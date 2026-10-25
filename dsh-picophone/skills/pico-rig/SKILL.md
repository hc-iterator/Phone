---
name: pico-rig
description: Use BEFORE the first pico_* tool call or /pico command in a session, and whenever a task touches the PicoPhone rig — boards, builds, flashing, serial or the persistent console, SWD, the rig lock, the trust gate and runtime copies, or debug artifacts. Carries the hard rules that tool schemas do not state.
---

# PicoPhone 台架（rig）

**这是"先读再动手"的规则书**：`pico_*` 工具的 schema 只说参数，本文件说**纪律**。
要碰台架就先读它；不够时再按 §4 深入。

## 0. 硬规矩（违反会砸硬件或砸别人）

1. **烧写前**：要烧的固件必须自带串口后门（`B` 进 BOOTSEL、`R` 重启）；像 `empty.uf2` 那种**不开 USB stdio 的固件不能当中转件**（烧上去既没串口也没后门）⇒ 要中转就编 `backdoor_only`。
2. **这块台架没有 RUN 引脚、SWD 不可用** ⇒ **BOOTSEL 按钮是唯一救砖手段**。
3. **串口与烧写互斥**：两者都占台架锁（`$DSH_HOME\picophone.lock`）；并发会被拒绝并报出占用者；空闲 2 分钟自动关会话并释放。
4. **按键驱动的固件用 `pico_console`**（`open` 付一次 4~5 秒开口成本，之后 `send`/`read`/`expect` 很便宜）；**不要**用 `pico_serial` 反复开关同一个口。
5. **"板上现在跑的是哪一份"**看 `pico_status` 的「最后烧写」（账本 `debug_logs/flash_ledger.jsonl`，含 uf2 的 sha256 前 16 位与源码 commit）；构建会落 `build/build_info.txt`。
6. **板子按 VID:PID 认，不认 COM 号**：`dut` = RP2350（2E8A:0009）、`probe` = RP2040 debugprobe（2E8A:000C，它的后门要 **ESC ESC** 前缀）、`sampler` = 2E8A:000A。
7. **跑在沙箱外的脚本受哈希信任门管辖**：`pico_build` / `pico_serial` / `pico_console` / `pico_flash` / `/pico swd|procs` 执行的是 **Pico 文件夹里的"运行本"**（`…\_picophone_trust\runtime\`），**不是** `DeepSeekCode\tools\` 里那份（那份只是源码）。改了受管脚本 ⇒ 指纹不符 ⇒ 弹审批（通用提权）或拒绝 ⇒ **别自己绕过**。

## 1. 先跑这个

`pico_status` —— 一次给出：路径、工具链版本、git 分支/HEAD/脏项、USB 设备、台架锁持有者、最后烧写、悬挂调试进程。只读，且同时返回 json 便于前后对比。

## 2. 九个工具（一句话职责 + 关键约束）

| 工具 | 干什么 | 关键约束 |
|---|---|---|
| `pico_status` | 台架全景（只读） | `probeSerial` 会采样串口 2 秒 |
| `pico_build` | 构建（`target`: root / 子工程 / host-test） | **不进沙箱**（cmake 在沙箱里会 AV 崩）；会写 `build_info.txt` |
| `pico_flash` | 烧写（`method`: bootsel / backdoor / picotool / auto） | 盘身份核对 + 固件检查；**不可逆** |
| `pico_serial` | 读一段串口并存盘 | 抓包**一律落 %TEMP%**（绝对路径会被围栏压回） |
| `pico_console` | 常驻会话：open/send/read/expect/close | 按键驱动固件用这个 |
| `pico_temp` | 读写 %TEMP%（插件侧） | "窗口外访问"的正规出口 |
| `pico_git` | git 操作（含 `_agents` 子空间） | 走沙箱；改历史类动作要 `mutate: true` |
| `pico_run` | 跑 `tools\` / `dsh-plugins\` 下的脚本 | **沙箱内**（可以自己写脚本随便跑） |
| `pico_exec` | 跑白名单可执行文件 | **沙箱内**；PATH 已注入 SDK 工具链 |

`/pico` 命令是同一批能力的**人工入口**：`status|build|flash|serial|console|git|run|exec|lock|trust|docs|agents|swd|procs`。

## 3. 常见失败与其含义

- `Could not find file 'COM…'` ⇒ 板子不在（或它跑的固件没开 USB stdio）
- `台架被占用: … pid=… 会话=…` ⇒ 别的会话在用；等它空闲，或确认后 `/pico lock clear`
- `⛔ 拒绝执行【沙箱之外】的脚本 … 已变更` ⇒ 受管脚本被改过 ⇒ 走审批，或人敲 `/pico trust <路径>`
- `sandbox={"denied":true}` / `PermissionError` ⇒ 沙箱按预期拒绝**窗口外**写入（不是 bug）
- `sh.exe … couldn't create signal pipe` ⇒ 沙箱里的 git 需要 POSIX shell ⇒ **沙箱内 push 不可用**（用 `pico_git` 的凭据链，或非沙箱终端）
- `审批结果：unavailable` ⇒ 审批策略是 `never` 或无人应答 ⇒ 一律 fail-closed（保持拒绝）

## 4. 深入资料（按需读，别一次全读）

- `DeepSeekCode\docs\台架接口.md` —— **每个工具的参数、行为与全部失败分支**（最权威）
- `dsh-plugins\dsh-picophone\README.md` —— 插件自述（配置项、已知坑、运行本与信任层）
- `DeepSeekCode\台架接口沙箱化说明.md` —— 沙箱化 / 信任层 / 运行本的来龙去脉（含踩过的坑）

## 补充（2026-10-25 从系统提示移出）

> 这些条目原先写在**每轮都进上下文**的系统提示与工具 `description` 里，为省 token 移到本技能。
> **约束效力不变**：它们和上面 §0 的硬规矩同级。

### 系统提示原先还说了这些

- **子智能体**：先复用已有 Agent（看 `_agents\` 下的空间与 `PicoPhone\子Agent须知.md`），**不要随手新建** ✗；复用前先跑 `tools\sync_agent_spaces.ps1` 同步它的空间（旧空间是旧快照，不同步就会引用旧名 ✗）；确需新建时，**要写明为什么不能复用**。
- 用户一提到子智能体，回复里就必须带一句"**优先复用**"。
- 按键驱动的固件用 `pico_console`（原硬规矩第 4 条）。
- 九个工具的关键约束、以及常见失败的含义，**只写在**本技能里；在加载它之前就调 `pico_*` 是错的。

### pico_status

- 正文与 json 是**同一批事实** ⇒ 两次调用可以机械对比（"和上次比哪里变了"）。
- 没显式传 `probeSerial` 时不采样串口；采样时是"板子是不是在跑交接说明里那份固件"最快的判断方式。

### pico_build

- 失败时返回**首批编译错误**（不是只给日志尾部）。
- 成功时在产物旁落 `build_info.txt`：源码 commit / 是否脏 / 工具链。
- `noUf2`：只省掉一次 elf→uf2 转换；**uf2 仍会出现**，因为每个子工程 CMakeLists 都调 `pico_add_extra_outputs()`，ninja 会产出它。
- `buildSub`：实验用单独目录（如 `build_slow`），避免覆盖全速产物。
- `target`：`root` 主固件 / `host-test` PC 侧内核自测 / 子工程名（`wboard_dvi`、`core1_monitor`、`probe_rp2040`）。
- `cacheArgs`：每个元素自带 `-D`，例如 `-DWBOARD_DVI_SM_CLKDIV=8`。

### pico_flash

- `backdoor`（默认）= 通过串口请**正在运行的固件**自己进 BOOTSEL；`bootsel` = 跑 `tools/flash_bootsel.ps1`；`picotool` = `picotool load -x`；`list` = 只枚举板子与盘；`auto` = 先 backdoor 再 picotool，都不成时会明说"需要人按 BOOTSEL"。
- **烧写会打断正在跑的应用**；本台架没引出 RUN 脚、SWD 不可用 ⇒ BOOTSEL 按钮是唯一救援。
- 写盘前核对引导盘身份；`force` 会跳过这台核对 —— DUT 与探针的引导盘几乎同名，写错代价很大。
- 写完追加 `debug_logs/flash_ledger.jsonl`：镜像指纹（sha256 前 16 位）、源码 commit、结果 ⇒ "板上跑的是哪份"可查。
- `dryRun` 只解析并打印将执行的命令与盘身份结果，**不碰硬件**。

### pico_serial

- 开口成本约 4.5 s ⇒ 要多次读写、或"发一条再等回应"，用 `pico_console`，别用 `pico_serial` 反复开关同一个口。
- 并发读会被台架锁**明确拒绝**，而不是两个进程抢同一个端口。
- `outFile`：默认落一个带时间戳的文件，正文字节一律回显；绝对路径越出 %TEMP% 会被**压回** %TEMP%，并在结果里标「围栏」。

### pico_console

- `open` 只付一次 4~5 s 的开口成本，之后 `send` / `read` / `expect` 很便宜。
- `expect` = 发出后等某一行匹配正则，**不用猜 sleep**；超时会明确说"没有匹配上"。
- 每行默认带到达时间戳（墙钟）—— 这才让"每 30 秒闪一次"可证。
- 会话开着就一直持有台架锁；`close` 或空闲超时（默认 120 s）才释放。

### pico_temp

- %TEMP% 是项目放抓包、payload、dump 的暂存区；这是"窗口外访问"的正规出口。

### pico_run

- 这是到达 SWD 工具、进程守卫、子智能体空间脚本、文档门禁、遥测解析器的那条路。

### pico_exec

- PATH 里预置了 `~\.pico-sdk` 的 cmake / ninja / arm-none-eabi-* / picotool / openocd，以及 VS 的 vswhere / MSBuild。
- **shell 故意不在白名单**；`cl` 也不在（没有 VS 开发者环境跑不起来）⇒ 跑项目脚本用 `pico_run`，MSVC 那条链用 `pico_build host-test`。

