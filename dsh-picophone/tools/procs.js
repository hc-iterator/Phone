// /pico procs：转发给 tools/proc_guard.ps1（list / kill / sweep）。

import path from 'node:path';

import { describeRun, runProjectScript } from '../lib/exec.js';

export async function opProcs(cfg, args = {}) {
  const action = String(args.action ?? 'list');
  const scriptArgs = [];
  if (action === 'kill') scriptArgs.push('-Kill');
  else if (action === 'sweep') scriptArgs.push('-SweepOurWorkers');
  else scriptArgs.push('-List');
  if (args.waitFree) scriptArgs.push('-WaitFree', String(args.waitFree));
  const res = await runProjectScript(cfg, path.join(cfg.repo, 'tools', 'proc_guard.ps1'), scriptArgs, { timeoutMs: 90000 });
  return { ok: res.ok, exitCode: res.exitCode, text: describeRun(`proc_guard.ps1 ${action}`, res, cfg) };
}
