// 配置：默认值 + 工具链目录自动探测 + resolveConfig（唯一给 state.toolPathPrefix 赋值的地方）。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { state } from './state.js';

// 2026-10-25 去硬编码：默认值全部从"当前在哪"推导，换机不用改源码。
// 优先级：环境变量 > 推导值。目录布局固定为 <workspace>/dsh-plugins/dsh-picophone/lib
// ⇒ 从本文件上三级就是 workspace（原来的写死值就是它）。
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const DERIVED_ROOT = path.resolve(PKG_DIR, '..', '..', '..');
// pwsh 在 Windows 上装在 %LOCALAPPDATA%\Programs\PowerShell7；没有则退回系统 powershell。
const DERIVED_PWSH = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'PowerShell7', 'pwsh.exe')
  : 'powershell';

export const DEFAULTS = {
  root: process.env.DSH_PICOPHONE_ROOT || DERIVED_ROOT,
  repo: null,
  tempRoot: null,
  python: 'python',
  powershell: process.env.DSH_POWERSHELL || DERIVED_PWSH,
  timeoutMs: 900000,
  shortTimeoutMs: 120000,
  maxOutputChars: 14000,
  // 注入子进程 PATH 的额外目录；空 = 自动探测 ~\.pico-sdk（见 discoverToolDirs）
  extraPath: [],
  // 自动探测时优先挑这些版本，其余版本按名称倒序接在后面
  toolVersions: {
    cmake: 'v3.31.5',
    ninja: 'v1.12.1',
    toolchain: '15_2_Rel1',
    picotool: '2.3.0',
    openocd: '0.12.0+dev',
  },
  // 台架锁（#1）：串口与烧写互斥；默认落在 $DSH_HOME\picophone.lock（跨会话可见）
  lockPath: null,
  lockStaleMs: 600000,
  // profile 名：Host 里探不到时【手填】这个口子（写在 cordis.patch.yml 的 config 里）
  profileName: '',
  // 串口常驻会话（#3/#4/#7）
  sessionIdleMs: 120000,
  sessionOpenTimeoutMs: 20000,
  // 自动落盘的串口抓包最多留几份（只删 picophone_serial_*.txt 这一种）
  serialKeep: 20,
  // git over HTTPS 在沙箱下的两个前提（不是"开口子"，是把信任与凭据变成文件）
  gitSslCa: null,           // 默认 <root>\dsh-plugins\.certs\watt-ca.pem（本机代理 Watt Toolkit 的 CA）
  gitTokenFile: null,       // 默认 $DSH_HOME\.git-token（一行：user:token 或裸 token）
  gitCredentialsFile: null, // 默认 $DSH_HOME\.git-credentials（备用重试路径）
  trustDir: null,           // 默认 <工作区的父目录>\_picophone_trust ——【必须在工作区之外】
  // BOOTSEL 盘身份（#6）：DUT 与探针的引导盘长得几乎一样，写错就是烧错板
  boardIds: { dut: 'RP2350', probe: 'RPI-RP2', sampler: 'RPI-RP2' },
  devices: {
    dut: { vid: '2E8A', pid: '0009', serial: 'C7771D72049EEF63', note: 'RP2350B-Plus-W 待测板' },
    probe: { vid: '2E8A', pid: '000C', serial: '', note: 'RP2040 debugprobe（后门版）' },
    sampler: { vid: '2E8A', pid: '000A', serial: '503558607A848D9F', note: 'RP2040 core1_monitor 采样探针' },
  },
  // pico_exec 的白名单：只放构建/调试链，不放 shell。
  // 需要跑 pwsh/cmd 时走 pico_run（脚本被围栏在仓库 tools/ 内）。
  allowExec: [
    'cmake',
    'ninja',
    'git',
    'picotool',
    'openocd',
    'python',
    'py',
    'arm-none-eabi-gcc',
    'arm-none-eabi-g++',
    'arm-none-eabi-objdump',
    'arm-none-eabi-objcopy',
    'arm-none-eabi-nm',
    'arm-none-eabi-size',
    'vswhere',
    'msbuild',
    'node',
  ],
};

export function discoverToolDirs(cfg) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const sdk = path.join(home, '.pico-sdk');
  const dirs = [];

  const push = (dir) => {
    if (dir && existsSync(dir) && !dirs.includes(dir)) dirs.push(dir);
  };
  const versionsOf = (name) => {
    try {
      return readdirSync(path.join(sdk, name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  // 首选版本排最前，其它版本按名称倒序接在后面（未来换版本也不用改代码）
  const ordered = (name, preferred) => {
    const all = versionsOf(name);
    const first = all.filter((v) => v === preferred);
    return [...first, ...all.filter((v) => v !== preferred)];
  };

  for (const v of ordered('cmake', cfg.toolVersions?.cmake)) push(path.join(sdk, 'cmake', v, 'bin'));
  for (const v of ordered('ninja', cfg.toolVersions?.ninja)) push(path.join(sdk, 'ninja', v));
  for (const v of ordered('toolchain', cfg.toolVersions?.toolchain)) push(path.join(sdk, 'toolchain', v, 'bin'));
  for (const v of ordered('picotool', cfg.toolVersions?.picotool)) push(path.join(sdk, 'picotool', v, 'picotool'));
  for (const v of ordered('openocd', cfg.toolVersions?.openocd)) push(path.join(sdk, 'openocd', v));

  const installer = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
  );
  push(installer);
  // MSBuild 自己不在 PATH 上，问 vswhere 要 VS 安装路径再拼出来
  try {
    const vsPath = execFileSync(path.join(installer, 'vswhere.exe'), ['-latest', '-property', 'installationPath'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
    }).trim();
    if (vsPath) push(path.join(vsPath, 'MSBuild', 'Current', 'Bin'));
  } catch {
    /* 没有 vswhere 就算了，msbuild 会以 ENOENT 如实报出来 */
  }

  return dirs;
}

// ---------------------------------------------------------------- 基础工具

export function resolveConfig(raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const cfg = { ...DEFAULTS, ...given };
  cfg.root = path.resolve(String(cfg.root));
  cfg.repo = path.resolve(String(cfg.repo ?? path.join(cfg.root, 'DeepSeekCode')));
  cfg.tempRoot = path.resolve(String(cfg.tempRoot ?? tmpdir()));
  cfg.devices = { ...DEFAULTS.devices, ...(given.devices ?? {}) };
  cfg.allowExec = Array.isArray(cfg.allowExec) ? cfg.allowExec.map((s) => String(s).toLowerCase()) : DEFAULTS.allowExec;
  const extra = Array.isArray(cfg.extraPath) ? cfg.extraPath.map((s) => String(s)) : [];
  state.toolPathPrefix = [...extra, ...discoverToolDirs(cfg)].join(path.delimiter);
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  cfg.gitSslCa = cfg.gitSslCa ?? path.join(cfg.root, 'dsh-plugins', '.certs', 'watt-ca.pem');
  cfg.gitTokenFile = cfg.gitTokenFile ?? path.join(dshHome, '.git-token');
  cfg.gitCredentialsFile = cfg.gitCredentialsFile ?? path.join(dshHome, '.git-credentials');
  // 沙箱之外脚本的信任清单：默认放在【工作区的父目录】下（沙箱里的 Agent 写不到那里）
  cfg.trustDir = cfg.trustDir ?? path.join(path.dirname(path.resolve(cfg.root)), '_picophone_trust');
  return cfg;
}
