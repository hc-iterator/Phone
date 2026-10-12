/*
 * pin_sniff.c —— RP2040 侧"引脚观察器"（2 号系统专用；2026-10-12）
 * 放在 core1_monitor/ 里的原因：本目录是 junction 回真仓库，运行本树也看得见
 * （新开子工程要改受管脚本 build_sub.ps1 ⇒ 会碰信任门，不走那条路）。
 *
 * 用途：与待测板（RP2350）GPIO0-20 逐脚相连，用它来【看】待测板。
 * 命令：
 *   S = 打印"当前电平 + 粘住的高电平记录"
 *   X = 清零粘住记录（查线流程：采样端按 X → 待测板按 T 走一遍 → 采样端按 S）
 *   C = 翻转计数（约 20ms，判有没有信号）
 *   B = 进 BOOTSEL    R = 重启    其它键 = 菜单
 *
 * 关键：本板 0-20 全部设成【输入 + 下拉】，绝不驱动 ⇒ 绝不与待测板抢线。
 *   下拉的用处：待测板驱动高 → 读 1；线断了/悬空 → 读 0 ⇒ 单根断线也能看出来。
 *
 * 主循环每圈（约 10ms）扫一次 21 脚并更新"粘住"位图 ⇒ 待测板慢慢走一圈（每脚 100ms）
 * 一定会被记下来。这样查线只花三条命令，不用主机反复轮询。
 *
 * ⚠️ 不做 TMDS 解码（那要 PIO 过采样 + tools/tmds_*.py）。这里只回答两件事：
 *    线通不通；线上有没有在动。
 */
#include <stdio.h>
#include "pico/stdlib.h"
#include "pico/bootrom.h"
#include "hardware/gpio.h"
#include "hardware/watchdog.h"
#include "hardware/clocks.h"
#include "hardware/watchdog.h"

#define PIN_N 21
#define MASK21 0x1FFFFFu

static volatile uint32_t g_ever_high = 0;   /* 见过的"高"（粘住，直到 X 清零） */

/* 待测板的 RUN 接在本板 GPIO28（低有效）⇒ 拉低 100ms 再放开 = 复位待测板。
 * 意义：待测板一旦跑飞/不再响应串口，这是【不碰按键】把它拉回来的唯一手段。 */
#define PIN_TARGET_RUN 28

static void pulse_target_run(void)
{
    gpio_init(PIN_TARGET_RUN);
    gpio_set_dir(PIN_TARGET_RUN, GPIO_OUT);
    gpio_put(PIN_TARGET_RUN, 0);
    printf("RUN low 100ms (target reset) ...\n"); fflush(stdout);
    sleep_ms(100);
    gpio_set_dir(PIN_TARGET_RUN, GPIO_IN);      /* 放开：外部上拉把 RUN 拉回高 */
    printf("RUN released\n"); fflush(stdout);
}

static void setup_pins(void)
{
    for (int p = 0; p < PIN_N; p++) {
        gpio_init(p);
        gpio_set_dir(p, GPIO_IN);
        gpio_pull_down(p);
    }
    sleep_ms(20);
}

static void print_menu(void)
{
    printf("\n===== pin_sniff（RP2040 观察器）=====\n");
    printf("  S = 打印当前电平 + 粘住记录\n");
    printf("  X = 清零粘住记录\n");
    printf("  C = 翻转计数（约 20ms，判有没有信号）\n");
    printf("  Z = 复位待测板（把 GPIO28/RUN 拉低 100ms）\n");
    printf("  B = 进 BOOTSEL    R = 重启\n\n");
    fflush(stdout);
}

static void print_bits(uint32_t v)
{
    for (int p = 0; p < PIN_N; p++) printf("%d", (int)((v >> p) & 1u));
}

static void sample_report(void)
{
    uint32_t now  = gpio_get_all() & MASK21;
    uint32_t ever = g_ever_high;
    printf("SAMPLE now  0x%07lx [", (unsigned long)now);  print_bits(now);  printf("]\n");
    printf("STICKY ever 0x%07lx [", (unsigned long)ever); print_bits(ever); printf("]\n");
    printf("  （位串顺序：GPIO0 在最左，GPIO20 在最右）\n");
    fflush(stdout);
}

static void sample_transitions(void)
{
    uint32_t cnt[PIN_N];
    for (int p = 0; p < PIN_N; p++) cnt[p] = 0;

    uint32_t last = gpio_get_all() & MASK21;
    absolute_time_t t_end = make_timeout_time_ms(20);
    while (!time_reached(t_end)) {
        uint32_t cur = gpio_get_all() & MASK21;
        uint32_t diff = cur ^ last;
        if (diff) {
            for (int p = 0; p < PIN_N; p++) if (diff & (1u << p)) cnt[p]++;
            last = cur;
        }
    }

    printf("ALIVE =");
    for (int p = 0; p < PIN_N; p++) if (cnt[p]) printf(" %d(%lu)", p, (unsigned long)cnt[p]);
    printf("\nDEAD  =");
    for (int p = 0; p < PIN_N; p++) if (!cnt[p]) printf(" %d", p);
    printf("\n");
    fflush(stdout);
}

int main(void)
{
    /* ★ 自愈：8 秒没喂狗就复位（本板还兼着"拉待测板 RUN"的职责，绝不能哑掉） */
    watchdog_enable(8000, 0);
    stdio_init_all();
    sleep_ms(300);
    printf("\n[pin_sniff] 上电：进入【等待 USB 命令】状态（未收到命令前不做任何动作）\n");
    printf("            sys_clk=%lu Hz（本板只观察 + 只驱动 GPIO28 拉待测板 RUN）\n",
           (unsigned long)clock_get_hz(clk_sys));
    printf("            门开了以后可用：S 采样 / X 清零 / C 翻转计数 / Z 拉待测板RUN / B BOOTSEL / R 重启\n");
    fflush(stdout);
    setup_pins();
    g_ever_high = 0;
    print_menu();

    while (true) {
        watchdog_update();                        /* ★ 喂狗 */
        /* 每圈更新"粘住"记录：10ms 粒度，足以抓住待测板 100ms/脚的走位 */
        g_ever_high |= (gpio_get_all() & MASK21);

        int ch = getchar_timeout_us(10000);
        if (ch == PICO_ERROR_TIMEOUT) continue;
        switch (ch) {
        case 'S': case 's': sample_report(); break;
        case 'X': case 'x':
            g_ever_high = 0;
            printf("STICKY cleared\n"); fflush(stdout);
            break;
        case 'C': case 'c': sample_transitions(); break;
        case 'Z': case 'z': pulse_target_run(); break;
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
