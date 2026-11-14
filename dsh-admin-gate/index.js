/**
 * dsh-admin-gate v0.1 —— 管理员权限闸门（第一期）
 * ================================================================
 * 本期只做三件事（其余权限项留位，见 PERMISSIONS 的 reserved）：
 *   1. 状态层：%DSH_HOME%\pm\state.json（原子写 tmp→rename）+ audit.jsonl（append-only）
 *   2. 表驱动权限项：admin.query / admin.grant 两项开关
 *   3. 三个工具：pm_who（所有人可调）/ pm_grant / pm_revoke（用户或管理员）
 *
 * 设计文档：DeepSeekCode/docs/管理员权限插件设计.md
 *
 * 关键约定：
 *  - 调用者身份只认 exec.agent.id，不接受自报；
 *  - 「用户」= 该会话最近一条 user/message 的 source.kind === 'user'；
 *  - 读-改-写全部走 withLock 串行，写盘先审计后状态；
 *  - 任何写操作都留审计（谁 / 何时 / 依据 / 结果）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gate from './lib/gate.js';

export const name = '@local/dsh-admin-gate';
// webServer 是可选依赖：有 Web 宿主时才注册路由；没有时仍可用三个工具。
export const inject = { tools: { required: true }, webServer: { required: false } };

// ── 常量 ────────────────────────────────────────────────────────────────

/** PicoMode：授权者。只有用户能撤销它。 */
const AUTHORIZER = 'session-b1774d91-62e0-47e0-aa6a-b98c406ad7f1';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PM_DIR = path.join(DSH_HOME, 'pm');
const STATE_FILE = path.join(PM_DIR, 'state.json');
const AUDIT_FILE = path.join(PM_DIR, 'audit.jsonl');
const RECENT_MAX = 200;
/** 插件自己的诊断日志（%TEMP%），apply 与路由注册的结果都写这里。 */
const LOG_FILE = path.join(os.tmpdir(), 'dsh-admin-gate.log');
function log(message) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8'); } catch { /* 日志失败不影响主流程 */ }
}
/** 判定「用户在场」的时间窗：最近一次真人发言若在 30 分钟内，则本会话可视为用户。 */
const HUMAN_WINDOW_MS = 30 * 60 * 1000;

// ── 状态层 ──────────────────────────────────────────────────────────────

function emptyState() {
  return {
    version: 1,
    updatedAt: null,
    admins: [],          // [{ sessionId, title, grantedBy, grantedAt, basis, bootstrap? }]
    permissions: {},     // { 'admin.query': true, ... }
    auditSeq: 0,
    auditRecent: [],     // 与 audit.jsonl 同构，保留最近 RECENT_MAX 条
    restart: null,       // ⑤⑥ 期再用
    bootstrapUsed: false, // 一次性初始化是否已用掉
  };
}

function ensureDir() {
  try { fs.mkdirSync(PM_DIR, { recursive: true }); } catch { /* 写盘时会暴露 */ }
}

function readState() {
  ensureDir();
  let raw;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return emptyState(); }
  try {
    const parsed = JSON.parse(raw);
    return {
      ...emptyState(),
      ...parsed,
      admins: Array.isArray(parsed.admins) ? parsed.admins : [],
      permissions: parsed.permissions && typeof parsed.permissions === 'object' ? parsed.permissions : {},
      auditRecent: Array.isArray(parsed.auditRecent) ? parsed.auditRecent : [],
    };
  } catch {
    // 损坏 → 留证，不覆盖；按空状态启动
    const broken = `${STATE_FILE}.broken-${Date.now()}`;
    try { fs.renameSync(STATE_FILE, broken); } catch { /* ignore */ }
    return { ...emptyState(), corruptAt: broken };
  }
}

function writeState(next) {
  ensureDir();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function appendAudit(record) {
  try {
    ensureDir();
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, 'utf8');
  } catch { /* 审计失败不阻塞主流程 */ }
}

let lockChain = Promise.resolve();

/** 进程内单飞锁：所有读-改-写排队。 */
function withLock(task) {
  const run = lockChain.then(task, task);
  lockChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 一次带审计的原子变更。
 * @param mutator (state) => { state?, audit }
 */
function commit(mutator) {
  return withLock(() => {
    const st = readState();
    const out = mutator(st) || {};
    const next = out.state || st;
    const seq = (Number(next.auditSeq) || 0) + 1;
    const audit = { seq, at: new Date().toISOString(), ...(out.audit || {}) };
    next.auditSeq = seq;
    next.auditRecent = [...(next.auditRecent || []), audit].slice(-RECENT_MAX);
    next.updatedAt = audit.at;
    appendAudit(audit);
    writeState(next);
    return { state: next, audit, reply: out.reply };
  });
}

// ── 身份判定 ────────────────────────────────────────────────────────────

/** 该会话最近一条 user/message 是谁发的。 */
function humanEvidence(ctx, sessionId) {
  try {
    const sessions = ctx.get ? ctx.get('sessions') : undefined;
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
    if (!session) return { known: false, human: false, kind: undefined };
    let events = [];
    try {
      if (typeof session.ownEvents === 'function') events = session.ownEvents() || [];
      else if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents() || [];
    } catch { events = []; }
    // 从新往旧找第一条真人（source.kind === 'user'）发言；agent-message 不算。
    // 只看"最近一条消息"会把「真人刚说完、agent 消息随后到」误判成机器人，故按时间窗判定。
    let lastKind;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (!e || e.type !== 'user/message') continue;
      const kind = e.data && e.data.source ? e.data.source.kind : undefined;
      if (lastKind === undefined) lastKind = kind;
      if (kind === 'user') {
        const at = Number(e.time) || 0;
        const fresh = at === 0 ? true : Date.now() - at <= HUMAN_WINDOW_MS;
        return { known: true, human: fresh, kind: lastKind, at };
      }
    }
    return { known: true, human: false, kind: lastKind };
  } catch {
    return { known: false, human: false, kind: undefined };
  }
}

function resolveRole(ctx, state, sessionId) {
  const isAdmin = (state.admins || []).some((a) => a && a.sessionId === sessionId);
  const ev = humanEvidence(ctx, sessionId);
  const isHuman = ev.human === true;
  return {
    sessionId,
    isAdmin,
    isHuman,
    kind: isAdmin ? (isHuman ? 'user+admin' : 'admin') : (isHuman ? 'user' : 'agent'),
  };
}

function scopeAllows(scopes, role) {
  if (scopes.includes('all')) return true;
  if (scopes.includes('user') && role.isHuman) return true;
  if (scopes.includes('admin') && role.isAdmin) return true;
  return false;
}

function permissionEnabled(state, id, fallback) {
  const v = (state.permissions || {})[id];
  return typeof v === 'boolean' ? v : fallback;
}

// ── 权限项表（表驱动：加一项 = 加一行） ─────────────────────────────────

const renderText = (v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }];

const output = (schema) => ({ schema: schema || { type: 'object', additionalProperties: true }, render: (_a, v) => renderText(v) });

/**
 * 一次性初始化（bootstrap）：否则第一个管理员永远任命不出来。
 * 条件：从未用过 bootstrap、当前管理员为空、且**只能授予调用者自己**。
 * 一旦用过（state.bootstrapUsed）或已有管理员，立刻失效。
 */
function bootstrapApplies(state, toolName, actor, args) {
  if (toolName !== 'pm_grant') return false;
  if (state.bootstrapUsed === true) return false;
  if ((state.admins || []).length > 0) return false;
  const target = normalizeSessionId(args && args.sessionId);
  return target !== null && target === actor;
}

/** 通用执行包装：开关 → 身份 → 处理器。 */
function tool(perm, overrides) {
  return {
    name: overrides.name,
    description: overrides.description,
    parameters: overrides.parameters,
    output: output(),
    async execute(args, exec) {
      const actor = String((exec && exec.agent && exec.agent.id) || '');
      if (!actor) return { ok: false, text: '拿不到调用者会话 id，拒绝执行' };
      const state = readState();
      if (!permissionEnabled(state, perm.id, perm.defaultEnabled)) {
        return { ok: false, permission: perm.id, text: `权限项 ${perm.id} 已关闭（可在 state.json 的 permissions 中开启）` };
      }
      const role = resolveRole(exec && exec.ctx ? exec.ctx : {}, state, actor);
      const bootstrap = bootstrapApplies(state, overrides.name, actor, args || {});
      if (!bootstrap && !scopeAllows(perm.scopes, role)) {
        return {
          ok: false,
          permission: perm.id,
          text: `无权限：${perm.id} 需要 ${perm.scopes.join(' 或 ')} 身份，调用者 ${actor} 当前是 ${role.kind}`,
        };
      }
      return overrides.run({ args: args || {}, actor, role, state, bootstrap });
    },
  };
}

const PERMISSIONS = [
  {
    id: 'admin.query',
    title: '查询当前管理员',
    scopes: ['all'],
    defaultEnabled: true,
    tools: [
      {
        name: 'pm_who',
        description: 'List the current administrators and permission switches. Callable by any agent (read-only).',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        async run({ actor, role, state }) {
          const admins = state.admins || [];
          const lines = admins.length
            ? admins.map((a) => `- ${a.sessionId}${a.title ? '（' + a.title + '）' : ''}${a.bootstrap ? '（bootstrap 初始化）' : ''} 由 ${a.basis || '?'} 于 ${a.grantedAt || '?'} 任命`).join('\n')
            : '（暂无管理员）';
          return {
            ok: true,
            admins,
            permissions: state.permissions || {},
            caller: { sessionId: actor, role: role.kind },
            text: `当前管理员 ${admins.length} 人：\n${lines}\n调用者：${actor}（${role.kind}）`,
          };
        },
      },
    ],
  },
  {
    id: 'admin.grant',
    title: '任命 / 撤销管理员',
    scopes: ['user', 'admin'],
    defaultEnabled: true,
    tools: [
      {
        name: 'pm_grant',
        description: 'Grant administrator to one session. Callable by the user or an existing administrator; writes an audit record.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', description: 'Target session id (session-<uuid> or bare uuid).' },
            title: { type: 'string', description: 'Optional human-readable label.' },
          },
          required: ['sessionId'],
        },
        async run({ args, actor, role, bootstrap }) {
          const target = normalizeSessionId(args.sessionId);
          if (!target) return { ok: false, text: 'sessionId 不合法（需要 session-<uuid> 或裸 uuid）' };
          const basis = bootstrap ? 'bootstrap' : (role.isHuman ? 'user' : `admin:${actor}`);
          return grantAdmin({ actor, basis, target, title: args.title, bootstrap });
        },
      },
      {
        name: 'pm_revoke',
        description: 'Revoke administrator from one session. Callable by the user or an existing administrator; PicoMode can only be revoked by the user.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', description: 'Target session id.' },
          },
          required: ['sessionId'],
        },
        async run({ args, actor, role }) {
          const target = normalizeSessionId(args.sessionId);
          if (!target) return { ok: false, text: 'sessionId 不合法' };
          if (target === AUTHORIZER && !role.isHuman) {
            return { ok: false, text: 'PicoMode 只能由用户撤销，管理员之间不能互撤它' };
          }
          const basis = role.isHuman ? 'user' : `admin:${actor}`;
          return revokeAdmin({ actor, basis, target });
        },
      },
    ],
  },
];

// ── 操作核心（工具与 GUI 共用同一份逻辑，不写两套） ──────────────────────

/** 权限项清单：已实现 + 预留（预留项默认关，UI 只读展示）。 */
const PERMISSION_LIST = [
  ...PERMISSIONS.map((p) => ({ id: p.id, title: p.title, defaultEnabled: p.defaultEnabled, implemented: true })),
  { id: 'session.pause', title: '暂停同工作目录会话', defaultEnabled: false, implemented: false },
  { id: 'session.create', title: '新建对话', defaultEnabled: false, implemented: false },
  { id: 'model.set', title: '改思考等级 / 模型', defaultEnabled: false, implemented: false },
  { id: 'dsh.restart', title: '重启 DSH', defaultEnabled: false, implemented: false },
];

async function grantAdmin({ actor, basis, target, title, bootstrap = false }) {
  const result = await commit((st) => {
    const exists = (st.admins || []).find((a) => a && a.sessionId === target);
    if (exists) {
      return {
        state: st,
        audit: { actor, permission: 'admin.grant', action: 'grant', target, basis, decision: 'allow', result: 'noop', detail: { reason: 'already-admin' } },
        reply: { already: true },
      };
    }
    const admin = { sessionId: target, title: String(title || ''), grantedBy: actor, grantedAt: new Date().toISOString(), basis, ...(bootstrap ? { bootstrap: true } : {}) };
    return {
      state: { ...st, admins: [...(st.admins || []), admin], bootstrapUsed: true },
      audit: { actor, permission: 'admin.grant', action: 'grant', target, basis, decision: 'allow', result: 'ok', detail: { title: admin.title } },
      reply: { already: false },
    };
  });
  const already = !!(result.reply && result.reply.already);
  return {
    ok: true,
    granted: !already,
    admins: result.state.admins,
    seq: result.audit.seq,
    text: already
      ? `${target} 早就是管理员，未重复添加（审计 seq=${result.audit.seq}）`
      : `已任命 ${target} 为管理员（依据 ${basis}，审计 seq=${result.audit.seq}）`,
  };
}

async function revokeAdmin({ actor, basis, target }) {
  const result = await commit((st) => {
    const exists = (st.admins || []).some((a) => a && a.sessionId === target);
    if (!exists) {
      return {
        state: st,
        audit: { actor, permission: 'admin.grant', action: 'revoke', target, basis, decision: 'allow', result: 'rejected:not-admin' },
      };
    }
    return {
      state: { ...st, admins: (st.admins || []).filter((a) => a && a.sessionId !== target) },
      audit: { actor, permission: 'admin.grant', action: 'revoke', target, basis, decision: 'allow', result: 'ok' },
    };
  });
  const removed = result.audit.result === 'ok';
  return {
    ok: removed,
    revoked: removed,
    admins: result.state.admins,
    seq: result.audit.seq,
    text: removed
      ? `已撤销 ${target} 的管理员（依据 ${basis}，审计 seq=${result.audit.seq}）`
      : `${target} 不是管理员，未做改动（审计 seq=${result.audit.seq}）`,
  };
}

async function setPermission({ actor, id, on }) {
  if (!PERMISSION_LIST.some((p) => p.id === id)) return { ok: false, error: 'unknown-permission' };
  const result = await commit((st) => ({
    state: { ...st, permissions: { ...(st.permissions || {}), [id]: on === true } },
    audit: { actor, permission: id, action: 'permission', target: id, basis: 'user', decision: on === true ? 'allow' : 'deny', result: 'ok' },
  }));
  return { ok: true, permissions: result.state.permissions, seq: result.audit.seq };
}

/** GUI 读取的快照。 */
function stateView() {
  const st = readState();
  const permissions = {};
  for (const p of PERMISSION_LIST) permissions[p.id] = permissionEnabled(st, p.id, p.defaultEnabled);
  return {
    admins: st.admins || [],
    permissions,
    audit: (st.auditRecent || []).slice(-10),
    bootstrapUsed: st.bootstrapUsed === true,
  };
}

// ── GUI 的 HTTP 桥（客户端没有 host.call，用同源 fetch） ─────────────────

function jsonReply(res, code, value) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/**
 * 面板请求按「用户本人」处理：浏览器里的点击就是用户的操作。
 * 动作仍走 grantAdmin / revokeAdmin / setPermission 这一份逻辑，审计照写。
 *
 * 路径挂在插件自己的前缀下（/.dsh-admin-gate/…）：/api 是 DSH 保留的 RPC 前缀，
 * 插件路由注册在 /api 下不会被命中（2026-11-11 独立实例实测 404）。
 */
async function handleHttpRequest(req, res) {
  const actor = 'gui:user';
  const url = new URL(req.url || '/.dsh-admin-gate/state', 'http://127.0.0.1');
  const action = (url.pathname.replace(/^\/\.dsh-admin-gate\/?/, '').replace(/\/+$/, '') || 'state');
  try {
    if (req.method === 'GET' && action === 'state') {
      jsonReply(res, 200, { ok: true, ...stateView() });
      return;
    }
    if (req.method !== 'POST') { jsonReply(res, 405, { ok: false, error: 'method-not-allowed' }); return; }

    const body = await readRequestBody(req);
    const act = body.action || action;

    if (act === 'grant' || act === 'revoke') {
      const target = normalizeSessionId(body.sessionId);
      if (!target) { jsonReply(res, 400, { ok: false, error: 'bad-session-id' }); return; }
      const r = act === 'grant'
        ? await grantAdmin({ actor, basis: 'user', target, title: body.title })
        : await revokeAdmin({ actor, basis: 'user', target });
      jsonReply(res, 200, { ...r, state: stateView() });
      return;
    }
    if (act === 'permission') {
      const r = await setPermission({ actor, id: String(body.id || ''), on: body.on === true });
      jsonReply(res, r.ok ? 200 : 400, { ...r, state: stateView() });
      return;
    }
    jsonReply(res, 400, { ok: false, error: 'unknown-action' });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ── 工具函数 ────────────────────────────────────────────────────────────

function normalizeSessionId(input) {
  const raw = String(input || '').trim();
  if (/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return `session-${raw.toLowerCase()}`;
  return null;
}

// ── 插件主体 ────────────────────────────────────────────────────────────

export function apply(ctx) {
  ensureDir();
  log('apply: enter');

  const registered = [];
  for (const perm of PERMISSIONS) {
    for (const t of perm.tools) {
      const def = tool(perm, t);
      ctx.effect(() => ctx.tools.register(def), `dsh-admin-gate: ${t.name}`);
      registered.push(t.name);
    }
  }
  log(`apply: tools registered = ${registered.join(',')}`);

  // ── 危险操作闸门（P1）────────────────────────────────────────────
  const approverOf = (st) => (st && st.approver) || gate.DEFAULT_APPROVER;

  const relay = (ctxArg, toId, body, senderId) => {
    try {
      const agents = ctxArg.get ? ctxArg.get('agents') : undefined;
      let agent = agents && typeof agents.get === 'function' ? agents.get(toId) : undefined;
      if (!agent && agents && typeof agents.list === 'function') {
        const bare = String(toId).replace(/^session-/, '');
        agent = (agents.list() || []).find((a) => a && String(a.id).replace(/^session-/, '') === bare);
      }
      const msg = {
        id: `pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: senderId },
      };
      if (agent && typeof agent.followup === 'function') { agent.followup(msg); return true; }
      const sc = ctxArg.get ? ctxArg.get('sessionController') : undefined;
      if (sc && typeof sc.resolveAgent === 'function') {
        Promise.resolve(sc.resolveAgent(toId)).then((r) => {
          const a = r && r.agent;
          if (a && typeof a.followup === 'function') a.followup(msg);
        }).catch(() => {});
        return true;
      }
    } catch { /* 投递失败不回滚请求，状态可查 */ }
    return false;
  };

  const gateToolDef = (name, description, parameters, run) => ({
    name,
    description,
    parameters,
    output: output(),
    async execute(args, exec) {
      const actor = String((exec && exec.agent && exec.agent.id) || '');
      if (!actor) return { ok: false, text: '拿不到调用者会话 id' };
      const st = readState();
      const ctxArg = exec && exec.ctx ? exec.ctx : { get: () => undefined };
      const role = resolveRole(ctxArg, st, actor);
      role.isApprover = actor === approverOf(st);
      return run({ args: args || {}, actor, role, state: st, ctxArg });
    },
  });

  const defRequest = gateToolDef(
    'gate_request',
    'Request approval for one dangerous operation. Writes the ledger and notifies the approver; the returned id is used as gate_ok:<id>.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: { type: 'string', description: 'Operation name, e.g. shell.destructive / dsh.restart / admin.grant.' },
        reason: { type: 'string', description: 'Why this is needed (audited).' },
        target: { type: 'string', description: 'Optional target (session id, path, host).' },
        diff: { type: 'string', description: 'Optional diff text; only its sha256 and first 200 bytes are stored.' },
        timeoutMinutes: { type: 'number', description: 'Shorter timeout, 1-10 minutes (cannot extend).' },
      },
      required: ['op', 'reason'],
    },
    async ({ args, actor, role, state, ctxArg }) => {
      const op = String(args.op || '').trim();
      if (!op) return { ok: false, text: 'op 不能为空' };
      const approver = approverOf(state);

      if (role.isHuman) {
        const r = gate.request({ actor, op, reason: args.reason, target: args.target, diff: args.diff, timeoutMinutes: args.timeoutMinutes, approver });
        if (r.ok && r.id) gate.decide({ id: r.id, decision: 'approve', decider: 'user', reason: '用户直接放行' });
        return { ok: true, id: r.id, status: 'approved', text: `用户直接放行（${op}）` };
      }

      if (!approver) return { ok: false, status: 'denied', text: '没有可用的审批人，直接拒绝' };

      const r = gate.request({ actor, op, reason: args.reason, target: args.target, diff: args.diff, timeoutMinutes: args.timeoutMinutes, approver });
      if (!r.ok) return { ok: false, status: r.status, text: r.text };
      if (!r.deduped) {
        relay(ctxArg, approver, `【危险操作待批】${op}\n发起：${actor}\n理由：${args.reason}\nid：${r.id}\n批准：gate_decide({id:"${r.id}",decision:"approve"})；拒绝用 deny。超时 ${gate.normalizeTimeout(args.timeoutMinutes)} 分钟默认拒绝。`, actor);
      }
      return { ok: true, id: r.id, status: r.status, expiresAt: r.expiresAt, text: r.text };
    },
  );

  const defDecide = gateToolDef(
    'gate_decide',
    'Approve or deny one pending dangerous-operation request. Only the configured approver or the user may decide.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Pending request id.' },
        decision: { type: 'string', enum: ['approve', 'deny'], description: 'approve or deny.' },
        reason: { type: 'string', description: 'Optional reason (audited).' },
      },
      required: ['id', 'decision'],
    },
    async ({ args, actor, role, state }) => {
      const id = String(args.id || '');
      const decision = String(args.decision || '');
      if (decision !== 'approve' && decision !== 'deny') return { ok: false, text: 'decision 只能是 approve 或 deny' };
      if (!role.isHuman && !role.isApprover) {
        return { ok: false, text: `无权限：只有权限管理员（${approverOf(state)}）或用户能审批` };
      }
      const pending = gate.readPending()[id];
      if (!pending) return { ok: false, text: `没有这个请求：${id}` };
      if (!role.isHuman && pending.actor === actor) {
        return { ok: false, text: '审批人不能批准自己发起的操作：请交用户审批' };
      }
      const r = gate.decide({ id, decision, decider: role.isHuman ? 'user' : actor, reason: args.reason });
      return { ok: r.ok, status: r.status, text: r.text };
    },
  );

  const defStatus = gateToolDef(
    'gate_status',
    'Show one pending request (or all pending plus the last 10 ledger lines).',
    {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'Optional request id.' } },
    },
    async ({ args }) => {
      if (args.id) {
        const e = gate.statusOf(String(args.id));
        return e
          ? { ok: true, request: e, text: `${e.id} ${e.op} status=${e.status} expiresAt=${e.expiresAt}` }
          : { ok: false, text: `没有这个请求：${args.id}` };
      }
      const pending = gate.statusOf();
      const tail = gate.readLedgerTail(10);
      return { ok: true, pending, ledger: tail, text: `待批 ${pending.length} 条；台账最近 ${tail.length} 行` };
    },
  );

  for (const def of [defRequest, defDecide, defStatus]) {
    ctx.effect(() => ctx.tools.register(def), `dsh-admin-gate: ${def.name}`);
  }
  log('apply: gate tools registered = gate_request,gate_decide,gate_status');

  // 工具执行前硬拦：危险操作没有有效 gate_ok 就拒绝
  try {
    ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
      const op = gate.classifyOp(exec && exec.name, exec && exec.arguments);
      if (!op) return next();
      const agentId = String((exec && exec.agent && exec.agent.id) || '');
      const token = gate.extractToken(exec && exec.arguments);
      const verdict = gate.authorizationFor({ agentId, op, token });
      if (!verdict.ok) return { kind: 'deny', reason: verdict.reason };
      gate.consume(verdict.id);
      return next();
    }), 'dsh-admin-gate: pre-execute gate');
    log('apply: pre-execute gate installed');
  } catch (err) {
    log(`apply: pre-execute gate THREW ${err && err.message ? err.message : String(err)}`);
  }

  // 超时默认拒绝：每 30 秒扫一次
  try {
    const timer = setInterval(() => { try { gate.sweepExpired(); } catch { /* ignore */ } }, 30_000);
    if (timer.unref) timer.unref();
    ctx.effect(() => () => clearInterval(timer), 'dsh-admin-gate: gate sweeper');
    log('apply: gate sweeper started');
  } catch (err) {
    log(`apply: sweeper THREW ${err && err.message ? err.message : String(err)}`);
  }

  // GUI 的数据/动作入口（浏览器同源 fetch）
  const webServer = ctx.get ? ctx.get('webServer') : undefined;
  if (!webServer || typeof webServer.register !== 'function') {
    log('apply: webServer 不存在或不可用 -> 路由未注册（工具仍可用）');
  } else {
    try {
      ctx.effect(() => {
        const dispose = webServer.register({ kind: 'prefix', path: '/.dsh-admin-gate', handler: handleHttpRequest });
        log(`apply: route registered -> /.dsh-admin-gate, disposer=${typeof dispose}`);
        return typeof dispose === 'function' ? dispose : () => {};
      }, 'dsh-admin-gate: gui route');
    } catch (err) {
      log(`apply: route register THREW ${err && err.message ? err.message : String(err)}`);
    }
  }
}

/** 供自测/外部复用（不依赖 ctx）。 */
export const _internals = { PERMISSIONS, readState, writeState, PM_DIR, STATE_FILE, AUDIT_FILE, normalizeSessionId, AUTHORIZER };
