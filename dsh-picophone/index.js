/**
 * dsh-picophone —— PicoPhone 台架能力包（Host 插件）
 *
 * 目的：把上一届 AI 每轮都要手打的那批接口，和几类常见的越权访问，
 * 做成 Harness 里可以直接调用的能力。
 *
 *   ① Agent 工具（9 个）：pico_status / pico_build / pico_flash / pico_serial /
 *      pico_console / pico_temp / pico_git / pico_run / pico_exec
 *   ② 人工命令（1 个）：/pico —— 上面全部能力的命令行入口，外加 swd / procs /
 *      docs / agents 四个只在命令里出现的子命令
 *
 * 「越权」的含义：本插件在 Host 进程里直接 spawn，不经过会话 shell 的沙箱，
 * 所以 CMake/ninja/VS 工具链、烧写 uf2、读串口、%TEMP% 读写都能真正落地。
 * 代价是这些能力不受沙箱约束 —— 因此每一项都带硬超时、白名单与路径围栏。
 *
 * 所有子进程 windowsHide:true（不弹窗），超时后杀整棵进程树。
 */

// 拆分后本文件只做接线：装配 config → 逐工具注册 → /pico 命令与系统提示注入。
// 具体实现分布在 lib/（跨工具共享的服务）与 tools/（一个工具一个文件）。

import { resolveConfig } from './lib/config.js';
import { detectProfileName } from './lib/identity.js';
import { state } from './lib/state.js';
import { dispatchCommand } from './tools/command.js';
import { register as registerBuild } from './tools/build.js';
import { register as registerConsole } from './tools/console.js';
import { register as registerExec } from './tools/exec.js';
import { register as registerFlash } from './tools/flash.js';
import { register as registerGit } from './tools/git.js';
import { register as registerRun } from './tools/run.js';
import { register as registerSerial } from './tools/serial.js';
import { register as registerStatus } from './tools/status.js';
import { register as registerTemp } from './tools/temp.js';

export const name = 'dsh-picophone';
export const inject = ['tools'];

// 9 个 Agent 工具，注册顺序与拆分前一致（status / build / flash / serial / console / temp / git / run / exec）。
const TOOL_REGISTRARS = [
  registerStatus,
  registerBuild,
  registerFlash,
  registerSerial,
  registerConsole,
  registerTemp,
  registerGit,
  registerRun,
  registerExec,
];

// ---------------------------------------------------------------- 插件入口

/**
 * 注入系统提示的"台架须知"。为什么要有它（2026-10-06 实测）：
 *   本插件原先**只**注册工具 + 命令 ⇒ 对"新来的 AI"而言，唯一常显通道就是工具说明；
 *   而项目自己的必读文件（`子Agent须知.md` / `开子Agent必读.md` / `docs\工作守则.md`）
 *   里**一个字都没提 pico_\*** —— 全库 26 处提及**全部**在本插件 README 里 ⇒
 *   新会话会去手搓 `tools\serial.ps1` 那套旧流程，白白错过台架锁与账本 ✗。
 * 所以在这里补一段**短**说明（每轮请求都进 system prompt，必须克制）：
 *   只讲"会踩坑的规矩"，细节一律指到 `docs/台架接口.md` 与本插件 README。
 * ⚠️ 这段文字里**不许出现反引号**（外面是 JS 模板字符串，反引号会把它截断 ✗）。
 */
const RIG_PROMPT = [
  'PicoPhone 台架（rig，仅本模式）：pico_status / pico_build / pico_flash / pico_serial / pico_console / pico_temp / pico_git / pico_run / pico_exec，人工入口是 /pico 命令。',
  '',
  '⚠️ 第一次调用任何 pico_* 工具或 /pico 命令【之前】，必须先 skill 加载 pico-rig；工具的关键约束与常见失败只写在那个技能里，不加载就调是错的。',
  '三条最要命的硬规矩：BOOTSEL 按钮是唯一救砖手段；串口与烧写互斥（同一把台架锁）；沙箱外的受管脚本走信任门/审批，不许绕过。',
  '先把 pico_status 跑起来看台架状态，是本模式的第一步。',
  '',
  '- 子智能体：优先复用已有 Agent（看 _agents\ 与 PicoPhone\子Agent须知.md），不要随手新建；复用前先跑 tools\sync_agent_spaces.ps1 同步它的空间，确需新建要写明为什么不能复用。',
].join('\n');

export async function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig);
  // Host 进程 env 里没有 DSH_SESSION_ID；agent 服务能给出"当前调用链的发起者"。
  cfg.agentsService = ctx.get ? ctx.get('agents') : undefined;
  // ⚠️ 必须是 `cfg.profileName || ...`：直接赋值会把 config 里手填的 profileName 清成 ''。
  cfg.profileName = cfg.profileName || detectProfileName(ctx);
  // 沙箱执行器：装上了，就把"跑任意代码"的那几个 op 送进去（见 SANDBOX_MODE 的注释）。
  // ⚠️ 必须用 ctx.inject(['shell'], …) 解析 —— 实测 ctx.get('shell') 在这个组合里拿不到
  //    （2026-10-07 首跑：全部沙箱 op 报"沙箱执行器不可用"，就是踩了这个）。
  ctx.inject(['shell'], (shellCtx) => {
    state.sandboxContext = { shell: shellCtx.shell, workspaceRoot: cfg.root };
  });
  // 审批服务：指纹不符时由 AI 发起申请、人点同意（不用人记任何命令）
  cfg.pluginCtx = ctx;
  ctx.inject(['approval'], (approvalCtx) => {
    cfg.approval = approvalCtx.approval;
  });
  // 2026-10-07 用户裁定：改受管脚本【不走 pico_amend（审判员）】，改走【通用提权】=
  // DSH 的 approval 提示（信任门 askTrustApproval 已接好）：指纹不符 ⇒ 弹框 ⇒ 人点同意 ⇒
  // 登记新指纹 + 同步进运行本。opAmend 的代码保留作参考，但不再注册成工具。
  // 逐工具注册：每个 register() 内部做「记下 exec.agent」的包装（见 lib/tool.js）。
  const definitions = TOOL_REGISTRARS.map((register) => register(ctx, { cfg }));

  // ---- 系统提示注入（让"新来的 AI"一睁眼就知道这套接口该怎么用）-------------
  // 用 ctx.inject（**不是**直接 ctx.systemPrompt.section()）：
  //   systemPrompt 服务没挂载时**静默不生效** ⇒ 绝不会因为注入失败而把整个插件带崩 ✗
  //   （注册工具才是命根子：注入挂了顶多少一段说明，工具挂了就什么都没了）。
  // order 2705 = 紧跟在 SECTION_ORDERS 的 TOOL_RALPH(2700) 之后、TOOL_SUBAGENT(2800) 之前；
  //   该表是 dsh-system-prompt 的固定档位（type PromptSectionOrderName = keyof SECTION_ORDERS），
  //   但 section() 只要求 order 有限、名字在本层唯一 ⇒ 用明确的字面量最稳。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    // 防御：真 Host 里 inject(['systemPrompt']) 保证服务存在，但**冒烟测试的假 ctx 可能没铺桩**
    // ⇒ 2026-10-06 实测：不加这层守卫，smoke-test 会在这里抛
    //   `TypeError: Cannot read properties of undefined (reading 'section')`，
    //   把整包 9 个工具一起带走 ✗（注入只是"锦上添花"，绝不能拖垮工具注册）。
    const sp = promptCtx && promptCtx.systemPrompt;
    if (!sp || typeof sp.section !== 'function') return;
    sp.section({
      name: 'picophone:rig',
      order: 2705,
      // 只在 pico_status 这个工具**真的注册了**时才发这段（服务没挂/工具被禁 ⇒ 空串）
      text: ({ scope }) => (ctx.tools.get('pico_status', scope) === undefined ? '' : RIG_PROMPT),
    });
  });

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'pico',
      description: 'PicoPhone 台架命令：构建 / 烧写 / 串口 / SWD / %TEMP% / git / 脚本',
      input: { hint: '[status|build|flash|serial|swd|procs|temp|git|run|exec|docs|agents]' },
      handler: async (invocation) => await dispatchCommand(cfg, invocation.rawInput ?? '', { sessionId: invocation.agent?.id ?? null }),
    });
  });

  if (ctx.logger && typeof ctx.logger.info === 'function') {
    ctx.logger.info(`dsh-picophone: 已挂载 ${definitions.length} 个工具 + 1 个命令（root=${cfg.root}）`);
  }
}
