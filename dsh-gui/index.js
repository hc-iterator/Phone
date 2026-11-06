/**
    ),
/**
 * dsh-gui —— 图形化 / 屏幕操作能力（宿主插件）
 *
 * 从 dsh-picophone（PicoPhone 台架）里拆出来的：台架和"看屏幕/点窗口"是两件事，
 * 混在一个插件里会让两边的规则互相污染（台架提示词被迫夹带 GUI 说明，反之亦然）。
 *
 * 工具：gui_windows / gui_capture / gui_zoom / gui_launch / gui_place /
 *       gui_vdd / gui_browser / gui_uia / gui_click / gui_verify
 * 脚本：DeepSeekCode/tools/gui/*.ps1（默认按插件位置推算仓库路径）
 *
 * ⚠️ 这些操作必须在**宿主进程**里跑：pico_run 的 workspace-write 沙箱会挡住 GDI/桌面访问
 *    （实测同一脚本在沙箱里 PrintWindow=false 全黑，pwsh 直跑正常）。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 插件放在 <PicoPhone>/dsh-plugins/dsh-gui，仓库在 <PicoPhone>/DeepSeekCode。 */
function defaultRepo() {
  return path.resolve(HERE, '..', '..', 'DeepSeekCode');
}

function resolveConfig(raw) {
  const cfg = raw ?? {};
  return {
    repo: cfg.repo ? String(cfg.repo) : defaultRepo(),
  };
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    // ⚠️ exitCode 故意不在 schema 里声明：它是 number|null，而网关只接受"单一类型字符串"
    //    （实测报错：schema.properties.exitCode.type must be a single type string）。
    //    additionalProperties: true ⇒ 不声明也能合法返回，值照样随结果传给模型。
    text: { type: 'string' },
  },
  required: ['ok', 'text'],
};
// ── 图形化能力：窗口清单 / 按窗口截图 / 放大镜 ──────────────────────────────
// 为什么放在宿主进程：pico_run 的 workspace-write 沙箱挡住 GDI/桌面访问。
// 实测同一脚本：沙箱里 PrintWindow=false 且全黑；pwsh 直跑 true、301 KB。
function guiScriptPath(cfg, name) {
  const script = path.join(cfg.repo, 'tools', 'gui', name);
  if (!existsSync(script)) throw new Error(`找不到脚本 ${script}`);
  return script;
}

function runGuiScript(cfg, name, argv, timeoutMs = 60000) {
  return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', guiScriptPath(cfg, name), ...argv], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
  });
}

// 审计（中危）：outFile 原来接受任意路径 ⇒ 能把已有文件覆盖成 PNG（实测 .txt 被换掉），
// 也是 fs/pwsh 被沙箱挡住时仍然能写的一条路。现在无条件围栏到 %TEMP% 之内。
function fencedOut(outFile) {
  if (!outFile) return null;
  const target = path.resolve(String(outFile));
  const root = path.resolve(tmpdir());
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // 越界 ⇒ 忽略，用默认路径
  return target;
}

function guiOutPath(ext) {
  const dir = path.join(tmpdir(), 'dsh_gui');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `gui-${stamp}.${ext}`);
}

// ── 三级恢复：鼠标 + 焦点 + 输入法 ────────────────────────────────────────────
// 只恢复鼠标是不够的：焦点没回来用户还得自己点一下，输入法没回来他下一个字就打错。
// 这两步都走 tools/gui/env-guard.ps1；失败一律吞掉（恢复不了不该让动作本身失败）。
function envGuard(cfg, argv) {
  try {
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', guiScriptPath(cfg, 'env-guard.ps1'), ...argv], {
      encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { /* best effort */ }
}

function envSnapshot(cfg) { envGuard(cfg, ['-Snapshot', '-Quiet']); }
function envRestore(cfg, target) {
  const argv = ['-Restore', '-Quiet'];
  if (target) argv.push('-Target', String(target));
  envGuard(cfg, argv);
}

// ── 真实屏幕守卫 ────────────────────────────────────────────────────────────
// 教训（2026-11-06）：虚拟屏挂掉时，工具会退化成"直接在用户真实屏幕上点/打字" ——
// 又闪又抢焦点，用户当场就看到鼠标乱跑。所以：**没有第二块屏就拒绝**，除非显式放行。
let __screenCache = { at: 0, count: 0 };

function screenCount(cfg) {
  const now = Date.now();
  if (now - __screenCache.at < 5000) return __screenCache.count;
  let count = 1;
  try {
    const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      '[System.Windows.Forms.Screen]::AllScreens.Count'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const n = Number(String(out).trim());
    if (Number.isFinite(n)) count = n;
  } catch { count = 1; }
  __screenCache = { at: now, count };
  return count;
}

function realScreenAllowed(cfg, args) {
  if (args && args.allowRealScreen === true) return true;
  return screenCount(cfg) >= 2;
}

function noVirtualScreen() {
  return {
    ok: false, exitCode: null,
    text: '拒绝执行：当前没有第二块屏（虚拟屏未开启），这会在用户真实屏幕上闪窗口/抢焦点。'
      + '\n先 gui_vdd({action:"add"})；确实要在真实屏幕操作，显式传 allowRealScreen: true。',
  };
}

// ── 操作列表（journal）────────────────────────────────────────────────────────
// 每次 gui_* 调用都记一条：时间、工具、是否成功、耗时、参数的摘要。
// 目的：① 用户能回看"它到底做了什么"；② 出问题时不用靠猜（本次实战就缺这个）。
function journalPath() {
  const dir = path.join(tmpdir(), 'dsh_gui');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, 'ops.jsonl');
}

function journalTool(name, args, result, ms) {
  try {
    const digest = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      if (k === 'text') digest[k] = String(v).slice(0, 40);
      else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') digest[k] = v;
      else if (Array.isArray(v)) digest[k] = v.slice(0, 5);
    }
    const row = {
      at: new Date().toISOString(),
      tool: name,
      ok: result?.ok !== false,
      ms,
      args: digest,
      result: String(result?.text ?? '').split('\n')[0].slice(0, 160),
    };
    appendFileSync(journalPath(), JSON.stringify(row) + '\n', 'utf8');
  } catch { /* 记不下就算了，绝不影响主流程 */ }
}

async function opGuiOps(cfg, args = {}) {
  const limit = Number.isFinite(args.limit) ? args.limit : 20;
  try {
    if (!existsSync(journalPath())) return { ok: true, exitCode: 0, text: '（还没有任何操作记录）' };
    const lines = readFileSync(journalPath(), 'utf8').trim().split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    const out = tail.map((l) => {
      try {
        const r = JSON.parse(l);
        return `${r.at.slice(11, 19)} ${r.ok ? '✓' : '✗'} ${r.tool} (${r.ms}ms) ${JSON.stringify(r.args).slice(0, 90)}`;
      } catch { return l; }
    });
    return { ok: true, exitCode: 0, text: `最近 ${tail.length} 条操作：\n` + out.join('\n') };
  } catch (error) {
    return { ok: false, exitCode: null, text: `读取操作记录失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function opGuiWindows(cfg, args = {}) {
  const argv = ['-Json'];
  if (args.all === true) argv.push('-All');
  try {
    const windows = JSON.parse(runGuiScript(cfg, 'list-windows.ps1', argv, 30000));
    const lines = [`窗口 ${windows.length} 个：hwnd / 进程 / 尺寸@位置 / 标题`];
    for (const w of windows) lines.push(`  ${w.hwndHex}  ${w.process}  ${w.rect.w}x${w.rect.h}@${w.rect.x},${w.rect.y}  ${w.title}`);
    return { ok: true, exitCode: 0, windows, text: lines.join('\n') };
  } catch (error) {
    return { ok: false, exitCode: null, text: `列窗口失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function opGuiCapture(cfg, args = {}) {
  const hwnd = String(args.hwnd ?? '').trim();
  if (hwnd === '') return { ok: false, exitCode: null, text: 'hwnd 必填（十进制或 0x 十六进制）' };
  const out = fencedOut(args.outFile) ?? guiOutPath('png');
  const argv = [hwnd, out];
  if (Number.isFinite(args.maxWidth) && args.maxWidth > 0) argv.push('-MaxWidth', String(args.maxWidth));
  if (args.raise === true) argv.push('-Raise');
  try {
    const raw = runGuiScript(cfg, 'capture-window.ps1', argv, 60000);
    return { ok: true, exitCode: 0, path: out, text: `${raw.trim()}\n图片：${out}` };
  } catch (error) {
    return { ok: false, exitCode: null, text: `截图失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function opGuiZoom(cfg, args = {}) {
  const x = Number(args.x); const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, exitCode: null, text: 'x / y 必须是数字' };
  const out = fencedOut(args.outFile) ?? guiOutPath('png');
  const argv = [String(Math.round(x)), String(Math.round(y)), out,
    '-Size', String(Number.isFinite(args.size) ? Math.max(16, args.size) : 100),
    '-Scale', String(Number.isFinite(args.scale) ? Math.max(1, args.scale) : 1)];
  try {
    const raw = runGuiScript(cfg, 'zoom-at.ps1', argv, 30000);
    return { ok: true, exitCode: 0, path: out, text: `${raw.trim()}\n图片：${out}` };
  } catch (error) {
    return { ok: false, exitCode: null, text: `放大镜失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

// 审计 H2：gui_launch 原本能起任意 exe/协议（实测 .cmd 被执行），等于在宿主令牌下任意代码执行。
// 现在只允许「驱动窗口用的普通程序」，协议处理器默认全部拒绝；要放宽必须在插件配置里显式列。
const DEFAULT_LAUNCH_ALLOW = [
  'notepad.exe', 'mspaint.exe', 'charmap.exe', 'calc.exe', 'calculator.exe',
  'msedge.exe', 'chrome.exe', 'explorer.exe', 'taskmgr.exe',
  'winword.exe', 'excel.exe', 'powerpnt.exe', 'notepad++.exe', 'code.exe',
];

function launchAllowed(cfg, file) {
  const raw = String(file ?? '').trim();
  if (raw === '') return false;
  const allow = Array.isArray(cfg.launchAllow) && cfg.launchAllow.length > 0 ? cfg.launchAllow : DEFAULT_LAUNCH_ALLOW;
  const base = raw.includes('\\') || raw.includes('/') ? path.basename(raw).toLowerCase() : raw.toLowerCase();
  // 协议处理器（foo: / ms-settings:）一律拒绝：它能把任意已注册程序拉起来
  if (/^[a-z][a-z0-9+.-]*:$/i.test(raw)) return false;
  return allow.map((x) => String(x).toLowerCase()).includes(base);
}

// ── 图形化：启动到虚拟屏 / 挪窗口 / 虚拟显示器 / 浏览器 CDP ────────────────
async function opGuiLaunch(cfg, args = {}) {
  const file = String(args.file ?? '').trim();
  if (file === '') return { ok: false, exitCode: null, text: 'file 必填（例如 notepad.exe）' };
  if (!realScreenAllowed(cfg, args)) return noVirtualScreen();
  if (!launchAllowed(cfg, file)) {
    return {
      ok: false, exitCode: null,
      text: `拒绝启动 ${file}：不在 gui_launch 白名单内（默认只允许常见窗口程序，协议处理器一律拒绝）。`
        + `\n需要放宽就在插件配置里加 launchAllow: [...]。`,
    };
  }
  const argv = ['-File', guiScriptPath(cfg, 'launch-on-vd.ps1'), file];
  // 审计：多参数原来被拆散/吞掉 ⇒ 改用 JSON 一次传，脚本侧 ConvertFrom-Json 还原
  if (Array.isArray(args.args) && args.args.length > 0) argv.push('-ArgsJson', JSON.stringify(args.args.map(String)));
  if (Number.isFinite(args.waitSeconds)) argv.push('-WaitSeconds', String(args.waitSeconds));
  // 启动会短暂影响前台/光标 ⇒ 动作完把环境还回去，用户不会觉得"鼠标自己跑了"
  const wantRestore = args.restore !== false;
  if (wantRestore) envSnapshot(cfg);
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...argv], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `启动失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (wantRestore) envRestore(cfg, null);
  }
}

async function opGuiPlace(cfg, args = {}) {
  const hwnd = String(args.hwnd ?? '').trim();
  if (hwnd === '') return { ok: false, exitCode: null, text: 'hwnd 必填' };
  const argv = ['-File', guiScriptPath(cfg, 'place-window.ps1'), hwnd];
  if (args.virtual !== false) argv.push('-Virtual');
  if (Number.isFinite(args.x)) argv.push('-X', String(args.x));
  if (Number.isFinite(args.y)) argv.push('-Y', String(args.y));
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...argv], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `挪动失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function opGuiVdd(cfg, args = {}) {
  const action = String(args.action ?? 'status');
  // keeper 的生命周期跟虚拟屏绑定：add 会顺带把它拉起来，remove 会停掉并解除鼠标裁剪。
  const argv = ['-File', guiScriptPath(cfg, 'vdd.ps1')];
  if (action === 'add') argv.push('-Enable');
  else if (action === 'remove') argv.push('-Disable');
  else argv.push('-Status');
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...argv], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `VDD 操作失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function opGuiUia(cfg, args = {}) {
  const hwnd = String(args.hwnd ?? '').trim();
  if (hwnd === '') return { ok: false, exitCode: null, text: 'hwnd 必填（先用 gui_windows 拿）' };
  const cmd = String(args.cmd ?? 'tree');
  const argv = [];
  if (cmd === 'invoke') {
    argv.push('-File', guiScriptPath(cfg, 'uia-invoke.ps1'), hwnd);
    if (args.name) argv.push('-Name', String(args.name));
    if (args.automationId) argv.push('-AutomationId', String(args.automationId));
    if (args.type) argv.push('-Type', String(args.type));
    if (args.method) argv.push('-Method', String(args.method));
    if (args.value !== undefined) argv.push('-Value', String(args.value));
    if (Number.isFinite(args.index)) argv.push('-Index', String(args.index));
  } else {
    argv.push('-File', guiScriptPath(cfg, 'uia-tree.ps1'), hwnd, '-Json');
    if (Number.isFinite(args.maxDepth)) argv.push('-MaxDepth', String(args.maxDepth));
    if (Number.isFinite(args.maxNodes)) argv.push('-MaxNodes', String(args.maxNodes));
    if (args.onlyClickable === true) argv.push('-OnlyClickable');
  }
  // UIA invoke 虽然不动鼠标，但可能让目标窗口抢到焦点、也可能改掉输入法状态 ⇒ 同样做三级恢复
  if (cmd === 'invoke' && !realScreenAllowed(cfg, args)) return noVirtualScreen();
  const wantRestore = cmd === 'invoke' && args.restore !== false;
  if (wantRestore) envSnapshot(cfg);
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...argv], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `UIA 失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (wantRestore) envRestore(cfg, hwnd);
  }
}

async function opGuiClick(cfg, args = {}) {
  if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) return { ok: false, exitCode: null, text: 'x/y 必填（屏幕坐标，可负）' };
  const argv = ['-File', guiScriptPath(cfg, 'click-at.ps1'), String(args.x), String(args.y)];
  // 规则：任何鼠标操作都自带窗口激活；不给 hwnd 就只点坐标（会点到当前前台窗口）
  if (args.hwnd) argv.push('-Hwnd', String(args.hwnd));
  if (args.coord === 'window') argv.push('-Coord', 'window');
  if (args.button) argv.push('-Button', String(args.button));
  if (args.double === true) argv.push('-DoubleClick');
  if (args.restore === false) argv.push('-Restore:$false');
  // 三级恢复：点之前记住鼠标/焦点/输入法，点完还回去（click-at.ps1 本身只管鼠标）
  const wantRestore = args.restore !== false;
  if (wantRestore) envSnapshot(cfg);
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...argv], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `点击失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (wantRestore) envRestore(cfg, null);
  }
}

// ── 键盘输入 ────────────────────────────────────────────────────────────────
// 之前只有 gui_click 没有 gui_type ⇒ CEF 类程序（钉钉/微信桌面版）既没 UIA 也没 DOM，
// 就彻底没法操作（实战：钉钉搜索框点开了却打不进字，只能临时借 SendKeys）。
async function opGuiType(cfg, args = {}) {
  const text = String(args.text ?? '');
  if (text === '') return { ok: false, exitCode: null, text: 'text 必填' };
  if (!realScreenAllowed(cfg, args)) return noVirtualScreen();
  const argv = ['-File', guiScriptPath(cfg, 'type-text.ps1'), text];
  if (args.enter === true) argv.push('-Enter');
  if (args.escapes === true) argv.push('-Escapes');
  if (args.hwnd) argv.push('-Hwnd', String(args.hwnd));
  if (args.coord === 'window') argv.push('-Coord', 'window');
  if (args.restore === false) argv.push('-NoRestore');
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...argv], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `输入失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function opGuiVerify(cfg, args = {}) {
  const hwnd = String(args.hwnd ?? '').trim();
  // 审计 H1：这里原来接受任意 PowerShell 文本并交给 Invoke-Expression ⇒ 宿主进程任意代码执行。
  // 现在只接受「可执行文件 + 参数数组」，由 execFileSync 直接起进程（无 shell、无求值器）。
  const exe = String(args.exe ?? '').trim();
  if (hwnd === '' || exe === '') return { ok: false, exitCode: null, text: 'hwnd 与 exe 都必填（exe 是要在两次截图之间运行的可执行文件）' };
  const argv = ['-File', guiScriptPath(cfg, 'verify-action.ps1'), hwnd, '-Exe', exe];
  if (Array.isArray(args.args) && args.args.length > 0) { argv.push('-ExeArgs', ...args.args.map(String)); }
  if (Number.isFinite(args.threshold)) argv.push('-Threshold', String(args.threshold));
  if (Number.isFinite(args.settleMs)) argv.push('-SettleMs', String(args.settleMs));
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...argv], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `校验失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
async function opGuiBrowser(cfg, args = {}) {
  const cmd = String(args.cmd ?? 'tree');
  if (!['list', 'tree', 'click', 'type', 'eval'].includes(cmd)) return { ok: false, exitCode: null, text: `cmd 必须是 list/tree/click/type/eval` };
  const script = path.join(cfg.repo, 'tools', 'gui', 'cdp.mjs');
  if (!existsSync(script)) return { ok: false, exitCode: null, text: `找不到 ${script}` };
  const argv = [script, cmd, '--port', String(Number.isFinite(args.port) ? args.port : 9333)];
  for (const [key, flag] of [['target', 'target'], ['selector', 'selector'], ['text', 'text'], ['script', 'script'], ['limit', 'limit']]) {
    if (args[key] !== undefined && args[key] !== '') argv.push('--' + flag, String(args[key]));
  }
  try {
    const raw = execFileSync(process.execPath, argv, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `CDP 失败：${error instanceof Error ? error.message : String(error)}\n（浏览器要用 --remote-debugging-port 启动；Win10 上可直接用 gui_launch 配 args）` };
  }
}
const OPS = {
  gui_windows: opGuiWindows,
  gui_launch: opGuiLaunch,
  gui_place: opGuiPlace,
  gui_vdd: opGuiVdd,
  gui_browser: opGuiBrowser,
  gui_uia: opGuiUia,
  gui_click: opGuiClick,
  gui_verify: opGuiVerify,
  gui_type: opGuiType,
  gui_ops: opGuiOps,
  gui_capture: opGuiCapture,
  gui_zoom: opGuiZoom,
};

function tool(cfg, name, description, parameters, opName) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) },
      ],
    },
    async execute(args) {
      const started = Date.now();
      const result = await OPS[opName](cfg, args ?? {}, {});
      journalTool(name, args, result, Date.now() - started);
      return result;
    },
  };
}

// ── keeper 绑定到 DSH 生命周期 ──────────────────────────────────────────────
// 用户要求：DSH 启动就自动插虚拟屏；DSH 挂了，keeper 与虚拟屏一起消失。
// 所以 keeper 是**本进程的子进程**（不是 WMI 脱离进程，也不是独立服务）：
//   · apply() 起来 ⇒ 插屏 + 鼠标锁主屏
//   · 插件卸载/DSH 退出 ⇒ ctx.effect 的清理函数 kill 它 ⇒ 屏跟着消失
//   · DSH 被硬杀（kill -9）时清理函数不会跑 ⇒ keeper 自己带 -ParentPid 轮询父进程，父没了就自杀
let keeperChild = null;

function keeperAlive() {
  return Boolean(keeperChild && keeperChild.exitCode === null && !keeperChild.killed);
}

function startKeeper(cfg) {
  if (keeperAlive()) return keeperChild;
  const script = guiScriptPath(cfg, 'vdd.ps1');
  try { mkdirSync(tmpdir(), { recursive: true }); } catch {}
  keeperChild = spawn('pwsh', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, '-Serve', '-ParentPid', String(process.pid)], {
    stdio: 'ignore', windowsHide: true, detached: false,
  });
  keeperChild.on('exit', () => { keeperChild = null; });
  return keeperChild;
}

function stopKeeper() {
  if (!keeperChild) return;
  try { keeperChild.kill(); } catch { /* 已经没了 */ }
  keeperChild = null;
}

function buildToolDefinitions(cfg) {
  return [    tool(
      cfg,
      'gui_windows',
      'List top-level windows (handle, process, position, title). Entry point: everything else needs a handle.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          all: { type: 'boolean', description: 'Include invisible/helper windows. Default false keeps only real, visible, non-minimized windows.' },
        },
      },
      'gui_windows',
    ),
    tool(
      cfg,
      'gui_capture',
      'Capture ONE window by handle to PNG. Reads occluded windows; black for minimized/DRM/fullscreen. Never capture the whole screen.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['hwnd'],
        properties: {
          hwnd: { type: 'string', description: 'Window handle from gui_windows: decimal (`133728`) or hex (`0x20A60`).' },
          outFile: { type: 'string', description: 'Optional absolute output path; default is a timestamped file under %TEMP%\\dsh_gui.' },
          maxWidth: { type: 'number', description: 'Downscale so width does not exceed this (keeps aspect ratio). The model input cap is about 0.8 MP, so 900-1280 is a sane value.' },
          raise: { type: 'boolean', description: 'When PrintWindow returns black, force the window to the foreground and capture from screen instead. This steals focus from the user — only use it when the caller is alone. Without it the tool refuses rather than returning a wrong image.' },
        },
      },
      'gui_capture',
    ),
    tool(
      cfg,
      'gui_zoom',
      'Magnifier: image around one screen point with a crosshair, plus `origin` to map back to absolute coordinates. Use it instead of guessing coordinates.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y'],
        properties: {
          x: { type: 'number', description: 'Screen X (may be negative when a secondary display sits left of the primary).' },
          y: { type: 'number', description: 'Screen Y.' },
          size: { type: 'number', description: 'Edge length in pixels, default 100.' },
          scale: { type: 'number', description: 'Nearest-neighbour upscale factor, default 1; 2-4 helps read small text.' },
          outFile: { type: 'string', description: 'Optional absolute output path; default is a timestamped file under %TEMP%\\dsh_gui.' },
        },
      },
      'gui_zoom',
    ),
    tool(
      cfg,
      'gui_launch',
      'Start an allow-listed program and place its window on the virtual display without stealing focus. Protocols and arbitrary executables are refused; widen with config launchAllow.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['file'],
        properties: {
          file: { type: 'string', description: 'Executable: `notepad.exe`, `msedge.exe`, or an absolute path.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the program.' },
          waitSeconds: { type: 'number', description: 'How long to wait for the window to appear; default 15.' },
        },
      },
      'gui_launch',
    ),
    tool(
      cfg,
      'gui_place',
      'Move an existing window to the virtual display without activating it.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['hwnd'],
        properties: {
          hwnd: { type: 'string', description: 'Window handle from gui_windows.' },
          virtual: { type: 'boolean', description: 'Put it on the non-primary (virtual) screen. Default true.' },
          x: { type: 'number', description: 'Explicit left coordinate.' },
          y: { type: 'number', description: 'Explicit top coordinate.' },
        },
      },
      'gui_place',
    ),
    tool(
      cfg,
      'gui_vdd',
      'Manage the Parsec virtual display: status / add / remove. Needs a keeper process; never plug/unplug repeatedly (Windows rearranges all windows).',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['status', 'add', 'remove'], description: 'Operation; default status.' },
          index: { type: 'number', description: 'Display index to remove (as returned by add).' },
        },
      },
      'gui_vdd',
    ),
    tool(
      cfg,
      'gui_browser',
      'Chromium/Electron over CDP: tree / click / type / eval. No mouse movement, no focus change. Requires --remote-debugging-port.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          cmd: { type: 'string', enum: ['list', 'tree', 'click', 'type', 'eval'], description: 'Operation; default tree.' },
          port: { type: 'number', description: 'CDP port, default 9333 (launch the browser with --remote-debugging-port=9333).' },
          target: { type: 'string', description: 'Target id prefix; default the first page target.' },
          selector: { type: 'string', description: 'CSS selector for click/type.' },
          text: { type: 'string', description: 'Text for type.' },
          script: { type: 'string', description: 'Expression for eval.' },
          limit: { type: 'number', description: 'Max rows printed for tree; default 200.' },
        },
      },
      'gui_browser',
    ),
      tool(
        cfg,
        'gui_uia',
        'UI Automation: tree / invoke. Triggers native controls WITHOUT moving the mouse — prefer it over clicking. Chromium content is invisible here; use gui_browser.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['hwnd'],
          properties: {
            hwnd: { type: 'string', description: 'Window handle from gui_windows.' },
            cmd: { type: 'string', enum: ['tree', 'invoke'], description: 'tree (default) or invoke.' },
            name: { type: 'string', description: 'invoke: control name/text, e.g. "7" or "确定".' },
            automationId: { type: 'string', description: 'invoke: AutomationId, more stable than the label.' },
            type: { type: 'string', description: 'invoke: restrict to a ControlType such as Button.' },
            method: { type: 'string', enum: ['invoke', 'value', 'select'], description: 'invoke: pattern to use; default invoke.' },
            value: { type: 'string', description: 'invoke+method=value: text to write.' },
            index: { type: 'number', description: 'invoke: which match to use when several match; default 0.' },
            maxDepth: { type: 'number', description: 'tree: recursion depth; default 6.' },
            maxNodes: { type: 'number', description: 'tree: node cap; default 400.' },
            onlyClickable: { type: 'boolean', description: 'tree: only controls that support Invoke.' },
            allowRealScreen: { type: 'boolean', description: 'invoke: allow acting on the real screen when no virtual display exists (default false: refuse).' },
          },
        },
        'gui_uia',
      ),
      tool(
        cfg,
        'gui_click',
        'Click one screen point. Pass hwnd so the target window is activated first — the whole input then happens in that window, and the previous focus/cursor/IME are restored afterwards. Omit hwnd only when the right window is already focused.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: {
            x: { type: 'number', description: 'Screen X in the virtual-desktop coordinate space (may be negative).' },
            y: { type: 'number', description: 'Screen Y.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
            double: { type: 'boolean', description: 'Double click.' },
            hwnd: { type: 'string', description: 'Target window to activate before clicking. Strongly recommended: without it the click lands on whatever is currently focused (which may be the user window).' },
            coord: { type: 'string', enum: ['screen', 'window'], description: 'Coordinate space of x/y: screen (default, absolute virtual-desktop pixels) or window (relative to the target window, requires hwnd).' },
            restore: { type: 'boolean', description: 'Put the cursor back afterwards; default true.' },
            allowRealScreen: { type: 'boolean', description: 'Allow clicking on the real screen when no virtual display exists (default false: refuse).' },
          },
        },
        'gui_click',
      ),
      tool(
        cfg,
        'gui_verify',
        'Prove an action happened: capture, run one program, capture again, report changed/unchanged. Pass xe + rgs; arbitrary shell text is NOT accepted (audit H1). Never assume a click worked.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['hwnd', 'command'],
          properties: {
            hwnd: { type: 'string', description: 'Window handle to watch.' },
            command: { type: 'string', description: 'Command line to run between the two captures, e.g. "pwsh -File tools/gui/click-at.ps1 2000 300".' },
            threshold: { type: 'number', description: 'Percent of pixels that must change; default 0.1.' },
            settleMs: { type: 'number', description: 'Wait after the action before the second capture; default 600.' },
          },
        },
        'gui_verify',
      ),
      tool(
        cfg,
        'gui_type',
        "Type text into a window (Chinese OK, no IME needed), optionally followed by Enter. Pass `hwnd` to activate the target first; focus/cursor/IME are restored afterwards. The only way to drive apps that expose neither UIA nor DOM (DingTalk, WeChat desktop).",
        {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string', description: 'Text to type; with escapes:true, \\n and \\t become Enter/Tab.' },
            enter: { type: 'boolean', description: 'Press Enter after typing (sending a chat message).' },
            escapes: { type: 'boolean', description: 'Interpret \\n and \\t in text.' },
            hwnd: { type: 'string', description: 'Optional window to focus first; default the current foreground window.' },
            restore: { type: 'boolean', description: 'Restore cursor/focus/IME afterwards; default true.' },
            allowRealScreen: { type: 'boolean', description: "Allow acting on the user's real screen when no virtual display exists (default false: refuse)." },
          },
        },
        'gui_type',
      ),
      tool(
        cfg,
        'gui_ops',
        'List the most recent GUI operations (time, tool, ok, duration, arguments). Use it to answer "what did you actually do" instead of guessing.',
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'number', description: 'How many recent operations to show; default 20.' },
          },
        },
        'gui_ops',
      ),
    ];
}

// cordis 要求：直接访问 ctx.tools 前必须在插件顶层声明依赖的 service。
// 2026-11-04 修：缺这一行 ⇒ 预设挂载失败 ⇒ 所有含 gui 行的会话都无法 resume。
export const inject = ['tools'];

export async function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig);
  for (const definition of buildToolDefinitions(cfg)) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-gui: ${definition.name}`);
  }

  // 插件一加载就把虚拟屏和 keeper 拉起来（DSH 起来 = 屏就位）
  startKeeper(cfg);
  // DSH 退出/插件卸载时连带清理：留一个孤儿 keeper 等于留一块没人管的假屏
  ctx.effect(() => () => stopKeeper(), 'dsh-gui: vdd keeper lifetime');
}




















