/**
 * dsh-session-resume —— DSH 重启后自动继续"上次在跑"的会话
 * ======================================================================
 * 用户规则（2026-11-11，照做，不加戏）：
 *   1. 不处理硬杀（断电 / 强杀）——不需要额外兜底；
 *   2. 启动后自动继续，不弹窗问用户；
 *   3. 只恢复"退出时确实有回合在跑"的会话，空转的不恢复。
 *
 * 机制：
 *   · 退出：SIGTERM / SIGINT / beforeExit 三个钩子里，把此刻
 *     `agent.status === 'running'` 的会话（id + 标题 + 时间）同步写进
 *     `%DSH_HOME%\resume\state.json`；
 *   · 启动：`apply()` 后延迟 ~20 秒（等运行时稳定），读 state.json，
 *     对每条走和 `dsh_wake_session` 相同的唤醒路径（活 Agent ⇒ steer；
 *     没加载 ⇒ `sessionController.resolveAgent()` 冷唤起后再投递），
 *     发一条【自动恢复】消息，让那个会话接着干；
 *   · 恢复成功后清空 state.json；唤醒失败的条目保留在 state.json 里，
 *     并记一行日志到 `%TEMP%\dsh_session_resume\log.txt`。
 *
 * 本文件只依赖 node 内置模块（与 dsh-agent-bus / dsh-restart 一致）：
 * 插件从 dsh-plugins 目录解析，拿不到 @deepseek-ai/dsh-* 包。
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const name = '@local/dsh-session-resume';

/** 恢复消息原文（用户给的措辞，别改）。 */
export const RESTORE_TEXT = '【自动恢复】DSH 刚重启，你在重启前有未完成的回合。请先简述你刚才在做什么，然后继续。';

/** 启动后等运行时稳定再恢复。测试可用环境变量压到 0。 */
const DEFAULT_DELAY_MS = 20_000;
export function restoreDelayMs() {
  const n = Number(process.env.DSH_SESSION_RESUME_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DELAY_MS;
}

// ── 路径 ────────────────────────────────────────────────────────────────

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
export function resumeDir() {
  return path.join(dshHome(), 'resume');
}
export function statePath() {
  return path.join(resumeDir(), 'state.json');
}
export function logPath() {
  return path.join(os.tmpdir(), 'dsh_session_resume', 'log.txt');
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

/** 追加一行日志；失败就忽略（日志不能反过来弄坏退出流程）。 */
export function log(msg) {
  try {
    const file = logPath();
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {}
}

// ── 退出时：采集并落盘 ──────────────────────────────────────────────────

/**
 * 从 Agent 列表里挑出"此刻有回合在跑"的，转成 state 条目。
 * 纯函数：不读盘、不写盘，方便单测。
 * @param {Array} agents `ctx.get('agents').list()` 的返回值
 */
export function collectRunning(agents, now = new Date()) {
  const at = now.toISOString();
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || a.status !== 'running') continue;
    // Agent id 就是 session id（dsh-agent 的 Agent.id 声明为 SessionId）
    const id = String((a.session && a.session.id) || a.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: null, status: 'running', at });
  }
  return out;
}

// 会话日志是多帧 zstd（追加写入）；标题只认 session/title 事件。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 找出某会话的日志文件；找不到返回 null。 */
export function findSessionFile(sessionId) {
  const root = path.join(dshHome(), 'sessions');
  const raw = String(sessionId || '');
  if (!raw) return null;
  const bare = raw.replace(/^session-/, '');
  const names = [`session-${bare}`, raw];
  let wss = [];
  try { wss = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const ws of wss) {
    if (!ws.isDirectory()) continue;
    for (const n of names) {
      const file = path.join(root, ws.name, n, 'session.v4.jsonl.zstd');
      try { if (fs.statSync(file).isFile()) return file; } catch {}
    }
  }
  return null;
}

/** 折叠一段事件里的标题：最后一条 session/title 胜出。 */
function foldTitle(events, fallback) {
  let title = fallback;
  for (const e of events) {
    if (e && e.type === 'session/title' && e.data && typeof e.data.title === 'string') title = e.data.title;
  }
  return title;
}

/**
 * 从会话日志尾部若干帧里读标题；读不到返回 null。
 * 只从后往前扫——标题很少变，一旦命中就是最后一条。
 */
export function readTitleFromFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { offsets.push(i); i += ZSTD_MAGIC.length; }
  let title = null;
  for (let k = offsets.length - 1; k >= 0; k -= 1) {
    let text = '';
    try { text = zstdDecompressSync(buf.subarray(offsets[k])).toString('utf8'); } catch { continue; }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch {}
    }
    title = foldTitle(events, title);
    if (title) break;
  }
  return title;
}

/**
 * 优先从投影缓存取标题（一次 JSON 读，最快也最准）：
 *   %DSH_HOME%\storages\session_projcache\sessions\<id>.json
 * 该目录两种文件名都见过（带 / 不带 `session-` 前缀），都试。
 */
export function titleFromProjCache(sessionId) {
  const raw = String(sessionId || '');
  if (!raw) return null;
  const bare = raw.replace(/^session-/, '');
  const dir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
  for (const name of [`session-${bare}.json`, `${bare}.json`, `${raw}.json`]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const v = j && j.record && j.record.rows && j.record.rows.title && j.record.rows.title.val;
      if (typeof v === 'string' && v) return v;
    } catch {}
  }
  return null;
}

/** 读某会话标题：先投影缓存，再退回日志扫描；都没有返回 null。 */
export function sessionTitle(sessionId) {
  try {
    const cached = titleFromProjCache(sessionId);
    if (cached) return cached;
  } catch {}
  try {
    const file = findSessionFile(sessionId);
    return file ? readTitleFromFile(file) : null;
  } catch { return null; }
}

/** 原子写 JSON：先写临时文件再改名，避免半截 state.json。 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows 上目标被占用时 rename 会失败：退一步直接覆盖写。
    try { fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/** 读 state.json；不存在/损坏返回 null。 */
export function readStateFile(file = statePath()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || !Array.isArray(j.sessions)) return null;
    return j;
  } catch { return null; }
}

/**
 * 退出钩子的主体：采集 + 写 state.json。
 *
 * 没有 running 会话时**不动** state.json —— 上一轮恢复失败、还没清掉的条目
 * 不能被一次"空退出"冲掉。
 * @returns {{written:boolean, count:number, path:string}}
 */
export function saveSnapshot(agents, reason = 'exit', now = new Date()) {
  let running = [];
  try { running = collectRunning(agents, now); } catch (e) { log(`collectRunning 失败：${e && e.message ? e.message : e}`); }
  if (running.length === 0) {
    log(`[${reason}] 没有 running 会话，state.json 保持不动`);
    return { written: false, count: 0, path: statePath() };
  }
  for (const item of running) item.title = sessionTitle(item.id);
  const state = { savedAt: now.toISOString(), reason, sessions: running };
  try {
    writeJsonAtomic(statePath(), state);
    log(`[${reason}] 已写 ${running.length} 个会话 → ${statePath()}`);
    return { written: true, count: running.length, path: statePath() };
  } catch (e) {
    log(`[${reason}] 写 state.json 失败：${e && e.message ? e.message : e}`);
    return { written: false, count: running.length, path: statePath() };
  }
}

// ── 启动时：恢复 ────────────────────────────────────────────────────────

/** 构造一条 Agent 消息（role 必须是 'user'；来源靠 source.kind 表达）。 */
export function buildRestoreMessage(text = RESTORE_TEXT) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-resume' },
  };
}

function sendTo(agent, msg) {
  if (typeof agent.steer === 'function') { agent.steer(msg); return 'steer'; }
  if (typeof agent.followup === 'function') { agent.followup(msg); return 'followup'; }
  return null;
}

/** 在已加载的 Agent 里按 id 找（agent id / session id / 去前缀 都认）。 */
function lookupLive(agents, id) {
  if (!agents || typeof agents.get !== 'function') return undefined;
  let a;
  try { a = agents.get(id); } catch { a = undefined; }
  if (a) return a;
  let all = [];
  try { all = typeof agents.list === 'function' ? (agents.list() || []) : []; } catch { all = []; }
  const bare = String(id).replace(/^session-/, '');
  return all.find((x) => x && (x.id === id || String(x.id).replace(/^session-/, '') === bare));
}

/**
 * 唤醒一个会话：与 dsh_wake_session 同一条路 ——
 *   活 Agent ⇒ steer（插队）；没加载 ⇒ sessionController.resolveAgent() 冷唤起后 steer。
 * @returns {Promise<{ok:boolean, via?:string, error?:string}>}
 */
export async function wakeSession(env, sessionId) {
  const msg = buildRestoreMessage();
  const live = lookupLive(env.agents, sessionId);
  if (live) {
    const how = sendTo(live, msg);
    if (how) return { ok: true, via: how };
    return { ok: false, error: '存活 Agent 既没有 steer 也没有 followup' };
  }
  const sc = env.sessionController;
  if (!sc || typeof sc.resolveAgent !== 'function') {
    return { ok: false, error: '没有 sessionController.resolveAgent，无法冷唤起' };
  }
  let resolved;
  try {
    resolved = await Promise.resolve(sc.resolveAgent(sessionId));
  } catch (e) {
    return { ok: false, error: `resolveAgent 抛错：${e && e.message ? e.message : e}` };
  }
  const agent = resolved && (resolved.agent || resolved.value || null);
  if (!agent) {
    // resolveAgent 不抛错：失败时返回 { error }（session/not-found、agent-busy 等）
    const err = resolved && resolved.error;
    let detail = '';
    if (err) {
      try { detail = typeof err === 'string' ? err : JSON.stringify(err).slice(0, 200); } catch { detail = String(err); }
    }
    return { ok: false, error: 'resolveAgent 未返回 Agent' + (detail ? `（${detail}）` : '') };
  }
  const how = sendTo(agent, msg);
  if (!how) return { ok: false, error: '冷唤起后的 Agent 没有 steer/followup' };
  return { ok: true, via: `wake:${how}` };
}

/**
 * 读 state.json 并逐条恢复；成功清空，失败保留。
 * @returns {Promise<{attempted:number, ok:number, failed:number, cleared:boolean}>}
 */
export async function restore(env, file = statePath()) {
  const state = readStateFile(file);
  if (!state || state.sessions.length === 0) {
    log('恢复：没有待恢复的会话');
    return { attempted: 0, ok: 0, failed: 0, cleared: false };
  }
  log(`恢复：开始处理 ${state.sessions.length} 个会话（savedAt=${state.savedAt || '未知'}）`);
  const failed = [];
  let ok = 0;
  for (const entry of state.sessions) {
    const id = String(entry && entry.id ? entry.id : '');
    if (!id) { failed.push({ ...entry, lastError: '条目缺少 id' }); continue; }
    let r;
    try {
      r = await wakeSession(env, id);
    } catch (e) {
      r = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    if (r.ok) {
      ok += 1;
      log(`恢复成功：${id}（${r.via}）`);
    } else {
      failed.push({ ...entry, lastError: r.error || '未知错误', lastAttempt: new Date().toISOString() });
      log(`恢复失败：${id} —— ${r.error || '未知错误'}`);
    }
    // 逐个来，别在同一毫秒把一堆会话同时点着
    await new Promise((res) => setTimeout(res, 200));
  }
  let cleared = false;
  try {
    if (failed.length === 0) {
      fs.unlinkSync(file);
      cleared = true;
      log('恢复：全部成功，state.json 已清空');
    } else {
      writeJsonAtomic(file, { savedAt: state.savedAt || null, sessions: failed });
      log(`恢复：${failed.length} 个失败条目已保留在 state.json`);
    }
  } catch (e) {
    log(`恢复：写回 state.json 失败：${e && e.message ? e.message : e}`);
  }
  return { attempted: state.sessions.length, ok, failed: failed.length, cleared };
}

// ── 运行期心跳（2026-11-12 用户要求）────────────────────────────────────
// 为什么需要：DSH 重启走 Stop-Process -Force（硬杀），退出钩子根本不触发。
// 所以运行期每 30 秒把"此刻在跑的会话"落一次盘，硬杀后最多丢 30 秒的状态。
//
// 规则：
//   · 有 running 才写；内容（id + 标题）没变就不写，避免每 30 秒刷盘；
//   · 没有 running 时删掉旧快照——否则重启后会把已经空闲的会话误当"未完成"唤醒；
//   · 启动时丢掉超过 6 小时的旧条目（硬杀留下的陈年快照不能拿来恢复）；
//   · 任何失败只记日志，不抛。

export const HEARTBEAT_MS = 30_000;
export const MAX_AGE_MS = 6 * 60 * 60 * 1000;

let lastHeartbeatFingerprint = null;

/** 会话集合的稳定指纹：只看 id + 标题（时间不参与，否则每次都算"变了"）。 */
export function fingerprintSessions(sessions) {
  return JSON.stringify(
    sessions
      .map((s) => [String(s.id), s.title || ''])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

/** 启动清理：丢掉超过 6 小时的条目；全过期就删文件。 */
export function cleanExpiredState(file = statePath(), now = Date.now()) {
  const state = readStateFile(file);
  if (!state) return { changed: false, kept: 0 };
  const cutoff = now - MAX_AGE_MS;
  const kept = state.sessions.filter((s) => {
    const t = Date.parse((s && (s.at || s.lastAttempt)) || state.savedAt || '');
    return !Number.isFinite(t) || t >= cutoff;
  });
  if (kept.length === state.sessions.length) return { changed: false, kept: kept.length };
  try {
    if (kept.length === 0) {
      fs.unlinkSync(file);
      log(`启动清理：快照全部超过 ${MAX_AGE_MS / 3_600_000} 小时，已删除`);
    } else {
      writeJsonAtomic(file, { savedAt: state.savedAt || null, sessions: kept });
      log(`启动清理：丢掉 ${state.sessions.length - kept.length} 条过期条目，保留 ${kept.length} 条`);
    }
    return { changed: true, kept: kept.length };
  } catch (e) {
    log(`启动清理失败：${e && e.message ? e.message : e}`);
    return { changed: false, kept: state.sessions.length };
  }
}

/**
 * 一次心跳：有 running 就写快照（内容不变则跳过）；没有 running 就清掉旧快照。
 * @returns {{written:boolean, reason:'changed'|'unchanged'|'idle'|'error', count:number}}
 */
export function heartbeatTick(agents, now = new Date()) {
  try {
    const running = collectRunning(agents, now);
    if (running.length === 0) {
      lastHeartbeatFingerprint = null;
      try {
        if (fs.existsSync(statePath())) {
          // 只清自己写的快照；退出钩子/恢复失败留下的条目要保留，不能一起抹掉。
          const prev = readStateFile();
          if (prev && prev.reason === 'heartbeat') {
            fs.unlinkSync(statePath());
            log('心跳：没有 running 会话，清掉旧快照（避免重启后误唤醒空闲会话）');
          } else if (prev) {
            log('心跳：没有 running，但快照不是心跳写的（待恢复/失败条目），保留');
          }
        }
      } catch (e) {
        log(`心跳：清旧快照失败：${e && e.message ? e.message : e}`);
      }
      return { written: false, reason: 'idle', count: 0 };
    }
    for (const item of running) item.title = sessionTitle(item.id);
    const fp = fingerprintSessions(running);
    if (fp === lastHeartbeatFingerprint && fs.existsSync(statePath())) {
      return { written: false, reason: 'unchanged', count: running.length };
    }
    writeJsonAtomic(statePath(), { savedAt: now.toISOString(), reason: 'heartbeat', sessions: running });
    lastHeartbeatFingerprint = fp;
    log(`心跳：写入 ${running.length} 个 running 会话`);
    return { written: true, reason: 'changed', count: running.length };
  } catch (e) {
    log(`心跳失败（已忽略）：${e && e.message ? e.message : e}`);
    return { written: false, reason: 'error', count: 0 };
  }
}

// ── 钩子安装 ────────────────────────────────────────────────────────────

/** 当前进程里最近一次 apply 传进来的 ctx（退出钩子要用它读 agents）。 */
let liveCtx = null;
let hooksInstalled = false;
let restoreScheduled = false;
let initialized = false;
let heartbeatStarted = false;

function currentAgents() {
  try {
    const svc = liveCtx && typeof liveCtx.get === 'function' ? liveCtx.get('agents') : undefined;
    return svc && typeof svc.list === 'function' ? (svc.list() || []) : [];
  } catch { return []; }
}

export function installHooks(ctx) {
  liveCtx = ctx;
  if (hooksInstalled) return;
  hooksInstalled = true;

  // 每个信号一个闭包：不依赖监听器收到的参数（process.emit 手工触发时没有参数）。
  const makeSignalHandler = (sig) => () => {
    try { saveSnapshot(currentAgents(), `signal:${sig}`); } catch {}
    // 自己退出：只留了监听器时 Node 不会自动走默认终止，这里必须显式结束。
    // 会话事件是逐条同步落盘的，所以直接退出不会丢已提交的内容。
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const onBeforeExit = () => {
    try { saveSnapshot(currentAgents(), 'beforeExit'); } catch {}
  };

  try { process.on('SIGTERM', makeSignalHandler('SIGTERM')); } catch {}
  try { process.on('SIGINT', makeSignalHandler('SIGINT')); } catch {}
  try { process.on('beforeExit', onBeforeExit); } catch {}
  log(`退出钩子已挂上（pid=${process.pid}）`);
}

export function apply(ctx) {
  ensureDir(resumeDir());
  installHooks(ctx);

  if (!initialized) {
    initialized = true;
    try { cleanExpiredState(); } catch (e) { log(`启动清理抛错：${e && e.message ? e.message : e}`); }
  }

  if (!heartbeatStarted) {
    heartbeatStarted = true;
    ctx.effect(() => {
      const t = setInterval(() => { heartbeatTick(currentAgents()); }, HEARTBEAT_MS);
      return () => clearInterval(t);
    }, 'dsh-session-resume: heartbeat');
    log(`心跳已启动（每 ${HEARTBEAT_MS / 1000} 秒一次）`);
  }

  if (restoreScheduled) {
    log('apply 再次调用：恢复排程已存在，跳过');
    return;
  }
  restoreScheduled = true;

  ctx.effect(() => {
    const t = setTimeout(() => {
      (async () => {
        const env = {
          get agents() { try { return ctx.get ? ctx.get('agents') : undefined; } catch { return undefined; } },
          get sessionController() { try { return ctx.get ? ctx.get('sessionController') : undefined; } catch { return undefined; } },
        };
        try {
          await restore(env);
        } catch (e) {
          log(`恢复流程抛错：${e && e.message ? e.message : e}`);
        }
      })();
    }, restoreDelayMs());
    return () => clearTimeout(t);
  }, 'dsh-session-resume: restore timer');
}
