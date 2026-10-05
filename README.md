# SPI_PICO_TEST

> 🔴 **要开子 Agent / 派活之前必读**：[`开子Agent必读.md`](开子Agent必读.md)
> （第一件事就是跑 `tools\who_can_i_reuse.ps1` —— **先看有什么能复用的，再决定新建**；
>  2026-10-05 立的门，起因见 `docs\陷阱.md` 错 27。）

> ## 📌 历史精简记录
>
> | 日期 | 条数变化 | 旧历史所在（本地备份分支） |
> |---|---|---|
> | 2026-10-02 | **259 → 9** | `pre-cleanup-1002` / `pre-split-1002` |
>
> **规矩**：提交攒到 **30 条以上**或超过 **1 周**就要**按功能精简**一次（不要压成一条，
> 要保留"能按块回退"的粒度）；精简后**顶端提交带 `[已精简]` 标记**，且**必须保留备份分支**。
> 判据：`git diff --quiet <备份> HEAD` 的**退出码 = 0**（树逐字节一致）。
> 详见 `docs/工作守则.md` §五。


在 **Waveshare RP2350-PiZero（RP2350B）** 上从底层搭一个**简易手机系统**：内核掌握全部外设权限，
应用通过**内存越权触发异常**请求系统服务，单前台 + 多后台。
（目录名已过时：`SPI` 是本项目唯一被放弃的部分，新名字待定。）

> **文档入口**：新对话先读 **`docs/开工前自检.md`**（动手前的清单，约 1 分钟），
> 再读 **`docs/导引.md`**（项目 / 用户 / 什么最重要）。
> **当前进度与每条状态的证据只看 `docs/当前状态.md`**（状态类信息的唯一权威处）。
> **全部分工见 `docs/工作守则.md` 的「文档分工」表**（唯一权威表）。

> **最后校准：2026-10-02** —— 上机实测基准是 **2026-10-01 晚**。

## 怎么编译

```powershell
cmd /c tools\build.cmd
```

结果看 `debug_logs\build_log.txt` 里的 `BUILD_EXIT=`（0 = 成功）。产物 `build\SPI_PICO_TEST.uf2`。

> ⚠️ **"退出码说成功"不算数** —— 本项目出过 `echo %ERRORLEVEL%` 把退出码冲成 0 的假成功。
> **必须同时看产物时间戳**（`build\SPI_PICO_TEST.uf2` / `.elf` 的 `LastWriteTime` 要是"刚刚"）。

## 怎么烧写

```powershell
cmd /c tools\flash.cmd
```

失败时（固件卡死时会发生）手动兜底：**按住 BOOTSEL → 点一下 RUN → 松开 BOOTSEL**，
然后重跑 `tools\flash.cmd`；也可以走 BOOTSEL 那条路：

```powershell
pwsh -NoProfile -File tools\flash_bootsel.ps1
```

### 串口后门（推荐：不用碰 BOOTSEL 按键）

**两块板都植入了串口后门** —— 发一个字符就能进 BOOTSEL 或重启，有现成脚本，不用手打：

```powershell
.\tools\flash_backdoor.ps1                                    # 列出当前能看到的板子与引导盘
.\tools\flash_backdoor.ps1 -Board probe                       # 刷探针（probe_rp2040.uf2）
.\tools\flash_backdoor.ps1 -Board dut -Firmware wboard_dvi\build\pin_toggle.uf2
```

| 板 | 角色 | 进 BOOT 后按 `INFO_UF2.TXT` 的 Board-ID 认 | 后门命令 | 固件在哪 |
|---|---|---|---|---|
| **RP2350B-Plus-W** | 待测板（`dut`） | `RP2350` | `B` = 进 BOOTSEL，`R` = 重启 | `wboard_dvi/*`、`src/dvi_min.c` |
| **RP2040**（13 元板，**超频到 252 MHz**） | 探针（`probe`） | `RPI-RP2` | `?` `S` `s` `g` `c<div>` `m` `d` `r/w` `P/C` `R` `B` `E/F` `X`（**必须 CR 结尾**） | **`core1_monitor`**（v1.1 = 监视器 + 采样器合并），见 `core1_monitor/README.md` |

> 🔴 **两条会白费半小时的坑（2026-10-04 亲踩，别重犯）**：
> 1. **命令必须以 CR（`\r` 或 `\n`）结尾才会被执行** —— 只发裸字符时固件**只回显、不动作**。
>    我据此误判成"探针固件不对"，其实只是协议没对上。串口工具请**关掉本地回显**（固件自己会回显）。
> 2. **探针跑的是 `core1_monitor`，不是 `probe_rp2040`** —— 它的**串口服务在 Core1**，
>    所以 **Core0 挂死它照样应答**（`S` 秒回缓存；`B` 任何状态下都能进 BOOTSEL，**不必人手按按键**）。
>    ⚠️ `probe_rp2040/probe.c` 是**上一代**的独立采样器固件，命令集不同、且**没有自救能力**。

- **绝不靠盘符认板**（插拔后会变号）—— 脚本按 `INFO_UF2.TXT` 的 `Board-ID` 判。
- 命令出处：`probe_rp2040/probe.c:21-22,337-339`、`src/dvi_min.c:126-144`、`wboard_dvi/pin_toggle.c:45-50`。
- ⚠️ **后门收不到的情形**：固件已挂死 ⇒ 只能人手按 BOOTSEL（脚本会明确报 `✗` 并提示）。

> **用什么手段看结果** —— 这一条决定了整个工作方式：
> - **SWD（推荐）**：2026-10-01 晚实测全链路可用 —— `SWD DPIDR 0x4c013477`、
>   两个 M33 核 `Examination succeed`、读/写内存都通、`program` 烧写+校验通过。
>   命令模板与注意事项见 `docs/当前状态.md` §一。
> - **串口（多半指望不上）**：目标板**应用态 USB stdio 不枚举**（ROM 的 BOOTSEL USB 是好的）。
>   ⇒ **读结果一律走 SWD**。

## 怎么读串口

```powershell
python tools\read_serial.py COM7 15
```

固件里的 `printf`（**包括 `panic()` 的消息**）都从这个口出来，排查崩溃比 SWD 翻调用栈快。
⚠️ **前提是 USB stdio 真的起来了** —— 不枚举时这个口不存在（见上）。

**设备识别**（⚠️ **COM 号每次插拔都会变 —— 只认 VID:PID + 序列号**；下表 2026-10-04 实测）：

| 设备 | VID:PID | **序列号（唯一）** | 当天 CDC | 备注 |
|---|---|---|---|---|
| **待测板 RP2350B-Plus-W** | `2E8A:0009`（MI_00=CDC，MI_02=Reset） | `C7771D72049EEF63` | COM18 | 跑 DVI 固件时，`s` 命令会吐 frank-hdmi 速率遥测（`[dvi] t=… eng=… vcnt=…`） |
| **探针 RP2040** | `2E8A:000A`（MI_00=CDC，MI_02=Reset） | **`503558607A848D9F`** | COM19 | ⚠️ **2026-10-04 该 CDC 打不开**（"设备没有发挥作用"）⇒ 需复位后才能用 `d`/`b` 采集 |

- `2E8A` = 树莓派官方 VID。⚠️ **`2E8A:000C` 是另跑的 `debugprobe`（CMSIS-DAP）**，与本表这两块不是同一套固件。
- 🔧 **串口打不开（报"连到系统上的设备没有发挥作用"）怎么救**（2026-10-04 实测）—— **次序很重要**：
  1. ✅ **首选**：`pnputil /restart-device "USB\VID_2E8A&PID_000A\503558607A848D9F"`
     （**父复合设备**，需管理员）⇒ 让主机重新枚举，**实测立刻可用**。
  2. 🔴 **不要用 `pnputil /remove-device`**（父设备或 `&MI_00` 子节点都不行）——
     **实测会把整块板从 USB 总线上打下去，而且不会自己回来**：`/scan-devices` 无效、
     `picotool` 也看不见它，**只能物理拔插 USB**（2026-10-04 亲踩）。
     ⚠️ 项目自带的 `tools/reset_usb_port.cmd` 走的正是 remove + scan 这条路 ⇒ **对它留个心眼**。
  3. ❌ `picotool reboot -f --bus/--address` 对这个症状**无效**（命令 exit=0 成功，口照样打不开）。
- ⚠️ **根因与预防**（`tools/reset_usb_port.cmd` 头部原话）：**进程在读取挂起时退出/被杀，
  Windows 会一直持有那个内核文件对象**，口就被独占。
  ⇒ **采集必须【在同一个进程里一气呵成】**（打开 → 发命令 → 收完 → 关），
  **不要"开一次、关一次、再开"** —— 反复开关正是把 CDC 弄卡的常见触发方式。
- **`picotool info`（不带参数）**可列出所有在线 RP2xxx：
  `RP2350 device at bus 1, address 5` / `RP2040 device at bus 1, address 4`；
  ⚠️ 要读固件身份得加 `-f`，而 **`-f` 会强制重启进 BOOTSEL（属状态变更，会中断正在跑的固件）**。

## 主机侧自检（不需要板子）

```powershell
cmd /c tools\host_test\run_all.cmd
```

一条命令跑完账本 43 步 + 资源借用 70 步 + 内存管理器 24 步，**能真的报失败**。
边界：验证的是**逻辑**，不是硬件行为（详见 `docs/实测数据.md` §十）。

## 目录布局

| 路径 | 是什么 |
|---|---|
| 根目录 `*.md` | 文档体系。**清单与分工见 `docs/工作守则.md` 的「文档分工」表**；本文件只是工程手册 |
| `CMakeLists.txt`、`pico_sdk_import.cmake` | 构建入口 |
| `src/` | 自家源码（内核、驱动、诊断） |
| `third_party/` | 第三方库，全部 vendored，基本不改 |
| `tools/` | 脚本、GDB 采集脚本、OpenOCD 配置、探针固件 |
| `libs/` | 打板用的元件库与参考设计（**别人给的，不是我们的源码**） |
| `debug_logs/` | 所有"跑一次就覆盖"的日志（不进版本库） |
| `docs/` | 文档：`当前状态.md`（**状态权威**）、`总体架构.md`、`显示子系统.md`、`应用ABI.md`、`硬件设计.md`（含打板清单） |
| `build/` | 编译产物（不进版本库） |

凡"脚本每跑一次就重写"的文件一律进 `debug_logs/`，不进版本库；
要留下的结论写进书或 `docs/`。
