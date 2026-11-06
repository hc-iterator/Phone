/**
 * dsh-restart v2 —— 两段式重启（重写版，旧实现作废）
 * ===========================================================================
 * 协议（2026-10-31 与用户确定）：
 *
 *   ① dsh_restart({note})        发起表决，可捎一句话
 *        候选 = 除发起者外「正在干活」的会话（本轮在跑 / 有子 Agent 在跑）
 *        给它们投递【Agent 消息】（source.kind='agent-message'，不是用户消息）
 *        阻塞等待，最长 3 分钟：
 *          全员同意 → 返回 { phase:'approved', token }
 *          任一拒绝 → 返回 { phase:'denied', reasons }
 *          没齐     → 返回 { phase:'collecting' }，转后台
 *        后台：5 分钟催未决者，10 分钟作废（phase:'expired'）
 *
 *   ② dsh_restart_commit({token})
 *        只有 phase='approved' 且 token 未用过才生效；用掉即作废，只能一次。
 *        这一步才真正排定重启——① 绝不重启。
 *
 *   表决：allowdshrestarting（同意）/ stopdshfromrestarting（拒绝，必须写理由）
 *   重启完成后：通知所有被通知者 + 发起者（启动时回放 pendingNotify）。
 *
 * 关于「5 分钟 bug」：旧代码把任务排到 now+5min 又立刻 /run，5 分钟后任务自己
 * 再跑一次，把刚起来的 DSH 又杀一遍。本实现按构造消除：任务只排在 2099 年
 * （永不自触发），只 /run 一次，doer 跑完自删。
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// 会话日志是多帧 zstd（追加写入）：同步解码器只认第一帧，所以按 magic 逐帧解。
import { zstdDecompressSync } from 'node:zlib';

export const name = '@local/dsh-restart';
export const inject = ['tools'];

const DIR = path.join(os.tmpdir(), 'dsh_restart');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'restart.log');
const RESULT = path.join(DIR, 'result.json');
const DOER = path.join(DIR, 'doer.ps1');
const VBS = path.join(DIR, 'silent.vbs');
// 2026-10-31：拉起 DSH 的 stdout/stderr 落盘，便于事后判断"为什么起来了又没了"
const LAUNCH_OUT = path.join(DIR, 'launch.out');
const LAUNCH_ERR = path.join(DIR, 'launch.err');
const TASK = 'dsh_restart_once';

const WAIT_BLOCK_MS = 3 * 60_000;
const NUDGE_MS = 5 * 60_000;
const EXPIRE_MS = 10 * 60_000;

/**
 * 常驻审批岗：任何重启都必须通知这个对话并取得它的同意（用户 2026-10-31 要求）。
 * 写死 session id —— 对话标题是「重启审批员」。它不在线时靠 resolveAgent 唤醒。
 */
const APPROVAL_SESSION = 'session-6c3e7938-e76f-4e5b-b8d0-47b29c22a1c2';

const PWSH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const BIN = 'C:\\Users\\Chen\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';

// ── 纯函数（可单测） ────────────────────────────────────────────────────

/** 新建一次请求的状态对象。 */
export function newState({ id, requester, note, targets, now = Date.now() }) {
  return {
    id,
    phase: 'collecting',
    at: new Date(now).toISOString(),
    requester: String(requester ?? ''),
    note: String(note ?? ''),
    targets: [...new Set(targets)].filter((t) => t && t !== requester),
    votes: {},
    token: null,
    tokenUsed: false,
    nudged: false,
    pendingNotify: [],
  };
}

/** 记一票；返回 { state, transition }，transition ∈ null|'approved'|'denied'。 */
export function recordVote(state, sid, decision, reason, now = Date.now()) {
  if (!state || state.phase !== 'collecting') return { state, transition: null, error: '当前没有待表决的请求' };
  if (!state.targets.includes(sid)) return { state, transition: null, error: '你不是本次被通知的对象' };
  if (state.votes[sid]) return { state, transition: null, error: '你已经表决过了' };
  if (decision === 'deny' && !String(reason ?? '').trim()) return { state, transition: null, error: '拒绝必须附上理由' };

  const next = {
    ...state,
    votes: { ...state.votes, [sid]: { decision, reason: String(reason ?? '').trim(), at: new Date(now).toISOString() } },
  };
  if (decision === 'deny') { next.phase = 'denied'; return { state: next, transition: 'denied' }; }
  if (next.targets.every((t) => next.votes[t])) {
    next.phase = 'approved';
    next.token = randomUUID();
    next.approvedAt = new Date(now).toISOString();
    return { state: next, transition: 'approved' };
  }
  return { state: next, transition: null };
}

/** 按时间推进后台阶段。返回 { state, nudge }。 */
export function tick(state, now = Date.now()) {
  if (!state || state.phase !== 'collecting') return { state, nudge: false };
  const at = Date.parse(state.at);
  if (!Number.isFinite(at)) return { state, nudge: false };
  if (now - at >= EXPIRE_MS) return { state: { ...state, phase: 'expired' }, nudge: false };
  if (now - at >= NUDGE_MS && !state.nudged) return { state: { ...state, nudged: true }, nudge: true };
  return { state, nudge: false };
}

/** ② 的准入判定。 */
export function canCommit(state, token, now = Date.now()) {
  if (!state) return { ok: false, error: '没有重启请求' };
  if (state.approvedAt && now - Date.parse(state.approvedAt) > EXPIRE_MS) return { ok: false, error: '凭证已过期（批准后超过 10 分钟）' };
  if (state.phase !== 'approved') return { ok: false, error: '当前状态是 ' + state.phase + '，不能执行重启' };
  if (state.tokenUsed) return { ok: false, error: '该凭证已用过，不能重复重启' };
  if (!state.token || token !== state.token) return { ok: false, error: '凭证不匹配' };
  return { ok: true };
}

/** 未表决者。 */
export function pendingTargets(state) {
  if (!state) return [];
  return state.targets.filter((t) => !state.votes[t]);
}

// ── 落盘 ────────────────────────────────────────────────────────────────
function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch {} }

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}
function writeState(s) {
  ensureDir();
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) { log('writeState failed: ' + e.message); }
}
export function log(m) {
  try {
    ensureDir();
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n', 'utf8');
  } catch {}
}

// ── 重启执行体（沿用已实测的 schtasks + 隐藏 VBS 路径） ────────────────────
const DOER_PS1 = [
  'param([switch]$DryRun)',
  "$LOG = '" + LOG + "'",
  "$NODE = '" + NODE + "'",
  "$BIN = '" + BIN + "'",
  "$RES = '" + RESULT + "'",
  'function W($m) { ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $m) | Add-Content -LiteralPath $LOG -Encoding UTF8 }',
  'function ListenerPid { $l = (netstat -ano | Select-String ":3080 .*LISTENING" | Select-Object -First 1); if ($l) { return [int](($l -replace "\\s+", " ").Trim().Split(" ")[-1]) } return 0 }',
  'W "doer start"',
  '$old = ListenerPid; W ("old pid=" + $old)',
  'if ($DryRun) { W "dry-run: no kill, no launch"; exit 0 }',
  'if ($old -gt 0) { try { Stop-Process -Id $old -Force -ErrorAction Stop; W ("stopped " + $old) } catch { W ("stop failed: " + $_.Exception.Message) } }',
  'Start-Sleep -Seconds 8',
  // 2026-10-31：把子进程的输出落到文件。之前 13:06:34 doer 报告 up=true（pid 7164 在听 3080），
  // 但那个进程随后消失了，Windows 日志里既没有崩溃也没有 OOM ⇒ 无法判断原因。
  // 现在 node 的 stdout/stderr 直接写进 launch.out / launch.err，下次能看见它为什么退。
  "$OUT = '" + LAUNCH_OUT + "'", "$ERR = '" + LAUNCH_ERR + "'",
  '$lp = 0',
  '$i = 0; while ($i -lt 3) { try { $p = Start-Process -FilePath $NODE -ArgumentList @($BIN, "web", "--no-open") -WindowStyle Hidden -RedirectStandardOutput $OUT -RedirectStandardError $ERR -PassThru; $lp = $p.Id; W ("launched pid=" + $lp); break } catch { $i++; W ("launch failed: " + $_.Exception.Message); Start-Sleep -Seconds 3 } }',
  '$new = 0; for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Seconds 2; $new = ListenerPid; if ($new -gt 0) { break } }',
  'W ("new pid=" + $new)',
  // 复检：起来 15 秒后还活着吗？不活就再拉一次（这一条就是针对"报告成功但其实没活"）
  'if ($new -gt 0) { Start-Sleep -Seconds 15; $alive = $false; try { $null = Get-Process -Id $new -ErrorAction Stop; $alive = $true } catch { $alive = $false }; W ("liveness check pid=" + $new + " alive=" + $alive); if (-not $alive) { try { $p2 = Start-Process -FilePath $NODE -ArgumentList @($BIN, "web", "--no-open") -WindowStyle Hidden -RedirectStandardOutput $OUT -RedirectStandardError $ERR -PassThru; W ("relaunch pid=" + $p2.Id) } catch { W ("relaunch failed: " + $_.Exception.Message) }; for ($i = 0; $i -lt 25; $i++) { Start-Sleep -Seconds 2; $new = ListenerPid; if ($new -gt 0) { break } }; W ("new pid after relaunch=" + $new) } }',
  'try { schtasks /delete /tn "' + TASK + '" /f 2>$null | Out-Null; W "task deleted" } catch { }',
  '$r = [ordered]@{ at = (Get-Date -Format "yyyy-MM-dd HH:mm:ss"); oldPid = $old; newPid = $new; up = ($new -gt 0) }',
  '[IO.File]::WriteAllText($RES, ($r | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))',
  'W ("RESULT " + ($r | ConvertTo-Json -Compress))',
].join('\r\n');

const VBS_TEXT = [
  'Set sh = CreateObject("WScript.Shell")',
  'sh.Run """' + PWSH + '"" -NoProfile -ExecutionPolicy Bypass -File ""' + DOER + '""", 0, False',
].join('\r\n');

function scheduleRestart() {
  ensureDir();
  try {
    fs.writeFileSync(DOER, DOER_PS1, 'utf8');
    fs.writeFileSync(VBS, VBS_TEXT, 'utf8');
  } catch (e) {
    return { ok: false, error: '写入重启脚本失败：' + e.message };
  }
  try { execFileSync('schtasks', ['/delete', '/tn', TASK, '/f'], { encoding: 'utf8', timeout: 20000, windowsHide: true }); } catch {}
  try {
    // 只排到 2099（永不自触发），紧接着 /run 一次，doer 跑完自删 ⇒ 结构上不可能出现第二次。
    execFileSync('schtasks', ['/create', '/tn', TASK, '/tr', 'wscript.exe //B //Nologo ' + VBS,
      '/sc', 'once', '/sd', '2099/12/31', '/st', '23:59', '/f'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    execFileSync('schtasks', ['/run', '/tn', TASK], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    log('scheduled: schtasks 2099 + run once');
    return { ok: true };
  } catch (e) {
    try {
      execFileSync('wscript.exe', ['//B', '//Nologo', VBS], { timeout: 20000, windowsHide: true, stdio: 'ignore' });
      log('scheduled: direct wscript fallback (' + (e && e.message) + ')');
      return { ok: true, fallback: true };
    } catch (e2) {
      return { ok: false, error: '排定重启失败：' + (e2 && e2.message ? e2.message : String(e2)) };
    }
  }
}

// ── 插件主体 ────────────────────────────────────────────────────────────
export function apply(ctx) {
  ensureDir();

  const senderOf = (exec) => {
    try { if (exec && exec.agent && exec.agent.id) return String(exec.agent.id); } catch {}
    try { if (exec && exec.sessionId) return String(exec.sessionId); } catch {}
    return '';
  };

  const sc = () => { try { return ctx.get ? ctx.get('sessionController') : undefined; } catch { return undefined; } };

  /**
   * 被我们唤醒过（resolveAgent 成功投递）的会话 id。
   *
   * 用来补 list() 的漏：2026-10-31 实测，经 resolveAgent 唤醒的会话不会出现在
   * `sessionController.list()` 的 running 名单里，于是重启广播根本不发 —— 目标数恒为 0。
   */
  const woken = new Map();

  /** 该会话当前是否仍持有 Agent（用于判断 woken 里的旧 id 是否还有效）。 */
  const hasAgent = (id) => {
    let agents = null;
    try { agents = ctx.get ? ctx.get('agents') : undefined; } catch { agents = null; }
    if (!agents) return false;
    let a = undefined;
    try { a = typeof agents.get === 'function' ? agents.get(id) : undefined; } catch { a = undefined; }
    if (a) return true;
    let all = [];
    try { all = typeof agents.list === 'function' ? (agents.list() || []) : []; } catch { all = []; }
    const bare = String(id).replace(/^session-/, '');
    return all.some((x) => x && (x.id === id || String(x.id).replace(/^session-/, '') === bare));
  };

  /** 投递一条【Agent 消息】（不是用户消息）。 */
  const relay = (toId, kind, body, senderId) => {
    let agents = null;
    try { agents = ctx.get ? ctx.get('agents') : undefined; } catch { agents = null; }
    const lookup = (id) => {
      if (!agents) return undefined;
      let a = typeof agents.get === 'function' ? agents.get(id) : undefined;
      if (a) return a;
      // 2026-10-31：传进来的常常是 session-id（session-xxxx），而 agents.get 只认 agent id。
      // 之前查不到就静默返回，导致「重启完成」通知永远送不到（用户实测：消息没收到）。
      // ⇒ 先按 list() 模糊匹配一次，再按去掉 session- 前缀匹配一次。
      if (typeof agents.list !== 'function') return undefined;
      let all = [];
      try { all = agents.list() || []; } catch { all = []; }
      const bare = String(id).replace(/^session-/, '');
      return all.find((x) => x && (
        x.id === id ||
        (Array.isArray(x.altIds) && x.altIds.includes(id)) ||
        String(x.id).replace(/^session-/, '') === bare));
    };
    const text = '【Agent 消息·' + kind + '】from ' + senderId + '\n' + body;
    const msg = {
      id: randomUUID(),
      // 2026-10-31：会话校验器只接受 role === 'user'
      //   （实测：session event at seq 1773 message must have role "user" ⇒ 会话被判 corrupt）
      // ⇒ role 写 'user'；"这是 Agent 消息"由 source.kind 表达，不靠 role。
      //   完全不写 role 时，组给模型会 400：messages[N]: missing field `role`。
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: senderId },
    };
    const deliver = (a, how) => {
      try {
        if (a.inbox && typeof a.inbox.send === 'function') { a.inbox.send(msg, 'turn', true); log('relay ok(inbox/' + how + ') → ' + toId); return true; }
        if (typeof a.followup === 'function') { a.followup(msg); log('relay ok(followup/' + how + ') → ' + toId); return true; }
      } catch (e) { log('relay send THREW (' + how + ') → ' + toId + ' :: ' + (e && e.message ? e.message : String(e))); }
      return false;
    };
    const agent = lookup(toId);
    if (agent && deliver(agent, 'live')) return { ok: true, via: 'live' };
    // 2026-10-31：目标没加载时，用官方入口 SessionController.resolveAgent(sessionId) 唤起。
    // 它的注释原文就是 "Resolve or resume one ordinary Session" —— 这才是真唤醒。
    // （之前的 sessionController.prompt 只是"接受"，实测目标会话文件根本没被写过。）
    const c = sc();
    if (c && typeof c.resolveAgent === 'function') {
      Promise.resolve(c.resolveAgent(toId)).then((r) => {
        const a = r && (r.agent || r.value || null);
        if (!a) { log('wake FAILED: resolveAgent 未返回 Agent → ' + toId + ' :: ' + JSON.stringify(r || null).slice(0, 200)); return; }
        woken.set(String(toId), Date.now());
        if (deliver(a, 'wake')) log('wake ok → ' + toId);
      }).catch((e) => log('wake THREW → ' + toId + ' :: ' + (e && e.message ? e.message : String(e))));
      return { ok: true, via: 'wake' };
    }
    log('relay FAILED: 既无存活 Agent 也无法唤起 for ' + toId);
    return { ok: false, error: '目标会话没有存活 Agent，且没有可用的唤起接口' };
  };

  /**
   * 会话里是否**真的发生过对话**（不只是头部）。
   *
   * 2026-11-06 事故：GUI 在某个时刻建了一个只有会话头、没有任何消息的草稿会话，
   * 文件 mtime 立刻是"刚刚" ⇒ 被当成"正在干活" ⇒ 重启请求把它拉进投票名单并**唤醒**它，
   * 用户在窗口里看到一个凭空冒出来、还在投票的对话，以为是插件在乱开窗。
   *
   * 所以"忙"不能只看 mtime：必须存在 user/message、assistant/message 或 turn/start 才算数。
   */
  const sessionHasWork = (file) => {
    let buf;
    try { buf = fs.readFileSync(file); } catch { return false; }
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    let i = 0;
    let sawHeader = false;
    while ((i = buf.indexOf(MAGIC, i)) !== -1) {
      let text = '';
      try { text = zstdDecompressSync(buf.subarray(i)).toString('utf8'); } catch { i += MAGIC.length; continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        if (!sawHeader) { sawHeader = true; continue; }  // 第一行是会话头
        // 只认"真的动过"的事件；title/设置类事件不算（草稿会话也可能写它们）
        if (line.includes('"user/message"') || line.includes('"assistant/message"') || line.includes('"turn/start"')) {
          return true;
        }
      }
      i += MAGIC.length;
    }
    return false;
  };

  /**
   * 最近 windowMs 内有写入、且**真的在对话**的会话。
   *
   * 为什么需要：这台机器上 `sessionController.list()` 恒为 0 项，于是"正在跑的对话"
   * 完全不会出现在重启目标里（实测：PicoMode (1) 在跑，但没被征求同意）。
   * 会话只要在干活就一定会写这个文件；但**空会话也会被写**，所以要再用 sessionHasWork 过滤。
   */
  const sessionsRecentlyWritten = (windowMs) => {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const root = path.join(home, 'sessions');
    const cutoff = Date.now() - windowMs;
    const found = [];
    let workspaces = [];
    try { workspaces = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      let sessions = [];
      try { sessions = fs.readdirSync(path.join(root, ws.name), { withFileTypes: true }); } catch { continue; }
      for (const s of sessions) {
        if (!s.isDirectory() || !s.name.startsWith('session-')) continue;
        const file = path.join(root, ws.name, s.name, 'session.v4.jsonl.zstd');
        try {
          if (fs.statSync(file).mtimeMs < cutoff) continue;
          // 刚写过的空会话（草稿）不算忙：它没有任何工作可被打断，也不该被唤醒去投票。
          if (!sessionHasWork(file)) { log('skip 空会话（无对话事件）: ' + s.name); continue; }
          found.push(s.name);
        } catch { /* 没有这个文件就不是活跃会话 */ }
      }
    }
    return found;
  };

  /** 除发起者外，正在干活的会话：本轮在跑 / 有子 Agent 在跑 / 我们唤醒过且仍加载。 */
  const busySessions = (requester) => {    const union = new Set();
    let items = [];
    // 2026-10-31 实测：三轮重启请求都报"目标=0"，而目标会话当时明明在跑子 agent。
    // 原实现把 list() 整段包在 try/catch 里并静默返回空数组 ⇒ 任何异常都变成"没人忙"，
    // 于是直接批准、广播从未发生。现在：出错要记日志，并用第二个来源兜底。
    try {
      const c = sc();
      if (!c) log('busySessions: sessionController 不可用');
      else if (typeof c.list !== 'function') log('busySessions: list() 不存在，keys=' + Object.keys(c).slice(0, 20).join(','));
      else {
        const r = c.list({});
        items = (r && r.items) || [];
        const sample = items[0] ? Object.keys(items[0]).slice(0, 18).join(',') : '(空)';
        log('busySessions: list() 返回 ' + items.length + ' 项；首项字段=' + sample);
      }
    } catch (e) {
      log('busySessions: list() THREW :: ' + (e && e.message ? e.message : String(e)));
    }
    for (const s of items) {
      if (!s) continue;
      if (s.running) union.add(String(s.sessionId));
      if (s.running && s.parentSessionId) union.add(String(s.parentSessionId));
    }
    // 兜底 1（最可靠）：按**会话文件的写入时间**判断是否在干活。
    // 2026-10-31 实测：这台机器上 list() 恒为 0 项，导致"PicoMode (1) 正在运行"时
    // 重启请求没把它列为目标、也就没征求它同意。会话只要在跑，磁盘上一定有近期写入，
    // 这条与 sessionController 无关，90 秒内写过就算忙。
    try {
      const recent = sessionsRecentlyWritten(90 * 1000);
      for (const id of recent) {
        if (id === requester) continue;
        union.add(id);
      }
      log('busySessions: 文件活跃会话 ' + recent.length + ' 个 → ' + recent.join(','));
    } catch (e) {
      log('busySessions: 扫描会话文件失败 :: ' + (e && e.message ? e.message : String(e)));
    }
    // 兜底 2：经 resolveAgent 唤醒过、且此刻仍持有 Agent 的会话。
    const WOKEN_TTL_MS = 10 * 60_000;
    for (const [id, at] of woken) {
      if (Date.now() - at > WOKEN_TTL_MS) { woken.delete(id); continue; }
      if (id === requester) continue;
      if (hasAgent(id)) union.add(id);
    }
    // 常驻审批岗：无条件加入（不管它忙不忙），任何重启都必须经它投一票。
    if (requester !== APPROVAL_SESSION) union.add(APPROVAL_SESSION);
    union.delete(requester);
    log('busySessions: 最终目标 ' + union.size + ' 个 → ' + [...union].join(','));
    return [...union];
  };

  const notifyTargets = (targets, kind, body, senderId, opts) => {
    const skip = (opts && opts.skip) || [];
    const okIds = [];
    for (const t of targets) {
      // 审批员只在「需要它投票」时收消息；其余流程通知（进入待执行、重启完成等）
      // 对它都是纯噪声（用户 2026-11-06 要求）。
      if (skip.includes(t)) continue;
      const r = relay(t, kind, body, senderId);
      if (r.ok) okIds.push(t); else log('relay failed to ' + t + ': ' + r.error);
    }
    return okIds;
  };

  const defRequest = {
    name: 'dsh_restart',
    description:
      'Request a DSH restart. Notifies every OTHER busy conversation with an Agent message, then waits up to 3 minutes until all agree. ' +
      'It never restarts by itself: on approval it returns a one-shot token, and only dsh_restart_commit with that token restarts.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { note: { type: 'string', description: 'Optional one-line reason shown to the peers.' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: ((typeof (v && v.text) === 'string' ? v.text : JSON.stringify(v)) + (v && v.token ? '\ntoken=' + v.token + '\n（把 token 原样传给 dsh_restart_commit 即可执行；一次性，用掉作废）' : '')) }],
    },
    timeoutMs: WAIT_BLOCK_MS + 20000,
    async execute(args, exec) {
      const requester = senderOf(exec);
      const cur = readState();
      if (cur && (cur.phase === 'collecting' || cur.phase === 'approved')) {
        const stale = cur.phase === 'approved' && cur.approvedAt && Date.now() - Date.parse(cur.approvedAt) > EXPIRE_MS;
        if (!stale) return { ok: false, text: '已有进行中的请求（' + cur.phase + '，id=' + cur.id + '）：用 dsh_restart_status 查看。' };
        writeState(Object.assign({}, cur, { phase: 'expired' }));
        log('previous approved request expired: ' + cur.id);
      }

      const targets = busySessions(requester);
      const st = newState({ id: randomUUID(), requester, note: args && args.note, targets });
      writeState(st);

      if (targets.length === 0) {
        st.phase = 'approved';
        st.token = randomUUID();
        writeState(st);
        return { ok: true, phase: 'approved', token: st.token, targets: [], text: '没有其它正在干活的会话，表决为空 ⇒ 已批准。用 dsh_restart_commit 执行（token 只能用一次）。' };
      }

      const notified = notifyTargets(targets, 'request',
        '请求重启 DSH' + (st.note ? '：' + st.note : '') + '。\n同意请调用 allowdshrestarting；拒绝请调用 stopdshfromrestarting 并附理由。',
        requester);
      writeState(st);

      const deadline = Date.now() + WAIT_BLOCK_MS;
      while (Date.now() < deadline) {
        const s = readState();
        if (!s || s.id !== st.id) return { ok: false, text: '请求状态被外部清理，表决中止' };
        if (s.phase === 'approved') {
          return { ok: true, phase: 'approved', token: s.token, targets: s.targets, text: '全员同意（' + s.targets.length + '/' + s.targets.length + '）⇒ 已批准。调用 dsh_restart_commit 执行。' };
        }
        if (s.phase === 'denied') {
          const reasons = Object.entries(s.votes).filter((kv) => kv[1].decision === 'deny').map((kv) => kv[0] + '：' + kv[1].reason);
          return { ok: false, phase: 'denied', reasons, text: '被拒绝：\n' + reasons.join('\n') };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const s2 = readState();
      const voted = s2 ? Object.keys(s2.votes || {}).length : 0;
      return { ok: true, phase: 'collecting', targets: st.targets, notified, text: '3 分钟内未收齐（' + voted + '/' + st.targets.length + '）。已转后台：5 分钟催未决者，10 分钟作废；用 dsh_restart_status 查看。' };
    },
  };

  const defCommit = {
    name: 'dsh_restart_commit',
    description: 'Execute an approved DSH restart with the one-shot token returned by dsh_restart. The token is consumed.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { token: { type: 'string' } }, required: ['token'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: ((typeof (v && v.text) === 'string' ? v.text : JSON.stringify(v)) + (v && v.token ? '\ntoken=' + v.token + '\n（把 token 原样传给 dsh_restart_commit 即可执行；一次性，用掉作废）' : '')) }],
    },
    async execute(args, exec) {
      const st = readState();
      const gate = canCommit(st, args && args.token);
      if (!gate.ok) return { ok: false, text: gate.error };
      // 只认发起者：A 申请、B 提交 这条路必须堵死（2026-10-31 事故：另一个会话
      // 为加载自己的工具而重启，把正在对话的用户一起断开）。
      const caller0 = senderOf(exec);
      if (st.requester && caller0 && caller0 !== st.requester) {
        log('commit 被拒：调用者 ' + caller0 + ' ≠ 发起者 ' + st.requester);
        return { ok: false, text: '只有发起本次重启请求的会话才能执行它（当前调用者不是发起者）。' };
      }
      const next = Object.assign({}, st, {
      phase: 'committed',
      tokenUsed: true,
      // 「重启完成」不必再告诉重启审批员：它已经投过票、也知道自己批的是什么。
      // 每重启一次就给它推一条"重启完成"是纯噪声（用户 2026-10-31 明确要求去掉）。
      pendingNotify: st.targets.concat(st.requester).filter((id) => id && id !== APPROVAL_SESSION),
    });
      writeState(next);
      const r = scheduleRestart();
      if (!r.ok) {
        writeState(Object.assign({}, st, { tokenUsed: false, phase: 'approved' }));
        return { ok: false, text: r.error };
      }
      return { ok: true, text: '已排定重启（只排一次：2099 任务 + 单次触发 + 自删）。约 20 秒后回来。' };
    },
  };

  // 2026-10-31：补上 harness 自带 agent_send 缺的能力 —— 「把消息送到关着的会话」。
  // agent_send 只认活动会话；本工具走 relay 的三级投递（含 sessionController.prompt 唤起）。
  const defWake = {
    name: 'dsh_wake_session',
    description: 'Deliver an Agent message to a session by id, waking it if it is not loaded (agent_send cannot do this). Omit `to` to send to yourself.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'session-<uuid> or bare uuid' },
        text: { type: 'string' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: ((typeof (v && v.text) === 'string' ? v.text : JSON.stringify(v)) + (v && v.token ? '\ntoken=' + v.token + '\n（把 token 原样传给 dsh_restart_commit 即可执行；一次性，用掉作废）' : '')) }],
    },
    async execute(args, exec) {
      const self = senderOf(exec);
      const to = (args && args.to) || self;
      if (!to) return { ok: false, text: '拿不到目标会话 id' };
      const r = relay(to, 'notice', (args && args.text) || 'wake 测试', self || to);
      return { ok: !!r.ok, to, via: r.via || 'live', text: (r.ok ? '已投递 → ' + to : '投递失败 → ' + to + '：' + (r.error || '')) };
    },
  };

  const defStatus = {    name: 'dsh_restart_status',
    description: 'Show the current restart request: phase, votes, pending peers, denial reasons, token state.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: ((typeof (v && v.text) === 'string' ? v.text : JSON.stringify(v)) + (v && v.token ? '\ntoken=' + v.token + '\n（把 token 原样传给 dsh_restart_commit 即可执行；一次性，用掉作废）' : '')) }],
    },
    async execute() {
      const st = readState();
      if (!st) return { ok: true, phase: 'none', text: '没有重启请求。' };
      const pending = pendingTargets(st);
      const denies = Object.entries(st.votes).filter((kv) => kv[1].decision === 'deny').map((kv) => kv[0] + '：' + kv[1].reason);
      return {
        ok: true, id: st.id, phase: st.phase, requester: st.requester, note: st.note,
        targets: st.targets, votes: st.votes, pending,
        text: [
          'id=' + st.id + ' phase=' + st.phase,
          '发起者=' + st.requester + (st.note ? ' 备注=' + st.note : ''),
          '目标=' + st.targets.length + ' 已表决=' + Object.keys(st.votes).length + ' 未决=' + (pending.join(',') || '无'),
          denies.length ? '拒绝理由：\n' + denies.join('\n') : '',
          st.phase === 'approved' ? '已批准：用 dsh_restart_commit 执行（token 一次性）' : '',
        ].filter(Boolean).join('\n'),
      };
    },
  };

  const voteTool = (decision, toolName, description) => ({
    name: toolName,
    description,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: decision === 'deny' ? { reason: { type: 'string', description: 'Why you refuse (required).' } } : {},
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: ((typeof (v && v.text) === 'string' ? v.text : JSON.stringify(v)) + (v && v.token ? '\ntoken=' + v.token + '\n（把 token 原样传给 dsh_restart_commit 即可执行；一次性，用掉作废）' : '')) }],
    },
    async execute(args, exec) {
      const sid = senderOf(exec);
      const st = readState();
      const r = recordVote(st, sid, decision, args && args.reason);
      if (r.error) return { ok: false, text: r.error };
      writeState(r.state);
      if (r.transition === 'approved') {
        notifyTargets(r.state.targets, 'notice', '全员已同意，重启进入待执行（由发起者提交）。', sid, { skip: [APPROVAL_SESSION] });
        return { ok: true, phase: 'approved', text: '已同意（最后一票）⇒ 已批准；等待发起者提交执行。' };
      }
      if (r.transition === 'denied') {
        notifyTargets(r.state.targets.concat(r.state.requester), 'notice', '已拒绝重启：' + String((args && args.reason) || ''), sid, { skip: [APPROVAL_SESSION] });
        return { ok: true, phase: 'denied', text: '已拒绝，理由已记录并通知发起者。' };
      }
      return { ok: true, phase: 'collecting', text: '已同意，还剩 ' + pendingTargets(r.state).length + ' 个未决。' };
    },
  });

  ctx.effect(() => ctx.tools.register(defRequest), 'dsh-restart: dsh_restart');
  ctx.effect(() => ctx.tools.register(defCommit), 'dsh-restart: dsh_restart_commit');
  ctx.effect(() => ctx.tools.register(defStatus), 'dsh-restart: dsh_restart_status');
  ctx.effect(() => ctx.tools.register(defWake), 'dsh-restart: dsh_wake_session');
  ctx.effect(() => ctx.tools.register(voteTool('allow', 'allowdshrestarting', 'Agree to the pending DSH restart.')), 'dsh-restart: allow');
  ctx.effect(() => ctx.tools.register(voteTool('deny', 'stopdshfromrestarting', 'Refuse the pending DSH restart; a reason is required.')), 'dsh-restart: deny');

  // 后台推进：5 分钟催、10 分钟作废（每 30 秒检查；重启后按时间戳继续）
  const timer = setInterval(() => {
    const st = readState();
    if (!st) return;
    const out = tick(st);
    if (out.state !== st) writeState(out.state);
    if (out.nudge) {
      const pending = pendingTargets(out.state);
      // 消息里带上请求 id：实测审批会话会因为读到旧请求（上一条已 denied）而说"没有待表决请求"，
      // 带上 id 它就能对着这一条表决，而不是靠"最近一条"猜。
      notifyTargets(pending, 'notice', '重启表决还在等你（请求 ' + out.state.id + '）：同意请 allowdshrestarting；拒绝请 stopdshfromrestarting 并附理由。', out.state.requester);
      log('nudged ' + pending.join(','));
    }
  }, 30000);
  try { timer.unref(); } catch {}

  // 重启后回放：把「重启完成」告诉所有被通知者 + 发起者
  // 2026-10-31：原来只在挂载后 5 秒试一次。实测重启完成时各会话可能还没「活」过来，
  // relay 查不到 Agent ⇒ 通知永远送不到（用户："看来消息没有送达啊"）。
  // ⇒ 改成 5s / 20s / 45s 三次重试，**送成功了才清 pendingNotify**，失败留着下次再试。
  const replay = (attempt) => {
    const st = readState();
    if (!st || st.phase !== 'committed' || !Array.isArray(st.pendingNotify) || st.pendingNotify.length === 0) return;
    let res = null;
    try { res = JSON.parse(fs.readFileSync(RESULT, 'utf8')); } catch (e) { res = null; }
    const summary = res ? '重启完成：旧 pid ' + res.oldPid + ' → 新 pid ' + res.newPid + '，监听=' + res.up : '重启完成（未读到结果文件）';
    const still = [];
    for (const sid of st.pendingNotify) {
      if (sid === APPROVAL_SESSION) continue; // 审批员不收「重启完成」；见 writeState 处的说明
      const r = relay(sid, 'notice', summary, st.requester);
      if (!r.ok) still.push(sid);
    }
    log('replay#' + attempt + ' pending=' + st.pendingNotify.length + ' 未送达=' + still.length);
    if (still.length === 0) {
      writeState(Object.assign({}, st, { phase: 'done', pendingNotify: [] }));
    } else if (attempt < 3) {
      const t = setTimeout(() => replay(attempt + 1), attempt === 1 ? 15000 : 25000);
      try { t.unref(); } catch {}
    }
  };
  const replayTimer = setTimeout(() => replay(1), 5000);
  try { replayTimer.unref(); } catch {}

  // 用户命令：/restartdsh（0 延时、不走表决）
  try {
    ctx.inject(['commands'], (c) => {
      try {
        c.commands.register({
          name: 'restartdsh',
          description: '立即重启 DSH（仅用户；不走表决，无延时）',
          handler: async () => {
            const r = scheduleRestart();
            return r.ok ? { kind: 'success', text: '已排定重启（无延时）。约 20 秒后回来。' }
                        : { kind: 'error', text: r.error };
          },
        });
      } catch (e) { log('register /restartdsh failed: ' + (e && e.message)); }
    });
  } catch (e) { log('inject commands failed: ' + (e && e.message)); }
}





