#ifndef STUB_HARDWARE_GPIO_H
#define STUB_HARDWARE_GPIO_H
/* 主机侧桩：GPIO。kernel_res.c 只是 include 了它，GPIO 的操作全在账本里，
 * 不碰 SDK。所以这个头只需要存在。 */
#include <stdbool.h>
#include <stdint.h>
#endif
