/* 纯后门固件（backdoor_only）：只干一件事 —— 让板子能被串口重新刷写。
 *
 * 为什么需要它（2026-10-06）
 *   `empty`（src/empty.c）是"什么都不做"的固件，但它 **不开 USB stdio**
 *   （见 CMakeLists.txt 里 empty 的 pico_enable_stdio_* 都是 0）
 *   ⇒ 烧上去以后 **没有 COM 口、也没有后门**，只能靠手按 BOOTSEL 救回来 ✗。
 *   它适合"要一个绝对安静的状态"，**不适合当中转固件** ✓。
 *   本目标补上这个缺口：**USB CDC 活着 + 后门活着 + 别的什么都不干** ✓。
 *
 * 配方照抄项目里已验证的写法（不自己发明 ✗）
 *   · 后门按键与动作：src/dvi_min.c:734-741
 *       'B' => reset_usb_boot(0,0)  进 BOOTSEL（不用按按键）✓
 *       'R' => watchdog_reboot(0,0,0) 普通重启 ✓
 *   · 非阻塞轮询：getchar_timeout_us(0)，绝不阻塞 ✓
 *   · **不碰时钟、不碰电压**：留在默认频率 ⇒ USB 枚举最稳 ✓
 *     （这正是它当中转固件的意义：越少动作，越不可能回不来 ✓）
 */
#include "pico/stdlib.h"
#include <stdio.h>               /* printf / fflush / stdout */
#include "pico/bootrom.h"        /* reset_usb_boot */
#include "hardware/watchdog.h"   /* watchdog_reboot */
#include "hardware/clocks.h"     /* clock_get_hz */

static void banner(void) {
    printf("\n[backdoor_only] 纯后门固件在跑：本固件不做别的事\n");
    printf("[backdoor_only] sysclk = %lu kHz\n",
           (unsigned long)(clock_get_hz(clk_sys) / 1000));
    printf("[backdoor_only] 命令： B = 进 BOOTSEL   R = 重启   ? = 再打一遍这三行\n");
    fflush(stdout);
}

int main(void) {
    stdio_init_all();
    sleep_ms(300);               /* 等 USB 枚举，别让开机那几行丢掉 */
    banner();

    while (true) {
        int c = getchar_timeout_us(0);
        if (c == 'B') {
            printf("\n[backdoor] BOOTSEL reboot...\n");
            fflush(stdout);
            sleep_ms(50);
            reset_usb_boot(0, 0);           /* 不再返回 */
        } else if (c == 'R') {
            printf("\n[backdoor] reboot...\n");
            fflush(stdout);
            sleep_ms(50);
            watchdog_reboot(0, 0, 0);       /* 不再返回 */
        } else if (c == '?') {
            printf("[backdoor_only] sysclk = %lu kHz   (alive)\n",
                   (unsigned long)(clock_get_hz(clk_sys) / 1000));
            fflush(stdout);
        } else if (c >= 0) {
            printf("[backdoor_only] 收到 0x%02X，本固件只认 B / R / ?\n",
                   (unsigned)c);
            fflush(stdout);
        } else {
            tight_loop_contents();          /* 无按键：空转，不占外设 */
        }
    }
}
