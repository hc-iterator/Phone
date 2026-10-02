#ifndef STUB_HARDWARE_DMA_H
#define STUB_HARDWARE_DMA_H
/* 主机侧桩：DMA 的占用状态。账本会同步 SDK 状态，所以桩也要有个真状态。
 * 注意：这里用 unsigned int 而不是 SDK 的 uint ——
 * uint 是 pico/types.h 里的 typedef，桩里不该依赖它（MSVC 不认，已踩过）。 */
#include <stdbool.h>
#include <stdint.h>
void dma_channel_claim(unsigned int channel);
void dma_channel_unclaim(unsigned int channel);
bool dma_channel_is_claimed(unsigned int channel);
#endif
