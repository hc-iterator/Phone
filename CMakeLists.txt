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
set(toolchainVersion 15_2_Rel1)
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

project(PicoPhone C CXX ASM)

set(PICO_CXX_ENABLE_EXCEPTIONS 1)

set(PICO_CXX_ENABLE_RTTI 1)

# Initialise the Raspberry Pi Pico SDK
pico_sdk_init()

# ★ 2026-10-10 修复：USB stdio 写超时 500ms → 2ms（治"app 被 printf 拖死、DVI 引擎饿死"）
# 实测（SWD 计数器，串口被占也能取证 ✓）：Core0 主循环 3 分钟只跑 150 圈（≈0.8 圈/秒）✗、
#   生产者只出 1062 行 ✗、引擎看门狗重启 1 次 ✗ ⇒ 屏幕蓝白闪。
# 根因（SDK 源码定死 ✓）：stdio_usb.c:122 每次写会一直等主机把数据取走，上限 =
#   PICO_STDIO_USB_STDOUT_TIMEOUT_US（stdio_usb.h:33 默认 500000 µs = 500 ms）✗。
#   主机侧开着 COM 口却不取数据（经 USB Hub 尤其容易）⇒ 每次打印阻塞 0.5 s ⇒ 与 0.8 圈/秒吻合 ✓。
# ⚠️ 这里【故意】只改 pico_stdio_usb 一个库：
#   · 宏是在 SDK 自己的 stdio_usb.c 里用的，所以要能影响"sdk 库的编译"，而不是我们的源文件 ✓
#   · 但绝不能用 add_compile_definitions 走全局 ✗ —— 那会把 500+ 个对象全部作废，
#     包括 third_party/ILI9488_Pico 里那些对象路径超过 Windows 260 字符上限的目标 ✗
#     （实测：编译报 opening dependency file ... .obj.d: No such file or directory），
#     结果整个工程再也编不出来 ✓（2026-10-10 为此卡了一个小时 ✗）。
#   · 关键（读 SDK 源码确认 ✓）：pico_stdio_usb 是个 INTERFACE 库，它把
#     stdio_usb.c / stdio_usb_descriptors.c 用 target_sources(... INTERFACE ...) 挂出来，
#     ⇒ 这些源文件是【跟着使用者目标一起编译】的 ✓ ⇒ 给 PicoPhone 加私有宏就能命中它们 ✓
#   · 但绝不能走 add_compile_definitions 全局 ✗ —— 那会把 500+ 个对象（含 third_party/ILI9488_Pico
#     里对象路径超过 Windows 260 字符上限的目标）全部作废，实测报 "opening dependency file ... .obj.d:
#     No such file or directory"，整个工程再也编不出来 ✓（2026-10-10 为此卡了一个多小时 ✗）。
# （本宏的 target_compile_definitions 必须放在 add_executable 之后 —— 目标得先存在 ✓）
# 见下方 add_executable(PicoPhone) 之后的那一行 ✓

# Add executable. Default name is the project name, version 0.1

add_executable(PicoPhone 
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

# ★ 2026-10-10：USB stdio 写超时 500ms → 2ms（长注释见本文件上方 project() 之后）
#     它治的是"printf 阻塞 0.5 s ⇒ Core0 主循环只有 0.8 圈/秒 ⇒ DVI 引擎饿死 ⇒ 蓝白闪" ✗
target_compile_definitions(PicoPhone PRIVATE PICO_STDIO_USB_STDOUT_TIMEOUT_US=2000)

target_compile_definitions(PicoPhone PRIVATE
    PICO_AUTO_DETECT_PSRAM=0          # 自动检测 PSRAM
    PICO_PSRAM_CS_PIN=47               # 你的板子的 CS 引脚（根据实际调整）
)
target_compile_definitions(PicoPhone PRIVATE
    PICO_SDIO_GPIO_BASE_16=1   # 启用基址 16
    # 追踪 SDIO 卡死点：USE_DBG_PRINTF 让库调用调试输出，
    # USE_PRINTF 才提供真正 printf 到串口（并 flush）的实现。
    # 只开前者无效 —— 默认实现是空函数。
    USE_DBG_PRINTF=1
    USE_PRINTF=1
)

pico_set_program_name(PicoPhone "PicoPhone")
pico_set_program_version(PicoPhone "0.1")

# Generate PIO header
pico_generate_pio_header(PicoPhone ${CMAKE_CURRENT_LIST_DIR}/src/blink.pio)

# Modify the below lines to enable/disable output over UART/USB
pico_enable_stdio_uart(PicoPhone 1)
pico_enable_stdio_usb(PicoPhone 1)

# Add the standard library to the build
target_link_libraries(PicoPhone
        pico_stdlib
        hardware_psram)

# Add the standard include files to the build
target_include_directories(PicoPhone PRIVATE
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

target_compile_definitions(PicoPhone PRIVATE
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
# ★ HSTX 分频：本板用 252 MHz 系统时钟（项目实测过的稳定档），必须 div2 才能保持
#   25.2 MHz 像素时钟（库默认 126MHz/div1 产出同一像素时钟）。这个宏在【库】里生效，
#   所以必须设在 add_subdirectory 之前。
set(PICO_HDMI_HSTX_CLK_DIV "2" CACHE STRING "Override MODE_HSTX_CLK_DIV; empty keeps mode default" FORCE)
add_subdirectory(third_party/pico_hdmi-0.0.7)

# Add any user requested libraries
target_link_libraries(PicoPhone 
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

pico_add_extra_outputs(PicoPhone)

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
target_include_directories(PicoPhone PRIVATE "${CMAKE_CURRENT_LIST_DIR}/src")


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
# 纯后门固件：USB CDC 活着 + 后门活着，别的什么都不干（"中转固件"）
#   ⚠️ 与 empty 的区别（2026-10-06 实测确认）：
#      empty 的 stdio 是 0/0 ⇒ 烧上去后【没有 COM 口、也没有后门】，
#      只能手按 BOOTSEL 救回 ✗ —— 它不能当中转固件。
#      本目标才是"能靠自己的后门走回来"的中间态 ✓。
#   构建：ninja -C build backdoor_only     产物：build/backdoor_only.uf2
# ============================================================================
add_executable(backdoor_only src/backdoor_only.c)
pico_set_program_name(backdoor_only "backdoor_only")
pico_set_program_version(backdoor_only "0.1")
pico_enable_stdio_uart(backdoor_only 1)
pico_enable_stdio_usb(backdoor_only 1)
target_link_libraries(backdoor_only pico_stdlib)
pico_add_extra_outputs(backdoor_only)

# ============================================================================
# 纯后门固件的【超频变体】：同一份安静固件，只换主频（2026-10-07 用户指定）
#   用途：与 backdoor_only 做**对照实验** —— 同一块板、同样"什么都不干"的固件，
#         唯一变量是主频 ⇒ 才能判定「SWD 通不通」与主频到底有没有关系 ✓
#   档位：vreg 1.25V + 252000 kHz —— **照抄项目实测过的档**（dvi_min 正在跑的那档 ✓），
#         不发明没试过的频率 ✗（docs\开工前自检.md §三.2）
#   构建：ninja -C build backdoor_only_oc     产物：build/backdoor_only_oc.uf2
# ============================================================================
add_executable(backdoor_only_oc src/backdoor_only.c)
pico_set_program_name(backdoor_only_oc "backdoor_only_oc")
pico_set_program_version(backdoor_only_oc "0.1")
pico_enable_stdio_uart(backdoor_only_oc 1)
pico_enable_stdio_usb(backdoor_only_oc 1)
target_compile_definitions(backdoor_only_oc PRIVATE BACKDOOR_OC_KHZ=252000)
target_link_libraries(backdoor_only_oc pico_stdlib)
pico_add_extra_outputs(backdoor_only_oc)

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

# ============================================================================
# HSTX + PIO 复制 —— 最小验证固件（2026-10-12）
# ============================================================================
# 板载 HDMI 口在 GPIO32..39（不可改），HSTX 硬连 GPIO12..19（不可改）⇒
# HSTX 产生 TMDS，PIO 四个 SM 用单条 `mov pins, pins` 逐位同速复制到 32..39。
# 时钟成对成立：sys 252MHz + HSTX div2（本文件上方设的缓存变量）+ PIO clkdiv=1。
# 判据：烧上去后屏幕出 8 色竖条 ⇒ 方案成立。
# 产物：build/hstx_copy.uf2
add_executable(hstx_copy
        src/hstx_copy.c
        )
target_link_libraries(hstx_copy
        pico_stdlib
        pico_multicore
        hardware_pio
        hardware_clocks
        hardware_vreg
        pico_hdmi
        )
# 串口没人读时不要卡死 core0（根工程 PicoPhone 早就这么做了）
target_compile_definitions(hstx_copy PRIVATE PICO_STDIO_USB_STDOUT_TIMEOUT_US=2000)
pico_enable_stdio_usb(hstx_copy 1)
pico_enable_stdio_uart(hstx_copy 1)
pico_add_extra_outputs(hstx_copy)

# ----------------------------------------------------------------------------
# hstx_auto —— 同一个源文件的"自动出图"变体（屏幕验证专用）
#   上电等 10 秒，没收到串口命令就自己走 Y 路径出图 ⇒ 即使 USB CDC 不工作也能出画面。
#   产物：build/hstx_auto.uf2
# ----------------------------------------------------------------------------
add_executable(hstx_auto
        src/hstx_copy.c
        )
target_link_libraries(hstx_auto
        pico_stdlib
        pico_multicore
        hardware_pio
        hardware_clocks
        hardware_vreg
        pico_hdmi
        )
target_compile_definitions(hstx_auto PRIVATE
        PICO_STDIO_USB_STDOUT_TIMEOUT_US=2000
        HSTX_AUTOSTART_SEC=10
        )
pico_enable_stdio_usb(hstx_auto 1)
pico_enable_stdio_uart(hstx_auto 1)
pico_add_extra_outputs(hstx_auto)

# hstx_auto_inv —— 自动出图 + 取反极性（真屏黑屏时换这一张）
add_executable(hstx_auto_inv
        src/hstx_copy.c
        )
target_link_libraries(hstx_auto_inv
        pico_stdlib
        pico_multicore
        hardware_pio
        hardware_clocks
        hardware_vreg
        pico_hdmi
        )
target_compile_definitions(hstx_auto_inv PRIVATE
        PICO_STDIO_USB_STDOUT_TIMEOUT_US=2000
        HSTX_AUTOSTART_SEC=10
        HSTX_AUTOSTART_INVERT=1
        )
pico_enable_stdio_usb(hstx_auto_inv 1)
pico_enable_stdio_uart(hstx_auto_inv 1)
pico_add_extra_outputs(hstx_auto_inv)
