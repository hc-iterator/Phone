// pico_amend：AI 申请修改受管脚本时的一次性审判员流程。
// ⚠️ 按 2026-10-07 用户裁定【不再注册成工具】：改受管脚本走通用 approval 提权。
//    这段代码保留作参考（拆分前也没有入口能调到它），所以 index.js 不 import 本文件。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runProcess } from '../lib/exec.js';
import {
  ensureRuntimeTree,
  invalidateRuntimeTree,
  registerTrust,
  runtimeRoot,
  trustedScripts,
  trustVerdict,
} from '../lib/trust.js';

/**
 * pico_amend：AI 申请修改【受管脚本】（＝跑在沙箱外的那批）。
 * 流程（用户 2026-10-07 裁定）：取 diff ⇒ 委派【一次性审判员】⇒
 *   · 合理 ⇒ 登记新指纹 + 同步进运行本（生效）
 *   · 否则 ⇒ 用运行本覆盖工作区里被改过的那份（回滚）
 * 审判员只读 diff、只出结构化裁决；判完立刻 dispose。拿不到 subagents/parent ⇒ 什么都不做。
 */
export function managedChangedFiles(cfg) {
  return trustedScripts(cfg).filter((rel) => !trustVerdict(cfg, path.join(cfg.root, rel)).ok);
}

export async function opAmend(cfg, args = {}) {
  const rels = (Array.isArray(args.paths) && args.paths.length > 0 ? args.paths.map((s) => String(s)) : managedChangedFiles(cfg)).filter(Boolean);
  if (rels.length === 0) {
    return { ok: true, exitCode: 0, text: '受管脚本当前全部与登记指纹一致 —— 没有需要裁决的改动。' };
  }
  const repoRel = path.relative(cfg.root, cfg.repo).split(path.sep).join('/');
  // 取 diff：受管脚本可能【不在 cfg.repo 里】（如 dsh-plugins\ 下的 worker 属于另一个 worktree）
  // ⇒ 逐个文件找最近的 .git，按仓库根分组取 diff。
  // 2026-10-07 审判员实测发现：写死 cfg.repo 会对这类文件恒取到【空 diff】（git 对不匹配的
  // pathspec 静默返回空）⇒ 审判员盲判。空 diff 现在会被显式写进提示词里当警告。
  const byRoot = new Map();
  for (const rel of rels) {
    const abs = path.join(cfg.root, rel);
    let dir = path.dirname(abs);
    let root = cfg.repo;
    for (let i = 0; i < 12; i += 1) {
      if (existsSync(path.join(dir, '.git'))) { root = dir; break; }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(path.relative(root, abs).split(path.sep).join('/'));
  }
  let diffText = '';
  let diffNote = '';
  for (const [root, list] of byRoot) {
    const res = await runProcess('git', ['-C', root, 'diff', '--', ...list], { cwd: cfg.repo, timeoutMs: 60000, sandbox: true });
    diffText += `# 仓库根 ${root}\n${res.stdout || ''}\n`;
    const untracked = await runProcess('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '--', ...list], { cwd: cfg.repo, timeoutMs: 30000, sandbox: true });
    const u = (untracked.stdout || '').trim();
    if (u) diffNote += `\n注意：以下文件是【未跟踪的新文件】，git diff 没有基线：${u}`;
    if (res.spawnError) diffNote += `\n注意：取 diff 失败（${res.spawnError}）`;
  }
  if (!diffText.replace(/# 仓库根 .*/g, '').trim()) diffNote += '\n警告：本次 diff 为空 —— 若确实有改动，说明仓库根判断错，请人工核实后再裁决。';
  // 取服务两种方式都试：apply 时的 inject 没回调过，就在调用时 ctx.get 一次（2026-10-07 实测 inject 没拿到）
  const svc = cfg.subagents ?? cfg.pluginCtx?.get?.('subagents');
  const parent = cfg.currentAgent;
  if (!svc || !parent) {
    return { ok: false, exitCode: null, text: `⚠️ 无法委派审判员（subagents=${Boolean(svc)} / parent=${Boolean(parent)}）⇒ 【不做任何改动】，请人工处理。` };
  }
  const provider = (svc.list?.() ?? [])[0];
  if (!provider) return { ok: false, exitCode: null, text: '⚠️ 没有可用的 subagent provider ⇒ 【不做任何改动】。' };
  const prompt = [
    '你是一次性审判员：判断"受管脚本"的这次改动是否合理。只依据 diff，不要臆测。',
    '背景：这些脚本跑在 DSH 沙箱【之外】（要碰设备 / 要跑 cmake），所以其内容必须是人工认可过的版本；',
    'AI 改完必须经你裁决才能生效。',
    '判"可疑/有害"的例子：往窗口外写文件、联网外传、读取凭据或令牌、无注释且与理由不符、',
    '与声明理由无关的大段重写、混淆或编码技巧、削弱既有校验。',
    `AI 给的理由：${String(args.why ?? '(未给)')}`,
    `涉及文件：${rels.join(', ')}`,
    'diff：',
    (diffText || '(空)').slice(0, 20000),
    diffNote,
  ].join('\n');
  let run;
  try {
    run = await svc.start(provider, {
      label: 'trust-judge',
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal: new AbortController().signal,
      maxDepth: 1, // 子本身即 depth 1（0 会被拒：'subagent depth 1 exceeds maxDepth 0'，2026-10-07 实测）；1 = 只准它自己、不准再往下派
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['verdict', 'reasons'],
        properties: {
          verdict: { type: 'string', enum: ['合理', '可疑', '有害'] },
          reasons: { type: 'array', items: { type: 'string' } },
        },
      },
    });
  } catch (error) {
    return { ok: false, exitCode: null, text: `⚠️ 委派审判员失败：${error && error.message ? error.message : error} ⇒ 【不做任何改动】。` };
  }
  let verdict = '';
  let reasons = [];
  try {
    const result = await run.result;
    verdict = String(result?.structured?.verdict ?? '');
    reasons = Array.isArray(result?.structured?.reasons) ? result.structured.reasons : [];
  } finally {
    try { await run.dispose(); } catch { /* 一次性，判完就放 */ }
  }
  const lines = [`审判员裁决：${verdict || '(无结构化输出)'}`, ...reasons.map((r) => `  · ${r}`), ''];
  if (verdict === '合理') {
    for (const rel of rels) registerTrust(cfg, path.join(cfg.root, rel));
    invalidateRuntimeTree();
    lines.push(ensureRuntimeTree(cfg) ? `✅ 已登记并同步进运行本：${rels.join(', ')}` : '✗ 裁决合理，但运行本刷新失败（请查指纹）');
  } else {
    for (const rel of rels) {
      const wsPath = path.join(cfg.root, rel);
      const rtPath = path.join(runtimeRoot(cfg), rel);
      try {
        if (existsSync(rtPath)) { writeFileSync(wsPath, readFileSync(rtPath)); lines.push(`↩︎ 已用运行本覆盖：${rel}`); }
        else lines.push(`· 运行本里没有 ${rel}（新文件？）⇒ 未覆盖，请人工处理`);
      } catch (error) { lines.push(`✗ 覆盖 ${rel} 失败：${error && error.message ? error.message : error}`); }
    }
  }
  return { ok: verdict === '合理', exitCode: null, text: lines.join('\n') };
}
