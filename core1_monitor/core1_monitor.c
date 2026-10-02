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

// 板子头文件一般会给，但万一没有也别编不过
#ifndef PICO_FLASH_SIZE_BYTES
#define PICO_FLASH_SIZE_BYTES (2u * 1024u * 1024u)
#endif

#define MON_VERSION "1.0"

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

// ---------------------------------------------------------------- 核间 FIFO 协议
// Core1 -> Core0（请求）
#define MSG_PAUSE_REQ  0xC0DE0001u
#define MSG_RESUME_REQ 0xC0DE0002u
#define MSG_FLASH_REQ  0xC0DE0003u
#define MSG_HANG_REQ   0xC0DE0004u
// Core0 -> Core1（应答）
#define MSG_PAUSE_ACK  0xC0DE0101u
#define MSG_RESUME_ACK 0xC0DE0102u
#define MSG_FLASH_ACK  0xC0DE0103u

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

// F 的接收缓冲：多留 256 字节，因为编程长度要按 256 向上取整（不满的部分填 0xFF）
static uint8_t g_wbuf[MAX_WRITE_LEN + FLASH_PAGE_SIZE];

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
    printf("\nNOTE: lowercase r = read, uppercase R = reboot (that is what the task asks for).\n");
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

    if (tok[0][1] != '\0') {                     // 命令必须是单字母
        printf("ERR: unknown command '%s' (? = help)\n", tok[0]);
        return;
    }

    // 注意：这里 **不能** 先 toupper！因为任务规定 'r' = 读内存、'R' = 重启，是两条不同的命令。
    // 大小写不敏感只对不冲突的字母成立（s/S、p/P、...）。
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
        case 'c': case 'C':  cmd_continue();   return;
        case 'b': case 'B':  cmd_bootsel();    return;
        case 'x': case 'X':  cmd_hang_core0(); return;

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
