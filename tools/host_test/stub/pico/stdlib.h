#ifndef STUB_PICO_STDLIB_H
#define STUB_PICO_STDLIB_H
/* 主机侧桩：SDK 的 stdlib 头只需要"存在"，不需要有内容。 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
/* SDK 的 uint 在 pico/types.h 里；MSVC 没有这个类型。
 * 错 14 错 2 就是漏了它 ⇒ dma.h 解析失败 ⇒ 所有声明作废。
 * kernel_mem.c 也要用 uint，所以这里必须带上。 */
#include "pico/types.h"
#endif
