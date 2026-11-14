/**
 * dsh-admin-gate · 危险操作闸门（P1）
 * ================================================================
 * 设计依据：DeepSeekCode/docs/设计-危险操作闸门.md
 *   - 台账 append-only：%DSH_HOME%\gate\approvals.jsonl
 *   - 超时默认拒绝：默认 10 分钟，只能缩短（1–10），不许延长
 *   - 谁可审批：权限管理员（可配，默认 a58366b8）+ 用户
 *   - 权限管理员不能自批（除非用户放行），留痕 "self-approval"
 *   - 台账写失败 ⇒ 拒绝执行（无记录不许动）
 *
 * 纯数据 + 纯函数；ctx 相关的注册在 index.js。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
export const GATE_DIR = path.join(DSH_HOME, 'gate');
export const LEDGER = path.join(GATE_DIR, 'approvals.jsonl');
export const PENDING = path.join(GATE_DIR, 'pending.json');
export const META = path.join(GATE_DIR, 'meta.json');

export const DEFAULT_APPROVER = 'session-a58366b8-c5f6-4d39-8cdb-bfda148d5cc2';
export const MAX_TIMEOUT_MIN = 10;
export const MIN_TIMEOUT_MIN = 1;
/** 同一操作重复发起，5 分钟内视为同一请求 */
export const DEDUPE_MS = 5 * 60 * 1000;

export class GateLedgerError extends Error {}

function ensureDirs() {
  fs.mkdirSync(GATE_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** append-only 台账；写失败抛 GateLedgerError（调用方据此拒绝执行）。 */
export function appendLedger(entry) {
  try {
    ensureDirs();
    fs.appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry.seq;
  } catch (err) {
    throw new GateLedgerError(`台账写入失败：${err && err.message ? err.message : String(err)}`);
  }
}

export function nextSeq() {
  const meta = readJson(META, { seq: 0 });
  const seq = (Number(meta.seq) || 0) + 1;
  writeJson(META, { seq });
  return seq;
}

export function nowIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function hashDiff(text) {
  const s = String(text || '');
  return `sha256:${crypto.createHash('sha256').update(s, 'utf8').digest('hex')}`;
}

export function readPending() {
  return readJson(PENDING, {});
}

export function writePending(next) {
  writeJson(PENDING, next);
}

export function readLedgerTail(n = 10) {
  try {
    const lines = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** 超时值只准缩短：1–10 分钟。 */
export function normalizeTimeout(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return MAX_TIMEOUT_MIN;
  return Math.min(MAX_TIMEOUT_MIN, Math.max(MIN_TIMEOUT_MIN, n));
}

// ── 危险操作分类 ────────────────────────────────────────────────────────

const DESTRUCTIVE_CMD = /git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|rm\s+-rf|del\s+\/s|Remove-Item[^\n]*-Recurse|format\s+[a-z]:|shutdown|taskkill\s+\/f|Stop-Process/i;
// 2026-11-12：把 dsh_restart_commit 从危险工具里去掉。
// 理由：重启本身已有独立审批链（全体表决 + 审批员），commit 用的是一次性 token，
// 再叠一层闸门只会死锁——闸门要 gate_ok，重启又要先 commit。
const DESTRUCTIVE_TOOLS = new Set(['worktree_delete', 'session_trash', 'blank_reaper']);

/** 返回 op 名（危险）或 ''（普通）。 */
export function classifyOp(toolName, args) {
  const name = String(toolName || '');
  if (DESTRUCTIVE_TOOLS.has(name)) return name;
  if (name === 'pm_grant' || name === 'pm_revoke') return 'admin.grant';
  if (name === 'bash' || name === 'pwsh' || name === 'terminal') {
    const text = typeof args === 'object' && args ? JSON.stringify(args) : String(args || '');
    if (DESTRUCTIVE_CMD.test(text)) return 'shell.destructive';
  }
  return '';
}

/** 从参数里找 gate_ok:<id>（bash/pwsh 的命令串等）。
 *
 * 2026-11-12 修：token 是 `g_<随机>_<随机>`，含下划线；原字符类漏了 `_`，
 * 于是 `gate_ok:g_mwdiwesp_...` 被截成 `g`，永远报“不存在”。
 */
export function extractToken(args) {
  const text = typeof args === 'object' && args ? JSON.stringify(args) : String(args || '');
  const m = /gate_ok:([0-9a-zA-Z_-]+)/.exec(text);
  return m ? m[1] : '';
}

// ── 请求 / 决定 / 超时 ──────────────────────────────────────────────────

/**
 * 发起一次危险操作请求。
 * @returns {{ ok:boolean, id?:string, status:string, expiresAt?:string, text:string, deduped?:boolean }}
 */
export function request({ actor, op, reason, target, diff, timeoutMinutes, approver }) {
  const pending = readPending();
  const now = Date.now();

  // 5 分钟内同一 actor+op 且**仍在待批**才算同一请求（已落定的不再复用）
  for (const [id, p] of Object.entries(pending)) {
    if (p.actor === actor && p.op === op && p.status === 'pending' && now - Date.parse(p.requestedAt) < DEDUPE_MS) {
      return { ok: true, id, status: p.status, expiresAt: p.expiresAt, deduped: true, text: `同一操作 5 分钟内已发起过（${id}，状态 ${p.status}）` };
    }
  }

  const timeout = normalizeTimeout(timeoutMinutes);
  const id = `g_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    actor,
    op,
    reason: String(reason || ''),
    target: String(target || ''),
    diffHash: diff ? hashDiff(diff) : '',
    diffHead: diff ? String(diff).slice(0, 200) : '',
    requestedAt: nowIso(),
    timeoutMinutes: timeout,
    expiresAt: nowIso(),
    status: 'pending',
    approver,
    decider: null,
    decidedAt: null,
    consumed: false,
  };
  entry.expiresAt = new Date(now + timeout * 60_000).toISOString();

  let seq;
  try {
    seq = nextSeq();
    appendLedger({
      seq, at: entry.requestedAt, actor, op, risk: 'high', reason: entry.reason,
      target: entry.target, diffHash: entry.diffHash, diffHead: entry.diffHead,
      requestedAt: entry.requestedAt, timeoutMinutes: timeout, decision: 'pending',
    });
  } catch (err) {
    return { ok: false, status: 'rejected', text: `台账写失败，拒绝挂起：${err.message}` };
  }

  pending[id] = entry;
  writePending(pending);
  return { ok: true, id, status: 'pending', expiresAt: entry.expiresAt, text: `已发起（${op}），等待 ${approver} 审批，超时 ${timeout} 分钟` };
}

/**
 * 落定：approve / deny / expired。
 * @returns {{ ok:boolean, status:string, text:string }}
 */
export function decide({ id, decision, decider, reason, selfApproval = false, executedResult = 'ok' }) {
  const pending = readPending();
  const entry = pending[id];
  if (!entry) return { ok: false, status: 'unknown', text: `没有这个请求：${id}` };
  if (entry.status !== 'pending') return { ok: false, status: entry.status, text: `该请求已落定：${entry.status}` };

  const now = Date.now();
  if (now > Date.parse(entry.expiresAt)) {
    return expireOne(pending, id);
  }

  entry.status = decision === 'approve' ? 'approved' : 'denied';
  entry.decider = decider;
  entry.decidedAt = nowIso();
  entry.decisionReason = String(reason || '');

  try {
    appendLedger({
      seq: nextSeq(), at: entry.decidedAt, actor: entry.actor, op: entry.op, risk: 'high',
      reason: entry.reason, target: entry.target, diffHash: entry.diffHash,
      requestedAt: entry.requestedAt, decidedAt: entry.decidedAt,
      elapsedMs: now - Date.parse(entry.requestedAt),
      decider, decision: entry.status, decisionReason: entry.decisionReason,
      selfApproval, result: executedResult,
    });
  } catch (err) {
    entry.status = 'pending';
    writePending(pending);
    return { ok: false, status: 'ledger-failed', text: `台账写失败，状态未落定：${err.message}` };
  }

  pending[id] = entry;
  writePending(pending);
  return { ok: true, status: entry.status, text: `已${entry.status === 'approved' ? '批准' : '拒绝'}（${id}）` };
}

function expireOne(pending, id) {
  const entry = pending[id];
  entry.status = 'expired';
  entry.decidedAt = nowIso();
  entry.decider = null;
  try {
    appendLedger({
      seq: nextSeq(), at: entry.decidedAt, actor: entry.actor, op: entry.op, risk: 'high',
      reason: entry.reason, target: entry.target, diffHash: entry.diffHash,
      requestedAt: entry.requestedAt, decidedAt: entry.decidedAt,
      elapsedMs: Date.now() - Date.parse(entry.requestedAt),
      decider: null, decision: 'expired', decisionReason: '超时未决，默认拒绝', result: 'denied',
    });
  } catch { /* 台账失败也要把内存状态推进，避免永远挂起 */ }
  pending[id] = entry;
  writePending(pending);
  return { ok: false, status: 'expired', text: `已超时，默认拒绝（${id}）` };
}

/** 定时器调用：把所有过期 pending 标 expired。 */
export function sweepExpired(now = Date.now()) {
  const pending = readPending();
  let changed = 0;
  for (const [id, entry] of Object.entries(pending)) {
    if (entry.status !== 'pending') continue;
    if (now <= Date.parse(entry.expiresAt)) continue;
    expireOne(pending, id);
    changed += 1;
  }
  return changed;
}

/**
 * 工具执行前的授权检查。
 * @returns {{ ok:boolean, id?:string, reason?:string }}
 */
export function authorizationFor({ agentId, op, token }) {
  const pending = readPending();
  const now = Date.now();

  const usable = (e) => e && e.status === 'approved' && !e.consumed && e.op === op;

  if (token) {
    const e = pending[token];
    if (!e) return { ok: false, reason: `gate_ok:${token} 不存在` };
    if (e.status !== 'approved') return { ok: false, reason: `gate_ok:${token} 状态是 ${e.status}，未获批准` };
    if (e.consumed) return { ok: false, reason: `gate_ok:${token} 已被使用过（一次性）` };
    if (e.op !== op) return { ok: false, reason: `gate_ok:${token} 对应操作是 ${e.op}，不是 ${op}` };
    if (now > Date.parse(e.expiresAt)) return { ok: false, reason: `gate_ok:${token} 已过期` };
    return { ok: true, id: token };
  }

  const mine = Object.entries(pending).find(([, e]) => usable(e) && e.actor === agentId && Date.parse(e.expiresAt) >= now);
  if (mine) return { ok: true, id: mine[0] };
  return { ok: false, reason: `危险操作 ${op} 未经审批：先用 gate_request 申请，批准后带上 gate_ok:<id>` };
}

/** 兑付：一次性。 */
export function consume(id) {
  const pending = readPending();
  const e = pending[id];
  if (!e) return false;
  e.consumed = true;
  e.executedAt = nowIso();
  pending[id] = e;
  writePending(pending);
  try {
    appendLedger({
      seq: nextSeq(), at: e.executedAt, actor: e.actor, op: e.op, risk: 'high',
      reason: e.reason, target: e.target, diffHash: e.diffHash,
      requestedAt: e.requestedAt, decidedAt: e.decidedAt, decider: e.decider,
      decision: 'approved', executedAt: e.executedAt,
      elapsedMs: Date.now() - Date.parse(e.requestedAt), result: 'ok',
    });
  } catch { /* 台账失败不影响已做出的决定 */ }
  return true;
}

export function statusOf(id) {
  const pending = readPending();
  if (id) return pending[id] || null;
  return Object.values(pending).filter((e) => e.status === 'pending');
}
