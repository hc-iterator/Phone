// pico_build：root / host-test / 子工程三条构建路线，失败时提炼首批错误。

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describeRun, runProjectScript } from '../lib/exec.js';
import { buildInfoText, writeBuildInfo } from '../lib/ledger.js';
import { registerDefinition, tool } from '../lib/tool.js';
import { artifactInfo, listUf2, tailFile } from '../lib/util.js';

// ---------------------------------------------------------------- 构建首错（#8）

function firstErrors(text, limit = 5) {
  const out = [];
  const pattern = /([^\s:]+\.(?:[ch](?:pp)?|cc|S|ld|txt)):(\d+)(?::(\d+))?:\s*(error|fatal error|Error):\s*(.+)$/;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || out.length >= limit) continue;
    const m = line.match(pattern);
    if (m) out.push(`${m[1]}:${m[2]}${m[3] ? `:${m[3]}` : ''}: ${m[4]}: ${m[5]}`);
    else if (/undefined reference to|multiple definition of|ninja: build stopped|FAILED:/i.test(line)) out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

export async function opBuild(cfg, args = {}, ctx = {}) {
  const target = String(args.target ?? 'root');
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : cfg.timeoutMs;
  const cwd = cfg.repo;

  if (target === 'host-test' || target === 'host_test' || target === 'hosttest') {
    const script = path.join(cwd, 'tools', 'host_test', 'run_all.cmd');
    const res = await runProjectScript(cfg, script, [], { cwd, timeoutMs });
    return { ok: res.ok, exitCode: res.exitCode, text: describeRun('host-test run_all.cmd', res, cfg) };
  }

  if (target === 'root' || target === 'PicoPhone' || target === 'main') {
    const script = path.join(cwd, 'tools', 'build.cmd');
    // ⚠️ 构建【不进沙箱】：实测沙箱下 cmake configure 会 AF 崩（CMAKE_EXIT=-1073741819 = 0xC0000005），
    //    外层 BUILD_EXIT 还被 ninja 的 "no work to do" 洗成 0 ⇒ 假成功（项目自己的老坑）。
    //    增量时又可能侥幸通过 ⇒ 表现为"有时崩有时过"，比稳定失败更坏。证据：台架接口沙箱化说明.md §三.9 与外部复核。
    const res = await runProjectScript(cfg, script, [], { cwd, timeoutMs });
    const logPath = path.join(cwd, 'debug_logs', 'build_log.txt');
    let fullLog = '';
    try {
      fullLog = readFileSync(logPath, 'utf8');
    } catch {
      fullLog = '';
    }
    const info = res.ok ? writeBuildInfo(cfg, path.join(cwd, 'build'), 'root', ctx) : null;
    const errors = res.ok ? [] : firstErrors(`${fullLog}\n${res.stdout}\n${res.stderr}`);
    const extra = {
      日志尾部: `\n${tailFile(logPath, 40, cfg)}`,
      产物: `\n${artifactInfo(path.join(cwd, 'build', 'PicoPhone.uf2'))}`,
    };
    // 命令根本没跑起来时，别把【上一轮】的日志与产物摆出来 —— 那看起来像"构建成功"
    if (res.spawnError) {
      delete extra.日志尾部;
      delete extra.产物;
    }
    if (info) extra['构建来源（已落 build/build_info.txt）'] = buildInfoText(info);
    if (errors.length > 0) extra['首批错误'] = `\n  ${errors.join('\n  ')}`;
    return { ok: res.ok, exitCode: res.exitCode, text: describeRun('build.cmd (根工程)', res, cfg, extra), json: { target: 'root', ok: res.ok, errors, buildInfo: info } };
  }

  const buildSub = String(args.buildSub ?? 'build');
  const scriptArgs = [target, '-BuildSub', buildSub];
  if (args.noUf2 === true) scriptArgs.push('-NoUf2');
  if (Array.isArray(args.cacheArgs) && args.cacheArgs.length > 0) {
    scriptArgs.push('-CacheArgs', ...args.cacheArgs.map((s) => String(s)));
  }
  const script = path.join(cwd, 'tools', 'build_sub.ps1');
  // ⚠️ 同上：子工程构建也不进沙箱（它内部要走 cmake configure + 捕获原生输出）。
  const res = await runProjectScript(cfg, script, scriptArgs, { cwd, timeoutMs });
  const outDir = path.join(cwd, target, buildSub);
  const info = res.ok ? writeBuildInfo(cfg, outDir, target, ctx) : null;
  const errors = res.ok ? [] : firstErrors(`${res.stdout}\n${res.stderr}`);
  const extra = { 产物: `\n${listUf2(outDir)}` };
  if (res.spawnError) delete extra.产物; // 同上：没跑起来就别摆旧产物
  if (info) extra['构建来源（已落 build_info.txt）'] = buildInfoText(info);
  if (errors.length > 0) extra['首批错误'] = `\n  ${errors.join('\n  ')}`;
  return { ok: res.ok, exitCode: res.exitCode, text: describeRun(`build_sub.ps1 ${target} (${buildSub})`, res, cfg, extra), json: { target, buildSub, ok: res.ok, errors, buildInfo: info } };
}

export function register(ctx, deps) {
  const { cfg } = deps;
  const definition = tool(
      cfg,
      'build',
      'Build root firmware, a subproject, or host-test via the project scripts; returns exit code, log tail and artifact.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: {
            type: 'string',
            description: '`root`, `host-test`, or a subproject name such as `wboard_dvi` / `core1_monitor` / `probe_rp2040`.',
          },
          buildSub: {
            type: 'string',
            description: 'Subproject build dir, default `build`. Use a separate one (e.g. `build_slow`) to keep the full-speed artifact intact.',
          },
          noUf2: {
            type: 'boolean',
            description: 'Subprojects only: skip the redundant elf→uf2 conversion. The uf2 still appears via pico_add_extra_outputs().',
          },
          cacheArgs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Extra cmake configure arguments, each element carrying its own -D, for example `-DWBOARD_DVI_SM_CLKDIV=8`.',
          },
          timeoutMs: { type: 'number', description: 'Hard timeout, default 900000 ms.' },
        },
      },
      opBuild,
    );
  return registerDefinition(ctx, cfg, definition);
}
