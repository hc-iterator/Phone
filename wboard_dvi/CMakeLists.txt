cmake_minimum_required(VERSION 3.13)

# ============================================================================
# 待测板（Waveshare RP2350B Plus W）的 DVI 输出固件
#
# 目的：不是造手机，而是【当一个已知的 DVI 信号源】，让 RP2040 探针去采它。
# 所以只编最小程序 dvi_min（复用主工程的源文件与 frank-hdmi-sound 库，不复制代码）。
#
# 与主工程的差异只有两处：
#   ① 板级：waveshare_rp2350_plus_16mb（SDK 里没有 "Plus W" 的定义；
#           无线部分本实验用不到，先不管）
#   ② DVI 引脚：改成 GPIO 0..7 区间，与探针的接线一一对应
#        0=D2P 1=D2N 2=D1P 3=D1N 4=D0P 5=D0N 6=CLKP 7=CLKN
#      （库内部把每个信号的正负脚当作 base 与 base+1）
# ============================================================================
if(NOT DEFINED ENV{PICO_SDK_PATH})
    set(ENV{PICO_SDK_PATH} "$ENV{USERPROFILE}/.pico-sdk/sdk/2.3.0")
endif()
# ==== Raspberry Pi Pico VS Code 扩展的配置（pioasm / picotool 路径就靠它）====
if(WIN32)
    set(USERHOME $ENV{USERPROFILE})
else()
    set(USERHOME $ENV{HOME})
endif()
set(sdkVersion 2.3.0)
set(toolchainVersion 15_2_Rel1)
set(picotoolVersion 2.3.0)
set(picoVscode ${USERHOME}/.pico-sdk/cmake/pico-vscode.cmake)
if(EXISTS ${picoVscode})
    include(${picoVscode})
endif()
# ==============================================================================
include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)

set(PICO_PLATFORM rp2350-arm-s CACHE STRING "" FORCE)
set(PICO_BOARD waveshare_rp2350_plus_16mb CACHE STRING "" FORCE)

project(wboard_dvi C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

# DVI 库（与主工程同一个，已含本项目的驱动强度等修复）
set(FRANK_HDMI_SM_CLKDIV "1" CACHE STRING "" FORCE)
add_subdirectory(${CMAKE_CURRENT_LIST_DIR}/../third_party/frank-hdmi-sound
                 ${CMAKE_CURRENT_BINARY_DIR}/frank-hdmi-sound)

add_executable(dvi_min ${CMAKE_CURRENT_LIST_DIR}/../src/dvi_min.c)
target_compile_definitions(dvi_min PRIVATE
    FRANK_HDMI_PIN_CLK=6
    FRANK_HDMI_PIN_D0=4
    FRANK_HDMI_PIN_D1=2
    FRANK_HDMI_PIN_D2=0
    FRANK_HDMI_INVERT_DIFFPAIRS=1
)
target_include_directories(dvi_min PRIVATE ${CMAKE_CURRENT_LIST_DIR}/../src)
target_link_libraries(dvi_min pico_stdlib hardware_pio hardware_dma hardware_clocks frank_hdmi_sound)
pico_enable_stdio_uart(dvi_min 1)
pico_enable_stdio_usb(dvi_min 1)
pico_add_extra_outputs(dvi_min)
