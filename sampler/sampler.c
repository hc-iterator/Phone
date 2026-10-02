/*
 * TMDS / DVI 高速采样探针
 * ---------------------------------------------------------------------------
 * 目的：把 PicoPhone 输出的 8 根 DVI 线（4 对差分）整拍锁存下来，
 *       通过 USB 串口送出，供离线解码分析 —— 让我们【第一次真正看到】
 *       面板收到的到底是什么，而不是继续盲猜参数。
 *
 * 原理：
 *   · PIO 一条 `in pins, 8` ⇒ 每 1 个时钟锁存 1 个采样（8 根线同时）
 *   · autopush = 32 位 ⇒ 每 4 个采样推出 1 个字
 *   · DMA 环形缓冲（地址回卷）⇒ 持续采样、随时可 dump
 *   · USB CDC 命令：见下方 print_help()
 *
 * 采样率 = sys_clk（默认 252 MHz）。TMDS 位率也是 252 Mbit/s
 * ⇒ 约 1 采样/位。想更细就超频（见 CMake 里的 SAMPLER_CLK_KHZ）。
 *
 * ⚠️ 两块板必须【共地】，否则电平无参考、采样无意义。
 * ⚠️ 探针引脚与 CYW43439 等外设不能冲突 —— 用 SAMPLER_PIN_BASE 选定，
 *    接线就是把 DUT 的 8 根 DVI 线按顺序接到 SAMPLER_PIN_BASE .. +7。
 *
 * RP2350B 的 PIO 引脚窗口只有两档：0..31 或 16..47（由 GPIOBASE 选择）
 * ⇒ 本文件按基址自动选窗口（这是本会话踩过的坑，见 历史本.md）。
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "hardware/clocks.h"
#include "hardware/vreg.h"
#include "sampler.pio.h"

#ifndef SAMPLER_PIN_BASE
#define SAMPLER_PIN_BASE 8           /* 8 根线占 PIN_BASE .. PIN_BASE+7（默认 8..15，避开 CYW43439 占用的高引脚）*/
#endif
#ifndef SAMPLER_CLK_KHZ
#define SAMPLER_CLK_KHZ  252000      /* 采样时钟（= 每个采样的时间分辨率）*/
#endif

/* 环形缓冲：64 KB = 65536 字 = 262144 个采样
 * 在 252 MHz 下 ≈ 1.04 ms ≈ 32 条 DVI 行（31.7 µs/行）—— 够看行结构 */
#define BUF_WORDS   (16u * 1024u)    /* 16K 字 = 64 KB */
static uint32_t __attribute__((aligned(4096))) g_buf[BUF_WORDS];

static PIO  g_pio;
static uint g_sm;
static int  g_dma = -1;
static volatile uint32_t g_wraps = 0;      /* DMA 回卷次数（表示采了多久）*/

static void dma_irq_handler(void) {
    if (dma_hw->ints0 & (1u << g_dma)) {
        dma_hw->ints0 = 1u << g_dma;       /* 清中断 */
        g_wraps++;
    }
}

/* ---------------------------------------------------------------- 初始化 */
static void sampler_init(void) {
    /* 时钟（可超频；RP2350B 在 252MHz 是常规的，300+ 也可试） */
    if (SAMPLER_CLK_KHZ > 252000) vreg_set_voltage(VREG_VOLTAGE_1_25);
    set_sys_clock_khz(SAMPLER_CLK_KHZ, true);

    /* 8 根输入脚：设为输入、使能数字接收器 */
    for (uint i = 0; i < 8; i++) {
        gpio_init(SAMPLER_PIN_BASE + i);
        gpio_set_dir(SAMPLER_PIN_BASE + i, GPIO_IN);
    }

    /* ★ 关键：按基址选 PIO 的引脚窗口（只有 0..31 或 16..47 两档）*/
    g_pio = pio0;
    uint in_base;
    if (SAMPLER_PIN_BASE >= 16u) {
        pio_set_gpio_base(g_pio, 16);      /* 窗口 16..47 */
        in_base = SAMPLER_PIN_BASE - 16u;
    } else {
        pio_set_gpio_base(g_pio, 0);       /* 窗口 0..31 */
        in_base = SAMPLER_PIN_BASE;
    }

    g_sm = (uint)pio_claim_unused_sm(g_pio, true);
    uint offset = pio_add_program(g_pio, &sampler_program);

    pio_sm_config c = sampler_program_get_default_config(offset);
    sm_config_set_in_pins(&c, in_base);
    sm_config_set_in_shift(&c, false /* 左移，先来的在高位 */, true /* autopush */, 32);
    sm_config_set_clkdiv(&c, 1.0f);        /* 每个时钟 1 个采样 */
    pio_sm_init(g_pio, g_sm, offset, &c);
    pio_sm_set_enabled(g_pio, g_sm, true);

    /* DMA：PIO RX FIFO → 环形缓冲（写地址回卷）*/
    g_dma = dma_claim_unused_channel(true);
    dma_channel_config dc = dma_channel_get_default_config((uint)g_dma);
    channel_config_set_transfer_data_size(&dc, DMA_SIZE_32);
    channel_config_set_read_increment(&dc, false);            /* 一直读 FIFO */
    channel_config_set_write_increment(&dc, true);
    channel_config_set_dreq(&dc, pio_get_dreq(g_pio, g_sm, false));
    /* 写地址环形回卷：缓冲 64 KB ⇒ 环大小 16 ⇒ 回卷到 64 KB 边界 */
    channel_config_set_ring(&dc, true /* write */, 16 /* 2^16 = 64KB */);
    dma_channel_configure((uint)g_dma, &dc,
                          g_buf,                          /* 写 */
                          &g_pio->rxf[g_sm],              /* 读 */
                          0xFFFFFFFFu,                    /* 无限 */
                          true);

    dma_channel_set_irq0_enabled((uint)g_dma, true);
    irq_set_exclusive_handler(DMA_IRQ_0, dma_irq_handler);
    irq_set_enabled(DMA_IRQ_0, true);
}

/* ---------------------------------------------------------------- 输出 */
static void dump_hex(void) {
    printf("BEGIN %u %u\n", (unsigned)BUF_WORDS, (unsigned)g_wraps);
    for (uint i = 0; i < BUF_WORDS; i++) {
        printf("%08lx\n", (unsigned long)g_buf[i]);
        if ((i & 0x3FFu) == 0x3FFu) { fflush(stdout); }   /* 分批 flush 防丢 */
    }
    printf("END\n");
    fflush(stdout);
}

static void dump_bin(void) {
    /* 二进制直出（更快）：先发 8 字节头，再发原始数据 */
    uint32_t hdr[2] = { BUF_WORDS, g_wraps };
    fwrite(hdr, 4, 2, stdout); fflush(stdout);
    fwrite((const void *)g_buf, 4, BUF_WORDS, stdout); fflush(stdout);
}

static void print_help(void) {
    printf("\n=== TMDS 采样探针 ===\n");
    printf(" 采样率 = %lu Hz   缓冲 = %u 字 (%u 采样)\n",
           (unsigned long)clock_get_hz(clk_sys), (unsigned)BUF_WORDS, (unsigned)BUF_WORDS * 4u);
    printf(" 引脚基址 = %d （接 DUT 的 8 根 DVI 线）\n", SAMPLER_PIN_BASE);
    printf(" 命令：\n");
    printf("   h  显示本帮助\n");
    printf("   s  显示状态（采样率/回卷数/缓冲）\n");
    printf("   d  以十六进制 dump 整个缓冲\n");
    printf("   b  以二进制 dump（快）\n");
    printf("   r  清空计数（把当前缓冲当作起点）\n");
    printf("   0  停止采样    1  开始采样\n");
    fflush(stdout);
}

int main(void) {
    stdio_init_all();
    sleep_ms(1500);                 /* 等 USB 枚举 */
    sampler_init();
    print_help();

    while (true) {
        int c = getchar_timeout_us(100000);   /* 100 ms 超时，便于同时打印心跳 */
        if (c == PICO_ERROR_TIMEOUT) {
            static uint32_t t = 0;
            if ((++t % 50u) == 0u) { printf("# %lu wraps\n", (unsigned long)g_wraps); fflush(stdout); }
            continue;
        }
        switch (c) {
            case 'h': case '?': print_help(); break;
            case 's':
                printf("STAT clk=%lu wraps=%lu buf=%u words\n",
                       (unsigned long)clock_get_hz(clk_sys), (unsigned long)g_wraps,
                       (unsigned)BUF_WORDS);
                fflush(stdout); break;
            case 'd': dump_hex(); break;
            case 'b': dump_bin(); break;
            case 'r': g_wraps = 0; printf("OK\n"); fflush(stdout); break;
            case '0': pio_sm_set_enabled(g_pio, g_sm, false); printf("OK stopped\n"); fflush(stdout); break;
            case '1': pio_sm_set_enabled(g_pio, g_sm, true);  printf("OK running\n"); fflush(stdout); break;
            default: break;
        }
    }
}
