/**
 * dsh-working-state v0.1 —— 工作模式（全局区） + 会话角色（会话区）
 * ================================================================
 * 背景：用户会离开电脑（睡觉/上班）或用微信远程指挥。同一个会话池里，
 * 有人是监督者、有人是干活的工人、有人只是来问一句的路人。
 * 本插件把这两件事显式存下来，让每个 agent 都能问一句"我现在在哪、我是谁"。
 *
 * 两区：
 *   全局区  current mode ∈ { local(用户本地监督) , wechat(微信远程) , away(离开/睡觉) }
 *           存 %DSH_HOME%\working-state.json
 *   会话区  每个会话一条：{ role: manager|worker|other, setBy, at, public }
 *
 * 四个工具：
 *   ws_get   任何 agent：读全局模式 + 本会话角色
 *   ws_set   管理员或用户：改全局模式
 *   ws_tag   管理员：给某会话打角色
 *   ws_list  管理员看全部；worker 只看公开的；other 只看自己
 *
 * 与现有实现对齐（不自己编）：
 *   · 会话身份只认 exec.agent.id（跟着 dsh-admin-gate 的规矩：不接受自报）；
 *   · 管理员名单来自 %DSH_HOME%\pm\state.json 的 admins[]（dsh-admin-gate 的状态文件，只读借用）；
 *   · "用户在场"沿用 dsh-admin-gate 的判定：该会话最近一条 user/message 的
 *     source.kind === 'user' 且在 30 分钟内；
 *   · 会话清单优先用 sessionController.list()（SessionSummary.sessionId），
 *     拿不到就退回本地记录 —— 不猜字段、不虚构会话。
 *
 * 写盘：tmp → rename（原子），并全程走进程内单飞锁，避免并发写丢记录。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = '@local/dsh-working-state';
export const inject = { tools: { required: true } };

// ── 常量 ────────────────────────────────────────────────────────────────

export const MODES = ['local', 'wechat', 'away'];
export const ROLES = ['manager', 'worker', 'other'];

/** 默认工作模式：用户在本地盯着（最保守的默认）。 */
export const DEFAULT_MODE = 'local';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
/** 状态文件；测试用 DSH_WORKING_STATE_FILE 指到临时文件，绝不碰真实状态。 */
const STATE_FILE = process.env.DSH_WORKING_STATE_FILE || path.join(DSH_HOME, 'working-state.json');
/** 只读借用 admin-gate 的管理员名单。 */
const PM_STATE_FILE = path.join(DSH_HOME, 'pm', 'state.json');
const LOG_FILE = path.join(os.tmpdir(), 'dsh-working-state.log');
/** 与 dsh-admin-gate 一致：真人发言 30 分钟内算"用户在场"。 */
const HUMAN_WINDOW_MS = 30 * 60 * 1000;

function log(message) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

// ── 状态层 ──────────────────────────────────────────────────────────────

export function emptyState() {
  return {
    version: 1,
    updatedAt: null,
    /** 全局区：当前工作模式。 */
    mode: DEFAULT_MODE,
    modeSetBy: null,     // { sessionId, at }
    /** 会话区：sessionId → { role, setBy, at, public } */
    sessions: {},
    rev: 0,
  };
}

function ensureDir() {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch { /* 写盘时暴露 */ }
}

/** 读状态；文件坏了不覆盖，改名留证并按默认启动。 */
export function readState() {
  ensureDir();
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw);
    const mode = MODES.includes(parsed.mode) ? parsed.mode : DEFAULT_MODE;
    const sessions = {};
    if (parsed.sessions && typeof parsed.sessions === 'object') {
      for (const [sid, value] of Object.entries(parsed.sessions)) {
        if (!value || typeof value !== 'object') continue;
        if (!ROLES.includes(value.role)) continue;
        sessions[sid] = {
          role: value.role,
          setBy: typeof value.setBy === 'string' ? value.setBy : null,
          at: typeof value.at === 'string' ? value.at : null,
          public: value.public === true,
        };
      }
    }
    return { ...emptyState(), ...parsed, mode, sessions, rev: Number(parsed.rev) || 0 };
  } catch {
    const broken = `${STATE_FILE}.broken-${Date.now()}`;
    try { fs.renameSync(STATE_FILE, broken); } catch { /* ignore */ }
    return { ...emptyState(), corruptAt: broken };
  }
}

/** 原子写：先写 .tmp 再 rename，读的人永远看不到半截 JSON。 */
export function writeState(next) {
  ensureDir();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

let lockChain = Promise.resolve();

/** 进程内单飞锁：所有"读-改-写"排队，专治并发写丢记录。 */
export function withLock(task) {
  const run = lockChain.then(task, task);
  lockChain = run.then(() => undefined, () => undefined);
  return run;
}

/** 一次带版本号推进的变更。mutator(state) 返回新 state（或就地改）。 */
export function commit(mutator) {
  return withLock(() => {
    const st = readState();
    const next = mutator(st) || st;
    next.rev = (Number(next.rev) || 0) + 1;
    next.updatedAt = new Date().toISOString();
    writeState(next);
    return next;
  });
}

// ── 身份判定（与 dsh-admin-gate 对齐，不重新发明） ──────────────────────

/** 只读借用 admin-gate 的管理员名单。 */
export function readAdmins() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PM_STATE_FILE, 'utf8'));
    return Array.isArray(parsed.admins) ? parsed.admins.filter((a) => a && typeof a.sessionId === 'string') : [];
  } catch {
    return [];
  }
}

export function isAdminSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  return readAdmins().some((a) => a.sessionId === sessionId);
}

/** 该会话最近一条 user/message 是不是真人发的、且在时间窗内。 */
export function humanEvidence(ctx, sessionId) {
  try {
    const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
    if (!session) return { known: false, human: false };
    let events = [];
    try {
      if (typeof session.ownEvents === 'function') events = session.ownEvents() || [];
      else if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents() || [];
    } catch { events = []; }
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (!e || e.type !== 'user/message') continue;
      const kind = e.data && e.data.source ? e.data.source.kind : undefined;
      if (kind !== 'user') return { known: true, human: false };
      const at = Number(e.time) || 0;
      const fresh = at === 0 ? true : Date.now() - at <= HUMAN_WINDOW_MS;
      return { known: true, human: fresh, at };
    }
    return { known: true, human: false };
  } catch {
    return { known: false, human: false };
  }
}

/** 调用者的完整身份：是不是管理员、是不是用户本人、手里的角色。 */
export function resolveCaller(ctx, state, sessionId) {
  const isAdmin = isAdminSession(sessionId);
  const isHuman = humanEvidence(ctx, sessionId).human === true;
  const record = state && state.sessions ? state.sessions[sessionId] : undefined;
  const role = record && ROLES.includes(record.role) ? record.role : 'other';
  return { sessionId, isAdmin, isHuman, role, kind: isAdmin ? 'admin' : (isHuman ? 'user' : role) };
}

/** 能否改全局模式：管理员或用户本人（需求原话"仅管理员或用户"）。 */
export function canSetMode(caller) {
  return caller.isAdmin === true || caller.isHuman === true;
}

/** 能否打角色：管理员（需求原话"（管理员）"）。 */
export function canTagRole(caller) {
  return caller.isAdmin === true;
}

// ── 可见性（ws_list 的三种视角） ────────────────────────────────────────

/**
 * 按调用者身份裁剪会话记录：
 *   管理员 → 全部；worker → 只公开的 + 自己；other → 只看自己。
 */
export function visibleSessions(state, caller, listSessions) {
  const sessions = state && state.sessions ? state.sessions : {};
  const ids = new Set(Object.keys(sessions));
  // 会话清单以 sessionController.list() 为准（真实会话 id），本地记录补上还没打角色的。
  if (Array.isArray(listSessions)) {
    for (const id of listSessions) if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  const rows = [];
  for (const sessionId of ids) {
    const record = sessions[sessionId];
    const isSelf = sessionId === caller.sessionId;
    if (caller.isAdmin) {
      rows.push({ sessionId, role: record ? record.role : null, public: record ? record.public === true : null, isSelf, setBy: record ? record.setBy : null, at: record ? record.at : null });
      continue;
    }
    if (!isSelf) {
      const visible = record && record.public === true && caller.role === 'worker';
      if (!visible) continue;
    }
    rows.push({ sessionId, role: record ? record.role : null, public: record ? record.public === true : null, isSelf, setBy: record ? record.setBy : null, at: record ? record.at : null });
  }
  rows.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return rows;
}

// ── 工具 ────────────────────────────────────────────────────────────────

const renderText = (v) => [{ type: 'text', text: typeof (v && v.text) === 'string' ? v.text : JSON.stringify(v) }];
const output = (schema) => ({ schema: schema || { type: 'object', additionalProperties: true }, render: (_a, v) => renderText(v) });

function normalizeSessionId(input) {
  const raw = String(input || '').trim();
  if (/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return `session-${raw.toLowerCase()}`;
  return null;
}

/** 尽量从 sessionController 取真实会话 id；拿不到就返回 []（不虚构）。 */
async function listSessionIds(ctx) {
  try {
    const controller = ctx && typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined;
    if (!controller || typeof controller.list !== 'function') return [];
    const value = await controller.list({}, undefined);
    const items = value && Array.isArray(value.items) ? value.items : [];
    return items.map((i) => String(i && i.sessionId ? i.sessionId : '')).filter(Boolean);
  } catch {
    return [];
  }
}

function modeLine(state) {
  return `工作模式 ${state.mode}` + (state.modeSetBy && state.modeSetBy.sessionId ? `（由 ${state.modeSetBy.sessionId} 于 ${state.modeSetBy.at || '?'} 设置）` : '（默认）');
}

const TOOLS = [
  {
    name: 'ws_get',
    description: 'Read the global working mode and this session\'s role. Callable by any agent.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: output(),
    async execute(_args, exec) {
      const actor = String((exec && exec.agent && exec.agent.id) || '');
      if (!actor) return { ok: false, text: '拿不到调用者会话 id，拒绝执行' };
      const state = readState();
      const caller = resolveCaller(exec && exec.ctx ? exec.ctx : {}, state, actor);
      const text = [
        modeLine(state),
        `本会话 ${actor}：角色 ${caller.role}（${caller.kind}）`,
        `可用模式：${MODES.join(' / ')}`,
      ].join('\n');
      return { ok: true, mode: state.mode, sessionId: actor, role: caller.role, caller: { isAdmin: caller.isAdmin, isHuman: caller.isHuman }, text };
    },
  },
  {
    name: 'ws_set',
    description: 'Set the global working mode (local | wechat | away). Callable by an administrator or the user; writes atomically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: MODES, description: 'local = 用户在本地监督；wechat = 微信远程；away = 离开/睡觉' },
      },
      required: ['mode'],
    },
    output: output(),
    async execute(args, exec) {
      const actor = String((exec && exec.agent && exec.agent.id) || '');
      if (!actor) return { ok: false, text: '拿不到调用者会话 id，拒绝执行' };
      const mode = String((args && args.mode) || '');
      if (!MODES.includes(mode)) return { ok: false, text: `模式只能是 ${MODES.join(' / ')}，收到 "${mode}"` };
      const before = readState();
      const caller = resolveCaller(exec && exec.ctx ? exec.ctx : {}, before, actor);
      if (!canSetMode(caller)) {
        return { ok: false, text: `无权限：改工作模式需要管理员或用户本人，调用者 ${actor} 当前是 ${caller.kind}` };
      }
      const at = new Date().toISOString();
      const next = await commit((st) => ({ ...st, mode, modeSetBy: { sessionId: actor, at } }));
      log(`ws_set ${actor} ${caller.kind}: ${before.mode} -> ${mode}`);
      return { ok: true, mode: next.mode, previous: before.mode, setBy: actor, text: `${modeLine(next)}\n（原来是 ${before.mode}）` };
    },
  },
  {
    name: 'ws_tag',
    description: 'Tag one session with a role (manager | worker | other). Administrator only; writes atomically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: 'Target session id (session-<uuid> or bare uuid).' },
        role: { type: 'string', enum: ROLES, description: 'manager = 指挥；worker = 干活；other = 路人' },
        public: { type: 'boolean', description: 'true = 公开给 worker 看（默认 false）' },
      },
      required: ['sessionId', 'role'],
    },
    output: output(),
    async execute(args, exec) {
      const actor = String((exec && exec.agent && exec.agent.id) || '');
      if (!actor) return { ok: false, text: '拿不到调用者会话 id，拒绝执行' };
      const target = normalizeSessionId(args && args.sessionId);
      if (!target) return { ok: false, text: 'sessionId 不合法（需要 session-<uuid> 或裸 uuid）' };
      const role = String((args && args.role) || '');
      if (!ROLES.includes(role)) return { ok: false, text: `角色只能是 ${ROLES.join(' / ')}，收到 "${role}"` };
      const before = readState();
      const caller = resolveCaller(exec && exec.ctx ? exec.ctx : {}, before, actor);
      if (!canTagRole(caller)) {
        return { ok: false, text: `无权限：打角色需要管理员，调用者 ${actor} 当前是 ${caller.kind}` };
      }
      const isPublic = args && args.public === true;
      const at = new Date().toISOString();
      const next = await commit((st) => ({
        ...st,
        sessions: { ...st.sessions, [target]: { role, setBy: actor, at, public: isPublic } },
      }));
      log(`ws_tag ${actor} -> ${target} ${role} public=${isPublic}`);
      const record = next.sessions[target];
      return {
        ok: true,
        sessionId: target,
        role: record.role,
        public: record.public,
        text: `已给 ${target} 打角色：${record.role}（${record.public ? '公开' : '不公开'}，由 ${actor} 于 ${record.at}）`,
      };
    },
  },
  {
    name: 'ws_list',
    description: 'List session roles. Administrator sees all; a worker sees public rows plus its own; anyone else sees only itself.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: output(),
    async execute(_args, exec) {
      const actor = String((exec && exec.agent && exec.agent.id) || '');
      if (!actor) return { ok: false, text: '拿不到调用者会话 id，拒绝执行' };
      const ctx = exec && exec.ctx ? exec.ctx : {};
      const state = readState();
      const caller = resolveCaller(ctx, state, actor);
      const ids = await listSessionIds(ctx);
      const rows = visibleSessions(state, caller, ids);
      const scope = caller.isAdmin ? '全部' : (caller.role === 'worker' ? '公开的 + 自己' : '只有自己');
      const lines = rows.map((r) => `- ${r.sessionId}${r.isSelf ? '（本会话）' : ''}：${r.role || '未打角色'}${r.public === true ? ' [公开]' : ''}${r.setBy ? `（${r.setBy} 设置）` : ''}`);
      const text = [
        `${modeLine(state)}；你看到的是${scope}（共 ${rows.length} 条）`,
        ...(lines.length ? lines : ['（暂无记录）']),
      ].join('\n');
      return { ok: true, mode: state.mode, scope, rows, text };
    },
  },
];

// ── 插件主体 ────────────────────────────────────────────────────────────

export function apply(ctx) {
  ensureDir();
  const names = [];
  for (const t of TOOLS) {
    ctx.effect(() => ctx.tools.register(t), `dsh-working-state: ${t.name}`);
    names.push(t.name);
  }
  const state = readState();
  log(`apply: tools=${names.join(',')} mode=${state.mode} sessions=${Object.keys(state.sessions).length} file=${STATE_FILE}`);
}

/** 供自测复用（不依赖 ctx）。 */
export const _internals = {
  STATE_FILE,
  PM_STATE_FILE,
  MODES,
  ROLES,
  DEFAULT_MODE,
  readState,
  writeState,
  emptyState,
  resolveCaller,
  canSetMode,
  canTagRole,
  visibleSessions,
  normalizeSessionId,
  TOOLS,
};
