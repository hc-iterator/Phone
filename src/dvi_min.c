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

int main(void)
{
    /*
     * 时钟与电压。252MHz 是微雪官方 demo 的值；
     * 不要用库 README 推荐的 504MHz —— 实测在本板上会把 Core1 打到 HardFault。
     */
    vreg_set_voltage(VREG_VOLTAGE_1_25);
    sleep_ms(10);
    set_sys_clock_khz(252000, true);

    stdio_init_all();

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

    while (true) {
        uint8_t c = seq[i];
        fill_solid(c);

        /* 用对比色画边框，便于判断画面是否完整（不是只有局部） */
        draw_border(c == 0 ? 1 : 0);

        i = (i + 1) % (int)(sizeof(seq) / sizeof(seq[0]));

        /*
         * ── 串口后门（本板没引出 SWD，只能靠它进 BOOTSEL）────────────────
         *   发 'B' ⇒ 重启进入 BOOTSEL（直接拖 uf2 即可，不用按按键）
         *   发 'R' ⇒ 普通重启
         * 用大写，避免与其它命令冲突；用 timeout=0 非阻塞，绝不拖慢 DVI 主循环。
         */
        for (int k = 0; k < 20; k++) {          /* 500ms 内分 20 次查，响应快 */
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
            }
            sleep_ms(25);
        }
    }
}
