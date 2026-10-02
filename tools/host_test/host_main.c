/*
 * tools/host_test/host_main.c —— 在 PC 上跑内核自检
 *
 * 为什么做这个：板子经常够不着（探针挂、SWD 断、USB 不枚举），
 * 而"写了代码但没验证"正是本项目最该防的事。
 * 所以把**不依赖硬件**的那部分逻辑拿到 PC 上跑 —— 立刻能知道对错。
 *
 * ⚠️ 这里的结论是【主机侧结论】：验证的是逻辑，不是硬件行为。
 *    DMA/PIO/PSRAM 的真行为仍然只能在板子上实测。
 */

#include <stdio.h>

#include "kernel_res.h"
#include "kernel_res_borrow.h"

void kmem_host_stub_init(void);

static void report(const char *name,
                   volatile uint32_t *status,
                   volatile uint32_t *steps,
                   volatile uint32_t *fail_at,
                   int *fail) {
    int ok = (*status == 1);
    printf("%-22s : %s   步数=%2u   首个失败步=%u\n",
           name, ok ? "✅ 通过" : "❌ 失败",
           (unsigned)*steps, (unsigned)*fail_at);
    if (!ok) (*fail)++;
}

int main(void) {
    int fail = 0;

    printf("=== 内核自检（主机侧 / MSVC + SDK 桩）===\n\n");

    kmem_host_stub_init();

    /* 1) 账本：12 步（独占、越权、import、内存回收、登记表满） */
    kres_init();
    kres_selftest();
    report("内核资源表(账本)",
           &g_kres_selftest_status, &g_kres_selftest_steps,
           &g_kres_selftest_fail_at, &fail);

    /* 2) 借用/调度：撞忙入队、优先级、FIFO、超时、自动转交、严格越权、队列满、MPU 区域 */
    kres_borrow_selftest();
    report("资源借用(调度)",
           &g_kresb_selftest_status, &g_kresb_selftest_steps,
           &g_kresb_selftest_fail_at, &fail);

    printf("\n-- 调度统计 --\n");
    printf("  撞忙 %u 次   入队 %u 次   排队后转交成功 %u 次   超时 %u 次   队列满拒绝 %u 次\n",
           (unsigned)g_kres_stat_contention, (unsigned)g_kres_stat_enqueued,
           (unsigned)g_kres_stat_granted,   (unsigned)g_kres_stat_timeouts,
           (unsigned)g_kres_stat_queue_full);

    printf("\n-- 各资源种类 --\n");
    for (int k = 0; k < (int)KRES_KIND_COUNT; k++) {
        printf("  %-11s 已用 %2u / %2u\n",
               kres_kind_name((kres_kind_t)k),
               (unsigned)kres_used_count((kres_kind_t)k),
               (unsigned)kres_capacity((kres_kind_t)k));
    }

    printf("\n%s\n", fail ? "❌ 有失败项" : "✅ 全部通过");
    return fail;
}
