// 沙箱外脚本的信任门 + 运行本（runtime）：指纹清单、审批、拒绝话术。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { currentSessionId } from './identity.js';
import { PACKAGE_DIR } from './paths.js';

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
  // 审计缺口①②（2026-10-07）：host_test 的入口与 serial.ps1 的子脚本，原先不在名单里
  'tools/host_test/run_all.cmd',
  'tools/serial_worker.ps1',
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
export function trustedScripts(cfg) {
  const prefix = path.relative(cfg.root, cfg.repo).split(path.sep).join('/');
  return [...TRUSTED_REPO_TOOLS_REL.map((rel) => (prefix ? `${prefix}/${rel}` : rel)), ...TRUSTED_PLUGIN_REL];
}

// ---------------------------------------------------------------- 运行本（Pico 文件夹里的常设副本）

// 红队审计（2026-10-07）确认：豁免沙箱的 op 跑的是【工作区里的脚本】，而工作区正是被关住的
// Agent 唯一能写的地方 ⇒ 改脚本 / 改子脚本 / 改构建输入 = 窗外任意代码执行（缺口 ①②③）。
// 用户裁定：tools\ 只当【源码】（不运行）；Pico 文件夹里常设一份【运行本】，插件只跑运行本；
// AI 想改 ⇒ 走 pico_amend（一次性审判员）⇒ 合理则同步进运行本，否则用运行本覆盖回去。
export function runtimeRoot(cfg) {
  return path.join(cfg.trustDir, 'runtime');
}

/** 工作区文件 → 运行本路径（相对 <工作区的父目录> 保形 ⇒ 映射唯一、可预测）。 */
export function runtimePath(cfg, file) {
  return path.join(runtimeRoot(cfg), path.relative(path.dirname(path.resolve(cfg.repo)), path.resolve(file)));
}

/** 把工作区文件同步进运行本（人批准 / 审判员通过后调用）。返回运行本路径。 */
export function syncToRuntime(cfg, file) {
  const dst = runtimePath(cfg, file);
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, readFileSync(file)); // 用 read/write 而不是 copyFileSync：后者本文件没 import
  return dst;
}

/** 递归拷目录（只用已 import 的 fs：readdirSync / mkdirSync / readFileSync / writeFileSync）。 */
export function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

/** 所有受管脚本的指纹是否都与登记一致。 */
export function treeIsTrusted(cfg) {
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
export function ensureRuntimeTree(cfg) {
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
  // 给"运行本"留一张说明：这里才是真正被执行的那份；tools\ 只是源码（用户 2026-10-07 要求标记）
  try {
    writeFileSync(
      path.join(runtimeRoot(cfg), 'README-这是运行本.md'),
      [
        '# 这是运行本（Pico 文件夹内）',
        '',
        'pico_* 工具【只执行这里的这一份】。',
        '',
        '- `DeepSeekCode/tools/` = 源码 / **不运行的副本**：AI 可以改它，但改了对执行【没有影响】。',
        '- 想让改动生效 ⇒ 调 `pico_amend`（一次性审判员裁决）：合理 ⇒ 同步到这里；不合理 ⇒ 用这里的版本覆盖回去。',
        '- 旁边就是信任清单 `trusted-scripts.json`，同样在工作区之外（沙箱里的 Agent 两样都写不到）。',
        '',
        '_由 dsh-picophone 插件自动生成，别手改（下次刷新会覆盖）。_',
        '',
      ].join('\n'),
      'utf8',
    );
  } catch { /* 写不了说明不影响功能 */ }
  runtimeTreeKey = key;
  return rtRepo;
}

/** 拿"该跑的那一份"（运行本树里的同路径文件）。null = 不能跑（fail-closed）。 */
export function resolveRuntimeScript(cfg, file) {
  const dst = runtimePath(cfg, file);
  // ⚠️ 必须【先用已存在的运行本】：工作区被改脏（比如正在等审判员裁决）是【正常状态】，
  //    不该让全部窗外 op 一起瘫 —— 2026-10-07 实测：改一个受管脚本后连 proc_guard 都不跑了。
  if (existsSync(dst)) return dst;
  if (!ensureRuntimeTree(cfg)) return null;
  return existsSync(dst) ? dst : null;
}

export function trustFilePath(cfg) {  return path.join(cfg.trustDir, 'trusted-scripts.json');
}

/** 信任清单【必须】在工作区之外：否则被关住的 Agent 连清单一起改，这层就白加了。 */
export function trustDirIsSafe(cfg) {
  const root = path.resolve(cfg.root).toLowerCase().replace(/[\\/]+$/, '');
  const dir = path.resolve(cfg.trustDir).toLowerCase();
  return !(dir === root || dir.startsWith(`${root}${path.sep}`));
}

export function relToRoot(cfg, file) {
  return path.relative(cfg.root, file).split(path.sep).join('/');
}

export function sha256Of(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export function loadTrust(cfg) {
  try {
    const parsed = JSON.parse(readFileSync(trustFilePath(cfg), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.scripts ? parsed : { version: 1, scripts: {} };
  } catch {
    return null; // 不存在或读不了 ⇒ 一律按"未登记"处理（fail-closed）
  }
}

/** 只登记一个文件的当前指纹（审批通过后调用）。返回是否写成功。 */
export function registerTrust(cfg, file) {
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
export async function askTrustApproval(cfg, file, opts = {}) {
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
export function trustVerdict(cfg, file) {
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
export function trustRefusal(cfg, file) {
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

/** 让 ensureRuntimeTree 的缓存失效（原先是 opAmend 直接写 runtimeTreeKey = ''）。 */
export function invalidateRuntimeTree() {
  runtimeTreeKey = '';
}
