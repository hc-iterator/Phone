/** P1 闸门自测（纯函数层，不依赖 DSH 运行期）。 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const home = path.join(os.tmpdir(), `gate-test-${Date.now()}`);
process.env.DSH_HOME = home;

const gate = await import('../lib/gate.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`PASS ${name} ${extra}`); }
  else { fail += 1; console.log(`FAIL ${name} ${extra}`); }
};

const A = 'session-actor';
const APR = gate.DEFAULT_APPROVER;

// 1 发起
let r = gate.request({ actor: A, op: 'shell.destructive', reason: 'test', approver: APR });
ok('1 发起得到 pending', r.ok && r.status === 'pending' && !!r.id, r.id);

// 2 台账有请求行
let lines = fs.readFileSync(gate.LEDGER, 'utf8').trim().split('\n').map(JSON.parse);
ok('2 台账请求行', lines.length === 1 && lines[0].decision === 'pending' && lines[0].actor === A);

// 3 批准
let d = gate.decide({ id: r.id, decision: 'approve', decider: APR, reason: 'ok' });
ok('3 批准', d.ok && d.status === 'approved');

// 4 台账落定行
lines = fs.readFileSync(gate.LEDGER, 'utf8').trim().split('\n').map(JSON.parse);
ok('4 台账落定行', lines.length === 2 && lines[1].decision === 'approved' && lines[1].elapsedMs >= 0);

// 5 token 兑付 + 一次性
let auth = gate.authorizationFor({ agentId: A, op: 'shell.destructive', token: r.id });
ok('5a token 可兑付', auth.ok, JSON.stringify(auth));
gate.consume(r.id);
auth = gate.authorizationFor({ agentId: A, op: 'shell.destructive', token: r.id });
ok('5b 二次兑付被拒', auth.ok === false);

// 6 无 token 时按 agent+op 命中
const r2 = gate.request({ actor: A, op: 'shell.destructive', reason: 'again', approver: APR });
gate.decide({ id: r2.id, decision: 'approve', decider: APR });
const auth2 = gate.authorizationFor({ agentId: A, op: 'shell.destructive', token: '' });
ok('6 agent+op 免 token', auth2.ok === true);

// 7 拒绝
const r3 = gate.request({ actor: A, op: 'dsh.restart', reason: 'x', approver: APR });
const d3 = gate.decide({ id: r3.id, decision: 'deny', decider: APR, reason: 'no' });
ok('7 拒绝', d3.ok && d3.status === 'denied');

// 8 超时
const r4 = gate.request({ actor: A, op: 'shell.destructive', reason: 'slow', approver: APR, timeoutMinutes: 1 });
const swept = gate.sweepExpired(Date.now() + 2 * 60_000);
const st4 = gate.statusOf(r4.id);
ok('8 超时默认拒绝', swept >= 1 && st4.status === 'expired', `swept=${swept}`);

// 9 重复请求去重
const r5 = gate.request({ actor: 'session-x', op: 'shell.destructive', reason: 'a', approver: APR });
const r6 = gate.request({ actor: 'session-x', op: 'shell.destructive', reason: 'b', approver: APR });
ok('9 5 分钟内去重', r6.deduped === true && r6.id === r5.id);

// 10 diff 哈希与截断
const diff = 'x'.repeat(500);
const h1 = gate.hashDiff(diff);
const h2 = gate.hashDiff(diff);
const r7 = gate.request({ actor: 'session-y', op: 'shell.destructive', reason: 'd', diff, approver: APR });
const e7 = gate.statusOf(r7.id);
ok('10 哈希一致且摘要截断', h1 === h2 && h1.startsWith('sha256:') && e7.diffHash === h1 && e7.diffHead.length === 200);

// 11 超时值只准缩短
ok('11 超时钳制', gate.normalizeTimeout(30) === 10 && gate.normalizeTimeout(1) === 1 && gate.normalizeTimeout(0) === 10);

// 12 未知 token 被拒
const bad = gate.authorizationFor({ agentId: A, op: 'shell.destructive', token: 'nope' });
ok('12 未知 token 被拒', bad.ok === false);

console.log(`\n合计 ${pass} 通过 / ${fail} 失败；台账 ${path.join(home, 'gate', 'approvals.jsonl')}`);
process.exit(fail === 0 ? 0 : 1);
