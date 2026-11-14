/**
 * dsh-auto-compact —— 任务正常结束后，Agent 自己压一轮
 *
 * 需求（项目权限管理员原话，v0.2 全部照办）：
 *   · 监听 `agent/status` 转 `idle`，**且**该会话最后一条 `turn/end` 是正常完成时，
 *     调 `compaction.compactNow()` 主动压一轮；
 *   · 同会话 10 分钟最多一次；
 *   · **阈值以下也压**（不再看 token 用量，compactNow 本来就是"阈值以下主动压"的入口）；
 *   · 失败只写日志、不重试、不抛出。
 *
 * 为什么不能只靠 compaction-basic 自己：
 *   · 它的自动压缩挂在 `agent/pre-step`（每走一步之前）⇒ 天生发生在**任务进行中**；
 *   · 阈值 min(窗口 × 0.8, 预算) 高得离谱，长任务中途就会触发；
 *   · 它没有"任务完成"这个概念，所以本插件只补"结束时机"这一个点。
 *
 * 关键事实（读源码 + cordis_inspect_query 核对，**不是猜的**）：
 *   · 服务名 `compaction`：`CompactionEngine extends Service`，`super(ctx, "compaction")`。
 *   · 签名（inspect 原文）：`compactNow(agent: ManualCompactAgentContext, signal: AbortSignal,
 *     sourceCommandId?: CommandId): Promise<CompactionResult | null>`
 *     —— 第二个参数是 **AbortSignal**，不是 ctx；`agent` 必须带 `runMaintenance`，
 *     也就是真实 agent 对象（不是 session）。
 *   · `compactNow` 本来就"允许在阈值以下主动压"（实现注释：Explicitly compact useful history
 *     even below automatic pressure thresholds），且没有可用区间时返回 null、不写日志、不调模型。
 *   · 忙时抛 `ManualCompactionError('busy')` ⇒ 必须只在 idle 之后调，且必须捕获。
 *   · `turn/end` 是**会话日志事件**，不是 Cordis 广播 ⇒ 只能从 `session.snapshotEvents()` 里读。
 *     `TurnEndReason` 的 kind：completed / aborted / blocked / error / max-tokens /
 *     interrupted / forked —— **只有 completed 才算正常完成**。
 *   · `agent/status` 只在状态**变化**时发；maintenance 期间对外仍算 idle ⇒ 压缩不会再触发一轮，
 *     不会递归。
 *
 * 本插件**故意不写** `inject: ['compaction']`：`compaction` 由 agent preset 的 isolate 分组挂载，
 * 根级 inject 会永远等不到服务、插件根本不加载。改为运行期从 `agent.ctx` 往上解析。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** 同会话两次尝试的最小间隔（毫秒）：需求写死 10 分钟。 */
const DEFAULT_MIN_INTERVAL_MINUTES = 10;
/** 调试日志；需求指定 %TEMP%\dsh-auto-compact.log。 */
const DEFAULT_LOG_FILE = join(tmpdir(), 'dsh-auto-compact.log');
/**
 * 项目侧台账（项目管理员 2026-11-12 的要求）：
 *   %TEMP% 会被系统清掉，审计"压了几次、花了多少 token"不能只靠它。
 *   所以每次**真压**（含 no-op 与失败）另写一行 JSONL 到持久目录。
 *   默认放 %DSH_HOME%\logs\ 下；PicoPhone 可以在 patch 里用 ledgerFile 指到项目 debug_logs。
 */
const DEFAULT_LEDGER_FILE = join(
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh'),
  'logs',
  'dsh-auto-compact-ledger.jsonl',
);
const LOG_TAG = '[dsh-auto-compact]';

export const name = 'dsh-auto-compact';

/** 把 config 洗成一组安全值：写错一律回落默认，绝不因为配置崩掉。 */
function readSettings(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {};
  const minutes = Number(config.minIntervalMinutes);
  return {
    /** 开关：默认开（需求第 6 条）。 */
    enabled: config.enabled !== false,
    minIntervalMs: Number.isFinite(minutes) && minutes >= 0
      ? Math.round(minutes * 60000)
      : DEFAULT_MIN_INTERVAL_MINUTES * 60000,
    /** dryRun 只留作首次验证：默认 false，真的压。 */
    dryRun: config.dryRun === true,
    /** 子会话（父会话可能还要追问它）默认不压。 */
    includeSubagents: config.includeSubagents === true,
    /** 日志落盘位置；允许临时改，方便排查。 */
    logFile: typeof config.logFile === 'string' && config.logFile.length > 0 ? config.logFile : DEFAULT_LOG_FILE,
    /** 项目侧台账（持久，不随 %TEMP% 被清）。 */
    ledgerFile: typeof config.ledgerFile === 'string' && config.ledgerFile.length > 0
      ? config.ledgerFile
      : DEFAULT_LEDGER_FILE,
    /** idle 之后延后多久再判定：让 turn/end 先落进会话日志。 */
    settleDelayMs: Number.isFinite(Number(config.settleDelayMs)) && Number(config.settleDelayMs) >= 0
      ? Math.round(Number(config.settleDelayMs))
      : 20,
  };
}

/**
 * 唯一的日志出口：**先写 %TEMP%\dsh-auto-compact.log**（需求指定），
 * 再顺手镜像一份到 ctx.logger。写日志本身绝不抛。
 */
function makeLogger(ctx, settings) {
  return function log(level, message) {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
    try {
      appendFileSync(settings.logFile, `${line}\n`, 'utf8');
    } catch { /* 磁盘满 / 权限不足都不该影响会话 */ }
    try {
      const logger = ctx?.logger;
      const write = typeof logger?.[level] === 'function' ? logger[level] : undefined;
      if (write !== undefined) {
        write.call(logger, `${LOG_TAG} ${message}`);
        return;
      }
    } catch { /* 落到 console */ }
    const fallback = level === 'warn' || level === 'error' ? console.warn : console.log;
    try { fallback(`${LOG_TAG} ${message}`); } catch { /* 忽略 */ }
  };
}

/**
 * 项目侧台账：每次真压写一行 JSONL（时间 / 会话 / 段数 / 约多少 token）。
 *
 * 为什么不只用 %TEMP% 的调试日志（项目管理员 2026-11-12 的建议）：
 *   临时目录会被系统清理，事后查"压了几次、花了多少"就查不到了。
 * 台账写不进去（只读盘、目录不存在、磁盘满）**绝不影响会话**，只安静失败一次。
 */
function makeLedger(settings) {
  let dirReady = false;
  return function writeLedger(record) {
    try {
      if (!dirReady) {
        mkdirSync(dirname(settings.ledgerFile), { recursive: true });
        dirReady = true;
      }
      const line = JSON.stringify({ at: new Date().toISOString(), ...record });
      appendFileSync(settings.ledgerFile, `${line}\n`, 'utf8');
    } catch {
      dirReady = false;   // 下次再试；失败本身不外抛
    }
  };
}

/**
 * 依次在 agent 作用域、根作用域里找服务。
 * compaction 在 preset 的 isolate 分组里，根 ctx 看不到；tokenMeter / llm 在 host 平面。
 */
function serviceOf(ctx, agent, name) {
  for (const scope of [agent?.ctx, ctx]) {
    if (scope === null || scope === undefined) continue;
    try {
      if (typeof scope.get === 'function') {
        const viaGet = scope.get(name);
        if (viaGet !== undefined && viaGet !== null) return viaGet;
      }
    } catch { /* 隔离作用域里 get 可能抛，继续试下一个 */ }
    try {
      const direct = scope[name];
      if (direct !== undefined && direct !== null) return direct;
    } catch { /* 未注册的服务属性可能抛，忽略 */ }
  }
  return undefined;
}

function sessionKeyOf(agent) {
  try {
    return String(agent?.session?.id ?? agent?.id ?? '');
  } catch {
    return '';
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读这个会话最后一条 `turn/end`，判定"这一轮是不是正常完成"。
 *
 * 返回：
 *   { state: 'completed' | 'other' | 'open' | 'none' | 'unknown', reason?: string }
 *   · completed —— 最后一条 turn/end 的 reason.kind === 'completed'（**只有这个才压**）
 *   · other     —— 有 turn/end 但不是正常完成（aborted / error / max-tokens / interrupted / …）
 *   · open      —— 最近一条 turn/start 比最后一条 turn/end 更晚（新一轮还没结束）
 *   · none      —— 日志里还没有任何 turn/end
 *   · unknown   —— 读不到会话事件（不猜，直接跳过）
 *
 * 注意：压缩产生的 compaction/start、compaction/end 是 turn/end **之后**的事件，
 * 扫到它们不影响本判定。
 */
function turnOutcome(session) {
  let events;
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined;
  } catch {
    return { state: 'unknown' };
  }
  if (!Array.isArray(events) || events.length === 0) return { state: 'none' };

  let lastEndIndex = -1;
  let lastStartIndex = -1;
  let lastEnd;

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const type = event?.type;
    if (lastEndIndex < 0 && type === 'turn/end') {
      lastEndIndex = i;
      lastEnd = event;
      continue;
    }
    if (lastStartIndex < 0 && type === 'turn/start') {
      lastStartIndex = i;
      continue;
    }
    if (lastEndIndex >= 0 && lastStartIndex >= 0) break;
  }

  if (lastEndIndex < 0) return { state: 'none' };
  if (lastStartIndex > lastEndIndex) return { state: 'open' };

  const reason = lastEnd?.data?.reason;
  const kind = reason?.kind;
  if (kind === 'completed') return { state: 'completed', reason: 'completed' };
  return { state: 'other', reason: typeof kind === 'string' ? kind : 'unknown' };
}

export function apply(ctx, config) {
  const settings = readSettings(config);
  const log = makeLogger(ctx, settings);
  /** 项目侧台账（持久）：每次真压一行，见 makeLedger 的注释。 */
  const ledger = makeLedger(settings);

  /** 会话 → 上次真正尝试压缩的时间戳（失败也算，避免 10 分钟内反复试）。 */
  const lastAttemptAt = new Map();
  /** 正在跑压缩的会话，防止同会话重入。 */
  const inFlight = new Set();
  /** 待执行的 setTimeout 句柄，dispose 时清掉。 */
  const timers = new Set();
  /** 在飞的压缩信号，dispose 时 abort。 */
  const aborters = new Set();
  /** 每类"解析不到"的原因只吵一次，不刷屏。 */
  const warned = new Set();

  function warnOnce(reason, message) {
    if (warned.has(reason)) return;
    warned.add(reason);
    log('warn', message);
  }

  /** idle 之后的一次判定：查 turn/end → 查节流 → compactNow。全程不抛。 */
  async function consider(agent, key) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      if (settings.includeSubagents !== true) {
        const origin = agent?.session?.meta?.origin;
        if (origin === 'subagent') {
          log('info', `session=${key} skip: subagent session`);
          return;
        }
      }

      // ① 最后一条 turn/end 必须存在，且是正常完成（异常 / 取消 / token 超限都不压）
      const outcome = turnOutcome(agent?.session);
      if (outcome.state !== 'completed') {
        const detail = outcome.reason !== undefined ? ` (reason=${outcome.reason})` : '';
        log('info', `session=${key} skip: turn not completed (${outcome.state}${detail})`);
        return;
      }

      // ② 同会话 10 分钟最多一次
      const now = Date.now();
      const last = lastAttemptAt.get(key) ?? 0;
      if (now - last < settings.minIntervalMs) {
        const waitMinutes = Math.ceil((settings.minIntervalMs - (now - last)) / 60000);
        log('info', `session=${key} skip: too soon (约 ${waitMinutes} 分钟后再试，间隔至少 ${Math.round(settings.minIntervalMs / 60000)} 分钟)`);
        return;
      }

      // ③ compaction 服务（运行期解析，不能 inject）
      const compaction = serviceOf(ctx, agent, 'compaction');
      if (compaction === undefined || typeof compaction.compactNow !== 'function') {
        warnOnce('compaction', `session=${key} 找不到 compaction 服务（compactNow 不可用），自动压缩跳过`);
        return;
      }

      // ④ 真的空闲才动手（忙时 compactNow 会抛 busy）
      if (agent.status !== 'idle') {
        log('info', `session=${key} skip: agent not idle (${agent.status})`);
        return;
      }

      if (settings.dryRun) {
        lastAttemptAt.set(key, now);
        log('info', `session=${key} dryRun: would compact now`);
        return;
      }

      // 先占坑再动手：失败也吃满 10 分钟节流，避免坏会话反复烧钱。
      lastAttemptAt.set(key, now);
      const controller = new AbortController();
      aborters.add(controller);
      try {
        // 签名以 inspect 为准：compactNow(agent, signal, sourceCommandId?)
        const result = await compaction.compactNow(agent, controller.signal);
        if (result === null || result === undefined) {
          log('info', `session=${key} compacted ok: nothing useful to compact (no-op)`);
          ledger({ session: key, outcome: 'noop' });
        } else {
          const count = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0;
          const tokens = Number(result.shadowedTokenCount ?? 0);
          log('info', `session=${key} compacted ok: ${count} 段历史（约 ${tokens} tokens）`);
          ledger({ session: key, outcome: 'compacted', seqs: count, tokens });
        }
      } finally {
        aborters.delete(controller);
      }
    } catch (error) {
      // 失败：只写日志，不重试、不抛出（busy / cancelled / 摘要模型报错都在这里消化）。
      log('warn', `session=${key} fail: ${errorMessage(error)}（不重试，等下一轮任务结束）`);
      ledger({ session: key, outcome: 'fail', error: errorMessage(error) });
    } finally {
      inFlight.delete(key);
    }
  }

  function onStatus(payload) {
    try {
      if (settings.enabled === false) return;   // 开关：config.enabled=false 时完全静默
      if (payload?.status !== 'idle') return;
      const agent = payload.agent;
      if (agent === null || agent === undefined) return;
      const key = sessionKeyOf(agent);
      if (key.length === 0) return;
      // 用 setTimeout 而不是同栈调用：emit 发生在 setPhase() 内部，
      // 同栈跑 runMaintenance() 会在别人的阶段切换里改 phase；延到下一个宏任务 并且
      // 留一点点时间让 turn/end 先写进会话日志。
      const timer = setTimeout(() => {
        timers.delete(timer);
        void consider(agent, key);
      }, settings.settleDelayMs);
      if (typeof timer.unref === 'function') timer.unref();
      timers.add(timer);
    } catch (error) {
      log('warn', `agent/status 处理失败（已忽略）：${errorMessage(error)}`);
    }
  }

  ctx.effect(() => {
    const off = ctx.on('agent/status', onStatus);
    return () => {
      if (typeof off === 'function') off();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const controller of aborters) {
        try { controller.abort(); } catch { /* 已经结束 */ }
      }
      aborters.clear();
    };
  }, 'dsh-auto-compact: agent/status');

  log('info', settings.enabled
    ? `已启用：任务正常结束即压一轮（阈值不设下限），节流 ${Math.round(settings.minIntervalMs / 60000)} 分钟，日志 ${settings.logFile}，台账 ${settings.ledgerFile}${settings.dryRun ? '，dryRun 只报告' : ''}`
    : `已停用（config.enabled=false），日志 ${settings.logFile}`);
}

/** 供 smoke-test 直接复用：判定逻辑是纯函数，好测。 */
export const __test = { readSettings, turnOutcome, serviceOf };
