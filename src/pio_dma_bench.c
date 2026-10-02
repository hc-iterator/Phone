/*
 * PIO + DMA 最小对照基准（2026-10-01 深夜，临时诊断）
 *
 * 目的：把【硬件能力】与【本项目的库用法】分开。
 *
 * 第 8 轮实测发现：拿 DVI 串行器的【原程序】跑基准，每字要 1157 ns
 * （约 292 时钟 = 每 bit 14.6 时钟），远慢于"1 bit/时钟"这个所有文档都假定的前提。
 * ⇒ 这就是"所有构建共有"的限速方。
 *
 * 第 9 轮：一次跑【两个变体】做对照 ——
 *   变体 0：fork 的写法  .side_set 2      （side-set 在 bit 12:11）
 *   变体 1：原版写法     .side_set 2 opt  （bit 12 是使能位，side-set 在 11:10）
 * 判读：
 *   变体 1 明显更快 ⇒ fork 把串行器改坏了，修法是把 opt 加回去
 *   两者一样慢     ⇒ 是 RP2350 上 out pc 分支的固有代价，需换串行器写法
 *
 * ⚠️ 临时诊断：直接用 SDK 的 pio2 / dma_claim_unused_channel，绕过内核资源账本。
 *    只在 DVI 启动【之前】跑，定位完应删除本文件及其调用点与 CMakeLists 登记。
 */

#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "hardware/clocks.h"

volatile uint32_t g_bench_us    = 0;   /* 变体 0（无 opt）搬 g_bench_words 字的耗时 */
volatile uint32_t g_bench2_us   = 0;   /* 变体 1（有 opt） */
volatile uint32_t g_bench3_us   = 0;   /* 变体 2（pull 版 20 时钟循环，已知正常的对照） */
volatile uint32_t g_bench4_us   = 0;   /* 变体 3（out pins,1 ×2 —— 第 11 轮判别） */
volatile uint32_t g_bench5_us   = 0;   /* 第 14 轮：展开 20×out + 显式 pull（autopull 关） */
volatile uint32_t g_bench6_us   = 0;   /* 第 15 轮：out null,1 ×2（不碰引脚） */
volatile uint32_t g_bench7_us   = 0;   /* 第 16 轮：out pins,1 ×2 但 autopull 阈值 10 */
volatile uint32_t g_bench8_us   = 0;   /* 第 19 轮：out pc,1 ×2 但 clkdiv=2（判别固定时延 vs SM周期） */
volatile uint32_t g_bench_words = 0;
volatile uint32_t g_bench_done  = 0;
volatile uint32_t g_bench_ch    = 0xFFFFFFFFu;
volatile uint32_t g_bench_sm    = 0xFFFFFFFFu;

#define BENCH_WORDS 4096u

static uint32_t s_src[BENCH_WORDS];

/* out pc,1 side 0b10 / out pc,1 side 0b01 —— 无 opt：side 在 bit 12:11 */
static const uint16_t PROG_NOOPT[2] = { 0x70A1u, 0x68A1u };
/* 同上，但有 opt：bit 12 = 使能位，side 退到 bit 11:10 */
static const uint16_t PROG_OPT[2]   = { 0x78A1u, 0x74A1u };
/* 对照：显式 pull + 带 18 周期延时的 jmp ⇒ 也是 20 个时钟/字，但不用 out pc */
static const uint16_t PROG_PULL[2]  = { 0x80A0u, 0x1200u };
/* 第 11 轮判别：与 V0 同结构，但写 PINS 而不是 PC ⇒ 分离"out pc 慢"与"每 bit 一条 out 慢" */
static const uint16_t PROG_PINS[2]  = { 0x7001u, 0x6801u };
/* 第 15 轮隔离：与 V0 同结构、同 side-set，但目标是 NULL（不碰引脚、不碰 PC、不碰内部寄存器）
 * ⇒ 若它也慢，则代价在 out/autopull 机制本身；若它快，则代价在"每 bit 改引脚"的 IO。 */
static const uint16_t PROG_NULL[2]  = { 0x7061u, 0x6861u };

/* 第 14 轮：展开成 21 条（20 条 out pins,1 + 1 条显式 pull block），autopull 关。
 * 预期每条 1 周期 ⇒ 21 时钟/字 ≈ 86 ns ⇒ 4096 字约 352 µs。
 * 若仍 ~4.7 ms ⇒ 是"每 bit 一条 out"的固有代价，不是 autopull。 */
static uint16_t s_unroll[21];

/* mode: 0=out pc 无opt, 1=out pc 有opt, 2=pull 对照, 3=out pins(autopull), 4=展开+显式pull */
static uint32_t run_variant(int mode, bool *ok) {
    *ok = false;
    const uint16_t *prog;
    int ninstr = 2;
    if (mode == 4) {
        for (int i = 0; i < 20; ++i) s_unroll[i] = (i & 1) ? 0x6801u : 0x7001u;
        s_unroll[20] = 0x80A0u;   /* pull block */
        prog = s_unroll; ninstr = 21;
    } else {
        prog = (mode == 2) ? PROG_PULL
             : (mode == 3) ? PROG_PINS
             : (mode == 5) ? PROG_NULL
             : (mode == 6) ? PROG_PINS
             : (mode == 1) ? PROG_OPT : PROG_NOOPT;
    }
    PIO pio = pio2;
    int sm = pio_claim_unused_sm(pio, false);
    if (sm < 0) return 0;

    for (int i = 0; i < ninstr; ++i) pio->instr_mem[i] = prog[i];

    pio_sm_config c = pio_get_default_sm_config();
    sm_config_set_wrap(&c, 0, (uint)ninstr - 1);
    sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_TX);   /* 8 深 TX FIFO */
    sm_config_set_clkdiv(&c, (mode == 7) ? 2.0f : 1.0f);   /* mode7: 第 19 轮 clkdiv 判别 */
    if (mode != 2) {
        sm_config_set_sideset(&c, 2, mode == 1, false);  /* 只有 out pc 版需要 side-set */
        sm_config_set_sideset_pins(&c, 32);              /* 引脚不影响节拍 */
        if (mode == 4) {
            sm_config_set_out_shift(&c, true, false, 0); /* autopull 【关】 */
            sm_config_set_out_pins(&c, 34, 1);
        } else {
            sm_config_set_out_shift(&c, true, true, (mode == 6) ? 10u : 20u);
            if (mode == 3) sm_config_set_out_pins(&c, 34, 1);
        }
    }
    pio_sm_init(pio, sm, 0, &c);
    pio_sm_set_enabled(pio, sm, true);

    int ch = dma_claim_unused_channel(false);
    if (ch < 0) { pio_sm_set_enabled(pio, sm, false); pio_sm_unclaim(pio, sm); return 0; }

    dma_channel_config cfg = dma_channel_get_default_config(ch);
    channel_config_set_transfer_data_size(&cfg, DMA_SIZE_32);
    channel_config_set_read_increment(&cfg, true);
    channel_config_set_write_increment(&cfg, false);
    channel_config_set_dreq(&cfg, pio_get_dreq(pio, sm, true));

    g_bench_ch = (uint32_t)ch;
    g_bench_sm = (uint32_t)sm;

    uint32_t t0 = time_us_32();
    dma_channel_configure(ch, &cfg, &pio->txf[sm], s_src, BENCH_WORDS, true);
    /* 第 13 轮：原来是 dma_channel_wait_for_finish_blocking(ch) —— 它【没有超时】，
     * 一旦 SM 不吃就永久 BUSY，整个固件跟着挂死（第 12 轮就是这么挂的）。
     * 改成有界轮询：超时也照样返回已用时间，让调用方看出"这个变体没跑完"。 */
    uint32_t guard = 20000000u;
    while (dma_channel_is_busy(ch) && --guard) {
        tight_loop_contents();
    }
    uint32_t dt = time_us_32() - t0;

    pio_sm_set_enabled(pio, sm, false);
    pio_sm_clear_fifos(pio, sm);
    dma_channel_unclaim(ch);
    pio_sm_unclaim(pio, sm);
    *ok = (guard != 0);   /* 第 16 轮修：守卫用尽（=DMA 从未完成）必须报失败。
                          * 原来这里无条件写 true ⇒ g_bench_done 谎报"跑完了"，
                          * 我已因此被骗三次（V4/V5/V6 的 873016 µs 都是超时）。 */
    return dt;
}

void pio_dma_bench_run(void) {
    for (uint32_t i = 0; i < BENCH_WORDS; ++i) s_src[i] = i;

    bool ok0 = false, ok1 = false, ok2 = false, ok3 = false, ok4 = false;
    uint32_t us0 = run_variant(0, &ok0);
    uint32_t us1 = run_variant(1, &ok1);
    uint32_t us2 = run_variant(2, &ok2);
    uint32_t us3 = run_variant(3, &ok3);
    uint32_t us4 = run_variant(4, &ok4);
    bool ok5 = false;
    uint32_t us5 = run_variant(5, &ok5);
    bool ok6 = false;
    uint32_t us6 = run_variant(6, &ok6);
    bool ok7 = false;
    uint32_t us7 = run_variant(7, &ok7);

    g_bench_us    = us0;
    g_bench2_us   = us1;
    g_bench3_us   = us2;
    g_bench4_us   = us3;
    g_bench5_us   = us4;
    g_bench6_us   = us5;
    g_bench7_us   = us6;
    g_bench8_us   = us7;
    g_bench_words = BENCH_WORDS;
    g_bench_done  = (ok0 ? 1u : 0u) | (ok1 ? 2u : 0u) | (ok2 ? 4u : 0u)
                  | (ok3 ? 8u : 0u) | (ok4 ? 16u : 0u) | (ok5 ? 32u : 0u)
                  | (ok6 ? 64u : 0u) | (ok7 ? 128u : 0u);
}

/* ★★★ 2026-10-02 第 53 轮诊断：固件自己当逻辑分析仪
 * 为什么需要它：调试口在引擎跑满总线时 halt 不动（"target was in unknown state"），
 * 所以读不到寄存器；而 DVI 的 pad 把输入使能关了（dvi_configure_pad 里清 IE），
 * 所以固件也读不到自己输出引脚的电平。
 * 做法：临时把这些引脚的输入使能打开，紧密循环采样 gpio_get_all()，
 *       统计每个引脚的变化次数 ⇒ 变化次数远大于 0 就说明【引脚上真的有信号】。
 * 结果从 USB 串口打印（stdio_usb 已开）。 */
#include <stdio.h>
#include "hardware/gpio.h"
#include "hardware/structs/padsbank0.h"

volatile uint32_t g_probe_changes[8];   /* 每个引脚的变化次数（供 SWD 直接读） */
volatile uint32_t g_probe_last[8];      /* 采样结束时的电平 */
volatile uint32_t g_probe_done;
volatile uint32_t g_probe_selftest;     /* 自检：用 SIO 翻转 GPIO32，同样的方法能数到多少次变化 */

void dvi_pin_probe(void) {
    static const uint pins[8] = {32,33,34,35,36,37,38,39};
    uint32_t changes[8] = {0};
    uint32_t last[8] = {0};
    uint32_t prev, cur, diff;
    int i;

    /* 1) 临时打开输入使能（IE=1） */
    for (i = 0; i < 8; i++)
        hw_write_masked(&padsbank0_hw->io[pins[i]], PADS_BANK0_GPIO0_IE_BITS, PADS_BANK0_GPIO0_IE_BITS);
    /* 1.5) 自检：把 GPIO32 拉成 SIO 输出、高速翻转，用【同样的方法】数变化。
     * 若这里也是 0 ⇒ 说明是【测量方法】坏了，而不是引脚没信号。 */
    gpio_init(32);
    gpio_set_dir(32, GPIO_OUT);
    {
        uint32_t sc = 0, sp = 0, sc2;
        for (uint32_t n = 0; n < 200000u; n++) {
            sio_hw->gpio_set = 1u << 32;
            sc2 = gpio_get_all();
            if ((sc2 ^ sp) & (1u << 32)) sc++;
            sp = sc2;
            sio_hw->gpio_clr = 1u << 32;
            sc2 = gpio_get_all();
            if ((sc2 ^ sp) & (1u << 32)) sc++;
            sp = sc2;
        }
        g_probe_selftest = sc;
    }
    gpio_set_function(32, GPIO_FUNC_PIO0);

    /* 2) 采样 200 万次，统计变化 */
    prev = gpio_get_all();
    for (i = 0; i < 8; i++) last[i] = (prev >> pins[i]) & 1u;
    for (uint32_t n = 0; n < 2000000u; n++) {
        cur  = gpio_get_all();
        diff = cur ^ prev;
        if (diff) {
            for (i = 0; i < 8; i++) {
                if (diff & (1u << pins[i])) changes[i]++;
                last[i] = (cur >> pins[i]) & 1u;
            }
        }
        prev = cur;
    }

    /* 3) 打印 */    for (i = 0; i < 8; i++) { g_probe_changes[i] = changes[i]; g_probe_last[i] = last[i]; }
    g_probe_done = 1;

    printf("[probe] DVI 引脚变化次数'（2e6 次采样）：\n");
    for (i = 0; i < 8; i++) {
        printf("   GPIO%d = %d   变化 %lu 次  %s\n", pins[i], (int)last[i],
               (unsigned long)changes[i], changes[i] ? "<== 有信号!" : "(纹丝不动)");
    }
    printf("[probe] 判读：任一引脚变化次数远大于 0 ⇒ 引脚上真的有波形\n");
    fflush(stdout);
}

/* 采样完把引擎停下来：调试口在引擎跑满总线时 halt/烧写都会超时，
 * 停掉 PIO 的 SM 和 PWM 时钟后板子就安静了。 */
#include "hardware/pio.h"
#include "hardware/pwm.h"
#include "hardware/clocks.h"
void dvi_stop_engine_for_debug(void) {
    pio_set_sm_mask_enabled(pio0, 0xFu, false);
    for (int s = 0; s < 8; s++) pwm_set_enabled((uint)s, false);
    printf("[probe] 引擎已停（PIO SM 关闭、PWM 关闭），板子现在安静了\n");
    fflush(stdout);
}

/* ★ 寄存器快照：调试口在引擎跑满总线时读不到，所以让固件把需要的寄存器
 * 抄进 RAM，之后用 reset halt + mdw 慢慢读。 */
#include "hardware/structs/io_bank0.h"
#include "hardware/structs/pwm.h"
volatile uint32_t g_snap[64];
volatile uint32_t g_snap_n;
void dvi_snapshot_regs(void) {
    int k = 0;
    /* 0..7 : IO_BANK0 GPIO32..39 的 CTRL（低5位=FUNCSEL, 6=PIO0, 7=PIO1, 4=PWM） */
    for (int i = 0; i < 8; i++) g_snap[k++] = io_bank0_hw->io[32 + i].ctrl;
    /* 8..15 : PADS_BANK0 GPIO32..39 */
    for (int i = 0; i < 8; i++) g_snap[k++] = padsbank0_hw->io[32 + i];
    /* 16..31 : PIO0 SM0..SM2 的 EXECCTRL, SHIFTCTRL, PINCTRL, ADDR */
    for (int s = 0; s < 3; s++) {
        g_snap[k++] = pio0->sm[s].execctrl;
        g_snap[k++] = pio0->sm[s].shiftctrl;
        g_snap[k++] = pio0->sm[s].pinctrl;
        g_snap[k++] = pio0->sm[s].addr;
    }
    /* 32..35 : PIO0 CTRL, FSTAT, FDEBUG, FLEVEL */
    g_snap[k++] = pio0->ctrl;
    g_snap[k++] = pio0->fstat;
    g_snap[k++] = pio0->fdebug;
    g_snap[k++] = pio0->flevel;
    /* 36..39 : PWM slice19（pin38 属于 slice19/ch1）CSR, DIV, CTR, CC */
    g_snap[k++] = pwm_hw->slice[19].csr;
    g_snap[k++] = pwm_hw->slice[19].div;
    g_snap[k++] = pwm_hw->slice[19].ctr;
    g_snap[k++] = pwm_hw->slice[19].cc;
    g_snap_n = (uint32_t)k;
}

/* ★★★ 修正版探针：RP2350 上 GPIO 32~47 在 SIO 的【高位】寄存器 gpio_hi_in 里，
 * gpio_get_all() 只给低 32 位 ⇒ 之前用 1u<<pin (pin>=32) 恒为 0，
 * 于是"引脚无信号"那个结论是【测量 bug】，不是事实。这里改用 gpio_hi_in。
 * 位序：gpio_hi_in 的 bit0..bit7 对应 GPIO32..39。 */
volatile uint32_t g_probe2_selftest;
volatile uint32_t g_probe2_runs;
void dvi_pin_probe2(void) {
    uint32_t changes[8] = {0}, last[8] = {0};
    uint32_t prev, cur, diff, i;

    for (i = 0; i < 8; i++)
        hw_write_masked(&padsbank0_hw->io[32 + i], PADS_BANK0_GPIO0_IE_BITS, PADS_BANK0_GPIO0_IE_BITS);

    /* 自检：SIO 高位寄存器翻转 GPIO32，用同样的方法数变化 */
    gpio_init(32); gpio_set_dir(32, GPIO_OUT);
    {
        uint32_t sc = 0, sp = sio_hw->gpio_hi_in;
        for (uint32_t n = 0; n < 200000u; n++) {
            sio_hw->gpio_hi_set = 1u;  cur = sio_hw->gpio_hi_in;
            if ((cur ^ sp) & 1u) sc++; sp = cur;
            sio_hw->gpio_hi_clr = 1u;  cur = sio_hw->gpio_hi_in;
            if ((cur ^ sp) & 1u) sc++; sp = cur;
        }
        g_probe2_selftest = sc;
    }
    gpio_set_function(32, GPIO_FUNC_PIO0);

    /* 主采样：2e6 次 */
    prev = sio_hw->gpio_hi_in;
    for (i = 0; i < 8; i++) last[i] = (prev >> i) & 1u;
    for (uint32_t n = 0; n < 2000000u; n++) {
        cur  = sio_hw->gpio_hi_in;
        diff = cur ^ prev;
        if (diff) {
            for (i = 0; i < 8; i++) { if (diff & (1u << i)) { changes[i]++; last[i] = (cur >> i) & 1u; } }
        }
        prev = cur;
    }
    for (i = 0; i < 8; i++) { g_probe_changes[i] = changes[i]; g_probe_last[i] = last[i]; }
    g_probe2_runs = 1;
    g_probe_done = 1;
    printf("[probe2] 自检=%lu  变化: 32=%lu 33=%lu 34=%lu 35=%lu 36=%lu 37=%lu 38=%lu 39=%lu\n",
           (unsigned long)g_probe2_selftest,
           (unsigned long)changes[0], (unsigned long)changes[1], (unsigned long)changes[2], (unsigned long)changes[3],
           (unsigned long)changes[4], (unsigned long)changes[5], (unsigned long)changes[6], (unsigned long)changes[7]);
    fflush(stdout);
}

/* 运行中快照：引擎还在跑的时候抄下 PIO0 的开关状态与各 SM 的 PC，
 * 两次采样对比 ADDR 是否变化 ⇒ 判断【SM 到底有没有被启用、有没有在执行】。 */
volatile uint32_t g_run[16];
void dvi_snapshot_running(void) {
    g_run[0] = pio0->ctrl;
    g_run[1] = pio0->fstat;
    g_run[2] = pio0->flevel;
    g_run[3] = pio0->fdebug;
    for (int s = 0; s < 3; s++) {
        g_run[4 + s] = pio0->sm[s].addr;
        g_run[7 + s] = pio0->sm[s].instr;
    }
    g_run[10] = pwm_hw->slice[19].csr;
    g_run[11] = (uint32_t)pwm_gpio_to_slice_num(38);
}

/* 补测：PIO 的 GPIO 窗口基址（偏移 0x168）+ 正确的 PWM slice（由 pwm_gpio_to_slice_num 给出） */
volatile uint32_t g_run2[8];
void dvi_snapshot_running2(void) {
    g_run2[0] = *(volatile uint32_t *)((uintptr_t)pio0 + 0x168);   /* PIO0 GPIOBASE */
    g_run2[1] = *(volatile uint32_t *)((uintptr_t)pio1 + 0x168);   /* PIO1 GPIOBASE */
    uint s = pwm_gpio_to_slice_num(38);
    g_run2[2] = s;
    g_run2[3] = pwm_hw->slice[s].csr;
    g_run2[4] = pwm_hw->slice[s].div;
    g_run2[5] = pwm_hw->slice[s].ctr;
    g_run2[6] = pwm_hw->slice[s].cc;
    g_run2[7] = pwm_hw->en;
}

/* ★ 隔离测试：PIO 到底能不能驱动 GPIO32 ？（用 PIO0 空闲的 SM3 + set pins）
 * 判据：探针能读到 GPIO32 翻转 ⇒ PIO 驱动没问题；读不到 ⇒ 窗口/基址机制不对。 */
volatile uint32_t g_pio_toggle_ok;
void pio_toggle_test(void) {
    static const uint16_t prog[2] = { 0xE001u, 0xE000u };  /* set pins,1 / set pins,0 */
    struct pio_program p = { .instructions = prog, .length = 2, .origin = -1 };
    uint off = pio_add_program(pio0, &p);
    pio_sm_config c = pio_get_default_sm_config();
    sm_config_set_set_pins(&c, 32, 1);          /* SET 基址 = GPIO32 */
    sm_config_set_wrap(&c, off, off + 1);
    sm_config_set_clkdiv(&c, 1000.0f);          /* 慢速，便于采样 */
    pio_gpio_init(pio0, 32);
    pio_sm_set_consecutive_pindirs(pio0, 3, 32, 1, true);
    pio_sm_init(pio0, 3, off, &c);
    pio_sm_set_enabled(pio0, 3, true);
    g_pio_toggle_ok = 0x1234;
}

/* 再验一次探针的"高位寄存器→引脚"编号：用 SIO 翻转 GPIO38（应为 bit6），
 * 若下标 6 变化 ⇒ 编号正确 ⇒ 之前"38/39 无波形"可信；
 * 若不变而别的下标变了 ⇒ 我的标签错，那个结论作废。 */
volatile uint32_t g_st32, g_st38;
void probe_maptest(void) {
    uint32_t sc, sp, cur, i;
    /* GPIO32 → 期望 bit0 */
    gpio_init(32); gpio_set_dir(32, GPIO_OUT);
    sc = 0; sp = sio_hw->gpio_hi_in;
    for (i = 0; i < 100000u; i++) {
        sio_hw->gpio_hi_set = 1u; cur = sio_hw->gpio_hi_in;
        if ((cur ^ sp) & 0x3Fu) sc++; sp = cur;
        sio_hw->gpio_hi_clr = 1u; cur = sio_hw->gpio_hi_in;
        if ((cur ^ sp) & 0x3Fu) sc++; sp = cur;
    }
    g_st32 = sc;
    gpio_set_function(32, GPIO_FUNC_PIO0);
    /* GPIO38 → 期望 bit6 */
    gpio_init(38); gpio_set_dir(38, GPIO_OUT);
    sc = 0; sp = sio_hw->gpio_hi_in;
    for (i = 0; i < 100000u; i++) {
        sio_hw->gpio_hi_set = 1u << 6; cur = sio_hw->gpio_hi_in;
        if ((cur ^ sp) & 0x3Fu) sc++; sp = cur;
        sio_hw->gpio_hi_clr = 1u << 6; cur = sio_hw->gpio_hi_in;
        if ((cur ^ sp) & 0x3Fu) sc++; sp = cur;
    }
    g_st38 = sc;
    gpio_set_function(38, GPIO_FUNC_PWM);
}

/* 极简诊断：每秒记一次 (时间 µs, IRQ 计数)。不碰任何 DVI 引脚。
 * 用 reset halt 后一次读回，避开"引擎忙时 halt 不动"的问题。 */
volatile uint32_t g_rate_t[16];
volatile uint32_t g_rate_c[16];
volatile uint32_t g_rate_n;
extern volatile uint32_t g_dvi_irq_count;
void rate_tick(void) {
    uint32_t n = g_rate_n;
    if (n < 16u) {
        g_rate_t[n] = time_us_32();
        g_rate_c[n] = g_dvi_irq_count;
        g_rate_n = n + 1u;
    }
}
