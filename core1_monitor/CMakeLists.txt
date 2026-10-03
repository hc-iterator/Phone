cmake_minimum_required(VERSION 3.13)

# ============================================================================================
#  ★ 关键块：pioasm / picotool 的路径由它设置。
#    漏了这块，SDK 会去现场编译主机工具，然后因为找不到主机 C++ 编译器而失败
#    （本项目已经踩过好几轮）。
# ============================================================================================
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
include($ENV{PICO_SDK_PATH}/external/pico_sdk_import.cmake)
set(PICO_PLATFORM rp2040 CACHE STRING "" FORCE)
set(PICO_BOARD pico CACHE STRING "" FORCE)
# ============================================================================================

project(core1_monitor C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

add_executable(core1_monitor core1_monitor.c)

# PIO 采样程序（sampler.pio）→ 由 pioasm 生成 sampler.pio.h。
# 注意：pioasm 的路径来自文件开头那个"关键块"（pico-vscode.cmake）——
# 少了它，这一步会去现场编译主机工具然后失败（本项目踩过好几轮的坑）。
pico_generate_pio_header(core1_monitor ${CMAKE_CURRENT_LIST_DIR}/sampler.pio)

# 只用 USB CDC 当串口：UART 关掉，省得两个串口抢输出（Core0/Core1 分工已经够清楚了）
pico_enable_stdio_usb(core1_monitor 1)
pico_enable_stdio_uart(core1_monitor 0)

target_link_libraries(core1_monitor
    pico_stdlib        # stdio + time + sync + 一堆基础件
    pico_multicore     # multicore_launch_core1 / 核间 FIFO
    hardware_flash     # flash_range_erase / flash_range_program / flash_do_cmd
    hardware_clocks    # clock_get_hz(clk_sys) —— S 命令要报时钟
    hardware_watchdog  # R 命令的 watchdog_reboot
    hardware_irq       # USB 服务换核要用 irq_set_enabled / user_irq_is_claimed
    hardware_pio       # 采样器：PIO0 的 SM + FIFO
    hardware_vreg      # 采样器要超频到 252 MHz（沿用 probe_rp2040 的档位）
)

pico_add_extra_outputs(core1_monitor)
