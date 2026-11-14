/**
 * dsh-auto-compact 冒烟测试（v0.2）—— 不需要 DSH、不需要模型、不联网。
 *
 * 用假的 ctx / agent / 会话日志 / compaction 把真实分支跑一遍：
 *   ① idle + 最后一条 turn/end 正常完成 → 调一次 compactNow，日志写 "compacted ok"
 *   ② 同会话立刻再来一次 → "skip: too soon"（10 分钟节流）
 *   ③ 最后一条 turn/end 是 aborted → 不压
 *   ④ 最后一条 turn/end 是 max-tokens → 不压
 *   ⑤ 新一轮 turn/start 比 turn/end 晚（还没结束）→ 不压
 *   ⑥ 日志里从来没有 turn/end → 不压
 *   ⑦ compactNow 抛错 → 只写 warn，不抛、不重试
 *   ⑧ compactNow 返回 null → "compacted ok: nothing useful"
 *   ⑨ enabled:false → 完全静默
 *   ⑩ 子会话默认不压
 *   ⑪ dispose → 解绑，迟到的事件不再触发
 *
 * 跑法：node smoke-test.mjs
 */

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from './index.js';

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let failures = 0;
let logSeq = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}`);
  }
}

const END = (kind) => ({ type: 'turn/end', data: { turn: 1, reason: { kind } } });
const START = () => ({ type: 'turn/start', data: { turn: 1 } });

/** 造一个够用的假世界。events 是"该会话已有的日志事件"。 */
function makeWorld({ events = [START(), END('completed')], origin, compactNow, config } = {}) {
  const logs = [];
  const listeners = new Map();
  const disposers = [];
  const logFile = join(tmpdir(), `dsh-auto-compact.test-${process.pid}-${logSeq++}.log`);
  const ledgerFile = join(tmpdir(), `dsh-auto-compact.ledger-${process.pid}-${logSeq++}.jsonl`);

  const services = {
    compaction: {
      compactNow: compactNow ?? (async () => ({ shadowedSeqs: [1, 2], shadowedTokenCount: 1234 })),
    },
  };

  const session = {
    id: 'session-abc',
    meta: origin === undefined ? { cwd: 'C:\\x' } : { cwd: 'C:\\x', origin },
    snapshotEvents: () => events,
  };

  const ctx = {
    logger: {
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
    },
    get: (name) => services[name],
    on: (name, listener) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    effect: (callback) => {
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
  };

  // compaction 挂在 agent 作用域（preset 的 isolate 分组），根 ctx 看不到。
  const agent = {
    id: 'session-abc',
    status: 'idle',
    session,
    ctx: { get: (name) => (name === 'compaction' ? services.compaction : undefined) },
  };

  return {
    ctx,
    agent,
    logs,
    listeners,
    disposers,
    logFile,
    /** 启动插件：统一把 settleDelayMs 设 0，测试不用等。 */
    start(extra = {}) {
      apply(ctx, { logFile, ledgerFile, settleDelayMs: 0, ...config, ...extra });
      return this;
    },
    emit(status = 'idle') {
      const listener = listeners.get('agent/status');
      if (typeof listener !== 'function') throw new Error('agent/status 没有注册监听器');
      listener({ agent, status });
    },
    /** 读日志文件里的所有行（插件唯一的真日志出口）。 */
    fileLines() {
      try {
        return readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    /** 读项目侧台账（每次真压一行 JSONL）。 */
    ledgerLines() {
      try {
        return readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    cleanup() {
      for (const dispose of disposers) dispose();
      try { rmSync(logFile, { force: true }); } catch { /* 忽略 */ }
      try { rmSync(ledgerFile, { force: true }); } catch { /* 忽略 */ }
    },
  };
}

console.log('[1] idle + turn/end 正常完成 → 压一次');
{
  const calls = [];
  const world = makeWorld({
    compactNow: async (agent, signal) => { calls.push({ agent, signal }); return { shadowedSeqs: [3], shadowedTokenCount: 900 }; },
  }).start();
  world.emit();
  await wait(30);
  check('compactNow 被调用 1 次', calls.length === 1);
  check('拿到的 agent 就是会话的 agent', calls[0]?.agent === world.agent);
  check('第二个参数是 AbortSignal（inspect 核对过的签名）', calls[0]?.signal instanceof AbortSignal);
  check('日志文件里有 compacted ok', world.fileLines().some((l) => l.includes('compacted ok')));
  check('日志里带了压缩段数', world.fileLines().some((l) => l.includes('已压缩') || l.includes('段历史')));
  world.cleanup();
}

console.log('[2] 同一会话立刻再来一次 → skip: too soon');
{
  const calls = [];
  const world = makeWorld({
    compactNow: async () => { calls.push(Date.now()); return { shadowedSeqs: [1], shadowedTokenCount: 10 }; },
  }).start();
  world.emit();
  await wait(30);
  world.emit();   // 模拟下一轮任务又结束了
  await wait(30);
  check('10 分钟内只调用了 1 次', calls.length === 1);
  check('日志里有 skip: too soon', world.fileLines().some((l) => l.includes('skip: too soon')));
  world.cleanup();
}

console.log('[3] 最后一条 turn/end 是 aborted → 不压');
{
  const calls = [];
  const world = makeWorld({
    events: [START(), END('aborted')],
    compactNow: async () => { calls.push(1); },
  }).start();
  world.emit();
  await wait(30);
  check('compactNow 没被调用', calls.length === 0);
  check('日志说明原因（turn not completed）', world.fileLines().some((l) => l.includes('turn not completed')));
  world.cleanup();
}

console.log('[4] 最后一条 turn/end 是 max-tokens → 不压');
{
  const calls = [];
  const world = makeWorld({
    events: [START(), END('max-tokens')],
    compactNow: async () => { calls.push(1); },
  }).start();
  world.emit();
  await wait(30);
  check('token 超限不触发压缩', calls.length === 0);
  world.cleanup();
}

console.log('[5] 新一轮 turn/start 晚于 turn/end（还没结束）→ 不压');
{
  const calls = [];
  const world = makeWorld({
    events: [START(), END('completed'), START()],
    compactNow: async () => { calls.push(1); },
  }).start();
  world.emit();
  await wait(30);
  check('未结束的 turn 不压', calls.length === 0);
  check('日志说明是 open', world.fileLines().some((l) => l.includes('open')));
  world.cleanup();
}

console.log('[6] 日志里从来没有 turn/end → 不压');
{
  const calls = [];
  const world = makeWorld({
    events: [START()],
    compactNow: async () => { calls.push(1); },
  }).start();
  world.emit();
  await wait(30);
  check('没有 turn/end 不压', calls.length === 0);
  world.cleanup();
}

console.log('[7] compactNow 抛错 → 只写 warn，不外抛、不重试');
{
  const calls = [];
  const world = makeWorld({
    compactNow: async () => { calls.push(1); throw new Error('boom: busy'); },
  }).start();
  world.emit();
  await wait(30);
  check('确实尝试了一次', calls.length === 1);
  check('失败写进了日志文件', world.fileLines().some((l) => l.includes('fail:') && l.includes('boom: busy')));
  check('失败也吃满节流（没重试）', calls.length === 1);
  world.cleanup();
}

console.log('[8] compactNow 返回 null → compacted ok: nothing useful');
{
  const world = makeWorld({ compactNow: async () => null }).start();
  world.emit();
  await wait(30);
  check('日志里有 nothing useful', world.fileLines().some((l) => l.includes('compacted ok') && l.includes('nothing useful')));
  world.cleanup();
}

console.log('[9] enabled:false → 完全静默');
{
  const calls = [];
  const world = makeWorld({ compactNow: async () => { calls.push(1); } }).start({ enabled: false });
  world.emit();
  await wait(30);
  check('开关关掉后不压', calls.length === 0);
  check('日志里没有 compacted ok', !world.fileLines().some((l) => l.includes('compacted ok')));
  world.cleanup();
}

console.log('[10] 子会话默认不压');
{
  const calls = [];
  const world = makeWorld({ origin: 'subagent', compactNow: async () => { calls.push(1); } }).start();
  world.emit();
  await wait(30);
  check('子会话没有触发压缩', calls.length === 0);
  world.cleanup();
}

console.log('[11] dispose → 解绑，迟到事件不再触发');
{
  const calls = [];
  const world = makeWorld({ compactNow: async () => { calls.push(1); } }).start();
  check('dispose 之前监听器在', world.listeners.has('agent/status'));
  for (const dispose of world.disposers) dispose();
  check('监听器已解绑', world.listeners.size === 0);
  await wait(30);
  check('dispose 之后不再压缩', calls.length === 0);
  world.cleanup();
}

console.log('[12] 项目侧台账（持久 JSONL）');
{
  const world = makeWorld({ compactNow: async () => ({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4321 }) }).start();
  world.emit();
  await wait(30);
  const lines = world.ledgerLines();
  check('台账写了 1 行', lines.length === 1);
  check('台账记了会话 id', lines[0]?.session === 'session-abc');
  check('台账记了段数', lines[0]?.seqs === 3);
  check('台账记了 token 数', lines[0]?.tokens === 4321);
  check('台账有 ISO 时间戳', typeof lines[0]?.at === 'string' && lines[0].at.includes('T'));
  check('台账标记 outcome=compacted', lines[0]?.outcome === 'compacted');
  world.cleanup();

  const failWorld = makeWorld({ compactNow: async () => { throw new Error('nope'); } }).start();
  failWorld.emit();
  await wait(30);
  check('失败也留一行（outcome=fail）', failWorld.ledgerLines().some((r) => r.outcome === 'fail'));
  failWorld.cleanup();
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n失败 ${failures} 项 ✗`);
process.exitCode = failures === 0 ? 0 : 1;
