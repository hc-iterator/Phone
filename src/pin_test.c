/*
 * pin_test v2 —— 引出引脚的连通性（短路）测试
 * ===========================================================================
 * 用途：焊接引出线 / 排针之后，检查这些引脚之间有没有【连锡（短路）】，
 *       以及有没有和 GND / 3V3 短路。避免带着连锡接信号上电。
 *
 * 原理（每种检查都只让一个引脚当输出，其余当输入，所以不会两个输出对打）：
 *   ① 【对 GND 短路】：所有引脚 = 输入 + 内部上拉。
 *        正常读到高；读到低 ⇒ 该脚被 GND 拉住 ⇒ 与 GND 短路 ✗
 *   ② 【对 3V3 短路】：所有引脚 = 输入 + 内部下拉。
 *        正常读到低；读到高 ⇒ 该脚被 3V3 拉住 ⇒ 与 3V3 短路 ✗
 *   ③ 【两两短路】：依次让第 i 脚输出低，其余 = 输入 + 上拉。
 *        若第 j 脚读到低 ⇒ i 与 j 相通 ✗
 *
 * ★ v2 的改变（v1 的报告大半没被收到）：
 *   · 【先把结果全部算完、存进数组，再打印】
 *   · 【第一行先打紧凑摘要】SUMMARY gnd=.. vcc=.. short=..  ⇒ 即使细节丢了也能判读
 *   · 每行 printf 后 fflush + 2ms 延时，照顾 USB CDC 的缓冲
 *
 * 用法：
 *   · 上电自动测一次；之后【串口发任意字符】就重测（可边焊边查）
 *   · 结果走 USB CDC 与 UART0
 * 引脚范围：PIN_TEST_BASE / PIN_TEST_COUNT（默认 GPIO 8..15）
 * ===========================================================================
 */
#include <stdio.h>
#include "pico/stdlib.h"

#ifndef PIN_TEST_BASE
#define PIN_TEST_BASE   8
#endif
#ifndef PIN_TEST_COUNT
#define PIN_TEST_COUNT  8
#endif
#ifndef PIN_TEST_SETTLE_US
#define PIN_TEST_SETTLE_US  50
#endif

#define MAXP 16
static const uint PIN_FIRST = PIN_TEST_BASE;
static const uint PIN_N     = (PIN_TEST_COUNT > MAXP ? MAXP : PIN_TEST_COUNT);

/* 测量结果（先全部算完再打印） */
static uint8_t g_gnd_bad[MAXP];          /* 1 = 与 GND 短路 */
static uint8_t g_vcc_bad[MAXP];          /* 1 = 与 3V3 短路 */
static uint8_t g_short[MAXP][MAXP];      /* 1 = i 与 j 相通 */
static int     g_n_gnd, g_n_vcc, g_n_short;

static void pl(const char *s) {          /* 每行都 flush + 小延时，照顾 CDC */
    fputs(s, stdout);
    fflush(stdout);
    sleep_ms(2);
}

static void all_input_pull(bool up) {
    for (uint i = 0; i < PIN_N; i++) {
        uint p = PIN_FIRST + i;
        gpio_init(p);
        gpio_set_dir(p, GPIO_IN);
        if (up) gpio_pull_up(p); else gpio_pull_down(p);
    }
    sleep_us(PIN_TEST_SETTLE_US);
}

static void measure_safe_checks(void) {
    g_n_gnd = g_n_vcc = 0;
    for (uint i = 0; i < MAXP; i++) { g_gnd_bad[i] = g_vcc_bad[i] = 0; }

    /* ① 对 GND：全部输入+上拉（不驱动任何脚，安全） */
    all_input_pull(true);
    for (uint i = 0; i < PIN_N; i++) {
        if (gpio_get(PIN_FIRST + i) == 0) { g_gnd_bad[i] = 1; g_n_gnd++; }
    }

    /* ② 对 3V3：全部输入+下拉（不驱动任何脚，安全） */
    all_input_pull(false);
    for (uint i = 0; i < PIN_N; i++) {
        if (gpio_get(PIN_FIRST + i) != 0) { g_vcc_bad[i] = 1; g_n_vcc++; }
    }
}

/*
 * ③ 两两相通：每次只让一个脚输出低。
 *
 * ★ 安全条件（很重要）：只对【在 ② 中表现正常】的脚做输出低。
 *   若某脚被判为"短路到 3V3"，把它拉低就等于把 3V3 直接对地
 *   ⇒ 会灌进几十毫安、可能把板子拉复位。所以【跳过它】，并且把"跳过"打印出来。
 *   同理，目标脚里若有"短路到 3V3"的，也不去读它（读数无意义）。
 */
static void measure_pair_shorts(void) {
    g_n_short = 0;
    for (uint i = 0; i < MAXP; i++)
        for (uint j = 0; j < MAXP; j++) g_short[i][j] = 0;

    all_input_pull(true);
    for (uint i = 0; i < PIN_N; i++) {
        if (g_vcc_bad[i]) continue;                 /* ★ 不驱动可能连电源的脚 */
        uint pi = PIN_FIRST + i;
        gpio_init(pi); gpio_set_dir(pi, GPIO_OUT); gpio_put(pi, 0);
        sleep_us(PIN_TEST_SETTLE_US);
        for (uint j = 0; j < PIN_N; j++) {
            if (j == i) continue;
            if (g_vcc_bad[j]) continue;             /* ★ 不读可能连电源的脚 */
            if (gpio_get(PIN_FIRST + j) == 0) { g_short[i][j] = 1; g_n_short++; }
        }
        gpio_init(pi); gpio_set_dir(pi, GPIO_IN); gpio_pull_up(pi);
        sleep_us(PIN_TEST_SETTLE_US);
    }
}

static int report_safe(void) {
    char b[128];
    snprintf(b, sizeof b, "SAFE gnd=%d vcc=%d base=%u n=%u\n",
             g_n_gnd, g_n_vcc, PIN_FIRST, PIN_N);
    pl(b);
    for (uint i = 0; i < PIN_N; i++) {
        if (g_gnd_bad[i]) { snprintf(b, sizeof b, "  GPIO %u : short to GND\n", PIN_FIRST + i); pl(b); }
        if (g_vcc_bad[i]) { snprintf(b, sizeof b, "  GPIO %u : short to 3V3 (will NOT drive it)\n", PIN_FIRST + i); pl(b); }
    }
    if (!g_n_gnd && !g_n_vcc) pl("  (no GND/3V3 shorts)\n");
    return g_n_gnd + g_n_vcc;
}

static int report_pairs(void) {
    char b[128];
    int problems = g_n_gnd + g_n_vcc + g_n_short;

    snprintf(b, sizeof b, "PAIRS connected=%d\n", g_n_short);
    pl(b);
    for (uint i = 0; i < PIN_N; i++) {
        for (uint j = i + 1; j < PIN_N; j++) {
            if (g_short[i][j] || g_short[j][i]) {
                snprintf(b, sizeof b, "  GPIO %u <-> GPIO %u : connected\n", PIN_FIRST + i, PIN_FIRST + j);
                pl(b);
            }
        }
    }
    snprintf(b, sizeof b, "SUMMARY gnd=%d vcc=%d short=%d\n", g_n_gnd, g_n_vcc, g_n_short);
    pl(b);
    pl(problems ? "RESULT: FAIL\n" : "RESULT: PASS\n");
    pl("PRESS ANY KEY TO RETEST\n");
    return problems;
}

int main(void) {
    stdio_init_all();
    sleep_ms(1500);

    pl("\n### pin_test v3 (continuity / short check) ###\n");
    { char b[96]; snprintf(b, sizeof b, "pins: GPIO %u..%u\n", PIN_FIRST, PIN_FIRST + PIN_N - 1); pl(b); }

    /* ★ 先做安全的检查①②并立刻报告（这两项不驱动任何脚） */
    measure_safe_checks();
    report_safe();

    /* ★ 再做③（会驱动引脚，但已避开可能连电源的脚） */
    measure_pair_shorts();
    report_pairs();

    while (true) {
        int c = getchar_timeout_us(200000);
        if (c != PICO_ERROR_TIMEOUT) {
            pl("---- retest ----\n");
            measure_safe_checks();
            report_safe();
            measure_pair_shorts();
            report_pairs();
        }
    }
}
