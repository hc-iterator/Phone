/*
 * tools/host_test/stub/hardware/psram.h —— hardware/psram.h 的主机侧替身
 *
 * kernel_mem.c 只用到两条只读查询：有没有 PSRAM、多大。
 * 主机侧由 host_kmem_main.c 提供实现（默认"没有 PSRAM"），
 * 因为主机上本来就没有那块芯片。
 *
 * ⚠️ 主机侧桩：结论只能是"逻辑对"，PSRAM 的真行为只能在板子上实测。
 */
#ifndef PICO_HOST_STUB_HARDWARE_PSRAM_H
#define PICO_HOST_STUB_HARDWARE_PSRAM_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 主机侧实现见 host_kmem_main.c：返回 false / 0 */
bool   psram_is_available(void);
size_t psram_get_size(void);

#ifdef __cplusplus
}
#endif

#endif /* PICO_HOST_STUB_HARDWARE_PSRAM_H */
