/*
 * hdmi_screen.c —— HDMI 屏幕点亮测试
 *
 * 目标：把 3.5 寸 HDMI 屏点亮，并画出可肉眼确认的图形。
 *
 * 为什么单独一个文件：显示初始化会改系统时钟、启动 Core1 跑 HSTX DMA，
 * 与内核/系统调用演示的关注点完全不同。分开写便于单独开关、单独排查。
 *
 * 用法（在 main.cpp 里）：
 *     hdmi_screen_test();     // 不返回：进入显示循环
 *
 * 硬件前提：
 *   - RP2350B 的 HSTX 引脚已接到 HDMI 座（微雪 RP2350-PiZero 板上已连好）
 *   - 屏幕接好 HDMI 线并通电
 */

#include <stdio.h>
#include <string.h>

#include "pico/stdlib.h"
#include "pico/multicore.h"

#include "hardware/clocks.h"
#include "hardware/vreg.h"

#include "pico_hdmi/hstx_data_island_queue.h"
#include "pico_hdmi/video_output.h"

#include "hdmi_screen.h"

// ============================================================================
// 显示参数
// ============================================================================

/*
 * 用 640x480@60Hz。
 *
 * 这是 pico_hdmi 自带的成熟模式（示例 bouncing_box 用的就是它），
 * 时序参数最稳妥。分辨率对"先点亮"这个目标足够。
 *
 * 480p60 需要 sys_clk = 126MHz 才能得到 25.2MHz 像素时钟。
 */
#define FRAME_WIDTH   640
#define FRAME_HEIGHT  480

// RGB565 颜色
#define COL_BLACK     0x0000
#define COL_WHITE     0xFFFF
#define COL_RED       0xF800
#define COL_GREEN     0x07E0
#define COL_BLUE      0x001F
#define COL_YELLOW    0xFFE0
#define COL_CYAN      0x07FF
#define COL_MAGENTA   0xF81F
#define COL_ORANGE    0xFD20
#define COL_DARKBLUE  0x0010
#define COL_GRAY      0x8410

// 彩条顺序（经典 SMPTE 风格）
static const uint16_t bar_colors[8] = {
    COL_WHITE, COL_YELLOW, COL_CYAN, COL_GREEN,
    COL_MAGENTA, COL_RED, COL_BLUE, COL_BLACK,
};

// ============================================================================
// 动画状态
// ============================================================================

static volatile uint32_t g_frame = 0;
static volatile int g_box_x = 40;
static volatile int g_box_y = 300;
static volatile int g_box_dx = 3;
static volatile int g_box_dy = 2;

/*
 * 画一个 8x8 的 ASCII 字形（只做演示，够看就行）。
 * 用 8 字节位图，每个字节一行，bit7 在最左。
 */
static void draw_glyph(uint32_t *dst, int x, int y, const uint8_t *glyph,
                       uint16_t fg, uint16_t bg);

// ============================================================================
// 扫描线回调 —— 逐行生成像素
// ============================================================================
/*
 * ⚠️ 放在 SCRATCH_X RAM 里。
 *
 * 这个回调由 HSTX DMA 驱动、在 Core1 上每个扫描线调用一次，
 * 对时序敏感。放 SRAM(尤其 scratch) 能避免 flash XIP 抖动导致的
 * 偶发像素错位。示例也是这么做的。
 */
static void __scratch_x("") scanline_callback(uint32_t v_scanline,
                                             uint32_t active_line,
                                             uint32_t *dst)
{
    (void)v_scanline;

    const int half = FRAME_WIDTH / 2;   /* 每个 uint32_t 装 2 个像素 */

    /*
     * 上半屏：竖彩条。
     * 下半屏：深蓝底 + 一个来回弹跳的方块 + 一条进度条。
     */
    if (active_line < FRAME_HEIGHT / 2) {
        // ---- 彩条区：每条约 FRAME_WIDTH/8 宽 ----
        const int bar_w_px = FRAME_WIDTH / 8;
        for (int i = 0; i < half; i++) {
            int px = i * 2;
            int bar = px / bar_w_px;
            if (bar > 7) bar = 7;
            uint16_t c = bar_colors[bar];
            dst[i] = (uint32_t)c | ((uint32_t)c << 16);
        }
        return;
    }

    // ---- 下半屏：深蓝底 ----
    uint32_t bg = (uint32_t)COL_DARKBLUE | ((uint32_t)COL_DARKBLUE << 16);
    for (int i = 0; i < half; i++) {
        dst[i] = bg;
    }

    int line = active_line;   /* 300..479 */

    // ---- 弹跳方块 32x32 ----
    {
        int bx = g_box_x;
        int by = g_box_y;
        if (line >= by && line < by + 32) {
            int start_pair = bx / 2;
            int end_pair = (bx + 32) / 2;
            if (start_pair < 0) start_pair = 0;
            if (end_pair > half) end_pair = half;
            uint32_t box = (uint32_t)COL_YELLOW | ((uint32_t)COL_YELLOW << 16);
            for (int i = start_pair; i < end_pair; i++) {
                dst[i] = box;
            }
        }
    }

    // ---- 右侧进度条：随帧数增长，用来确认"画面在动" ----
    {
        int bar_y = 440;
        if (line >= bar_y && line < bar_y + 16) {
            // 0..FRAME_WIDTH，按帧数循环
            int filled = (int)(g_frame % (FRAME_WIDTH + 1));
            int end_pair = filled / 2;
            if (end_pair > half) end_pair = half;
            uint32_t fg = (uint32_t)COL_GREEN | ((uint32_t)COL_GREEN << 16);
            for (int i = 0; i < end_pair; i++) {
                dst[i] = fg;
            }
            uint32_t mk = (uint32_t)COL_WHITE | ((uint32_t)COL_WHITE << 16);
            if (end_pair < half) dst[end_pair] = mk;
        }
    }

    (void)draw_glyph;
}

static void draw_glyph(uint32_t *dst, int x, int y, const uint8_t *glyph,
                       uint16_t fg, uint16_t bg)
{
    (void)dst; (void)x; (void)y; (void)glyph; (void)fg; (void)bg;
}

// ============================================================================
// VSYNC 回调 —— 每帧推进动画
// ============================================================================
static void vsync_callback(void)
{
    g_frame++;

    int x = g_box_x + g_box_dx;
    int y = g_box_y + g_box_dy;

    if (x < 0) { x = 0; g_box_dx = -g_box_dx; }
    if (x > FRAME_WIDTH - 32) { x = FRAME_WIDTH - 32; g_box_dx = -g_box_dx; }
    if (y < FRAME_HEIGHT / 2) { y = FRAME_HEIGHT / 2; g_box_dy = -g_box_dy; }
    if (y > FRAME_HEIGHT - 48) { y = FRAME_HEIGHT - 48; g_box_dy = -g_box_dy; }

    g_box_x = x;
    g_box_y = y;
}

// ============================================================================
// 对外入口
// ============================================================================

void hdmi_screen_test(void)
{
    /*
     * 480p60 需要 126MHz 系统时钟来产生 25.2MHz 像素时钟。
     * 这一步必须在 video_output_init() 之前完成。
     */
    set_sys_clock_khz(126000, true);

    stdio_init_all();

    printf("\n[hdmi] 初始化 HDMI 输出 %dx%d ...\n", FRAME_WIDTH, FRAME_HEIGHT);
    fflush(stdout);

    hstx_di_queue_init();
    video_output_init(FRAME_WIDTH, FRAME_HEIGHT);

    /* 有些显示器对 HDMI 数据岛不友好，DVI 模式更容易同步。
     * 先留成 HDMI 模式；若屏幕不出图，改 true 再试。 */
    video_output_set_dvi_mode(false);

    video_output_set_scanline_callback(scanline_callback);
    video_output_set_vsync_callback(vsync_callback);

    printf("[hdmi] 启动 Core1 输出 HSTX ...\n");
    fflush(stdout);

    multicore_launch_core1(video_output_core1_run);

    printf("[hdmi] 已启动。屏幕上应当是：上半竖彩条 + 下半深蓝底黄色弹跳方块 + 绿色进度条\n");
    fflush(stdout);

    /* Core0 主循环：只负责推进状态与心跳 */
    uint32_t last = 0;
    while (true) {
        if (g_frame != last) {
            last = g_frame;
        }
        tight_loop_contents();
    }
}
