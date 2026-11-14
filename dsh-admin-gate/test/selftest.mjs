/**
 * 自测（bootstrap 版）：不依赖 DSH 运行期，用假 ctx 直接调工具。
 * 场景对应用户/PM 给的 4 步：
 *   1) 空状态 → 任意 agent 任命**自己** → 应成功（bootstrap）
 *   2) pm_who → 能看到自己且标 bootstrap
 *   3) 已是管理员 → 任命另一个会话 → 应成功
 *   4) 撤销自己后再让 agent 任命 → 应被拒（bootstrap 只用一次）
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const home = path.join(os.tmpdir(), `pm-selftest-${Date.now()}`);
process.env.DSH_HOME = home;

const mod = await import('../index.js');

const tools = new Map();
const fakeCtx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
  effect: (fn) => { fn(); },
  get: (svc) => (svc !== 'sessions' ? undefined : {
    get: () => ({ ownEvents: () => [{ type: 'user/message', data: { source: { kind: 'agent-message' } }, time: Date.now() }] }),
  }),
  logger: { info: () => {} },
};

mod.apply(fakeCtx);
const call = (name, args, actor) => tools.get(name).execute(args, { agent: { id: actor }, ctx: fakeCtx });

const A = 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const C = 'session-cccccccc-cccc-cccc-cccc-cccccccccccc';

const out = [];
let r;

r = await call('pm_grant', { sessionId: A, title: 'bootstrap 自授' }, A);
out.push(['1) 空状态 agent 自授', r.ok === true && r.granted === true, r.text]);

r = await call('pm_who', {}, A);
out.push(['2) pm_who 看到自己', r.admins.length === 1, r.text.replace(/\n/g, ' | ')]);

r = await call('pm_grant', { sessionId: B }, A);
out.push(['3) 已是管理员→任命他人', r.ok === true && r.granted === true, r.text]);

r = await call('pm_grant', { sessionId: C }, C);
out.push(['4a) 非管理员 agent 任命他人（应拒）', r.ok === false, r.text]);

r = await call('pm_revoke', { sessionId: A }, A);
out.push(['4b) 管理员撤销自己', r.ok === true, r.text]);

r = await call('pm_grant', { sessionId: C }, C);
out.push(['4c) 撤销后再 agent 自授（应拒）', r.ok === false, r.text]);

const stateFile = path.join(home, 'pm', 'state.json');
const auditFile = path.join(home, 'pm', 'audit.jsonl');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const audit = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

for (const row of out) console.log(row.map((x) => String(x)).join('  '));
console.log('\n=== state.json（片段） ===');
console.log('bootstrapUsed =', state.bootstrapUsed, '| auditSeq =', state.auditSeq);
console.log('admins =', JSON.stringify(state.admins));
console.log('\n=== audit.jsonl（全部 ' + audit.length + ' 条） ===');
for (const a of audit) console.log(JSON.stringify({ seq: a.seq, actor: a.actor, action: a.action, target: a.target, basis: a.basis, result: a.result }));
console.log('\n落盘目录 =', path.join(home, 'pm'));
