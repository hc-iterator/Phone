#ifndef KERNEL_RES_H
#define KERNEL_RES_H

/*
 * 内核资源登记表（kernel_res）
 *
 * ── 这是整个"内核掌握所有外延权限"的账本 ──
 *
 * 用户最初给这个项目定的中心思想是：
 *   "内核掌握所有外延（屏幕啊蓝牙啊内存啊）的权限，通过系统 API 分发出去。"
 *
 * 那张"权限"要落地，第一步不是拦，而是【先记账】：
 * 内核必须随时知道"哪个 DMA 通道被谁占了、哪个 PIO 状态机给了谁、
 * 哪块内存是谁的、哪几个 GPIO 属于哪个子系统"。
 *
 * 没有这本账，后面所有事都做不了：
 *   - 没法做"应用退出时回收它占的一切"（会漏资源，跑几次就没通道了）；
 *   - 没法做越权判定（我都不知道这块内存是谁的，怎么判断越权？）；
 *   - 没法做死亡诊断（DVI 抢了 SDIO 的 DMA 中断这种事，本项目真的踩过）。
 *
 * 所以本模块是"先记账，后执法"。执法（应用只能走系统调用）在后面的阶段做。
 *
 * ── 设计取舍 ──
 *
 * 1. 全部是【静态表】，不用 malloc —— 内核最底层的账本不能依赖分配器，
 *    否则就成了"分配器自己出错时连账都记不了"的死循环。
 * 2. 每个资源项记住【所有者类别 + 所有者实例号】，于是
 *    "回收某个应用的全部资源"就是扫一遍表，O(n) 但 n 很小。
 * 3. 外设的实际占用同时会和 SDK 的状态对齐：
 *      DMA  → dma_channel_claim() / dma_channel_unclaim()
 *      PIO  → pio_sm_claim()       / pio_sm_unclaim()
 *    这样 SDK 自己也不会把同一个通道再分给别人。
 */

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ── 谁能持有资源 ── */
typedef enum {
    KRES_FREE = 0,      /* 空闲 */
    KRES_KERNEL,        /* 内核自己 */
    KRES_DISPLAY,       /* 显示子系统（DVI） */
    KRES_STORAGE,       /* 存储子系统（SD / FatFS） */
    KRES_NET,           /* 网络子系统（蓝牙 / 2.4G） */
    KRES_AUDIO,         /* 音频子系统 */
    KRES_SYSTEM_APP,    /* 系统应用（锁屏 / 主界面 / 设置）—— 受限特权 */
    KRES_APP,           /* 普通应用 —— 完全非特权 */
    KRES_OWNER_COUNT
} kres_owner_t;

/* ── 资源种类 ── */
typedef enum {
    KRES_MEM = 0,       /* 一块内存 */
    KRES_DMA_CH,        /* 一个 DMA 通道（RP2350 有 16 个） */
    KRES_PIO_SM,        /* 一个 PIO 状态机（3 个 PIO × 4 = 12 个） */
    KRES_GPIO,          /* 一个 GPIO（RP2350B 有 48 个） */
    KRES_IRQ,           /* 一个中断号 */
    KRES_BLOCKDEV,      /* 一个块设备（SD 卡 / 内存假磁盘） */
    KRES_MPU_REGION,    /* 一个 MPU 区域（RP2350 有 8 个）
                         * 2026-09-29 新增。理由：MPU 区域和 DMA 通道一样是
                         * 【有限的、会被抢的硬件资源】，不该散在别处手写魔数，
                         * 应该跟其它资源一起登记、一起回收 —— 见 规范 6b。 */
    KRES_KIND_COUNT
} kres_kind_t;

/* 各类资源的容量（数组长度） */
#define KRES_MEM_MAX       64
#define KRES_DMA_MAX       16
#define KRES_PIO_SM_MAX    12
#define KRES_GPIO_MAX      48
#define KRES_IRQ_MAX       64
#define KRES_BLOCKDEV_MAX   8
#define KRES_MPU_REGION_MAX 8

/* 内存资源用的池标识 */
#define KRES_POOL_SRAM     0
#define KRES_POOL_PSRAM    1

typedef struct {
    uint8_t   owner;      /* kres_owner_t，0 = 空闲 */
    uint8_t   pool;       /* 内存资源：0=SRAM 1=PSRAM */
    uint16_t  owner_id;   /* 同一所有者内的实例号 / 应用 id */
    uint32_t  arg;        /* 内存=字节数 / PIO=实例号 / 块设备=扇区数 */
    uintptr_t base;       /* 内存资源：起始地址 */
} kres_entry_t;

/* ── 基础操作 ── */

/* 清空整张表。注意：不动硬件，只清账本 —— 上电调用。 */
void kres_init(void);

/* 资源种类的名字（"DMA_CH" 之类），打印和诊断用 */
const char *kres_kind_name(kres_kind_t k);

/* 某一类资源的容量 */
uint32_t kres_capacity(kres_kind_t k);

/* 通用认领 / 释放。成功返回 0，失败返回负值。 */
int  kres_claim(kres_kind_t k, uint32_t id,
                kres_owner_t owner, uint16_t owner_id,
                uint32_t arg, uintptr_t base);
int  kres_release(kres_kind_t k, uint32_t id, kres_owner_t owner);

/* 查询 */
bool     kres_is_free(kres_kind_t k, uint32_t id);
uint8_t  kres_owner_of(kres_kind_t k, uint32_t id);
bool     kres_owned_by(kres_kind_t k, uint32_t id,
                       kres_owner_t owner, uint16_t owner_id);
uint32_t kres_used_count(kres_kind_t k);

/* ── DMA ──
 *
 * 内核自己挑一个没被登记的通道，认领它，并同步告诉 SDK。
 * 返回通道号（0..15），失败返回 -1。
 */
int  kres_dma_claim(kres_owner_t owner, uint16_t owner_id);
bool kres_dma_release(uint32_t ch, kres_owner_t owner);

/*
 * 把"别人已经占掉的"通道补登记进账本。
 *
 * 为什么需要它：DVI 库（frank_hdmi_sound）内部直接调
 * dma_claim_unused_channel()，绕过了本账本。与其现在去改那个第三方库，
 * 不如初始化完之后把它实际拿到的通道【补记】进来 ——
 * 账本先做到"不比现实更差"，再逐步收权。
 */
int  kres_dma_import(uint32_t ch, kres_owner_t owner, uint16_t owner_id);

/* ── PIO 状态机 ── */

/* pio_idx: 0=pio0 1=pio1 2=pio2。返回 SM 号（0..3），失败 -1。 */
int  kres_pio_sm_claim(uint32_t pio_idx, kres_owner_t owner, uint16_t owner_id);
bool kres_pio_sm_release(uint32_t pio_idx, uint32_t sm, kres_owner_t owner);
int  kres_pio_sm_import(uint32_t pio_idx, uint32_t sm,
                        kres_owner_t owner, uint16_t owner_id);
/* 全局编号 = pio_idx*4 + sm，便于用一张表管 12 个 SM */
uint32_t kres_pio_sm_index(uint32_t pio_idx, uint32_t sm);

/* ── GPIO ── */
int  kres_gpio_claim(uint32_t pin, kres_owner_t owner, uint16_t owner_id);
bool kres_gpio_release(uint32_t pin, kres_owner_t owner);
int  kres_gpio_import(uint32_t pin, kres_owner_t owner, uint16_t owner_id);

/* ── 内存 ──
 *
 * 只登记，不分配。分配走 kernel_mem（kmem_alloc）。
 * ptr/size 必须与 kmem_alloc 回填的完全一致，回收时才不会出错。
 */
int  kres_mem_track(void *ptr, size_t size, uint8_t pool,
                    kres_owner_t owner, uint16_t owner_id);
void kres_mem_untrack(void *ptr);

/* ── 块设备（SD 卡 / 内存假磁盘）── */
int  kres_blockdev_claim(uint32_t id, kres_owner_t owner, uint16_t owner_id,
                         uint32_t sectors);
bool kres_blockdev_release(uint32_t id, kres_owner_t owner);

/* ── 回收 ──
 *
 * 把某个所有者（通常是"一个应用退出"）持有的【全部】资源还回来。
 * 内存会真的调 kmem_free 还给池子。
 * 返回回收掉的资源项数。
 */
size_t kres_revoke_all(kres_owner_t owner, uint16_t owner_id);

/* ── 自检 ── */
extern volatile uint32_t g_kres_selftest_status;
extern volatile uint32_t g_kres_selftest_steps;
extern volatile uint32_t g_kres_selftest_fail_at;
void kres_selftest(void);

#ifdef __cplusplus
}
#endif

#endif /* KERNEL_RES_H */
