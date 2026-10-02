/*
 * TMDS 采样探针 —— RP2040 版
 * ===========================================================================
 * 角色：探针（RP2040，13 元板）采样【待测板】的 DVI 输出。
 *
 * 接线（与待测板 RP2350B Plus W 的 GPIO 0..7 一一对应）：
 *      探针 GPIO 0..7  ←  待测 GPIO 0..7
 *      0=D2P 1=D2N 2=D1P 3=D1N 4=D0P 5=D0N 6=CLKP 7=CLKN
 *   外加共地（GND）。
 *
 * 原理：
 *   · PIO 一条 `in pins, 8` ⇒ 每个时钟锁存 8 根线一次
 *   · autopush=32bit ⇒ 每 4 个采样推出 1 个 32 位字给 DMA
 *   · DMA 写地址环形回卷到 64KB 缓冲 ⇒ 持续采样、随时 dump
 *   · 采样率 = sys_clk。TMDS 位率也是 252 Mbit/s ⇒ 约 1 采样/位。
 *     RP2040 默认 133 MHz 会严重混叠 ⇒ 这里超频到 252 MHz（用户已批准随便超）。
 *
 * 两块板的晶振有微小频差 ⇒ 采到的时钟会呈"拍频"图案
 *   ⇒ 可离线反推待测板的真实位率，并做等效时间采样重建波形。
 *
 * 串口命令（USB CDC + UART0）：
 *   h 帮助   s 状态   d 十六进制 dump   b 二进制 dump   r 清计数   0 停  1 开
 * ===========================================================================
 */
#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "hardware/clocks.h"
#include "hardware/vreg.h"

/*
 * PIO 程序：手写，不依赖 pioasm。
 *   `in pins, 8` 一条指令 = 每个时钟把 8 根引脚锁存进 ISR。
 *   编码：bit15..13=010(IN)  bit7..5=000(PINS)  bit4..0=8 ⇒ 0x4008
 *   （这样就不需要 pico_generate_pio_header / pioasm 主机工具）
 */
static const uint16_t sampler_program_instructions[] = { 0x4008 };
static const struct pio_program sampler_program = {
    .instructions = sampler_program_instructions,
    .length       = 1,
    .origin       = -1,
};

#define PROBE_PIN_BASE   0            /* 采 GPIO 0..7 */
#define PROBE_CLK_KHZ    252000       /* 采样时钟（超频，用户已批准） */
#define BUF_WORDS        (16u * 1024u)   /* 16K 字 = 64KB = 262144 个采样 */

static uint32_t __attribute__((aligned(4096))) g_buf[BUF_WORDS];
static PIO  g_pio;
static uint g_sm;
static int  g_dma = -1;
static volatile uint32_t g_wraps = 0;

static void dma_irq_handler(void) {
    if (dma_hw->ints0 & (1u << g_dma)) {
        dma_hw->ints0 = 1u << g_dma;
        g_wraps++;
    }
}

static void probe_init(void) {
    /* ★ 超频：RP2040 跑 252 MHz 需要抬 vreg（这是社区验证过的常用超频档） */
    vreg_set_voltage(VREG_VOLTAGE_1_25);
    sleep_ms(10);
    set_sys_clock_khz(PROBE_CLK_KHZ, true);

    for (uint i = 0; i < 8; i++) {
        gpio_init(PROBE_PIN_BASE + i);
        gpio_set_dir(PROBE_PIN_BASE + i, GPIO_IN);
    }

    g_pio = pio0;
    g_sm  = (uint)pio_claim_unused_sm(g_pio, true);
    uint offset = pio_add_program(g_pio, &sampler_program);

    pio_sm_config c = pio_get_default_sm_config();
    sm_config_set_in_pins(&c, PROBE_PIN_BASE);        /* RP2040 窗口固定 0..31 */
    sm_config_set_in_shift(&c, false /* 左移：先来的在高位 */, true /* autopush */, 32);
    sm_config_set_clkdiv(&c, 1.0f);
    pio_sm_init(g_pio, g_sm, offset, &c);
    pio_sm_set_enabled(g_pio, g_sm, true);

    g_dma = dma_claim_unused_channel(true);
    dma_channel_config dc = dma_channel_get_default_config((uint)g_dma);
    channel_config_set_transfer_data_size(&dc, DMA_SIZE_32);
    channel_config_set_read_increment(&dc, false);
    channel_config_set_write_increment(&dc, true);
    channel_config_set_dreq(&dc, pio_get_dreq(g_pio, g_sm, false));
    channel_config_set_ring(&dc, true /* write */, 16 /* 2^16 = 64KB 环 */);
    dma_channel_configure((uint)g_dma, &dc, g_buf, &g_pio->rxf[g_sm], 0xFFFFFFFFu, true);

    dma_channel_set_irq0_enabled((uint)g_dma, true);
    irq_set_exclusive_handler(DMA_IRQ_0, dma_irq_handler);
    irq_set_enabled(DMA_IRQ_0, true);
}

static void dump_hex(void) {
    printf("BEGIN %u %lu\n", (unsigned)BUF_WORDS, (unsigned long)g_wraps);
    for (uint i = 0; i < BUF_WORDS; i++) {
        printf("%08lx\n", (unsigned long)g_buf[i]);
        if ((i & 0x3FFu) == 0x3FFu) fflush(stdout);
    }
    printf("END\n");
    fflush(stdout);
}

static void help(void) {
    printf("\n=== TMDS 采样探针 (RP2040) ===\n");
    printf(" 采样率 = %lu Hz   缓冲 = %u 字 (%u 采样)\n",
           (unsigned long)clock_get_hz(clk_sys), (unsigned)BUF_WORDS, (unsigned)BUF_WORDS * 4u);
    printf(" 采 GPIO %d..%d   命令: h 帮助  s 状态  d hex dump  b bin dump  r 清计数  0 停  1 开\n",
           PROBE_PIN_BASE, PROBE_PIN_BASE + 7);
    fflush(stdout);
}

int main(void) {
    stdio_init_all();
    sleep_ms(1500);
    probe_init();
    help();

    while (true) {
        int c = getchar_timeout_us(100000);
        if (c == PICO_ERROR_TIMEOUT) {
            static uint32_t t = 0;
            if ((++t % 60u) == 0u) { printf("# %lu wraps\n", (unsigned long)g_wraps); fflush(stdout); }
            continue;
        }
        switch (c) {
            case 'h': case '?': help(); break;
            case 's':
                printf("STAT clk=%lu wraps=%lu buf=%u\n",
                       (unsigned long)clock_get_hz(clk_sys), (unsigned long)g_wraps, (unsigned)BUF_WORDS);
                fflush(stdout); break;
            case 'd': dump_hex(); break;
            case 'b': {
                uint32_t hdr[2] = { BUF_WORDS, g_wraps };
                fwrite(hdr, 4, 2, stdout); fflush(stdout);
                fwrite(g_buf, 4, BUF_WORDS, stdout); fflush(stdout);
                break;
            }
            case 'r': g_wraps = 0; printf("OK\n"); fflush(stdout); break;
            case '0': pio_sm_set_enabled(g_pio, g_sm, false); printf("OK stopped\n"); fflush(stdout); break;
            case '1': pio_sm_set_enabled(g_pio, g_sm, true);  printf("OK running\n"); fflush(stdout); break;
            default: break;
        }
    }
}
