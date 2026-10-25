// /pico agents：子智能体空间 list / sync / create（沙箱内跑）。

import path from 'node:path';

import { describeRun, runProjectScript } from '../lib/exec.js';

export async function opAgents(cfg, args = {}) {
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
