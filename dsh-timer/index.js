/**
 * dsh-timer —— 三个小功能：正计时 / 倒计时 / 现在几点
 *
 * 关键设计：**每个对话一份状态**（用户明确要求）。
 *   用 exec.agent.id 作为 key —— A 会话的倒计时不该出现在 B 会话里，
 *   也不该因为别的会话 reset 就被清零。每个会话几字节，不值得省。
 *
 * 其它取舍：
 *   · 定时器一律 unref()：否则长倒计时会把 DSH 进程吊住，关不掉。
 *   · 时间用 Date.now() 差值而不是累加 tick：系统卡顿也不会让计时漂移。
 *   · 倒计时到期不主动推送，只把状态标成"已结束"（主动提醒该由上层决定）。
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

/** 毫秒 → "1h 02m 03s"，人一眼能读。 */
function human(ms) {
  if (!Number.isFinite(ms)) ms = 0;
  const neg = ms < 0;
  ms = Math.abs(ms);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = (ms % 60000) / 1000;
  const parts = [];
  if (h > 0) parts.push(h + 'h');
  if (h > 0 || m > 0) {
    parts.push(String(m).padStart(2, '0') + 'm');
    parts.push(String(Math.floor(s)).padStart(2, '0') + 's');
  } else {
    parts.push(s.toFixed(1) + 's');
  }
  return (neg ? '-' : '') + parts.join(' ');
}

// ── 每个会话一份状态 ────────────────────────────────────────────────────────
const stopwatchBySession = new Map();  // id -> { startedAt, accumulated }
const countdownBySession = new Map();  // id -> { endsAt, totalMs, handle, fired }

function stopwatchOf(id) {
  if (!stopwatchBySession.has(id)) stopwatchBySession.set(id, { startedAt: null, accumulated: 0 });
  return stopwatchBySession.get(id);
}

function countdownOf(id) {
  if (!countdownBySession.has(id)) countdownBySession.set(id, { endsAt: null, totalMs: 0, handle: null, fired: false });
  return countdownBySession.get(id);
}

function elapsedOf(sw) {
  return sw.accumulated + (sw.startedAt === null ? 0 : Date.now() - sw.startedAt);
}

function remainingOf(cd) {
  if (cd.endsAt === null) return null;
  return cd.endsAt - Date.now();
}

function clearCountdownTimer(cd) {
  if (cd.handle) {
    try { clearTimeout(cd.handle); } catch { /* 已触发过 */ }
    cd.handle = null;
  }
}

async function opStopwatch(args = {}, sessionId = '') {
  const action = String(args.action ?? 'status');
  const now = Date.now();
  const sw = stopwatchOf(sessionId);

  switch (action) {
    case 'start':
      if (sw.startedAt !== null) {
        return { ok: true, text: `本对话的正计时已经在跑：${human(elapsedOf(sw))}（要重来请先 reset）` };
      }
      sw.startedAt = now;
      return { ok: true, text: `本对话正计时已开始（之前累计 ${human(sw.accumulated)}）` };
    case 'stop':
      if (sw.startedAt === null) {
        return { ok: true, text: `本对话正计时没在跑；累计 ${human(sw.accumulated)}` };
      }
      sw.accumulated += now - sw.startedAt;
      sw.startedAt = null;
      return { ok: true, text: `本对话正计时已停：${human(sw.accumulated)}` };
    case 'reset':
      sw.startedAt = null;
      sw.accumulated = 0;
      return { ok: true, text: '本对话正计时已清零' };
    case 'status':
    default:
      return {
        ok: true,
        text: `本对话正计时：${human(elapsedOf(sw))}（${sw.startedAt !== null ? '在跑' : '已停'}）`,
      };
  }
}

async function opCountdown(args = {}, sessionId = '') {
  const action = String(args.action ?? 'status');
  const now = Date.now();
  const cd = countdownOf(sessionId);

  if (action === 'start') {
    const seconds = Number(args.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, text: 'seconds 必须是正数（秒）' };
    if (cd.endsAt !== null) {
      return { ok: false, text: `本对话已有倒计时在跑（剩 ${human(remainingOf(cd))}）。先 cancel 再开新的。` };
    }
    const ms = seconds * 1000;
    cd.totalMs = ms;
    cd.endsAt = now + ms;
    cd.fired = false;
    clearCountdownTimer(cd);
    cd.handle = setTimeout(() => {
      cd.fired = true;
      cd.handle = null;
    }, ms);
    if (typeof cd.handle.unref === 'function') cd.handle.unref();
    return { ok: true, text: `本对话倒计时开始：${human(ms)}（到 ${new Date(cd.endsAt).toLocaleTimeString()}）` };
  }

  if (action === 'cancel') {
    const had = cd.endsAt !== null;
    clearCountdownTimer(cd);
    cd.endsAt = null;
    cd.totalMs = 0;
    cd.fired = false;
    return { ok: true, text: had ? '本对话倒计时已取消' : '本对话本来就没有倒计时' };
  }

  if (cd.endsAt === null) return { ok: true, text: '本对话倒计时：没有在跑' };
  const left = remainingOf(cd);
  if (left <= 0) {
    return { ok: true, text: `本对话倒计时：已结束（原定 ${human(cd.totalMs)}，结束于 ${new Date(cd.endsAt).toLocaleTimeString()}）` };
  }
  return { ok: true, text: `本对话倒计时剩：${human(left)}（共 ${human(cd.totalMs)}，到 ${new Date(cd.endsAt).toLocaleTimeString()}）` };
}

async function opNow() {
  const d = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '(unknown)';
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const utc = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  return { ok: true, text: `现在：${local}\nUTC ：${utc}\n时区：${tz}\nepoch：${d.getTime()}（毫秒）` };
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
    async execute(args, exec) {
      // 会话 id 就是隔离键；拿不到时退回 'global'（不崩，只是退化成共享）
      const sessionId = String(exec?.agent?.id ?? 'global');
      return await run(args ?? {}, sessionId);
    },
  };
}

function buildToolDefinitions() {
  return [
    tool(
      'timer_stopwatch',
      'Count UP inside THIS conversation: start / stop / reset / status. Each conversation has its own stopwatch. Use it for "how long did this take".',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'reset', 'status'], description: 'Operation; default status.' },
        },
      },
      (args, sessionId) => opStopwatch(args, sessionId),
    ),
    tool(
      'timer_countdown',
      'Count DOWN inside THIS conversation: start / cancel / status. Each conversation has its own countdown (one at a time). Use it for "remind me in 10 minutes".',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['start', 'cancel', 'status'], description: 'Operation; default status.' },
          seconds: { type: 'number', description: 'start: duration in seconds (> 0).' },
        },
      },
      (args, sessionId) => opCountdown(args, sessionId),
    ),
    tool(
      'timer_now',
      'Return the current local time, UTC time, timezone and epoch milliseconds.',
      { type: 'object', additionalProperties: false, properties: {} },
      () => opNow(),
    ),
  ];
}

// cordis 要求：直接访问 ctx.tools 前必须在插件顶层声明依赖。
// 缺这一行 ⇒ 插件挂载被拒 ⇒ 所有加载它的会话都无法 resume（2026-11-04 在 dsh-gui 上踩过一次）。
export const inject = ['tools'];

export async function apply(ctx, rawConfig) {
  for (const definition of buildToolDefinitions()) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-timer: ${definition.name}`);
  }
}

