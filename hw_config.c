#include "hw_config.h"
#include "spi.h"
#include "sd_card.h"

static spi_t spi1_dev = {
    .hw_inst = spi1,
    .miso_gpio = 11,
    .mosi_gpio = 12,
    .sck_gpio = 10,
    .baud_rate = 25 * 1000 * 1000
};

static sd_card_t sd_card_dev = {
    .pcName = "0:",
    .spi = &spi1_dev,
    .ss_gpio = 13,
    .use_card_detect = false
};

size_t spi_get_num(void) { return 1; }
spi_t *spi_get_by_num(size_t num) {
    return (num == 0) ? &spi1_dev : NULL;
}

size_t sd_get_num(void) { return 1; }
sd_card_t *sd_get_by_num(size_t num) {
    return (num == 0) ? &sd_card_dev : NULL;
}