/*
 * dvi_min.c —— 最小 DVI 验证固件
 *
 * 目的：把可能性一刀切开。
 *
 * 现状：完整固件里 DVI 引擎确认在产帧（计数器在涨）、像素时钟在跑、
 *       八个引脚 FUNCSEL 全对，但屏幕【时好时坏】—— 说明是边缘性/时序问题，
 *       或者有别的子系统在干扰。
 *
 * 本文件尽量砍掉一切：
 *   - 不初始化 SDIO / FatFS
 *   - 不初始化 PSRAM
 *   - 不跑系统调用演示
 *   - 不碰 pico_hdmi（HSTX）
 *   只做：设时钟 -> 初始化 frank-hdmi-sound -> Core1 跑 DVI -> Core0 填纯色帧缓冲
 *
 * 判据：
 *   最小固件稳定出图  -> 是别的子系统干扰 DVI，逐个加回来定位
 *   最小固件也不出图  -> 问题在 DVI 配置/时钟/硬件，与其它模块无关
 *
 * 画面：每秒换一种满屏颜色（红/绿/蓝/白/黄/青/品红/黑），
 *       一眼就能看出是否在刷新、颜色是否正确。
 */

#include <stdio.h>
#include <string.h>

#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/bootrom.h"          /* reset_usb_boot：串口后门进 BOOTSEL */
#include "hardware/watchdog.h"     /* watchdog_reboot：串口后门普通重启 */

#include "hardware/clocks.h"
#include "hardware/vreg.h"
#include "hardware/dma.h"      /* ★ 诊断 6：Core0 直接读 DMA 寄存器 */
#include "hardware/pio.h"      /* ★ 诊断 6：Core0 直接读 PIO 寄存器 */

#include "frank_hdmi.h"

#define FB_W  FRANK_HDMI_LOGICAL_WIDTH    /* 320 */
#define FB_H  FRANK_HDMI_LOGICAL_HEIGHT   /* 240 */

static uint8_t g_fb[FB_W * FB_H];

/* 满屏纯色，每秒换一种。颜色索引见下面 pal[] 的顺序。 */
static void fill_solid(uint8_t c)
{
    memset(g_fb, c, sizeof(g_fb));
}

/* 画一个明显的边框，避免"全是纯色但看不出对错" */
static void draw_border(uint8_t c)
{
    for (int x = 0; x < FB_W; x++) {
        g_fb[0 * FB_W + x] = c;
        g_fb[1 * FB_W + x] = c;
        g_fb[(FB_H - 1) * FB_W + x] = c;
        g_fb[(FB_H - 2) * FB_W + x] = c;
    }
    for (int y = 0; y < FB_H; y++) {
        g_fb[y * FB_W + 0] = c;
        g_fb[y * FB_W + 1] = c;
        g_fb[y * FB_W + (FB_W - 1)] = c;
        g_fb[y * FB_W + (FB_W - 2)] = c;
    }
}

/*
 * ── 2026-10-05 图案诊断（用户要求的 4 层实验：纯色 / 纯色幻灯片 / 静态图形 / 变化图形）──
 *  为什么必须上图案：**纯色会掩盖问题** ✗ —— 缺行、错位、时序偏差在纯白上都看不出来。
 *  这正是文档里那条"图案诊断法"的道理（`docs\历史.md:434`，用户提议：复杂图案会掩盖问题，
 *  反过来纯色也一样会掩盖"缺行/重复行"这类几何缺陷 ⇒ 要用简单几何图案把它逼出来）。
 *  按键：'8' 竖条纹（1 像素，最能暴露水平方向问题）
 *        '9' 棋盘格（8×8，暴露块级错位）
 *        'A' 变化图形：一根 16 像素宽的白竖条左右扫动（持续重绘 ⇒ 测【更新通路】）
 *        按 '1'..'7' 会切回纯色模式。
 */
static void draw_vstripes(uint8_t a, uint8_t b)
{
    for (int y = 0; y < FB_H; y++) {
        uint8_t *row = &g_fb[y * FB_W];
        for (int x = 0; x < FB_W; x++) {
            row[x] = (x & 1) ? a : b;
        }
    }
}

static void draw_checker(uint8_t a, uint8_t b, int cell)
{
    for (int y = 0; y < FB_H; y++) {
        uint8_t *row = &g_fb[y * FB_W];
        for (int x = 0; x < FB_W; x++) {
            row[x] = (((x / cell) + (y / cell)) & 1) ? a : b;
        }
    }
}

/* 变化图形：黑底 + 一根白竖条（宽 bar_w 像素），位置由 phase 控制（扫出屏外再回） */
/*
 * ★ 2026-10-06 校准图（用户：格子太小没法数 ✗）：
 *   · 大格子：40 逻辑像素 ⇒ 横 320/40 = 8 格、纵 240/40 = 6 格 ⇒ 一眼数得清 ✓
 *   · 四边四种颜色（各 2 逻辑像素）⇒ 可分别判断哪条边缺、哪条边偏粗 ✓
 *       上=红(2)  下=绿(3)  左=蓝(4)  右=黄(5)
 *   · 判据：若上边看不到 ⇒ 纵向有 ~2 行偏移 ✓；若左右比上下【细一半】⇒ 横向复制没生效 ✓
 */
static void draw_calib(void)
{
    const int cell = 40;
    for (int y = 0; y < FB_H; ++y) {
        for (int x = 0; x < FB_W; ++x) {
            g_fb[y * FB_W + x] = (((x / cell) + (y / cell)) & 1) ? 1 : 0;
        }
    }
    /* 四边：各 2 逻辑像素，颜色互不相同 ✓ */
    for (int x = 0; x < FB_W; ++x) {
        g_fb[0 * FB_W + x] = 2;                 /* 上 = 红 */
        g_fb[1 * FB_W + x] = 2;
        g_fb[(FB_H - 1) * FB_W + x] = 3;        /* 下 = 绿 */
        g_fb[(FB_H - 2) * FB_W + x] = 3;
    }
    for (int y = 0; y < FB_H; ++y) {
        g_fb[y * FB_W + 0] = 4;                 /* 左 = 蓝 */
        g_fb[y * FB_W + 1] = 4;
        g_fb[y * FB_W + (FB_W - 1)] = 5;        /* 右 = 黄 */
        g_fb[y * FB_W + (FB_W - 2)] = 5;
    }
}
/*
 * ★ 2026-10-06 大色块（按 'M'）—— 用户反馈"颜色尺细条数不清"✗ ⇒ 改成不可能看错的大块 ✓
 *   · 最顶 5% 高 = 黄(5)  ⇒ 它若不见了，就说明顶部被裁 ✗
 *   · 其余均分 4 大块（自上而下）：红(2) / 绿(3) / 蓝(4) / 白(1)
 *   ⇒ 用户只需报"从上到下 4 大块什么颜色" ✓✓
 */
static void draw_ruler(void)
{
    const int top = FB_H / 20;              /* 最顶 5% = 黄 */
    const int rest = FB_H - top;
    for (int y = 0; y < FB_H; ++y) {
        uint8_t c;
        if (y < top) {
            c = 5;                          /* 黄 */
        } else {
            int q = (y - top) * 4 / rest;   /* 0..3 */
            c = (q == 0) ? 2 : (q == 1) ? 3 : (q == 2) ? 4 : 1;
        }
        for (int x = 0; x < FB_W; ++x) {
            g_fb[y * FB_W + x] = c;
        }
    }
}
static void draw_moving_bar(int phase, int bar_w)
{
    memset(g_fb, 0, sizeof(g_fb));
    int x0 = (phase % (FB_W + bar_w)) - bar_w;
    for (int y = 0; y < FB_H; y++) {
        uint8_t *row = &g_fb[y * FB_W];
        for (int x = 0; x < FB_W; x++) {
            if (x >= x0 && x < x0 + bar_w) {
                row[x] = 1;                  /* 1 = 白 */
            }
        }
    }
}

/*
 * ── 2026-10-04 临时诊断：DMA 块表转储（修 DVI 输出用）──────────────────
 *  库里的全局量是非 static 的（能读），这里直接 extern，打印放在 Core0，
 *  避免在 DVI 的 IRQ 里 printf。
 *  判据：L0 第 3 格（非音频路径的有效块）的 read_addr 必须 == tmdsbuf；
 *        若它指向 ctrl_syms 那一片（控制符号数组）⇒ 同步 lane 在发控制符号 = bug 坐实。
 */
extern volatile uint32_t g_dbg_seq, g_dbg_list_id, g_dbg_island, g_dbg_tmdsbuf;
extern volatile uint32_t g_dbg_blk_addr[3][7], g_dbg_blk_cnt[3][7];
extern volatile uint32_t g_dbg_data_ra[3], g_dbg_data_tc[3];
extern volatile uint32_t g_dbg_ctrl_ra[3], g_dbg_ctrl_tc[3];
extern volatile uint32_t g_dbg_buf[3][3];
extern volatile uint32_t g_dbg2_seq, g_dbg2_tcr[3], g_dbg2_tc[3], g_dbg2_ra[3], g_dbg2_ctrl[3];
extern volatile uint32_t g_dbg2_cra[3], g_dbg2_ctc[3];
extern volatile uint32_t g_dbg_tx[3], g_dbg_tx_dreq[3], g_dbg_waddr[3][4];
extern volatile uint32_t g_dbg_pio_tx[4], g_dbg_pinctrl[4], g_dbg_clkdiv[4];
extern volatile uint32_t g_dbg_sm[3], g_dbg_pins[3];
extern volatile uint32_t g_dbg_blkbuf[3][3], g_dbg_blkctrl[3][7], g_dbg_vidblk[3];extern volatile uint32_t g_dbg_state_hist[5], g_dbg_cur_state, g_dbg_cur_vctr;
extern volatile uint32_t g_dbg_v_active_lines, g_dbg_blank_top, g_dbg_blank_bottom, g_dbg_scanline_en;
extern volatile uint32_t g_dbg_chan_data[3], g_dbg_chan_ctrl[3], g_dbg_pio_base;
extern volatile uint32_t g_dbg_list_addr[5], g_dbg_list_size;
extern volatile uint32_t g_dbg_hist_list[64], g_dbg_hist_state[64], g_dbg_hist_vctr[64], g_dbg_hist_idx;
extern volatile uint32_t g_dbg_const_addr[5];
extern void dvi_debug_fill_const_addrs(void);

/* 把地址点成名字：给一个 read_addr，回一个可读标签 */
static const char *name_of_addr(uint32_t a)
{
    static char buf[48];
    static const char *nm[5] = { "dvi_ctrl_syms", "empty_scanline_tmds",
                                 "black_scanline_tmds", "video_gaurdband_syms", "-" };
    for (int i = 0; i < 4; ++i) {
        uint32_t b = g_dbg_const_addr[i];
        if (b && a >= b && a < b + 16u) {
            snprintf(buf, sizeof(buf), "%s+%lu", nm[i], (unsigned long)(a - b));
            return buf;
        }
    }
    if (a >= 0x2002c000u && a < 0x20030000u) return "TMDS-POOL";
    snprintf(buf, sizeof(buf), "?%08lx", (unsigned long)a);
    return buf;
}

/*
 * ★ 2026-10-04 诊断 6：真正的【行中】快照 —— Core0 直接读 DMA / PIO 寄存器。
 *   现有 [dbg2]/[dbg]/[chain] 都是在 DVI 的 IRQ 里填的 ⇒ 只能看【行边界】。
 *   这里由 Core0 在任意时刻读（'D' 命令），所以能落在有效区进行中（占 91%）。
 *   连采 8 次、间隔 500 µs ⇒ 得到一条【行内时间剖面】（一行在 150 分频下约 4.76 ms）。
 */
/*
 * ★ 2026-10-04 诊断 8：一行之内，三条 lane 的【控制通道块指针】按什么顺序走。
 *   IRQ 一行只来一次（只能看行边界），所以这里由 Core0 高频采样：
 *   400 次 × ~10 µs ≈ 4 ms ≈ 一行（150 分频下一行约 4.76 ms），只打印变化点。
 *   正常应在 L0 上看到 l0[0](前肩) → l0[1](同步) → l0[2](后肩) → l0[3](有效=视频块)。
 */
#define TRACE_N 400
static uint32_t g_tr_t[TRACE_N];
static uint32_t g_tr_c0[TRACE_N], g_tr_c1[TRACE_N], g_tr_c2[TRACE_N];
static uint32_t g_tr_d0[TRACE_N];

static void trace_line(void)
{
    uint32_t t0 = time_us_32();
    for (int i = 0; i < TRACE_N; ++i) {
        g_tr_t[i]  = time_us_32() - t0;
        g_tr_c0[i] = dma_hw->ch[g_dbg_chan_ctrl[0]].read_addr;
        g_tr_c1[i] = dma_hw->ch[g_dbg_chan_ctrl[1]].read_addr;
        g_tr_c2[i] = dma_hw->ch[g_dbg_chan_ctrl[2]].read_addr;
        g_tr_d0[i] = dma_hw->ch[g_dbg_chan_data[0]].read_addr;
        sleep_us(10);
    }
    printf("[trace] 采样 %d 点，跨度 %lu us\n", TRACE_N,
           (unsigned long)(time_us_32() - t0));
    {   /* ★ 分类直方图：L0 数据通道这 400 点里有多少落在 TMDS 池、多少落在常量区 */
        int in_pool = 0, in_const = 0, other = 0;
        for (int i = 0; i < TRACE_N; ++i) {
            uint32_t a = g_tr_d0[i];
            if (a >= 0x2002c000u && a < 0x20040000u) ++in_pool;
            else if (a >= 0x20000000u && a < 0x20004000u) ++in_const;
            else ++other;
        }
        printf("[trace] L0 数据通道读数分类: TMDS池=%d  低RAM常量区=%d  其它=%d  (共 %d)\n",
               in_pool, in_const, other, TRACE_N);
        printf("[trace] => 视频块占比 %.1f%%（若链路正常应≈80%%）\n", in_pool * 100.0 / TRACE_N);
    }
    uint32_t p0 = 0xFFFFFFFFu, p1 = 0xFFFFFFFFu, p2 = 0xFFFFFFFFu, pd = 0xFFFFFFFFu;
    int shown = 0;
    for (int i = 0; i < TRACE_N && shown < 60; ++i) {
        if (g_tr_c0[i] != p0 || g_tr_c1[i] != p1 || g_tr_c2[i] != p2 || g_tr_d0[i] != pd) {
            printf("[trace] t=%5luus ctrl L0=%08lx L1=%08lx L2=%08lx | L0data.ra=%08lx\n",
                   (unsigned long)g_tr_t[i], (unsigned long)g_tr_c0[i],
                   (unsigned long)g_tr_c1[i], (unsigned long)g_tr_c2[i],
                   (unsigned long)g_tr_d0[i]);
            p0 = g_tr_c0[i]; p1 = g_tr_c1[i]; p2 = g_tr_c2[i]; pd = g_tr_d0[i];
            ++shown;
        }
    }
    fflush(stdout);
}

static void dump_live_regs(void)
{
    static const char *ln[3] = { "L0/blue", "L1/green", "L2/red" };
    static const char *lname5[5] = { "vblank_sync", "vblank_nosync", "active", "error", "active_blank" };
    dvi_debug_fill_const_addrs();
    printf("[const] dvi_ctrl_syms=%08lx empty=%08lx black=%08lx guard=%08lx\n",
           (unsigned long)g_dbg_const_addr[0], (unsigned long)g_dbg_const_addr[1],
           (unsigned long)g_dbg_const_addr[2], (unsigned long)g_dbg_const_addr[3]);
    printf("[lists] size=%lu  hist_idx=%lu\n",
           (unsigned long)g_dbg_list_size, (unsigned long)g_dbg_hist_idx);
    {   /* ★ 诊断 9：逐行列表/状态对照（最近 24 行） */
        static const char *l5[6] = { "vb_sync", "vb_nosync", "ACTIVE", "error", "act_blank", "?" };
        static const char *st4[5] = { "FP", "SYNC", "BP", "ACT", "?" };
        printf("[hist] 最近 24 行 (list, state, v_ctr):\n");
        uint32_t n = g_dbg_hist_idx < 64u ? g_dbg_hist_idx : 64u;
        uint32_t start = (g_dbg_hist_idx >= 64u) ? (g_dbg_hist_idx % 64u) : 0u;
        for (uint32_t k = 0; k < n && k < 24u; ++k) {
            uint32_t ix = (start + k) % 64u;
            uint32_t li = g_dbg_hist_list[ix], st = g_dbg_hist_state[ix];
            printf("   [%02lu] %-9s %-5s vctr=%lu\n", (unsigned long)ix,
                   l5[li < 6u ? li : 5], st4[st < 5u ? st : 4],
                   (unsigned long)g_dbg_hist_vctr[ix]);
        }
    }
    for (int i = 0; i < 5; ++i) {
        printf("[lists] %-14s @ %08lx .. %08lx\n", lname5[i],
               (unsigned long)g_dbg_list_addr[i],
               (unsigned long)(g_dbg_list_addr[i] + g_dbg_list_size - 1));
    }
    for (int s = 0; s < 8; ++s) {
        printf("[live%02d] t=%luus ", s, (unsigned long)time_us_32());
        for (int i = 0; i < 3; ++i) {
            uint ch = g_dbg_chan_data[i];
            printf("| %s ch%lu ra=%08lx[%s] tc=%lu ctrl=%08lx ",
                   ln[i], (unsigned long)ch,
                   (unsigned long)dma_hw->ch[ch].read_addr,
                   name_of_addr((uint32_t)dma_hw->ch[ch].read_addr),
                   (unsigned long)dma_hw->ch[ch].transfer_count,
                   (unsigned long)dma_hw->ch[ch].ctrl_trig);
        }
        printf("\n");
        printf("[live%02d] pio0 flevel=%08lx fdebug=%08lx  sm0.addr=%lu sm1.addr=%lu sm2.addr=%lu\n",
               s, (unsigned long)pio0_hw->flevel, (unsigned long)pio0_hw->fdebug,
               (unsigned long)pio0_hw->sm[0].addr, (unsigned long)pio0_hw->sm[1].addr,
               (unsigned long)pio0_hw->sm[2].addr);
        /* ★ 控制通道的行中现场：把它换算成"第几 lane 的第几格"
         *   列表结构 { l0[6]; l1[7]; l2[7] }（每格 16 字节，总 320 字节）
         *   ⇒ 以 active 列表为基址换算槽号；越界会串到隔壁 lane。 */
        printf("[live%02d] ctrl ch:", s);
        for (int i = 0; i < 3; ++i) {
            uint cc = g_dbg_chan_ctrl[i];
            uint32_t ra = (uint32_t)dma_hw->ch[cc].read_addr;
            uint32_t base = g_dbg_list_addr[2];              /* active */
            int lane = -1, slot = -1;
            if (ra >= base && ra < base + 320u) {
                uint32_t off = ra - base;
                if (off < 96u)        { lane = 0; slot = (int)(off / 16u); }
                else if (off < 208u)  { lane = 1; slot = (int)((off - 96u) / 16u); }
                else                  { lane = 2; slot = (int)((off - 208u) / 16u); }
            }
            if (lane >= 0 && slot >= 0)
                printf(" %s ra=%08lx=L%d[%d]", ln[i], (unsigned long)ra, lane, slot);
            else
                printf(" %s ra=%08lx=%s", ln[i], (unsigned long)ra, name_of_addr(ra));
        }
        printf("\n");
        sleep_us(500);
    }
    fflush(stdout);
}
extern const uint32_t dvi_ctrl_syms[4];

static void dump_dma_dbg(void)
{
    static const char *lname[3] = { "L0/blue(sync)", "L1/green", "L2/red" };
    printf("\n[dbg] seq=%lu list=%lu island=%lu tmdsbuf=0x%08lx\n",
           (unsigned long)g_dbg_seq, (unsigned long)g_dbg_list_id,
           (unsigned long)g_dbg_island, (unsigned long)g_dbg_tmdsbuf);
    printf("[dbg] ctrl_syms=0x%08lx (CTL0+0 CTL1+4 CTL2+8 CTL3+12)\n",
           (unsigned long)(uintptr_t)&dvi_ctrl_syms[0]);
    for (int i = 0; i < 3; ++i) {
        printf("[dbg] buf %s: [0]=%08lx [1]=%08lx [last]=%08lx\n", lname[i],
               (unsigned long)g_dbg_buf[i][0], (unsigned long)g_dbg_buf[i][1],
               (unsigned long)g_dbg_buf[i][2]);
    }
    for (int i = 0; i < 3; ++i) {
        printf("[dbg] %s blk:", lname[i]);
        for (int k = 0; k < 7; ++k) {
            printf(" [%d]a=%08lx(%s) c=%lu", k,
                   (unsigned long)g_dbg_blk_addr[i][k],
                   name_of_addr(g_dbg_blk_addr[i][k]),
                   (unsigned long)g_dbg_blk_cnt[i][k]);
        }
        printf("\n[dbg] %s live: data ra=%08lx tc=%lu | ctrl ra=%08lx tc=%lu\n",
               lname[i],
               (unsigned long)g_dbg_data_ra[i], (unsigned long)g_dbg_data_tc[i],
               (unsigned long)g_dbg_ctrl_ra[i], (unsigned long)g_dbg_ctrl_tc[i]);
    }
    printf("[dbg2] seq=%lu  (IRQ 入口现场 = 上一行刚跑完、还没重装)\n",
           (unsigned long)g_dbg2_seq);
    for (int i = 0; i < 3; ++i) {
        printf("[dbg2] %s: dbg_tcr=%lu tc=%lu ra=%08lx ctrl=%08lx | ctrl_ch ra=%08lx tc=%lu\n",
               lname[i], (unsigned long)g_dbg2_tcr[i], (unsigned long)g_dbg2_tc[i],
               (unsigned long)g_dbg2_ra[i], (unsigned long)g_dbg2_ctrl[i],
               (unsigned long)g_dbg2_cra[i], (unsigned long)g_dbg2_ctc[i]);
    }
    printf("[chain] pio txf[0..3] = %08lx %08lx %08lx %08lx\n",
           (unsigned long)g_dbg_pio_tx[0], (unsigned long)g_dbg_pio_tx[1],
           (unsigned long)g_dbg_pio_tx[2], (unsigned long)g_dbg_pio_tx[3]);
    for (int i = 0; i < 3; ++i) {
        printf("[chain] %s: sm=%lu pins=%lu dreq=%lu tx_fifo=%08lx\n",
               lname[i], (unsigned long)g_dbg_sm[i], (unsigned long)g_dbg_pins[i],
               (unsigned long)g_dbg_tx_dreq[i], (unsigned long)g_dbg_tx[i]);
        printf("[chain] %s: blk wa = %08lx %08lx %08lx %08lx\n", lname[i],
               (unsigned long)g_dbg_waddr[i][0], (unsigned long)g_dbg_waddr[i][1],
               (unsigned long)g_dbg_waddr[i][2], (unsigned long)g_dbg_waddr[i][3]);
    }
    for (int k = 0; k < 4; ++k) {
        printf("[chain] sm[%d]: pinctrl=%08lx clkdiv=%08lx\n", k,
               (unsigned long)g_dbg_pinctrl[k], (unsigned long)g_dbg_clkdiv[k]);
    }
    for (int i = 0; i < 3; ++i) {
        printf("[vidblk] %s: read_addr=%08lx  content=[0]=%08lx [1]=%08lx [last]=%08lx\n",
               lname[i], (unsigned long)g_dbg_vidblk[i],
               (unsigned long)g_dbg_blkbuf[i][0], (unsigned long)g_dbg_blkbuf[i][1],
               (unsigned long)g_dbg_blkbuf[i][2]);
        printf("[vidblk] %s: blk c.ctrl =", lname[i]);
        for (int k = 0; k < 7; ++k) printf(" %08lx", (unsigned long)g_dbg_blkctrl[i][k]);
        printf("\n");
    }
    printf("[state] v_state hist: FP=%lu SYNC=%lu BP=%lu ACTIVE=%lu (共 %lu)  cur=%lu v_ctr=%lu\n",
           (unsigned long)g_dbg_state_hist[0], (unsigned long)g_dbg_state_hist[1],
           (unsigned long)g_dbg_state_hist[2], (unsigned long)g_dbg_state_hist[3],
           (unsigned long)(g_dbg_state_hist[0]+g_dbg_state_hist[1]+g_dbg_state_hist[2]+g_dbg_state_hist[3]),
           (unsigned long)g_dbg_cur_state, (unsigned long)g_dbg_cur_vctr);
    printf("[state] v_active_lines=%lu blank_top=%lu blank_bottom=%lu scanline_is_enabled=%lu\n",
           (unsigned long)g_dbg_v_active_lines, (unsigned long)g_dbg_blank_top,
           (unsigned long)g_dbg_blank_bottom, (unsigned long)g_dbg_scanline_en);
    fflush(stdout);
}

/*
 * ── 2026-10-05 超频扫描的【Flash 记录】（用户指示：改用 SWD 或写进 Flash 作报告 ✓）──
 * 为什么必须落盘：若某一档直接把芯片挂住 ✗，任何"靠自己打印"的证据都拿不到 ✗。
 * 记录写在【最后一个 4KB 扇区】✓，只用一个结构体 ⇒ 每次覆盖写 ✓。
 * 读法（两种都行 ✓）：
 *   ① 复位/重启后本程序开机第一句就把它打印出来 ✓
 *   ② SWD: reset halt + dump_image 最后一个扇区 ✓（今晚已验证该手法可行 ✓）
 * 判据：看到 tag="attempt" 的 want=F，但其后没有 tag="ok/fail" ⇒ F 就是挂点 ✓✓
 */
#include "hardware/flash.h"
#include "hardware/sync.h"

#define OC_MAGIC   0x4F435231u                      /* "OCR1" */
#define OC_OFFSET  (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)

typedef struct {
    uint32_t magic;
    uint32_t seq;
    char     tag[8];        /* "attempt" / "ok" / "fail" */
    uint32_t want_khz;
    uint32_t actual_khz;
    uint32_t vsel;
    uint32_t reset_reason;
} oc_rec_t;

static const oc_rec_t *oc_peek(void)
{
    const oc_rec_t *r = (const oc_rec_t *)(XIP_BASE + OC_OFFSET);
    return (r->magic == OC_MAGIC) ? r : NULL;
}

static void oc_write(const char *tag, uint32_t want, uint32_t actual, uint32_t vsel)
{
    const oc_rec_t *old = oc_peek();
    oc_rec_t rec;
    memset(&rec, 0, sizeof rec);
    rec.magic        = OC_MAGIC;
    rec.seq          = (old ? old->seq : 0u) + 1u;
    strncpy(rec.tag, tag, sizeof rec.tag - 1);
    rec.want_khz     = want;
    rec.actual_khz   = actual;
    rec.vsel         = vsel;
    rec.reset_reason = watchdog_hw->scratch[1];      /* 1 = 从超频命令重启来的 ✓ */

    uint8_t page[FLASH_PAGE_SIZE];
    memset(page, 0xFF, sizeof page);
    memcpy(page, &rec, sizeof rec);

    uint32_t ints = save_and_disable_interrupts();
    flash_range_erase(OC_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(OC_OFFSET, page, FLASH_PAGE_SIZE);
    restore_interrupts(ints);
}

static void oc_print_prev(void)
{
    const oc_rec_t *prev = oc_peek();
    if (prev) {
        printf("[ocp] prev seq=%lu tag=%.8s want=%lu actual=%lu vsel=%lu rr=%lu\n",
               (unsigned long)prev->seq, prev->tag,
               (unsigned long)prev->want_khz, (unsigned long)prev->actual_khz,
               (unsigned long)prev->vsel, (unsigned long)prev->reset_reason);
    } else {
        printf("[ocp] no previous overclock record in flash\n");
    }
    fflush(stdout);
}

int main(void)
{

    uint32_t want_khz = watchdog_hw->scratch[0];
    uint32_t from_reboot = watchdog_hw->scratch[1];
    if (want_khz < 100000u || want_khz > 600000u) {
        want_khz = 252000u;
        from_reboot = 0;
    }

    if (!from_reboot) {
        /* ---- 阶段 0：默认 252MHz 下收命令，写 scratch，软复位 ---- */
        stdio_init_all();
        oc_print_prev();   /* 先打印上一轮的超频记录（防挂证据 ✓）*/
        oc_print_prev();   /* 先打印上一轮留下的超频记录（防挂证据 ✓）*/
        sleep_ms(300);
        printf("\n[oc] stage0 @252MHz: send  F<kHz>  within 12 s (e.g. F276). Then it reboots to apply.\n");
        fflush(stdout);
        uint32_t acc = 0;
        bool have = false;
        absolute_time_t until = make_timeout_time_ms(12000);
        while (!time_reached(until)) {
            int ch = getchar_timeout_us(2000);
            if (ch == PICO_ERROR_TIMEOUT) {
                continue;
            }
            if (ch == 'F' || ch == 'f') {
                acc = 0; have = false;
            } else if (ch >= '0' && ch <= '9') {
                acc = acc * 10u + (uint32_t)(ch - '0');
                have = true;
            } else if (ch == '\r' || ch == '\n') {
                if (have && acc >= 100000u && acc <= 600000u) {
                    printf("[oc] got %lu kHz => reboot to apply (stdio will be re-inited at the new clock)\n",
                           (unsigned long)acc);
                    fflush(stdout);
                    watchdog_hw->scratch[0] = acc;
                    watchdog_hw->scratch[1] = 1u;
                    sleep_ms(100);
                    watchdog_reboot(0, 0, 0);          /* 不返回 ✓ */
                }
                acc = 0; have = false;
            }
        }
        printf("[oc] no command in 12 s => staying at 252 MHz\n");
        fflush(stdout);
        want_khz = 252000u;
    }

    /* ---- 阶段 1：先落盘"要试哪一档"⇒ 再提压、提频 ⇒ 再起 stdio ✓ ---- */
    /* ★ 用户 2026-10-05 警告：核心电压不能超过耐压 ✓
     *   RP2350 核心 DVDD 绝对最大 = 1.30 V ⇒ 【本扫描永不设 >1.30V】✗（原 1.35V 档已删 ✗）
     *   阶梯：≤276MHz ⇒ 1.25V；更高 ⇒ 1.30V（到此为止）✓   先提压、再提频 ✓ */
    int vsel = 0;                                      /* 0=1.25V 1=1.30V（无 1.35V ✗）*/
    if (want_khz > 276000u) vsel = 1;

    if (from_reboot) {
        oc_write("attempt", want_khz, 0u, (uint32_t)vsel);   /* ★ 防挂：先落盘 ✓ */
    }

    vreg_set_voltage(vsel == 0 ? VREG_VOLTAGE_1_25 : VREG_VOLTAGE_1_30);   /* 上限 1.30V ✓ 不超规 */
    sleep_ms(10);

    bool clk_ok = set_sys_clock_khz(want_khz, false);
    uint32_t actual_khz = (uint32_t)(clock_get_hz(clk_sys) / 1000);

    if (from_reboot) {
        stdio_init_all();
        oc_print_prev();   /* 先打印上一轮的超频记录（防挂证据 ✓）*/
        oc_print_prev();   /* 先打印上一轮留下的超频记录（防挂证据 ✓）*/                              /* ★ 关键：改频之后才起 stdio ✓ */
        sleep_ms(200);
        oc_write(clk_ok ? "ok" : "fail", want_khz, actual_khz, (uint32_t)vsel);
        watchdog_hw->scratch[0] = 0u;                  /* 清掉，避免下次误判 ✓ */
        watchdog_hw->scratch[1] = 0u;
    }

    printf("\n[oc] want=%lu kHz  set_sys_clock_khz=%s  actual clk_sys=%lu kHz  vreg=%s\n",
           (unsigned long)want_khz, clk_ok ? "OK" : "FAILED",
           (unsigned long)actual_khz,
           vsel == 0 ? "1.25V" : "1.30V");
    fflush(stdout);

    printf("\n[min] 最小 DVI 验证\n");
    printf("[min] 引脚 CLK=%d D0=%d D1=%d D2=%d  invert=%d\n",
           FRANK_HDMI_PIN_CLK, FRANK_HDMI_PIN_D0,
           FRANK_HDMI_PIN_D1, FRANK_HDMI_PIN_D2,
#ifdef FRANK_HDMI_INVERT_DIFFPAIRS
           FRANK_HDMI_INVERT_DIFFPAIRS
#else
           -1
#endif
           );
    fflush(stdout);

    /* 调色板：0..7 依次为 黑/白/红/绿/蓝/黄/青/品红 */
    frank_hdmi_set_palette(0, 0x000000);
    frank_hdmi_set_palette(1, 0xFFFFFF);
    frank_hdmi_set_palette(2, 0xFF0000);
    frank_hdmi_set_palette(3, 0x00FF00);
    frank_hdmi_set_palette(4, 0x0000FF);
    frank_hdmi_set_palette(5, 0xFFFF00);
    frank_hdmi_set_palette(6, 0x00FFFF);
    frank_hdmi_set_palette(7, 0xFF00FF);

    fill_solid(1);                 /* 起始：白底 */

    frank_hdmi_init();
    frank_hdmi_set_buffer(g_fb, FB_W, FB_H);

    multicore_launch_core1(frank_hdmi_run_core1);

    printf("[min] Core1 已启动，开始循环换色\n");
    fflush(stdout);

    /*
     * 每 500ms 换一种满屏颜色：黑 -> 白 -> 红 -> 绿 -> 蓝 -> 黄 -> 青 -> 品红
     * 颜色变化非常容易肉眼判断，也便于发现"卡在某一帧"。
     */
    static const uint8_t seq[] = { 1, 2, 3, 4, 5, 6, 7, 0 };
    int i = 0;
    /*
     * ★ 2026-10-04 新增：颜色冻结（验收第 3 条要"已知颜色"才能算期望码字）。
     *   发 '0'..'7' ⇒ 停在对应调色板颜色（0黑 1白 2红 3绿 4蓝 5黄 6青 7品红）
     *   发 'C'      ⇒ 恢复自动轮换
     */
    int freeze = 1, frozen = 0;      /* ★ 默认【停住】：不再自动轮换颜色，屏幕画面稳定。
                                      *   理由：验证已经完成，上屏实测需要稳定画面；
                                      *   且自动换色会让"抓一包已知颜色"变得不可复现。 */

    /* 2026-10-05 图案模式：0=纯色(原行为) 1=竖条纹 2=棋盘格 3=变化图形(扫动条) */
    int mode = 0;
    /* ★ 2026-10-06 重画守卫（只补这一个变量 ✓）
     * 实测证据：没有它时，app 每轮都整屏重写 76KB ⇒ Core0 突发 ⇒ TMDS FIFO 被顶穿
     *   ⇒ 遥测 free=0/1446 ✗（饥饿）+ loop=73~88µs ✗（健康 63~64）⇒ 屏幕【蓝白条纹闪】
     * 加它之后：静态内容只画一次 ⇒ free 应回到 >=10 ✓、loop 回到 ~63µs ✓ */
    int last_mode = -1;
    int last_c = -1;
    int phase = 0;

    while (true) {
        uint8_t c;
        if (freeze) {
            c = (uint8_t)frozen;
        } else {
            c = seq[i];
            i = (i + 1) % (int)(sizeof(seq) / sizeof(seq[0]));
        }
        /*
         * ── 2026-10-05 【抓引擎之死】Core1 心跳看门狗 ──────────────────────────
         * 背景（本会话实测）：屏幕出现过两种状态 ——
         *   · 纯白    ⇒ 时序/DMA 还在跑，但像素数据恒定 ✗（irq 在涨、TMDS 符号不变）
         *   · 无信号  ⇒ 整个 DVI 输出停了 ✗（遥测直接归零）
         * Core1 上跑着【编码器 + DVI 的 DMA IRQ】，所以先要判定"心跳何时停、停时计数器是什么"。
         * `frank_hdmi_heartbeat_lines` 由 Core1 每编码一行 ++（库里的 volatile 全局 ✓）。
         * 外层循环一轮约 500ms ⇒ 每轮加 500ms 计一次停顿时长。
         */
        {
            extern volatile uint32_t frank_hdmi_heartbeat_lines;
            extern volatile uint32_t frank_hdmi_heartbeat_frames;
            extern volatile uint32_t g_enc_count, g_enc_us, g_enc_us_max, g_loop_us;
            extern volatile uint32_t g_wait_free_us, g_wait_valid_us, g_wait_colour_us;
            static uint32_t last_hb = 0, stall_ms = 0, loops = 0;
            static int warned = 0;
            uint32_t hb = frank_hdmi_heartbeat_lines;
            loops++;
            if (hb != last_hb) {
                last_hb = hb; stall_ms = 0; warned = 0;
            } else {
                stall_ms += 500;
                if (!warned && stall_ms >= 1500) {
                    warned = 1;
                    printf("\n[STALL] Core1 heartbeat stuck >=%lums  (Core0 loops=%lu)\n",
                           (unsigned long)stall_ms, (unsigned long)loops);
                    printf("[STALL] hb lines=%lu frames=%lu\n",
                           (unsigned long)hb, (unsigned long)frank_hdmi_heartbeat_frames);
                    printf("[STALL] enc_count=%lu enc_us=%lu enc_us_max=%lu loop_us=%lu\n",
                           (unsigned long)g_enc_count, (unsigned long)g_enc_us,
                           (unsigned long)g_enc_us_max, (unsigned long)g_loop_us);
                    printf("[STALL] waits us: free=%lu valid=%lu colour=%lu\n",
                           (unsigned long)g_wait_free_us, (unsigned long)g_wait_valid_us,
                           (unsigned long)g_wait_colour_us);
                    printf("[STALL] mode=%d freeze=%d c=%d\n", mode, freeze, (int)c);
                    fflush(stdout);
                }
            }
        }

        /*
         * ── 2026-10-05 【查 Core1 到底卡在哪条队列】────────────────────────────
         * 动机（本会话实测）：irq=31499 行/秒、n=16696 行/秒、enc≈40µs/行。
         * 若 31499 行都要编码，需要 31499×40µs = 1.26 秒/秒 ⇒ 物理不可能 ✗
         * ⇒ 只有 16696 行真被编码（占用约 67%）⇒ **编码器有 1/3 时间是闲的** ✗
         * ⇒ 它不是算力不够，是【被某条队列卡住】✓（与 docs/DVI攻坚流水.md 14.20
         *   「Core1 是受害者不是元凶」一致 ✓）。
         * 引擎里早已埋好这些计数器（frank_hdmi.c:220-233），只是遥测只印了 waitfree ✗
         * ⇒ 这里把三条等待 + 循环耗时都打出来（cur/max 成对 ✓），每约 2 秒一次。
         */
        {
            extern volatile uint32_t g_wait_colour_us, g_wait_colour_us_max;
            extern volatile uint32_t g_wait_valid_us, g_wait_valid_us_max;
            extern volatile uint32_t g_wait_free_us, g_wait_free_us_max;
            extern volatile uint32_t g_loop_us, g_loop_us_max;
            extern volatile uint32_t g_enc_us, g_enc_us_max;
            static uint32_t tick = 0;
            if ((++tick % 4) == 0) {
                /* ★ 2026-10-05 加主频：docs/DVI攻坚流水.md:64 留了"唯一没排除"的线索
                 *   —— sys_clk 实际不是 252MHz。Core1 整圈 42µs ⇒ 只有 23.8k 圈/秒 < 31500 行/秒 ✗
                 *   若主频低于 252，一切都解释得通（编码吞吐随主频线性）。
                 * 注：g_dbg_sys_clk_hz 只存在于根工程 PicoPhone，dvi_min 里没有 ⇒ 不引它 ✗ */
                uint32_t hz = (uint32_t)clock_get_hz(clk_sys);
                printf("[wait] colour=%lu/%lu valid=%lu/%lu free=%lu/%lu loop=%lu/%lu enc=%lu/%lu\n",
                       (unsigned long)g_wait_colour_us, (unsigned long)g_wait_colour_us_max,
                       (unsigned long)g_wait_valid_us, (unsigned long)g_wait_valid_us_max,
                       (unsigned long)g_wait_free_us, (unsigned long)g_wait_free_us_max,
                       (unsigned long)g_loop_us, (unsigned long)g_loop_us_max,
                       (unsigned long)g_enc_us, (unsigned long)g_enc_us_max);
                printf("[clk] clk_sys=%lu Hz (%lu kHz)   loop_rate=%lu/s\n",
                       (unsigned long)hz, (unsigned long)(hz / 1000),
                       (unsigned long)(g_loop_us ? (1000000u / g_loop_us) : 0));
                fflush(stdout);
            }
        }

        const bool same_as_last = (mode == last_mode) && (mode != 0 || (int)c == last_c);
        last_mode = mode; last_c = (int)c;
        if (same_as_last && mode != 3) {
            /* 内容没变 ⇒ 一个字节都不写 ✓（mode==3 的动画仍逐帧画 ✓）*/
        } else if (mode == 7) {
            /* 颜色尺：第 0..7 行各一色 ⇒ 读出纵向偏移几行 ✓ */
            draw_ruler();
        } else if (mode == 4) {
            /* 校准图：40 像素大格子 + 四边四色 ✓（用户一眼可报数 ✓）*/
            draw_calib();
        } else if (mode == 1) {
            /* 第 3 层：静态图形 —— 1 像素竖条纹（最容易暴露水平方向/缺行问题） */
            draw_vstripes(1, 0);
            draw_border(2);
        } else if (mode == 2) {
            /* 第 3 层：静态图形 —— 8x8 棋盘格（暴露块级错位） */
            draw_checker(1, 0, 8);
            draw_border(2);
        } else if (mode == 3) {
            /* 第 4 层：变化图形 —— 扫动条在下面的内层循环里逐帧重绘（见 mode==3 处） */
        } else {
            /* 原行为：满屏纯色 + 对比色边框，便于判断画面是否完整（不是只有局部） */
            fill_solid(c);
            draw_border(c == 0 ? 1 : 0);
        }

        /*
         * ── 串口后门（本板没引出 SWD，只能靠它进 BOOTSEL）────────────────
         *   发 'B' ⇒ 重启进入 BOOTSEL（直接拖 uf2 即可，不用按按键）
         *   发 'R' ⇒ 普通重启
         * 用大写，避免与其它命令冲突；用 timeout=0 非阻塞，绝不拖慢 DVI 主循环。
         */
        for (int k = 0; k < 20; k++) {          /* 500ms 内分 20 次查，响应快 */
            if (mode == 3) {                    /* 变化图形：约 40 Hz 重绘，测【更新通路】 */
                draw_moving_bar(phase++, 16);
            }
            int ch = getchar_timeout_us(0);
            if (ch == 'B') {                    /* 'B' ⇒ BOOTSEL */
                printf("\n[backdoor] BOOTSEL reboot...\n");
                sleep_ms(50);
                reset_usb_boot(0, 0);           /* 不再返回 */
            } else if (ch == 'R') {             /* 'R' */
                printf("\n[backdoor] reboot...\n");
                sleep_ms(50);
                watchdog_reboot(0, 0, 0);       /* 不再返回 */
            } else if (ch == 'D') {             /* 'D' ⇒ 打印 DMA 块表快照 */
                dump_dma_dbg();
            } else if (ch == 'L') {             /* 'L' ⇒ 行中快照（Core0 直读寄存器） */
                dump_live_regs();
            } else if (ch == 'T') {             /* 'T' ⇒ 一行之内的块指针轨迹 */
                trace_line();
            } else if (ch >= '0' && ch <= '7') { /* '0'..'7' ⇒ 冻结到该颜色（并切回纯色模式） */
                frozen = ch - '0';
                freeze = 1;
                mode = 0;
                printf("\n[freeze] 停住，颜色=%d（0黑 1白 2红 3绿 4蓝 5黄 6青 7品红）\n", frozen);
                fflush(stdout);
            } else if (ch == 'C') {             /* 'C' ⇒ 恢复自动轮换 */
                freeze = 0;
                mode = 0;
                printf("\n[freeze] 恢复自动轮换\n");
                fflush(stdout);
            } else if (ch == 'M') {             /* 'M' ⇒ 颜色尺（读纵向偏移）*/
                mode = 7;
                printf("\n[mode] 颜色尺：自上而下 白红绿蓝黄青品红白（每行全宽）\n");
                fflush(stdout);
            } else if (ch == 'K') {             /* 'K' ⇒ 校准图（大格子 + 四边四色 ✓）*/
                mode = 4;
                printf("\n[mode] 校准图：横 8 格 × 纵 6 格；上红 下绿 左蓝 右黄\n");
                fflush(stdout);
            } else if (ch == '8') {             /* '8' ⇒ 第 3 层：竖条纹 */
                mode = 1;
                printf("\n[mode] vertical stripes\n");
                fflush(stdout);
            } else if (ch == '9') {             /* '9' ⇒ 第 3 层：棋盘格 */
                mode = 2;
                printf("\n[mode] checkerboard 8x8\n");
                fflush(stdout);
            } else if (ch == 'A') {             /* 'A' ⇒ 第 4 层：变化图形（扫动条） */
                mode = 3;
                phase = 0;
                printf("\n[mode] moving bar (animated)\n");
                fflush(stdout);
            } else if (ch == 'G') {
                /*
                 * 'G' ⇒ 2026-10-05 新增诊断：把【我们写的帧缓冲】打出来。
                 * 起因：屏幕恒为纯白，切颜色/图案/TMDS 符号全不变 ✗ ⇒ 必须分清两种可能：
                 *   ① Core0 写 g_fb 没生效 ✗  ② 下游（PIO/引脚/面板）把它压成了恒定 ✗
                 * 竖条纹模式下 g_fb 应当是 01 00 01 00 ...（1=白 0=黑）。
                 * 注意：不能 extern 引擎里的 fb_buf/fb_w/fb_h/palette_rgb565 —— 它们是
                 * frank_hdmi.c 的 static，链不上（2026-10-05 实测 undefined reference ✗）。
                 */
                {   /* 探针 v2 读数：生产者最近 16 行（logical_y / 缓冲指针）✓ */
                    extern volatile int32_t  g_plog_y[16];
                    extern volatile uint32_t g_plog_buf[16];
                    extern volatile uint32_t g_plog_n;
                    printf("[plog] n=%lu y=", (unsigned long)g_plog_n);
                    for (int _i = 0; _i < 16; _i++) printf(" %ld", (long)g_plog_y[_i]);
                    printf("\n[plog] buf=");
                    for (int _i = 0; _i < 16; _i++) printf(" %08lx", (unsigned long)g_plog_buf[_i]);
                    printf("\n");
                    fflush(stdout);
                }                {   /* 探针 v3 读数：最近 16 次的 v_ctr 与取新标记 ✓ */
                    extern volatile int32_t  g_ctr_log[16];
                    extern volatile int32_t  g_ctr_took[16];
                    extern volatile uint32_t g_ctr_n;
                    printf("[ctr] n=%lu v=", (unsigned long)g_ctr_n);
                    for (int _i = 0; _i < 16; _i++) printf(" %ld", (long)g_ctr_log[_i]);
                    printf("\n[ctr] took=");
                    for (int _i = 0; _i < 16; _i++) printf(" %ld", (long)g_ctr_took[_i]);
                    printf("\n");
                    fflush(stdout);
                }                printf("\n[g] g_fb=%p  engine_fb=%p  engine_w=%d engine_h=%d  mode=%d freeze=%d c=%d\n",
                       (const void *)g_fb, (const void *)frank_hdmi_get_buffer(),
                       frank_hdmi_get_buffer_w(), frank_hdmi_get_buffer_h(),
                       mode, freeze, (int)c);
                printf("[g] MATCH (engine_fb == g_fb) : %s\n",
                       (frank_hdmi_get_buffer() == g_fb) ? "YES" : "NO");
                printf("[g] g_fb row120[0..15]=");
                for (int k = 0; k < 16; k++) printf(" %02x", g_fb[120 * FB_W + k]);
                printf("\n[g] g_fb row120[160..175]=");
                for (int k = 0; k < 16; k++) printf(" %02x", g_fb[120 * FB_W + 160 + k]);
                printf("\n[g] g_fb row240[0..15]=");
                for (int k = 0; k < 16; k++) printf(" %02x", g_fb[239 * FB_W + k]);
                int uniq = 0;
                for (int v = 0; v < 256; v++) {
                    for (int k = 0; k < 256; k++) {
                        if (g_fb[120 * FB_W + k] == v) { uniq++; break; }
                    }
                }
                printf("\n[g] distinct values in MIDDLE row's first 256 px=%d\n", uniq);
                fflush(stdout);
            }
            sleep_ms(25);
        }
    }
}
