# Phone —— 300 元以内，自己造一台手机

> **让手机便宜到"被没收了，咬咬牙就能再搭一台"。**
> 工程优先级：**成本 / 可复现性 / 可维修性 > 极限性能**。

---

# 🚀 先看这里：本项目的主要工作**不在本分支**

| | |
|---|---|
| **`main`（你正在看的）** | 只有**用户手写代码的空骨架**（板级 hello world）——**几乎什么也没有** |
| **`deepseek_bunch`** | ✅ **真正的代码 + 全部文档都在这里** |

**想看到真东西，切过去只要两条命令：**

```bash
git clone https://github.com/hc-iterator/Phone.git
cd Phone/DeepSeekCode
git switch deepseek_bunch          # ← 主要工作在这里
```

> 进去后**第一件事**读 `开工前自检.md`（约 1 分钟），
> 再看 `引路本.md`（项目 / 用户 / 什么最重要）与 `docs/当前状态.md`（进度与证据）。

---

## 这个项目是什么

用 **Waveshare RP2350-PiZero（RP2350B）** 从底层搭一个**简易手机系统**：

- **内核掌握全部外设权限**，应用通过**内存越权触发异常**请求系统服务（单前台 + 多后台）
- 显示走 **PIO bitbang DVI**（不是 HSTX：本板 HSTX 硬连 GPIO12..19，而 DVI 在 GPIO32..39）
- 无线用另一块 **RP2350B Plus W**（CYW43439）做 WiFi / 蓝牙试验

---

## 已经做到什么（都有实测证据）

| 事项 | 状态 |
|---|---|
| **屏幕点亮** | ✅ 在真板上点亮并持续出帧，**61.2 fps**（行频 31.5 kHz，即 640×480p60） |
| **竖条纹 / 隔行** | ✅ 已消除（`DVI_VERTICAL_REPEAT` 改回库原生值） |
| **大面积闪 / 竖带 / 红通道解不出** | ✅ 已消除（DVI 引脚驱动强度 2 mA→8~12 mA + 快速压摆） |
| **TMDS 编码正确性** | ✅ 直接读芯片内 TMDS 缓冲验证：三条 lane 完全对齐 |
| **测量手段** | ✅ 自研 **TMDS 采样探针**（第二块板高速抓 DVI 波形）+ 解码器 |
| **当前工作** | 🔬 用探针测真实波形，定位"电脑显示器也不认我们的信号"的原因 |

详细的修复清单、被证伪的猜测、以及踩过的坑，都在 `deepseek_bunch` 的
`历史本.md`（交接）/ `小本本.md`（技术笔记）/ `陷阱本.md`（坑）里。

---

## 仓库结构

```
Phone.git
  ├── UserCode/       分支 main            用户手写代码（本分支，目前是空骨架）
  └── DeepSeekCode/   分支 deepseek_bunch  AI 工作区：系统代码 + 全部文档  ← 主要工作
```

---

## 硬件

| 部件 | 型号 / 说明 |
|---|---|
| 主控 | **Waveshare RP2350B-PiZero**（RP2350B，252 MHz 级，16 MB flash，8 MB PSRAM） |
| 显示 | **3.5" HDMI 面板 480×320**，板载 **RTD2660D** 缩放芯片（只认标准模式） |
| 无线 | 另一块 **RP2350B Plus W**（CYW43439） |
| DVI 引脚 | `D2 = 32/33`、`D1 = 34/35`、`D0 = 36/37`、`CLK = 38/39` |

---

## 怎么开始（三条命令）

```bash
git clone https://github.com/hc-iterator/Phone.git
cd Phone/DeepSeekCode
git switch deepseek_bunch
```

```powershell
# 编译（在 DeepSeekCode 下）
cmd /c tools\build.cmd            # 结果看 debug_logs\build_log.txt 里的 BUILD_EXIT=0
```

```powershell
# 烧写（BOOTSEL + UF2 最省事；或走 SWD）
# 按住 BOOTSEL 拔插 USB ⇒ 出现 U 盘（RP2350）⇒ 拖 build\SPI_PICO_TEST.uf2 进去
```

---

## 提交历史

提交攒到 **30 条以上**或超过 **1 周**就**按功能精简**一次（保留"能按块回退"的粒度），
精简后顶端提交带 `[已精简]` 标记并保留备份分支。规矩见 `DeepSeekCode/指令本.md` §五。
