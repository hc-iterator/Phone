#include <cstdio>
#include <cstring>
#include "pico/stdlib.h"
#include "pico/time.h"
#include "ff.h"
#include "hw_config.h"

int main() {
    stdio_init_all();
    sleep_ms(3000);
    printf("\n=== SD Card Raw Speed Test ===\n");

    // 1. 挂载 SD 卡（FatFs 会自动初始化 SPI）
    sd_card_t *sd = sd_get_by_num(0);
    FRESULT fr = f_mount(&sd->fatfs, "", 1);
    if (fr != FR_OK) {
        printf("Mount failed, error code: %d\n", fr);
        while (1) tight_loop_contents();
    }
    printf("SD card mounted.\n");

    // 2. 打开文件
    FIL file;
    fr = f_open(&file, "readme.txt", FA_READ);
    if (fr != FR_OK) {
        printf("readme.txt not found. Error: %d\n", fr);
        f_unmount("");
        while (1) tight_loop_contents();
    }

    // 3. 读取并测速
    const size_t BUF_SIZE = 4096;
    uint8_t buf[BUF_SIZE];
    UINT br;
    uint32_t total_bytes = 0;
    absolute_time_t start = get_absolute_time();

    while (f_read(&file, buf, sizeof(buf), &br) == FR_OK && br > 0) {
        total_bytes += br;
    }
    absolute_time_t end = get_absolute_time();
    int64_t elapsed_us = absolute_time_diff_us(start, end);

    f_close(&file);

    // 4. 输出结果
    printf("Read %lu bytes in %lld us (%.2f ms)\n",
           total_bytes, elapsed_us, elapsed_us / 1000.0);
    if (elapsed_us > 0) {
        double speed_kbps = (total_bytes / 1024.0) / (elapsed_us / 1000000.0);
        printf("Speed: %.2f KB/s\n", speed_kbps);
    }

    // 5. 获取空闲空间
    FATFS *fs_ptr;
    DWORD fre_clust;
    fr = f_getfree("", &fre_clust, &fs_ptr);
    if (fr == FR_OK) {
        uint64_t free_kb = (uint64_t)fre_clust * fs_ptr->csize * 512 / 1024;
        printf("Free space: %llu KB\n", free_kb);
    }

    f_unmount("");
    printf("Done.\n");
    while (1) tight_loop_contents();
    return 0;
}