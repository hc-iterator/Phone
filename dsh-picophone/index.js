/**
 * dsh-picophone —— PicoPhone 台架能力包（Host 插件）
 *
 * 目的：把上一届 AI 每轮都要手打的那批接口，和几类常见的越权访问，
 * 做成 Harness 里可以直接调用的能力。
 *
 *   ① Agent 工具（9 个）：pico_status / pico_build / pico_flash / pico_serial /
 *      pico_console / pico_temp / pico_git / pico_run / pico_exec
 *   ② 人工命令（1 个）：/pico —— 上面全部能力的命令行入口，外加 swd / procs /
 *      docs / agents 四个只在命令里出现的子命令
 *
 * 「越权」的含义：本插件在 Host 进程里直接 spawn，不经过会话 shell 的沙箱，
 * 所以 CMake/ninja/VS 工具链、烧写 uf2、读串口、%TEMP% 读写都能真正落地。
 * 代价是这些能力不受沙箱约束 —— 因此每一项都带硬超时、白名单与路径围栏。
 *
 * 所有子进程 windowsHide:true（不弹窗），超时后杀整棵进程树。
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-picophone';
export const inject = ['tools'];

const DEFAULTS = {
  root: 'C:\\Users\\Chen\\Desktop\\Pico\\PicoPhone',
  repo: null,
  tempRoot: null,
  python: 'python',
  powershell: 'pwsh',
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

// 子进程要用的 PATH 前缀：系统 PATH 里没有 ninja / openocd / arm-none-eabi-* / vswhere，
// 而它们都躺在 ~\.pico-sdk 与 VS 安装目录下 ⇒ 在这里补上，否则 pico_exec 会 ENOENT。
let toolPathPrefix = '';

function discoverToolDirs(cfg) {
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

function resolveConfig(raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const cfg = { ...DEFAULTS, ...given };
  cfg.root = path.resolve(String(cfg.root));
  cfg.repo = path.resolve(String(cfg.repo ?? path.join(cfg.root, 'DeepSeekCode')));
  cfg.tempRoot = path.resolve(String(cfg.tempRoot ?? tmpdir()));
  cfg.devices = { ...DEFAULTS.devices, ...(given.devices ?? {}) };
  cfg.allowExec = Array.isArray(cfg.allowExec) ? cfg.allowExec.map((s) => String(s).toLowerCase()) : DEFAULTS.allowExec;
  const extra = Array.isArray(cfg.extraPath) ? cfg.extraPath.map((s) => String(s)) : [];
  toolPathPrefix = [...extra, ...discoverToolDirs(cfg)].join(path.delimiter);
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  cfg.gitSslCa = cfg.gitSslCa ?? path.join(cfg.root, 'dsh-plugins', '.certs', 'watt-ca.pem');
  cfg.gitTokenFile = cfg.gitTokenFile ?? path.join(dshHome, '.git-token');
  cfg.gitCredentialsFile = cfg.gitCredentialsFile ?? path.join(dshHome, '.git-credentials');
  // 沙箱之外脚本的信任清单：默认放在【工作区的父目录】下（沙箱里的 Agent 写不到那里）
  cfg.trustDir = cfg.trustDir ?? path.join(path.dirname(path.resolve(cfg.root)), '_picophone_trust');
  return cfg;
}

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** PowerShell 的 Write-Host 颜色在重定向后仍会留下 ANSI 转义，去掉它免得污染上下文。 */
function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

function decodeBuffer(buffer) {
  if (!buffer || buffer.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}

function clip(text, max) {  const t = String(text ?? '').replace(/\r\n/g, '\n');
  if (t.length <= max) return t;
  const head = t.slice(0, Math.floor(max * 0.6));
  const tail = t.slice(-Math.floor(max * 0.4));
  return `${head}\n... [省略 ${t.length - max} 字符] ...\n${tail}`;
}

/** 给自动落盘的文件起个不会撞名的后缀。 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 自动落盘的抓包会越攒越多（每读一次一份）⇒ 只留最近 serialKeep 份。
 * 只认 picophone_serial_*.txt 这个名字形状，别的文件一律不碰；失败也不影响结果。
 */
function pruneSerialCaptures(cfg) {
  const keep = Number.isFinite(cfg.serialKeep) ? cfg.serialKeep : 20;
  try {
    const files = readdirSync(cfg.tempRoot)
      .filter((name) => /^picophone_serial_.*\.txt$/.test(name))
      .map((name) => {
        const full = path.join(cfg.tempRoot, name);
        try {
          return { full, mtime: statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(keep)) {
      try {
        unlinkSync(file.full);
      } catch {
        /* 尽力而为 */
      }
    }
  } catch {
    /* 清理失败不影响这次读取的结果 */
  }
}

function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* 尽力而为 */
  }
}

/** 跑一个进程：硬超时、隐藏窗口、捕获输出、超时杀整棵树。 */
// ---------------------------------------------------------------- 沙箱（2026-10-06 实测后加）

// ⚠️ 必须是**硬编码常量**：实测证明 ctx.shell.resolve 不做上限压制 ——
//    插件请求 danger-full-access 就被采纳、越界写就成功了（见 DeepSeekCode\台架接口沙箱化说明.md §四.1）。
//    ⇒ 沙箱约束的是"借出去的手"，不防插件作者；插件源码本身仍靠 git diff / 人眼兜底。
const SANDBOX_MODE = 'workspace-write';

// 由 apply() 填：{ shell, workspaceRoot }
let sandboxContext = null;

// ---------------------------------------------------------------- 脚本信任登记（2026-10-07 红队突破后加）

// 为什么需要：上面的沙箱只管得住"经 ctx.shell 出去的"那些命令；但豁免沙箱的那 7 处 op
// （build / serial / console / flash / swd / procs / status 的 proc_guard）跑的是
// 【工作区里的脚本】，而工作区正是被沙箱关住的那个 Agent **唯一能写的地方** ⇒
// "把 payload 写进 tools\proc_guard.ps1，再调 pico_status" 就是一条【不过沙箱】的任意代码执行。
// 办法：把这几个脚本的 SHA256 钉在【工作区之外】，每次执行前核对；不符 ⇒ 拒绝执行。
// ⚠️ 登记入口只做在 /pico 命令里（人敲），**不做成工具** —— 否则 AI 自己就能把恶意脚本登记掉。
// （createHash 在文件顶部已经 import 过，这里别再引一次 —— 重复声明会直接 SyntaxError。）
const TRUSTED_REPO_TOOLS_REL = [
  'tools/build.cmd',
  'tools/build_sub.ps1',
  'tools/serial.ps1',
  'tools/flash_bootsel.ps1',
  'tools/flash_backdoor.ps1',
  'tools/swd.ps1',
  'tools/proc_guard.ps1',
];

// ⚠️ 会话 worker **不在 `tools/` 里** —— 它是插件自己的文件（见下面 `path.join(PACKAGE_DIR, …)`）。
//    2026-10-07 实测踩到：原先这里写了 `tools/serial-session.ps1`（不存在 ⇒ 永远"读不到"），
//    而真正的 worker 是【直接 spawn】的、不过信任门 ⇒ 那是一条真口子（改 worker = 沙箱外任意代码）。
const TRUSTED_PLUGIN_REL = ['dsh-plugins/dsh-picophone/serial-session.ps1'];

/**
 * 受管脚本的清单键 = **相对 `cfg.root`** 的路径（与 `relToRoot()` 同一口径）。
 * ⚠️ 别再写死 `'tools/xxx'`：脚本其实在 `<root>\DeepSeekCode\tools\` 下，
 *    写死会让 `/pico trust init` 一个都找不到、登记不上，门就永远拒着（2026-10-07 实测踩到）。
 */
function trustedScripts(cfg) {
  const prefix = path.relative(cfg.root, cfg.repo).split(path.sep).join('/');
  return [...TRUSTED_REPO_TOOLS_REL.map((rel) => (prefix ? `${prefix}/${rel}` : rel)), ...TRUSTED_PLUGIN_REL];
}

// ---------------------------------------------------------------- 运行本（Pico 文件夹里的常设副本）

// 红队审计（2026-10-07）确认：豁免沙箱的 op 跑的是【工作区里的脚本】，而工作区正是被关住的
// Agent 唯一能写的地方 ⇒ 改脚本 / 改子脚本 / 改构建输入 = 窗外任意代码执行（缺口 ①②③）。
// 用户裁定：tools\ 只当【源码】（不运行）；Pico 文件夹里常设一份【运行本】，插件只跑运行本；
// AI 想改 ⇒ 走 pico_amend（一次性审判员）⇒ 合理则同步进运行本，否则用运行本覆盖回去。
function runtimeRoot(cfg) {
  return path.join(cfg.trustDir, 'runtime');
}

/** 工作区文件 → 运行本路径（相对 <工作区的父目录> 保形 ⇒ 映射唯一、可预测）。 */
function runtimePath(cfg, file) {
  return path.join(runtimeRoot(cfg), path.relative(path.dirname(path.resolve(cfg.repo)), path.resolve(file)));
}

/** 把工作区文件同步进运行本（人批准 / 审判员通过后调用）。返回运行本路径。 */
function syncToRuntime(cfg, file) {
  const dst = runtimePath(cfg, file);
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, readFileSync(file)); // 用 read/write 而不是 copyFileSync：后者本文件没 import
  return dst;
}

/** 递归拷目录（只用已 import 的 fs：readdirSync / mkdirSync / readFileSync / writeFileSync）。 */
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

/** 所有受管脚本的指纹是否都与登记一致。 */
function treeIsTrusted(cfg) {
  return trustedScripts(cfg).every((rel) => trustVerdict(cfg, path.join(cfg.root, rel)).ok);
}

/**
 * 建/刷新【运行本树】：
 *   runtime\<相对 <工作区父目录> 的路径>\  = 真仓库的骨架（除 tools\ 外全部 junction/硬链接回真身，
 *                                          一次性由人建好 ⇒ 脚本用 %~dp0 推树时看到的是【真树】）
 *                                        + tools\ 的【整棵副本】（含子脚本 ⇒ 缺口②结构性消失）
 * 只有全部受管指纹一致才允许刷新；否则返回 null（fail-closed）。
 */
let runtimeTreeKey = '';
function ensureRuntimeTree(cfg) {
  if (!treeIsTrusted(cfg)) return null;
  const rtRepo = path.join(runtimeRoot(cfg), path.relative(path.dirname(path.resolve(cfg.repo)), path.resolve(cfg.repo)));
  const key = trustedScripts(cfg).map((rel) => sha256Of(path.join(cfg.root, rel))).join(':');
  const workerSrc = path.join(PACKAGE_DIR, 'serial-session.ps1');
  const workerDst = runtimePath(cfg, workerSrc);
  if (key === runtimeTreeKey && existsSync(path.join(rtRepo, 'tools')) && existsSync(workerDst)) return rtRepo;
  mkdirSync(rtRepo, { recursive: true });
  copyTree(path.join(cfg.repo, 'tools'), path.join(rtRepo, 'tools'));
  // 插件自己的会话 worker【不在仓库里】：按同一套映射单独抄一份
  // （否则 pico_console 会报"运行本不可用" —— 2026-10-07 实测踩到）
  if (existsSync(workerSrc)) {
    mkdirSync(path.dirname(workerDst), { recursive: true });
    writeFileSync(workerDst, readFileSync(workerSrc));
  }
  runtimeTreeKey = key;
  return rtRepo;
}

/** 拿"该跑的那一份"（运行本树里的同路径文件）。null = 不能跑（fail-closed）。 */
function resolveRuntimeScript(cfg, file) {
  const dst = runtimePath(cfg, file);
  // ⚠️ 必须【先用已存在的运行本】：工作区被改脏（比如正在等审判员裁决）是【正常状态】，
  //    不该让全部窗外 op 一起瘫 —— 2026-10-07 实测：改一个受管脚本后连 proc_guard 都不跑了。
  if (existsSync(dst)) return dst;
  if (!ensureRuntimeTree(cfg)) return null;
  return existsSync(dst) ? dst : null;
}

function trustFilePath(cfg) {  return path.join(cfg.trustDir, 'trusted-scripts.json');
}

/** 信任清单【必须】在工作区之外：否则被关住的 Agent 连清单一起改，这层就白加了。 */
function trustDirIsSafe(cfg) {
  const root = path.resolve(cfg.root).toLowerCase().replace(/[\\/]+$/, '');
  const dir = path.resolve(cfg.trustDir).toLowerCase();
  return !(dir === root || dir.startsWith(`${root}${path.sep}`));
}

function relToRoot(cfg, file) {
  return path.relative(cfg.root, file).split(path.sep).join('/');
}

function sha256Of(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function loadTrust(cfg) {
  try {
    const parsed = JSON.parse(readFileSync(trustFilePath(cfg), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.scripts ? parsed : { version: 1, scripts: {} };
  } catch {
    return null; // 不存在或读不了 ⇒ 一律按"未登记"处理（fail-closed）
  }
}

/** 只登记一个文件的当前指纹（审批通过后调用）。返回是否写成功。 */
function registerTrust(cfg, file) {
  const now = sha256Of(file);
  if (!now) return false;
  try {
    mkdirSync(cfg.trustDir, { recursive: true });
    const manifest = loadTrust(cfg) ?? { version: 1, scripts: {} };
    manifest.scripts[relToRoot(cfg, file)] = { sha256: now, registeredAt: new Date().toISOString() };
    writeFileSync(trustFilePath(cfg), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 指纹不符时的【提权申请】：走 DSH 的 approval 服务 —— **AI 发起、人点同意**，人不敲任何命令。
 * 契约（`Service.listService approval`，2026-10-07 查证）：
 *   `request({ agent, toolName, callId?, reason?, displayReason?, signal? }) → 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
 *   · 必须在**打开的 turn** 里调用（工具调用过程中满足）；每次 ask/outcome 都写进会话日志；
 *   · 没有应答者 / 策略为 `never` ⇒ `'unavailable'`（fail-closed）。
 * ⇒ 这里【只有 `allowed-once` 算放行】，其余一律保持拒绝；异常也当 `unavailable` 处理。
 */
async function askTrustApproval(cfg, file, opts = {}) {
  const service = cfg.approval;
  const verdict = trustVerdict(cfg, file);
  // ⚠️ 插件级 ctx **没有**会话上下文：直接 currentSessionId(cfg.pluginCtx) 会抛
  //    `cannot get property "sessionId" without inject`（2026-10-07 实测，且连带漏了一把台架锁）。
  //    ⇒ 包起来；拿不到身份就 fail-closed（拒绝），绝不误放行。
  let sid = '';
  try {
    sid = cfg.pluginCtx ? String(currentSessionId(cfg.pluginCtx) ?? '') : '';
  } catch {
    sid = '';
  }
  const agent = cfg.currentAgent ?? (/^[\w.:-]{8,}$/.test(sid) && !sid.startsWith('(') ? { id: sid } : undefined);
  if (!service || typeof service.request !== 'function') return { outcome: 'unavailable', verdict, detail: '审批服务不可用（ctx.approval 没拿到）' };
  if (!agent) return { outcome: 'unavailable', verdict, detail: '拿不到发起审批所需的 agent（这条链没接上 ⇒ 保持拒绝）' };
  const reason = [
    `【沙箱外脚本】内容与登记指纹不符，需要你认可才继续：${verdict.rel}`,
    `原因：${verdict.why}`,
    `旧指纹：${verdict.want ? verdict.want.slice(0, 16) : '(未登记)'}   →   新指纹：${verdict.now ? verdict.now.slice(0, 16) : '(读不到)'}`,
    `文件：${file}`,
    `要看改了什么：git -C ${cfg.repo} diff -- ${verdict.rel.split('/').slice(1).join('/')}`,
    opts.extra ? String(opts.extra) : '',
  ].filter(Boolean).join('\n');
  try {
    const outcome = await service.request({
      agent,
      toolName: opts.toolName ?? 'pico_run',
      reason,
      displayReason: {
        en: `An unsandboxed script changed: ${verdict.rel} (${verdict.why}). Approve to re-register its hash and continue.`,
      },
    });
    return { outcome, verdict };
  } catch (error) {
    return { outcome: 'unavailable', verdict, detail: `审批调用失败: ${error && error.message ? error.message : error}` };
  }
}

/** 返回 { ok, rel, now, want, why }。ok=false 时调用方必须拒绝执行。 */
function trustVerdict(cfg, file) {
  const rel = relToRoot(cfg, file);
  const now = sha256Of(file);
  if (!trustDirIsSafe(cfg)) return { ok: false, rel, now, want: null, why: '信任清单目录被配到了工作区【之内】（它必须在工作区之外，否则这层形同虚设）' };
  const manifest = loadTrust(cfg);
  const rec = manifest?.scripts?.[rel];
  if (!now) return { ok: false, rel, now, want: rec?.sha256 ?? null, why: '文件读不到' };
  if (!manifest) return { ok: false, rel, now, want: null, why: '清单不存在（这些脚本还没登记过）' };
  if (!rec) return { ok: false, rel, now, want: null, why: '未登记' };
  if (rec.sha256 !== now) return { ok: false, rel, now, want: rec.sha256, why: '已变更（登记之后又被改过）' };
  return { ok: true, rel, now, want: rec.sha256, why: '匹配' };
}

/** 拒绝执行时给的那段话 —— 它必须自解释：说清原因、给出现在值与登记值、给出人该敲什么。 */
function trustRefusal(cfg, file) {
  const v = trustVerdict(cfg, file);
  return [
    `⛔ 拒绝执行【沙箱之外】的脚本：${v.rel}`,
    `   原因：${v.why}`,
    `   当前 sha256_16 = ${v.now ? v.now.slice(0, 16) : '(读不到)'}`,
    `   登记值         = ${v.want ? v.want.slice(0, 16) : '(无)'}`,
    '',
    '   这类脚本必须跑在沙箱外（要碰设备 / 要跑 cmake），所以它的内容必须是【人认可过的】：',
    '   现在 AI 会自己弹审批给你（approval）；被拒或审批不可用时，也可以人敲 /pico 命令手动盖章：',
    '     /pico trust                             # 看全部受管脚本的登记状态',
    `     /pico trust ${v.rel}`,
    '     /pico trust init                        # 全部重新登记',
    `   清单位置（工作区之外）：${trustFilePath(cfg)}`,
  ].join('\n');
}

async function opTrust(cfg, args = {}) {
  const action = String(args.action ?? 'list').toLowerCase();
  if (!trustDirIsSafe(cfg)) {
    return { kind: 'error', text: `✗ 信任清单必须放在工作区之外；当前配置 ${cfg.trustDir} 在工作区之内 ⇒ 拒绝登记。` };
  }
  const names = action === 'init' ? trustedScripts(cfg) : action === 'list' ? [] : [String(args.name ?? '')].filter(Boolean);
  if (names.length > 0) {
    const manifest = loadTrust(cfg) ?? { version: 1, scripts: {} };
    mkdirSync(cfg.trustDir, { recursive: true });
    const lines = [];
    for (const rel of names) {
      const now = sha256Of(path.join(cfg.root, rel));
      if (!now) { lines.push(`✗ ${rel}  读不到`); continue; }
      manifest.scripts[rel] = { sha256: now, registeredAt: new Date().toISOString() };
      try { syncToRuntime(cfg, path.join(cfg.root, rel)); } catch { /* 同步失败不影响登记 */ }
      lines.push(`✓ ${rel}  →  ${now.slice(0, 16)}…（已同步进运行本）`);
    }
    try {
      writeFileSync(trustFilePath(cfg), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    } catch (error) {
      return { kind: 'error', text: `✗ 写清单失败: ${error && error.message ? error.message : error}` };
    }
    return { kind: 'success', text: `已登记 ${lines.length} 个脚本\n清单：${trustFilePath(cfg)}\n${lines.join('\n')}` };
  }
  const rows = trustedScripts(cfg).map((rel) => {
    const v = trustVerdict(cfg, path.join(cfg.root, rel));
    const mark = v.ok ? '✓ 匹配  ' : v.want ? '✗ 已变更' : '· 未登记';
    const detail = v.ok ? '' : `   当前 ${v.now ? v.now.slice(0, 8) : '(读不到)'} / 登记 ${v.want ? v.want.slice(0, 8) : '无'}`;
    return `  ${mark}  ${rel}${detail}`;
  });
  const exists = loadTrust(cfg) ? '' : '（清单还不存在 ⇒ 上面这些都会被执行时拒绝）';
  return {
    kind: 'success',
    text: [
      '沙箱之外脚本的信任登记：',
      `  清单 ${trustFilePath(cfg)}  ${exists}`,
      '',
      ...rows,
      '',
      '重新登记：/pico trust <相对路径>    或    /pico trust init（全部）',
    ].join('\n'),
  };
}

/** 走 DSH 的 OS 级沙箱执行器（Windows = 路径 ACL + 受限令牌）。 */
async function runSandboxedCommand(command, options = {}) {
  const shell = sandboxContext?.shell;
  const started = Date.now();
  if (!shell) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      durationMs: 0,
      spawnError: '沙箱执行器不可用（ctx.shell 缺失）—— 未执行任何命令',
    };
  }
  try {
    // ⚠️ 沙箱路径【必须自己注入环境】—— 实测走 ctx.shell 时：
    //    ① `Get-Command ninja` / `arm-none-eabi-gcc` 都是空（它用系统 PATH，不是我们给子进程拼的前缀）；
    //    ② 连 `$env:DSH_HOME` 都没有 ⇒ 依赖它的脚本（如 tools\clear_rig_lock.ps1）会看错地方、报假 FREE。
    const envPrefix = [];
    if (toolPathPrefix && !/^\s*\$env:PATH\s*=/.test(command)) {
      envPrefix.push(`$env:PATH = ${quoteAlways(`${toolPathPrefix}${path.delimiter}`)} + $env:PATH;`);
    }
    if (process.env.DSH_HOME) envPrefix.push(`$env:DSH_HOME = ${quoteAlways(process.env.DSH_HOME)};`);
    if (process.env.DSH_PROFILE) envPrefix.push(`$env:DSH_PROFILE = ${quoteAlways(process.env.DSH_PROFILE)};`);
    const withEnv = envPrefix.length > 0 ? `${envPrefix.join(' ')} ${command}` : command;
    const spec = shell.resolve({
      command: withEnv,
      workdir: options.cwd ?? sandboxContext.workspaceRoot,
      timeoutMs: options.timeoutMs ?? DEFAULTS.shortTimeoutMs,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      sandboxPolicy: { mode: SANDBOX_MODE, workspaceRoot: sandboxContext.workspaceRoot },
    });
    const execution = await shell.execute(spec);
    const result = await execution.result();
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      aborted: Boolean(result.aborted),
      stdout: stripAnsi(result.stdout?.text ?? ''),
      stderr: stripAnsi(result.stderr?.text ?? ''),
      durationMs: Date.now() - started,
      sandbox: result.sandbox ?? null,
      command,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      spawnError: `沙箱执行失败: ${error && error.message ? error.message : error}`,
      command,
    };
  }
}

/** 给 PowerShell 命令串做参数引用（沙箱路径要把 argv 拼成一条命令）。 */
function quoteArg(value) {
  const text = String(value);
  if (text === '') return "''";
  if (!/[\s"'`$&|<>();,{}\[\]]/.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * 【强制】单引号 —— 专给"环境变量赋值"用。
 * 实测教训：`$env:DSH_HOME = C:\固态盘秘钥\.dsh;` 这种裸词赋值会被 PowerShell **当成命令**去执行
 * （报 "not recognized as a name of a cmdlet"），变量根本没赋上。引用成 'C:\...' 才稳。
 */
function quoteAlways(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 把 (可执行文件, argv) 拼成一条命令串。
 * ⚠️ 输出必须"直通"：实测在 pwsh 里捕获原生程序输出会走 .NET 命名管道 `\\.\pipe\LOCAL\dotnet_*`，
 *    而那条路在沙箱里是【被拒】的（说明文件 §三 第 2 条）。所以这里绝不加 `| cmdlet`、也绝不赋值。
 */
function buildCommandLine(file, args) {
  const list = (args ?? []).map(quoteArg).join(' ');
  const kind = shellFor(file);
  if (kind === 'ps1') return `${quoteArg('pwsh')} -NoProfile -NonInteractive -File ${quoteArg(file)}${list ? ` ${list}` : ''}`;
  if (kind === 'cmd') return `cmd /c ${quoteArg(file)}${list ? ` ${list}` : ''}`;
  if (kind === 'py') return `python ${quoteArg(file)}${list ? ` ${list}` : ''}`;
  return `& ${quoteArg(file)}${list ? ` ${list}` : ''}`;
}

function runProcess(file, args, options = {}) {
  const { cwd, timeoutMs = DEFAULTS.shortTimeoutMs, signal, env, input } = options;
  if (options.sandbox === true) {
    return runSandboxedCommand(buildCommandLine(file, args), { cwd, timeoutMs, stdin: input });
  }
  const started = Date.now();
  const childEnv = spawnEnv(env);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        windowsHide: true,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        exitCode: null,
        timedOut: false,
        spawnError: String(error && error.message ? error.message : error),
        stdout: '',
        stderr: '',
        durationMs: Date.now() - started,
      });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    const CAP = 4 * 1024 * 1024;
    child.stdout.on('data', (d) => {
      if (outBytes < CAP) {
        outChunks.push(d);
        outBytes += d.length;
      }
    });
    child.stderr.on('data', (d) => {
      if (errBytes < CAP) {
        errChunks.push(d);
        errBytes += d.length;
      }
    });

    let settled = false;
    let timedOut = false;
    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeoutMs)
        : null;
    const onAbort = () => killTree(child);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal: sig ?? null,
        timedOut,
        aborted: Boolean(signal && signal.aborted),
        stdout: stripAnsi(decodeBuffer(Buffer.concat(outChunks))),
        stderr: stripAnsi(decodeBuffer(Buffer.concat(errChunks))),
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        ok: false,
        exitCode: null,
        timedOut,
        spawnError: String(error && error.message ? error.message : error),
        stdout: stripAnsi(decodeBuffer(Buffer.concat(outChunks))),
        stderr: stripAnsi(decodeBuffer(Buffer.concat(errChunks))),
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (code, sig) => finish(code, sig));

    try {
      if (input !== undefined && input !== null) child.stdin.end(String(input));
      else child.stdin.end();
    } catch {
      /* stdin 可能已关闭 */
    }
  });
}

function describeRun(label, result, cfg, extra = {}) {
  const lines = [];
  const bits = [`exit=${result.exitCode === null ? 'n/a' : result.exitCode}`];
  if (result.timedOut) bits.push('TIMEOUT');
  if (result.aborted) bits.push('ABORTED');
  if (result.spawnError) bits.push(`spawnError=${result.spawnError}`);
  if (result.sandbox) bits.push(`sandbox=${JSON.stringify(result.sandbox)}`);
  bits.push(`${result.durationMs}ms`);
  lines.push(`[${label}] ${bits.join(' ')}`);
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`);
  if (result.stdout && result.stdout.trim()) lines.push('--- stdout ---', clip(result.stdout.trim(), cfg.maxOutputChars));
  if (result.stderr && result.stderr.trim()) lines.push('--- stderr ---', clip(result.stderr.trim(), cfg.maxOutputChars));
  if (!result.stdout.trim() && !result.stderr.trim()) lines.push('(无输出)');
  return lines.join('\n');
}

function shellFor(scriptPath) {
  const ext = path.extname(scriptPath).toLowerCase();
  if (ext === '.ps1') return 'ps1';
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.py') return 'py';
  return 'other';
}

/** 跑仓库内的脚本：.ps1 -> pwsh、.cmd/.bat -> cmd、.py -> python。 */
async function runProjectScript(cfg, scriptPath, args, options = {}) {
  if (options.sandbox !== true) {
    // 【信任门】沙箱之外的脚本先与工作区外的哈希清单核对；不符 ⇒ **发起审批**（AI 问、人答），
    // 批了就地登记并继续；没批/审批不可用 ⇒ 保持拒绝（fail-closed）。
    // 沙箱化的调用（run/exec/docs/agents）不走这里 —— 它们本来就跑在沙箱里，随便改无所谓。
    let verdict = trustVerdict(cfg, scriptPath);
    let askNote = '';
    if (!verdict.ok) {
      const ask = await askTrustApproval(cfg, scriptPath, { toolName: options.toolName });
      if (ask.outcome === 'allowed-once' && registerTrust(cfg, scriptPath)) {
        verdict = trustVerdict(cfg, scriptPath);
        askNote = '（已按你的同意重新登记指纹）';
      } else {
        askNote = `（审批结果：${ask.outcome}${ask.detail ? ` — ${ask.detail}` : ''}）`;
      }
    }
    if (!verdict.ok) {
      return {
        ok: false,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        durationMs: 0,
        spawnError: `${trustRefusal(cfg, scriptPath)}\n\n${askNote}`,
      };
    }
    // 【运行本】指纹过了还不够：真正要跑的是 Pico 文件夹里那一份（工作区那份只是源码）。
    const resolvedRuntime = resolveRuntimeScript(cfg, scriptPath);
    if (!resolvedRuntime) {
      return {
        ok: false,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        durationMs: 0,
        spawnError: `⛔ 运行本不可用：${relToRoot(cfg, scriptPath)}\n（工作区版本与登记指纹不一致，运行本里也没有对应的一份）\n⇒ 先 /pico trust <路径> 登记，或用 pico_amend 提交改动让审判员裁决。`,
      };
    }
    scriptPath = resolvedRuntime;
  }
  if (options.sandbox === true) {
    return runSandboxedCommand(buildCommandLine(scriptPath, args), {
      cwd: options.cwd ?? cfg.repo,
      timeoutMs: options.timeoutMs,
      stdin: options.input,
    });
  }
  const kind = shellFor(scriptPath);
  const cwd = options.cwd ?? cfg.repo;
  if (kind === 'ps1') {
    return runProcess(cfg.powershell, ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args], { ...options, cwd });
  }
  if (kind === 'cmd') {
    return runProcess('cmd', ['/c', scriptPath, ...args], { ...options, cwd });
  }
  if (kind === 'py') {
    return runProcess(cfg.python, [scriptPath, ...args], { ...options, cwd });
  }
  return Promise.resolve({
    ok: false,
    exitCode: null,
    timedOut: false,
    spawnError: `不支持的脚本类型: ${scriptPath}`,
    stdout: '',
    stderr: '',
    durationMs: 0,
  });
}

function tailFile(file, lines, cfg) {
  try {
    const text = decodeBuffer(readFileSync(file));
    const all = text.split(/\r?\n/);
    return clip(all.slice(-lines).join('\n'), cfg.maxOutputChars);
  } catch (error) {
    return `(读不到 ${file}: ${error && error.message ? error.message : error})`;
  }
}

function artifactInfo(file) {
  try {
    const st = statSync(file);
    return `${file}  ${st.size} B  ${st.mtime.toISOString()}`;
  } catch {
    return `${file}  (不存在)`;
  }
}

function listUf2(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.uf2'))
      .map((f) => artifactInfo(path.join(dir, f)))
      .join('\n');
  } catch {
    return `(目录不存在: ${dir})`;
  }
}

function safeTempPath(cfg, rel) {
  const target = path.resolve(cfg.tempRoot, rel === undefined || rel === null || rel === '' ? '.' : String(rel));
  if (!isInside(cfg.tempRoot, target)) throw new Error(`路径越出 %TEMP%: ${rel}`);
  return target;
}

function resolveRepoArg(cfg, repo) {
  const key = String(repo ?? 'main').trim();
  if (key === '' || key === 'main' || key === 'DeepSeekCode') return cfg.repo;
  const dir = path.resolve(cfg.root, '_agents', key);
  if (!isInside(path.join(cfg.root, '_agents'), dir)) throw new Error(`非法空间名: ${key}`);
  if (!existsSync(dir)) throw new Error(`空间不存在: ${dir}`);
  return dir;
}

function gitArgsFor(cfg, dir) {
  return ['-c', `safe.directory=${cfg.root.replace(/\\/g, '/')}/*`, '-C', dir];
}

// ---------------------------------------------------------------- 台架锁（#1）

/** 锁文件：默认 $DSH_HOME\picophone.lock —— 放在 profile 之外，任何会话都看得见。 */
function lockFilePath(cfg) {
  if (cfg.lockPath) return path.resolve(String(cfg.lockPath));
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return path.join(home, 'picophone.lock');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function readLockFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function lockHolderText(info) {
  if (!info) return '(锁文件在，但读不出来)';
  const ageSec = Math.max(0, Math.round((Date.now() - Number(info.since ?? Date.now())) / 1000));
  const parts = [info.what ?? '?', `pid=${info.pid}`, `会话=${info.session ?? '?'}`];
  if (info.profile) parts.push(`profile=${info.profile}`);
  parts.push(`起于 ${info.sinceText ?? '?'}（已占用 ${ageSec}s）`);
  return parts.join(' · ');
}

/**
 * 会话 id 的来源顺序：工具调用上下文里带的 agent → Host 环境变量 → 明说取不到。
 * ⚠️ Host 进程的 env 里【没有】DSH_SESSION_ID（Harness 只把它注入给派出去的子进程），
 * 所以第一顺位才是正路；取不到时写成一句人话，不写 "(unknown)" 免得看着像"没有会话"。
 */
function currentSessionId(ctx) {
  const fromCtx = ctx && ctx.sessionId ? String(ctx.sessionId) : '';
  if (fromCtx) return fromCtx;
  const fromEnv = process.env.DSH_SESSION_ID;
  if (fromEnv) return String(fromEnv);
  return '(取不到会话 id：工具上下文与 Host env 都没有)';
}

/**
 * profile 名同理：Host env 里也没有 DSH_PROFILE。
 * 退路是从 hmr 服务的 baseDir 反推（它形如 <DSH_HOME>\profiles\<名字>），
 * 但只在父目录确实叫 profiles 时才认 —— 宁可留空，也不要写个错的。
 */
function detectProfileName(ctx) {
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
  try {
    const baseDir = ctx && ctx.get ? ctx.get('hmr')?.baseDir : undefined;
    if (baseDir && path.basename(path.dirname(baseDir)) === 'profiles') return path.basename(baseDir);
  } catch {
    /* 没有 hmr 就算了 */
  }
  return '';
}

/** 占用台架（串口/烧写互斥）。陈锁（进程已死 / 超过 lockStaleMs）会被接手。 */
function acquireRigLock(cfg, what, ctx) {
  const file = lockFilePath(cfg);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const payload = {
    token,
    pid: process.pid,
    session: currentSessionId(ctx),
    profile: cfg.profileName || process.env.DSH_PROFILE || '',
    what,
    since: Date.now(),
    sinceText: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const fd = openSync(file, 'wx');
      writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      closeSync(fd);
      return { ok: true, token, file, text: `已占台架锁（${what}）: ${file}` };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        return { ok: false, token: '', text: `台架锁创建失败: ${error && error.message ? error.message : error}` };
      }
      const info = readLockFile(file);
      const staleByAge = Boolean(info) && Number.isFinite(Number(info.since)) && Date.now() - Number(info.since) > cfg.lockStaleMs;
      const staleByPid = Boolean(info) && Number.isFinite(Number(info.pid)) && !pidAlive(Number(info.pid));
      if (attempt === 0 && (staleByAge || staleByPid)) {
        try {
          unlinkSync(file);
        } catch {
          /* 别人抢先删了 */
        }
        continue;
      }
      const why = staleByAge ? '（陈锁：超过 lockStaleMs）' : staleByPid ? '（陈锁：占用进程已不在）' : '';
      return {
        ok: false,
        token: '',
        text:
          `台架被占用 ✗ ${why}\n  占用者: ${lockHolderText(info)}\n  锁文件: ${file}\n` +
          `串口/烧写不是可并发资源 —— 等它结束，或确认是陈锁后手动删掉该文件再试。`,
      };
    }
  }
  return { ok: false, token: '', text: '台架锁竞争失败（重试后仍被占）' };
}

function releaseRigLock(lock) {
  if (!lock || !lock.ok) return;
  try {
    const info = readLockFile(lock.file);
    if (info && info.token === lock.token) unlinkSync(lock.file);
  } catch {
    /* 已经不在了 */
  }
}

// ---------------------------------------------------------------- 固件指纹 / 烧写账本（#2）

function sha16(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function firmwareFingerprint(file) {
  const abs = path.resolve(file);
  if (!existsSync(abs)) return { path: abs, name: path.basename(abs), exists: false };
  const st = statSync(abs);
  return {
    path: abs,
    name: path.basename(abs),
    exists: true,
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    sha256_16: sha16(abs),
  };
}

function repoStamp(cfg) {
  const run = (args) => {
    try {
      return execFileSync('git', [...gitArgsFor(cfg, cfg.repo), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
    } catch {
      return '';
    }
  };
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    head: run(['rev-parse', '--short', 'HEAD']),
    subject: run(['log', '-1', '--pretty=%s']),
    dirty: run(['status', '--porcelain']) !== '',
  };
}

function ledgerFilePath(cfg) {
  return path.join(cfg.repo, 'debug_logs', 'flash_ledger.jsonl');
}

function appendFlashLedger(cfg, entry) {
  try {
    mkdirSync(path.dirname(ledgerFilePath(cfg)), { recursive: true });
    appendFileSync(ledgerFilePath(cfg), `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function flashLedgerTail(cfg, count = 3) {
  try {
    const lines = readFileSync(ledgerFilePath(cfg), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    return lines.slice(-count).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

function ledgerLine(entry) {
  if (!entry || entry.raw) return `  ${entry?.raw ?? '(读不出)'}`;
  const fw = entry.firmware ?? {};
  return `  ${entry.timeText ?? '?'}  ${entry.board ?? '?'}  ${entry.method ?? '?'}  ${entry.ok ? 'OK' : 'FAIL'}  ${fw.name ?? '?'} (${fw.bytes ?? '?'} B, sha ${fw.sha256_16 ?? '?'})  ← ${entry.session ?? '?'}`;
}

// 把构建来源写进产物目录，让"板上跑的是哪份"有据可查
function writeBuildInfo(cfg, dir, target, ctx) {
  const info = {
    target,
    builtAt: new Date().toISOString(),
    source: repoStamp(cfg),
    toolchain: cfg.toolVersions,
    node: process.version,
    session: currentSessionId(ctx),
    profile: cfg.profileName || '',
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'build_info.txt'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    return info;
  } catch {
    return info;
  }
}

function buildInfoText(info) {
  const src = info?.source ?? {};
  return `${src.branch ?? '?'}@${src.head ?? '?'}${src.dirty ? '(脏)' : '(干净)'} · ${src.subject ?? ''} · 构建于 ${info?.builtAt ?? '?'}`;
}

// ---------------------------------------------------------------- BOOTSEL 盘身份（#6）

function bootVolumes() {
  const found = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    const infoFile = path.join(root, 'INFO_UF2.TXT');
    if (!existsSync(infoFile)) continue;
    let text = '';
    try {
      text = readFileSync(infoFile, 'utf8');
    } catch {
      continue;
    }
    found.push({
      drive: root,
      boardId: (text.match(/Board-ID:\s*(\S+)/i) ?? [])[1] ?? '',
      model: ((text.match(/Model:\s*(.+)/i) ?? [])[1] ?? '').trim(),
      text: text.trim().split(/\r?\n/).slice(0, 6).join(' | '),
    });
  }
  return found;
}

/** 烧写前核对引导盘身份：DUT 与探针的盘几乎同名，写错就是把固件烧到另一块板。 */
function checkBootVolume(cfg, board, force) {
  const want = String(cfg.boardIds?.[board] ?? '');
  const vols = bootVolumes();
  if (vols.length === 0) {
    // kind='none' 交给调用方按方法措辞：backdoor 方式下"现在没有 BOOTSEL 盘"本来就是正常前态，
    // 不该长得像报错（2026-10-06 反馈：它和同一屏后面的"已刷入"自相矛盾，害人以为失败）。
    return { ok: false, kind: 'none', text: '当前没有 BOOTSEL 盘（找不到 INFO_UF2.TXT）。' };
  }
  const listing = vols.map((v) => `  ${v.drive}  Board-ID=${v.boardId || '?'}  Model=${v.model || '?'}`).join('\n');
  const matched = vols.find((v) => v.boardId.toLowerCase() === want.toLowerCase());
  if (matched) return { ok: true, kind: 'match', drive: matched.drive, text: `BOOTSEL 盘身份匹配（${board} → Board-ID ${want}）\n${listing}` };
  if (force) return { ok: true, kind: 'forced', drive: vols[0].drive, text: `⚠️ 强制作业：盘身份不匹配（期望 ${board} → "${want}"）\n${listing}` };
  return {
    ok: false,
    kind: 'mismatch',
    text:
      `拒绝烧写 ✗ BOOTSEL 盘身份不匹配（期望 ${board} → Board-ID "${want}"，实际看到：\n${listing}\n` +
      `本台架没引出 RUN 脚，BOOTSEL 按钮是唯一救援手段；写错板代价很大。确认无误要强来就加 force: true。`,
  };
}

// ---------------------------------------------------------------- 构建首错（#8）

function firstErrors(text, limit = 5) {
  const out = [];
  const pattern = /([^\s:]+\.(?:[ch](?:pp)?|cc|S|ld|txt)):(\d+)(?::(\d+))?:\s*(error|fatal error|Error):\s*(.+)$/;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || out.length >= limit) continue;
    const m = line.match(pattern);
    if (m) out.push(`${m[1]}:${m[2]}${m[3] ? `:${m[3]}` : ''}: ${m[4]}: ${m[5]}`);
    else if (/undefined reference to|multiple definition of|ninja: build stopped|FAILED:/i.test(line)) out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- 串口常驻会话（#3/#4/#7）

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map();

function spawnEnv(extra) {
  const env = { ...process.env, ...(extra ?? {}) };
  if (toolPathPrefix) {
    const inherited = env.PATH ?? env.Path ?? '';
    env.PATH = inherited ? `${toolPathPrefix}${path.delimiter}${inherited}` : toolPathPrefix;
  }
  return env;
}

function sessionList() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    port: s.port || '(未开)',
    owner: s.owner,
    openedAt: s.openedAtText,
    idleSec: Math.round((Date.now() - s.lastUsed) / 1000),
    alive: s.child.exitCode === null,
  }));
}

function sessionTouch(cfg, s) {
  s.lastUsed = Date.now();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    sessionClose(cfg, s.id, '空闲超时自动关闭');
  }, cfg.sessionIdleMs);
  if (s.timer.unref) s.timer.unref();
}

/** 一发一收：一个会话同时只允许一个在途请求（串口本来就是串行的）。 */
function sessionRequest(s, message, timeoutMs) {
  return new Promise((resolve) => {
    if (s.pending) {
      resolve({ ok: false, event: 'busy', text: `会话 ${s.id} 还有一个请求在途，稍后再试。` });
      return;
    }
    const timer = setTimeout(() => {
      s.pending = null;
      resolve({ ok: false, event: 'timeout', text: `会话 ${s.id} 在 ${timeoutMs}ms 内没有任何回应（端口卡住或板子没反应）。` });
    }, timeoutMs);
    s.pending = { resolve, timer, message };
    try {
      s.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      clearTimeout(timer);
      s.pending = null;
      resolve({ ok: false, event: 'error', text: `写入会话失败: ${error && error.message ? error.message : error}` });
    }
  });
}

function onSessionData(cfg, s, chunk) {
  s.buffer += chunk;
  let index = s.buffer.indexOf('\n');
  while (index >= 0) {
    const line = s.buffer.slice(0, index).trim();
    s.buffer = s.buffer.slice(index + 1);
    index = s.buffer.indexOf('\n');
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const pending = s.pending;
    if (!pending) continue;
    s.pending = null;
    clearTimeout(pending.timer);
    if (event.event === 'opened') s.port = event.port ?? s.port;
    pending.resolve({
      ok: event.event !== 'error',
      event: event.event,
      matched: event.matched,
      text: event.event === 'error' ? `会话错误: ${event.message}` : event.text,
      bytes: event.bytes,
      lines: event.lines,
      port: event.port,
      timedOut: event.timedOut,
    });
  }
}

async function sessionOpen(cfg, args, ctx = {}) {
  const id = String(args.sessionId ?? 'default');
  const existing = sessions.get(id);
  if (existing && existing.child.exitCode === null) {
    sessionTouch(cfg, existing);
    return { ok: true, text: `会话 ${id} 已经开着（端口 ${existing.port || '?'}，起于 ${existing.openedAtText}）。` };
  }
  const lock = acquireRigLock(cfg, `serial session ${id}`, ctx);
  if (!lock.ok) return { ok: false, text: lock.text };

  const worker = path.join(PACKAGE_DIR, 'serial-session.ps1');
  if (!existsSync(worker)) {
    releaseRigLock(lock);
    return { ok: false, text: `缺少 ${worker}` };
  }
  // 【信任门】worker 是【直接 spawn】的（不经过 runProjectScript）⇒ 必须在 here 手动加同一道门。
  // 2026-10-07：它先前是漏的 —— 往 serial-session.ps1 里塞点东西再 pico_console open 就是沙箱外任意代码。
  let workerTrust = trustVerdict(cfg, worker);
  if (!workerTrust.ok) {
    // ⚠️ 这里必须 try/catch：锁已经拿在手里了，审批若抛异常而直接冒泡，就会【漏锁】
    //    （2026-10-07 实测漏了一把，得等 10 分钟陈锁判据或人手动清）。
    let ask;
    try {
      ask = await askTrustApproval(cfg, worker, { toolName: 'pico_console' });
    } catch (error) {
      ask = { outcome: 'unavailable', detail: `审批异常: ${error && error.message ? error.message : error}` };
    }
    if (ask.outcome === 'allowed-once' && registerTrust(cfg, worker)) {
      workerTrust = trustVerdict(cfg, worker);
    } else {
      releaseRigLock(lock);
      return { ok: false, text: `${trustRefusal(cfg, worker)}\n\n（审批结果：${ask.outcome}${ask.detail ? ` — ${ask.detail}` : ''}）` };
    }
  }
  // 【运行本】worker 也只跑 Pico 文件夹里那一份
  const workerRuntime = resolveRuntimeScript(cfg, worker);
  if (!workerRuntime) {
    releaseRigLock(lock);
    return { ok: false, text: `⛔ 会话 worker 的运行本不可用：${relToRoot(cfg, worker)}\n⇒ 先登记，或走 pico_amend。` };
  }
  let child;
  try {
    child = spawn(cfg.powershell, ['-NoProfile', '-NonInteractive', '-File', workerRuntime], {
      cwd: cfg.repo,
      windowsHide: true,
      env: spawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    releaseRigLock(lock);
    return { ok: false, text: `启动会话进程失败: ${error && error.message ? error.message : error}` };
  }

  const s = {
    id,
    child,
    port: '',
    buffer: '',
    pending: null,
    stderr: '',
    lock,
    owner: currentSessionId(ctx),
    lastUsed: Date.now(),
    openedAtText: new Date().toISOString(),
    timer: null,
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => onSessionData(cfg, s, chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    s.stderr = `${s.stderr}${chunk}`.slice(-4000);
  });
  child.on('close', () => {
    if (s.timer) clearTimeout(s.timer);
    sessions.delete(id);
    releaseRigLock(s.lock);
  });
  sessions.set(id, s);

  const target = args.port ? null : cfg.devices[String(args.target ?? 'dut')];
  const open = await sessionRequest(
    s,
    {
      cmd: 'open',
      port: args.port ? String(args.port) : '',
      vid: args.vid ?? target?.vid ?? '',
      pid: args.pid ?? target?.pid ?? '',
      baud: Number.isFinite(args.baud) ? args.baud : 115200,
    },
    cfg.sessionOpenTimeoutMs,
  );
  if (!open.ok) {
    const stderr = s.stderr.trim() ? `\n子进程 stderr（前 1500 字）:\n${clip(s.stderr, 1500)}` : '';
    sessionClose(cfg, id, '打开失败');
    return { ok: false, text: `${open.text}${stderr}\n（实测 open 本身要 4.5~4.7s；超时多半是端口被占或在 BOOTSEL 里没跑应用）` };
  }
  sessionTouch(cfg, s);
  return { ok: true, text: `会话 ${id} 已打开：${s.port}（DTR 已拉高）—— 之后可以反复 send/read，不用再重开口。` };
}

async function sessionSend(cfg, s, args) {
  const res = await sessionRequest(s, { cmd: 'send', data: String(args.data ?? ''), escapes: args.escapes === true }, 15000);
  if (res.ok) sessionTouch(cfg, s);
  return { ok: res.ok, text: res.ok ? `已发送 ${res.bytes ?? 0} 字节到 ${s.port}。` : res.text };
}

async function sessionRead(cfg, s, args) {
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 2000;
  const res = await sessionRequest(
    s,
    { cmd: 'read', timeoutMs, until: args.until === undefined ? '' : String(args.until), stamp: args.stamp !== false },
    timeoutMs + 8000,
  );
  if (!res.ok) return { ok: false, text: res.text };
  sessionTouch(cfg, s);
  const head = res.matched
    ? `命中 until（${args.until}），${res.bytes ?? 0} 字节 / ${res.lines ?? 0} 行：`
    : `超时无匹配（读了 ${res.bytes ?? 0} 字节 / ${res.lines ?? 0} 行；不是"没打印"就是板子没反应）：`;
  return { ok: true, text: `${head}\n${res.text && res.text.trim() !== '' ? res.text : '(这段时间没有输出)'}` };
}

function sessionClose(cfg, id, why) {
  const s = sessions.get(id);
  if (!s) return { ok: false, text: `没有会话 ${id}。` };
  sessions.delete(id);
  if (s.timer) clearTimeout(s.timer);
  try {
    s.child.stdin.write(`${JSON.stringify({ cmd: 'close' })}\n`);
    s.child.stdin.end();
  } catch {
    /* 已经关了 */
  }
  setTimeout(() => killTree(s.child), 800).unref?.();
  releaseRigLock(s.lock);
  return { ok: true, text: `会话 ${id} 已关闭（${why}）。` };
}

async function opConsole(cfg, args = {}, ctx = {}) {
  const op = String(args.op ?? 'list');
  const id = String(args.sessionId ?? 'default');

  if (op === 'list') {
    const list = sessionList();
    if (list.length === 0) return { ok: true, text: '当前没有打开的串口会话。', json: { sessions: [] } };
    const text = list.map((s) => `  ${s.id}  ${s.port}  会话=${s.owner ?? '?'}  起于 ${s.openedAt}  空闲 ${s.idleSec}s  ${s.alive ? '活着' : '已退出'}`).join('\n');
    return { ok: true, text: `打开的会话（${list.length}）：\n${text}`, json: { sessions: list } };
  }

  if (op === 'open') return await sessionOpen(cfg, args, ctx);

  const s = sessions.get(id);
  if (!s || s.child.exitCode !== null) {
    return { ok: false, text: `没有会话 ${id}；先用 op:"open" 打开（open 要 4~5 秒，但只用付一次）。` };
  }

  if (op === 'send') return await sessionSend(cfg, s, args);
  if (op === 'read') return await sessionRead(cfg, s, args);
  if (op === 'expect') {
    if (!args.until) return { ok: false, text: 'expect 需要 until（正则）。' };
    const parts = [];
    if (args.data !== undefined && String(args.data) !== '') {
      const sent = await sessionSend(cfg, s, args);
      parts.push(sent.text);
    }
    const read = await sessionRead(cfg, s, args);
    return { ok: read.ok, text: [...parts, read.text].join('\n') };
  }
  if (op === 'close') return sessionClose(cfg, id, args.reason ? String(args.reason) : '手动关闭');

  return { ok: false, text: `未知 op: ${op}（open/send/read/expect/close/list）` };
}

// ---------------------------------------------------------------- 各项能力

async function opStatus(cfg, args = {}, ctx = {}) {
  const parts = [];
  const json = { paths: {}, tools: {}, git: {}, ports: [], lock: null, lastFlash: null, probe: null };
  parts.push('== 路径 ==');
  parts.push(`root      : ${cfg.root}  ${existsSync(cfg.root) ? '存在' : '缺失'}`);
  parts.push(`repo      : ${cfg.repo}  ${existsSync(cfg.repo) ? '存在' : '缺失'}`);
  parts.push(`tempRoot  : ${cfg.tempRoot}`);
  parts.push(`backup    : ${artifactInfo(path.join(cfg.root, '_firmware_backup', 'fw_full_153154.uf2'))}`);
  parts.push(`agents    : ${existsSync(path.join(cfg.root, '_agents')) ? readdirSync(path.join(cfg.root, '_agents')).join(', ') : '(无)'}`);
  json.paths = { root: cfg.root, repo: cfg.repo, tempRoot: cfg.tempRoot };

  const home = process.env.USERPROFILE || '';
  const tools = {
    cmake: path.join(home, '.pico-sdk', 'cmake', cfg.toolVersions.cmake, 'bin', 'cmake.exe'),
    ninja: path.join(home, '.pico-sdk', 'ninja', cfg.toolVersions.ninja, 'ninja.exe'),
    sdk: path.join(home, '.pico-sdk', 'sdk', '2.3.0'),
    gcc: path.join(home, '.pico-sdk', 'toolchain', cfg.toolVersions.toolchain, 'bin', 'arm-none-eabi-gcc.exe'),
    picotool: path.join(home, '.pico-sdk', 'picotool', cfg.toolVersions.picotool, 'picotool', 'picotool.exe'),
  };
  parts.push('');
  parts.push('== 工具链 ==');
  for (const [key, value] of Object.entries(tools)) parts.push(`${key.padEnd(9)}: ${value}  ${existsSync(value) ? '✓' : '✗'}`);
  json.tools.paths = tools;

  const versionJobs = [
    ['cmake', tools.cmake, ['--version']],
    ['ninja', tools.ninja, ['--version']],
    ['gcc', tools.gcc, ['-dumpfullversion']],
    ['picotool', tools.picotool, ['version']],
    ['python', cfg.python, ['--version']],
  ];
  for (const [label, file, argv] of versionJobs) {
    if (!existsSync(file) && label !== 'python') {
      parts.push(`${label}: (缺可执行文件)`);
      continue;
    }
    const res = await runProcess(file, argv, { timeoutMs: 30000 });
    const text = (res.stdout || res.stderr || res.spawnError || '').trim().split(/\r?\n/)[0] ?? '';
    json.tools[label] = text.slice(0, 120);
    parts.push(`${label}: ${text.slice(0, 120) || '(无输出)'}`);
  }

  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (existsSync(vswhere)) {
    const res = await runProcess(vswhere, ['-latest', '-property', 'displayName'], { timeoutMs: 30000 });
    const text = (res.stdout || res.stderr || '').trim() || '(未探测到)';
    json.tools.visualStudio = text;
    parts.push(`VisualStudio: ${text}`);
  } else {
    parts.push('VisualStudio: (vswhere 不在默认位置)');
  }

  parts.push('');
  parts.push('== 子进程 PATH 前缀（pico_exec / pico_run 会带上）==');
  for (const dir of toolPathPrefix.split(path.delimiter).filter(Boolean)) parts.push(`  ${dir}`);

  parts.push('');
  parts.push('== git ==');
  for (const [label, dir] of [['main', cfg.repo]]) {
    const branch = await runProcess('git', [...gitArgsFor(cfg, dir), 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 30000 });
    const head = await runProcess('git', [...gitArgsFor(cfg, dir), 'log', '--oneline', '-1'], { timeoutMs: 30000 });
    const status = await runProcess('git', [...gitArgsFor(cfg, dir), 'status', '--porcelain'], { timeoutMs: 30000 });
    const dirtyLines = status.stdout.trim() === '' ? [] : status.stdout.trim().split(/\r?\n/);
    const dirty = dirtyLines.length === 0 ? '干净' : `脏(${dirtyLines.length} 项)`;
    json.git = { branch: (branch.stdout || '').trim(), head: (head.stdout || '').trim(), dirty: dirtyLines.length > 0, dirtyCount: dirtyLines.length };
    parts.push(`${label}: ${(branch.stdout || '').trim()} | ${(head.stdout || '').trim()} | ${dirty}`);
  }

  parts.push('');
  parts.push('== 设备（按 VID:PID 认，不认 COM 号）==');
  const pnp = await runProcess(
    cfg.powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_2E8A' } | Select-Object -ExpandProperty InstanceId",
    ],
    { timeoutMs: 60000 },
  );
  const deviceLines = (pnp.stdout || pnp.stderr || '(枚举失败)').trim().split(/\r?\n/).filter((l) => l !== '');
  json.ports = deviceLines;
  parts.push(deviceLines.join('\n') || '(没有 2E8A 设备)');

  parts.push('');
  parts.push('== 台架锁（串口/烧写互斥）==');
  const lockInfo = readLockFile(lockFilePath(cfg));
  json.lock = lockInfo;
  parts.push(lockInfo ? `被占用: ${lockHolderText(lockInfo)}` : '空闲');

  parts.push('');
  parts.push('== 最后烧写（debug_logs/flash_ledger.jsonl）==');
  const ledger = flashLedgerTail(cfg, 3);
  json.lastFlash = ledger.length > 0 ? ledger[ledger.length - 1] : null;
  parts.push(ledger.length === 0 ? '(账本为空 —— 这个工具还没烧过东西)' : ledger.map(ledgerLine).join('\n'));

  parts.push('');
  parts.push('== 悬挂进程守卫 ==');
  const guard = await runProjectScript(cfg, path.join(cfg.repo, 'tools', 'proc_guard.ps1'), ['-List'], { timeoutMs: 60000 });
  parts.push(clip((guard.stdout || guard.stderr || '(无输出)').trim(), 4000));

  if (args.probeSerial === true) {
    const seconds = Number.isFinite(args.probeSeconds) ? args.probeSeconds : 2;
    parts.push('');
    parts.push(`== 板上最近说过的话（${seconds}s 串口采样）==`);
    const probe = await opSerial(cfg, { target: args.probeTarget ?? 'dut', seconds }, ctx);
    json.probe = probe.text;
    parts.push(clip(probe.text, 4000));
  }

  return { ok: true, exitCode: 0, text: clip(parts.join('\n'), cfg.maxOutputChars), json };
}

async function opBuild(cfg, args = {}, ctx = {}) {
  const target = String(args.target ?? 'root');
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : cfg.timeoutMs;
  const cwd = cfg.repo;

  if (target === 'host-test' || target === 'host_test' || target === 'hosttest') {
    const script = path.join(cwd, 'tools', 'host_test', 'run_all.cmd');
    const res = await runProjectScript(cfg, script, [], { cwd, timeoutMs });
    return { ok: res.ok, exitCode: res.exitCode, text: describeRun('host-test run_all.cmd', res, cfg) };
  }

  if (target === 'root' || target === 'PicoPhone' || target === 'main') {
    const script = path.join(cwd, 'tools', 'build.cmd');
    // ⚠️ 构建【不进沙箱】：实测沙箱下 cmake configure 会 AF 崩（CMAKE_EXIT=-1073741819 = 0xC0000005），
    //    外层 BUILD_EXIT 还被 ninja 的 "no work to do" 洗成 0 ⇒ 假成功（项目自己的老坑）。
    //    增量时又可能侥幸通过 ⇒ 表现为"有时崩有时过"，比稳定失败更坏。证据：台架接口沙箱化说明.md §三.9 与外部复核。
    const res = await runProjectScript(cfg, script, [], { cwd, timeoutMs });
    const logPath = path.join(cwd, 'debug_logs', 'build_log.txt');
    let fullLog = '';
    try {
      fullLog = readFileSync(logPath, 'utf8');
    } catch {
      fullLog = '';
    }
    const info = res.ok ? writeBuildInfo(cfg, path.join(cwd, 'build'), 'root', ctx) : null;
    const errors = res.ok ? [] : firstErrors(`${fullLog}\n${res.stdout}\n${res.stderr}`);
    const extra = {
      日志尾部: `\n${tailFile(logPath, 40, cfg)}`,
      产物: `\n${artifactInfo(path.join(cwd, 'build', 'PicoPhone.uf2'))}`,
    };
    // 命令根本没跑起来时，别把【上一轮】的日志与产物摆出来 —— 那看起来像"构建成功"
    if (res.spawnError) {
      delete extra.日志尾部;
      delete extra.产物;
    }
    if (info) extra['构建来源（已落 build/build_info.txt）'] = buildInfoText(info);
    if (errors.length > 0) extra['首批错误'] = `\n  ${errors.join('\n  ')}`;
    return { ok: res.ok, exitCode: res.exitCode, text: describeRun('build.cmd (根工程)', res, cfg, extra), json: { target: 'root', ok: res.ok, errors, buildInfo: info } };
  }

  const buildSub = String(args.buildSub ?? 'build');
  const scriptArgs = [target, '-BuildSub', buildSub];
  if (args.noUf2 === true) scriptArgs.push('-NoUf2');
  if (Array.isArray(args.cacheArgs) && args.cacheArgs.length > 0) {
    scriptArgs.push('-CacheArgs', ...args.cacheArgs.map((s) => String(s)));
  }
  const script = path.join(cwd, 'tools', 'build_sub.ps1');
  // ⚠️ 同上：子工程构建也不进沙箱（它内部要走 cmake configure + 捕获原生输出）。
  const res = await runProjectScript(cfg, script, scriptArgs, { cwd, timeoutMs });
  const outDir = path.join(cwd, target, buildSub);
  const info = res.ok ? writeBuildInfo(cfg, outDir, target, ctx) : null;
  const errors = res.ok ? [] : firstErrors(`${res.stdout}\n${res.stderr}`);
  const extra = { 产物: `\n${listUf2(outDir)}` };
  if (res.spawnError) delete extra.产物; // 同上：没跑起来就别摆旧产物
  if (info) extra['构建来源（已落 build_info.txt）'] = buildInfoText(info);
  if (errors.length > 0) extra['首批错误'] = `\n  ${errors.join('\n  ')}`;
  return { ok: res.ok, exitCode: res.exitCode, text: describeRun(`build_sub.ps1 ${target} (${buildSub})`, res, cfg, extra), json: { target, buildSub, ok: res.ok, errors, buildInfo: info } };
}

async function opFlash(cfg, args = {}, ctx = {}) {
  const method = String(args.method ?? 'backdoor');
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : cfg.shortTimeoutMs;
  const force = args.force === true;

  if (method === 'list') {
    const script = path.join(cfg.repo, 'tools', 'flash_backdoor.ps1');
    const res = await runProjectScript(cfg, script, [], { timeoutMs: 60000 });
    const vols = bootVolumes();
    const volText = vols.length === 0 ? '(当前没有 BOOTSEL 盘)' : vols.map((v) => `  ${v.drive}  Board-ID=${v.boardId || '?'}  Model=${v.model || '?'}`).join('\n');
    return {
      ok: res.ok,
      exitCode: res.exitCode,
      text: `${describeRun('flash_backdoor.ps1 (列出可见板子)', res, cfg)}\n\n== 当前 BOOTSEL 盘 ==\n${volText}`,
      json: { volumes: vols },
    };
  }

  const board = args.board === undefined ? '' : String(args.board);
  let firmware = args.firmware === undefined ? '' : String(args.firmware);
  if (firmware && !path.isAbsolute(firmware)) firmware = path.resolve(cfg.repo, firmware);
  if (firmware && !existsSync(firmware)) return { ok: false, exitCode: null, text: `固件不存在: ${firmware}` };

  // 盘身份核对（#6）：这一条是清单里唯一能砸硬件的。
  // 措辞随方法变：backdoor/auto 下"现在还没有 BOOTSEL 盘"是正常前态（板子自己会进去），
  // 写成"拒绝/先让它进 BOOTSEL"会和同一屏后面的"已刷入"自相矛盾（2026-10-06 反馈）。
  const backdoorLike = method === 'backdoor' || method === 'auto';
  const rawVolume = args.skipVolumeCheck === true ? { ok: true, kind: 'skipped', text: '(按要求跳过盘身份核对)' } : checkBootVolume(cfg, board || 'dut', force);
  const volumeText =
    rawVolume.kind === 'none'
      ? backdoorLike
        ? '预检：当前没有 BOOTSEL 盘 —— 正常（backdoor 方式会让板子自己进去，写盘前再按 Board-ID 认一次）'
        : rawVolume.text
      : rawVolume.text;
  const volume = { ...rawVolume, text: volumeText };

  const planFor = (m) => {
    if (m === 'bootsel') return `${cfg.powershell} -NoProfile -File tools\\flash_bootsel.ps1${firmware ? ` -Firmware "${firmware}"` : ''}`;
    if (m === 'picotool') return `picotool load -x "${firmware}"`;
    return `${cfg.powershell} -NoProfile -File tools\\flash_backdoor.ps1 -Board ${board}${firmware ? ` -Firmware "${firmware}"` : ''}`;
  };

  if (args.dryRun === true) {
    const planned = method === 'auto' ? ['backdoor', 'picotool'] : [method];
    return {
      ok: true,
      exitCode: 0,
      text:
        `[dry-run] 将执行（cwd=${cfg.repo}）：\n${planned.map((m) => `  ${m}: ${planFor(m)}`).join('\n')}\n` +
        `固件: ${firmware || '(未指定，脚本会列出板子)'}\n\n== 盘身份核对 ==\n${volume.text}`,
    };
  }
  if (!firmware && method !== 'backdoor' && method !== 'auto') {
    return { ok: false, exitCode: null, text: `method=${method} 需要 firmware。` };
  }

  const lock = acquireRigLock(cfg, `flash ${board || 'dut'} (${method})`, ctx);
  if (!lock.ok) return { ok: false, exitCode: null, text: lock.text };

  const fingerprint = firmware ? firmwareFingerprint(firmware) : null;
  const source = repoStamp(cfg);
  const attempts = [];
  let used = '';
  let res = null;
  try {
    const planned = method === 'auto' ? ['backdoor', 'picotool'] : [method];
    for (const m of planned) {
      if (m === 'picotool' && !firmware) {
        attempts.push('picotool: 跳过（没给 firmware）');
        continue;
      }
      if ((m === 'picotool' || m === 'bootsel') && !volume.ok) {
        attempts.push(`${m}: 跳过（${rawVolume.kind === 'none' ? '当前没有 BOOTSEL 盘' : '盘身份没通过'}）`);
        continue;
      }
      if (m === 'picotool') res = await runProcess('picotool', ['load', '-x', firmware], { cwd: cfg.repo, timeoutMs });
      else if (m === 'bootsel') {
        res = await runProjectScript(cfg, path.join(cfg.repo, 'tools', 'flash_bootsel.ps1'), firmware ? ['-Firmware', firmware] : [], { timeoutMs });
      } else {
        const scriptArgs = ['-Board', board || 'dut'];
        if (firmware) scriptArgs.push('-Firmware', firmware);
        res = await runProjectScript(cfg, path.join(cfg.repo, 'tools', 'flash_backdoor.ps1'), scriptArgs, { timeoutMs });
      }
      used = m;
      attempts.push(`${m}: exit=${res.exitCode === null ? 'n/a' : res.exitCode}${res.timedOut ? ' TIMEOUT' : ''}`);
      if (res.ok) break;
    }
  } finally {
    releaseRigLock(lock);
  }

  const ok = Boolean(res && res.ok);
  const entry = {
    timeText: new Date().toISOString(),
    board: board || 'dut',
    method: used || method,
    ok,
    exitCode: res ? res.exitCode : null,
    firmware: fingerprint,
    source,
    session: currentSessionId(ctx),
    profile: cfg.profileName || '',
    pid: process.pid,
    attempts,
  };
  const logged = appendFlashLedger(cfg, entry);

  const extra = {
    固件指纹: fingerprint ? `${fingerprint.name}  ${fingerprint.bytes} B  sha256:${fingerprint.sha256_16}  mtime=${fingerprint.mtime}` : '(未指定)',
    源码来源: `${source.branch}@${source.head}${source.dirty ? '(脏)' : '(干净)'} · ${source.subject}`,
    尝试: attempts.join(' / '),
    账本: logged ? `已追加 ${ledgerFilePath(cfg)}` : '(账本写入失败)',
    盘身份: `\n${volume.text}`,
  };
  if (!ok && method === 'auto') {
    extra['下一步'] = 'backdoor 与 picotool 都没成 ⇒ 需要人按 BOOTSEL（本台架没引出 RUN 脚，按钮是唯一救援）';
  }
  return { ok, exitCode: res ? res.exitCode : null, text: describeRun(`flash ${used || method} ${board || 'dut'}`, res ?? { exitCode: null, timedOut: false, stdout: '', stderr: '', durationMs: 0, ok: false }, cfg, extra), json: { flash: entry, volume } };
}

async function opSerial(cfg, args = {}, ctx = {}) {
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : cfg.shortTimeoutMs;
  const scriptArgs = [];
  let label = 'serial.ps1';

  if (args.list === true) {
    scriptArgs.push('-List');
    label = 'serial.ps1 -List';
  } else if (args.port) {
    scriptArgs.push('-Port', String(args.port));
    label = `serial.ps1 ${args.port}`;
  } else {
    const target = String(args.target ?? 'dut');
    const device = cfg.devices[target];
    const vid = args.vid ?? device?.vid;
    const pid = args.pid ?? device?.pid;
    if (!vid || !pid) return { ok: false, exitCode: null, text: `未知目标 ${target}；请给 target(dut|probe|sampler) 或 vid+pid，或直接给 port。` };
    scriptArgs.push('-Vid', String(vid), '-ProductId', String(pid));
    label = `serial.ps1 ${target} (${vid}:${pid})`;
  }

  const seconds = Number.isFinite(args.seconds) ? args.seconds : 5;
  if (args.list !== true) scriptArgs.push('-Seconds', String(seconds));
  if (args.send !== undefined && args.send !== null && String(args.send) !== '') {
    scriptArgs.push('-Send', String(args.send));
    if (args.escapes === true) scriptArgs.push('-Escapes');
  }
  // serial.ps1 只在给了 -OutFile 时才把正文落盘（stdout 里只有 "READ n bytes"）
  // ⇒ 默认自己给一个 %TEMP% 下的文件，保证读到的字节一定能看见。
  let outFile = '';
  let autoOutFile = false;
  let fencedNote = '';
  if (args.list !== true) {
    if (args.outFile) {
      // 🚨 红队 2026-10-07【唯一确认的突破】就出在这里：原先是 `outFile = String(args.outFile)` ——
      //    绝对路径原样使用，而 pico_serial 本身【豁免沙箱】（Host 侧直接 spawn serial.ps1）
      //    ⇒ 只要有任意一个能打开的串口，就能往窗口之外写文件（实测：往桌面根写了 258 B）。
      //    修法：与 pico_temp 对齐，【无条件】围栏 —— 只认 %TEMP% 之内，越界一律压回。
      const raw = String(args.outFile);
      const asked = path.isAbsolute(raw) ? path.normalize(raw) : safeTempPath(cfg, raw);
      const rootNorm = path.resolve(cfg.tempRoot).toLowerCase().replace(/[\\/]+$/, '');
      const askedNorm = path.resolve(asked).toLowerCase();
      const insideTemp = askedNorm === rootNorm || askedNorm.startsWith(`${rootNorm}${path.sep}`);
      if (!insideTemp) {
        const fenced = path.join(cfg.tempRoot, path.basename(asked) || `picophone_serial_${stamp()}.txt`);
        fencedNote = `⚠️ outFile 越出 %TEMP%（请求 ${raw}）⇒ 已压回 ${fenced}（pico_serial 一律只落 %TEMP%）`;
        outFile = fenced;
      } else {
        outFile = asked;
      }
    } else {
      outFile = path.join(cfg.tempRoot, `picophone_serial_${stamp()}.txt`);
      autoOutFile = true;
    }
    scriptArgs.push('-OutFile', outFile);
  }

  if (args.list === true) {
    const listed = await runProjectScript(cfg, path.join(cfg.repo, 'tools', 'serial.ps1'), scriptArgs, { timeoutMs });
    return { ok: listed.ok, exitCode: listed.exitCode, text: describeRun(label, listed, cfg) };
  }

  const lock = acquireRigLock(cfg, `serial ${label}`, ctx);
  if (!lock.ok) return { ok: false, exitCode: null, text: lock.text, json: { locked: true } };
  try {
    const res = await runProjectScript(cfg, path.join(cfg.repo, 'tools', 'serial.ps1'), scriptArgs, { timeoutMs });
    const extra = {};
    if (outFile) {
      extra['落盘'] = outFile;
      extra['读到的内容'] = existsSync(outFile) ? `\n${tailFile(outFile, 120, cfg)}` : '(没有落盘文件)';
    }
    if (fencedNote) extra['围栏'] = fencedNote;
    return { ok: res.ok, exitCode: res.exitCode, text: describeRun(label, res, cfg, extra), json: { serial: { label, outFile, ok: res.ok } } };
  } finally {
    releaseRigLock(lock);
    if (autoOutFile) pruneSerialCaptures(cfg);
  }
}

async function opSwd(cfg, args = {}) {
  const list = Array.isArray(args.args) ? args.args.map((s) => String(s)) : [];
  if (list.length === 0) list.push('probe');
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : cfg.shortTimeoutMs;
  const res = await runProjectScript(cfg, path.join(cfg.repo, 'tools', 'swd.ps1'), list, { timeoutMs });
  return { ok: res.ok, exitCode: res.exitCode, text: describeRun(`swd.ps1 ${list.join(' ')}`, res, cfg) };
}

async function opProcs(cfg, args = {}) {
  const action = String(args.action ?? 'list');
  const scriptArgs = [];
  if (action === 'kill') scriptArgs.push('-Kill');
  else if (action === 'sweep') scriptArgs.push('-SweepOurWorkers');
  else scriptArgs.push('-List');
  if (args.waitFree) scriptArgs.push('-WaitFree', String(args.waitFree));
  const res = await runProjectScript(cfg, path.join(cfg.repo, 'tools', 'proc_guard.ps1'), scriptArgs, { timeoutMs: 90000 });
  return { ok: res.ok, exitCode: res.exitCode, text: describeRun(`proc_guard.ps1 ${action}`, res, cfg) };
}

async function opTemp(cfg, args = {}) {
  const op = String(args.op ?? 'path');
  const rel = args.path === undefined ? '' : String(args.path);
  const maxBytes = Number.isFinite(args.maxBytes) ? args.maxBytes : 200000;
  let target;
  try {
    target = op === 'path' ? cfg.tempRoot : safeTempPath(cfg, rel);
  } catch (error) {
    return { ok: false, exitCode: null, text: String(error && error.message ? error.message : error) };
  }

  if (op === 'path') return { ok: true, exitCode: 0, text: cfg.tempRoot };

  if (op === 'ls') {
    if (!existsSync(target)) return { ok: false, exitCode: null, text: `不存在: ${target}` };
    const st = statSync(target);
    if (!st.isDirectory()) return { ok: true, exitCode: 0, text: artifactInfo(target) };
    const rows = readdirSync(target, { withFileTypes: true })
      .slice(0, 400)
      .map((entry) => {
        const full = path.join(target, entry.name);
        try {
          const s = statSync(full);
          return `${entry.isDirectory() ? 'DIR ' : 'FILE'} ${String(s.size).padStart(10)}  ${s.mtime.toISOString()}  ${entry.name}`;
        } catch {
          return `?    ${entry.name}`;
        }
      });
    return { ok: true, exitCode: 0, text: `${target}\n${rows.join('\n') || '(空目录)'}` };
  }

  if (op === 'stat') {
    if (!existsSync(target)) return { ok: false, exitCode: null, text: `不存在: ${target}` };
    const s = statSync(target);
    return { ok: true, exitCode: 0, text: `${target}\n类型: ${s.isDirectory() ? '目录' : '文件'}\n大小: ${s.size}\n修改: ${s.mtime.toISOString()}` };
  }

  if (op === 'read') {
    if (!existsSync(target)) return { ok: false, exitCode: null, text: `不存在: ${target}` };
    const buf = readFileSync(target);
    const sliced = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
    const note = buf.length > maxBytes ? `\n[只显示末尾 ${maxBytes} / ${buf.length} 字节]` : '';
    return { ok: true, exitCode: 0, text: `${target} (${buf.length} B)${note}\n${clip(decodeBuffer(sliced), cfg.maxOutputChars)}` };
  }

  if (op === 'write' || op === 'append') {
    mkdirSync(path.dirname(target), { recursive: true });
    const raw = String(args.content ?? '');
    const asBase64 = String(args.encoding ?? '').toLowerCase() === 'base64';
    const payload = asBase64 ? Buffer.from(raw, 'base64') : raw;
    if (op === 'write') {
      if (asBase64) writeFileSync(target, payload);
      else writeFileSync(target, payload, 'utf8');
    } else if (asBase64) {
      appendFileSync(target, payload);
    } else {
      appendFileSync(target, payload, 'utf8');
    }
    const s = statSync(target);
    return { ok: true, exitCode: 0, text: `${op === 'write' ? '写入' : '追加'}完成: ${target} (${s.size} B${asBase64 ? '，base64 解码后' : ''})` };
  }

  if (op === 'cp' || op === 'mv') {
    const from = safeTempPath(cfg, String(args.from ?? ''));
    const to = safeTempPath(cfg, rel);
    if (!existsSync(from)) return { ok: false, exitCode: null, text: `源不存在: ${from}` };
    mkdirSync(path.dirname(to), { recursive: true });
    if (op === 'cp') copyFileSync(from, to);
    else renameSync(from, to);
    return { ok: true, exitCode: 0, text: `${op === 'cp' ? '已复制' : '已移动'}: ${from} -> ${to}` };
  }

  if (op === 'mkdir') {
    mkdirSync(target, { recursive: true });
    return { ok: true, exitCode: 0, text: `已创建目录: ${target}` };
  }

  if (op === 'rm') {
    if (!existsSync(target)) return { ok: false, exitCode: null, text: `不存在: ${target}` };
    rmSync(target, { recursive: true, force: true });
    return { ok: true, exitCode: 0, text: `已删除: ${target}` };
  }

  return { ok: false, exitCode: null, text: `未知 op: ${op}` };
}

/**
 * git over HTTPS 在沙箱下的两个前提（都不是"开口子"，是把信任与凭据变成【文件】）：
 *   · TLS 信任：本机代理（Watt Toolkit）的中间人 CA 导出成工作区里的 PEM ⇒ 沙箱读得到
 *   · 凭据：Git 默认助手要 spawn sh.exe/bash.exe ⇒ 要建命名管道 ⇒ 被沙箱拒（Win32 error 5）
 *           ⇒ 主路用 extraHeader（令牌不落盘），失败时**重试** git 内建的 store 助手（读一个文件）。
 * 返回 null = 这条路当前不可用（文件不存在）。
 */
function gitAuthArgs(cfg, kind) {
  const out = [];
  if (cfg.gitSslCa && existsSync(cfg.gitSslCa)) {
    out.push('-c', 'http.sslBackend=openssl', '-c', `http.sslCAInfo=${cfg.gitSslCa}`);
  }
  if (kind === 'header') {
    if (!cfg.gitTokenFile || !existsSync(cfg.gitTokenFile)) return null;
    let raw = '';
    try {
      raw = readFileSync(cfg.gitTokenFile, 'utf8').trim();
    } catch {
      return null;
    }
    if (raw === '') return null;
    const pair = raw.includes(':') ? raw : `x-access-token:${raw}`;
    out.push('-c', `http.extraHeader=Authorization: Basic ${Buffer.from(pair, 'utf8').toString('base64')}`);
    return out;
  }
  if (kind === 'store') {
    if (!cfg.gitCredentialsFile || !existsSync(cfg.gitCredentialsFile)) return null;
    out.push('-c', `credential.helper=store --file=${cfg.gitCredentialsFile}`);
    return out;
  }
  return out.length > 0 ? out : null;
}

async function opGit(cfg, args = {}) {
  const dir = resolveRepoArg(cfg, args.repo);
  const list = Array.isArray(args.args) ? args.args.map((s) => String(s)) : [];
  if (list.length === 0) list.push('status', '--short', '--branch');
  const mutating = ['commit', 'push', 'pull', 'fetch', 'reset', 'checkout', 'switch', 'merge', 'rebase', 'add', 'rm', 'mv', 'stash', 'clean', 'tag', 'branch', 'revert', 'cherry-pick', 'gc'];
  const verb = list.find((token) => !token.startsWith('-')) ?? '';
  if (mutating.includes(verb) && args.mutate !== true) {
    return {
      ok: false,
      exitCode: null,
      text: `git ${verb} 会改变仓库状态。确认后带 mutate: true 重试（仓库: ${dir}）。`,
    };
  }
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 120000;
  const netVerb = ['push', 'fetch', 'pull', 'ls-remote', 'clone'].includes(verb);
  const primary = gitAuthArgs(cfg, 'header');
  const retry = netVerb ? gitAuthArgs(cfg, 'store') : null;
  const label = `git -C ${dir} ${list.join(' ')}`;
  const res = await runProcess('git', [...gitArgsFor(cfg, dir), ...(primary ?? []), ...list], { cwd: dir, timeoutMs, sandbox: true });
  if (!res.ok && retry) {
    const first = describeRun(`${label} [主路 extraHeader 失败]`, res, cfg);
    const res2 = await runProcess('git', [...gitArgsFor(cfg, dir), ...retry, ...list], { cwd: dir, timeoutMs, sandbox: true });
    return {
      ok: res2.ok,
      exitCode: res2.exitCode,
      text: `${first}\n\n== 错误重试路径：改走 credential.helper=store（读 ${cfg.gitCredentialsFile}）==\n${describeRun(label, res2, cfg)}`,
      json: { git: { verb, attempts: ['extraHeader', 'store'], ok: res2.ok } },
    };
  }
  return {
    ok: res.ok,
    exitCode: res.exitCode,
    text: `${describeRun(label, res, cfg)}\n（凭据路径：${primary ? 'extraHeader 主路' : '未注入凭据'}）`,
    json: { git: { verb, attempts: [primary ? 'extraHeader' : 'none'], ok: res.ok } },
  };
}

const SCRIPT_EXT = new Set(['.ps1', '.cmd', '.bat', '.py']);

async function opRun(cfg, args = {}) {
  const rel = String(args.script ?? '');
  if (!rel) return { ok: false, exitCode: null, text: '需要 script（相对仓库的脚本路径，例如 tools/build.cmd）。' };
  const scriptPath = path.resolve(cfg.repo, rel);
  const allowedRoots = [path.join(cfg.repo, 'tools'), path.join(cfg.root, 'dsh-plugins')];
  if (!allowedRoots.some((root) => isInside(root, scriptPath))) {
    return { ok: false, exitCode: null, text: `只允许运行仓库 tools/ 与项目 dsh-plugins/ 下的脚本；被拒绝: ${scriptPath}` };
  }
  if (!SCRIPT_EXT.has(path.extname(scriptPath).toLowerCase())) {
    return { ok: false, exitCode: null, text: `只允许 .ps1/.cmd/.bat/.py；被拒绝: ${scriptPath}` };
  }
  if (!existsSync(scriptPath)) return { ok: false, exitCode: null, text: `脚本不存在: ${scriptPath}` };

  const list = Array.isArray(args.args) ? args.args.map((s) => String(s)) : [];
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : cfg.shortTimeoutMs;
  const res = await runProjectScript(cfg, scriptPath, list, { timeoutMs, sandbox: true });
  return { ok: res.ok, exitCode: res.exitCode, text: describeRun(`${rel} ${list.join(' ')}`.trim(), res, cfg) };
}

async function opExec(cfg, args = {}) {
  const file = String(args.file ?? '');
  if (!file) return { ok: false, exitCode: null, text: '需要 file（白名单内的可执行文件）。' };
  const base = path.basename(file).toLowerCase().replace(/\.exe$/, '');
  if (!cfg.allowExec.includes(base)) {
    return { ok: false, exitCode: null, text: `不在白名单内: ${base}\n允许: ${cfg.allowExec.join(', ')}` };
  }
  let cwd = cfg.repo;
  if (args.cwd) {
    const resolved = path.isAbsolute(String(args.cwd)) ? path.resolve(String(args.cwd)) : path.resolve(cfg.repo, String(args.cwd));
    if (!isInside(cfg.root, resolved) && !isInside(cfg.tempRoot, resolved)) {
      return { ok: false, exitCode: null, text: `cwd 必须落在项目目录或 %TEMP% 内；被拒绝: ${resolved}` };
    }
    cwd = resolved;
  }
  const list = Array.isArray(args.args) ? args.args.map((s) => String(s)) : [];
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : cfg.shortTimeoutMs;
  const res = await runProcess(file, list, { cwd, timeoutMs, input: args.input, sandbox: true });
  return { ok: res.ok, exitCode: res.exitCode, text: describeRun(`${file} ${list.join(' ')}`.trim(), res, cfg) };
}

async function opDocs(cfg, args = {}) {
  const action = String(args.action ?? 'check');
  const list = Array.isArray(args.args) ? args.args.map((s) => String(s)) : [];
  if (action === 'check') {
    const scriptPath = path.join(cfg.repo, 'tools', 'check_docs_refs.py');
    const res = await runProjectScript(cfg, scriptPath, [cfg.repo, ...list], { timeoutMs: 120000, sandbox: true });
    return { ok: res.ok, exitCode: res.exitCode, text: describeRun('check_docs_refs.py', res, cfg) };
  }
  if (action === 'patch') {
    const scriptPath = path.join(cfg.repo, 'tools', 'doc_patch.py');
    const res = await runProjectScript(cfg, scriptPath, list, { timeoutMs: 120000, sandbox: true });
    return { ok: res.ok, exitCode: res.exitCode, text: describeRun(`doc_patch.py ${list.join(' ')}`, res, cfg) };
  }
  return { ok: false, exitCode: null, text: `未知 action: ${action}` };
}

async function opAgents(cfg, args = {}) {
  const action = String(args.action ?? 'list');
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 300000;
  if (action === 'list') {
    const scriptPath = path.join(cfg.repo, 'tools', 'who_can_i_reuse.ps1');
    const res = await runProjectScript(cfg, scriptPath, ['-ShowMain'], { timeoutMs: 60000, sandbox: true });
    return { ok: res.ok, exitCode: res.exitCode, text: describeRun('who_can_i_reuse.ps1 -ShowMain', res, cfg) };
  }
  if (action === 'sync') {
    const list = [];
    if (args.name) list.push('-Only', String(args.name));
    if (args.force === true) list.push('-Force');
    const scriptPath = path.join(cfg.repo, 'tools', 'sync_agent_spaces.ps1');
    const res = await runProjectScript(cfg, scriptPath, list, { timeoutMs, sandbox: true });
    return { ok: res.ok, exitCode: res.exitCode, text: describeRun('sync_agent_spaces.ps1', res, cfg) };
  }
  if (action === 'create') {
    if (!args.name) return { ok: false, exitCode: null, text: 'create 需要 name。' };
    const list = ['-Name', String(args.name)];
    if (args.recreate === true) list.push('-Recreate');
    const scriptPath = path.join(cfg.repo, 'tools', 'agent_space.ps1');
    const res = await runProjectScript(cfg, scriptPath, list, { timeoutMs, sandbox: true });
    return { ok: res.ok, exitCode: res.exitCode, text: describeRun(`agent_space.ps1 ${args.name}`, res, cfg) };
  }
  return { ok: false, exitCode: null, text: `未知 action: ${action}` };
}

/**
 * pico_amend：AI 申请修改【受管脚本】（＝跑在沙箱外的那批）。
 * 流程（用户 2026-10-07 裁定）：取 diff ⇒ 委派【一次性审判员】⇒
 *   · 合理 ⇒ 登记新指纹 + 同步进运行本（生效）
 *   · 否则 ⇒ 用运行本覆盖工作区里被改过的那份（回滚）
 * 审判员只读 diff、只出结构化裁决；判完立刻 dispose。拿不到 subagents/parent ⇒ 什么都不做。
 */
function managedChangedFiles(cfg) {
  return trustedScripts(cfg).filter((rel) => !trustVerdict(cfg, path.join(cfg.root, rel)).ok);
}

async function opAmend(cfg, args = {}) {
  const rels = (Array.isArray(args.paths) && args.paths.length > 0 ? args.paths.map((s) => String(s)) : managedChangedFiles(cfg)).filter(Boolean);
  if (rels.length === 0) {
    return { ok: true, exitCode: 0, text: '受管脚本当前全部与登记指纹一致 —— 没有需要裁决的改动。' };
  }
  const repoRel = path.relative(cfg.root, cfg.repo).split(path.sep).join('/');
  // 取 diff：受管脚本可能【不在 cfg.repo 里】（如 dsh-plugins\ 下的 worker 属于另一个 worktree）
  // ⇒ 逐个文件找最近的 .git，按仓库根分组取 diff。
  // 2026-10-07 审判员实测发现：写死 cfg.repo 会对这类文件恒取到【空 diff】（git 对不匹配的
  // pathspec 静默返回空）⇒ 审判员盲判。空 diff 现在会被显式写进提示词里当警告。
  const byRoot = new Map();
  for (const rel of rels) {
    const abs = path.join(cfg.root, rel);
    let dir = path.dirname(abs);
    let root = cfg.repo;
    for (let i = 0; i < 12; i += 1) {
      if (existsSync(path.join(dir, '.git'))) { root = dir; break; }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(path.relative(root, abs).split(path.sep).join('/'));
  }
  let diffText = '';
  let diffNote = '';
  for (const [root, list] of byRoot) {
    const res = await runProcess('git', ['-C', root, 'diff', '--', ...list], { cwd: cfg.repo, timeoutMs: 60000, sandbox: true });
    diffText += `# 仓库根 ${root}\n${res.stdout || ''}\n`;
    const untracked = await runProcess('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '--', ...list], { cwd: cfg.repo, timeoutMs: 30000, sandbox: true });
    const u = (untracked.stdout || '').trim();
    if (u) diffNote += `\n注意：以下文件是【未跟踪的新文件】，git diff 没有基线：${u}`;
    if (res.spawnError) diffNote += `\n注意：取 diff 失败（${res.spawnError}）`;
  }
  if (!diffText.replace(/# 仓库根 .*/g, '').trim()) diffNote += '\n警告：本次 diff 为空 —— 若确实有改动，说明仓库根判断错，请人工核实后再裁决。';
  // 取服务两种方式都试：apply 时的 inject 没回调过，就在调用时 ctx.get 一次（2026-10-07 实测 inject 没拿到）
  const svc = cfg.subagents ?? cfg.pluginCtx?.get?.('subagents');
  const parent = cfg.currentAgent;
  if (!svc || !parent) {
    return { ok: false, exitCode: null, text: `⚠️ 无法委派审判员（subagents=${Boolean(svc)} / parent=${Boolean(parent)}）⇒ 【不做任何改动】，请人工处理。` };
  }
  const provider = (svc.list?.() ?? [])[0];
  if (!provider) return { ok: false, exitCode: null, text: '⚠️ 没有可用的 subagent provider ⇒ 【不做任何改动】。' };
  const prompt = [
    '你是一次性审判员：判断"受管脚本"的这次改动是否合理。只依据 diff，不要臆测。',
    '背景：这些脚本跑在 DSH 沙箱【之外】（要碰设备 / 要跑 cmake），所以其内容必须是人工认可过的版本；',
    'AI 改完必须经你裁决才能生效。',
    '判"可疑/有害"的例子：往窗口外写文件、联网外传、读取凭据或令牌、无注释且与理由不符、',
    '与声明理由无关的大段重写、混淆或编码技巧、削弱既有校验。',
    `AI 给的理由：${String(args.why ?? '(未给)')}`,
    `涉及文件：${rels.join(', ')}`,
    'diff：',
    (diffText || '(空)').slice(0, 20000),
    diffNote,
  ].join('\n');
  let run;
  try {
    run = await svc.start(provider, {
      label: 'trust-judge',
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal: new AbortController().signal,
      maxDepth: 1, // 子本身即 depth 1（0 会被拒：'subagent depth 1 exceeds maxDepth 0'，2026-10-07 实测）；1 = 只准它自己、不准再往下派
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['verdict', 'reasons'],
        properties: {
          verdict: { type: 'string', enum: ['合理', '可疑', '有害'] },
          reasons: { type: 'array', items: { type: 'string' } },
        },
      },
    });
  } catch (error) {
    return { ok: false, exitCode: null, text: `⚠️ 委派审判员失败：${error && error.message ? error.message : error} ⇒ 【不做任何改动】。` };
  }
  let verdict = '';
  let reasons = [];
  try {
    const result = await run.result;
    verdict = String(result?.structured?.verdict ?? '');
    reasons = Array.isArray(result?.structured?.reasons) ? result.structured.reasons : [];
  } finally {
    try { await run.dispose(); } catch { /* 一次性，判完就放 */ }
  }
  const lines = [`审判员裁决：${verdict || '(无结构化输出)'}`, ...reasons.map((r) => `  · ${r}`), ''];
  if (verdict === '合理') {
    for (const rel of rels) registerTrust(cfg, path.join(cfg.root, rel));
    runtimeTreeKey = '';
    lines.push(ensureRuntimeTree(cfg) ? `✅ 已登记并同步进运行本：${rels.join(', ')}` : '✗ 裁决合理，但运行本刷新失败（请查指纹）');
  } else {
    for (const rel of rels) {
      const wsPath = path.join(cfg.root, rel);
      const rtPath = path.join(runtimeRoot(cfg), rel);
      try {
        if (existsSync(rtPath)) { writeFileSync(wsPath, readFileSync(rtPath)); lines.push(`↩︎ 已用运行本覆盖：${rel}`); }
        else lines.push(`· 运行本里没有 ${rel}（新文件？）⇒ 未覆盖，请人工处理`);
      } catch (error) { lines.push(`✗ 覆盖 ${rel} 失败：${error && error.message ? error.message : error}`); }
    }
  }
  return { ok: verdict === '合理', exitCode: null, text: lines.join('\n') };
}

const OPS = {  status: opStatus,
  build: opBuild,
  flash: opFlash,
  serial: opSerial,
  console: opConsole,
  swd: opSwd,
  procs: opProcs,
  temp: opTemp,
  git: opGit,
  run: opRun,
  exec: opExec,
  docs: opDocs,
  agents: opAgents,
  amend: opAmend,
};

// ---------------------------------------------------------------- 工具定义

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

function tool(cfg, name, description, parameters, opName) {
  return {
    name: `pico_${name}`,
    description,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) },
      ],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? cfg.agentsService?.currentInitiator?.()?.id ?? null;
      return await OPS[opName](cfg, args ?? {}, { sessionId });
    },
  };
}

const BOARD_ENUM = ['dut', 'probe', 'sampler'];

function buildToolDefinitions(cfg) {
  return [
    tool(
      cfg,
      'status',
      'Report the PicoPhone rig: managed paths, toolchain versions, git branch/head/dirty, USB devices with VID 2E8A, who holds the rig lock, the last image from the flash ledger, and hung debug processes. Read-only; returns the same facts as a json object beside the text so two runs can be compared mechanically.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          probeSerial: { type: 'boolean', description: 'Also sample the board serial for a couple of seconds. This is the fastest way to notice that the board is not running the firmware a handover note claims.' },
          probeSeconds: { type: 'number', description: 'Sampling window for probeSerial; default 2 s.' },
          probeTarget: { type: 'string', enum: BOARD_ENUM, description: 'Which board probeSerial reads; default `dut`.' },
        },
      },
      'status',
    ),
    tool(
      cfg,
      'build',
      'Build with the project-owned scripts and return the exit code, the log tail, and the artifact path with its timestamp. On success it also writes build_info.txt (source commit, dirty flag, toolchain) beside the artifact; on failure it returns the first few compiler errors instead of only the log tail.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: {
            type: 'string',
            description: '`root` for the main firmware, `host-test` for the PC-side kernel self-tests, or a subproject name such as `wboard_dvi`, `core1_monitor`, `probe_rp2040`.',
          },
          buildSub: {
            type: 'string',
            description: 'Subproject build directory, default `build`. Use a separate one (for example `build_slow`) so an experiment never overwrites the full-speed artifact.',
          },
          noUf2: {
            type: 'boolean',
            description: 'Subprojects only: skip the extra elf→uf2 conversion step. The uf2 still appears, because every subproject CMakeLists calls pico_add_extra_outputs() and ninja emits it — this flag only avoids a redundant conversion.',
          },
          cacheArgs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Extra cmake configure arguments, each element carrying its own -D, for example `-DWBOARD_DVI_SM_CLKDIV=8`.',
          },
          timeoutMs: { type: 'number', description: 'Hard timeout, default 900000 ms.' },
        },
      },
      'build',
    ),
    tool(
      cfg,
      'flash',
      'Write a uf2 onto a board and report what the board answered. The default backdoor method asks the running firmware to enter BOOTSEL over serial. Flashing interrupts the running app, and on this rig the BOOTSEL button is the only recovery. Before writing it verifies the mounted BOOTSEL volume identity against the intended board, takes the rig lock, and appends an entry to debug_logs/flash_ledger.jsonl recording the image fingerprint, the source commit and the outcome, so "which image is on the board" stays answerable.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['board'],
        properties: {
          board: { type: 'string', enum: BOARD_ENUM, description: 'Which board receives the image.' },
          firmware: { type: 'string', description: 'Absolute or repo-relative path to the .uf2.' },
          method: {
            type: 'string',
            enum: ['backdoor', 'bootsel', 'picotool', 'list', 'auto'],
            description: '`backdoor` (default) uses the firmware serial backdoor, `bootsel` uses tools/flash_bootsel.ps1, `picotool` uses picotool load -x, `list` only enumerates boards and drives, `auto` tries backdoor then picotool and says plainly when a human must press BOOTSEL.',
          },
          force: { type: 'boolean', description: 'Flash even though the BOOTSEL volume identity does not match the intended board. Off by default: the DUT and the probe expose near-identical boot volumes, and a wrong write is expensive on a rig with no reset pin.' },
          skipVolumeCheck: { type: 'boolean', description: 'Skip the boot-volume identity check entirely (dry runs and non-volume methods).' },
          dryRun: { type: 'boolean', description: 'Resolve and print the exact commands plus the volume check result without touching hardware.' },
          timeoutMs: { type: 'number', description: 'Hard timeout, default 120000 ms.' },
        },
      },
      'flash',
    ),
    tool(
      cfg,
      'serial',
      'Read a USB CDC port once for a bounded time and return the captured text. Identify boards by VID/PID rather than COM number, because the number changes on every replug. Opening costs about 4.5 s, so use pico_console when several reads or a send-then-wait are needed. Takes the rig lock, so a concurrent reader fails loudly instead of fighting over the port.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', enum: BOARD_ENUM, description: 'Which known device to read; default `dut`.' },
          port: { type: 'string', description: 'Explicit COM port; wins over target.' },
          vid: { type: 'string', description: 'Custom VID, with pid, when the device is not one of the known targets.' },
          pid: { type: 'string', description: 'Custom PID, with vid.' },
          seconds: { type: 'number', description: 'Capture window, default 5 s.' },
          send: { type: 'string', description: 'Text written after opening. The probe backdoor needs a CR terminator.' },
          escapes: { type: 'boolean', description: 'Interpret send as a PowerShell escape sequence, so `` `r `` becomes CR.' },
          outFile: { type: 'string', description: 'Where to save the capture. Always lands under %TEMP%: a relative path resolves there, and an absolute path outside it is re-fenced into it (reported as 围栏). Defaults to a timestamped file in %TEMP%, whose contents are echoed back either way.' },
          list: { type: 'boolean', description: 'Only enumerate ports and their VID/PID.' },
          timeoutMs: { type: 'number', description: 'Hard timeout, default 120000 ms.' },
        },
      },
      'serial',
    ),
    tool(
      cfg,
      'console',
      'Keep one serial port open across calls and drive the board interactively. `open` pays the 4-5 s port-open cost once, then `send` / `read` / `expect` are cheap — use this instead of pico_serial when a firmware is key-driven. `expect` sends and waits until a line matches a regular expression, so no sleep duration has to be guessed; a timeout says explicitly that nothing matched. Lines carry wall-clock timestamps by default, which is what makes "flashes every 30 s" provable. The rig lock is held while the session is open and released on close or after the idle timeout.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['open', 'send', 'read', 'expect', 'close', 'list'], description: 'Session operation.' },
          sessionId: { type: 'string', description: 'Session name, default `default`; reuse one name to keep a single port open.' },
          target: { type: 'string', enum: BOARD_ENUM, description: 'Which known device to open; default `dut`.' },
          port: { type: 'string', description: 'Explicit COM port; wins over target.' },
          baud: { type: 'number', description: 'Baud rate; USB CDC ignores it. Default 115200.' },
          data: { type: 'string', description: 'Text to send (`send` and `expect`).' },
          escapes: { type: 'boolean', description: 'Interpret data as a PowerShell escape sequence, so `` `r `` becomes CR.' },
          until: { type: 'string', description: 'Regular expression that ends the wait early (`read` and `expect`).' },
          timeoutMs: { type: 'number', description: 'How long to wait for data before reporting a timeout; default 2000 ms.' },
          stamp: { type: 'boolean', description: 'Prefix every line with its arrival time; default true. Set false for byte-exact output.' },
        },
      },
      'console',
    ),
    tool(
      cfg,
      'temp',
      'Read and write files under the session %TEMP% directory, the scratch area the project uses for captures, payloads and dumps. Paths are confined to %TEMP% and cannot escape it.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['path', 'ls', 'read', 'write', 'append', 'stat', 'mkdir', 'rm', 'cp', 'mv'], description: 'Operation to perform; `path` prints the %TEMP% root.' },
          path: { type: 'string', description: 'Path relative to %TEMP%; omit for `path`.' },
          from: { type: 'string', description: 'Source path for `cp` and `mv`, relative to %TEMP%.' },
          content: { type: 'string', description: 'Payload for `write` and `append`.' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'How to read `content`; `base64` writes the decoded bytes.' },
          maxBytes: { type: 'number', description: 'For `read`: show only the last N bytes, default 200000.' },
        },
      },
      'temp',
    ),
    tool(
      cfg,
      'git',
      'Run git in the main repository or in one isolated agent space and return its output. History-changing verbs (commit, push, reset, checkout, merge, ...) are refused unless mutate is true.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['args'],
        properties: {
          repo: { type: 'string', description: '`main` for DeepSeekCode, or an `_agents/<name>` space name; default `main`.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Verbatim git arguments, for example `["log","--oneline","-5"]`.' },
          mutate: { type: 'boolean', description: 'Required true for verbs that change repository state.' },
          timeoutMs: { type: 'number', description: 'Hard timeout, default 120000 ms.' },
        },
      },
      'git',
    ),
    tool(
      cfg,
      'run',
      'Run one project script under the repository tools/ directory or the project dsh-plugins/ directory (ps1, cmd, bat, py) and return its exit code and output. This is how the SWD tool, the process guard, the agent-space scripts, the documentation gates and the telemetry parsers are reached; scripts elsewhere are refused.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['script'],
        properties: {
          script: { type: 'string', description: 'Path relative to the repository, for example `tools/swd.ps1` or `tools/host_test/run_all.cmd`.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed verbatim to the script.' },
          timeoutMs: { type: 'number', description: 'Hard timeout, default 120000 ms.' },
        },
      },
      'run',
    ),
    tool(
      cfg,
      'exec',
      'Run one allow-listed build or debug executable and return its exit code and output. The ~\\.pico-sdk toolchain directories (cmake, ninja, arm-none-eabi-*, picotool, openocd) and the Visual Studio vswhere/MSBuild directories are prepended to PATH for the child, so those names resolve even though they are not on the system PATH. Shells are deliberately excluded, and so is `cl`, which cannot run without a Visual Studio developer environment; use pico_run for project scripts and pico_build host-test for the MSVC build chain.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['file'],
        properties: {
          file: { type: 'string', description: 'Executable name from the allow list, for example `cmake` or `arm-none-eabi-objdump`.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed verbatim.' },
          cwd: { type: 'string', description: 'Working directory inside the project or %TEMP%; default the DeepSeekCode repo.' },
          input: { type: 'string', description: 'Text written to the process stdin.' },
          timeoutMs: { type: 'number', description: 'Hard timeout, default 120000 ms.' },
        },
      },
      'exec',
    ),
  ];
}

// ---------------------------------------------------------------- /pico 命令

const HELP = [
  '/pico —— PicoPhone 台架命令',
  '',
  '  /pico status [--probe [--seconds N]]  路径 / 工具链 / git / 设备 / 台架锁 / 烧写账本 / 悬挂进程',
  '  /pico lock [clear]                看谁占着台架锁 / 清掉（确认是陈锁再用）',
  '  /pico build [root|<子工程>|host-test] [--sub <目录>] [--no-uf2] [--D <定义>]',
  '  /pico flash <dut|probe|sampler> [uf2路径] [--list] [--dry] [--method auto|backdoor|bootsel|picotool] [--force]',
  '  /pico serial [dut|probe|sampler] [秒数] [--send <文本>] [--esc] [--out <文件>] [--list]',
  '  /pico console <open|send|read|expect|close|list> [会话名] [数据] [--until <正则>] [--timeout <ms>] [--target <板>] [--no-stamp]',
  '  /pico swd <参数...>               （原样转发给 tools\\swd.ps1）',
  '  /pico procs [list|kill|sweep] [COM号]',
  '  /pico temp <path|ls|read|write|append|stat|mkdir|rm> <相对路径> [内容]',
  '  /pico git [main|<空间名>] <git 参数...>   （写操作加 --mutate）',
  '  /pico run <tools下的脚本> [参数...]',
  '  /pico exec <白名单可执行文件> [参数...]',
  '  /pico docs <check|patch ...>',
  '  /pico agents <list|sync|create <名字>> [--force|--recreate]',
  '',
  'Agent 侧对应工具：pico_status / pico_build / pico_flash / pico_serial / pico_console / pico_temp / pico_git / pico_run / pico_exec',
].join('\n');

function parseFlags(argv) {
  const rest = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      rest.push(token);
    }
  }
  return { rest, flags };
}

async function dispatchCommand(cfg, line, ctx = {}) {
  const argv = line.trim().split(/\s+/).filter((s) => s !== '');
  if (argv.length === 0) return { kind: 'success', text: HELP };
  const verb = argv[0].toLowerCase();
  const tail = argv.slice(1);

  if (verb === 'help' || verb === '?') return { kind: 'success', text: HELP };

  const wrap = (result) => (result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text });

  try {
    switch (verb) {
      case 'status':
      case 'env': {
        const { flags } = parseFlags(tail);
        return wrap(
          await opStatus(cfg, {
            probeSerial: flags.has('probe'),
            probeSeconds: flags.get('seconds') === undefined || flags.get('seconds') === true ? undefined : Number(flags.get('seconds')),
            probeTarget: flags.get('target'),
          }, ctx),
        );
      }
      case 'trust': {
        return await opTrust(cfg, { action: (tail[0] ?? 'list').toLowerCase(), name: tail[1] ?? '' });
      }
      case 'lock': {
        const file = lockFilePath(cfg);
        const info = readLockFile(file);
        if (tail[0] === 'clear' || tail[0] === 'unlock' || tail[0] === '--force') {
          try {
            unlinkSync(file);
            return { kind: 'success', text: `已删除台架锁 ${file}` };
          } catch (error) {
            return { kind: 'error', text: `删除失败: ${error && error.message ? error.message : error}` };
          }
        }
        return { kind: 'success', text: info ? `台架被占用: ${lockHolderText(info)}\n锁文件: ${file}` : `台架空闲（${file} 不存在）` };
      }
      case 'console': {
        const { rest, flags } = parseFlags(tail);
        const op = (rest[0] ?? 'list').toLowerCase();
        const data = flags.get('data') ?? (rest.length > 2 ? rest.slice(2).join(' ') : undefined);
        return wrap(
          await opConsole(cfg, {
            op,
            sessionId: rest[1],
            target: flags.get('target'),
            port: flags.get('port'),
            data: data === true ? undefined : data,
            until: flags.get('until'),
            timeoutMs: flags.get('timeout') === undefined || flags.get('timeout') === true ? undefined : Number(flags.get('timeout')),
            escapes: flags.has('esc'),
            stamp: flags.has('no-stamp') ? false : undefined,
          }, ctx),
        );
      }
      case 'build': {
        const { rest, flags } = parseFlags(tail);
        const target = rest[0] ?? 'root';
        const cacheArgs = [];
        for (const [k, v] of flags) if (k.startsWith('D')) cacheArgs.push(v === true ? `-D${k.slice(1)}` : `-D${k.slice(1)}=${v}`);
        return wrap(
          await opBuild(cfg, {
            target,
            buildSub: flags.get('sub'),
            noUf2: flags.has('no-uf2') || flags.has('nouf2'),
            cacheArgs,
          }),
        );
      }
      case 'flash': {
        const { rest, flags } = parseFlags(tail);
        if (flags.has('list')) return wrap(await opFlash(cfg, { method: 'list' }, ctx));
        return wrap(
          await opFlash(cfg, {
            board: rest[0] ?? 'dut',
            firmware: rest[1],
            method: flags.get('method') ?? 'backdoor',
            dryRun: flags.has('dry') || flags.has('dry-run'),
          }, ctx),
        );
      }
      case 'serial': {
        const { rest, flags } = parseFlags(tail);
        if (flags.has('list')) return wrap(await opSerial(cfg, { list: true }, ctx));
        return wrap(
          await opSerial(cfg, {
            target: rest[0] ?? 'dut',
            seconds: rest[1] === undefined ? undefined : Number(rest[1]),
            send: flags.get('send'),
            escapes: flags.has('esc') || flags.has('escapes'),
            outFile: flags.get('out'),
          }, ctx),
        );
      }
      case 'swd':
        return wrap(await opSwd(cfg, { args: tail }));
      case 'procs':
      case 'guard': {
        const action = (tail[0] ?? 'list').toLowerCase();
        return wrap(await opProcs(cfg, { action, waitFree: tail[1] }));
      }
      case 'temp': {
        const op = (tail[0] ?? 'path').toLowerCase();
        const rel = tail[1];
        const content = tail.slice(2).join(' ');
        return wrap(await opTemp(cfg, { op, path: rel, content: content === '' ? undefined : content }));
      }
      case 'git': {
        const { rest, flags } = parseFlags(tail);
        let repo = 'main';
        let gitArgv = rest;
        if (rest[0] === 'main' || rest[0] === 'agent' || rest[0]?.startsWith('agent/')) {
          repo = rest[0] === 'agent' ? rest[1] : rest[0];
          gitArgv = rest.slice(rest[0] === 'agent' ? 2 : 1);
        } else if (rest.length > 0 && existsSync(path.join(cfg.root, '_agents', rest[0]))) {
          repo = rest[0];
          gitArgv = rest.slice(1);
        }
        return wrap(await opGit(cfg, { repo, args: gitArgv, mutate: flags.has('mutate') }));
      }
      case 'run':
        if (tail.length === 0) return { kind: 'error', text: '用法: /pico run <tools下的脚本> [参数...]' };
        return wrap(await opRun(cfg, { script: tail[0], args: tail.slice(1) }));
      case 'exec':
        if (tail.length === 0) return { kind: 'error', text: '用法: /pico exec <白名单可执行文件> [参数...]' };
        return wrap(await opExec(cfg, { file: tail[0], args: tail.slice(1) }));
      case 'docs': {
        const action = (tail[0] ?? 'check').toLowerCase();
        return wrap(await opDocs(cfg, { action, args: tail.slice(1) }));
      }
      case 'agents': {
        const { rest, flags } = parseFlags(tail);
        const action = (rest[0] ?? 'list').toLowerCase();
        return wrap(await opAgents(cfg, { action, name: rest[1], force: flags.has('force'), recreate: flags.has('recreate') }));
      }
      default:
        return { kind: 'error', text: `未知子命令: ${verb}\n\n${HELP}` };
    }
  } catch (error) {
    return { kind: 'error', text: `执行失败: ${error && error.message ? error.message : error}` };
  }
}

// ---------------------------------------------------------------- 插件入口

/**
 * 注入系统提示的"台架须知"。为什么要有它（2026-10-06 实测）：
 *   本插件原先**只**注册工具 + 命令 ⇒ 对"新来的 AI"而言，唯一常显通道就是工具说明；
 *   而项目自己的必读文件（`子Agent须知.md` / `开子Agent必读.md` / `docs\工作守则.md`）
 *   里**一个字都没提 pico_\*** —— 全库 26 处提及**全部**在本插件 README 里 ⇒
 *   新会话会去手搓 `tools\serial.ps1` 那套旧流程，白白错过台架锁与账本 ✗。
 * 所以在这里补一段**短**说明（每轮请求都进 system prompt，必须克制）：
 *   只讲"会踩坑的规矩"，细节一律指到 `docs/台架接口.md` 与本插件 README。
 * ⚠️ 这段文字里**不许出现反引号**（外面是 JS 模板字符串，反引号会把它截断 ✗）。
 */
const RIG_PROMPT = [
  'PicoPhone 台架（本 profile 常驻）已把常用操作装成一级工具：pico_status / pico_build /',
  'pico_flash / pico_serial / pico_console / pico_temp / pico_git / pico_run / pico_exec。',
  '**先调 pico_status 看台架状态，不要手搓 tools/ 下的旧命令**；等价的人工入口是 /pico 命令。',
  '',
  '- 板子：dut = RP2350 待测板（2E8A:0009）；probe = RP2040 debugprobe（2E8A:000C，它的后门要 ESC ESC 前缀）；sampler = 采样探针。',
  '- **串口与烧写互斥**：两者都占台架锁（锁文件在 $DSH_HOME\\picophone.lock），并发会被明确拒绝并报出占用者；空闲 2 分钟自动关会话并释放。',
  '- **按键驱动的固件用 pico_console**（open 只付一次 4~5 秒开口成本，之后 send/read/expect 很便宜），不要用 pico_serial 反复开关同一个口。',
  '- **烧写纪律（这块台架没有 RUN 引脚、SWD 不可用 ⇒ BOOTSEL 按钮是唯一救砖手段）**：①要烧的固件必须自带串口后门（B = 进 BOOTSEL、R = 重启）；',
  '  ②像 empty.uf2 那种**不开 USB stdio 的固件不能当中转件**（烧上去既没串口也没后门）；要中转就编 backdoor_only。',
  '- **"板上现在跑的是哪一份"**：看 pico_status 的「最后烧写」（记在 debug_logs/flash_ledger.jsonl，含 uf2 的 sha256 前 16 位与源码 commit）；pico_build 会把 build_info.txt 落在产物旁。',
  '- 每个工具的参数、行为与**全部失败分支**见 DeepSeekCode\\docs\\台架接口.md；插件自述见 dsh-plugins\\dsh-picophone\\README.md。',
].join('\n');

export async function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig);
  // Host 进程 env 里没有 DSH_SESSION_ID；agent 服务能给出"当前调用链的发起者"。
  cfg.agentsService = ctx.get ? ctx.get('agents') : undefined;
  // ⚠️ 必须是 `cfg.profileName || ...`：直接赋值会把 config 里手填的 profileName 清成 ''。
  cfg.profileName = cfg.profileName || detectProfileName(ctx);
  // 沙箱执行器：装上了，就把"跑任意代码"的那几个 op 送进去（见 SANDBOX_MODE 的注释）。
  // ⚠️ 必须用 ctx.inject(['shell'], …) 解析 —— 实测 ctx.get('shell') 在这个组合里拿不到
  //    （2026-10-07 首跑：全部沙箱 op 报"沙箱执行器不可用"，就是踩了这个）。
  ctx.inject(['shell'], (shellCtx) => {
    sandboxContext = { shell: shellCtx.shell, workspaceRoot: cfg.root };
  });
  // 审批服务：指纹不符时由 AI 发起申请、人点同意（不用人记任何命令）
  cfg.pluginCtx = ctx;
  ctx.inject(['approval'], (approvalCtx) => {
    cfg.approval = approvalCtx.approval;
  });
  const definitions = [
    ...buildToolDefinitions(cfg),
    tool(
      cfg,
      'amend',
      '请求修改【受管脚本】(= 跑在沙箱外的那批)。插件把 diff 交给一次性审判员裁决：合理 ⇒ 登记新指纹并同步进运行本(生效)；否则 ⇒ 用运行本覆盖你的改动(回滚)。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '受管脚本路径(相对工作区，如 DeepSeekCode/tools/build.cmd)；缺省 = 自动找出与登记指纹不符的那些' },
          why: { type: 'string', description: '为什么要改(审判员会看)' },
        },
      },
      'amend',
    ),
  ];

  for (const definition of definitions) {
    // 【审批用】每次工具调用都记下它的 exec 上下文 —— `approval.request` 必须带 agent 才发得出去。
    // 只记不拦：绝不改参数、绝不吞异常；拦/放仍由信任门自己决定。
    // 拿不到 agent 时 cfg.currentAgent 保持原样（最终为 undefined）⇒ 审批报 'unavailable' ⇒ 拒绝（fail-closed）。
    const inner = definition.execute;
    if (typeof inner === 'function') {
      definition.execute = async (args, exec) => {
        if (exec && exec.agent) cfg.currentAgent = exec.agent;
        return inner.call(definition, args, exec);
      };
    }
    ctx.effect(() => ctx.tools.register(definition), `dsh-picophone: ${definition.name}`);
  }

  // ---- 系统提示注入（让"新来的 AI"一睁眼就知道这套接口该怎么用）-------------
  // 用 ctx.inject（**不是**直接 ctx.systemPrompt.section()）：
  //   systemPrompt 服务没挂载时**静默不生效** ⇒ 绝不会因为注入失败而把整个插件带崩 ✗
  //   （注册工具才是命根子：注入挂了顶多少一段说明，工具挂了就什么都没了）。
  // order 2705 = 紧跟在 SECTION_ORDERS 的 TOOL_RALPH(2700) 之后、TOOL_SUBAGENT(2800) 之前；
  //   该表是 dsh-system-prompt 的固定档位（type PromptSectionOrderName = keyof SECTION_ORDERS），
  //   但 section() 只要求 order 有限、名字在本层唯一 ⇒ 用明确的字面量最稳。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    // 防御：真 Host 里 inject(['systemPrompt']) 保证服务存在，但**冒烟测试的假 ctx 可能没铺桩**
    // ⇒ 2026-10-06 实测：不加这层守卫，smoke-test 会在这里抛
    //   `TypeError: Cannot read properties of undefined (reading 'section')`，
    //   把整包 9 个工具一起带走 ✗（注入只是"锦上添花"，绝不能拖垮工具注册）。
    const sp = promptCtx && promptCtx.systemPrompt;
    if (!sp || typeof sp.section !== 'function') return;
    sp.section({
      name: 'picophone:rig',
      order: 2705,
      // 只在 pico_status 这个工具**真的注册了**时才发这段（服务没挂/工具被禁 ⇒ 空串）
      text: ({ scope }) => (ctx.tools.get('pico_status', scope) === undefined ? '' : RIG_PROMPT),
    });
  });

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'pico',
      description: 'PicoPhone 台架命令：构建 / 烧写 / 串口 / SWD / %TEMP% / git / 脚本',
      input: { hint: '[status|build|flash|serial|swd|procs|temp|git|run|exec|docs|agents]' },
      handler: async (invocation) => await dispatchCommand(cfg, invocation.rawInput ?? '', { sessionId: invocation.agent?.id ?? null }),
    });
  });

  if (ctx.logger && typeof ctx.logger.info === 'function') {
    ctx.logger.info(`dsh-picophone: 已挂载 ${definitions.length} 个工具 + 1 个命令（root=${cfg.root}）`);
  }
}
