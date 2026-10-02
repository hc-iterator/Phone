/*
 * kernel_res.c —— 内核资源登记表
 *
 * 设计说明见 kernel_res.h。这里只补一条实现上的原则：
 *
 * 【账本是权威，硬件状态是影子。】
 *
 * 也就是说：某个 DMA 通道到底能不能用，以本文件的表为准；
 * 同时我们尽量让 SDK 的状态跟上（dma_channel_claim / pio_sm_claim），
 * 免得 SDK 自己把同一个资源又分出去。
 *
 * 为什么不让 SDK 当权威：因为 DVI 那个第三方库是直接调
 * dma_claim_unused_channel() 的，它绕过了我们。如果以 SDK 为准，
 * 我们就永远不知道那块资源"归谁"，回收和越权判定都做不了。
 * 所以本文件用 import 系列函数把别人的占用补记进来，
 * 让账本至少不比现实更差。
 */

#include "kernel_res.h"

#include <string.h>

#include "pico/stdlib.h"
#include "hardware/dma.h"
#include "hardware/gpio.h"
#include "hardware/pio.h"

#include "kernel_mem.h"

/* ===========================================================================
 * 静态账本
 * =========================================================================== */

static kres_entry_t g_tab[KRES_KIND_COUNT][KRES_MEM_MAX > KRES_DMA_MAX ?
                                             (KRES_MEM_MAX > KRES_IRQ_MAX ?
                                              (KRES_MEM_MAX > KRES_GPIO_MAX ?
                                               KRES_MEM_MAX : KRES_GPIO_MAX) :
                                              (KRES_IRQ_MAX > KRES_GPIO_MAX ?
                                               KRES_IRQ_MAX : KRES_GPIO_MAX)) :
                                             (KRES_DMA_MAX > KRES_IRQ_MAX ?
                                              (KRES_DMA_MAX > KRES_GPIO_MAX ?
                                               KRES_DMA_MAX : KRES_GPIO_MAX) :
                                              (KRES_IRQ_MAX > KRES_GPIO_MAX ?
                                               KRES_IRQ_MAX : KRES_GPIO_MAX))];

/* 上表那串嵌套三元表达式太丑了，改成显式的最大容量常量 */
#undef KRES_SLOT_MAX

static const uint32_t k_capacity[KRES_KIND_COUNT] = {
    KRES_MEM_MAX, KRES_DMA_MAX, KRES_PIO_SM_MAX,
    KRES_GPIO_MAX, KRES_IRQ_MAX, KRES_BLOCKDEV_MAX,
    KRES_MPU_REGION_MAX
};

static const char *k_kind_name[KRES_KIND_COUNT] = {
    "MEM", "DMA_CH", "PIO_SM", "GPIO", "IRQ", "BLOCKDEV", "MPU_REGION"
};

/* 三块 PIO（RP2350 有 pio0/pio1/pio2） */
#if PICO_RP2350
static PIO *const k_pio[NUM_PIOS] = { pio0, pio1, pio2 };
#else
static PIO *const k_pio[NUM_PIOS] = { pio0, pio1 };
#endif

volatile uint32_t g_kres_selftest_status  = 0;
volatile uint32_t g_kres_selftest_steps   = 0;
volatile uint32_t g_kres_selftest_fail_at = 0;

/* ===========================================================================
 * 基础操作
 * =========================================================================== */

void kres_init(void) {
    memset(g_tab, 0, sizeof(g_tab));
}

const char *kres_kind_name(kres_kind_t k) {
    if ((int)k < 0 || k >= KRES_KIND_COUNT) return "?";
    return k_kind_name[k];
}

uint32_t kres_capacity(kres_kind_t k) {
    if ((int)k < 0 || k >= KRES_KIND_COUNT) return 0;
    return k_capacity[k];
}

static bool slot_ok(kres_kind_t k, uint32_t id) {
    return (int)k >= 0 && k < KRES_KIND_COUNT && id < k_capacity[k];
}

int kres_claim(kres_kind_t k, uint32_t id,
               kres_owner_t owner, uint16_t owner_id,
               uint32_t arg, uintptr_t base) {
    if (!slot_ok(k, id)) return -1;
    if (owner == KRES_FREE) return -2;
    kres_entry_t *e = &g_tab[k][id];
    if (e->owner != KRES_FREE) return -3;   /* 已被占 */

    e->owner    = (uint8_t)owner;
    e->owner_id = owner_id;
    e->arg      = arg;
    e->base     = base;
    e->pool     = 0;
    return 0;
}

int kres_release(kres_kind_t k, uint32_t id, kres_owner_t owner) {
    if (!slot_ok(k, id)) return -1;
    kres_entry_t *e = &g_tab[k][id];
    if (e->owner == KRES_FREE) return -2;
    /* 只有主人（或内核）能释放 —— 这就是最朴素的"越权检查" */
    if (e->owner != (uint8_t)owner && owner != KRES_KERNEL) return -3;
    memset(e, 0, sizeof(*e));
    return 0;
}

bool kres_is_free(kres_kind_t k, uint32_t id) {
    if (!slot_ok(k, id)) return false;
    return g_tab[k][id].owner == KRES_FREE;
}

uint8_t kres_owner_of(kres_kind_t k, uint32_t id) {
    if (!slot_ok(k, id)) return KRES_FREE;
    return g_tab[k][id].owner;
}

bool kres_owned_by(kres_kind_t k, uint32_t id,
                   kres_owner_t owner, uint16_t owner_id) {
    if (!slot_ok(k, id)) return false;
    const kres_entry_t *e = &g_tab[k][id];
    return e->owner == (uint8_t)owner && e->owner_id == owner_id;
}

uint32_t kres_used_count(kres_kind_t k) {
    if ((int)k < 0 || k >= KRES_KIND_COUNT) return 0;
    uint32_t n = 0;
    for (uint32_t i = 0; i < k_capacity[k]; i++) {
        if (g_tab[k][i].owner != KRES_FREE) n++;
    }
    return n;
}

/* ===========================================================================
 * DMA
 * =========================================================================== */

int kres_dma_claim(kres_owner_t owner, uint16_t owner_id) {
    for (uint32_t ch = 0; ch < KRES_DMA_MAX; ch++) {
        if (g_tab[KRES_DMA_CH][ch].owner != KRES_FREE) continue;
        if (kres_claim(KRES_DMA_CH, ch, owner, owner_id, 0, 0) != 0) continue;
        /* 同步告诉 SDK，免得它把同一个通道再分给别人。
         * 先查 is_claimed，避免对已被别人占的通道重复认领而触发断言。 */
        if (!dma_channel_is_claimed(ch)) {
            dma_channel_claim(ch);
        }
        return (int)ch;
    }
    return -1;
}

bool kres_dma_release(uint32_t ch, kres_owner_t owner) {
    if (kres_release(KRES_DMA_CH, ch, owner) != 0) return false;
    dma_channel_unclaim(ch);
    return true;
}

int kres_dma_import(uint32_t ch, kres_owner_t owner, uint16_t owner_id) {
    if (!slot_ok(KRES_DMA_CH, ch)) return -1;
    /* 补记：直接写表，不走 kres_claim 的"必须空闲"检查，
     * 因为目的就是"把一个已经存在的占用登记上"。 */
    kres_entry_t *e = &g_tab[KRES_DMA_CH][ch];
    e->owner    = (uint8_t)owner;
    e->owner_id = owner_id;
    e->arg      = 1;          /* 标记：这条是 import 进来的 */
    e->base     = 0;
    e->pool     = 0;

    /* ⚠️ 必须把 SDK 的认领状态一起同步（和 kres_dma_claim 的做法一致）。
     *
     * 不同步的话，kres_dma_release() 里那句无条件的 dma_channel_unclaim()
     * 会撞上真 SDK 的断言：
     *     dma_channel_unclaim → hw_claim_clear → claim.c:51
     *     assert(hw_is_claimed(bits, bit_index))
     * 也就是"在释放一个从没被认领过的通道" ⇒ panic ⇒ 卡死在 _exit()。
     *
     * 【上机实测事故 2026-10-01】kres_selftest() 第 29 步（kres_dma_release）
     * 与第 30 步之间就是死在这里：g_kres_selftest_steps 停在 29、
     * fail_at 仍是 0（因为崩在条件表达式里面，还没来得及记失败步）。
     *
     * ⚠️ 主机侧当时【没抓到】—— 因为 tools/host_test/stub.c 把 unclaim 实现成了
     * 无声赋值，没有复现这条断言。桩已同步修好，现在两边都能抓。 */
    if (!dma_channel_is_claimed(ch)) {
        dma_channel_claim(ch);
    }
    return 0;
}

/* ===========================================================================
 * PIO 状态机
 * =========================================================================== */

uint32_t kres_pio_sm_index(uint32_t pio_idx, uint32_t sm) {
    return pio_idx * 4u + sm;
}

int kres_pio_sm_claim(uint32_t pio_idx, kres_owner_t owner, uint16_t owner_id) {
    if (pio_idx >= (uint32_t)NUM_PIOS) return -1;
    for (uint32_t sm = 0; sm < 4; sm++) {
        uint32_t idx = kres_pio_sm_index(pio_idx, sm);
        if (g_tab[KRES_PIO_SM][idx].owner != KRES_FREE) continue;
        if (kres_claim(KRES_PIO_SM, idx, owner, owner_id, pio_idx, 0) != 0) continue;
        /* 和 kres_dma_claim 同样先查再认领：
         * 真 SDK 的 pio_sm_claim 走 hw_claim_or_assert ⇒ 重复认领会断言。 */
        if (!pio_sm_is_claimed(k_pio[pio_idx], (int)sm)) {
            pio_sm_claim(k_pio[pio_idx], (int)sm);
        }
        return (int)sm;
    }
    return -1;
}

bool kres_pio_sm_release(uint32_t pio_idx, uint32_t sm, kres_owner_t owner) {
    if (pio_idx >= (uint32_t)NUM_PIOS || sm >= 4u) return false;
    uint32_t idx = kres_pio_sm_index(pio_idx, sm);
    if (kres_release(KRES_PIO_SM, idx, owner) != 0) return false;
    pio_sm_unclaim(k_pio[pio_idx], (int)sm);
    return true;
}

int kres_pio_sm_import(uint32_t pio_idx, uint32_t sm,
                       kres_owner_t owner, uint16_t owner_id) {
    if (pio_idx >= (uint32_t)NUM_PIOS || sm >= 4u) return -1;
    uint32_t idx = kres_pio_sm_index(pio_idx, sm);
    kres_entry_t *e = &g_tab[KRES_PIO_SM][idx];
    e->owner    = (uint8_t)owner;
    e->owner_id = owner_id;
    e->arg      = pio_idx;
    e->base     = 0;
    e->pool     = 1;          /* 标记：import */

    /* 同理（见 kres_dma_import 的长注释）：不同步 SDK 的话，
     * kres_pio_sm_release() 里的 pio_sm_unclaim() 会撞上
     * claim.c 的 assert(hw_is_claimed(...)) ⇒ panic。 */
    if (!pio_sm_is_claimed(k_pio[pio_idx], (int)sm)) {
        pio_sm_claim(k_pio[pio_idx], (int)sm);
    }
    return 0;
}

/* ===========================================================================
 * GPIO
 * =========================================================================== */

int kres_gpio_claim(uint32_t pin, kres_owner_t owner, uint16_t owner_id) {
    return kres_claim(KRES_GPIO, pin, owner, owner_id, 0, 0);
}

bool kres_gpio_release(uint32_t pin, kres_owner_t owner) {
    return kres_release(KRES_GPIO, pin, owner) == 0;
}

int kres_gpio_import(uint32_t pin, kres_owner_t owner, uint16_t owner_id) {
    if (!slot_ok(KRES_GPIO, pin)) return -1;
    kres_entry_t *e = &g_tab[KRES_GPIO][pin];
    e->owner    = (uint8_t)owner;
    e->owner_id = owner_id;
    e->arg      = 1;
    e->base     = 0;
    e->pool     = 1;
    return 0;
}

/* ===========================================================================
 * 内存
 * =========================================================================== */

int kres_mem_track(void *ptr, size_t size, uint8_t pool,
                   kres_owner_t owner, uint16_t owner_id) {
    if (ptr == NULL || size == 0) return -1;
    for (uint32_t i = 0; i < KRES_MEM_MAX; i++) {
        if (g_tab[KRES_MEM][i].owner != KRES_FREE) continue;
        kres_entry_t *e = &g_tab[KRES_MEM][i];
        e->owner    = (uint8_t)owner;
        e->owner_id = owner_id;
        e->pool     = pool;
        e->arg      = (uint32_t)size;
        e->base     = (uintptr_t)ptr;
        return 0;
    }
    return -1;   /* 登记表满了 —— 宁可拒绝分配，也不要留下无主的块 */
}

void kres_mem_untrack(void *ptr) {
    if (ptr == NULL) return;
    for (uint32_t i = 0; i < KRES_MEM_MAX; i++) {
        kres_entry_t *e = &g_tab[KRES_MEM][i];
        if (e->owner != KRES_FREE && e->base == (uintptr_t)ptr) {
            memset(e, 0, sizeof(*e));
            return;
        }
    }
}

/* ===========================================================================
 * 块设备
 * =========================================================================== */

int kres_blockdev_claim(uint32_t id, kres_owner_t owner, uint16_t owner_id,
                        uint32_t sectors) {
    return kres_claim(KRES_BLOCKDEV, id, owner, owner_id, sectors, 0);
}

bool kres_blockdev_release(uint32_t id, kres_owner_t owner) {
    return kres_release(KRES_BLOCKDEV, id, owner) == 0;
}

/* ===========================================================================
 * 回收
 * =========================================================================== */

size_t kres_revoke_all(kres_owner_t owner, uint16_t owner_id) {
    size_t n = 0;

    for (int k = 0; k < KRES_KIND_COUNT; k++) {
        for (uint32_t i = 0; i < k_capacity[k]; i++) {
            kres_entry_t *e = &g_tab[k][i];
            if (e->owner != (uint8_t)owner || e->owner_id != owner_id) continue;

            /* 内存要真的还给池子 —— 否则"应用退出"只是忘了它，
             * 内存永远回不来（这就是漏资源）。 */
            if ((kres_kind_t)k == KRES_MEM) {
                kmem_pool_t *pool = (e->pool == KRES_POOL_PSRAM)
                                    ? &g_pool_psram : &g_pool_sram;
                kmem_free(pool, (void *)e->base, e->arg);
            }
            /* 注：DMA / PIO 在这里故意【不】动 SDK 的认领状态。
             * 原因是回收经常发生在"资源已经不对了"的路径上，
             * 此时去动硬件容易把别的子系统一起带坏。
             * 真正的硬件收权放在子系统自己的 shutdown 里做。 */

            memset(e, 0, sizeof(*e));
            n++;
        }
    }
    return n;
}

/* ===========================================================================
 * 自检
 * ===========================================================================
 *
 * 结果写进 g_kres_selftest_*，SWD 直接读。
 *
 * 为什么自检里【不碰 PIO 硬件】：PIO0 的三个状态机马上要给 DVI 用，
 * SD 驱动也占 PIO，这里去认领会把它们的既有状态搅乱。
 * 所以 PIO 只测"编号映射 + 账本读写"这条纯软件路径。
 * DMA 则趁早（别的子系统都还没启动）真实认领一遍，是真测。
 */

#define KRES_ST_OK(cond)                                                  \
    do {                                                                  \
        step++;                                                           \
        g_kres_selftest_steps = step;                                     \
        if (!(cond)) {                                                    \
            g_kres_selftest_fail_at = step;                               \
            g_kres_selftest_status = 0;                                   \
            return;                                                       \
        }                                                                 \
    } while (0)

void kres_selftest(void) {
    uint32_t step = 0;
    g_kres_selftest_status  = 0;
    g_kres_selftest_fail_at = 0;

    kres_init();

    /* 1. 初始化后全部空闲 */
    KRES_ST_OK(kres_used_count(KRES_DMA_CH) == 0);
    KRES_ST_OK(kres_used_count(KRES_GPIO) == 0);
    KRES_ST_OK(kres_used_count(KRES_MEM) == 0);

    /* 2. 容量自洽 */
    KRES_ST_OK(kres_capacity(KRES_DMA_CH) == KRES_DMA_MAX);
    KRES_ST_OK(kres_capacity(KRES_PIO_SM) == KRES_PIO_SM_MAX);

    /* 3. 认领一个 DMA 通道，拿到的号要合法、且确实被我们占着 */
    int ch = kres_dma_claim(KRES_KERNEL, 1);
    KRES_ST_OK(ch >= 0 && ch < KRES_DMA_MAX);
    KRES_ST_OK(kres_owner_of(KRES_DMA_CH, (uint32_t)ch) == KRES_KERNEL);
    KRES_ST_OK(kres_used_count(KRES_DMA_CH) == 1);

    /* 4. 同一个通道不能重复认领 */
    KRES_ST_OK(kres_claim(KRES_DMA_CH, (uint32_t)ch, KRES_APP, 7, 0, 0) != 0);

    /* 5. **越权检查**：别人不能释放我的资源 */
    KRES_ST_OK(kres_release(KRES_DMA_CH, (uint32_t)ch, KRES_APP) != 0);
    KRES_ST_OK(kres_owner_of(KRES_DMA_CH, (uint32_t)ch) == KRES_KERNEL);
    /* 主人自己可以 */
    KRES_ST_OK(kres_release(KRES_DMA_CH, (uint32_t)ch, KRES_KERNEL) == 0);
    KRES_ST_OK(kres_is_free(KRES_DMA_CH, (uint32_t)ch));

    /* 6. 把 16 个 DMA 通道全认领掉，第 17 个必须干净失败 */
    {
        int got[KRES_DMA_MAX];
        for (int i = 0; i < KRES_DMA_MAX; i++) {
            got[i] = kres_dma_claim(KRES_DISPLAY, (uint16_t)(100 + i));
        }
        /* 由于 ch 刚释放，这里应当能拿到全部 16 个 */
        KRES_ST_OK(got[KRES_DMA_MAX - 1] >= 0);
        KRES_ST_OK(kres_used_count(KRES_DMA_CH) == KRES_DMA_MAX);
        KRES_ST_OK(kres_dma_claim(KRES_APP, 9) == -1);   /* 满了 */
        /* 全部归还 */
        for (int i = 0; i < KRES_DMA_MAX; i++) {
            if (got[i] >= 0) kres_dma_release((uint32_t)got[i], KRES_DISPLAY);
        }
        KRES_ST_OK(kres_used_count(KRES_DMA_CH) == 0);
    }

    /* 7. PIO 编号映射（纯软件，不碰硬件） */
    KRES_ST_OK(kres_pio_sm_index(0, 0) == 0);
    KRES_ST_OK(kres_pio_sm_index(0, 3) == 3);
    KRES_ST_OK(kres_pio_sm_index(1, 0) == 4);
    KRES_ST_OK(kres_pio_sm_index(2, 3) == 11);

    /* 8. GPIO 认领 / 越权 / 释放 */
    KRES_ST_OK(kres_gpio_claim(25, KRES_NET, 3) == 0);
    KRES_ST_OK(!kres_is_free(KRES_GPIO, 25));
    KRES_ST_OK(!kres_gpio_release(25, KRES_APP));      /* 越权 */
    KRES_ST_OK(kres_gpio_release(25, KRES_NET));
    KRES_ST_OK(kres_is_free(KRES_GPIO, 25));

    /* 9. import：补记别人的占用 */
    KRES_ST_OK(kres_dma_import(5, KRES_DISPLAY, 1) == 0);
    KRES_ST_OK(kres_owner_of(KRES_DMA_CH, 5) == KRES_DISPLAY);
    KRES_ST_OK(kres_dma_release(5, KRES_DISPLAY));

    /* 10. 内存登记 + 回收：这是和内存管理器真正打通的一步。
     *     先记下池子当前空闲量，分配、登记、然后 revoke，
     *     空闲量必须回到原值 —— 否则就是内存泄漏。 */
    {
        size_t before = g_pool_sram.free_bytes;
        size_t got = 0;
        void *p = kmem_alloc(&g_pool_sram, 333, &got);
        KRES_ST_OK(p != NULL && got == 512);
        KRES_ST_OK(kres_mem_track(p, got, KRES_POOL_SRAM, KRES_APP, 42) == 0);
        KRES_ST_OK(kres_used_count(KRES_MEM) == 1);
        KRES_ST_OK(g_pool_sram.free_bytes == before - got);

        size_t n = kres_revoke_all(KRES_APP, 42);
        KRES_ST_OK(n == 1);
        KRES_ST_OK(kres_used_count(KRES_MEM) == 0);
        KRES_ST_OK(g_pool_sram.free_bytes == before);    /* 真的还回去了 */
    }

    /* 11. 带外内存：登记表满了要拒绝，而不是留下无主的块 */
    {
        void *ptrs[KRES_MEM_MAX + 2];
        size_t n = 0;
        for (uint32_t i = 0; i < KRES_MEM_MAX + 2; i++) {
            size_t got = 0;
            void *p = kmem_alloc(&g_pool_sram, 16, &got);
            if (p == NULL) break;
            if (kres_mem_track(p, got, KRES_POOL_SRAM, KRES_APP, 77) != 0) {
                kmem_free(&g_pool_sram, p, got);   /* 登记不上就当场还掉 */
                break;
            }
            ptrs[n++] = p;
        }
        KRES_ST_OK(n == KRES_MEM_MAX);
        KRES_ST_OK(kres_used_count(KRES_MEM) == KRES_MEM_MAX);
        size_t back = kres_revoke_all(KRES_APP, 77);
        KRES_ST_OK(back == KRES_MEM_MAX);
        KRES_ST_OK(kres_used_count(KRES_MEM) == 0);
    }

    /* 12. 收尾：整张表应当是干净的（除了启动时已经 import 的东西） */
    KRES_ST_OK(kres_used_count(KRES_GPIO) == 0);
    KRES_ST_OK(kres_used_count(KRES_MEM) == 0);
    KRES_ST_OK(kres_used_count(KRES_BLOCKDEV) == 0);

    g_kres_selftest_status = 1;
}

#undef KRES_ST_OK
