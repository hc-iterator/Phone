// 子进程层：沙箱执行器、引号拼装、带硬超时的 runProcess、走信任门+运行本的 runProjectScript。
// sandboxContext / toolPathPrefix 现在住在 lib/state.js。

import { spawn } from 'node:child_process';
import path from 'node:path';

import { DEFAULTS } from './config.js';
import { state } from './state.js';
import {
  askTrustApproval,
  registerTrust,
  relToRoot,
  resolveRuntimeScript,
  trustRefusal,
  trustVerdict,
} from './trust.js';
import { clip, decodeBuffer, killTree, stripAnsi } from './util.js';

/** 跑一个进程：硬超时、隐藏窗口、捕获输出、超时杀整棵树。 */
// ---------------------------------------------------------------- 沙箱（2026-10-06 实测后加）

// ⚠️ 必须是**硬编码常量**：实测证明 ctx.shell.resolve 不做上限压制 ——
//    插件请求 danger-full-access 就被采纳、越界写就成功了（见 DeepSeekCode\台架接口沙箱化说明.md §四.1）。
//    ⇒ 沙箱约束的是"借出去的手"，不防插件作者；插件源码本身仍靠 git diff / 人眼兜底。
const SANDBOX_MODE = 'workspace-write';

/** 走 DSH 的 OS 级沙箱执行器（Windows = 路径 ACL + 受限令牌）。 */
export async function runSandboxedCommand(command, options = {}) {
  const shell = state.sandboxContext?.shell;
  const started = Date.now();
  if (!shell) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      durationMs: 0,
      spawnError: '沙箱执行器不可用（ctx.shell 缺失）—— 未执行任何命令',
    };
  }
  try {
    // ⚠️ 沙箱路径【必须自己注入环境】—— 实测走 ctx.shell 时：
    //    ① `Get-Command ninja` / `arm-none-eabi-gcc` 都是空（它用系统 PATH，不是我们给子进程拼的前缀）；
    //    ② 连 `$env:DSH_HOME` 都没有 ⇒ 依赖它的脚本（如 tools\clear_rig_lock.ps1）会看错地方、报假 FREE。
    const envPrefix = [];
    if (state.toolPathPrefix && !/^\s*\$env:PATH\s*=/.test(command)) {
      envPrefix.push(`$env:PATH = ${quoteAlways(`${state.toolPathPrefix}${path.delimiter}`)} + $env:PATH;`);
    }
    if (process.env.DSH_HOME) envPrefix.push(`$env:DSH_HOME = ${quoteAlways(process.env.DSH_HOME)};`);
    if (process.env.DSH_PROFILE) envPrefix.push(`$env:DSH_PROFILE = ${quoteAlways(process.env.DSH_PROFILE)};`);
    const withEnv = envPrefix.length > 0 ? `${envPrefix.join(' ')} ${command}` : command;
    const spec = shell.resolve({
      command: withEnv,
      workdir: options.cwd ?? state.sandboxContext.workspaceRoot,
      timeoutMs: options.timeoutMs ?? DEFAULTS.shortTimeoutMs,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      sandboxPolicy: { mode: SANDBOX_MODE, workspaceRoot: state.sandboxContext.workspaceRoot },
    });
    const execution = await shell.execute(spec);
    const result = await execution.result();
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      aborted: Boolean(result.aborted),
      stdout: stripAnsi(result.stdout?.text ?? ''),
      stderr: stripAnsi(result.stderr?.text ?? ''),
      durationMs: Date.now() - started,
      sandbox: result.sandbox ?? null,
      command,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      spawnError: `沙箱执行失败: ${error && error.message ? error.message : error}`,
      command,
    };
  }
}

/** 给 PowerShell 命令串做参数引用（沙箱路径要把 argv 拼成一条命令）。 */
export function quoteArg(value) {
  const text = String(value);
  if (text === '') return "''";
  if (!/[\s"'`$&|<>();,{}\[\]]/.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * 【强制】单引号 —— 专给"环境变量赋值"用。
 * 实测教训：`$env:DSH_HOME = C:\固态盘秘钥\.dsh;` 这种裸词赋值会被 PowerShell **当成命令**去执行
 * （报 "not recognized as a name of a cmdlet"），变量根本没赋上。引用成 'C:\...' 才稳。
 */
export function quoteAlways(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 把 (可执行文件, argv) 拼成一条命令串。
 * ⚠️ 输出必须"直通"：实测在 pwsh 里捕获原生程序输出会走 .NET 命名管道 `\\.\pipe\LOCAL\dotnet_*`，
 *    而那条路在沙箱里是【被拒】的（说明文件 §三 第 2 条）。所以这里绝不加 `| cmdlet`、也绝不赋值。
 */
export function buildCommandLine(file, args) {
  const list = (args ?? []).map(quoteArg).join(' ');
  const kind = shellFor(file);
  if (kind === 'ps1') return `${quoteArg('pwsh')} -NoProfile -NonInteractive -File ${quoteArg(file)}${list ? ` ${list}` : ''}`;
  if (kind === 'cmd') return `cmd /c ${quoteArg(file)}${list ? ` ${list}` : ''}`;
  if (kind === 'py') return `python ${quoteArg(file)}${list ? ` ${list}` : ''}`;
  return `& ${quoteArg(file)}${list ? ` ${list}` : ''}`;
}

export function runProcess(file, args, options = {}) {
  const { cwd, timeoutMs = DEFAULTS.shortTimeoutMs, signal, env, input } = options;
  if (options.sandbox === true) {
    return runSandboxedCommand(buildCommandLine(file, args), { cwd, timeoutMs, stdin: input });
  }
  const started = Date.now();
  const childEnv = spawnEnv(env);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        windowsHide: true,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        exitCode: null,
        timedOut: false,
        spawnError: String(error && error.message ? error.message : error),
        stdout: '',
        stderr: '',
        durationMs: Date.now() - started,
      });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    const CAP = 4 * 1024 * 1024;
    child.stdout.on('data', (d) => {
      if (outBytes < CAP) {
        outChunks.push(d);
        outBytes += d.length;
      }
    });
    child.stderr.on('data', (d) => {
      if (errBytes < CAP) {
        errChunks.push(d);
        errBytes += d.length;
      }
    });

    let settled = false;
    let timedOut = false;
    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeoutMs)
        : null;
    const onAbort = () => killTree(child);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal: sig ?? null,
        timedOut,
        aborted: Boolean(signal && signal.aborted),
        stdout: stripAnsi(decodeBuffer(Buffer.concat(outChunks))),
        stderr: stripAnsi(decodeBuffer(Buffer.concat(errChunks))),
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        ok: false,
        exitCode: null,
        timedOut,
        spawnError: String(error && error.message ? error.message : error),
        stdout: stripAnsi(decodeBuffer(Buffer.concat(outChunks))),
        stderr: stripAnsi(decodeBuffer(Buffer.concat(errChunks))),
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (code, sig) => finish(code, sig));

    try {
      if (input !== undefined && input !== null) child.stdin.end(String(input));
      else child.stdin.end();
    } catch {
      /* stdin 可能已关闭 */
    }
  });
}

export function describeRun(label, result, cfg, extra = {}) {
  const lines = [];
  const bits = [`exit=${result.exitCode === null ? 'n/a' : result.exitCode}`];
  if (result.timedOut) bits.push('TIMEOUT');
  if (result.aborted) bits.push('ABORTED');
  if (result.spawnError) bits.push(`spawnError=${result.spawnError}`);
  if (result.sandbox) bits.push(`sandbox=${JSON.stringify(result.sandbox)}`);
  bits.push(`${result.durationMs}ms`);
  lines.push(`[${label}] ${bits.join(' ')}`);
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`);
  if (result.stdout && result.stdout.trim()) lines.push('--- stdout ---', clip(result.stdout.trim(), cfg.maxOutputChars));
  if (result.stderr && result.stderr.trim()) lines.push('--- stderr ---', clip(result.stderr.trim(), cfg.maxOutputChars));
  if (!result.stdout.trim() && !result.stderr.trim()) lines.push('(无输出)');
  return lines.join('\n');
}

export function shellFor(scriptPath) {
  const ext = path.extname(scriptPath).toLowerCase();
  if (ext === '.ps1') return 'ps1';
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.py') return 'py';
  return 'other';
}

/** 跑仓库内的脚本：.ps1 -> pwsh、.cmd/.bat -> cmd、.py -> python。 */
export async function runProjectScript(cfg, scriptPath, args, options = {}) {
  if (options.sandbox !== true) {
    // 【信任门】沙箱之外的脚本先与工作区外的哈希清单核对；不符 ⇒ **发起审批**（AI 问、人答），
    // 批了就地登记并继续；没批/审批不可用 ⇒ 保持拒绝（fail-closed）。
    // 沙箱化的调用（run/exec/docs/agents）不走这里 —— 它们本来就跑在沙箱里，随便改无所谓。
    let verdict = trustVerdict(cfg, scriptPath);
    let askNote = '';
    if (!verdict.ok) {
      const ask = await askTrustApproval(cfg, scriptPath, { toolName: options.toolName });
      if (ask.outcome === 'allowed-once' && registerTrust(cfg, scriptPath)) {
        verdict = trustVerdict(cfg, scriptPath);
        askNote = '（已按你的同意重新登记指纹）';
      } else {
        askNote = `（审批结果：${ask.outcome}${ask.detail ? ` — ${ask.detail}` : ''}）`;
      }
    }
    if (!verdict.ok) {
      return {
        ok: false,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        durationMs: 0,
        spawnError: `${trustRefusal(cfg, scriptPath)}\n\n${askNote}`,
      };
    }
    // 【运行本】指纹过了还不够：真正要跑的是 Pico 文件夹里那一份（工作区那份只是源码）。
    const resolvedRuntime = resolveRuntimeScript(cfg, scriptPath);
    if (!resolvedRuntime) {
      return {
        ok: false,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        durationMs: 0,
        spawnError: `⛔ 运行本不可用：${relToRoot(cfg, scriptPath)}\n（工作区版本与登记指纹不一致，运行本里也没有对应的一份）\n⇒ 先 /pico trust <路径> 登记，或用 pico_amend 提交改动让审判员裁决。`,
      };
    }
    scriptPath = resolvedRuntime;
  }
  if (options.sandbox === true) {
    return runSandboxedCommand(buildCommandLine(scriptPath, args), {
      cwd: options.cwd ?? cfg.repo,
      timeoutMs: options.timeoutMs,
      stdin: options.input,
    });
  }
  const kind = shellFor(scriptPath);
  const cwd = options.cwd ?? cfg.repo;
  if (kind === 'ps1') {
    return runProcess(cfg.powershell, ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...args], { ...options, cwd });
  }
  if (kind === 'cmd') {
    return runProcess('cmd', ['/c', scriptPath, ...args], { ...options, cwd });
  }
  if (kind === 'py') {
    return runProcess(cfg.python, [scriptPath, ...args], { ...options, cwd });
  }
  return Promise.resolve({
    ok: false,
    exitCode: null,
    timedOut: false,
    spawnError: `不支持的脚本类型: ${scriptPath}`,
    stdout: '',
    stderr: '',
    durationMs: 0,
  });
}

export function spawnEnv(extra) {
  const env = { ...process.env, ...(extra ?? {}) };
  if (state.toolPathPrefix) {
    const inherited = env.PATH ?? env.Path ?? '';
    env.PATH = inherited ? `${state.toolPathPrefix}${path.delimiter}${inherited}` : state.toolPathPrefix;
  }
  return env;
}
