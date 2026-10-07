/*
 * frank-hdmi-sound. Minimal HDMI video + audio driver for RP2350.
 *
 * (c) 2026 Mikhail Matveev <xtreme@rh1.tech>, https://rh1.tech
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or
 * modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.  See the LICENSE file at
 * the root of this repository, or <https://www.gnu.org/licenses/>.
 *
 * Acknowledgements
 * ----------------
 * This driver is a fork of the libdvi-based HDMI path I built for
 * frank-snes (an SNES emulator for the RP2350), which itself was
 * inspired by pico-zxspectrum by fruit-bat and contributors
 * (https://github.com/fruit-bat/pico-zxspectrum) and uses the libdvi
 * HDMI library by shuichitakano (PicoDVI-audio,
 * https://github.com/shuichitakano/PicoDVI-audio), which extends
 * Luke Wren's PicoDVI (https://github.com/Wren6991/PicoDVI).
 *
 * libdvi (under src/libdvi/) is BSD-3-Clause; see
 * src/libdvi/UPSTREAM_README.md for the upstream notice.
 */
#ifndef FRANK_HDMI_SOUND_H_
#define FRANK_HDMI_SOUND_H_

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Pin layout
 * ----------
 * The driver writes a TMDS clock pair on (CLK_PIN, CLK_PIN+1) and
 * three TMDS data pairs on (D0_PIN, D0_PIN+1), (D1_PIN, D1_PIN+1),
 * (D2_PIN, D2_PIN+1).  CLK_PIN must be even (PWM slice constraint).
 *
 * Board presets are selected by defining one of:
 *
 *     FRANK_HDMI_BOARD_M1       FRANK / MURMULATOR-1 layout
 *     FRANK_HDMI_BOARD_M2       FRANK / MURMULATOR-2 layout (default)
 *
 * If you need a different board, leave the preset undefined and
 * override individual pins via -DFRANK_HDMI_PIN_CLK=<n> etc.; any
 * macro you define yourself takes precedence over the preset.
 */
#if !defined(FRANK_HDMI_BOARD_M1) && !defined(FRANK_HDMI_BOARD_M2) && \
    !defined(FRANK_HDMI_PIN_CLK)
#define FRANK_HDMI_BOARD_M2   /* default */
#endif

#ifdef FRANK_HDMI_BOARD_M1
/* MURMULATOR-1: CLK on GPIO 6/7, data lanes on 8/9, 10/11, 12/13. */
#  ifndef FRANK_HDMI_PIN_CLK
#    define FRANK_HDMI_PIN_CLK   6
#  endif
#  ifndef FRANK_HDMI_PIN_D0
#    define FRANK_HDMI_PIN_D0    8
#  endif
#  ifndef FRANK_HDMI_PIN_D1
#    define FRANK_HDMI_PIN_D1    10
#  endif
#  ifndef FRANK_HDMI_PIN_D2
#    define FRANK_HDMI_PIN_D2    12
#  endif
#endif

#ifdef FRANK_HDMI_BOARD_M2
/* MURMULATOR-2 / FRANK: CLK on GPIO 12/13, data on 14/15, 16/17, 18/19. */
#  ifndef FRANK_HDMI_PIN_CLK
#    define FRANK_HDMI_PIN_CLK   12
#  endif
#  ifndef FRANK_HDMI_PIN_D0
#    define FRANK_HDMI_PIN_D0    14
#  endif
#  ifndef FRANK_HDMI_PIN_D1
#    define FRANK_HDMI_PIN_D1    16
#  endif
#  ifndef FRANK_HDMI_PIN_D2
#    define FRANK_HDMI_PIN_D2    18
#  endif
#endif

/* Final fallback if no preset matched and nothing is overridden. */
#ifndef FRANK_HDMI_PIN_CLK
#define FRANK_HDMI_PIN_CLK   12
#endif
#ifndef FRANK_HDMI_PIN_D0
#define FRANK_HDMI_PIN_D0    14
#endif
#ifndef FRANK_HDMI_PIN_D1
#define FRANK_HDMI_PIN_D1    16
#endif
#ifndef FRANK_HDMI_PIN_D2
#define FRANK_HDMI_PIN_D2    18
#endif

/*
 * Default video mode is 640x480p60 with libdvi's vertical-doubled
 * 320x240 logical canvas (each logical scanline drives two raster
 * lines).  The encoder is also pixel-doubling, so the source
 * framebuffer is 320 RGB565 pixels wide on the wire, but exposed to
 * the caller as an 8-bit palette-indexed buffer up to 320x240.
 */
#define FRANK_HDMI_FRAME_WIDTH    640
#define FRANK_HDMI_FRAME_HEIGHT   480
#define FRANK_HDMI_LOGICAL_WIDTH  320
/* ★ 2026-10-05 A/B 实验（主 AI）：480 → 240（回到库 README 写明的 "max 320x240" ✓）
 *   配合 frank_dvi_config.h 的 DVI_VERTICAL_REPEAT 改回 2。
 *   理由与代价见 docs/DVI攻坚流水.md〈2026-10-05 晚 实测：画面恒定的根因〉✓ */
/* ★ 2026-10-07：240 → 120（配套 DVI_VERTICAL_REPEAT 2 → 4 ✓；硬约束 120×4 = 480 ✓ 不变）
 *   动机与代价见 frank_dvi_config.h 顶部的长注释与 docs/DVI攻坚流水.md ✓
 *   一句话：平均产能 12,219 行/秒 < 需要的 14,328 ⇒ 差 15% ⇒ 画面闪 ✗；
 *           降到 120 行后只需 7,164 行/秒 ⇒ 余量 70% ✓ ⇒ 画面先稳下来 ✓ */
#define FRANK_HDMI_LOGICAL_HEIGHT 120

/*
 * Audio sample rate declared on the wire (CEA-861 standard rate).
 * The driver itself is rate-agnostic; the producer just calls
 * frank_hdmi_audio_write() at whatever rate it likes.  For minimal
 * drift the producer's actual rate should be close to this value;
 * 0.1 % drift is inaudible.
 */
#define FRANK_HDMI_AUDIO_RATE     32000

/*
 * 是否启用 HDMI 数据岛音频。默认 0（关）。
 *
 * 关掉的原因见 frank_hdmi.c 里 dvi_set_audio_freq() 调用处的长注释：
 * 打开音频会重建全部扫描线 DMA 表，而实测引擎约 107 帧后会在
 * DMA 中断里死等。先用纯视频把画面坐实，再回头查音频。
 */
#ifndef FRANK_HDMI_ENABLE_AUDIO
/*
 * 2026-10-01 深夜（第 21 轮续）：1 → 原为 0，现改为 1 做对照实验。
 *
 * 原来关它的理由是：开音频后引擎约 107 帧会卡死在 DMA 中断里
 * "等 dbg_tcr == 320" 的死循环（dbg_tcr 停在 49/4/0）。
 *
 * 但那个循环的根因已在第 16 轮定位并修掉：被等的 320 在【77% 的行】上
 * 永远等不到（因为列表里 320 那条后面还有 tc=8 的续命段，行末 dbg_tcr
 * 必然停在 8），守卫打满 10 万次白烧约 1.8 ms。把 DVI_TCR_WAIT_GUARD
 * 从 100000 降到 2000 后，纯视频从 1.3 fps 提到 5 fps。
 *
 * ⇒ 所以现在值得重新试音频模式，而且它可能顺带解决别的问题：
 *   音频模式会把 6/7 个槽位【全部填满】（非音频模式只填 2~4 段）。
 */
#define FRANK_HDMI_ENABLE_AUDIO   0
#endif

/*
 * Bring up HDMI on the configured pins.  Must be called before
 * frank_hdmi_run_core1().  Does NOT change the system clock; the
 * caller is responsible for setting sys_clock to a multiple of the
 * TMDS bit rate (252 MHz at 1x, 504 MHz at 2x; the libdvi build is
 * configured with DVI_SM_CLKDIV=2 by default).
 */
void frank_hdmi_init(void);

/*
 * Core 1 entry point.  Owns the DMA IRQs for the DVI engine and runs
 * a tight producer/consumer loop forever.  Launch via
 * multicore_launch_core1(frank_hdmi_run_core1).
 */
void frank_hdmi_run_core1(void);

/*
 * Set the source framebuffer.  Format is 8-bit palette indices, row-
 * major, no padding.  256 entries in the palette LUT are populated by
 * frank_hdmi_set_palette().  Pass NULL to display a solid black
 * frame.
 *
 * The buffer is read live by Core 1 every scanline.  The caller may
 * mutate it freely; tearing during writes is up to the caller to
 * manage (typical pattern: double buffer + atomic pointer swap).
 *
 * w x h must fit inside the logical canvas (FRANK_HDMI_LOGICAL_WIDTH
 * x FRANK_HDMI_LOGICAL_HEIGHT).  Smaller buffers are centred with
 * black pillarbox/letterbox; larger buffers are clipped.
 */
void frank_hdmi_set_buffer(const uint8_t *fb, int w, int h);

/*
 * ★ 2026-10-05 只读 getter（主 AI 加，用于定位"画面恒为纯白"）
 *   实测 app 的帧缓冲内容完全正确（纯白=01、条纹=00/01 交替 ✓），但 TMDS 符号三模式相同 ✗
 *   ⇒ 需要验证引擎里的 fb_buf 是否真的指向调用方那块内存。fb_buf 原本是 static，
 *     外部 extern 链不上（undefined reference ✗），故提供只读访问口。不改变任何行为 ✓。
 */
const uint8_t *frank_hdmi_get_buffer(void);
int frank_hdmi_get_buffer_w(void);
int frank_hdmi_get_buffer_h(void);

/* Set palette entry i to the 24-bit RGB colour (0xRRGGBB). */
void frank_hdmi_set_palette(uint8_t i, uint32_t color888);

/* Read back a palette entry. */
uint32_t frank_hdmi_get_palette(uint8_t i);

/*
 * Push num_frames stereo samples into the HDMI audio ring.  Each
 * frame is two int16_t channels (L then R) at FRANK_HDMI_AUDIO_RATE.
 * Returns the number of frames actually written; the rest are
 * dropped silently (we never block the producer).
 */
uint32_t frank_hdmi_audio_write(const int16_t *frames_lr, uint32_t num_frames);

/* Free space in the HDMI audio ring, in stereo frames. */
uint32_t frank_hdmi_audio_free(void);

/*
 * Diagnostic counters bumped by the Core 1 encode loop.  Useful for
 * a heartbeat from Core 0: if frames keeps incrementing at ~60/s the
 * encoder is alive.  Volatile reads only, no synchronisation.
 */
extern volatile uint32_t frank_hdmi_heartbeat_lines;
extern volatile uint32_t frank_hdmi_heartbeat_frames;

#ifdef __cplusplus
}
#endif

#endif /* FRANK_HDMI_SOUND_H_ */
