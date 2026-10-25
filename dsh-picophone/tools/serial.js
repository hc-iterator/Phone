// pico_serial：单次串口读（按 VID:PID 认板），默认把正文落到 %TEMP% 并回显。

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { describeRun, runProjectScript } from '../lib/exec.js';
import { acquireRigLock, releaseRigLock } from '../lib/identity.js';
import { safeTempPath } from '../lib/paths.js';
import { BOARD_ENUM, registerDefinition, tool } from '../lib/tool.js';
import { tailFile } from '../lib/util.js';

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

export async function opSerial(cfg, args = {}, ctx = {}) {
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

export function register(ctx, deps) {
  const { cfg } = deps;
  const definition = tool(
      cfg,
      'serial',
      'Read one USB CDC port for a bounded time; identify boards by VID/PID, never COM. Takes the rig lock; capture lands in %TEMP%.',
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
      opSerial,
    );
  return registerDefinition(ctx, cfg, definition);
}
