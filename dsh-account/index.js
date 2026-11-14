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
  // 修复（F 路 A1）：两个进程同时查用量时直接抛 "database is locked"。
  //   WAL 只解决读写并存，写-写仍要排队；没有 busy_timeout 就立刻失败。
  DB.exec('PRAGMA busy_timeout = 8000;');
  DB.exec(`
    CREATE TABLE IF NOT EXISTS calls(
      id INTEGER PRIMARY KEY,
      file TEXT,
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
  // 老库迁移：calls 表补 file 列（修复 F 路 A2：只按会话名 DELETE 会让不同工作区的
  // 同名会话互相覆盖，而被覆盖的那份因为 files 行还在，永远不会重建）。
  const cols = DB.prepare("PRAGMA table_info(calls)").all().map((c) => c.name);
  if (!cols.includes('file')) DB.exec('ALTER TABLE calls ADD COLUMN file TEXT');
  DB.exec('CREATE INDEX IF NOT EXISTS ix_calls_file ON calls(file)');
  return DB;
}

function decodeFrames(file) {
  let buf;
  // 读失败返回 null（不是 []）：调用方据此**不写 files 行**，下次还会重试。
  // 返回 [] 会被当成"这个文件没有 usage"，把已索引的数据清成 0 且永不重解。
  try { buf = fs.readFileSync(file); } catch { return null; }
  const events = [];
  let i = 0;
  let frames = 0;
  let badFrames = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    frames++;
    try {
      const text = zstdDecompressSync(buf.subarray(i)).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { /* 半行 */ }
      }
    } catch { badFrames++; }
    i += ZSTD_MAGIC.length;
  }
  // 帧解不开通常是"文件正在追加，末帧还没写完"。这种情况返回 null 让调用方跳过，
  // 下次 size 变化时再解 —— 而不是把一个不完整的结果当成最终结果记下来。
  if (frames > 0 && badFrames > 0) return null;
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

  const events = decodeFrames(file);
  // 修复（F 路 A6）：读失败/半帧时**不要**写 files 行。
  //   否则"读到截断的末帧"会被记成已索引，之后 size 不变就再也不会重解 ⇒ 永久漏计；
  //   更糟的是 readFileSync 失败会返回 []，等于把该会话已有数据清空并记成 0。
  if (events === null) return -1;

  const ins = db().prepare('INSERT INTO calls(file, session, ts, input, output, cache_read, cache_write, total) VALUES(?,?,?,?,?,?,?,?)');
  let n = 0;
  // 修复（F 路 A3）：删旧 + 插新 + 写 files 行必须在一个事务里，
  //   否则中途被打断（崩溃/锁超时）会留下"files 说已索引、calls 却是空的"，永久丢数。
  db().exec('BEGIN IMMEDIATE');
  try {
    // 修复（F 路 A2）：按**文件路径**删，而不是按会话名 —— 不同工作区可能有同名会话。
    db().prepare('DELETE FROM calls WHERE file=?').run(file);
    // 兼容旧库：老行没有 file 列，按会话名 + 空 file 再兜一次
    db().prepare('DELETE FROM calls WHERE session=? AND file IS NULL').run(session);
    for (const e of events) {
      if (e?.type !== 'assistant/message') continue;
      const u = e.data?.usage;
      if (!u) continue;
      ins.run(
        file,
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
    db().exec('COMMIT');
  } catch (error) {
    try { db().exec('ROLLBACK'); } catch { /* 已经回滚 */ }
    throw error;
  }
  return n;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * DeepSeek 官方价格（元 / 百万 tokens），来源：
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 空闲时段 = 高峰时段的一半；高峰为北京时间周一至周五 9:00-12:00、14:00-18:00
 * （不含中国法定节假日——节假日这里无法自动判断，按工作日算，属于已知偏差）。
 */
const PRICING = {
  'deepseek-flash': {
    peak: { cacheRead: 0.04, input: 2, output: 8 },
    offpeak: { cacheRead: 0.02, input: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { cacheRead: 0.3, input: 9, output: 27 },
    offpeak: { cacheRead: 0.15, input: 4.5, output: 13.5 },
  },
};

const PRICING_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';

// ── 余额快照：唯一能反映「真实花掉多少钱」的口径 ────────────────────────────
// 官方单价 × token 数算出来的值实测比真实账单高一个数量级（cacheRead 口径偏大），
// 所以真实花费一律用余额差值，token 估算只作参考。

function snapshotPath() {
  return path.join(dshHome(), 'usage', 'balance-snapshots.json');
}

function loadSnapshots() {
  try {
    const raw = fs.readFileSync(snapshotPath(), 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function saveSnapshots(list) {
  try {
    const p = snapshotPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 只留最近 500 条，避免文件无限长
    const trimmed = list.slice(-500);
    fs.writeFileSync(p, JSON.stringify(trimmed), 'utf8');
  } catch { /* 写不进去不影响主流程 */ }
}

/** 记录一次余额观测；同一分钟内重复的不重复记。 */
function recordSnapshot(total, at = Date.now()) {
  if (total == null || !Number.isFinite(total)) return loadSnapshots();
  const list = loadSnapshots();
  const last = list[list.length - 1];
  if (last && at - Number(last.at) < 60000 && Number(last.total) === total) return list;
  list.push({ at, total });
  saveSnapshots(list);
  return list;
}

/**
 * 找基线：范围内最早的那次观测。
 * 如果范围内一条都没有，说明这个区间还没开始记账，返回 null。
 */
function baselineFor(list, since) {
  const inRange = list.filter((s) => Number(s.at) >= since);
  return inRange.length ? inRange[0] : null;
}

/** 判断某个时间点是否落在高峰时段（按北京时间算）。 */
function isPeakTime(ts) {
  const d = new Date(ts + 8 * 3600 * 1000); // 平移到 UTC+8
  const day = d.getUTCDay();                 // 0=周日, 6=周六
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 取模型价格表；未知模型返回 null。 */
function pricingFor(model) {
  const key = String(model || 'deepseek-flash');
  return PRICING[key] ?? null;
}

/** 按三段 token 数和价格算钱（元）。 */
function costOf(usage, price) {
  const MILLION = 1e6;
  return (usage.input / MILLION) * price.input
    + (usage.cacheRead / MILLION) * price.cacheRead
    + (usage.output / MILLION) * price.output;
}

async function opUsage(args = {}, sessionId = '') {
  const scope = String(args.scope ?? 'today');
  // 修复（F 路 A4/A5）：days 之前用 Number.isFinite 判断，传字符串 "3" 会被静默当成 7 天；
  //   days<=0 或超大也没有校验（0 → "最近 0 天"、-1 → since 落在未来、10000 → 等价全部）。
  let days = 7;
  if (args.days !== undefined && args.days !== null) {
    const parsed = Number(args.days);
    if (!Number.isFinite(parsed)) return { ok: false, text: `days 必须是数字（收到 ${JSON.stringify(args.days)}）` };
    if (parsed < 1) return { ok: false, text: `days 必须 ≥ 1（收到 ${parsed}）` };
    days = Math.min(parsed, 36500);
  }
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
      // 只在"这个文件不可能包含范围内数据"时跳过：
      // mtime 早于查询起点 ⇒ 里面不可能有范围内的调用，连索引都不必建
      // （否则第一次查「今天」会白扫 769 个历史文件，约 10 分钟）。
      if (since > 0 && Math.floor(st.mtimeMs) < since) continue;
      if (indexFile(f.file, f.session) > 0) scanned++;
    } catch { /* 单个文件失败不影响整体 */ }
  }

  const where = [];
  const params = [];
  if (scope === 'session') { where.push('session = ?'); params.push(String(sessionId || 'session-')); }
  if (since > 0) { where.push('ts >= ?'); params.push(since); }
  if (until > 0) { where.push('ts <= ?'); params.push(until); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  let row;
  try {
    row = db().prepare(`
      SELECT COUNT(*) AS calls,
             COALESCE(SUM(input),0) AS input,
             COALESCE(SUM(output),0) AS output,
             COALESCE(SUM(cache_read),0) AS cacheRead,
             COALESCE(SUM(cache_write),0) AS cacheWrite,
             COALESCE(SUM(total),0) AS total
      FROM calls ${whereSql}`).get(...params);
  } catch (error) {
    // 修复（F 路 A1）：锁超时不该以异常形式冒给模型；给出可行动的说法。
    const msg = error instanceof Error ? error.message : String(error);
    if (/locked|busy/i.test(msg)) return { ok: false, text: '用量库正被另一个进程写入（锁超时），稍后重试即可。' };
    return { ok: false, text: `查询用量失败：${msg}` };
  }

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

/**
 * 算「这次会话花了多少钱」。
 * 价格按 DeepSeek 官方表；时段按调用发生的时间判定（高峰/空闲分别计价）。
 * 由于库表里没有逐条记录模型名，模型用参数指定，默认 deepseek-flash。
 */
async function opCost(args = {}, sessionId = '') {
  const scope = String(args.scope ?? 'today');
  const model = String(args.model ?? 'deepseek-flash');
  const price = pricingFor(model);
  if (!price) {
    return { ok: false, text: `未知模型 ${model}，可选：${Object.keys(PRICING).join(' / ')}` };
  }

  let since = 0;
  let until = Date.now();
  if (scope === 'today') since = startOfToday();
  else if (scope === 'all') since = 0;
  else if (scope === 'session') since = 0;
  else return { ok: false, text: 'scope 只能是 session / today / all' };

  // ① 真实口径：余额差值
  const before = await fetchBalance(false);
  let realText = '';
  if (before.payload && before.payload.total != null) {
    const list = recordSnapshot(before.payload.total, before.at);
    const base = baselineFor(list, since === 0 ? 0 : since);
    if (base && base !== list[list.length - 1]) {
      const delta = Number(base.total) - Number(before.payload.total);
      realText = `  自 ${new Date(Number(base.at)).toLocaleString('zh-CN')} 起的余额差值：¥${delta.toFixed(2)}（未覆盖更早时段）`
        + `（基线 ${new Date(Number(base.at)).toLocaleString('zh-CN')} ¥${Number(base.total).toFixed(2)} → 现在 ¥${Number(before.payload.total).toFixed(2)}）`;
    } else if (list.length <= 1) {
      realText = '  真实花费：还没基线。这次已记下当前余额，下次再查就能给出差值。';
    } else {
      realText = `  真实花费：本次范围内只有一条余额观测（¥${Number(before.payload.total).toFixed(2)}），多查几次就能算出差值。`;
    }
  } else {
    realText = '  真实花费：取不到余额（' + (before.error || '未知原因') + '）';
  }

  // ② 参考口径：token × 官方单价

  // 确保索引进到最新
  const files = sessionFiles();
  for (const f of files) {
    try {
      const st = fs.statSync(f.file);
      if (since > 0 && Math.floor(st.mtimeMs) < since) continue;
      indexFile(f.file, f.session);
    } catch { /* 单个文件失败不影响整体 */ }
  }

  const where = [];
  const params = [];
  if (scope === 'session') { where.push('session = ?'); params.push(String(sessionId || 'session-')); }
  if (since > 0) { where.push('ts >= ?'); params.push(since); }
  if (until > 0) { where.push('ts <= ?'); params.push(until); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 逐条取出（只有几千条的量级），按时间判高峰/空闲分别累加
  let rows;
  try {
    rows = db().prepare(
      `SELECT ts, input, output, cache_read AS cacheRead FROM calls ${whereSql} ORDER BY ts`
    ).all(...params);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/locked|busy/i.test(msg)) return { ok: false, text: '用量库正被另一个进程写入（锁超时），稍后重试即可。' };
    return { ok: false, text: `查询用量失败：${msg}` };
  }

  const peakU = { input: 0, output: 0, cacheRead: 0 };
  const offU = { input: 0, output: 0, cacheRead: 0 };
  for (const r of rows) {
    const bucket = isPeakTime(Number(r.ts)) ? peakU : offU;
    bucket.input += Number(r.input) || 0;
    bucket.output += Number(r.output) || 0;
    bucket.cacheRead += Number(r.cacheRead) || 0;
  }

  const peakCost = costOf(peakU, price.peak);
  const offCost = costOf(offU, price.offpeak);
  const total = peakCost + offCost;

  const scopeLabel = scope === 'session' ? '本会话'
    : scope === 'today' ? '今天' : '全部历史';
  const fmt = (n) => n.toLocaleString('zh-CN');
  const money = (n) => '¥' + n.toFixed(4);
  const tok = (u) => `输入 ${fmt(u.input)} · 输出 ${fmt(u.output)} · 缓存命中 ${fmt(u.cacheRead)}`;

  const sum = {
    input: peakU.input + offU.input,
    output: peakU.output + offU.output,
    cacheRead: peakU.cacheRead + offU.cacheRead,
  };

  const lines = [
    `${scopeLabel} token 结构（${model}）：`,
    `  覆盖时间：${rows.length ? new Date(Number(rows[0].ts)).toLocaleString('zh-CN') : '-'}`
      + ` → ${rows.length ? new Date(Number(rows[rows.length - 1].ts)).toLocaleString('zh-CN') : '-'}`,
    `  估计费用 ${money(total)}`,
    `  高峰时段 ${money(peakCost)}（${tok(peakU)}）`,
    `  空闲时段 ${money(offCost)}（${tok(offU)}）`,
    `  合计 tokens：${fmt(sum.input + sum.output + sum.cacheRead)}（${rows.length} 次调用）`,
    `  单价（元/百万 tokens）：缓存命中 ${price.peak.cacheRead}/${price.offpeak.cacheRead} · `
      + `输入 ${price.peak.input}/${price.offpeak.input} · 输出 ${price.peak.output}/${price.offpeak.output}（高峰/空闲）`,
    `  价格来源：${PRICING_SOURCE}（法定节假日按工作日计，属已知偏差）`,
    '',
    `对账参考（余额差值，最接近真实扣费）：`,
    realText,
  ];
  if (rows.length === 0) lines.push('提示：范围内没有调用记录，先调 usage_reindex 建索引。');
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
    tool('usage_cost',
      'Estimate how much money this session (or today / all history) has cost, using the official DeepSeek price table '
        + 'and splitting peak vs off-peak by call time. CNY.',
      { type: 'object', additionalProperties: false, properties: {
        scope: { type: 'string', enum: ['today', 'session', 'all'], description: 'Default today. session = the whole conversation, which may span days.' },
        model: { type: 'string', description: 'deepseek-flash (default) or deepseek-v4-pro.' } } },
      (a, s) => opCost(a, s)),
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
// ── 并发测试入口：node index.js --usage-test ─────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('index.js') && process.argv.includes('--usage-test')) {
  const r = await opUsage({ scope: 'all' }, '');
  console.log((r.ok ? 'OK  ' : 'FAIL') + ' ' + r.text.split('\n')[0]);
}


