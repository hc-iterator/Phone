/*
 * kernel_res_borrow.c —— 资源的【借用】语义
 *
 * 设计说明见 kernel_res_borrow.h。实现上强调三条：
 *
 * 1. 【不碰 kernel_res 的内部表】。真正占/还都走 kres_claim / kres_is_free /
 *    kres_release，所以这是纯增量，已验证的 12 步自检完全不受影响。
 *
 * 2. 【等待队列静态、定长、可中断安全】。没有 malloc、没有链表；
 *    查找是 O(16) 的小循环。队列满就诚实拒绝，不让它无限膨胀。
 *
 * 3. ★【归还时收紧越权检查】★
 *    账本原来的 kres_release 只比对【所有者类别】，不比对实例号 ——
 *    也就是说同为 KRES_APP 的两个应用之间可以互相释放对方的资源。
 *    这是账本里的真问题（写本模块的测试时发现的）。
 *    借用层不等账本改，自己先用 kres_owned_by() 做【严格实例校验】，
 *    再调 kres_release()，把这个洞堵在本层。
 */

#include "kernel_res_borrow.h"

#include <string.h>

#include "pico/time.h"      /* time_us_32() / busy_wait_us_32() */

/* ===========================================================================
 * 等待队列
 * =========================================================================== */

typedef struct {
    uint8_t  used;
    uint8_t  kind;        /* kres_kind_t */
    uint8_t  prio;        /* kres_prio_t */
    uint8_t  owner;       /* kres_owner_t */
    uint16_t res_id;
    uint16_t owner_id;
    uint32_t deadline;    /* 0 = 不过期 */
    uint32_t seq;         /* 同优先级按它 FIFO */
} kresb_wait_t;

static kresb_wait_t g_wait[KRESB_WAITQ_MAX];
static uint32_t     g_seq;

volatile uint32_t g_kres_stat_contention = 0;
volatile uint32_t g_kres_stat_enqueued   = 0;
volatile uint32_t g_kres_stat_granted    = 0;
volatile uint32_t g_kres_stat_timeouts   = 0;
volatile uint32_t g_kres_stat_queue_full = 0;

volatile uint32_t g_kresb_selftest_status  = 0;
volatile uint32_t g_kresb_selftest_steps   = 0;
volatile uint32_t g_kresb_selftest_fail_at = 0;

void kres_borrow_init(void) {
    memset(g_wait, 0, sizeof(g_wait));
    g_seq = 0;
}

/* time_us_32() 约 71.6 分钟回绕一次。
 * 用【有符号差值】比较：32 位减法在回绕处也是对的，这是标准做法。 */
static bool wait_expired(uint32_t deadline) {
    if (deadline == 0) return false;                 /* 0 = 不过期 */
    return (int32_t)(time_us_32() - deadline) >= 0;
}

static bool args_ok(kres_kind_t k, uint32_t id) {
    if ((int)k < 0 || k >= KRES_KIND_COUNT) return false;
    return id < kres_capacity(k);
}

static int wait_find(kres_kind_t k, uint32_t id,
                     kres_owner_t owner, uint16_t owner_id) {
    for (int i = 0; i < KRESB_WAITQ_MAX; i++) {
        if (!g_wait[i].used) continue;
        if (g_wait[i].kind == (uint8_t)k && g_wait[i].res_id == (uint16_t)id &&
            g_wait[i].owner == (uint8_t)owner && g_wait[i].owner_id == owner_id) {
            return i;
        }
    }
    return -1;
}

/* 某个资源上"最该轮到"的等待者：优先级最高，同优先级序号最小 */
static int wait_find_best(kres_kind_t k, uint32_t id) {
    int best = -1;
    for (int i = 0; i < KRESB_WAITQ_MAX; i++) {
        if (!g_wait[i].used) continue;
        if (g_wait[i].kind != (uint8_t)k || g_wait[i].res_id != (uint16_t)id) continue;
        if (best < 0) { best = i; continue; }
        if (g_wait[i].prio > g_wait[best].prio) { best = i; continue; }
        if (g_wait[i].prio == g_wait[best].prio && g_wait[i].seq < g_wait[best].seq) {
            best = i;
        }
    }
    return best;
}

static int wait_alloc(void) {
    for (int i = 0; i < KRESB_WAITQ_MAX; i++) {
        if (!g_wait[i].used) return i;
    }
    return -1;
}

/* 清掉所有过期的等待者，返回清掉的个数 */
static uint32_t wait_reap(void) {
    uint32_t n = 0;
    for (int i = 0; i < KRESB_WAITQ_MAX; i++) {
        if (!g_wait[i].used) continue;
        if (wait_expired(g_wait[i].deadline)) {
            g_wait[i].used = 0;
            g_kres_stat_timeouts++;
            n++;
        }
    }
    return n;
}

/* 资源空闲的话，把它判给队列里优先级最高的等待者（归还即自动转交） */
static void grant_best(kres_kind_t k, uint32_t id) {
    if (!kres_is_free(k, id)) return;
    int b = wait_find_best(k, id);
    if (b < 0) return;
    if (kres_claim(k, id, (kres_owner_t)g_wait[b].owner,
                   g_wait[b].owner_id, 0, 0) != 0) {
        return;   /* 拿不下来就留着，等下次 poll */
    }
    g_wait[b].used = 0;
    g_kres_stat_granted++;
}

/* ===========================================================================
 * 公开 API
 * =========================================================================== */

int kres_acquire(kres_kind_t k, uint32_t id,
                 kres_owner_t owner, uint16_t owner_id,
                 kres_prio_t prio, uint32_t timeout_us) {
    if (!args_ok(k, id)) return KRESB_EBADARG;
    if (owner == KRES_FREE) return KRESB_EBADARG;
    if ((int)prio < 0 || prio >= KRES_PRIO_COUNT) return KRESB_EBADARG;

    wait_reap();

    /* ① 已经是我自己的 ⇒ 幂等成功（不重复占队列位） */
    if (kres_owned_by(k, id, owner, owner_id)) {
        int me = wait_find(k, id, owner, owner_id);
        if (me >= 0) g_wait[me].used = 0;
        return KRESB_OK;
    }

    /* ② 空闲 ⇒ 立刻拿到 */
    if (kres_is_free(k, id)) {
        if (kres_claim(k, id, owner, owner_id, 0, 0) == 0) {
            int me = wait_find(k, id, owner, owner_id);
            if (me >= 0) g_wait[me].used = 0;
            return KRESB_OK;
        }
    }

    /* ③ 忙 ⇒ 登记排队并【立刻返回】，绝不死等（规范 4） */
    g_kres_stat_contention++;

    int me = wait_find(k, id, owner, owner_id);
    if (me < 0) {
        me = wait_alloc();
        if (me < 0) {
            g_kres_stat_queue_full++;
            return KRESB_EQUEUEFULL;
        }
        g_wait[me].used     = 1;
        g_wait[me].kind     = (uint8_t)k;
        g_wait[me].res_id   = (uint16_t)id;
        g_wait[me].owner    = (uint8_t)owner;
        g_wait[me].owner_id = owner_id;
        g_wait[me].seq      = ++g_seq;
        g_kres_stat_enqueued++;
    }
    /* 重复 acquire 时刷新优先级与截止时间（幂等） */
    g_wait[me].prio     = (uint8_t)prio;
    g_wait[me].deadline = (timeout_us == 0) ? 0u : (time_us_32() + timeout_us);
    return KRESB_EBUSY;
}

int kres_poll(kres_kind_t k, uint32_t id,
              kres_owner_t owner, uint16_t owner_id) {
    if (!args_ok(k, id)) return KRESB_EBADARG;

    /* 已经拿到 ⇒ 退队并成功 */
    if (kres_owned_by(k, id, owner, owner_id)) {
        int me = wait_find(k, id, owner, owner_id);
        if (me >= 0) g_wait[me].used = 0;
        return KRESB_OK;
    }

    int me = wait_find(k, id, owner, owner_id);
    if (me < 0) return KRESB_EBADARG;      /* 我不在排队 */

    /* 自己过期要先报出来：wait_reap 会把它抹掉，那就分不清超时还是没排队 */
    if (wait_expired(g_wait[me].deadline)) {
        g_wait[me].used = 0;
        g_kres_stat_timeouts++;
        return KRESB_ETIMEOUT;
    }

    wait_reap();      /* 顺手清掉别人过期的 */

    me = wait_find(k, id, owner, owner_id);
    if (me < 0) return KRESB_EBADARG;

    /* 轮到我了吗？（资源空 + 我是最优等待者） */
    if (kres_is_free(k, id) && wait_find_best(k, id) == me) {
        if (kres_claim(k, id, owner, owner_id, 0, 0) == 0) {
            g_wait[me].used = 0;
            g_kres_stat_granted++;
            return KRESB_OK;
        }
    }
    return KRESB_EBUSY;
}

int kres_borrow_release(kres_kind_t k, uint32_t id,
                        kres_owner_t owner, uint16_t owner_id) {
    if (!args_ok(k, id)) return KRESB_EBADARG;

    /* ★严格越权检查：必须是【这个实例本人】，或内核。
     * 账本原来的检查只比类别，同类的两个应用能互相释放 —— 这里堵住。 */
    if (owner != KRES_KERNEL && !kres_owned_by(k, id, owner, owner_id)) {
        return KRESB_EBADARG;
    }
    if (kres_is_free(k, id)) return KRESB_EBADARG;

    int r = kres_release(k, id, owner);
    if (r != 0) return r;

    grant_best(k, id);      /* 归还即自动转交给最该轮到的人 */
    return KRESB_OK;
}

uint32_t kres_wait_count(kres_kind_t k, uint32_t id) {
    uint32_t n = 0;
    for (int i = 0; i < KRESB_WAITQ_MAX; i++) {
        if (g_wait[i].used && g_wait[i].kind == (uint8_t)k &&
            g_wait[i].res_id == (uint16_t)id) {
            n++;
        }
    }
    return n;
}

uint32_t kres_wait_total(void) {
    uint32_t n = 0;
    for (int i = 0; i < KRESB_WAITQ_MAX; i++) if (g_wait[i].used) n++;
    return n;
}

/* ===========================================================================
 * 自检
 *
 * 用 KRES_BLOCKDEV（块设备，容量 8，语义上最像"借来用一下"的东西）
 * 和 KRES_MPU_REGION（容量 8）来测，不去动 DMA/PIO 这些硬件真正占用的种类。
 * =========================================================================== */

#define KRESB_K   KRES_BLOCKDEV
#define KRESB_ID  0u

#define KRESB_ST_OK(cond)                                                 \
    do {                                                                  \
        step++;                                                           \
        g_kresb_selftest_steps = step;                                    \
        if (!(cond)) {                                                    \
            g_kresb_selftest_fail_at = step;                              \
            g_kresb_selftest_status = 0;                                  \
            return;                                                       \
        }                                                                 \
    } while (0)

void kres_borrow_selftest(void) {
    uint32_t step = 0;
    g_kresb_selftest_status  = 0;
    g_kresb_selftest_fail_at = 0;

    kres_borrow_init();

    /* 1. 起点 */
    KRESB_ST_OK(kres_wait_total() == 0);
    KRESB_ST_OK(kres_is_free(KRESB_K, KRESB_ID));

    /* 2. 空闲时立刻成功，账本归我 */
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_APP, 1, KRES_PRIO_APP, 0) == KRESB_OK);
    KRESB_ST_OK(kres_owned_by(KRESB_K, KRESB_ID, KRES_APP, 1));

    /* 3. 自己再借 = 幂等 */
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_APP, 1, KRES_PRIO_APP, 0) == KRESB_OK);
    KRESB_ST_OK(kres_wait_total() == 0);

    /* 4. 别人来借 ⇒ 撞忙、入队、立刻返回 */
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_APP, 2, KRES_PRIO_APP, 0) == KRESB_EBUSY);
    KRESB_ST_OK(kres_wait_count(KRESB_K, KRESB_ID) == 1);

    /* 5. 他再借一次 ⇒ 幂等，队列位没被重复占 */
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_APP, 2, KRES_PRIO_APP, 0) == KRESB_EBUSY);
    KRESB_ST_OK(kres_wait_count(KRESB_K, KRESB_ID) == 1);

    /* 6. 我归还 ⇒ 【自动】判给他，他不必来 poll */
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_APP, 1) == KRESB_OK);
    KRESB_ST_OK(kres_owned_by(KRESB_K, KRESB_ID, KRES_APP, 2));
    KRESB_ST_OK(kres_wait_count(KRESB_K, KRESB_ID) == 0);

    /* 7. 他还回来 ⇒ 归零 */
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_APP, 2) == KRESB_OK);
    KRESB_ST_OK(kres_is_free(KRESB_K, KRESB_ID));

    /* 8. ★优先级插队：后台先排，显示后排 ⇒ 释放后【显示】先拿 */
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_KERNEL, 100, KRES_PRIO_DISPLAY, 0) == KRESB_OK);
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_APP, 11, KRES_PRIO_BACKGROUND, 0) == KRESB_EBUSY);
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_APP, 12, KRES_PRIO_DISPLAY, 0) == KRESB_EBUSY);
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_KERNEL, 100) == KRESB_OK);
    KRESB_ST_OK(kres_owned_by(KRESB_K, KRESB_ID, KRES_APP, 12));       /* 高优先级拿到 */
    KRESB_ST_OK(kres_wait_count(KRESB_K, KRESB_ID) == 1);              /* 低优先级还在等 */

    /* 9. 再释放 ⇒ 轮到后台（是排队，不是被丢弃） */
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_APP, 12) == KRESB_OK);
    KRESB_ST_OK(kres_owned_by(KRESB_K, KRESB_ID, KRES_APP, 11));
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_APP, 11) == KRESB_OK);

    /* 10. 同优先级 FIFO */
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_KERNEL, 101, KRES_PRIO_DISPLAY, 0) == KRESB_OK);
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_APP, 21, KRES_PRIO_APP, 0) == KRESB_EBUSY);
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_APP, 22, KRES_PRIO_APP, 0) == KRESB_EBUSY);
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_KERNEL, 101) == KRESB_OK);
    KRESB_ST_OK(kres_owned_by(KRESB_K, KRESB_ID, KRES_APP, 21));       /* 21 在前 */
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_APP, 21) == KRESB_OK);
    KRESB_ST_OK(kres_owned_by(KRESB_K, KRESB_ID, KRES_APP, 22));
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_APP, 22) == KRESB_OK);

    /* 11. ★超时：排队后不取，过期必须自动退队并报 ETIMEOUT */
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_KERNEL, 102, KRES_PRIO_DISPLAY, 0) == KRESB_OK);
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_APP, 31, KRES_PRIO_APP, 50) == KRESB_EBUSY);
    KRESB_ST_OK(kres_wait_count(KRESB_K, KRESB_ID) == 1);
    busy_wait_us_32(300);                                   /* 故意拖过截止时间 */
    KRESB_ST_OK(kres_poll(KRESB_K, KRESB_ID, KRES_APP, 31) == KRESB_ETIMEOUT);
    KRESB_ST_OK(kres_wait_count(KRESB_K, KRESB_ID) == 0);   /* 自动退队 */
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_KERNEL, 102) == KRESB_OK);

    /* 12. ★严格越权：同类别的【另一个实例】也不能替我归还 */
    KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_APP, 41, KRES_PRIO_APP, 0) == KRESB_OK);
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_APP, 99) == KRESB_EBADARG);  /* 别的应用 */
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_NET, 41) == KRESB_EBADARG);  /* 别的类别 */
    KRESB_ST_OK(kres_owned_by(KRESB_K, KRESB_ID, KRES_APP, 41));       /* 没被抢走 */
    KRESB_ST_OK(kres_borrow_release(KRESB_K, KRESB_ID, KRES_APP, 41) == KRESB_OK);

    /* 13. 队列满：诚实拒绝，不悄悄丢请求 */
    {
        KRESB_ST_OK(kres_acquire(KRESB_K, KRESB_ID, KRES_KERNEL, 200, KRES_PRIO_DISPLAY, 0) == KRESB_OK);
        int full_seen = 0;
        for (uint16_t i = 0; i < KRESB_WAITQ_MAX + 3; i++) {
            int r = kres_acquire(KRESB_K, KRESB_ID, KRES_APP,
                                 (uint16_t)(300 + i), KRES_PRIO_BACKGROUND, 0);
            if (r == KRESB_EQUEUEFULL) { full_seen = 1; break; }
            KRESB_ST_OK(r == KRESB_EBUSY);
        }
        KRESB_ST_OK(full_seen == 1);
        KRESB_ST_OK(kres_release(KRESB_K, KRESB_ID, KRES_KERNEL) == 0);   /* 内核强制收场 */
        kres_borrow_init();
        KRESB_ST_OK(kres_wait_total() == 0);
        KRESB_ST_OK(kres_is_free(KRESB_K, KRESB_ID));
    }

    /* 14. MPU 区域也是一类资源：8 个，第 9 个必须失败 */
    {
        int got = 0;
        uint32_t cap = kres_capacity(KRES_MPU_REGION);
        for (uint32_t i = 0; i < cap; i++) {
            if (kres_claim(KRES_MPU_REGION, i, KRES_KERNEL, 1, i,
                           0x20000000u + (i << 12)) == 0) {
                got++;
            }
        }
        KRESB_ST_OK(cap == 8);
        KRESB_ST_OK(got == 8);
        KRESB_ST_OK(kres_used_count(KRES_MPU_REGION) == 8);
        KRESB_ST_OK(kres_claim(KRES_MPU_REGION, 99, KRES_APP, 1, 0, 0) != 0);  /* id 越界 */
        for (uint32_t i = 0; i < cap; i++) kres_release(KRES_MPU_REGION, i, KRES_KERNEL);
        KRESB_ST_OK(kres_used_count(KRES_MPU_REGION) == 0);
    }

    /* 15. 收尾 */
    KRESB_ST_OK(kres_wait_total() == 0);

    g_kresb_selftest_status = 1;
}

#undef KRESB_ST_OK
#undef KRESB_K
#undef KRESB_ID
