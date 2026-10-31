import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets, validateSend, resolveTarget, checkRate, buildAgentMessage } from './index.js';

test('scanSecrets 命中恢复密钥', () => {
  assert.equal(scanSecrets('key 104984-440979-521884-648263-577170-057684-396638-279158'), 'bitlocker-recovery-key');
});

test('scanSecrets 命中 sk- / 私钥 / 密码赋值', () => {
  assert.equal(scanSecrets('use sk-abcdefghijklmnopqrstuvwx'), 'api-key-sk');
  assert.equal(scanSecrets('-----BEGIN RSA PRIVATE KEY-----'), 'private-key-block');
  assert.equal(scanSecrets('password=hunter2'), 'password-assignment');
});

test('scanSecrets 放过普通文本', () => {
  assert.equal(scanSecrets('构建跑到 40% 了，重启会丢进度'), null);
  assert.equal(scanSecrets('session-2b884859-37c4-40c1-ab59-8cefa402559a'), null);
});

test('validateSend 校验 kind / 空正文 / 超长 / hop / 密钥', () => {
  assert.equal(validateSend({ kind: 'chat', body: 'x' }).ok, false);
  assert.equal(validateSend({ kind: 'notice', body: '   ' }).ok, false);
  assert.equal(validateSend({ kind: 'notice', body: 'x'.repeat(501) }).ok, false);
  assert.equal(validateSend({ kind: 'notice', body: 'hi', hop: 3 }).ok, false);
  assert.equal(validateSend({ kind: 'notice', body: 'sk-abcdefghijklmnopqrstuvwx' }).ok, false);
  assert.equal(validateSend({ kind: 'notice', body: 'hi' }).ok, true);
  assert.equal(validateSend({ kind: 'reply', body: 'hi', hop: 2 }).ok, true);
});

test('resolveTarget 只认精确编号，不做模糊匹配', () => {
  const ids = ['session-aaaaaaaa-1111-2222-3333-444444444444', 'session-bbbbbbbb-1111-2222-3333-444444444444'];
  assert.deepEqual(resolveTarget(ids, ids[0]), { ok: true, sessionId: ids[0] });
  assert.deepEqual(resolveTarget(ids, 'aaaaaaaa-1111-2222-3333-444444444444'), { ok: true, sessionId: ids[0] });
  assert.equal(resolveTarget(ids, 'PicoMode').ok, false);
  assert.equal(resolveTarget(ids, 'session-aaaa').ok, false);
  assert.equal(resolveTarget(ids, '').ok, false);
});

test('checkRate 每分钟第 31 条被拒', () => {
  const sender = 'session-rate-test';
  for (let i = 1; i <= 30; i++) assert.equal(checkRate(sender, 1000).ok, true, `第 ${i} 条应放行`);
  assert.equal(checkRate(sender, 1000).ok, false);
  assert.equal(checkRate(sender, 1000 + 61_000).ok, true);
});

test('buildAgentMessage 的来源是 agent-message / relay，不是 user', () => {
  const m = buildAgentMessage('session-sender', 'hi');
  assert.equal(m.source.kind, 'agent-message');
  assert.equal(m.source.form, 'relay');
  assert.equal(m.source.senderSessionId, 'session-sender');
  assert.equal(m.content[0].text, 'hi');
  assert.ok(m.id);
  // 2026-10-31：必须是 user/message 语义（role==='user'），否则目标会话被判 corrupt 打不开；
  //   "是 Agent 消息"这一点由 source.kind 表达，不靠 role。
  assert.equal(m.role, 'user');
});
