import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, recordVote, tick, canCommit, pendingTargets } from './index.js';

const T0 = Date.parse('2026-10-31T04:00:00.000Z');

function fresh(targets = ['session-a', 'session-b']) {
  return newState({ id: 'r1', requester: 'session-me', note: '测试', targets, now: T0 });
}

test('newState 去掉重复与发起者自身', () => {
  const s = newState({ id: 'r', requester: 'me', targets: ['me', 'a', 'a', 'b'], now: T0 });
  assert.deepEqual(s.targets, ['a', 'b']);
  assert.equal(s.phase, 'collecting');
  assert.equal(s.token, null);
});

test('recordVote 只认被通知者，且拒绝必须写理由', () => {
  const s = fresh();
  assert.equal(recordVote(s, 'session-x', 'allow').error, '你不是本次被通知的对象');
  assert.equal(recordVote(s, 'session-a', 'deny').error, '拒绝必须附上理由');
  assert.equal(recordVote(s, 'session-a', 'deny', '  ').error, '拒绝必须附上理由');
});

test('一票同意后仍未批准；全部同意才批准并给 token', () => {
  let s = fresh();
  const r1 = recordVote(s, 'session-a', 'allow', undefined, T0 + 1000);
  assert.equal(r1.transition, null);
  assert.equal(r1.state.phase, 'collecting');
  assert.deepEqual(pendingTargets(r1.state), ['session-b']);

  const r2 = recordVote(r1.state, 'session-b', 'allow', undefined, T0 + 2000);
  assert.equal(r2.transition, 'approved');
  assert.equal(r2.state.phase, 'approved');
  assert.ok(r2.state.token && r2.state.token.length > 10);
});

test('任一拒绝立即 denied，并保留理由', () => {
  const r = recordVote(fresh(), 'session-b', 'deny', '正在跑 40 分钟构建', T0 + 1000);
  assert.equal(r.transition, 'denied');
  assert.equal(r.state.phase, 'denied');
  assert.equal(r.state.votes['session-b'].reason, '正在跑 40 分钟构建');
});

test('重复投票被拒', () => {
  const r1 = recordVote(fresh(), 'session-a', 'allow');
  assert.equal(recordVote(r1.state, 'session-a', 'allow').error, '你已经表决过了');
});

test('tick：5 分钟催一次，10 分钟作废', () => {
  const s = fresh();
  assert.equal(tick(s, T0 + 60_000).nudge, false);

  const at5 = tick(s, T0 + 5 * 60_000);
  assert.equal(at5.nudge, true);
  assert.equal(at5.state.phase, 'collecting');
  assert.equal(at5.state.nudged, true);

  // 已经催过就不再催
  assert.equal(tick(at5.state, T0 + 6 * 60_000).nudge, false);

  const at10 = tick(s, T0 + 10 * 60_000);
  assert.equal(at10.state.phase, 'expired');
});

test('canCommit：状态、token、一次性', () => {
  const s = fresh();
  assert.equal(canCommit(null, 'x').ok, false);
  assert.equal(canCommit(s, 'x').ok, false);            // 还在 collecting

  const approved = recordVote(recordVote(s, 'session-a', 'allow').state, 'session-b', 'allow').state;
  assert.equal(canCommit(approved, 'wrong').ok, false);
  assert.equal(canCommit(approved, approved.token).ok, true);

  const used = { ...approved, tokenUsed: true };
  assert.equal(canCommit(used, approved.token).ok, false);
});

test('批准的 token 超过 10 分钟失效', () => {
  const s = fresh();
  const approved = recordVote(recordVote(s, 'session-a', 'allow', undefined, T0).state, 'session-b', 'allow', undefined, T0).state;
  assert.equal(canCommit(approved, approved.token, T0 + 60_000).ok, true);
  assert.equal(canCommit(approved, approved.token, T0 + 11 * 60_000).ok, false);
});
