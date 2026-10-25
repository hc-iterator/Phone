// pico_exec：跑白名单里的构建/调试可执行文件（PATH 已注入 ~\.pico-sdk 与 VS 目录）。

import path from 'node:path';

import { describeRun, runProcess } from '../lib/exec.js';
import { registerDefinition, tool } from '../lib/tool.js';
import { isInside } from '../lib/util.js';

export async function opExec(cfg, args = {}) {
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

export function register(ctx, deps) {
  const { cfg } = deps;
  const definition = tool(
      cfg,
      'exec',
      'Run one allow-listed build or debug executable inside the sandbox; SDK and Visual Studio dirs are prepended to PATH. No shells.',
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
      opExec,
    );
  return registerDefinition(ctx, cfg, definition);
}
