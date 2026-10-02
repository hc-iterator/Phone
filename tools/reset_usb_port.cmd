@echo off
REM ============================================================================
REM  tools\reset_usb_port.cmd - free a wedged RP2350 USB CDC port
REM
REM  RUN THIS AS ADMINISTRATOR. pnputil refuses /remove-device without elevation.
REM
REM  Why this is needed: if a process reading the board's serial port is killed
REM  while a read is pending, Windows keeps the port's kernel file object alive
REM  until that I/O completes. The process becomes unkillable and the port stays
REM  exclusively held, so nothing (not even PuTTY) can reopen it. Removing and
REM  rescanning the device forces the stack to tear down and re-enumerate it.
REM
REM  This does NOT touch the board's flash or the project. It only cycles the
REM  USB device node for Raspberry Pi VID 2E8A.
REM ============================================================================

setlocal enabledelayedexpansion

net session >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: this script must be run as Administrator.
    echo Right-click it and choose "Run as administrator".
    echo.
    pause
    exit /b 1
)

set "PNPUTIL=%SystemRoot%\System32\pnputil.exe"
set "TMPFILE=%TEMP%\rp2350_devices.txt"

echo ==== 1. Enumerating Raspberry Pi (VID_2E8A) serial devices ====
"%PNPUTIL%" /enum-devices /class Ports > "%TMPFILE%" 2>&1

set FOUND=0
for /f "tokens=1,* delims=:" %%A in ('findstr /I "Instance ID" "%TMPFILE%"') do (
    set "LINE=%%B"
    set "LINE=!LINE: =!"
    echo !LINE! | findstr /I "VID_2E8A" >nul
    if not errorlevel 1 (
        echo   Found: !LINE!
        echo   Removing...
        "%PNPUTIL%" /remove-device "!LINE!"
        set /a FOUND+=1
    )
)

if "%FOUND%"=="0" (
    echo   No RP2350 USB serial device found. Is the board plugged in?
)

echo.
echo ==== 2. Rescanning for hardware ====
"%PNPUTIL%" /scan-devices

echo.
echo ==== 3. Ports now present ====
"%PNPUTIL%" /enum-devices /class Ports | findstr /I "VID_2E8A"
mode | findstr /I "COM"

del "%TMPFILE%" >nul 2>&1
echo.
echo Done. The board should re-enumerate within a few seconds.
pause
