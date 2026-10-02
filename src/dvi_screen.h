/*
 * dvi_screen.h —— HDMI 屏幕驱动入口（PIO bitbang DVI + HDMI 数据岛音频）
 *
 * 为什么不用 hdmi_screen.h 那一套（pico_hdmi/HSTX）：
 *   见 dvi_screen.c 顶部的说明 —— HSTX 硬连 GPIO12..19，
 *   而微雪 RP2350-PiZero 的 DVI 在 GPIO32..39，只能走 PIO。
 *
 * hdmi_screen.c/h 保留在仓库里，但当前不参与构建、也不被调用；
 * 如果以后换到 HSTX 引脚的板子，那套还能用。
 */
#ifndef DVI_SCREEN_H
#define DVI_SCREEN_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 初始化 DVI 输出并进入显示循环。
 *
 * 注意：本函数【不返回】。内部把系统时钟设到 252MHz（1.25V 内核电压），
 * 在 Core1 上跑 DVI 引擎，Core0 负责逐帧画图与推送音频。
 */
void dvi_screen_test(void);

/*
 * Core0 侧的存活信标：显示主循环每转一圈 +1。
 *
 * 为什么要单独有这个：
 *   `dvi0.dvi_frame_count` 是 Core1 的引擎计数，
 *   两个核各自独立，光看它没法判断"到底是哪一边停了"。
 *   实测就吃过这个亏：引擎计数冻在 107 不动，而 Core0 其实已经画到 5139 帧，
 *   一度被误判成"整个程序卡死"。
 *   排查时【两个计数器都要读】。
 */
extern volatile uint32_t g_dvi_loop_frames;

#ifdef __cplusplus
}
#endif

#endif /* DVI_SCREEN_H */
