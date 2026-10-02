/*
 * Brings the TMDS serialiser hardware up.  Configures three PIO state
 * machines (one per TMDS data lane), drives the pixel clock either
 * from a PWM slice or a fourth PIO SM, and applies the per-pad drive,
 * slew and inversion settings.
 *
 * (c) 2026 Mikhail Matveev <xtreme@rh1.tech>, https://rh1.tech
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Based on libdvi by Luke Wren and contributors
 * (https://github.com/Wren6991/PicoDVI).
 *
 * Copyright (c) 2021 Luke Wren and contributors.
 */
#include "pico.h"
#include "hardware/pio.h"
#include "hardware/gpio.h"
#include "hardware/pwm.h"
#include "hardware/structs/padsbank0.h"

#include "frank_dvi.h"
#include "frank_serialiser.h"
#include "frank_serialiser.pio.h"
#include "frank_clock.pio.h"

#if defined(USE_PIO_TMDS_ENCODE) || !defined (DVI_USE_PIO_CLOCK)
#define USE_PWM_CLOCK
#endif

#ifndef USE_PWM_CLOCK
static int clk_sm = 0;
#endif

/*
 * Apply the pad-control settings appropriate for an HDMI line: low
 * drive strength with slew limiting (the 3V3 LDO stays cool and most
 * receivers are happy with the resulting edge rates) and disable the
 * digital input buffer (we never read these pins).  GPIO inversion
 * is applied on top, picked from `invert_diffpairs` in the config.
 * Boards that wire P/N the wrong way round flip the bit here without
 * touching the rest of the pipeline.
 */
static void dvi_configure_pad(uint gpio, bool invert) {
	/* ★ 2026-10-02 驱动强度/压摆率：从 libdvi 默认的【2mA + 压摆受限】提高到
	 * 【8mA + 快速压摆】。
	 *
	 * 为什么改：默认值是在"连接器紧贴芯片"的官方小板上验证的（注释原文
	 * "this seems fine even at 720p30"）。而本板是
	 *   微雪 PiZero 板 → HDMI 座 → 转接头 → 一条 HDMI 线 → 面板
	 * 信号要走过几十厘米和两个接插件，2mA + 受限压摆的边沿会明显变钝，
	 * 面板在钝边沿上判错 ⇒ 大面积闪 / 偶尔丢锁 / 某一通道(红)解不出来。
	 * （用户已排除线缆与面板：同样的线与面板接电脑完全正常。）
	 *
	 * DRIVE: 0=2mA 1=4mA 2=8mA 3=12mA；SLEWFAST=1 表示【不做】压摆限制（边沿更快）。
	 * 另外数字接收器保持关闭（DVI 输出引脚不需要 IE）。 */
	hw_write_masked(
		&padsbank0_hw->io[gpio],
		(3u << PADS_BANK0_GPIO0_DRIVE_LSB) | PADS_BANK0_GPIO0_SLEWFAST_BITS,
		PADS_BANK0_GPIO0_DRIVE_BITS | PADS_BANK0_GPIO0_SLEWFAST_BITS | PADS_BANK0_GPIO0_IE_BITS
	);
	gpio_set_outover(gpio, invert ? GPIO_OVERRIDE_INVERT : GPIO_OVERRIDE_NORMAL);
}

/*
 * Bring up the TMDS serialiser hardware described by `cfg`.
 *
 * Loads the serialiser PIO program once, then for each of the three
 * data lanes claims the requested state machine, configures it for
 * the named GPIO pair, and applies the pad settings.
 *
 * The pixel clock is generated either by a PWM slice (the default;
 * the PWM hardware is rock-steady at 50% duty across both pins of
 * the pair) or by a fourth PIO state machine, depending on whether
 * the build defines DVI_USE_PIO_CLOCK.  PWM mode requires the clock
 * pin to be even (PWM slice constraint).
 */
void dvi_serialiser_init(struct dvi_serialiser_cfg *cfg) {
	/* ★★★ 2026-10-02 根因修复：RP2350B 的 PIO 只能寻址 32 根引脚，窗口要么 0~31、要么 16~47。
	 * DVI 用的引脚是 32~39 —— 都在 0~31 窗口【之外】！
	 * 不设这个基址的后果（已实测）：SDK 把真实引脚号 32 存进配置，
	 * 硬件却按窗口 0 解释 ⇒ 32 被 5 位字段截成 0 ⇒ 【PIO 一直在驱动引脚 0~7，
	 * 而那 8 根 DVI 引脚上什么都没有】⇒ 这就是"从来没有画面"的根因。
	 * 判据：设之前 PINCTRL=0x14000000(OUT_BASE=0/SET_BASE=0)、EXECCTRL 的 SIDESET_BASE=0；
	 *       设之后应为非 0（引脚 32 → 32-16 = 16）。
	 * 注：PICO_PIO_USE_GPIO_BASE 在 RP2350B 上默认即为 1（(NUM_BANK0_GPIOS=48) > 32），
	 *     所以不需要额外的编译定义；缺的就是这一个调用。 */
	pio_set_gpio_base(cfg->pio, 16);
#if DVI_SERIAL_DEBUG
	uint offset = pio_add_program(cfg->pio, &dvi_serialiser_debug_program);
#else
	uint offset = pio_add_program(cfg->pio, &dvi_serialiser_program);
#endif
	cfg->prog_offs = offset;

	for (int i = 0; i < N_TMDS_LANES; ++i) {
		pio_sm_claim(cfg->pio, cfg->sm_tmds[i]);
		dvi_serialiser_program_init(
			cfg->pio,
			cfg->sm_tmds[i],
			offset,
			cfg->pins_tmds[i],
			DVI_SERIAL_DEBUG
		);
			bool inv = cfg->invert_diffpairs;
	if (cfg->pins_tmds[i] == 32) inv = !inv;   /* 实验：只反 lane2(红) */
	dvi_configure_pad(cfg->pins_tmds[i], inv);
		dvi_configure_pad(cfg->pins_tmds[i] + 1, inv);
	}

#ifdef USE_PWM_CLOCK
	// Use a PWM slice to drive the pixel clock. Both GPIOs must be on the same
	// slice (lower-numbered GPIO must be even).
	assert(cfg->pins_clk % 2 == 0);
	uint slice = pwm_gpio_to_slice_num(cfg->pins_clk);
	// 5 cycles high, 5 low. Invert one channel so that we get complementary outputs.
	pwm_config pwm_cfg = pwm_get_default_config();
	pwm_config_set_output_polarity(&pwm_cfg, true, false);
	pwm_config_set_wrap(&pwm_cfg, 9);
	// PATCH (frank-hdmi-sound): when sys_clock is an integer multiple of the
	// TMDS bit clock, divide the PWM clock by the same factor so the
	// pixel-clock output runs at spec while the CPU stays fast.
#ifdef DVI_SM_CLKDIV
	pwm_config_set_clkdiv_int(&pwm_cfg, DVI_SM_CLKDIV);
#endif
	pwm_init(slice, &pwm_cfg, false);
	pwm_set_both_levels(slice, 5, 5);
#else
	// Use a state machine to generate the clock
	clk_sm = pio_claim_unused_sm(cfg->pio, true);
    offset = pio_add_program(cfg->pio, &dvi_clock_program);
	dvi_clock_program_init(cfg->pio, clk_sm, offset, cfg->pins_clk);
#endif

	for (uint i = cfg->pins_clk; i <= cfg->pins_clk + 1; ++i) {
#ifdef USE_PWM_CLOCK
		gpio_set_function(i, GPIO_FUNC_PWM);
#endif
		dvi_configure_pad(i, cfg->invert_diffpairs);
	}
}

/*
 * Master enable for the TMDS serialiser.  Toggles the three (or
 * four, with PIO clock) state machines and the pixel-clock source
 * together.  The DVI spec allows a phase offset between the data
 * and clock lanes, so the data SMs and the clock generator don't
 * have to be enabled in the same cycle.
 */
void dvi_serialiser_enable(struct dvi_serialiser_cfg *cfg, bool enable) {
	uint mask = 0;
	for (int i = 0; i < N_TMDS_LANES; ++i)
		mask |= 1u << (cfg->sm_tmds[i] + PIO_CTRL_SM_ENABLE_LSB);
	if (enable) {
		// The DVI spec allows for phase offset between clock and data links.
		// So PWM and PIO do not need to be synchronised perfectly.
		hw_set_bits(&cfg->pio->ctrl, mask);
#ifdef USE_PWM_CLOCK
		pwm_set_enabled(pwm_gpio_to_slice_num(cfg->pins_clk), true);
#else
    	pio_sm_set_enabled(cfg->pio, clk_sm, true);
#endif
	}
	else {
		hw_clear_bits(&cfg->pio->ctrl, mask);
#ifdef USE_PWM_CLOCK
		pwm_set_enabled(pwm_gpio_to_slice_num(cfg->pins_clk), false);
#else
    	pio_sm_set_enabled(cfg->pio, clk_sm, false);
#endif
	}
}
