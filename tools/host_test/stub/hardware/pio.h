#ifndef STUB_HARDWARE_PIO_H
#define STUB_HARDWARE_PIO_H
/* 主机侧桩：PIO 实例与状态机占用。
 * 形状要和 SDK 一致：PIO 是一个类型，pio0/pio1/pio2 是【指针】，
 * 因为 kernel_res.c 里写的是 static PIO *const k_pio[NUM_PIOS]。 */
#include <stdbool.h>
#include <stdint.h>

typedef struct pio_hw { int id; } PIO;

extern PIO pio0_stub, pio1_stub, pio2_stub;
#define pio0 (&pio0_stub)
#define pio1 (&pio1_stub)
#define pio2 (&pio2_stub)

#define NUM_PIOS 3

void pio_sm_claim(PIO *pio, int sm);
void pio_sm_unclaim(PIO *pio, int sm);
bool pio_sm_is_claimed(PIO *pio, int sm);
#endif
