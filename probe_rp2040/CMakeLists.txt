cmake_minimum_required(VERSION 3.13)

# RP2040 采样探针（独立工程：PICO_PLATFORM/PICO_BOARD 是工程级设置）
if(NOT DEFINED ENV{PICO_SDK_PATH})
    set(ENV{PICO_SDK_PATH} "$ENV{USERPROFILE}/.pico-sdk/sdk/2.3.0")
endif()

# ★ 必须有：pioasm / picotool 的路径由它设置（VSCode 扩展的配置）
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

project(probe_rp2040 C CXX ASM)
set(CMAKE_C_STANDARD 11)
pico_sdk_init()

add_executable(probe_rp2040 probe.c)
pico_generate_pio_header(probe_rp2040 ${CMAKE_CURRENT_LIST_DIR}/sampler.pio)
pico_enable_stdio_usb(probe_rp2040 1)
pico_enable_stdio_uart(probe_rp2040 1)
target_link_libraries(probe_rp2040 pico_stdlib hardware_pio hardware_dma hardware_clocks hardware_vreg)
pico_add_extra_outputs(probe_rp2040)
