/*
 * tools/host_test/stub/pico/types.h —— pico/types.h 的主机侧替身
 *
 * 为什么需要它：内核源码用了 SDK 的 uint（= unsigned int），
 * 而 MSVC 没有这个类型。
 * 错 14 错 2 就是栽在这里：当时在桩头文件里用了 uint，
 * 于是 dma.h 解析失败、所有声明作废、真源码里的调用退化成
 * "假设返回 int"（warning C4013），一编译就错一大片。
 *
 * ⇒ 所以这个文件【只用 C 标准类型】，并把 SDK 那个 uint 补上。
 *
 * ⚠️ 主机侧桩：只为了让源码在 PC 上编译，不代表硬件行为。
 */
#ifndef PICO_HOST_STUB_TYPES_H
#define PICO_HOST_STUB_TYPES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* SDK 的 pico/types.h 里就有这个 —— MSVC 没有，必须补 */
typedef unsigned int uint;

#endif /* PICO_HOST_STUB_TYPES_H */
