# 探针固件存档（RP2040 · core1_monitor）

> 用途：这块 **RP2040** 探针（CDC 端口 `COM19`）在 2026-10-04 被**换回 SWD 调试器固件**之前，
> 把它的固件**源码 + 可直接回烧的 `.uf2`** 一起存进仓库，避免"想再用探针却没固件了"。

## 文件

| 文件 | 说明 |
|---|---|
| `core1_monitor-v1.1-20261003.uf2` | **可直接拖盘回烧**的产物（119296 字节） |
| `core1_monitor-v1.1.c` | 当时的源码快照（`MON_VERSION "1.1"`） |
| `core1_monitor-v1.1.CMakeLists.txt` | 当时的构建脚本快照 |

- **SHA256**（uf2）：`40015391DECA4D12BDA0EED4E296EEF89BABA0A2CD19B65B08DDED1482DAF346`
- 源码在仓库里的正式位置：`DeepSeekCode/core1_monitor/`（本目录只是**存档快照**，改代码请改那边）
- 存档时的 git 提交：`6b6e3bb`

## 怎么回烧（两种都行）

1. **推荐的常规路径**：让探针进 BOOTSEL ⇒ 出现 `RPI-RP2` 盘 ⇒ 把 `.uf2` 拖进去
   - 进 BOOTSEL 的三种办法：① 串口发 `B`（本固件后门，**Core0 死了也能用**）；
     ② 按住 BOOTSEL 再插 USB；③ 板上有 RUN 键时按它。
   - 也可以一步到位：在 BOOTSEL 下 `picotool load -x core1_monitor-v1.1-20261003.uf2`
     （`-x/--execute` = 烧完立刻执行，见 `picotool help load`）。
2. **重建**（要改代码时）：
   ```
   cd DeepSeekCode\core1_monitor
   cmake -S . -B build -G Ninja
   ninja -C build
   ```
   产物 = `build/core1_monitor.uf2`。

## 串口协议速查（都用 CR 结尾）

| 命令 | 作用 |
|---|---|
| `c<div>` | 设定采样分频（1..64）。**`c64` ⇒ 3.9375 MSa/s**（sys 252 MHz / 64，每字 4 个采样） |
| `d` | 采一包（**固定 16384 字 = 65536 采样**）并打印 |
| `m` | 测量排水速率（判断有没有丢样本 / RXSTALL） |
| `s` | 状态 |
| `P` / `C` | 暂停 / 继续 Core0（Core1 继续服务 USB） |
| `R` | 重启芯片（watchdog） |
| `B` | **进 BOOTSEL**（换固件的安全路径） |
| `E` / `F` | 擦一个 4KB 扇区 / 擦+写+回读校验 |

- **8 位采样打包进 32 位字**，**高字节 = 最先采到的样本**（与 `tools/tmds_decode_oversampled.py` 一致）。
- 引脚映射（探针与 DUT 相同）：`GPIO0= D2P 1=D2N 2=D1P 3=D1N 4=D0P 5=D0N 6=CLKP 7=CLKN`；
  库侧 `TMDS_SYNC_LANE=0` ⇒ 同步 lane 在 **GPIO4/5**（2026-10-04 逐 lane 扫描实测确认）。
- 本固件由 **Core1** 承担 USB 串口，所以 **Core0 挂死也不影响抓包**（这就是它的设计目的）。

## 为什么值得存

DVI 输出那次从"上屏画面不对"查到"IRQ 里每行重触发控制通道顶掉视频块"，
**全部证据都来自这块探针**（受控方波实验、逐 lane 扫描、行中寄存器快照）。
探针一旦被换成 SWD 固件，这套验证台就暂时不可用了 —— 所以固件必须留档。

## ⚠️ 2026-10-04 用户更正（口径）

- **真正"没有引出 SWD"的是【被测那块】（DUT / RP2350B-Plus-W）** ⇒ 调不到它，
  才走上"探针串口抓包 + 软件后门"这条路。
- **探针（RP2040）这边**：当时认为"**给探针上 SWD 没啥必要**"（是判断，不是板子做不到）。
- ⇒ 本目录旧文案里"探针板没有引出 SWD"的表述，按上面口径理解；**别再记成"探针没有 SWD"**。
