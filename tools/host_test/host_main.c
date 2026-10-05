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
#include "hardware/pio.h"    /* 主机侧桩：pio0/pio1/pio2 与 pio_sm_is_claimed() */

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

/* ===========================================================================
 * 主机侧用例：PIO 状态机【认领 / 越权 / import / 释放】
 * ===========================================================================
 *
 * 为什么加：桩里 pio_sm_claim / pio_sm_unclaim 带着两条断言（重复认领要断言、
 * 释放没认领过的也要断言），但原来只有 kres_pio_sm_index() 的算术被测到 ⇒
 * 那两条断言一直是"待命"状态，等于给被测代码开了一个主机侧豁免。
 * （陷阱本 错 17：桩必须复现【契约】—— 断言/边界/失败路径 —— 不只是【签名】。）
 *
 * 为什么【不】加进 src/kernel_res.c 的 kres_selftest()：
 *   那边有一条写死的设计决定（kernel_res.c:355-358）—— 自检【不碰 PIO 硬件】：
 *   PIO0 的 SM 开机就要给 DVI 用、SD 驱动也占 PIO，自检去认领会把真实硬件状态
 *   搅乱，所以板子路径上 PIO 只测编号映射。主机侧没有真硬件，pio0/pio1/pio2
 *   就是桩里的三个假实例 ⇒ 这里可以放心把认领/越权/import/release 全走一遍。
 *   于是【内核源码一个字节不用动】，而契约在主机侧被真正执行。
 *
 * 覆盖两条路，缺一不可：
 *   · 合法路径：认领成功 / 主人释放成功 / import 成功
 *   · 失败路径：重复认领被拒 / 越权释放被拒 / 越界参数被拒 / 12 个占满后干净失败
 * 关键点：凡是被【拒绝】的操作，SDK 桩那一侧的状态必须【原封不动】——
 *   否则就是"拒绝了但偷偷动了硬件"。
 *
 * ⚠️ 本用例只在 PC 上跑，认领的是桩；板子路径不受任何影响。
 */
static volatile uint32_t g_pio_selftest_status  = 0;
static volatile uint32_t g_pio_selftest_steps   = 0;
static volatile uint32_t g_pio_selftest_fail_at = 0;

#define PIO_ST_OK(cond)                                                       \
    do {                                                                      \
        g_pio_selftest_steps++;                                               \
        if (!(cond)) {                                                        \
            g_pio_selftest_fail_at = g_pio_selftest_steps;                    \
            g_pio_selftest_status = 0;                                        \
            return;                                                           \
        }                                                                     \
    } while (0)

static void pio_claim_host_selftest(void) {
    g_pio_selftest_status  = 0;
    g_pio_selftest_steps   = 0;
    g_pio_selftest_fail_at = 0;

    kres_init();

    /* (a) 合法认领：账本与 SDK 桩【两侧】都要记上 */
    int sm0 = kres_pio_sm_claim(0, KRES_KERNEL, 1);
    PIO_ST_OK(sm0 >= 0 && sm0 < 4);
    PIO_ST_OK(kres_owner_of(KRES_PIO_SM, kres_pio_sm_index(0, (uint32_t)sm0)) == KRES_KERNEL);
    PIO_ST_OK(kres_used_count(KRES_PIO_SM) == 1);
    PIO_ST_OK(pio_sm_is_claimed(pio0, sm0) == true);      /* SDK 侧同步了 */

    /* (b) 失败路径：重复认领同一个 SM 必须被拒，主人不变 */
    PIO_ST_OK(kres_claim(KRES_PIO_SM, kres_pio_sm_index(0, (uint32_t)sm0),
                         KRES_APP, 7, 0, 0) != 0);
    PIO_ST_OK(kres_owner_of(KRES_PIO_SM, kres_pio_sm_index(0, (uint32_t)sm0)) == KRES_KERNEL);

    /* (c) 失败路径：越权释放必须被拒，而且【不许】动 SDK 状态 */
    PIO_ST_OK(kres_pio_sm_release(0, (uint32_t)sm0, KRES_APP) == false);
    PIO_ST_OK(kres_owner_of(KRES_PIO_SM, kres_pio_sm_index(0, (uint32_t)sm0)) == KRES_KERNEL);
    PIO_ST_OK(pio_sm_is_claimed(pio0, sm0) == true);      /* 被拒的释放不能悄悄 unclaim */

    /* (d) 合法释放：账本与 SDK 桩两侧都清掉 */
    PIO_ST_OK(kres_pio_sm_release(0, (uint32_t)sm0, KRES_KERNEL) == true);
    PIO_ST_OK(kres_is_free(KRES_PIO_SM, kres_pio_sm_index(0, (uint32_t)sm0)));
    PIO_ST_OK(pio_sm_is_claimed(pio0, sm0) == false);
    PIO_ST_OK(kres_used_count(KRES_PIO_SM) == 0);

    /* (e) import 必须把 SDK 侧也认领 —— 否则 release 里的 unclaim 会撞上真 SDK 的
     *     assert(hw_is_claimed(...))：2026-10-01 上机事故正是这条（stub.c:37-49）。 */
    PIO_ST_OK(kres_pio_sm_import(1, 2, KRES_DISPLAY, 5) == 0);
    PIO_ST_OK(kres_owner_of(KRES_PIO_SM, kres_pio_sm_index(1, 2)) == KRES_DISPLAY);
    PIO_ST_OK(pio_sm_is_claimed(pio1, 2) == true);
    PIO_ST_OK(kres_pio_sm_release(1, 2, KRES_DISPLAY) == true);
    PIO_ST_OK(pio_sm_is_claimed(pio1, 2) == false);
    PIO_ST_OK(kres_used_count(KRES_PIO_SM) == 0);

    /* (f) 失败路径：越界参数要干净拒绝（不是断言、不是越界写） */
    PIO_ST_OK(kres_pio_sm_claim(99, KRES_APP, 9) == -1);
    PIO_ST_OK(kres_pio_sm_import(0, 4, KRES_APP, 9) == -1);
    PIO_ST_OK(kres_pio_sm_release(0, 4, KRES_APP) == false);
    PIO_ST_OK(kres_used_count(KRES_PIO_SM) == 0);

    /* (g) 12 个 SM（3 个 PIO x 4）全占满 -> 第 13 个必须干净失败；
     *     且桩里 12 个都【真的】被认领、归还后【真的】全清掉。 */
    {
        for (int p = 0; p < 3; p++) {
            for (int i = 0; i < 4; i++) {
                int got = kres_pio_sm_claim((uint32_t)p, KRES_APP, 9);
                PIO_ST_OK(got >= 0 && got < 4);
            }
        }
        PIO_ST_OK(kres_used_count(KRES_PIO_SM) == KRES_PIO_SM_MAX);
        PIO_ST_OK(kres_pio_sm_claim(0, KRES_APP, 9) == -1);           /* 满了：干净失败 */
        PIO_ST_OK(pio_sm_is_claimed(pio0, 0) && pio_sm_is_claimed(pio0, 3) &&
                  pio_sm_is_claimed(pio1, 0) && pio_sm_is_claimed(pio2, 3));
        for (int p = 0; p < 3; p++) {
            for (int i = 0; i < 4; i++) {
                PIO_ST_OK(kres_pio_sm_release((uint32_t)p, (uint32_t)i, KRES_APP) == true);
            }
        }
        PIO_ST_OK(kres_used_count(KRES_PIO_SM) == 0);
        PIO_ST_OK(!pio_sm_is_claimed(pio0, 0) && !pio_sm_is_claimed(pio1, 3) &&
                  !pio_sm_is_claimed(pio2, 2));
    }

    g_pio_selftest_status = 1;
}

#undef PIO_ST_OK

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

    /* 3) PIO 认领 / 越权 / import：主机侧新增用例（为什么不在 kres_selftest()
     *    里，见本文件上方那段长注释：板子路径故意不碰 PIO 硬件）。
     *    ⚠️ 只跑在 PC 上，认领的是桩；这一步不改板子行为。 */
    pio_claim_host_selftest();
    printf("%-22s : %s   steps=%2u   first_fail_at=%u\n",
           "PIO claim (host-side)",
           (g_pio_selftest_status == 1) ? "PASS" : "FAIL",
           (unsigned)g_pio_selftest_steps,
           (unsigned)g_pio_selftest_fail_at);
    if (g_pio_selftest_status != 1) fail++;

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
