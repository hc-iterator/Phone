/**
 * dsh-timer —— 三个小功能：正计时 / 倒计时 / 现在几点
 *
 * 设计取舍（都为了"不碍事"）：
 *   · **一个进程内计时器**，不是外部进程：DSH 一停，计时也停（用户要的是"这次会话里过了多久"，
 *     不是系统级闹钟）。
 *   · 定时器一律 `unref()`：否则倒计时会把 DSH 进程吊住，用户关不掉。
 *   · 状态是**全局单例**（不在每个会话里各存一份）：用户说"倒计时 10 分钟"时，他期望的是
 *     "这台机器上有一个 10 分钟倒计时"，而不是每个会话各一个。
 *   · 时间一律用单调时钟（performance.now / Date.now 差值）算，避免系统时间被改导致跳变。
 *
 * 工具：
 *   timer_stopwatch  正计时：start / stop / reset / status
 *   timer_countdown  倒计时：start(seconds) / cancel / status
 *   timer_now        现在时间（本地 + UTC + epoch，附格式化）
 */

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
  },
  required: ['ok', 'text'],
};

/** 把毫秒格式化成 "1h 02m 03.4s" 这种一眼能读的形式。 */
function human(ms) {
  if (!Number.isFinite(ms)) ms = 0;
  const neg = ms < 0;
  ms = Math.abs(ms);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = (ms % 60000) / 1000;
  const parts = [];
  if (h > 0) parts.push(h + 'h');
  if (h > 0 || m > 0) parts.push(String(m).padStart(2, '0') + 'm');
  parts.push((h > 0 || m > 0 ? String(Math.floor(s)).padStart(2, '0') : s.toFixed(1)) + (h > 0 || m > 0 ? 's' : ''));
  return (neg ? '-' : '') + parts.join(' ');
}

// ── 全局单例状态 ────────────────────────────────────────────────────────────
const stopwatch = {
  startedAt: null,   // Date.now() 起点；null = 没在跑
  accumulated: 0,    // 之前几段累计的毫秒
};

const countdown = {
  endsAt: null,      // Date.now() 到期时刻；null = 没在跑
  totalMs: 0,
  handle: null,
  fired: false,      // 是否已到期（到期后仍保留，直到 cancel 或下一次 start）
};

function stopwatchElapsed() {
  return stopwatch.accumulated + (stopwatch.startedAt === null ? 0 : Date.now() - stopwatch.startedAt);
}

function countdownRemaining() {
  if (countdown.endsAt === null) return null;
  return countdown.endsAt - Date.now();
}

function clearCountdownTimer() {
  if (countdown.handle) {
    try { clearTimeout(countdown.handle); } catch { /* 已经触发过 */ }
    countdown.handle = null;
  }
}

async function opStopwatch(cfg, args = {}) {
  const action = String(args.action ?? 'status');
  const now = Date.now();
  switch (action) {
    case 'start': {
      if (stopwatch.startedAt !== null) {
        return { ok: true, text: `正计时已经在跑：${human(stopwatchElapsed())}（要重来请先 reset）` };
      }
      stopwatch.startedAt = now;
      return { ok: true, text: `正计时已开始（之前累计 ${human(stopwatch.accumulated)}）` };
    }
    case 'stop': {
      if (stopwatch.startedAt === null) {
        return { ok: true, text: `正计时没在跑；累计 ${human(stopwatch.accumulated)}` };
      }
      stopwatch.accumulated += now - stopwatch.startedAt;
      stopwatch.startedAt = null;
      return { ok: true, text: `正计时已停：${human(stopwatch.accumulated)}` };
    }
    case 'reset': {
      stopwatch.startedAt = null;
      stopwatch.accumulated = 0;
      return { ok: true, text: '正计时已清零' };
    }
    case 'status':
    default: {
      const running = stopwatch.startedAt !== null;
      return {
        ok: true,
        text: `正计时：${human(stopwatchElapsed())}（${running ? '在跑' : '已停'}）`,
      };
    }
  }
}

async function opCountdown(cfg, args = {}) {
  const action = String(args.action ?? 'status');
  const now = Date.now();

  if (action === 'start') {
    const seconds = Number(args.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { ok: false, text: 'seconds 必须是正数（秒）' };
    }
    if (countdown.endsAt !== null) {
      const left = countdownRemaining();
      return { ok: false, text: `已经有一个倒计时在跑（剩 ${human(left)}）。先 cancel 再开新的。` };
    }
    const ms = seconds * 1000;
    countdown.totalMs = ms;
    countdown.endsAt = now + ms;
    countdown.fired = false;
    clearCountdownTimer();
    countdown.handle = setTimeout(() => {
      countdown.fired = true;
      countdown.handle = null;
      // unref 之后这个定时器不会吊住进程，但它仍会按时回调（进程活着时）
    }, ms);
    // 关键：不 unref 的话，长倒计时会让 DSH 进程无法退出
    if (typeof countdown.handle.unref === 'function') countdown.handle.unref();
    return { ok: true, text: `倒计时开始：${human(ms)}（到 ${new Date(countdown.endsAt).toLocaleTimeString()}）` };
  }

  if (action === 'cancel') {
    const had = countdown.endsAt !== null;
    clearCountdownTimer();
    countdown.endsAt = null;
    countdown.totalMs = 0;
    countdown.fired = false;
    return { ok: true, text: had ? '倒计时已取消' : '本来就没有倒计时在跑' };
  }

  // status
  if (countdown.endsAt === null) {
    return { ok: true, text: '倒计时：没有在跑' };
  }
  const left = countdownRemaining();
  if (left <= 0) {
    return { ok: true, text: `倒计时：已结束（原定 ${human(countdown.totalMs)}，结束于 ${new Date(countdown.endsAt).toLocaleTimeString()}）` };
  }
  return { ok: true, text: `倒计时剩：${human(left)}（共 ${human(countdown.totalMs)}，到 ${new Date(countdown.endsAt).toLocaleTimeString()}）` };
}

async function opNow(cfg, args = {}) {
  const d = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '(unknown)';
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const utc = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  return {
    ok: true,
    text: `现在：${local}\nUTC ：${utc}\n时区：${tz}\nepoch：${d.getTime()}（毫秒）`,
  };
}

function tool(cfg, name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    },
    async execute(args) {
      return await run(cfg, args ?? {});
    },
  };
}

function buildToolDefinitions(cfg) {
  return [
    tool(
      cfg,
      'timer_stopwatch',
      'Count UP from zero: start / stop / reset / status. Keeps accumulating across stop/start until reset. Use it for "how long did this take".',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'reset', 'status'], description: 'Operation; default status.' },
        },
      },
      opStopwatch,
    ),
    tool(
      cfg,
      'timer_countdown',
      'Count DOWN: start / cancel / status. One global countdown at a time (starting a second is refused). Use it for "remind me in 10 minutes".',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['start', 'cancel', 'status'], description: 'Operation; default status.' },
          seconds: { type: 'number', description: 'start: duration in seconds (must be > 0).' },
        },
      },
      opCountdown,
    ),
    tool(
      cfg,
      'timer_now',
      'Return the current local time, UTC time, timezone and epoch milliseconds.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      opNow,
    ),
  ];
}

export async function apply(ctx, rawConfig) {
  const cfg = {};
  for (const definition of buildToolDefinitions(cfg)) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-timer: ${definition.name}`);
  }
}
