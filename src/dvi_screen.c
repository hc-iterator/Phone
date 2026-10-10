/*
 * dvi_screen.c —— HDMI 屏幕驱动（微雪 RP2350-PiZero，PIO bitbang DVI + HDMI 音频）
 *
 * ── 为什么不用 pico_hdmi ──
 *
 * pico_hdmi 走的是 RP2350 的 HSTX 硬件外设，而 HSTX 在硅片上【硬连】GPIO 12..19：
 * SDK 的 io_bank0.h 覆盖 GPIO 0..47，其中带 FUNCSEL_VALUE_HSTX 的只有
 * GPIO12..19 八个（GPIO12→HSTX_0 ... GPIO19→HSTX_7），没有第二个 bank。
 *
 * 而微雪 RP2350-PiZero 的 DVI 座接在 GPIO32..39：
 *      32/33 D2、34/35 D1、36/37 D0、38/39 CLK
 * 微雪官方 demo 自己也写明是基于 Wren6991/PicoDVI —— 那是【PIO bitbang】方案。
 * 所以这块板子不可能走 HSTX，必须用 PIO。
 *
 * ── 为什么用 frank-hdmi-sound 而不是微雪自带的 libdvi ──
 *
 * 原版 PicoDVI / 微雪 libdvi 只发 DVI，不发声（所以它叫 DVI）。
 * 而 HDMI 音频是走消隐期的 Data Island 包传的。
 * 这块屏有 3.5mm 音频引出口，说明它从 HDMI 流里解音频，
 * 所以我们需要带 data island 的实现。
 *
 * frank-hdmi-sound（vendored 在 frank-hdmi-sound/）基于 shuichitakano 的
 * PicoDVI-audio 分支，在 libdvi 基础上加了 HDMI 数据岛音频：
 *   - 640x480p60 视频
 *   - 32kHz 立体声 PCM 嵌在同一路 HDMI 流里
 *   - 8bpp 调色板帧缓冲，逻辑分辨率 320x240（libdvi 的 16bpp 编码器做像素加倍）
 *   - Core1 跑 DVI 引擎，Core0 留给应用 —— 正合本项目的手机 OS 架构
 *
 * ⚠️ 2026 两点更正（我排查时差点被这两处带偏，写下来免得下次再绕）：
 *   1. 音频目前是【关】的：`FRANK_HDMI_ENABLE_AUDIO=0`（在 frank_hdmi.h 里）。
 *      关它是因为开音频会重建全部扫描线 DMA 表，得先单独验纯视频。
 *   2. "8bpp"说的是【接口】：调用方给的是 uint8_t 调色板索引缓冲，
 *      库内部 `fill_scanline()` 把它转成 RGB565 扫描线，再交给那个
 *      名叫 `encode_one_scanline_16bpp()` 的编码器。
 *      所以"帧缓冲 8bpp / 编码器 16bpp"【不是 bug】，是设计如此。
 *
 * ── 引脚与时钟 ──
 *
 * 引脚通过 CMake 宏传入（见顶层 CMakeLists.txt）：
 *   FRANK_HDMI_PIN_CLK=38, D0=36, D1=34, D2=32
 * 与微雪 demo 的 pico_sock_cfg（pins_tmds={36,34,32}, pins_clk=38,
 * invert_diffpairs=false）一致。
 *
 * 系统时钟用 252MHz：CMake 里 FRANK_HDMI_SM_CLKDIV=1，
 * 于是 TMDS 位时钟 = CPU = 252MHz，正好是 640x480p60 需要的。
 * 不需要 2 倍超频，也不用 504MHz。
 *
 * ⚠️ 2026 更正：这里原来写的是"必须 504MHz / DVI_SM_CLKDIV=2"，
 *    那是照抄库 README 的写法。实测 504MHz 会把 Core1 打到 HardFault、
 *    Core0 卡到连 SWD 都 halt 不住。代码早已改成 252MHz，注释是旧的。
 */

#include <stdio.h>
#include <string.h>

#include "pico/stdlib.h"
#include "pico/multicore.h"

#include "hardware/clocks.h"
#include "hardware/vreg.h"

#include "frank_hdmi.h"
#include "frank_dvi.h"   /* struct dvi_inst / dvi0：周期性串口诊断要用（2026-10-01 深夜加） */

#include "dvi_screen.h"
#include "kernel.h"          /* kernel_mark / kernel_read_control：第 18 轮探针 */

/* Core0 侧存活信标（见 dvi_screen.h 的说明：排查时必须两个计数器一起读） */
volatile uint32_t g_dvi_loop_frames = 0;

/* ★ 2026-10-02 诊断"Core0 周期重启"：
 *   g_entry_count      —— dvi_screen_test() 入口计数，只增不减
 *   g_loop_iter_total  —— 主循环迭代总数，只增不减（不随任何重置归零）
 * 判读：若 g_entry_count 停在 1 而 g_loop_iter_total 一直在涨 ⇒ 主循环其实【没重启】，
 *       之前看到的 g_dvi_loop_frames 归零是别的原因。
 *       若 g_entry_count 持续增长 ⇒ 函数真的被反复重入。 */
volatile uint32_t g_entry_count     = 0;
volatile uint32_t g_loop_iter_total = 0;

/* ★ 2026-10-02 引擎看门狗：
 *   实测（读硬件寄存器）确认了间歇性死锁：所有 DMA 通道 EN=0（链停），
 *   而 PIO 三个状态机仍在跑、TX FIFO 还有数据 ⇒ DMA 链要靠"完成中断"重新装载、
 *   处理器要等"DMA 完成"才有中断 ⇒ 一旦掉进"未完成"状态就永远互等 ✗
 *   这里在应用侧兜底：主循环定期检查引擎是否还在出帧，没进展就重启引擎。
 *   ⇒ 把"永久卡死"降级成"最多卡约 2 秒后自愈"，直接服务目标的"长时间连续出帧"。 */
volatile uint32_t g_engine_restarts   = 0;   /* 看门狗触发重启引擎的次数（SWD 可读） */
volatile uint32_t g_engine_stuck_seen = 0;   /* 见过多少次"没进展"的检测点 */

/* 时钟诊断（2026-10-01 深夜加）：引擎行率只有应有值的 1/13，
 * 而 PIO SM 分频、PWM 像素时钟都已排除 ⇒ 只剩"sys_clk 到底是不是 252MHz"没查。
 * 这两个变量就是为它准备的，查完可以删。 */
volatile uint32_t g_dbg_setclk_ok   = 0;   /* set_sys_clock_khz(252000,true) 的返回值 */
volatile uint32_t g_dbg_sys_clk_hz  = 0;   /* clock_get_hz(clk_sys) 实测值 */

// ============================================================================
// 屏幕参数
// ============================================================================

/*
 * 逻辑帧缓冲 320x240，8bpp 调色板索引。
 * 上屏是 640x480（编码器做 2 倍像素加倍），所以实际是 320x240 的内容铺满。
 */
#define FB_W  FRANK_HDMI_LOGICAL_WIDTH    /* 320 */
#define FB_H  FRANK_HDMI_LOGICAL_HEIGHT   /* 240 */

static uint8_t g_fb[FB_W * FB_H];

// ============================================================================
// 调色板
// ============================================================================

/*
 * 调色板是 256 项 RGB888。这里前 16 项做成常用色，
 * 其余留给以后画界面（文字抗锯齿、渐变等）。
 *
 * 索引 0 故意留黑，作为背景。
 */
enum {
    C_BLACK = 0,
    C_WHITE,
    C_RED,
    C_GREEN,
    C_BLUE,
    C_YELLOW,
    C_CYAN,
    C_MAGENTA,
    C_ORANGE,
    C_NAVY,
    C_GRAY,
    C_DARKGREEN,
    C_PURPLE,
    C_BROWN,
    C_PINK,
    C_LIGHTGRAY,
};

static void palette_init(void)
{
    frank_hdmi_set_palette(C_BLACK,      0x000000);
    frank_hdmi_set_palette(C_WHITE,      0xFFFFFF);
    frank_hdmi_set_palette(C_RED,        0xFF0000);
    frank_hdmi_set_palette(C_GREEN,      0x00FF00);
    frank_hdmi_set_palette(C_BLUE,       0x0000FF);
    frank_hdmi_set_palette(C_YELLOW,     0xFFFF00);
    frank_hdmi_set_palette(C_CYAN,       0x00FFFF);
    frank_hdmi_set_palette(C_MAGENTA,    0xFF00FF);
    frank_hdmi_set_palette(C_ORANGE,     0xFF8000);
    frank_hdmi_set_palette(C_NAVY,       0x000080);
    frank_hdmi_set_palette(C_GRAY,       0x808080);
    frank_hdmi_set_palette(C_DARKGREEN,  0x008000);
    frank_hdmi_set_palette(C_PURPLE,     0x800080);
    frank_hdmi_set_palette(C_BROWN,      0x804000);
    frank_hdmi_set_palette(C_PINK,       0xFFC0CB);
    frank_hdmi_set_palette(C_LIGHTGRAY,  0xC0C0C0);
}

// ============================================================================
// 测试图案
// ============================================================================

static inline void put(int x, int y, uint8_t c)
{
    if (x >= 0 && x < FB_W && y >= 0 && y < FB_H) {
        g_fb[y * FB_W + x] = c;
    }
}

static void fill_rect(int x, int y, int w, int h, uint8_t c)
{
    for (int j = 0; j < h; j++) {
        for (int i = 0; i < w; i++) {
            put(x + i, y + j, c);
        }
    }
}

/*
 * 画一屏测试图案：
 *   上半：8 条竖彩条
 *   下半：深蓝底 + 一个方块 + 一条会动的进度条
 * 画面会动，方便一眼确认"不是卡住的静态图"。
 */
/* ★ 2026-10-02 【用户指定·极简测试】整屏纯红。
 * 用户要求："排除一切故障，就显示红色屏幕，调好了再说。"
 * 理由：红正是长期出问题的那个通道；纯色没有任何图案复杂度干扰，
 *       屏幕要么是红的（红通道通了），要么不是（没通）—— 判据最干净。
 * 注：红对 = 我们的 D2 = 引脚 32/33（与蓝 36/37、绿 34/35 并列）。 */
static void draw_solid_test(uint32_t frame)
{
    (void)frame;
    for (int i = 0; i < FB_W * FB_H; i++) g_fb[i] = C_RED;
}
/* 备用图案：白底 + 黑边框 + 中间十字（几何判读用） */
static void draw_solid_test_cross(uint32_t frame)
{
    const int B = 2;                     /* 边框粗细（逻辑像素） */
    int cx = FB_W / 2, cy = FB_H / 2;
    for (int y = 0; y < FB_H; y++) {
        for (int x = 0; x < FB_W; x++) {
            bool border = (x < B) || (x >= FB_W - B) || (y < B) || (y >= FB_H - B);
            bool cross  = (x >= cx - B && x < cx + B) || (y >= cy - B && y < cy + B);
            g_fb[y * FB_W + x] = (border || cross) ? C_BLACK : C_WHITE;
        }
    }
}
/* 备用图案 1：左 32 逻辑像素黑 + 其余白（测 lane 对齐用，配合读 TMDS 缓冲） */
static void draw_solid_test_edge(uint32_t frame)
{
    (void)frame;
    for (int y = 0; y < FB_H; y++) {
        for (int x = 0; x < FB_W; x++) {
            g_fb[y * FB_W + x] = (x < 32) ? C_BLACK : C_WHITE;
        }
    }
}
#if 0
static void draw_solid_test_bars(uint32_t frame)
{
    (void)frame;
    int bw = FB_W / 8;
    for (int y = 0; y < FB_H; y++) {
        for (int b = 0; b < 8; b++) {
            uint8_t c = (b & 1) ? C_BLACK : C_WHITE;
            int x0 = b * bw, x1 = x0 + bw;
            if (x1 > FB_W) x1 = FB_W;
            for (int x = x0; x < x1; x++) g_fb[y * FB_W + x] = c;
        }
    }
}
#endif   /* 8 条竖条图案（备用，改回它只需把上面的 draw_solid_test 换掉） */
// ============================================================================
// 音频：测试音
// ============================================================================

/*
 * 一个简单的正弦波，左右声道同相（单声道内容放两边）。
 * 用整数相位累加器，不需要浮点、不需要查表以外的资源。
 */
#define TONE_HZ      440
#define AUDIO_FRAMES_PER_FRAME  533   /* 32000 / 60 ≈ 533 */

static int16_t g_audio_buf[2 * AUDIO_FRAMES_PER_FRAME];
static uint32_t g_phase = 0;

static void make_tone(void)
{
    /*
     * 每帧生成 533 个立体声采样。相位步进 = 2^32 * f / fs。
     * 用 64 位算，避免溢出。
     */
    const uint32_t step = (uint32_t)(((uint64_t)TONE_HZ << 32) /
                                     FRANK_HDMI_AUDIO_RATE);

    for (int i = 0; i < AUDIO_FRAMES_PER_FRAME; i++) {
        g_phase += step;
        /* 取相位高位的三角波近似正弦，够听就行，且完全无浮点 */
        int32_t p = (int32_t)(g_phase >> 16);      /* 0..65535 */
        int32_t tri = (p < 32768) ? p : (65535 - p);  /* 0..32767 三角 */
        int16_t s = (int16_t)((tri - 16384) >> 2);    /* 居中，限幅 */

        g_audio_buf[2 * i]     = s;
        g_audio_buf[2 * i + 1] = s;
    }

    frank_hdmi_audio_write(g_audio_buf, AUDIO_FRAMES_PER_FRAME);
}

// ============================================================================
// 对外入口
// ============================================================================

void dvi_screen_test(void)
{
    /* ★ 2026-10-02 只增不减的入口计数：用于判定 dvi_screen_test() 是否被反复调用。
     * 之前观察到 g_dvi_loop_frames 反复归零（引擎计数却单调递增），
     * 无法区分"函数被重入"与"计数被别处改写"。这个计数器一次性切开两种可能。 */
    extern volatile uint32_t g_entry_count;
    g_entry_count++;

    /*
     * ── 第 18 轮探针：入口先测特权态，再往下走 ──
     *
     * 之前"系统调用演示之后 DVI 必崩"一直只能怀疑是特权态没恢复，
     * 但从来没测过。这里在【第一件事】就读 CONTROL 并落盘：
     *   g_probe_ctrl[4] = 0 ⇒ 屏幕初始化是在特权态跑的，
     *                          那崩溃就跟权限无关，得另找原因；
     *   g_probe_ctrl[4] = 1 ⇒ 应用退出后仍是非特权态，权限没收回。
     *
     * 后面每一步都插一个 kernel_mark 进度点：
     * 崩溃时 g_probe_marks 停在哪个数字，就知道死在哪一步，
     * 不用再靠反汇编猜出错位置。
     */
    kernel_mark(200);
    g_probe_ctrl[4] = kernel_read_control();
    kernel_mark(201);
    /*
     * 时钟与电压。
     *
     * ⚠️ 实测教训：一开始照抄库 README 的 504MHz + 1.2V，
     * 结果是 Core1 进 HardFault、Core0 卡死到连 SWD 都 halt 不住
     * （OpenOCD 报 "timed out while waiting for target halted"，
     *  只有 Core1 还能 halt，靠它复位才救回来）。
     * 说明这块板子在 504MHz 下供电撑不住。
     *
     * 现在改成 252MHz：CMake 里把 FRANK_HDMI_SM_CLKDIV 设为 1，
     * 于是 CPU = TMDS 位时钟 = 252MHz，正好是 640x480p60 需要的，
     * 既不需要 2 倍超频，也不用 504MHz。
     * 电压抬到 1.25V 留些余量；这是 RP2350 上常见的保守超频值。
     */
    vreg_set_voltage(VREG_VOLTAGE_1_25);
    sleep_ms(10);
    set_sys_clock_khz(252000, true);
    g_dbg_setclk_ok  = set_sys_clock_khz(252000, true) ? 1u : 0u;
    g_dbg_sys_clk_hz = (uint32_t)clock_get_hz(clk_sys);
    kernel_mark(202);

    stdio_init_all();
    kernel_mark(203);

    printf("\n[dvi] frank-hdmi-sound 初始化\n");
    printf("[dvi] 引脚 CLK=%d D0=%d D1=%d D2=%d (微雪 RP2350-PiZero)\n",
           FRANK_HDMI_PIN_CLK, FRANK_HDMI_PIN_D0,
           FRANK_HDMI_PIN_D1, FRANK_HDMI_PIN_D2);
    printf("[dvi] 逻辑帧缓冲 %dx%d, 上屏 640x480p60, 音频 %d Hz\n",
           FB_W, FB_H, FRANK_HDMI_AUDIO_RATE);
    fflush(stdout);
    kernel_mark(204);

    palette_init();
    kernel_mark(205);

    /* 第 19 轮临时诊断：DVI 启动【之前】跑一次 PIO+DMA 最小对照基准。
     * 目的是把【硬件能力】与【库用法】分开（见 src/pio_dma_bench.c 顶部说明）。 */
    {
        extern void pio_dma_bench_run(void);
        extern volatile uint32_t g_bench_us, g_bench_words, g_bench_done, g_bench_ch, g_bench_sm;
        /* 第 33 轮：把基准从启动路径摘掉 —— 它每次开机要跑 8 个变体，其中好几个是
         * 0.87 秒的守卫超时，白等好几秒；而它的结论都已落档（小本本 §14.24/14.49）。
         * 只注释调用，不删文件 —— 需要时把下面这行放开即可。 */
        (void)g_bench_us; (void)g_bench_words; (void)g_bench_ch; (void)g_bench_sm;
        /* pio_dma_bench_run(); */
        if (g_bench_done) {
            printf("[bench] PIO+DMA 搬 %lu 字用了 %lu us (ch=%lu sm=%lu)  ⇒ %lu ns/字\n",
                   (unsigned long)g_bench_words, (unsigned long)g_bench_us,
                   (unsigned long)g_bench_ch, (unsigned long)g_bench_sm,
                   (unsigned long)(g_bench_words ? (g_bench_us * 1000ull) / g_bench_words : 0));
        } else {
            printf("[bench] 没跑起来（SM 或 DMA 通道没抢到）\n");
        }
        fflush(stdout);
    }
    kernel_mark(206);

    frank_hdmi_init();
    kernel_mark(206);
    frank_hdmi_set_buffer(g_fb, FB_W, FB_H);
    kernel_mark(207);

    /* Core1 专职跑 DVI 引擎（视频 + 音频数据岛），Core0 留给应用 */
    multicore_launch_core1(frank_hdmi_run_core1);
    kernel_mark(208);

    printf("[dvi] Core1 已启动，开始输出\n");
    fflush(stdout);
    kernel_mark(209);



    uint32_t frame = 0;
    /* ★ 2026-10-07 重画守卫（从 dvi_min.c 搬来 —— 那边实测过，主 App 这边一直缺 ✗）
     * 证据：修前实测 hb÷t = 12,351 逻辑行/秒（需求 14,328）⇒ 生产者帧率只有 51.4 fps
     *   ⇒ 每圈整屏重写 FB_W*FB_H = 320×240 = **76,800 字节** ⇒ Core0 突发抢总线
     *   ⇒ Core1 的 TMDS 编码被顶穿 ⇒ DMA 重复旧行 ⇒ 屏幕【蓝白条纹闪】（用户 2026-10-07 实测症状 ✓）
     * 做法：内容没变就一个字节都不写 ✓（本循环是静态测试图案，画一次就够 ✓）
     * 同理见 docs\陷阱.md 与 dvi_min.c:605-608 的原始诊断 ✓ */
    bool fb_drawn = false;
    while (true) {
        if (!fb_drawn) { draw_solid_test(frame); fb_drawn = true; }   /* ★ 只画一次 ✓ */
        make_tone();
        frame++;
        g_loop_iter_total++;         /* ★ 只增不减：判定主循环是否真的在重启 */
        g_dvi_loop_frames = frame;   /* Core0 存活信标 */
        { extern void rate_tick(void); static uint32_t rc=0; if((++rc % 60u)==0u) rate_tick(); }
        kernel_mark(300);      /* 首帧之后就一直停在这附近 ⇒ 主循环活着 */

        /*
         * 串口后门轮询（实现在 main.cpp，timeout=0 非阻塞）：
         *     发 'B' ⇒ 进 BOOTSEL，发 'R' ⇒ 普通重启。
         *     其它任意键（含 '?'）⇒ 只把 5 行 [ktest] 自测结果重打一遍，不做别的动作。
         * 放在这里是因为 main() 最后就停在本函数里、不会返回 ——
         * 这里才是根固件真正一直在跑的"主循环"。
         */
        { extern void backdoor_poll(void); backdoor_poll(); }

        /* ★ 引擎看门狗（见文件上方变量处的长注释）：
         * 每 30 帧（约 0.5 秒）查一次引擎的 IRQ 计数；连续 4 次没进展（约 2 秒）
         * 就重启引擎（复位 Core1 → 重新初始化 → 重挂缓冲 → 再启动 Core1）。 */
        {
            extern volatile uint32_t g_dvi_irq_count;
            static uint32_t wd_last = 0;
            static uint32_t wd_stuck = 0;
            if ((frame % 30u) == 0u) {
                if (g_dvi_irq_count == wd_last) {
                    g_engine_stuck_seen++;
                    if (++wd_stuck >= 4u) {
                        wd_stuck = 0;
                        g_engine_restarts++;
                        multicore_reset_core1();
                        frank_hdmi_init();
                        frank_hdmi_set_buffer(g_fb, FB_W, FB_H);
                        multicore_launch_core1(frank_hdmi_run_core1);
                    }
                } else {
                    wd_last = g_dvi_irq_count;
                    wd_stuck = 0;
                }
            }
        }

        /* 等下一帧。用绝对时间对齐，避免越跑越偏。 */
        sleep_ms(16);
    }
}