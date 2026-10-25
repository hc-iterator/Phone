// /pico swd：原样转发给 tools/swd.ps1（没有注册成 Agent 工具）。

import path from 'node:path';

import { describeRun, runProjectScript } from '../lib/exec.js';

export async function opSwd(cfg, args = {}) {
  const list = Array.isArray(args.args) ? args.args.map((s) => String(s)) : [];
  if (list.length === 0) list.push('probe');
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : cfg.shortTimeoutMs;
  const res = await runProjectScript(cfg, path.join(cfg.repo, 'tools', 'swd.ps1'), list, { timeoutMs });
  return { ok: res.ok, exitCode: res.exitCode, text: describeRun(`swd.ps1 ${list.join(' ')}`, res, cfg) };
}
