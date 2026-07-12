// spi_cmd0_test.c
// 极简 SD 卡 SPI 模式 CMD0 测试
// 接线：SCK=GPIO2, MOSI=GPIO3, MISO=GPIO4, CS=GPIO7
// 编译时需链接 hardware_spi 和 pico_stdlib

#include <stdio.h>
#include <stdint.h>
#include "pico/stdlib.h"
#include "hardware/spi.h"
#include "hardware/gpio.h"

// 引脚定义（与你当前接线一致）
#define PIN_SCK   2
#define PIN_MOSI  3
#define PIN_MISO  4
#define PIN_CS    7

// SPI 实例
#define SPI_PORT spi0

// 发送 CMD0（带 CRC，0x95）
static void sd_cmd0() {
    uint8_t cmd[] = {0x40, 0x00, 0x00, 0x00, 0x00, 0x95};
    gpio_put(PIN_CS, 0);          // 拉低 CS，选中卡
    spi_write_blocking(SPI_PORT, cmd, 6);
    // 等待响应（最多 8 个字节，通常第一个非 0xFF 就是响应）
    for (int i = 0; i < 8; i++) {
        uint8_t resp = 0xFF;
        spi_read_blocking(SPI_PORT, 0xFF, &resp, 1);
        if (resp != 0xFF) {
            printf("CMD0 response: 0x%02X\n", resp);
            break;
        }
        if (i == 7) printf("CMD0 timeout (no response)\n");
    }
    gpio_put(PIN_CS, 1);          // 拉高 CS，释放
}

int main() {
    stdio_init_all();

    // 等待 USB 连接（方便看输出）
    while (!stdio_usb_connected()) tight_loop_contents();

    printf("=== SD Card SPI CMD0 Test ===\n");

    // 1. 初始化 GPIO
    gpio_init(PIN_CS);
    gpio_set_dir(PIN_CS, GPIO_OUT);
    gpio_put(PIN_CS, 1);          // 默认 CS 高

    // 2. 初始化 SPI
    spi_init(SPI_PORT, 400 * 1000);  // 初始化用 400kHz（低速安全）
    spi_set_format(SPI_PORT, 8, SPI_CPOL_0, SPI_CPHA_0, SPI_MSB_FIRST);
    gpio_set_function(PIN_SCK,  GPIO_FUNC_SPI);
    gpio_set_function(PIN_MOSI, GPIO_FUNC_SPI);
    gpio_set_function(PIN_MISO, GPIO_FUNC_SPI);

    // 3. 发送至少 74 个时钟脉冲让卡进入 SPI 模式
    //    方法：拉低 CS，发送 10 个 0xFF（80 个时钟）
    gpio_put(PIN_CS, 0);
    for (int i = 0; i < 10; i++) {
        spi_write_blocking(SPI_PORT, (uint8_t[]){0xFF}, 1);
    }
    gpio_put(PIN_CS, 1);
    sleep_ms(10);

    // 4. 发送 CMD0，获取响应
    printf("Sending CMD0...\n");
    sd_cmd0();

    // 5. 发送 CMD8（可选，用于区分 SDHC 等）
    //    这里不做，仅测试基本通信。

    printf("Test done. Loop forever.\n");
    while (1) tight_loop_contents();
}