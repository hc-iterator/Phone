/*
 * hstx_copy.c —— HSTX(12-19) → PIO 复制 → GPIO0-7；带【启动门】的自救型验证固件
 * =============================================================================
 * 2026-10-12 第二版。与第一版的差别（第一版烧上去是黑屏，且会失联）：
 *   ★ 启动门：上电【不超频、不碰 HSTX】，只在串口等命令。
 *     ⇒ 任何时候上电都不会挂死；配合 RUN 脚/BOOTSEL 可无限次重试，绝不失联。
 *   ★ 复制目标改成 GPIO0-7（2 号系统上 0-20 与采样 RP2040 逐脚相连，便于用采样端验收）
 *   ★ 增加 T 命令：本板自己的引脚自测（逐脚驱动、看谁跟着动）——查短路/悬空
 *   ★ 增加 P 命令：打印现场（时钟 / PIO1 CTRL+FSTAT / SM ADDR / 0-20 电平）
 *
 * ── 为什么这样接（时钟必须三档对齐）──
 *   · TMDS 640x480p60：像素时钟 25.2 MHz、每 lane 位率 252 Mbit/s
 *   · HSTX：sys 252 MHz + HSTX div2 + CSR div5 ⇒ 25.2 MHz ✓（CMake 里设的 MODE_HSTX_CLK_DIV=2）
 *   · PIO：clkdiv=1 ⇒ 1 指令/系统时钟 = 252 M 指令/秒；程序体只有一条 `mov pins, pins`
 *          ⇒ 1 指令 = 1 位 = 逐位同速 ✓
 *
 * ── 引脚映射（对基址）──
 *   HSTX 侧（硅片硬连，不可改）：CLK=12/13  D0=14/15  D1=16/17  D2=18/19
 *   复制到：CLK→0/1  D0→2/3  D1→4/5  D2→6/7
 *
 * ── 串口命令（都带 CR 或不带都行，逐个字符解析）──
 *   S = 启动（超频 + HSTX + PIO 复制）      Q = 停止（关 HSTX + 停 PIO，回空闲）
 *   T = 引脚自测（逐脚驱动 0..20）          P = 打印现场
 *   B = 进 BOOTSEL                          R = 重启
 *   其它可见字符 = 打印菜单
 */
#include <stdio.h>
#include <string.h>

#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/bootrom.h"
#include "hardware/clocks.h"
#include "hardware/vreg.h"
#include "hardware/pio.h"
#include "hardware/gpio.h"
#include "hardware/structs/sio.h"
#include "hardware/dma.h"
#include "hardware/structs/clocks.h"
#include "hardware/watchdog.h"

#include "pico_hdmi/hstx_data_island_queue.h"
#include "pico_hdmi/video_output.h"      // 非 rt 路径：它读 MODE_HSTX_CLK_DIV

// ---------------------------------------------------------------------------
// 引脚
// ---------------------------------------------------------------------------
#define PIN_N           21          // 0..20 全部参与（与采样端逐脚相连）

#define PIN_HSTX_CLK    12
#define PIN_HSTX_D0     14
#define PIN_HSTX_D1     16
#define PIN_HSTX_D2     18

#define PIN_COPY_CLK    0           // CLK 对复制到这里（0/1）
#define PIN_COPY_D0     2
#define PIN_COPY_D1     4
#define PIN_COPY_D2     6

static const uint8_t pair_in[4]  = { PIN_HSTX_CLK, PIN_HSTX_D0, PIN_HSTX_D1, PIN_HSTX_D2 };
static const uint8_t pair_out[4] = { PIN_COPY_CLK, PIN_COPY_D0, PIN_COPY_D1, PIN_COPY_D2 };

// ---------------------------------------------------------------------------
// 画面：8 色竖条（RGB565）
// ---------------------------------------------------------------------------
#define FRAME_W 640
#define FRAME_H 480

static const uint16_t color_bars[8] = {
    0xFFFF, 0xFFE0, 0x07FF, 0x07E0, 0xF81F, 0xF800, 0x001F, 0x0000
};

static void __scratch_x("") scanline_cb(uint32_t v_scanline, uint32_t active_line, uint32_t *dst)
{
    (void)v_scanline; (void)active_line;
    const int bars = 8;
    for (int b = 0; b < bars; b++) {
        const uint16_t c = color_bars[b];
        const uint32_t packed = (uint32_t)c | ((uint32_t)c << 16);
        const int start = b * (FRAME_W / bars) / 2;
        const int end   = (b + 1) * (FRAME_W / bars) / 2;
        for (int i = start; i < end; i++) dst[i] = packed;
    }
}

// ---------------------------------------------------------------------------
// PIO 复制层：4 个 SM，每个一条 `mov pins, pins`（0xA000），wrap=0
// ---------------------------------------------------------------------------
static const uint16_t copy_prog_insn[1] = { 0xA000u };          /* mov pins, pins  */
static const uint16_t copy_prog_insn_inv[1] = { 0xA008u };      /* mov pins, !pins（整字节取反 ⇒ 四对 P/N 全交换）*/
static const struct pio_program copy_prog_inv = {
    .instructions = copy_prog_insn_inv, .length = 1, .origin = -1,
};
static bool g_relay_invert = false;   /* 第二级是否取反（极性选项） */
static const struct pio_program copy_prog = {
    .instructions = copy_prog_insn,
    .length = 1,
    .origin = -1,
};

static PIO      g_pio = NULL;
static uint32_t g_sm_mask = 0;
static uint32_t g_prog_off[4] = { 0, 0, 0, 0 };
static bool     g_started = false;

static void pio_copy_start(void)
{
    if (g_started) return;
    g_pio = pio1;
    g_sm_mask = 0;

    for (int i = 0; i < 4; i++) {
        const int sm = pio_claim_unused_sm(g_pio, true);
        g_prog_off[i] = pio_add_program(g_pio, &copy_prog);

        pio_sm_config c = pio_get_default_sm_config();
        sm_config_set_wrap(&c, g_prog_off[i], g_prog_off[i]);
        sm_config_set_in_pins(&c, pair_in[i]);          // 读：HSTX 那对（偶数脚为基址）
        sm_config_set_out_pins(&c, pair_out[i], 2);     // 写：复制目标那对
        sm_config_set_clkdiv(&c, 1.0f);                 // 1 指令/系统时钟 = 252 M/s
        pio_sm_init(g_pio, sm, g_prog_off[i], &c);

        // 输出脚交给 PIO 并设为输出；输入脚【绝不碰】（必须保持 HSTX 功能，HSTX 才驱得动）
        pio_gpio_init(g_pio, pair_out[i]);
        pio_gpio_init(g_pio, pair_out[i] + 1);
        pio_sm_set_consecutive_pindirs(g_pio, sm, pair_out[i], 2, true);

        g_sm_mask |= 1u << sm;
    }
    pio_enable_sm_mask_in_sync(g_pio, g_sm_mask);       // 四 SM 同步启动
    g_started = true;
}

static void pio_copy_stop(void)
{
    if (!g_started) return;
    pio_set_sm_mask_enabled(g_pio, g_sm_mask, false);
    for (int i = 0; i < 4; i++) {
        // 把复制输出脚还回 SIO 输入态（不驱动），免得干扰 T 自测
        gpio_init(pair_out[i]);
        gpio_set_dir(pair_out[i], GPIO_IN);
        gpio_init(pair_out[i] + 1);
        gpio_set_dir(pair_out[i] + 1, GPIO_IN);
    }
    g_started = false;
}

// ---------------------------------------------------------------------------
// A：拉【采样板】的 RUN（用户 2026-10-12 新加的线：待测板 GPIO42 -> 探针 RUN）
//    意义：两个方向都能复位了 —— 采样板 Z 拉待测板 RUN，待测板 A 拉采样板 RUN。
// ---------------------------------------------------------------------------
#define PIN_SAMPLER_RUN 42

static void pulse_sampler_run(void)
{
    gpio_init(PIN_SAMPLER_RUN);
    gpio_set_dir(PIN_SAMPLER_RUN, GPIO_OUT);
    gpio_put(PIN_SAMPLER_RUN, 0);
    printf("[A] 拉采样板 RUN（GPIO42）低 100ms ...\n"); fflush(stdout);
    sleep_ms(100);
    gpio_set_dir(PIN_SAMPLER_RUN, GPIO_IN);          /* 释放：外部上拉把 RUN 拉回高 */
    printf("[A] 已释放\n"); fflush(stdout);
}

// ---------------------------------------------------------------------------
// 单脚持续驱动（主机手动对拍用）：H = 持续驱动 GPIO11 高，N = 释放
// ---------------------------------------------------------------------------
static int g_hold_pin = -1;

static void hold_pin(int p, bool on)
{
    if (on) {
        if (g_hold_pin >= 0 && g_hold_pin != p) { gpio_put(g_hold_pin, 0); gpio_set_dir(g_hold_pin, GPIO_IN); }
        gpio_init(p);
        gpio_set_dir(p, GPIO_OUT);
        gpio_put(p, 1);
        g_hold_pin = p;
        printf("[hold] GPIO%d 持续驱动高。现在去观察板读 now 位图（发 N 释放）\n", p);
    } else {
        if (g_hold_pin >= 0) {
            gpio_put(g_hold_pin, 0);
            gpio_set_dir(g_hold_pin, GPIO_IN);
            printf("[hold] 已释放 GPIO%d\n", g_hold_pin);
        }
        g_hold_pin = -1;
    }
    fflush(stdout);
}

// ---------------------------------------------------------------------------
// 现场打印
// ---------------------------------------------------------------------------
static void print_pins(void)
{
    printf("  PINS lo=0x%08lx hi=0x%08lx\n",
           (unsigned long)sio_hw->gpio_in, (unsigned long)sio_hw->gpio_hi_in);
}

static void print_diag(void)
{
    printf("\n--- DIAG ---\n");
    printf("  sys_clk = %lu Hz   vreg_set=%d\n",
           (unsigned long)clock_get_hz(clk_sys), (int)(clock_get_hz(clk_sys) / 1000000));
    printf("  HSTX video: %s   video_frame_count=%lu\n",
           g_started ? "started" : "not started", (unsigned long)video_frame_count);
    if (g_pio) {
        printf("  PIO1 CTRL=0x%08lx FSTAT=0x%08lx (sm_mask=0x%lx)\n",
               (unsigned long)g_pio->ctrl, (unsigned long)g_pio->fstat, (unsigned long)g_sm_mask);
        printf("    PIO1 CTRL/FSTAT 见上（诊断已缩短，避免刷屏卡死）\n");
    }
    print_pins();
    printf("--- END DIAG ---\n\n");
}

// ---------------------------------------------------------------------------
// T：本板引脚自测（逐脚驱动高，看谁跟着动 ⇒ 查短路/悬空）
//     ⚠️ 先把 PIO 停掉并把 0-20 全部设成 SIO，避免与 PIO 抢脚
// ---------------------------------------------------------------------------
static void pin_selftest(void)
{
    printf("\n--- PIN WALK (GPIO0..20，每脚高 60ms / 低 40ms) ---\n");
    printf("  查线流程：采样端先按 X 清零 -> 让我走这一遍 -> 采样端按 S 看 STICKY\n");
    fflush(stdout);
    pio_copy_stop();
    hold_pin(0, false);         /* 先释放任何单脚保持 */

    for (int p = 0; p < PIN_N; p++) {
        gpio_init(p);
        gpio_set_dir(p, GPIO_IN);
        gpio_pull_down(p);
    }
    sleep_ms(10);

    for (int p = 0; p < PIN_N; p++) {
        gpio_set_dir(p, GPIO_OUT);
        gpio_put(p, 1);
        sleep_ms(60);                                   // 保持高：够采样端 10ms 粒度抓住
        uint32_t v = gpio_get_all() & 0x1FFFFFu;
        gpio_put(p, 0);
        gpio_set_dir(p, GPIO_IN);

        uint32_t others = v & ~(1u << p);
        printf("  GPIO%-2d HIGH  self=%d", p, (int)((v >> p) & 1u));
        if (others) printf("   ⚠ 本板另有脚跟着高: 0x%07lx（短路/同网）", (unsigned long)others);
        printf("\n");
        fflush(stdout);
        sleep_ms(40);
    }
    printf("--- END PIN WALK ---\n\n");
    fflush(stdout);
}

// ---------------------------------------------------------------------------
// 启动 HSTX + 复制
// ---------------------------------------------------------------------------
static bool g_video_started = false;
static bool g_slow = false;
static int  g_relay_div = 1;      /* 中继分频：与位率同步（生产=1；对拍降速=8） */

static void start_video(bool with_copy)
{
    if (g_video_started) { printf("[start] 视频已启动过，跳过\n"); fflush(stdout); return; }
    printf("[start] vreg 1.25V + sys 252MHz ...\n"); fflush(stdout);
    if (g_slow) {
        printf("[start] 慢档：sys=31.5MHz（TMDS 位率同步降到 1/8，供采样板 8x 过采样解码）\n"); fflush(stdout);
        set_sys_clock_khz(31500, true);
        g_video_started = false;
    } else {
        vreg_set_voltage(VREG_VOLTAGE_1_25);
        sleep_ms(50);
    }
    bool ok = g_slow ? true : set_sys_clock_khz(252000, true);
    printf("[start] set_sys_clock_khz(252000) = %d, now %lu Hz\n",
           (int)ok, (unsigned long)clock_get_hz(clk_sys));

    if (with_copy) {
        pio_copy_start();
        printf("[start] PIO1 复制层已启动 sm_mask=0x%lx（0/1=CLK 2/3=D0 4/5=D1 6/7=D2）\n",
               (unsigned long)g_sm_mask);
    } else {
        printf("[start] 只出 HSTX，不做 PIO 复制（供 1 号系统：12-19 用跳线接 32-39）\n");
    }

    hstx_di_queue_init();
    video_output_init(FRAME_W, FRAME_H);
    video_output_set_dvi_mode(true);
    video_output_set_scanline_callback(scanline_cb);
    multicore_launch_core1(video_output_core1_run);
    g_video_started = true;
    printf("[start] HSTX 已启动（Core1）\n"); fflush(stdout);

    sleep_ms(500);
    print_diag();
}

// ---------------------------------------------------------------------------
// W：两级 PIO 中继 —— 一个实例读低窗口、另一个实例写高窗口，中间经"脚"流过去
//   PIO0(base 0) : IN=12  OUT=20  驱动 20-27   <- 读 HSTX 的 12-19
//   PIO1(base 16): IN=20  OUT=32  驱动 32-39   <- 读 PIO0 刚驱动的 20-27（同一批 pad，无需接线）
//   两级延迟对 4 条 lane 相同 ⇒ 相对偏移 0；全程无缓冲/无 DMA ⇒ 无抖动
// ---------------------------------------------------------------------------
static bool g_relay_started = false;

static void relay_start(bool mirror)
{
    if (g_relay_started) return;
    g_relay_started = true;

    /* 第一级 PIO0(base 0)：4 个 SM，每对差分线一个，按【HDMI 座的配对顺序】落到中间脚 20-27
     *   HSTX: 12/13=CLK 14/15=D0 16/17=D1 18/19=D2
     *   HDMI: 32/33=D2  34/35=D1  36/37=D0  38/39=CLK   ⇒ 中间块排成 D2,D1,D0,CLK
     * 每个 SM 只把自己那 2 个目标脚设成输出 ⇒ 窗口内其余位写了也不驱动 */
    const uint relay_div = g_relay_div;
    static const struct { int in_pin; int out_pin; } st1[4] = {
        { 18, 20 },   /* D2  */
        { 16, 22 },   /* D1  */
        { 14, 24 },   /* D0  */
        { 12, 26 },   /* CLK */
    };
    pio_set_gpio_base(pio0, 0);
    uint mask0 = 0;
    for (int i = 0; i < 4; i++) {
        int sm = pio_claim_unused_sm(pio0, true);
        uint off = pio_add_program(pio0, &copy_prog);
        pio_sm_config c = pio_get_default_sm_config();
        sm_config_set_wrap(&c, off, off);
        sm_config_set_in_pins(&c, (uint)st1[i].in_pin);
        sm_config_set_out_pins(&c, (uint)st1[i].out_pin, 2);
        sm_config_set_clkdiv(&c, (float)relay_div);
        pio_sm_init(pio0, sm, off, &c);
        pio_gpio_init(pio0, (uint)st1[i].out_pin);
        pio_gpio_init(pio0, (uint)(st1[i].out_pin + 1));
        pio_sm_set_consecutive_pindirs(pio0, sm, (uint)st1[i].out_pin, 2, true);
        mask0 |= 1u << sm;
    }

    /* 第二级 PIO1(base 16)：一个 SM 直通 20-27 -> 32-39（顺序已在第一级排好） */
    pio_set_gpio_base(pio1, mirror ? 0 : 16);
    int sm1 = pio_claim_unused_sm(pio1, true);
    uint off1 = pio_add_program(pio1, g_relay_invert ? &copy_prog_inv : &copy_prog);
    pio_sm_config c1 = pio_get_default_sm_config();
    sm_config_set_wrap(&c1, off1, off1);
    sm_config_set_in_pins(&c1, 20);
    sm_config_set_out_pins(&c1, mirror ? 0 : 32, 8);
    sm_config_set_clkdiv(&c1, (float)relay_div);
    pio_sm_init(pio1, sm1, off1, &c1);
    for (int q = (mirror ? 0 : 32); q < (mirror ? 8 : 40); q++) pio_gpio_init(pio1, (uint)q);
    pio_sm_set_consecutive_pindirs(pio1, sm1, (uint)(mirror ? 0 : 32), 8, true);
    printf("[relay] 第二级 -> %s\n", mirror ? "GPIO0-7（镜像，供采样解码）" : "GPIO32-39（真实 HDMI 座）");

    pio_enable_sm_mask_in_sync(pio0, mask0);
    pio_enable_sm_mask_in_sync(pio1, 1u << sm1);
}

static void activity(const char *tag, volatile uint32_t *reg, uint32_t mask)
{
    uint32_t last = *reg & mask, n = 0;
    absolute_time_t t = make_timeout_time_ms(20);
    while (!time_reached(t)) {
        uint32_t cur = *reg & mask;
        if (cur != last) { n++; last = cur; }
    }
    printf("  %s  mask=0x%05lx 20ms内变化=%lu 当前=0x%05lx\n",
           tag, (unsigned long)mask, (unsigned long)n, (unsigned long)(*reg & mask));
    fflush(stdout);
}

static void relay_test(void)
{
    printf("\n--- W：两级 PIO 中继（12-19 -> 20-27 -> 32-39）---\n");
    fflush(stdout);
    start_video(false);        /* 幂等：已启动就跳过 */
    relay_start(false);
    sleep_ms(150);
    printf("  PIO0 base=%u CTRL=0x%08lx | PIO1 base=%u CTRL=0x%08lx\n",
           (unsigned)pio_get_gpio_base(pio0), (unsigned long)pio0->ctrl,
           (unsigned)pio_get_gpio_base(pio1), (unsigned long)pio1->ctrl);
    activity("HSTX   12-19", &sio_hw->gpio_in,    0x000FF000u);
    activity("中继1  20-27", &sio_hw->gpio_in,    0x0FF00000u);
    activity("中继2  32-39", &sio_hw->gpio_hi_in, 0x000000FFu);
    printf("--- END W ---\n\n");
    fflush(stdout);
}

// ---------------------------------------------------------------------------
// K：逐位对拍（不依赖 RP2040 采样板）
//   1) sys 回 252MHz；2) clk_hstx 重配到 252/16=15.75MHz ⇒ 位率 31.5Mbit/s（降 8 倍）
//   3) 中继 clkdiv=8（仍与位率逐位同步）；4) 两个采样 SM(kdiv=1 = 252MSa/s ⇒ 8 采样/位)
//      分别采【源 12-19】与【输出 32-39】→ DMA 进 RAM → C 里对齐统计不一致位数
// ---------------------------------------------------------------------------
#define BER_N 4096
static uint32_t g_ber_src[BER_N];
static uint32_t g_ber_out[BER_N];
static const uint16_t samp_insn[1] = { 0x4008u };   /* in pins, 8 */
static const struct pio_program samp_prog = { .instructions = samp_insn, .length = 1, .origin = -1 };

static int ber_sampler(PIO pio, int gpio_base, int in_pin, uint32_t *dst)
{
    pio_set_gpio_base(pio, (uint)gpio_base);
    int sm = pio_claim_unused_sm(pio, true);
    uint off = pio_add_program(pio, &samp_prog);
    pio_sm_config c = pio_get_default_sm_config();
    sm_config_set_wrap(&c, off, off);
    sm_config_set_in_pins(&c, (uint)in_pin);
    sm_config_set_in_shift(&c, false, true, 8);      /* 左移? 否, autopush, 8 位 */
    sm_config_set_clkdiv(&c, 10.0f);                 /* 25.2 MSa/s（DMA 只需 100MB/s，不会反压） */
    pio_sm_init(pio, sm, off, &c);
    /* ⚠️ 不碰 pindirs、不 pio_gpio_init 输入脚：前者可能影响同实例其他 SM 的输出使能，
     *    后者会改 FUNCSEL 把 HSTX 从 12-19 上踢开。pio_sm_init 后本 SM 本来就是全输入。 */
    pio_sm_clear_fifos(pio, sm);
    int ch = dma_claim_unused_channel(true);
    dma_channel_config dc = dma_channel_get_default_config(ch);
    channel_config_set_transfer_data_size(&dc, DMA_SIZE_32);
    channel_config_set_read_increment(&dc, false);
    channel_config_set_write_increment(&dc, true);
    channel_config_set_dreq(&dc, pio_get_dreq(pio, sm, false));
    dma_channel_configure(ch, &dc, dst, &pio->rxf[sm], BER_N, false);
    pio_sm_set_enabled(pio, sm, true);
    dma_channel_start(ch);
    return (int)ch;
}

static void ber_test(void)
{
    printf("\n--- K：逐位对拍（源 12-19 vs 输出 32-39，8 采样/位）---\n"); fflush(stdout);
    watchdog_disable();                       /* 测试时间长，先关狗 */

    if (g_video_started || g_relay_started) { printf("  请先按 R 重启再发 K（本测试要求干净启动）\n\n"); return; }

    vreg_set_voltage(VREG_VOLTAGE_1_25); sleep_ms(50);
    set_sys_clock_khz(252000, true);

    /* ★ 源改用 PIO 图案发生器（同一时基、可整除），而不是 HSTX：
     *   源 SM 在 12-19 上播放固定图案（clkdiv=80 ⇒ 3.15 M 样本/秒 = 位率）；
     *   中继照抄（clkdiv=80）；两个采样 SM 以 clkdiv=10（25.2MSa/s ⇒ 8 采样/位）采源与输出。 */
    {
        static uint32_t pat[32];
        uint32_t lfsr = 0xACE1u;
        for (int i = 0; i < 32; i++) {
            uint32_t w = 0;
            for (int k = 0; k < 4; k++) {
                lfsr = (lfsr >> 1) ^ (uint32_t)(-(int32_t)(lfsr & 1u) & 0xB400u);
                w |= (lfsr & 0xFFu) << (8 * k);
            }
            pat[i] = w;
        }
        static const uint16_t out_insn[1] = { 0x6008u };  /* out pins, 8 */
        static const struct pio_program out_prog = { .instructions = out_insn, .length = 1, .origin = -1 };
        pio_set_gpio_base(pio2, 0);                       /* ★ 源放 PIO2：PIO0 的 4 个 SM 留给中继第一级 */
        int sm = pio_claim_unused_sm(pio2, true);
        uint off2 = pio_add_program(pio2, &out_prog);
        pio_sm_config c = pio_get_default_sm_config();
        sm_config_set_wrap(&c, off2, off2);
        sm_config_set_out_pins(&c, 12, 8);
        sm_config_set_out_shift(&c, true, true, 8);       /* 右移、autopull、8 位 */
        sm_config_set_clkdiv(&c, 80.0f);                  /* 3.15 M 样本/秒 */
        pio_sm_init(pio2, sm, off2, &c);
        for (int q = 12; q < 20; q++) pio_gpio_init(pio2, (uint)q);   /* 源要驱动 12-19，这里必须设 FUNCSEL */
        pio_sm_set_consecutive_pindirs(pio2, sm, 12, 8, true);
        int ch = dma_claim_unused_channel(true);
        dma_channel_config dc = dma_channel_get_default_config(ch);
        channel_config_set_transfer_data_size(&dc, DMA_SIZE_32);
        channel_config_set_read_increment(&dc, true);
        channel_config_set_write_increment(&dc, false);
        channel_config_set_dreq(&dc, pio_get_dreq(pio2, sm, true));
        channel_config_set_ring(&dc, false, 5);           /* 读地址按 32 字回绕 ⇒ 图案循环 */
        dma_channel_configure(ch, &dc, &pio2->txf[sm], pat, 0xFFFFFFFFu, true);
        pio_sm_set_enabled(pio2, sm, true);
        printf("  源：PIO0 图案发生器 12-19 @3.15M 样本/秒（DMA 环形）\n");
    }
    /* 位率降到 1/8：clk_hstx = 252/16 = 15.75MHz ⇒ 像素 3.15MHz ⇒ 位率 31.5Mbit/s */
    /* 位率 = 2 x clk_hstx；取 3.15 Mbit/s ⇒ 采样 80/位、DMA 只需 25MSa/s（能稳住不反压） */
    bool cok = clock_configure(clk_hstx, 0, CLOCKS_CLK_HSTX_CTRL_AUXSRC_VALUE_CLK_SYS,
                               252000000u, 1575000u);
    printf("  clock_configure(hstx->15.75MHz) = %d  实测 clk_hstx=%lu Hz ⇒ 位率≈%lu Mb/s\n",
           (int)cok, (unsigned long)clock_get_hz(clk_hstx),
           (unsigned long)(2 * clock_get_hz(clk_hstx) / 1000000));

    g_relay_div = 80;                      /* 252/3.15 = 80：中继与位率逐位同步 */
    relay_start(false);                    /* 真实路径：12-19 -> 20-27 -> 32-39 */
    sleep_ms(50);
    /* 先证明"pad 到底有没有在动"，把"源没驱动"与"采样读不到"分开 */
    activity("源   12-19", &sio_hw->gpio_in,    0x000FF000u);
    activity("中继1 20-27", &sio_hw->gpio_in,    0x0FF00000u);
    activity("中继2 32-39", &sio_hw->gpio_hi_in, 0x000000FFu);

    int ch_src = ber_sampler(pio2, 0, 12, g_ber_src);   /* 源：12-19 */
    int ch_out = ber_sampler(pio1, 16, 32, g_ber_out);  /* 输出：32-39 */
    printf("  —— 启动采样后再看 pad 是否还在动 ——\n");
    activity("源   12-19", &sio_hw->gpio_in,    0x000FF000u);
    activity("中继2 32-39", &sio_hw->gpio_hi_in, 0x000000FFu);
    dma_channel_wait_for_finish_blocking(ch_src);
    dma_channel_wait_for_finish_blocking(ch_out);

    /* 源侧配对顺序 (CLK,D0,D1,D2) -> 输出侧 (D2,D1,D0,CLK)：把源的 2 位一组倒过来再比 */
    int best_sh = 0; uint32_t best_mm = 0xFFFFFFFFu, raw_mm = 0;
    for (int sh = 0; sh < 120; sh++) {
        uint32_t mm = 0;
        for (int i = 0; i + sh < BER_N; i++) {
            uint32_t s = g_ber_src[i] & 0xFFu;
            uint32_t exp = ((s & 3u) << 6) | (((s >> 2) & 3u) << 4) | (((s >> 4) & 3u) << 2) | ((s >> 6) & 3u);
            mm += (uint32_t)__builtin_popcount((exp ^ (g_ber_out[i + sh] & 0xFFu)));
        }
        if (mm < best_mm) { best_mm = mm; best_sh = sh; }
        if (sh == 0) raw_mm = mm;
    }
    int nz_src = 0, nz_out = 0;
    for (int i = 0; i < BER_N; i++) { if (g_ber_src[i]) nz_src++; if (g_ber_out[i]) nz_out++; }
    printf("  非零样本: src=%d/%d  out=%d/%d\n", nz_src, BER_N, nz_out, BER_N);
    printf("  src[0..7]=%02lx %02lx %02lx %02lx %02lx %02lx %02lx %02lx\n",
           (unsigned long)(g_ber_src[0]&0xFF),(unsigned long)(g_ber_src[1]&0xFF),(unsigned long)(g_ber_src[2]&0xFF),(unsigned long)(g_ber_src[3]&0xFF),
           (unsigned long)(g_ber_src[4]&0xFF),(unsigned long)(g_ber_src[5]&0xFF),(unsigned long)(g_ber_src[6]&0xFF),(unsigned long)(g_ber_src[7]&0xFF));
    printf("  out[0..7]=%02lx %02lx %02lx %02lx %02lx %02lx %02lx %02lx\n",
           (unsigned long)(g_ber_out[0]&0xFF),(unsigned long)(g_ber_out[1]&0xFF),(unsigned long)(g_ber_out[2]&0xFF),(unsigned long)(g_ber_out[3]&0xFF),
           (unsigned long)(g_ber_out[4]&0xFF),(unsigned long)(g_ber_out[5]&0xFF),(unsigned long)(g_ber_out[6]&0xFF),(unsigned long)(g_ber_out[7]&0xFF));
    printf("  PIO0 CTRL=0x%lx PIO1 CTRL=0x%lx PIO2 CTRL=0x%lx\n",
           (unsigned long)pio0->ctrl, (unsigned long)pio1->ctrl, (unsigned long)pio2->ctrl);
    printf("  最佳对齐 = %d 采样 (%.2f 位周期)   不一致位 = %lu / %d 采样\n",
           best_sh, best_sh / 8.0, (unsigned long)best_mm, BER_N);
    printf("  (未对齐时不一致位 = %lu；若最佳对齐下为 0 ⇒ 逐位相同)\n\n", (unsigned long)raw_mm);
    fflush(stdout);
    watchdog_enable(8000, 0);                 /* 测试完重新上狗 */
}

static void print_menu(void)
{
    printf("\n===== hstx_copy v2（启动门版）=====\n");
    printf("  S = 启动（252MHz + HSTX 12-19 + PIO 复制 -> 0-7）\n");
    printf("  V = 只出 HSTX（不复制）\n");
    printf("  K = 逐位对拍（源 12-19 vs 输出 32-39，8 采样/位）\n");
    printf("  W = 两级中继实验（含测量）\n  Y = HSTX + 两级中继 -> 32-39（出图）\n  M = 镜像版 -> 0-7（供采样解码）\n  L = 慢档 31.5MHz 开关\n");
    printf("  Q = 停止（关 HSTX、停 PIO、回空闲）\n");
    printf("  T = 引脚自测（逐脚驱动 0..20）\n");
    printf("  Z = 同 Y 但四对 P/N 取反（黑屏时换它试）\n  A = 拉采样板 RUN（GPIO42）  H[脚号] = 持续驱动某脚高（默认 10）   N = 释放\n");
    printf("  P = 打印现场\n");
    printf("  B = 进 BOOTSEL    R = 重启\n");
    printf("当前：空闲（未超频、未启动 HSTX）\n\n");
    fflush(stdout);
}

int main(void)
{
    // ★ 启动门：先不起任何危险的东西
    /* ★ 自愈保险：8 秒没喂狗就硬件复位，回到"等命令"的启动门。
     * 这样即使固件跑飞/panic，也不需要人去按 BOOTSEL —— 板子自己会回来。 */
    watchdog_enable(8000, 0);
    stdio_init_all();
    sleep_ms(300);
    printf("\n[hstx_copy] 上电。sys_clk=%lu Hz（默认档，未超频）\n",
           (unsigned long)clock_get_hz(clk_sys));
    print_menu();

    while (true) {
        watchdog_update();                       /* ★ 喂狗 */
        int ch = getchar_timeout_us(10000);     // 10ms 轮询：既省电又不丢键
        if (ch == PICO_ERROR_TIMEOUT) continue;

        switch (ch) {
        case 'S': case 's': start_video(true);  break;   /* 带 PIO 复制（2 号系统：0-7） */
        case 'V': case 'v': start_video(false); break;   /* 只出 HSTX */
        case 'W': case 'w': relay_test(); break;          /* 两级 PIO 中继实验 + 测量 */
        case 'Z': case 'z': g_relay_invert = true;  printf("[Z] 极性取反版（四对 P/N 交换）\n"); fflush(stdout);
                            start_video(false); relay_start(false); printf("[Z] HSTX + 两级中继(取反) -> 32-39\n"); fflush(stdout); break;
        case 'Y': case 'y': start_video(false); relay_start(false); printf("[Y] HSTX + 两级中继 -> 32-39\n"); fflush(stdout); break;
        case 'M': case 'm': start_video(false); relay_start(true);  printf("[M] 镜像：两级中继 -> 0-7（采样板可解码）\n"); fflush(stdout); break;
        case 'K': case 'k': ber_test(); break;   /* 逐位对拍（BER） */
        case 'L': case 'l': g_slow = !g_slow; printf("[L] 慢档 = %d（下次 S/V/Y/M 生效）\n", (int)g_slow); fflush(stdout); break;
        case 'Q': case 'q':
            pio_copy_stop();
            printf("[stop] PIO 已停（HSTX 若已启动则仍在跑；要彻底复位请按 R）\n");
            fflush(stdout);
            break;
        case 'T': case 't': pin_selftest(); break;
        case 'A': case 'a': pulse_sampler_run(); break;   /* 拉采样板 RUN */
        case 'H': case 'h': {                               /* 单脚对拍：H 默认 GPIO10；H<0-2位数字> 指定 */
            int pin = 0, n = 0;
            while (n < 2) {
                int d = getchar_timeout_us(200000);
                if (d < '0' || d > '9') break;
                pin = pin * 10 + (d - '0'); n++;
            }
            hold_pin(n ? pin : 10, true);
            break;
        }
        case 'N': case 'n': hold_pin(0, false); break;      /* 释放 */
        case 'P': case 'p': print_diag(); break;
        case 'B': case 'b':
            printf("[backdoor] BOOTSEL reboot...\n"); fflush(stdout);
            sleep_ms(50);
            reset_usb_boot(0, 0);
            break;
        case 'R': case 'r':
            printf("[backdoor] reboot...\n"); fflush(stdout);
            sleep_ms(50);
            watchdog_reboot(0, 0, 0);
            break;
        case '\r': case '\n': break;
        default: print_menu(); break;
        }
    }
}
