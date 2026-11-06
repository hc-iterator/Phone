/**
 * dsh-memory —— 两块长期存储，性质完全不同，所以分成两张表
 *
 * ① 用户画像（profile）
 *    · 常驻注入 system prompt 的只有「核心画像」：硬预算 400 字符（≈130 token）。
 *    · 其余特征全部留在库里，按需查（mem_profile_list / mem_profile_get）——
 *      人很多面，400 字写不完；但每轮都塞 4000 字就是浪费。
 *
 * ② 项目事实（project_fact）—— 不是记忆，是**工具**
 *    · 按工作区（会话 cwd 绝对路径）共享：同一个项目里所有 agent 看到同一份。
 *    · 纯精确事实：subject + attribute + value(+unit)，唯一键 upsert，绝不堆积。
 *    · 默认**不进** prompt：用 mem_fact_get / mem_fact_search 现查现用。
 *    · 删除用标记失效（invalid_at），保留"曾经如此"的回答能力。
 *
 * 为什么不是现成的记忆库：现成方案假设"每轮 LLM 抽取 + 向量召回"，
 * 而这里要的是零抽取成本、精确命中、工作区隔离——数据形状完全不同。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROMPT_BUDGET = 400;     // 核心画像注入上限（字符）
const PINNED_LIMIT = 5;        // 允许"永不被挤掉"的条数上限
const VALUE_CAP = 500;         // 单条值上限

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
  required: ['ok', 'text'],
};

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function dbPath() {
  const dir = path.join(dshHome(), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'memory.db');
}

let DB = null;

function db() {
  if (DB) return DB;
  DB = new DatabaseSync(dbPath());
  DB.exec('PRAGMA journal_mode = WAL;');
  DB.exec('PRAGMA synchronous = NORMAL;');
  // 修复（G 路）：并发写时不要立刻失败，排队等一会儿。
  DB.exec('PRAGMA busy_timeout = 8000;');
  // 修复（G 路）：连接永不关闭 ⇒ 句柄泄漏、删库报 EPERM、多次开关实例内存上涨。
  //   进程退出时统一收尾（注册一次即可）。
  if (!db.closingRegistered) {
    db.closingRegistered = true;
    process.once('exit', () => { try { DB?.close(); } catch { /* 已关 */ } });
  }
  DB.exec(`
    CREATE TABLE IF NOT EXISTS profile(
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      core INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      importance INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_profile ON profile(category, key);

    CREATE TABLE IF NOT EXISTS project_fact(
      id INTEGER PRIMARY KEY,
      workspace TEXT NOT NULL,
      subject TEXT NOT NULL,
      attribute TEXT NOT NULL,
      value TEXT NOT NULL,
      unit TEXT,
      note TEXT,
      source_session TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      invalid_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_fact_live
      ON project_fact(workspace, subject, attribute) WHERE invalid_at IS NULL;
    CREATE INDEX IF NOT EXISTS ix_fact_ws ON project_fact(workspace);
  `);
  return DB;
}

// ── 工作区解析：会话 id → 工作区身份 ────────────────────────────────────────
// 关键认知：DSH 的会话目录名是**有损编码**（`dsh-session-persistence-jsonl` 的 projectKey）：
//   `/ \ :` → 单个 `-`（连续折叠），不安全字符（含 `~`）→ `~XXXX`，两端包 `--`。
//   有损 ⇒ **不能反解**。之前用"把 - 换成 \ 再补冒号"的猜法，把
//   `--C-~56FA...-.dsh-dsh_orb--` 解成 `C:\~56FA...\.dsh\dsh_orb` 这种幻影路径，
//   153/776 个会话会因此把事实写进不存在的工作区。
//
// 正确做法：**正向编码**。从 workspace.json 拿到真实路径，按官方规则算出目录名，
//   用"目录名 → 真实路径"建映射；认不出来的（workspace.json 还没记），
//   就用**目录名本身**当工作区身份（稳定、唯一，绝不编造路径）。
let WS_CACHE = { at: 0, map: new Map() };

/** 官方 projectKey 的复刻：路径 → 会话目录名（与 DSH 完全一致）。 */
function projectKey(cwd) {
  if (!cwd) throw new Error('empty path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  const trimmed = readable.replace(/^-+/, '') || 'root';
  return `--${trimmed.slice(0, 251)}--`;
}

function rebuildWsMap() {
  const bySession = new Map();   // 会话 id → 工作区身份
  const dirToPath = new Map();   // 目录名 → 真实路径（能算出来的）

  // ① 权威：workspace.json 里 path + sessionIds
  try {
    const raw = fs.readFileSync(path.join(dshHome(), 'storages', 'workspace.json'), 'utf8');
    const table = JSON.parse(raw)?.tables?.workspaces;
    const tables = Array.isArray(table) ? (table[0] ?? {}) : (table ?? {});
    for (const ws of Object.values(tables)) {
      const p = String(ws.path ?? '');
      if (!p) continue;
      try { dirToPath.set(projectKey(p), p); } catch { /* 路径异常就跳过 */ }
      for (const sid of ws.sessionIds ?? []) {
        const id = String(sid);
        bySession.set(id, p);
        bySession.set(id.replace(/^session-/, ''), p);
      }
    }
  } catch { /* 没有就靠目录映射 */ }

  // ② 目录扫描：目录名先尝试用正向编码对上真实路径，对不上就把目录名当身份
  try {
    const root = path.join(dshHome(), 'sessions');
    for (const wsDir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!wsDir.isDirectory()) continue;
      const identity = dirToPath.get(wsDir.name) || wsDir.name;
      let entries = [];
      try { entries = fs.readdirSync(path.join(root, wsDir.name), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const id = e.name;
        if (!bySession.has(id)) bySession.set(id, identity);
        const bare = id.replace(/^session-/, '');
        if (!bySession.has(bare)) bySession.set(bare, identity);
      }
    }
  } catch { /* 读不到就算了 */ }

  return bySession;
}

function workspaceOf(sessionId) {
  const now = Date.now();
  if (now - WS_CACHE.at > 60000) WS_CACHE = { at: now, map: rebuildWsMap() };
  const id = String(sessionId ?? '');
  const hit = WS_CACHE.map.get(id) || WS_CACHE.map.get('session-' + id);
  if (hit) return hit;
  // 未命中（新会话还没落盘）时强刷一次；仍无则退回 cwd（最后手段）
  WS_CACHE = { at: now, map: rebuildWsMap() };
  return WS_CACHE.map.get(id) || WS_CACHE.map.get('session-' + id) || process.cwd();
}

// ── 画像注入 ────────────────────────────────────────────────────────────────
let PROMPT_CACHE = { at: 0, text: '' };

function profileBlock(force = false) {
  const now = Date.now();
  if (!force && now - PROMPT_CACHE.at < 3000) return PROMPT_CACHE.text;
  let text = '';
  try {
    const rows = db()
      .prepare('SELECT category, key, value, pinned, importance FROM profile ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT 200')
      .all();

    // 修复（F 路 M1）：原来在遍历里 `if (used >= BUDGET) break`，而 pinned 排在最前，
    // 于是 pinned 一多就在它们内部提前 break ⇒ 只注入 1 条 pinned，还超预算。
    // 现在改两趟：**pinned 先全部放进**（最多 PINNED_LIMIT 条），再用剩余预算填普通条目。
    //
    // 修复（F 路 M2）：同一个 key 可能存在于不同 category（写入时没有全局唯一约束），
    // 那样会注入两条自相矛盾的行。这里按排序只保留**优先级最高**的那条。
    const seenKey = new Set();
    const pinnedRows = [];
    const otherRows = [];
    for (const r of rows) {
      if (seenKey.has(r.key)) continue;
      seenKey.add(r.key);
      (r.pinned ? pinnedRows : otherRows).push(r);
    }

    const lines = [];
    let used = 0;
    const pushLine = (r) => {
      const line = `${r.key}=${r.value}`;
      lines.push(line);
      used += line.length + 3;
    };

    for (const r of pinnedRows.slice(0, PINNED_LIMIT)) pushLine(r);
    // pinned 自己就超预算时不再硬塞普通条目（但 pinned 一条都不丢）
    for (const r of otherRows) {
      const cost = r.key.length + String(r.value).length + 3;
      if (used + cost > PROMPT_BUDGET) continue;
      pushLine(r);
    }

    if (lines.length) {
      text = '[用户画像] ' + lines.join(' | ')
        + '\n（更多特征用 mem_profile_list 查；不要臆造画像里没有的信息）';
    }
  } catch { /* 库坏了就少一段说明，绝不影响主流程 */ }
  PROMPT_CACHE = { at: now, text };
  return text;
}

// ── 工具实现 ────────────────────────────────────────────────────────────────
async function opProfileSet(args = {}, sessionId = '') {
  const category = String(args.category ?? 'preference').trim();
  const key = String(args.key ?? '').trim();
  const value = String(args.value ?? '').trim();
  if (!key || !value) return { ok: false, text: 'key 与 value 必填' };
  if (value.length > VALUE_CAP) return { ok: false, text: `value 太长（${value.length} > ${VALUE_CAP}）` };

  const pinnedRows = db().prepare('SELECT COUNT(*) AS n FROM profile WHERE pinned = 1').get().n;
  let pinned = args.pinned === true ? 1 : 0;
  if (pinned && pinnedRows >= PINNED_LIMIT && !db().prepare('SELECT 1 FROM profile WHERE category=? AND key=? AND pinned=1').get(category, key)) {
    return { ok: false, text: `pinned 已满（上限 ${PINNED_LIMIT} 条），先取消一条再设` };
  }
  const core = args.core === true ? 1 : 0;
  const importance = Number.isFinite(args.importance) ? Number(args.importance) : 0;
  const now = Date.now();
  db().prepare(`
    INSERT INTO profile(category,key,value,core,pinned,importance,source,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(category,key) DO UPDATE SET
      value=excluded.value, core=excluded.core, pinned=excluded.pinned,
      importance=excluded.importance, updated_at=excluded.updated_at
  `).run(category, key, value, core, pinned, importance, sessionId, now, now);
  PROMPT_CACHE = { at: 0, text: '' };
  return { ok: true, text: `画像已记：${category}/${key} = ${value}${pinned ? '（pinned）' : ''}\n当前注入：${profileBlock(true) || '（空）'}` };
}

async function opProfileDel(args = {}) {
  const category = String(args.category ?? '').trim();
  const key = String(args.key ?? '').trim();
  if (!key) return { ok: false, text: 'key 必填' };
  const info = category
    ? db().prepare('DELETE FROM profile WHERE category=? AND key=?').run(category, key)
    : db().prepare('DELETE FROM profile WHERE key=?').run(key);
  PROMPT_CACHE = { at: 0, text: '' };
  return { ok: true, text: info.changes ? `已删除 ${info.changes} 条` : '没找到这条画像' };
}

async function opProfileList(args = {}) {
  const category = args.category ? String(args.category) : null;
  const rows = category
    ? db().prepare('SELECT category,key,value,core,pinned FROM profile WHERE category=? ORDER BY pinned DESC, importance DESC, updated_at DESC').all(category)
    : db().prepare('SELECT category,key,value,core,pinned FROM profile ORDER BY category, pinned DESC, importance DESC, updated_at DESC').all();
  if (!rows.length) return { ok: true, text: '画像还是空的' };
  const lines = rows.map((r) => `${r.pinned ? '★' : ' '} [${r.category}] ${r.key} = ${r.value}`);
  return { ok: true, text: `共 ${rows.length} 条画像：\n` + lines.join('\n') };
}

function liveFactRow(workspace, subject, attribute) {
  return db().prepare('SELECT * FROM project_fact WHERE workspace=? AND subject=? AND attribute=? AND invalid_at IS NULL')
    .get(workspace, subject, attribute);
}

async function opFactPut(args = {}, sessionId = '') {
  const workspace = String(args.workspace ?? '').trim() || workspaceOf(sessionId);
  const subject = String(args.subject ?? '').trim();
  const attribute = String(args.attribute ?? '').trim();
  const value = String(args.value ?? '').trim();
  if (!subject || !attribute || !value) return { ok: false, text: 'subject / attribute / value 必填（精确事实不接受模糊描述）' };
  if (value.length > VALUE_CAP) return { ok: false, text: `value 太长（${value.length} > ${VALUE_CAP}）` };
  const unit = args.unit == null ? null : String(args.unit);
  const note = args.note == null ? null : String(args.note);
  const now = Date.now();
  // 修复（G 路）：原来"先查再写"，两个连接并发写同一新键会直接抛 UNIQUE 冲突；
  //   而且更新时若调用方没给 unit/note，会把旧值静默清空。
  //   现在用**单条原子 upsert** + COALESCE 保留旧值。
  const before = liveFactRow(workspace, subject, attribute);
  db().prepare(`
    INSERT INTO project_fact(workspace,subject,attribute,value,unit,note,source_session,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace,subject,attribute) WHERE invalid_at IS NULL DO UPDATE SET
      value = excluded.value,
      unit  = COALESCE(excluded.unit, project_fact.unit),
      note  = COALESCE(excluded.note, project_fact.note),
      source_session = excluded.source_session,
      updated_at = excluded.updated_at
  `).run(workspace, subject, attribute, value, unit, note, sessionId, now, now);

  const written = liveFactRow(workspace, subject, attribute);
  const suffix = unit ? ' ' + unit : '';
  if (before && before.value !== value) {
    return { ok: true, text: `已更新事实：${subject}.${attribute} = ${value}${suffix}（原值 ${before.value}）` };
  }
  return { ok: true, text: `已记录事实：${subject}.${attribute} = ${value}${suffix}\n工作区：${written?.workspace ?? workspace}` };
}

async function opFactGet(args = {}, sessionId = '') {
  const workspace = String(args.workspace ?? '').trim() || workspaceOf(sessionId);
  const subject = String(args.subject ?? '').trim();
  if (!subject) return { ok: false, text: 'subject 必填（或用 mem_fact_search）' };
  const attribute = args.attribute ? String(args.attribute).trim() : null;
  const rows = attribute
    ? db().prepare('SELECT * FROM project_fact WHERE workspace=? AND subject=? AND attribute=? AND invalid_at IS NULL').all(workspace, subject, attribute)
    : db().prepare('SELECT * FROM project_fact WHERE workspace=? AND subject=? AND invalid_at IS NULL ORDER BY updated_at DESC').all(workspace, subject);
  if (!rows.length) return { ok: true, text: `没有关于 ${subject} 的事实（工作区 ${workspace}）` };
  const lines = rows.map((r) => `${r.subject}.${r.attribute} = ${r.value}${r.unit ? ' ' + r.unit : ''}${r.note ? `  // ${r.note}` : ''}`);
  return { ok: true, text: lines.join('\n') };
}

async function opFactSearch(args = {}, sessionId = '') {
  const q = String(args.query ?? '').trim();
  if (!q) return { ok: false, text: 'query 必填' };
  const workspace = args.allWorkspaces === true ? null : (String(args.workspace ?? '').trim() || workspaceOf(sessionId));
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
  // 修复（G 路）：LIKE 里的 % 和 _ 是通配符，没转义的话查 "%" 会命中全部、查 "3_3" 会命中外
  //   "3.3"。这里按 SQLite 的 ESCAPE 规则转义三个字符。
  const escaped = q.replace(/[\\%_]/g, (m) => '\\' + m);
  const like = `%${escaped}%`;
  const rows = workspace
    ? db().prepare(`SELECT * FROM project_fact WHERE invalid_at IS NULL AND workspace=? AND (subject LIKE ? ESCAPE '\\' OR attribute LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?`).all(workspace, like, like, like, like, limit)
    : db().prepare(`SELECT * FROM project_fact WHERE invalid_at IS NULL AND (subject LIKE ? ESCAPE '\\' OR attribute LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT ?`).all(like, like, like, like, limit);
  if (!rows.length) return { ok: true, text: `没找到含「${q}」的事实` };
  const lines = rows.map((r) => `${r.subject}.${r.attribute} = ${r.value}${r.unit ? ' ' + r.unit : ''}  [${r.workspace.split('\\').pop() || r.workspace}]`);
  return { ok: true, text: `命中 ${rows.length} 条：\n` + lines.join('\n') };
}

async function opFactInvalidate(args = {}, sessionId = '') {
  const workspace = String(args.workspace ?? '').trim() || workspaceOf(sessionId);
  const subject = String(args.subject ?? '').trim();
  const attribute = String(args.attribute ?? '').trim();
  if (!subject || !attribute) return { ok: false, text: 'subject 与 attribute 必填' };
  const row = liveFactRow(workspace, subject, attribute);
  if (!row) return { ok: false, text: '没有这条事实' };
  db().prepare('UPDATE project_fact SET invalid_at=? WHERE id=?').run(Date.now(), row.id);
  return { ok: true, text: `已标记失效：${subject}.${attribute}（原值 ${row.value}，历史仍可查）` };
}

async function opFactList(args = {}, sessionId = '') {
  const workspace = String(args.workspace ?? '').trim() || workspaceOf(sessionId);
  const limit = Math.max(1, Math.min(Number(args.limit) || 100, 500));
  const rows = db().prepare('SELECT * FROM project_fact WHERE workspace=? AND invalid_at IS NULL ORDER BY subject, attribute LIMIT ?').all(workspace, limit);
  if (!rows.length) return { ok: true, text: `工作区还没有项目事实：${workspace}` };
  const lines = rows.map((r) => `${r.subject}.${r.attribute} = ${r.value}${r.unit ? ' ' + r.unit : ''}`);
  return { ok: true, text: `本工作区 ${rows.length} 条事实：\n` + lines.join('\n') };
}

async function opExport(args = {}) {
  const out = String(args.path ?? '').trim() || path.join(dshHome(), 'memory', 'memory.md');
  const prof = db().prepare('SELECT category,key,value,pinned FROM profile ORDER BY category, pinned DESC').all();
  const facts = db().prepare('SELECT * FROM project_fact WHERE invalid_at IS NULL ORDER BY workspace, subject, attribute').all();
  // 修复（G 路）：value/note 里的换行、反引号、管道会把 Markdown 结构破坏掉（一行变多行、
  //   代码块提前闭合）。导出是给人看的，必须压成单行并把关键符号替换掉。
  const oneLine = (s) => String(s ?? '')
    .replace(/[\r\n]+/g, ' ⏎ ')
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|')
    .trim();
  const lines = ['# 记忆库导出', '', `导出时间：${new Date().toLocaleString(undefined, { hour12: false })}`, '', '## 用户画像', ''];
  if (!prof.length) lines.push('（空）');
  for (const p of prof) lines.push(`- ${p.pinned ? '★ ' : ''}[${p.category}] ${oneLine(p.key)} = ${oneLine(p.value)}`);
  lines.push('', '## 项目事实', '');
  if (!facts.length) lines.push('（空）');
  let ws = null;
  for (const f of facts) {
    if (f.workspace !== ws) { ws = f.workspace; lines.push('', `### ${oneLine(ws)}`, ''); }
    const unit = f.unit ? ' ' + oneLine(f.unit) : '';
    const note = f.note ? ` — ${oneLine(f.note)}` : '';
    lines.push(`- \`${oneLine(f.subject)}.${oneLine(f.attribute)}\` = ${oneLine(f.value)}${unit}${note}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  return { ok: true, text: `已导出 ${prof.length} 条画像、${facts.length} 条事实 → ${out}` };
}

async function opStats(sessionId = '') {
  const dbg = `会话=${sessionId} 解析工作区=${workspaceOf(sessionId)}`;
  const p = db().prepare('SELECT COUNT(*) AS n FROM profile').get().n;
  const f = db().prepare('SELECT COUNT(*) AS n FROM project_fact WHERE invalid_at IS NULL').get().n;
  const fi = db().prepare('SELECT COUNT(*) AS n FROM project_fact WHERE invalid_at IS NOT NULL').get().n;
  const size = fs.existsSync(dbPath()) ? (fs.statSync(dbPath()).size / 1024).toFixed(0) : '0';
  const block = profileBlock(true);
  return { ok: true, text: `画像 ${p} 条、有效事实 ${f} 条（失效 ${fi} 条），库 ${size} KB\n${dbg}\n当前注入（${block.length}/${PROMPT_BUDGET} 字符）：\n${block || '（空）'}` };
}

function tool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_a, v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }],
    },
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.id ?? '');
      return await run(args ?? {}, sessionId);
    },
  };
}

function buildToolDefinitions() {
  return [
    tool('mem_profile_set',
      'Record ONE user-profile fact (who the user is / what they prefer). Only the core profile is injected into every prompt (hard budget 400 chars); everything else stays queryable. Use pinned for at most 5 never-dropped facts.',
      { type: 'object', additionalProperties: false, required: ['key', 'value'], properties: {
        category: { type: 'string', description: 'identity | preference | habit | constraint | other (default preference).' },
        key: { type: 'string', description: 'Short attribute name, e.g. "年级" or "回答语言".' },
        value: { type: 'string', description: 'The value, e.g. "初二" or "中文".' },
        core: { type: 'boolean', description: 'Prefer keeping it inside the injected budget.' },
        pinned: { type: 'boolean', description: 'Never dropped by the budget (max 5 total).' },
        importance: { type: 'number', description: 'Higher = kept earlier when budget is tight.' },
      } },
      (a, s) => opProfileSet(a, s)),
    tool('mem_profile_del', 'Delete one profile fact by key (and optional category).',
      { type: 'object', additionalProperties: false, required: ['key'], properties: {
        key: { type: 'string' }, category: { type: 'string' } } },
      (a) => opProfileDel(a)),
    tool('mem_profile_list', 'List stored profile facts (optionally by category).',
      { type: 'object', additionalProperties: false, properties: { category: { type: 'string' } } },
      (a) => opProfileList(a)),
    tool('mem_fact_put',
      'Store ONE precise project fact for this workspace (subject.attribute = value). Updates in place when the same subject+attribute exists. Not injected into the prompt — query it when needed.',
      { type: 'object', additionalProperties: false, required: ['subject', 'attribute', 'value'], properties: {
        subject: { type: 'string', description: 'Entity, e.g. "RP2350" or "烧写流程".' },
        attribute: { type: 'string', description: 'Property, e.g. "flash_sha" or "波特率".' },
        value: { type: 'string', description: 'Exact value.' },
        unit: { type: 'string', description: 'Optional unit, e.g. "V" or "ms".' },
        note: { type: 'string', description: 'Optional short note/caveat.' },
        workspace: { type: 'string', description: 'Override workspace (default: this session cwd).' },
      } },
      (a, s) => opFactPut(a, s)),
    tool('mem_fact_get', 'Get exact facts for one subject in this workspace.',
      { type: 'object', additionalProperties: false, required: ['subject'], properties: {
        subject: { type: 'string' }, attribute: { type: 'string' }, workspace: { type: 'string' } } },
      (a, s) => opFactGet(a, s)),
    tool('mem_fact_search', 'Substring search over project facts in this workspace (subject/attribute/value/note).',
      { type: 'object', additionalProperties: false, required: ['query'], properties: {
        query: { type: 'string' }, limit: { type: 'number' }, allWorkspaces: { type: 'boolean' }, workspace: { type: 'string' } } },
      (a, s) => opFactSearch(a, s)),
    tool('mem_fact_list', 'List all live facts of this workspace.',
      { type: 'object', additionalProperties: false, properties: { workspace: { type: 'string' }, limit: { type: 'number' } } },
      (a, s) => opFactList(a, s)),
    tool('mem_fact_invalidate', 'Mark a fact as no longer true (kept for history instead of deleting).',
      { type: 'object', additionalProperties: false, required: ['subject', 'attribute'], properties: {
        subject: { type: 'string' }, attribute: { type: 'string' }, workspace: { type: 'string' } } },
      (a, s) => opFactInvalidate(a, s)),
    tool('mem_export', 'Export profile + project facts to a Markdown file for human review.',
      { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } },
      (a) => opExport(a)),
    tool('mem_stats', 'Show memory counts and the exact text injected into the prompt this turn.',
      { type: 'object', additionalProperties: false, properties: {} },
      (a, s) => opStats(s)),
  ];
}

export const inject = ['tools'];

export async function apply(ctx) {
  for (const definition of buildToolDefinitions()) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-memory: ${definition.name}`);
  }
  // 核心画像注入：用 ctx.inject 而不是直接 ctx.systemPrompt.section()
  // （服务没挂时静默跳过，绝不因为注入失败把 10 个工具一起带走）
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const sp = promptCtx && promptCtx.systemPrompt;
    if (!sp || typeof sp.section !== 'function') return;
    sp.section({
      name: 'memory:profile',
      order: 2710,
      text: () => profileBlock(),
    });
  });
}
// ── 命令行冒烟测试：node index.js --smoke ────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('index.js') && process.argv.includes('--smoke')) {
  const sid = 'smoke-session';
  const ws = 'C:\\Users\\Chen\\Desktop\\Pico\\PicoPhone';
  await opProfileSet({ category: 'identity', key: '年级', value: '初二', pinned: true }, sid);
  await opProfileSet({ category: 'preference', key: '回答语言', value: '中文，不要英文' }, sid);
  console.log((await opProfileList({})).text);
  console.log('\n--- 注入块 ---\n' + profileBlock(true));
  console.log('\n' + (await opFactPut({ workspace: ws, subject: 'RP2350', attribute: 'flash_sha', value: '90e2bcab' }, sid)).text);
  console.log((await opFactPut({ workspace: ws, subject: 'RP2350', attribute: 'flash_sha', value: 'a1b2c3d4' }, sid)).text);
  console.log((await opFactGet({ workspace: ws, subject: 'RP2350' }, sid)).text);
  console.log((await opFactSearch({ workspace: ws, query: 'flash' }, sid)).text);
  console.log((await opStats()).text);
}

