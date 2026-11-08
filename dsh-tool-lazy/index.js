/**
 * dsh-tool-lazy —— 按需加载工具组（用户 2026-11-08 诉求）
 *
 * 目标：上下文里只留"有这些工具组"这一行；要用哪组，才把该组工具注册/放行进当前会话。
 *
 * 依据（host `tools` 服务的契约，cordis_inspect_query 实测）：
 *   register(definition): () => void     —— 全局或"调用方 agent scope"注册；返回 disposer 可卸载
 *   restrict({ allow?, deny? }): () => void —— 只作用于【调用方 agent scope】的【全局】工具；可叠加（intersect）
 *   schemas(scope?: ScopeKey): ToolSchema[] —— scope 传 agent，即"该 agent 看得见的工具"
 *
 * 因此本插件**不复制**别的插件的定义（拿不到也没必要），只做两件事：
 *   1) catalog：用 schemas(agent) 现场算出"有哪些组、每组多少工具、当前哪些被挡"；
 *   2) load/unload：用 restrict() 在【本 agent 的 scope】里 deny 掉未加载组的工具名。
 *
 * ⚠️ 边界：restrict 只认【全局】工具名；若某组工具是 preset/scope 内注册的（scope-local），
 *    restrict 会报错 —— 这里捕获并把原因如实返回，不硬来（见 docs/调查-按需加载工具组.md）。
 */
export const inject = ['tools'];

/** 组定义：按工具名前缀归属（不写死清单，插件加减工具后自动跟上）。 */
const GROUPS = {
  pico: { prefix: 'pico_', label: 'PicoPhone 台架（dsh-picophone）' },
  gui: { prefix: 'gui_', label: '屏幕/窗口操作（dsh-gui）' },
  rea: { prefix: 'rea_', label: 'REA 逆向工程（需 REA 插件配合；本组仅占位）' },
  // 测试组：本机任何会话都有 timer_*，用来端到端验证 load/unload 机制（REA 未安装时也能自检）。
  probe: { prefix: 'timer_', label: '测试用：timer_*（验证 load/unload 机制）' },
};
const GROUP_KEYS = Object.keys(GROUPS);

/** 每个 agent 的加载状态：{ disposer, loaded:Set, denied:Set } */
const stateByAgent = new WeakMap();

/** 未在状态里的组默认视为"未加载"。 */
function stateOf(agent) {
  let s = stateByAgent.get(agent);
  if (s === undefined) {
    s = { disposer: undefined, loaded: new Set(), denied: new Set() };
    stateByAgent.set(agent, s);
  }
  return s;
}

/** 该 agent 现在看得见的全部工具名。 */
function visibleNames(ctx, agent) {
  try {
    return ctx.tools.schemas(agent).map((t) => t.name);
  } catch {
    return [];
  }
}

/** 按组归类当前可见的工具。 */
function groupOf(names) {
  const out = {};
  for (const key of GROUP_KEYS) out[key] = [];
  for (const name of names) {
    for (const key of GROUP_KEYS) {
      if (name.startsWith(GROUPS[key].prefix)) { out[key].push(name); break; }
    }
  }
  return out;
}

/** 重新应用限制：deny = 未加载组的工具名。返回 { ok, error }。 */
function applyRestriction(ctx, agent, loaded) {
  const s = stateOf(agent);
  const names = visibleNames(ctx, agent);
  const byGroup = groupOf(names);
  const deny = [];
  for (const key of GROUP_KEYS) {
    if (key === 'rea' && byGroup.rea.length === 0) continue; // 占位组：没有工具就不掺和
    if (!loaded.has(key)) deny.push(...byGroup[key]);
  }
  try {
    if (s.disposer !== undefined) { try { s.disposer(); } catch { /* 旧限制已失效 */ } s.disposer = undefined; }
    s.denied = new Set(deny);
    s.disposer = ctx.tools.restrict(deny.length === 0 ? {} : { deny });
    return { ok: true, denied: deny };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function text(value) {
  return { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok', 'text'] }, render: (_a, v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }] };
}

function tool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: text(),
    async execute(args, exec) {
      return await run(args ?? {}, exec);
    },
  };
}

function buildToolDefinitions(ctx) {
  return [
    tool(
      'tools_catalog',
      'List lazy tool groups: which exist, how many tools each has, which are currently loaded. One line per group, no schemas.',
      { type: 'object', additionalProperties: false, properties: {} },
      async (_args, exec) => {
        const agent = exec?.agent;
        if (!agent) return { ok: false, text: '拿不到 agent，无法读取作用域工具' };
        const byGroup = groupOf(visibleNames(ctx, agent));
        const s = stateOf(agent);
        const lines = GROUP_KEYS.map((key) => {
          const g = GROUPS[key];
          const total = byGroup[key].length;
          const status = total === 0 ? '无工具' : (s.loaded.has(key) ? '已加载' : '未加载');
          return `- ${key.padEnd(5)} ${status}  ${String(total).padStart(3)} 个工具  ${g.label}`;
        });
        return {
          ok: true,
          text: '按需工具组（默认只保留 tools_catalog / tools_load / tools_unload）：\n' + lines.join('\n') +
            '\n\n加载：tools_load { group: "pico" }；卸载：tools_unload { group: "pico" }。',
        };
      },
    ),
    tool(
      'tools_load',
      'Load one tool group into THIS conversation (un-hides its tools). Other groups stay hidden.',
      {
        type: 'object', additionalProperties: false, required: ['group'],
        properties: { group: { type: 'string', enum: GROUP_KEYS, description: 'Group key.' } },
      },
      async (args, exec) => {
        const agent = exec?.agent;
        if (!agent) return { ok: false, text: '拿不到 agent，无法在会话作用域注册' };
        const group = String(args.group ?? '');
        if (!GROUP_KEYS.includes(group)) return { ok: false, text: `未知组：${group}（可选：${GROUP_KEYS.join(' / ')}）` };
        const s = stateOf(agent);
        const byGroup = groupOf(visibleNames(ctx, agent));
        if (byGroup[group].length === 0) {
          return { ok: false, text: `组 ${group} 当前没有可见工具${group === 'rea' ? '（REA 插件未挂载）' : ''}；等它注册后再试。` };
        }
        const loaded = new Set(s.loaded); loaded.add(group);
        const r = applyRestriction(ctx, agent, loaded);
        if (!r.ok) {
          return { ok: false, text: `加载失败：${r.error}\n可能原因：该组工具是 scope-local（preset 内注册），restrict 不适用 —— 见 docs/调查-按需加载工具组.md 的"缺口"。` };
        }
        s.loaded = loaded;
        return { ok: true, text: `已加载组 ${group}：${byGroup[group].length} 个工具（${byGroup[group].slice(0, 6).join(', ')}${byGroup[group].length > 6 ? ', …' : ''}）` };
      },
    ),
    tool(
      'tools_unload',
      'Unload one tool group from THIS conversation (hides its tools again).',
      {
        type: 'object', additionalProperties: false, required: ['group'],
        properties: { group: { type: 'string', enum: GROUP_KEYS, description: 'Group key.' } },
      },
      async (args, exec) => {
        const agent = exec?.agent;
        if (!agent) return { ok: false, text: '拿不到 agent' };
        const group = String(args.group ?? '');
        if (!GROUP_KEYS.includes(group)) return { ok: false, text: `未知组：${group}` };
        const s = stateOf(agent);
        if (!s.loaded.has(group)) return { ok: true, text: `组 ${group} 本来就没加载` };
        const loaded = new Set(s.loaded); loaded.delete(group);
        const r = applyRestriction(ctx, agent, loaded);
        if (!r.ok) return { ok: false, text: `卸载失败：${r.error}` };
        s.loaded = loaded;
        return { ok: true, text: `已卸载组 ${group}（其工具再次隐藏）` };
      },
    ),
  ];
}

export async function apply(ctx) {
  for (const definition of buildToolDefinitions(ctx)) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-tool-lazy: ${definition.name}`);
  }
}
