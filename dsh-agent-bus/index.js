/**
 * dsh-agent-bus —— Agent 之间的横向消息通道（L1 信封 + L2 请求/应答）
 * ======================================================================
 * 设计约束（2026-10-31 与用户确定）：
 *
 *  1. 消息必须是【Agent 消息】，绝不能落成【用户消息】。
 *     实现方式：投递时显式带
 *        source = { kind: 'agent-message', form: 'relay', senderSessionId }
 *     这正是 @deepseek-ai/dsh-subagent 内部投递子 Agent 消息用的同一套来源标记。
 *     后果（物理层，不依赖 Agent 自觉）：
 *        dsh-tool-goal 只在"当前回合存在 source.kind === 'user' 的 user/message"时
 *        才承认目标修改权 ⇒ 收到 bus 消息的 Agent 在协议层就没有改目标的资格。
 *
 *  2. 不许当"传秘密"的通道。发送前正则扫描，命中即拒发（尽力而为，不是 100%）。
 *
 *  3. 不许无限循环。信封带 hop，> MAX_HOP 直接拒收；正文限长；每会话限速。
 *
 *  4. 全量审计：%TEMP%\dsh_agent_bus\bus.jsonl，谁发给谁、发了什么、拦了什么。
 *
 * 本文件只依赖 node 内置模块：插件的 import 从 dsh-plugins 目录解析，
 * 拿不到 @deepseek-ai/dsh-* 的包，所以消息对象按协议形状手工构造。
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const name = '@local/dsh-agent-bus';
export const inject = ['tools'];

const DIR = path.join(os.tmpdir(), 'dsh_agent_bus');
const LOG = path.join(DIR, 'bus.jsonl');

const KINDS = new Set(['notice', 'request', 'reply', 'status']);
const MAX_BODY = 500;
const MAX_HOP = 2;
const RATE_LIMIT = 30;          // 每个发送者 1 分钟内的上限
const RATE_WINDOW = 60_000;

// 群发（2026-11-12 用户要求）：单次最多 20 个目标；同一调用者 30 秒内最多 1 次。
const BROADCAST_MAX_TARGETS = 20;
const BROADCAST_WINDOW = 30_000;

/** 密钥/凭据类特征。命中即拒发——降低手滑概率，不承诺 100%。 */
export const SECRET_PATTERNS = [
  { label: 'bitlocker-recovery-key', re: /\b(?:\d{6}-){7}\d{6}\b/ },
  { label: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'api-key-sk', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { label: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'password-assignment', re: /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i },
  { label: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  { label: 'token-assignment', re: /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*[A-Za-z0-9._-]{12,}/i },
];

/** 扫出第一个命中的密钥特征，返回 label；无命中返回 null。纯函数。 */
export function scanSecrets(text) {
  const s = String(text ?? '');
  for (const p of SECRET_PATTERNS) if (p.re.test(s)) return p.label;
  return null;
}

/** 校验一条待发消息；返回 {ok:true} 或 {ok:false, error}。纯函数。 */
export function validateSend({ kind, body, hop } = {}) {
  if (!KINDS.has(String(kind))) return { ok: false, error: `kind 必须是 ${[...KINDS].join(' / ')}` };
  const text = String(body ?? '').trim();
  if (!text) return { ok: false, error: '正文不能为空' };
  if (text.length > MAX_BODY) return { ok: false, error: `正文超过 ${MAX_BODY} 字` };
  const h = Number(hop ?? 0);
  if (!Number.isFinite(h) || h < 0) return { ok: false, error: 'hop 非法' };
  if (h > MAX_HOP) return { ok: false, error: `消息跳数超过 ${MAX_HOP}，拒绝继续转发` };
  const hit = scanSecrets(text);
  if (hit) return { ok: false, error: `正文疑似含密钥（${hit}），拒绝发送` };
  return { ok: true };
}

/**
 * 把 to 解析成会话编号。
 * 只接受两种确定形式：`session-<uuid>` 或裸 uuid；不做模糊匹配、不做标题猜测。
 */
export function resolveTarget(liveIds, to) {
  const raw = String(to ?? '').trim();
  if (!raw) return { ok: false, error: '目标不能为空' };
  const exact = liveIds.find((id) => id === raw);
  if (exact) return { ok: true, sessionId: exact };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    const prefixed = `session-${raw.toLowerCase()}`;
    if (liveIds.includes(prefixed)) return { ok: true, sessionId: prefixed };
  }
  return { ok: false, error: `找不到活动会话 ${JSON.stringify(raw)}（只接受 session-<uuid> 或裸 uuid）` };
}

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
}

/** 追加一条审计记录。任何失败都不抛，只忽略（审计不能反过来弄坏调用）。 */
export function audit(record) {
  try {
    ensureDir();
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', 'utf8');
  } catch {}
}

/**
 * 构造 Agent 消息（**语义上不是用户消息**，但落盘时必须是 user/message）。
 *
 * 2026-10-31 修复（第二次踩这个坑）：
 * - 会话校验器 `dsh-session/lib/index.js` 对事件类型做 `type → role` 一一映射：
 *   `user/message` 的 role **只能**是 `'user'`（没有按来源开例外）。
 * - 漏写 role 的后果不是"这条消息不可见"，而是**整段会话被判 corrupt**：
 *   `session event at seq N message must have role "user"` ⇒ 会话打不开。
 *   （PicoMode 会话就是这么坏的，seq 3953，已手工补齐救回。）
 * - 完全不写 role 时，组给模型还会 400：`messages[N]: missing field \`role\``。
 * - **"这是 Agent 消息"由 `source.kind = 'agent-message'` 表达，不靠 role**：
 *   role 是"模型眼里的席位"（只有 user/assistant/system/tool/developer），
 *   source.kind 是"真实来源"。两者分工，不能互相顶替。
 */
export function buildAgentMessage(senderSessionId, text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  };
}

const rate = new Map(); // senderId -> { windowStart, count }
export function checkRate(senderId, now = Date.now()) {
  const st = rate.get(senderId);
  if (!st || now - st.windowStart > RATE_WINDOW) {
    rate.set(senderId, { windowStart: now, count: 1 });
    return { ok: true };
  }
  if (st.count >= RATE_LIMIT) return { ok: false, error: `发送过于频繁（${RATE_WINDOW / 1000}s 内上限 ${RATE_LIMIT} 条）` };
  st.count += 1;
  return { ok: true };
}

// ── 群发（2026-11-12 用户要求）────────────────────────────────────────────
// 一次给多个会话发同一条消息。工具名 agent_broadcast。
//   targets: 数组（完整 session id / 8 位短 id）或 "all" / "running"
//   text:    正文（沿用 agent_send 的信封与密钥扫描）
//   mode:    'steer'（默认，下一步读）/ 'turn'（排队）
//   kind:    默认 'notice'
//   includeSelf: 默认 false
// 规则：单次最多 20 个目标；同一调用者 30 秒内最多 1 次；密钥命中 ⇒ 整次取消。

const broadcastRate = new Map(); // senderId -> 上次群发的时间戳
export function checkBroadcastRate(senderId, now = Date.now()) {
  const last = broadcastRate.get(senderId);
  if (last !== undefined && now - last < BROADCAST_WINDOW) {
    const wait = Math.ceil((BROADCAST_WINDOW - (now - last)) / 1000);
    return { ok: false, error: `群发过于频繁（${BROADCAST_WINDOW / 1000} 秒内最多 1 次，还需等 ${wait} 秒）` };
  }
  broadcastRate.set(senderId, now);
  return { ok: true };
}

/**
 * 解析一个目标：先认完整编号（复用 resolveTarget），再认 8 位短 id。
 * 短 id 必须唯一命中，多义就报错，绝不猜。
 */
export function resolveShortTarget(liveIds, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: '目标不能为空' };
  const exact = liveIds.find((id) => id === text);
  if (exact) return { ok: true, sessionId: exact };
  const bare = text.replace(/^session-/, '');
  if (/^[0-9a-f]{8}$/i.test(bare)) {
    const hits = liveIds.filter((id) => String(id).replace(/^session-/, '').toLowerCase().startsWith(bare.toLowerCase()));
    if (hits.length === 1) return { ok: true, sessionId: hits[0] };
    if (hits.length > 1) return { ok: false, error: `短 id ${bare} 命中 ${hits.length} 个会话，请给完整 id` };
  }
  return resolveTarget(liveIds, text);
}

/**
 * 把一组原始目标解析成 [{ target, sessionId, error }]（纯函数）。
 * 解析失败的目标保留在结果里（后面会记一条失败审计），不静默丢弃。
 *
 * 2026-11-12：完整 session id / uuid 即使**没加载**也收下——留给投递阶段先唤醒，
 * 不能在这里当成"找不到活动会话"拒掉（用户实测的 bug 2）。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeSessionId(raw) {
  const text = String(raw ?? '').trim().replace(/^session-/, '');
  return UUID_RE.test(text) ? `session-${text.toLowerCase()}` : null;
}

export function resolveBroadcastTargets(liveIds, rawTargets, { sender = '', includeSelf = false } = {}) {
  if (!Array.isArray(rawTargets)) return { ok: false, error: 'targets 必须是数组，或字符串 "all" / "running"' };
  if (rawTargets.length === 0) return { ok: false, error: 'targets 不能为空' };
  if (rawTargets.length > BROADCAST_MAX_TARGETS) {
    return { ok: false, error: `一次最多 ${BROADCAST_MAX_TARGETS} 个目标（给了 ${rawTargets.length} 个）` };
  }
  const senderId = normalizeSessionId(sender) || String(sender || '');
  const out = [];
  const seen = new Set();
  for (const raw of rawTargets) {
    const r = resolveShortTarget(liveIds, raw);
    if (!r.ok) {
      const wakeId = normalizeSessionId(raw);
      if (wakeId) {
        if (!includeSelf && wakeId === senderId) continue;
        if (seen.has(wakeId)) continue;
        seen.add(wakeId);
        out.push({ target: String(raw), sessionId: wakeId, needsWake: true });
      } else {
        out.push({ target: String(raw), sessionId: null, error: r.error });
      }
      continue;
    }
    if (!includeSelf && r.sessionId === senderId) continue;
    if (seen.has(r.sessionId)) continue;
    seen.add(r.sessionId);
    out.push({ target: String(raw), sessionId: r.sessionId });
  }
  return { ok: true, targets: out };
}


export function apply(ctx) {
  ensureDir();

  /**
   * 会话最后一次"真的动过"的时间（毫秒时间戳），取不到返回 undefined。
   *
   * 数据来源：投影缓存 `%DSH_HOME%\storages\session_projcache\sessions\session-<id>.json`
   * 的修改时间。这是运行时会话持久化时必然刷新的文件，比"内存里有没有加载"可信。
   */
  const lastActivityMs = (sessionId) => {
    try {
      const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      // sessionId 本身通常已带 "session-" 前缀；重复拼接会永远取不到文件（2026-11-11 实测）。
      const bare = String(sessionId).replace(/^session-/, '');
      const dir = path.join(base, 'storages', 'session_projcache', 'sessions');
      const direct = path.join(dir, `session-${bare}.json`);
      try { return fs.statSync(direct).mtimeMs; } catch { /* 换一种布局再试 */ }
      // 兼容旧布局：分工作区目录下的 session.v4.jsonl.zstd
      const root = path.join(base, 'sessions');
      for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ws.isDirectory()) continue;
        try {
          return fs.statSync(path.join(root, ws.name, `session-${bare}`, 'session.v4.jsonl.zstd')).mtimeMs;
        } catch { /* 继续找 */ }
      }
      return undefined;
    } catch { return undefined; }
  };

  const liveIds = () => {
    try {
      const svc = ctx.get ? ctx.get('agents') : undefined;
      if (!svc || typeof svc.list !== 'function') return [];
      return svc.list().map((a) => String(a?.id ?? '')).filter(Boolean);
    } catch { return []; }
  };

  /**
   * 真正"此刻有一个回合在跑"的会话（本地补丁，2026-11-11）。
   *
   * 之前 `agent_sessions` 用 `liveIds()` 判定，那是"会话是否被加载在内存里"——
   * 一个会话被唤醒过一次就会一直挂在注册表里，于是界面显示"正在运行"，
   * 实际上一小时没有任何动作（用户实测：Worker_Pico_Low 16:45 之后再没动过，标记仍在）。
   *
   * 现在改成读每个 agent 自己的 `status`：`'running'` 表示有回合在跑，`'idle'` 表示没有。
   * 取不到 status 的（旧运行时）退回原判定，不把功能弄坏。
   */
  const liveRunningIds = () => {
    try {
      const svc = ctx.get ? ctx.get('agents') : undefined;
      if (!svc || typeof svc.list !== 'function') return [];
      const out = [];
      for (const a of svc.list()) {
        const id = String(a?.id ?? '');
        if (!id) continue;
        const status = a?.status;
        if (status === undefined || status === 'running') out.push(id);
      }
      return out;
    } catch { return []; }
  };

  const deliver = (toId, text, senderId, mode = 'steer') => {
    let agents = null;
    try { agents = ctx.get ? ctx.get('agents') : undefined; } catch { agents = null; }
    const agent = agents && typeof agents.get === 'function' ? agents.get(toId) : undefined;
    if (!agent) {
      /*
       * 2026-11-11：这句话以前写成"只能发给正在运行的会话"，把两件事混了——
       * 真正缺席的是"这个会话没有活着的 Agent"（没加载），而不是"它没有回合在跑"。
       * 加载了但空闲的会话是可以收消息的，收下后会被唤醒；所以这里如实说缺少什么。
       */
      return {
        ok: false,
        error: '目标会话没有活着的 Agent（既没加载也无法唤醒）；已加载但空闲的会话是可以接收消息的',
      };
    }
    const msg = buildAgentMessage(senderId, text);
    try {
      // 2026-11-08：原来用 followup ⇒ 排队到"下一个回合"，接收方要等整个回合跑完才看到，
      // 造成信息延迟。DSH 的"插话发送"走的是 steer ⇒ send(input,'next-step',true)，
      // 在下一个 step 开始前（上一次工具结果之后）就被读走。这里对齐 steer 语义。
      // 2026-11-12：群发需要 'turn' 模式，所以把边界变成参数；默认仍是 steer。
      if (mode === 'steer' && typeof agent.steer === 'function') { agent.steer(msg); return { ok: true, mode: 'steer' }; }
      if (typeof agent.followup === 'function') { agent.followup(msg); return { ok: true, mode: 'followup' }; }
      if (typeof agent.steer === 'function') { agent.steer(msg); return { ok: true, mode: 'steer' }; }
      // 旧的 inbox.send 分支已删除：Inbox 没有 send 方法，'turn' 也不是合法边界（查证见
      // docs/调查-消息插入延迟.md），属于死代码。
      return { ok: false, error: '该 Agent 既没有 steer 也没有 followup，无法投递' };
    } catch (e) {
      return { ok: false, error: '投递失败：' + (e && e.message ? e.message : String(e)) };
    }
  };

  /**
   * 投递一条消息；目标没加载就先冷唤起再投——与 dsh_wake_session 同一条路
   * （sessionController.resolveAgent → steer/followup）。
   *
   * 2026-11-12 用户实测：群发到"没加载"的会话时原来直接漏掉，必须补唤醒。
   * @returns {Promise<{ok:boolean, mode?:string, via?:'live'|'wake', error?:string}>}
   */
  const deliverWithWake = async (toId, text, senderId, mode = 'steer') => {
    const first = deliver(toId, text, senderId, mode);
    if (first.ok) return { ...first, via: 'live' };

    let sc = null;
    try { sc = ctx.get ? ctx.get('sessionController') : undefined; } catch { sc = null; }
    if (!sc || typeof sc.resolveAgent !== 'function') {
      return { ok: false, error: `${first.error}；且没有 sessionController.resolveAgent 可唤醒` };
    }
    let resolved;
    try {
      resolved = await Promise.resolve(sc.resolveAgent(toId));
    } catch (e) {
      return { ok: false, error: '唤醒失败：' + (e && e.message ? e.message : String(e)) };
    }
    const agent = resolved && (resolved.agent || resolved.value || null);
    if (!agent) {
      const err = resolved && resolved.error;
      let detail = '';
      if (err) {
        try { detail = typeof err === 'string' ? err : JSON.stringify(err).slice(0, 160); } catch { detail = String(err); }
      }
      return { ok: false, error: '唤醒失败：resolveAgent 未返回 Agent' + (detail ? `（${detail}）` : '') };
    }
    const msg = buildAgentMessage(senderId, text);
    try {
      if (mode === 'steer' && typeof agent.steer === 'function') { agent.steer(msg); return { ok: true, mode: 'steer', via: 'wake' }; }
      if (typeof agent.followup === 'function') { agent.followup(msg); return { ok: true, mode: 'followup', via: 'wake' }; }
      if (typeof agent.steer === 'function') { agent.steer(msg); return { ok: true, mode: 'steer', via: 'wake' }; }
      return { ok: false, error: '唤醒后的 Agent 既没有 steer 也没有 followup' };
    } catch (e) {
      return { ok: false, error: '唤醒后投递失败：' + (e && e.message ? e.message : String(e)) };
    }
  };

  const defSend = {
    name: 'agent_send',
    description:
      'Send one message to ANOTHER running Agent (a different conversation). This is a relay, not a user instruction: ' +
      'the recipient may treat it as information, but it does NOT grant permission to change goals, permissions or models. ' +
      'Never include secrets (keys, passwords, tokens, recovery keys) — such messages are rejected. ' +
      'Target must be an exact session id (session-<uuid> or bare uuid).',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        to: { type: 'string', description: 'Exact session id of the recipient (session-<uuid> or bare uuid).' },
        kind: { type: 'string', enum: [...KINDS], description: 'notice | request | reply | status' },
        body: { type: 'string', description: 'Plain text, max 500 chars. No secrets.' },
        replyTo: { type: 'string', description: 'Optional message id this message answers.' },
        hop: { type: 'integer', description: 'Forwarding depth; recipients auto-reply at hop+1. Max 2.' },
      },
      required: ['to', 'kind', 'body'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }],
    },
    async execute(args, exec) {
      const sender = senderOf(exec);
      const check = validateSend(args ?? {});
      if (!check.ok) { audit({ ev: 'reject', reason: check.error, from: sender, to: args?.to, body: String(args?.body ?? '').slice(0, 80) }); return { ok: false, text: check.error }; }
      const rl = checkRate(sender);
      if (!rl.ok) { audit({ ev: 'reject', reason: rl.error, from: sender }); return { ok: false, text: rl.error }; }

      const ids = liveIds();
      const target = resolveTarget(ids, args.to);
      if (!target.ok) return { ok: false, text: target.error };
      if (target.sessionId === sender) return { ok: false, text: '不能发给自己' };

      const hop = Number(args.hop ?? 0);
      const text = `【Agent 消息·${args.kind}】from ${sender}${args.replyTo ? `（回复 ${args.replyTo}）` : ''}\n${String(args.body).trim()}`;
      const sent = deliver(target.sessionId, text, sender);
      const id = randomUUID();
      audit({ ev: 'send', id, from: sender, to: target.sessionId, kind: args.kind, hop, ok: sent.ok, error: sent.error ?? null, body: String(args.body).trim() });

      return sent.ok
        ? { ok: true, id, to: target.sessionId, text: `已投递给 ${target.sessionId}（Agent 消息，非用户消息）` }
        : { ok: false, text: sent.error };
    },
  };

  const defInbox = {
    name: 'agent_inbox',
    description: 'Read recent Agent-to-Agent messages addressed to this session, from the bus audit log.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', description: 'Max messages to return (default 20).' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }],
    },
    async execute(args, exec) {
      const me = senderOf(exec);
      const limit = Math.min(Math.max(Number(args?.limit ?? 20), 1), 100);
      let lines = [];
      try { lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch { lines = []; }
      const mine = [];
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (r.ev === 'send' && r.to === me && r.ok) mine.push(r);
        } catch {}
      }
      const tail = mine.slice(-limit);
      if (tail.length === 0) return { ok: true, count: 0, text: '没有收到过 Agent 消息。' };
      const text = tail.map((m) => `[${m.at}] ${m.from} · ${m.kind}${m.hop ? ` · hop=${m.hop}` : ''}\n${m.body}`).join('\n---\n');
      return { ok: true, count: tail.length, text };
    },
  };

  const defSessions = {
    name: 'agent_sessions',
    description:
      'List conversations (sessions) with title, session id and workspace. Read-only. ' +
      'Includes sessions that are not currently running, newest first. ' +
      '`*` marks a session that has a turn in flight right now (not merely one that was ever woken). ' +
      'Use it to find the exact `to` for agent_send / dsh_wake_session.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        workspace: { type: 'string', description: 'Only workspaces whose title or path contains this text.' },
        limit: { type: 'integer', description: 'Max rows to return (default 50, max 500).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }],
    },
    async execute(args) {
      let alive = [];
      try { alive = liveRunningIds(); } catch { alive = []; }
      const running = new Set(alive);
      const { total, rows } = listSessions({ limit: args?.limit, workspace: args?.workspace });
      const now = Date.now();
      /**
       * 卡住上限（用户定：15 分钟）。
       *
       * 判定语义：`status === 'running'` 表示"有回合在跑"，但回合可能卡在等模型返回、
       * 等工具、等审批上——那种情况下它永远不结束，"运行中"就成了假话。
       * 所以再叠一层：15 分钟没有任何进展 ⇒ 标"疑似卡住"。
       */
      const STUCK_MS = 15 * 60 * 1000;
      for (const r of rows) {
        r.running = running.has(r.sessionId);
        const t = lastActivityMs(r.sessionId);
        r.lastActivity = t === undefined ? null : new Date(t).toISOString();
        r.idleMinutes = t === undefined ? null : Math.floor((now - t) / 60000);
        r.stuck = r.running && t !== undefined && now - t > STUCK_MS;
      }
      if (rows.length === 0) return { ok: true, total: 0, rows: [], text: '没有找到会话。' };
      const wsWidth = Math.max(...rows.map((r) => String(r.workspace).length), 9);
      const age = (r) => {
        if (r.idleMinutes === null) return '无记录';
        if (r.idleMinutes < 1) return '刚刚';
        if (r.idleMinutes < 60) return `${r.idleMinutes} 分钟前`;
        return `${Math.floor(r.idleMinutes / 60)} 小时前`;
      };
      const lines = rows.map((r) => {
        const mark = r.running ? '*' : ' ';
        const state = r.running
          ? (r.stuck ? `运行中·疑似卡住（${age(r)}无进展）` : `运行中（最后进展 ${age(r)}）`)
          : (r.idleMinutes !== null && r.idleMinutes <= 2 ? '已加载·空闲' : `空闲（${age(r)}无动作）`);
        return `${mark} ${r.sessionId}  ${String(r.workspace).padEnd(wsWidth)}  ${r.title || '(无标题)'}  ${state}`;
      });
      return {
        ok: true,
        total,
        rows,
        text: `${lines.join('\n')}\n\n共 ${total} 个会话，显示 ${rows.length} 个`
          + `（* = 现在有回合在跑；超过 15 分钟无进展标"疑似卡住"；空白 = 没有回合在跑）`,
      };
    },
  };

  /**
   * 群发（2026-11-12 用户要求）。
   *
   * 与 agent_send 的差别：一次解析多个目标、逐个投递、逐个回报；
   * 任何一条正文命中密钥就整次取消（不能发一半）。
   * 审计：每个目标一行，同一次调用带同一个 broadcastGroup。
   */
  const defBroadcast = {
    name: 'agent_broadcast',
    description:
      'Broadcast ONE Agent message (not a user message) to several conversations at once. ' +
      '`targets` is an array of exact session ids or unique 8-character id prefixes (a JSON-encoded array string is also accepted), or the string "all" / "running". ' +
      'Targets that are not loaded are woken first (like dsh_wake_session) and then delivered; archived conversations are skipped. ' +
      'Per-target results are returned; secrets in the text cancel the whole call. ' +
      'Max 20 targets; at most one broadcast per caller per 30 seconds. Off by default it never sends to the caller itself.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        targets: {
          description: 'Array of session ids / 8-char id prefixes (a JSON-encoded array string is also accepted), or "all" (every live session in this workspace, archived ones excluded) / "running" (only sessions with a turn in flight).',
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string' },
          ],
        },
        text: { type: 'string', description: 'Plain text, max 500 chars. No secrets.' },
        mode: {
          type: 'string', enum: ['steer', 'turn'],
          description: 'steer = read before the next step (default, for dispatch); turn = queued after the current turn.',
        },
        kind: { type: 'string', enum: [...KINDS], description: 'Default notice.' },
        includeSelf: { type: 'boolean', description: 'Also send to the caller session (default false).' },
      },
      required: ['targets', 'text'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }],
    },
    async execute(args, exec) {
      const sender = senderOf(exec);
      const kind = String(args?.kind ?? 'notice');
      const mode = args?.mode === 'turn' ? 'turn' : 'steer';
      const includeSelf = args?.includeSelf === true;
      const text = String(args?.text ?? '').trim();

      // 1) 正文校验（kind / 长度 / 密钥）——先做，命中就一条都不发
      const check = validateSend({ kind, body: text, hop: 0 });
      if (!check.ok) {
        audit({ ev: 'reject', reason: check.error, from: sender, to: 'broadcast', body: text.slice(0, 80) });
        return { ok: false, text: check.error };
      }

      // 2) 解析目标
      const ids = liveIds();
      const archived = readArchivedIds();
      let rawList;
      let excludedArchived = 0;
      if (typeof args?.targets === 'string') {
        const key = args.targets.trim().toLowerCase();
        if (key === 'all' || key === 'running') {
          // 2026-11-12 用户要求："all" 不把已归档的会话算进去（也不占 20 个名额）
          const base = key === 'all' ? ids.slice() : liveRunningIds();
          const kept = base.filter((id) => !archived.has(id));
          excludedArchived = base.length - kept.length;
          rawList = kept;
        } else if (args.targets.trim().startsWith('[')) {
          // 2026-11-12：某些调用方会把数组序列化成 JSON 字符串（实测工具参数被 stringify），
          // 这里兼容一下，否则永远走不到数组分支。
          try {
            const parsed = JSON.parse(args.targets);
            if (!Array.isArray(parsed)) return { ok: false, text: 'targets 必须是数组，或字符串 "all" / "running"' };
            rawList = parsed;
          } catch {
            return { ok: false, text: 'targets 是字符串但不是合法 JSON 数组' };
          }
        } else return { ok: false, text: 'targets 只接受数组、"all" 或 "running"' };
      } else if (Array.isArray(args?.targets)) {
        rawList = args.targets;
      } else {
        return { ok: false, text: 'targets 必须是数组，或字符串 "all" / "running"' };
      }

      const resolved = resolveBroadcastTargets(ids, rawList, { sender, includeSelf });
      if (!resolved.ok) {
        audit({ ev: 'reject', reason: resolved.error, from: sender, to: 'broadcast', body: text.slice(0, 80) });
        return { ok: false, text: resolved.error };
      }
      const plan = resolved.targets;
      if (plan.length === 0) {
        return { ok: false, text: '没有可发送的目标（自己默认被排除；要发给自己请 includeSelf=true）' };
      }

      // 3) 限流：同一调用者 30 秒内最多 1 次（放在目标确认之后，无效调用不烧配额）
      const rl = checkBroadcastRate(sender);
      if (!rl.ok) {
        audit({ ev: 'reject', reason: rl.error, from: sender, to: 'broadcast' });
        return { ok: false, text: rl.error };
      }

      // 4) 逐个投递（未加载先唤醒）+ 每个目标一行审计
      const group = randomUUID();
      const envelope = `【Agent 消息·${kind}】from ${sender}\n${text}`;
      const results = [];
      for (const item of plan) {
        if (!item.sessionId) {
          audit({
            ev: 'send', id: randomUUID(), from: sender, to: item.target, kind, hop: 0,
            ok: false, error: item.error, body: text, broadcastGroup: group,
          });
          results.push({ target: item.target, ok: false, error: item.error });
          continue;
        }
        if (archived.has(item.sessionId)) {
          audit({
            ev: 'send', id: randomUUID(), from: sender, to: item.sessionId, kind, hop: 0,
            ok: false, skipped: 'archived', error: null, body: text, broadcastGroup: group,
          });
          results.push({ target: item.sessionId, ok: false, skipped: 'archived' });
          continue;
        }
        const sent = await deliverWithWake(item.sessionId, envelope, sender, mode);
        audit({
          ev: 'send', id: randomUUID(), from: sender, to: item.sessionId, kind, hop: 0,
          ok: sent.ok, error: sent.error ?? null, via: sent.via ?? null, body: text, broadcastGroup: group,
        });
        results.push({
          target: item.sessionId,
          ok: sent.ok,
          via: sent.ok ? sent.via : null,
          mode: sent.ok ? (sent.mode || null) : null,
          error: sent.ok ? null : sent.error,
        });
      }

      const wakeOk = results.filter((r) => r.ok && r.via === 'wake').length;
      const liveOk = results.filter((r) => r.ok && r.via === 'live').length;
      const skipped = results.filter((r) => r.skipped === 'archived').length + excludedArchived;
      const failed = results.filter((r) => !r.ok && !r.skipped).length;
      const succeeded = liveOk + wakeOk;
      const lines = results.map((r) => {
        if (r.skipped === 'archived') return `○ ${r.target} 已归档，跳过`;
        if (!r.ok) return `✗ ${r.target} ${r.error}`;
        return r.via === 'wake'
          ? `✓ ${r.target} 唤醒后投递（${r.mode}）`
          : `✓ ${r.target} 已投递（${r.mode}）`;
      });
      const summary = `群发完成：成功 ${succeeded}（唤醒后 ${wakeOk}），跳过归档 ${skipped}，失败 ${failed}`
        + `（group ${group.slice(0, 8)}）\n${lines.join('\n')}`;
      return {
        ok: succeeded > 0,
        group,
        total: results.length + excludedArchived,
        succeeded,
        wokeSucceeded: wakeOk,
        skippedArchived: skipped,
        failed,
        results,
        text: summary,
      };
    },
  };

  ctx.effect(() => ctx.tools.register(defSend), 'dsh-agent-bus: agent_send');
  ctx.effect(() => ctx.tools.register(defBroadcast), 'dsh-agent-bus: agent_broadcast');
  ctx.effect(() => ctx.tools.register(defInbox), 'dsh-agent-bus: agent_inbox');
  ctx.effect(() => ctx.tools.register(defSessions), 'dsh-agent-bus: agent_sessions');
}

// ---------------------------------------------------------------------------
// 会话清单（只读）
// ---------------------------------------------------------------------------
// 目的：发消息前能看见"有谁、叫什么"，而不是只有一个 uuid。
// 数据源：DSH_HOME/sessions/<工作区目录>/<session-id>/session.v4.jsonl.zstd
//         + storages/workspace.json（工作区名与成员关系）
//         + 会话日志里的 session/title 事件（对话名，最后一条胜出）
// 全部只读；不写、不删、不改任何会话文件。

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const titleCache = new Map(); // file -> { mtimeMs, size, title }

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}
function workspaceJson() {
  return path.join(dshHome(), 'storages', 'workspace.json');
}

/**
 * 已归档的会话 id 集合。
 *
 * 权威来源：`%DSH_HOME%\storages\workspace.json` 的 `global.archivedSessionIds`
 * （DSH 把"归档"记在这里，工作区各自的 sessionIds 只表示成员关系）。
 * 读不到就当没有归档——不能因为读失败把群发弄崩。
 */
export function readArchivedIds(file = workspaceJson()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = j && j.global && Array.isArray(j.global.archivedSessionIds) ? j.global.archivedSessionIds : [];
    return new Set(list.map(String));
  } catch { return new Set(); }
}

/**
 * 解一条会话日志的全部事件。
 *
 * 会话日志是**追加写入**的，所以磁盘上是多段独立 zstd 帧，不是单帧。
 * 标准解码器（同步与流式都一样）只认第一帧，多帧会报 "Unknown frame descriptor"，
 * 于是只能解出那条头部。做法：按 magic 逐帧定位，各自解压后合并。
 * 帧长未知不影响——从帧头开始解，解码器读完自己那一帧就停。
 */
export function decodeSessionEvents(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return []; }
  const events = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    try {
      const text = zstdDecompressSync(buf.subarray(i)).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
    } catch {}
    i += ZSTD_MAGIC.length;
  }
  return events;
}

/** 折叠标题：最后一条 session/title 胜出（与 dsh-session-title 的语义一致）。 */
export function foldSessionTitle(events) {
  let title = null;
  for (const e of events) {
    if (e && e.type === 'session/title' && e.data && typeof e.data.title === 'string') title = e.data.title;
  }
  return title;
}

/** 一个文件里所有 zstd 帧的起始偏移。 */
function frameOffsets(buf) {
  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { offs.push(i); i += ZSTD_MAGIC.length; }
  return offs;
}

/** 一个帧里的全部事件；解不开返回空数组。 */
function frameEvents(buf, off) {
  let text;
  try { text = zstdDecompressSync(buf.subarray(off)).toString('utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

/**
 * 读一个会话的标题，按 (mtime, size) 缓存。
 *
 * 帧从**后往前**扫，命中第一条 session/title 即停：标题很少变，几乎总在尾部几帧里，
 * 不必把整份日志（几百帧）解完。567 个会话只解当前页，且每页只解尾部。
 */
function readTitle(file) {
  let st, buf;
  try { st = fs.statSync(file); buf = fs.readFileSync(file); } catch { return null; }
  const hit = titleCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.title;
  let title = null;
  const offs = frameOffsets(buf);
  for (let k = offs.length - 1; k >= 0; k -= 1) {
    const found = foldSessionTitle(frameEvents(buf, offs[k]));
    if (found) { title = found; break; }
  }
  titleCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, title });
  return title;
}

/** sessionId -> { workspace, workspacePath }，来自 workspace.json。 */
function readWorkspaceIndex() {
  const map = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(workspaceJson(), 'utf8'));
    const table = (j && j.tables && j.tables.workspaces) || {};
    for (const ws of Object.values(table)) {
      if (!ws) continue;
      for (const sid of ws.sessionIds || []) {
        map.set(String(sid), { workspace: ws.title || null, workspacePath: ws.path || null });
      }
    }
  } catch {}
  return map;
}

/**
 * 列出会话，按最近写入倒序。
 * @param {{limit?: number, workspace?: string}} opts
 * @returns {{total: number, rows: object[]}}
 */
export function listSessions({ limit, workspace } = {}) {
  const root = sessionsRoot();
  const known = readWorkspaceIndex();
  const rows = [];
  let wsDirs = [];
  try { wsDirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return { total: 0, rows: [] }; }
  for (const wsDir of wsDirs) {
    if (!wsDir.isDirectory()) continue;
    let subs = [];
    try { subs = fs.readdirSync(path.join(root, wsDir.name), { withFileTypes: true }); } catch { continue; }
    for (const s of subs) {
      if (!s.isDirectory() || !s.name.startsWith('session-')) continue;
      const file = path.join(root, wsDir.name, s.name, 'session.v4.jsonl.zstd');
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      const meta = known.get(s.name);
      rows.push({
        sessionId: s.name,
        file,
        mtimeMs,
        // workspace.json 里没有的会话（旧工作区/已删除工作区）退回用目录名
        workspace: (meta && meta.workspace) || wsDir.name,
        workspacePath: (meta && meta.workspacePath) || null,
      });
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const needle = String(workspace || '').trim().toLowerCase();
  const filtered = needle
    ? rows.filter((r) => String(r.workspace).toLowerCase().includes(needle)
        || String(r.workspacePath || '').toLowerCase().includes(needle))
    : rows;
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const page = filtered.slice(0, n);
  for (const r of page) {
    r.title = readTitle(r.file);
    delete r.file;
    delete r.mtimeMs;
  }
  return { total: filtered.length, rows: page };
}

function senderOf(exec) {
  try { if (exec?.agent?.id) return String(exec.agent.id); } catch {}
  try { if (exec?.sessionId) return String(exec.sessionId); } catch {}
  return 'unknown';
}
