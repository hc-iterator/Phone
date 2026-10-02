@echo off
REM ============================================================================
REM  read_psram.cmd - double-click this to read the board's serial output.
REM
REM  Double-clicking runs it in your own console, so nothing can kill it
REM  mid-read. That matters: a reader killed while a serial read is pending
REM  leaves the port locked at the kernel level, and no process can free it.
REM
REM  It lists the available ports first, then tries each candidate that is not
REM  COM1/COM29 (which are the motherboard and Bluetooth ports).
REM ============================================================================

cd /d "%~dp0"

echo ============================================
echo  Available serial ports
echo ============================================
python -c "import serial.tools.list_ports as lp; [print('   ', p.device, '-', p.description) for p in lp.comports()]"
echo.

echo ============================================
echo  Reading board output (15 s per port)
echo ============================================
for %%P in (COM7 COM5 COM6 COM8 COM9 COM10 COM11 COM12 COM13) do (
    echo.
    echo ---- trying %%P ----
    python tools\read_serial.py %%P 15
    if not errorlevel 1 goto :done
)

:done
echo.
echo ============================================
echo  Done. Copy the PSRAM block above if it appeared.
echo ============================================
pause
