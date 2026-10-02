#ifndef PSRAM_PROBE_H
#define PSRAM_PROBE_H

#include <stdint.h>

/*
 * 实现是 C（psram_probe.c），但这个头文件被 main.cpp（C++）包含，
 * 所以必须加 C linkage 包装 —— 否则 C++ 调用方生成被修饰过的名字，
 * 链接会报 "undefined reference to `psram_probe_report()'"。
 * 这个坑本项目踩过两次。
 */
#ifdef __cplusplus
extern "C" {
#endif

/*
 * PSRAM 诊断（2026-09-27 重写：从"压力测试"改成"验明正身"）
 *
 * ── 为什么要重写 ──
 *
 * 原来的版本是拿连续写入去顶，结论是"连续 4 KiB 写入把整片挂死"。
 * 那个结论没错，但它把板子顶死之后什么也问不出来。
 *
 * 后来查到两条关键事实：
 *   1. 微雪官方 wiki 说这块板 PSRAM 只是 "a reserved PSRAM pad"
 *      （预留焊盘，芯片是可选项，出厂不一定焊）；
 *   2. SDK 的 PSRAM 片选是【自动猜】的 —— 依次去试 {0, 8, 19, 47}，
 *      谁答话就认定谁（PICO_AUTO_DETECT_PSRAM_CS 默认开着，
 *      此时 PICO_PSRAM_CS_PIN=47 是被【忽略】的）。
 *
 * 于是有了一个能解释全部现象的假设：
 *   **芯片根本没焊，自动检测在某个空脚上假阳性了。**
 *
 * 这个诊断就用来判定它：不写一个字节，只读器件 ID。
 * 真 APS6404 会回 KGD=0x5D；悬空脚会回 0x00/0xFF 或噪声。
 *
 * ── 读法（SWD 直接读这些全局变量）──
 *   g_psram_diag_done          1 = 诊断跑完了
 *   g_psram_diag_sdk_cs_gpio   SDK 最终认定的片选脚（0xFF = 没认定）
 *   g_psram_diag_pin[i]        第 i 个被试探的脚
 *   g_psram_diag_kgd[i]        该脚回包的 KGD 字节（真器件应为 0x5D）
 *   g_psram_diag_eid[i]        该脚回包的 EID 字节
 *   g_psram_diag_size[i]       该脚换算出的容量（0 = 不是 PSRAM）
 *   g_psram_diag_raw[i]        该脚 8 字节原始回包（第 0 字节在 bit0..7）
 *   g_psram_diag_qmi_timing    qmi_hw->m[1].timing 原值
 *   g_psram_diag_divisor / rxdelay / max_select / min_deselect  拆出来的字段
 */

#define PSRAM_DIAG_PINS 4

extern volatile uint32_t g_psram_diag_done;
extern volatile uint32_t g_psram_diag_sdk_cs_gpio;
extern volatile uint32_t g_psram_diag_pin[PSRAM_DIAG_PINS];
extern volatile uint32_t g_psram_diag_kgd[PSRAM_DIAG_PINS];
extern volatile uint32_t g_psram_diag_eid[PSRAM_DIAG_PINS];
extern volatile uint32_t g_psram_diag_size[PSRAM_DIAG_PINS];
extern volatile uint32_t g_psram_diag_raw[PSRAM_DIAG_PINS];
extern volatile uint32_t g_psram_diag_qmi_timing;
extern volatile uint32_t g_psram_diag_divisor;
extern volatile uint32_t g_psram_diag_rxdelay;
extern volatile uint32_t g_psram_diag_max_select;
extern volatile uint32_t g_psram_diag_min_deselect;

/* 跑诊断（安全：只读 ID、不写内存），并把结果同时打印到串口 */
void psram_diag_run(void);

/* 老接口保留，现在只在串口上复述一遍诊断结果 */
void psram_probe_report(void);

/* ── 连续写入实验（2026-09-27 新增）────────────────────────────────
 *
 * 诊断已证实芯片真在 GPIO47 上，所以"连续写挂死"是时序/信号问题。
 * 这个实验试 3 组 QMI 参数 × 5 档长度（16B → 16KiB），
 * 看哪一组能撑到 16 KiB。
 *
 * ⚠️ 这个实验【会】把板子顶死，靠看门狗复位。
 *    它把步号写进 watchdog scratch[4]，开机时读回来，
 *    于是每复位一次就多拿一个数据点、自动从下一步继续 ——
 *    不需要人工干预，也不会陷入无限复位循环。
 *
 * 读法（SWD）：
 *   g_wt_result[config][step]  0=没跑 1=通过 2=挂死 3=数据不符 4=重初始化失败
 *   g_wt_us[config][step]      通过时花了多少微秒
 *   g_wt_done                  1 = 全部 15 步都跑完了
 *   g_wt_resumed_from          上次复位在第几步（0xFFFFFFFF = 没发生过）
 *   g_wt_end_config_ok         QMI 参数是否成功还原成 SDK 原来那套
 */
#define WT_CFG_COUNT   3
#define WT_STEP_COUNT  5

extern volatile uint32_t g_wt_result[WT_CFG_COUNT][WT_STEP_COUNT];
extern volatile uint32_t g_wt_us[WT_CFG_COUNT][WT_STEP_COUNT];
extern volatile uint32_t g_wt_done;
extern volatile uint32_t g_wt_resumed_from;
extern volatile uint32_t g_wt_hung_mask;
extern volatile uint32_t g_wt_end_config_ok;

void psram_writetest_run(void);
void psram_writetest_report(void);

#ifdef __cplusplus
}
#endif

#endif /* PSRAM_PROBE_H */
