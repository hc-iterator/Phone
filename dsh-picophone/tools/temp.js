// pico_temp：%TEMP% 内的读写/列目录/拷贝/删除，路径一律围栏在 %TEMP% 里。

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { safeTempPath } from '../lib/paths.js';
import { registerDefinition, tool } from '../lib/tool.js';
import { artifactInfo, clip, decodeBuffer } from '../lib/util.js';

export async function opTemp(cfg, args = {}) {
  const op = String(args.op ?? 'path');
  const rel = args.path === undefined ? '' : String(args.path);
  const maxBytes = Number.isFinite(args.maxBytes) ? args.maxBytes : 200000;
  let target;
  try {
    target = op === 'path' ? cfg.tempRoot : safeTempPath(cfg, rel);
  } catch (error) {
    return { ok: false, exitCode: null, text: String(error && error.message ? error.message : error) };
  }

  if (op === 'path') return { ok: true, exitCode: 0, text: cfg.tempRoot };

  if (op === 'ls') {
    if (!existsSync(target)) return { ok: false, exitCode: null, text: `不存在: ${target}` };
    const st = statSync(target);
    if (!st.isDirectory()) return { ok: true, exitCode: 0, text: artifactInfo(target) };
    const rows = readdirSync(target, { withFileTypes: true })
      .slice(0, 400)
      .map((entry) => {
        const full = path.join(target, entry.name);
        try {
          const s = statSync(full);
          return `${entry.isDirectory() ? 'DIR ' : 'FILE'} ${String(s.size).padStart(10)}  ${s.mtime.toISOString()}  ${entry.name}`;
        } catch {
          return `?    ${entry.name}`;
        }
      });
    return { ok: true, exitCode: 0, text: `${target}\n${rows.join('\n') || '(空目录)'}` };
  }

  if (op === 'stat') {
    if (!existsSync(target)) return { ok: false, exitCode: null, text: `不存在: ${target}` };
    const s = statSync(target);
    return { ok: true, exitCode: 0, text: `${target}\n类型: ${s.isDirectory() ? '目录' : '文件'}\n大小: ${s.size}\n修改: ${s.mtime.toISOString()}` };
  }

  if (op === 'read') {
    if (!existsSync(target)) return { ok: false, exitCode: null, text: `不存在: ${target}` };
    const buf = readFileSync(target);
    const sliced = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
    const note = buf.length > maxBytes ? `\n[只显示末尾 ${maxBytes} / ${buf.length} 字节]` : '';
    return { ok: true, exitCode: 0, text: `${target} (${buf.length} B)${note}\n${clip(decodeBuffer(sliced), cfg.maxOutputChars)}` };
  }

  if (op === 'write' || op === 'append') {
    mkdirSync(path.dirname(target), { recursive: true });
    const raw = String(args.content ?? '');
    const asBase64 = String(args.encoding ?? '').toLowerCase() === 'base64';
    const payload = asBase64 ? Buffer.from(raw, 'base64') : raw;
    if (op === 'write') {
      if (asBase64) writeFileSync(target, payload);
      else writeFileSync(target, payload, 'utf8');
    } else if (asBase64) {
      appendFileSync(target, payload);
    } else {
      appendFileSync(target, payload, 'utf8');
    }
    const s = statSync(target);
    return { ok: true, exitCode: 0, text: `${op === 'write' ? '写入' : '追加'}完成: ${target} (${s.size} B${asBase64 ? '，base64 解码后' : ''})` };
  }

  if (op === 'cp' || op === 'mv') {
    const from = safeTempPath(cfg, String(args.from ?? ''));
    const to = safeTempPath(cfg, rel);
    if (!existsSync(from)) return { ok: false, exitCode: null, text: `源不存在: ${from}` };
    mkdirSync(path.dirname(to), { recursive: true });
    if (op === 'cp') copyFileSync(from, to);
    else renameSync(from, to);
    return { ok: true, exitCode: 0, text: `${op === 'cp' ? '已复制' : '已移动'}: ${from} -> ${to}` };
  }

  if (op === 'mkdir') {
    mkdirSync(target, { recursive: true });
    return { ok: true, exitCode: 0, text: `已创建目录: ${target}` };
  }

  if (op === 'rm') {
    if (!existsSync(target)) return { ok: false, exitCode: null, text: `不存在: ${target}` };
    rmSync(target, { recursive: true, force: true });
    return { ok: true, exitCode: 0, text: `已删除: ${target}` };
  }

  return { ok: false, exitCode: null, text: `未知 op: ${op}` };
}

export function register(ctx, deps) {
  const { cfg } = deps;
  const definition = tool(
      cfg,
      'temp',
      'Read and write files under %TEMP%, the scratch area for captures and payloads. Paths cannot escape %TEMP%.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['path', 'ls', 'read', 'write', 'append', 'stat', 'mkdir', 'rm', 'cp', 'mv'], description: 'Operation to perform; `path` prints the %TEMP% root.' },
          path: { type: 'string', description: 'Path relative to %TEMP%; omit for `path`.' },
          from: { type: 'string', description: 'Source path for `cp` and `mv`, relative to %TEMP%.' },
          content: { type: 'string', description: 'Payload for `write` and `append`.' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'How to read `content`; `base64` writes the decoded bytes.' },
          maxBytes: { type: 'number', description: 'For `read`: show only the last N bytes, default 200000.' },
        },
      },
      opTemp,
    );
  return registerDefinition(ctx, cfg, definition);
}
