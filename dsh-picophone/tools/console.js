// pico_console：常驻串口会话的 open/send/read/expect/close/list；会话进程本身在 lib/session.js。

import {
  sessionClose,
  sessionList,
  sessionOpen,
  sessionRead,
  sessionSend,
  sessions,
} from '../lib/session.js';
import { BOARD_ENUM, registerDefinition, tool } from '../lib/tool.js';

export async function opConsole(cfg, args = {}, ctx = {}) {
  const op = String(args.op ?? 'list');
  const id = String(args.sessionId ?? 'default');

  if (op === 'list') {
    const list = sessionList();
    if (list.length === 0) return { ok: true, text: '当前没有打开的串口会话。', json: { sessions: [] } };
    const text = list.map((s) => `  ${s.id}  ${s.port}  会话=${s.owner ?? '?'}  起于 ${s.openedAt}  空闲 ${s.idleSec}s  ${s.alive ? '活着' : '已退出'}`).join('\n');
    return { ok: true, text: `打开的会话（${list.length}）：\n${text}`, json: { sessions: list } };
  }

  if (op === 'open') return await sessionOpen(cfg, args, ctx);

  const s = sessions.get(id);
  if (!s || s.child.exitCode !== null) {
    return { ok: false, text: `没有会话 ${id}；先用 op:"open" 打开（open 要 4~5 秒，但只用付一次）。` };
  }

  if (op === 'send') return await sessionSend(cfg, s, args);
  if (op === 'read') return await sessionRead(cfg, s, args);
  if (op === 'expect') {
    if (!args.until) return { ok: false, text: 'expect 需要 until（正则）。' };
    const parts = [];
    if (args.data !== undefined && String(args.data) !== '') {
      const sent = await sessionSend(cfg, s, args);
      parts.push(sent.text);
    }
    const read = await sessionRead(cfg, s, args);
    return { ok: read.ok, text: [...parts, read.text].join('\n') };
  }
  if (op === 'close') return sessionClose(cfg, id, args.reason ? String(args.reason) : '手动关闭');

  return { ok: false, text: `未知 op: ${op}（open/send/read/expect/close/list）` };
}

export function register(ctx, deps) {
  const { cfg } = deps;
  const definition = tool(
      cfg,
      'console',
      'Keep one serial port open across calls: open, send, read, expect, close, list. Use it instead of repeated pico_serial.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['op'],
        properties: {
          op: { type: 'string', enum: ['open', 'send', 'read', 'expect', 'close', 'list'], description: 'Session operation.' },
          sessionId: { type: 'string', description: 'Session name, default `default`; reuse one name to keep a single port open.' },
          target: { type: 'string', enum: BOARD_ENUM, description: 'Which known device to open; default `dut`.' },
          port: { type: 'string', description: 'Explicit COM port; wins over target.' },
          baud: { type: 'number', description: 'Baud rate; USB CDC ignores it. Default 115200.' },
          data: { type: 'string', description: 'Text to send (`send` and `expect`).' },
          escapes: { type: 'boolean', description: 'Interpret data as a PowerShell escape sequence, so `` `r `` becomes CR.' },
          until: { type: 'string', description: 'Regular expression that ends the wait early (`read` and `expect`).' },
          timeoutMs: { type: 'number', description: 'How long to wait for data before reporting a timeout; default 2000 ms.' },
          stamp: { type: 'boolean', description: 'Prefix every line with its arrival time; default true. Set false for byte-exact output.' },
        },
      },
      opConsole,
    );
  return registerDefinition(ctx, cfg, definition);
}
