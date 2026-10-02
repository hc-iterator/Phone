/**
 * SDIO bring-up test for Waveshare RP2350-PiZero (RP2350B)
 *
 * Purpose: prove or disprove the SDIO interface on the on-board TF socket.
 *
 * Pin configuration lives in hw_config.cpp:
 *     CLK = 38, CMD = 31, D0..D3 = 40..43, PIO base moved to 16
 *
 * This replaces the HDMI colour-bar test. That version is preserved at
 * commit 6a3b454; restore it with:
 *     git checkout 6a3b454 -- main.cpp
 *
 * Output goes to USB CDC and UART0. UART0 is left enabled ON PURPOSE: the
 * previous main.cpp waited for a USB host to attach before printing anything,
 * so a board powered from a battery produced no diagnostics at all. Here the
 * USB wait times out and output continues on UART0 regardless.
 */

#include <stdio.h>
#include <string.h>

#include "pico/stdlib.h"

#include "hardware/clocks.h"

#include "f_util.h"
#include "ff.h"
#include "hw_config.h"

#include "psram_probe.h"
#include "hdmi_screen.h"
#include "dvi_screen.h"
#include "kernel.h"
#include "kernel_mem.h"
#include "kernel_res.h"
#include "kernel_res_borrow.h"

#include "hardware/watchdog.h"

// Sentinel written to watchdog scratch[4] before arming, purely so a later
// reader can tell this firmware armed it. See main().
#define WDG_MAGIC 0x57444731u   // 'WDG1'

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// Wait briefly for a USB host. Returns true if one attached.
//
// The wait must stay bounded: blocking forever meant the board never serviced
// picotool's USB reset request, so every reflash needed a physical BOOTSEL
// press.
//
// The host being present also gates whether the PSRAM test runs at all -- see
// main(). Skipping the test when nobody is listening avoids an endless
// reset loop that makes Windows chime on every USB re-enumeration.
#define USB_WAIT_MS 8000

static bool wait_for_usb_host(void) {
    absolute_time_t deadline = make_timeout_time_ms(USB_WAIT_MS);
    while (!stdio_usb_connected()) {
        if (absolute_time_diff_us(get_absolute_time(), deadline) <= 0) {
            printf("(no USB host after %d ms)\n", USB_WAIT_MS);
            fflush(stdout);
            return false;
        }
        watchdog_update();
        tight_loop_contents();
    }
    printf("USB host attached.\n");
    fflush(stdout);
    return true;
}

static void print_card_identity(sd_card_t *card) {
    const char *type_name;
    switch (card->state.card_type) {
        case SDCARD_V1:    type_name = "SD v1.x (standard capacity)"; break;
        case SDCARD_V2:    type_name = "SD v2.x (standard capacity)"; break;
        case SDCARD_V2HC:  type_name = "SDHC/SDXC (high capacity)";   break;
        case CARD_UNKNOWN: type_name = "unknown/unsupported";         break;
        case SDCARD_NONE:
        default:           type_name = "none";                        break;
    }
    printf("  card type: %s\n", type_name);
    printf("  sectors:   %lu (%lu MiB)\n",
           (unsigned long)card->state.sectors,
           (unsigned long)((uint64_t)card->state.sectors * 512u / (1024u * 1024u)));
}

static void mount_and_exercise(sd_card_t *card) {
    (void)card;
    FATFS fs;
    FRESULT fr = f_mount(&fs, "", 1);
    if (FR_OK != fr) {
        printf("  f_mount FAILED: %s (%d)\n", FRESULT_str(fr), fr);
        printf("  -> the card answered on the bus but the FAT volume is not readable.\n");
        return;
    }
    printf("  f_mount OK\n");

    // Write-then-read-back is the only check that actually proves both
    // directions of the interface work.
    const char *const path = "sdio_probe.txt";
    FIL fil;
    fr = f_open(&fil, path, FA_CREATE_ALWAYS | FA_WRITE);
    if (FR_OK != fr) {
        printf("  f_open(write) FAILED: %s (%d)\n", FRESULT_str(fr), fr);
        f_unmount("");
        return;
    }
    const char *msg = "RP2350-PiZero SDIO write test\n";
    UINT bw = 0;
    fr = f_write(&fil, msg, strlen(msg), &bw);
    if (FR_OK != fr || bw != strlen(msg)) {
        printf("  f_write FAILED: %s (%d), wrote %u of %u\n",
               FRESULT_str(fr), fr, (unsigned)bw, (unsigned)strlen(msg));
        f_close(&fil);
        f_unmount("");
        return;
    }
    f_close(&fil);
    printf("  wrote %s (%u bytes)\n", path, (unsigned)bw);

    fr = f_open(&fil, path, FA_READ);
    if (FR_OK != fr) {
        printf("  f_open(read) FAILED: %s (%d)\n", FRESULT_str(fr), fr);
        f_unmount("");
        return;
    }
    char buf[64] = {0};
    UINT br = 0;
    fr = f_read(&fil, buf, sizeof(buf) - 1, &br);
    f_close(&fil);
    if (FR_OK != fr) {
        printf("  f_read FAILED: %s (%d)\n", FRESULT_str(fr), fr);
    } else {
        printf("  read back %u bytes: \"%s\"\n", (unsigned)br, buf);
        printf("  ROUND TRIP %s\n",
               (br == strlen(msg) && memcmp(buf, msg, br) == 0) ? "OK" : "MISMATCH");
    }
    f_unmount("");
}

// ---------------------------------------------------------------------------

int main(void) {
    stdio_init_all();

    /*
     * ⚠️ 这里【不再等待 USB 主机】。
     *
     * 实测教训：`wait_for_usb_host()` 会把整个程序挡在开头。
     * 调试时 PC 停在 `stdio_usb_connected` 里，导致后面的自检、
     * 演示、SDIO 测试【一个都没执行】—— 表现就是"变量全 0、
     * 进度标记不出现、串口没输出"，让人误以为内核机制出了问题。
     *
     * 而它等的东西（主机拉高 DTR）在调试场景下并不可靠：
     * 复位会重新枚举 USB，主机重新拉高 DTR 的时机不受我们控制。
     *
     * 所以现在直接往下走。串口输出若在终端接上之前产生会丢失，
     * 这可以接受 —— 因为验证结果都写在内存变量里，由调试器读。
     */
    bool host = stdio_usb_connected();
    printf("\n=== RP2350-PiZero bring-up ===\n");
    fflush(stdout);

    printf("sys_clk = %lu Hz\n", (unsigned long)clock_get_hz(clk_sys));
    fflush(stdout);

    /*
     * 内核机制演示【无条件运行】，不受"USB 主机是否在场"影响。
     *
     * 原来它被放在 if (host) 里面，结果只要 stdio_usb_connected() 在启动窗口
     * 里返回假（实测反复发生），整个演示就被跳过、板子直接进停车循环，
     * 串口一个字节都没有 —— 查了很久才发现是门控条件的问题。
     *
     * 这个演示是纯 SRAM 操作，不会挂死、也没有破坏性，本来就不需要门控。
     */
    printf("host_detected=%d\n", host ? 1 : 0);
    fflush(stdout);

    /*
     * 最小自检放在【最前面】，而且不打印。
     *
     * 它只验证核心链路，结果写在 pico_kernel_selftest_* 变量里，
     * 由调试器（SWD）直接读 —— 不依赖串口，因此不受 USB 状态影响。
     *
     * 先跑它的原因：一旦它把 MPU 配置打开，后续任何非特权访问都可能出问题，
     * 所以必须让它独立、最先执行、而且自己负责把状态收尾。
     */
    kernel_minimal_selftest();
    kernel_mark(110);

    /*
     * ==== 内核内存管理器（2026-09-27 新增，地基的第一块砖）====
     *
     * 放在最前面：后面所有子系统（帧缓冲、应用加载、资源表）都要向它要内存。
     * 它自己从 .bss 里划了一块静态"竞技场"，不依赖 SDK 的 malloc
     * （SDK 的堆只有 2KB，是给 printf 之类内部零用的）。
     *
     * 结果写在 g_kmem_* 变量里，SWD 直接读，不依赖串口。
     */
    kmem_init_all();
    kernel_mark(115);
    kmem_selftest();
    kernel_mark(116);

    /*
     * ==== 内核资源登记表（2026-09-28 接入）====
     *
     * 这是"内核掌握所有外延权限"那本账的第一次真正跑起来：
     * 内核统一持有 DMA 通道 / PIO 状态机 / GPIO / 内存，
     * 并且做最朴素的越权检查（别人的资源不能被第三方释放）。
     *
     * 结果写在 g_kres_selftest_* 里，SWD 直接读。
     */
    kres_init();
    kres_selftest();
    kernel_mark(117);
    printf("内核资源表: 自检=%lu (步数 %lu, 首个失败步 %lu)\n",
           (unsigned long)g_kres_selftest_status,
           (unsigned long)g_kres_selftest_steps,
           (unsigned long)g_kres_selftest_fail_at);

    /*
     * 资源【借用】语义自检（规范 6b）。
     *
     * 账本只管"是谁的"；这里测的是"现在该给谁用"：
     * 撞忙入队、优先级插队、同优先级 FIFO、超时自动退队、
     * 归还后自动转交、严格实例越权检查、队列满诚实拒绝、MPU 区域登记。
     *
     * 用 KRES_BLOCKDEV 和 KRES_MPU_REGION 测，**不碰 DMA/PIO**，
     * 所以不会把硬件真正要用的资源搅乱。
     */
    kres_borrow_selftest();
    kernel_mark(118);
    printf("资源借用(调度)自检: 通过=%lu (步数 %lu, 首个失败步 %lu)\n",
           (unsigned long)g_kresb_selftest_status,
           (unsigned long)g_kresb_selftest_steps,
           (unsigned long)g_kresb_selftest_fail_at);
    printf("    统计: 撞忙 %lu 入队 %lu 转交成功 %lu 超时 %lu 队列满 %lu\n",
           (unsigned long)g_kres_stat_contention,
           (unsigned long)g_kres_stat_enqueued,
           (unsigned long)g_kres_stat_granted,
           (unsigned long)g_kres_stat_timeouts,
           (unsigned long)g_kres_stat_queue_full);
    for (int k = 0; k < (int)KRES_KIND_COUNT; k++) {
        printf("    %-9s 已用 %lu / %lu\n",
               kres_kind_name((kres_kind_t)k),
               (unsigned long)kres_used_count((kres_kind_t)k),
               (unsigned long)kres_capacity((kres_kind_t)k));
    }
    fflush(stdout);
    printf("内核内存: SRAM 竞技场 = %lu 字节, 自检 = %lu (步数 %lu, 首个失败步 %lu)\n",
           (unsigned long)g_kmem_sram_arena_size,
           (unsigned long)g_kmem_selftest_status,
           (unsigned long)g_kmem_selftest_steps,
           (unsigned long)g_kmem_selftest_fail_at);
    printf("          SRAM 池: 总 %lu 空闲 %lu 峰值 %lu\n",
           (unsigned long)g_pool_sram.size,
           (unsigned long)g_pool_sram.free_bytes,
           (unsigned long)g_pool_sram.peak_used);
    printf("          PSRAM: 检测到=%lu 容量=%lu 池可用=%lu (KMEM_ENABLE_PSRAM=%d)\n",
           (unsigned long)g_kmem_psram_detected,
           (unsigned long)g_kmem_psram_size,
           (unsigned long)g_kmem_psram_ok,
           (int)KMEM_ENABLE_PSRAM);
    fflush(stdout);

    /*
     * 第 17 轮诊断已撤除（kernel_r17.c/h 已删除）。
     *
     * 为什么删：它当初是为了判断"处理程序入口读到 nPRIV=1 说明它不是特权态"，
     * 而这个前提本身是错的（Handler 模式必然特权，nPRIV 描述的是线程）。
     * 更要紧的是它的注释和收尾逻辑都建立在"处理程序入口会清 nPRIV"上，
     * 留着只会在下一次排查时把人再次带偏。
     *
     * 它真正有价值的那条结论（入口 CONTROL 读数）现在由 kernel.c 的
     * g_probe_ctrl[0] 继续采，不必再养一个文件。
     */
    printf("自检状态=%lu 异常次数=%lu 出错地址=0x%08lX\n",
           (unsigned long)pico_kernel_selftest_status,
           (unsigned long)pico_kernel_selftest_faults,
           (unsigned long)pico_kernel_selftest_addr);
    fflush(stdout);
    kernel_mark(120);

    /*
     * 系统调用演示（SVC 版）。
     *
     * 2026-09-27 更新：这个演示【已经不再关闭】了。
     *
     * 当初关掉它的理由是"从非特权态进异常后，处理程序入口读到 CONTROL.nPRIV
     * 仍是 1，于是处理程序一碰特权资源就 HardFault"。**那个理由是错的**：
     * Handler 模式必然特权，入口读到的 nPRIV 描述的是【线程】的状态，
     * 不是处理程序的。真正的崩溃原因是另一个 bug ——
     * isr_svcall 这个 naked 处理程序用了 r5 却没保存它
     * （硬件异常进入只压 r0-r3/r12/lr/pc/xPSR，不保存 r4-r11），
     * 于是返回后 main 的 r5（常驻 &_impure_ptr）被改坏，
     * 下一次 fflush(stdout) 变成 fflush(野地址) → 非对齐访问 → HardFault。
     * 详见 小本本.md「真正那个 bug 找到了」一节。
     *
     * 现在演示跑得通，实测 g_sys_done_magic=0x5AFE0001（完整走完）。
     */
#define KERNEL_SYSCALL_DEMO 1
#if KERNEL_SYSCALL_DEMO
    kernel_syscall_demo();
    fflush(stdout);
    kernel_mark(130);
#else
    printf("(syscall demo disabled)\n");
    fflush(stdout);
#endif

    if (host) {
        printf("SDIO pins: CLK=%u CMD=%u D0=%u D1=%u D2=%u D3=%u (PIO base 16)\n",
               30u, 31u, 40u, 41u, 42u, 43u);
        fflush(stdout);
    } else {
        printf("no host: (串口可能看不到输出，结果看 SWD 读的内存变量)\n");
        fflush(stdout);
    }

    /*
     * ==== PSRAM 诊断（2026-09-27 改成【只读】，因此不再需要任何门控）====
     *
     * 旧版本是"连续写入压力测试"，会把板子整个顶死，所以当时必须：
     *   1) 只在 USB 主机在场时跑（否则变成 启动→挂死→复位 的无限循环，
     *      Windows 每 6 秒"叮咚"一次）；
     *   2) 开 6 秒看门狗兜底。
     *
     * 新版本只读器件 ID —— 一次 8 字节的 QMI 命令，不碰 PSRAM 存储阵列，
     * 【没有挂死风险】，所以改成无条件跑，而且不再需要看门狗。
     *
     * 结果同时写两个地方：内存变量（SWD 直接读）+ 串口。
     */
    printf("\n=== PSRAM 诊断 ===\n");
    fflush(stdout);
    psram_diag_run();
    psram_probe_report();
    kernel_mark(125);

    /*
     * ==== PSRAM 连续写入实验 ====
     *
     * ⚠️ 这一步【会】把板子顶死 —— 这正是我们要测的东西。所以：
     *   1) 开 3 秒看门狗（pause_on_debug=true，这样 SWD 把核停住时
     *      不会误触发复位，方便调试）；
     *   2) 实验自己把"步号"写进 watchdog scratch[4]，复位后开机读回来，
     *      标出"挂死的就是这一步"，然后【从下一步继续】。
     *   ⇒ 每复位一次就多拿一个数据点，自动跑完全部 15 步。
     *   ⇒ 期间 USB 会反复重新枚举，Windows 会"叮咚"几声，是正常的。
     *
     * 不想再跑就把它改成 0。
     */
/*
     * ⚠️ 2026-09-28 暂时关掉（改成 0）。
     *
     * 原因：这个实验会让板子走进【无限重启】——
     *   psram_writetest_run() 里的"步号标记"是在 psram_reinitialize() 【之后】才写的；
     *   如果 panic 就发生在那里面，标记永远写不进去，
     *   断点续跑机制就永远学不到东西 ⇒ 每开机一次 panic 一次 ⇒ 复位循环。
     *   循环期间 SWD 的体检做不完、COM7 也抓不稳，等于把调试手段全废了。
     *
     * 重新打开前，要先把步号标记【挪到 psram_reinitialize() 之前】，让循环能收敛。
     */
#define PSRAM_WRITE_TEST 0
#if PSRAM_WRITE_TEST
    printf("\n=== PSRAM 连续写入实验（可能顶死板子，靠看门狗续跑）===\n");
    fflush(stdout);
    watchdog_enable(2000, true);
    psram_writetest_run();
    watchdog_disable();
    psram_writetest_report();
    kernel_mark(126);
#endif


    /*
     * SD 卡是可选的：没有卡不应该阻止后面点屏。
     *
     * 原来的写法是"初始化失败就 while(true) 卡住"，在只做屏幕测试时
     * 会让板子停在 SD 报错上、屏幕永远黑着。现在改成失败就跳过。
     */
    if (!sd_init_driver()) {
        printf("sd_init_driver() FAILED - no usable card on the bus.\n");
        printf("Check: CLK=30, CMD=31, D0..D3=40..43 actually wired to the socket;\n");
        printf("       card inserted; 47k pull-ups on CMD/D0/D3 may be too weak.\n");
        printf("       (skipping SD tests; continuing to HDMI screen test)\n");
        fflush(stdout);
    } else {
        size_t n = sd_get_num();
        printf("sd_get_num() = %u\n", (unsigned)n);
        for (size_t i = 0; i < n; i++) {
            sd_card_t *card = sd_get_by_num(i);
            if (!card) continue;
            printf("card %u: interface = %s\n", (unsigned)i,
                   card->type == SD_IF_SDIO ? "SDIO" : "SPI");

            /*
             * Report identity only AFTER f_mount(). card_type and sectors are
             * filled in during initialisation, so printing them beforehand always
             * showed "none" / 0 even on a healthy card -- which made a successful
             * run look broken.
             */
            mount_and_exercise(card);
            print_card_identity(card);
        }
    }

    /*
     * ==== HDMI 屏幕点亮 ====
     *
     * 放在最后：显示初始化会改系统时钟并启动 Core1 跑 HSTX DMA，
     * 之后 USB 串口的行为会受影响，所以让所有串口诊断先跑完。
     *
     * hdmi_screen_test() 不返回 —— 它会停在显示循环里持续出图。
     */
    printf("\n=== tests done; starting HDMI screen test ===\n");
    fflush(stdout);
    kernel_mark(140);

    /*
     * 用 frank-hdmi-sound 的 PIO DVI + HDMI 音频。
     *
     * 不用 hdmi_screen_test()（pico_hdmi/HSTX）的原因见 dvi_screen.c 顶部：
     * HSTX 硬连 GPIO12..19，而这块板的 DVI 在 GPIO32..39，只能走 PIO。
     */
    dvi_screen_test();

    /* 不会走到这里 */
    return 0;
}
