#ifndef KERNEL_MEM_H
#define KERNEL_MEM_H

/*
 * 内核内存管理器（kernel_mem）
 *
 * ── 为什么用"二叉伙伴分配器"（binary buddy allocator）而不是 malloc ──
 *
 * 因为本项目的内存要交给 MPU（内存保护单元）去隔离：
 *
 *   MPU 的每个保护区域都要求【大小是 2 的幂】且【基址按大小对齐】
 *   （ARMv8-M 的 MPU_RBAR / MPU_RLAR 就是这么规定的）。
 *
 * 伙伴分配器天生满足这两条：任何一次分配拿到的块，大小一定是 2 的幂、
 * 地址一定按该大小对齐。于是"分配内存"和"配置 MPU 区域"可以一步到位，
 * 不需要再打补丁凑对齐。
 *
 * 代价：内部碎片最多接近 2 倍（要 257 字节会拿到 512 字节）。
 * 对本项目（应用、帧缓冲、栈）完全可以接受，换来的是"永远不会分错对齐"。
 *
 * ── 和 SDK 的 malloc 什么关系 ──
 *
 * 没关系。SDK 的 malloc 用的是链接脚本里那 2KB 的 .heap，只够 printf 之类
 * 内部零用。内核内存管理器自己从 .bss 里划走一大块静态内存当"竞技场"，
 * 见 kernel_mem.c 里的 g_sram_arena。
 */

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* 最小块 = 2^4 = 16 字节。选 16 而不是 8：
 * 空闲块内部要放一个 next 指针（4 字节），16 字节留足余量。 */
#define KMEM_MIN_SHIFT   4u
/* 最大支持到 2^23 = 8 MiB，正好覆盖整块 PSRAM */
#define KMEM_MAX_ORDERS  24u

typedef struct kmem_block {
    struct kmem_block *next;   /* 空闲时借用块本身存链表指针 */
} kmem_block_t;

typedef struct kmem_pool {
    const char   *name;
    uint8_t      *base;
    size_t        size;        /* 必须是 2 的幂 */
    uint8_t       max_order;   /* log2(size) */
    uint8_t       in_use;      /* 1 = 池子已就绪可用 */
    uint8_t       _pad[2];
    size_t        free_bytes;
    size_t        used_bytes;
    size_t        peak_used;
    uint32_t      alloc_count;
    uint32_t      fail_count;
    kmem_block_t *free_list[KMEM_MAX_ORDERS];
} kmem_pool_t;

/*
 * 要不要把 PSRAM 当成可分配内存池。
 *
 * 【默认 0，是有意的，不是忘了打开。】
 *
 * 实测（见 docs/实测数据.md「PSRAM」一节）：本板 PSRAM "能检测到 8 MiB，
 * 但连续写入会挂死"——16 B 通过，256 B 挂死。
 *
 * ⚠️ 这里曾经写着"高度怀疑芯片根本没焊、是自动检测假阳性"。
 *    那个假设【已被实测推翻】：芯片确实在 GPIO47 上
 *    （KGD=0x5D、EID=0x46、8 MiB；候选脚 {0,8,19} 上没人答话）。
 *    ⇒ 关掉池子的理由是"连续写入挂死"这个**已实测的事实**，
 *      不是"怀疑芯片不在"。别再引用那个已作废的假设。
 *
 * 在查清挂死原因之前绝不把它交给分配器：一个会让整片挂死的地址，
 * 比"少 8MB 内存"糟糕得多。
 *
 * 打开的条件（缺一不可）：
 *   1. 连续写入不再挂死（最强假设：QMI max_select 超过这颗的 tCEM，未验证）；
 *   2. PSRAM 时序与当前系统时钟对得上（规范 8：改主频会让 QMI 时序失准）。
 */
#ifndef KMEM_ENABLE_PSRAM
#define KMEM_ENABLE_PSRAM 0
#endif

/* 两个池子：片上 SRAM 和外挂 PSRAM */
extern kmem_pool_t g_pool_sram;
extern kmem_pool_t g_pool_psram;

/*
 * 竞技场实际拿到的大小（字节）。
 * 因为静态数组只保证 4KB 对齐，而伙伴分配器要求"基址按池子大小对齐"，
 * 所以实际大小可能是 256KB 也可能是 128KB（见 kernel_mem.c 的 arena_fit）。
 * SWD 读这个值就知道到底拿到了多少。
 */
extern volatile uint32_t g_kmem_sram_arena_size;

/* ── 初始化 ── */

/* 初始化全部内存池（SRAM 一定可用；PSRAM 视检测与安全验证结果而定） */
void kmem_init_all(void);

/* 初始化单个池。base 必须按 size 对齐，size 必须是 2 的幂 */
bool kmem_pool_init(kmem_pool_t *p, const char *name, void *base, size_t size);

/* ── 分配 / 释放 ── */

/*
 * 把请求大小向上取到 2 的幂（不足 16 按 16）。
 * 这个函数【会被应用看到】：应用申请内存时要能预先知道会拿到多大的块。
 */
size_t kmem_block_size(size_t want);

/* 求某个大小对应的阶（= log2(块大小)）。配 MPU 时直接用这个值算区域大小。 */
uint8_t kmem_order_of_size(size_t size);

/*
 * 分配。返回的块大小是 2 的幂、地址按该大小对齐。
 * got_size 非空时回填【实际拿到的块大小】——释放时必须用这个值。
 */
void *kmem_alloc(kmem_pool_t *p, size_t want, size_t *got_size);

/* 释放。size 必须与分配时 got_size 回填的值一致。 */
void kmem_free(kmem_pool_t *p, void *ptr, size_t size);

/* ── PSRAM 探测结果（给 SWD 读）── */

#define KMEM_PSRAM_BASE  0x11000000u

extern volatile uint32_t g_kmem_psram_detected;   /* SDK 报出有 PSRAM */
extern volatile uint32_t g_kmem_psram_size;       /* 报出的字节数 */
extern volatile uint32_t g_kmem_psram_ok;         /* 安全验证通过、池子已放开 */
extern volatile uint32_t g_kmem_psram_probe_val;  /* 单字写读回的值（应 0x5A5A1234） */

/* ── 自检 ── */

/*
 * 自检结果（全部是普通内存变量，SWD 直接读，不依赖串口）：
 *   g_kmem_selftest_status   1 = 全部通过
 *   g_kmem_selftest_steps    一共跑完了几步（用于确认"跑到了"而不是"跳过了"）
 *   g_kmem_selftest_fail_at  第一个失败的步号（0 = 没有失败）
 */
extern volatile uint32_t g_kmem_selftest_status;
extern volatile uint32_t g_kmem_selftest_steps;
extern volatile uint32_t g_kmem_selftest_fail_at;

void kmem_selftest(void);

#ifdef __cplusplus
}
#endif

#endif /* KERNEL_MEM_H */
