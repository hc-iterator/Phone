/**
 * dsh-memdb —— 记忆库 v0（事件时间线 + 用户画像）
 *
 * 定位（用户 2026-11-07 定案）：
 *   记忆库 = **用户是怎样的人、今天干了什么**（时间线 / 事件 / 画像）
 *   项目库 = **项目里客观成立的事实**（键值，dsh-projectdb 已上线）
 * 形状不同、语义不合并，但**共用同一个 SQLite 文件**与同一套安全机制：
 *   %DSH_HOME%\projectdb\project.db   ← 追加 events / profile / profile_history 三张表，绝不另建库。
 *
 * v0 只有三件事（不超范围）：
 *   ① 建表：events（kind 五选一）、profile（只允许一行、≤600 字）、profile_history（画像旧值）
 *   ② 三个工具：mem_event / mem_timeline / mem_who
 *   ③ 首批事件：把 2026-11-08 的四个里程碑灌进 events（`--seed`，幂等）
 *
 * 设计要点：
 *   - `at` 是"事情发生的时间"，`created_at` 是"什么时候被记下来的"，两者不混用；
 *   - 事件永不覆盖、永不过期（它就是历史）；画像只有一份当前值，改动进 profile_history；
 *   - 写入全部走事务（与项目库同款 BEGIN IMMEDIATE + busy_timeout），多会话并发不丢；
 *   - 摘要 ≤120 字：超了**截断并提示**（宁可留半句，也不让工具调用失败）；
 *   - 画像 >600 字：**直接拒绝**并提示"请改写而非追加"（画像膨胀是不可逆的噪声）。
 *
 * 自测：node index.js --self-test（用 %TEMP% 下的临时库，不碰真库）
 * 灌首批数据：node index.js --seed
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const KINDS = ['decision', 'milestone', 'incident', 'preference', 'todo'];
const KIND_LABEL = {
  decision: '决定',
  milestone: '里程碑',
  incident: '事故',
  preference: '偏好',
  todo: '待办',
};
const SUMMARY_MAX = 120;
const SUBJECT_MAX = 100;
const PROFILE_MAX = 600;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
  required: ['ok', 'text'],
};

// ── 存储：与项目库共用同一个文件 ─────────────────────────────────────────────

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 默认与 dsh-projectdb 指向同一个库文件（这是本次实现的硬性要求：不新建数据库）。
 * DSH_MEMDB_DB 只给自测用（临时文件），生产环境永远不设它。
 */
function dbPath() {
  const override = process.env.DSH_MEMDB_DB;
  if (override) {
    fs.mkdirSync(path.dirname(override), { recursive: true });
    return override;
  }
  const dir = path.join(dshHome(), 'projectdb');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'project.db');
}

let DB = null;

function db() {
  if (DB) return DB;
  DB = new DatabaseSync(dbPath());
  DB.exec('PRAGMA journal_mode = WAL;');
  DB.exec('PRAGMA synchronous = NORMAL;');
  DB.exec('PRAGMA busy_timeout = 8000;');
  DB.exec(`
    -- 事件：只在事件发生的"那一刻"有意义，永不覆盖
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('decision','milestone','incident','preference','todo')),
      subject TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_session TEXT,
      refs TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_events_at ON events(at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS ix_events_kind ON events(kind);

    -- 画像：只保留一行当前值（CHECK 把"只有一行"写进 schema，而不是靠自觉）
    CREATE TABLE IF NOT EXISTS profile(
      id INTEGER PRIMARY KEY CHECK (id = 1),
      text TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      session TEXT
    );

    -- 画像历史：每次改画像，旧文本追加到这里（可回档，不丢旧说法）
    CREATE TABLE IF NOT EXISTS profile_history(
      id INTEGER PRIMARY KEY,
      profile_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      session TEXT,
      at INTEGER NOT NULL,
      op TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_profile_hist ON profile_history(profile_id, at);
  `);
  if (!db.closing) {
    db.closing = true;
    process.once('exit', () => { try { DB?.close(); } catch { /* 已关 */ } });
  }
  return DB;
}

function now() { return Date.now(); }

/** 事务包装：中途失败整体回滚，不留半条记录（与项目库同一套写法）。 */
function tx(fn) {
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (error) {
    try { d.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw error;
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 按 Unicode 码点计"字"（中文一个字算 1，不至于被代理对算成 2）。 */
function charLen(s) { return Array.from(String(s)).length; }

/** 按码点截断，返回 [文本, 被截掉的字数]。 */
function clip(s, max) {
  const chars = Array.from(String(s));
  if (chars.length <= max) return [chars.join(''), 0];
  return [chars.slice(0, max).join(''), chars.length - max];
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 解析时间边界。接受 `YYYY-MM-DD`（按**本地**自然日：from 取 00:00:00.000，
 * to 取 23:59:59.999）或任何 Date.parse 认得的完整时间戳（按原值，不做整日扩展）。
 * 返回 null 表示未给，NaN 表示格式不认识。
 */
function parseBound(value, isEnd) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      isEnd ? 23 : 0, isEnd ? 59 : 0, isEnd ? 59 : 0, isEnd ? 999 : 0);
    return Number.isNaN(d.getTime()) ? NaN : d.getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

/** refs 列：统一存 JSON {source, items}，这样"出处"和"关联"都有地方放，且不撑宽表。 */
function packRefs(source, refs) {
  const items = [];
  if (Array.isArray(refs)) {
    for (const r of refs) { const s = String(r ?? '').trim(); if (s) items.push(s); }
  } else if (refs != null) {
    const s = String(refs).trim();
    if (s) items.push(s);
  }
  const src = source == null ? '' : String(source).trim();
  if (!src && !items.length) return null;
  return JSON.stringify({ source: src || null, items });
}

/** 把 refs 还原成给人看的一小段（太长就截断，时间线一行不能被出处撑爆）。 */
function refsNote(refs) {
  if (!refs) return '';
  let parts = [];
  try {
    const o = JSON.parse(refs);
    if (o && typeof o === 'object') {
      if (o.source) parts.push(String(o.source));
      if (Array.isArray(o.items)) parts.push(...o.items.map(String));
    } else {
      parts.push(String(o));
    }
  } catch {
    parts.push(String(refs));
  }
  parts = parts.filter(Boolean);
  if (!parts.length) return '';
  const [text, cut] = clip(parts.join(' '), 80);
  return `（出处 ${text}${cut ? '…' : ''}）`;
}

// ── 工具实现 ────────────────────────────────────────────────────────────────

/** 单条事件的校验与截断：mem_event 与 mem_summarize 走**同一条**路径，规则不会跑偏。 */
function prepareEvent(raw = {}, atOverride) {
  const kind = String(raw.kind ?? '').trim();
  if (!KINDS.includes(kind)) {
    return {
      ok: false,
      text: `kind 非法：${kind || '(空)'}。只允许 ${KINDS.join('|')}（${KINDS.map((k) => KIND_LABEL[k]).join('/')}）`,
    };
  }
  const subjectRaw = String(raw.subject ?? '').trim();
  if (!subjectRaw) return { ok: false, text: 'subject 必填（这件事是关于什么的，几个字即可）' };
  const summaryRaw = String(raw.summary ?? '').trim();
  if (!summaryRaw) return { ok: false, text: 'summary 必填（一句话：决定了什么/做成了什么/出了什么事）' };

  const [subject, subjectCut] = clip(subjectRaw, SUBJECT_MAX);
  const [summary, summaryCut] = clip(summaryRaw, SUMMARY_MAX);
  return {
    ok: true,
    row: {
      kind,
      subject,
      summary,
      refs: packRefs(raw.source, raw.refs),
      at: Number.isFinite(atOverride) ? Number(atOverride) : now(),
      createdAt: now(),
      subjectCut,
      summaryCut,
    },
  };
}

/** 写一行事件，返回 id（调用方负责事务边界）。 */
function insertEvent(row, sessionId) {
  const info = db().prepare(
    'INSERT INTO events(kind, subject, summary, source_session, refs, at, created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(row.kind, row.subject, row.summary, sessionId || null, row.refs, row.at, row.createdAt);
  return Number(info.lastInsertRowid);
}

/** 截断提示（截断不算失败，但要说明白）。 */
function eventNotes(rows) {
  const notes = [];
  const truncated = rows.filter((r) => r.summaryCut || r.subjectCut);
  if (truncated.length) notes.push(`${truncated.length} 条超长已截断（摘要上限 ${SUMMARY_MAX} 字，主题上限 ${SUBJECT_MAX} 字）`);
  return notes;
}

async function opEvent(args = {}, sessionId = '') {
  const prep = prepareEvent(args);
  if (!prep.ok) return prep;
  const row = prep.row;
  const id = insertEvent(row, sessionId);
  const notes = eventNotes([row]);
  const tail = notes.length ? `\n注意：${notes.join('；')}` : '';
  return {
    ok: true,
    text: `已记录 #${id}：${fmtDate(row.at)} ${KIND_LABEL[row.kind]} ${row.subject} — ${row.summary}${tail}`,
  };
}

/**
 * 批量收口：agent 自己判断"一段活告一段落"时调用，把这段工作收成几条事件，并可顺手改写画像。
 *
 * 两条硬规则：
 *   ① **先全部校验、再统一写入**——任何一条 entry 非法就整批拒绝，不留半截事件；
 *   ② 画像同样先查长度再落盘，>600 字整批拒绝（entries 也不会写），提示"改写而非追加"。
 */
async function opSummarize(args = {}, sessionId = '') {
  const entries = args.entries == null ? [] : args.entries;
  if (!Array.isArray(entries)) return { ok: false, text: 'entries 必须是数组（[{kind, subject, summary, source?}, …]）' };
  if (entries.length > 40) return { ok: false, text: `一次最多收 40 条（收到 ${entries.length}）。分两次调。` };

  const profileGiven = args.profile != null && String(args.profile).trim() !== '';
  if (!entries.length && !profileGiven) return { ok: false, text: 'entries 与 profile 至少要给一个' };

  // ① 先校验，一个都不写
  const rows = [];
  for (let i = 0; i < entries.length; i += 1) {
    const prep = prepareEvent(entries[i] ?? {});
    if (!prep.ok) return { ok: false, text: `第 ${i + 1} 条：${prep.text}（整批未写入）` };
    rows.push(prep.row);
  }
  let profileText = null;
  if (profileGiven) {
    profileText = String(args.profile).trim();
    const n = charLen(profileText);
    if (n > PROFILE_MAX) {
      return {
        ok: false,
        text: `画像超长：${n} > ${PROFILE_MAX} 字（整批未写入）。请**改写**而非追加 —— 画像只保留当前的一句话画像`,
      };
    }
  }

  // ② 事件走一个事务：要么全进，要么全不进
  const ids = [];
  if (rows.length) {
    tx(() => { for (const row of rows) ids.push(insertEvent(row, sessionId)); });
  }

  // ③ 画像（opProfileSet 自带事务与历史）
  let profileLine = '画像未提供，未动';
  if (profileText != null) {
    const r = await opProfileSet(profileText, sessionId);
    profileLine = r.ok ? `画像：${r.text}` : `画像：${r.text}`;
    if (!r.ok) {
      return { ok: false, text: `事件已写入 ${ids.length} 条，但${profileLine}` };
    }
  }

  const notes = eventNotes(rows);
  const head = rows.length
    ? `已写入 ${rows.length} 条事件（#${ids[0]}${ids.length > 1 ? `-#${ids[ids.length - 1]}` : ''}）`
    : '未写入事件（本次只更新画像）';
  const tail = notes.length ? `\n注意：${notes.join('；')}` : '';
  return { ok: true, text: `${head}；${profileLine}${tail}` };
}

async function opTimeline(args = {}) {
  const limit = Number.isFinite(Number(args.limit))
    ? Math.max(1, Math.min(Math.trunc(Number(args.limit)), 200))
    : 20;

  let kind = null;
  if (args.kind != null && String(args.kind).trim() !== '') {
    kind = String(args.kind).trim();
    if (!KINDS.includes(kind)) {
      return { ok: false, text: `kind 非法：${kind}。只允许 ${KINDS.join('|')}` };
    }
  }

  const from = parseBound(args.from, false);
  const to = parseBound(args.to, true);
  if (Number.isNaN(from)) return { ok: false, text: `from 认不出来：${args.from}（要 YYYY-MM-DD 或 ISO 时间）` };
  if (Number.isNaN(to)) return { ok: false, text: `to 认不出来：${args.to}（要 YYYY-MM-DD 或 ISO 时间）` };
  if (from != null && to != null && from > to) return { ok: false, text: 'from 比 to 晚，时间范围是空的' };

  const where = [];
  const params = [];
  if (from != null) { where.push('at >= ?'); params.push(from); }
  if (to != null) { where.push('at <= ?'); params.push(to); }
  if (kind) { where.push('kind = ?'); params.push(kind); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const d = db();
  const total = d.prepare(`SELECT COUNT(*) AS n FROM events ${clause}`).get(...params).n;
  const rows = d.prepare(`SELECT * FROM events ${clause} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...params, limit);

  if (!rows.length) {
    const scope = [from != null ? `from ${fmtDate(from)}` : '', to != null ? `to ${fmtDate(to)}` : '',
      kind ? `kind ${kind}` : ''].filter(Boolean).join(' ');
    return { ok: true, text: `没有符合条件的事件（${scope || '全部'}）` };
  }

  const lines = rows.map((r) => {
    const label = KIND_LABEL[r.kind] || r.kind;
    return `${fmtDate(r.at)} ${label} ${r.subject} — ${r.summary}${refsNote(r.refs)}`;
  });
  const more = total > rows.length ? `\n…共 ${total} 条，只显示最近 ${rows.length} 条` : '';
  return { ok: true, text: lines.join('\n') + more };
}

async function opWho() {
  const d = db();
  const row = d.prepare('SELECT * FROM profile WHERE id = 1').get();
  if (!row) {
    return { ok: true, text: '尚未建立用户画像（v0 没有画像写入工具，先看事件时间线；写画像用 CLI --set-profile）' };
  }
  const n = charLen(row.text);
  return { ok: true, text: `${row.text}\n— 当前画像 ${n}/${PROFILE_MAX} 字，更新于 ${fmtDateTime(row.updated_at)}` };
}

/**
 * 写画像（v0 不暴露成工具，只给 CLI 与将来的收工摘要用）。
 * 硬规则：>600 字拒绝，而不是截断 —— 画像一旦膨胀就再也读不动了。
 */
async function opProfileSet(text, sessionId = '') {
  const value = String(text ?? '').trim();
  if (!value) return { ok: false, text: '画像内容为空' };
  const n = charLen(value);
  if (n > PROFILE_MAX) {
    return {
      ok: false,
      text: `画像超长：${n} > ${PROFILE_MAX} 字。请**改写**而非追加 —— 画像只保留当前的一句话画像，不堆历史细节`,
    };
  }
  const at = now();
  const result = tx((d) => {
    const old = d.prepare('SELECT * FROM profile WHERE id = 1').get();
    if (old && old.text === value) return { changed: false };
    if (old) {
      d.prepare('INSERT INTO profile_history(profile_id, text, session, at, op) VALUES(?,?,?,?,?)')
        .run(old.id, old.text, sessionId || null, at, 'replace');
    }
    d.prepare(`
      INSERT INTO profile(id, text, updated_at, session) VALUES(1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at,
                                    session = excluded.session
    `).run(value, at, sessionId || null);
    if (!old) {
      d.prepare('INSERT INTO profile_history(profile_id, text, session, at, op) VALUES(?,?,?,?,?)')
        .run(1, value, sessionId || null, at, 'insert');
    }
    return { changed: true, previous: old ? old.text : null };
  });
  if (!result.changed) return { ok: true, text: `未变：画像与当前一致（${n}/${PROFILE_MAX} 字），不写历史` };
  return {
    ok: true,
    text: result.previous == null
      ? `已建立画像（${n}/${PROFILE_MAX} 字）`
      : `已更新画像（${n}/${PROFILE_MAX} 字，旧版已进 profile_history）`,
  };
}

async function opStats() {
  const d = db();
  const n = d.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  const byKind = d.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC').all();
  const prof = d.prepare('SELECT * FROM profile WHERE id = 1').get();
  const hist = d.prepare('SELECT COUNT(*) AS n FROM profile_history').get().n;
  const size = fs.existsSync(dbPath()) ? (fs.statSync(dbPath()).size / 1024 / 1024).toFixed(1) : '0';
  const kindText = byKind.length ? byKind.map((r) => `${KIND_LABEL[r.kind] || r.kind} ${r.n}`).join(' · ') : '无';
  const profText = prof ? `${charLen(prof.text)}/${PROFILE_MAX} 字（更新于 ${fmtDate(prof.updated_at)}）` : '尚未建立';
  return {
    ok: true,
    text: `事件 ${n} 条（${kindText}）· 画像 ${profText} · 画像历史 ${hist} 条 · 库 ${size} MB（与项目库共用）`,
  };
}

// ── 首批数据：2026-11-08 的四件事 ────────────────────────────────────────────

/**
 * 用固定的一天 + 小时来排时间线，避免"今天灌的明天就变成明天的事"。
 * 文案按 120 字上限写，只记"做成了什么"，不记过程。
 */
const SEED_EVENTS = [
  {
    hour: 9,
    kind: 'milestone',
    subject: '项目库 v1 上线',
    summary: '项目事实库 dsh-projectdb 上线，2804 条事实入库；proj_* 九工具可用，软删+历史+WAL 并发安全（实测 80 并发零丢失）',
    source: 'dsh-plugins/dsh-projectdb/index.js',
  },
  {
    hour: 10,
    kind: 'milestone',
    subject: 'blank-reaper 上线',
    summary: '空草稿自动回收插件上线：每工作区只留最新 1 个空草稿，清掉 16 天积压的 724 个（只搬回收站，不动会话内容）',
    source: 'dsh-plugins/dsh-blank-reaper/index.js',
  },
  {
    hour: 11,
    kind: 'milestone',
    subject: 'agent 消息插队修复',
    summary: 'agent 间消息不再等回合结束才投递：延迟 41.6s → 1.13s（约 37 倍），改在总线投递路径上插队',
    source: 'dsh-plugins/dsh-agent-bus/index.js',
  },
  {
    hour: 12,
    kind: 'milestone',
    subject: 'REA 207 工具按需加载',
    summary: 'REA 的 207 个工具改为 20 组按需加载：只在需要时载入，离线自测 12/12 通过，常驻工具表不再被撑爆',
    source: 'dsh-plugins/dsh-rea-lazy',
  },
];

function seedDay(arg) {
  // 默认用"今天"作为灌入日期（本次是 2026-11-08）；也能用 --seed 2026-11-08 指到别的日子。
  const bound = parseBound(typeof arg === 'string' ? arg : null, false);
  if (bound != null && !Number.isNaN(bound)) return bound;
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

async function opSeed(dayStart) {
  const start = Number.isFinite(dayStart) ? dayStart : new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const d = db();
  const results = [];
  let inserted = 0, skipped = 0;
  for (const e of SEED_EVENTS) {
    const at = start + e.hour * 3600 * 1000;
    const dayEnd = start + 86400000;
    // 幂等：同一天、同 kind、同 subject、同 summary 已存在就跳过，不重复灌
    const dup = d.prepare('SELECT id FROM events WHERE kind=? AND subject=? AND summary=? AND at>=? AND at<?')
      .get(e.kind, e.subject, e.summary, start, dayEnd);
    if (dup) { skipped++; results.push(`跳过（已有 #${dup.id}）：${fmtDate(at)} ${KIND_LABEL[e.kind]} ${e.subject}`); continue; }
    const res = await opEvent({ kind: e.kind, subject: e.subject, summary: e.summary, source: e.source, at }, 'seed');
    if (!res.ok) { results.push(`失败：${e.subject} —— ${res.text}`); continue; }
    inserted++;
    results.push(`已灌入：${res.text}`);
  }
  return { ok: true, text: `首批事件：新灌入 ${inserted} 条，跳过 ${skipped} 条\n` + results.join('\n') };
}

// ── 自测：写事件→读时间线→kind 非法被拒→画像超 600 被拒→画像更新进历史 ─────────

async function opSelfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memdb-test-'));
  const file = path.join(dir, 'test.db');
  process.env.DSH_MEMDB_DB = file;
  DB = null; // 强制指向临时库，绝不碰真库

  const checks = [];
  const check = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
  };

  try {
    // 1. 写一条事件
    const w = await opEvent({ kind: 'milestone', subject: '自测事件', summary: '写一条里程碑事件' }, 'self-test');
    check('写事件', w.ok && /已记录 #\d+/.test(w.text), w.text.replace(/\n/g, ' '));

    // 2. 读时间线能看到它，且格式是「日期 类型 主题 — 摘要」
    const t = await opTimeline({ limit: 5 });
    check('读时间线', t.ok && t.text.includes('自测事件')
      && new RegExp(`^\\d{4}-\\d{2}-\\d{2} 里程碑 自测事件 — 写一条里程碑事件`).test(t.text.split('\n')[0]),
      t.text.split('\n')[0]);

    // 3. kind 非法必须被拒
    const bad = await opEvent({ kind: 'note', subject: 'x', summary: 'y' });
    check('kind 非法被拒', bad.ok === false && bad.text.includes('kind 非法'), bad.text);

    // 4. 摘要超 120 字：截断并提示（不是失败）
    const long = await opEvent({ kind: 'todo', subject: '长摘要', summary: '啊'.repeat(130) });
    check('摘要超长截断', long.ok && long.text.includes('已截断'), long.text.split('\n')[1] || long.text);

    // 5. 画像超 600 字必须被拒（且提示"改写"）
    const big = await opProfileSet('字'.repeat(601), 'self-test');
    check('画像超 600 被拒', big.ok === false && big.text.includes('改写'), big.text);

    // 6. 画像更新进历史：旧文本必须能在 profile_history 里找到
    const p1 = await opProfileSet('第一版画像：用户是初中生，擅长信息技术。', 'self-test');
    const p2 = await opProfileSet('第二版画像：用户是初中生，擅长信息技术，讨厌废话。', 'self-test');
    const histRows = db().prepare('SELECT text, op FROM profile_history WHERE profile_id = 1 ORDER BY at, id').all();
    const histTexts = histRows.map((r) => r.text);
    check('画像更新进历史',
      p1.ok && p2.ok && histRows.length === 2
      && histTexts.includes('第一版画像：用户是初中生，擅长信息技术。')
      && histRows.every((r) => ['insert', 'replace'].includes(r.op)),
      `profile_history ${histRows.length} 条：${histRows.map((r) => r.op).join('/')}`);

    // 7. 画像仍然只有一行（CHECK id=1 + ON CONFLICT）
    const profRows = db().prepare('SELECT COUNT(*) AS n FROM profile').get().n;
    check('画像只有一行', profRows === 1, `profile 行数 ${profRows}`);

    // 8. 时间线与筛选：kind/日期过滤可用
    const filtered = await opTimeline({ kind: 'todo', limit: 10 });
    const noMatch = await opTimeline({ from: '2000-01-01', to: '2000-01-02' });
    check('时间线筛选', filtered.ok && filtered.text.includes('长摘要') && noMatch.ok && noMatch.text.includes('没有符合条件'),
      noMatch.text);

    // 9. mem_summarize 批量写：一次收两条事件
    const evBefore = db().prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const s1 = await opSummarize({
      entries: [
        { kind: 'decision', subject: '批量收口', summary: '决定把一段工作收成两条事件' },
        { kind: 'todo', subject: '批量收口后续', summary: '下次检查时间线是否完整' },
      ],
    }, 'self-test');
    const evAfter = db().prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const tl = await opTimeline({ kind: 'decision', limit: 5 });
    check('mem_summarize 批量写',
      s1.ok && /已写入 2 条事件/.test(s1.text) && evAfter === evBefore + 2 && tl.text.includes('批量收口'),
      s1.text.split('\n')[0]);

    // 10. mem_summarize 顺手改写画像：旧值进历史
    const histBefore = db().prepare('SELECT COUNT(*) AS n FROM profile_history').get().n;
    const third = '第三版画像：用户是初中生，擅长信息技术，要求中文回答。';
    const s2 = await opSummarize({
      entries: [{ kind: 'preference', subject: '语言偏好', summary: '用户要求中文回答' }],
      profile: third,
    }, 'self-test');
    const profRow = db().prepare('SELECT text FROM profile WHERE id = 1').get();
    const histAfter = db().prepare('SELECT COUNT(*) AS n FROM profile_history').get().n;
    check('mem_summarize 画像更新',
      s2.ok && profRow.text === third && histAfter === histBefore + 1 && /画像：已更新/.test(s2.text),
      `${s2.text.split('\n')[0]}；profile_history ${histBefore}→${histAfter}`);

    // 11. entries 里有一条非法：整批拒绝，一条都不写
    const evBeforeBad = db().prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const bad2 = await opSummarize({
      entries: [
        { kind: 'milestone', subject: '合法的一条', summary: '不该落盘' },
        { kind: 'note', subject: '非法类型', summary: '应该被拒' },
      ],
    }, 'self-test');
    const evAfterBad = db().prepare('SELECT COUNT(*) AS n FROM events').get().n;
    check('entries 非法整批拒绝',
      bad2.ok === false && bad2.text.includes('第 2 条') && evAfterBad === evBeforeBad,
      bad2.text);

    // 12. 画像超 600 字：整批拒绝（事件也不写）
    const evBeforeBig = db().prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const big2 = await opSummarize({
      entries: [{ kind: 'todo', subject: '不该写入', summary: '画像超长时事件也不该落盘' }],
      profile: '字'.repeat(601),
    }, 'self-test');
    const evAfterBig = db().prepare('SELECT COUNT(*) AS n FROM events').get().n;
    check('summarize 画像超长整批拒绝',
      big2.ok === false && big2.text.includes('改写') && evAfterBig === evBeforeBig,
      big2.text);
  } finally {
    try { DB?.close(); } catch { /* 已关 */ }
    DB = null;
    delete process.env.DSH_MEMDB_DB;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留给系统清理 */ }
  }

  const pass = checks.filter((c) => c.pass).length;
  console.log(`\n自测结果：${pass}/${checks.length} 项通过`);
  return { ok: pass === checks.length, text: `自测 ${pass}/${checks.length} 项通过` };
}

// ── 工具注册 ────────────────────────────────────────────────────────────────

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
    tool('mem_event',
      '写一条记忆库事件（时间线）：做过什么决定/做成了什么/出了什么事故/用户表达了什么偏好/留下什么待办。'
      + 'kind 只允许 decision|milestone|incident|preference|todo；summary 上限 120 字，超了会自动截断。'
      + '只记结论，不记过程。注意：客观事实用 proj_put，不要写这里。',
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'subject', 'summary'],
        properties: {
          kind: { type: 'string', enum: KINDS, description: '决定 / 里程碑 / 事故 / 偏好 / 待办' },
          subject: { type: 'string', description: '这件事关于什么（几个字，如「项目库 v1 上线」）' },
          summary: { type: 'string', description: '一句话结论，≤120 字。超了会被截断。' },
          source: { type: 'string', description: '出处：文件:行、URL 或插件目录（可选）' },
          refs: { type: 'string', description: '关联的东西（可选，如会话 id、issue 号、另一条事件）' },
        },
      },
      (a, s2) => opEvent(a, s2)),
    tool('mem_timeline',
      '按时间倒序列出记忆库事件，每条一行「日期 类型 主题 — 摘要」，默认最近 20 条。'
      + '可传 from/to（YYYY-MM-DD，按本地自然日）与 kind 过滤。回答"今天/那几天做了什么"用它。'
      + '想知道"最近做了什么/上次到哪一步"时读它；也可以不读。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', description: '起始日期 YYYY-MM-DD（含当天）' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD（含当天）' },
          kind: { type: 'string', enum: KINDS, description: '只看某一种类型' },
          limit: { type: 'number', description: '最多几条，默认 20，上限 200' },
        },
      },
      (a) => opTimeline(a)),
    tool('mem_who',
      '返回当前用户画像（一段 ≤600 字的可读文本，含更新时间）。回答"用户是怎样的人/讨厌什么/擅长什么"用它；'
      + '尚未建立时会明确说没有。'
      + '本机存有一份 ≤600 字的用户画像（偏好/忌讳/长期目标）。需要判断用户想要什么时读它；不需要就不读，不读不影响其它功能。',
      { type: 'object', additionalProperties: false, properties: {} },
      () => opWho()),
    tool('mem_summarize',
      '把一段刚做完的活收口成记忆：entries 逐条写进事件时间线（与 mem_event 同一套校验与截断），'
      + 'profile 若给则整段改写当前画像（≤600 字，旧值进历史）。'
      + '什么时候用由你自己判断：一段活告一段落、或用户明确说"记一下"时调；没有值得记的结论就别调。'
      + '任何一条 entries 非法或画像超 600 字，整批不写入。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            description: '要记的事件，一条一个结论（不超过 40 条）',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'subject', 'summary'],
              properties: {
                kind: { type: 'string', enum: KINDS, description: '决定 / 里程碑 / 事故 / 偏好 / 待办' },
                subject: { type: 'string', description: '这件事关于什么，几个字' },
                summary: { type: 'string', description: '一句话结论，≤120 字，超了截断' },
                source: { type: 'string', description: '出处：文件:行、URL、插件目录（可选）' },
              },
            },
          },
          profile: {
            type: 'string',
            description: '可选：改写后的完整画像（≤600 字，整段重写而不是追加；不给就只写事件）',
          },
        },
      },
      (a, s2) => opSummarize(a, s2)),
  ];
}

export const inject = ['tools'];

export async function apply(ctx) {
  for (const definition of buildToolDefinitions()) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-memdb: ${definition.name}`);
  }
}

// ── CLI：node index.js --event '<json>' | --timeline | --who | --set-profile <text> ─
//          --seed [YYYY-MM-DD] | --stats | --self-test | --profile-history
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const flag = (name) => {
    const i = process.argv.indexOf(name);
    if (i < 0) return undefined;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
  };
  const run = async () => {
    if (flag('--self-test')) {
      const r = await opSelfTest();
      process.exitCode = r.ok ? 0 : 1;
    } else if (flag('--seed')) {
      const arg = flag('--seed');
      const day = seedDay(typeof arg === 'string' ? arg : null);
      console.log((await opSeed(day)).text);
      console.log((await opStats()).text);
    } else if (flag('--event')) {
      let payload;
      const raw = flag('--event');
      if (typeof raw !== 'string') { console.log('用法：--event \'{"kind":"milestone","subject":"…","summary":"…"}\''); process.exit(2); }
      try { payload = JSON.parse(raw); } catch { console.log('--event 需要 JSON'); process.exit(2); }
      const r = await opEvent(payload, 'cli');
      console.log(r.text);
      if (!r.ok) process.exitCode = 2;
    } else if (flag('--timeline')) {
      const r = await opTimeline({
        from: typeof flag('--from') === 'string' ? flag('--from') : undefined,
        to: typeof flag('--to') === 'string' ? flag('--to') : undefined,
        kind: typeof flag('--kind') === 'string' ? flag('--kind') : undefined,
        limit: typeof flag('--limit') === 'string' ? Number(flag('--limit')) : undefined,
      });
      console.log(r.text);
      if (!r.ok) process.exitCode = 2;
    } else if (flag('--who')) {
      console.log((await opWho()).text);
    } else if (flag('--set-profile')) {
      let text = flag('--set-profile');
      if (typeof text !== 'string') { console.log('用法：--set-profile "<画像文本，≤600 字>" 或 --set-profile-file <路径>'); process.exit(2); }
      const r = await opProfileSet(text, 'cli');
      console.log(r.text);
      if (!r.ok) process.exitCode = 2;
    } else if (flag('--set-profile-file')) {
      const f = flag('--set-profile-file');
      if (typeof f !== 'string' || !fs.existsSync(f)) { console.log('文件不存在'); process.exit(2); }
      const r = await opProfileSet(fs.readFileSync(f, 'utf8'), 'cli');
      console.log(r.text);
      if (!r.ok) process.exitCode = 2;
    } else if (flag('--profile-history')) {
      const rows = db().prepare('SELECT * FROM profile_history ORDER BY at, id').all();
      if (!rows.length) console.log('画像没有历史（只写过一次，或从未写入）');
      else console.log(rows.map((r, i) => `${i + 1}. ${fmtDateTime(r.at)} ${r.op} ${charLen(r.text)} 字：${clip(r.text, 60)[0]}`).join('\n'));
    } else if (flag('--stats')) {
      console.log((await opStats()).text);
    } else {
      console.log('dsh-memdb CLI');
      console.log('  --event \'<json>\'           写一条事件');
      console.log('  --timeline [--from d] [--to d] [--kind k] [--limit n]');
      console.log('  --who                      当前画像');
      console.log('  --set-profile "<text>"     写画像（≤600 字，旧的进历史）');
      console.log('  --set-profile-file <path>  从文件写画像');
      console.log('  --profile-history          画像历史');
      console.log('  --seed [YYYY-MM-DD]        灌首批四条里程碑（幂等）');
      console.log('  --stats                    统计');
      console.log('  --self-test                自测（临时库，不碰真库）');
    }
  };
  run().catch((error) => {
    console.error('失败：', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
