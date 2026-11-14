/**
 * dsh-working-state 自测 —— 不需要 DSH、不需要模型。
 *
 * 全部跑在临时目录（DSH_HOME 指向 %TEMP% 下的空目录），绝不碰真实状态文件。
 * 覆盖 9 组：
 *   ① 默认模式 local（文件不存在）
 *   ② 切换模式并持久化
 *   ③ 角色可见性三分支（管理员 / worker / other）
 *   ④ 非管理员改模式被拒
 *   ⑤ 非管理员打角色被拒
 *   ⑥ 原子写：没有 .tmp 残留、文件始终是合法 JSON
 *   ⑦ 并发写：20 个并发变更一条不丢
 *   ⑧ 非法模式 / 非法角色被拒
 *   ⑨ 状态文件损坏 → 改名留证 + 按默认启动
 *
 * 跑法：node selftest.mjs ；退出码 0 = 全过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 先把家指到临时目录，再 import 插件（模块加载时才读 DSH_HOME）
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-test-'));
process.env.DSH_HOME = HOME;
for (const k of ['DSH_WORKING_STATE_FILE']) delete process.env[k];

const ws = await import('./index.js');

let failures = 0;
let checks = 0;
function check(label, condition) {
  checks += 1;
  if (condition) console.log(`  ✓ ${label}`);
  else { failures += 1; console.log(`  ✗ ${label}`); }
}

const STATE_FILE = path.join(HOME, 'working-state.json');
const PM_FILE = path.join(HOME, 'pm', 'state.json');

function writeAdmins(ids) {
  fs.mkdirSync(path.dirname(PM_FILE), { recursive: true });
  fs.writeFileSync(PM_FILE, JSON.stringify({ admins: ids.map((sessionId) => ({ sessionId })) }, null, 2), 'utf8');
}

/** 假 exec：身份只认 agent.id（与真实工具一致）。 */
function execFor(sessionId, { human = false } = {}) {
  return {
    agent: { id: sessionId },
    ctx: {
      get: (name) => (name === 'sessions'
        ? {
          get: () => ({
            ownEvents: () => (human
              ? [{ type: 'user/message', time: Date.now(), data: { source: { kind: 'user' } } }]
              : [{ type: 'user/message', time: Date.now(), data: { source: { kind: 'model' } } }]),
          }),
        }
        : undefined),
    },
  };
}

const tool = (n) => ws._internals.TOOLS.find((t) => t.name === n);
const ADMIN = 'session-11111111-1111-1111-1111-111111111111';
const WORKER = 'session-22222222-2222-2222-2222-222222222222';
const OTHER = 'session-33333333-3333-3333-3333-333333333333';

console.log('[1] 默认模式');
{
  check('文件不存在时默认 local', ws._internals.readState().mode === 'local');
  const r = await tool('ws_get').execute({}, execFor(OTHER));
  check('ws_get 能读模式', r.ok === true && r.mode === 'local');
  check('ws_get 报出本会话角色（未打角色=other）', r.role === 'other');
}

console.log('[2] 切换模式并持久化');
{
  writeAdmins([ADMIN]);
  const r = await tool('ws_set').execute({ mode: 'away' }, execFor(ADMIN));
  check('管理员改模式成功', r.ok === true && r.mode === 'away');
  check('重新读盘仍是 away', ws._internals.readState().mode === 'away');
  check('记下了是谁设的', ws._internals.readState().modeSetBy?.sessionId === ADMIN);
  const back = await tool('ws_set').execute({ mode: 'local' }, execFor(ADMIN));
  check('能改回来', back.ok === true && ws._internals.readState().mode === 'local');
}

console.log('[3] 角色可见性');
{
  writeAdmins([ADMIN]);
  await tool('ws_tag').execute({ sessionId: WORKER, role: 'worker', public: true }, execFor(ADMIN));
  await tool('ws_tag').execute({ sessionId: OTHER, role: 'other', public: false }, execFor(ADMIN));
  await tool('ws_tag').execute({ sessionId: ADMIN, role: 'manager', public: true }, execFor(ADMIN));

  const state = ws._internals.readState();
  const adminRows = ws._internals.visibleSessions(state, { sessionId: ADMIN, isAdmin: true, role: 'manager' }, []);
  check('管理员看得到全部 3 条', adminRows.length === 3);

  const workerRows = ws._internals.visibleSessions(state, { sessionId: WORKER, isAdmin: false, role: 'worker' }, []);
  check('worker 只看到公开的 + 自己（2 条）', workerRows.length === 2
    && workerRows.some((r) => r.sessionId === WORKER)
    && workerRows.some((r) => r.sessionId === ADMIN)
    && !workerRows.some((r) => r.sessionId === OTHER));

  const otherRows = ws._internals.visibleSessions(state, { sessionId: OTHER, isAdmin: false, role: 'other' }, []);
  check('other 只看得到自己（1 条）', otherRows.length === 1 && otherRows[0].sessionId === OTHER);

  const listWorker = await tool('ws_list').execute({}, execFor(WORKER));
  check('ws_list 给 worker 的 scope 写对了', listWorker.scope.includes('公开'));
}

console.log('[4] 非管理员改模式被拒');
{
  writeAdmins([ADMIN]);
  const r = await tool('ws_set').execute({ mode: 'away' }, execFor(OTHER));
  check('普通 agent 被拒', r.ok === false && r.text.includes('无权限'));
  check('被拒后模式没变', ws._internals.readState().mode !== 'away');
  const human = await tool('ws_set').execute({ mode: 'wechat' }, execFor(OTHER, { human: true }));
  check('用户本人可以改（真人发言在 30 分钟内）', human.ok === true && human.mode === 'wechat');
}

console.log('[5] 非管理员打角色被拒');
{
  writeAdmins([ADMIN]);
  const r = await tool('ws_tag').execute({ sessionId: WORKER, role: 'manager' }, execFor(OTHER, { human: true }));
  check('用户也不能绕过 ws_tag（需求：管理员）', r.ok === false);
  check('记录没被改', ws._internals.readState().sessions[WORKER]?.role !== 'manager');
}

console.log('[6] 原子写');
{
  writeAdmins([ADMIN]);
  await tool('ws_set').execute({ mode: 'away' }, execFor(ADMIN));
  const leftovers = fs.readdirSync(HOME).filter((f) => f.includes('.tmp'));
  check('没有 .tmp 残留', leftovers.length === 0);
  check('文件是合法 JSON', (() => { try { JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return true; } catch { return false; } })());
}

console.log('[7] 并发写');
{
  writeAdmins([ADMIN]);
  const before = Object.keys(ws._internals.readState().sessions).length;
  const ids = Array.from({ length: 20 }, (_, i) => `session-${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`);
  await Promise.all(ids.map((sessionId) => tool('ws_tag').execute({ sessionId, role: 'worker', public: i8(sessionId) }, execFor(ADMIN))));
  const after = ws._internals.readState();
  const landed = ids.filter((id) => after.sessions[id]).length;
  check('20 条并发写入全部落盘', landed === 20);
  check('原有记录没被覆盖', Object.keys(after.sessions).length === before + 20);
  check('模式字段没被并发写带坏', after.mode === 'away');
}
function i8(id) { return Number(id.slice(8, 10)) % 2 === 0; }

console.log('[8] 非法参数');
{
  writeAdmins([ADMIN]);
  const bad = await tool('ws_set').execute({ mode: 'sleeping' }, execFor(ADMIN));
  check('非法模式被拒', bad.ok === false && bad.text.includes('local'));
  const badRole = await tool('ws_tag').execute({ sessionId: WORKER, role: 'boss' }, execFor(ADMIN));
  check('非法角色被拒', badRole.ok === false);
  const badId = await tool('ws_tag').execute({ sessionId: 'not-a-session', role: 'worker' }, execFor(ADMIN));
  check('非法会话 id 被拒', badId.ok === false);
}

console.log('[9] 状态文件损坏');
{
  fs.writeFileSync(STATE_FILE, '{ this is not json', 'utf8');
  const st = ws._internals.readState();
  check('坏文件按默认启动（local）', st.mode === 'local');
  const broken = fs.readdirSync(HOME).filter((f) => f.startsWith('working-state.json.broken-'));
  check('坏文件被改名留证', broken.length === 1);
}

console.log(`\n共 ${checks} 项检查，失败 ${failures} 项`);
console.log(failures === 0 ? 'SELFTEST=PASS' : 'SELFTEST=FAIL');
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = failures === 0 ? 0 : 1;
