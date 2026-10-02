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
            }
            sleep_ms(25);
        }
    }
}
