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
#include "pico/bootrom.h"          /* reset_usb_boot：串口后门进 BOOTSEL */
#include "hardware/watchdog.h"     /* watchdog_reboot：串口后门普通重启 */
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "hardware/clocks.h"
#include "hardware/vreg.h"

#include "sampler.pio.h"       /* 由 pioasm 生成：in pins, 8 */

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
        uint p = PROBE_PIN_BASE + i;
        gpio_init(p);
        gpio_set_dir(p, GPIO_IN);
        /*
         * ★ 把引脚功能交给 PIO。gpio_init 只把功能设成 SIO，
         *   而 PIO 采样走的是 PAD 的输入通路 —— pio_gpio_init 会设置 PIO 功能
         *   并清掉 PAD 的 ISO（隔离）位，这是"PIO 采不到电平"最常见的原因。
         */
        pio_gpio_init(pio0, p);
    }

    g_pio = pio0;
    g_sm  = (uint)pio_claim_unused_sm(g_pio, true);
    uint offset = pio_add_program(g_pio, &sampler_program);

    /* ★ 必须用【程序自己的】默认配置：它会把 wrap_top/wrap_bottom 设成该程序的边界。
     *   若改用 pio_get_default_sm_config()，wrap 会是整片 (0,31)，
     *   而程序若被装在偏移 2，SM 就会在地址 0/1 的空指令（jmp 0）里死循环，
     *   永远走不到 in pins,8 ⇒ FIFO 永远空。（本轮实测踩到的坑） */
    pio_sm_config c = sampler_program_get_default_config(offset);
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
    /* ★ 用显式 DREQ 宏（RP2040: DREQ_PIO0_RX0=4），避免任何参数顺序疑问 */
    channel_config_set_dreq(&dc, DREQ_PIO0_RX0 + g_sm);
    /*
     * ★ 高优先级：实测数据里 CLK 边沿间隔是 min=1 median=1 max=4455 ——
     *   那个 4455 采样的空洞说明 PIO 的 FIFO 溢出过 ⇒ SM 停顿 ⇒【丢样、时间轴断裂】。
     *   FIFO 只有 4 深，DMA 必须在 4 个采样内响应；DMA 一旦被总线上的其它流量
     *   （USB、以及我们自己在 dump 的串口）挤后，就会来不及。
     *   给这个通道开高优先级是 RP2040 上"别让 DMA 饿死"的标准做法。
     */
    channel_config_set_high_priority(&dc, true);
    /*
     * ★ 不用环形回卷：RP2040 的 DMA ring size 只有 4 位（最大 2^15），
     *   之前写 16（=2^16）是非法值，很可能就是"一个字都没搬"的原因 ✗
     *   改成最朴素的一次性采集：填满 16384 字就停，用 'd' 取走后再 'c' 重启。
     */
    dma_channel_configure((uint)g_dma, &dc, g_buf, &g_pio->rxf[g_sm], BUF_WORDS, true);

    dma_channel_set_irq0_enabled((uint)g_dma, true);
    irq_set_exclusive_handler(DMA_IRQ_0, dma_irq_handler);
    irq_set_enabled(DMA_IRQ_0, true);
}

static void capture(void) {
    /*
     * ★ 不用 DMA：直接用 CPU 紧循环抽干 PIO 的 RX FIFO。
     *   理由（本轮实测证据）：FIFO 里确实有数据（FIFO_POP=0x2b15528b），
     *   但 DMA 的 TREQ 触发源没配成 PIO0_RX（ctrl=0x01020029 ⇒ TREQ 字段不对），
     *   于是 DMA 一个字都没搬。CPU 抽 FIFO 这条路已被证明可用。
     *
     * 速度：CPU 读一个 32 位字约 4~8 周期 ⇒ 16384 字 ≈ 260~520 µs 的信号 ✓
     * （每个字含 4 个采样，采样率 = sys_clk = 252 MHz）
     */
    for (uint i = 0; i < BUF_WORDS; i++) {
        uint32_t guard = 0;
        while (pio_sm_is_rx_fifo_empty(g_pio, g_sm)) {
            if (++guard > 2000000u) {   /* ★ 超时保护：宁可采不满，也绝不挂死 */
                printf("CAPTURE_TIMEOUT at word %lu\n", (unsigned long)i);
                fflush(stdout);
                return;
            }
        }
        g_buf[i] = pio_sm_get(g_pio, g_sm);
    }
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
                /* ★ 自证诊断：缓冲里有多少个非零字（证明 DMA 真的写进过数据），
                 *   以及该 DMA 通道还剩多少传输（0xFFFFFFFF 减去已搬字数）。*/
                {
                    uint32_t nz = 0, firstnz = 0xFFFFFFFFu;
                    for (uint i = 0; i < BUF_WORDS; i++) {
                        if (g_buf[i]) { if (firstnz == 0xFFFFFFFFu) firstnz = i; nz++; }
                    }
                    uint32_t remain = dma_channel_hw_addr((uint)g_dma)->transfer_count;
                    printf("DIAG nonzero=%lu/%u first_at=%ld dma_remain=%lu sm_en=%u rxf=%u\n",
                           (unsigned long)nz, (unsigned)BUF_WORDS,
                           (firstnz == 0xFFFFFFFFu ? -1L : (long)firstnz),
                           (unsigned long)remain,
                           (unsigned)((g_pio->ctrl >> (g_sm * 4u)) & 1u),
                           (unsigned)pio_sm_get_rx_fifo_level(g_pio, g_sm));
                    /* ★ PIO 寄存器全貌：判断状态机到底在不在执行、配置对不对 */
                    printf("PIO ctrl=0x%08lx fstat=0x%08lx sm%u: clkdiv=0x%08lx execctrl=0x%08lx shiftctrl=0x%08lx addr=%lu pinctrl=0x%08lx\n",
                           (unsigned long)g_pio->ctrl, (unsigned long)g_pio->fstat, g_sm,
                           (unsigned long)g_pio->sm[g_sm].clkdiv,
                           (unsigned long)g_pio->sm[g_sm].execctrl,
                           (unsigned long)g_pio->sm[g_sm].shiftctrl,
                           (unsigned long)g_pio->sm[g_sm].addr,
                           (unsigned long)g_pio->sm[g_sm].pinctrl);
                    printf("PIO instr0=0x%04lx  (期望 0x4008 = in pins,8)\n",
                           (unsigned long)g_pio->instr_mem[0]);
                    /*
                     * ★ 程序到底装在哪、SM 到底在跑哪条指令？
                     *   execctrl 的 wrap_bottom(bit16:12) 就是 pio_add_program 返回的 offset
                     *   （pio_add_program 从指令内存【顶部】向下找空位 ⇒ 1 条指令的程序会落在 31）
                     *   所以真正该看的是 instr_mem[offset]，而不是 instr_mem[0]。
                     */
                    {
                        uint32_t off = (g_pio->sm[g_sm].execctrl >> 12) & 0x1fu;
                        uint32_t pc  = g_pio->sm[g_sm].addr & 0x1fu;
                        printf("PROG offset=%lu pc=%lu  instr[offset]=0x%04lx  instr[pc]=0x%04lx\n",
                               (unsigned long)off, (unsigned long)pc,
                               (unsigned long)g_pio->instr_mem[off],
                               (unsigned long)g_pio->instr_mem[pc]);
                    }
                    /* ★ DMA 通道 CTRL + 直接把 FIFO 里一个字取出来（读 RXF 会弹出一个字）
                     *   ⇒ 如果这里能读到非零数据，就证明 PIO 确实在生产数据，问题只在 DMA ✗ */
                    printf("DMA ctrl=0x%08lx  FIFO_POP=0x%08lx\n",
                           (unsigned long)dma_channel_hw_addr((uint)g_dma)->ctrl_trig,
                           (unsigned long)g_pio->rxf[g_sm]);
                }
                fflush(stdout); break;
            case 'd': dump_hex();
                      /* ★ 采完立刻重新装填并启动 DMA，方便连续采 */
                      dma_channel_set_write_addr((uint)g_dma, g_buf, false);
                      dma_channel_set_trans_count((uint)g_dma, BUF_WORDS, true);
                      break;
            case 'b': {
                uint32_t hdr[2] = { BUF_WORDS, g_wraps };
                fwrite(hdr, 4, 2, stdout); fflush(stdout);
                fwrite(g_buf, 4, BUF_WORDS, stdout); fflush(stdout);
                break;
            }
            case 'r': g_wraps = 0; printf("OK\n"); fflush(stdout); break;
            /*
             * ★ 'c' = 设分频 + 重装 DMA。
             *   为什么需要：满速（clkdiv=1）时 PIO 每 4 个采样推 1 个字 = 63 Mwords/s，
             *   而 RX FIFO 只有 4 深 ⇒ DMA 必须 64ns 内响应，RP2040 的 DMA 延迟恰在这个量级
             *   ⇒ 一溢出 PIO 就停顿 ⇒ 【丢样本 ⇒ 时间轴断裂 ⇒ 无法抽符号】。
             *   降速后 FIFO 永不溢出，样本在时间上连续。
             *   测 TMDS 用【相干欠采样】即可：采样率与位率不成整数关系时，
             *   每个样本落在不同的比特相位上 ⇒ 足够多的样本可重建整条眼图/波形。
             *   用法： c <div>  例如 c 4 ⇒ 63 MSa/s
             */
            case 'c': {
                float d = 4.0f;
                /* 允许 "c 8" 这样带个整数参数（简单解析：读一个十进制数） */
                int ch2 = getchar_timeout_us(20000);
                if (ch2 >= '1' && ch2 <= '9') d = (float)(ch2 - '0');
                pio_sm_set_clkdiv(g_pio, g_sm, d);
                dma_channel_set_write_addr((uint)g_dma, g_buf, false);
                dma_channel_set_trans_count((uint)g_dma, BUF_WORDS, true);
                printf("OK clkdiv=%.1f  =>  %.1f MSa/s\n", (double)d,
                       (double)clock_get_hz(clk_sys) / d / 1e6);
                fflush(stdout); break;
            }
            case '0': pio_sm_set_enabled(g_pio, g_sm, false); printf("OK stopped\n"); fflush(stdout); break;
            case '1': pio_sm_set_enabled(g_pio, g_sm, true);  printf("OK running\n"); fflush(stdout); break;
            /* ── 直接读引脚（绕过 PIO/DMA，用 SIO）⇒ 分清"通路坏"还是"PIO 路坏" ── */
            case 'g': {
                printf("GPIO   : 7 6 5 4 3 2 1 0\n");
                for (int n = 0; n < 5; n++) {
                    uint32_t m = 0;
                    for (int i = 0; i < 8; i++) if (gpio_get(PROBE_PIN_BASE + i)) m |= (1u << i);
                    printf("read%-2d : %d %d %d %d %d %d %d %d   0x%02lx\n", n,
                           (int)((m >> 7) & 1), (int)((m >> 6) & 1), (int)((m >> 5) & 1), (int)((m >> 4) & 1),
                           (int)((m >> 3) & 1), (int)((m >> 2) & 1), (int)((m >> 1) & 1), (int)(m & 1),
                           (unsigned long)m);
                    sleep_ms(200);
                }
                fflush(stdout); break;
            }
            /* ── 串口后门：本板没 SWD 时靠它进 BOOTSEL ── */
            case 'B': printf("\n[backdoor] BOOTSEL reboot...\n"); fflush(stdout); sleep_ms(50); reset_usb_boot(0, 0); break;
            case 'R': printf("\n[backdoor] reboot...\n");        fflush(stdout); sleep_ms(50); watchdog_reboot(0, 0, 0); break;
            default: break;
        }
    }
}
