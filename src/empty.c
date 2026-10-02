/* 空固件：什么都不做，只空转。
 * 用途：把板子恢复成"安静"状态 —— 不跑 DVI 引擎、不占满总线，
 * 这样调试口/USB 就稳定了。所有外设留在复位状态。 */
#include "pico/stdlib.h"

int main(void) {
    while (true) {
        tight_loop_contents();
    }
}
