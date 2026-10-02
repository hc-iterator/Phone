/*
 * hw_config.cpp - SD card hardware configuration for Waveshare RP2350-PiZero
 *
 * SDIO mode. The previous SPI-mode configuration lived here (verified working,
 * see commit 9197ba5) and used:
 *     SPI1  SCK=30  MOSI=31  MISO=40  CS=43
 *
 * SDIO reuses the same socket lines:
 *     CMD = 31  (was MOSI)
 *     D0  = 40  (was MISO)
 *     D3  = 43  (was CS)
 *     D1  = 41  (wired, pull-up present per schematic)
 *     D2  = 42  (wired, pull-up present per schematic)
 *
 * Pin rule imposed by sd_driver/SDIO/rp2040_sdio.pio:
 *     CLK_gpio = (D0_gpio + SDIO_CLK_PIN_D0_OFFSET) % 32
 *     D1_gpio = D0_gpio + 1, D2 = +2, D3 = +3
 *
 * SDIO_CLK_PIN_D0_OFFSET is 22, which is what makes this layout consistent:
 *     CLK = (40 + 22) % 32 = 30   <- matches SCK on the socket
 * (The upstream value of 30 would put CLK at 38, which is NOT this board.)
 *
 * RP2350 only reaches GPIO 32..47 through a PIO when the PIO GPIO base is
 * moved to 16 (PICO_SDIO_GPIO_BASE_16, consumed by rp2040_sdio.c). Base 16
 * gives the window [16..47], covering CLK=30, CMD=31 and D0..D3=40..43.
 */

#include "hw_config.h"

/* SDIO Interface */
static sd_sdio_if_t sdio_if = {
    /*
     * Only D0_gpio and CMD_gpio may be set here.
     *
     * sd_sdio_ctor() ASSERTS that CLK_gpio, D1_gpio, D2_gpio and D3_gpio are
     * zero and then derives them itself (sd_card_sdio.c:645-653):
     *     CLK_gpio = (D0_gpio + SDIO_CLK_PIN_D0_OFFSET) % 32
     *     D1_gpio  = D0_gpio + 1
     *     D2_gpio  = D0_gpio + 2
     *     D3_gpio  = D0_gpio + 3
     *
     * Filling these in "correctly" from the schematic actively breaks the
     * build's runtime: it trips the assertion and the board appears to hang.
     * This was the actual cause of the SDIO bring-up hang.
     *
     * Which physical pin the clock lands on is therefore decided solely by
     * SDIO_CLK_PIN_D0_OFFSET in rp2040_sdio.pio. With D0 = 40:
     *     offset 22 -> CLK = (40 + 22) % 32 = 30   <- matches SCK on this board
     */
    .CMD_gpio = 31,
    .D0_gpio  = 40,

    .SDIO_PIO = pio1,
    /*
 * ⚠️ 从 DMA_IRQ_1 改成 DMA_IRQ_0。
 *
 * 原因：frank-hdmi-sound 的 DVI 引擎【硬编码】占用 DMA_IRQ_1
 * （它注释说这样能避开 Core0 上使用 DMA_IRQ_0 的代码）。
 * 而本配置原来正好把 SDIO 放在 DMA_IRQ_1 且 use_exclusive_DMA_IRQ_handler
 * = true，于是 Core1 启动 DVI 时 irq_set_exclusive_handler(DMA_IRQ_1, ...)
 * 断言失败：
 *     current == __unhandled_user_irq || current == handler
 *     hardware_irq/irq.c:260
 * 直接 panic，屏幕完全不出图。
 *
 * 一个 IRQ 只能有一个独占处理程序，所以两边必须分居：
 *     SDIO -> DMA_IRQ_0（本文件）
 *     DVI  -> DMA_IRQ_1（库内固定，不改）
 * frank_dvi.c 本身两种都支持，只是库选了 DMA_IRQ_1。
 *
 * 注意：SDIO 只在插卡时初始化，晚于 DVI，所以它让位更安全。
 */
.DMA_IRQ_num = DMA_IRQ_0,
    .use_exclusive_DMA_IRQ_handler = true,

    /*
     * clk_sys is the SDK default 150 MHz here, NOT the 126 MHz that the old
     * HDMI build used to set. An earlier revision divided 126 MHz and so
     * asked for 25.2 MHz while the chip actually ran at 150 MHz, producing
     * ~30 MHz -- above the card's 25 MHz ceiling. Confirmed on hardware:
     * the board prints sys_clk = 150000000.
     *
     * The driver performs card identification at a fixed 400 kHz regardless
     * of this value, so this only affects transfers after the handshake.
     *
     * 150 / 8 = 18.75 MHz: an exact integer PIO divider (clock div 2.0) with
     * margin below 25 MHz and no fractional-divider jitter.
     */
    .baud_rate = 150 * 1000 * 1000 / 8,  // 18.75 MHz

    .set_drive_strength = true,
    .CLK_gpio_drive_strength = GPIO_DRIVE_STRENGTH_12MA,
    .CMD_gpio_drive_strength = GPIO_DRIVE_STRENGTH_4MA,
    .D0_gpio_drive_strength = GPIO_DRIVE_STRENGTH_4MA,
    .D1_gpio_drive_strength = GPIO_DRIVE_STRENGTH_4MA,
    .D2_gpio_drive_strength = GPIO_DRIVE_STRENGTH_4MA,
    .D3_gpio_drive_strength = GPIO_DRIVE_STRENGTH_4MA,
};

/*
 * The intended clock pin is a property of SDIO_CLK_PIN_D0_OFFSET, not of this
 * file, so it cannot be asserted from here without re-deriving the driver's
 * formula. The value to keep in mind when editing the .pio file:
 *     (D0_gpio 40 + offset 22) % 32 = CLK 30  == SCK on the socket
 */

/* Hardware Configuration of the SD Card socket "object" */
static sd_card_t sd_card = {
    .type = SD_IF_SDIO,
    .sdio_if_p = &sdio_if,

    /*
     * No card-detect GPIO is wired on this board's TF socket, so leave it off.
     * The SPI configuration that previously worked did not use it either.
     */
    .use_card_detect = false,
};

/* ********************************************************************** */

size_t sd_get_num() { return 1; }

sd_card_t *sd_get_by_num(size_t num) {
    if (0 == num) {
        return &sd_card;
    } else {
        return NULL;
    }
}

/* [] END OF FILE */
