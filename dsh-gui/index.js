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
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
    exitCode: { type: 'number' },
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

function guiOutPath(ext) {
  const dir = path.join(tmpdir(), 'dsh_gui');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `gui-${stamp}.${ext}`);
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
  const out = args.outFile ? path.resolve(String(args.outFile)) : guiOutPath('png');
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
  const out = args.outFile ? path.resolve(String(args.outFile)) : guiOutPath('png');
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

// ── 图形化：启动到虚拟屏 / 挪窗口 / 虚拟显示器 / 浏览器 CDP ────────────────
async function opGuiLaunch(cfg, args = {}) {
  const file = String(args.file ?? '').trim();
  if (file === '') return { ok: false, exitCode: null, text: 'file 必填（例如 notepad.exe）' };
  const argv = ['-File', guiScriptPath(cfg, 'launch-on-vd.ps1'), file];
  if (Array.isArray(args.args) && args.args.length > 0) argv.push('-Args', ...args.args.map(String));
  if (Number.isFinite(args.waitSeconds)) argv.push('-WaitSeconds', String(args.waitSeconds));
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...argv], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `启动失败：${error instanceof Error ? error.message : String(error)}` };
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
  const argv = ['-File', guiScriptPath(cfg, 'vdd.ps1')];
  if (action === 'add') argv.push('-Add');
  else if (action === 'remove') { argv.push('-Remove', String(Number.isFinite(args.index) ? args.index : 0)); }
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
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...argv], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `UIA 失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function opGuiClick(cfg, args = {}) {
  if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) return { ok: false, exitCode: null, text: 'x/y 必填（屏幕坐标，可负）' };
  const argv = ['-File', guiScriptPath(cfg, 'click-at.ps1'), String(args.x), String(args.y)];
  if (args.button) argv.push('-Button', String(args.button));
  if (args.double === true) argv.push('-DoubleClick');
  if (args.restore === false) argv.push('-Restore:$false');
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', ...argv], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return { ok: true, exitCode: 0, text: raw.trim() };
  } catch (error) {
    return { ok: false, exitCode: null, text: `点击失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function opGuiVerify(cfg, args = {}) {
  const hwnd = String(args.hwnd ?? '').trim();
  const command = String(args.command ?? '').trim();
  if (hwnd === '' || command === '') return { ok: false, exitCode: null, text: 'hwnd 与 command 都必填（command 是要执行的命令文本）' };
  const argv = ['-File', guiScriptPath(cfg, 'verify-action.ps1'), hwnd, '-Command', command];
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
      return await OPS[opName](cfg, args ?? {}, {});
    },
  };
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
      'Start a program and place its window on the virtual display without stealing focus, so the user never sees it.',
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
          },
        },
        'gui_uia',
      ),
      tool(
        cfg,
        'gui_click',
        'Click one screen point (real input, steals focus). Only when gui_uia/gui_browser cannot act; always pair with gui_verify.',
        {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: {
            x: { type: 'number', description: 'Screen X in the virtual-desktop coordinate space (may be negative).' },
            y: { type: 'number', description: 'Screen Y.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
            double: { type: 'boolean', description: 'Double click.' },
            restore: { type: 'boolean', description: 'Put the cursor back afterwards; default true.' },
          },
        },
        'gui_click',
      ),
      tool(
        cfg,
        'gui_verify',
        'Prove an action happened: capture, run command, capture, report changed/unchanged. Never assume a click worked.',
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
      ),  ];
}

// cordis 要求：直接访问 ctx.tools 前必须在插件顶层声明依赖的 service。
// 2026-11-04 修：缺这一行 ⇒ 预设挂载失败 ⇒ 所有含 gui 行的会话都无法 resume。
export const inject = ['tools'];

export async function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig);
  for (const definition of buildToolDefinitions(cfg)) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-gui: ${definition.name}`);
  }
}

