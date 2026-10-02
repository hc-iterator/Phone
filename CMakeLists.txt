# 强制 Debug 模式（-O0 -g）
set(CMAKE_BUILD_TYPE Debug)

# 如果上述设置无效，显式覆盖编译选项
set(CMAKE_C_FLAGS_DEBUG "-O0 -g3 -ggdb" CACHE STRING "" FORCE)
set(CMAKE_CXX_FLAGS_DEBUG "-O0 -g3 -ggdb" CACHE STRING "" FORCE)
set(CMAKE_ASM_FLAGS_DEBUG "-O0 -g3 -ggdb" CACHE STRING "" FORCE)

# Generated Cmake Pico project file

cmake_minimum_required(VERSION 3.13)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Initialise pico_sdk from installed location
# (note this can come from environment, CMake cache etc)

# == DO NOT EDIT THE FOLLOWING LINES for the Raspberry Pi Pico VS Code Extension to work ==
if(WIN32)
    set(USERHOME $ENV{USERPROFILE})
else()
    set(USERHOME $ENV{HOME})
endif()
set(sdkVersion 2.3.0)
set(toolchainVersion 14_2_Rel1)
set(picotoolVersion 2.3.0)
set(picoVscode ${USERHOME}/.pico-sdk/cmake/pico-vscode.cmake)
if (EXISTS ${picoVscode})
    include(${picoVscode})
endif()
# ====================================================================================

set(PICO_BOARD waveshare_rp2350_pizero CACHE STRING "Board type")

# Pull in Raspberry Pi Pico SDK (must be before project)
include(pico_sdk_import.cmake)

set(PICO_PSRAM_SIZE_BYTES 8*1024*1024)

project(SPI_PICO_TEST C CXX ASM)

set(PICO_CXX_ENABLE_EXCEPTIONS 1)

set(PICO_CXX_ENABLE_RTTI 1)

# Initialise the Raspberry Pi Pico SDK
pico_sdk_init()

# Add executable. Default name is the project name, version 0.1

add_executable(SPI_PICO_TEST 
        src/main.cpp
        src/hw_config.cpp
        src/psram_probe.c
        src/kernel.c
        src/kernel_mem.c
        src/kernel_res.c
        src/kernel_res_borrow.c
        src/hdmi_screen.c
        src/dvi_screen.c
        src/pio_dma_bench.c   # 第 19 轮临时诊断：PIO+DMA 最小对照基准（定位完删除）
        #psram_test.c
        )

target_compile_definitions(SPI_PICO_TEST PRIVATE
    PICO_AUTO_DETECT_PSRAM=0          # 自动检测 PSRAM
    PICO_PSRAM_CS_PIN=47               # 你的板子的 CS 引脚（根据实际调整）
)
target_compile_definitions(SPI_PICO_TEST PRIVATE
    PICO_SDIO_GPIO_BASE_16=1   # 启用基址 16
    # 追踪 SDIO 卡死点：USE_DBG_PRINTF 让库调用调试输出，
    # USE_PRINTF 才提供真正 printf 到串口（并 flush）的实现。
    # 只开前者无效 —— 默认实现是空函数。
    USE_DBG_PRINTF=1
    USE_PRINTF=1
)

pico_set_program_name(SPI_PICO_TEST "SPI_PICO_TEST")
pico_set_program_version(SPI_PICO_TEST "0.1")

# Generate PIO header
pico_generate_pio_header(SPI_PICO_TEST ${CMAKE_CURRENT_LIST_DIR}/src/blink.pio)

# Modify the below lines to enable/disable output over UART/USB
pico_enable_stdio_uart(SPI_PICO_TEST 1)
pico_enable_stdio_usb(SPI_PICO_TEST 1)

# Add the standard library to the build
target_link_libraries(SPI_PICO_TEST
        pico_stdlib
        hardware_psram)

# Add the standard include files to the build
target_include_directories(SPI_PICO_TEST PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}
)


# Use runtime video mode switching API
set(PICO_HDMI_RUNTIME_MODES ON CACHE BOOL "" FORCE)

# ============================================================================
# HDMI 输出：frank-hdmi-sound（PIO bitbang DVI + HDMI 数据岛音频）
# ============================================================================
#
# 为什么是这个库、而不是 pico_hdmi（HSTX）或微雪自带的 libdvi：
#
#   1) 微雪 RP2350-PiZero 的 DVI 座接在 GPIO32..39，而 RP2350 的 HSTX
#      在硅片上【硬连】GPIO12..19（SDK 的 io_bank0.h 覆盖 GPIO0..47，
#      其中带 FUNCSEL_VALUE_HSTX 的只有 GPIO12..19），所以 HSTX 走不通，
#      只能用 PIO。微雪官方 demo 也写明基于 Wren6991/PicoDVI —— PIO 方案。
#
#   2) 原版 PicoDVI / 微雪 libdvi 只发 DVI，不含 HDMI 音频数据岛。
#      本项目需要音频（屏幕带 3.5mm 输出），所以用 frank-hdmi-sound，
#      它在 libdvi 基础上加了 HDMI data-island 音频。
#
# 引脚与微雪 demo 的 pico_sock_cfg 一致：
#       pico_sock_cfg: pins_tmds={36,34,32}, pins_clk=38,
#                      invert_diffpairs=false
# 对应到本库的命名：D0 = 36/37、D1 = 34/35、D2 = 32/33、CLK = 38/39。
#
# 时钟：DVI_SM_CLKDIV = 1，即 CPU = TMDS 位时钟 = 252MHz，
# 正好是 640x480p60 所需的位时钟，不需要任何倍频。
# 因此 dvi_screen.c 里是 set_sys_clock_khz(252000) + vreg 1.25V。
#
# ⚠️ 不要照抄库 README 的 "504MHz 推荐值"。实测 504MHz + 1.2V 在本板上
# 会让 Core1 进 HardFault、Core0 卡到连 SWD 都 halt 不住（要靠 RP2350
# 救援位 + 断电才恢复）。252MHz 是微雪官方 demo 用的值，稳定。
set(FRANK_HDMI_SM_CLKDIV "1" CACHE STRING "" FORCE)

# ── 微雪 RP2350-PiZero 的 DVI 引脚（GPIO 32..39）───────────────
#
# ⚠️ 必须用 target_compile_definitions，不能用 set() 缓存变量！
#
# 踩过的坑：原来写的是
#     set(FRANK_HDMI_PIN_CLK 38 CACHE STRING "" FORCE)
# 看着没错，但库的 src/CMakeLists.txt 只把 DVI_SM_CLKDIV 和
# DVI_N_TMDS_BUFFERS 变成了编译定义，从不读 FRANK_HDMI_PIN_*。
# 于是这几个宏压根没进编译命令行，frank_hdmi.h 里"未定义就用默认值"
# 的分支生效 —— 引脚一直是默认 GPIO 12/14/16/18，
# 而本板实际接在 GPIO 32..39，结果屏幕完全无信号。
#
# 教训：设了变量 ≠ 传给了编译器。改完一定要去
# build/compile_commands.json 里确认宏真的出现在命令行上。

# 引脚映射（与微雪官方 demo 的 pico_sock_cfg 一致）：
#     GPIO32/33 = D2 P/N, 34/35 = D1 P/N,
#     GPIO36/37 = D0 P/N, 38/39 = CLK P/N
add_subdirectory(third_party/frank-hdmi-sound)

target_compile_definitions(SPI_PICO_TEST PRIVATE
    FRANK_HDMI_PIN_CLK=38
    FRANK_HDMI_PIN_D0=36
    FRANK_HDMI_PIN_D1=34
    FRANK_HDMI_PIN_D2=32

    # ⚠️ 差分对极性：微雪这块板是 false，而库的默认值是 true。
    #
    # 库源码里写得很清楚：默认 true 是给 FRANK / MURMULATOR-2 板用的
    #   "the libdvi PIO + this board's PCB wiring give the spec-correct
    #    differential output only when the GPIO override inverter is enabled"
    # 而微雪官方 demo 的 pico_sock_cfg 明确是 .invert_diffpairs = false。
    #
    # 极性反了，TMDS 的 P/N 两极就颠倒 —— 表现为引擎产帧正常、像素时钟
    # 正常、引脚映射也全对，但屏幕完全收不到信号。属于最难查的一类问题。
    FRANK_HDMI_INVERT_DIFFPAIRS=1
)

add_subdirectory(third_party/no-OS-FatFS-SD-SDIO-SPI-RPi-Pico-main/src)
add_subdirectory(third_party/ILI9488_Pico)
add_subdirectory(third_party/pico_hdmi-0.0.7)

# Add any user requested libraries
target_link_libraries(SPI_PICO_TEST 
        pico_rand
        hardware_spi
        hardware_i2c
        hardware_dma
        hardware_pio
        hardware_interp
        hardware_timer
        hardware_watchdog
        hardware_clocks
        no-OS-FatFS-SD-SDIO-SPI-RPi-Pico
        ili9488_modern_driver # Provide from ILI9488_Pico
        font_system           # Provide from ILI9488_Pico
        pico_hdmi
        frank_hdmi_sound
        pico_multicore
        hardware_irq
        )

pico_add_extra_outputs(SPI_PICO_TEST)

# ============================================================================
# 最小 DVI 验证固件（调试用，独立目标）
# ============================================================================
#
# 目的：把"屏幕不出图"的可能性一刀切开 —— 这个目标【只】初始化 DVI，
# 不含 SDIO / FatFS / PSRAM / 系统调用 / pico_hdmi，用来判断
# 到底是别的子系统干扰了 DVI，还是 DVI 本身/时钟/硬件的问题。
#
# 构建：ninja -C build dvi_min
# 产物：build/dvi_min.elf
add_executable(dvi_min
        src/dvi_min.c
        )

target_compile_definitions(dvi_min PRIVATE
    FRANK_HDMI_PIN_CLK=38
    FRANK_HDMI_PIN_D0=36
    FRANK_HDMI_PIN_D1=34
    FRANK_HDMI_PIN_D2=32
    FRANK_HDMI_INVERT_DIFFPAIRS=1
)

target_link_libraries(dvi_min
    pico_stdlib
    pico_multicore
    frank_hdmi_sound
)

pico_enable_stdio_uart(dvi_min 1)
pico_enable_stdio_usb(dvi_min 1)
pico_add_extra_outputs(dvi_min)


# ============================================================================
# 源码已整理进 src/，把它加进包含路径，
# 这样 src 里的 #include "kernel.h" 之类仍然有效。
# ============================================================================
target_include_directories(SPI_PICO_TEST PRIVATE "${CMAKE_CURRENT_LIST_DIR}/src")


# ============================================================================
# 空固件：什么都不做 —— 用于把板子恢复成安静状态
# ============================================================================
add_executable(empty src/empty.c)
pico_set_program_name(empty "empty")
pico_set_program_version(empty "0.1")
pico_enable_stdio_uart(empty 0)
pico_enable_stdio_usb(empty 0)
target_link_libraries(empty pico_stdlib)
pico_add_extra_outputs(empty)

# ============================================================================
# TMDS 采样探针（独立固件，用于【测量】PicoPhone 的 DVI 输出波形）
#   与主固件完全无关，只依赖 pico_stdlib + PIO + DMA。
#   引脚基址/采样时钟由下方定义控制；接法见 sampler/sampler.c 顶部注释。
# ============================================================================
add_executable(sampler sampler/sampler.c)
pico_generate_pio_header(sampler ${CMAKE_CURRENT_LIST_DIR}/sampler/sampler.pio)
pico_enable_stdio_usb(sampler 1)
pico_enable_stdio_uart(sampler 0)
target_compile_definitions(sampler PRIVATE
    SAMPLER_PIN_BASE=8       # 8 根线接在 GPIO 32..39（按你的接线改）
    SAMPLER_CLK_KHZ=252000    # 采样时钟 = 时间分辨率
)
target_link_libraries(sampler
    pico_stdlib
    hardware_pio
    hardware_dma
    hardware_clocks
    hardware_vreg)
pico_add_extra_outputs(sampler)

# ============================================================================
# 引脚连通性测试固件（焊接后查连锡，避免带短路接信号上电）
#   不需要接任何外部信号：只检查 GPIO 8..15 之间/对 GND/对 3V3 是否相通
# ============================================================================
add_executable(pin_test src/pin_test.c)
pico_set_program_name(pin_test "pin_test")
pico_set_program_version(pin_test "0.1")
pico_enable_stdio_usb(pin_test 1)
pico_enable_stdio_uart(pin_test 1)
target_compile_definitions(pin_test PRIVATE
    PIN_TEST_BASE=8        # 被测引脚起始 GPIO（按你的引出脚改）
    PIN_TEST_COUNT=8       # 被测引脚个数
)
target_link_libraries(pin_test pico_stdlib)
pico_add_extra_outputs(pin_test)
