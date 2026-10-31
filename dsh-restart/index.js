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

export const name = '@local/dsh-restart';
export const inject = ['tools'];

const DIR = path.join(os.tmpdir(), 'dsh_restart');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'restart.log');
const RESULT = path.join(DIR, 'result.json');
const DOER = path.join(DIR, 'doer.ps1');
const VBS = path.join(DIR, 'silent.vbs');
const TASK = 'dsh_restart_once';

const WAIT_BLOCK_MS = 3 * 60_000;
const NUDGE_MS = 5 * 60_000;
const EXPIRE_MS = 10 * 60_000;

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
  '$i = 0; while ($i -lt 3) { try { Start-Process -FilePath $NODE -ArgumentList @($BIN, "web", "--no-open") -WindowStyle Hidden; W "launched"; break } catch { $i++; W ("launch failed: " + $_.Exception.Message); Start-Sleep -Seconds 3 } }',
  '$new = 0; for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Seconds 2; $new = ListenerPid; if ($new -gt 0) { break } }',
  'W ("new pid=" + $new)',
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
    const agent = lookup(toId);
    const text = '【Agent 消息·' + kind + '】from ' + senderId + '\n' + body;
    // 2026-10-31：目标会话可能根本没加载（"找不到活动会话"）。这时并不等于送不到 ——
    // harness 有唤醒入口：sessionController.prompt({sessionId,...})，会让该会话 open() 并收下这条。
    // ⇒ 三级投递：在线用 inbox/followup；不在线用 prompt 唤起；都不行才报错。
    const viaPrompt = () => {
      let sc = null;
      try { sc = ctx.get ? ctx.get('sessionController') : undefined; } catch { sc = null; }
      if (!sc || typeof sc.prompt !== 'function') return { ok: false, error: '没有 sessionController.prompt' };
      try {
        sc.prompt({
          requestId: 'dsh-restart-relay-' + randomUUID(),
          sessionId: toId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          source: { kind: 'agent-message', form: 'relay', senderSessionId: senderId },
        }, new AbortController().signal);
        log('relay ok(prompt/wake) → ' + toId);
        return { ok: true, via: 'prompt' };
      } catch (e) {
        log('relay prompt THREW → ' + toId + ' :: ' + (e && e.message ? e.message : String(e)));
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    };
    if (!agent) {
      const w = viaPrompt();
      if (w.ok) return w;
      log('relay FAILED: 没有存活 Agent 且无法唤起 for ' + toId);
      return { ok: false, error: '目标会话没有存活 Agent，且唤起失败：' + (w.error || '') };
    }
    const msg = {
      id: randomUUID(),
      // 2026-10-31：会话校验器只接受 role === 'user'
      //   （实测：session event at seq 1773 message must have role "user" ⇒ 会话被判 corrupt）
      // ⇒ role 写 'user'；"这是 Agent 消息"由下面的 source.kind 表达，不靠 role。
      //   完全不写 role 时，组给模型会 400：messages[N]: missing field `role`。
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: senderId },
    };
    try {
      if (agent.inbox && typeof agent.inbox.send === 'function') { agent.inbox.send(msg, 'turn', true); log('relay ok(inbox) → ' + toId); return { ok: true }; }
      if (typeof agent.followup === 'function') { agent.followup(msg); log('relay ok(followup) → ' + toId); return { ok: true }; }
      log('relay FAILED: 该 Agent 没有投递接口 → ' + toId);
      return { ok: false, error: '该 Agent 没有可用的投递接口' };
    } catch (e) {
      log('relay THREW → ' + toId + ' :: ' + (e && e.message ? e.message : String(e)));
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  };

  /** 除发起者外，正在干活的会话：本轮在跑 / 有子 Agent 在跑。 */
  const busySessions = (requester) => {
    let items = [];
    try {
      const r = sc() ? sc().list({}) : null;
      items = (r && r.items) || [];
    } catch { items = []; }
    const union = new Set();
    for (const s of items) {
      if (!s) continue;
      if (s.running) union.add(String(s.sessionId));
      if (s.running && s.parentSessionId) union.add(String(s.parentSessionId));
    }
    union.delete(requester);
    return [...union];
  };

  const notifyTargets = (targets, kind, body, senderId) => {
    const okIds = [];
    for (const t of targets) {
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
      render: (_a, v) => [{ type: 'text', text: typeof (v && v.text) === 'string' ? v.text : JSON.stringify(v) }],
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
      render: (_a, v) => [{ type: 'text', text: typeof (v && v.text) === 'string' ? v.text : JSON.stringify(v) }],
    },
    async execute(args) {
      const st = readState();
      const gate = canCommit(st, args && args.token);
      if (!gate.ok) return { ok: false, text: gate.error };
      const next = Object.assign({}, st, { phase: 'committed', tokenUsed: true, pendingNotify: st.targets.concat(st.requester).filter(Boolean) });
      writeState(next);
      const r = scheduleRestart();
      if (!r.ok) {
        writeState(Object.assign({}, st, { tokenUsed: false, phase: 'approved' }));
        return { ok: false, text: r.error };
      }
      return { ok: true, text: '已排定重启（只排一次：2099 任务 + 单次触发 + 自删）。约 20 秒后回来。' };
    },
  };

  const defStatus = {    name: 'dsh_restart_status',
    description: 'Show the current restart request: phase, votes, pending peers, denial reasons, token state.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: typeof (v && v.text) === 'string' ? v.text : JSON.stringify(v) }],
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
      render: (_a, v) => [{ type: 'text', text: typeof (v && v.text) === 'string' ? v.text : JSON.stringify(v) }],
    },
    async execute(args, exec) {
      const sid = senderOf(exec);
      const st = readState();
      const r = recordVote(st, sid, decision, args && args.reason);
      if (r.error) return { ok: false, text: r.error };
      writeState(r.state);
      if (r.transition === 'approved') {
        notifyTargets(r.state.targets, 'notice', '全员已同意，重启进入待执行（由发起者提交）。', sid);
        return { ok: true, phase: 'approved', text: '已同意（最后一票）⇒ 已批准；等待发起者提交执行。' };
      }
      if (r.transition === 'denied') {
        notifyTargets(r.state.targets.concat(r.state.requester), 'notice', '已拒绝重启：' + String((args && args.reason) || ''), sid);
        return { ok: true, phase: 'denied', text: '已拒绝，理由已记录并通知发起者。' };
      }
      return { ok: true, phase: 'collecting', text: '已同意，还剩 ' + pendingTargets(r.state).length + ' 个未决。' };
    },
  });

  ctx.effect(() => ctx.tools.register(defRequest), 'dsh-restart: dsh_restart');
  ctx.effect(() => ctx.tools.register(defCommit), 'dsh-restart: dsh_restart_commit');
  ctx.effect(() => ctx.tools.register(defStatus), 'dsh-restart: dsh_restart_status');
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
      notifyTargets(pending, 'notice', '重启表决还在等你：同意请 allowdshrestarting；拒绝请 stopdshfromrestarting 并附理由。', out.state.requester);
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
