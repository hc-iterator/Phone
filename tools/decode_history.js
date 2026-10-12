#!/usr/bin/env node
'use strict';
/**
 * DSH 会话日志解读器（session.v4.jsonl → 可读 Markdown）
 * ========================================================
 * 给以后的 Agent 用：把 DeepSeek Harness 的会话日志（每行一个 JSON 事件）
 * 解读成一份人类/Agent 可读的 Markdown 摘要，方便快速理解以前的会话。
 *
 * 用法：
 *   node decode_history.js [输入] [输出.md]
 *     输入：一个 session.v4.jsonl 文件，或一个包含若干日志的目录（默认 ./History，
 *           目录输入会递归找出所有 .jsonl，包括 subagents/ 子目录）
 *     输出：Markdown 文件；不填则写在输入目录下 summary.md
 *
 *   可选开关：
 *     --full   不截断长文本（默认正文 2000 / 思考 400 / 工具结果 400 / 参数 240 字）
 *     --stats  只输出文首摘要与统计表，不输出逐条正文
 *     --help   显示本说明
 *
 * 日志格式（v4）：每行 {type, seq?, time(epoch ms), data}，首行 type==="session"。
 * 叙事主线事件：user/message、assistant/message、tool/call、tool/result、
 *   goal/change、compaction/summary、model/selection、approval/*、command/*。
 * 遥测噪音（delivery-accepted / ptc-dispatch / step 等）默认静默跳过。
 */

const fs = require('fs');
const path = require('path');

// ---------------- CLI ----------------
const USAGE = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 24).join('\n');
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--') || a === '-h'));
const pos = argv.filter(a => !a.startsWith('--') && a !== '-h');
if (flags.has('--help') || flags.has('-h')) { console.log(USAGE); process.exit(0); }

const FULL = flags.has('--full');
const STATS = flags.has('--stats');
const input = pos[0] || 'History';
const output = pos[1] || null;

const LIMIT = { text: 2000, reason: 400, result: 400, args: 240, misc: 240, digest: 2400 };

// 遥测/框架噪音：默认完全跳过（不进正文，只进统计）
const SKIP = new Set([
  'session-log-deepseek/delivery-accepted',
  'tool/ptc-dispatch-start',
  'tool/ptc-dispatch',            // 与 tool/result 内容重复，以 tool/result 为准
  'step/start', 'step/end',
  'turn/end',
  'session/end-seed',
  'agent/inbox/spliced',
  'request/header', 'request/context',
  'session/title-llm-request',
  'llm/retry', 'llm/retry-started',
  'assistant/attempt',
  'compaction/prune', 'compaction/start', 'compaction/end',
  'system/message',               // 系统提示词，太长且无叙事价值
]);

// ---------------- 工具函数 ----------------
function pad(n) { return String(n).padStart(2, '0'); }
function fmtTime(t) {
  if (typeof t !== 'number' || !isFinite(t)) return '?';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function trunc(s, n) {
  s = String(s == null ? '' : s);
  if (FULL || s.length <= n) return s;
  return s.slice(0, n) + ` …(截断，共 ${s.length} 字)`;
}
function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n').trim();
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
function collectFiles(inp) {
  const st = fs.statSync(inp);
  if (st.isFile()) return [path.resolve(inp)];
  if (!st.isDirectory()) { console.error(`❌ 输入不存在: ${inp}`); process.exit(1); }
  return walk(path.resolve(inp)).sort((a, b) =>
    (a.split(path.sep).length - b.split(path.sep).length) || a.localeCompare(b));
}
function loadEvents(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const events = []; let bad = 0;
  for (const l of lines) { try { events.push(JSON.parse(l)); } catch { bad++; } }
  return { events, bad, total: lines.length };
}

// ---------------- 文首摘要（digest） ----------------
function buildDigest(events, bad, total) {
  const d = {
    header: null, titles: [], goals: new Map(), models: new Set(),
    presets: [], compactions: [], t0: Infinity, t1: -Infinity,
    tokMax: 0, tokN: 0,   // usage.totalTokens 是"本次请求的上下文总量"，不是增量 ⇒ 只取峰值，绝不求和
    bad, total,
  };
  for (const o of events) {
    if (typeof o.time === 'number') {
      if (o.time < d.t0) d.t0 = o.time;
      if (o.time > d.t1) d.t1 = o.time;
    }
    const data = o.data || {};
    switch (o.type) {
      case 'session': d.header = o; break; // 首行：字段在顶层，不在 data 里
      case 'session/title': if (data.title) d.titles.push(data.title); break;
      case 'goal/change': if (data.goal) d.goals.set(data.goal.id || '?', data.goal); break;
      case 'model/selection':
        if (data.model) d.models.add(`${data.provider || '?'}/${data.model}`); break;
      case 'agent-preset/selected':
        if (data.agentPreset && !d.presets.includes(data.agentPreset)) d.presets.push(data.agentPreset); break;
      case 'compaction/summary': {
        const t = textOf(data.summary);
        if (t) d.compactions.push(t);
        break;
      }
      case 'assistant/message': {
        const src = (data.message || {}).source || {};
        if (src.model) d.models.add(`${src.provider || '?'}/${src.model}`);
        const tt = (data.usage && data.usage.totalTokens) || 0;
        if (tt) { d.tokN++; if (tt > d.tokMax) d.tokMax = tt; }
        break;
      }
    }
  }
  return d;
}

// ---------------- 正文渲染 ----------------
function renderBody(events) {
  const md = [];
  const callNames = new Map();   // callId → 工具名
  const apprNames = new Map();   // 审批 id → 工具名
  const counts = {};             // 事件类型计数
  const toolBy = {};             // 工具名计数
  const unknown = {};            // 未解读事件类型

  for (const o of events) {
    const t = o.type || '(?)';
    counts[t] = (counts[t] || 0) + 1;
    if (SKIP.has(t)) continue;
    const data = o.data || {};
    const ts = fmtTime(o.time);

    switch (t) {
      case 'session': break;      // 已进文首摘要
      case 'session/title': break;
      case 'turn/start':
        md.push(`\n---\n\n### Turn ${data.turn}\n`);
        break;

      case 'user/message': {
        const txt = textOf(data.content);
        if (!txt) break;
        const kind = (data.source || {}).kind || '?';
        const who = kind === 'user' ? '👤 用户' : `📎 注入(${kind})`;
        md.push(`\n**${who}** · ${ts}\n\n${trunc(txt, LIMIT.text)}\n`);
        break;
      }

      case 'assistant/message': {
        const m = data.message || {};
        const blocks = Array.isArray(m.content) ? m.content : [];
        const src = m.source || {};
        const who = src.model ? `${src.provider || '?'}/${src.model}` : 'assistant';
        md.push(`\n**🤖 助手** · ${ts} · turn${data.turn ?? '?'}/step${data.step ?? '?'} · ${who}\n`);
        for (const b of blocks) {
          if (!b) continue;
          if (b.type === 'reasoning') {
            const r = (b.text || '').trim();
            if (r) md.push(`> 💭 ${trunc(r, LIMIT.reason).replace(/\n/g, '\n> ')}\n`);
          } else if (b.type === 'text') {
            const x = (b.text || '').trim();
            if (x) md.push(`${trunc(x, LIMIT.text)}\n`);
          } else if (b.type === 'tool-call') {
            if (b.id && b.name) callNames.set(b.id, b.name); // 正文由 tool/call 事件渲染
          } else {
            md.push(`\`[块 ${b.type}]\`\n`);
          }
        }
        break;
      }

      case 'tool/call': {
        if (data.callId) callNames.set(data.callId, data.name || '?');
        const name = data.name || '?';
        toolBy[name] = (toolBy[name] || 0) + 1;
        const args = typeof data.arguments === 'string'
          ? data.arguments : JSON.stringify(data.arguments);
        md.push(`\n🔧 \`${name}\`(${trunc(args, LIMIT.args)}) · ${ts}\n`);
        break;
      }

      case 'tool/result': {
        const m = data.message || {};
        const name = callNames.get(m.toolCallId || data.toolCallId) || '?';
        const txt = textOf(m.content);
        const isErr = data.isError || m.isError;
        md.push(`↩️ \`${name}\` ${isErr ? '**⚠️ 出错** ' : ''}结果 · ${trunc(txt || '(空)', LIMIT.result)}\n`);
        break;
      }

      case 'goal/change': {
        const g = data.goal || {};
        md.push(`\n🎯 **目标 ${data.operation || '?'}** · ${ts} · 阶段=${g.phase || '?'}\n\n${trunc(g.objective || '', LIMIT.text)}\n`);
        break;
      }

      case 'model/selection':
        md.push(`\n🔁 模型切换 → ${data.provider || '?'}/${data.model || '?'} · ${ts}\n`);
        break;
      case 'agent-preset/selected':
        md.push(`\n📋 预设切换 → ${data.agentPreset} · ${ts}\n`);
        break;
      case 'permission/preset':
        md.push(`> 🔒 权限预设：${data.preset}`);
        break;
      case 'sandbox/mode':
        md.push(`> 🧱 沙箱模式：${data.mode}`);
        break;
      case 'approval/policy':
        md.push(`> ❓ 审批策略：${data.policy}`);
        break;

      case 'approval/asked':
        if (data.id) apprNames.set(data.id, data.toolName || '?');
        md.push(`\n⚠️ 审批请求 · \`${data.toolName}\` · ${ts}\n\n${trunc(data.reason || '', LIMIT.misc)}\n`);
        break;
      case 'approval/decided':
        md.push(`\n${data.outcome === 'approved' ? '✅' : '❌'} 审批结果：${data.outcome}（工具 \`${apprNames.get(data.id) || '?'}\`）· ${ts}\n`);
        break;

      case 'command/run':
        md.push(`\n⌘ 用户命令 \`/${data.name}${data.args ? ' ' + data.args : ''}\` · ${ts}\n`);
        break;
      case 'command/done':
        md.push(`⌘ ↳ ${data.kind === 'success' ? '✅' : '❌'} ${trunc(data.text || '', LIMIT.misc)}\n`);
        break;

      case 'compaction/summary':
        md.push(`\n📦 上下文压缩摘要（完整文本见文首）· ${ts}\n`);
        break;
      case 'workspace/changes':
        md.push(`\n📁 工作区有文件改动 · turn ${data.turn ?? '?'} · ${ts}\n`);
        break;

      case 'tool-workflow/run-start':
        md.push(`\n🕸 工作流开始 · ${trunc(JSON.stringify(data), LIMIT.misc)}\n`);
        break;
      case 'tool-workflow/run-end':
        md.push(`🕸 工作流结束 · ${trunc(JSON.stringify(data), LIMIT.misc)}\n`);
        break;
      case 'tool-workflow/agent-start':
        md.push(`🕸 ↳ 子代理开始 · ${trunc(JSON.stringify(data), LIMIT.misc)}`);
        break;
      case 'tool-workflow/agent-end':
        md.push(`🕸 ↳ 子代理结束 · ${trunc(JSON.stringify(data), LIMIT.misc)}`);
        break;

      case 'subagent/descriptor':
        md.push(`\n🧬 子代理描述 · ${trunc(JSON.stringify(data), LIMIT.misc)}\n`);
        break;
      case 'subagent/catalog':
        md.push(`\n🧬 子代理目录 · ${trunc(JSON.stringify(data), LIMIT.misc)}\n`);
        break;

      default:
        unknown[t] = (unknown[t] || 0) + 1;
        if (FULL) md.push(`\n\`[未解读事件 ${t}]\` ${trunc(JSON.stringify(data), LIMIT.misc)}\n`);
    }
  }
  return { md, counts, toolBy, unknown };
}

// ---------------- 单文件渲染 ----------------
function renderFileSection(file, events, bad, total) {
  const d = buildDigest(events, bad, total);
  const md = [];
  const h = d.header || {};

  md.push(`# 会话解读：${path.relative(process.cwd(), file) || file}`);
  md.push('');
  md.push(`- **会话**：${h.id || '?'} · v${h.version || '?'} · 创建于 ${fmtTime(h.createdAt)}`);
  if (h.cwd) md.push(`- **工作目录**：${h.cwd}`);
  if (h.agentPreset) md.push(`- **预设**：${h.agentPreset}`);
  if (d.titles.length) md.push(`- **标题**：${[...new Set(d.titles)].join(' | ')}`);
  if (d.presets.length) md.push(`- **预设切换**：${d.presets.join(' → ')}`);
  if (d.models.size) md.push(`- **模型**：${[...d.models].join('、')}`);
  if (d.t0 !== Infinity)
    md.push(`- **时间范围**：${fmtTime(d.t0)} → ${fmtTime(d.t1)}（约 ${Math.round((d.t1 - d.t0) / 60000)} 分钟）`);
  if (d.tokN) md.push(`- **上下文 token**：峰值 ≈${(d.tokMax / 1000).toFixed(1)}k（${d.tokN} 次采样；该字段是"每次请求的上下文总量"，非增量，不能相加）`);
  if (d.total) md.push(`- **日志行数**：${d.total}${d.bad ? `（其中 ${d.bad} 行解析失败）` : ''}`);
  if (d.goals.size) {
    md.push('- **目标**：');
    for (const g of d.goals.values())
      md.push(`  - [${g.phase}] ${trunc(g.objective, LIMIT.misc)}`);
  }

  if (d.compactions.length) {
    md.push('');
    md.push('## 压缩摘要（理解旧会话的最佳入口）');
    d.compactions.forEach((c, i) => {
      md.push(`\n### 压缩 #${i + 1}\n`);
      md.push(trunc(c, LIMIT.digest));
    });
  }

  const { md: body, counts, toolBy, unknown } = renderBody(events);

  if (!STATS && body.length) {
    md.push('');
    md.push('## 会话正文');
    md.push('');
    md.push(...body);
  }

  // 统计
  md.push('');
  md.push('## 统计');
  md.push('');
  md.push('| 事件类型 | 次数 |');
  md.push('|---|---|');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
    md.push(`| \`${k}\` | ${v} |`);
  const tools = Object.entries(toolBy).sort((a, b) => b[1] - a[1]);
  if (tools.length) {
    md.push('');
    md.push('**工具调用 Top**：' + tools.slice(0, 10).map(([k, v]) => `\`${k}\`×${v}`).join('、')
      + (tools.length > 10 ? ` 等 ${tools.length} 种` : ''));
  }
  const unk = Object.entries(unknown);
  if (unk.length)
    md.push(`\n**未解读事件类型**：${unk.map(([k, v]) => `\`${k}\`×${v}`).join('、')}（加 --full 可看原文）`);

  return md.join('\n');
}

// ---------------- 主流程 ----------------
function main() {
  const files = collectFiles(input);
  if (!files.length) { console.error('❌ 没找到任何 .jsonl 日志'); process.exit(1); }
  const sections = files.map(f => {
    const { events, bad, total } = loadEvents(f);
    return renderFileSection(f, events, bad, total);
  });
  const md = sections.join('\n\n---\n\n') + '\n';
  const outFile = output
    ? path.resolve(output)
    : (fs.statSync(input).isDirectory()
        ? path.join(path.resolve(input), 'summary.md')
        : path.resolve(input) + '.summary.md');
  fs.writeFileSync(outFile, md, 'utf8');
  console.log(`✅ 已解读 ${files.length} 个日志 → ${outFile}`);
}
main();
