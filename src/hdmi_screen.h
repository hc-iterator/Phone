/*
 * hdmi_screen.h —— HDMI 屏幕点亮测试入口
 */
#ifndef HDMI_SCREEN_H
#define HDMI_SCREEN_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 初始化 HDMI 输出并进入显示循环。
 *
 * 注意：本函数【不返回】—— 内部是 Core0 的显示主循环，
 * 画面由 Core1 的 HSTX DMA 持续输出。
 *
 * 调用前请确保不需要再用 USB 串口打印诊断（HSTX 会占用相关时钟配置）。
 */
void hdmi_screen_test(void);

#ifdef __cplusplus
}
#endif

#endif /* HDMI_SCREEN_H */
