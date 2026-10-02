# SPI_PICO_TEST

在 **Waveshare RP2350-PiZero（RP2350B）** 上从底层搭一个**简易手机系统**：内核掌握全部外设权限，
应用通过**内存越权触发异常**请求系统服务，单前台 + 多后台。
（目录名已过时：`SPI` 是本项目唯一被放弃的部分，新名字待定。）

> **文档入口**：新对话先读 **`开工前自检.md`**（动手前的清单，约 1 分钟），
> 再读 **`引路本.md`**（项目 / 用户 / 什么最重要）。
> **当前进度与每条状态的证据只看 `docs/当前状态.md`**（状态类信息的唯一权威处）。
> **全部分工见 `指令本.md` 的「本子分工」表**（唯一权威表）。

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

**设备识别**：`2E8A:0009` = 目标板（串口 COM7）；`2E8A:000C` = 调试探针（CMSIS-DAP + COM8）。`2E8A` 是树莓派官方 VID。

## 主机侧自检（不需要板子）

```powershell
cmd /c tools\host_test\run_all.cmd
```

一条命令跑完账本 43 步 + 资源借用 70 步 + 内存管理器 24 步，**能真的报失败**。
边界：验证的是**逻辑**，不是硬件行为（详见 `小本本.md` §十）。

## 目录布局

| 路径 | 是什么 |
|---|---|
| 根目录 `*.md` | 文档体系。**清单与分工见 `指令本.md` 的「本子分工」表**；本文件只是工程手册 |
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
