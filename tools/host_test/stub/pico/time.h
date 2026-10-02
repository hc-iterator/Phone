#ifndef STUB_PICO_TIME_H
#define STUB_PICO_TIME_H
/* 主机侧桩：假时钟。
 * 用【可控的】微秒计数代替真实定时器 —— 这样"超时"用例是确定性的，不会偶发失败。 */
#include <stdint.h>
uint32_t time_us_32(void);
void     busy_wait_us_32(uint32_t us);
#endif
