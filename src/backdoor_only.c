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

/* ── 变体标签：串口上一眼能分清现在跑的是哪一份（2026-10-07 加）──────────────
 * 目的：同一份"安静固件"在 150 MHz 与 252 MHz 各跑一次，用来对照 SWD 通不通 ✓
 *   · 不带宏 ⇒ backdoor_only     （默认时钟，不碰电压）
 *   · 带宏   ⇒ backdoor_only_oc  （提压 + 提频，档位必须是项目实测过的 ✓）
 */
#ifdef BACKDOOR_OC_KHZ
#define BD_TAG "backdoor_only_oc"
#else
#define BD_TAG "backdoor_only"
#endif

#ifdef BACKDOOR_OC_KHZ
/* ── 超频变体：配方照抄项目已验证的写法（**不自己发明** ✗）────────────────────
 *   · 提压：vreg_set_voltage(VREG_VOLTAGE_1_25) —— 与 src/dvi_min.c 的超频工装同档 ✓
 *   · 提频：set_sys_clock_khz(KHZ, false) —— 与 core1_monitor 的探针超频配方同写法 ✓
 * ⚠️ 两个关键点（都是本项目踩出来的）：
 *   ① 第二参数**必须 false**（尽力而为）：启动阶段 panic 等于又要人按 BOOTSEL ✗
 *   ② **先提压、再提频、最后才 stdio_init_all()** —— USB CDC 要按最终主频配置 ✓
 *      （2026-10-06 用户明确纠正过这一条 ✓）
 * ⚠️ 频率只许用项目**实测过**的档位（252 MHz = dvi_min 正在跑的档 ✓）——
 *    不许把频率调到没试过的区间 ✗（docs\开工前自检.md §三.2 用户原话）
 */
#include "hardware/vreg.h"

static void oc_apply(void) {
    vreg_set_voltage(VREG_VOLTAGE_1_25);
    sleep_ms(10);
    (void)set_sys_clock_khz(BACKDOOR_OC_KHZ, false);   /* 上不去就留默认时钟继续跑，绝不 panic ✓ */
}
#endif

static void banner(void) {
    printf("\n[%s] 纯后门固件在跑：本固件不做别的事\n", BD_TAG);
    printf("[%s] sysclk = %lu kHz\n", BD_TAG,
           (unsigned long)(clock_get_hz(clk_sys) / 1000));
    printf("[%s] 命令： B = 进 BOOTSEL   R = 重启   ? = 再打一遍这几行\n", BD_TAG);
    fflush(stdout);
}

int main(void) {
#ifdef BACKDOOR_OC_KHZ
    oc_apply();                  /* 必须在 stdio_init_all() 之前 ✓ */
#endif
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
            printf("[%s] sysclk = %lu kHz   (alive)\n", BD_TAG,
                   (unsigned long)(clock_get_hz(clk_sys) / 1000));
            fflush(stdout);
        } else if (c >= 0) {
            printf("[%s] 收到 0x%02X，本固件只认 B / R / ?\n", BD_TAG,
                   (unsigned)c);
            fflush(stdout);
        } else {
            tight_loop_contents();          /* 无按键：空转，不占外设 */
        }
    }
}
