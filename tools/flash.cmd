@echo off
REM ============================================================================
REM  tools\flash.cmd - write build\SPI_PICO_TEST.uf2 to the board
REM
REM  Requires the board to be in BOOTSEL mode (hold BOOTSEL while plugging in
REM  USB). picotool's -f auto-reboot does NOT work while the firmware is parked
REM  in the blocking wait_for_usb_host() loop, so this is manual by design.
REM
REM  Writes only inside this repository: flash_log.txt
REM  Last line is FLASH_EXIT=<code>.
REM ============================================================================

cd /d "%~dp0.."

set "PICOTOOL=%USERPROFILE%\.pico-sdk\picotool\2.3.0\picotool\picotool.exe"
set "UF2=build\SPI_PICO_TEST.uf2"
if not exist debug_logs mkdir debug_logs
set "LOG=debug_logs\flash_log.txt"

if not exist "%PICOTOOL%" ( echo ERROR: picotool not found > "%LOG%" & echo FLASH_EXIT=1 >> "%LOG%" & exit /b 1 )
if not exist "%UF2%" ( echo ERROR: %UF2% not found - run tools\build.cmd first > "%LOG%" & echo FLASH_EXIT=1 >> "%LOG%" & exit /b 1 )

echo ==== picotool load ==== > "%LOG%"
"%PICOTOOL%" load "%UF2%" >> "%LOG%" 2>&1
set LD=%ERRORLEVEL%

echo. >> "%LOG%"
echo ==== picotool reboot ==== >> "%LOG%"
"%PICOTOOL%" reboot >> "%LOG%" 2>&1
set RB=%ERRORLEVEL%

echo. >> "%LOG%"
echo LOAD_EXIT=%LD% >> "%LOG%"
echo REBOOT_EXIT=%RB% >> "%LOG%"
echo FLASH_EXIT=%LD% >> "%LOG%"

if not "%LD%"=="0" exit /b %LD%
exit /b 0
