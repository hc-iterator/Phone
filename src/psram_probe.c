/*
 * psram_probe.c —— PSRAM 诊断：验明正身（2026-09-27 重写）
 *
 * 设计原则：【只读，不写】。
 *
 * 旧版本是拿连续写入去顶，把板子顶死之后什么也问不出来。
 * 新版本只做一件事：把四个候选片选脚逐个当 CS1，各读一次器件 ID。
 * 读 ID 是一次 8 字节的 QMI 命令，不碰 PSRAM 存储阵列，
 * 所以【没有挂死风险】，可以无条件在启动时跑。
 *
 * 判据：
 *   真 APS6404  → rx[5] (KGD) == 0x5D，容量可换算（通常 8 MiB）
 *   悬空/无器件 → KGD 为 0x00 或 0xFF，容量 0
 *
 * 于是只要看两件事就能定案：
 *   1. g_psram_diag_pin[i] 里有【哪个脚】真的答了 0x5D；
 *   2. g_psram_diag_sdk_cs_gpio（SDK 认定的脚）和上面对不对得上。
 *   对不上 ⇒ 自动检测假阳性 ⇒ 芯片根本不在。
 */

#include <stdio.h>

#include "pico/stdlib.h"
#include "pico/time.h"
#include "hardware/gpio.h"
#include "hardware/flash.h"
#include "hardware/psram.h"
#include "hardware/watchdog.h"
#include "hardware/structs/qmi.h"

#include "psram_probe.h"

/* PSRAM 在 RP2350 上的映射基址（XIP 区之后） */
#define PSRAM_BASE 0x11000000u

/* PSRAM 的 SPI 命令字（与 SDK 的 hardware_psram/psram.c 一致） */
#define PSRAM_READ_ID_CMD  0x9Fu   /* RDID：读器件 ID */
#define PSRAM_NOOP_CMD     0xFFu   /* 后面跟 7 个 NOOP 把回包时钟出来 */

/* PSRAM ID 里的 KGD（Known Good Die）字节，APS6404 应为 0x5D */
#define PSRAM_EXPECTED_KGD 0x5D

/*
 * SDK 在 RP2350B 上会去试的候选片选脚（抄自 psram.c 的 PICO_AVAILABLE_CS1_GPIOS）。
 * 注意 RP2350A 只有 {0,8,19}，RP2350B 才有 47。
 * 本板是 RP2350B。
 */
static const uint8_t k_candidates[PSRAM_DIAG_PINS] = { 0, 8, 19, 47 };

/* ── 诊断结果（全部 SWD 可直接读）── */
volatile uint32_t g_psram_diag_done         = 0;
volatile uint32_t g_psram_diag_sdk_cs_gpio  = 0xFFFFFFFFu;
volatile uint32_t g_psram_diag_pin[PSRAM_DIAG_PINS]  = { 0 };
volatile uint32_t g_psram_diag_kgd[PSRAM_DIAG_PINS]  = { 0 };
volatile uint32_t g_psram_diag_eid[PSRAM_DIAG_PINS]  = { 0 };
volatile uint32_t g_psram_diag_size[PSRAM_DIAG_PINS] = { 0 };
volatile uint32_t g_psram_diag_raw[PSRAM_DIAG_PINS]  = { 0 };
volatile uint32_t g_psram_diag_qmi_timing  = 0;
volatile uint32_t g_psram_diag_divisor     = 0;
volatile uint32_t g_psram_diag_rxdelay     = 0;
volatile uint32_t g_psram_diag_max_select  = 0;
volatile uint32_t g_psram_diag_min_deselect = 0;

/* ------------------------------------------------------------------------- */

/*
 * 读一次器件 ID，8 字节回包写进 rx。
 *
 * 照抄 SDK psram_detect_size() 的关键一步：
 *   先把 cs_size 设成【非零】，这样 bootrom 才会对 CS1 发 XIP 退出序列
 *   （XIP exit sequence），否则片选根本不会真的动。
 *   片选脚的功能由调用方自己设 —— 那个参数 SDK 注释里明说不重要。
 */
static void read_id_once(uint8_t *rx) {
    uint8_t tx[8];
    tx[0] = PSRAM_READ_ID_CMD;
    for (int i = 1; i < 8; i++) tx[i] = PSRAM_NOOP_CMD;

    flash_devinfo_size_t prev_size = flash_devinfo_get_cs_size(1);
    flash_devinfo_set_cs_size(1, FLASH_DEVINFO_SIZE_8K);
    flash_do_cmd_cs(tx, rx, 8, 1);
    flash_devinfo_set_cs_size(1, prev_size);
}

/* ------------------------------------------------------------------------- */

void psram_diag_run(void) {
    /* ── 1. 先把 QMI 的 M1（PSRAM）时序抄下来 ──
     * SDK 在 runtime init 里已经配过了，这里只是把字段拆出来给人看。
     * 如果 divisor 是 0 或离谱，说明配置路径有问题。 */
    uint32_t timing = qmi_hw->m[1].timing;
    g_psram_diag_qmi_timing   = timing;
    g_psram_diag_divisor      = (timing & QMI_M1_TIMING_CLKDIV_BITS)     >> QMI_M1_TIMING_CLKDIV_LSB;
    g_psram_diag_rxdelay      = (timing & QMI_M1_TIMING_RXDELAY_BITS)     >> QMI_M1_TIMING_RXDELAY_LSB;
    g_psram_diag_max_select   = (timing & QMI_M1_TIMING_MAX_SELECT_BITS)  >> QMI_M1_TIMING_MAX_SELECT_LSB;
    g_psram_diag_min_deselect = (timing & QMI_M1_TIMING_MIN_DESELECT_BITS)>> QMI_M1_TIMING_MIN_DESELECT_LSB;

    /* ── 2. SDK 最终把片选认到了哪个脚 ── */
    g_psram_diag_sdk_cs_gpio = (uint32_t)flash_devinfo_get_cs_gpio(1);

    /* ── 3. 逐个候选脚试探 ──
     * 先把所有候选脚都清成 GPIO_FUNC_NULL，避免两个脚同时是 CS1 互相干扰
     * （SDK 的 psram_detect_cs_and_size 也是这么做的）。
     * 同时记下它们原来的功能，诊断完原样还回去。 */
    uint32_t prev_func[PSRAM_DIAG_PINS];
    for (int i = 0; i < PSRAM_DIAG_PINS; i++) {
        prev_func[i] = (uint32_t)gpio_get_function(k_candidates[i]);
        g_psram_diag_pin[i] = k_candidates[i];
        gpio_set_function(k_candidates[i], GPIO_FUNC_NULL);
    }

    for (int i = 0; i < PSRAM_DIAG_PINS; i++) {
        uint8_t rx[8] = { 0 };

        flash_devinfo_set_cs_gpio(1, k_candidates[i]);
        gpio_set_function(k_candidates[i], GPIO_FUNC_XIP_CS1);

        read_id_once(rx);

        /* 测完立刻把这个脚放开，免得影响下一个 */
        gpio_set_function(k_candidates[i], GPIO_FUNC_NULL);

        uint32_t raw = 0;
        for (int k = 0; k < 8; k++) {
            raw |= ((uint32_t)rx[k]) << (8 * k);
        }
        g_psram_diag_raw[i]  = raw;
        g_psram_diag_kgd[i]  = rx[5];
        g_psram_diag_eid[i]  = rx[6];
        g_psram_diag_size[i] = (uint32_t)psram_eid_to_size(rx[5], rx[6]);
    }

    /* ── 4. 恢复原状 ──
     * 注意 prev_func 是在本函数开头读的，那时 SDK 已经配好了它认定的片选脚，
     * 所以还回去的内容正好就是 SDK 的状态。 */
    for (int i = 0; i < PSRAM_DIAG_PINS; i++) {
        gpio_set_function(k_candidates[i], (gpio_function_t)prev_func[i]);
    }
    if (g_psram_diag_sdk_cs_gpio < 48u) {
        flash_devinfo_set_cs_gpio(1, (uint)g_psram_diag_sdk_cs_gpio);
        gpio_set_function((uint)g_psram_diag_sdk_cs_gpio, GPIO_FUNC_XIP_CS1);
    }

    g_psram_diag_done = 1;
}

/* ------------------------------------------------------------------------- */

void psram_probe_report(void) {
    printf("\n--- PSRAM 诊断（只读 ID，不写内存）---\n");
    printf("  SDK 报告的可用性 = %d, 容量 = %u KiB\n",
           psram_is_available() ? 1 : 0,
           (unsigned)(psram_get_size() / 1024));
    printf("  SDK 最终认定的片选脚 = GPIO%u\n",
           (unsigned)g_psram_diag_sdk_cs_gpio);
    printf("  QMI M1 timing = 0x%08X (clkdiv=%u rxdelay=%u max_sel=%u min_desel=%u)\n",
           (unsigned)g_psram_diag_qmi_timing,
           (unsigned)g_psram_diag_divisor,
           (unsigned)g_psram_diag_rxdelay,
           (unsigned)g_psram_diag_max_select,
           (unsigned)g_psram_diag_min_deselect);

    printf("  逐个候选片选脚读 ID：\n");
    int found = -1;
    for (int i = 0; i < PSRAM_DIAG_PINS; i++) {
        printf("    GPIO%-2u : KGD=0x%02X EID=0x%02X 容量=%u KiB  raw=0x%08X%s\n",
               (unsigned)g_psram_diag_pin[i],
               (unsigned)g_psram_diag_kgd[i],
               (unsigned)g_psram_diag_eid[i],
               (unsigned)(g_psram_diag_size[i] / 1024),
               (unsigned)g_psram_diag_raw[i],
               (g_psram_diag_kgd[i] == PSRAM_EXPECTED_KGD) ? "   <== 有器件!" : "");
        if (g_psram_diag_kgd[i] == PSRAM_EXPECTED_KGD) found = i;
    }

    if (found < 0) {
        printf("  >>> 结论：四个候选脚上【都没有】PSRAM 器件。\n");
        printf("      SDK 那个 \"8 MiB\" 是自动检测的假阳性 —— 芯片根本不在板上\n");
        printf("      （微雪 wiki 说这块板 PSRAM 只是 a reserved PSRAM pad）。\n");
    } else if ((uint32_t)k_candidates[found] == g_psram_diag_sdk_cs_gpio) {
        printf("  >>> 结论：芯片真的在 GPIO%u 上，SDK 也认对了。\n",
               (unsigned)k_candidates[found]);
        printf("      那么\"连续写入挂死\"是时序/信号完整性问题，继续查。\n");
    } else {
        printf("  >>> 结论：芯片在 GPIO%u 上，但 SDK 认成了 GPIO%u —— 认错了脚！\n",
               (unsigned)k_candidates[found],
               (unsigned)g_psram_diag_sdk_cs_gpio);
    }
    fflush(stdout);
}

/* ===========================================================================
 * 连续写入实验（2026-09-27）
 * ===========================================================================
 *
 * 背景：诊断已经证实【芯片真的在 GPIO47 上、SDK 也认对了脚】，
 * 所以"连续 4 KiB 写入挂死"是个真实的时序/信号问题，不是"没芯片"。
 *
 * 头号嫌疑：QMI 的 MAX_SELECT（片选拉低的最长时间，单位 64 个系统时钟）
 *           超过了这颗 PSRAM 的 tCEM 上限。
 *           SDK 默认给 8000 ns，但不少 APS6404 变种只有 4000 ns。
 *           超了的话长突发会被芯片拒收，芯片内部状态机卡住，
 *           进而拖住整条 QMI —— 而取指也走 QMI ⇒ 整片挂死。
 *
 * 这个实验同时试三组 QMI 参数 × 五档长度，看哪一组能撑到 16 KiB。
 *
 * ── 关键设计：看门狗 + 断点续跑 ──
 *
 * 一次挂死就会把板子顶死，只能靠看门狗复位。所以：
 *   - 每一步开跑之前，把"步号"写进 watchdog scratch[4]（复位后仍在）；
 *   - 开机时先读 scratch[4]：如果上次正是死在这一步，
 *     就把那一步标成"挂死"，然后【从下一步继续】。
 *   ⇒ 每复位一次就多拿到一个数据点，自动跑完全部 15 步，
 *     不需要人工干预，也不会陷入"开机→挂死→复位"的死循环。
 */

#define WT_CFG_COUNT   3
#define WT_STEP_COUNT  5
#define WT_TOTAL       (WT_CFG_COUNT * WT_STEP_COUNT)
#define WT_MARK_BASE   0x50530000u   /* 'PS' + 0 + 步号，写在 watchdog scratch[0] */
#define WT_MAGIC       0x57543132u   /* 'WT12'，写在 scratch[3]，用来校验 scratch[1] 是否本固件所写 */

typedef struct {
    uint32_t divisor;      /* QSPI 分频：sys_clk / divisor */
    uint32_t rxdelay;
    uint32_t max_select;   /* 单位 = 64 个系统时钟 */
    uint32_t min_deselect;
    const char *name;
} wt_cfg_t;

/* 系统时钟按 150MHz 算：1 个 max_select 单位 = 64/150MHz ≈ 427 ns */
static const wt_cfg_t k_wt_cfg[WT_CFG_COUNT] = {
    { 2, 2, 18, 2, "A 基线   div2(75MHz)  maxsel18(7.7us)" },
    { 2, 2,  6, 2, "B 短突发 div2(75MHz)  maxsel6 (2.6us)" },
    { 4, 4, 18, 2, "C 降频   div4(37.5MHz) maxsel18(7.7us)" },
};

static const uint32_t k_wt_len[WT_STEP_COUNT] = { 16u, 256u, 1024u, 4096u, 16384u };

/* 结果：0=没跑 1=通过 2=挂死(上次复位在这里) 3=数据不符 4=重初始化失败 */
volatile uint32_t g_wt_result[WT_CFG_COUNT][WT_STEP_COUNT];
volatile uint32_t g_wt_us[WT_CFG_COUNT][WT_STEP_COUNT];
volatile uint32_t g_wt_done = 0;
volatile uint32_t g_wt_resumed_from = 0xFFFFFFFFu;   /* 上次挂死在第几步 */
volatile uint32_t g_wt_hung_mask = 0;                /* 挂死步的位图（存在 watchdog scratch[1]） */
volatile uint32_t g_wt_end_config_ok = 0;

void psram_writetest_run(void) {
    /* ── 1. 看上次是不是挂死在这套实验里 ──
     *
     * ⚠️ 必须用 scratch[0..3]，【不能用 scratch[4..7]】。
     *
     * 踩过的坑：一开始我用的是 scratch[4]，结果续跑从来没生效。
     * 原因在 SDK 的 watchdog.c：
     *     watchdog_hw->scratch[4] = WATCHDOG_NON_REBOOT_MAGIC;  // watchdog_enable() 写的
     *     watchdog_hw->scratch[5..7] = ...                      // watchdog_reboot() 用的
     * 也就是说 4~7 是 SDK 保留的，我一调 watchdog_enable() 就把自己的标记冲掉了。
     *
     * scratch 分工：
     *   scratch[0] = 当前正在跑第几步（WT_MARK_BASE | idx）
     *   scratch[1] = 【挂死步的位图】—— 必须在 scratch 里，不能只在 RAM 里！
     *
     * 为什么位图非放 scratch 不可（第二个坑）：
     *   g_wt_result 在 RAM 里，复位就清零。如果只靠 scratch[0] 记住"最后"
     *   挂死的那一步，那么复位后更早挂死的步会被重跑、又挂死 ——
     *   实验会在两步之间无限循环，永远跑不完。
     *   用位图把【所有】挂死过的步都记住，才能单调向前收敛。
     */
    uint32_t hung_mask = 0;

    /* scratch[3] 放一个 magic，用来判断 scratch[1] 里的位图是不是【本固件】
     * 写的。否则刷入新固件后首次启动时，scratch 里残留的旧值会被
     * 误当成"这些步挂死过"，直接污染整份结果。 */
    if (watchdog_hw->scratch[3] == WT_MAGIC) {
        hung_mask = watchdog_hw->scratch[1];
    }

    uint32_t mark = watchdog_hw->scratch[0];
    if ((mark & 0xFFFF0000u) == WT_MARK_BASE) {
        uint32_t idx = mark & 0xFFFFu;
        if (idx < WT_TOTAL) {
            hung_mask |= (1u << idx);      /* 把这一步永久记进位图 */
            g_wt_resumed_from = idx;
        }
        watchdog_hw->scratch[0] = 0;
    }

    hung_mask &= (uint32_t)((1u << WT_TOTAL) - 1u);   /* 只保留有效位 */
    watchdog_hw->scratch[1] = hung_mask;
    watchdog_hw->scratch[3] = WT_MAGIC;
    g_wt_hung_mask = hung_mask;

    if (!psram_is_available()) { g_wt_done = 1; return; }

    uint8_t *base = (uint8_t *)(uintptr_t)PSRAM_BASE;

    /* 幂等：凡是已经有结论的步（通过/挂死/不符）一律跳过。
     * 这样每复位一次就净增一个数据点，单调收敛到全部 15 步。 */
    for (uint32_t idx = 0; idx < WT_TOTAL; idx++) {
        /* 先把位图里的"挂死"回填进 RAM 结果表 */
        if (hung_mask & (1u << idx)) {
            g_wt_result[idx / WT_STEP_COUNT][idx % WT_STEP_COUNT] = 2u;
        }
        if (g_wt_result[idx / WT_STEP_COUNT][idx % WT_STEP_COUNT] != 0u) continue;

        uint32_t ci = idx / WT_STEP_COUNT;
        uint32_t si = idx % WT_STEP_COUNT;
        const wt_cfg_t *c = &k_wt_cfg[ci];
        size_t len = k_wt_len[si];

        /* ── 2. 应用这一组参数并重建 PSRAM ── */
        psram_set_params(c->divisor, c->rxdelay, c->max_select, c->min_deselect);
        if (psram_reinitialize() != PICO_OK) {
            g_wt_result[ci][si] = 4;
            continue;
        }

        /* ── 3. 标记这一步（万一挂死，下次开机就知道是它） ──
         * 用 scratch[0]，原因见函数开头。 */
        watchdog_hw->scratch[0] = WT_MARK_BASE | idx;
        watchdog_update();

        /* ── 4. 顺序写 ── */
        uint32_t t0 = time_us_32();
        for (size_t i = 0; i < len; i += 4u) {
            *(volatile uint32_t *)(base + i) = 0xA5A50000u + (uint32_t)i;
            if ((i & 0xFFu) == 0u) watchdog_update();
        }
        uint32_t dt = time_us_32() - t0;

        /* ── 5. 读回校验 ── */
        bool ok = true;
        for (size_t i = 0; i < len; i += 4u) {
            if (*(volatile uint32_t *)(base + i) != 0xA5A50000u + (uint32_t)i) {
                ok = false;
                break;
            }
            if ((i & 0xFFu) == 0u) watchdog_update();
        }

        g_wt_us[ci][si] = dt;
        g_wt_result[ci][si] = ok ? 1u : 3u;
        watchdog_hw->scratch[0] = 0;
    }

    /* ── 6. 把 QMI 参数恢复成 SDK 原来那套 ── */
    if (g_psram_diag_divisor != 0u) {
        psram_set_params(g_psram_diag_divisor, g_psram_diag_rxdelay,
                         g_psram_diag_max_select, g_psram_diag_min_deselect);
        g_wt_end_config_ok = (psram_reinitialize() == PICO_OK) ? 1u : 0u;
    }

    g_wt_done = 1;
}

/* 串口报告：只在主机在场时打，SWD 直接读全局变量更可靠 */
void psram_writetest_report(void) {
    printf("\n--- PSRAM 连续写入实验（16B → 16KiB × 3 组 QMI 参数）---\n");
    if (g_wt_resumed_from != 0xFFFFFFFFu) {
        printf("  上次复位在第 %u 步 ⇒ 那一步标记为挂死\n",
               (unsigned)g_wt_resumed_from);
    }
    const char *tag[5] = { "没跑", "通过", "挂死", "数据不符", "重初始化失败" };
    for (int ci = 0; ci < WT_CFG_COUNT; ci++) {
        printf("  %s\n", k_wt_cfg[ci].name);
        for (int si = 0; si < WT_STEP_COUNT; si++) {
            uint32_t r = g_wt_result[ci][si];
            printf("      %6u 字节 : %-12s", (unsigned)k_wt_len[si],
                   tag[r <= 4u ? r : 0]);
            if (r == 1u) printf("  %u us", (unsigned)g_wt_us[ci][si]);
            printf("\n");
        }
    }
    printf("  实验完成 = %u, QMI 参数已还原 = %u\n",
           (unsigned)g_wt_done, (unsigned)g_wt_end_config_ok);
    fflush(stdout);
}

