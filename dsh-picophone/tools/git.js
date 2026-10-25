// pico_git：在主仓库或某个 _agents 空间里跑 git；改状态的动词要 mutate:true。

import { existsSync, readFileSync } from 'node:fs';

import { describeRun, runProcess } from '../lib/exec.js';
import { gitArgsFor, resolveRepoArg } from '../lib/paths.js';
import { registerDefinition, tool } from '../lib/tool.js';

/**
 * git over HTTPS 在沙箱下的两个前提（都不是"开口子"，是把信任与凭据变成【文件】）：
 *   · TLS 信任：本机代理（Watt Toolkit）的中间人 CA 导出成工作区里的 PEM ⇒ 沙箱读得到
 *   · 凭据：Git 默认助手要 spawn sh.exe/bash.exe ⇒ 要建命名管道 ⇒ 被沙箱拒（Win32 error 5）
 *           ⇒ 主路用 extraHeader（令牌不落盘），失败时**重试** git 内建的 store 助手（读一个文件）。
 * 返回 null = 这条路当前不可用（文件不存在）。
 */
function gitAuthArgs(cfg, kind) {
  const out = [];
  if (cfg.gitSslCa && existsSync(cfg.gitSslCa)) {
    out.push('-c', 'http.sslBackend=openssl', '-c', `http.sslCAInfo=${cfg.gitSslCa}`);
  }
  if (kind === 'header') {
    if (!cfg.gitTokenFile || !existsSync(cfg.gitTokenFile)) return null;
    let raw = '';
    try {
      raw = readFileSync(cfg.gitTokenFile, 'utf8').trim();
    } catch {
      return null;
    }
    if (raw === '') return null;
    const pair = raw.includes(':') ? raw : `x-access-token:${raw}`;
    out.push('-c', `http.extraHeader=Authorization: Basic ${Buffer.from(pair, 'utf8').toString('base64')}`);
    return out;
  }
  if (kind === 'store') {
    if (!cfg.gitCredentialsFile || !existsSync(cfg.gitCredentialsFile)) return null;
    out.push('-c', `credential.helper=store --file=${cfg.gitCredentialsFile}`);
    return out;
  }
  return out.length > 0 ? out : null;
}

export async function opGit(cfg, args = {}) {
  const dir = resolveRepoArg(cfg, args.repo);
  const list = Array.isArray(args.args) ? args.args.map((s) => String(s)) : [];
  if (list.length === 0) list.push('status', '--short', '--branch');
  const mutating = ['commit', 'push', 'pull', 'fetch', 'reset', 'checkout', 'switch', 'merge', 'rebase', 'add', 'rm', 'mv', 'stash', 'clean', 'tag', 'branch', 'revert', 'cherry-pick', 'gc'];
  const verb = list.find((token) => !token.startsWith('-')) ?? '';
  if (mutating.includes(verb) && args.mutate !== true) {
    return {
      ok: false,
      exitCode: null,
      text: `git ${verb} 会改变仓库状态。确认后带 mutate: true 重试（仓库: ${dir}）。`,
    };
  }
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 120000;
  const netVerb = ['push', 'fetch', 'pull', 'ls-remote', 'clone'].includes(verb);
  const primary = gitAuthArgs(cfg, 'header');
  const retry = netVerb ? gitAuthArgs(cfg, 'store') : null;
  const label = `git -C ${dir} ${list.join(' ')}`;
  const res = await runProcess('git', [...gitArgsFor(cfg, dir), ...(primary ?? []), ...list], { cwd: dir, timeoutMs, sandbox: true });
  if (!res.ok && retry) {
    const first = describeRun(`${label} [主路 extraHeader 失败]`, res, cfg);
    const res2 = await runProcess('git', [...gitArgsFor(cfg, dir), ...retry, ...list], { cwd: dir, timeoutMs, sandbox: true });
    return {
      ok: res2.ok,
      exitCode: res2.exitCode,
      text: `${first}\n\n== 错误重试路径：改走 credential.helper=store（读 ${cfg.gitCredentialsFile}）==\n${describeRun(label, res2, cfg)}`,
      json: { git: { verb, attempts: ['extraHeader', 'store'], ok: res2.ok } },
    };
  }
  return {
    ok: res.ok,
    exitCode: res.exitCode,
    text: `${describeRun(label, res, cfg)}\n（凭据路径：${primary ? 'extraHeader 主路' : '未注入凭据'}）`,
    json: { git: { verb, attempts: [primary ? 'extraHeader' : 'none'], ok: res.ok } },
  };
}

export function register(ctx, deps) {
  const { cfg } = deps;
  const definition = tool(
      cfg,
      'git',
      'Run git in the main repo or an isolated _agents space. History-changing verbs need mutate: true.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['args'],
        properties: {
          repo: { type: 'string', description: '`main` for DeepSeekCode, or an `_agents/<name>` space name; default `main`.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Verbatim git arguments, for example `["log","--oneline","-5"]`.' },
          mutate: { type: 'boolean', description: 'Required true for verbs that change repository state.' },
          timeoutMs: { type: 'number', description: 'Hard timeout, default 120000 ms.' },
        },
      },
      opGit,
    );
  return registerDefinition(ctx, cfg, definition);
}
