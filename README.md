# UserCode —— 手机项目：手写代码

要造一台 **300 元以内** 的简易手机，摆脱"家长控制钱袋子就控制手机使用"的现状：
**没收了，咬咬牙就能再搭一台。** 工程优先级：**成本 / 可复现性 / 可维修性 > 极限性能**。

本仓库（`UserCode/`）放 **用户手写的代码**；AI 的工作区在**另一个仓库**（见文末"两个仓库的关系"）。

---

## 当前状态

> ⚠️ **目前只是板级 hello world 骨架**：`UserCode.cpp` 每秒打印一次 `Hello, world!`。
> 真正的系统代码（内核 / 显示 / 驱动）仍在 AI 工作区里，**尚未迁入本仓库**。

---

## 硬件

| 部件 | 型号 / 说明 |
|---|---|
| 主控 | **Waveshare RP2350B-PiZero**（RP2350B，282 MHz 级，16 MB flash，8 MB PSRAM） |
| 显示 | **3.5" HDMI 面板，480×320**，板载 **RTD2660D** 缩放芯片（只认标准模式） |
| 无线 | 另一块 **RP2350B Plus W**（CYW43439）用于 WiFi / 蓝牙试验 |
| DVI 引脚 | `D2 = 32/33`、`D1 = 34/35`、`D0 = 36/37`、`CLK = 38/39`（差分对 P/N） |

**显示链路**：RP2350 (PIO bitbang DVI) → HDMI 座 → 转接头 → 线 → 面板。
⇒ **实测教训**：这条链路比官方小板长得多，DVI 引脚必须用**较强驱动 + 快速压摆**
（`2 mA + 压摆受限` 会导致大面积闪、竖带、某通道解不出）。

---

## ⚠️ 已知待改

```
CMakeLists.txt 里：  set(PICO_BOARD pico2 CACHE STRING "Board type")
实际硬件是 Waveshare RP2350B-PiZero（RP2350B, 48 引脚）
⇒ 迁入真实代码前必须改板级（或提供自定义板级头）
```
（本文件不改代码，只做记录。）

---

## 怎么编译

**方式一：VSCode + Raspberry Pi Pico 扩展**（本骨架就是它生成的，直接点 Build 即可）

**方式二：命令行**
```powershell
cmake -B build -G Ninja -DPICO_BOARD=<板级>
cmake --build build
```
产物：`build/UserCode.uf2`（还有 `.elf` / `.bin` / `.hex`）

---

## 怎么烧写

**推荐：BOOTSEL + UF2（最省事）**
1. 按住 **BOOTSEL**，拔插 USB，松开 ⇒ 出现一个 U 盘（`RP2350` / `RPI-RP2`）
2. 把 `build/UserCode.uf2` 拖进去 ⇒ 板子自动烧写并重启

**或者 SWD（CMSIS-DAP）**：用 `openocd` 的 `program <elf> verify`。

---

## 怎么读输出

`pico_enable_stdio_usb/uart` 都开着 ⇒ 串口（USB CDC）或 UART0 都能看到 `printf`。

⚠️ 电脑上常有**蓝牙虚拟串口**，别选错。用串口时先看清设备名（`2E8A` 是树莓派官方 VID）。

---

## 文档在哪

**主文档在 AI 工作区 `../DeepSeekCode/`**（那里是本项目文档体系的唯一权威处）：

| 文件 | 什么时候读 |
|---|---|
| `开工前自检.md` | **动手前先读这个**（约 1 分钟） |
| `引路本.md` | 项目是什么、用户是谁、什么最重要 |
| `指令本.md` | 怎么干活（操作规矩、本子分工） |
| `docs/当前状态.md` | **当前进度与每条状态的证据（唯一权威处）** |
| `小本本.md` / `历史本.md` / `陷阱本.md` | 技术笔记 / 交接 / 踩过的坑 |

---

## 两个仓库的关系

```
Phone.git
  ├── UserCode/      分支 main            用户手写代码（本仓库）
  └── DeepSeekCode/  分支 deepseek_bunch  AI 工作区：系统代码 + 全部文档
```

仓库地址：<https://github.com/hc-iterator/Phone.git>

---

## 关于提交历史

提交攒到 **30 条以上**或超过 **1 周**就要**按功能精简**一次（保留"能按块回退"的粒度），
精简后**顶端提交带 `[已精简]` 标记**并保留备份分支。规矩详见 `DeepSeekCode/指令本.md` §五。
