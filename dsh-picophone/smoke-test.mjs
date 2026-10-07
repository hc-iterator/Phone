// 冒烟测试：用假 ctx 加载本插件，逐项调用各能力（不碰硬件：只做只读 + %TEMP% 读写）。
// 用法： node smoke-test.mjs
import { apply } from './index.js';
import { existsSync, readFileSync } from 'node:fs';

const tools = new Map();
let command = null;
// ★ 2026-10-06：系统提示注入的落点。不铺桩的话，插件里那条注入路径等于**没被测到** ✗
const promptSections = [];

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
    // ★ 2026-10-06：注入的文本里会问"pico_status 注册了吗"，所以桩要支持 get(name, scope)
    get(name) {
      return tools.get(name);
    },
  },
  inject(names, cb) {
    const fake = {
      commands: {
        register(def) {
          command = def;
          return () => {
            command = null;
          };
        },
      },
    };
    if (Array.isArray(names) && names.includes('systemPrompt')) {
      fake.systemPrompt = {
        section(s) {
          promptSections.push(s);
          return () => {};
        },
        getSectionOrder: () => 2700,
      };
    }
    cb(fake);
  },
  logger: { info: (m) => console.log('[log]', m) },
};

const line = (s) => console.log(`\n===== ${s} =====`);
async function safe(promise) {
  try {
    return await promise;
  } catch (error) {
    return { ok: false, text: `THREW: ${error && error.message ? error.message : error}` };
  }
}
const run = (name, args) => safe(tools.get(name).execute(args));

await apply(ctx, {});

// ★ 2026-10-06 新增：系统提示注入必须**真的发生** ——
//   这是"新来的 AI 知不知道这套接口怎么用"的唯一常显通道（工具说明之外）。
line('系统提示注入（picophone:rig）');
{
  const s = promptSections[0];
  const text = s ? (typeof s.text === 'function' ? s.text({ scope: {} }) : s.text) : '';
  console.log(`  section 数 = ${promptSections.length}  name = ${s?.name ?? '(无)'}  order = ${s?.order ?? '-'}  字符数 = ${text.length}`);
  const hasDoc = text.includes('台架接口.md');
  const hasRelay = text.includes('backdoor_only');
  const noTick = !text.includes('`');
  console.log(`  含 台架接口.md = ${hasDoc}   含 backdoor_only = ${hasRelay}   无反引号 = ${noTick}`);
  if (!s || text.length < 200 || !hasDoc || !hasRelay || !noTick) {
    console.log('  ✗ 注入缺失 / 过短 / 缺关键项');
    process.exitCode = 1;
  } else {
    console.log('  ✓ 注入正常');
  }
  // 反向：工具被禁时这段必须变空串（不能指着不存在的工具说话）
  const saved = tools.get('pico_status');
  tools.delete('pico_status');
  const empty = typeof s?.text === 'function' ? s.text({ scope: {} }) : '';
  console.log(`  工具清空后长度 = ${empty.length} ${empty.length === 0 ? '（✓ 空串）' : '（✗ 应为空）'}`);
  if (empty.length !== 0) process.exitCode = 1;
  if (saved) tools.set('pico_status', saved);
}

line('注册结果');
console.log('tools  :', [...tools.keys()].join(', '));
console.log('command:', command && command.name);

line('pico_temp 读写');
console.log((await run('pico_temp', { op: 'write', path: 'picophone_smoke/hello.txt', content: '你好 PicoPhone\n' })).text);
console.log((await run('pico_temp', { op: 'read', path: 'picophone_smoke/hello.txt' })).text);
console.log((await run('pico_temp', { op: 'ls', path: 'picophone_smoke' })).text);

line('围栏：%TEMP% 之外的路径');
console.log((await run('pico_temp', { op: 'read', path: '../escape.txt' })).text);

line('围栏：白名单之外的执行文件');
console.log((await run('pico_exec', { file: 'cmd', args: ['/c', 'echo hi'] })).text);

line('围栏：tools/ 之外的脚本');
console.log((await run('pico_run', { script: 'src/main.cpp' })).text);

line('围栏：git 写操作');
console.log((await run('pico_git', { args: ['push'] })).text);

line('pico_git 只读');
console.log((await run('pico_git', { args: ['log', '--oneline', '-3'] })).text);

line('pico_flash dry-run');
console.log((await run('pico_flash', { board: 'dut', firmware: 'build/PicoPhone.uf2', dryRun: true })).text);

line('pico_serial --list');
console.log((await run('pico_serial', { list: true })).text);

line('pico_exec 注入 PATH 后应能跑起来（原先 ENOENT 的那几个）');
for (const [name, argv] of [
  ['ninja', ['--version']],
  ['arm-none-eabi-gcc', ['-dumpfullversion']],
  ['arm-none-eabi-objdump', ['--version']],
  ['openocd', ['--version']],
  ['vswhere', ['-latest', '-property', 'displayName']],
  ['msbuild', ['-version']],
]) {
  const res = await run('pico_exec', { file: name, args: argv });
  const first = String(res.text).split('\n').slice(0, 2).join(' | ');
  console.log(`${name.padEnd(22)} ${first}`);
}

line('pico_serial 读 dut 3 秒（默认落盘 + 回显正文）');
console.log((await run('pico_serial', { target: 'dut', seconds: 3 })).text);

line('pico_status');
console.log((await run('pico_status', {})).text);

line('/pico help');
const help = await command.handler({ rawInput: 'help', agent: {}, attachments: [], signal: new AbortController().signal });
console.log(help.kind, '\n', help.text);

line('/pico temp read');
const read = await command.handler({ rawInput: 'temp read picophone_smoke/hello.txt', agent: {}, attachments: [], signal: new AbortController().signal });
console.log(read.kind, '\n', read.text);

line('pico_status --probe（#5）');
const probed = await run('pico_status', { probeSerial: true, probeSeconds: 2 });
console.log(String(probed.text).split('== 板上最近说过的话')[1]?.slice(0, 500) ?? '(没有采样栏)');
console.log('json.git:', JSON.stringify(probed.json?.git ?? null));

line('台架锁：会话开着时 pico_serial 应被拒（#1）');
console.log((await run('pico_console', { op: 'open', sessionId: 'smoke', target: 'dut' })).text);
const blocked = await run('pico_serial', { target: 'dut', seconds: 2 });
console.log(String(blocked.text).split('\n').slice(0, 3).join('\n'));

line('锁文件里报得出会话名吗（新修 ①）');
try {
  const lockJson = JSON.parse(readFileSync('C:\\固态盘秘钥\\.dsh\\picophone.lock', 'utf8'));
  console.log('session =', lockJson.session, '| what =', lockJson.what);
  console.log(String(lockJson.session).includes('unknown') ? '✗ 还是取不到会话' : '✓ 报得出会话');
} catch (error) {
  console.log('读锁失败:', error.message);
}

line('expect：发 G 并等到匹配（#3/#4）');
const expected = await run('pico_console', { op: 'expect', sessionId: 'smoke', data: 'G\r', escapes: true, until: 'MATCH|engine_fb|g_fb', timeoutMs: 3000 });
console.log(String(expected.text).slice(0, 1000));

line('时间戳不打折：开着不读 6 秒后再读一次（新修 ②）');
await new Promise((resolve) => setTimeout(resolve, 6000));
const after = await run('pico_console', { op: 'read', sessionId: 'smoke', timeoutMs: 500 });
const stamped = String(after.text).split('\n').filter((l) => /^\d\d:\d\d:\d\d\.\d\d\d /.test(l));
const stamps = [...new Set(stamped.map((l) => l.slice(0, 12)))];
console.log(`读到 ${stamped.length} 行，去重后 ${stamps.length} 个到达时刻：${stamps.slice(0, 6).join('  ')}`);
console.log(stamps.length >= 3 ? '✓ 时间戳是分开的（缓冲里保留了真实到达时刻）' : '✗ 时间戳挤在一起（还在骗人）');

line('会话列表 / 关闭 / 锁释放');
console.log((await run('pico_console', { op: 'list' })).text);
console.log((await run('pico_console', { op: 'close', sessionId: 'smoke' })).text);
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log(String((await run('pico_serial', { target: 'dut', seconds: 2 })).text).split('\n').slice(0, 2).join('\n'));

line('pico_temp base64 + cp/mv（#11）');
console.log((await run('pico_temp', { op: 'write', path: 'picophone_smoke/bin.dat', content: Buffer.from('hello-bin\n').toString('base64'), encoding: 'base64' })).text);
console.log((await run('pico_temp', { op: 'cp', from: 'picophone_smoke/bin.dat', path: 'picophone_smoke/bin2.dat' })).text);
console.log((await run('pico_temp', { op: 'mv', from: 'picophone_smoke/bin2.dat', path: 'picophone_smoke/bin3.dat' })).text);
console.log((await run('pico_temp', { op: 'read', path: 'picophone_smoke/bin3.dat' })).text);

line('pico_flash：盘身份核对 + dry-run（#6）');
console.log(String((await run('pico_flash', { method: 'list' })).text).slice(0, 700));
console.log((await run('pico_flash', { board: 'dut', firmware: 'build/PicoPhone.uf2', method: 'picotool', dryRun: true })).text);

// ⚠️ 这一段会真跑构建：它覆盖 <repo>\build\build_info.txt 并重写 debug_logs 下的构建日志。
//    只想跑只读检查就加 --no-build（或设 SMOKE_NO_BUILD=1）。
const WITH_BUILD = process.env.SMOKE_NO_BUILD !== '1' && !process.argv.includes('--no-build');
if (!WITH_BUILD) {
  line('pico_build root：已按 --no-build 跳过');
  console.log('（它会覆盖 build\\build_info.txt，所以默认允许，跳过得显式说明）');
} else {
  line('pico_build root：build_info + json（#2/#8）');
  const built = await run('pico_build', { target: 'root' });
  console.log(String(built.text).split('\n').slice(0, 10).join('\n'));
  console.log('json:', JSON.stringify(built.json ?? null).slice(0, 400));
  console.log('build_info.txt 存在:', existsSync('C:\\Users\\Chen\\Desktop\\Pico\\PicoPhone\\DeepSeekCode\\build\\build_info.txt'));
  console.log('账本行数:', (() => { try { return readFileSync('C:\\Users\\Chen\\Desktop\\Pico\\PicoPhone\\DeepSeekCode\\debug_logs\\flash_ledger.jsonl', 'utf8').trim().split('\n').length; } catch { return 0; } })());
}

line('清理');
console.log((await run('pico_temp', { op: 'rm', path: 'picophone_smoke' })).text);
