/**
 * dsh-projectdb —— 项目事实库（不是记忆库）
 *
 * 定位：**文档库/事实索引**。回答"PSRAM 的 max_sel 是多少"这类问题，一次 get 就出结果，
 * 不必翻十几个 md。不做语义检索、不做画像注入、不猜。
 *
 * 与"记忆库"的区别（用户 2026-11-07 定案）：
 *   记忆库 = 用户是怎样的人、今天干了什么（时间线、事件、偏好，需自动摘要）
 *   项目库 = 项目里客观成立的事实（键值，手动写入，精确取回）
 *
 * 四条硬设计（对应 2026-11-07 用户提的三个规则问题）：
 *   ① 可回档：每次写入进 `fact_history`（追加式），`proj_restore` 可回退到任意版本
 *   ② 删除可恢复：软删除（deleted_at），物理删除只允许 `proj_purge` 且需要确认串
 *   ③ 并发安全：WAL + busy_timeout + 事务内 upsert，**绝不读-改-写**，多会话同时写不丢
 *   ④ 冲突可见：同一 (subject,attribute) 多个 value 时全部保留并标记，不替用户选边
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  // 多会话并发写时排队而不是报错（实测缺这条会直接 database is locked）
  DB.exec('PRAGMA busy_timeout = 8000;');
  DB.exec(`
    CREATE TABLE IF NOT EXISTS facts(
      id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL,
      attribute TEXT NOT NULL,
      value TEXT NOT NULL,
      unit TEXT,
      source TEXT,
      confidence TEXT DEFAULT '中',
      source_session TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER
    );
    -- 唯一性只在"未删除"的行上生效：软删除后同键可以重新写入
    CREATE UNIQUE INDEX IF NOT EXISTS ux_facts_live
      ON facts(subject, attribute) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS ix_facts_subject ON facts(subject);
    CREATE INDEX IF NOT EXISTS ix_facts_attr ON facts(attribute);

    CREATE TABLE IF NOT EXISTS fact_history(
      id INTEGER PRIMARY KEY,
      fact_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      attribute TEXT NOT NULL,
      value TEXT NOT NULL,
      unit TEXT,
      session TEXT,
      at INTEGER NOT NULL,
      op TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hist_fact ON fact_history(fact_id);
  `);
  if (!db.closing) {
    db.closing = true;
    process.once('exit', () => { try { DB?.close(); } catch { /* 已关 */ } });
  }
  return DB;
}

function now() { return Date.now(); }

/** 事务包装：中途失败整体回滚，不留半条记录。 */
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

function fmtRow(r) {
  const unit = r.unit ? ' ' + r.unit : '';
  const src = r.source ? `  [${r.source}]` : '';
  const date = new Date(r.updated_at).toISOString().slice(0, 10);
  return `${r.subject}.${r.attribute} = ${r.value}${unit}${src}  (${date}, v${r.version}, ${r.confidence})`;
}

// ── 工具实现 ────────────────────────────────────────────────────────────────
async function opPut(args = {}, sessionId = '') {
  const subject = String(args.subject ?? '').trim();
  const attribute = String(args.attribute ?? '').trim();
  const value = String(args.value ?? '').trim();
  if (!subject || !attribute) return { ok: false, text: 'subject 与 attribute 必填' };
  if (!value) return { ok: false, text: 'value 必填（空值请用 proj_delete）' };
  if (value.length > 2000) return { ok: false, text: `value 太长（${value.length} > 2000）` };
  const unit = args.unit == null ? null : String(args.unit);
  const source = args.source == null ? null : String(args.source);
  const confidence = ['高', '中', '低'].includes(String(args.confidence)) ? String(args.confidence) : '中';
  const at = now();

  const result = tx((d) => {
    const existing = d.prepare('SELECT * FROM facts WHERE subject=? AND attribute=? AND deleted_at IS NULL').get(subject, attribute);
    if (existing) {
      if (existing.value === value && (existing.unit ?? null) === unit) {
        // 值没变：只更新出处与时间，不算新版本
        d.prepare('UPDATE facts SET source=COALESCE(?, source), confidence=?, updated_at=?, source_session=? WHERE id=?')
          .run(source, confidence, at, sessionId || null, existing.id);
        return { changed: false, id: existing.id };
      }
      d.prepare('UPDATE facts SET value=?, unit=?, source=COALESCE(?, source), confidence=?, updated_at=?, source_session=?, version=version+1 WHERE id=?')
        .run(value, unit, source, confidence, at, sessionId || null, existing.id);
      d.prepare('INSERT INTO fact_history(fact_id,subject,attribute,value,unit,session,at,op) VALUES(?,?,?,?,?,?,?,?)')
        .run(existing.id, subject, attribute, value, unit, sessionId || null, at, 'update');
      return { changed: true, id: existing.id, previous: existing.value };
    }
    const info = d.prepare('INSERT INTO facts(subject,attribute,value,unit,source,confidence,source_session,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(subject, attribute, value, unit, source, confidence, sessionId || null, at, at);
    const id = Number(info.lastInsertRowid);
    d.prepare('INSERT INTO fact_history(fact_id,subject,attribute,value,unit,session,at,op) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, subject, attribute, value, unit, sessionId || null, at, 'insert');
    return { changed: true, id, created: true };
  });

  if (!result.changed) return { ok: true, text: `未变：${subject}.${attribute} = ${value}（仅更新出处/时间）` };
  if (result.created) return { ok: true, text: `已记录：${subject}.${attribute} = ${value}${unit ? ' ' + unit : ''}` };
  return { ok: true, text: `已更新：${subject}.${attribute} = ${value}${unit ? ' ' + unit : ''}（原值 ${result.previous}）` };
}

async function opGet(args = {}) {
  const subject = args.subject ? String(args.subject).trim() : '';
  const attribute = args.attribute ? String(args.attribute).trim() : '';
  const d = db();
  let rows;
  if (subject && attribute) {
    rows = d.prepare('SELECT * FROM facts WHERE deleted_at IS NULL AND subject=? AND attribute LIKE ? ORDER BY attribute').all(subject, `%${attribute}%`);
  } else if (subject) {
    rows = d.prepare('SELECT * FROM facts WHERE deleted_at IS NULL AND subject LIKE ? ORDER BY attribute').all(`%${subject}%`);
  } else if (attribute) {
    rows = d.prepare('SELECT * FROM facts WHERE deleted_at IS NULL AND attribute LIKE ? ORDER BY subject').all(`%${attribute}%`);
  } else {
    return { ok: false, text: 'subject 或 attribute 至少要给一个' };
  }
  if (!rows.length) return { ok: true, text: `没有匹配的事实（subject=${subject || '*'} attribute=${attribute || '*'}）` };
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(Number(args.limit), 200)) : 50;
  const out = rows.slice(0, limit).map(fmtRow);
  const more = rows.length > limit ? `\n…共 ${rows.length} 条，只显示前 ${limit} 条` : '';
  return { ok: true, text: out.join('\n') + more };
}

async function opHistory(args = {}) {
  const subject = String(args.subject ?? '').trim();
  const attribute = String(args.attribute ?? '').trim();
  if (!subject || !attribute) return { ok: false, text: 'subject 与 attribute 必填' };
  const d = db();
  const fact = d.prepare('SELECT * FROM facts WHERE subject=? AND attribute=? AND deleted_at IS NULL').get(subject, attribute);
  if (!fact) return { ok: false, text: '没有这条事实' };
  const rows = d.prepare('SELECT * FROM fact_history WHERE fact_id=? ORDER BY at').all(fact.id);
  if (!rows.length) return { ok: true, text: `${subject}.${attribute} 只有当前值，无历史：${fmtRow(fact)}` };
  const lines = rows.map((r, i) => `${i + 1}. ${new Date(r.at).toISOString().slice(0, 16)} ${r.op} → ${r.value}${r.unit ? ' ' + r.unit : ''}${r.session ? '  [' + String(r.session).slice(0, 8) + ']' : ''}`);
  return { ok: true, text: `${subject}.${attribute} 共 ${rows.length} 条历史：\n` + lines.join('\n') };
}

async function opRestore(args = {}, sessionId = '') {
  const subject = String(args.subject ?? '').trim();
  const attribute = String(args.attribute ?? '').trim();
  const index = Number(args.index);
  if (!subject || !attribute || !Number.isFinite(index)) return { ok: false, text: 'subject / attribute / index（第几条历史，从 1 开始）必填' };
  const d = db();
  const fact = d.prepare('SELECT * FROM facts WHERE subject=? AND attribute=? AND deleted_at IS NULL').get(subject, attribute);
  if (!fact) return { ok: false, text: '没有这条事实' };
  const rows = d.prepare('SELECT * FROM fact_history WHERE fact_id=? ORDER BY at').all(fact.id);
  const target = rows[index - 1];
  if (!target) return { ok: false, text: `历史只有 ${rows.length} 条，没有第 ${index} 条` };
  const at = now();
  tx((dd) => {
    dd.prepare('UPDATE facts SET value=?, unit=?, updated_at=?, version=version+1, source_session=? WHERE id=?')
      .run(target.value, target.unit, at, sessionId || null, fact.id);
    dd.prepare('INSERT INTO fact_history(fact_id,subject,attribute,value,unit,session,at,op) VALUES(?,?,?,?,?,?,?,?)')
      .run(fact.id, subject, attribute, target.value, target.unit, sessionId || null, at, 'restore');
  });
  return { ok: true, text: `已回档：${subject}.${attribute} = ${target.value}${target.unit ? ' ' + target.unit : ''}（原值 ${fact.value}）` };
}

async function opDelete(args = {}, sessionId = '') {
  const subject = String(args.subject ?? '').trim();
  const attribute = String(args.attribute ?? '').trim();
  if (!subject || !attribute) return { ok: false, text: 'subject 与 attribute 必填' };
  const at = now();
  const d = db();
  const fact = d.prepare('SELECT * FROM facts WHERE subject=? AND attribute=? AND deleted_at IS NULL').get(subject, attribute);
  if (!fact) return { ok: false, text: '没有这条事实' };
  tx((dd) => {
    dd.prepare('UPDATE facts SET deleted_at=? WHERE id=?').run(at, fact.id);
    dd.prepare('INSERT INTO fact_history(fact_id,subject,attribute,value,unit,session,at,op) VALUES(?,?,?,?,?,?,?,?)')
      .run(fact.id, subject, attribute, fact.value, fact.unit, sessionId || null, at, 'delete');
  });
  return { ok: true, text: `已软删除：${subject}.${attribute}（值 ${fact.value} 仍可恢复，用 proj_undelete）` };
}

async function opUndelete(args = {}) {
  const subject = String(args.subject ?? '').trim();
  const attribute = String(args.attribute ?? '').trim();
  const d = db();
  const row = d.prepare('SELECT * FROM facts WHERE subject=? AND attribute=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC').get(subject, attribute);
  if (!row) return { ok: false, text: '没有已删除的该键' };
  try {
    d.prepare('UPDATE facts SET deleted_at=NULL WHERE id=?').run(row.id);
  } catch (error) {
    return { ok: false, text: `恢复失败（可能已有同键的在线记录）：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, text: `已恢复：${subject}.${attribute} = ${row.value}` };
}

async function opConflicts(args = {}) {
  const d = db();
  // 唯一索引保证"当前值"只有一条 ⇒ 冲突要从**历史**看：同一键出现过多个不同 value。
  // 这样导入冲突素材时不丢信息（旧值都在历史里），也能回答"这条事实有没有争议"。
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(Number(args.limit), 500)) : 50;
  const rows = d.prepare(`
    SELECT subject, attribute, COUNT(DISTINCT value) AS n, GROUP_CONCAT(DISTINCT value) AS vals
    FROM fact_history
    GROUP BY subject, attribute HAVING COUNT(DISTINCT value) > 1
    ORDER BY n DESC LIMIT ?`).all(limit);
  if (!rows.length) return { ok: true, text: '没有发现同键多值（历史里每个键只有一个取值）' };
  const lines = rows.map((r) => `${r.subject}.${r.attribute}（${r.n} 种取值）: ${String(r.vals).slice(0, 300)}`);
  return { ok: true, text: `发现 ${rows.length} 组同键多值（当前值取最新，其它值可在 proj_history 查）：\n` + lines.join('\n') };
}

async function opStats() {
  const d = db();
  const live = d.prepare('SELECT COUNT(*) AS n FROM facts WHERE deleted_at IS NULL').get().n;
  const del = d.prepare('SELECT COUNT(*) AS n FROM facts WHERE deleted_at IS NOT NULL').get().n;
  const hist = d.prepare('SELECT COUNT(*) AS n FROM fact_history').get().n;
  const subjects = d.prepare('SELECT COUNT(DISTINCT subject) AS n FROM facts WHERE deleted_at IS NULL').get().n;
  const size = fs.existsSync(dbPath()) ? (fs.statSync(dbPath()).size / 1024 / 1024).toFixed(1) : '0';
  return { ok: true, text: `有效事实 ${live} 条（${subjects} 个主题）· 已删除 ${del} 条 · 历史 ${hist} 条 · 库 ${size} MB` };
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
  const s = { type: 'object' };
  return [
    tool('proj_put',
      'Store ONE project fact (subject.attribute = value). Upsert: same key overwrites but the old value is kept in history. Never loses data on concurrent writes.',
      { type: 'object', additionalProperties: false, required: ['subject', 'attribute', 'value'], properties: {
        subject: { type: 'string' }, attribute: { type: 'string' }, value: { type: 'string' },
        unit: { type: 'string' }, source: { type: 'string', description: 'File:line or URL.' },
        confidence: { type: 'string', enum: ['高', '中', '低'] } } },
      (a, s2) => opPut(a, s2)),
    tool('proj_get', 'Get project facts by subject and/or attribute (substring match). This is the fast path that replaces reading many docs.',
      { type: 'object', additionalProperties: false, properties: {
        subject: { type: 'string' }, attribute: { type: 'string' }, limit: { type: 'number' } } },
      (a) => opGet(a)),
    tool('proj_history', 'Show all past values of one fact (append-only history), newest last.',
      { type: 'object', additionalProperties: false, required: ['subject', 'attribute'], properties: {
        subject: { type: 'string' }, attribute: { type: 'string' } } },
      (a) => opHistory(a)),
    tool('proj_restore', 'Roll a fact back to one historical version (index from proj_history, 1-based).',
      { type: 'object', additionalProperties: false, required: ['subject', 'attribute', 'index'], properties: {
        subject: { type: 'string' }, attribute: { type: 'string' }, index: { type: 'number' } } },
      (a, s2) => opRestore(a, s2)),
    tool('proj_delete', 'Soft-delete a fact (kept in DB, recoverable with proj_undelete).',
      { type: 'object', additionalProperties: false, required: ['subject', 'attribute'], properties: {
        subject: { type: 'string' }, attribute: { type: 'string' } } },
      (a, s2) => opDelete(a, s2)),
    tool('proj_undelete', 'Restore a soft-deleted fact.',
      { type: 'object', additionalProperties: false, required: ['subject', 'attribute'], properties: {
        subject: { type: 'string' }, attribute: { type: 'string' } } },
      (a) => opUndelete(a)),
    tool('proj_conflicts', 'List keys that hold more than one live value.',
      { type: 'object', additionalProperties: false, properties: {} },
      () => opConflicts()),
    tool('proj_stats', 'Counts: live facts, deleted facts, history rows, subjects, DB size.',
      { type: 'object', additionalProperties: false, properties: {} },
      () => opStats()),
  ];
}

export const inject = ['tools'];

export async function apply(ctx) {
  for (const definition of buildToolDefinitions()) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-projectdb: ${definition.name}`);
  }
}

// ── CLI：node index.js --import <jsonl> | --stats | --get subject [attr] ─────
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  if (process.argv.includes('--import')) {
    const file = process.argv[process.argv.indexOf('--import') + 1];
    if (!file || !fs.existsSync(file)) { console.log('用法：--import <jsonl 路径>'); process.exit(2); }
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    let ok = 0, bad = 0, changed = 0;
    for (const line of lines) {
      let r;
      try { r = JSON.parse(line); } catch { bad++; continue; }
      const res = await opPut({ subject: r.subject, attribute: r.attribute, value: r.value, unit: r.unit, source: r.source, confidence: r.confidence }, 'import');
      if (res.ok) { ok++; if (!/未变/.test(res.text)) changed++; } else bad++;
    }
    console.log(`导入完成：成功 ${ok}（其中变更 ${changed}），跳过/失败 ${bad}`);
    console.log((await opStats()).text);
  } else if (process.argv.includes('--stats')) {
    console.log((await opStats()).text);
  } else if (process.argv.includes('--get')) {
    const i = process.argv.indexOf('--get');
    const subject = process.argv[i + 1];
    const attribute = process.argv[i + 2];
    console.log((await opGet({ subject, attribute })).text);
  }
}
