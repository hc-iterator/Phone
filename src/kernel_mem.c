/*
 * kernel_mem.c —— 内核内存管理器（二叉伙伴分配器）
 *
 * 设计理由见 kernel_mem.h 顶部注释。这里只强调一句：
 * 【本文件里没有任何 printf】。
 * 所有结论都写进普通内存变量，由 SWD 直接读 —— 理由和内核自检一样：
 * 串口在启动早期不可靠（USB 主机可能没接上），而内存变量永远能读。
 *
 * ── 为什么 PSRAM 池默认关着 ──
 *
 * 实测事实（见 小本本.md「PSRAM」一节）：
 *   本板 PSRAM「能检测到 8 MiB，但连续写入会挂死」——16 B 通过，256 B 挂死。
 *
 * ⚠️ 这里曾经写着"高度怀疑芯片根本没焊、是自动检测假阳性"。
 *    那个假设【已被实测推翻】：芯片确实在 GPIO47 上
 *    （KGD=0x5D、EID=0x46、8 MiB；候选脚 {0,8,19} 上没人答话）。
 *    ⇒ 关掉池子的理由是"连续写入挂死"这个**已实测的事实**。
 *    （这个已作废的假设曾经从本文件抄进两份分析报告，
 *      见 错题本-判断 陷阱 1 —— 所以把结论留在这里说清楚。）
 *
 * 在查清挂死原因之前，【绝不能】把一个"会让整片挂死"的内存交给分配器，
 * 所以 KMEM_ENABLE_PSRAM 默认 0。注意：SDK 自己在 runtime init 时就已经
 * 配置过 PSRAM 了，本文件开关只控制"我们要不要把它当内存池用"。
 */

#include "kernel_mem.h"

#include <string.h>

#include "pico/stdlib.h"
#include "hardware/psram.h"

/* ===========================================================================
 * 编译期属性兼容（GCC/Clang 与 MSVC）
 * ===========================================================================
 *
 * 为什么要这一块：MSVC **不认** __attribute__，而且是硬报错
 * （实测 error C2059 / C2143），不是"忽略未知属性"。
 * 于是本文件没法编进主机侧自检（tools/host_test/），
 * 而那 24 步自检恰恰是纯逻辑、最该在主机侧跑的东西
 * —— 板子够不着的时候，主机侧是唯一的验证手段（规范 5b）。
 *
 * 做法：只在 MSVC 分支换成 __declspec 等价写法。
 *
 * ⚠️ 两家的位置不一样，所以把 static 一起收进宏，让两个分支都写成
 *    纯前缀形态（宏放在类型前面）：
 *     GCC  →  static __attribute__((aligned(N))) uint8_t x[];
 *     MSVC →  static __declspec(align(N))        uint8_t x[];
 *   两种都是各自的标准写法。
 *   （实测：MSVC 下把 __declspec 放到变量名后面会报
 *     error C2054 "在 g_sram_arena_raw 之后应输入 (" ）
 *
 * ⚠️ 已实测验证（2026-10-01，本机两条编译器都跑过）：
 *   · MSVC 分支 —— MSVC 2022 Community，tools/host_test/build_kmem.cmd
 *     24 步自检全通过（含"分配块 4KB 对齐"那几步）。
 *   · GCC 分支 —— 真实 arm-none-eabi-gcc 13_3_Rel1，只编译不链接：
 *       _Static_assert(_Alignof(x) == 4096) 原句/新句都成立；
 *       nm 显示 g_sram_arena_raw 落在 0x1000（=4096 对齐）、大小 0x50000。
 *     ⇒ 属性"前置"与"后置"在 GCC 下语义相同（GCC 文档允许属性写在声明符前）。
 *
 * MSVC 的上限：__declspec(align(N)) 只保证到 8192；本文件用 4096，够。
 */
#if defined(_MSC_VER)
#  define KMEM_STATIC_ALIGNED(N)   static __declspec(align(N))
#else
#  define KMEM_STATIC_ALIGNED(N)   static __attribute__((aligned(N)))
#endif

/* ===========================================================================
 * 竞技场（arena）
 * ===========================================================================
 *
 * 为什么用"静态大数组"从 .bss 里划，而不是改链接脚本：
 *   1. 不用动 SDK 的链接脚本，换 SDK 版本也不会失效；
 *   2. 对齐是数组属性，直接满足 MPU 区域的对齐要求；
 *   3. 装不下时编译器/链接器会当场报错，不会悄悄跑偏。
 *
 * 为什么要"按实际对齐缩到合适的 2 的幂"：
 *   伙伴分配器靠"伙伴地址 = 本块地址 XOR 块大小"来找伙伴，
 *   这要求【池子基址按池子大小对齐】。而静态数组只保证 4KB 对齐，
 *   256KB 的池子未必落在 256KB 边界上。
 *   所以下面 arena_fit() 会先试 256KB，不行就退到 128KB，
 *   并把最终拿到的大小记进 g_kmem_sram_arena_size 供 SWD 读出。
 *   —— 宁可池子小一半，也不要一个"看起来能用、一合并就出错"的分配器。
 */
#define KMEM_ARENA_CAPACITY (224u * 1024u)  /* 原 320KB：腾 96KB 给 320x480 帧缓冲（去掉纵向复制实验）*/

KMEM_STATIC_ALIGNED(4096) uint8_t g_sram_arena_raw[KMEM_ARENA_CAPACITY];

kmem_pool_t g_pool_sram;
kmem_pool_t g_pool_psram;

/* 顶部那个"竞技场实际拿到多大"的诊断值 */
volatile uint32_t g_kmem_sram_arena_size = 0;

/* PSRAM 诊断值 */
volatile uint32_t g_kmem_psram_detected = 0;
volatile uint32_t g_kmem_psram_size = 0;
volatile uint32_t g_kmem_psram_ok = 0;
volatile uint32_t g_kmem_psram_probe_val = 0;

/* 自检结果 */
volatile uint32_t g_kmem_selftest_status = 0;
volatile uint32_t g_kmem_selftest_steps = 0;
volatile uint32_t g_kmem_selftest_fail_at = 0;

/* ===========================================================================
 * 小工具
 * =========================================================================== */

static inline bool is_pow2(size_t v) { return v != 0 && (v & (v - 1u)) == 0; }

static inline uint8_t log2u(size_t v) {
    uint8_t n = 0;
    while (v > 1u) { v >>= 1; n++; }
    return n;
}

size_t kmem_block_size(size_t want) {
    if (want < ((size_t)1u << KMEM_MIN_SHIFT)) {
        want = (size_t)1u << KMEM_MIN_SHIFT;
    }
    size_t s = (size_t)1u << KMEM_MIN_SHIFT;
    while (s < want) s <<= 1;
    return s;
}

uint8_t kmem_order_of_size(size_t size) {
    uint8_t o = (uint8_t)KMEM_MIN_SHIFT;
    while (((size_t)1u << o) < size) o++;
    return o;
}

/*
 * 在 [start, start+cap) 里找一块"大小是 2 的幂、且基址按该大小对齐"的区域。
 * 从最大的 2 的幂开始试，不行就减半。返回 NULL 表示连最小块都放不下。
 */
static void *arena_fit(void *start, size_t cap, size_t min_size, size_t *out_size) {
    uintptr_t s0 = (uintptr_t)start;
    size_t s = (size_t)1u << log2u(cap);      /* <= cap 的最大 2 的幂 */
    while (s >= min_size) {
        uintptr_t a = (s0 + (uintptr_t)(s - 1u)) & ~(uintptr_t)(s - 1u);
        if (a + s <= s0 + cap) {
            *out_size = s;
            return (void *)a;
        }
        s >>= 1;
    }
    *out_size = 0;
    return NULL;
}

/* ===========================================================================
 * 池子初始化 / 分配 / 释放
 * =========================================================================== */

bool kmem_pool_init(kmem_pool_t *p, const char *name, void *base, size_t size) {
    if (p == NULL || base == NULL) return false;
    if (!is_pow2(size) || size < ((size_t)1u << KMEM_MIN_SHIFT)) return false;
    /* 基址必须按池子大小对齐，否则 XOR 找伙伴会算到池子外面去 */
    if (((uintptr_t)base & (uintptr_t)(size - 1u)) != 0) return false;
    if (log2u(size) >= KMEM_MAX_ORDERS) return false;

    memset(p, 0, sizeof(*p));
    p->name      = name;
    p->base      = (uint8_t *)base;
    p->size      = size;
    p->max_order = log2u(size);
    p->in_use    = 1;
    p->free_bytes = size;

    /* 整个池子作为"最大阶"的一个空闲块挂上去 */
    kmem_block_t *b = (kmem_block_t *)base;
    b->next = NULL;
    p->free_list[p->max_order] = b;

    /* 把这块内存里的链表指针之外的部分当作未初始化 —— 不 memset，
     * 因为 memset 一个 256KB 的池子会白白花掉启动时间，
     * 而且分配器只信任自己写的链表指针。 */
    return true;
}

void *kmem_alloc(kmem_pool_t *p, size_t want, size_t *got_size) {
    if (p == NULL || !p->in_use || want == 0) return NULL;

    uint8_t o = kmem_order_of_size(want);
    if (o > p->max_order) { p->fail_count++; return NULL; }

    /* 找最小的、装得下的空闲块 */
    int i = o;
    while (i <= (int)p->max_order && p->free_list[i] == NULL) i++;
    if (i > (int)p->max_order) { p->fail_count++; return NULL; }

    kmem_block_t *b = p->free_list[i];
    p->free_list[i] = b->next;

    /* 从 i 阶一路裂到 o 阶：每一级把"后半块"挂到该阶的空闲链表 */
    while (i > (int)o) {
        i--;
        kmem_block_t *buddy = (kmem_block_t *)((uint8_t *)b + ((size_t)1u << i));
        buddy->next = p->free_list[i];
        p->free_list[i] = buddy;
    }

    size_t sz = (size_t)1u << o;
    if (p->free_bytes >= sz) p->free_bytes -= sz;
    p->used_bytes += sz;
    if (p->used_bytes > p->peak_used) p->peak_used = p->used_bytes;
    p->alloc_count++;

    if (got_size) *got_size = sz;
    return b;
}

void kmem_free(kmem_pool_t *p, void *ptr, size_t size) {
    if (p == NULL || !p->in_use || ptr == NULL) return;

    const size_t orig = kmem_block_size(size);
    const uint8_t o0 = kmem_order_of_size(orig);
    if (o0 > p->max_order) return;
    /* 不是合法块起点就拒绝 —— 宁可泄漏也不要破坏堆 */
    if (((uintptr_t)ptr & (orig - 1u)) != 0) return;

    const uintptr_t base = (uintptr_t)p->base;
    const uintptr_t end  = base + p->size;

    kmem_block_t *b = (kmem_block_t *)ptr;
    uint8_t o = o0;
    size_t  sz = orig;

    /* 逐级向上与伙伴合并 */
    while (o < p->max_order) {
        uintptr_t want = (uintptr_t)b ^ (uintptr_t)sz;   /* 同阶伙伴 = 地址异或大小 */
        if (want < base || want + sz > end) break;

        /* 伙伴必须真的在本阶空闲链表里 */
        kmem_block_t **pp = &p->free_list[o];
        while (*pp != NULL && (uintptr_t)*pp != want) pp = &(*pp)->next;
        if (*pp == NULL) break;                          /* 伙伴被占着，不能合并 */

        *pp = (*pp)->next;                               /* 把伙伴摘下来 */
        if (want < (uintptr_t)b) b = (kmem_block_t *)want;   /* 取地址小的那个 */
        o++;
        sz <<= 1;
    }

    b->next = p->free_list[o];
    p->free_list[o] = b;

    p->free_bytes += orig;
    if (p->used_bytes >= orig) p->used_bytes -= orig; else p->used_bytes = 0;
}

/* ===========================================================================
 * 初始化全部池子
 * =========================================================================== */

void kmem_init_all(void) {
    /* ── SRAM ── */
    size_t got = 0;
    void *arena = arena_fit(g_sram_arena_raw, sizeof(g_sram_arena_raw),
                            (size_t)64u * 1024u, &got);
    g_kmem_sram_arena_size = (uint32_t)got;
    if (arena != NULL) {
        if (!kmem_pool_init(&g_pool_sram, "SRAM", arena, got)) {
            g_kmem_sram_arena_size = 0;
        }
    }

    /* ── PSRAM ──
     *
     * 只做【只读】记录：SDK 说有没有、多大。
     * 不写任何一个字节，因为"连续写会挂死"这件事还没查清，
     * 而这是启动路径 —— 绝不能因为内存探测把板子卡在开机。
     */
    if (psram_is_available()) {
        g_kmem_psram_detected = 1;
        g_kmem_psram_size = (uint32_t)psram_get_size();
    } else {
        g_kmem_psram_detected = 0;
        g_kmem_psram_size = 0;
    }

#if KMEM_ENABLE_PSRAM
    /*
     * 只有明确证实"芯片真的在、而且连续读写没问题"之后，才打开这个分支。
     * 打开前请先跑 tools 里的 PSRAM 诊断，确认：
     *   1) SDK 认的片选和实际焊芯片的脚一致；
     *   2) 连续 4 KiB 写入不再挂死。
     */
    if (g_kmem_psram_detected && g_kmem_psram_size != 0 &&
        is_pow2(g_kmem_psram_size)) {
        if (kmem_pool_init(&g_pool_psram, "PSRAM",
                           (void *)(uintptr_t)KMEM_PSRAM_BASE,
                           (size_t)g_kmem_psram_size)) {
            g_kmem_psram_ok = 1;
        }
    }
#else
    /* 默认关闭：把 PSRAM 池显式标成"不可用"，
     * 这样任何误用 kmem_alloc(&g_pool_psram, ...) 都会安全地返回 NULL，
     * 而不是踩进一个可能挂死的地址。 */
    g_pool_psram.in_use = 0;
    g_pool_psram.name = "PSRAM(disabled)";
    g_kmem_psram_ok = 0;
#endif
}

/* ===========================================================================
 * 自检
 * ===========================================================================
 *
 * 目标：证明这个分配器【真的能用来放东西】并且【不会把内存分错】。
 * 只测 SRAM 池（PSRAM 默认关着）。
 * 结果全部落进 g_kmem_selftest_*，SWD 直接读。
 */

#define KMEM_ST_OK(cond)                                                  \
    do {                                                                  \
        step++;                                                           \
        g_kmem_selftest_steps = step;                                     \
        if (!(cond)) {                                                    \
            g_kmem_selftest_fail_at = step;                               \
            g_kmem_selftest_status = 0;                                   \
            return;                                                       \
        }                                                                 \
    } while (0)

void kmem_selftest(void) {
    uint32_t step = 0;
    g_kmem_selftest_status  = 0;
    g_kmem_selftest_fail_at = 0;

    kmem_pool_t *p = &g_pool_sram;

    /* 1. 池子就绪，且一开始全空 */
    KMEM_ST_OK(p->in_use == 1);
    KMEM_ST_OK(p->free_bytes == p->size);
    KMEM_ST_OK(p->used_bytes == 0);

    /* 2. 要 100 字节 → 应该拿到 128 字节，且 128 字节对齐 */
    size_t got = 0;
    void *a = kmem_alloc(p, 100, &got);
    KMEM_ST_OK(a != NULL);
    KMEM_ST_OK(got == 128);
    KMEM_ST_OK(((uintptr_t)a & 127u) == 0);

    /* 3. 要 4KB → 4KB 对齐（MPU 区域能直接用） */
    void *b = kmem_alloc(p, 4096, &got);
    KMEM_ST_OK(b != NULL);
    KMEM_ST_OK(got == 4096);
    KMEM_ST_OK(((uintptr_t)b & 4095u) == 0);

    /* 4. 两块不能重叠 */
    {
        uintptr_t a0 = (uintptr_t)a, a1 = a0 + 128;
        uintptr_t b0 = (uintptr_t)b, b1 = b0 + 4096;
        KMEM_ST_OK(a1 <= b0 || b1 <= a0);
    }

    /* 5. 那块 4KB 真的能存住数据（写满再读回） */
    {
        uint8_t *q = (uint8_t *)b;
        for (size_t i = 0; i < 4096; i++) q[i] = (uint8_t)(i * 7u);
        for (size_t i = 0; i < 4096; i++) {
            if (q[i] != (uint8_t)(i * 7u)) { KMEM_ST_OK(0); }
        }
        KMEM_ST_OK(1);
    }

    /* 6. 释放后能原样再拿到同一地址（伙伴合并生效） */
    KMEM_ST_OK(p->alloc_count == 2);
    kmem_free(p, b, 4096);
    void *b2 = kmem_alloc(p, 4096, &got);
    KMEM_ST_OK(b2 == b);

    /* 7. 全部释放，空闲应当回到初始值（说明彻底合并回一整块） */
    kmem_free(p, b2, 4096);
    kmem_free(p, a, 128);
    KMEM_ST_OK(p->free_bytes == p->size);
    KMEM_ST_OK(p->used_bytes == 0);

    /* 8. 能拿到【整个池子】—— 这是"完全合并成功"的强证据。
     *    如果合并有 bug，这里就会拿不到而返回 NULL。 */
    void *whole = kmem_alloc(p, p->size, &got);
    KMEM_ST_OK(whole == (void *)p->base);
    KMEM_ST_OK(got == p->size);

    /* 9. 池子被占满时，再要一小块应当【干净地失败】而不是越界 */
    KMEM_ST_OK(kmem_alloc(p, 16, &got) == NULL);

    /* 10. 还回去，重新空 */
    kmem_free(p, whole, p->size);
    KMEM_ST_OK(p->free_bytes == p->size);

    /* 11. 最后做一次"碎片压力"：交替申请不同大小再全放，
     *     确认还能拿回整块。 */
    {
        void *v[16];
        size_t n = 0;
        static const size_t sizes[8] = { 64, 512, 4096, 32, 8192, 128, 2048, 1024 };
        for (int i = 0; i < 16; i++) {
            v[n] = kmem_alloc(p, sizes[i % 8], &got);
            if (v[n] == NULL) break;
            n++;
        }
        KMEM_ST_OK(n == 16);
        for (size_t i = 0; i < n; i++) {
            kmem_free(p, v[i], kmem_block_size(sizes[i % 8]));
        }
        KMEM_ST_OK(p->free_bytes == p->size);
        void *whole2 = kmem_alloc(p, p->size, &got);
        KMEM_ST_OK(whole2 == (void *)p->base);
        kmem_free(p, whole2, p->size);
    }

    /* 12. PSRAM 池在默认配置下必须是"不可用"的
     *     （否则就是把一块会挂死的内存交出去了） */
#if !KMEM_ENABLE_PSRAM
    KMEM_ST_OK(g_pool_psram.in_use == 0);
    KMEM_ST_OK(kmem_alloc(&g_pool_psram, 16, &got) == NULL);
#endif

    g_kmem_selftest_status = 1;
}

#undef KMEM_ST_OK
