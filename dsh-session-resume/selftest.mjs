/**
 * dsh-session-resume 自测（不依赖 DSH 运行时）
 * ======================================================================
 * 覆盖：
 *   1. collectRunning 只挑 status==='running'；
 *   2. 会话标题能从多帧 zstd 日志里解出来；
 *   3. saveSnapshot 写 state.json（id + title + 时间）；
 *   4. restore 走 resolveAgent 冷唤起 → steer 投递【自动恢复】，成功后清空 state；
 *   5. 唤醒失败时条目保留在 state.json 并写日志；
 *   6. 真实 SIGTERM：子进程收到信号后 state.json 落盘；
 *   7. apply() 的延迟恢复定时器（延迟压到 0）能跑通。
 *
 * 跑法：node selftest.mjs
 */

import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = pathToFileURL(path.join(HERE, 'index.js')).href;

// 独立临时 DSH_HOME / TEMP，别污染真的
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-selftest-'));
const HOME = path.join(ROOT, 'home');
const TMP = path.join(ROOT, 'tmp');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
process.env.DSH_HOME = HOME;
process.env.TEMP = TMP;
process.env.TMP = TMP;
process.env.DSH_SESSION_RESUME_DELAY_MS = '0';

const mod = await import(INDEX);
const STATE = path.join(HOME, 'resume', 'state.json');
const LOG = path.join(TMP, 'dsh_session_resume', 'log.txt');

let passed = 0;
function ok(label, cond, extra = '') {
  assert.ok(cond, label + (extra ? ` :: ${extra}` : ''));
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ── 1. collectRunning ──────────────────────────────────────────────────
console.log('[1] collectRunning 只保留 running');
{
  const list = [
    { id: 'session-a', status: 'running' },
    { id: 'session-b', status: 'idle' },
    { id: 'session-c', status: 'running', session: { id: 'session-c' } },
  ];
  const r = mod.collectRunning(list);
  ok('只挑出 2 条 running', r.length === 2, JSON.stringify(r.map((x) => x.id)));
  ok('id 正确', r[0].id === 'session-a' && r[1].id === 'session-c');
  ok('带时间戳', typeof r[0].at === 'string' && !Number.isNaN(Date.parse(r[0].at)));
  ok('空输入返回空数组', mod.collectRunning(null).length === 0);
}

// ── 2. 标题解析（多帧 zstd） ─────────────────────────────────────────────
console.log('[2] 从会话日志尾部解析标题');
const SESSION_A = 'session-11111111-1111-1111-1111-111111111111';
const SESSION_BAD = 'session-22222222-2222-2222-2222-222222222222';
function writeSessionLog(sessionId, title) {
  const dir = path.join(HOME, 'sessions', 'ws-demo', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const frames = [
    JSON.stringify({ type: 'session/created', data: { id: sessionId } }) + '\n',
    JSON.stringify({ type: 'session/title', data: { title } }) + '\n',
    JSON.stringify({ type: 'user/message', data: { text: 'hi' } }) + '\n',
  ];
  // 分别压成独立帧再拼起来——正是追加写入的磁盘形态
  const buf = Buffer.concat(frames.map((f) => zstdCompressSync(Buffer.from(f, 'utf8'))));
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), buf);
}
writeSessionLog(SESSION_A, 'Worker 演示会话');
{
  const file = mod.findSessionFile(SESSION_A);
  ok('能定位会话文件', !!file, String(file));
  ok('标题解析正确', mod.sessionTitle(SESSION_A) === 'Worker 演示会话', String(mod.sessionTitle(SESSION_A)));
  ok('找不到的会话返回 null', mod.sessionTitle('session-deadbeef') === null);
}

// ── 2b. 投影缓存优先 ───────────────────────────────────────────────────
console.log('[2b] 投影缓存里的标题优先（带 / 不带 session- 前缀都试）');
{
  const SESSION_CACHE = 'session-77777777-7777-7777-7777-777777777777';
  const bare = SESSION_CACHE.replace(/^session-/, '');
  const dir = path.join(HOME, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${bare}.json`), JSON.stringify({
    version: 7, record: { rows: { title: { ver: 1, seq: 3, val: '缓存里的标题' } } },
  }), 'utf8');
  ok('从不带前缀的缓存文件读到标题', mod.sessionTitle(SESSION_CACHE) === '缓存里的标题',
    String(mod.sessionTitle(SESSION_CACHE)));
  ok('没有缓存也没有日志时返回 null', mod.sessionTitle('session-88888888-8888-8888-8888-888888888888') === null);
}

// ── 3. saveSnapshot ────────────────────────────────────────────────────
console.log('[3] saveSnapshot 写 state.json');
{
  const r = mod.saveSnapshot([
    { id: SESSION_A, status: 'running' },
    { id: 'session-33333333-3333-3333-3333-333333333333', status: 'idle' },
  ], 'selftest');
  ok('写出 1 条', r.written && r.count === 1, JSON.stringify(r));
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  ok('文件里有 savedAt', typeof st.savedAt === 'string' && !Number.isNaN(Date.parse(st.savedAt)));
  ok('条目含 id/title/时间', st.sessions.length === 1 && st.sessions[0].id === SESSION_A
    && st.sessions[0].title === 'Worker 演示会话' && typeof st.sessions[0].at === 'string');
  ok('reason 记录', st.reason === 'selftest');
}

// ── 4. restore 成功路径 ─────────────────────────────────────────────────
console.log('[4] restore：冷唤起 + steer，成功后清空 state');
{
  const sent = [];
  const liveAgent = { status: 'idle', steer: (m) => sent.push(m) };
  const env = {
    agents: undefined,
    sessionController: {
      resolveAgent: async (id) => {
        assert.equal(id, SESSION_A);
        return { agent: liveAgent };
      },
    },
  };
  const r = await mod.restore(env);
  ok('attempted=1 ok=1 failed=0', r.attempted === 1 && r.ok === 1 && r.failed === 0, JSON.stringify(r));
  ok('state.json 已清空', !fs.existsSync(STATE));
  ok('收到 1 条消息', sent.length === 1);
  const msg = sent[0];
  ok('正文是用户指定措辞', msg.content[0].text === mod.RESTORE_TEXT, msg.content[0].text);
  ok('role=user（会话校验器要求）', msg.role === 'user');
  ok('来源标成 Agent 消息', msg.source && msg.source.kind === 'agent-message');
}

// ── 5. restore 失败路径 ────────────────────────────────────────────────
console.log('[5] restore：唤醒失败要保留条目并写日志');
{
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({
    savedAt: new Date().toISOString(),
    sessions: [{ id: SESSION_BAD, title: null, at: new Date().toISOString() }],
  }), 'utf8');
  const env = {
    agents: undefined,
    sessionController: { resolveAgent: async () => { throw new Error('会话文件不存在'); } },
  };
  const r = await mod.restore(env);
  ok('记为失败', r.failed === 1 && r.ok === 0 && r.cleared === false, JSON.stringify(r));
  ok('state.json 仍存在', fs.existsSync(STATE));
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  ok('失败条目被保留', st.sessions.length === 1 && st.sessions[0].id === SESSION_BAD);
  ok('保留里有错误原因', /会话文件不存在/.test(st.sessions[0].lastError || ''));
  const logText = fs.readFileSync(LOG, 'utf8');
  ok('日志里有失败记录', /恢复失败：session-2222/.test(logText));
}

// ── 5b. resolveAgent 不抛错、返回 { error } 的情况 ───────────────────────
console.log('[5b] restore：resolveAgent 返回 { error } 时也要算失败');
{
  const env = {
    agents: undefined,
    sessionController: { resolveAgent: async () => ({ error: { code: 'session/not-found' } }) },
  };
  const r = await mod.restore(env);
  ok('记为失败且不清空', r.failed === 1 && r.cleared === false, JSON.stringify(r));
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  ok('错误原因带上会话域错误', /session\/not-found/.test(st.sessions[0].lastError || ''),
    String(st.sessions[0].lastError));
}

// ── 6. 退出钩子（Windows 上 process.kill 是硬杀，这里用 process.emit 驱动监听器） ──
console.log('[6] SIGTERM 监听器：退出钩子落盘');
{
  fs.rmSync(STATE, { force: true });
  const code = `
    process.env.DSH_HOME = ${JSON.stringify(HOME)};
    process.env.TEMP = ${JSON.stringify(TMP)};
    const mod = await import(${JSON.stringify(INDEX)});
    const agents = { list: () => [{ id: 'session-44444444-4444-4444-4444-444444444444', status: 'running' },
                                 { id: 'session-55555555-5555-5555-5555-555555555555', status: 'idle' }] };
    mod.installHooks({ get: (k) => (k === 'agents' ? agents : undefined), effect: () => {} });
    // Windows 的 process.kill(pid,'SIGTERM') 会直接 TerminateProcess（JS 监听器不会跑），
    // 所以这里用 process.emit 模拟控制台信号到达 Node 之后的路径。
    process.emit('SIGTERM');
    setTimeout(() => {}, 5000);
  `;
  // 注意：本沙箱里 spawnSync 用 stdio:'pipe' 会 EPERM（命名管道被拒），
  // 所以子进程输出一律走文件，stdio 用 'ignore'。
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', timeout: 15000 });
  ok('监听器里 process.exit(143)', r.status === 143, `status=${r.status} error=${r.error ? r.error.message : ''}`);
  ok('SIGTERM 后 state.json 存在', fs.existsSync(STATE), fs.existsSync(STATE) ? '' : ' 不存在');
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  ok('只记 running 的 1 条', st.sessions.length === 1 && st.sessions[0].id.startsWith('session-4444'));
  ok('reason=signal:SIGTERM', st.reason === 'signal:SIGTERM', String(st.reason));
}

// ── 6b. beforeExit ─────────────────────────────────────────────────────
console.log('[6b] beforeExit：正常退出时也落盘');
{
  fs.rmSync(STATE, { force: true });
  const code = `
    process.env.DSH_HOME = ${JSON.stringify(HOME)};
    process.env.TEMP = ${JSON.stringify(TMP)};
    const mod = await import(${JSON.stringify(INDEX)});
    const agents = { list: () => [{ id: 'session-66666666-6666-6666-6666-666666666666', status: 'running' }] };
    mod.installHooks({ get: (k) => (k === 'agents' ? agents : undefined), effect: () => {} });
    // 不排任何定时器：事件循环自然清空 ⇒ beforeExit
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', timeout: 15000 });
  ok('beforeExit 子进程正常退出', r.status === 0, `status=${r.status}`);
  ok('beforeExit 后 state.json 存在', fs.existsSync(STATE));
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  ok('reason=beforeExit', st.reason === 'beforeExit', String(st.reason));
  ok('记下 running 会话', st.sessions.length === 1 && st.sessions[0].id.startsWith('session-6666'));
}

// ── 7. apply() 的延迟恢复 ──────────────────────────────────────────────
console.log('[7] apply()：延迟定时器读完 state 后唤醒并清空');
{
  fs.rmSync(STATE, { force: true });
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({
    savedAt: new Date().toISOString(),
    sessions: [{ id: SESSION_A, title: 'Worker 演示会话', at: new Date().toISOString() }],
  }), 'utf8');
  const OUT = path.join(TMP, 'apply-result.json');
  const code = `
    process.env.DSH_HOME = ${JSON.stringify(HOME)};
    process.env.TEMP = ${JSON.stringify(TMP)};
    process.env.DSH_SESSION_RESUME_DELAY_MS = '0';
    const mod = await import(${JSON.stringify(INDEX)});
    const nodeFs = await import('node:fs');
    const seen = [];
    const sc = { resolveAgent: async () => ({ agent: { steer: (m) => seen.push(m.content[0].text) } }) };
    const ctx = {
      get: (k) => (k === 'sessionController' ? sc : undefined),
      effect: (fn) => fn(),
    };
    mod.apply(ctx);
    setTimeout(() => {
      nodeFs.writeFileSync(${JSON.stringify(OUT)},
        JSON.stringify({ seen, stateGone: !nodeFs.existsSync(${JSON.stringify(STATE)}) }));
      process.exit(0);
    }, 600);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore', timeout: 15000 });
  ok('apply 子进程正常退出', r.status === 0, `status=${r.status} error=${r.error ? r.error.message : ''}`);
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  ok('apply 后唤醒到 1 条', Array.isArray(parsed.seen) && parsed.seen.length === 1, JSON.stringify(parsed));
  ok('唤醒正文正确', parsed.seen && parsed.seen[0] === mod.RESTORE_TEXT);
  ok('apply 后 state.json 清空', parsed.stateGone === true);
}

// ── 8. 心跳：有 running 就写；内容没变不写 ─────────────────────────────
console.log('[8] 心跳：有 running 写一次，内容不变不重复写');
{
  fs.rmSync(STATE, { force: true });
  const agents = [{ id: SESSION_A, status: 'running' }];
  const before = Date.now();
  const r1 = mod.heartbeatTick(agents, new Date(before));
  ok('首次心跳写入', r1.written === true && r1.count === 1, JSON.stringify(r1));
  const st1 = fs.statSync(STATE);
  const body1 = fs.readFileSync(STATE, 'utf8');
  const r2 = mod.heartbeatTick(agents, new Date(before + 30_000));
  ok('第二次心跳判为未变', r2.written === false && r2.reason === 'unchanged', JSON.stringify(r2));
  const st2 = fs.statSync(STATE);
  ok('文件没被重写', st1.mtimeMs === st2.mtimeMs && body1 === fs.readFileSync(STATE, 'utf8'));
  const state = JSON.parse(body1);
  ok('快照带 id / 标题 / 时间 / heartbeat 原因',
    state.sessions[0].id === SESSION_A && state.sessions[0].title === 'Worker 演示会话'
    && typeof state.sessions[0].at === 'string' && state.reason === 'heartbeat');
}

// ── 9. 没有 running 不写 ───────────────────────────────────────────────
console.log('[9] 心跳：没有 running 会话时不写；旧快照要清掉');
{
  fs.rmSync(STATE, { force: true });
  const r = mod.heartbeatTick([{ id: SESSION_A, status: 'idle' }]);
  ok('无 running 时不产生文件', r.reason === 'idle' && !fs.existsSync(STATE), JSON.stringify(r));

  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({
    savedAt: new Date().toISOString(), reason: 'heartbeat',
    sessions: [{ id: SESSION_A, at: new Date().toISOString() }],
  }), 'utf8');
  const r2 = mod.heartbeatTick([]);
  ok('心跳写的旧快照被清掉（避免误唤醒）', r2.reason === 'idle' && !fs.existsSync(STATE));

  // 非心跳写的（退出钩子 / 恢复失败保留的条目）不能被心跳误删
  fs.writeFileSync(STATE, JSON.stringify({
    savedAt: new Date().toISOString(), reason: 'signal:SIGTERM',
    sessions: [{ id: SESSION_A, at: new Date().toISOString() }],
  }), 'utf8');
  const r3 = mod.heartbeatTick([]);
  ok('非心跳快照被保留', r3.reason === 'idle' && fs.existsSync(STATE));
}

// ── 10. 启动清理：超过 6 小时的条目丢弃 ────────────────────────────────
console.log('[10] 启动清理：超过 6 小时的条目丢弃');
{
  const oldAt = new Date(Date.now() - 7 * 3600_000).toISOString();
  const freshAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({
    savedAt: oldAt,
    sessions: [
      { id: SESSION_A, at: oldAt, title: '太旧' },
      { id: SESSION_BAD, at: freshAt, title: '还新' },
    ],
  }), 'utf8');
  const r = mod.cleanExpiredState();
  ok('丢掉 1 条留 1 条', r.changed === true && r.kept === 1, JSON.stringify(r));
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  ok('留下的是新条目', st.sessions.length === 1 && st.sessions[0].id === SESSION_BAD);

  fs.writeFileSync(STATE, JSON.stringify({ savedAt: oldAt, sessions: [{ id: SESSION_A, at: oldAt }] }), 'utf8');
  const r2 = mod.cleanExpiredState();
  ok('全部过期就删文件', r2.changed === true && r2.kept === 0 && !fs.existsSync(STATE));
}

// ── 11. 端到端：心跳写盘 → 进程被硬杀 → 新进程启动自动恢复 ─────────────
console.log('[11] 端到端：心跳写盘 → 硬杀（process.exit，不走 beforeExit）→ 新进程恢复');
{
  fs.rmSync(STATE, { force: true });
  // 第一段：只有心跳，没有退出钩子，最后 process.exit(0) 模拟硬杀
  const hardKill = `
    process.env.DSH_HOME = ${JSON.stringify(HOME)};
    process.env.TEMP = ${JSON.stringify(TMP)};
    const mod = await import(${JSON.stringify(INDEX)});
    const agents = [{ id: ${JSON.stringify(SESSION_A)}, status: 'running' }];
    mod.heartbeatTick(agents);
    process.exit(0);
  `;
  const k = spawnSync(process.execPath, ['--input-type=module', '-e', hardKill], { stdio: 'ignore', timeout: 15000 });
  ok('硬杀段退出码 0', k.status === 0, `status=${k.status}`);
  ok('硬杀后 state.json 留在盘上', fs.existsSync(STATE));
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  ok('快照里是 running 的会话', st.sessions.length === 1 && st.sessions[0].id === SESSION_A && st.reason === 'heartbeat');

  // 第二段：新进程启动，延迟 0 秒恢复
  const OUT2 = path.join(TMP, 'e2e-restore.json');
  const restart = `
    process.env.DSH_HOME = ${JSON.stringify(HOME)};
    process.env.TEMP = ${JSON.stringify(TMP)};
    process.env.DSH_SESSION_RESUME_DELAY_MS = '0';
    const mod = await import(${JSON.stringify(INDEX)});
    const nodeFs = await import('node:fs');
    const seen = [];
    const sc = { resolveAgent: async () => ({ agent: { steer: (m) => seen.push(m.content[0].text) } }) };
    const ctx = { get: (k) => (k === 'sessionController' ? sc : undefined), effect: (fn) => fn() };
    mod.apply(ctx);
    setTimeout(() => {
      nodeFs.writeFileSync(${JSON.stringify(OUT2)},
        JSON.stringify({ seen, stateGone: !nodeFs.existsSync(${JSON.stringify(STATE)}) }));
      process.exit(0);
    }, 600);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', restart], { stdio: 'ignore', timeout: 15000 });
  ok('重启段退出码 0', r.status === 0, `status=${r.status}`);
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(OUT2, 'utf8')); } catch {}
  ok('重启后自动恢复 1 条', Array.isArray(parsed.seen) && parsed.seen.length === 1, JSON.stringify(parsed));
  ok('恢复正文是【自动恢复】', parsed.seen && parsed.seen[0] === mod.RESTORE_TEXT);
  ok('恢复后 state.json 清空', parsed.stateGone === true);
}

console.log(`\n全部通过：${passed} 项`);
fs.rmSync(ROOT, { recursive: true, force: true });
