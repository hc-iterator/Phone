/**
 * dsh-session-gc —— 清理"空草稿会话"
 *
 * 背景（2026-11-06 实测）：
 *   这台机器上 780 个会话里有 **617 个是空草稿**（占 79%）：只有会话头和策略事件
 *   （session / permission/preset / sandbox/mode / approval/policy / ...），**没有任何消息**。
 *   它们只占 0.5 MB，省空间没有意义；真正的代价是**数量噪声**：
 *     · dsh-restart 按文件 mtime 判"忙" ⇒ 空草稿被拉进投票名单、还会被唤醒（已踩过：用户看到凭空冒出的对话）；
 *     · 会话列表、按会话扫描的统计都被 79% 的空壳稀释。
 *
 * 安全设计（宁可少删，不可误删）：
 *   1. 判定条件只有一个：**解出来的事件里没有任何 user/assistant/turn 事件**；
 *   2. 必须**足够老**（默认 ≥ 6 小时），避免删掉用户刚打开、正要开始打的会话；
 *   3. 跳过当前会话自己；
 *   4. 删除 = **整体移动到回收目录**（`%DSH_HOME%\trash\session-gc\<时间戳>\`），随时可以搬回来；
 *   5. 默认 dry-run：不传 `apply: true` 只报告，不动磁盘。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DEFAULT_MIN_AGE_HOURS = 6;
const SENSE_EVENTS = ['"user/message"', '"assistant/message"', '"turn/start"'];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
  required: ['ok', 'text'],
};

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

function trashRoot() {
  return path.join(dshHome(), 'trash', 'session-gc');
}

/** 解一个会话文件，返回 {events, hasWork, badFrames}。读不到返回 null。 */
function inspectSession(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  let i = 0;
  let sawHeader = false;
  let events = 0;
  let badFrames = 0;
  let hasWork = false;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    let text = '';
    try { text = zstdDecompressSync(buf.subarray(i)).toString('utf8'); } catch { badFrames++; i += ZSTD_MAGIC.length; continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      events++;
      if (!sawHeader) { sawHeader = true; continue; }
      if (!hasWork && SENSE_EVENTS.some((m) => line.includes(m))) hasWork = true;
    }
    i += ZSTD_MAGIC.length;
  }
  return { events, hasWork, badFrames };
}

/** 扫描候选：空草稿 + 足够老 + 不是当前会话。 */
function scanCandidates({ minAgeHours = DEFAULT_MIN_AGE_HOURS, currentSessionId = '' } = {}) {
  const root = sessionsRoot();
  const cutoff = Date.now() - minAgeHours * 3600000;
  const candidates = [];
  const stats = { total: 0, withWork: 0, empty: 0, emptyFresh: 0, badFrames: 0, missing: 0 };
  let wsDirs = [];
  try { wsDirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return { candidates, stats }; }

  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue;
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, ws.name), { withFileTypes: true }); } catch { continue; }
    for (const s of entries) {
      if (!s.isDirectory()) continue;
      const dir = path.join(root, ws.name, s.name);
      const file = path.join(dir, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) { stats.missing++; continue; }
      stats.total++;
      if (s.name === currentSessionId || s.name === 'session-' + currentSessionId) continue;
      const info = inspectSession(file);
      if (!info) { stats.missing++; continue; }
      if (info.badFrames > 0) { stats.badFrames++; continue; } // 解不开的一律不动
      if (info.hasWork) { stats.withWork++; continue; }
      stats.empty++;
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      if (mtime > cutoff) { stats.emptyFresh++; continue; }    // 太新：可能是正在打的草稿
      let bytes = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* 忽略 */ }
        }
      } catch { /* 忽略 */ }
      candidates.push({ dir, id: s.name, workspace: ws.name, mtime, bytes });
    }
  }
  candidates.sort((a, b) => a.mtime - b.mtime);
  return { candidates, stats };
}

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function describe({ candidates, stats }, minAgeHours) {
  const totalBytes = candidates.reduce((s, c) => s + c.bytes, 0);
  const lines = [
    `总会话 ${stats.total} 个：有对话 ${stats.withWork}、空草稿 ${stats.empty}（其中 ${stats.emptyFresh} 个太新未计入）、坏帧跳过 ${stats.badFrames}`,
    `可清理候选：${candidates.length} 个，共 ${humanBytes(totalBytes)}（年龄 ≥ ${minAgeHours} 小时）`,
  ];
  if (candidates.length) {
    lines.push('最老的 5 个：');
    for (const c of candidates.slice(0, 5)) {
      lines.push(`  ${c.id}  ${humanBytes(c.bytes)}  ${new Date(c.mtime).toLocaleString()}`);
    }
    lines.push('最新的 2 个（接近阈值）：');
    for (const c of candidates.slice(-2)) {
      lines.push(`  ${c.id}  ${humanBytes(c.bytes)}  ${new Date(c.mtime).toLocaleString()}`);
    }
  }
  return lines.join('\n');
}

async function opScan(args = {}, sessionId = '') {
  const minAgeHours = Number.isFinite(args.minAgeHours) ? Number(args.minAgeHours) : DEFAULT_MIN_AGE_HOURS;
  const result = scanCandidates({ minAgeHours, currentSessionId: sessionId });
  return { ok: true, text: describe(result, minAgeHours) + '\n（只扫描，不动磁盘；要真的清理请调 session_gc_apply 并传 apply:true）' };
}

async function opApply(args = {}, sessionId = '') {
  const minAgeHours = Number.isFinite(args.minAgeHours) ? Number(args.minAgeHours) : DEFAULT_MIN_AGE_HOURS;
  const apply = args.apply === true;
  const maxSessions = Number.isFinite(args.maxSessions) ? Math.max(1, Number(args.maxSessions)) : 2000;

  const result = scanCandidates({ minAgeHours, currentSessionId: sessionId });
  const chosen = result.candidates.slice(0, maxSessions);

  if (!apply) {
    return { ok: true, text: describe(result, minAgeHours) + '\n（dry-run：没有删除任何东西。确认无误后传 apply:true）' };
  }
  if (!chosen.length) return { ok: true, text: '没有可清理的空草稿会话' };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(trashRoot(), stamp);
  fs.mkdirSync(dest, { recursive: true });

  let moved = 0;
  const failed = [];
  for (const c of chosen) {
    try {
      fs.renameSync(c.dir, path.join(dest, c.id));
      moved++;
    } catch (error) {
      // 跨卷/占用时退回"复制 + 删除"
      try {
        fs.cpSync(c.dir, path.join(dest, c.id), { recursive: true });
        fs.rmSync(c.dir, { recursive: true, force: true });
        moved++;
      } catch (error2) {
        failed.push(`${c.id}: ${error2 instanceof Error ? error2.message : String(error2)}`);
      }
    }
  }
  const lines = [
    `已把 ${moved} 个空草稿会话移到回收站：${dest}`,
    `失败 ${failed.length} 个${failed.length ? '（' + failed.slice(0, 3).join('; ') + '）' : ''}`,
    '要恢复：把回收目录里的会话文件夹搬回原工作区目录即可；确认无用后可直接删掉该回收目录。',
  ];
  return { ok: succeeded(moved), text: lines.join('\n') };
}

function succeeded(n) { return n > 0; }

function tool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_a, v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }],
    },
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.id ?? '');
      return await run(args ?? {}, sessionId);
    },
  };
}

function buildToolDefinitions() {
  return [
    tool('session_gc_scan',
      'List empty draft sessions (header + policy events only, no messages) older than N hours. Read-only; changes nothing.',
      { type: 'object', additionalProperties: false, properties: {
        minAgeHours: { type: 'number', description: `Only consider sessions untouched for this many hours (default ${DEFAULT_MIN_AGE_HOURS}).` } } },
      (a, s) => opScan(a, s)),
    tool('session_gc_apply',
      'Move empty draft sessions into the trash directory (recoverable). Dry-run unless apply:true.',
      { type: 'object', additionalProperties: false, properties: {
        apply: { type: 'boolean', description: 'Must be true to actually move anything; default false (dry-run).' },
        minAgeHours: { type: 'number', description: 'Age threshold in hours (default 6).' },
        maxSessions: { type: 'number', description: 'Move at most this many (default 2000).' } } },
      (a, s) => opApply(a, s)),
  ];
}

export const inject = ['tools'];

export async function apply(ctx) {
  for (const definition of buildToolDefinitions()) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-session-gc: ${definition.name}`);
  }

  // ── 开机自愈：积压的空草稿自动清 ────────────────────────────────────────────
  // 2026-11-08 调查：空草稿 16 天 724 个、中位间隔 59.6 秒，且"没派活也在涨" ⇒ 多个来源；
  // 根治要改创建点（需 CDP 定位前端）。在那之前先让积压不滚雪球：
  //   · 只在"积压 ≥ 20 个且都老于 1 小时"时动手（不误伤正在用的）；
  //   · 删除 = 移到回收站，可恢复；失败不影响主流程。
  try {
    const scan = scanCandidates({ minAgeHours: 1, currentSessionId: '' });
    if (scan.candidates.length >= 20) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(trashRoot(), stamp);
      fs.mkdirSync(dest, { recursive: true });
      let moved = 0;
      for (const c of scan.candidates.slice(0, 500)) {
        try { fs.renameSync(c.dir, path.join(dest, c.id)); moved++; } catch { /* 单个失败无妨 */ }
      }
      if (moved > 0) console.log(`[dsh-session-gc] 启动自愈：清理 ${moved} 个空草稿 → ${dest}`);
    }
  } catch (error) {
    console.log(`[dsh-session-gc] 启动自愈跳过：${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── 命令行：node index.js --scan [小时] / --apply [小时] ─────────────────────
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  if (process.argv.includes('--scan')) {
    const hours = Number(process.argv[process.argv.indexOf('--scan') + 1]) || DEFAULT_MIN_AGE_HOURS;
    const r = scanCandidates({ minAgeHours: hours });
    console.log(describe(r, hours));
  } else if (process.argv.includes('--apply')) {
    const hours = Number(process.argv[process.argv.indexOf('--apply') + 1]) || DEFAULT_MIN_AGE_HOURS;
    const r = await opApply({ apply: true, minAgeHours: hours }, '');
    console.log(r.text);
  }
}
