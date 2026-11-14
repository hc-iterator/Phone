/**
 * dsh-agent-bus · agent_broadcast 自测
 * ======================================================================
 * 覆盖验收要求：
 *   1. 3 个目标（含 1 个不存在的 id）→ 2 成功 1 失败；
 *   2. bus.jsonl 里 3 条记录带同一个 broadcastGroup；
 *   3. 同一调用者连续第二次调用被限流拒绝；
 * 另外覆盖：8 位短 id 解析、去重、默认排除自己、20 个上限、密钥整次取消、turn 模式。
 *
 * 跑法：node broadcast.test.mjs   （或 node --test broadcast.test.mjs）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 先隔离临时目录，再动态导入：插件在模块加载时就把审计路径定下来了。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-broadcast-'));
process.env.TEMP = TMP;
process.env.TMP = TMP;
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, 'storages'), { recursive: true });
process.env.DSH_HOME = HOME;
const mod = await import('./index.js');

const BUS_LOG = path.join(TMP, 'dsh_agent_bus', 'bus.jsonl');
const WORKSPACE_JSON = path.join(HOME, 'storages', 'workspace.json');

/** 写归档名单（DSH 存在 global.archivedSessionIds）。 */
function setArchived(ids) {
  fs.writeFileSync(WORKSPACE_JSON, JSON.stringify({ global: { archivedSessionIds: ids } }), 'utf8');
}
function clearArchived() {
  try { fs.rmSync(WORKSPACE_JSON, { force: true }); } catch {}
}

function makeSession(id, status = 'idle') {
  return {
    id,
    status,
    steers: [],
    followups: [],
    steer(msg) { this.steers.push(msg); },
    followup(msg) { this.followups.push(msg); },
  };
}

/** 最小 ctx 替身：只提供 deliver / liveIds / 唤醒用到的那点接口。 */
function makeCtx(sessions, extra = {}) {
  const tools = new Map();
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name); } },
    effect: (fn) => { fn(); },
    get: (name) => {
      if (name === 'agents') {
        return {
          list: () => sessions,
          get: (id) => sessions.find((s) => s.id === id),
        };
      }
      return extra[name];
    },
  };
  mod.apply(ctx);
  return { tools, ctx };
}

function auditLines() {
  try {
    return fs.readFileSync(BUS_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

const A = 'session-aaaaaaaa-1111-2222-3333-444444444444';
const B = 'session-bbbbbbbb-1111-2222-3333-444444444444';
const MISSING = 'deadbeef';

test('群发：3 个目标（含 1 个不存在）→ 2 成功 1 失败，审计 3 条同组', async () => {
  const s1 = makeSession(A);
  const s2 = makeSession(B);
  const { tools } = makeCtx([s1, s2]);
  const exec = { agent: { id: 'session-sender-1' } };

  const def = tools.get('agent_broadcast');
  assert.ok(def, 'agent_broadcast 应已注册');
  const r = await def.execute({ targets: [A, B, MISSING], text: '测试群发' }, exec);

  assert.equal(r.succeeded, 2, JSON.stringify(r));
  assert.equal(r.failed, 1);
  assert.equal(s1.steers.length, 1);
  assert.equal(s2.steers.length, 1);
  assert.equal(s1.steers[0].role, 'user');
  assert.equal(s1.steers[0].source.kind, 'agent-message');
  assert.match(s1.steers[0].content[0].text, /【Agent 消息·notice】from session-sender-1/);
  assert.match(s1.steers[0].content[0].text, /测试群发/);

  const group = auditLines().filter((l) => l.broadcastGroup === r.group);
  assert.equal(group.length, 3, '每个目标一行审计');
  assert.equal(group.filter((l) => l.ok).length, 2);
  assert.equal(group.filter((l) => !l.ok).length, 1);
  assert.ok(group.every((l) => l.ev === 'send' && l.kind === 'notice'));
  assert.ok(group.some((l) => l.to === MISSING && !l.ok));
});

test('群发：同一调用者 30 秒内第二次被限流', async () => {
  const s1 = makeSession(A);
  const { tools } = makeCtx([s1]);
  const def = tools.get('agent_broadcast');
  const exec = { agent: { id: 'session-sender-2' } };

  const first = await def.execute({ targets: [A], text: '第一次' }, exec);
  assert.equal(first.succeeded, 1);

  const second = await def.execute({ targets: [A], text: '第二次' }, exec);
  assert.equal(second.ok, false);
  assert.match(second.text, /群发过于频繁/);
  assert.equal(s1.steers.length, 1, '第二次不应投递');
});

test('群发：8 位短 id 唯一命中；有歧义就报错', async () => {
  const s1 = makeSession('session-abcdef12-1111-2222-3333-444444444401');
  const s2 = makeSession('session-abcdef12-1111-2222-3333-444444444402');
  const s3 = makeSession('session-9f9f9f9f-1111-2222-3333-444444444403');
  const { tools } = makeCtx([s1, s2, s3]);
  const def = tools.get('agent_broadcast');

  const r1 = await def.execute({ targets: ['9f9f9f9f'], text: '短 id' }, { agent: { id: 'sender-3a' } });
  assert.equal(r1.succeeded, 1, JSON.stringify(r1));
  assert.equal(s3.steers.length, 1);

  const r2 = await def.execute({ targets: ['abcdef12'], text: '有歧义' }, { agent: { id: 'sender-3b' } });
  assert.equal(r2.ok, false);
  assert.match(r2.text, /命中 2 个会话/);
  assert.equal(s1.steers.length + s2.steers.length, 0);
});

test('群发：默认排除自己；includeSelf=true 才发给自己', async () => {
  const me = makeSession(A);
  const { tools } = makeCtx([me]);
  const def = tools.get('agent_broadcast');

  const r1 = await def.execute({ targets: [A], text: '不给自己' }, { agent: { id: A } });
  assert.equal(r1.ok, false);
  assert.equal(me.steers.length, 0);

  const r2 = await def.execute({ targets: [A], text: '发给自己', includeSelf: true }, { agent: { id: 'sender-4' } });
  assert.equal(r2.succeeded, 1);
});

test('群发：超过 20 个目标整次拒绝', async () => {
  const sessions = Array.from({ length: 21 }, (_, i) => makeSession(`session-000000${String(i).padStart(2, '0')}-1111-2222-3333-444444444444`));
  const { tools } = makeCtx(sessions);
  const def = tools.get('agent_broadcast');
  const r = await def.execute({ targets: sessions.map((s) => s.id), text: '太多' }, { agent: { id: 'sender-5' } });
  assert.equal(r.ok, false);
  assert.match(r.text, /一次最多 20 个目标/);
  assert.equal(sessions.reduce((n, s) => n + s.steers.length, 0), 0);
});

test('群发：正文含密钥 → 整次取消，一条都不发', async () => {
  const s1 = makeSession(A);
  const s2 = makeSession(B);
  const { tools } = makeCtx([s1, s2]);
  const def = tools.get('agent_broadcast');
  const r = await def.execute({ targets: [A, B], text: '用 sk-abcdefghijklmnopqrstuvwx 登录' }, { agent: { id: 'sender-6' } });
  assert.equal(r.ok, false);
  assert.match(r.text, /疑似含密钥/);
  assert.equal(s1.steers.length + s2.steers.length, 0);
});

test('群发：mode=turn 走 followup；"running" 只发给有回合在跑的', async () => {
  const running = makeSession(A, 'running');
  const idle = makeSession(B, 'idle');
  const { tools } = makeCtx([running, idle]);
  const def = tools.get('agent_broadcast');

  const r = await def.execute({ targets: 'running', text: '只发跑着的', mode: 'turn' }, { agent: { id: 'sender-7' } });
  assert.equal(r.succeeded, 1, JSON.stringify(r));
  assert.equal(running.followups.length, 1);
  assert.equal(running.steers.length, 0);
  assert.equal(idle.steers.length + idle.followups.length, 0);
});

// ── 2026-11-12 用户实测的三个 bug ──────────────────────────────────────

test('群发：数组被序列化成 JSON 字符串也能用', async () => {
  const s1 = makeSession(A);
  const s2 = makeSession(B);
  const { tools } = makeCtx([s1, s2]);
  const def = tools.get('agent_broadcast');

  const r = await def.execute({ targets: JSON.stringify([A, B]), text: '字符串数组' }, { agent: { id: 'sender-8' } });
  assert.equal(r.succeeded, 2, JSON.stringify(r));
  assert.equal(s1.steers.length, 1);
  assert.equal(s2.steers.length, 1);
});

test('群发：目标没加载 → 先唤醒再投递，并标成"唤醒后成功"', async () => {
  const TARGET = 'session-dddddddd-1111-2222-3333-444444444444';
  const woken = [];
  const sc = {
    resolveAgent: async (id) => ({ agent: { steer: (m) => woken.push({ id, text: m.content[0].text }) } }),
  };
  const { tools } = makeCtx([], { sessionController: sc });
  const def = tools.get('agent_broadcast');

  const r = await def.execute({ targets: [TARGET], text: '唤醒测试' }, { agent: { id: 'sender-9' } });
  assert.equal(r.succeeded, 1, JSON.stringify(r));
  assert.equal(r.wokeSucceeded, 1, JSON.stringify(r));
  assert.equal(woken.length, 1);
  assert.equal(woken[0].id, TARGET);
  assert.match(woken[0].text, /唤醒测试/);
  assert.match(r.text, /唤醒后投递/);
  assert.equal(r.results[0].via, 'wake');
});

test('群发：唤醒失败要记成失败（不是漏掉）', async () => {
  const TARGET = 'session-eeeeeeee-1111-2222-3333-444444444444';
  const sc = { resolveAgent: async () => ({ error: { code: 'session/not-found' } }) };
  const { tools } = makeCtx([], { sessionController: sc });
  const def = tools.get('agent_broadcast');

  const r = await def.execute({ targets: [TARGET], text: '醒不来' }, { agent: { id: 'sender-10' } });
  assert.equal(r.succeeded, 0);
  assert.equal(r.failed, 1);
  assert.match(r.results[0].error, /唤醒失败/);
});

test('群发：归档会话跳过，结果里标 skipped: archived', async () => {
  setArchived([A]);
  try {
    const s1 = makeSession(A);
    const s2 = makeSession(B);
    const { tools } = makeCtx([s1, s2]);
    const def = tools.get('agent_broadcast');

    const r = await def.execute({ targets: [A, B], text: '归档跳过' }, { agent: { id: 'sender-11' } });
    assert.equal(r.succeeded, 1, JSON.stringify(r));
    assert.equal(r.skippedArchived, 1);
    assert.equal(r.results[0].skipped, 'archived');
    assert.equal(s1.steers.length, 0);
    assert.equal(s2.steers.length, 1);
    assert.match(r.text, /已归档，跳过/);
  } finally {
    clearArchived();
  }
});

test('群发："all" 不把已归档会话算进去', async () => {
  setArchived([B]);
  try {
    const s1 = makeSession(A);
    const s2 = makeSession(B);
    const { tools } = makeCtx([s1, s2]);
    const def = tools.get('agent_broadcast');

    const r = await def.execute({ targets: 'all', text: '全员但不含归档' }, { agent: { id: 'sender-12' } });
    assert.equal(r.succeeded, 1, JSON.stringify(r));
    assert.equal(r.skippedArchived, 1);
    assert.equal(s1.steers.length, 1);
    assert.equal(s2.steers.length, 0);
    assert.deepEqual(r.results.map((x) => x.target), [A]);
  } finally {
    clearArchived();
  }
});
