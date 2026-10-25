// pico_run：跑 tools/ 或 dsh-plugins/ 下的脚本（ps1/cmd/bat/py），走沙箱 + 扩展名白名单。

import { existsSync } from 'node:fs';
import path from 'node:path';

import { describeRun, runProjectScript } from '../lib/exec.js';
import { registerDefinition, tool } from '../lib/tool.js';
import { isInside } from '../lib/util.js';

const SCRIPT_EXT = new Set(['.ps1', '.cmd', '.bat', '.py']);

export async function opRun(cfg, args = {}) {
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

export function register(ctx, deps) {
  const { cfg } = deps;
  const definition = tool(
      cfg,
      'run',
      'Run one project script under the repository tools/ or dsh-plugins/ (ps1, cmd, bat, py) inside the sandbox.',
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
      opRun,
    );
  return registerDefinition(ctx, cfg, definition);
}
