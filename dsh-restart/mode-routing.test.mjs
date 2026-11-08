/**
 * dsh-restart 投递边界（mode）冒烟测试 —— 只验证「消息投到哪个边界」，不碰任何会话。
 *
 * 背景：用户报「消息还是排队，没搞好插队」。根因是 relay() 只会 followup（= next-turn）。
 * 修法见 docs/调查-消息插队复测.md 第五节。本测试锁三件事：
 *
 *   1) dsh_wake_session（派活/唤醒）必须走 agent.steer → next-step（插队）；
 *   2) 表决/广播/流程通知必须走 agent.followup → next-turn（不打断）；
 *   3) 冷唤起路径（目标没加载，靠 resolveAgent 拉起来）也必须拿到同一个 mode
 *      —— 这里曾经丢过 mode（deliver(a,'wake') 少传一个参数），是本测试的重点回归项。
 *
 * 跑法：node dsh-plugins/dsh-restart/mode-routing.test.mjs
 * 退出码 0 = 全绿。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ← ' + detail : '')); }
};

/** 造一个只会记录「被投到哪个边界」的假 Agent。 */
function fakeAgent({ withSteer = true } = {}) {
  const rec = { steer: 0, followup: 0, sawInboxSend: false };
  const a = {
    id: 'session-fake',
    // 故意的：Inbox 上没有 send（真实 Inbox 也没有），旧代码就是靠它做死分枝判断。
    inbox: {},
    followup: (m) => { rec.followup++; rec.msg = m; rec.kind = 'followup'; },
  };
  if (withSteer) a.steer = (m) => { rec.steer++; rec.msg = m; rec.kind = 'steer'; };
  rec.agent = a;
  return rec;
}

/** 用给定的 agents / sessionController 建一个 ctx，并捕获所有注册的工具。 */
function boot({ agents, sessionController } = {}) {
  const tools = new Map();
  const services = new Map();
  if (agents !== undefined) services.set('agents', agents);
  if (sessionController !== undefined) services.set('sessionController', sessionController);
  const ctx = {
    effect: (cb) => { const r = cb(); return typeof r === 'function' ? r : () => {}; },
    tools: { register: (d) => { tools.set(d.name, d); return () => {}; } },
    get: (k) => services.get(k),
    inject: (names, cb) => {
      if (names.includes('commands')) cb({ commands: { register: () => {} } });
    },
    on: () => () => {},
  };
  apply(ctx, {});
  return tools;
}

const exec = { agent: { id: 'session-tester' } };

// ── 用例 1：活的 Agent + 有 steer ⇒ 插队 ──────────────────────────────────
console.log('[1] dsh_wake_session → 活 Agent（有 steer）应走 steer');
{
  const rec = fakeAgent({ withSteer: true });
  const tools = boot({ agents: { get: (id) => (id === 'session-target' ? rec.agent : undefined), list: () => [rec.agent] } });
  const r = await tools.get('dsh_wake_session').execute({ to: 'session-target', text: '[测试] 插队' }, exec);
  check('返回 ok', r.ok === true, JSON.stringify(r));
  check('调用了 steer 一次', rec.steer === 1, 'steer=' + rec.steer);
  check('没有落到 followup', rec.followup === 0, 'followup=' + rec.followup);
  check('消息带 agent-message 来源', rec.msg && rec.msg.source && rec.msg.source.kind === 'agent-message');
  check('role 仍是 user（会话校验器要求）', rec.msg && rec.msg.role === 'user');
}

// ── 用例 2：活的 Agent 没有 steer ⇒ followup 兜底，消息不能丢 ─────────────
console.log('[2] dsh_wake_session → 老门面（无 steer）应 followup 兜底');
{
  const rec = fakeAgent({ withSteer: false });
  const tools = boot({ agents: { get: () => rec.agent, list: () => [rec.agent] } });
  const r = await tools.get('dsh_wake_session').execute({ to: 'session-target', text: '[测试] 兜底' }, exec);
  check('返回 ok', r.ok === true, JSON.stringify(r));
  check('调用了 followup 一次', rec.followup === 1, 'followup=' + rec.followup);
}

// ── 用例 3（重点回归）：冷唤起也要拿到 mode，必须还是 steer ───────────────
console.log('[3] dsh_wake_session → 目标没加载，resolveAgent 唤起后应仍走 steer');
{
  const rec = fakeAgent({ withSteer: true });
  const agents = { get: () => undefined, list: () => [] };
  const sessionController = { resolveAgent: async () => ({ agent: rec.agent }) };  // 真实形状：{agent}|{error}
  const tools = boot({ agents, sessionController });
  const r = await tools.get('dsh_wake_session').execute({ to: 'session-target', text: '[测试] 冷唤起' }, exec);
  check('返回 via=wake', r.via === 'wake', JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 50));   // 等 resolveAgent 的 then 跑完
  check('冷唤起后调用了 steer（mode 没丢）', rec.steer === 1, 'steer=' + rec.steer + ' followup=' + rec.followup);
  check('冷唤起没有落到 followup', rec.followup === 0, 'followup=' + rec.followup);
}

// ── 用例 4：静态检查 —— 每个投递点都必须显式声明边界 ──────────────────────
// 注意：静态检查必须先把注释剥掉，否则本文件里那些「解释死代码」的注释会被误当成代码。
// 调用点常常跨行，所以按括号配平取整段实参，不能按行判断。

/** 剥掉 // 与 /* *\/ 注释（保留字符串字面量内的内容）。足够用于本仓库的源码。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

/** 从 `name(` 的 `(` 开始按括号配平，返回整段调用（含括号），用于跨行调用。 */
function callAt(src, openParenIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openParenIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openParenIdx, i + 1); }
  }
  return src.slice(openParenIdx);
}

console.log('[4] 静态检查：投递点的 mode 是否显式且正确');
{
  const raw = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  const src = stripComments(raw);

  check('死分枝 inbox.send 已删除', !/inbox\.send/.test(src), '仍有 inbox.send 调用');
  check("relay 的 mode 默认值是 'turn'（漏传不打断别人）", /const relay = \(toId, kind, body, senderId, mode = 'turn'\)/.test(src));
  check("notifyTargets 的兜底 mode 是 'turn'", /const mode = \(opts && opts\.mode\) \|\| 'turn';/.test(src));

  // 所有 notifyTargets(...) 调用点（排除定义本身）
  const notifyArgs = [];
  for (let i = src.indexOf('notifyTargets('); i >= 0; i = src.indexOf('notifyTargets(', i + 1)) {
    const before = src.slice(Math.max(0, i - 20), i);
    if (/(const|=>\s*)$/.test(before.trim()) || /const\s+$/.test(before)) continue;   // 定义，不是调用
    notifyArgs.push(callAt(src, i + 'notifyTargets'.length));
  }
  check('notifyTargets 调用点共 4 处', notifyArgs.length === 4, '实际 ' + notifyArgs.length);
  for (const a of notifyArgs) {
    check("  └ 该调用点显式 mode: 'turn'", /mode: 'turn'/.test(a), a.replace(/\s+/g, ' ').slice(0, 110));
  }

  // 直接 relay(...) 的调用点
  const relayArgs = [];
  for (let i = src.indexOf('relay('); i >= 0; i = src.indexOf('relay(', i + 1)) {
    const before = src.slice(Math.max(0, i - 24), i);
    if (/const\s+$/.test(before) || /function\s+$/.test(before)) continue;            // 定义
    relayArgs.push(callAt(src, i + 'relay'.length));
  }
  check('直接 relay(...) 调用点共 3 处', relayArgs.length === 3, '实际 ' + relayArgs.length);
  const wakeSteer = relayArgs.find((a) => /'steer'/.test(a));
  check("dsh_wake_session 调用点显式 'steer'", !!wakeSteer, '未找到');
  const replayTurn = relayArgs.filter((a) => /'turn'/.test(a));
  check("重启结果回放显式 'turn'", replayTurn.length === 1, '实际 ' + replayTurn.length);
  // notifyTargets 内部那次 relay 传的是变量 mode，也算显式。
  check('所有直接 relay 调用点都显式给了边界', relayArgs.every((a) => /'steer'|'turn'|\bmode\b/.test(a)), relayArgs.map((a) => a.replace(/\s+/g, ' ').slice(0, 60)).join(' | '));

  // 冷唤起分支必须把 mode 传下去（曾经就是这里丢的）
  check("冷唤起分支 deliver(a, 'wake', mode) 带 mode", /deliver\(a, 'wake', mode\)/.test(src));
}

console.log('\n' + (fail === 0 ? 'SMOKE-OK' : 'SMOKE-FAIL') + '  pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
