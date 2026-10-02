#ifndef KERNEL_H
#define KERNEL_H

/*
 * 内存越权系统调用的内核接口。
 *
 * 实现见 kernel.c，设计说明见 docs/系统调用设计.md。
 *
 * 注意 extern "C"：kernel.c 是 C，调用方 main.cpp 是 C++，
 * 少了这层包装会因名称修饰（name mangling）链接失败 —— 这个坑本项目踩过两次。
 */
#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

/* 系统页按 4 字节一个槽位划分，地址本身编码调用号 */
#define SYSCALL_WORDS 1024          /* 4KB / 4 */

/* 系统页本体，位于自定义段 .syspage，4KB 对齐 */
extern uint32_t g_sys_page[SYSCALL_WORDS];

/* 运行演示：配置 MPU、切入非特权态、跑一段应用、打印结果 */
void kernel_syscall_demo(void);

/*
 * 最小自检：只验证"非特权态写系统页 → 触发 MemManage → 内核识别为系统调用"
 * 这条链路本身。
 *
 * 为什么单独做这个：原演示依赖 printf，而 printf 在异常上下文里不安全；
 * 而且异常处理程序若要访问外设还得先升回特权态，牵出循环依赖。
 * 这个自检【完全不碰外设】，只用内存变量记录结果，因此不受上述问题影响，
 * 结果由调试器（SWD）直接读变量即可。
 *
 * 读法：
 *   pico_kernel_selftest_status  1=通过 0=未通过/未运行
 *   pico_kernel_selftest_faults  处理程序被触发次数（期望 1）
 *   pico_kernel_selftest_addr    处理程序看到的出错地址（期望 0x20006000）
 */
extern volatile uint32_t pico_kernel_selftest_status;
extern volatile uint32_t pico_kernel_selftest_faults;
extern volatile uint32_t pico_kernel_selftest_addr;
void kernel_minimal_selftest(void);

/*
 * ── 第 18 轮探针：把"此刻是不是特权态"从推理改成测量 ──
 *
 * 起因：前几轮反复栽在"处理程序/线程到底什么特权"的推理上，
 * 每次都要花掉整轮。现在一律采样，由 SWD 读走数字。
 *
 * 读法（全部是普通内存变量，任何特权级都能读）：
 *   g_probe_marks          最后到达的进度点。崩溃时看它就知道死在哪一步。
 *   g_probe_ctrl[0]        第 1 次 SVC 处理程序入口读到的 CONTROL
 *                          （1 ⇒ nPRIV 跨异常进入保留；0 ⇒ 进入时被清）
 *   g_probe_ctrl[1]        演示里设 nPRIV=1 之前（应 0 = 特权）
 *   g_probe_ctrl[2]        3 次 SVC 之后、SYS_EXIT 之前（1 = 应用仍非特权）
 *   g_probe_ctrl[3]        SYS_EXIT 之后（0 = 内核已收回权限）
 *   g_probe_ctrl[4]        dvi_screen_test 入口（0 = 屏幕初始化在特权态跑）
 *   g_probe_svc_n          SVC 处理程序进入总次数
 *   g_probe_mpu_type       行为验证：特权态读 MPU_TYPE 非 0，非特权读得 0
 */
void     kernel_mark(uint32_t m);
uint32_t kernel_read_control(void);
extern volatile uint32_t g_probe_marks;
extern volatile uint32_t g_probe_ctrl[8];
extern volatile uint32_t g_probe_svc_n;
extern volatile uint32_t g_probe_mpu_type;

#ifdef __cplusplus
}
#endif

#endif /* KERNEL_H */
