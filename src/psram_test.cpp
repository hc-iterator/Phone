

#include <stdio.h>
#include <stdlib.h>
#include "pico/stdlib.h"
#include "hardware/psram.h"
#include "pico/rand.h"

#define PSRAM_CACHED_BASE 0x11000000u
#define PSRAM_OUT_CACHED_BASE 0x15000000u

#define TEST_SIZE (1 * 1024 * 1024)  // 1MB
__uninitialized_psram("buf")uint8_t psram_buf[TEST_SIZE];

int /*__not_in_flash_func(*/main/*)*/() {
    stdio_init_all();

    //while (!stdio_usb_connected()) {
    //    tight_loop_contents();
    //}


    while(true)
    {
        printf("hello world\n");
    }

    // 1. 检查 PSRAM 是否可用
    if (!psram_is_available()) {
        printf("PSRAM not available!\n");
        while(1) tight_loop_contents();
    }

    


    while(true)
    {
        uint8_t * rd_psram_ptr = (uint8_t *)((uint32_t)(get_rand_32()%TEST_SIZE) + (uint32_t)psram_buf);

        printf("rd_psram_ptr: %p\n", rd_psram_ptr);

        psram_check_address(rd_psram_ptr)? printf("psram_check_address: true\n") : printf("psram_check_address: false\n");

        uint8_t rd_num = (uint8_t)get_rand_32();

        printf("rd_num: %02X\n", rd_num);

        *rd_psram_ptr = rd_num;

        printf("psram_num: %02X\n", *rd_psram_ptr);
        
        sleep_ms(100);
    }


    while(true)
    {
        uint8_t * rd_psram_ptr = (uint8_t *)((get_rand_32() & 0x007FFFF8) + 0x11000000);
        printf("rd_psram_ptr: %p\n", rd_psram_ptr);
        uint8_t rd_num = (uint8_t)get_rand_32();
        printf("rd_num: %02X\n", rd_num);
        *rd_psram_ptr = rd_num;
        printf("psram_num: %02X\n", *rd_psram_ptr);
    }



    while(1) tight_loop_contents();
}