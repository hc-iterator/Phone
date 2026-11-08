/**
 * 离线冒烟：验证 dsh-timer 的倒计时到期会向发起会话投递一次提醒，取消后不再投递。
 * 不依赖 DSH 运行时：伪造 ctx / agent，直接调 apply() 注册出来的工具定义。
 *
 * 运行：node smoke-test.mjs        （退出码 0 = 全过）
 */
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(HERE, 'index.js')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, extra = '') {
  console.log((ok ? '✓ ' : '✗ ') + label + (extra ? '   ' + extra : ''));
  if (!ok) failures += 1;
}

// ── 伪造宿主：捕获注册出来的工具定义 ──────────────────────────────────────
const tools = {};
const fakeCtx = {
  effect: (fn) => { try { return fn(); } catch { return undefined; } },
  tools: { register: (definition) => { tools[definition.name] = definition; } },
  get: (key) => (key === 'agents' ? { get: () => undefined } : undefined),
};
await mod.apply(fakeCtx, {});
const countdown = tools.timer_countdown;
check('工具注册成功（timer_countdown）', countdown !== undefined && typeof countdown.execute === 'function');

function makeAgent(id) {
  const calls = [];
  return {
    id,
    calls,
    steer: (message) => { calls.push({ via: 'steer', message }); },
    followup: (message) => { calls.push({ via: 'followup', message }); },
  };
}

// ── 用例 1：到期应投递一次，且来源不是 user ────────────────────────────────
const a1 = makeAgent('sess-expire');
await countdown.execute({ action: 'start', seconds: 0.05 }, { agent: a1 });
await sleep(400);
check('到期后投递一次', a1.calls.length === 1, '实际 ' + a1.calls.length + ' 次');
check('走的是 steer', a1.calls[0]?.via === 'steer', String(a1.calls[0]?.via));
const msg = a1.calls[0]?.message;
check('消息是 user 角色 + text 块', msg?.role === 'user' && Array.isArray(msg?.content) && msg.content[0]?.type === 'text');
check('来源不是 user（保目标闸）', msg?.source?.kind === 'tool', JSON.stringify(msg?.source));
check('正文声明是系统提醒', typeof msg?.content?.[0]?.text === 'string' && msg.content[0].text.includes('倒计时器的系统提醒'));

// ── 用例 2：取消后到期不再投递 ─────────────────────────────────────────────
const a2 = makeAgent('sess-cancel');
await countdown.execute({ action: 'start', seconds: 1 }, { agent: a2 });
await countdown.execute({ action: 'cancel' }, { agent: a2 });
await sleep(1300);
check('取消后不再投递', a2.calls.length === 0, '实际 ' + a2.calls.length + ' 次');

// ── 用例 3：没有 steer 时退回 followup ─────────────────────────────────────
const a3 = { id: 'sess-followup', calls: [], followup(message) { this.calls.push({ via: 'followup', message }); } };
await countdown.execute({ action: 'start', seconds: 0.05 }, { agent: a3 });
await sleep(400);
check('无 steer 时退回 followup', a3.calls.length === 1 && a3.calls[0].via === 'followup', '实际 ' + a3.calls.length + ' 次');

// ── 用例 4：拿不到 agent 时不崩 ────────────────────────────────────────────
let threw = false;
try {
  await countdown.execute({ action: 'start', seconds: 0.05 }, {});
  await sleep(400);
} catch { threw = true; }
check('没有 agent 也不抛错', threw === false);

console.log(failures === 0 ? '\nRESULT: ALL PASS ✓' : '\nRESULT: ' + failures + ' FAILED ✗');
process.exit(failures === 0 ? 0 : 1);
