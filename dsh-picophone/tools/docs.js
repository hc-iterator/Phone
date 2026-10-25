// /pico docs：文档引用检查与打补丁（沙箱内跑）。

import path from 'node:path';

import { describeRun, runProjectScript } from '../lib/exec.js';

export async function opDocs(cfg, args = {}) {
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
