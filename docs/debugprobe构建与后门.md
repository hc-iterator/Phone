# debugprobe（后门版）—— 构建配方与后门设计

> 目标：把上届 AI 在 `core1_monitor` 里写的后门能力，糅进 **raspberrypi/debugprobe**，
> 编译出 **debugprobe（后门版）.uf2**，这样这块 RP2040 既能当 **SWD 调试器**，
> 又保留"**运行中不用碰板子就能进 BOOTSEL / 重启**"的救命通道。
> 仓库克隆位置：`C:\Users\Chen\Desktop\Pico\debugprobe`（上游 commit `262f962`）。

## 一、本机构建配方（★ 已踩过的坑，别再踩）

| 项 | 值 |
|---|---|
| SDK | `%USERPROFILE%\.pico-sdk\sdk\2.3.0` |
| 工具链 | `%USERPROFILE%\.pico-sdk\toolchain\13_3_Rel1`（`arm-none-eabi-gcc 13.3.1`） |
| cmake / ninja | `%USERPROFILE%\.pico-sdk\cmake\v3.31.5\bin\cmake.exe` / `...\ninja\v1.12.1\ninja.exe` |
| 目标板 | **`-DPICO_BOARD=pico`**（我们的探针是普通 Pico，不是官方 Debug Probe 板） |
| 子模块 | `git submodule update --init --depth 1`（FreeRTOS 内核 `682f051`） |

**坑 1：cmake/ninja 必须经 `cmd.exe` 调用**（PowerShell 直连会让 cmake 访问违例崩溃）——用 `build_probe.cmd`。
**坑 2：宿主机【没有 C++ 编译器】**（无 `cl`/`clang++`/`g++`），而 SDK 默认要**现编宿主机版 pioasm** ⇒ 必失败。
三道不改上游行为的处理：
1. `%USERPROFILE%\.pico-sdk\tools\2.3.0\pioasm\pioasm.exe` 是官方**预编译**版；
   给 SDK 的 `tools/Findpioasm.cmake` 加了**优先用预编译版**的分支（**只有该文件存在时才走**，否则逻辑与上游一字不差）；
2. `get-version.sh` 在 Windows 上没有 `sh` ⇒ 换成一个 **cmd 能执行**的等价脚本（只负责生成 `generated/probe/version.h`）；
3. debugprobe 自带的 `pico_sdk_import.cmake` 是它自改过的版本 ⇒ 换成 **SDK 官版**（原版留作 `.orig`）。

**产物**：`build_pico/debugprobe_on_pico.uf2`（106496 字节，2026-10-04 基线）✓

## 二、后门设计（关键约束：debugprobe 的 CDC 是 UART 桥）

**为什么不能照搬单字母命令**：`core1_monitor` 的 CDC 只用于诊断，发 `B` 没有副作用；
而 debugprobe 的 CDC 是**给目标板用的 UART 桥**（`src/cdc_uart.c`）⇒
把裸 `B`/`R` 吃掉会破坏桥接功能 ✗。

**采用的方案**：**前缀门控**的命令通道 ——
主机发 `ESC ESC`（`0x1B 0x1B`）再跟一个命令字节 + CR/LF：

| 命令 | 作用 |
|---|---|
| `ESC ESC B` | 进 **BOOTSEL**（等价 `reset_usb_boot(0,0)`）—— 板子装在够不着的地方也能换固件 |
| `ESC ESC R` | **重启**（`watchdog_reboot`） |
| `ESC ESC ?` | 打印帮助（从 CDC 回给主机） |

实现落点：`src/cdc_uart.c` 的 `cdc_task()` 里，host→device 那条路径
（`tud_cdc_read(tx_buf, watermark)` → `uart_write_blocking()`）**之前**过一遍状态机，
**只把命令字节吃掉，其余原样转发** ⇒ 正常桥接不受影响。

**另有两条标准通道本来就在**（不依赖后门，也值得记住）：
- **picotool**：本仓库已定义 `PICO_ENABLE_USB_RESET_VIA_VENDOR_INTERFACE=1` 并链了 `pico_usb_reset`
  ⇒ `picotool reboot -u -f` 可把**运行中**的它退回 BOOTSEL；
- **1200 bps 触碰**：串口以 1200 波特打开再关，是业界通用的"软进 BOOTSEL"。

**（未做）实测**：需要先把探针现固件存档（已完成：`DeepSeekCode/probe_firmware/`），
再刷入后门版实测三条通道 —— **按用户要求不擅自刷机**。

## 三、已完成：后门版已编译并交付（2026-10-04）

| 项 | 值 |
|---|---|
| 源文件 | `src/backdoor.c` / `src/backdoor.h`（新增）；`src/cdc_uart.c` 的 `cdc_task()` 里加一行 `tx_len = backdoor_filter(tx_buf, tx_len);` |
| CMake | `add_executable(debugprobe ... src/backdoor.c)` |
| 构建目录 | `build_pico_backdoor/`（基线留在 `build_pico/`，便于对照） |
| **交付产物** | **`C:\360安全浏览器下载\debugprobe(后门版).uf2`（108544 字节）** |
| SHA256 | `1770C4D4C231074D728F409FE14C0C5B65384C06D7AB8916791F0DC625346D5D` |
| 对照基线 | `C:\360安全浏览器下载\debugprobe_on_pico-原版基线.uf2`（106496 字节，未含后门） |

**已做的验证（不含刷机）**：
1. **符号级**：后门版 ELF 有 `backdoor_filter`，**基线 ELF 没有** ⇒ 改动确实只加在后门版里 ✓
2. **算法镜像自测**：`tools/backdoor_mirror_test.py` **7/7 通过** ——
   覆盖"普通数据/单字节 ESC 必须转发/ESC ESC 命令/跨分片/未知字节"等分支；
   **并因此抓到一个真 bug**：`ESC ESC` 后跟未知字节时，代码把那个**普通字节也吃掉了**，
   与注释承诺相反 ⇒ 已修（`return true → false`）并重编译，uf2 哈希随之改变 ✓
   （⚠️ 镜像自测只验算法语义，**不等于固件实测**——真机行为仍需刷上去量。）

**仍未做（等用户发话）**：刷进探针实测三条通道（`ESC ESC B/R/?`、picotool、1200bps）；
以及决定是否就用这块板子做 SWD 调试（换固件后探针验证台暂时不可用，随时可用
`probe_firmware/core1_monitor-v1.1-20261003.uf2` 回烧）。

## 四、✅ 已刷入探针并实机验证通过（2026-10-04 深夜）

**刷入**：把后门版 uf2（SHA256 `1770C4D4…346D5D`）刷进那块 **RP2040 探针**
（原跑 `core1_monitor`，串口 `COM19`）。刷前用 `INFO_UF2.TXT` 双重确认板子身份：
**RP2040 报 `Board-ID: RPI-RP2`**，RP2350 报 `RP2350` —— 两者不会混淆（DUT 是 RP2350，未受影响）。

**刷后枚举（探针序列号 `503558607A848D9F`）**：
```
USB Composite Device   VID_2E8A&PID_000C\503558607A848D9F
CMSIS-DAP v2 Interface ...&PID_000C&MI_00      <- SWD 调试口
USB 串行设备 (COM17)    ...&PID_000C&MI_01      <- UART 桥 CDC（原 COM19）
USBDevice Reset        ...&PID_000C&MI_03      <- picotool 复位接口
DUT 未受影响: VID_2E8A&PID_0009 + COM18 ✓
```

**后门实机测试**：
| 测试 | 结果 |
|---|---|
| `ESC ESC ?` | ✅ **帮助文本原样返回** |
| `ESC ESC Q`（未知） | ✅ 返回 `unknown command after ESC ESC -- ESCs dropped, byte forwarded`（修正后的语义正确） |
| `ESC ESC B` | ✅ **串口立刻断开**（重启进 BOOTSEL），随后出现 `RPI-RP2` 卷 |
| `picotool load -x <后门版 uf2>` | ✅ **加载并立即执行**，探针恢复为 CMSIS-DAP + COM17 |
| 单个 `ESC`（反例） | ⚠️ **该条作废**：UART 桥把**悬空 RX 脚上的噪声**（大片 `0xFF`）转发到 CDC，污染了这次观察 —— 属桥的本职行为，与本改动无关 |

**⇒ 结论：后门的真正用途（运行中不碰板子就能进 BOOTSEL）以及 picotool 恢复路径，
都在真机上验通了。** 现在这块板子**既是 SWD 调试器、又留着救命通道**。

**要恢复探针验证台**：进 BOOTSEL（用后门 `ESC ESC B` 即可，不必按按键）后刷
`DeepSeekCode/probe_firmware/core1_monitor-v1.1-20261003.uf2`。

### ⚠️ 后门的边界（能救什么 / 不能救什么）—— 别当"万能保险"

| 情形 | 能不能救 |
|---|---|
| **应用层挂了**：任务卡死、DMA/PIO 配置错、程序逻辑跑飞，但 **USB 栈与 CDC 任务还活着** | ✅ 能：`ESC ESC B` 进 BOOTSEL；`picotool reboot -u -f`（Reset 厂商接口）、1200bps 触碰同理 |
| **USB 整体死掉**：启动阶段就卡死、时钟/电压配错导致 USB 不枚举、USB 描述符写坏 | ❌ **不能**：三条软件通道全部失效，**仍需按住 BOOTSEL 再插 USB**（物理兜底） |

⇒ 它把"几乎每次挂都要按按键"降到"**只有连 USB 都活不了时才要按**"，
但**不是绝对保险** —— 说"崩了也能救回来"时，这个前提要一起说。
