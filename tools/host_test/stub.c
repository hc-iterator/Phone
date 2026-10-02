/*
 * tools/host_test/stub.c —— 主机侧（PC 上跑）的 SDK 桩
 *
 * 目的：让 kernel_res.c 和 kernel_res_borrow.c **原封不动**地在 PC 上编译并运行，
 * 从而在板子够不着的时候也能验证账本逻辑和借用逻辑。
 *
 * ⚠️ 它验证的是【逻辑】，不是【硬件行为】。
 *    硬件那边的实测（真正的 DMA/PIO/PSRAM）仍然只能在板子上做。
 *    桩和真实现的差别本身就是风险，所以结论要写清"这是主机侧结论"。
 *
 * 关键设计：**假时钟**
 *   用可控的微秒计数代替真实定时器，于是"超时"用例是确定性的 ——
 *   不会出现"机器慢就偶发失败"这种最烦人的测试。
 */

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "pico/time.h"
#include "hardware/dma.h"
#include "hardware/pio.h"

/* 用【真】的 kernel_mem.h（只桩实现，不桩头文件）——
 * 因为 C 的 #include "..." 会优先找源文件同目录，桩头文件根本拦不住。
 * 好处是：桩的实现必须跟真头文件对得上，编译器会替我们盯着。 */
#include "kernel_mem.h"

/* ── 可控假时钟 ── */
static uint32_t g_fake_us = 1000;   /* 从非 0 起步：0 在借用层里表示"不过期" */

uint32_t time_us_32(void) { return g_fake_us; }
void     busy_wait_us_32(uint32_t us) { g_fake_us += us; }

/* ── DMA ──
 *
 * ⚠️⚠️ 桩必须复现真 SDK 的【契约】，不能只复现【状态】。
 *
 * 真 SDK（`hardware_dma/dma.c` → `common/hardware_claim/claim.c`）：
 *     dma_channel_claim(ch)   → hw_claim_or_assert(...)  ⇒ 重复认领会断言
 *     dma_channel_unclaim(ch) → hw_claim_clear(...)      ⇒ 释放没认领过的会断言
 *                               （claim.c:51: assert(hw_is_claimed(bits, bit_index))）
 *
 * 2026-10-01 上机实测事故：`kres_dma_import()` 只写账本、不同步 SDK，
 * 于是 `kres_dma_release()` 里的 `dma_channel_unclaim()` 在真板上 panic。
 * **主机侧 43/43 全绿没抓到，就是因为原来的桩把 unclaim 写成了无声赋值。**
 * ⇒ 教训：桩少一条断言，就等于给被测代码开了一个"主机侧豁免"。
 */
#define STUB_DMA_MAX 16
static bool g_dma_claimed[STUB_DMA_MAX];

void dma_channel_claim(unsigned int channel) {
    if (channel >= STUB_DMA_MAX) return;
    assert(!g_dma_claimed[channel]);          /* 真 SDK: hw_claim_or_assert */
    g_dma_claimed[channel] = true;
}
void dma_channel_unclaim(unsigned int channel) {
    if (channel >= STUB_DMA_MAX) return;
    assert(g_dma_claimed[channel]);           /* 真 SDK: hw_claim_clear + assert */
    g_dma_claimed[channel] = false;
}
bool dma_channel_is_claimed(unsigned int channel) { return channel < STUB_DMA_MAX && g_dma_claimed[channel]; }

/* ── PIO ──（契约同上：claim 重复认领断言、unclaim 未认领断言）── */
PIO pio0_stub = { 0 }, pio1_stub = { 1 }, pio2_stub = { 2 };
static bool g_sm[3][4];

void pio_sm_claim(PIO *pio, int sm) {
    int i = pio ? pio->id : 0;
    if (!(i >= 0 && i < 3 && sm >= 0 && sm < 4)) return;
    assert(!g_sm[i][sm]);
    g_sm[i][sm] = true;
}
void pio_sm_unclaim(PIO *pio, int sm) {
    int i = pio ? pio->id : 0;
    if (!(i >= 0 && i < 3 && sm >= 0 && sm < 4)) return;
    assert(g_sm[i][sm]);
    g_sm[i][sm] = false;
}
bool pio_sm_is_claimed(PIO *pio, int sm) {
    int i = pio ? pio->id : 0;
    return (i >= 0 && i < 3 && sm >= 0 && sm < 4) && g_sm[i][sm];
}

/* ── 内核内存桩 ──
 * 只实现 kres 用得到的那几条语义，并且要和真的伙伴分配器一致：
 *   · 块大小向上取到 2 的幂，最小 16  —— 所以 333 字节会拿到 512（kres 自检就是这么断言的）
 *   · free_bytes 记账：分配减、释放加 —— 于是"到底还回去没有"测得出来
 * 真正的分配器逻辑（24 步）由硬件那边自检验。 */
kmem_pool_t g_pool_sram;
kmem_pool_t g_pool_psram;
volatile uint32_t g_kmem_sram_arena_size = 128u * 1024u;

static uintptr_t g_fake_ptr = 0x20000000u;

size_t kmem_block_size(size_t want) {
    size_t n = 16;
    while (n < want) n <<= 1;
    return n;
}

void *kmem_alloc(kmem_pool_t *p, size_t want, size_t *got_size) {
    if (!p) return NULL;
    size_t n = kmem_block_size(want);
    if (n > p->free_bytes) { p->fail_count++; return NULL; }
    p->free_bytes -= n;
    p->used_bytes += n;
    if (p->used_bytes > p->peak_used) p->peak_used = p->used_bytes;
    p->alloc_count++;
    if (got_size) *got_size = n;
    g_fake_ptr += n;
    return (void *)g_fake_ptr;
}

void kmem_free(kmem_pool_t *p, void *ptr, size_t size) {
    (void)ptr;
    if (!p) return;
    p->free_bytes += size;
    if (p->used_bytes >= size) p->used_bytes -= size;
}

/* 桩自己的初始化（host_main 开头调用） */
void kmem_host_stub_init(void) {
    memset(&g_pool_sram, 0, sizeof(g_pool_sram));
    memset(&g_pool_psram, 0, sizeof(g_pool_psram));
    g_pool_sram.name  = "SRAM(host-stub)";
    g_pool_sram.size  = 128u * 1024u;
    g_pool_sram.free_bytes = 128u * 1024u;
    g_pool_sram.in_use = 1;
    g_pool_psram.name = "PSRAM(host-stub)";
    g_pool_psram.size = 8u * 1024u * 1024u;
    g_pool_psram.free_bytes = 8u * 1024u * 1024u;
    g_pool_psram.in_use = 1;
}
