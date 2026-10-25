// 固件指纹 / 烧写账本 / 构建来源（build_info.txt）—— 都是"板上跑的是哪份"的取证材料。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { currentSessionId } from './identity.js';
import { gitArgsFor } from './paths.js';

// ---------------------------------------------------------------- 固件指纹 / 烧写账本（#2）

export function sha16(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export function firmwareFingerprint(file) {
  const abs = path.resolve(file);
  if (!existsSync(abs)) return { path: abs, name: path.basename(abs), exists: false };
  const st = statSync(abs);
  return {
    path: abs,
    name: path.basename(abs),
    exists: true,
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    sha256_16: sha16(abs),
  };
}

export function repoStamp(cfg) {
  const run = (args) => {
    try {
      return execFileSync('git', [...gitArgsFor(cfg, cfg.repo), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
    } catch {
      return '';
    }
  };
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    head: run(['rev-parse', '--short', 'HEAD']),
    subject: run(['log', '-1', '--pretty=%s']),
    dirty: run(['status', '--porcelain']) !== '',
  };
}

export function ledgerFilePath(cfg) {
  return path.join(cfg.repo, 'debug_logs', 'flash_ledger.jsonl');
}

export function appendFlashLedger(cfg, entry) {
  try {
    mkdirSync(path.dirname(ledgerFilePath(cfg)), { recursive: true });
    appendFileSync(ledgerFilePath(cfg), `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function flashLedgerTail(cfg, count = 3) {
  try {
    const lines = readFileSync(ledgerFilePath(cfg), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    return lines.slice(-count).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

export function ledgerLine(entry) {
  if (!entry || entry.raw) return `  ${entry?.raw ?? '(读不出)'}`;
  const fw = entry.firmware ?? {};
  return `  ${entry.timeText ?? '?'}  ${entry.board ?? '?'}  ${entry.method ?? '?'}  ${entry.ok ? 'OK' : 'FAIL'}  ${fw.name ?? '?'} (${fw.bytes ?? '?'} B, sha ${fw.sha256_16 ?? '?'})  ← ${entry.session ?? '?'}`;
}

// 把构建来源写进产物目录，让"板上跑的是哪份"有据可查
export function writeBuildInfo(cfg, dir, target, ctx) {
  const info = {
    target,
    builtAt: new Date().toISOString(),
    source: repoStamp(cfg),
    toolchain: cfg.toolVersions,
    node: process.version,
    session: currentSessionId(ctx),
    profile: cfg.profileName || '',
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'build_info.txt'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    return info;
  } catch {
    return info;
  }
}

export function buildInfoText(info) {
  const src = info?.source ?? {};
  return `${src.branch ?? '?'}@${src.head ?? '?'}${src.dirty ? '(脏)' : '(干净)'} · ${src.subject ?? ''} · 构建于 ${info?.builtAt ?? '?'}`;
}
