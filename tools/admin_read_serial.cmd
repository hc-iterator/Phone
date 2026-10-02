@echo off
REM ============================================================================
REM  tools\admin_read_serial.cmd - reset the RP2350 USB node, then read its
REM  serial output -- both from an elevated context.
REM
REM  RUN AS ADMINISTRATOR.
REM
REM  Why combined: reset_usb_port.cmd alone cycles the device but never opens
REM  the port, and a plain (non-elevated) reader is refused with
REM  PermissionError(13). Doing both from one elevated shell gives the read the
REM  best chance of acquiring the port.
REM
REM  Writes nothing except serial_output.txt in the repo root.
REM ============================================================================

setlocal enabledelayedexpansion

net session >nul 2>&1
if errorlevel 1 (
    echo ERROR: run this as Administrator.
    pause
    exit /b 1
)

cd /d "%~dp0.."
set "PNPUTIL=%SystemRoot%\System32\pnputil.exe"
set "OUT=serial_output.txt"
set "TMPFILE=%TEMP%\rp2350_devs.txt"

echo ==== 1. Cycling Raspberry Pi USB serial devices ====
"%PNPUTIL%" /enum-devices /class Ports > "%TMPFILE%" 2>&1
for /f "tokens=1,* delims=:" %%A in ('findstr /I "Instance ID" "%TMPFILE%"') do (
    set "LINE=%%B"
    set "LINE=!LINE: =!"
    echo !LINE! | findstr /I "VID_2E8A" >nul
    if not errorlevel 1 (
        echo   removing !LINE!
        "%PNPUTIL%" /remove-device "!LINE!" >nul 2>&1
    )
)
"%PNPUTIL%" /scan-devices >nul 2>&1
echo   rescan issued; waiting for re-enumeration
timeout /t 8 /nobreak >nul
del "%TMPFILE%" >nul 2>&1

echo.
echo ==== 2. Ports after rescan ====
"%PNPUTIL%" /enum-devices /class Ports | findstr /I "VID_2E8A"

echo.
echo ==== 3. Reading serial for 25 s ====
set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY ( where python >nul 2>&1 && set "PY=python" )
if not defined PY (
    echo   No python interpreter found; cannot read.
    pause
    exit /b 1
)
%PY% "%~dp0read_serial.py" COM28 25 > "%OUT%" 2>&1
echo   exit code %ERRORLEVEL%
echo.
echo ==== Output captured in %OUT% ====
type "%OUT%"
echo.
pause
