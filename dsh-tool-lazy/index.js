/**
 * dsh-tool-lazy —— 按需加载工具组（用户 2026-11-08 定稿：两层结构 + 自动回收）
 *
 * 第一层：tools-catalog 技能 = 目录（组名 + 一句描述 + 工具数，不含参数说明）
 * 第二层：每组一个技能 rea-<组名>，调 tools_load('<组>') 把【该组】工具放行到当前会话
 * 回收：默认 10 分钟无调用自动 unload；也可手动 tools_unload；maxAgeMs 兜底强制回收
 *
 * 依据（host `tools` 服务契约，cordis_inspect_query 实测）：
 *   register/restrict/schemas 都是 scope-aware；restrict 只作用于【调用方 agent scope】的【全局】工具。
 *   guard(guard): () => void —— 通过 agent.ctx 注册则只作用于该 agent（用来观察"这组工具最近有没有被用"）。
 */
export const inject = ['tools'];

/** 组定义：key → { prefix, label }。label 就是目录里那句中文描述。 */
const GROUPS = {
  'rea-disasm': { prefix: 'rea_', match: /disasm|decompil|pseudo|cfg|codeflow|code_flow|lift|func/i, label: '反汇编/反编译：伪代码、函数恢复、控制流' },
  'rea-binary': { prefix: 'rea_', match: /elf|pe_|macho|section|import|export|header|segment/i, label: 'ELF/PE/Mach-O 解析：节区、导入导出、头结构' },
  'rea-strings': { prefix: 'rea_', match: /string|const|extract|encod|utf|ascii/i, label: '字符串与常量：提取、搜索、编码识别' },
  'rea-debug': { prefix: 'rea_', match: /debug|break|memory|register|readmem|writemem|mem_/i, label: '调试与内存：断点、内存读写、寄存器' },
  'rea-packers': { prefix: 'rea_', match: /pack|upx|protect|entropy|shell|unpack/i, label: '打包器/壳识别：UPX/VMProtect 等与脱壳' },
  'rea-scripts': { prefix: 'rea_', match: /script|batch|plugin|eval|macro/i, label: '脚本引擎：内置脚本、批处理、插件 API' },
  'rea-network': { prefix: 'rea_', match: /net|http|cert|tls|pcap|proto|socket|dns/i, label: '网络与证书：抓包、证书、协议解析' },
  'rea-formats': { prefix: 'rea_', match: /format|image|container|archive|zip|compress|tar/i, label: '文件格式：固件、镜像、容器、压缩' },
  'rea-symbols': { prefix: 'rea_', match: /symbol|pdb|dwarf|reloc|maplib|sig/i, label: '符号与重定位：PDB/DWARF、符号恢复' },
  'rea-js': { prefix: 'rea_', match: /js_|javascript|electron|obfusc|webpack|asar|node_/i, label: 'JS/Electron 逆向：打包、混淆、热更新' },
  'rea-managed': { prefix: 'rea_', match: /dotnet|il_|java|bytecode|class_|assembly|mono/i, label: '.NET/Java 逆向：IL 与字节码反编译' },
  'rea-mobile': { prefix: 'rea_', match: /android|ios_|apk|ipa|dalvik|smali|plist/i, label: 'Android/iOS：APK/IPA 拆包与分析' },
  'rea-firmware': { prefix: 'rea_', match: /firmware|rtos|boot|flash|uboot|squashfs|jffs/i, label: '固件/嵌入式：解包、RTOS 符号、启动链' },
  'rea-workflow': { prefix: 'rea_', match: /workflow|session|task|report|evidence|note|plan/i, label: '流程编排：会话、任务、报告与证据' },
  probe: { prefix: 'timer_', match: /^timer_/, label: '测试用：timer_*（验证 load/unload 机制）' },

  // 2026-11-12 用户要求精简系统提示词：把低频但占地大的工具按组藏起来，用 tools_load 再拉。
  // 2026-11-13 用户要求：会话清理类保留但折叠（低频，用时再 tools_load）。
  gc: { prefix: 'session_gc_', label: '会话清理：按时间/空会话回收' },
  reaper: { prefix: 'blank_reaper', label: '空草稿回收：只留每个工作区最新一个' },
  gui: { prefix: 'gui_', label: 'GUI/桌面：截屏、点击、输入、窗口、虚拟屏' },
  pico: { prefix: 'pico_', label: 'Pico 台架：构建、烧写、串口、SWD' },
  mem: { prefix: 'mem_', label: '记忆库：事件时间线、用户画像' },
  proj: { prefix: 'proj_', label: '项目库：事实存取与查询' },
  agent: { prefix: 'agent_', label: '会话间消息：发送、收件箱、群发、清单' },
  admin: { prefix: 'pm_', label: '管理员：任命、撤销、查询' },
  ws: { prefix: 'ws_', label: '工作状态：模式与角色' },
  gate: { prefix: 'gate_', label: '危险操作闸门：申请、决定、状态' },
};
const GROUP_KEYS = Object.keys(GROUPS);
const CATALOG_KEYS = GROUP_KEYS.filter((k) => k !== 'probe');

const DEFAULTS = { idleMs: 10 * 60 * 1000, maxAgeMs: 60 * 60 * 1000, sweepMs: 30 * 1000 };

const stateByAgent = new WeakMap();
function stateOf(agent) {
  let s = stateByAgent.get(agent);
  if (s === undefined) { s = { loaded: new Map(), timer: undefined }; stateByAgent.set(agent, s); }
  return s;
}

function human(ms) {
  const min = Math.round(ms / 60000);
  return min >= 1 ? min + ' 分钟' : Math.round(ms / 1000) + ' 秒';
}

function visibleNames(ctx, agent) {
  try { return ctx.tools.schemas(agent).map((t) => t.name); } catch { return []; }
}

function namesOfGroup(names, key) {
  const g = GROUPS[key];
  if (g === void 0) return [];
  const byPrefix = names.filter((n) => n.startsWith(g.prefix));
  // 没有 match 的组按前缀整体归属；有 match 的组再用关键字细分（REA 未实装时关键字是预估，需校准）
  return g.match === void 0 ? byPrefix : byPrefix.filter((n) => g.match.test(n));
}

function applyRestriction(ctx, agent) {
  const s = stateOf(agent);
  const names = visibleNames(ctx, agent);
  const deny = [];
  for (const key of GROUP_KEYS) {
    if (s.loaded.has(key)) continue;
    deny.push(...namesOfGroup(names, key));
  }
  const uniq = [...new Set(deny)];
  try {
    return { ok: true, deny: uniq, disposer: ctx.tools.restrict(uniq.length === 0 ? {} : { deny: uniq }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function startSweeper(ctx, agent, config) {
  const s = stateOf(agent);
  if (s.timer !== undefined) return;
  s.timer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of [...s.loaded.entries()]) {
      if (now - entry.lastUsedAt > config.idleMs || now - entry.at > config.maxAgeMs) {
        for (const d of entry.disposers) { try { d(); } catch { /* ignore */ } }
        s.loaded.delete(key);
        changed = true;
      }
    }
    if (changed) applyRestriction(ctx, agent);
  }, config.sweepMs);
  if (typeof s.timer.unref === 'function') s.timer.unref();
}

function tool(name, description, parameters, run) {
  return {
    name, description, parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok', 'text'] },
      render: (_a, v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }],
    },
    async execute(args, exec) { return await run(args ?? {}, exec); },
  };
}

export async function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
  try {
    ctx.systemPrompt?.section?.({
      name: 'tool:lazy-groups',
      order: typeof ctx.systemPrompt?.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_LAZY') : 0,
      text: '逆向/反编译相关的工具按组按需加载：先读 `tools-catalog` 技能，再加载需要的组。',
    });
  } catch { /* 没有 systemPrompt 服务就算了 */ }

  const definitions = [
    tool('tools_catalog',
      'List lazy tool groups: group name, one-line purpose, tool count, and whether each is loaded. No parameter docs.',
      { type: 'object', additionalProperties: false, properties: {} },
      async (_args, exec) => {
        const agent = exec?.agent;
        if (!agent) return { ok: false, text: '拿不到 agent，无法读取作用域工具' };
        const s = stateOf(agent);
        const names = visibleNames(ctx, agent);
        const lines = CATALOG_KEYS.map((key) => {
          const total = namesOfGroup(names, key).length;
          const status = s.loaded.has(key) ? '已加载' : '未加载';
          return '- ' + key.padEnd(14) + ' ' + status + '  ' + String(total).padStart(3) + ' 个工具  ' + GROUPS[key].label;
        });
        return { ok: true, text: '按需工具组：\n' + lines.join('\n') + '\n\n加载：tools_load { group: "rea-disasm" }；卸载：tools_unload { group: "…" }（默认 10 分钟无调用自动卸载）。' };
      }),
    tool('tools_load',
      'Load ONE tool group into this conversation (un-hides only that group). Auto-unloads after idle timeout.',
      { type: 'object', additionalProperties: false, required: ['group'], properties: { group: { type: 'string', enum: GROUP_KEYS, description: 'Group key.' } } },
      async (args, exec) => {
        const agent = exec?.agent;
        if (!agent) return { ok: false, text: '拿不到 agent' };
        const key = String(args.group ?? '');
        if (!GROUP_KEYS.includes(key)) return { ok: false, text: '未知组：' + key };
        const s = stateOf(agent);
        if (s.loaded.has(key)) { s.loaded.get(key).lastUsedAt = Date.now(); return { ok: true, text: '组 ' + key + ' 已经是加载状态' }; }
        const targets = namesOfGroup(visibleNames(ctx, agent), key);
        if (targets.length === 0) return { ok: false, text: '组 ' + key + ' 当前没有工具（REA 未安装或该组工具未注册）' };
        s.loaded.set(key, { at: Date.now(), lastUsedAt: Date.now(), disposers: [] });
        try {
          if (typeof agent.ctx?.tools?.guard === 'function') {
            const d = agent.ctx.tools.guard((execution) => {
              if (targets.includes(execution.name)) { const e = s.loaded.get(key); if (e !== void 0) e.lastUsedAt = Date.now(); }
              return void 0;
            });
            s.loaded.get(key).disposers.push(d);
          }
        } catch { /* guard 不可用不影响加载 */ }
        const r = applyRestriction(ctx, agent);
        if (!r.ok) { s.loaded.delete(key); return { ok: false, text: '加载失败：' + r.error + '（可能是 scope-local 工具，restrict 不适用）' }; }
        startSweeper(ctx, agent, config);
        return { ok: true, text: '已加载 ' + key + '：' + targets.length + ' 个工具（' + human(config.idleMs) + ' 无调用会自动卸载）' };
      }),
    tool('tools_unload',
      'Unload one tool group from this conversation (hides its tools again).',
      { type: 'object', additionalProperties: false, required: ['group'], properties: { group: { type: 'string', enum: GROUP_KEYS, description: 'Group key.' } } },
      async (args, exec) => {
        const agent = exec?.agent;
        if (!agent) return { ok: false, text: '拿不到 agent' };
        const key = String(args.group ?? '');
        const s = stateOf(agent);
        const entry = s.loaded.get(key);
        if (entry === void 0) return { ok: true, text: '组 ' + key + ' 本来就没加载' };
        for (const d of entry.disposers) { try { d(); } catch { /* ignore */ } }
        s.loaded.delete(key);
        const r = applyRestriction(ctx, agent);
        if (!r.ok) return { ok: false, text: '卸载失败：' + r.error };
        return { ok: true, text: '已卸载 ' + key + '（其工具再次隐藏）' };
      }),
  ];
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), 'dsh-tool-lazy: ' + definition.name);
  }
}