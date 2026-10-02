#ifndef KERNEL_RES_BORROW_H
#define KERNEL_RES_BORROW_H

/*
 * kernel_res_borrow —— 资源的【借用】语义（规范 6b 的落地）
 *
 * ── 为什么要有它 ──
 *
 * kernel_res 原本只有 claim / release，也就是【独占、长期】。
 * 但没有借用语义的话，**一个后台应用就能永久占住 SDIO 卡、SPI 总线这类资源**，
 * 而这类资源天生是"用完就该还、大家轮着用"的。
 * 规范 6b 说的"硬件资源调度器"，第一件缺的就是这个。
 *
 * ── 三条设计决定（都不是随便定的）──
 *
 * 1. 【不阻塞】。acquire 撞上"有人占着"时，只是**登记排队**并返回 KRES_EBUSY，
 *    绝不在内核里干等 —— 这条直接来自 规范 4（禁止无超时死等）。
 *    "等"这件事交给调用方：它可以去睡一会儿，回头用 poll 问一句。
 *    ⚠️ 将来有了调度器，就是调度器负责睡和醒；现在没有调度器也不会死等。
 *
 * 2. 【每个等待都带截止时间】。过期之后 poll 返回 KRES_ETIMEOUT 并**自动退队**，
 *    所以队列不会因为等待者死掉而永久占着位置（这正是"必须超时"的价值）。
 *
 * 3. 【优先级 + 同优先级 FIFO】。显示 > 音频 > 前台 > 后台。
 *    ⚠️ 现在**不做抢占** —— 规范 6b 规则 4 写明：没有事故就不做。
 *    优先级只决定"资源被释放时判给谁"。
 *    低优先级被饿死的次数会记账，将来靠这个数字决定要不要上 aging。
 *
 * ── 与账本的关系 ──
 *
 * 本模块**只用 kernel_res 的公开 API**（kres_is_free / kres_claim / kres_release），
 * 不碰它的内部表。因此它是【纯增量】：已验证的 12 步自检一点都不受影响。
 *
 * 它还顺带解决一个健壮性问题：即使某个长期持有者用普通的 kres_release 归还
 * （而不是 kres_borrow_release），等待者下一次 poll 也会发现自己已经能拿了 ——
 * 所以"忘了通知队列"不会造成永久卡死。
 */

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

#include "kernel_res.h"

/* ── 返回码（与 kernel_res 的 -1/-2/-3 区分开，便于诊断）── */
#define KRESB_OK           0
#define KRESB_EBUSY      (-20)   /* 有人占着；若已排队，稍后 poll */
#define KRESB_ETIMEOUT   (-21)   /* 等超时了，已自动退队 */
#define KRESB_EBADARG    (-22)   /* 参数不合法 */
#define KRESB_EQUEUEFULL (-23)   /* 等待队列满了（这是"资源不够"的诚实回答）*/

/* ── 优先级：数值越大越优先 ── */
typedef enum {
    KRES_PRIO_BACKGROUND = 0,   /* 后台 */
    KRES_PRIO_APP        = 1,   /* 前台应用 */
    KRES_PRIO_AUDIO      = 2,   /* 音频 */
    KRES_PRIO_DISPLAY    = 3,   /* 显示（最高） */
    KRES_PRIO_COUNT
} kres_prio_t;

/* 等待队列长度。小是故意的：队列满就该让调用方知道，而不是无限膨胀。 */
#define KRESB_WAITQ_MAX 16

/* 清空等待队列（上电调用）。不动硬件，也不动账本。 */
void kres_borrow_init(void);

/*
 * 借一次。**不阻塞。**
 *
 *   资源空闲   ⇒ 立即拿到，返回 KRESB_OK
 *   资源被占   ⇒ 登记排队（带优先级和截止时间），返回 KRESB_EBUSY
 *   参数不合法 ⇒ KRESB_EBADARG
 *   队列满     ⇒ KRESB_EQUEUEFULL
 *
 * timeout_us = 0 表示"永不过期"（不推荐，但调试时有用）。
 * 同一个 (资源, 所有者) 重复 acquire 是**幂等**的：不会重复占队列位。
 */
int kres_acquire(kres_kind_t k, uint32_t id,
                 kres_owner_t owner, uint16_t owner_id,
                 kres_prio_t prio, uint32_t timeout_us);

/*
 * 问一句："轮到我了吗？"
 *
 *   已拿到      ⇒ KRESB_OK（并且这一项已经从队列里移除）
 *   还没轮到    ⇒ KRESB_EBUSY
 *   已经超时    ⇒ KRESB_ETIMEOUT（自动退队）
 *   没在排队    ⇒ KRESB_EBADARG
 *
 * 顺便会清理**所有**过期的等待者（不只我自己），免得队列被死掉的等待者占住。
 */
int kres_poll(kres_kind_t k, uint32_t id,
              kres_owner_t owner, uint16_t owner_id);

/*
 * 归还借用，并把资源判给队列里优先级最高的等待者。
 *
 * ★为什么这里要带 owner_id★
 *   账本原来的 kres_release(k,id,owner) 只比对【所有者类别】，
 *   不比对实例号 —— 也就是说同为 KRES_APP 的两个应用可以互相释放对方的资源。
 *   本函数先在 kres_owned_by() 上做【严格实例校验】，再调 kres_release()，
 *   把这个洞堵在借用层。（账本自己那层以后要收紧成同样的检查。）
 */
int kres_borrow_release(kres_kind_t k, uint32_t id,
                        kres_owner_t owner, uint16_t owner_id);

/* ── 诊断（规范 5：状态上报要能读）── */

/* 某个资源上有几个等待者 */
uint32_t kres_wait_count(kres_kind_t k, uint32_t id);
/* 全局等待者总数 */
uint32_t kres_wait_total(void);

extern volatile uint32_t g_kres_stat_contention;  /* 撞上"忙"的次数 */
extern volatile uint32_t g_kres_stat_enqueued;    /* 实际入队次数 */
extern volatile uint32_t g_kres_stat_granted;     /* 排队后成功拿到次数 */
extern volatile uint32_t g_kres_stat_timeouts;    /* 超时次数 */
extern volatile uint32_t g_kres_stat_queue_full;  /* 队列满拒绝次数 */

/* ── 自检 ──
 *
 * 独立于 kres_selftest，**不动那个已验证的 12 步**。
 * 覆盖：立即拿到 / 忙时入队 / 幂等 / 归还后自动判给等待者 /
 *       优先级插队 / 同优先级 FIFO / 超时自动退队 / 越权 / 队列满 / MPU 区域。
 */
extern volatile uint32_t g_kresb_selftest_status;
extern volatile uint32_t g_kresb_selftest_steps;
extern volatile uint32_t g_kresb_selftest_fail_at;
void kres_borrow_selftest(void);

#ifdef __cplusplus
}
#endif

#endif /* KERNEL_RES_BORROW_H */
