// /pico trust 的实现（登记 / 状态列表）。登记入口只做在人工命令里，不做成工具。

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  loadTrust,
  sha256Of,
  syncToRuntime,
  trustDirIsSafe,
  trustFilePath,
  trustVerdict,
  trustedScripts,
} from '../lib/trust.js';

export async function opTrust(cfg, args = {}) {
  const action = String(args.action ?? 'list').toLowerCase();
  if (!trustDirIsSafe(cfg)) {
    return { kind: 'error', text: `✗ 信任清单必须放在工作区之外；当前配置 ${cfg.trustDir} 在工作区之内 ⇒ 拒绝登记。` };
  }
  const names = action === 'init' ? trustedScripts(cfg) : action === 'list' ? [] : [String(args.name ?? '')].filter(Boolean);
  if (names.length > 0) {
    const manifest = loadTrust(cfg) ?? { version: 1, scripts: {} };
    mkdirSync(cfg.trustDir, { recursive: true });
    const lines = [];
    for (const rel of names) {
      const now = sha256Of(path.join(cfg.root, rel));
      if (!now) { lines.push(`✗ ${rel}  读不到`); continue; }
      manifest.scripts[rel] = { sha256: now, registeredAt: new Date().toISOString() };
      try { syncToRuntime(cfg, path.join(cfg.root, rel)); } catch { /* 同步失败不影响登记 */ }
      lines.push(`✓ ${rel}  →  ${now.slice(0, 16)}…（已同步进运行本）`);
    }
    try {
      writeFileSync(trustFilePath(cfg), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    } catch (error) {
      return { kind: 'error', text: `✗ 写清单失败: ${error && error.message ? error.message : error}` };
    }
    return { kind: 'success', text: `已登记 ${lines.length} 个脚本\n清单：${trustFilePath(cfg)}\n${lines.join('\n')}` };
  }
  const rows = trustedScripts(cfg).map((rel) => {
    const v = trustVerdict(cfg, path.join(cfg.root, rel));
    const mark = v.ok ? '✓ 匹配  ' : v.want ? '✗ 已变更' : '· 未登记';
    const detail = v.ok ? '' : `   当前 ${v.now ? v.now.slice(0, 8) : '(读不到)'} / 登记 ${v.want ? v.want.slice(0, 8) : '无'}`;
    return `  ${mark}  ${rel}${detail}`;
  });
  const exists = loadTrust(cfg) ? '' : '（清单还不存在 ⇒ 上面这些都会被执行时拒绝）';
  return {
    kind: 'success',
    text: [
      '沙箱之外脚本的信任登记：',
      `  清单 ${trustFilePath(cfg)}  ${exists}`,
      '',
      ...rows,
      '',
      '重新登记：/pico trust <相对路径>    或    /pico trust init（全部）',
    ].join('\n'),
  };
}
