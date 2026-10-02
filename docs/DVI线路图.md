# DVI 线路图（给人看的，一页）

> **为什么有这份文件**：`third_party/frank-hdmi-sound/` + `third_party/libdvi/` 加起来上万行，
> 人读不动。这份文件只做一件事：**把"从一幅画面到 HDMI 线上的一位"这条路画出来**，
> 并标出**哪几处才是关键**、**哪些是我（AI）加的临时东西**。
>
> 配套：`小本本.md` §14.0（问题现状摘要）、§14.23（已排除清单）。

---

## 一、数据流（一条线，从上到下）

```
应用画图 (Core0)
  src/dvi_screen.c        画测试图 / 写 g_fb
        │  sleep_ms(16)
        ▼
引擎喂数 (Core1)  ← 真正的引擎在这一核
  frank_hdmi.c : core1_main()
        │  ① queue_remove_blocking(q_colour_free)   拿一块空闲扫描线缓冲
        │  ② fill_scanline()                        把 g_fb 的一行填成 RGB565
        │  ③ encode_one_scanline_16bpp()            调 3 次 tmds_encode_*，编成 TMDS 符号
        │       └ 里面两次 queue_remove_blocking（等 q_colour_valid / 等 q_tmds_free）
        │  ④ queue_add_blocking(q_tmds_valid)       交给 DMA 侧
        ▼
DMA 链 (硬件)
  frank_dvi.c : IRQ 处理器（dvi_dma_irq_handler）
        │  · 按 timing_state 选一张表（active / blank / error / vblank）
        │  · _dvi_load_dma_op() 把"控制通道"指向那张表
        │  · 控制通道每段写 4 个字到"数据通道"⇒ 触发它搬这一段
        ▼
  frank_dvi_timing.c : 表的构建（dma_cb_t 数组，每段 = 读地址+写FIFO+字数+CTRL）
        ▼
PIO 串行器 (硬件)  ← 实测瓶颈在这一层
  frank_serialiser.pio : 两条指令 `out pc,1 side 0b10` / `out pc,1 side 0b01`
        │  从 TX FIFO 拉字，1 bit 1 bit 地推出差分对
        ▼
  引脚 32/34/36（数据）+ 38（时钟，由 PWM 产生）
```

---

## 二、关键文件（按重要性）

| 文件 | 是什么 | 为什么重要 |
|---|---|---|
| **`frank-hdmi-sound/src/frank_serialiser.pio`** | **串行器，只有 2 条指令** | **实测瓶颈就在这两条指令的节拍上**（每 bit ~13 周期，而非注释假定的 1） |
| `libdvi/dvi_serialiser.pio` | **同一东西的【未修改原版】** | 对照用：原版是 `.side_set 2 opt`，fork 是 `.side_set 2` |
| `frank-hdmi-sound/src/frank_dvi.c` | 引擎：IRQ 处理器、DMA 链装载、启动 | 每行被拆成 6~7 段、由控制通道逐段触发 |
| `frank-hdmi-sound/src/frank_dvi_timing.c` | 扫描线 DMA 表的构建 | **341–387 行有一段中文注释，是上一任 AI 写的完整故障诊断**（"全零槽地雷"）—— **项目本子里没有它** |
| `frank-hdmi-sound/src/frank_hdmi.c` | Core1 的引擎主循环、颜色缓冲、队列 | 引擎产出的真正计数器 `frank_hdmi_heartbeat_lines` 在这里 |
| `frank-hdmi-sound/docs/LLM_GUIDE.md` | 库自己的说明+排障 | 官方排障只有三条，本项目三条全满足 ⇒ 我们已在它已知问题集之外 |

---

## 三、只有 5 处真正关键

1. **`frank_serialiser.pio` 那两条 `out pc, 1`** ← **头号嫌疑**（见下方"两个问题"）
2. **`frank_dvi.c` 里 IRQ 处理器中那段 `while (dbg_tcr != want_tcr)` 的等待** ←
   本项目已把它的守卫从 10 万降到 2000，**帧率因此从 1.3 → 4.7 fps**
3. **`_dvi_load_dma_op()`** ← 每行重新武装三个控制通道；**我在这里加了"收口"**（见第四节）
4. **`_dvi_fill_unused_slots()`**（`frank_dvi_timing.c`）← 上一任把"零区"填成第 0 段副本，
   防"全零控制块把数据通道 EN 写成 0"；**我又把续命段的字数压小过**
5. **`dvi_set_sys_clock` / `frank_hdmi_init`** ← `sys_clock = TMDS_bit_clock × DVI_SM_CLKDIV`
   （252MHz × 1，已实测正确）

---

## 四、哪些是我（AI）加的、应该清理的

| 位置 | 是什么 | 处置 |
|---|---|---|
| `src/pio_dma_bench.c` | **我造的最小基准**（PIO+DMA 对照尺） | 有用，但它是**临时诊断**；已在 `CMakeLists.txt` 登记、在 `dvi_screen.c` 里被调用 |
| `CMakeLists.txt` 一行 | `src/pio_dma_bench.c` 的登记 | 同上 |
| `dvi_screen.c` 里一段 `{ ... pio_dma_bench_run() ... }` | 启动前跑基准 | 同上 |
| `frank_dvi.c` 里满地的 `g_dvi_*` / `g_bench*` | **我加的临时仪表**（计数器/耗时） | 定位完应删 |
| `frank_hdmi.c` 里的 `g_enc_*` / `g_wait_*` / `g_loop_*` | 同上 | 同上 |
| `frank_dvi.c` 的 `_dvi_restart_dma_chain()` | 我第 2 轮加的"整条链重排" | **实测有害**，其调用已改成 `break`；函数体已成死代码，可删 |
| `frank_dvi.c` / `frank_dvi_timing.c` 里的 `#if 1` / `#if 0` 实验开关 | 收口、显式重触发、续命段字数 | **当前是"收口开、重触发开"**（这是修好 lane2 的那一版）；建议把开关去掉、只留生效的那份 |

---

## 五、问题现在是什么样（两句话）

**两个独立问题，已用实验分离：**

1. **主因**：PIO 串行器**每 bit 要约 13 个时钟**（而非 1）⇒ 整条链慢 **12~13 倍**。
   证据：我的最小基准 ~14.6 周期/bit；真实 DVI 389 µs ÷ 8000 bit ≈ 12.2 周期/bit。
2. **次因（已修好）**：控制通道读越界 ⇒ 垃圾控制块把 lane2 数据通道的 `EN` 写成 0。
   **重新打开"收口+显式重触发"后，三条 lane 的 `dbg_tcr` 全部 = 320、`EN` 全部 = 1。**
   而**修好它并没有提高帧率** ⇒ 实验证明它不是限速方。

**⇒ 所以真正要打的只有第 1 条。**
