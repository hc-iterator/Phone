// 冒烟测试：用一个假 ctx 加载 index.js，只读地走一遍九件套 + /pico 命令（不碰硬件、不烧写）。
// 跑法：node smoke-test.mjs（默认含一次 root 构建；--no-build 只跑只读项，--build 强制跑构建）。
// 测什么：工具注册 / 系统提示注入是否指向 pico-rig 技能 / 路径与白名单围栏 / %TEMP% 读写 / pico_exec 的 PATH 注入 / 构建产物。
// 失败意味着什么：任何一项 ✗ ⇒ 退出码 1（不再"打印 ✗ 却 exit 0"）；SKIP 不是失败，它表示这台机器缺条件。
// 没有开发板会 SKIP：串口读取、console 会话、status --probe；真烧写永远 SKIP（本台架没有 RUN 脚，BOOTSEL 按钮是唯一救援）。
import { apply } from './index.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');   // <workspace> —— 插件在 <workspace>\dsh-plugins\dsh-picophone
const REPO = path.join(ROOT, 'DeepSeekCode');

// ---------------------------------------------------------------- 断言账本
// 规矩：只有这里能改计数器。任何 ✗ 都进 failures，最后据此设退出码。
const state = { pass: 0, fail: 0, skip: 0, failures: [] };
const line = (s) => console.log(`\n===== ${s} =====`);
const oneLine = (t, n = 200) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const firstLines = (t, n = 4) => String(t ?? '').split(/\r?\n/).slice(0, n).join(' | ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pass(label, detail) {
  state.pass += 1;
  console.log(`  ✓ ${label}${detail ? `  — ${oneLine(detail)}` : ''}`);
}
function fail(label, detail) {
  state.fail += 1;
  state.failures.push(label);
  console.log(`  ✗ ${label}${detail ? `  — ${oneLine(detail)}` : ''}`);
}
function skip(label, why) {
  state.skip += 1;
  console.log(`  SKIP ${label}  — ${why}`);
}
function check(cond, label, detail = '') {
  if (cond) pass(label, detail);
  else fail(label, detail);
  return Boolean(cond);
}
function checkEq(actual, expected, label) {
  if (actual === expected) pass(label);
  else fail(label, `期望 ${expected}，实际 ${actual}`);
  return actual === expected;
}

// ---------------------------------------------------------------- 假 ctx
const tools = new Map();
let command = null;
const promptSections = [];

// 沙箱执行器替身：直接 pwsh 跑插件拼出来的那条命令。
// ⚠️ 它不提供 OS 级隔离 —— 所以这层只验证"命令构造 + PATH 注入"，
//    加密/围栏类断言全部在插件 JS 里（跑不到 shell），不靠沙箱拦。
const shellState = { exe: null, ok: false };
function runShell(commandLine, workdir, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - started,
        sandbox: { mode: 'workspace-write', denied: false, note: 'smoke-test 替身（不做 OS 级隔离）' },
        ...payload,
      });
    };
    try {
      child = spawn(shellState.exe, ['-NoProfile', '-NonInteractive', '-Command', commandLine], {
        cwd: workdir && existsSync(workdir) ? workdir : ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ exitCode: null, stdout: { text: '' }, stderr: { text: String(error && error.message ? error.message : error) } });
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs)
      : null;
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      finish({ exitCode: null, stdout: { text: '' }, stderr: { text: String(error && error.message ? error.message : error) } });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        exitCode: code,
        timedOut,
        aborted: false,
        durationMs: Date.now() - started,
        stdout: { text: Buffer.concat(out).toString('utf8') },
        stderr: { text: Buffer.concat(err).toString('utf8') },
        sandbox: { mode: 'workspace-write', denied: false, note: 'smoke-test 替身（不做 OS 级隔离）' },
      });
    });
  });
}
const shellDouble = {
  resolve({ command: commandLine, workdir, timeoutMs }) {
    return { command: commandLine, workdir, timeoutMs };
  },
  async execute(spec) {
    const res = await runShell(spec.command, spec.workdir, spec.timeoutMs);
    return { result: async () => res };
  },
};

const ctx = {
  effect(fn) {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  tools: {
    register(def) {
      tools.set(def.name, def);
      return () => tools.delete(def.name);
    },
    get(name) {
      return tools.get(name);
    },
  },
  inject(names, cb) {
    const list = Array.isArray(names) ? names : [];
    const services = {
      commands: {
        register(def) {
          command = def;
          return () => {
            command = null;
          };
        },
      },
    };
    if (list.includes('systemPrompt')) {
      services.systemPrompt = {
        section(s) {
          promptSections.push(s);
          return () => {};
        },
      };
    }
    if (list.includes('shell')) services.shell = shellDouble;
    // 故意不给 approval：信任门在假 ctx 里拿不到审批者 ⇒ fail-closed（拒绝），这正是要测的默认行为。
    cb(services);
  },
  logger: { info: (m) => console.log('[log]', m) },
};

async function run(name, args) {
  const def = tools.get(name);
  // 工具没注册就是真失败（缺工具比缺功能严重），不要静默成 undefined.execute
  if (!def) return { ok: false, missing: true, text: `工具 ${name} 未注册` };
  try {
    return await def.execute(args);
  } catch (error) {
    return { ok: false, threw: true, text: `THREW: ${error && error.message ? error.message : error}` };
  }
}

async function callCommand(rawInput) {
  if (!command || typeof command.handler !== 'function') return { kind: null, text: '' };
  try {
    return await command.handler({ rawInput, agent: {}, attachments: [], signal: new AbortController().signal });
  } catch (error) {
    return { kind: 'THREW', text: `THREW: ${error && error.message ? error.message : error}` };
  }
}

/** 磁盘上到底有没有这个可执行文件 —— 用来区分"插件 PATH 没注入"（真失败）与"机器没装"（SKIP）。 */
function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}
const SDK = path.join(process.env.USERPROFILE || process.env.HOME || '', '.pico-sdk');
const VS_INSTALLER = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer');
function firstExisting(list) {
  return list.find((p) => p && existsSync(p)) ?? null;
}
function findTool(name) {
  if (!name) return null;
  if (name === 'ninja') return firstExisting(subdirs(path.join(SDK, 'ninja')).map((d) => path.join(d, 'ninja.exe')));
  if (name === 'cmake') return firstExisting(subdirs(path.join(SDK, 'cmake')).map((d) => path.join(d, 'bin', 'cmake.exe')));
  if (name === 'openocd') return firstExisting(subdirs(path.join(SDK, 'openocd')).map((d) => path.join(d, 'openocd.exe')));
  if (name === 'picotool') return firstExisting(subdirs(path.join(SDK, 'picotool')).map((d) => path.join(d, 'picotool', 'picotool.exe')));
  if (name === 'vswhere') return firstExisting([path.join(VS_INSTALLER, 'vswhere.exe')]);
  if (name === 'msbuild') return findTool('vswhere') ? '(需要 Visual Studio)' : null;
  if (name.startsWith('arm-none-eabi-')) {
    return firstExisting(subdirs(path.join(SDK, 'toolchain')).map((d) => path.join(d, 'bin', `${name}.exe`)));
  }
  return null;
}

async function main() {
  // ------------------------------------------------------------ 挂载
  line('加载插件（假 ctx：假 shell / 没有 approval）');
  try {
    await apply(ctx, {});
    pass('apply() 未抛异常');
  } catch (error) {
    fail('apply() 抛了异常 —— 九个工具一个都没挂上', error && error.message ? error.message : String(error));
    return; // 后面所有调用都无从谈起，直接收尾
  }

  line('注册结果');
  const EXPECTED = [
    'pico_status', 'pico_build', 'pico_flash', 'pico_serial', 'pico_console',
    'pico_temp', 'pico_git', 'pico_run', 'pico_exec',
  ];
  const registered = [...tools.keys()].sort();
  console.log('  实际:', registered.join(', ') || '(无)');
  check(registered.length === EXPECTED.length, `注册了 ${EXPECTED.length} 个工具`, `实际 ${registered.length} 个`);
  const missing = EXPECTED.filter((n) => !tools.has(n));
  const extra = registered.filter((n) => !EXPECTED.includes(n));
  check(missing.length === 0, '九件套全部在场', missing.length ? `缺: ${missing.join(', ')}` : '');
  check(extra.length === 0, '没有文档之外的第十件（说明写成"九个工具"）', extra.length ? `多: ${extra.join(', ')}` : '');
  check(command && command.name === 'pico', '/pico 命令已注册', command && command.name);

  // ------------------------------------------------------------ 系统提示注入
  // 这是"新来的 AI 知不知道先加载 pico-rig 技能"的唯一常显通道，断了就等于没人知道。
  line('系统提示注入（picophone:rig → pico-rig 技能）');
  const sectionText = () => {
    const s = promptSections[0];
    if (!s) return '';
    return typeof s.text === 'function' ? String(s.text({ scope: {} }) ?? '') : String(s.text ?? '');
  };
  check(promptSections.length === 1, '注册了 1 段 systemPrompt', `实际 ${promptSections.length} 段`);
  const s = promptSections[0];
  check(s && s.name === 'picophone:rig', '段落名 = picophone:rig', s && s.name);
  const order = s && s.order;
  check(Number.isFinite(order) && order > 2700 && order < 2800, 'order 落在 TOOL_RALPH(2700) 之后、TOOL_SUBAGENT(2800) 之前', String(order));
  check(s && typeof s.text === 'function', 'text 是函数（按 scope 判断工具是否在，才能整体关掉）', s && typeof s.text);

  const text = sectionText();
  console.log(`  字符数 = ${text.length}`);
  console.log(`  首行: ${oneLine(text.split(/\r?\n/)[0], 120)}`);
  check(text.length >= 200, '注入正文不短于 200 字符', `${text.length} 字符`);
  // ★ 这条就是本次修掉的假红灯：实现早已把细节指到 pico-rig 技能，不再提 台架接口.md / backdoor_only。
  check(text.includes('pico-rig'), '正文点名 pico-rig 技能（"先读技能再动手"）', '');
  check(text.includes('BOOTSEL'), '正文保留硬规矩：BOOTSEL 是唯一救砖手段', '');
  check(text.includes('/pico'), '正文提到 /pico 人工入口', '');
  // 正文里出现的每个 pico_xxx 都必须真的注册了 —— 防"指着不存在的工具说话"。
  const mentioned = [...new Set(text.match(/pico_[a-z_]+/g) ?? [])];
  const ghosts = mentioned.filter((n) => !tools.has(n));
  check(mentioned.length >= 9 && ghosts.length === 0, '正文提到的 pico_* 全部真的注册了', ghosts.length ? `幽灵: ${ghosts.join(', ')}` : `${mentioned.length} 个`);
  // 反引号会截断外层模板字符串，这是代码里写死的约束。
  check(!text.includes('`'), '正文里没有反引号（否则会截断模板字符串）', '');

  const savedStatus = tools.get('pico_status');
  tools.delete('pico_status');
  const gated = sectionText();
  check(gated === '', '工具被禁时这段变空串', `长度 ${gated.length}`);
  if (savedStatus) tools.set('pico_status', savedStatus);
  check(sectionText().length === text.length && text.length > 0, '工具恢复后又给出全文', `${sectionText().length} 字符`);

  // ------------------------------------------------------------ pico_temp
  line('pico_temp 读写（真实内容回读，不是只看 exit）');
  const w = await run('pico_temp', { op: 'write', path: 'picophone_smoke/hello.txt', content: '你好 PicoPhone\n' });
  check(w.ok === true, 'write 成功', w.text);
  const r = await run('pico_temp', { op: 'read', path: 'picophone_smoke/hello.txt' });
  check(r.ok === true && String(r.text).includes('你好 PicoPhone'), 'read 读回同一段 UTF-8 正文', r.text);
  const ls = await run('pico_temp', { op: 'ls', path: 'picophone_smoke' });
  check(ls.ok === true && String(ls.text).includes('hello.txt'), 'ls 列出刚写的文件', ls.text);

  const b64 = Buffer.from('hello-bin\n', 'utf8').toString('base64');
  const bw = await run('pico_temp', { op: 'write', path: 'picophone_smoke/bin.dat', content: b64, encoding: 'base64' });
  check(bw.ok === true && String(bw.text).includes('base64'), 'write 支持 base64 解码', bw.text);
  const br = await run('pico_temp', { op: 'read', path: 'picophone_smoke/bin.dat' });
  check(String(br.text).includes('hello-bin'), 'base64 写进去的字节能原样读回', br.text);
  const cp = await run('pico_temp', { op: 'cp', from: 'picophone_smoke/bin.dat', path: 'picophone_smoke/bin2.dat' });
  check(cp.ok === true, 'cp 复制', cp.text);
  const mv = await run('pico_temp', { op: 'mv', from: 'picophone_smoke/bin2.dat', path: 'picophone_smoke/bin3.dat' });
  check(mv.ok === true, 'mv 改名', mv.text);
  const moved = await run('pico_temp', { op: 'read', path: 'picophone_smoke/bin3.dat' });
  check(String(moved.text).includes('hello-bin'), 'mv 之后内容还在（bin3.dat）', moved.text);
  const gone = await run('pico_temp', { op: 'read', path: 'picophone_smoke/bin2.dat' });
  check(gone.ok === false, 'mv 之后源文件真的不在了', gone.text);

  // ------------------------------------------------------------ 围栏
  // 这几条都【在插件 JS 里就拒绝】，不依赖 shell/沙箱，所以假 ctx 里也必须真的拒。
  line('围栏：越界一律拒绝（拒绝理由要能看懂）');
  const esc = await run('pico_temp', { op: 'read', path: '../escape.txt' });
  check(esc.ok === false && /越出\s*%TEMP%/.test(String(esc.text)), '%TEMP% 之外的路径被拒（../escape.txt）', esc.text);
  const badExec = await run('pico_exec', { file: 'cmd', args: ['/c', 'echo hi'] });
  check(badExec.ok === false && /不在白名单/.test(String(badExec.text)), 'shell 不在 pico_exec 白名单（cmd 被拒）', badExec.text);
  const badCwd = await run('pico_exec', { file: 'ninja', args: ['--version'], cwd: 'C:\\Windows' });
  check(badCwd.ok === false && /cwd 必须落在/.test(String(badCwd.text)), 'pico_exec 的 cwd 逃不出项目/%TEMP%', badCwd.text);
  const badRun = await run('pico_run', { script: 'src/main.cpp' });
  check(badRun.ok === false && /只允许运行/.test(String(badRun.text)), 'tools/ 之外的脚本不能跑（src/main.cpp 被拒）', badRun.text);
  const badGit = await run('pico_git', { args: ['push'] });
  check(badGit.ok === false && /mutate/.test(String(badGit.text)), 'push 不带 mutate:true 被拒', badGit.text);

  // ------------------------------------------------------------ 沙箱类（真跑）
  line('沙箱类真跑（shell 替身：只验证命令构造 + PATH 注入，不验证 OS 隔离）');
  shellState.exe = firstExisting([
    'C:\\Users\\Rain\\AppData\\Local\\Programs\\PowerShell7\\pwsh.exe',
    'pwsh',
    'powershell.exe',
  ]);
  const probe = shellState.exe ? await runShell('exit 0', ROOT, 20000) : { exitCode: null, stderr: { text: '找不到 pwsh' } };
  shellState.ok = probe.exitCode === 0;
  check(shellState.ok, '替身 shell 可用（pwsh -Command exit 0）', shellState.ok ? shellState.exe : probe.stderr && probe.stderr.text);

  if (!shellState.ok) {
    skip('pico_git 只读（git log）', '没有可用的 pwsh 做替身');
    for (const n of ['ninja', 'arm-none-eabi-gcc', 'arm-none-eabi-objdump', 'openocd', 'vswhere', 'msbuild']) skip(`pico_exec ${n}`, '没有可用的 pwsh 做替身');
  } else {
    const gitLog = await run('pico_git', { args: ['log', '--oneline', '-3'] });
    check(gitLog.ok === true && /exit=0/.test(String(gitLog.text)), 'pico_git 只读（git log --oneline -3）', firstLines(gitLog.text, 3));
    check(/--- stdout ---/.test(String(gitLog.text)) && /\b[0-9a-f]{7,}\b/.test(String(gitLog.text)), 'git log 真的吐出了 commit', firstLines(gitLog.text, 3));

    // PATH 注入：这些可执行文件都不在系统 PATH 上，只可能来自插件的 toolPathPrefix。
    // 磁盘上有 ⇒ 必须跑得起来（跑不起来 = PATH 注入坏了，真失败）；磁盘上没有 ⇒ SKIP（机器没装）。
    for (const [name, argv] of [
      ['ninja', ['--version']],
      ['arm-none-eabi-gcc', ['-dumpfullversion']],
      ['arm-none-eabi-objdump', ['--version']],
      ['openocd', ['--version']],
      ['vswhere', ['-latest', '-property', 'displayName']],
      ['msbuild', ['-version']],
    ]) {
      if (!findTool(name)) {
        skip(`pico_exec ${name}`, `这台机器没装（${name} 在 .pico-sdk / VS 目录里都找不到）`);
        continue;
      }
      const res = await run('pico_exec', { file: name, args: argv });
      check(res.ok === true && res.exitCode === 0, `pico_exec ${name} 跑得起来（PATH 已注入）`, firstLines(res.text, 2));
    }
  }

  // ------------------------------------------------------------ pico_status
  line('pico_status（只读全景）');
  const st = await run('pico_status', {});
  check(st.ok === true && st.json && typeof st.json === 'object', 'pico_status 返回 ok + json', firstLines(st.text, 1));
  const j = st.json ?? {};
  const stText = String(st.text ?? '');
  console.log(stText.slice(0, 900));
  checkEq(j.paths && j.paths.root, ROOT, 'json.paths.root 就是本工作区（插件里别写死旧路径）');
  check(j.paths && j.paths.repo === REPO && existsSync(REPO), 'json.paths.repo = <root>\\DeepSeekCode 且存在', j.paths && j.paths.repo);
  check(['== 工具链 ==', '== 台架锁（串口/烧写互斥）==', '== 最后烧写', '== 悬挂进程守卫 =='].every((h) => stText.includes(h)), 'status 各栏齐全（工具链/台架锁/账本/悬挂进程）', '');
  check('lock' in j && Array.isArray(j.ports) && 'lastFlash' in j, 'json 带 lock / ports / lastFlash 三个可机读字段', Object.keys(j).join(','));
  const lockHeld = Boolean(j.lock);

  // ------------------------------------------------------------ 台架（板子）
  line('台架：串口 / 会话（没有开发板就 SKIP，不算失败）');
  const listed = await run('pico_serial', { list: true });
  check(listed.ok === true, 'pico_serial --list 正常返回', firstLines(listed.text, 2));
  const match = /MATCH-COUNT\s+(\d+)/.exec(String(listed.text));
  check(match !== null, 'serial.ps1 -List 报出 MATCH-COUNT（板子在不在，看这个数）', firstLines(listed.text, 2));
  const boardCount = match ? Number(match[1]) : 0;
  const board = boardCount > 0;
  console.log(`  探测到 ${boardCount} 个 dut 设备（VID 2E8A / PID 0009）`);

  const rigSkipReason = !board
    ? '没插开发板（serial.ps1 -List MATCH-COUNT=0）'
    : lockHeld
      ? `台架锁被占用：${oneLine((j.lock && j.lock.what) ?? '?', 60)}`
      : '';
  if (rigSkipReason) {
    skip('pico_serial 读 dut 3 秒', rigSkipReason);
    skip('pico_console open/expect/read/close', rigSkipReason);
    skip('pico_status --probe', rigSkipReason);
  } else {
    const read = await run('pico_serial', { target: 'dut', seconds: 3 });
    check(read.ok === true, 'pico_serial 读 dut 3 秒', firstLines(read.text, 3));
    check(/落盘/.test(String(read.text)), 'pico_serial 默认落 %TEMP% 并回显正文（不是只看 READ n bytes）', firstLines(read.text, 4));

    const opened = await run('pico_console', { op: 'open', sessionId: 'smoke', target: 'dut' });
    check(opened.ok === true, 'pico_console open（付一次 4~5s）', firstLines(opened.text, 2));
    if (opened.ok) {
      const exp = await run('pico_console', { op: 'expect', sessionId: 'smoke', data: 'G\r', escapes: true, until: 'MATCH|engine_fb|g_fb', timeoutMs: 3000 });
      console.log(`  expect: ${oneLine(exp.text, 160)}`);
      check(/命中 until|超时无匹配/.test(String(exp.text)), 'expect 给出明确结论（命中/超时，不是含糊的"没输出"）', firstLines(exp.text, 1));
      await sleep(1000);
      const after = await run('pico_console', { op: 'read', sessionId: 'smoke', timeoutMs: 500 });
      const stamps = new Set(String(after.text).split(/\r?\n/).filter((l) => /^\d\d:\d\d:\d\d\.\d{3}/.test(l)).map((l) => l.slice(0, 12)));
      check(after.ok === true && stamps.size >= 2, 'read 每行带真实到达时刻（缓冲不篡改时间戳）', `去重后 ${stamps.size} 个时刻`);
      const sessions = await run('pico_console', { op: 'list' });
      check(sessions.ok === true && String(sessions.text).includes('smoke'), 'console list 报得出会话名', firstLines(sessions.text, 2));
      const closed = await run('pico_console', { op: 'close', sessionId: 'smoke' });
      check(closed.ok === true, 'close 关会话并释放台架锁', firstLines(closed.text, 1));
    }
    const probed = await run('pico_status', { probeSerial: true, probeSeconds: 2 });
    check(probed.ok === true && String(probed.text).includes('板上最近说过的话'), 'status --probe 带上串口采样栏', '');
  }
  // 无论有没有板子，冒烟测试都不写板子 —— 这条是纪律，不是条件。
  skip('真烧写 pico_flash', '冒烟测试不碰硬件（只做 dry-run）；真烧写是单独的动作，BOOTSEL 是唯一救砖手段');

  // ------------------------------------------------------------ 烧写预演
  line('pico_flash：盘身份 + dry-run（不写盘）');
  const flashList = await run('pico_flash', { method: 'list' });
  check(String(flashList.text).includes('当前 BOOTSEL 盘'), 'method=list 报出当前 BOOTSEL 盘（空也要说"没有"）', firstLines(flashList.text, 2));
  check(Array.isArray(flashList.json && flashList.json.volumes), 'list 的 json.volumes 是数组', Array.isArray(flashList.json && flashList.json.volumes) ? 'array' : typeof (flashList.json && flashList.json.volumes));
  const uf2 = path.join(REPO, 'build', 'PicoPhone.uf2');
  if (!existsSync(uf2)) {
    skip('pico_flash dry-run', 'build/PicoPhone.uf2 还没有（先跑一次构建，或去掉 --no-build）');
  } else {
    const dry = await run('pico_flash', { board: 'dut', firmware: 'build/PicoPhone.uf2', dryRun: true });
    check(dry.ok === true && /\[dry-run\]/.test(String(dry.text)), 'dry-run 解析出要执行的命令', firstLines(dry.text, 2));
    check(/盘身份核对/.test(String(dry.text)), 'dry-run 带上盘身份核对结论（写盘前必须认盘）', '');
  }

  // ------------------------------------------------------------ /pico 命令
  line('/pico 命令');
  const help = await callCommand('help');
  check(help.kind === 'success', '/pico help 返回 success', help.kind);
  const verbs = ['status', 'lock', 'build', 'flash', 'serial', 'console', 'swd', 'procs', 'temp', 'git', 'run', 'exec', 'docs', 'agents'];
  const missingVerbs = verbs.filter((v) => !String(help.text).includes(`/pico ${v}`));
  check(missingVerbs.length === 0, `help 列全 ${verbs.length} 个子命令`, missingVerbs.length ? `缺: ${missingVerbs.join(', ')}` : '');
  check(String(help.text).includes('pico_status') && String(help.text).includes('pico_exec'), 'help 末尾点名 Agent 侧的九个工具', '');

  const cmdRead = await callCommand('temp read picophone_smoke/hello.txt');
  check(cmdRead.kind === 'success' && String(cmdRead.text).includes('你好 PicoPhone'), '/pico temp read 读到刚写的文件（命令面与工具面同一条路）', firstLines(cmdRead.text, 1));
  const cmdLock = await callCommand('lock');
  check(cmdLock.kind === 'success' && /台架空闲|台架被占用/.test(String(cmdLock.text)), '/pico lock 报出台架锁状态', firstLines(cmdLock.text, 1));

  // ------------------------------------------------------------ 构建
  line('pico_build root（真构建；会覆盖 build\\build_info.txt）');
  const NO_BUILD = process.env.SMOKE_NO_BUILD === '1' || process.argv.includes('--no-build');
  const FORCE_BUILD = process.argv.includes('--build');
  // pico_build 执行的是运行本（_picophone_trust\runtime）里那一份 build.cmd，它 `cd %~dp0..` 落在运行本里
  // ⇒ 运行本必须是一棵完整仓库骨架（lib/trust.js：除 tools\ 外全部 junction 回真身、由人一次性建好）。
  // 这台机器没建骨架时构建必然失败 —— 那是部署缺口，不是插件代码错，按 SKIP 报（--build 可强制跑）。
  const runtimeRepo = path.join(path.dirname(ROOT), '_picophone_trust', 'runtime', path.basename(REPO));
  const runtimeReady = existsSync(path.join(runtimeRepo, 'CMakeLists.txt'));
  if (NO_BUILD) {
    skip('pico_build root', '--no-build / SMOKE_NO_BUILD=1：不覆盖 build\\build_info.txt');
  } else if (!runtimeReady && !FORCE_BUILD) {
    skip('pico_build root', `运行本骨架没建（${runtimeRepo} 里没有 CMakeLists.txt）⇒ 构建必然失败；加 --build 可强制跑`);
  } else {
    const t0 = Date.now();
    const built = await run('pico_build', { target: 'root' });
    console.log(`  构建耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
    check(built.ok === true, 'root 构建成功（走 tools/build.cmd）', firstLines(built.text, 3));
    check(built.json && built.json.target === 'root', 'json.target = root', built.json && built.json.target);
    if (!built.ok) {
      skip('build_info.txt / uf2 派生检查', '构建没成功 ⇒ 派生结论不成立（也不许拿上一轮的产物冒充这一轮）');
    } else {
      const infoFile = path.join(REPO, 'build', 'build_info.txt');
      check(existsSync(infoFile), '产物旁落了 build/build_info.txt', infoFile);
      if (existsSync(infoFile)) {
        let info = null;
        try {
          info = JSON.parse(readFileSync(infoFile, 'utf8'));
        } catch {
          info = null;
        }
        check(Boolean(info && info.source && info.source.branch && info.source.head), 'build_info.txt 记了源码来源 branch@head', info && info.source ? `${info.source.branch}@${info.source.head}` : '(解析失败)');
        check(Boolean(info && info.builtAt && info.node && info.toolchain), 'build_info.txt 记了构建时间 / node / 工具链版本', info && info.builtAt);
      }
      check(existsSync(path.join(REPO, 'build', 'PicoPhone.uf2')), 'build/PicoPhone.uf2 在', '');
    }
  }

  // ------------------------------------------------------------ 清理
  line('清理');
  const rm = await run('pico_temp', { op: 'rm', path: 'picophone_smoke' });
  check(rm.ok === true, '删掉 %TEMP%\\picophone_smoke', rm.text);
}

try {
  await main();
} catch (error) {
  fail('冒烟测试自身抛了异常', error && error.stack ? String(error.stack).split(/\r?\n/)[0] : String(error));
}

line('汇总');
console.log(`  通过 ${state.pass} · 失败 ${state.fail} · 跳过 ${state.skip}`);
if (state.failures.length > 0) {
  console.log('  失败项:');
  for (const name of state.failures) console.log(`   - ${name}`);
  console.log('  结论: 红灯 —— 上面有 ✗，退出码 1。');
} else {
  console.log('  结论: 绿灯 —— SKIP 项是"这台机器没这个条件"（没板子/没装 VS），不是失败。');
}
// 必须显式 exit：会话计时器 / 子进程可能让事件循环挂着，而 exitCode 只在自然退出时生效。
process.exit(state.fail > 0 ? 1 : 0);
