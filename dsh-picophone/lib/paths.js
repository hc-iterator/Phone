// 路径推导：插件包根、%TEMP% 围栏、git 空间名、git 参数。

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isInside } from './util.js';

// 插件包根目录。原先是 index.js 的 path.dirname(fileURLToPath(import.meta.url))；
// 现在本文件在 lib/ 下 ⇒ 多上跳一层，得到的仍是同一个目录。
export const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function safeTempPath(cfg, rel) {
  const target = path.resolve(cfg.tempRoot, rel === undefined || rel === null || rel === '' ? '.' : String(rel));
  if (!isInside(cfg.tempRoot, target)) throw new Error(`路径越出 %TEMP%: ${rel}`);
  return target;
}

export function resolveRepoArg(cfg, repo) {
  const key = String(repo ?? 'main').trim();
  if (key === '' || key === 'main' || key === 'DeepSeekCode') return cfg.repo;
  const dir = path.resolve(cfg.root, '_agents', key);
  if (!isInside(path.join(cfg.root, '_agents'), dir)) throw new Error(`非法空间名: ${key}`);
  if (!existsSync(dir)) throw new Error(`空间不存在: ${dir}`);
  return dir;
}

export function gitArgsFor(cfg, dir) {
  return ['-c', `safe.directory=${cfg.root.replace(/\\/g, '/')}/*`, '-C', dir];
}
