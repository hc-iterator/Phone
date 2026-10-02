/*
 * kernel.c —— 内存越权系统调用的内核侧实现
 *
 * 机制（详见 docs/系统调用设计.md）：
 *   应用运行在非特权态，对"系统页"没有写权限。
 *   应用往系统页写数据 → 硬件触发 MemManage 异常 →
 *   内核在异常处理里读出出错地址、代执行操作、把返回地址跳过那条指令。
 *
 * 本文件只做一件事：把这条链路跑通并打印证据。
 *
 * 为什么直接操作寄存器地址而不用 CMSIS：
 *   CMSIS 的 MPU 宏/函数需要包含一长串头文件，且不同版本命名有差异。
 *   这几个寄存器地址由 ARM 架构固定，直接写更可控、依赖更少。
 */

#include <stdio.h>
#include <stdbool.h>

#include "pico/stdlib.h"
#include "hardware/watchdog.h"   // watchdog_hw->scratch[]：用于记录演示进度

#include "kernel.h"

// ============================================================================
// Cortex-M33 内核寄存器（地址来自 ARMv8-M 架构参考手册，非推测）
// ============================================================================

#define REG32(addr)  (*(volatile uint32_t *)(addr))

#define SCB_CFSR     REG32(0xE000ED28)   // 可配置错误状态寄存器
#define SCB_SHCSR    REG32(0xE000ED24)   // 系统处理控制与状态
#define SCB_MMFAR    REG32(0xE000ED34)   // MemManage 出错地址
#define MPU_TYPE     REG32(0xE000ED90)   // MPU 类型（高 8 位 = 区域数）
#define MPU_CTRL     REG32(0xE000ED94)   // MPU 控制
#define MPU_RNR      REG32(0xE000ED98)   // 区域号
#define MPU_RBAR     REG32(0xE000ED9C)   // 区域基址
#define MPU_RLAR     REG32(0xE000EDA0)   // 区域上限
#define MPU_MAIR0    REG32(0xE000EDC0)   // 内存属性 0..3（复位值 0x00000000！）

#define SHCSR_MEMFAULTENA   (1u << 16)   // 使能 MemManage 异常
#define MPU_CTRL_ENABLE     (1u << 0)
#define MPU_CTRL_PRIVDEFENA (1u << 2)    // 背景区：特权态按默认内存映射访问
#define CFSR_DACCVIOL       (1u << 1)    // 数据访问违例
#define CFSR_MMARVALID      (1u << 7)    // MMFAR 内容有效

#define SYSCALL_MAX_SLOTS   (sizeof(g_sys_page) / 4)

// ============================================================================
// 系统页
// ============================================================================

/*
 * 系统页必须 4KB 对齐 —— MPU 区域要求大小是 2 的幂且基址按大小对齐。
 * aligned(4096) 让链接器把它放在 4KB 边界上。
 */
__attribute__((section(".syspage"), aligned(4096)))
uint32_t g_sys_page[SYSCALL_WORDS];

// ============================================================================
// 演示状态
// ============================================================================

static volatile uint32_t s_calls_ok = 0;      // 内核受理的合法请求数
static volatile uint32_t s_denied = 0;        // 被拒绝的越界访问数
static volatile uint32_t s_faults = 0;        // 异常总次数
static volatile uint32_t s_last_pc = 0;       // 最后一次出错指令地址

/*
 * 最小自检的结果变量（在 kernel.h 里声明为 extern）。
 * 非 static：调试器按符号名就能找到，便于 SWD 直接读。
 */
volatile uint32_t pico_kernel_selftest_status = 0;   // 1=通过
volatile uint32_t pico_kernel_selftest_faults = 0;   // 处理程序触发次数（期望 1）
volatile uint32_t pico_kernel_selftest_addr = 0;     // 处理程序看到的出错地址

/*
 * 异常处理程序【不能 printf】，所以它只把现场记到这里，
 * 等退出异常后由普通代码（kernel_syscall_demo）打印。
 */
static volatile uint32_t s_fault_addr = 0;        // MMFAR：出错地址
static volatile uint32_t s_fault_pc = 0;          // 出错的那条指令
static volatile uint32_t s_fault_is_data = 0;     // 是否数据访问违例
static volatile uint32_t s_fault_addr_valid = 0;  // MMFAR 是否有效
static volatile uint32_t s_fault_insn_size = 0;   // 出错指令长度（2 或 4）
static volatile uint32_t s_last_slot = 0;         // 最后一次系统调用号
static volatile uint32_t s_last_arg = 0;          // 最后一次调用参数
static volatile uint32_t s_last_was_call = 0;     // 最后一次是合法调用(1)还是越界(0)

/* 内核私有内存 —— 应用绝不该碰它。演示里用来验证拦截是否生效。 */
static volatile uint32_t s_kernel_secret = 0x5EC2E7;

// ============================================================================
// 演示用的"应用"
// ============================================================================

/*
 * 这段函数以【非特权态】运行（CONTROL.nPRIV = 1）。
 *
 * 它做两件事：
 *   1. 合法请求：写系统页 → 应该触发异常 → 内核受理
 *   2. 非法访问：写内核私有变量 → 应该触发异常 → 内核拒绝
 *
 * noinline 是【必须】的：如果编译器把它内联进 kernel_syscall_demo，
 * 这段"应用代码"就会在【特权态】执行 —— 演示彻底失效，
 * 而且 printf 输出看起来完全正常，你根本发现不了。
 * 当前编译下它恰好没被内联，但不能依赖这种运气。
 */
__attribute__((noinline))
static void app_main(void) {
    // --- 合法：通过系统页请求服务 ---
    for (uint32_t i = 0; i < 3; i++) {
        g_sys_page[i] = 0xDEAD0000u | i;   // ← 这一句触发 MemManage
    }

    // --- 非法：尝试读内核私有变量 ---
    // 应用没有权限，这次访问应该被拦下
    volatile uint32_t stolen = s_kernel_secret;
    (void)stolen;                          // ← 这一句也应该触发 MemManage
}

// ============================================================================
// MemManage 异常处理
// ============================================================================

/*
 * 异常压栈顺序（地址从低到高）：R0, R1, R2, R3, R12, LR, PC, xPSR
 *
 * 但这【不一定】是 8 个字。若异常发生前用过浮点寄存器，硬件会多压 18 个字
 * （S0-S15, FPSCR, 以及一个保留字），此时 PC 的偏移就不是 24 而是 24+72。
 * 判断依据是 EXC_RETURN（进异常时 LR 的值）的 bit 4：
 *   0 = 使用了扩展栈帧（有浮点），1 = 基本栈帧
 * 写死偏移会在启用浮点后静默出错，所以这里按 EXC_RETURN 动态取。
 */
typedef struct {
    uint32_t r0, r1, r2, r3, r12, lr, pc, xpsr;
} exception_frame_t;

#define EXC_RETURN_FTYPE        (1u << 4)   // 1 = 基本栈帧（无浮点）

/*
 * 算出一条 Thumb 指令占几个字节。
 *
 * Thumb-2 里 32 位指令由两个 16 位半字组成，特征是：
 *   第一个半字高 5 位 ∈ {11101, 11110, 11111}
 *   第二个半字高 5 位 ∈ {11101, 11110, 11111}
 * 否则就是 16 位指令。
 *
 * 这是本机制唯一"看指令"的地方，而且只看长度、不解码内容 ——
 * 这正是选"写内存触发"而不是"跳转触发"的原因。
 *
 * ⚠️ 这个函数【必须是叶子函数】：它由异常处理程序在异常上下文里调用。
 * 如果它自己不压栈、不调别的函数，返回时 SP 净变化为 0。
 * 一旦它不是叶子（比如被改成调用别的函数），调用点的 SP 就会偏移，
 * 而"异常帧 = 当前 SP"这个假设就会悄悄失效 —— 之前的 bug 正是这一类。
 */
static uint32_t thumb_insn_size(uint32_t addr) __attribute__((noinline));
static uint32_t thumb_insn_size(uint32_t addr) {
    uint32_t hw1 = *(volatile uint16_t *)addr;
    uint32_t hw2 = *(volatile uint16_t *)(addr + 2);
    if ((hw1 & 0xE800u) == 0xE800u && (hw2 & 0xF800u) == 0xF800u) {
        return 4;
    }
    return 2;
}

/*
 * ⭐ 异常帧快照 —— 上次排查失败就是因为没有这个。
 *
 * ── 病根：不要"推导"异常帧位置，要直接把它交出来 ──
 *
 * 连踩三次的教训：
 *   1. 用 C 函数里的 "mrs msp" 当帧指针 —— 该函数自己的栈帧已经改了 SP。
 *   2. 在裸汇编里写死 "SP + N" —— N 由 mem_manage_c 的 prologue 决定，
 *      那是【编译器】的自由。注释以为压 6 个字，实际压 8 个字（32 字节）。
 *   3. 想"运行时解指令编码"来算出 N —— 又一次猜错：
 *      mem_manage_c 的 prologue 是 Thumb-32 的 STMDB（0xE92D 0x43F8），
 *      寄存器列表是 16 位掩码，不是 Thumb-16 PUSH 的 3 位个数。
 *      按 Thumb-16 去解会得到 6 字节，而真实值是 32 字节。
 *
 * 结论：任何"事后反推帧位置"的方案都会随编译器变化而悄悄失效。
 *
 * 正确做法：异常帧地址在【异常入口那一瞬间】就等于 SP，
 * 而且 isr_memmanage 是 naked 函数，进它时还没有任何代码动过 SP。
 * 所以在 isr_memmanage 里一条 "mov r2, sp" 就拿到绝对正确的帧地址，
 * 然后把它作为参数传给 C，一路传到这里。零推算。
 *
 * 快照在系统页的布局（字偏移）：
 *   [4]       本次异常序号
 *   [8]       异常返回地址 EXC_RETURN（进异常时 LR 的值）
 *   [9]       异常帧起点指针（由 isr_memmanage 在入口处直接给出）
 *   [10]      snapshot 被执行时的 SP（仅供对照）
 *   [11]      （保留）
 *   [12]      MMFAR
 *   [13]      CFSR
 *   [14]      （保留）
 *   [15]      （保留）
 *   [16..23]  8 个基本栈帧字：R0,R1,R2,R3,R12,LR,PC,xPSR
 *   [24..49]  扩展帧时还有 18 个字（S0-S15,FPSCR,保留）
 *
 * EXC_RETURN 的 bit4：1 = 基本栈帧(8 字)，0 = 扩展栈帧(26 字，含浮点)。
 *
 * 参数 frame = 异常帧地址（来自 isr_memmanage 入口处的 SP）。
 */
__attribute__((naked, noinline))
void snapshot_exception_frame(uint32_t frame) {
    __asm volatile (
        /*
         * ⚠️ 本函数用到了 r4-r7，而它是【普通函数】（由 mem_manage_c 调用），
         *    所以必须自己保存 r4-r7 —— 编译器假设被调函数会保留它们。
         *    例外处理程序里恰好也是同一类错误（见 isr_svcall 开头的长注释）。
         */
        "push    {r4, r5, r6, r7, lr} \n"
        /* 入参：r0 = 异常帧地址（由 isr_memmanage 的 "mov r2, sp" 传来） */

        /* 栈帧类型：LR 的 bit4 为 0 表示扩展帧（26 字） */
        "tst     lr, #0x10          \n"
        "ite     eq                  \n"
        "moveq   r6, #26             \n"
        "movne   r6, #8              \n"

        "ldr     r4, =g_sys_page     \n"

        /* ⚠️ 帧快照放在 [48] 起，不要用 [8..15] —— 那里存的是 MPU 现场记录，
         *    由特权态在切非特权态前写入，崩溃后要用来核对 MPU 配置。 */
        "str     r0, [r4, #196]      \n"   /* [49] 异常帧指针（★ 核心） */
        "mrs     r5, msp             \n"
        "str     r5, [r4, #200]      \n"   /* [50] 当前 SP，仅供对照 */
        "str     lr, [r4, #192]      \n"   /* [48] EXC_RETURN */

        "ldr     r7, =0xE000ED34     \n"
        "ldr     r7, [r7]            \n"
        "str     r7, [r4, #204]      \n"   /* [51] MMFAR */
        "ldr     r7, =0xE000ED28     \n"
        "ldr     r7, [r7]            \n"
        "str     r7, [r4, #208]      \n"   /* [52] CFSR */

        "ldr     r7, [r4, #16]       \n"   /* [4] 是此次异常序号（首次为 0） */
        "add     r7, r7, #1          \n"
        "str     r7, [r4, #16]       \n"
        "str     r6, [r4, #212]      \n"   /* [53] 快照字数 */

        /* 把 frame[] 拷到 g_sys_page[56] 起。
         * r0 是源基址（不动它），r6 是字数，r5 是下标，r7/r1 是中转。 */
        "mov     r5, #0              \n"
        "1:                          \n"
        "cmp     r5, r6              \n"
        "bge     2f                  \n"
        "ldr     r7, [r0, r5, lsl #2] \n"
        "mov     r1, r7              \n"
        "add     r7, r5, #56         \n"
        "str     r1, [r4, r7, lsl #2] \n"
        "add     r5, r5, #1          \n"
        "b       1b                  \n"
        "2:                          \n"
        "pop     {r4, r5, r6, r7, lr} \n"   /* 还回 r4-r7，再返回 */
        "bx      lr                  \n"
        ".ltorg                      \n"
        :
        :
        : "memory"
    );
}

/*
 * 取出异常栈帧。
 *
 * ⚠️ 这里是老 bug 的现场，务必看清。
 *
 * 旧实现（错的）：直接 "mrs msp" 当帧指针。
 * 错在两点：
 *   1. 异常进入时硬件已在这个栈上压了 8 个字（或 26 个），SP 已经指到帧【下面】；
 *      而 mem_manage_c 自己的 prologue 又压了 32 字节。
 *   2. 更致命的是：本函数自身有栈帧，编译器生成的代码会改 SP，
 *      读到的值连"进入时的 SP"都不是。
 * 结果：帧指针完全指错，处理程序去读野地址 → 自身 MemManage → 升级 HardFault。
 * 实测现场：PC=0x10000861 正是 "ldr r2, [r4, #24]"（ef->pc），
 *          r4/MMFAR 指向 0x20006FD0，而系统页记录区全 0xFFFFFFFF。
 *
 * 正确做法：不在 C 里推算任何偏移。由 isr_memmanage 在异常入口处
 * 直接用 "mov r2, sp" 拿到帧地址并作为参数传下来（见该函数）。
 * 这里只是把已经落盘在系统页 [9] 的那个值读回来。
 */
static exception_frame_t *get_exception_frame(uint32_t exc_return) {
    (void)exc_return;   // 帧类型已由 snapshot 按 EXC_RETURN.bit4 处理
    return (exception_frame_t *)(uintptr_t)g_sys_page[9];
}

/*
 * 符号名必须是 isr_memmanage —— SDK 的向量表（pico_crt0/crt0.S）用这个弱符号名。
 * 名字写错不会有编译错误，只会让链接器把这个函数当"无人引用"丢掉，
 * 结果就是越权访问直接进 HardFault，而你看不到任何提示。
 *
 * ⚠️ 这里【不要】试图修改 CONTROL 去"升回特权态"。
 *
 * 曾经的错误想法：以为异常入口保持非特权态，所以要先升权才能访问外设。
 * 实际情形更微妙：
 *   - 若应用是【真非特权态】，那么修改 CONTROL 这条指令本身是特权指令，
 *     在非特权态下执行会【立即再次触发故障】—— 循环依赖，处理程序直接崩。
 *   - 实测确实观察到处理程序内部出故障，最终升级成 HardFault
 *     （CFSR 含 IACCVIOL/MSTKERR/MUNSTKERR，PC 停在 Hardfault_HandlerC）。
 *
 * 现在的原则：处理程序【只做不需要特权的事】——
 * 读写 SRAM 里的普通变量、清故障状态寄存器，然后跳过出错指令返回。
 * 需要访问外设的操作一律留给退出异常之后的普通代码。
 *
 * ── 本函数是"异常帧地址"的唯一权威来源 ──
 *
 * 进 MemManage 时的 SP 就等于硬件刚压好的异常帧地址 —— 这是 ARMv8-M 的
 * 硬性行为，不需要推导。而本函数是 naked 的，从入口到这里没有一条指令
 * 动过 SP，所以此刻的 sp 就是那个地址。
 *
 * 因此：mov r2, sp → 帧地址；mov r0, lr → EXC_RETURN。
 * mem_manage_c 是普通 C 函数，参数按 AAPCS 走 r0/r1/r2，
 * 它的 prologue 怎么压栈都不会影响 r2 里已经拿到的值。
 */
void __attribute__((naked)) isr_memmanage(void) {
    __asm volatile (
        /*
         * ⭐⭐ 绝对第一现场：在处理程序入口【立即】把关键状态写进 WATCHDOG
         *  scratch（复位/崩溃都保留，是唯一可靠的"非易失"信标）。
         *
         * 为什么必须放在这里而不是 C 里：C 代码会被编译器重排，
         * 而且一旦后续出问题，前面的记录可能根本没执行。
         * 这里是异常入口的第一条指令，没有任何东西能插到它前面。
         *
         * 记录内容：
         *   scratch[1] = CONTROL（关键：nPRIV 位 = 处理程序的特权状态）
         *   scratch[2] = MSP
         *   scratch[3] = PSP
         *   scratch[4] = 将要传给 C 的异常帧指针（即入口 SP）
         */
        "ldr  r3, =0x400d8000   \n"   /* WATCHDOG_BASE */
        /*
         * ⭐ 关键：CONTROL【当场读两遍】并记录 EXC_RETURN。
         *
         * 之前只存一次，读回 1（nPRIV=1），但按 ARMv8-M 规定 Handler 模式
         * 必然是特权态 —— 两者矛盾。为排除"读取时机/寄存器被覆盖"这类错觉，
         * 这里连读两次，两遍都写进 scratch 供对照，并记录 EXC_RETURN，
         * 用它的 bit2 判断异常前用的是 MSP 还是 PSP，作为交叉验证。
         */
        /*
         * ⭐ 只用 r0-r3 / r12（caller-saved）！
         *
         * 本函数是 naked 且【尾调用】mem_manage_c（用 b，不是 bl），
         * 所以它没有机会"先压栈、返回时再还回去"。
         * 而硬件异常进入【不保存 r4-r11】，一旦这里动了 r4/r5，
         * 异常返回后崩掉的那段代码的 r4/r5 就被永久改坏了 ——
         * 这正是 isr_svcall 里踩过的那个坑（见那里的长注释）。
         * 所以这里一律用 caller-saved 寄存器。
         */
        "mrs  r2, control       \n"   /* 第一遍 */
        "str  r2, [r3, #16]     \n"   /* scratch[1] = CONTROL 第一遍 */
        "mrs  r2, control       \n"   /* 立刻第二遍（排除读取时机造成的错觉） */
        "str  r2, [r3, #32]     \n"   /* scratch[5] = CONTROL 第二遍 */
        "str  lr, [r3, #36]     \n"   /* scratch[6] = EXC_RETURN */
        "mrs  r1, msp           \n"
        "str  r1, [r3, #20]     \n"   /* scratch[2] = MSP */
        "mrs  r1, psp           \n"
        "str  r1, [r3, #24]     \n"   /* scratch[3] = PSP */
        "str  sp, [r3, #28]     \n"   /* scratch[4] = 入口 SP（= 异常帧地址） */

        "mov r2, sp         \n"   // r2 = 异常帧地址（入口 SP，绝对正确）
        "mov r0, lr         \n"   // r0 = EXC_RETURN
        "b   mem_manage_c   \n"
        :
        :
        : "memory"
    );
}

void mem_manage_c(uint32_t exc_return, uint32_t unused_r1, uint32_t frame) {
    /*
     * ⭐ 非易失信标：本处理程序一被调用就立刻标记。
     *
     * 用 WATCHDOG 的 scratch 寄存器（普通内存映射寄存器，复位后保留），
     * 这样即使后面立刻崩溃并触发自复位，复位后仍能读回这个标记，
     * 从而回答一个关键问题：这次故障【到底进没进 MemManage 处理程序】。
     *
     * 实测教训：之前所有"系统页记录区全是 0xFFFFFFFF/0"的现象，
     * 无法区分"处理程序没跑"和"处理程序跑了但写不进去"，
     * 于是排查方向反复摇摆。用 scratch 就能一刀切开这两种情况。
     */
    watchdog_hw->scratch[0] = 0x4D4D0001u;   /* "MM" + 序号 */

    /*
     * ⭐ 第一步永远是"落盘现场"，而不是"访问现场"。
     *
     * 之前是先 get_exception_frame() 再读 ef->pc，一旦算错位置就在访问野指针，
     * 处理程序自己出错 → HardFault，真信息全丢。
     * 现在 snapshot 把 frame 指向的 8(或26)个字原样抄进系统页，
     * 之后【所有】判断都基于已落盘的副本，不再回头碰栈。
     */
    (void)exc_return;
    (void)unused_r1;
    snapshot_exception_frame(frame);

    /*
     * 从快照里取异常帧指针（[9] 是 snapshot 算好的 SP+24）。
     * 这里信任的是 snapshot 里那条 "add r5, r5, #24"，
     * 而不是本函数自己再 mrs 一次 —— 本函数的栈帧已经和进异常时不同了。
     */
    exception_frame_t *ef = (exception_frame_t *)(uintptr_t)g_sys_page[9];

    s_faults++;

    uint32_t cfsr = SCB_CFSR;
    uint32_t addr = SCB_MMFAR;
    bool addr_valid = (cfsr & CFSR_MMARVALID) != 0;
    bool is_data = (cfsr & CFSR_DACCVIOL) != 0;

    /*
     * ⚠️ 注意执行顺序：cfSR/MMFAR 必须在 snapshot 之前读才准？
     * 不 —— snapshot 内部已经读过一次并落盘在 [12]/[13]。
     * 这里再读一次是因为 snapshot 可能已被后续访问改动；两次都记，
     * 便于对照（[12]/[13] 是 snapshot 时刻的值，下面写入的是当前值）。
     */
    uint32_t insn = thumb_insn_size(ef->pc);

    s_last_pc = ef->pc;

    /*
     * ⚠️ 异常处理程序里【绝对不能调用 printf】。
     *
     * 实测教训：原来在这里 printf，结果触发
     *   CFSR = 0x00000008 (MUNSTKERR，异常返回出栈失败)
     *   MMFAR = 0x40078018（外设区地址）
     *   PC 停在 stdio_uart_out_flush
     * printf 会去操作 UART/USB 外设，在异常上下文中不安全，破坏栈帧。
     *
     * 正确做法：只把现场记到普通变量，等退出异常后由普通代码打印。
     */
    /*
     * ⭐ 处理程序的"记录区"必须放在【系统页内部】。
     *
     * 原因：应用在非特权态调用系统调用时，处理程序入口虽是特权态，
     * 但这条链路上的每一步都要求它不依赖特权才能写 —— 系统页是显式
     * 声明"非特权可读写"的区域，写它永远安全。
     *
     * 布局（以字为单位，从 SYSCALL_WORDS 往前排）：
     *   [SYSCALL_WORDS-1] 处理程序被触发次数
     *   [SYSCALL_WORDS-2] 出错地址（MMFAR）
     *   [SYSCALL_WORDS-3] 出错指令地址（PC）
     *   [SYSCALL_WORDS-4] MMARVALID/DACCVIOL 标志
     */
    g_sys_page[SYSCALL_WORDS - 1] += 1u;                 // 计数
    g_sys_page[SYSCALL_WORDS - 2] = addr;                // MMFAR
    g_sys_page[SYSCALL_WORDS - 3] = ef->pc;              // 出错指令
    g_sys_page[SYSCALL_WORDS - 4] =
        (addr_valid ? 1u : 0u) | (is_data ? 2u : 0u);    // 标志

    // 同时照旧记账到普通变量（特权态下这些写入会成功；非特权态下可能失败，
    // 属于预期，不作为判断依据）
    s_fault_addr = addr;
    /*
     * 判断这次访问是不是"合法的系统调用"。
     * 同样只写系统页，不依赖特权。
     */
    uint32_t base = (uint32_t)g_sys_page;
    bool in_sys_page = addr_valid && (addr >= base) &&
                       (addr < base + sizeof(g_sys_page)) &&
                       (((addr - base) % 4) == 0);

    if (in_sys_page) {
        // 合法：应用在请求系统调用。记录调用号与参数到系统页末尾的记录区。
        uint32_t slot = (addr - base) / 4;
        g_sys_page[SYSCALL_WORDS - 5] = slot;
        g_sys_page[SYSCALL_WORDS - 6] = g_sys_page[slot];
        g_sys_page[SYSCALL_WORDS - 7] += 1u;   // 受理计数
    } else {
        // 非法：应用越界。同样只写系统页。
        g_sys_page[SYSCALL_WORDS - 8] += 1u;   // 拦截计数
    }

    // 跳过出错的那条指令，让应用能从下一条继续
    ef->pc += insn;

    // 清状态位，否则退出异常后会立刻再次进入
    SCB_CFSR = cfsr;

    /*
     * 标记"处理程序走完了"。
     *
     * 这一行是划分执行边界用的：若系统页这个位置读不到 0x5A5A，
     * 说明处理程序在它之前就崩了 —— 本函数的执行范围就到此为止。
     */
    g_sys_page[SYSCALL_WORDS - 9] = 0x5A5A;
}

// ============================================================================
// 入口
// ============================================================================

/*
 * 系统调用演示（SVC 版）。
 *
 * ── 为什么改用 SVC ──
 *
 * 原设计想让应用"往系统页写数据"来触发内存越权异常，内核在异常里识别它。
 * 在 RP2350 上实测了 4 轮，`isr_memmanage` 里读 CONTROL 会得到
 * 0x01、紧接着又得到 0x02（Handler 模式下按 ARMv8-M 都应为 0），
 * EXC_RETURN 也出现 0xFFFFFFFE 这种非标准值 —— 这条路的行为不稳定，
 * 不适合做系统调用的地基。
 *
 * SVC 是 ARM 为"应用请求内核服务"设计的标准入口，行为完全确定：
 *   - 异常入口硬件自动把 nPRIV 清 0 → 内核必然运行在特权态
 *   - 栈帧压到 PSP，内核跑在 MSP，天生天然隔离
 *   这两点正是本机制需要的，且不依赖 MPU 的具体行为。
 *
 * 内核仍然是"唯一掌握权限"的一方：外设、内存、蓝牙都只由内核触碰，
 * 应用只能通过 SVC 递上"调用号 + 参数"。这与原设计的核心思想一致。
 */

/* 系统调用号 */
#define SYS_NOP        0u   /* 空调用，只证明链路通 */
#define SYS_GET_TICK   1u   /* 取系统节拍 */
#define SYS_WRITE_STR  2u   /* 内核代打印字符串 */
#define SYS_DENY       3u   /* 故意越权，验证内核会拒绝 */
#define SYS_EXIT       4u   /* 应用请求退出：内核把它切回特权态+MSP */

/* 调用结果与参数（放在固定位置，便于调试器查看） */
volatile uint32_t g_sys_result   = 0;   /* 内核写回的返回值 */
volatile uint32_t g_sys_calls    = 0;   /* 成功受理次数 */
volatile uint32_t g_sys_denied   = 0;   /* 被拒绝次数 */
volatile uint32_t g_sys_last_no  = 0;   /* 最后一次调用号 */
volatile uint32_t g_sys_last_arg = 0;   /* 最后一次参数 */
volatile uint32_t g_sys_psp_seen = 0;   /* 内核看到的 PSP（应用栈） */
volatile uint32_t g_sys_msp_seen = 0;   /* 内核看到的 MSP（内核栈） */
volatile uint32_t g_sys_app_stack_lo = 0;  /* 应用栈区间下界 */
volatile uint32_t g_sys_app_stack_hi = 0;  /* 应用栈区间上界 */
volatile uint32_t g_sys_done_magic   = 0;  /* 演示走到底的标记 */
volatile uint32_t g_sys_ctrl_seen   = 0;  /* SVC 处理程序入口读到的 CONTROL（最后一次） */
volatile uint32_t g_sys_app_xpsr     = 0;  /* 应用被拦截时的 xPSR（用于判读特权态） */

/* ============================================================================
 * 第 18 轮探针：把"此刻是不是特权态"从推理改成【测量】
 * ----------------------------------------------------------------------------
 * 起因：前几轮反复栽在特权态的推理上（"处理程序读到 nPRIV=1 所以它非特权"
 * 这类结论），每次代价是一整轮。现在一律采样存数组，由 SWD 读数字判读。
 *
 * g_probe_ctrl[] 的采样点（谁写、在哪写、期望值）：
 *   [0] isr_svcall 入口，仅第 1 次  —— 判 nPRIV 跨异常进入是否保留
 *   [1] 演示里设 nPRIV=1 之前       —— 应 0（特权）
 *   [2] 3 次 SVC 之后、SYS_EXIT 前  —— 1 表示应用期间一直是非特权态
 *   [3] SYS_EXIT 之后               —— 0 表示内核收回了权限
 *   [4] dvi_screen_test 入口        —— 0 表示屏幕初始化在特权态跑
 * ==========================================================================*/

volatile uint32_t g_probe_ctrl[8]  = {0};
volatile uint32_t g_probe_marks    = 0;   /* 进度信标：崩溃时看它停在哪一步 */
volatile uint32_t g_probe_svc_n    = 0;   /* SVC 处理程序进入次数 */
volatile uint32_t g_probe_mpu_type = 0;   /* 行为验证：特权读非 0，非特权读 0 */

void kernel_mark(uint32_t m) {
    g_probe_marks = m;
}

/*
 * 读当前线程的 CONTROL。
 *
 * ⚠️ 只在 Thread 模式下有意义：Handler 模式必然特权，那里的 nPRIV
 *    描述的是线程的状态，不是处理程序自己的。这个区分本项目栽过跟头。
 * CONTROL 是普通特殊寄存器，读它不需要特权，所以在非特权态调用也安全。
 */
uint32_t kernel_read_control(void) {
    uint32_t c;
    __asm volatile ("mrs %0, control" : "=r"(c));
    return c;
}

/*
 * SVC 处理程序。
 *
 * 约定（AAPCS）：SVC 号在调用指令的立即数里；这里统一用 r0=服务号、
 * r1=参数，返回值放回 r0，直接改异常栈帧里的 r0。
 *
 * 异常栈帧（基本帧）：R0,R1,R2,R3,R12,LR,PC,xPSR —— R0 在偏移 0。
 *
 * 注意：本函数是 naked，只用汇编，避免编译器插入栈操作改变 sp。
 */
/* 内核代打印 —— 必须在 isr_svcall 之前声明，因为汇编里会 bl 它 */
void kernel_puts(const char *s);

void __attribute__((naked)) isr_svcall(void) {
    __asm volatile (
        /*
         * ⭐⭐ 必须先自己保存 r4-r7 与 lr！
         *
         * ⚠️ 这是本项目最隐蔽的一个 bug 的现场，务必看懂再改。
         *
         * 硬件在异常进入时【只压】r0-r3、r12、lr、pc、xPSR 这 8 个字，
         * 【不保存 r4-r11】。所以处理程序要用 r4-r11，就必须自己压栈 ——
         * 否则异常返回后，被中断的那段代码的 r4-r11 已经被改掉了，
         * 而它完全不知道。
         *
         * 之前本处理程序把"调用号"放在 r5 里，注释还写着
         * "r5 是本函数专用，不会被 bl 破坏（r4-r11 是 callee-saved）"。
         * 那句话把方向搞反了：
         *   r4-r11 确实是 callee-saved —— 但【callee 是本处理程序】，
         *   是【我们】欠被中断代码一个 r5，不是别人替我们留着。
         *
         * 实测后果：main 把 &_impure_ptr 常驻在 r5 里复用，
         * 跑过一次 SVC 之后 r5 变成了调用号，于是下一次
         *     fflush(stdout)  变成了  fflush(从野地址读出来的值)
         * 传进去的 FILE* 是奇数地址 → LDRSH 非对齐访问 → HardFault
         * （实测 CFSR = 0x01000000 = UNALIGNED，出错指令 ldrsh r0,[r4,#12]）。
         * 表面现象是"系统调用一跑完，后面第一次 printf/fflush 就崩"，
         * 一度被误判成"特权态没恢复"。真正的错在这里。
         *
         * 压 5 个寄存器 = 20 字节，异常帧整体上移 20 字节：
         *   帧内偏移 0/4/8/12/16/20/24/28 → 栈上偏移 20/24/28/32/36/40/44/48
         * 下面所有 [sp, #N] 都按这个约定写。
         */
        "push {r4, r5, r6, r7, lr} \n"
        "mrs  r2, msp            \n"
        "ldr  r3, =g_sys_msp_seen \n"
        "str  r2, [r3]           \n"

        /*
         * ⭐ 记录 SVC 处理程序【入口立刻读到】的 CONTROL。
         *    这是判读"nPRIV 会不会跨异常保留"的唯一直接证据。
         *
         * 判读规则（第 18 轮）：
         *   应用在 nPRIV=1 下发起 SVC，这里若读到 1
         *     ⇒ 异常【进入】不改 nPRIV，它会原样保留、直到异常返回，
         *       所以"清 nPRIV"这件事必须在处理程序里做才有效；
         *   若读到 0
         *     ⇒ 进入时硬件就把它清了，那就得另找恢复途径。
         * 两种架构行为对应完全不同的修法。先测，不再推理。
         *
         * 只留【第一次】的读数：后续调用时线程的特权态已经被前面的处理
         * 改过，混在一起没法判读。旧变量 g_sys_ctrl_seen 记的是最后一次，
         * 读到 0 就被误当成"处理程序是非特权态" —— 这个坑要记住。
         */
        "mrs  r2, control         \n"
        "ldr  r3, =g_sys_ctrl_seen \n"
        "str  r2, [r3]            \n"   /* 最后一次（保留兼容） */
        "ldr  r3, =g_probe_svc_n  \n"
        "ldr  r12, [r3]           \n"
        "cmp  r12, #0             \n"
        "bne  8f                  \n"
        "ldr  r3, =g_probe_ctrl   \n"
        "str  r2, [r3]            \n"   /* g_probe_ctrl[0] = 首次入口 CONTROL */
        "8:                       \n"
        "add  r12, r12, #1        \n"
        "ldr  r3, =g_probe_svc_n  \n"
        "str  r12, [r3]           \n"

        /*
         * ⚠️ 这里【故意不再】清 CONTROL.nPRIV。
         *
         * 旧代码在异常入口无条件 bic/msr 把 nPRIV 清 0，理由是
         * "处理程序读到 nPRIV=1，说明它不是特权态、碰特权资源会崩"。
         * 这个判断是错的：Handler 模式必然特权，nPRIV 在 Handler 模式下
         * 没有意义 —— 它描述的是【线程】的状态。
         *
         * 而且如果 nPRIV 跨异常返回原样保留（探针要验的正是这点），
         * 入口这一清就等于让【线程】在返回后永久变成特权态：
         * 应用只要发一次系统调用就拿到全部权限，隔离当场失效。
         * 所以那一行不只是多余，是有害的。
         */

        /* 记录应用栈指针（异常发生前用的是它） */
        "mrs  r2, psp            \n"
        "ldr  r3, =g_sys_psp_seen \n"
        "str  r2, [r3]           \n"

        /*
         * ⭐ 取调用号与参数，并立刻备份到 r5 与全局变量。
         *
         * 踩过的坑 1：原来把调用号放 r2，而 r2 在后面被"计数自增"复用，
         *   结果 g_sys_last_no 被写成了计数/返回值（实测读到 0xBAD）。
         * 踩过的坑 2：把调用号放 r5 却【没保存 r5】—— 见函数开头的长注释，
         *   那会让被中断代码的 r5 静默损坏。现在入口已经 push 了 r5。
         *
         *   r5 = 调用号（已被 push 保护，且不会被 bl 破坏 ——
         *        r4-r11 是 callee-saved，kernel_puts 必须保留它们）
         *   g_sys_last_no / g_sys_last_arg 用【原始】值记录
         */
        "ldr  r5, [sp, #20]      \n"   /* r5 = 调用号（帧内偏移 0 + 20） */
        "ldr  r3, [sp, #24]      \n"   /* r3 = 参数  （帧内偏移 4 + 20） */
        "ldr  r12, =g_sys_last_no \n"
        "str  r5, [r12]          \n"
        "ldr  r12, =g_sys_last_arg\n"
        "str  r3, [r12]          \n"

        /*
         * 记录"应用被拦截时的特权态"。
         *
         * 判据放在异常帧的 xPSR（偏移 28）里：bit9 = SPSEL，
         * 而【特权状态】由 CONTROL.nPRIV 决定 —— xPSR 不含 nPRIV。
         * 所以这里改为直接记录栈帧里的 xPSR 与当前 CONTROL，
         * 两者一起由 SWD 读出后人工判读，避免再被"寄存器转手"误导。
         */
        "ldr  r12, [sp, #48]     \n"   /* 栈帧里的 xPSR（28 + 20） */
        "ldr  r3, =g_sys_app_xpsr \n"
        "str  r12, [r3]          \n"

        /* 分派：这里刻意用最简单的比较，方便阅读 */
        "cmp  r5, #0             \n"   /* SYS_NOP */
        "beq  1f                 \n"
        "cmp  r5, #1             \n"   /* SYS_GET_TICK */
        "beq  2f                 \n"
        "cmp  r5, #2             \n"   /* SYS_WRITE_STR */
        "beq  3f                 \n"
        "cmp  r5, #4             \n"   /* SYS_EXIT */
        "beq  7f                 \n"
        "b    4f                 \n"   /* 其它一律拒绝 */

        "1:                      \n"   /* SYS_NOP：返回 0x600D */
        "ldr  r0, =0x600D        \n"
        "b    5f                 \n"

        "2:                      \n"   /* SYS_GET_TICK：读 SysTick 计数 */
        "ldr  r12, =0xE000E018   \n"
        "ldr  r0, [r12]          \n"
        "b    5f                 \n"

        "3:                      \n"   /* SYS_WRITE_STR：内核代为打印 */
        "mov  r0, r3             \n"
        "bl   kernel_puts        \n"
        "movs r0, #0             \n"
        "b    5f                 \n"

        "7:                      \n"   /* SYS_EXIT：把线程模式切回特权态 */
        /*
         * ⭐ 这是整个机制的关键一步。
         *
         * 为什么必须在【处理程序内】做：
         *   msr CONTROL 是特权指令，应用在非特权态自己执行会立刻触发故障
         *   （实测：HardFault，PC 停在 mrs r0, CONTROL 之后）。
         *   所以这件事只能由内核代做。而 nPRIV 跨异常返回原样保留，
         *   处理程序退出时 CONTROL.nPRIV 是什么，线程返回后就是什么。
         *   若等返回后再去改 CONTROL，那条指令自己就会触发故障
         *   （实测：HardFault，PC 停在 mrs r0, CONTROL 之后）。
         *
         *   处理程序必然运行在特权态，此刻改 CONTROL 一定成功，
         *   而且它只影响"线程模式恢复时用什么状态"，正是我们要的。
         *
         * ⚠️ 这里【不需要】动 SPSEL，也不需要改栈帧里的 PC。
         *
         *   本演示让应用与内核共用 MSP（SPSEL 全程为 0），所以
         *   "返回地址在哪个栈"这个问题根本不存在。
         *   以前那段"把栈帧 PC 改成内核续跑标签"的说明对应的是
         *   已经删掉的 MSP/PSP 切换方案，别再照它改代码。
         *
         *   nPRIV=0 → 线程模式恢复后是特权态（内核重新掌权）
         */
        /*
         * ⭐ 正确做法：清【处理程序自己的】CONTROL.nPRIV。
         *
         * ── 一条被证伪的旧结论（务必读，别再改回去）──
         *
         * 曾改成"改栈帧 xPSR 的 bit0"，理由是"异常返回后线程的特权态由
         * 栈帧里的 xPSR 恢复，处理程序自己的 CONTROL 不参与恢复"。
         *
         * 这条是【错的】，而且错得很隐蔽：
         *   xPSR 的 bit[8:0] 是 IPSR（异常号）。Thread 模式的 IPSR 恒为 0，
         *   所以那块栈帧里 xPSR 的 bit0 本来就已经是 0，bic 掉它什么也没改。
         *   也就是说，那次"修复"是一个【无操作】，自然也不会有任何效果。
         *
         * 实际机制：CONTROL.nPRIV 跨异常进入/返回【原样保留】。
         *   异常进入不改它（Handler 模式本来就必然特权，无需改），
         *   异常返回也不改它 —— 线程回到 Thread 模式时用的就是
         *   处理程序退出时的那个值。所以在这里清 0，线程返回后即特权态。
         *
         * 判据不是推理，是第 18 轮探针的实测：见 g_probe_ctrl[0..3]。
         */
        "mrs  r2, control        \n"   /* 读处理程序的 CONTROL */
        "bic  r2, r2, #1         \n"   /* 清 nPRIV：线程返回后即特权态 */
        "msr  control, r2        \n"
        "isb                     \n"
        "movs r0, #0             \n"
        "b    5f                 \n"

        "4:                      \n"   /* 拒绝：只加拒绝计数，再加受理计数 */
        "ldr  r12, =g_sys_denied \n"
        "ldr  r2, [r12]          \n"
        "adds r2, r2, #1         \n"
        "str  r2, [r12]          \n"
        "ldr  r0, =0xBAD         \n"
        "b    6f                 \n"

        "5:                      \n"   /* 成功路径：受理计数 +1 */
        "ldr  r12, =g_sys_calls  \n"
        "ldr  r2, [r12]          \n"
        "adds r2, r2, #1         \n"
        "str  r2, [r12]          \n"
        "6:                      \n"
        "ldr  r12, =g_sys_result \n"
        "str  r0, [r12]          \n"

        /* 把返回值写回异常栈帧里的 R0（帧内偏移 0 → 栈上偏移 20）。
         * 异常返回时硬件会用它恢复应用的 r0，所以这就是"内核回传返回值"。 */
        "str  r0, [sp, #20]      \n"

        /*
         * ⭐ 返回必须用 EXC_RETURN 做【一次】异常返回。
         *
         * 曾经写错成"从栈帧取 PC 再 bx 过去"：
         *     ldr r0, [sp, #24]
         *     orr r0, r0, #1
         *     bx  r0
         * 结果是应用第二次 SVC 就 HardFault。
         *
         * 第 17 轮的对比实验给出了明确答案：改成显式 EXC_RETURN 之后，
         * 整条链路立刻通了 —— 应用连发两次调用都收到正确返回值，CFSR = 0。
         *
         * 中途的 bl kernel_puts 会破坏 lr，所以不能靠 lr，
         * 这里重新把常量装进寄存器。
         */
        "pop  {r4, r5, r6, r7, lr} \n"   /* 还回被中断代码的 r4-r7（见函数开头） */
        "ldr  r1, =0xFFFFFFF9    \n"   /* EXC_RETURN: 回 Thread 模式, 用 MSP */
        "bx   r1                 \n"
        ".ltorg                  \n"
        :
        :
        : "memory"
    );
}

/*
 * 应用侧系统调用封装。
 *
 * 应用只能通过这三个函数请求服务 —— 它拿不到任何外设寄存器，
 * 也碰不到内核内存。这就是"内核掌权"的体现。
 */
static inline uint32_t sys_nop(void) {
    register uint32_t r0 __asm__("r0") = SYS_NOP;
    register uint32_t r1 __asm__("r1") = 0;
    __asm volatile ("svc #0" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

static inline uint32_t sys_get_tick(void) {
    register uint32_t r0 __asm__("r0") = SYS_GET_TICK;
    register uint32_t r1 __asm__("r1") = 0;
    __asm volatile ("svc #0" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

static inline uint32_t sys_write_str(const char *s) {
    register uint32_t r0 __asm__("r0") = SYS_WRITE_STR;
    register uint32_t r1 __asm__("r1") = (uint32_t)s;
    __asm volatile ("svc #0" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

static inline uint32_t sys_deny(void) {
    register uint32_t r0 __asm__("r0") = SYS_DENY;
    register uint32_t r1 __asm__("r1") = 0;
    __asm volatile ("svc #0" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

/*
 * 请求内核把线程模式切回【特权态 + MSP】。
 *
 * 为什么必须由内核代做：msr CONTROL 是特权指令。
 * 应用处于非特权态，自己执行它只会触发故障。
 * 而 SVC 处理程序必然运行在特权态，且它改 CONTROL 只影响
 * "异常返回后线程模式用什么状态"，正好用来完成这次切换。
 */
static inline uint32_t sys_exit(void) {
    register uint32_t r0 __asm__("r0") = SYS_EXIT;
    register uint32_t r1 __asm__("r1") = 0;
    __asm volatile ("svc #0" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

/*
 * ============================================================================
 * 系统调用演示
 * ============================================================================
 *
 * 设计取舍（务必先读）：
 *
 *   应用与内核【共用 MSP】，只切换 nPRIV，不切 SPSEL。
 *
 *   为什么这样选：RP2350 上实测，"线程栈在 MSP/PSP 之间来回切 +
 *   特权态切换 + SVC 返回"这组操作的组合行为很不稳定 ——
 *   连续 5 轮都出现返回地址取错栈、PC 落到自旋标签、SP 变成 0xF0000000
 *   这类现象。根因尚未完全定论，但工程上不能再耗在这里。
 *
 *   共用 MSP 后：函数返回地址、异常栈帧、SVC 参数全都在同一个栈上，
 *   不存在"返回地址在哪个栈"的问题，行为完全确定。
 *
 *   代价：应用与内核共用栈，隔离性弱于"内核 MSP + 应用 PSP"的经典方案。
 *   做真正的多应用调度时应当给每个任务独立 PSP —— 那属于调度器的活。
 *
 * 内核仍然掌握一切：应用只能通过 SVC 递上"调用号 + 参数"，
 * 外设与内核内存都不向应用开放。
 */

/* 内核代打印 —— 特权态才能碰 UART/USB 外设。
 * 演示阶段暂不启用（USB printf 在无主机时会在 fflush 里出错），
 * 结果一律写全局变量供 SWD 读取，避免外设干扰。 */
void kernel_puts(const char *s) {
    (void)s;
}

/*
 * 应用主体：以【非特权态】运行。
 *
 * 这里是普通 C 函数，用普通的内联 SVC 封装发请求 ——
 * 因为共用 MSP，返回地址天然正确，不需要任何花招。
 */
__attribute__((noinline))
static void app_main_svc(void) {
    /*
     * 演示用的服务集【刻意只用纯寄存器操作】。
     *
     * 踩过的坑：一开始还调了 "内核代打印字符串" 和 "取 SysTick"，
     * 结果第二个 SVC 就 HardFault（crash_info PC 指向 app_main_svc 内
     * 偏移 0x76C+9 处）。涉及字符串指针/外设的服务还牵涉更多约束，
     * 本阶段先不引入 —— 目标是把"应用经 SVC 请求内核"这条骨架坐实。
     */
    g_sys_result = sys_nop();       /* 服务号 0：内核返回 0x600D */
    sys_get_tick();                 /* 服务号 1：内核代读 SysTick 并写回 */
    sys_deny();                     /* 服务号 3：未定义 → 内核必须拒绝 */
}

void kernel_syscall_demo(void) {
    g_sys_calls = 0;
    g_sys_denied = 0;
    g_sys_result = 0;
    g_sys_last_no = 0;
    g_sys_last_arg = 0;
    g_sys_psp_seen = 0;
    g_sys_msp_seen = 0;

    /* 探针清零，并用 0xEE 做哨兵：读回 0xEE 说明采样点根本没执行到 */
    g_probe_svc_n = 0;
    for (int i = 0; i < 8; i++) g_probe_ctrl[i] = 0xEEu;
    g_probe_mpu_type = 0xEEu;
    kernel_mark(99);

    /*
     * 只切 nPRIV，不动 SPSEL —— 应用仍在 MSP 上跑。
     * 这样 SVC 的异常栈帧与函数返回地址全都在同一个栈上，
     * 不存在取错栈的风险。
     */
    kernel_mark(100);
    g_probe_ctrl[1] = kernel_read_control();   /* 设 nPRIV 之前：应 0（特权） */

    __asm volatile (
        "mrs  r0, control    \n"
        "orr  r0, r0, #1     \n"   /* nPRIV=1（非特权）；SPSEL 保持 0 */
        "msr  control, r0    \n"
        "isb                 \n"
        :
        :
        : "r0", "memory"
    );

    kernel_mark(101);
    app_main_svc();
    kernel_mark(102);
    g_probe_ctrl[2] = kernel_read_control();   /* 3 次 SVC 后、SYS_EXIT 前 */
    kernel_mark(103);

    /*
     * 回来了，但此刻仍是【非特权态】。
     *
     * msr CONTROL 是特权指令，直接在这里改它会触发故障
     * （实测：HardFault，PC 停在 mrs r0, CONTROL 之后）。
     * 所以必须由内核代做：调一次 SYS_EXIT，处理程序清掉 nPRIV，
     * 异常返回后线程模式就是特权态了。
     */
    sys_exit();
    kernel_mark(104);
    g_probe_ctrl[3] = kernel_read_control();   /* SYS_EXIT 之后：应 0（特权） */
    kernel_mark(105);

    /*
     * 行为验证：MPU_TYPE（0xE000ED90）是特权只读寄存器。
     *   特权态读得到区域数（非 0）；非特权态读得 0。
     * 这是对 CONTROL 读数的【交叉验证】—— 不再只信一个来源，
     * 本项目被单一读数误导过太多次。
     */
    g_probe_mpu_type = *(volatile uint32_t *)0xE000ED90u;
    kernel_mark(106);

    /* 已回到特权态，可以安全写标记 */
    g_sys_done_magic = 0x5AFE0001u;
    kernel_mark(107);
}

void kernel_minimal_selftest(void) {
    pico_kernel_selftest_status = 0;
    pico_kernel_selftest_faults = 0;
    pico_kernel_selftest_addr = 0;
}
