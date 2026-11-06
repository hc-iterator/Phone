/**
 * dsh-account —— 让 agent 能查「我还有多少钱」和「我烧了多少 token」
 *
 * ① 余额：直接问官方 `GET https://api.deepseek.com/user/balance`。
 *    凭据来源顺序：环境变量 DEEPSEEK_API_KEY → `.dsh/.credentials.yaml` 的 refs。
 *    ⚠️ 不走小鲸鱼插件的 `/dsh-whale/balance.json`：那条路由被 DSH 的连接栅栏挡着（实测 401），
 *    而宿主内部调自己的 HTTP 拿不到 Web 会话凭据。直接问官方反而更简单、更快。
 *
 * ② token 用量：DSH 每条 assistant/message 都带 usage（input/output/cacheRead/cacheWrite/total），
 *    按会话日志聚合。日志是**多帧 zstd**（追加写入），所以按 magic 逐帧解码。
 *    为了不每次都全量重解：按 (mtime,size) 记忆已索引的文件，只处理变动的那些。
 *
 * 单位说明：DeepSeek 的余额接口给的是字符串（"115.79"），这里转成数字再格式化；
 * cacheRead 单独列出来——缓存命中便宜一个量级，混在 input 里会看不懂账。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BALANCE_TTL_MS = 60000;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
  required: ['ok', 'text'],
};

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// ── 凭据 ────────────────────────────────────────────────────────────────────
/** 从 .credentials.yaml 的 refs 段里取一个原始值（该文件是扁平的 key: value，不需要完整 YAML 解析）。 */
function credentialFromFile(name) {
  const file = path.join(dshHome(), '.credentials.yaml');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let inRefs = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) { inRefs = false; continue; }
    if (!inRefs) continue;
    const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m || m[1] !== name) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (!v || /^#/.test(v)) return null;
    return v;
  }
  return null;
}

function apiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return credentialFromFile('DEEPSEEK_API_KEY');
}

// ── 余额 ────────────────────────────────────────────────────────────────────
let BALANCE_CACHE = { at: 0, payload: null, error: null };

async function fetchBalance(force = false) {
  const now = Date.now();
  if (!force && BALANCE_CACHE.payload && now - BALANCE_CACHE.at < BALANCE_TTL_MS) return BALANCE_CACHE;

  const key = apiKey();
  if (!key) {
    BALANCE_CACHE = { at: now, payload: null, error: '没有找到 DEEPSEEK_API_KEY（环境变量或 .credentials.yaml 的 refs）' };
    return BALANCE_CACHE;
  }
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      BALANCE_CACHE = { at: now, payload: null, error: `HTTP ${res.status}` };
      return BALANCE_CACHE;
    }
    const data = await res.json();
    const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
    const cny = infos.find((i) => String(i?.currency).toUpperCase() === 'CNY') ?? infos[0] ?? null;
    BALANCE_CACHE = {
      at: now,
      error: null,
      payload: {
        available: data?.is_available === true,
        currency: cny?.currency ?? null,
        total: cny?.total_balance != null ? Number(cny.total_balance) : null,
        toppedUp: cny?.topped_up_balance != null ? Number(cny.topped_up_balance) : null,
        granted: cny?.granted_balance != null ? Number(cny.granted_balance) : null,
        others: infos.filter((i) => i !== cny).map((i) => ({ currency: i.currency, total: Number(i.total_balance) })),
      },
    };
    return BALANCE_CACHE;
  } catch (error) {
    BALANCE_CACHE = { at: now, payload: null, error: error instanceof Error ? error.message : String(error) };
    return BALANCE_CACHE;
  }
}

function money(n, currency) {
  if (!Number.isFinite(n)) return '—';
  const sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : (currency ? currency + ' ' : '');
  return sym + n.toFixed(2);
}

async function opBalance(args = {}) {
  const snap = await fetchBalance(args.force === true);
  if (!snap.payload) return { ok: false, text: `查不到余额：${snap.error}` };
  const p = snap.payload;
  const lines = [
    `余额：${money(p.total, p.currency)}（充值 ${money(p.toppedUp, p.currency)} + 赠金 ${money(p.granted, p.currency)}）`,
    `账户状态：${p.available ? '可用' : '⚠️ 不可用'}`,
  ];
  if (p.others.length) lines.push('其它币种：' + p.others.map((o) => `${o.currency} ${o.total.toFixed(2)}`).join('、'));
  lines.push(`（缓存 ${Math.round((Date.now() - snap.at) / 1000)} 秒，force:true 可强制刷新）`);
  return { ok: true, text: lines.join('\n') };
}

// ── token 用量索引 ──────────────────────────────────────────────────────────
let DB = null;

function db() {
  if (DB) return DB;
  const dir = path.join(dshHome(), 'usage');
  fs.mkdirSync(dir, { recursive: true });
  DB = new DatabaseSync(path.join(dir, 'usage.db'));
  DB.exec('PRAGMA journal_mode = WAL;');
  DB.exec('PRAGMA synchronous = NORMAL;');
  DB.exec(`
    CREATE TABLE IF NOT EXISTS calls(
      id INTEGER PRIMARY KEY,
      session TEXT NOT NULL,
      ts INTEGER NOT NULL,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      total INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_calls_ts ON calls(ts);
    CREATE INDEX IF NOT EXISTS ix_calls_session ON calls(session);
    CREATE TABLE IF NOT EXISTS files(
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      calls INTEGER NOT NULL
    );
  `);
  return DB;
}

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
    } catch { /* 坏帧跳过 */ }
    i += ZSTD_MAGIC.length;
  }
  return events;
}

function sessionFiles() {
  const root = path.join(dshHome(), 'sessions');
  const out = [];
  let wsDirs = [];
  try { wsDirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue;
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(root, ws.name), { withFileTypes: true }); } catch { continue; }
    for (const s of dirs) {
      if (!s.isDirectory()) continue;
      const file = path.join(root, ws.name, s.name, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) out.push({ file, session: s.name });
    }
  }
  return out;
}

function indexFile(file, session) {
  const st = fs.statSync(file);
  const known = db().prepare('SELECT mtime, size FROM files WHERE path=?').get(file);
  if (known && known.mtime === Math.floor(st.mtimeMs) && known.size === st.size) return 0;

  db().prepare('DELETE FROM calls WHERE session=?').run(session);
  const events = decodeFrames(file);
  const ins = db().prepare('INSERT INTO calls(session, ts, input, output, cache_read, cache_write, total) VALUES(?,?,?,?,?,?,?)');
  let n = 0;
  for (const e of events) {
    if (e?.type !== 'assistant/message') continue;
    const u = e.data?.usage;
    if (!u) continue;
    ins.run(
      session,
      Number(e.time) || 0,
      Number(u.inputTokens) || 0,
      Number(u.outputTokens) || 0,
      Number(u.cacheReadTokens) || 0,
      Number(u.cacheWriteTokens) || 0,
      Number(u.totalTokens) || 0,
    );
    n++;
  }
  db().prepare('INSERT OR REPLACE INTO files(path, mtime, size, calls) VALUES(?,?,?,?)')
    .run(file, Math.floor(st.mtimeMs), st.size, n);
  return n;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function opUsage(args = {}, sessionId = '') {
  const scope = String(args.scope ?? 'today');
  const days = Number.isFinite(args.days) ? Number(args.days) : 7;
  let since = 0;
  let until = Date.now();

  if (scope === 'today') since = startOfToday();
  else if (scope === 'days') since = Date.now() - days * 86400000;
  else if (scope === 'session') since = 0;
  else if (scope === 'all') since = 0;
  else return { ok: false, text: 'scope 只能是 today / days / session / all' };

  // 只重解"可能影响结果"的文件：今天的查询只碰今天改过的文件
  const files = sessionFiles();
  let scanned = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(f.file);
      if (scope === 'today' && Math.floor(st.mtimeMs) < startOfToday()) {
        const known = db().prepare('SELECT 1 FROM files WHERE path=?').get(f.file);
        if (known) continue; // 今天没动过、也索引过 → 跳过
      }
      if (indexFile(f.file, f.session) > 0) scanned++;
    } catch { /* 单个文件失败不影响整体 */ }
  }

  const where = [];
  const params = [];
  if (scope === 'session') { where.push('session = ?'); params.push(String(sessionId || 'session-')); }
  if (since > 0) { where.push('ts >= ?'); params.push(since); }
  if (until > 0) { where.push('ts <= ?'); params.push(until); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const row = db().prepare(`
    SELECT COUNT(*) AS calls,
           COALESCE(SUM(input),0) AS input,
           COALESCE(SUM(output),0) AS output,
           COALESCE(SUM(cache_read),0) AS cacheRead,
           COALESCE(SUM(cache_write),0) AS cacheWrite,
           COALESCE(SUM(total),0) AS total
    FROM calls ${whereSql}`).get(...params);

  const scopeLabel = scope === 'today' ? '今天'
    : scope === 'days' ? `最近 ${days} 天`
      : scope === 'session' ? '本会话' : '全部历史';
  const fmt = (n) => n.toLocaleString('zh-CN');
  const lines = [
    `${scopeLabel}：${fmt(row.total)} tokens（${row.calls} 次模型调用）`,
    `  输入 ${fmt(row.input)} · 输出 ${fmt(row.output)} · 缓存命中 ${fmt(row.cacheRead)} · 缓存写入 ${fmt(row.cacheWrite)}`,
    `（本轮重解了 ${scanned} 个会话文件）`,
  ];
  if (row.calls === 0) lines.push('提示：索引可能还没建，先调 usage_reindex 跑一次全量。');
  return { ok: true, text: lines.join('\n') };
}

async function opReindex(args = {}) {
  const maxFiles = Number.isFinite(args.maxFiles) ? Number(args.maxFiles) : 0;
  const started = Date.now();
  const files = sessionFiles();
  const list = maxFiles > 0 ? files.slice(0, maxFiles) : files;
  let calls = 0, done = 0, failed = 0;
  for (const f of list) {
    try { calls += indexFile(f.file, f.session); done++; } catch { failed++; }
  }
  const total = db().prepare('SELECT COALESCE(SUM(total),0) AS t, COUNT(*) AS c FROM calls').get();
  return {
    ok: true,
    text: `扫描 ${done} 个会话（失败 ${failed}），新增 ${calls} 次调用记录\n`
      + `库里共 ${total.c} 次调用 / ${total.t.toLocaleString('zh-CN')} tokens，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  };
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
    tool('account_balance',
      'Read the DeepSeek account balance (total / topped-up / granted, in CNY). Cached 60 seconds.',
      { type: 'object', additionalProperties: false, properties: {
        force: { type: 'boolean', description: 'Bypass the 60s cache.' } } },
      (a) => opBalance(a)),
    tool('usage_tokens',
      'Report token consumption: today / last N days / this session / all history. Counts input, output and cache reads separately.',
      { type: 'object', additionalProperties: false, properties: {
        scope: { type: 'string', enum: ['today', 'days', 'session', 'all'], description: 'Default today.' },
        days: { type: 'number', description: 'With scope=days: how many days back (default 7).' } } },
      (a, s) => opUsage(a, s)),
    tool('usage_reindex',
      'Build or refresh the token usage index by decoding session logs (incremental: unchanged files are skipped).',
      { type: 'object', additionalProperties: false, properties: {
        maxFiles: { type: 'number', description: 'Only index the first N sessions (debugging).' } } },
      (a) => opReindex(a)),
  ];
}

export const inject = ['tools'];

export async function apply(ctx) {
  for (const definition of buildToolDefinitions()) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-account: ${definition.name}`);
  }
}

// ── 命令行冒烟：node index.js --smoke ───────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('index.js') && process.argv.includes('--smoke')) {
  console.log((await opBalance({ force: true })).text);
  console.log('\n' + (await opReindex({ maxFiles: 20 })).text);
  console.log('\n' + (await opUsage({ scope: 'all' }, '')).text);
}
