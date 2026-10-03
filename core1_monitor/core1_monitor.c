/*
 * core1_monitor.c -- RP2040 / Core1 串口调试监视器（"穷人版 SWD"）
 *
 * 目标：探针板（RP2040 核心板，没有引出 SWD）一旦跑挂，只能人手按 BOOTSEL 才能救。
 *       本固件把「串口服务」整个从会挂死的那一核搬到 Core1 上，于是：
 *         Core0 死不死，串口都活着；P（暂停）/B（进 BOOTSEL）永远能用。
 *
 * ============================ 为什么这么写（设计理由，不是"做了什么"） ============================
 *
 * [1] 为什么 USB stdio 必须"Core0 初始化、Core1 服务"
 *     SDK 的 stdio_usb_init() 顶部有一条硬断言：
 *         if (get_core_num() != alarm_pool_core_num(alarm_pool_get_default())) { assert(false); ... }
 *     而默认 alarm pool 是 boot 时在 Core0 的 runtime init 里建好的（单例，永远属于 Core0）。
 *     => 在 Core1 上调 stdio_usb_init() 会直接 panic（断言默认是开着的）。
 *     所以：Core0 负责 *初始化*，然后我们把 USB 的两条中断从 Core0 的 NVIC 上摘下来、
 *     挂到 Core1 的 NVIC 上（NVIC 是每核私有的：访问 PPB 基址拿到的就是当前核的）。
 *     中断处理函数表（RAM vector table + shared handler 表）是全局的，所以换核服务完全可行。
 *     换核之后 Core0 再也不碰任何 stdio —— 这就是"Core1 独占串口"。
 *
 * [2] 为什么 Core1 的所有等待都必须自带超时、且不能用 sleep_ms()
 *     SDK 的 sleep_ms() / multicore_fifo_pop_timeout_us() 内部走 best_effort_wfe_or_timeout()，
 *     而它会把"叫醒我"的闹钟挂到 **默认 alarm pool（Core0 的池）** 上：
 *     如果 Core0 挂死且关着中断，那个闹钟永远不会响，Core1 就会卡在 __wfe() 里 ——
 *     这正是本任务要消灭的"挂死"，绝对不能自己踩进去。
 *     所以 Core1 上一律用自旋等待（time_us_64() 比较 + tight_loop_contents()），
 *     并且从不在 Core1 上调用 sleep_ms()/sleep_us()。
 *
 * [3] 为什么写 Flash 前必须把 Core0 停到一个 RAM 函数里
 *     flash_range_erase()/flash_range_program()/flash_do_cmd() 内部会 flash_exit_xip() 关掉 XIP。
 *     XIP 一关，任何"从 flash 取指"的核都会在总线上卡死。
 *     Core0 平时就是在 flash 里跑代码（暂停时也只是在 flash 里 WFI），所以：
 *       - Core1 先通过 FIFO 请 Core0 跳进一个 __no_inline_not_in_flash_func 的 RAM 函数，
 *       - Core0 在里面关中断 + 纯 RAM 自旋（中断关了 WFI 永远醒不来，所以只能自旋），
 *       - Core1 收到 ACK 才开始碰 flash，干完把 g_flash_release 置 1 放行。
 *     拿不到 ACK（Core0 真挂了）就 **拒绝** 这次 flash 操作并报错，绝不让 XIP 和 Core0 互相踩。
 *     Core1 自己在 flash 操作期间也要 save_and_disable_interrupts()，否则它自己的 ISR 会去取 flash。
 *
 * [4] 为什么 r/w 只认白名单地址
 *     在错误地址上取数会吃 BusFault -> HardFault，那等于"监视器自己挂了"，与任务目的相反。
 *     所以 r 只允许 bootrom / XIP flash / SRAM，w 只允许 SRAM（外设寄存器一律拒绝：
 *     读外设可能有副作用，读未实现地址会 fault）。
 *
 * [5] 为什么 0x10000000 起头 4KB 永远不许写
 *     那是 boot2（flash 二级引导）+ 向量表，写坏就真的变砖。任何擦/写请求只要碰到它就拒绝。
 *
 * [6] 为什么还要拒绝"写自己"
 *     擦掉正在执行的代码，这个会话会在命令中途断气（XIP 恢复后第一条取指就完蛋）。
 *     要换固件请走 B（BOOTSEL）+ picotool —— 那才是安全路径。
 *
 * [7] 采样器（第二件活）：为什么把它搬到 Core0，而不是让 Core1 干
 *     探针板以前要么跑"监视器"、要么跑"采样器"，两个固件。而探针【干活时】（跑采样器）
 *     一旦挂死，照样没人救 —— 那正是本固件要消灭的场景。
 *     合并方案：Core1 保持它已验证的"独占 USB + 永不挂死"角色；采样器（PIO + 抽 FIFO）
 *     放 Core0，Core1 只通过核间 FIFO 下命令、然后负责把 16384 行 hex 从 USB 顺畅吐出去。
 *     好处：采样器跑飞 = Core0 挂死 = 恰恰是本固件已经被上机验证过能扛住的那种故障。
 *
 * [8] 采样器为什么必须保留 252 MHz 超频（沿用 probe_rp2040 的档位）
 *     上位机的 tools/tmds_sampled_decode.py 里 PROBE_CLK_HZ = 252.0e6 是【硬编码】的，
 *     报告也写着"固件只能产生 252MHz/clkdiv"。合并后如果偷偷改成 125 MHz，
 *     所有历史采集与离线分析全部对不上 ⇒ 采样率契约必须保持不变。
 *     超频只在【Core1 启动之前】做一次：Core1 一旦开始服务 USB，就再也不动时钟了，
 *     所以监视器那套"永不挂死"的性质一点没被削弱（USB 用的是独立的 clk_usb = 48MHz）。
 *     而且 set_sys_clock_khz(..., false) 用"尽力而为"：万一这颗板子上不去，
 *     就留在默认时钟继续跑并如实报告，绝不在启动阶段 panic（那时 Core1 还没起来，
 *     panic 就等于又要人手按 BOOTSEL —— 正好是本固件要消灭的事）。
 *
 * 所有 printf 都是纯 ASCII：这台机器的控制台是 GBK，打中文或 ★/✓ 会 UnicodeEncodeError 崩掉。
 * ================================================================================================
 */

#include <stdio.h>
#include <string.h>
#include <ctype.h>
#include <stdint.h>

#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/bootrom.h"
#include "pico/stdio_usb.h"
#include "pico/stdio.h"
#include "pico/time.h"

#include "hardware/flash.h"
#include "hardware/sync.h"
#include "hardware/clocks.h"
#include "hardware/watchdog.h"
#include "hardware/irq.h"
#include "hardware/timer.h"
#include "hardware/pio.h"
#include "hardware/vreg.h"

#include "sampler.pio.h"   // pioasm 生成：in pins, 8（见 CMakeLists 的 pico_generate_pio_header）

// 板子头文件一般会给，但万一没有也别编不过
#ifndef PICO_FLASH_SIZE_BYTES
#define PICO_FLASH_SIZE_BYTES (2u * 1024u * 1024u)
#endif

#define MON_VERSION "1.1"

// ---------------------------------------------------------------- 地址窗口
#define XIP_BASE_ADDR  0x10000000u
#define ROM_BASE_ADDR  0x00000000u
#define ROM_END_ADDR   0x00004000u   // bootrom 32KB
#define SRAM_BASE_ADDR 0x20000000u
#define SRAM_END_ADDR  0x20042000u   // 256KB + SRAM4 4KB + SRAM5 4KB = 264KB

// 头 4KB 是 boot2 + 向量表：碰它就变砖
#define FLASH_GUARD_LEN 0x1000u

// ---------------------------------------------------------------- 上限 / 超时
#define MAX_READ_WORDS       64u                 // r 一次最多读 64 个字
#define MAX_WRITE_LEN        32768u              // F 一次最多写 32KB（RAM 缓冲区上限）
#define REQ_TIMEOUT_MS       200u                // 跟 Core0 通话的超时（Core0 正常时 <1ms 就回）
#define FIFO_PUSH_TIMEOUT_US 1000u               // 往 FIFO 塞消息的超时（正常永远不会满）
#define RX_IDLE_TIMEOUT_MS   10000u              // F 接收模式：10 秒没数据就中止
#define LINE_MAX             96u

// ---------------------------------------------------------------- 采样器参数
#define SAMP_PIN_BASE        0u                  // 采 GPIO0..7（应用侧映射固定，别改）
#define SAMP_WORDS           (16u * 1024u)       // 一包 = 16384 字 = 65536 个采样（4 采样/字）
#define SAMP_CLK_KHZ         252000u             // 沿用 probe_rp2040 的超频档（见文件头 [8]）
#define SAMP_DIV_MIN         1u
#define SAMP_DIV_MAX         64u
#define SAMP_DIV_RECOMMEND   11u                 // 推荐 11~12（与 probe_rp2040 的下位机约定一致）
#define SAMP_CAP_TIMEOUT_MS  500u                // Core0 抽 FIFO 的兜底（必须 < Core1 的等待上限，
                                                 // 这样 PIO 真死了 Core1 收到的是"采到 0 字"而不是"没响应"）
#define SAMP_ACK_TIMEOUT_MS  1500u               // Core1 等采样器请求完成的上限（> Core0 的 500ms 兜底）
#define SAMP_MEASURE_US      2000u               // m 命令默认观测窗 2ms

// ---------------------------------------------------------------- 核间 FIFO 协议
// Core1 -> Core0（请求）
#define MSG_PAUSE_REQ  0xC0DE0001u
#define MSG_RESUME_REQ 0xC0DE0002u
#define MSG_FLASH_REQ  0xC0DE0003u
#define MSG_HANG_REQ   0xC0DE0004u
// 采样器请求后都跟 1 个参数字（见下面的 MSG_SAMP_*_ARG）
#define MSG_SAMP_CFG     0xC0DE0011u   // + 分频（1..64）
#define MSG_SAMP_CAPTURE 0xC0DE0012u   // + 要抽多少字
#define MSG_SAMP_MEASURE 0xC0DE0013u   // + 观测窗（微秒）
#define MSG_SAMP_STATUS  0xC0DE0014u   // + 0
#define MSG_SAMP_GPIO    0xC0DE0015u   // + 0（用 SIO 直读 GPIO0..7）
// Core0 -> Core1（应答）
#define MSG_PAUSE_ACK  0xC0DE0101u
#define MSG_RESUME_ACK 0xC0DE0102u
#define MSG_FLASH_ACK  0xC0DE0103u
#define MSG_SAMP_ACK   0xC0DE0111u     // 采样器请求处理完毕，结果在 g_sres（共享 RAM）

// Core0 状态（共享变量，Core0 自己写，Core1 只读）
#define CORE0_RUNNING 0u
#define CORE0_PAUSED  1u
#define CORE0_PARKED  2u   // 在 RAM 里给 flash 操作"停车"

// ---------------------------------------------------------------- 共享状态
static volatile uint32_t g_core0_state = CORE0_RUNNING;
static volatile uint32_t g_core0_heartbeat;   // Core0 活着就一直在涨；不涨说明它挂了
static volatile uint32_t g_spin;              // 自旋计数器（volatile 防止循环被优化掉）
static volatile uint32_t g_flash_release;     // Core1 写 1 -> 放 Core0 出停车位

// 只有 1ms 唤醒闹钟真的建起来了，Core0 才敢用 __wfi()。
// 为什么这么小心：M0+ 的 WFI 必须有中断才会醒，万一 alarm pool 满了导致闹钟没建上，
// WFI 就成了"永远醒不来的挂死" —— 那正是我们要消灭的东西，不能自己制造一个。
static volatile bool g_wfi_ok;

static uint32_t g_chip_flash_size;            // 由 JEDEC ID 推出来的芯片容量（0 = 未知）
static uint32_t g_jedec_id;                   // 原始 24 位 ID

// 252 MHz 超频有没有成功。这不只是"性能"问题：上位机的分析链是按 252MHz/clkdiv 写死的
// （tools/tmds_sampled_decode.py 里 PROBE_CLK_HZ = 252.0e6），所以它是个【契约】，要如实报告。
static bool g_sys_clk_overclocked;

// F 的接收缓冲：多留 256 字节，因为编程长度要按 256 向上取整（不满的部分填 0xFF）
static uint8_t g_wbuf[MAX_WRITE_LEN + FLASH_PAGE_SIZE];

// 采样缓冲：一包 16384 字 = 64KB。Core0 写、Core1 读，靠 FIFO 的 ACK 做同步（RP2040 无 cache，
// 两个核看到的是同一片 SRAM）。放在这里而不是 malloc：避免堆，且地址固定便于排查。
static uint32_t g_samp_buf[SAMP_WORDS] __attribute__((aligned(4)));

// 采样器请求的结果（Core0 填完再回 ACK；Core1 收到 ACK 才读）。
// 为什么用共享结构体而不是把结果也塞进 FIFO：结果字段多（8~10 个），
// FIFO 只有 8 深，全塞进去容易和别的请求互相插队；结构体 + 单字 ACK 最不容易出错。
typedef struct {
    volatile uint32_t status;      // 0 = OK，非 0 = 该请求出错
    volatile uint32_t clkdiv;      // PIO 分频寄存器原值（16.8 定点）
    volatile uint32_t sm;          // PIO 状态机号（Core0 认领到的）
    volatile uint32_t stall;       // 当前 RXSTALL（丢样标志）0/1 —— 掩码在 Core0 侧算，见下
    volatile uint32_t stall_window;// ★ 上一次"窗口操作"（d 的采集 / m 的测量）期间丢过样没有。
                                   //   必须与 stall 分开：窗口一结束就没人抽 FIFO 了，FIFO 立刻会满、
                                   //   RXSTALL 立刻会再置位，所以"当前值"不能拿来当"窗口内的结论"。
    volatile uint32_t words;       // d: 实际抽到的字数；m: 窗口内抽走的字数
    volatile uint32_t window_us;   // m: 实际观测窗时长
    volatile uint32_t rxf;         // 完成时的 RX FIFO 电平
    volatile uint32_t fdebug;      // PIO FDEBUG 原值（含 RXSTALL 丢样标志）
    volatile uint32_t sm_en;       // SM 使能位
    volatile uint32_t nonzero;     // 缓冲里非零字的个数
    volatile uint32_t first_nz;    // 第一个非零字的下标（0xFFFFFFFF = 全是 0）
    volatile uint32_t gpio_mask;   // g: GPIO0..7 的电平
} samp_result_t;
static volatile samp_result_t g_sres;

// 采样器自身的状态（Core0 写的）
static PIO   g_probe_pio;
static uint  g_probe_sm;
static bool  g_samp_inited;

// 采样器的"上次已知值"缓存（Core1 侧持有）：Core0 一旦挂死，至少还能报出上次的配置，
// 而且让 S（监视器总状态）不必去问 Core0 —— 那会让 S 在最需要它的时候慢 200ms。
static uint32_t g_samp_cache_div;
static uint32_t g_samp_cache_ksa;      // 有效采样率 kSa/s（= sys_clk / clkdiv / 1000）
static uint32_t g_samp_cache_words;    // 上次 d 抽到的字数
static uint32_t g_samp_cache_stall;    // 上次 d 是否丢样
static bool     g_samp_cache_valid;

// 把 Core0 报回来的 clkdiv（16.8 定点）换成 x100 的整数，便于打印成 "12.00"
static uint32_t sres_div_x100(void) {
    uint32_t cd = g_sres.clkdiv;
    uint32_t i = cd >> 8, f = cd & 0xFFu;
    return i * 100u + (f * 100u) / 256u;
}

// 用"当前的 clkdiv"和 sys_clk 算有效采样率（kSa/s）。Core1 也能读 CLOCKS 寄存器，
// 所以这个值不依赖 Core0 是否响应。
static uint32_t samp_ksa_from(uint32_t div) {
    if (div == 0) div = 1;
    return (uint32_t)((uint64_t)clock_get_hz(clk_sys) / div / 1000u);
}

// 链接脚本给的映像范围（用于"不许写自己"的保护）
extern uint8_t __flash_binary_start[];
extern uint8_t __flash_binary_end[];

// =====================================================================================
//  小工具
// =====================================================================================

static void flush_out(void) {
    // 双保险：fflush 把 C 库缓冲推给 stdio 驱动，stdio_flush 再推给 USB
    fflush(stdout);
    stdio_flush();
}

// Core1 专用的"等一会儿"：纯自旋，绝不碰 alarm pool（见文件头 [2]）
static void bus_delay_us(uint32_t us) {
    uint64_t end = time_us_64() + (uint64_t)us;
    while ((int64_t)(end - time_us_64()) > 0) {
        g_spin++;
        tight_loop_contents();
    }
}

static void bus_delay_ms(uint32_t ms) {
    bus_delay_us(ms * 1000u);
}

static int hex_val(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// 解析十六进制：最多 8 位，允许 0x/0X 前缀
static bool parse_hex_u32(const char *s, uint32_t *out) {
    if (!s || !*s) return false;
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s += 2;
    uint32_t v = 0;
    int n = 0;
    while (*s) {
        int d = hex_val((unsigned char)*s);
        if (d < 0) return false;
        v = (v << 4) | (uint32_t)d;
        s++;
        if (++n > 8) return false;
    }
    if (n == 0) return false;
    *out = v;
    return true;
}

// 解析十进制
static bool parse_dec_u32(const char *s, uint32_t *out) {
    if (!s || !*s) return false;
    uint64_t v = 0;
    while (*s) {
        if (*s < '0' || *s > '9') return false;
        v = v * 10u + (uint32_t)(*s - '0');
        if (v > 0xFFFFFFFFull) return false;
        s++;
    }
    *out = (uint32_t)v;
    return true;
}

// 地址 / 写入值：**一律按十六进制**（这是调试器惯例，也跟任务里的 "r 20000000" 对齐）。
// 千万别在这里"聪明地"猜十进制：20000000 和 10100000 全是数字字符，猜错就打到别的地址上。
static bool parse_hex_arg(const char *s, uint32_t *out) {
    return parse_hex_u32(s, out);
}

// 长度 / 个数：十进制优先（写 256 比写 100 舒服），带 0x 前缀才算十六进制。
// 命令回显里会把解释结果按 hex/dec 都打出来，写错了看得出来。
static bool parse_count_arg(const char *s, uint32_t *out) {
    if (!s || !*s) return false;
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) return parse_hex_u32(s, out);
    if (parse_dec_u32(s, out)) return true;
    return parse_hex_u32(s, out);   // 含 a-f 的按十六进制兜底
}

// 按空白切 token（就地改 line），返回 token 数
static int tokenize(char *line, char *tok[], int max_tok) {
    int n = 0;
    char *p = line;
    while (*p && n < max_tok) {
        while (*p == ' ' || *p == '\t') p++;
        if (!*p) break;
        tok[n++] = p;
        while (*p && *p != ' ' && *p != '\t') p++;
        if (*p) *p++ = '\0';
    }
    return n;
}

// =====================================================================================
//  USB 服务换核（见文件头 [1]）
// =====================================================================================

// USB 服务涉及两条中断：
//   USBCTRL_IRQ : tinyusb 的 DCD 中断（硬件收发 / 枚举，必须在活着的核上）
//   某个 user IRQ: stdio_usb 的"低优先级 tud_task"中断（动态认领 26..31 之一）
// 把它俩从当前核的 NVIC 上摘掉 / 挂上，就完成了"串口归谁服务"的搬家。
static void usb_service_disable_here(void) {
    irq_set_enabled(USBCTRL_IRQ, false);
    for (uint n = NUM_IRQS - NUM_USER_IRQS; n < NUM_IRQS; n++) {
        if (user_irq_is_claimed(n)) irq_set_enabled(n, false);
    }
}

static void usb_service_enable_here(void) {
    irq_set_enabled(USBCTRL_IRQ, true);
    for (uint n = NUM_IRQS - NUM_USER_IRQS; n < NUM_IRQS; n++) {
        if (user_irq_is_claimed(n)) irq_set_enabled(n, true);
    }
}

// 主动踢一下那个"低优先级 tud_task"中断。
// 为什么需要：stdio_usb 发现 USBCTRL_IRQ 已经有共享处理者时走 one-shot 定时器模式，
// 而那个定时器挂在 Core0 的 alarm pool 上；换核以后它叫不动 Core1。
// 我们在 Core1 主循环里定期踢一脚，就保证 tud_task() 一定被周期性调用（等效 SDK 的 1ms
// 轮询模式），而且完全不依赖 Core0 是否活着 —— 这正是"灵魂"所在。
static void usb_kick(void) {
    for (uint n = NUM_IRQS - NUM_USER_IRQS; n < NUM_IRQS; n++) {
        if (user_irq_is_claimed(n)) irq_set_pending(n);
    }
}

// 限速版：给"紧循环等待"用。
// 为什么必须限速：irq_set_pending() 会让中断立刻被取下，如果在自旋循环里每次迭代都踢一脚，
// 主循环几乎全部时间都耗在 ISR 里（252MHz 下一秒钟能踢几百万次），等于把监视器自己拖慢。
static void usb_kick_throttled(void) {
    static uint64_t last;
    uint64_t now = time_us_64();
    if (now - last >= 1000u) {      // 1ms 一次，和 SDK 的默认轮询周期一致
        last = now;
        usb_kick();
    }
}

// =====================================================================================
//  Core0 侧：心跳 / 暂停 / 给 flash 让路 / 故意挂死
// =====================================================================================

// Core0 的 1ms 心跳闹钟：唯一目的是给 __wfi() 提供唤醒源。
// Cortex-M0+ 的 WFI 必须有中断才会醒；默认 alarm pool 是 Core0 的，所以这个 alarm 天然属于
// Core0，回调里什么都不做。
static bool core0_tick_cb(repeating_timer_t *t) {
    (void)t;
    return true;   // 继续重复
}

// ★ 必须在 RAM 里执行：调用期间 Core1 会关掉 XIP，Core0 只要还从 flash 取一条指令就会卡死。
//   中断也必须关：那个 1ms 闹钟要是把我们从自旋里叫醒，醒来第一件事就是取 flash 指令。
static void __no_inline_not_in_flash_func(core0_flash_park)(void) {
    uint32_t save = save_and_disable_interrupts();
    g_flash_release = 0;                 // 先清零再回 ACK：Core1 拿到 ACK 就可能立刻放行
    g_core0_state = CORE0_PARKED;
    multicore_fifo_push_blocking_inline(MSG_FLASH_ACK);
    while (!g_flash_release) {
        // 停车期间仍然回应重复的 FLASH_REQ（幂等）：万一是"上一次超时后才迟到的那条请求"，
        // 我们照样回 ACK，Core1 就不会白白又超时一次。这些操作全是 SIO 寄存器 + RAM，安全。
        if (multicore_fifo_rvalid()) {
            uint32_t m = multicore_fifo_pop_blocking_inline();
            if (m == MSG_FLASH_REQ) multicore_fifo_push_blocking_inline(MSG_FLASH_ACK);
        }
        g_spin++;                        // volatile 自旋：只碰 RAM，且循环不会被优化掉
        tight_loop_contents();
    }
    restore_interrupts(save);
    g_core0_state = CORE0_RUNNING;
}

// Core0 的暂停循环：收到 P 就钻进这里 WFI 等 C。
// 用 __wfi()（任务要求），靠 1ms 闹钟保证一定醒得来；对重复的 P 也回 ACK（幂等），
// 免得 Core1 的状态和 Core0 对不上。
static void core0_pause_loop(void) {
    g_core0_state = CORE0_PAUSED;
    multicore_fifo_push_blocking_inline(MSG_PAUSE_ACK);
    for (;;) {
        if (multicore_fifo_rvalid()) {
            uint32_t m = multicore_fifo_pop_blocking_inline();
            if (m == MSG_RESUME_REQ) {
                multicore_fifo_push_blocking_inline(MSG_RESUME_ACK);
                break;
            } else if (m == MSG_PAUSE_REQ) {
                multicore_fifo_push_blocking_inline(MSG_PAUSE_ACK);   // 已经是暂停态
            } else if (m == MSG_FLASH_REQ) {
                // 正常流程 Core1 会先 RESUME；真走到这里说明状态不同步，那也照办（进停车位）
                core0_flash_park();
            }
            // 其它消息忽略
        }
        if (g_wfi_ok) __wfi();   // 同上：闹钟没建好就退化成忙等，绝不睡死
    }
    g_core0_state = CORE0_RUNNING;
}

// 故意把 Core0 弄挂（自测用：验证监视器在 Core0 挂死时照样服务）
static void __attribute__((noreturn)) core0_deliberate_hang(void) {
    // 最恶劣形态：中断全关 + 死循环在 flash 里（用 SDK 的 save_and_disable_interrupts，
    // 不用 CMSIS 的 __disable_irq，后者在这个包含链里没有声明）
    (void)save_and_disable_interrupts();
    for (;;) {
        g_spin++;
        tight_loop_contents();
    }
}

// 采样器的实现在后面"Core0 侧：采样器"那一节（那里贴着三个实测坑的说明）。
// 这里先声明一下：core0_handle_sampler 要调它们，而 GCC 14 起不允许隐式声明。
static void     samp_sampler_init(void);
static void     samp_clear_stall(void);
static bool     samp_stalled(void);
static void     samp_drain_fifo(void);
static void     samp_fill_common(uint32_t status);
static void     samp_buffer_diag(void);
static uint32_t samp_capture(uint32_t want);
static void     samp_measure(uint32_t window_us);
static uint32_t samp_read_gpio_sio(void);

// 等一个参数字：带超时。为什么不直接 multicore_fifo_pop_blocking()：
// 万一 Core1 在中途死了/重启了，Core0 会永远卡在这里 —— 那也是一种"挂死"。
static bool core0_wait_arg(uint32_t *out, uint32_t timeout_us) {
    uint64_t t0 = time_us_64();
    while (!multicore_fifo_rvalid()) {
        if (time_us_64() - t0 > timeout_us) return false;
        tight_loop_contents();
    }
    *out = multicore_fifo_pop_blocking_inline();
    return true;
}

// 采样器请求的统一处理：收参数 -> 干活 -> 填 g_sres -> 回 MSG_SAMP_ACK
static void core0_handle_sampler(uint32_t msg) {
    uint32_t arg = 0;
    if (!core0_wait_arg(&arg, 100000u)) {   // 100ms 内收不到参数就当这条请求残缺，回错误
        g_sres.status = 99;
        multicore_fifo_push_blocking_inline(MSG_SAMP_ACK);
        return;
    }
    if (!g_samp_inited) {
        g_sres.status = 98;                 // 初始化失败（正常不会发生）
        multicore_fifo_push_blocking_inline(MSG_SAMP_ACK);
        return;
    }

    switch (msg) {
        case MSG_SAMP_CFG: {
            uint32_t div = arg;
            if (div < SAMP_DIV_MIN) div = SAMP_DIV_MIN;
            if (div > SAMP_DIV_MAX) div = SAMP_DIV_MAX;
            pio_sm_set_clkdiv(g_probe_pio, g_probe_sm, (float)div);
            samp_clear_stall();             // 换了速率，旧的丢样标志就不算数了
            samp_fill_common(0);
            break;
        }
        case MSG_SAMP_CAPTURE: {
            // ★ 采集前先把 FIFO 里已经躺着的字（最多 4 个）倒掉，再清丢样标志。
            //   为什么：SM 从上电起就在跑，FIFO 早就满了、RXSTALL 也早就置位过；
            //   不倒掉的话，(a) 缓冲开头混进采集前的陈旧字，(b) 丢样标志会把"采集前
            //   就发生过的那次停顿"算到本次头上，变成假警报。
            //   代价：时间轴开头少掉不到 4 个字（<16 个采样），而且是在【窗口之前】，
            //   窗口内部仍然连续 —— 比旧 DMA 方案内部断裂要好得多。
            samp_drain_fifo();
            samp_clear_stall();
            uint32_t got = samp_capture(arg);
            // ★ 必须【立刻】读丢样标志：下一行 samp_buffer_diag() 要扫 16384 个字（几毫秒），
            //   这期间没人抽 FIFO ⇒ FIFO 又满了 ⇒ RXSTALL 又置位。晚读一步就永远是"丢过样"的假警报。
            bool stall_in_window = samp_stalled();
            g_sres.words = got;
            samp_buffer_diag();
            samp_fill_common(0);
            g_sres.stall_window = stall_in_window ? 1u : 0u;   // 覆盖成"窗口内"的结论
            break;
        }
        case MSG_SAMP_MEASURE: {
            samp_measure(arg);      // 里面会在窗口结束的那一刻快照丢样标志
            samp_fill_common(0);
            break;
        }
        case MSG_SAMP_STATUS: {
            samp_buffer_diag();
            samp_fill_common(0);
            break;
        }
        case MSG_SAMP_GPIO: {
            g_sres.gpio_mask = samp_read_gpio_sio();
            samp_fill_common(0);
            break;
        }
        default:
            g_sres.status = 97;
            break;
    }
    multicore_fifo_push_blocking_inline(MSG_SAMP_ACK);
}

// Core0 的"无所谓的空闲工作"：数心跳 + 看 FIFO + WFI 省电
static void __attribute__((noreturn)) core0_idle_loop(void) {
    for (;;) {
        if (multicore_fifo_rvalid()) {
            uint32_t m = multicore_fifo_pop_blocking_inline();
            switch (m) {
                case MSG_PAUSE_REQ:  core0_pause_loop();      break;
                case MSG_FLASH_REQ:  core0_flash_park();      break;
                case MSG_HANG_REQ:   core0_deliberate_hang(); break;
                case MSG_RESUME_REQ: // 幂等：没暂停也被要求继续
                    multicore_fifo_push_blocking_inline(MSG_RESUME_ACK);
                    break;
                case MSG_SAMP_CFG:
                case MSG_SAMP_CAPTURE:
                case MSG_SAMP_MEASURE:
                case MSG_SAMP_STATUS:
                case MSG_SAMP_GPIO:
                    core0_handle_sampler(m);
                    break;
                default: break;      // 不认识的直接丢掉，绝不卡住
            }
        }
        g_core0_heartbeat++;
        if (g_wfi_ok) __wfi();   // 1ms 心跳闹钟保证醒得来（这也是为什么必须有那个闹钟）
    }
}

// =====================================================================================
//  Core1 -> Core0 的带超时通话（见文件头 [2]）
// =====================================================================================

// 丢干净残留消息：迟到的 ACK 绝不能污染下一条命令的判断
static void fifo_flush(void) {
    while (multicore_fifo_rvalid()) {
        (void)multicore_fifo_pop_blocking_inline();
    }
}

// 发一条请求并等指定 ACK；超时返回 false（绝不无限等）
static bool core0_request(uint32_t req, uint32_t ack, uint32_t timeout_ms) {
    fifo_flush();

    uint64_t t0 = time_us_64();
    while (!multicore_fifo_wready()) {
        if (time_us_64() - t0 > FIFO_PUSH_TIMEOUT_US) return false;
        tight_loop_contents();
    }
    multicore_fifo_push_blocking_inline(req);

    uint64_t deadline = t0 + (uint64_t)timeout_ms * 1000u;
    for (;;) {
        if (multicore_fifo_rvalid()) {
            uint32_t m = multicore_fifo_pop_blocking_inline();
            if (m == ack) return true;
            // 其它消息（理论上不会有）丢掉继续等
        }
        if ((int64_t)(deadline - time_us_64()) <= 0) {
            fifo_flush();     // 清掉迟到的 ACK，免得它被下一条命令当成应答
            return false;
        }
        usb_kick_throttled();   // 等 Core0 期间也让 USB 保持被服务（挂死时要等满超时，1ms 一踢）
        g_spin++;
        tight_loop_contents();
    }
}

// 发一条请求 + 一个参数字，等指定 ACK（采样器系列请求用）
static bool core0_request_arg(uint32_t req, uint32_t arg, uint32_t ack, uint32_t timeout_ms) {
    fifo_flush();
    uint64_t t0 = time_us_64();
    // 两个词一起塞（FIFO 8 深，够用）；仍然带超时，绝不硬等
    for (int i = 0; i < 2; i++) {
        uint32_t v = (i == 0) ? req : arg;
        while (!multicore_fifo_wready()) {
            if (time_us_64() - t0 > FIFO_PUSH_TIMEOUT_US) return false;
            tight_loop_contents();
        }
        multicore_fifo_push_blocking_inline(v);
    }
    uint64_t deadline = t0 + (uint64_t)timeout_ms * 1000u;
    for (;;) {
        if (multicore_fifo_rvalid()) {
            uint32_t m = multicore_fifo_pop_blocking_inline();
            if (m == ack) return true;
        }
        if ((int64_t)(deadline - time_us_64()) <= 0) {
            fifo_flush();
            return false;
        }
        usb_kick_throttled();   // 同上：1ms 一踢，别把主循环时间全耗在 ISR 里
        g_spin++;
        tight_loop_contents();
    }
}

// =====================================================================================
//  Flash 相关
// =====================================================================================

static uint32_t flash_limit(void) {
    uint32_t lim = PICO_FLASH_SIZE_BYTES;
    if (g_chip_flash_size && g_chip_flash_size < lim) lim = g_chip_flash_size;
    return lim;
}

// 申请的区间是否压到"正在跑的固件自己"
static bool overlaps_running_image(uint32_t off, uint32_t len) {
    uint32_t s = (uint32_t)(uintptr_t)__flash_binary_start;
    uint32_t e = (uint32_t)(uintptr_t)__flash_binary_end;
    if (e <= s) return false;
    uint32_t is = s - XIP_BASE_ADDR;
    uint32_t ie = e - XIP_BASE_ADDR;
    return (off < ie) && (off + len > is);
}

// 请 Core0 进 RAM 停车位；失败 = Core0 没响应 -> 调用方必须拒绝 flash 操作
static bool core0_park_begin(void) {
    // 暂停态下的 Core0 正 WFI 在 flash 里，不能直接开始 flash 操作，先叫醒它
    if (g_core0_state == CORE0_PAUSED) {
        if (!core0_request(MSG_RESUME_REQ, MSG_RESUME_ACK, REQ_TIMEOUT_MS)) return false;
    }
    if (!core0_request(MSG_FLASH_REQ, MSG_FLASH_ACK, REQ_TIMEOUT_MS)) {
        // 超时了：Core0 也许只是慢，稍后才进停车位。这里先把放行标志立起来，
        // 它一进去就会立刻出来（下一次停车会在函数开头重新清零），不会白白留在停车位里。
        g_flash_release = 1;
        return false;
    }
    return true;
}

static void core0_park_end(void) {
    g_flash_release = 1;    // Core0 自己出停车位；此刻 XIP 已恢复，它取 flash 指令是安全的
}

// 读 JEDEC ID（0x9F）。注意 flash_do_cmd 收发是同时移位的，第一个收到的字节是哑字节，
// 所以厂商/类型/容量分别在 rx[1]/rx[2]/rx[3]（SDK 的 flash_get_unique_id 也这么偏移）。
static bool read_jedec_id(uint8_t *mf, uint8_t *mt, uint8_t *cap) {
    if (!core0_park_begin()) return false;

    uint8_t tx[4] = {0x9F, 0x00, 0x00, 0x00};
    uint8_t rx[4] = {0, 0, 0, 0};
    uint32_t ints = save_and_disable_interrupts();   // 关中断：XIP 关着的时候任何 ISR 都会去取 flash
    flash_do_cmd(tx, rx, sizeof(tx));
    restore_interrupts(ints);

    core0_park_end();
    *mf = rx[1];
    *mt = rx[2];
    *cap = rx[3];
    return true;
}

// 从容量码推实际大小（W25Q 系列：0x15=2MB 0x16=4MB 0x17=8MB 0x18=16MB）
static uint32_t jedec_cap_to_size(uint8_t cap) {
    if (cap < 0x14 || cap > 0x18) return 0;    // 不敢乱猜就返回未知
    return 1u << cap;
}

// =====================================================================================
//  Core0 侧：采样器（PIO 抽 GPIO0..7）
//  ★ 三个实测踩出来的点全部照抄 probe_rp2040/probe.c，一个字都没改：
//     ① 必须 pio_gpio_init()  ② 必须用程序自己的默认配置  ③ 用 CPU 抽 FIFO，不用 DMA
//  下面每处的注释里都写了"为什么"，方便以后有人想动它时先看到代价。
// =====================================================================================

// FDEBUG 里 RXSTALL 是 [3:0]，每个 SM 一位（不是想当然的 0x100 << sm —— 查过 regs/pio.h）。
// 含义：SM 因为 RX FIFO 满了而停顿过 ⇒ 【采样丢过】。这是我们判断采样是否连续的唯一硬证据，
// 比 probe.c 时代的"wraps"有意义得多（CPU 抽 FIFO 方案里根本不存在 DMA 回卷）。
#define SAMP_RXSTALL_MASK (1u << (PIO_FDEBUG_RXSTALL_LSB + g_probe_sm))

static void samp_clear_stall(void) {
    g_probe_pio->fdebug = SAMP_RXSTALL_MASK;     // W1C：写 1 清标志
}

static bool samp_stalled(void) {
    return (g_probe_pio->fdebug & SAMP_RXSTALL_MASK) != 0;
}

// 倒掉 FIFO 里的存货（读 RXF 即弹出）。用于采集/测量前把状态拉到"干净边界"。
static void samp_drain_fifo(void) {
    while (!pio_sm_is_rx_fifo_empty(g_probe_pio, g_probe_sm)) {
        (void)pio_sm_get(g_probe_pio, g_probe_sm);
    }
}

static void samp_fill_common(uint32_t status) {
    g_sres.status   = status;
    g_sres.clkdiv   = g_samp_inited ? g_probe_pio->sm[g_probe_sm].clkdiv : 0;
    g_sres.sm       = g_samp_inited ? g_probe_sm : 0;
    g_sres.stall    = g_samp_inited ? (samp_stalled() ? 1u : 0u) : 0;
    g_sres.rxf      = g_samp_inited ? pio_sm_get_rx_fifo_level(g_probe_pio, g_probe_sm) : 0;
    g_sres.fdebug   = g_samp_inited ? g_probe_pio->fdebug : 0;
    g_sres.sm_en    = g_samp_inited ? ((g_probe_pio->ctrl >> (g_probe_sm * 4u)) & 1u) : 0;
}

// 统计缓冲里有多少非零字、第一个非零在哪 —— 用来一眼看出"PIO 是不是采到全 0"
// （全 0 就是 PAD 输入通路/引脚功能没配对，这是探针历史上最常见的一种坏法）
static void samp_buffer_diag(void) {
    uint32_t nz = 0, first = 0xFFFFFFFFu;
    for (uint32_t i = 0; i < SAMP_WORDS; i++) {
        if (g_samp_buf[i]) {
            if (first == 0xFFFFFFFFu) first = i;
            nz++;
        }
    }
    g_sres.nonzero = nz;
    g_sres.first_nz = first;
}

static void samp_sampler_init(void) {
    if (g_samp_inited) return;

    // ① 【实测踩过】必须 pio_gpio_init()：gpio_init 只把 FUNCSEL 设成 SIO，
    //    而 PIO 的输入走的是 PAD 输入通路（受 FUNCSEL 门控 + 要清 ISO 隔离位）
    //    ⇒ 不调它，PIO 永远采到 0。
    for (uint i = 0; i < 8; i++) {
        uint p = SAMP_PIN_BASE + i;
        gpio_init(p);
        gpio_set_dir(p, GPIO_IN);
        pio_gpio_init(pio0, p);
    }

    g_probe_pio = pio0;
    g_probe_sm = (uint)pio_claim_unused_sm(g_probe_pio, true);
    uint offset = pio_add_program(g_probe_pio, &sampler_program);

    // ② 【实测踩过】必须用 sampler_program_get_default_config(offset)：
    //    pio_get_default_sm_config() 给的 wrap 是整片 (0,31)，而 pio_add_program 把
    //    1 条指令的程序装在偏移 31 ⇒ wrap 不对，SM 就一直在地址 0 的空指令里打转，
    //    RX FIFO 永远是空的。
    pio_sm_config c = sampler_program_get_default_config(offset);
    sm_config_set_in_pins(&c, SAMP_PIN_BASE);              // RP2040 的 in 窗口固定 0..31
    sm_config_set_in_shift(&c, false /* 左移：先采到的在高位 */, true /* autopush */, 32);
    sm_config_set_clkdiv(&c, 1.0f);
    pio_sm_init(g_probe_pio, g_probe_sm, offset, &c);
    pio_sm_set_enabled(g_probe_pio, g_probe_sm, true);
    samp_clear_stall();                                    // 清掉启动瞬间的陈旧标志
    g_samp_inited = true;
}

// ③ 【实测踩过】用 CPU 抽 FIFO，不用 DMA：
//    probe_rp2040 实测本板 DMA 从 PIO FIFO 只有 5~7 Mwords/s（病态低），
//    FIFO 只有 4 深 ⇒ 一溢出 SM 就停顿 ⇒ 丢样、时间轴断裂。
//    CPU 紧循环抽 FIFO 已被证明连续。
//    这里的改进（不改上面那条结论，只是把兜底做硬）：超时改成【时间基准】而不是循环计数，
//    这样换主频/换分频都不用重算；并且宁可少采也绝不挂死（本固件的红线）。
static uint32_t samp_capture(uint32_t want) {
    if (want > SAMP_WORDS) want = SAMP_WORDS;
    uint64_t t0 = time_us_64();
    uint32_t got = 0;
    while (got < want) {
        if (!pio_sm_is_rx_fifo_empty(g_probe_pio, g_probe_sm)) {
            g_samp_buf[got++] = pio_sm_get(g_probe_pio, g_probe_sm);
        } else if ((time_us_64() - t0) > (uint64_t)SAMP_CAP_TIMEOUT_MS * 1000u) {
            break;      // PIO 没在产数据：报实际抽到的字数，让上位机自己判断
        }
    }
    return got;
}

// m：在给定窗口内尽量快地抽 FIFO 并丢掉，量出"这一侧的搬运能力"，
//    同时在窗口前后看 RXSTALL（FIFO 满过没有）—— 这是"该把 clkdiv 设多大"的判据。
static void samp_measure(uint32_t window_us) {
    if (window_us < 100u)   window_us = 100u;
    if (window_us > 200000u) window_us = 200000u;

    samp_drain_fifo();                                            // 倒掉存货
    samp_clear_stall();

    uint64_t t0 = time_us_64();
    uint32_t moved = 0;
    for (;;) {
        if (!pio_sm_is_rx_fifo_empty(g_probe_pio, g_probe_sm)) {
            (void)pio_sm_get(g_probe_pio, g_probe_sm);
            moved++;
            // ★ 每 1024 字查一次表：如果 PIO 产得比 CPU 抽得快，FIFO 会一直是满的，
            //   若只在"FIFO 空"分支里查时间，这个循环就永远出不来 ⇒ 挂死。
            if ((moved & 0x3FFu) == 0u && (time_us_64() - t0) >= window_us) break;
        } else if ((time_us_64() - t0) >= window_us) {
            break;
        }
    }
    g_sres.words     = moved;
    g_sres.window_us = (uint32_t)(time_us_64() - t0);
    // ★ 窗口一结束立刻快照：晚一步 FIFO 就会重新变满，标志就变成假警报（见结构体里的注释）
    g_sres.stall_window = samp_stalled() ? 1u : 0u;
}

// g：用 SIO 直读 GPIO0..7（gpio_get 读的就是 sio_hw->gpio_in 的 pad 输入），
//    用来和 PIO 交叉验证"是线/电平的问题，还是 PIO 通路的问题"。
//    注意：这里【不动 FUNCSEL】—— probe.c 的 g 命令就是这么用的（说明 FUNCSEL 选 PIO 时
//    SIO 仍能读到 pad 电平），因此不会打扰正在跑的采样。
static uint32_t samp_read_gpio_sio(void) {
    uint32_t m = 0;
    for (uint i = 0; i < 8; i++) {
        if (gpio_get(SAMP_PIN_BASE + i)) m |= (1u << i);
    }
    return m;
}

// =====================================================================================
//  F 命令的接收端
// =====================================================================================

// 原始字节模式：READY 之后直接发 len 个字节
static int recv_raw(uint8_t *buf, uint32_t len) {
    uint32_t got = 0;
    uint64_t last = time_us_64();
    while (got < len) {
        int c = getchar_timeout_us(1000);
        if (c == PICO_ERROR_TIMEOUT) {
            usb_kick();     // 空闲时踢一下，保证 tud_task 还在跑
            if (time_us_64() - last > (uint64_t)RX_IDLE_TIMEOUT_MS * 1000u) return -1;
            continue;
        }
        last = time_us_64();
        buf[got++] = (uint8_t)c;
        if ((got & 0x3FFu) == 0) {         // 每 1KB 打一个点，让人看得出在动
            printf(".");
            flush_out();
            usb_kick();
        }
    }
    return (int)got;
}

// 十六进制行模式：一行一串十六进制；空白/逗号/冒号/减号忽略；# 后是注释；单独一行 Z 中止
static int recv_hex(uint8_t *buf, uint32_t len) {
    uint32_t got = 0;
    uint64_t last = time_us_64();
    int hi = -1;              // 待配对的高 4 位
    bool line_start = true;   // 本行还没出现十六进制字符
    bool comment = false;

    while (got < len) {
        int c = getchar_timeout_us(1000);
        if (c == PICO_ERROR_TIMEOUT) {
            usb_kick();
            if (time_us_64() - last > (uint64_t)RX_IDLE_TIMEOUT_MS * 1000u) return -1;
            continue;
        }
        last = time_us_64();

        if (comment) {
            if (c == '\n') { comment = false; line_start = true; }
            continue;
        }
        if (c == '#') { comment = true; continue; }
        if (c == '\r') continue;
        if (c == '\n') {
            if (hi >= 0) return -2;        // 半字节就换行 = 格式错
            line_start = true;
            continue;
        }
        if (line_start && (c == 'Z' || c == 'z')) return -3;   // 主动中止
        if (c == ' ' || c == '\t' || c == ',' || c == ':' || c == '-') continue;

        int d = hex_val(c);
        if (d < 0) return -4;              // 出现非十六进制字符 = 格式错

        line_start = false;
        if (hi < 0) {
            hi = d;
        } else {
            buf[got++] = (uint8_t)((hi << 4) | d);
            hi = -1;
            if ((got & 0x3FFu) == 0) {
                printf(".");
                flush_out();
                usb_kick();
            }
        }
    }
    return (int)got;
}

// =====================================================================================
//  命令实现
// =====================================================================================

static void print_help(void) {
    printf("\nCommands. addr/val are ALWAYS hex (0x optional). counts are decimal (0x.. = hex).\n");
    printf("  ?                 this help\n");
    printf("  S                 status: sys_clk / Core0 state / flash size + JEDEC id\n");
    printf("  r <addr> [n]      read n 32-bit words (n<=%lu dec), e.g. r 20000000 / r 10000000 8\n",
           (unsigned long)MAX_READ_WORDS);
    printf("  w <addr> <val>    write one 32-bit word (SRAM only), e.g. w 20000000 CAFEBABE\n");
    printf("  P                 pause Core0 (WFI loop). Core1 keeps serving USB\n");
    printf("  C                 continue (resume) Core0\n");
    printf("  R                 reboot the chip (watchdog). No args.\n");
    printf("  B                 reboot into BOOTSEL (USB mass storage) -- always available\n");
    printf("  E <addr>          erase one 4KB flash sector (addr must be 4KB aligned)\n");
    printf("  F <addr> <len> [H] erase + program len bytes, then read back and verify\n");
    printf("                      raw mode: send exactly len bytes after READY\n");
    printf("                      H mode  : send hex text (whitespace ignored, # = comment,\n");
    printf("                                a line with just Z aborts)\n");
    printf("  X                 hang Core0 on purpose (self test); recover with R or B\n");
    printf("\nSampler (runs on Core0, PIO0 SM, GPIO0..7 = D2P D2N D1P D1N D0P D0N CLKP CLKN):\n");
    printf("  c<div>            set PIO clkdiv 1..64 (decimal). fs = sys_clk / clkdiv.\n");
    printf("                    e.g. c12 => 21 MSa/s at 252 MHz. Start with 11 or 12.\n");
    printf("  m                 measure the CPU-side drain rate + FIFO/FDEBUG status\n");
    printf("  d                 capture 1 packet (%lu words = %lu samples) and hex-dump it\n",
           (unsigned long)SAMP_WORDS, (unsigned long)(SAMP_WORDS * 4u));
    printf("                    output: BEGIN <words> <stall> / one 8-digit hex word per\n");
    printf("                    line / END. (<stall> is 1 if the PIO RX FIFO went full,\n");
    printf("                    i.e. samples were lost -- same slot the old 'wraps' was in)\n");
    printf("  s                 sampler status (live from Core0; cached values if it is hung)\n");
    printf("  g                 read GPIO0..7 through SIO 5x (cross-check against the PIO)\n");
    printf("\nNOTE: lowercase r = read, uppercase R = reboot (that is what the task asks for).\n");
    printf("Commands are line based: end them with CR (or LF). A bare character is only\n");
    printf("echoed and does nothing until the line is terminated.\n");
    printf("Safe windows: rom 00000000-00003FFF, xip 10000000-1FFFFFFF, sram 20000000-20041FFF\n");
    printf("(w only in sram). Other addresses are refused: a bad read would be a HardFault,\n");
    printf("i.e. this monitor killing itself. Erase/write of the first 4KB of flash, or of\n");
    printf("the running image, is refused too.\n");
}

static const char *core0_state_str(void) {
    switch (g_core0_state) {
        case CORE0_PAUSED: return "PAUSED (WFI loop)";
        case CORE0_PARKED: return "PARKED (in RAM for a flash op)";
        default:           return "running";
    }
}

static void cmd_status(void) {
    printf("monitor   : core1_monitor %s, this is Core%u\n", MON_VERSION,
           (unsigned)get_core_num());
    printf("sys_clk   : %lu Hz\n", (unsigned long)clock_get_hz(clk_sys));
    printf("peri_clk  : %lu Hz\n", (unsigned long)clock_get_hz(clk_peri));
    printf("overclock : %s (target %lu kHz)\n",
           g_sys_clk_overclocked ? "OK" : "FAILED -> running at the default clock",
           (unsigned long)SAMP_CLK_KHZ);
    if (!g_sys_clk_overclocked) {
        printf("            NOTE: the sampler contract is fs = 252MHz/clkdiv; with another\n");
        printf("            sys_clk you must pass the real clock to the decode tools.\n");
    }

    if (!g_chip_flash_size) {
        uint8_t mf = 0, mt = 0, cap = 0;
        if (read_jedec_id(&mf, &mt, &cap)) {
            g_jedec_id = ((uint32_t)mf << 16) | ((uint32_t)mt << 8) | cap;
            g_chip_flash_size = jedec_cap_to_size(cap);
        }
    }
    printf("flash     : build limit %lu KB, JEDEC id %06lx",
           (unsigned long)(PICO_FLASH_SIZE_BYTES / 1024u), (unsigned long)(g_jedec_id & 0xFFFFFFu));
    if (g_chip_flash_size) {
        printf(", chip %lu KB\n", (unsigned long)(g_chip_flash_size / 1024u));
    } else {
        printf(", chip size unknown (id read may have failed)\n");
    }
    printf("usable    : up to %08lx\n",
           (unsigned long)(XIP_BASE_ADDR + flash_limit()));
    printf("image     : %08lx..%08lx (writing here is refused on purpose)\n",
           (unsigned long)((uint32_t)(uintptr_t)__flash_binary_start),
           (unsigned long)((uint32_t)(uintptr_t)__flash_binary_end));

    // 判断 Core0 死活：心跳采两次。必须用 Core1 自己的自旋延时，不能用 sleep_ms（见文件头 [2]）
    uint32_t st = g_core0_state;
    uint32_t hb1 = g_core0_heartbeat;
    bus_delay_ms(20);
    uint32_t hb2 = g_core0_heartbeat;

    printf("core0     : %s, heartbeat %lu -> %lu\n",
           core0_state_str(), (unsigned long)hb1, (unsigned long)hb2);
    if (st == CORE0_RUNNING) {
        if (hb1 == hb2) printf("            WARN: heartbeat frozen -> Core0 looks hung\n");
        else            printf("            ok: alive (~%lu ticks/20ms)\n", (unsigned long)(hb2 - hb1));
    }
    printf("core-fifo : status %08lx (rx not empty = %u)\n",
           (unsigned long)multicore_fifo_get_status(), (unsigned)multicore_fifo_rvalid());
    // 采样器只报【缓存值】：S 是"监视器状态"，不该因为 Core0 挂了而变慢 200ms。
    // 要看实时采样器状态请用 s（那条会去问 Core0）。
    if (g_samp_cache_valid) {
        printf("sampler   : clkdiv %lu (last known) -> %lu kSa/s, last capture %lu words, stall=%lu\n",
               (unsigned long)g_samp_cache_div, (unsigned long)g_samp_cache_ksa,
               (unsigned long)g_samp_cache_words, (unsigned long)g_samp_cache_stall);
    } else {
        printf("sampler   : not used yet this session (try: s / c12 / d)\n");
    }
}

// =====================================================================================
//  采样器命令（Core1 侧：只下命令 + 把结果/数据吐出去）
// =====================================================================================

static void samp_cache_update(void) {
    uint32_t div = (sres_div_x100() + 50u) / 100u;
    if (div == 0) div = 1;
    g_samp_cache_div = div;
    g_samp_cache_ksa = samp_ksa_from(div);
    g_samp_cache_valid = true;
}

// 采样请求的前置检查：Core0 被 P 暂停时，它不会去处理 FIFO（那是暂停的定义），
// 不先说清楚的话用户要白等一次超时，还以为固件坏了。
static bool samp_precheck(const char *what) {
    if (g_core0_state == CORE0_PAUSED) {
        printf("ERR: Core0 is PAUSED -- %s needs Core0. Send C to resume it first.\n", what);
        return false;
    }
    return true;
}

static bool samp_req(uint32_t msg, uint32_t arg, uint32_t timeout_ms) {
    if (!core0_request_arg(msg, arg, MSG_SAMP_ACK, timeout_ms)) return false;
    return g_sres.status == 0;
}

// c<div>：设 PIO 分频（1~64，十进制；1~2 位）
static void cmd_samp_cfg(uint32_t div) {
    if (!samp_precheck("c<div>")) return;
    if (div < SAMP_DIV_MIN || div > SAMP_DIV_MAX) {
        printf("ERR: clkdiv must be %lu..%lu (recommended %lu)\n",
               (unsigned long)SAMP_DIV_MIN, (unsigned long)SAMP_DIV_MAX,
               (unsigned long)SAMP_DIV_RECOMMEND);
        return;
    }
    if (!samp_req(MSG_SAMP_CFG, div, REQ_TIMEOUT_MS)) {
        printf("ERR: Core0 no response (hung?) -- sampler is dead, nothing changed.\n");
        return;
    }
    samp_cache_update();
    printf("OK clkdiv=%lu.%02lu  =>  %lu kSa/s  (words/s = %lu)\n",
           (unsigned long)(sres_div_x100() / 100u), (unsigned long)(sres_div_x100() % 100u),
           (unsigned long)g_samp_cache_ksa,
           (unsigned long)((uint64_t)clock_get_hz(clk_sys) / div / 4u));
    printf("   sample rate = sys_clk(%lu Hz) / clkdiv(%lu); 4 samples per 32-bit word\n",
           (unsigned long)clock_get_hz(clk_sys), (unsigned long)div);
}

// m：量"这一侧的搬运能力" + FIFO/FDEBUG 状态
static void cmd_samp_measure(void) {
    if (!samp_precheck("m")) return;
    if (!samp_req(MSG_SAMP_MEASURE, SAMP_MEASURE_US, SAMP_ACK_TIMEOUT_MS)) {
        printf("ERR: Core0 no response (hung?) -- sampler is dead.\n");
        return;
    }
    samp_cache_update();
    uint32_t moved = g_sres.words, win = g_sres.window_us;
    if (win == 0) win = 1;
    // 全整数运算：pico 的 printf 走 %f 不稳，而且整数更好读
    uint32_t words_per_s = (uint32_t)((uint64_t)moved * 1000000u / win);
    uint32_t div = g_samp_cache_div;
    uint32_t expect = (uint32_t)((uint64_t)clock_get_hz(clk_sys) / div / 4u);

    printf("MEAS moved=%lu words in %lu us => %lu words/s (expect %lu at clkdiv=%lu)\n",
           (unsigned long)moved, (unsigned long)win, (unsigned long)words_per_s,
           (unsigned long)expect, (unsigned long)div);
    printf("     rxf=%lu sm_en=%lu fdebug=%08lx\n",
           (unsigned long)g_sres.rxf, (unsigned long)g_sres.sm_en,
           (unsigned long)g_sres.fdebug);
    printf("     => %s\n",
           (words_per_s * 2u < expect) ? "drain is the bottleneck (<50% of expected)"
                                       : "drain rate looks fine (bottleneck is not here)");
    if (g_sres.stall_window) {
        printf("     WARN: PIO RXSTALL during the window -> the RX FIFO went full, samples WERE lost.\n");
        printf("           raise clkdiv (try c11 / c12) until this warning stops.\n");
    } else {
        printf("     ok: no RXSTALL during the window -> no sample loss at this rate.\n");
    }
}

// d：采一包（16384 字）+ 十六进制 dump（格式与 probe_rp2040 的 d 一致）
static void cmd_samp_capture(void) {
    if (!samp_precheck("d")) return;
    printf("d: capturing %lu words (%lu samples) ...\n",
           (unsigned long)SAMP_WORDS, (unsigned long)(SAMP_WORDS * 4u));
    flush_out();

    uint64_t t0 = time_us_64();
    bool ok = core0_request_arg(MSG_SAMP_CAPTURE, SAMP_WORDS, MSG_SAMP_ACK, SAMP_ACK_TIMEOUT_MS);
    uint64_t dt = time_us_64() - t0;
    if (!ok) {
        printf("ERR: Core0 no response (hung?) -- sampler is dead, no data.\n");
        return;
    }
    uint32_t got = g_sres.words;
    uint32_t stall = g_sres.stall_window;      // 窗口内的结论，不是"当前值"（见结构体注释）
    samp_cache_update();
    g_samp_cache_words = got;
    g_samp_cache_stall = stall;

    if (got == 0) {
        printf("ERR: captured 0 words -- the RX FIFO stayed empty for %lu ms.\n",
               (unsigned long)SAMP_CAP_TIMEOUT_MS);
        printf("     checks: pio_gpio_init() called? sampler_program_get_default_config() used?\n");
        printf("     use 'g' to see whether the pads themselves carry any level.\n");
        return;
    }

    printf("captured %lu words (%lu samples) in %lu us, sys_clk %lu Hz, clkdiv %lu\n",
           (unsigned long)got, (unsigned long)(got * 4u), (unsigned long)dt,
           (unsigned long)clock_get_hz(clk_sys), (unsigned long)g_samp_cache_div);
    printf("fifo: rxf=%lu sm_en=%lu fdebug=%08lx rxstall=%lu%s\n",
           (unsigned long)g_sres.rxf, (unsigned long)g_sres.sm_en,
           (unsigned long)g_sres.fdebug, (unsigned long)stall,
           stall ? "  <-- SAMPLES LOST, raise clkdiv" : "");
    printf("buffer: nonzero=%lu/%lu first_nonzero=%ld\n",
           (unsigned long)g_sres.nonzero, (unsigned long)SAMP_WORDS,
           (g_sres.first_nz == 0xFFFFFFFFu) ? -1L : (long)g_sres.first_nz);
    flush_out();

    // --- 与 probe_rp2040 的 d 相同的三段格式：BEGIN <字数> <wraps> / 每行 8 位十六进制 / END ---
    // 第二字段沿用 wraps 的位置，但"CPU 抽 FIFO"方案里没有 DMA 回卷可言，
    // 所以它的含义改成【本次采集期间 PIO 是否因 RX FIFO 满而停顿过（丢样）】：
    //   0 = 没丢样（时间轴连续），1 = 丢过（请加大 clkdiv 重采）。
    // 已核对：tools/tmds_decode.py 与 tmds_sampled_decode.py 只把它读出来打印，不参与计算。
    printf("BEGIN %lu %lu\n", (unsigned long)got, (unsigned long)stall);
    for (uint32_t i = 0; i < got; i++) {
        printf("%08lx\n", (unsigned long)g_samp_buf[i]);
        if ((i & 0x1FFu) == 0x1FFu) {      // 每 512 行 flush 一次：既不碎，也不会攒太多
            flush_out();
            usb_kick();
        }
    }
    printf("END\n");
    flush_out();
}

// s：采样器实时状态（会去问 Core0；Core0 挂了就如实报无响应 + 缓存值）
static void cmd_samp_status(void) {
    if (!samp_precheck("s")) return;
    if (!samp_req(MSG_SAMP_STATUS, 0, REQ_TIMEOUT_MS)) {
        printf("ERR: Core0 no response (hung?) -- sampler is dead.\n");
        if (g_samp_cache_valid) {
            printf("     last known: clkdiv=%lu -> %lu kSa/s, last capture %lu words, stall=%lu\n",
                   (unsigned long)g_samp_cache_div, (unsigned long)g_samp_cache_ksa,
                   (unsigned long)g_samp_cache_words, (unsigned long)g_samp_cache_stall);
        }
        return;
    }
    samp_cache_update();
    printf("sampler   : PIO0 SM%u, in-pins %lu..%lu  (GPIO0=D2P 1=D2N 2=D1P 3=D1N "
           "4=D0P 5=D0N 6=CLKP 7=CLKN)\n",
           (unsigned)g_sres.sm, (unsigned long)SAMP_PIN_BASE, (unsigned long)(SAMP_PIN_BASE + 7));
    printf("clk       : sys_clk %lu Hz, clkdiv %lu.%02lu -> %lu kSa/s (4 samples/word)\n",
           (unsigned long)clock_get_hz(clk_sys),
           (unsigned long)(sres_div_x100() / 100u), (unsigned long)(sres_div_x100() % 100u),
           (unsigned long)g_samp_cache_ksa);
    printf("sm        : enabled=%lu  rx fifo level=%lu  fdebug=%08lx\n",
           (unsigned long)g_sres.sm_en, (unsigned long)g_sres.rxf,
           (unsigned long)g_sres.fdebug);
    printf("rxstall   : now=%lu  during last window=%lu   (1 = samples may have been lost;\n",
           (unsigned long)g_sres.stall, (unsigned long)g_sres.stall_window);
    printf("            'now' is usually 1 because nobody drains the FIFO between commands)\n");
    printf("buffer    : nonzero=%lu/%lu first_nonzero=%ld (all-zero = PAD input path problem)\n",
           (unsigned long)g_sres.nonzero, (unsigned long)SAMP_WORDS,
           (g_sres.first_nz == 0xFFFFFFFFu) ? -1L : (long)g_sres.first_nz);
    if (g_samp_cache_valid) {
        printf("last cap  : %lu words, stall=%lu\n",
               (unsigned long)g_samp_cache_words, (unsigned long)g_samp_cache_stall);
    }
}

// g：用 SIO 直读 GPIO0..7 五次，和 PIO 交叉验证
static void cmd_samp_gpio(void) {
    if (!samp_precheck("g")) return;
    printf("GPIO   : 7 6 5 4 3 2 1 0\n");
    uint32_t prev = 0xFFFFFFFFu, changes = 0, n = 0;
    for (int i = 0; i < 5; i++) {
        if (!samp_req(MSG_SAMP_GPIO, 0, REQ_TIMEOUT_MS)) {
            printf("ERR: Core0 no response (hung?) -- sampler is dead.\n");
            return;
        }
        uint32_t m = g_sres.gpio_mask & 0xFFu;
        printf("read%-2d : %d %d %d %d %d %d %d %d   0x%02lx\n", i,
               (int)((m >> 7) & 1), (int)((m >> 6) & 1), (int)((m >> 5) & 1), (int)((m >> 4) & 1),
               (int)((m >> 3) & 1), (int)((m >> 2) & 1), (int)((m >> 1) & 1), (int)(m & 1),
               (unsigned long)m);
        flush_out();
        if (prev != 0xFFFFFFFFu && m != prev) changes++;
        prev = m;
        n++;
        if (i != 4) bus_delay_ms(100);      // Core1 自己的自旋延时，不碰 alarm pool
    }
    printf("changes in %lu reads: %lu %s\n", (unsigned long)n, (unsigned long)changes,
           changes ? "(levels are moving -> a live signal is present)" : "(static levels)");
}

// 读/写用的窗口判断：end 是开区间上界。
// 必须先挡住 a + 4 的 32 位回绕：r FFFFFFFC 1 这种地址如果直接加 4 会绕回 0，
// 判断就"通过"了，然后真的去读 0xFFFFFFFC —— 那是 BusFault，等于监视器自杀。
static bool win_contains_word(uint32_t a, uint32_t base, uint32_t end) {
    if (a < base) return false;
    if (a > 0xFFFFFFFCu) return false;
    return (a + 4u) <= end;
}

static void cmd_read(uint32_t addr, uint32_t n) {
    if (n == 0) n = 1;
    if (n > MAX_READ_WORDS) {
        printf("ERR: n too big (max %lu)\n", (unsigned long)MAX_READ_WORDS);
        return;
    }
    uint32_t limit = flash_limit();
    for (uint32_t i = 0; i < n; i++) {
        uint32_t a = addr + i * 4u;
        bool ok = win_contains_word(a, ROM_BASE_ADDR, ROM_END_ADDR)
               || win_contains_word(a, XIP_BASE_ADDR, XIP_BASE_ADDR + limit)
               || win_contains_word(a, SRAM_BASE_ADDR, SRAM_END_ADDR);
        if (!ok) {
            printf("ERR: %08lx outside readable windows (refused: would HardFault)\n",
                   (unsigned long)a);
            return;
        }
        volatile uint32_t *p = (volatile uint32_t *)a;
        uint32_t v = *p;
        if ((i & 3u) == 0) printf("%08lx:", (unsigned long)a);
        printf(" %08lx", (unsigned long)v);
        if ((i & 3u) == 3u || i == n - 1u) printf("\n");
    }
}

static void cmd_write(uint32_t addr, uint32_t val) {
    if ((addr & 3u) != 0) {
        printf("ERR: addr must be 4-byte aligned\n");
        return;
    }
    if (!win_contains_word(addr, SRAM_BASE_ADDR, SRAM_END_ADDR)) {
        printf("ERR: w only accepts SRAM (20000000-20041FFF); flash -> F/E, peripherals refused\n");
        return;
    }
    volatile uint32_t *p = (volatile uint32_t *)addr;
    uint32_t before = *p;
    *p = val;
    uint32_t after = *p;
    printf("w %08lx: %08lx -> %08lx (readback %08lx) %s\n",
           (unsigned long)addr, (unsigned long)before, (unsigned long)val,
           (unsigned long)after, after == val ? "OK" : "MISMATCH");
}

static void cmd_pause(void) {
    if (g_core0_state == CORE0_PAUSED) {
        printf("Core0 is already paused\n");
        return;
    }
    if (core0_request(MSG_PAUSE_REQ, MSG_PAUSE_ACK, REQ_TIMEOUT_MS)) {
        printf("Core0 paused (state=%s). Core1 is still serving this port. C = resume\n",
               core0_state_str());
    } else {
        printf("ERR: Core0 no response (hung?) -- nothing was paused, and this monitor is fine.\n");
        printf("     P cannot stop a core that is already stuck. R / B still work.\n");
    }
}

static void cmd_continue(void) {
    if (core0_request(MSG_RESUME_REQ, MSG_RESUME_ACK, REQ_TIMEOUT_MS)) {
        printf("Core0 resumed (state=%s)\n", core0_state_str());
    } else {
        printf("ERR: Core0 no response (hung?) -- cannot resume it.\n");
    }
}

static void cmd_reboot(void) {
    printf("rebooting now (watchdog_reboot). This port will re-enumerate.\n");
    flush_out();
    bus_delay_ms(50);
    watchdog_reboot(0, 0, 0);
    for (;;) tight_loop_contents();
}

static void cmd_bootsel(void) {
    printf("rebooting into BOOTSEL (RP2 mass storage). Close this port.\n");
    flush_out();
    bus_delay_ms(50);            // 让上面那行真的走出 USB
    reset_usb_boot(0, 0);        // 不返回
    for (;;) tight_loop_contents();
}

static void cmd_erase(uint32_t addr) {
    uint32_t limit = flash_limit();
    if ((addr & (FLASH_SECTOR_SIZE - 1u)) != 0) {
        printf("ERR: E needs a 4KB aligned addr. Sector containing %08lx is %08lx\n",
               (unsigned long)addr, (unsigned long)(addr & ~(FLASH_SECTOR_SIZE - 1u)));
        printf("     (refused on purpose: an unaligned erase would wipe its neighbours too)\n");
        return;
    }
    if (addr < XIP_BASE_ADDR) {
        printf("ERR: flash commands take a XIP address (10000000 + offset)\n");
        return;
    }
    uint32_t off = addr - XIP_BASE_ADDR;
    if (off + FLASH_SECTOR_SIZE > limit) {
        printf("ERR: out of range (flash limit %lu KB)\n", (unsigned long)(limit / 1024u));
        return;
    }
    if (off < FLASH_GUARD_LEN) {
        printf("ERR: refused -- first 4KB of flash holds boot2 + the vector table\n");
        return;
    }
    if (overlaps_running_image(off, FLASH_SECTOR_SIZE)) {
        printf("ERR: refused -- that sector holds the running monitor image\n");
        printf("     Use B (BOOTSEL) + picotool to reflash the probe instead.\n");
        return;
    }

    printf("E: erasing %08lx..%08lx (4KB)\n", (unsigned long)addr,
           (unsigned long)(addr + FLASH_SECTOR_SIZE));
    if (!core0_park_begin()) {
        printf("ERR: Core0 no response -> refuse to erase (XIP would be pulled out under it)\n");
        return;
    }
    uint32_t ints = save_and_disable_interrupts();
    flash_range_erase(off, FLASH_SECTOR_SIZE);
    restore_interrupts(ints);
    core0_park_end();

    const uint8_t *p = (const uint8_t *)(XIP_BASE_ADDR + off);
    uint32_t nonff = 0;
    for (uint32_t i = 0; i < FLASH_SECTOR_SIZE; i++) {
        if (p[i] != 0xFFu) nonff++;
    }
    printf("done. verify: %lu bytes not 0xFF (expect 0) -> %s\n",
           (unsigned long)nonff, nonff == 0 ? "OK" : "SUSPECT");
}

// F：擦除 + 编程 + 读回校验
static void cmd_flash_write(uint32_t addr, uint32_t len, bool hex) {
    uint32_t limit = flash_limit();

    if (len == 0) {
        printf("ERR: len must be > 0\n");
        return;
    }
    if (len > MAX_WRITE_LEN) {
        printf("ERR: len too big (max %lu)\n", (unsigned long)MAX_WRITE_LEN);
        return;
    }
    if (addr < XIP_BASE_ADDR) {
        printf("ERR: flash commands take a XIP address (10000000 + offset)\n");
        return;
    }
    if ((addr & (FLASH_PAGE_SIZE - 1u)) != 0) {
        printf("ERR: addr must be %lu-byte aligned for programming\n",
               (unsigned long)FLASH_PAGE_SIZE);
        return;
    }
    uint32_t off = addr - XIP_BASE_ADDR;
    if (off >= limit || off + len > limit) {
        printf("ERR: out of range (flash limit %lu KB)\n", (unsigned long)(limit / 1024u));
        return;
    }
    if (off < FLASH_GUARD_LEN) {
        printf("ERR: refused -- first 4KB of flash holds boot2 + the vector table.\n");
        printf("     Writing it wrong bricks the probe (only BOOTSEL by hand could save it).\n");
        return;
    }
    if (overlaps_running_image(off, len)) {
        printf("ERR: refused -- that range holds the running monitor image\n");
        printf("     (erasing it kills this session mid-command).\n");
        printf("     Use B (BOOTSEL) + picotool to reflash the probe instead.\n");
        return;
    }

    uint32_t erase_off = off & ~(FLASH_SECTOR_SIZE - 1u);
    uint32_t erase_len = ((off - erase_off) + len + FLASH_SECTOR_SIZE - 1u)
                         & ~(FLASH_SECTOR_SIZE - 1u);
    uint32_t prog_len  = (len + FLASH_PAGE_SIZE - 1u) & ~(FLASH_PAGE_SIZE - 1u);
    if (erase_off + erase_len > limit || off + prog_len > limit) {
        printf("ERR: aligned erase/program range would run past the flash end\n");
        return;
    }

    printf("F: addr %08lx len %lu (0x%lx) (%s input)\n",
           (unsigned long)addr, (unsigned long)len, (unsigned long)len,
           hex ? "HEX-TEXT" : "RAW-BINARY");
    printf("   erase   %08lx..%08lx\n",
           (unsigned long)(XIP_BASE_ADDR + erase_off),
           (unsigned long)(XIP_BASE_ADDR + erase_off + erase_len));
    printf("   program %08lx..%08lx (tail padded with 0xFF)\n",
           (unsigned long)addr, (unsigned long)(addr + prog_len));
    printf("READY: send %lu bytes now; a Z-only line or %lu s of silence aborts\n",
           (unsigned long)len, (unsigned long)(RX_IDLE_TIMEOUT_MS / 1000u));
    flush_out();

    // 缓冲区先全填 0xFF：编程长度按 256 向上取整，多出来的部分必须是擦除态
    memset(g_wbuf, 0xFF, prog_len);
    int got = hex ? recv_hex(g_wbuf, len) : recv_raw(g_wbuf, len);
    if (got < 0) {
        printf("\nERR: receive aborted (code %d): -1 idle timeout, -2 odd nibble, "
               "-3 Z, -4 bad char\n", got);
        return;
    }
    printf("\ngot %d bytes\n", got);
    flush_out();
    if ((uint32_t)got != len) {
        printf("ERR: short receive (%d of %lu)\n", got, (unsigned long)len);
        return;
    }

    if (!core0_park_begin()) {
        printf("ERR: Core0 no response -> refuse flash write\n");
        printf("     (XIP would be disabled while Core0 is still fetching from flash)\n");
        return;
    }
    printf("writing...\n");
    flush_out();
    uint32_t ints = save_and_disable_interrupts();
    flash_range_erase(erase_off, erase_len);
    flash_range_program(off, g_wbuf, prog_len);
    restore_interrupts(ints);
    core0_park_end();

    // 读回校验（任务硬要求）：逐字节比对 + 打校验和，不能只报一句 OK
    const uint8_t *fb = (const uint8_t *)(XIP_BASE_ADDR + off);
    uint32_t bad = 0, first = 0, sum_f = 0, sum_b = 0;
    for (uint32_t i = 0; i < len; i++) {
        sum_f += fb[i];
        sum_b += g_wbuf[i];
        if (fb[i] != g_wbuf[i]) {
            if (bad == 0) first = i;
            bad++;
        }
    }
    printf("verify: %lu/%lu bytes differ (sum flash=%08lx expect=%08lx) -> %s\n",
           (unsigned long)bad, (unsigned long)len,
           (unsigned long)(sum_f & 0xFFFFFFFFu), (unsigned long)(sum_b & 0xFFFFFFFFu),
           bad == 0 ? "OK" : "FAIL");
    if (bad) {
        printf("        first diff at %08lx: flash=%02x expect=%02x\n",
               (unsigned long)(addr + first), (unsigned)fb[first], (unsigned)g_wbuf[first]);
    }
}

static void cmd_hang_core0(void) {
    printf("X: asking Core0 to hang on purpose (interrupts off + dead loop)...\n");
    flush_out();
    // Core0 收到就钻死循环，不回 ACK -> 这条请求注定超时，那正是我们要演示的效果
    (void)core0_request(MSG_HANG_REQ, MSG_PAUSE_ACK, REQ_TIMEOUT_MS);

    bus_delay_ms(50);
    uint32_t hb1 = g_core0_heartbeat;
    bus_delay_ms(50);
    uint32_t hb2 = g_core0_heartbeat;
    printf("Core0 heartbeat %lu -> %lu (frozen = it is really hung).\n",
           (unsigned long)hb1, (unsigned long)hb2);
    printf("This monitor is still alive on Core1. Try S / P (no response expected),\n");
    printf("then R or B -- both still work. That is the whole point of this firmware.\n");
}

// =====================================================================================
//  命令行
// =====================================================================================

static void dispatch(char *line) {
    char *tok[5];
    int ntok = tokenize(line, tok, 5);
    if (ntok == 0) return;                       // 空行：什么都不做，绝不报错

    // 任务规定的写法是【连写】：c12 / c4（分频紧跟在字母后面，中间没有空格）。
    // 所以要在"命令必须单字母"的检查之前先把它捞出来。
    // 注意只认小写 c：大写 C 是"继续 Core0"，不能被这里吃掉。
    if (tok[0][0] == 'c' && tok[0][1] != '\0') {
        uint32_t d = 0;
        if (!parse_count_arg(&tok[0][1], &d)) {
            printf("ERR: bad clkdiv in '%s' (usage: c<div>, e.g. c12)\n", tok[0]);
            return;
        }
        cmd_samp_cfg(d);
        return;
    }

    if (tok[0][1] != '\0') {                     // 其余命令必须是单字母
        printf("ERR: unknown command '%s' (? = help)\n", tok[0]);
        return;
    }

    // 注意：这里 **不能** 先 toupper！因为任务规定 'r' = 读内存、'R' = 重启，是两条不同的命令；
    // 现在又加了 'c<div>' = 设采样分频 与 'C' = 继续 Core0，同样靠大小写区分。
    const char c = tok[0][0];
    uint32_t a = 0, b = 0;

    switch (c) {
        case '?':  print_help();  return;

        // 读：只认小写 r（大写 R 是重启）
        case 'r':
            if (ntok < 2) { printf("usage: r <addr> [n]   e.g. r 20000000 / r 10000000 8\n"); return; }
            if (!parse_hex_arg(tok[1], &a)) { printf("ERR: bad address (hex)\n"); return; }
            b = 1;
            if (ntok >= 3 && !parse_count_arg(tok[2], &b)) { printf("ERR: bad count\n"); return; }
            cmd_read(a, b);
            return;

        // 重启：只认单独的 R；带了参数就当成误触，宁可不动
        case 'R':
            if (ntok > 1) {
                printf("ERR: R = reboot and takes no args.\n");
                printf("     To read memory use lowercase: r %s\n", tok[1]);
                return;
            }
            cmd_reboot();
            return;

        case 'w': case 'W':
            if (ntok < 3) { printf("usage: w <addr> <val>   e.g. w 20000000 CAFEBABE\n"); return; }
            if (!parse_hex_arg(tok[1], &a) || !parse_hex_arg(tok[2], &b)) {
                printf("ERR: bad number (addr and value are hex)\n");
                return;
            }
            cmd_write(a, b);
            return;

        case 's': case 'S':  cmd_status();     return;
        case 'p': case 'P':  cmd_pause();      return;
        case 'b': case 'B':  cmd_bootsel();    return;
        case 'x': case 'X':  cmd_hang_core0(); return;

        // 'C'（大写）= 继续 Core0。小写 c 是采样器分频，见上面连写分支和下面的用法提示。
        case 'C':  cmd_continue(); return;

        // ---- 采样器 ----
        case 'c':
            // 走到这里说明是单独一个小写 c（带了参数的连写形式已经在前面处理掉了）
            if (ntok >= 2) {
                if (!parse_count_arg(tok[1], &a)) { printf("ERR: bad clkdiv\n"); return; }
                cmd_samp_cfg(a);
                return;
            }
            printf("usage: c<div>   e.g. c12  (set PIO clkdiv, 1..64; fs = sys_clk / clkdiv)\n");
            return;

        case 'd':  cmd_samp_capture(); return;
        case 'm':  cmd_samp_measure(); return;
        case 'g':  cmd_samp_gpio();    return;

        case 'e': case 'E':
            if (ntok < 2) { printf("usage: E <addr>   (4KB aligned, e.g. E 101FF000)\n"); return; }
            if (!parse_hex_arg(tok[1], &a)) { printf("ERR: bad address (hex)\n"); return; }
            cmd_erase(a);
            return;

        case 'f': case 'F': {
            if (ntok < 3) {
                printf("usage: F <addr> <len> [H]\n");
                printf("       addr is hex, len is decimal (0x.. = hex)\n");
                printf("       e.g. F 10100000 256      (raw binary input)\n");
                printf("            F 10100000 256 H    (hex text input)\n");
                return;
            }
            if (!parse_hex_arg(tok[1], &a) || !parse_count_arg(tok[2], &b)) {
                printf("ERR: bad number (addr hex, len decimal or 0x..)\n");
                return;
            }
            bool hex = false;
            if (ntok >= 4) {
                if ((tok[3][0] == 'H' || tok[3][0] == 'h') && tok[3][1] == '\0') hex = true;
                else { printf("ERR: 4th arg must be H (hex-text input) or omitted (raw)\n"); return; }
            }
            cmd_flash_write(a, b, hex);
            return;
        }

        default:
            printf("ERR: unknown command '%c' (? = help)\n", c);
            return;
    }
}

// =====================================================================================
//  Core1：独占串口 + 跑命令
// =====================================================================================
static void core1_main(void) {
    fifo_flush();              // 清掉启动握手的残留

    // 从这一刻起，USB 的两条中断只挂在 Core1 的 NVIC 上：Core0 死活都影响不到串口
    usb_service_enable_here();

    printf("\n");
    printf("=== core1_monitor %s : Core1 serial debug monitor (poor man's SWD) ===\n", MON_VERSION);
    printf("USB CDC is serviced by Core%u. Core0 never touches stdio.\n", (unsigned)get_core_num());
    printf("Type ? for help.\n");
    if (g_core0_state == CORE0_PAUSED) printf("note: Core0 is currently PAUSED\n");
    flush_out();

    char line[LINE_MAX];
    for (;;) {
        usb_kick();
        printf("mon> ");
        flush_out();

        // 读一行（等输入时每 1ms 踢一次 tud_task，所以 USB 永远在被服务）
        uint32_t n = 0;
        bool overflow = false;
        for (;;) {
            int c = getchar_timeout_us(1000);
            if (c == PICO_ERROR_TIMEOUT) {
                usb_kick();
                continue;
            }
            if (c == '\r' || c == '\n') break;
            if (c == 0x7F || c == 0x08) {              // 退格
                if (n > 0) { n--; printf("\b \b"); flush_out(); }
                continue;
            }
            if (c == '\t') c = ' ';
            if (c < 0x20 || c > 0x7E) continue;        // 其它控制字符丢掉
            if (n + 1 >= LINE_MAX) { overflow = true; continue; }
            line[n++] = (char)c;
            printf("%c", c);                           // 回显（串口工具请关掉本地回显）
            flush_out();
        }
        printf("\n");
        flush_out();
        line[n] = '\0';
        if (overflow) {
            printf("ERR: line too long, ignored\n");
            continue;
        }
        dispatch(line);
        flush_out();
    }
}

// =====================================================================================
//  Core0：初始化 + 把串口交给 Core1 + 空闲
// =====================================================================================
int main(void) {
    // [1] USB stdio 只能在 Core0 初始化（SDK 那条断言），但服务马上交给 Core1
    (void)stdio_usb_init();

    // [2] 超频到 252 MHz —— 必须在 Core1 启动【之前】做完（见文件头 [8]）。
    //     用 best-effort（false）：万一这颗板子上不去，就留在默认时钟继续跑并如实报告；
    //     绝不用 required=true 在这里 panic —— 此刻 Core1 还没起来，panic 就等于又要人手按 BOOTSEL。
    //     vreg 抬到 1.25V 是 probe_rp2040 验证过的档位（252 MHz 需要它）。
    vreg_set_voltage(VREG_VOLTAGE_1_25);
    sleep_ms(10);
    bool clk_ok = set_sys_clock_khz(SAMP_CLK_KHZ, false);
    g_sys_clk_overclocked = clk_ok;

    // 顺手读一次 JEDEC，把芯片真实容量记下来（S 命令和 flash 边界检查都要用）。
    // 此刻 Core1 还没启动，没有别的核在跑，所以这次裸读是安全的：XIP 会被短暂关掉，
    // 而执行这段的 Core0 正停在 ROM/ RAM 里的 flash 例程中。
    {
        uint8_t tx[4] = {0x9F, 0x00, 0x00, 0x00};
        uint8_t rx[4] = {0, 0, 0, 0};
        uint32_t ints = save_and_disable_interrupts();
        flash_do_cmd(tx, rx, sizeof(tx));
        restore_interrupts(ints);
        g_jedec_id = ((uint32_t)rx[1] << 16) | ((uint32_t)rx[2] << 8) | rx[3];
        g_chip_flash_size = jedec_cap_to_size(rx[3]);
    }

    // [3] 采样器上电就绪（PIO0 + SM + 引脚）。放在这里的原因：
    //     · 时钟已经定下来了，PIO 的分频算出来就是最终的采样率；
    //     · 此时还没有别的核在跑，配置过程中不会有竞态。
    samp_sampler_init();

    // Core0 的 1ms 唤醒源：没有它 __wfi() 在 M0+ 上可能永远醒不来。
    // 建不上就退化成忙等（g_wfi_ok 为 false），宁可费电也绝不睡死。
    static repeating_timer_t tick;
    g_wfi_ok = add_repeating_timer_ms(1, core0_tick_cb, NULL, &tick);

    // 把 USB 的两条中断从本核摘掉，Core1 起来后再挂到它自己头上
    usb_service_disable_here();

    multicore_launch_core1(core1_main);

    core0_idle_loop();
    return 0;   // 不会到
}
