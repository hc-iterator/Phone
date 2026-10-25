// pico_status：台架体检（路径/工具链/git/设备/锁/烧写账本/悬挂进程）。

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { runProcess, runProjectScript } from '../lib/exec.js';
import { lockFilePath, lockHolderText, readLockFile } from '../lib/identity.js';
import { flashLedgerTail, ledgerLine } from '../lib/ledger.js';
import { gitArgsFor } from '../lib/paths.js';
import { state } from '../lib/state.js';
import { BOARD_ENUM, registerDefinition, tool } from '../lib/tool.js';
import { artifactInfo, clip } from '../lib/util.js';
import { opSerial } from './serial.js';

// ---------------------------------------------------------------- 各项能力

export async function opStatus(cfg, args = {}, ctx = {}) {
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
  for (const dir of state.toolPathPrefix.split(path.delimiter).filter(Boolean)) parts.push(`  ${dir}`);

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

export function register(ctx, deps) {
  const { cfg } = deps;
  const definition = tool(
      cfg,
      'status',
      'Rig overview: paths, toolchain versions, git state, devices, lock, last flash, hung processes. Read-only; also returns JSON.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          probeSerial: { type: 'boolean', description: 'Also sample the board serial for a couple of seconds; the fastest check for stale firmware.' },
          probeSeconds: { type: 'number', description: 'Sampling window for probeSerial; default 2 s.' },
          probeTarget: { type: 'string', enum: BOARD_ENUM, description: 'Which board probeSerial reads; default `dut`.' },
        },
      },
      opStatus,
    );
  return registerDefinition(ctx, cfg, definition);
}
