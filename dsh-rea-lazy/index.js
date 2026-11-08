/**
 * dsh-rea-lazy —— REA(MCP) 工具按【任务】分组懒加载
 *
 * 为什么要自己写：@deepseek-ai/dsh-mcp-client 激活时一次性注册服务器全部工具（207 个），
 * 没有 allow/deny 过滤 ⇒ 上下文立刻 +~250k tokens。本插件只做一件事：
 *   连上 MCP 后只 tools/list，不注册；tools_load 时才把该组/该工具 scoped 注册进当前会话；
 *   引用计数卸载；10 分钟无调用自动回收。
 *
 * 关键依据（host tools 服务契约）：register 在"调用方 agent scope"注册并返回 disposer；
 * guard(agent.ctx) 可观察调用；schemas(agent) 读该 agent 可见工具。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const inject = ['tools'];

const HERE = fileURLToPath(new URL('.', import.meta.url));
const GROUPS_PATH = new URL('./groups.json', import.meta.url);
const GROUPS = JSON.parse(fs.readFileSync(GROUPS_PATH, 'utf8'));

const DEFAULTS = { idleMs: 10 * 60 * 1000, maxAgeMs: 60 * 60 * 1000, sweepMs: 30 * 1000, thirdPartyDir: '', command: '', args: [] };

// ── 一行组定义（catalog 用）──────────────────────────────────────────────
const GROUP_KEYS = Object.keys(GROUPS);

// ── 连接（懒、复用、失败可重试）──────────────────────────────────────────
let mcp = null;          // { client, transport, tools: Map<rawName, {description, inputSchema}> }
let mcpError = null;     // 最近一次失败原因（给用户看）
let mcpConnecting = null;

function resolveLaunch(config) {
  if (config.command && config.args?.length) return { command: config.command, args: config.args };
  // 优先用 npx 缓存里已解包的 rea-agents（不联网、启动快）
  const cache = process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\npm-cache\\_npx` : '';
  if (cache && fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache)) {
      const entry = `${cache}\\${dir}\\node_modules\\rea-agents\\scripts\\rea.mjs`;
      if (fs.existsSync(entry)) return { command: process.execPath, args: [entry, 'mcp'] };
    }
  }
  return { command: 'npx', args: ['-y', 'rea-agents@6.7.0', 'mcp'] };
}

async function ensureMcp(config) {
  if (mcp !== null) return mcp;
  if (mcpConnecting !== null) return await mcpConnecting;
  mcpConnecting = (async () => {
    try {
      const { Client } = await import('@modelcontextprotocol/client');
      const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
      const base = config.thirdPartyDir;
      const env = { ...process.env };
      if (base) {
        env.GHIDRA_INSTALL_DIR = `${base}\\ghidra_12.1.4_PUBLIC`;
        env.JAVA_HOME = `${base}\\jdk-21.0.12.1+1`;
        env.TEMP = `${base}\\rea-tmp`;
        env.TMP = env.TEMP;
        const missing = [env.GHIDRA_INSTALL_DIR, env.JAVA_HOME, env.TEMP].filter((p) => !fs.existsSync(p));
        if (missing.length > 0) throw new Error('依赖路径不存在：' + missing.join(' ; '));
      }
      const launch = resolveLaunch(config);
      const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env, stderr: 'pipe' });
      const client = new Client({ name: 'dsh-rea-lazy', version: '0.1.0' });
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = new Map();
      for (const t of listed.tools ?? []) {
        tools.set(t.name, { description: String(t.description ?? t.name), inputSchema: t.inputSchema ?? { type: 'object', properties: {} } });
      }
      mcp = { client, transport, tools };
      mcpError = null;
      return mcp;
    } catch (error) {
      mcpError = error instanceof Error ? error.message : String(error);
      throw new Error('REA MCP 连接失败：' + mcpError + '\n常见原因：npx 首次拉包慢/无网络；GHIDRA_INSTALL_DIR 或 JAVA_HOME 路径不对；端口被占。');
    } finally {
      mcpConnecting = null;
    }
  })();
  return await mcpConnecting;
}

// ── 每 agent 状态：registered + 已加载组 ─────────────────────────────────
const stateByAgent = new WeakMap();
function stateOf(agent) {
  let s = stateByAgent.get(agent);
  if (s === undefined) { s = { registered: new Map(), sweeper: undefined }; stateByAgent.set(agent, s); }
  return s;
}

function human(ms) { const m = Math.round(ms / 60000); return m >= 1 ? m + ' 分钟' : Math.round(ms / 1000) + ' 秒'; }

function outputOf() {
  return {
    schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok', 'text'] },
    render: (_a, v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }],
  };
}

function makeDefinition(name, meta, callRaw) {
  return {
    name,
    description: meta.description,
    parameters: meta.inputSchema,
    output: outputOf(),
    async execute(args) {
      try {
        const res = await callRaw(name, args ?? {});
        const blocks = Array.isArray(res?.content) ? res.content : [];
        const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') || JSON.stringify(res ?? {});
        return { ok: res?.isError !== true, text };
      } catch (error) {
        return { ok: false, text: 'REA 调用失败（' + name + '）：' + (error instanceof Error ? error.message : String(error)) };
      }
    },
  };
}

function startSweeper(ctx, agent, config) {
  const s = stateOf(agent);
  if (s.sweeper !== undefined) return;
  s.sweeper = setInterval(() => {
    const now = Date.now();
    for (const [name, e] of [...s.registered.entries()]) {
      if (now - e.lastUsedAt > config.idleMs || now - e.at > config.maxAgeMs) {
        try { e.disposer(); } catch { /* ignore */ }
        s.registered.delete(name);
      }
    }
  }, config.sweepMs);
  if (typeof s.sweeper.unref === 'function') s.sweeper.unref();
}

/** 求差集注册（幂等）。返回新注册的名字数组。 */
function registerNames(agent, names, mcpTools, callRaw) {
  const s = stateOf(agent);
  const added = [];
  for (const name of names) {
    if (s.registered.has(name)) { s.registered.get(name).lastUsedAt = Date.now(); continue; }
    const meta = mcpTools.get(name);
    if (meta === undefined) continue;
    const def = makeDefinition(name, meta, callRaw);
    const disposer = agent.ctx.tools.register(def);
    s.registered.set(name, { disposer, at: Date.now(), lastUsedAt: Date.now(), refs: new Set() });
    added.push(name);
  }
  return added;
}

function tool(name, description, parameters, run) {
  return { name, description, parameters, output: outputOf(), async execute(args, exec) { return await run(args ?? {}, exec); } };
}

// 仅测试用：注入假 MCP（离线冒烟），不参与运行时逻辑。
export const __test = { setMcp: (fake) => { mcp = fake; }, stateOf, GROUPS };

export async function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
  if (!config.thirdPartyDir) {
    // 默认：<workspace>/../_third_party（PicoPhone/_third_party）
    try { config.thirdPartyDir = fileURLToPath(new URL('../../_third_party', import.meta.url)); } catch { config.thirdPartyDir = ''; }
  }
  ctx.systemPrompt?.section?.({
    name: 'tool:rea-lazy',
    order: typeof ctx.systemPrompt?.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_REA_LAZY') : 0,
    text: 'REA 逆向工具按任务分组、按需加载：需要逆向/反编译时先读 `tools-catalog` 技能，再 tools_load 对应组或单个工具。',
  });

  const definitions = [
    tool('tools_catalog',
      'List REA lazy groups (name, task, tool count, loaded?). With {group} list that group\'s tool names (paged, default 40).',
      { type: 'object', additionalProperties: false, properties: { group: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } } },
      async (args, exec) => {
        const group = args.group === void 0 ? undefined : String(args.group);
        if (group !== undefined) {
          const g = GROUPS[group];
          if (g === void 0) return { ok: false, text: '未知组：' + group + '（可选：' + GROUP_KEYS.join(' / ') + '）' };
          const offset = Number.isFinite(args.offset) ? Math.max(0, args.offset) : 0;
          const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 40;
          const page = g.tools.slice(offset, offset + limit);
          const more = offset + limit < g.tools.length;
          return { ok: true, text: '组 ' + group + '（' + g.label + '，共 ' + g.tools.length + ' 个）\n' + page.join('\n') + (more ? '\n…下一页 offset=' + (offset + limit) : '') };
        }
        let m = mcp;
        if (m === null) { try { m = await ensureMcp(config); } catch (error) { return { ok: false, text: String(error.message ?? error) }; } }
        const s = exec?.agent ? stateOf(exec.agent) : undefined;
        const lines = GROUP_KEYS.map((k) => {
          const g = GROUPS[k];
          const loaded = s !== undefined && g.tools.some((t) => s.registered.has(t));
          return '- ' + k.padEnd(14) + ' ' + (loaded ? '部分已加载' : '未加载') + '  ' + String(g.tools.length).padStart(3) + ' 个  ' + g.label;
        });
        return { ok: true, text: 'REA 按需工具组（连上后共 ' + (m?.tools?.size ?? 0) + ' 个工具）：\n' + lines.join('\n') + '\n\n加载：tools_load { group: "fn-analysis" } 或 { tool: "inspect_function" } 或 { group: "...", tools: ["..."] }。' };
      }),
    tool('tools_load',
      'Load a REA group and/or specific tools into THIS conversation (scoped). Idempotent; only the difference is registered.',
      { type: 'object', additionalProperties: false, properties: { group: { type: 'string' }, tool: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } } } },
      async (args, exec) => {
        const agent = exec?.agent;
        if (!agent) return { ok: false, text: '拿不到 agent，无法在会话作用域注册' };
        const group = args.group === void 0 ? undefined : String(args.group);
        const wanted = new Set();
        if (group !== undefined) {
          const g = GROUPS[group];
          if (g === void 0) return { ok: false, text: '未知组：' + group };
          for (const t of g.tools) wanted.add(t);
        }
        if (typeof args.tool === 'string' && args.tool !== '') wanted.add(args.tool);
        if (Array.isArray(args.tools)) for (const t of args.tools) if (typeof t === 'string') wanted.add(t);
        if (wanted.size === 0) return { ok: false, text: '要么给 group，要么给 tool/tools' };
        let m;
        try { m = await ensureMcp(config); } catch (error) { return { ok: false, text: String(error.message ?? error) }; }
        const callRaw = async (name, a) => await m.client.callTool({ name, arguments: a });
        const known = [...wanted].filter((t) => m.tools.has(t));
        const unknown = [...wanted].filter((t) => !m.tools.has(t));
        const added = registerNames(agent, known, m.tools, callRaw);
        const s = stateOf(agent);
        for (const t of known) { const e = s.registered.get(t); if (e) { if (group) e.refs.add(group); e.refs.add('@explicit'); e.lastUsedAt = Date.now(); } }
        startSweeper(ctx, agent, config);
        return {
          ok: known.length > 0,
          text: '加载完成：新注册 ' + added.length + ' 个，已在册 ' + (known.length - added.length) + ' 个' +
            (unknown.length > 0 ? '\n未知工具（REA 没有）：' + unknown.join(', ') : '') +
            '\n（' + human(config.idleMs) + ' 无调用会自动回收）',
        };
      }),
    tool('tools_unload',
      'Unload a group or specific tools from THIS conversation. Reference-counted: only tools no loaded group still uses are truly unregistered.',
      { type: 'object', additionalProperties: false, properties: { group: { type: 'string' }, tool: { type: 'string' } } },
      async (args, exec) => {
        const agent = exec?.agent;
        if (!agent) return { ok: false, text: '拿不到 agent' };
        const s = stateOf(agent);
        const group = args.group === void 0 ? undefined : String(args.group);
        const only = typeof args.tool === 'string' ? args.tool : undefined;
        const names = only !== undefined ? [only] : (group !== undefined && GROUPS[group] ? GROUPS[group].tools : []);
        if (names.length === 0) return { ok: false, text: '给 group 或 tool' };
        let removed = 0;
        for (const t of names) {
          const e = s.registered.get(t);
          if (e === undefined) continue;
          if (group !== undefined) e.refs.delete(group);
          e.refs.delete('@explicit');
          if (only !== undefined || e.refs.size === 0) {
            try { e.disposer(); } catch { /* ignore */ }
            s.registered.delete(t);
            removed += 1;
          }
        }
        return { ok: true, text: '已卸载 ' + removed + ' 个工具（其余仍被已加载组引用，保留）' };
      }),
  ];
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), 'dsh-rea-lazy: ' + definition.name);
  }
}