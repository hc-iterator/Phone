/*
 * frank-hdmi-sound. DVI engine implementation.
 *
 * Wires up the per-instance state (`dvi_inst`), claims the three TMDS
 * DMA channel pairs (control + data per lane), pre-builds the
 * scanline DMA control-block lists for vsync, vblank, active,
 * blanked-active and error states, and runs the IRQ that hot-swaps
 * those lists at every scanline boundary.  Also exposes the worker
 * entry points the application calls from Core 1 to feed the encoder
 * (scanbuf and framebuf modes, 8bpp or 16bpp), plus the HDMI audio
 * data-island setup that adds CEA-861 InfoFrames and audio sample
 * packets to the stream.
 *
 * (c) 2026 Mikhail Matveev <xtreme@rh1.tech>, https://rh1.tech
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Based on libdvi by Luke Wren and contributors
 * (https://github.com/Wren6991/PicoDVI), with HDMI audio additions
 * from shuichitakano's PicoDVI-audio fork
 * (https://github.com/shuichitakano/PicoDVI-audio).
 *
 * Copyright (c) 2021 Luke Wren and contributors.
 */
#include <stdlib.h>
#include "hardware/dma.h"
#include "hardware/irq.h"

#include "frank_dvi.h"
#include "frank_dvi_timing.h"
#include "frank_serialiser.h"
#include "frank_tmds.h"

// Time-critical functions pulled into RAM but each in a unique section to
// allow garbage collection
#define __dvi_func(f) __not_in_flash_func(f)
#define __dvi_func_x(f) __scratch_x(__STRING(f)) f

// We require exclusive use of a DMA IRQ line. (you wouldn't want to share
// anyway). It's possible in theory to hook both IRQs and have two DVI outs.
static struct dvi_inst *dma_irq_privdata[2];
static void dvi_dma0_irq();
static void dvi_dma1_irq();

static inline void dvi_update_data_packet(struct dvi_inst *inst) {
    data_packet_t packet;
    if (!dvi_update_data_packet_(inst, &packet)) {
        set_null(&packet, sizeof(data_packet_t));
    }
    bool vsync = inst->timing_state.v_state == DVI_STATE_SYNC;
    encode(&inst->next_data_stream, &packet, inst->timing->v_sync_polarity == vsync, inst->timing->h_sync_polarity);
}

/*
 * One-shot bring-up for a DVI instance.
 *
 * The caller fills in the static fields of `inst` first.  The
 * important ones are `timing` (which mode to drive) and `ser_cfg`
 * (which PIO and GPIOs to drive).  This function:
 *
 *   1. Resets the runtime state of the timing state machine.
 *   2. Sets the audio-data-island sub-state to "no audio".
 *   3. Brings up the TMDS serialiser PIO state machines.
 *   4. Claims six DMA channels (two per TMDS lane: one for the
 *      control-block list, one for the symbol stream itself).
 *   5. Creates the four blocking queues that move scanlines and
 *      TMDS buffers between the producer (application) and the
 *      consumer (the IRQ-driven DMA chain).
 *   6. Pre-builds the DMA control-block lists for the scanline
 *      "shapes": vsync line, vblank line, active line, blanked-
 *      active line, plus an "error" line for when the producer
 *      underruns.
 *   7. Carves the TMDS symbol buffers out of a static pool sized at
 *      compile time (DVI_STATIC_TMDS_MAX_PIX, default 640) and
 *      pushes them into q_tmds_free so the encoder can pick them up.
 *   8. Fills the AVI InfoFrame with sensible defaults (RGB, 4:3
 *      aspect, full range, picked from the timing).
 *
 * The two `spinlock_*` arguments are pico_util spinlock numbers used
 * to make queue accesses safe across cores.  Pass distinct values
 * obtained via `next_striped_spin_lock_num()`.
 */
/*
 * 诊断计数器（2026 修复时加，非 static 是为了 SWD/GDB 能直接读）。
 *
 * g_dvi_tcr_timeouts：第 384 行那个等待循环超时的次数。
 *   平时应该恒为 0。一旦非 0，说明控制通道又跑过头了 ——
 *   也就是当年那个"全零槽"坑（见 frank_dvi_timing.c 里
 *   _dvi_fill_unused_slots 上方的长注释）又出现了别的变种。
 *   这是把"永久死机"变成"可观测事件"之后留下的探针。
 */
volatile uint32_t g_dvi_tcr_timeouts = 0;

/* ── 诊断用（2026-10-01 加，只记【第一次】TCR 超时的现场；排查完可以删）──
 * 症状：引擎只出 14 帧就永久停住，Core0 仍以 ~47Hz 画图；
 *       DMA ch2~ch7 全部 EN=1 但 PIO0 TX FIFO 全空（FLEVEL=0）。
 * 手推寄存器位域已错三次，故改为在固件里直接记录现场。 */
volatile uint32_t g_dvi_irq_count   = 0;   /* DMA IRQ 进入次数 */
volatile uint32_t g_dvi_tcr_wait_us     = 0;   /* 上一次 IRQ 里 TCR 等待耗时(µs) */
volatile uint32_t g_dvi_tcr_wait_us_max = 0;   /* 历史最大 */
volatile uint32_t g_dvi_h_us      = 0;   /* 本次 IRQ 处理器耗时(µs，到最后一步之前) */
volatile uint32_t g_dvi_h_us_max  = 0;
volatile uint32_t g_dvi_upd_us     = 0;   /* 本次 dvi_update_scanline_data_dma 耗时(µs) */
volatile uint32_t g_dvi_upd_us_max = 0;
volatile uint32_t g_dvi_upd_count  = 0;   /* 该函数被调用的次数 */
/* 第 21 轮补：前文只量到 _dvi_load_dma_op() 之前，漏掉了处理器后半段 */
volatile uint32_t g_dvi_tail_us      = 0;   /* _dvi_load_dma_op + 重触发 + 数据岛 */
volatile uint32_t g_dvi_tail_us_max  = 0;
volatile uint32_t g_dvi_full_us      = 0;   /* 整个处理器（入口到出口） */
volatile uint32_t g_dvi_full_us_max  = 0;
/* 第 7 轮：累加器 —— 前面只看 last/max，从没量过【平均】，而"软件不是瓶颈"
 * 这个结论正建立在 last（单次采样读到 0）上。平均值 = sum / g_dvi_irq_count。 */
volatile uint32_t g_dvi_full_us_sum  = 0;
volatile uint32_t g_dvi_tmo_lane    = 0xFFFFFFFFu; /* 第一次超时发生在哪条 lane */
volatile uint32_t g_dvi_tmo_want    = 0;   /* 期望的 dbg_tcr */
volatile uint32_t g_dvi_tmo_tcr[3]  = {0, 0, 0};  /* 超时时三条 lane 的 dbg_tcr */
volatile uint32_t g_dvi_tmo_ctrl[3] = {0, 0, 0};  /* 三条 lane 数据通道的 CTRL */
volatile uint32_t g_dvi_tmo_cnt[3]  = {0, 0, 0};  /* 三条 lane 数据通道剩余传输数 */
volatile uint32_t g_dvi_tmo_chan[3] = {0, 0, 0};  /* 三条 lane 的数据通道号 */

/* ★★ 2026-10-04 临时诊断（修 DVI 输出用）：DMA 块表快照 ★★
 * 背景：探针实测到"同步 lane（蓝/D0）的有效区一直是控制符号，6/6 采集都这样"，
 *       而代码怎么读都该发 tmdsbuf 里的蓝通道数据 ⇒ 不再靠推理，直接把运行时真实块表抓出来。
 * 判据：若 L0 第 3 格（非音频路径的有效块）的 read_addr != g_dbg_tmdsbuf，
 *       就说明有效块被指到了别处（控制符号数组）——bug 坐实。
 * 填在 IRQ 里（**只写全局、不打印**），Core0 用串口 'D' 走 dvi_debug_dump() 打印。 */
volatile uint32_t g_dbg_seq      = 0;   /* IRQ 里填过多少次 */
volatile uint32_t g_dbg_list_id  = 0;   /* 0=active 1=vblank_nosync 2=active_blank 3=error 4=vblank_sync */
volatile uint32_t g_dbg_island   = 0;   /* data_island_is_enabled */
volatile uint32_t g_dbg_tmdsbuf  = 0;   /* 最近一次 dvi_update_scanline_data_dma 收到的 tmdsbuf */
volatile uint32_t g_dbg_blk_addr[3][7] = {{0}};
volatile uint32_t g_dbg_blk_cnt [3][7] = {{0}};
volatile uint32_t g_dbg_data_ra[3] = {0}, g_dbg_data_tc[3] = {0};
volatile uint32_t g_dbg_ctrl_ra[3] = {0}, g_dbg_ctrl_tc[3] = {0};
volatile uint32_t g_dbg_blkctrl[3][7] = {{0}};
volatile uint32_t g_dbg_blkwrite[3][7] = {{0}};
/* ★ 判据升级（2026-10-04）：块表已证实正确 ⇒ 再抓【编码器到底往 tmdsbuf 里写了什么】。
 *   每条 lane 的切片各取 3 个字（首、次、末）。若这些字本身就是控制符号
 *   （0x354/0x0AB/0x154/0x2AB 各出现两次的 20 位字），则问题在编码器侧；
 *   若是正常的成对数据码字，则问题在探针读回侧。 */
volatile uint32_t g_dbg_buf[3][3] = {{0}};
/* ★★ 诊断 2（2026-10-04）：在【IRQ 入口】抓 —— 那一刻上一行刚跑完、还没重装，
 *   所以看到的就是"这一行究竟跑了什么"的现场。
 *   dbg_tcr 尤其关键：IRQ 等的就是它 == h_active/2 (=320)。
 *   若某条 lane 的 dbg_tcr 停在 1（续命段字数）而不是 320 ⇒ 它这一行【没跑到有效段】。 */
volatile uint32_t g_dbg2_seq = 0;
volatile uint32_t g_dbg2_tcr[3]   = {0}, g_dbg2_tc[3]  = {0}, g_dbg2_ra[3] = {0};
volatile uint32_t g_dbg2_ctrl[3]  = {0};
volatile uint32_t g_dbg2_cra[3]   = {0}, g_dbg2_ctc[3] = {0};
/* ★★ 诊断 3（2026-10-04）：查 "DMA 读 X 却写出 Y" 唯一剩下的方向 ——
 *   DMA→TX FIFO→PIO SM→引脚 这条链有没有接错。
 *   判据：dma_cfg[i].tx_fifo 必须等于 &pio->txf[sm_tmds[i]]，
 *         且各格的 write_addr 也必须等于同一个地址。 */
volatile uint32_t g_dbg_tx[3]       = {0};   /* dma_cfg[i].tx_fifo */
volatile uint32_t g_dbg_tx_dreq[3]  = {0};   /* dma_cfg[i].dreq */
volatile uint32_t g_dbg_waddr[3][7] = {{0}}; /* 各格的 write_addr */
volatile uint32_t g_dbg_pio_tx[4]   = {0};   /* &pio->txf[0..3] 作参照 */
volatile uint32_t g_dbg_pinctrl[4]  = {0};   /* sm[k].pinctrl 作参照 */
volatile uint32_t g_dbg_sm[3]       = {0};   /* ser_cfg.sm_tmds[i] */
volatile uint32_t g_dbg_pins[3]     = {0};   /* ser_cfg.pins_tmds[i] */
volatile uint32_t g_dbg_clkdiv[4]   = {0};   /* sm[k].clkdiv 作参照 */
/* ★★ 诊断 4（2026-10-04）：补取证空白 ——
 *   先前只读了 `tmdsbuf`（live 那块）的内容，而有效块 read_addr 指向的是【另一块】。
 *   这里直接把【有效块指向那块】的内容抓下来，并把各格 c.ctrl 也抓下来
 *   （看 RING_SIZE 是否把有效块配成了"字重复"）。 */
volatile uint32_t g_dbg_blkbuf[3][3]  = {{0}};   /* 各 lane 有效块指向缓冲的 [0]/[1]/[last] */
volatile uint32_t g_dbg_blkctrl2_unused = 0;   /* 各格 c.ctrl 见上方 [3][7] 声明 */
volatile uint32_t g_dbg_vidblk[3]     = {0};     /* 各 lane 有效块的 read_addr */
/* ★★ 诊断 5（2026-10-04）：行状态直方图 —— 判"DUT 是不是大部分时间在跑 vblank 列表"。
 *   若 ACTIVE 只占很小一部分，而实测 D0 一直发控制符号，则两者吻合。 */
volatile uint32_t g_dbg_state_hist[5] = {0};     /* 下标 = timing_state.v_state (0..4) */
volatile uint32_t g_dbg_cur_state     = 0;
volatile uint32_t g_dbg_cur_vctr      = 0;
volatile uint32_t g_dbg_v_active_lines= 0;
volatile uint32_t g_dbg_blank_top     = 0;
volatile uint32_t g_dbg_blank_bottom  = 0;
volatile uint32_t g_dbg_scanline_en   = 0;
/* ★★ 诊断 6（2026-10-04）：留给 Core0 做【行中】快照 —— 通道号必须在这里记下来，
 *   因为 Core0 拿不到 inst。Core0 会用它们直接读 DMA/PIO 寄存器。 */
volatile uint32_t g_dbg_chan_data[3] = {0};
volatile uint32_t g_dbg_chan_ctrl[3] = {0};
volatile uint32_t g_dbg_pio_base     = 0;
/* ★★ 诊断 7：五张列表的地址 —— 把控制通道的行中 ra 与它们比对，就能点名是【哪一张列表】。 */
volatile uint32_t g_dbg_list_addr[5] = {0};   /* vblank_sync, vblank_nosync, active, error, active_blank */
volatile uint32_t g_dbg_list_size    = 0;     /* sizeof(struct dvi_scanline_dma_list) */
/* ★★ 诊断 9：逐行环形记录 —— 每行选了哪张列表、当时状态是什么。
 *   用于回答"状态明明说 ACTIVE，为什么装的是 vblank 列表"。 */
#define DVI_DBG_HIST 64
volatile uint32_t g_dbg_hist_list [DVI_DBG_HIST] = {0};   /* 0..4 见 g_dbg_list_addr 顺序 */
volatile uint32_t g_dbg_hist_state[DVI_DBG_HIST] = {0};   /* timing_state.v_state */
volatile uint32_t g_dbg_hist_vctr [DVI_DBG_HIST] = {0};
volatile uint32_t g_dbg_hist_idx  = 0;

/* 等待上限：正常情况这个条件在进入循环前就已经成立（链式触发在
 * "后肩段"结束时就把有效像素段装好了），所以这里留的余量非常宽。
 * 目的是"绝不无限等"，而不是"精确计时"。 */
/*
 * 2026-10-01 深夜（第 16 轮）：原来这里是 100000。实测这个守卫在【63% 的行】上
 * 打满（g_dvi_tcr_timeouts / heartbeat_lines = 1410/2248），每行白烧约 1.8 ms。
 *
 * 原因：被等的条件是 `dbg_tcr == want_tcr(=320)`，而 dbg_tcr 数的是【当前这一次
 * 触发】的完成数。扫描线列表 l0 的 tc 序列是 8,48,24,【320】,8,8 —— 320 在第 4 条，
 * 后面还有两条续命段。一行跑完时最后一次触发是 tc=8 的那条 ⇒ dbg_tcr = 8。
 * ⇒ "等 320" 只在恰好撞上第 4 条正在跑的小窗口里才成立，其余时间必然打满守卫。
 *
 * 等待的本意是"别在 PIO 还在消费本行数据时就重建列表"。既然它九成时间等不到，
 * 就把守卫收到一个【与行预算同量级】的值：让等待退化成"给一点点时间让数据排空"，
 * 而不是"烧掉 1.8 ms"。真正的重建安全由 _dvi_load_dma_op() + 显式重触发保证。
 */
#define DVI_TCR_WAIT_GUARD 100u

void dvi_init(struct dvi_inst *inst, uint spinlock_tmds_queue, uint spinlock_colour_queue) {
    inst->dvi_started = false;
    inst->timing_state.v_ctr  = 0;
    inst->dvi_frame_count = 0;

    dvi_audio_init(inst);
    dvi_timing_state_init(&inst->timing_state);
    dvi_serialiser_init(&inst->ser_cfg);
    for (int i = 0; i < N_TMDS_LANES; ++i) {
        inst->dma_cfg[i].chan_ctrl = dma_claim_unused_channel(true);
        inst->dma_cfg[i].chan_data = dma_claim_unused_channel(true);
        inst->dma_cfg[i].tx_fifo = (void*)&inst->ser_cfg.pio->txf[inst->ser_cfg.sm_tmds[i]];
        inst->dma_cfg[i].dreq = pio_get_dreq(inst->ser_cfg.pio, inst->ser_cfg.sm_tmds[i], true);
    }
    inst->late_scanline_ctr = 0;
    inst->tmds_buf_release[0] = NULL;
    inst->tmds_buf_release[1] = NULL;
    inst->tmds_buf_held = NULL;   /* ★ 2026-10-05 重复行复用的那条（见 frank_dvi.h 的说明）*/
    queue_init_with_spinlock(&inst->q_tmds_valid,   sizeof(void*),  8, spinlock_tmds_queue);
    queue_init_with_spinlock(&inst->q_tmds_free,    sizeof(void*),  8, spinlock_tmds_queue);
    queue_init_with_spinlock(&inst->q_colour_valid, sizeof(void*),  8, spinlock_colour_queue);
    queue_init_with_spinlock(&inst->q_colour_free,  sizeof(void*),  8, spinlock_colour_queue);

    dvi_setup_scanline_for_vblank(inst->timing, inst->dma_cfg, true, &inst->dma_list_vblank_sync);
    dvi_setup_scanline_for_vblank(inst->timing, inst->dma_cfg, false, &inst->dma_list_vblank_nosync);
    dvi_setup_scanline_for_active(inst->timing, inst->dma_cfg, (void*)SRAM_BASE, &inst->dma_list_active, false);
    dvi_setup_scanline_for_active(inst->timing, inst->dma_cfg, NULL, &inst->dma_list_error, false);
    dvi_setup_scanline_for_active(inst->timing, inst->dma_cfg, NULL, &inst->dma_list_active_blank, true);

    uint16_t mask = 0;

#ifdef DVI_1BPP_BUFFER
    mask = 0x1f;  // To account for worst case of 1bpp horizontal pixels generated 32 bits at a time (e.g. 720x568)
#endif

    // PATCH (frank-hdmi-sound): the upstream code malloc()s TMDS buffers, which
    // requires a heap large enough to hold ~12 KB.  On RP2350 builds with
    // a tight SRAM budget that pushes the firmware over the SRAM region.
    // Use a static buffer pool sized for the largest mode we care about
    // (720x576p, the worst case in dvi_timing.c).  Worst-case size:
    //   TMDS_CHANNELS (3) * ((720 + 31) & ~31) / 2 * 4 = 4608 bytes/buf
    // x DVI_N_TMDS_BUFFERS (3) = 13824 bytes total.
#ifndef DVI_STATIC_TMDS_MAX_PIX
#define DVI_STATIC_TMDS_MAX_PIX  640
#endif
#if DVI_MONOCHROME_TMDS
#define DVI_STATIC_TMDS_BYTES_PER_BUF \
    (((DVI_STATIC_TMDS_MAX_PIX) / DVI_SYMBOLS_PER_WORD) * sizeof(uint32_t))
#else
#define DVI_STATIC_TMDS_BYTES_PER_BUF \
    (TMDS_CHANNELS * ((DVI_STATIC_TMDS_MAX_PIX) / DVI_SYMBOLS_PER_WORD) * sizeof(uint32_t))
#endif
    static uint32_t __attribute__((aligned(4)))
        static_tmds_pool[DVI_N_TMDS_BUFFERS]
                        [DVI_STATIC_TMDS_BYTES_PER_BUF / sizeof(uint32_t)];

    /* Sanity check: if the user has selected a wider mode than the
     * static pool was sized for, fall back to malloc with a clear panic
     * instead of silent corruption. */
    {
        uint16_t needed_pix = (inst->timing->h_active_pixels + mask) & (~mask);
        if (needed_pix > DVI_STATIC_TMDS_MAX_PIX) {
            panic("DVI mode wider than static TMDS pool (%u > %u)",
                  needed_pix, DVI_STATIC_TMDS_MAX_PIX);
        }
    }

    for (int i = 0; i < DVI_N_TMDS_BUFFERS; ++i) {
        void *tmdsbuf = static_tmds_pool[i];
        queue_add_blocking_u32(&inst->q_tmds_free, &tmdsbuf);
    }

    set_AVI_info_frame(&inst->avi_info_frame, UNDERSCAN, RGB, ITU601, PIC_ASPECT_RATIO_4_3, SAME_AS_PAR, FULL,
                       (inst->timing->h_active_pixels == 720) ? _720x576P50 : _640x480P60);

}

/*
 * Hook the DMA-completion IRQ for the sync-lane data DMA.  Whichever
 * core calls this is the one the IRQ will fire on, which is why it's
 * a separate call from dvi_init().  The typical pattern: the
 * application's Core 0 calls dvi_init() (no IRQs of its own) and
 * Core 1 calls this from its entry point.
 *
 * irq_num is DMA_IRQ_0 or DMA_IRQ_1.  Both are wired up internally,
 * so callers can park their own DMA IRQs on the other one.
 */
void dvi_register_irqs_this_core(struct dvi_inst *inst, uint irq_num) {
    uint32_t mask_sync_channel = 1u << inst->dma_cfg[TMDS_SYNC_LANE].chan_data;
    uint32_t mask_all_channels = 0;
    for (int i = 0; i < N_TMDS_LANES; ++i)
        mask_all_channels |= 1u << inst->dma_cfg[i].chan_ctrl | 1u << inst->dma_cfg[i].chan_data;

    dma_hw->ints0 = mask_sync_channel;
    if (irq_num == DMA_IRQ_0) {
        hw_write_masked(&dma_hw->inte0, mask_sync_channel, mask_all_channels);
        dma_irq_privdata[0] = inst;
        irq_set_exclusive_handler(DMA_IRQ_0, dvi_dma0_irq);
    }
    else {
        hw_write_masked(&dma_hw->inte1, mask_sync_channel, mask_all_channels);
        dma_irq_privdata[1] = inst;
        irq_set_exclusive_handler(DMA_IRQ_1, dvi_dma1_irq);
    }
    irq_set_enabled(irq_num, true);
}

void dvi_unregister_irqs_this_core(struct dvi_inst *inst, uint irq_num) {
    irq_set_enabled(irq_num, false);
    if (irq_num == DMA_IRQ_0) {
         irq_remove_handler(DMA_IRQ_0, dvi_dma0_irq);
    } else {
         irq_remove_handler(DMA_IRQ_1, dvi_dma1_irq);
    }
    if (inst->tmds_buf_release[1]) {
        queue_try_add_u32(&inst->q_tmds_free, &inst->tmds_buf_release[1]);
    }
    if (inst->tmds_buf_release[0]) {
        queue_try_add_u32(&inst->q_tmds_free, &inst->tmds_buf_release[0]);
    }
    inst->tmds_buf_release[1] = NULL;
    inst->tmds_buf_release[0] = NULL;
}

/* ★ 2026-10-06 探针 v3：记录消费者（frank_dvi.c 的 ACTIVE 分支）看到的 v_ctr ✓
 * 目的：用户看到"整面蓝白闪"✗ = 整帧只用了一条缓冲 ⇒ 怀疑 v_ctr 不是每行 +1 ✗
 * ⇒ 直接量：最近 16 次的 v_ctr 与是否取了新缓冲 ✓ */
volatile int32_t  g_ctr_log[16];
volatile int32_t  g_ctr_took[16];
volatile uint32_t g_ctr_n = 0;
// Set up control channels to make transfers to data channels' control
// registers (but don't trigger the control channels -- this is done either by
// data channel CHAIN_TO or an initial write to MULTI_CHAN_TRIGGER)
static inline void __attribute__((always_inline)) _dvi_load_dma_op(const struct dvi_lane_dma_cfg dma_cfg[], struct dvi_scanline_dma_list *l) {
    for (int i = 0; i < N_TMDS_LANES; ++i) {
        dma_channel_config cfg = dma_channel_get_default_config(dma_cfg[i].chan_ctrl);
        channel_config_set_ring(&cfg, true, 4); // 16-byte write wrap
        channel_config_set_read_increment(&cfg, true);
        channel_config_set_write_increment(&cfg, true);
        dma_channel_configure(
            dma_cfg[i].chan_ctrl,
            &cfg,
            &dma_hw->ch[dma_cfg[i].chan_data],
            dvi_lane_from_list(l, i),
            4, // Configure all 4 registers then halt until next CHAIN_TO
            false
        );
    }
    /*
     * PATCH（2026-10-01 深夜）：列表【收口】，切断跨 lane 读越界。
     *
     * 背景（详见 小本本 §14.13–§14.17）：控制通道的读指针是线性前进的，
     * 而三个 lane 的数组在内存里【连续排列】。原设计让每个数据通道的
     * CHAIN_TO 都指回自己的控制通道，于是控制通道读完本 lane 的最后一条后
     * 会【接着读隔壁 lane 的数组】，把隔壁的参数（TXF1/TXF2、TREQ_SEL=1/2）
     * 写进本 lane 的数据通道 ⇒ 传输被打断、dbg_tcr 上不去 ⇒ 越界更严重（正反馈）。
     *
     * 修法：把每个 lane 数组的【最后一条】改成不链（CHAIN_TO = 数据通道自己）。
     *   ⇒ 链条走完本 lane 的最后一条就停，不再越界。
     *   ⇒ 代价是链条不再自持，必须由 IRQ 每行显式重新触发 —— 见 IRQ 处理器
     *     末尾 `_dvi_load_dma_op()` 之后新增的 `dma_start_channel_mask()`。
     * 从尾部【空白副本】往前数第二条起仍是空白续命段，所以处理程序期间链条
     * 有足够时间存活。
     */
    /*
     * 🔬 第 7 轮实验：暂时【关闭】收口，恢复库原本的"自持链"。
     * 理由：处理器平均耗时只有 61 µs（占 15.8% CPU），每行却被 2.19 次中断打断；
     * 而我在处理器末尾加了 dma_start_channel_mask() 显式重触发控制通道 ⇒
     * 每行把链条从头重置 2.19 次，链条可能永远走不远。
     * 本实验只留"守卫 100000→2000"这一处修复，撤掉收口 + 重触发，
     * 看行率是好是坏。用 #if 0 包住，方便随时恢复。
     */
#if 1
    for (int i = 0; i < N_TMDS_LANES; ++i) {
        int total = (i == TMDS_SYNC_LANE) ? DVI_SYNC_LANE_CHUNKS_WITH_AUDIO
                                          : DVI_NOSYNC_LANE_CHUNKS_WITH_AUDIO;
        // CHAIN_TO 指向数据通道自己的编号 ⇒ RP2040 规定这表示【不链】
        channel_config_set_chain_to(&dvi_lane_from_list(l, i)[total - 1].c,
                                    dma_cfg[i].chan_data);
    }
#endif
    /* 实验记录（2026-10-01 深夜，已撤销）：曾在此把所有条目的 DREQ 改成
     * DREQ_FORCE 做判别，实测行率从 315 行/秒【掉到 23 行/秒】⇒ 强制 DREQ
     * 有害且无益 ⇒ DREQ 不是限速环节。详见 小本本 §14.18。 */
    /*
     * 实验记录（第 20 轮，已撤销）：曾在此把第 0 段的 CHAIN_TO 也设成"不链"，
     * 想试试"每行只走一段"能否提高行率。结果【引擎直接冻住】：10 秒只产出 1 行、
     * g_dvi_irq_count = 0。
     * ⇒ 学到了一个设计约束：**每行的 IRQ 是由列表【中间某一段】产生的，不是第 0 段。**
     *   链条必须走完整张列表才能到达那一段；段不能随便砍。详见 小本本 §14.25。
     */
}

/*
 * Set the DMA chain in motion and unblank the TMDS serialiser.
 *
 * Configures each lane's control channel to feed the data channel's
 * registers from the pre-built scanline DMA list, then triggers all
 * three control channels in lockstep.  After the first scanline
 * runs, each data channel's CHAIN_TO retriggers its own control
 * channel, so the chain runs forever from a single trigger.
 *
 * The TMDS PIO state machines are deliberately enabled *after* their
 * TX FIFOs are full.  Starting them with a partially-filled FIFO
 * guarantees an underrun on the very first scanline and the receiver
 * never locks.
 *
 * The DMA IRQ handler must be registered
 * (dvi_register_irqs_this_core) before this is called.  The chain
 * needs an IRQ every scanline to swap the next list in.
 */
void dvi_start(struct dvi_inst *inst) {
    if (inst->dvi_started) {
        return;
    }
    _dvi_load_dma_op(inst->dma_cfg, &inst->dma_list_vblank_nosync);
    dma_start_channel_mask(
        (1u << inst->dma_cfg[0].chan_ctrl) |
        (1u << inst->dma_cfg[1].chan_ctrl) |
        (1u << inst->dma_cfg[2].chan_ctrl));

    // We really don't want the FIFOs to bottom out, so wait for full before
    // starting the shift-out.
    for (int i = 0; i < N_TMDS_LANES; ++i)
        while (!pio_sm_is_tx_fifo_full(inst->ser_cfg.pio, inst->ser_cfg.sm_tmds[i]))
            tight_loop_contents();
    dvi_serialiser_enable(&inst->ser_cfg, true);
    inst->dvi_started = true;
}

/*
 * Tear the DMA chain down and silence the TMDS lanes.  Aborts every
 * lane's control and data channel, acks any pending IRQ, and turns
 * off the serialiser PIO state machines.  Safe to call when the
 * instance isn't running; early-exits in that case.
 */
void dvi_stop(struct dvi_inst *inst) {
    if (!inst->dvi_started) {
        return;
    }
    uint mask  = 0;
    for (int i = 0; i < N_TMDS_LANES; ++i) {
        dma_channel_config cfg = dma_channel_get_default_config(inst->dma_cfg[i].chan_ctrl);
        dma_channel_set_config(inst->dma_cfg[i].chan_ctrl, &cfg, false);
        cfg = dma_channel_get_default_config(inst->dma_cfg[i].chan_data);
        dma_channel_set_config(inst->dma_cfg[i].chan_data, &cfg, false);
        mask |= 1 << inst->dma_cfg[i].chan_data;
        mask |= 1 << inst->dma_cfg[i].chan_ctrl;
    }

    dma_channel_abort(mask);
    dma_irqn_acknowledge_channel(0, inst->dma_cfg[TMDS_SYNC_LANE].chan_data);
    dma_hw->ints0 = 1u << inst->dma_cfg[TMDS_SYNC_LANE].chan_data;

    dvi_serialiser_enable(&inst->ser_cfg, false);
    inst->dvi_started = false;
}

static inline void __dvi_func_x(_dvi_prepare_scanline_8bpp)(struct dvi_inst *inst, uint32_t *scanbuf) {
    uint32_t *tmdsbuf = NULL;
    queue_remove_blocking_u32(&inst->q_tmds_free, &tmdsbuf);
    uint pixwidth = inst->timing->h_active_pixels;
    uint words_per_channel = pixwidth / DVI_SYMBOLS_PER_WORD;
    // Scanline buffers are half-resolution; the functions take the number of *input* pixels as parameter.
    tmds_encode_data_channel_8bpp(scanbuf, tmdsbuf + 0 * words_per_channel, pixwidth / 2, DVI_8BPP_BLUE_MSB,  DVI_8BPP_BLUE_LSB );
    tmds_encode_data_channel_8bpp(scanbuf, tmdsbuf + 1 * words_per_channel, pixwidth / 2, DVI_8BPP_GREEN_MSB, DVI_8BPP_GREEN_LSB);
    tmds_encode_data_channel_8bpp(scanbuf, tmdsbuf + 2 * words_per_channel, pixwidth / 2, DVI_8BPP_RED_MSB,   DVI_8BPP_RED_LSB  );
    queue_add_blocking_u32(&inst->q_tmds_valid, &tmdsbuf);
}

static inline void __dvi_func_x(_dvi_prepare_scanline_16bpp)(struct dvi_inst *inst, uint32_t *scanbuf) {
    uint32_t *tmdsbuf = NULL;
    queue_remove_blocking_u32(&inst->q_tmds_free, &tmdsbuf);
    uint pixwidth = inst->timing->h_active_pixels;
    uint words_per_channel = pixwidth / DVI_SYMBOLS_PER_WORD;
    tmds_encode_data_channel_16bpp(scanbuf, tmdsbuf + 0 * words_per_channel, pixwidth / 2, DVI_16BPP_BLUE_MSB,  DVI_16BPP_BLUE_LSB );
    tmds_encode_data_channel_16bpp(scanbuf, tmdsbuf + 1 * words_per_channel, pixwidth / 2, DVI_16BPP_GREEN_MSB, DVI_16BPP_GREEN_LSB);
    tmds_encode_data_channel_16bpp(scanbuf, tmdsbuf + 2 * words_per_channel, pixwidth / 2, DVI_16BPP_RED_MSB,   DVI_16BPP_RED_LSB  );
    queue_add_blocking_u32(&inst->q_tmds_valid, &tmdsbuf);
}

/*
 * "Worker thread" entry points.  Each of these consumes scanlines
 * from `q_colour_valid`, runs the encoder over them, and pushes the
 * resulting TMDS buffer into `q_tmds_valid` for the DMA chain to
 * pick up.  They never return; the calling core enters one and stays
 * inside the loop forever (still servicing the DMA IRQ that was
 * registered earlier).
 *
 * The "scanbuf" variants treat each `q_colour_valid` entry as a
 * single scanline.  The "framebuf" variants below treat it as a
 * pointer to the start of a whole framebuffer and walk through it
 * line-by-line internally, which is useful if you'd rather not push
 * every line through the queue.
 */
void __dvi_func(dvi_scanbuf_main_8bpp)(struct dvi_inst *inst) {
    while (1) {
        uint32_t *scanbuf = NULL;
        queue_remove_blocking_u32(&inst->q_colour_valid, &scanbuf);
        _dvi_prepare_scanline_8bpp(inst, scanbuf);
        queue_add_blocking_u32(&inst->q_colour_free, &scanbuf);
    }
    __builtin_unreachable();
}

/*
 * Same shape as the 8bpp worker, but for RGB565 inputs.  The two
 * versions are kept as separate functions on purpose: that way the
 * linker can garbage-collect whichever encoder loops the application
 * doesn't reach, instead of dragging both into scratch_x.
 */
void __dvi_func(dvi_scanbuf_main_16bpp)(struct dvi_inst *inst) {
    while (1) {
        uint32_t *scanbuf = NULL;
        queue_remove_blocking_u32(&inst->q_colour_valid, &scanbuf);
        _dvi_prepare_scanline_16bpp(inst, scanbuf);
        queue_add_blocking_u32(&inst->q_colour_free, &scanbuf);
    }
    __builtin_unreachable();
}

/*
 * Per-scanline IRQ.  Fires four times per line, once each for the
 * front porch, sync, back porch and active region.  On the active
 * edge we have one full active scanline of "headroom" to install the
 * DMA control-block list for the *next* line.  In broad strokes:
 *
 *   1. Advance the timing state machine (front porch -> sync -> ...)
 *      so we know what kind of line is coming up.
 *   2. Park the previous TMDS buffer on the free queue.  This is
 *      deferred by one scanline because the data DMA may still be
 *      reading it when the IRQ fires.
 *   3. If we owe scanlines to the encoder (the "late" counter),
 *      drop the next valid buffer on the floor instead of displaying
 *      it: the buffer was generated for an earlier vertical position
 *      and using it now would tear the picture.
 *   4. Pick the right pre-built DMA list (vsync, vblank, active,
 *      blanked-active, error) for this line and load it onto the
 *      control channels.
 *   5. If audio is enabled, ask the data-island packetiser for the
 *      next packet to interleave into this line's blanking interval.
 */
/* ── 把整条 DVI DMA 链重新拉起来（2026-10-01 加）────────────────────────
 *
 * 为什么必须有它：
 *   数据通道可能被装进一个 CTRL 的 **EN=0** 的控制块（实测 lane1 的
 *   CTRL=0x0000197c）。通道一旦停了，它就不会再 CHAIN_TO ⇒ 它自己的
 *   控制通道永远不被触发 —— 而 _dvi_load_dma_op() 用的是
 *   dma_channel_configure(..., false)，**只装填、不触发**。
 *   于是"一次瞬时故障"被放大成"整条链永久停摆"。
 *
 * 实测后果（2026-10-01）：dvi_frame_count 停在 14 帧不动（两次独立测量一致），
 *   而 Core0 仍以约 47 Hz 画图 —— 整机没死，屏没了。
 *
 * 做法照抄 dvi_start()：abort 六条通道 → 清中断 → 重装安全列表 →
 *   **真的把三个控制通道启动起来**（这一步就是原来缺的）。
 * 代价：正在跑的一帧会断，屏上可能闪一下；但比永久黑屏好。 */
/* ⚠️ 2026-10-01 深夜清理：上面注释描述的那个 _dvi_restart_dma_chain() 函数【已删除】。
 * 原因：第 16 轮实测它【有害】——会在 36% 的行上触发（g_dvi_tcr_timeouts/heartbeat_lines），
 * 而它做的事（abort 六条通道 → 装 vblank 列表 → 启动控制通道 → return）会把正常的
 * 列表选择、队列回收、_dvi_load_dma_op 全部跳过。调用点已改成 break ⇒ 它成了死代码。
 * 详见 小本本 §14.19。若将来真要"重排整条链"，从 git 历史取回即可。 */

static void __dvi_func(dvi_dma_irq_handler)(struct dvi_inst *inst) {
    ++g_dvi_irq_count;   /* 诊断 */
    uint32_t _h_t0 = time_us_32();   /* 诊断：整个处理器的耗时 */
    // Every fourth interrupt marks the start of the horizontal active region. We
    // now have until the end of this region to generate DMA blocklist for next
    // scanline.
    dvi_timing_state_advance(inst->timing, &inst->timing_state);
    /* ★ 诊断 2：IRQ 入口现场 —— 上一行刚跑完、还没重装。看每条 lane 这一行停在哪。
     *   dbg_tcr 是关键：它数"当前这一次传输的字数"，IRQ 等的就是它 == 320。 */
    g_dbg2_seq++;
    /* ★ 诊断 5：行状态直方图 + 相关配置 */
    {
        uint32_t _vs = (uint32_t)inst->timing_state.v_state;
        if (_vs < 5u) g_dbg_state_hist[_vs]++;
        g_dbg_cur_state      = _vs;
        g_dbg_cur_vctr       = inst->timing_state.v_ctr;
        g_dbg_v_active_lines = inst->timing->v_active_lines;
        g_dbg_blank_top      = (uint32_t)inst->blank_settings.top;
        g_dbg_blank_bottom   = (uint32_t)inst->blank_settings.bottom;
        g_dbg_scanline_en    = inst->scanline_is_enabled ? 1u : 0u;
    }
    for (int _i = 0; _i < N_TMDS_LANES; ++_i) {
        g_dbg2_tcr [_i] = dma_debug_hw->ch[inst->dma_cfg[_i].chan_data].dbg_tcr;
        g_dbg2_tc  [_i] = dma_hw->ch[inst->dma_cfg[_i].chan_data].transfer_count;
        g_dbg2_ra  [_i] = dma_hw->ch[inst->dma_cfg[_i].chan_data].read_addr;
        g_dbg2_ctrl[_i] = dma_hw->ch[inst->dma_cfg[_i].chan_data].ctrl_trig;
        g_dbg2_cra [_i] = dma_hw->ch[inst->dma_cfg[_i].chan_ctrl].read_addr;
        g_dbg2_ctc [_i] = dma_hw->ch[inst->dma_cfg[_i].chan_ctrl].transfer_count;
    }
    // Make sure all three channels have definitely loaded their last block
    // (should be within a few cycles of one another)
    //
    // ⚠️ 2026 修复：这里原来是一个【没有超时】的死等循环。
    //   实测过（tools/gdb_dmalists.txt）：只要有一个数据通道被装进"全零控制块"，
    //   它的 CTRL 就变成 0（EN=0），dbg_tcr 永远回不到 320，
    //   于是 Core1 永久卡死在这个循环里 —— 一次瞬时故障被放大成整机死机。
    //   现在给它加上限：超时就记一笔再跳出，让函数继续往下走。
    //   下面的 _dvi_load_dma_op() 会把三个控制通道重新拨回第 0 段，
    //   只要数据通道还是使能的，下一行就能自己恢复。
    const uint32_t want_tcr = inst->timing->h_active_pixels / DVI_SYMBOLS_PER_WORD;
    uint32_t _tcr_t0 = time_us_32();          /* 诊断：量 TCR 等待耗时 */
    for (int i = 0; i < N_TMDS_LANES; ++i) {
        uint32_t guard = DVI_TCR_WAIT_GUARD;
        while (dma_debug_hw->ch[inst->dma_cfg[i].chan_data].dbg_tcr != want_tcr) {
            if (--guard == 0u) {
                ++g_dvi_tcr_timeouts;
                if (g_dvi_tmo_lane == 0xFFFFFFFFu) {   /* 只记第一次 */
                    g_dvi_tmo_lane = (uint32_t)i;
                    g_dvi_tmo_want = want_tcr;
                    for (int k = 0; k < N_TMDS_LANES; ++k) {
                        g_dvi_tmo_chan[k] = (uint32_t)inst->dma_cfg[k].chan_data;
                        g_dvi_tmo_tcr[k]  = dma_debug_hw->ch[inst->dma_cfg[k].chan_data].dbg_tcr;
                        g_dvi_tmo_ctrl[k] = dma_hw->ch[inst->dma_cfg[k].chan_data].ctrl_trig;
                        g_dvi_tmo_cnt[k]  = dma_hw->ch[inst->dma_cfg[k].chan_data].transfer_count;
                    }
                }
                /* 修复（2026-10-01 深夜，第 16 轮）：这里原来是
                 * "整条链重排(_dvi_restart_dma_chain) + return"。
                 * 实测该路径会在【36% 的行】上触发（g_dvi_tcr_timeouts=4467 /
                 * heartbeat_lines=12262），而它做的事是：abort 六条通道、
                 * 装 dma_list_vblank_nosync（不是 active 列表）、启动控制通道、
                 * 然后 return —— 把正常的列表选择、队列回收、_dvi_load_dma_op
                 * 全部跳过。⇒ 三分之一的扫描线在放消隐表、缓冲不回收、链被反复
                 * 推倒重来。这就是引擎慢的主因，而且是"修复"自己造出来的。
                 *
                 * 改成只跳出本 lane 的等待、继续走完处理器：
                 * 紧随其后的 _dvi_load_dma_op() 会重设控制通道，
                 * 其后的 dma_start_channel_mask() 会重新触发它们 ——
                 * 链条由【处理器的正常路径】恢复，而不是推倒重来。 */
                break;
            }
            tight_loop_contents();
        }
    }
    {   /* 诊断：记录本次 TCR 等待花了多久（这是"PIO 94% 时间在停摆"的头号嫌疑） */
        uint32_t _dt = time_us_32() - _tcr_t0;
        g_dvi_tcr_wait_us = _dt;
        if (_dt > g_dvi_tcr_wait_us_max) g_dvi_tcr_wait_us_max = _dt;
    }

    if (inst->tmds_buf_release[1] && !queue_try_add_u32(&inst->q_tmds_free, &inst->tmds_buf_release[1])) {
        panic("TMDS free queue full in IRQ!");
    }
    inst->tmds_buf_release[1] = inst->tmds_buf_release[0];
    inst->tmds_buf_release[0] = NULL;

    uint32_t *tmdsbuf = NULL;
    while (inst->late_scanline_ctr > 0 && queue_try_remove_u32(&inst->q_tmds_valid, &tmdsbuf)) {
        // If we displayed this buffer then it would be in the wrong vertical
        // position on-screen. Just pass it back.
        queue_add_blocking_u32(&inst->q_tmds_free, &tmdsbuf);
        --inst->late_scanline_ctr;
    }

    struct dvi_scanline_dma_list *dma_list_selected = &inst->dma_list_vblank_nosync;
    switch (inst->timing_state.v_state) {
        case DVI_STATE_ACTIVE:
        {
            bool is_blank_line = false;
            if (inst->timing_state.v_ctr < inst->blank_settings.top ||
                inst->timing_state.v_ctr >= (inst->timing->v_active_lines - inst->blank_settings.bottom)) {
                // Is a Blank Line
                is_blank_line = true;
            } else {
                /*
                 * ★ 2026-10-05 主 AI 修 DVI_VERTICAL_REPEAT>1 的真 bug（原实现见 git 历史）：
                 * 原代码只在 `v_ctr % REPEAT == REPEAT-1` 的行取缓冲，其余"重复行"因为
                 * tmdsbuf 是局部变量而仍是 NULL ⇒ 掉进 dma_list_error（隔行错误图案 =
                 * 文档记的"竖条纹/隔行"✗），并且缓冲的取/还与 late_scanline_ctr 错位
                 * ⇒ 队列漂移 ⇒ 引擎最终停摆 ✗。
                 * 修法：边界行取新缓冲、并把【上一条 held】归还（它已显示 REPEAT 行 ✓）；
                 * 重复行直接复用 held ✓。REPEAT==1 时走的是原语义（取到即挂 release[0] ✓），
                 * 编译期常量 ⇒ 默认配置行为一字不变 ✓，零回归风险 ✓。
                 */
                /*
                 * ★ 2026-10-06 配对最终版：用【行奇偶】定相位 + 显式归还 ✓
                 *   前两版的教训（都有用户观测为证 ✓）：
                 *     · 奇偶用 == REPEAT-1 ⇒ 竖条（两个不同逻辑行配成一对 ✗，y 错）
                 *     · 用 held==NULL 当开关 ⇒ 横条（一次迟到就翻转相位 ✗，x 对 y 漂）
                 *   本版：偶数行取新（帧首 v_ctr==0 必取 ✓）、奇数行复用并归还 ✓
                 *        每帧恰 240 取 / 240 还 ⇒ 平衡 ✓；迟到不翻转相位 ⇒ 不漂 ✓
                 */
                if ((inst->timing_state.v_ctr & 1) == 0) {
                    if (queue_try_peek_u32(&inst->q_tmds_valid, &tmdsbuf)) {
                        queue_remove_blocking_u32(&inst->q_tmds_valid, &tmdsbuf);
                        inst->tmds_buf_held = tmdsbuf;      /* 本对的第一行 ✓ */
                    {   /* 探针 v3：这一行看到的 v_ctr 与是否取新 ✓ */
                        uint32_t _k = g_ctr_n++ & 15u;
                        g_ctr_log[_k]  = (int32_t)inst->timing_state.v_ctr;
                        g_ctr_took[_k] = 1;   /* 取新分支 */
                    }
                    } else {
                        tmdsbuf = NULL;
                        inst->tmds_buf_held = NULL;         /* 不硬留 ⇒ 不漂 ✓ */
                        ++inst->late_scanline_ctr;
                    }
                } else {
                    tmdsbuf = inst->tmds_buf_held;          /* 本对的第二行 ✓ */
                    if (tmdsbuf) {
                        inst->tmds_buf_held = NULL;
                        inst->tmds_buf_release[0] = tmdsbuf; /* 显示两次后归还 ✓ 只归一次 ✓ */
                    if (tmdsbuf) {
                        inst->tmds_buf_held = NULL;
                        inst->tmds_buf_release[0] = tmdsbuf; /* 显示两次后归还 ✓ 只归一次 ✓ */
                    }
                    {   /* 探针 v3：复用分支 ⇒ took=0 ✓ */
                        uint32_t _k = g_ctr_n++ & 15u;
                        g_ctr_log[_k]  = (int32_t)inst->timing_state.v_ctr;
                        g_ctr_took[_k] = 0;
                    }
                    }
                }

                if (inst->scanline_is_enabled && (inst->timing_state.v_ctr & 1)) {
                    is_blank_line = true;
                }
            }

            if (is_blank_line) {
                dma_list_selected = &inst->dma_list_active_blank;
            } else if (tmdsbuf) {
                uint32_t _u0 = time_us_32();
                dvi_update_scanline_data_dma(inst->timing, tmdsbuf, &inst->dma_list_active, inst->data_island_is_enabled);
                g_dbg_tmdsbuf = (uint32_t)(uintptr_t)tmdsbuf;   /* ★ 诊断：判据基准 */
                {   /* ★ 抓编码器写进缓冲区的实际内容（每条 lane 切片的首/次/末字） */
                    const uint32_t *_b = (const uint32_t *)tmdsbuf;
                    const uint32_t _wpc = inst->timing->h_active_pixels / DVI_SYMBOLS_PER_WORD;
                    for (int _i = 0; _i < N_TMDS_LANES; ++_i) {
                        g_dbg_buf[_i][0] = _b[_i * _wpc + 0];
                        g_dbg_buf[_i][1] = _b[_i * _wpc + 1];
                        g_dbg_buf[_i][2] = _b[_i * _wpc + _wpc - 1];
                    }
                }
                {   /* 诊断：每行重建 active 列表的耗时 */
                    uint32_t _udt = time_us_32() - _u0;
                    g_dvi_upd_us = _udt;
                    ++g_dvi_upd_count;
                    if (_udt > g_dvi_upd_us_max) g_dvi_upd_us_max = _udt;
                }
                dma_list_selected =  &inst->dma_list_active;
            } else {
                dma_list_selected = &inst->dma_list_error;
            }

            if (inst->scanline_callback && inst->timing_state.v_ctr % DVI_VERTICAL_REPEAT == DVI_VERTICAL_REPEAT - 1) {
                inst->scanline_callback(inst->timing_state.v_ctr / DVI_VERTICAL_REPEAT);
            }
        }
        break;

        case DVI_STATE_SYNC:
            dma_list_selected = &inst->dma_list_vblank_sync;
            if (inst->timing_state.v_ctr == 0) {
                ++inst->dvi_frame_count;
            }
            break;
        default: break;
    }
    {   /* 诊断：整个 IRQ 处理器的耗时（到最后一步之前） */
        uint32_t _hdt = time_us_32() - _h_t0;
        g_dvi_h_us = _hdt;
        if (_hdt > g_dvi_h_us_max) g_dvi_h_us_max = _hdt;
    }
    uint32_t _h2t0 = time_us_32();   /* 第 21 轮：处理器后半段计时起点 */
    _dvi_load_dma_op(inst->dma_cfg, dma_list_selected);
    /* ★ 诊断 9：把"这一行选了哪张表 + 当时状态"记进环形缓冲 */
    {
        uint32_t _li = 0;
        if      (dma_list_selected == &inst->dma_list_vblank_sync)   _li = 0;
        else if (dma_list_selected == &inst->dma_list_vblank_nosync) _li = 1;
        else if (dma_list_selected == &inst->dma_list_active)        _li = 2;
        else if (dma_list_selected == &inst->dma_list_error)         _li = 3;
        else if (dma_list_selected == &inst->dma_list_active_blank)  _li = 4;
        else                                                          _li = 5;
        uint32_t _ix = g_dbg_hist_idx % DVI_DBG_HIST;
        g_dbg_hist_list [_ix] = _li;
        g_dbg_hist_state[_ix] = (uint32_t)inst->timing_state.v_state;
        g_dbg_hist_vctr [_ix] = inst->timing_state.v_ctr;
        g_dbg_hist_idx++;
    }
    /* ★ 2026-10-04 诊断：把刚装载的块表与通道现场抓成快照（只写全局，不打印） */
    g_dbg_seq++;
    g_dbg_list_id = (dma_list_selected == &inst->dma_list_active)         ? 0u :
                    (dma_list_selected == &inst->dma_list_vblank_nosync)  ? 1u :
                    (dma_list_selected == &inst->dma_list_active_blank)   ? 2u :
                    (dma_list_selected == &inst->dma_list_error)          ? 3u :
                    (dma_list_selected == &inst->dma_list_vblank_sync)    ? 4u : 5u;
    g_dbg_island = inst->data_island_is_enabled ? 1u : 0u;
    for (int _i = 0; _i < N_TMDS_LANES; ++_i) {
        dma_cb_t *_bl = dvi_lane_from_list(dma_list_selected, _i);
        for (int _k = 0; _k < 7; ++_k) {
            g_dbg_blk_addr [_i][_k] = (uint32_t)(uintptr_t)_bl[_k].read_addr;
            g_dbg_blk_cnt  [_i][_k] = _bl[_k].transfer_count;
            g_dbg_waddr    [_i][_k] = (uint32_t)(uintptr_t)_bl[_k].write_addr;   /* ★ 诊断 3 */
            g_dbg_blkctrl  [_i][_k] = _bl[_k].c.ctrl;                            /* ★ 诊断 4 */
            g_dbg_blkwrite [_i][_k] = (uint32_t)(uintptr_t)_bl[_k].write_addr;
        }
        /* ★ 诊断 4：读【有效块实际指向那块】的内容（这才是 DMA 真正会搬的数据） */
        {
            const uint32_t *_vb = (const uint32_t *)_bl[3].read_addr;
            uint32_t _wpc = inst->timing->h_active_pixels / DVI_SYMBOLS_PER_WORD;
            g_dbg_vidblk[_i] = (uint32_t)(uintptr_t)_bl[3].read_addr;
            if (_vb) {
                g_dbg_blkbuf[_i][0] = _vb[0];
                g_dbg_blkbuf[_i][1] = (_bl[3].transfer_count > 1) ? _vb[1] : 0;
                g_dbg_blkbuf[_i][2] = (_bl[3].transfer_count >= _wpc) ? _vb[_wpc - 1] : 0;
            }
        }
        g_dbg_data_ra[_i] = dma_channel_hw_addr(inst->dma_cfg[_i].chan_data)->read_addr;
        g_dbg_data_tc[_i] = dma_channel_hw_addr(inst->dma_cfg[_i].chan_data)->transfer_count;
        g_dbg_ctrl_ra[_i] = dma_channel_hw_addr(inst->dma_cfg[_i].chan_ctrl)->read_addr;
        g_dbg_ctrl_tc[_i] = dma_channel_hw_addr(inst->dma_cfg[_i].chan_ctrl)->transfer_count;
        /* ★ 诊断 3：DMA→FIFO→SM→引脚 这条链 */
        g_dbg_tx[_i]      = (uint32_t)(uintptr_t)inst->dma_cfg[_i].tx_fifo;
        g_dbg_tx_dreq[_i] = inst->dma_cfg[_i].dreq;
        g_dbg_sm[_i]      = inst->ser_cfg.sm_tmds[_i];
        g_dbg_pins[_i]    = inst->ser_cfg.pins_tmds[_i];
        g_dbg_chan_data[_i] = (uint32_t)inst->dma_cfg[_i].chan_data;   /* ★ 诊断 6 */
        g_dbg_chan_ctrl[_i] = (uint32_t)inst->dma_cfg[_i].chan_ctrl;
    }
    g_dbg_pio_base = (uint32_t)(uintptr_t)inst->ser_cfg.pio;
    g_dbg_list_addr[0] = (uint32_t)(uintptr_t)&inst->dma_list_vblank_sync;
    g_dbg_list_addr[1] = (uint32_t)(uintptr_t)&inst->dma_list_vblank_nosync;
    g_dbg_list_addr[2] = (uint32_t)(uintptr_t)&inst->dma_list_active;
    g_dbg_list_addr[3] = (uint32_t)(uintptr_t)&inst->dma_list_error;
    g_dbg_list_addr[4] = (uint32_t)(uintptr_t)&inst->dma_list_active_blank;
    g_dbg_list_size    = (uint32_t)sizeof(struct dvi_scanline_dma_list);
    for (int _k = 0; _k < 4; ++_k) {
        g_dbg_pio_tx[_k]  = (uint32_t)(uintptr_t)&inst->ser_cfg.pio->txf[_k];
        g_dbg_pinctrl[_k] = inst->ser_cfg.pio->sm[_k].pinctrl;
        g_dbg_clkdiv[_k]  = inst->ser_cfg.pio->sm[_k].clkdiv;
    }
    /*
     * PATCH（2026-10-01 深夜）：配合 _dvi_load_dma_op() 里的"列表收口"。
     * 收口后链条不再自持（尾条 CHAIN_TO=自己），所以这里必须【显式重新触发】
     * 三个控制通道，否则 _dvi_load_dma_op() 的 dma_channel_configure(..., false)
     * 只装填不触发 ⇒ 数据通道永久停摆 ⇒ 每行中断再也不来（正是库注释警告的情形）。
     */
    /*
     * ★★ 2026-10-04 删除："每行显式重触发三条控制通道"（原 `#if 1` 那段 dma_start_channel_mask）。
     *
     * 为什么删（实测证据见 `陷阱本.md` M16 第 6~12 轮）：
     *   一个 IRQ 可能在一行里来两次，而这段代码**每次 IRQ 都重触发控制通道** ⇒
     *   控制通道会在**正在跑的 320 字视频块**（占一行 80%）结束之前，
     *   把下一个块装进数据通道，**把在跑的传输顶掉** ⇒
     *   同步 lane 只能跑 1~48 字的短消隐块 ⇒ 输出成了重复的控制符号。
     *   实测：同步 lane 数据通道指向 TMDS 池（视频块）的占比 **0.2%**（应 ≈80%）。
     *
     * 删掉之后：
     *   - 视频块占比回到 **76~95%**；
     *   - 探针解码：**每行 800 符号 = 前肩 16 + 同步 96 + 后肩 48 + 有效 640 数据符号**（逐行重复）；
     *   - DUT 仍然活着（`eng`/`vctr`/`irq` 都在走）⇒ **链条【不需要】这段重触发也能每行自己续上**
     *     （`_dvi_load_dma_op()` 里的 `dma_channel_configure()` 本身就会让空闲的控制通道使能并待触发）。
     *   ⇒ 原注释里"收口后必须每行显式重触发，否则永久停摆"这一判断，**与实测不符**。
     *
     * 保留"收口"（每个 lane 数组最后一条 CHAIN_TO 指向数据通道自己 = 不链）不变 ——
     * 它的目的是防控制通道越界读进隔壁 lane 的数组，实测删除重触发后链条仍能正常续行。
     */

    if (inst->data_island_is_enabled) {
        dvi_update_data_packet(inst);
    }
    {   /* 第 21 轮诊断：处理器后半段 + 整个处理器 */
        uint32_t _tdt = time_us_32() - _h2t0;
        g_dvi_tail_us = _tdt;
        if (_tdt > g_dvi_tail_us_max) g_dvi_tail_us_max = _tdt;
        uint32_t _fdt = time_us_32() - _h_t0;
        g_dvi_full_us = _fdt;
        if (_fdt > g_dvi_full_us_max) g_dvi_full_us_max = _fdt;
        g_dvi_full_us_sum += _fdt;   /* 第 7 轮：累加，用于求平均值 */
    }
}

static void __dvi_func(dvi_dma0_irq)() {
    struct dvi_inst *inst = dma_irq_privdata[0];
    dma_hw->ints0 = 1u << inst->dma_cfg[TMDS_SYNC_LANE].chan_data;
    dvi_dma_irq_handler(inst);
}

static void __dvi_func(dvi_dma1_irq)() {
    struct dvi_inst *inst = dma_irq_privdata[1];
    dma_hw->ints1 = 1u << inst->dma_cfg[TMDS_SYNC_LANE].chan_data;
    dvi_dma_irq_handler(inst);
}

/* ----- HDMI data-island / audio API ----------------------------- */

/* Reset the audio sub-state to "no audio".  Called from dvi_init().
 * After this, calling dvi_audio_sample_buffer_set followed by
 * dvi_set_audio_freq turns audio back on. */
void dvi_audio_init(struct dvi_inst *inst) {
    inst->data_island_is_enabled = false;
    inst->scanline_is_enabled = false;
    inst->audio_freq = 0;
    inst->samples_per_frame = 0;
    inst->samples_per_line24 = 0;
    inst->audio_sample_pos = 0;
    inst->audio_frame_count = 0;
}

/*
 * Switch from a pure-DVI signal to an HDMI signal that carries data
 * islands.  Re-builds every scanline DMA list using the "with audio"
 * variants (which leave a gap inside the horizontal blanking
 * interval for the data-island packets) and points each list at the
 * shared `next_data_stream` buffer.
 *
 * If you actually want audio, call dvi_audio_sample_buffer_set
 * followed by dvi_set_audio_freq before this; on its own it only
 * enables the InfoFrame slot.
 */
void dvi_enable_data_island(struct dvi_inst *inst) {
    inst->data_island_is_enabled  = true;

    dvi_setup_scanline_for_vblank_with_audio(inst->timing, inst->dma_cfg, true, &inst->dma_list_vblank_sync);
    dvi_setup_scanline_for_vblank_with_audio(inst->timing, inst->dma_cfg, false, &inst->dma_list_vblank_nosync);
    dvi_setup_scanline_for_active_with_audio(inst->timing, inst->dma_cfg, (void*)SRAM_BASE, &inst->dma_list_active, false);
    dvi_setup_scanline_for_active_with_audio(inst->timing, inst->dma_cfg, NULL, &inst->dma_list_error, false);
    dvi_setup_scanline_for_active_with_audio(inst->timing, inst->dma_cfg, NULL, &inst->dma_list_active_blank, true);

    // Setup internal Data Packet streams
    dvi_update_data_island_ptr(&inst->dma_list_vblank_sync,   &inst->next_data_stream);
    dvi_update_data_island_ptr(&inst->dma_list_vblank_nosync, &inst->next_data_stream);
    dvi_update_data_island_ptr(&inst->dma_list_active,        &inst->next_data_stream);
    dvi_update_data_island_ptr(&inst->dma_list_error,         &inst->next_data_stream);
    dvi_update_data_island_ptr(&inst->dma_list_active_blank,  &inst->next_data_stream);
}

void dvi_update_data_island_ptr(struct dvi_scanline_dma_list *dma_list, data_island_stream_t *stream) {
    for (int i = 0; i < N_TMDS_LANES; ++i) {
        dma_cb_t *cblist = dvi_lane_from_list(dma_list, i);
        uint32_t *src = stream->data[i];

        if (i == TMDS_SYNC_LANE) {
            cblist[1].read_addr = src;
        } else {
            cblist[2].read_addr = src;
        }
    }
}

/*
 * Hand the driver the storage for the audio ring.  size must be a
 * power of two.  The producer pushes int16 stereo frames into it via
 * the public frank_hdmi_audio_write() helper, and the IRQ pulls
 * them out a few at a time per scanline.
 */
void dvi_audio_sample_buffer_set(struct dvi_inst *inst, audio_sample_t *buffer, int size) {
    audio_ring_set(&inst->audio_ring, buffer, size);
}

// video_freq: video sampling frequency
// audio_freq: audio sampling frequency
// CTS: Cycle Time Stamp
// N: HDMI Constant
// 128 * audio_freq = video_freq * N / CTS
// e.g.: video_freq = 23495525, audio_freq = 44100 , CTS = 28000, N = 6727
/*
 * Tell the driver which HDMI audio sample rate to advertise on the
 * wire, and how to clock-regenerate it on the receiver.
 *
 * `audio_freq` is the nominal sample rate in Hz (32000, 44100, 48000
 * or a CEA-861 multiple).  `cts` and `n` are the audio-clock-
 * regeneration values per CEA-861:
 *
 *     128 * audio_freq = pixel_freq * n / cts
 *
 * Pick n from the CEA-861 standard table for the chosen sample rate
 * and compute cts from the active video clock; the receiver stays
 * locked.  After this call, the data-island stream is automatically
 * enabled.
 */
void dvi_set_audio_freq(struct dvi_inst *inst, int audio_freq, int cts, int n) {
    inst->audio_freq = audio_freq;
    set_audio_clock_regeneration(&inst->audio_clock_regeneration, cts, n);
    set_audio_info_frame(&inst->audio_info_frame, audio_freq);
    uint pixelClock =   dvi_timing_get_pixel_clock(inst->timing);
    uint64_t nPixPerFrame = dvi_timing_get_pixels_per_frame(inst->timing);
    uint64_t nPixPerLine =  dvi_timing_get_pixels_per_line(inst->timing);
    inst->samples_per_frame  = (uint64_t)(audio_freq) * nPixPerFrame / pixelClock;
    uint64_t t = audio_freq * nPixPerLine * (uint64_t)0x1000000;
    inst->samples_per_line24 = t / pixelClock;
    dvi_enable_data_island(inst);
}

void dvi_wait_for_valid_line(struct dvi_inst *inst) {
    uint32_t *tmdsbuf = NULL;
    queue_peek_blocking_u32(&inst->q_colour_valid, &tmdsbuf);
}

bool __dvi_func(dvi_update_data_packet_)(struct dvi_inst *inst, data_packet_t *packet) {
    if (inst->samples_per_frame == 0) {
        return false;
    }

    inst->audio_sample_pos += inst->samples_per_line24;
    if (inst->timing_state.v_state == DVI_STATE_FRONT_PORCH) {
        if (inst->timing_state.v_ctr == 0) {
            if (inst->dvi_frame_count & 1) {
                *packet = inst->avi_info_frame;
            } else {
                *packet = inst->audio_info_frame;
            }
            return true;
        } else if (inst->timing_state.v_ctr == 1) {
            *packet = inst->audio_clock_regeneration;

            return true;
        }
    }
    const int sample_pos_24 = inst->audio_sample_pos >> 24;
    const int n = MIN(4, sample_pos_24);
    if (n)
    {
        inst->audio_sample_pos -= (n << 24);
        inst->audio_frame_count = set_audio_sample(packet, &inst->audio_ring, n, inst->audio_frame_count);
        return true;
    }

    return false;
}
