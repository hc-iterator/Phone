/*
 * tools/host_test/host_kmem_main.c —— 在 PC 上跑【内核内存管理器】的 24 步自检
 *
 * ── 为什么需要单独一个入口 ──
 *
 * 原来的 host_main.c 测的是 kernel_res / kernel_res_borrow ——
 * 而 stub.c 里【把 kernel_mem 整个桩掉了】（用假的 kmem_alloc/kmem_free
 * 顶替），于是内存管理器自己的 24 步自检
 *   · 从来没在主机侧跑过；
 *   · 只存在于板子路径上 —— 而板子经常够不着。
 *
 * 这就是规范 5b 要防的事：能无硬件验证的逻辑，就必须能在主机侧验证。
 *
 * ── 与 host_main.c 的关系 ──
 *
 * 不合并，各用各的 main：因为二者的桩彼此冲突
 * （stub.c 定义了假的 kmem_alloc，本文件要链接【真的】kernel_mem.c）。
 * 合并以后就只能二选一。
 *
 * ── 本文件提供的桩 ──
 *
 *   psram_is_available() / psram_get_size()  —— 主机上没有 PSRAM
 *
 * ⚠️ 这里的结论是【主机侧结论】：验证的是逻辑（伙伴分配器的分裂/合并/
 *    对齐/回收），不是硬件行为。DMA/PIO/PSRAM 的真行为仍然只能在板子上实测。
 */

#include <stdio.h>

#include "kernel_mem.h"
#include "hardware/psram.h"

/* ── 主机侧没有 PSRAM 芯片 ──
 * 返回 false 而不是"假装有"：这样 kmem_init_all() 走的是与真板子
 * 默认配置（KMEM_ENABLE_PSRAM=0）一致的那条路。 */
bool psram_is_available(void) { return false; }
size_t psram_get_size(void) { return 0; }

int main(void) {
    int ok;

    printf("=== 内核内存管理器自检（主机侧 / MSVC + SDK 桩）===\n\n");
    printf("注意：这是【主机侧结论】—— 验证逻辑，不是硬件行为。\n\n");

    /* 走真正的初始化路径：arena_fit 会把 320KB 静态数组削到
     * "基址按大小对齐"的那个 2 的幂（见 kernel_mem.c 顶部说明）。 */
    kmem_init_all();

    printf("SRAM 竞技场实际拿到 : %u 字节\n",
           (unsigned)g_kmem_sram_arena_size);
    printf("PSRAM 检测到         : %u（主机上应为 0）\n",
           (unsigned)g_kmem_psram_detected);
    printf("PSRAM 池已放开       : %u（默认配置应为 0）\n\n",
           (unsigned)g_kmem_psram_ok);

    kmem_selftest();

    ok = (g_kmem_selftest_status == 1);

    printf("内核内存管理器(24 步) : %s   步数=%u   首个失败步=%u\n",
           ok ? "✅ 通过" : "❌ 失败",
           (unsigned)g_kmem_selftest_steps,
           (unsigned)g_kmem_selftest_fail_at);

    printf("\n池子记账：\n");
    printf("  总大小 %u 字节   空闲 %u   已用 %u   峰值 %u\n",
           (unsigned)g_pool_sram.size,
           (unsigned)g_pool_sram.free_bytes,
           (unsigned)g_pool_sram.used_bytes,
           (unsigned)g_pool_sram.peak_used);
    printf("  分配次数 %u   失败次数 %u\n",
           (unsigned)g_pool_sram.alloc_count,
           (unsigned)g_pool_sram.fail_count);

    printf("\n%s\n", ok ? "✅ 全部通过" : "❌ 有失败项");
    return ok ? 0 : 1;
}
