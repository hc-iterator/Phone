#define SD_DRIVER_USE_SPI_ONLY 1
#define DEBUG_PRINTF printf

/* main.c
Copyright 2021 Carl John Kugler III

Licensed under the Apache License, Version 2.0 (the License); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at

   http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an AS IS BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
*/

#include <stdio.h>
//
#include "pico/stdlib.h"
//
#include "hw_config.h"
#include "f_util.h"
#include "ff.h"

/**
 * @file main.c
 * @brief Minimal example of writing to a file on SD card
 * @details
 * This program demonstrates the following:
 * - Initialization of the stdio
 * - Mounting and unmounting the SD card
 * - Opening a file and writing to it
 * - Closing a file and unmounting the SD card
 */

int main() {
    // Initialize stdio
    stdio_init_all();

    gpio_init(25);
    gpio_set_dir(25, GPIO_OUT);
    gpio_put(25, 1);

    gpio_init(7);
    gpio_set_dir(7, GPIO_OUT);
    gpio_put(7, 1); // 先拉高，后拉低
    gpio_deinit(7);

    //while(!stdio_usb_connected()) {
        //tight_loop_contents();
    //}
    __breakpoint();

    puts("50:Hello, world!");

    sd_card_t *sd = sd_get_by_num(0);
if (sd) {
    printf("Got SD card object at %p\n", (void*)sd);

    // 先初始化卡
    printf("Calling sd->init(sd)...\n");
    printf("sd->init = %p\n", (void*)sd->init);
    DSTATUS init_status = sd->init(sd);
    printf("sd->init returned: 0x%02X\n", init_status);
    if (init_status != 0) {
        printf("SD card init failed!\n");
    } else {
        printf("Testing raw sector read...\n");
        uint8_t buf[512];
        int rc = sd->read_blocks(sd, buf, 0, 1);  // 现在函数指针已赋值
        if (rc == 0) {
            printf("Read sector 0 OK! MBR signature: 0x%02X%02X\n", buf[510], buf[511]);
            if (buf[510] == 0x55 && buf[511] == 0xAA) {
                printf("Valid MBR found.\n");
            } else {
                printf("Invalid MBR signature.\n");
            }
        } else {
            printf("Read sector 0 FAILED! rc=%d\n", rc);
        }
    }
} else {
    printf("sd_get_by_num(0) returned NULL!\n");
}

    // See FatFs - Generic FAT Filesystem Module, "Application Interface",
    // http://elm-chan.org/fsw/ff/00index_e.html

    FATFS fs;
    FRESULT fr = f_mount(&fs, "0:", 1);
    if (FR_OK != fr) {
        panic("f_mount error: %s (%d)\n", FRESULT_str(fr), fr);
    }

    puts("60:Hello, world!");

    // Open a file and write to it
    FIL fil;
    const char* const filename = "filename.txt";
    fr = f_open(&fil, filename, FA_OPEN_APPEND | FA_WRITE);
    if (FR_OK != fr && FR_EXIST != fr) {
        panic("f_open(%s) error: %s (%d)\n", filename, FRESULT_str(fr), fr);
    }
    if (f_printf(&fil, "Hello, world!\n") < 0) {
        printf("f_printf failed\n");
    }

    puts("73:Hello, world!");

    // Close the file
    fr = f_close(&fil);
    if (FR_OK != fr) {
        printf("f_close error: %s (%d)\n", FRESULT_str(fr), fr);
    }

    puts("81:Hello, world!");

    // Unmount the SD card
    f_unmount("");

    puts("86:Goodbye, world!");
    for (;;);
}
