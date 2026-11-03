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
