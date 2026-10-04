/*
 * pair_wave.c —— 受控实验固件：验【探针在四对差分脚上的动态读回是否一致】
 *
 * 为什么需要它：
 *   截至 2026-10-04，已经用转储证明【DUT 侧整条链完全正确】——
 *     数据通道 → &pio->txf[sm] → SM 的 SIDESET_BASE → 正确的 GPIO 对，clkdiv=150 也对；
 *     有效块的 read_addr 就是 tmdsbuf，里面是合法像素码字；dbg_tcr=320 说明确实传完 320 字。
 *   而探针在 GPIO4/5（D0/蓝/同步 lane）上量到的却是常量控制符号。
 *   pin_toggle 只验过【静态】图案 ⇒ 动态读回仍是空白。
 *
 * 本固件做什么：
 *   4 个 PWM 片把 GPIO0..7 当 4 对差分对，输出【四对完全相同】的 50% 互补方波。
 *   ⇒ 探针采一包，四条 lane 的差分序列必须完全一致。
 *
 * ⚠️ 2026-10-04 第一版失败原因（记录）：照抄了 dvi_min 的
 *    vreg_set_voltage + set_sys_clock_khz(252000, true) 超频序列，结果板子没有输出
 *    （很可能卡在那一步）。本版【不改时钟】，只用默认频率并如实打印。
 */
#include <stdio.h>
#include "pico/stdlib.h"
#include "pico/bootrom.h"
#include "hardware/watchdog.h"
#include "hardware/clocks.h"
#include "hardware/pwm.h"
#include "hardware/gpio.h"

int main(void)
{
    stdio_init_all();
    sleep_ms(200);

    uint32_t fsys = clock_get_hz(clk_sys);
    printf("\n[pair_wave] alive. sys_clk = %lu Hz\n", (unsigned long)fsys);

    /* 目标方波 ~100 kHz：div = fsys / 100000 / 10（wrap=9 ⇒ 10 个计数一周期）
     * PWM 的整数字段只有 8 位（≤255），所以要夹一下并打印实际值。 */
    uint32_t div = fsys / 100000u / 10u;
    if (div < 1) div = 1;
    if (div > 255) div = 255;
    uint32_t actual_hz = fsys / (div * 10u);
    printf("[pair_wave] pwm div=%lu -> wave ≈ %lu Hz\n",
           (unsigned long)div, (unsigned long)actual_hz);

    for (int s = 0; s < 4; ++s) {
        gpio_set_function(2 * s,     GPIO_FUNC_PWM);
        gpio_set_function(2 * s + 1, GPIO_FUNC_PWM);

        pwm_config c = pwm_get_default_config();
        pwm_config_set_output_polarity(&c, true, false);   /* A 反相、B 不反 ⇒ 两脚互补 */
        pwm_config_set_wrap(&c, 9);
        pwm_config_set_clkdiv_int(&c, (uint8_t)div);
        pwm_init(s, &c, false);
        pwm_set_both_levels(s, 5, 5);                      /* 5/5 ⇒ 50% */
    }
    for (int s = 0; s < 4; ++s) {
        pwm_set_enabled(s, true);
    }
    printf("[pair_wave] 4 pairs running (complementary). "
           "Probe must read the SAME sequence on all 4 lanes.\n");

    int tick = 0;
    while (true) {
        int ch = getchar_timeout_us(0);
        if (ch == 'B') {
            printf("\n[backdoor] BOOTSEL reboot...\n");
            sleep_ms(50);
            reset_usb_boot(0, 0);
        } else if (ch == 'R') {
            printf("\n[backdoor] reboot...\n");
            sleep_ms(50);
            watchdog_reboot(0, 0, 0);
        } else if (ch == '?') {
            printf("[pair_wave] tick=%d sys=%lu wave=%lu\n", tick,
                   (unsigned long)clock_get_hz(clk_sys), (unsigned long)actual_hz);
        }
        if (++tick % 20 == 0) {                 /* 每 ~1 秒一条心跳 */
            printf("[pair_wave] heartbeat tick=%d\n", tick);
            fflush(stdout);
        }
        sleep_ms(50);
    }
}
