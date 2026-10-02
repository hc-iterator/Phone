/*
 * pin_toggle —— 最简信号源（不用 PIO / DMA / DVI 引擎）
 * ===========================================================================
 * 目的：把【探针采样路径 + 杜邦线接线】与【DVI 引擎】彻底分开验证。
 *
 *   GPIO0 = 1 Hz 方波（每 500ms 翻转）
 *   GPIO2 / 4 / 6 = 恒 1
 *   GPIO1 / 3 / 5 / 7 = 恒 0
 *
 * ⇒ 探针采一次，若看到：
 *      bit0 在 0/1 变化、bit2/4/6 恒 1、bit1/3/5/7 恒 0
 *   ⇒ 【采样路径 + 接线全部正确】✓
 *   否则一眼就能看出是哪一位错位、断路或接反 ✓
 *
 * 🚪 串口后门（本板没引出 SWD，靠它进 BOOTSEL）：
 *      B ⇒ 重启进入 BOOTSEL（拖 uf2 即可）
 *      R ⇒ 普通重启
 * ===========================================================================
 */
#include <stdio.h>
#include "pico/stdlib.h"
#include "pico/bootrom.h"          /* reset_usb_boot */
#include "hardware/watchdog.h"     /* watchdog_reboot */

int main(void) {
    stdio_init_all();
    sleep_ms(1500);

    for (int p = 0; p < 8; p++) { gpio_init(p); gpio_set_dir(p, GPIO_OUT); }
    gpio_put(1, 0); gpio_put(2, 1); gpio_put(3, 0); gpio_put(4, 1);
    gpio_put(5, 0); gpio_put(6, 1); gpio_put(7, 0);

    printf("\n### pin_toggle: GPIO0=1Hz方波, GPIO2/4/6=1, GPIO1/3/5/7=0 ###\n");
    printf("### 后门: B=进BOOTSEL, R=重启 ###\n");
    fflush(stdout);

    int v = 0;
    while (true) {
        v ^= 1;
        gpio_put(0, v);
        printf("[toggle] t=%dms gpio0=%d  expect bit0=%d bit2/4/6=1 bit1/3/5/7=0\n",
               (int)to_ms_since_boot(get_absolute_time()), v, v);
        fflush(stdout);

        for (int k = 0; k < 10; k++) {          /* 500ms 内分 10 次查后门，响应快 */
            int c = getchar_timeout_us(0);
            if (c == 'B') { printf("[backdoor] BOOTSEL...\n"); fflush(stdout); sleep_ms(50); reset_usb_boot(0, 0); }
            if (c == 'R') { printf("[backdoor] reboot...\n");  fflush(stdout); sleep_ms(50); watchdog_reboot(0, 0, 0); }
            sleep_ms(50);
        }
    }
}
