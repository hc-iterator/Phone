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
set(sdkVersion 2.2.0)
set(toolchainVersion 14_2_Rel1)
set(picotoolVersion 2.2.0-a4)
set(picoVscode ${USERHOME}/.pico-sdk/cmake/pico-vscode.cmake)
if (EXISTS ${picoVscode})
    include(${picoVscode})
endif()
# ====================================================================================
set(PICO_BOARD pico CACHE STRING "Board type")

# Pull in Raspberry Pi Pico SDK (must be before project)
include(pico_sdk_import.cmake)

project(SPI_PICO_TEST C CXX ASM)

set(PICO_CXX_ENABLE_EXCEPTIONS 1)

set(PICO_CXX_ENABLE_RTTI 1)

# Initialise the Raspberry Pi Pico SDK
pico_sdk_init()

# Add executable. Default name is the project name, version 0.1

add_executable(SPI_PICO_TEST SPI_PICO_TEST.cpp )

pico_set_program_name(SPI_PICO_TEST "SPI_PICO_TEST")
pico_set_program_version(SPI_PICO_TEST "0.1")

# Generate PIO header
pico_generate_pio_header(SPI_PICO_TEST ${CMAKE_CURRENT_LIST_DIR}/blink.pio)

# Modify the below lines to enable/disable output over UART/USB
pico_enable_stdio_uart(SPI_PICO_TEST 1)
pico_enable_stdio_usb(SPI_PICO_TEST 1)

# Add the standard library to the build
target_link_libraries(SPI_PICO_TEST
        pico_stdlib)

# Add the standard include files to the build
target_include_directories(SPI_PICO_TEST PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}
)

add_subdirectory(no-OS-FatFS-SD-SPI-RPi-Pico-1.0.8/FatFs_SPI)

# Add any user requested libraries
target_link_libraries(SPI_PICO_TEST 
        hardware_spi
        hardware_i2c
        hardware_dma
        hardware_pio
        hardware_interp
        hardware_timer
        hardware_watchdog
        hardware_clocks
        ILI9488_Pico
        FatFs_SPI
        )

add_subdirectory(ILI9488_Pico)
target_link_libraries(SPI_PICO_TEST ili9488_modern_driver)
 
pico_add_extra_outputs(SPI_PICO_TEST)

