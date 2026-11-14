/**
 * @local/dsh-blank-reaper —— 空草稿会话回收器
 * ======================================================================
 * 背景（2026-11-08 实测）：
 *   Web GUI 每点一次「新会话」就新建一个 0.9 KB 的空草稿会话（只有会话头 +
 *   策略事件），而且从不同收。用户连点两次实测 205→206→207；16 天攒了 724 个。
 *   已试过的坏办法是改发行包（dsh-api-session-controller）让它复用空草稿 ——
 *   用户不接受改 node_modules，所以改成插件方案。
 *
 * 核心策略（保守：宁可不动，绝不误伤正在用的会话）：
 *   1. 监听 `session/created`（事件名出处见 README）：每次有新会话，安排一次复查；
 *   2. 复查按**工作区**清点：把"空草稿"（只有会话头与策略事件、没有任何
 *      user/assistant 消息、没有 turn/start）按创建时间倒序排，**只保留最新的 1 个**，
 *      更旧的才进回收站；
 *   3. 宽限期：任何空草稿创建/改动不到 90 秒，一律不动（给用户打字的时间）；
 *   4. 只有"≥2 个空草稿"时才动手（count > keepPerWorkspace），单个空草稿永远不碰；
 *   5. 只做"移入回收站"：
 *        · 首选 harness 自己的归档通道（workspaceRegistry.archiveSession + detach），
 *          并在本机已有的回收站账本（%DSH_HOME%\dsh-session-trash\trash.json）里登记，
 *          用户在「回收站」里点恢复即可原样回来；
 *        · 拿不到 workspaceRegistry 时退回物理搬迁到 %DSH_HOME%\trash\blank-reaper\。
 *   6. 失败只记日志，绝不抛错，不影响 DSH 主流程（`session/created` 监听器同步
 *      抛错会**否决会话创建**，所以监听器里全部包 try/catch 并只做排队）。
 *
 * 判定"空"的逻辑**照抄 dsh-session-gc**（同一份 ZSTD 帧扫描 + 同样的三个敏感标记），
 * 这样两个插件对"什么是空草稿"的口径完全一致。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const name = '@local/dsh-blank-reaper';

// ── 判定"空"：与 dsh-session-gc 完全一致的规则 ───────────────────────────────
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SENSE_EVENTS = ['"user/message"', '"assistant/message"', '"turn/start"'];
// 空草稿实测约 0.9 KB；超过这个大小的一律当"有内容"，连解都不解（既快又安全）。
const ALWAYS_NOT_EMPTY_BYTES = 512 * 1024;

const DEFAULTS = {
  graceMs: 90 * 1000,         // 宽限期：新草稿 90 秒内绝不动
  keepPerWorkspace: 1,        // 每个工作区保留几个空草稿
  sweepIntervalMs: 10 * 60 * 1000,
  startupDelayMs: 60 * 1000,
  debounceMs: 2 * 1000,
  minSweepGapMs: 5 * 1000,
  maxReapsPerSweep: 50,       // 单次扫描最多搬几个（避免启动瞬间搬几百个）
  shareTrashStore: true,      // 在现成的「回收站」插件账本里登记，用户可在 UI 里恢复
  dryRun: false,
};

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
  required: ['ok', 'text'],
};

// ── 路径 ────────────────────────────────────────────────────────────────────
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}
function stateDir() {
  return path.join(dshHome(), 'dsh-blank-reaper');
}
function stateFile() {
  return path.join(stateDir(), 'state.json');
}
function ownTrashRoot() {
  return path.join(dshHome(), 'trash', 'blank-reaper');
}
function sharedTrashFile() {
  return path.join(dshHome(), 'dsh-session-trash', 'trash.json');
}

function msg(error) {
  return error instanceof Error ? error.message : String(error);
}
function log(text) {
  try { console.log(`[dsh-blank-reaper] ${text}`); } catch { /* 忽略 */ }
}
function safeArray(value) {
  try { return Array.isArray(value) ? value.slice() : []; } catch { return []; }
}
function safeGet(ctx, key) {
  try { return ctx && typeof ctx.get === 'function' ? ctx.get(key) : undefined; } catch { return undefined; }
}
function stampNow() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 会话 id 的两种写法（`session-<uuid>` / 裸 uuid）都试一下。 */
function idVariants(id) {
  const raw = String(id || '');
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
  return raw === bare ? [raw, `session-${raw}`] : [raw, bare];
}
function hasId(setLike, id) {
  try { return idVariants(id).some((v) => setLike.has(v)); } catch { return false; }
}

// ── 空草稿判定（照抄 dsh-session-gc 的 inspectSession，另多解出会话头）───────
/**
 * 解一个会话文件。
 * @returns {{hasWork: boolean, badFrames: number, events: number, header: object|null, tooBig: boolean}|null}
 *   读不到返回 null（一律不动）。
 */
function inspectSession(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length > ALWAYS_NOT_EMPTY_BYTES) {
    return { hasWork: true, badFrames: 0, events: 0, header: null, tooBig: true };
  }
  let i = 0;
  let firstLine = true;
  let header = null;
  let events = 0;
  let badFrames = 0;
  let hasWork = false;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    let text = '';
    try { text = zstdDecompressSync(buf.subarray(i)).toString('utf8'); }
    catch { badFrames++; i += ZSTD_MAGIC.length; continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      if (firstLine) { // 第一行是会话头（type: "session"）
        firstLine = false;
        try { header = JSON.parse(line); } catch { header = null; }
        continue;
      }
      events++;
      if (!hasWork && SENSE_EVENTS.some((marker) => line.includes(marker))) hasWork = true;
    }
    if (hasWork) break; // 已经确定有对话，不必再解后面的帧（大会话省时间）
    i += ZSTD_MAGIC.length;
  }
  return { hasWork, badFrames, events, header, tooBig: false };
}

/** 会话目录里的日志文件名（v4 为主，兼容其它版本）。 */
function findSessionFile(dir) {
  const preferred = path.join(dir, 'session.v4.jsonl.zstd');
  try { if (fs.statSync(preferred).isFile()) return preferred; } catch { /* 继续找 */ }
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const hit = names
    .filter((n) => /^session\.v\d+\.jsonl\.zstd$/.test(n))
    .sort()
    .pop();
  return hit ? path.join(dir, hit) : null;
}

/**
 * 清点一个工作区目录下的空草稿。
 * @returns {Array<{id, dir, file, mtime, createdAt, workspace}>}
 */
function listEmptyDrafts(bucketDir, bucketName) {
  let entries = [];
  try { entries = fs.readdirSync(bucketDir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(bucketDir, entry.name);
    const file = findSessionFile(dir);
    if (!file) continue;
    const info = inspectSession(file);
    if (!info) continue;
    if (info.badFrames > 0) continue;   // 解不开的一律当"可疑"，绝不动
    if (info.hasWork) continue;         // 有 user/assistant/turn ⇒ 有对话，绝不动
    if (!info.header) continue;         // 读不出会话头 ⇒ 不动（保守）
    if (info.header.origin === 'subagent') continue;      // 子代理会话不归这里管
    if (info.header.parentSession) continue;              // fork 出来的会话不碰
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    const createdAt = Number(info.header.createdAt);
    found.push({
      id: entry.name,
      sessionId: String(info.header.id || entry.name),
      dir,
      file,
      mtime,
      createdAt: Number.isFinite(createdAt) ? createdAt : mtime,
      workspace: bucketName,
    });
  }
  return found;
}

/** 列出磁盘上所有工作区目录。 */
function listBuckets() {
  let entries = [];
  try { entries = fs.readdirSync(sessionsRoot(), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, dir: path.join(sessionsRoot(), e.name) }));
}

// ── 本插件自己的账本（谁被搬过、怎么搬的、能不能恢复）──────────────────────
function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const reaped = raw && typeof raw === 'object' && raw.reaped && typeof raw.reaped === 'object' ? raw.reaped : {};
    return { version: 1, reaped };
  } catch {
    return { version: 1, reaped: {} };
  }
}

function saveLedger(ledger) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = `${stateFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
    fs.renameSync(tmp, stateFile());
    return true;
  } catch (error) {
    log(`账本写入失败（不影响主流程）：${msg(error)}`);
    return false;
  }
}

// ── 与现成的「回收站」插件共享账本：搬走的会话能在 UI 里点恢复 ──────────────
function loadTrashStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(sharedTrashFile(), 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') return raw;
  } catch { /* 不存在或坏文件 */ }
  return null;
}

/**
 * 在回收站账本里登记一条记录（读-改-写 + 原子替换）。
 * 只在"文件不存在"或"文件能正常解析"时写；解析失败说明别人正在写或格式可疑，
 * 这时**宁可不登记**，也绝不覆盖别人已有的记录。
 */
function recordInTrashStore(entry) {
  const file = sharedTrashFile();
  let raw = null;
  let exists = false;
  try { exists = fs.statSync(file).isFile(); } catch { exists = false; }
  if (exists) {
    raw = loadTrashStore();
    if (!raw) return { ok: false, error: '回收站账本无法解析，跳过登记（不覆盖）' };
  } else {
    raw = { version: 1, entries: {}, gateUntil: 0 };
  }
  const entries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  if (entries[entry.sessionId]) return { ok: true, skipped: true };  // 已经在里面，别刷新 deletedAt
  entries[entry.sessionId] = {
    sessionId: entry.sessionId,
    title: entry.title || '',
    deletedAt: entry.deletedAt,
    workspaceId: entry.workspaceId ?? null,
    source: 'dsh-blank-reaper',
  };
  raw.entries = entries;
  if (typeof raw.version !== 'number') raw.version = 1;
  if (typeof raw.gateUntil !== 'number') raw.gateUntil = 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.blank-reaper.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: msg(error) };
  }
}

// ── 两种"进回收站"的实现 ───────────────────────────────────────────────────

/** 这个会话挂在哪个工作区（找不到返回 null，仍然可以归档）。 */
function findWorkspace(registry, sessionId) {
  try {
    if (!registry || typeof registry.list !== 'function') return null;
    for (const workspace of registry.list() || []) {
      let ids = [];
      try { ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []; } catch { ids = []; }
      if (ids.some((candidate) => idVariants(sessionId).includes(String(candidate)))) return workspace;
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 首选通道：harness 自己的归档 + 摘出工作区 + 登记回收站（可恢复，30 天后自动清）。 */
async function reapViaRegistry(ctx, cfg, draft) {
  const registry = safeGet(ctx, 'workspaceRegistry');
  if (!registry || typeof registry.archiveSession !== 'function') {
    return { ok: false, unavailable: true };
  }
  const workspace = findWorkspace(registry, draft.sessionId);
  try {
    await registry.archiveSession(draft.sessionId, { stopActivity: true });
  } catch (error) {
    return { ok: false, error: `归档失败：${msg(error)}` };
  }
  // 摘出工作区：会话变成无分组，侧栏不再当它是一条待用会话。
  if (workspace && typeof workspace.detachSession === 'function') {
    try { await workspace.detachSession(draft.sessionId); } catch (error) { log(`摘出工作区失败（已归档，继续）：${msg(error)}`); }
  }
  let recorded = { ok: true, skipped: true };
  if (cfg.shareTrashStore) {
    recorded = recordInTrashStore({
      sessionId: draft.sessionId,
      title: '',
      deletedAt: Date.now(),
      workspaceId: workspace && workspace.id ? workspace.id : null,
    });
    if (!recorded.ok) log(`回收站登记失败（会话已归档，仍可恢复）：${recorded.error}`);
  }
  return { ok: true, mode: 'archive', recorded: recorded.ok === true };
}

/** 退路：物理搬到本插件自己的回收目录（同卷 rename，失败再复制）。 */
function reapByMoving(draft) {
  const dest = path.join(ownTrashRoot(), stampNow(), draft.id);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(draft.dir, dest); }
    catch {
      fs.cpSync(draft.dir, dest, { recursive: true });
      fs.rmSync(draft.dir, { recursive: true, force: true });
    }
    return { ok: true, mode: 'move', dest };
  } catch (error) {
    return { ok: false, error: msg(error) };
  }
}

// ── 扫描 / 回收 ─────────────────────────────────────────────────────────────
let sweeping = false;

/**
 * 一次对账：按工作区保留最新 N 个空草稿，更旧的进回收站。
 * @param {object|null} ctx cordis 上下文；CLI 调用时传 null（只用物理搬迁通道）
 * @param {object} cfg 合并后的配置
 * @param {{dryRun?: boolean, minAgeMs?: number, maxReaps?: number, trigger?: string}} [opts]
 */
async function sweep(ctx, cfg, opts = {}) {
  if (sweeping) return { skipped: true, reason: 'scan-in-progress' };
  sweeping = true;
  const dryRun = opts.dryRun === undefined ? cfg.dryRun === true : opts.dryRun === true;
  const keep = Math.max(1, Number(cfg.keepPerWorkspace) || 1);
  const ageFloor = Math.max(Number(opts.minAgeMs) || 0, Number(cfg.graceMs) || 0);
  const report = {
    trigger: opts.trigger || 'manual',
    dryRun,
    scanned: 0,
    emptyDrafts: 0,
    reaped: 0,
    failed: 0,
    skippedYoung: 0,
    skippedKnown: 0,
    details: [],
  };
  try {
    const now = Date.now();
    const ledger = loadLedger();
    const registry = ctx ? safeGet(ctx, 'workspaceRegistry') : undefined;
    const archived = new Set(safeArray(registry && registry.archivedSessionIds));
    const pinned = new Set(safeArray(registry && registry.pinnedSessionIds));
    const bin = new Set(Object.keys((loadTrashStore() || {}).entries || {}));
    let budget = Number.isFinite(opts.maxReaps) ? Number(opts.maxReaps) : cfg.maxReapsPerSweep;

    for (const bucket of listBuckets()) {
      report.scanned++;
      const empties = listEmptyDrafts(bucket.dir, bucket.name);
      if (!empties.length) continue;
      report.emptyDrafts += empties.length;

      // 已经被搬过 / 已归档 / 已置顶的：不算进"待用草稿"，也不重复处理。
      const live = empties.filter((draft) => {
        if (ledger.reaped[draft.id] || ledger.reaped[draft.sessionId]) { report.skippedKnown++; return false; }
        if (hasId(archived, draft.sessionId) || hasId(archived, draft.id)) { report.skippedKnown++; return false; }
        if (hasId(pinned, draft.sessionId) || hasId(pinned, draft.id)) { report.skippedKnown++; return false; }
        if (hasId(bin, draft.sessionId) || hasId(bin, draft.id)) { report.skippedKnown++; return false; }
        return true;
      });
      if (live.length <= keep) continue;

      live.sort((a, b) => (b.createdAt - a.createdAt) || (b.mtime - a.mtime));
      for (const draft of live.slice(keep)) {
        if (budget !== undefined && budget <= 0) break;
        // 宽限期：刚创建/刚动过的草稿，绝不碰。
        if (now - draft.createdAt < ageFloor || now - draft.mtime < ageFloor) {
          report.skippedYoung++;
          continue;
        }
        if (dryRun) {
          report.details.push(`[dry-run] ${draft.workspace} ${draft.sessionId}`);
          if (budget !== undefined) budget--;
          continue;
        }
        let result;
        if (ctx) {
          result = await reapViaRegistry(ctx, cfg, draft);
          if (result && result.unavailable) result = reapByMoving(draft);
        } else {
          result = reapByMoving(draft);
        }
        if (result && result.ok) {
          report.reaped++;
          ledger.reaped[draft.id] = {
            at: Date.now(),
            sessionId: draft.sessionId,
            workspace: draft.workspace,
            mode: result.mode,
            dir: result.dest || draft.dir,
          };
          saveLedger(ledger);
          report.details.push(`${result.mode === 'archive' ? '已归档' : '已搬走'} ${draft.workspace} ${draft.sessionId}`);
          log(`回收空草稿 ${draft.sessionId}（${draft.workspace}，方式 ${result.mode}）`);
        } else {
          report.failed++;
          log(`回收失败 ${draft.sessionId}：${result && result.error ? result.error : '未知原因'}`);
        }
        if (budget !== undefined) budget--;
      }
    }
    return report;
  } catch (error) {
    log(`对账异常（已忽略，不影响主流程）：${msg(error)}`);
    return { ...report, error: msg(error) };
  } finally {
    sweeping = false;
  }
}

function describeReport(report, cfg) {
  const lines = [
    `${report.dryRun ? '【预演，不动磁盘】' : '【已执行】'}触发：${report.trigger}`,
    `扫描工作区 ${report.scanned} 个，空草稿 ${report.emptyDrafts} 个；本次回收 ${report.reaped} 个、失败 ${report.failed} 个`,
    `跳过：太年轻（<${Math.round(cfg.graceMs / 1000)} 秒）${report.skippedYoung} 个、已知/已归档/置顶 ${report.skippedKnown} 个`,
    `规则：每个工作区只保留最新 ${cfg.keepPerWorkspace} 个空草稿，更旧的进回收站（可恢复）`,
  ];
  if (report.details.length) {
    lines.push('明细（最多 10 条）：');
    for (const line of report.details.slice(0, 10)) lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function resolveConfig(config) {
  const merged = { ...DEFAULTS };
  if (config && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      const value = config[key];
      if (value === undefined || value === null) continue;
      if (typeof DEFAULTS[key] === 'number' && Number.isFinite(Number(value))) merged[key] = Number(value);
      else if (typeof DEFAULTS[key] === 'boolean') merged[key] = value === true;
    }
  }
  merged.graceMs = Math.max(0, merged.graceMs);
  merged.keepPerWorkspace = Math.max(1, Math.floor(merged.keepPerWorkspace));
  merged.maxReapsPerSweep = Math.max(1, Math.floor(merged.maxReapsPerSweep));
  return merged;
}

// ── Agent 工具（可选依赖 tools；没有就不注册）──────────────────────────────
function buildTool(ctx, cfg) {
  return {
    name: 'blank_reaper',
    description:
      'Clean up empty draft sessions (header + policy events only, no messages). ' +
      'Keeps the newest empty draft per workspace and moves older ones into the recycle bin ' +
      '(recoverable). action=scan reports only; action=sweep runs one pass; action=status shows config and history.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['scan', 'sweep', 'status'], description: 'scan (read-only) | sweep (apply now) | status' },
      },
      required: ['action'],
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    },
    async execute(args) {
      const action = String((args && args.action) || 'scan');
      if (action === 'status') {
        const ledger = loadLedger();
        const ids = Object.keys(ledger.reaped);
        const recent = ids
          .map((id) => ledger.reaped[id])
          .filter(Boolean)
          .sort((a, b) => (b.at || 0) - (a.at || 0))
          .slice(0, 5);
        const lines = [
          `宽限期 ${Math.round(cfg.graceMs / 1000)} 秒；每工作区保留 ${cfg.keepPerWorkspace} 个空草稿`,
          `周期对账 ${Math.round(cfg.sweepIntervalMs / 60000)} 分钟；单次上限 ${cfg.maxReapsPerSweep} 个；共享回收站账本 ${cfg.shareTrashStore ? '开' : '关'}`,
          `已回收 ${ids.length} 个空草稿（记录在 ${stateFile()}）`,
        ];
        for (const entry of recent) lines.push(`  ${entry.sessionId}  ${new Date(entry.at).toLocaleString()}  ${entry.mode}`);
        lines.push('恢复：在「设置 → 回收站」里点恢复（本插件搬走的都登记在那里）。');
        return { ok: true, text: lines.join('\n') };
      }
      const report = await sweep(ctx, cfg, {
        dryRun: action === 'scan',
        trigger: action === 'scan' ? 'manual-scan' : 'manual-sweep',
        maxReaps: action === 'scan' ? 1000 : cfg.maxReapsPerSweep,
      });
      if (report.skipped) return { ok: true, text: '上一轮对账还没跑完，请稍后再试。' };
      return { ok: report.failed === 0, text: describeReport(report, cfg) };
    },
  };
}

// ── 插件入口 ────────────────────────────────────────────────────────────────
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  let disposed = false;
  let quickTimer = null;
  let lateTimer = null;

  const runSweep = (trigger) => {
    if (disposed) return;
    void sweep(ctx, cfg, { trigger }).catch((error) => log(`后台对账失败（已忽略）：${msg(error)}`));
  };

  // 触发点 1：会话创建 —— 用户点了「新会话」。
  // ⚠️ 这个监听器是**同步**执行的，抛错会否决会话创建，所以这里只排队、绝不做重活。
  try {
    ctx.on('session/created', (session) => {
      try {
        const id = String(session && session.id ? session.id : '');
        if (disposed || !id) return;
        if (quickTimer === null) {
          quickTimer = setTimeout(() => {
            quickTimer = null;
            runSweep(`新会话 ${id}`);
          }, Math.max(0, cfg.debounceMs));
          if (typeof quickTimer.unref === 'function') quickTimer.unref();
        }
        // 再排一次"宽限期之后"的复查：那一刻新草稿才允许被评估，落盘的日志也齐了。
        if (lateTimer !== null) { clearTimeout(lateTimer); lateTimer = null; }
        lateTimer = setTimeout(() => {
          lateTimer = null;
          runSweep('宽限期后复查');
        }, cfg.graceMs + cfg.debounceMs + cfg.minSweepGapMs);
        if (typeof lateTimer.unref === 'function') lateTimer.unref();
      } catch (error) {
        log(`session/created 处理失败（已忽略）：${msg(error)}`);
      }
    });
    log('已监听 session/created，开始看守空草稿');
  } catch (error) {
    log(`监听 session/created 失败：${msg(error)}`);
  }

  // 触发点 2：周期对账（兜底；也用来慢慢消化历史积压）。
  ctx.effect(() => {
    const interval = setInterval(() => runSweep('周期对账'), cfg.sweepIntervalMs);
    const startup = setTimeout(() => runSweep('启动后首次对账'), cfg.startupDelayMs);
    if (typeof interval.unref === 'function') interval.unref();
    if (typeof startup.unref === 'function') startup.unref();
    return () => {
      disposed = true;
      clearInterval(interval);
      clearTimeout(startup);
      if (quickTimer !== null) { clearTimeout(quickTimer); quickTimer = null; }
      if (lateTimer !== null) { clearTimeout(lateTimer); lateTimer = null; }
    };
  }, 'dsh-blank-reaper: 周期对账');

  // 触发点 3：给 Agent 一个查询/立即执行的口子（tools 缺失时静默跳过）。
  try {
    ctx.inject(['tools'], (child) => {
      const definition = buildTool(ctx, cfg);
      child.effect(() => child.tools.register(definition), 'dsh-blank-reaper: blank_reaper');
    });
  } catch (error) {
    log(`注册 blank_reaper 工具失败（不影响回收）：${msg(error)}`);
  }
}

// ── 命令行：node index.js --scan / --sweep / --status ───────────────────────
// 用于**不重启 DSH** 的验证：直接在真实会话目录上跑一遍，--scan 只看不动。
if (process.argv[1] && /dsh-blank-reaper[\\/]index\.js$/.test(process.argv[1])) {
  const argv = process.argv.slice(2);
  const argValue = (flag, fallback) => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) ? value : fallback;
  };
  const cfg = resolveConfig({
    graceMs: argValue('--grace', DEFAULTS.graceMs / 1000) * 1000,
    keepPerWorkspace: argValue('--keep', DEFAULTS.keepPerWorkspace),
    maxReapsPerSweep: argValue('--max', DEFAULTS.maxReapsPerSweep),
  });
  const mode = argv.includes('--sweep') ? 'sweep' : argv.includes('--status') ? 'status' : 'scan';
  if (mode === 'status') {
    const ledger = loadLedger();
    console.log(`DSH_HOME = ${dshHome()}`);
    console.log(`宽限期 ${Math.round(cfg.graceMs / 1000)} 秒；每工作区保留 ${cfg.keepPerWorkspace} 个空草稿`);
    console.log(`已回收 ${Object.keys(ledger.reaped).length} 个（账本：${stateFile()}）`);
    console.log(`自己的回收目录：${ownTrashRoot()}`);
  } else if (mode === 'sweep') {
    // 命令行没有 cordis 上下文 ⇒ 走物理搬迁通道；只处理足够老的草稿，避免碰正在用的。
    const report = await sweep(null, cfg, {
      dryRun: false,
      trigger: 'cli-sweep',
      minAgeMs: argValue('--min-age-min', 60) * 60 * 1000,
    });
    console.log(describeReport(report, cfg));
  } else {
    const report = await sweep(null, cfg, { dryRun: true, trigger: 'cli-scan', maxReaps: 1000 });
    console.log(describeReport(report, cfg));
  }
}
