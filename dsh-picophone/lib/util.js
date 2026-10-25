// 通用小工具：ANSI/编码/裁剪、路径围栏判断、杀进程树、文件摘要。搬自 index.js「基础工具」段。

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** PowerShell 的 Write-Host 颜色在重定向后仍会留下 ANSI 转义，去掉它免得污染上下文。 */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

export function decodeBuffer(buffer) {
  if (!buffer || buffer.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}

export function clip(text, max) {  const t = String(text ?? '').replace(/\r\n/g, '\n');
  if (t.length <= max) return t;
  const head = t.slice(0, Math.floor(max * 0.6));
  const tail = t.slice(-Math.floor(max * 0.4));
  return `${head}\n... [省略 ${t.length - max} 字符] ...\n${tail}`;
}

export function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* 尽力而为 */
  }
}

export function tailFile(file, lines, cfg) {
  try {
    const text = decodeBuffer(readFileSync(file));
    const all = text.split(/\r?\n/);
    return clip(all.slice(-lines).join('\n'), cfg.maxOutputChars);
  } catch (error) {
    return `(读不到 ${file}: ${error && error.message ? error.message : error})`;
  }
}

export function artifactInfo(file) {
  try {
    const st = statSync(file);
    return `${file}  ${st.size} B  ${st.mtime.toISOString()}`;
  } catch {
    return `${file}  (不存在)`;
  }
}

export function listUf2(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.uf2'))
      .map((f) => artifactInfo(path.join(dir, f)))
      .join('\n');
  } catch {
    return `(目录不存在: ${dir})`;
  }
}
