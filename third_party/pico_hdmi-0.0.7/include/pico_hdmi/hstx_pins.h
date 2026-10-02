/**
 * pico_hdmi 引脚配置
 *
 * ⚠️ 本地修改版，不是上游原样。改动与理由见下。
 *
 * ── 背景：微雪 RP2350-PiZero 的 HDMI 引脚到底是哪几个？（未定论）──
 *
 * 现有两条互相矛盾的证据：
 *
 *   证据 A（用户提供的板级接线）：
 *       GPIO32/33 D2 P/N、GPIO34/35 D1 P/N、
 *       GPIO36/37 D0 P/N、GPIO38/39 CLK P/N、
 *       GPIO44/45/46 DDC SDA/SCL/CEC
 *
 *   证据 B（SDK，更权威）：
 *       SDK 的 io_bank0.h 覆盖 GPIO 0..47 全部引脚，而其中带
 *       FUNCSEL_VALUE_HSTX 定义的【只有 GPIO 12..19 八个】：
 *           GPIO12→HSTX_0, 13→HSTX_1, ... 19→HSTX_7
 *       hstx_ctrl.h 的注释也写 "if HSTX is on GPIOs 12 through 19"。
 *       也就是说 HSTX 在这颗芯片上是【硬连】到 GPIO 12..19 的，
 *       GPIO 32..39 上根本没有 HSTX 功能（不是配置问题，是硅片接线）。
 *
 * 两条同时成立是不可能的：若板子 HDMI 真在 32..39，就不可能走 HSTX，
 * 只能用 PIO 模拟 TMDS。
 *
 * ── 因此这里的取值策略 ──
 *
 * 先用【标准 HSTX 引脚 GPIO 12..19】编译烧写做一次判定实验：
 *   屏幕亮了  → 说明之前那份接线表里的 32..39 不是 GPIO 编号
 *              （很可能是排针序号），问题解决。
 *   屏幕仍不亮 → 说明确实要走 PIO DVI，需要另写驱动。
 *
 * 引脚对顺序（HSTX 标准，来自 io_bank0.h 的 HSTX_0..HSTX_7）：
 *   CLK = 12/13    D0 = 14/15    D1 = 16/17    D2 = 18/19
 * 每对"偶数 = P（正）、奇数 = N（负）"，宏里填偶数那侧。
 */

#ifndef HSTX_PINS_H
#define HSTX_PINS_H

// =============================================================================
// DVI/HSTX 输出引脚 —— 先用 HSTX 标准 GPIO 12..19 做判定实验
// =============================================================================
#define PIN_HSTX_CLK 12 // CLK 对基址（12 = CLK P，13 = CLK N）
#define PIN_HSTX_D0  14 // D0  对基址（14 = D0  P，15 = D0  N）
#define PIN_HSTX_D1  16 // D1  对基址（16 = D1  P，17 = D1  N）
#define PIN_HSTX_D2  18 // D2  对基址（18 = D2  P，19 = D2  N）

#endif // HSTX_PINS_H
