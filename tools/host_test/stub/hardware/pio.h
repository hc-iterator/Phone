#ifndef STUB_HARDWARE_PIO_H
#define STUB_HARDWARE_PIO_H
/* 主机侧桩：PIO 实例与状态机占用。
 *
 * 形状必须和真 SDK 逐字对齐，否则被桩的源文件会被"桩的形状"卡住编译。
 * 真 SDK（C:\Users\...\.pico-sdk\sdk\2.3.0）：
 *     hardware/pio.h:121   typedef pio_hw_t *PIO;          <-- PIO 是【指针类型】
 *     hardware/pio.h:129   #define pio0 pio0_hw
 *     hardware/pio.h:2039  void pio_sm_claim(PIO pio, uint sm);   <-- 按值收指针
 *     hardware/pio.h:2082  bool pio_sm_is_claimed(PIO pio, uint sm);
 * 而被测源码写的是：
 *     src/kernel_res.c:61  static PIO const k_pio[NUM_PIOS] = { pio0, pio1, pio2 };
 *     （PIO const = "const 指针"，正是 SDK 的形状）
 *
 * 【2026-10-05 修】老桩把 PIO 定义成结构体、三个函数收 PIO *，于是 MSVC 报
 *     ..\..\src\kernel_res.c(215): error C2440: 无法从"const PIO"转换为"PIO *"
 *     （216 / 227 / 245 / 246 同）
 * 和 kernel_res.c(61) 的 warning C4047。根因是【桩的形状过时了】，不是内核代码
 * 有 bug —— 内核在真 GCC/SDK 上编得过也跑得对。0f882a2 把 kernel_res.c 从
 * "PIO *const" 修成 "PIO const" 时漏改了这个桩。
 * 断言（重复认领 / 释放未认领）一条没动，改的只是类型形状。 */
#include <stdbool.h>
#include <stdint.h>

typedef struct pio_hw { int id; } pio_hw_t;   /* 对应 SDK 的 pio_hw_t */
typedef pio_hw_t *PIO;                        /* 对应 SDK: typedef pio_hw_t *PIO; */

extern pio_hw_t pio0_stub, pio1_stub, pio2_stub;
#define pio0 (&pio0_stub)
#define pio1 (&pio1_stub)
#define pio2 (&pio2_stub)

#define NUM_PIOS 3

void pio_sm_claim(PIO pio, int sm);
void pio_sm_unclaim(PIO pio, int sm);
bool pio_sm_is_claimed(PIO pio, int sm);
#endif
