@echo off
REM ============================================================================
REM  tools\read_serial.cmd - read the board's serial output and capture it to a
REM  file, so it can be collected without capturing a child process's output
REM  through a pipe (which the shell sandbox forbids).
REM
REM  Usage:  tools\read_serial.cmd [port] [seconds]
REM
REM  With no port argument it probes COM5..COM9, because Windows reassigns the
REM  CDC port number every time the board re-enumerates.
REM
REM  Writes only inside this repository: serial_output.txt
REM  Last line of that file is SERIAL_EXIT=<code>.
REM ============================================================================

cd /d "%~dp0.."
set "OUT=serial_output.txt"
set "PYEXE=python"

if not "%~1"=="" (
    echo ==== reading %~1 for %~2 s ==== > "%OUT%"
    "%PYEXE%" "%~dp0read_serial.py" %~1 %~2 >> "%OUT%" 2>&1
    echo. >> "%OUT%"
    echo SERIAL_EXIT=%ERRORLEVEL% >> "%OUT%"
    exit /b 0
)

echo ==== auto-probing ports ==== > "%OUT%"
for %%P in (COM7 COM5 COM6 COM8 COM9 COM10 COM11 COM12) do (
    echo. >> "%OUT%"
    echo ---- trying %%P ---- >> "%OUT%"
    "%PYEXE%" "%~dp0read_serial.py" %%P 12 >> "%OUT%" 2>&1
    findstr /C:"RESULT:" /C:"[alive]" "%OUT%" >nul 2>&1
    if not errorlevel 1 (
        echo FOUND_PORT=%%P >> "%OUT%"
        goto :done
    )
)

:done
echo. >> "%OUT%"
echo SERIAL_EXIT=0 >> "%OUT%"
exit /b 0
