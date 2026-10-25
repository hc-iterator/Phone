// pico_flash：盘身份核对 → 占台架锁 → 按方法写 uf2 → 记烧写账本。

import { existsSync } from 'node:fs';
import path from 'node:path';

import { bootVolumes, checkBootVolume } from '../lib/boards.js';
import { describeRun, runProcess, runProjectScript } from '../lib/exec.js';
import { acquireRigLock, currentSessionId, releaseRigLock } from '../lib/identity.js';
import {
  appendFlashLedger,
  firmwareFingerprint,
  ledgerFilePath,
  repoStamp,
} from '../lib/ledger.js';
import { BOARD_ENUM, registerDefinition, tool } from '../lib/tool.js';

export async function opFlash(cfg, args = {}, ctx = {}) {
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

export function register(ctx, deps) {
  const { cfg } = deps;
  const definition = tool(
      cfg,
      'flash',
      'Write a uf2 to a board: checks the BOOTSEL Board-ID, takes the rig lock, appends the ledger. Only the BOOTSEL button recovers a wrong write.',
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
      opFlash,
    );
  return registerDefinition(ctx, cfg, definition);
}
