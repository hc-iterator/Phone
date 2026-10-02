/*
 * pin_test —— 引出引脚的连通性（短路）测试
 * ===========================================================================
 * 用途：焊接引出线 / 排针之后，检查这些引脚之间有没有【连锡（短路）】，
 *       以及有没有和 GND / 3V3 短路。避免带着连锡接信号上电。
 *
 * 原理（每种检查都只让一个引脚当输出，其余当输入，所以不会两个输出对打）：
 *   ① 【对 GND 短路】：所有引脚 = 输入 + 内部上拉。
 *        正常：读到高。  读到低 ⇒ 该脚被 GND 拉住了 ⇒ 与 GND 短路 ✗
 *   ② 【对 3V3 短路】：所有引脚 = 输入 + 内部下拉。
 *        正常：读到低。  读到高 ⇒ 该脚被 3V3 拉住了 ⇒ 与 3V3 短路 ✗
 *   ③ 【两两短路】：依次让第 i 脚输出低电平，其余 = 输入 + 上拉。
 *        若第 j 脚（j≠i）读到低 ⇒ i 与 j 相通 ✗
 *        （做完一个把第 i 脚恢复成输入+上拉，再测下一个）
 *
 * 用法：
 *   · 上电自动测一次；之后【按任意键（串口发一个字符）就重测一次】
 *     ⇒ 你可以边焊边查，焊一下、敲一下回车就知道好没好
 *   · 结果同时走 USB CDC 与 UART0（pico_enable_stdio_*）
 *
 * 引脚范围由 PIN_TEST_BASE / PIN_TEST_COUNT 决定（下面有默认值）。
 * ===========================================================================
 */
#include <stdio.h>
#include <string.h>
#include "pico/stdlib.h"

#ifndef PIN_TEST_BASE
#define PIN_TEST_BASE   8      /* 被测引脚起始 GPIO */
#endif
#ifndef PIN_TEST_COUNT
#define PIN_TEST_COUNT  8      /* 被测引脚个数（8..15）*/
#endif

#define SETTLE_US       20     /* 换驱动方向后等电平稳定（内部上拉很弱，给足时间）*/

static const uint PIN_FIRST = PIN_TEST_BASE;
static const uint PIN_N     = PIN_TEST_COUNT;

/* 内部上拉约 50kΩ、引脚电容几 pF ⇒ 几十 µs 足够 */
static void all_input_pull(bool up) {
    for (uint i = 0; i < PIN_N; i++) {
        uint p = PIN_FIRST + i;
        gpio_init(p);
        gpio_set_dir(p, GPIO_IN);
        if (up) gpio_pull_up(p); else gpio_pull_down(p);
    }
    sleep_us(SETTLE_US);
}

static void one_output_low(uint i) {
    uint p = PIN_FIRST + i;
    gpio_init(p);
    gpio_set_dir(p, GPIO_OUT);
    gpio_put(p, 0);
    sleep_us(SETTLE_US);
}

static void one_back_to_input(uint i) {
    uint p = PIN_FIRST + i;
    gpio_init(p);
    gpio_set_dir(p, GPIO_IN);
    gpio_pull_up(p);
    sleep_us(SETTLE_US);
}

static int run_once(void) {
    int problems = 0;

    printf("\n===== 引脚连通性测试：GPIO %u..%u =====\n", PIN_FIRST, PIN_FIRST + PIN_N - 1);

    /* ① 对 GND 短路 */
    printf("\n[1] 与 GND 短路检查（全部上拉；应为高）\n");
    all_input_pull(true);
    for (uint i = 0; i < PIN_N; i++) {
        uint p = PIN_FIRST + i;
        int v = gpio_get(p);
        if (v) printf("    GPIO %-3u 高  ✓\n", p);
        else { printf("    GPIO %-3u 低  ✗ 可能和 GND 短路！\n", p); problems++; }
    }

    /* ② 对 3V3 短路 */
    printf("\n[2] 与 3V3 短路检查（全部下拉；应为低）\n");
    all_input_pull(false);
    for (uint i = 0; i < PIN_N; i++) {
        uint p = PIN_FIRST + i;
        int v = gpio_get(p);
        if (!v) printf("    GPIO %-3u 低  ✓\n", p);
        else { printf("    GPIO %-3u 高  ✗ 可能和 3V3 短路！\n", p); problems++; }
    }

    /* ③ 两两短路 */
    printf("\n[3] 两两短路检查（每次只让一个脚输出低）\n");
    all_input_pull(true);
    for (uint i = 0; i < PIN_N; i++) {
        uint pi = PIN_FIRST + i;
        one_output_low(i);
        for (uint j = 0; j < PIN_N; j++) {
            if (j == i) continue;
            uint pj = PIN_FIRST + j;
            if (gpio_get(pj) == 0) {
                printf("    GPIO %-3u <-> GPIO %-3u  相通  ✗\n", pi, pj);
                problems++;
            }
        }
        one_back_to_input(i);
    }
    if (problems == 0) printf("    （未发现相通）✓\n");

    printf("\n===== 结论：%s（%d 处可疑）=====\n",
           problems ? "发现问题 ✗" : "全部通过 ✓", problems);
    if (problems) printf("提示：连锡多半可用助焊剂+吸锡带清掉；清完按回车重测。\n");
    printf("\n按【任意键】重测一次。\n");
    fflush(stdout);
    return problems;
}

int main(void) {
    stdio_init_all();
    sleep_ms(1500);                 /* 等 USB 枚举 */

    printf("\n\n### pin_test 引脚连通性测试 ###\n");
    printf("被测引脚：GPIO %u..%u（共 %u 个）\n", PIN_FIRST, PIN_FIRST + PIN_N - 1, PIN_N);
    printf("接法：本测试不需要接任何外部信号，只看这些脚之间/对地/对电源有没有相通。\n");

    run_once();

    while (true) {
        int c = getchar_timeout_us(200000);   /* 200ms 超时 */
        if (c != PICO_ERROR_TIMEOUT) {
            run_once();
        } else {
            /* 无输入时给个心跳，方便确认串口是活的 */
            static uint32_t t = 0;
            if ((++t % 25u) == 0u) { printf("# 等待指令（按任意键重测）\n"); fflush(stdout); }
        }
    }
}
