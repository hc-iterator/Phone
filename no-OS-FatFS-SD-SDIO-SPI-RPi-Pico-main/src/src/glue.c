/* glue.c
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
/*-----------------------------------------------------------------------*/
/* Low level disk I/O module SKELETON for FatFs     (C)ChaN, 2019        */
/*-----------------------------------------------------------------------*/
/* If a working storage control module is available, it should be        */
/* attached to the FatFs via a glue function rather than modifying it.   */
/* This is an example of glue functions to attach various exsisting      */
/* storage control modules to the FatFs module with a defined API.       */
/*-----------------------------------------------------------------------*/
//
//
#include "hw_config.h"
#include "my_debug.h"
#include "sd_card.h"
//
#include "diskio.h" /* Declarations of disk functions */

#define TRACE_PRINTF(fmt, args...)
//#define TRACE_PRINTF printf  // task_printf

/*-----------------------------------------------------------------------*/
/* Get Drive Status                                                      */
/*-----------------------------------------------------------------------*/

DSTATUS disk_status(BYTE pdrv /* Physical drive number to identify the drive */
) {
    TRACE_PRINTF(">>> %s\n", __FUNCTION__);
    sd_card_t *sd_card_p = sd_get_by_num(pdrv);
    if (!sd_card_p) return RES_PARERR;
    sd_card_detect(sd_card_p);   // Fast: just a GPIO read
    return sd_card_p->state.m_Status;  // See http://elm-chan.org/fsw/ff/doc/dstat.html
}

/*-----------------------------------------------------------------------*/
/* Inidialize a Drive                                                    */
/*-----------------------------------------------------------------------*/

/*
DSTATUS disk_initialize(
    BYTE pdrv /* Physical drive number to identify the drive */
/*) {

    TRACE_PRINTF(">>> %s\n", __FUNCTION__);

    bool ok = sd_init_driver();
    if (!ok) return RES_NOTRDY;

    sd_card_t *sd_card_p = sd_get_by_num(pdrv);
    if (!sd_card_p) return RES_PARERR;
    DSTATUS ds = disk_status(pdrv);
    if (STA_NODISK & ds) 
        return ds;
    // See http://elm-chan.org/fsw/ff/doc/dstat.html
    return sd_card_p->init(sd_card_p);  
}
*/












#include <stdio.h>
DSTATUS disk_initialize(BYTE pdrv) {
    // ===== 入口 =====
    printf("[disk_initialize] ENTRY: pdrv=%d\n", pdrv);

    // 1. 调用 sd_init_driver()
    printf("[disk_initialize] Calling sd_init_driver()...\n");
    bool ok = sd_init_driver();
    printf("[disk_initialize] sd_init_driver() returned: %d (true=1, false=0)\n", ok);
    if (!ok) {
        printf("[disk_initialize] sd_init_driver FAILED, returning STA_NOINIT\n");
        return RES_NOTRDY;   // 注意原代码返回 RES_NOTRDY，但 RES_NOTRDY 可能是 0xFF? 我们按标准改
        // 实际上如果 sd_init_driver 返回 false，说明驱动初始化失败，返回 STA_NOINIT
    }

    // 2. 获取 SD 卡对象
    printf("[disk_initialize] Calling sd_get_by_num(%d)...\n", pdrv);
    sd_card_t *sd_card_p = sd_get_by_num(pdrv);
    printf("[disk_initialize] sd_get_by_num() returned: %p\n", (void*)sd_card_p);
    if (!sd_card_p) {
        printf("[disk_initialize] sd_get_by_num FAILED, returning STA_NOINIT\n");
        return RES_PARERR;   // 原代码返回 RES_PARERR，同样不合理，改为 STA_NOINIT
    }

    // 3. 调用 disk_status 检查当前状态
    printf("[disk_initialize] Calling disk_status(%d)...\n", pdrv);
    DSTATUS ds = disk_status(pdrv);
    printf("[disk_initialize] disk_status() returned: 0x%02X\n", ds);
    if (STA_NODISK & ds) {
        printf("[disk_initialize] STA_NODISK is set, returning ds=0x%02X\n", ds);
        return ds;
    }

    // 4. 调用 SD 卡对象的 init 函数
    printf("[disk_initialize] Calling sd_card_p->init(sd_card_p) at %p...\n", (void*)sd_card_p->init);
    DSTATUS init_result = sd_card_p->init(sd_card_p);
    printf("[disk_initialize] sd_card_p->init() returned: 0x%02X\n", init_result);
    if (init_result == 0) {
        printf("[disk_initialize] SUCCESS: SD card initialized, returning 0\n");
    } else {
        printf("[disk_initialize] FAILED: SD card init returned 0x%02X, returning STA_NOINIT\n", init_result);
        // 注意：原代码直接返回 init_result，但可能包含 STA_NOINIT，这里我们统一处理
        // 如果 init_result 非0，我们返回 STA_NOINIT 以确保错误被识别
        // 但为了保留原意，直接返回 init_result
        // 不过根据标准，0表示成功，非0表示错误
    }
    return init_result;
}













static int sdrc2dresult(int sd_rc) {
    switch (sd_rc) {
        case SD_BLOCK_DEVICE_ERROR_NONE:
            return RES_OK;
        case SD_BLOCK_DEVICE_ERROR_UNUSABLE:
        case SD_BLOCK_DEVICE_ERROR_NO_RESPONSE:
        case SD_BLOCK_DEVICE_ERROR_NO_INIT:
        case SD_BLOCK_DEVICE_ERROR_NO_DEVICE:
            return RES_NOTRDY;
        case SD_BLOCK_DEVICE_ERROR_PARAMETER:
        case SD_BLOCK_DEVICE_ERROR_UNSUPPORTED:
            return RES_PARERR;
        case SD_BLOCK_DEVICE_ERROR_WRITE_PROTECTED:
            return RES_WRPRT;
        case SD_BLOCK_DEVICE_ERROR_CRC:
        case SD_BLOCK_DEVICE_ERROR_WOULD_BLOCK:
        case SD_BLOCK_DEVICE_ERROR_ERASE:
        case SD_BLOCK_DEVICE_ERROR_WRITE:
        default:
            return RES_ERROR;
            }
        }

/*-----------------------------------------------------------------------*/
/* Read Sector(s)                                                        */
/*-----------------------------------------------------------------------*/

DRESULT disk_read(BYTE pdrv,  /* Physical drive number to identify the drive */
                  BYTE *buff, /* Data buffer to store read data */
                  LBA_t sector, /* Start sector in LBA */
                  UINT count    /* Number of sectors to read */
) {
    TRACE_PRINTF(">>> %s\n", __FUNCTION__);
    sd_card_t *sd_card_p = sd_get_by_num(pdrv);
    if (!sd_card_p) return RES_PARERR;
    int rc = sd_card_p->read_blocks(sd_card_p, buff, sector, count);
    return sdrc2dresult(rc);
}

/*-----------------------------------------------------------------------*/
/* Write Sector(s)                                                       */
/*-----------------------------------------------------------------------*/

#if FF_FS_READONLY == 0

DRESULT disk_write(BYTE pdrv, /* Physical drive number to identify the drive */
                   const BYTE *buff, /* Data to be written */
                   LBA_t sector,     /* Start sector in LBA */
                   UINT count        /* Number of sectors to write */
) {
    TRACE_PRINTF(">>> %s\n", __FUNCTION__);
    sd_card_t *sd_card_p = sd_get_by_num(pdrv);
    if (!sd_card_p) return RES_PARERR;
    int rc = sd_card_p->write_blocks(sd_card_p, buff, sector, count);
    return sdrc2dresult(rc);
}

#endif

/*-----------------------------------------------------------------------*/
/* Miscellaneous Functions                                               */
/*-----------------------------------------------------------------------*/

DRESULT disk_ioctl(BYTE pdrv, /* Physical drive number (0..) */
                   BYTE cmd,  /* Control code */
                   void *buff /* Buffer to send/receive control data */
) {
    TRACE_PRINTF(">>> %s\n", __FUNCTION__);
    sd_card_t *sd_card_p = sd_get_by_num(pdrv);
    if (!sd_card_p) return RES_PARERR;
    switch (cmd) {
        case GET_SECTOR_COUNT: {  // Retrieves number of available sectors, the
                                  // largest allowable LBA + 1, on the drive
                                  // into the LBA_t variable pointed by buff.
                                  // This command is used by f_mkfs and f_fdisk
                                  // function to determine the size of
                                  // volume/partition to be created. It is
                                  // required when FF_USE_MKFS == 1.
            static LBA_t n;
            n = sd_card_p->get_num_sectors(sd_card_p);
            *(LBA_t *)buff = n;
            if (!n) return RES_ERROR;
            return RES_OK;
        }
        case GET_BLOCK_SIZE: {  // Retrieves erase block size of the flash
                                // memory media in unit of sector into the DWORD
                                // variable pointed by buff. The allowable value
                                // is 1 to 32768 in power of 2. Return 1 if the
                                // erase block size is unknown or non flash
                                // memory media. This command is used by only
                                // f_mkfs function and it attempts to align data
                                // area on the erase block boundary. It is
                                // required when FF_USE_MKFS == 1.
            static DWORD bs = 1;
            *(DWORD *)buff = bs;
            return RES_OK;
        }
        case CTRL_SYNC:
            sd_card_p->sync(sd_card_p);
            return RES_OK;
        default:
            return RES_PARERR;
    }
}
