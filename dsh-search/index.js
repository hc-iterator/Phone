/**
 * dsh-search —— 精确的中文会话检索（替代 FTS5 unicode61 的"中文搜不到"）
 *
 * 背景（2026-11-06 实测）：
 *   DSH 自带会话搜索用 SQLite FTS5 + tokenize='unicode61'。中文没有空格，
 *   整句被当成**一个 token** ⇒ 搜"波特率"命中 0 条（英文词能命中）。
 *   换成 trigram 后 3 字能中，但**两字词仍然 0**（中文两字词太常见）。
 *
 * 做法：
 *   · 分词用 **DeepSeek 官方 BPE 词表**（128k vocab），中文能得到"波特""确认""身份"这类词级单位；
 *   · 索引只存「消息 → 唯一 token 集合」，不存出现次数（体积小一个量级）；
 *   · 查询用 **AND** 语义（所有 token 都要命中），精度来自交集而不是词表大小；
 *   · 会话日志是多帧 zstd（追加写入），按 magic 逐帧解码（沿用 dsh-agent-bus 的现成做法）。
 *
 * 只索引 user / assistant 的**正文**，跳过 reasoning 与 request/header（后者在样本里占 83 万字符纯噪声）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const TEXT_CAP = 2000;         // 单条消息最多索引多少字（BPE 是主要耗时，压小最有效）
const TOOL_CAP = 600;          // 工具输出只留开头：后面多是 JSON 噪声，检索价值低
const MAX_DOCS_PER_TOKEN = 5000; // 单个 token 命中过多时截断（防止"的"这类高频词拖垮查询）

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
  },
  required: ['ok', 'text'],
};

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function dataDir() {
  const dir = path.join(dshHome(), 'search');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── DeepSeek BPE 分词器（词表 7.5 MB，启动解析一次）────────────────────────────
function bytesToUnicode() {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  }
  const map = new Map();
  for (let i = 0; i < bs.length; i++) map.set(bs[i], String.fromCharCode(cs[i]));
  return map;
}

let TOKENIZER = null;

function loadTokenizer() {
  if (TOKENIZER) return TOKENIZER;
  const file = path.join(dataDir(), 'tokenizer.json');
  if (!fs.existsSync(file)) {
    throw new Error(`缺少分词器词表：${file}\n用 tools/search/fetch-tokenizer.ps1 下载（约 7.5 MB，来源 hf-mirror.com）`);
  }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ranks = new Map();
  for (let i = 0; i < j.model.merges.length; i++) {
    const m = j.model.merges[i];
    ranks.set(typeof m === 'string' ? m : m[0] + ' ' + m[1], i);
  }
  TOKENIZER = { ranks, byteToUni: bytesToUnicode() };
  return TOKENIZER;
}

function tokenize(text) {
  const { ranks, byteToUni } = loadTokenizer();
  const out = [];
  const parts = text.match(/[\u4e00-\u9fff\u3040-\u30ff]+|\p{N}{1,3}|[^\s\u4e00-\u9fff\u3040-\u30ff\p{N}]+|\s+/gu) || [];
  for (const part of parts) {
    let s = '';
    for (const b of Buffer.from(part, 'utf8')) s += byteToUni.get(b);
    let syms = Array.from(s);
    while (syms.length > 1) {
      let best = Infinity, at = -1;
      for (let i = 0; i < syms.length - 1; i++) {
        const r = ranks.get(syms[i] + ' ' + syms[i + 1]);
        if (r !== undefined && r < best) { best = r; at = i; }
      }
      if (at < 0) break;
      syms = syms.slice(0, at).concat([syms[at] + syms[at + 1]], syms.slice(at + 2));
    }
    for (const sym of syms) out.push(sym);
  }
  return out;
}

// ── 会话解码 ────────────────────────────────────────────────────────────────
function decodeFrames(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return []; }
  const events = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    try {
      const text = zstdDecompressSync(buf.subarray(i)).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { /* 半行 */ }
      }
    } catch { /* 该帧坏了，跳过 */ }
    i += ZSTD_MAGIC.length;
  }
  return events;
}

/** 从事件流里抽出可检索的正文。 */
function extractDocs(events, sessionId) {
  const docs = [];
  const push = (role, ts, text) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length < 2) return;
    docs.push({ role, ts, text: t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) : t });
  };
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const ts = Number(e.time) || Date.now();
    if (e.type === 'user/message') {
      const content = e.data?.content;
      const text = Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
      push('user', ts, text);
    } else if (e.type === 'assistant/message') {
      const content = e.data?.message?.content;
      // 只取 text，跳过 reasoning（模型内部思考，检索价值低且噪声大）
      const text = Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
      push('assistant', ts, text);
    } else if (e.type === 'tool/result') {
      const m = e.data?.message;
      const text = typeof m === 'string' ? m : JSON.stringify(m ?? '');
      // 工具输出只留开头：BPE 是主要耗时，尾部多是 JSON 噪声
      if (text && text.length > 40) push('tool', ts, text.length > TOOL_CAP ? text.slice(0, TOOL_CAP) : text);
    }
  }
  return docs.map((d) => ({ ...d, session: sessionId }));
}

// ── 索引 ────────────────────────────────────────────────────────────────────
function openDb() {
  const file = path.join(dataDir(), 'index.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs(
      id INTEGER PRIMARY KEY,
      session TEXT NOT NULL,
      role TEXT NOT NULL,
      ts INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS postings(
      token TEXT NOT NULL,
      doc INTEGER NOT NULL,
      PRIMARY KEY(token, doc)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS ix_postings_token ON postings(token);
    CREATE TABLE IF NOT EXISTS files(
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      docs INTEGER NOT NULL
    );
  `);
  return db;
}

function indexFile(db, file, sessionId) {
  const st = fs.statSync(file);
  const known = db.prepare('SELECT mtime, size FROM files WHERE path = ?').get(file);
  if (known && known.mtime === Math.floor(st.mtimeMs) && known.size === st.size) return 0;

  // 重建这个会话：先删旧的（增量更新靠 mtime 判断，重写比打补丁简单且不易错）
  const oldDocs = db.prepare('SELECT id FROM docs WHERE session = ?').all(sessionId);
  for (const row of oldDocs) db.prepare('DELETE FROM postings WHERE doc = ?').run(row.id);
  db.prepare('DELETE FROM docs WHERE session = ?').run(sessionId);

  const events = decodeFrames(file);
  const docs = extractDocs(events, sessionId);
  const insDoc = db.prepare('INSERT INTO docs(session, role, ts, text) VALUES(?,?,?,?)');
  const insPost = db.prepare('INSERT OR IGNORE INTO postings(token, doc) VALUES(?,?)');
  for (const d of docs) {
    const info = insDoc.run(d.session, d.role, d.ts, d.text);
    const docId = Number(info.lastInsertRowid);
    const seen = new Set(tokenize(d.text));
    for (const tok of seen) insPost.run(tok, docId);
  }
  db.prepare('INSERT OR REPLACE INTO files(path, mtime, size, docs) VALUES(?,?,?,?)')
    .run(file, Math.floor(st.mtimeMs), st.size, docs.length);
  return docs.length;
}

function allSessionFiles() {
  const root = path.join(dshHome(), 'sessions');
  const out = [];
  let wsDirs = [];
  try { wsDirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue;
    const wsPath = path.join(root, ws.name);
    let sessions = [];
    try { sessions = fs.readdirSync(wsPath, { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory() || !s.name.startsWith('session-') && !/^[0-9a-f-]{36}$/.test(s.name)) continue;
      const file = path.join(wsPath, s.name, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) out.push({ file, sessionId: s.name, ws: ws.name });
    }
  }
  return out;
}

// ── 检索 ────────────────────────────────────────────────────────────────────
function search(db, query, limit) {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return { tokens, rows: [] };
  const stmt = db.prepare('SELECT doc FROM postings WHERE token = ? LIMIT ?');
  let candidate = null;
  for (const tok of tokens) {
    const set = new Set(stmt.all(tok, MAX_DOCS_PER_TOKEN).map((r) => r.doc));
    if (set.size === 0) return { tokens, rows: [] };
    candidate = candidate === null ? set : new Set([...candidate].filter((x) => set.has(x)));
    if (candidate.size === 0) return { tokens, rows: [] };
  }
  const getDoc = db.prepare('SELECT id, session, role, ts, text FROM docs WHERE id = ?');
  const rows = [];
  for (const id of candidate) {
    const d = getDoc.get(id);
    if (d) rows.push(d);
  }
  rows.sort((a, b) => b.ts - a.ts);
  return { tokens, rows: rows.slice(0, limit) };
}

// ── 工具 ────────────────────────────────────────────────────────────────────
async function opSearch(cfg, args = {}) {
  const query = String(args.query ?? '').trim();
  if (!query) return { ok: false, text: 'query 必填' };
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const db = openDb();
  try {
    const { tokens, rows } = search(db, query, limit);
    if (rows.length === 0) {
      return { ok: true, text: `没有命中（分词：${tokens.length} 个 token）。索引可能还没建，先调 search_reindex。` };
    }
    const lines = rows.map((r) => {
      const t = new Date(r.ts).toISOString().replace('T', ' ').slice(0, 16);
      const snippet = r.text.length > 160 ? r.text.slice(0, 160) + '…' : r.text;
      const sid = String(r.session).replace(/^session-/, '').slice(0, 8);
      return `[${t}] ${r.role}  ${sid}\n    ${snippet}`;
    });
    return { ok: true, text: `命中 ${rows.length} 条（分词 ${tokens.length} 个）：\n` + lines.join('\n') };
  } finally { db.close(); }
}

async function opReindex(cfg, args = {}) {
  const maxFiles = Number.isFinite(args.maxFiles) ? Number(args.maxFiles) : 0;
  const db = openDb();
  const started = Date.now();
  try {
    const files = allSessionFiles();
    const todo = maxFiles > 0 ? files.slice(0, maxFiles) : files;
    let docs = 0, done = 0, failed = 0;
    for (const f of todo) {
      try { docs += indexFile(db, f.file, f.sessionId); done++; }
      catch { failed++; }
      if (done % 50 === 0 && done > 0) { /* 只是让它可中断 */ }
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
    const postings = db.prepare('SELECT COUNT(*) AS n FROM postings').get().n;
    return {
      ok: true,
      text: `索引完成：处理 ${done} 个会话（失败 ${failed}），新增/更新 ${docs} 条消息\n`
        + `库里共 ${total} 条消息、${postings} 条倒排记录，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
    };
  } finally { db.close(); }
}

async function opStats() {
  const db = openDb();
  try {
    const docs = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
    const postings = db.prepare('SELECT COUNT(*) AS n FROM postings').get().n;
    const files = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
    const file = path.join(dataDir(), 'index.db');
    const size = fs.existsSync(file) ? (fs.statSync(file).size / 1024 / 1024).toFixed(1) : '0';
    return { ok: true, text: `会话 ${files} 个、消息 ${docs} 条、倒排 ${postings} 条，索引文件 ${size} MB` };
  } finally { db.close(); }
}

function tool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    },
    async execute(args) { return await run(args ?? {}); },
  };
}

function buildToolDefinitions() {
  return [
    tool(
      'search_sessions',
      'Search past conversations by EXACT Chinese/English text. Uses DeepSeek BPE tokens + AND semantics, so 2-character Chinese words work (unlike the built-in FTS5 search).',
      {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Text to look for, e.g. "波特率" or "烧写".' },
          limit: { type: 'number', description: 'Max results; default 10, max 50.' },
        },
      },
      (a) => opSearch(null, a),
    ),
    tool(
      'search_reindex',
      'Build or refresh the conversation index (incremental: only files whose mtime/size changed are re-decoded). Run it once before searching.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxFiles: { type: 'number', description: 'Only index the first N session files (debugging); omit for all.' },
        },
      },
      (a) => opReindex(null, a),
    ),
    tool(
      'search_stats',
      'Show index statistics (sessions, messages, postings, file size).',
      { type: 'object', additionalProperties: false, properties: {} },
      () => opStats(),
    ),
  ];
}

export const inject = ['tools'];

export async function apply(ctx) {
  for (const definition of buildToolDefinitions()) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-search: ${definition.name}`);
  }
}
// ── 命令行冒烟测试：node index.js --smoke [N] ────────────────────────────────
// 不用重启 DSH 就能验证"解码 + 分词 + 建索引 + 检索"这条链。
if (process.argv[1] && process.argv[1].endsWith('index.js') && process.argv.includes('--smoke')) {
  const n = Number(process.argv[process.argv.indexOf('--smoke') + 1]) || 3;
  const db = openDb();
  try {
    const files = allSessionFiles().slice(0, n);
    console.log(`会话文件 ${files.length} 个`);
    let docs = 0;
    for (const f of files) { docs += indexFile(db, f.file, f.sessionId); }
    console.log(`索引消息 ${docs} 条`);
    const st = db.prepare('SELECT COUNT(*) AS n FROM docs').get();
    const po = db.prepare('SELECT COUNT(*) AS n FROM postings').get();
    console.log(`库内：消息 ${st.n} 条，倒排 ${po.n} 条`);
    for (const q of ['ClawsGO', 'WebSocket', 'terminal', '波特率']) {
      const r = search(db, q, 3);
      console.log(`\n查询 "${q}"  tokens=${r.tokens.length}  命中=${r.rows.length}`);
      for (const row of r.rows) console.log('   ' + row.role + ' | ' + row.text.slice(0, 80));
    }
  } finally { db.close(); }
}
// ── 全量索引：node index.js --index ─────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('index.js') && process.argv.includes('--index')) {
  const db = openDb();
  const started = Date.now();
  try {
    const files = allSessionFiles();
    console.log(`待处理会话 ${files.length} 个`);
    let i = 0, docs = 0, failed = 0;
    for (const f of files) {
      try { docs += indexFile(db, f.file, f.sessionId); } catch { failed++; }
      i++;
      if (i % 25 === 0) {
        const s = ((Date.now() - started) / 1000).toFixed(0);
        console.log(`进度 ${i}/${files.length}  消息 ${docs}  失败 ${failed}  已用 ${s}s`);
      }
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
    const postings = db.prepare('SELECT COUNT(*) AS n FROM postings').get().n;
    console.log(`完成：会话 ${i}（失败 ${failed}），消息 ${total}，倒排 ${postings}，用时 ${((Date.now()-started)/1000).toFixed(1)}s`);
  } finally { db.close(); }
}


