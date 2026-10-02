@echo off
REM ============================================================
REM  tools\host_test\build.cmd
REM
REM  Build and run the kernel self-tests on the PC (host side).
REM
REM  Why: the board is often unreachable (probe dead, SWD down,
REM  USB not enumerating), and "wrote code but never verified it"
REM  is the exact failure this project keeps trying to avoid.
REM  The parts that do NOT need hardware can run right here.
REM
REM  NOTE: the verdict is a HOST-SIDE verdict.  It verifies logic,
REM  not hardware behaviour.  DMA/PIO/PSRAM still need the board.
REM
REM  IMPORTANT: keep this file pure ASCII.  cmd.exe reads .cmd with
REM  the OEM code page, so UTF-8 Chinese comments get mangled and
REM  can split the command line apart.  (Paid for once already.)
REM
REM  IMPORTANT: do NOT hardcode the Visual Studio edition.  It was
REM  once written as ...\2022\Professional\... and that silently
REM  disabled the whole host-test path on a machine with Community
REM  installed (cuotiben-gongju 16).  Probe the known editions, then
REM  fall back to vswhere.
REM ============================================================
setlocal
cd /d "%~dp0"

REM -- locate vcvars64.bat: known editions first, then vswhere ------
REM    Tried in this order so the common single-install case needs
REM    no external tool at all.
set "VCVARS="
if not defined VCVARS call :try "%ProgramFiles%\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS call :try "%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS call :try "%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS call :try "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS call :try "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS call :try "%ProgramFiles%\Microsoft Visual Studio\2019\Professional\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS call :try "%ProgramFiles%\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS call :try "%ProgramFiles(x86)%\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if not defined VCVARS (
    set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
    if exist "%VSWHERE%" (
        for /f "usebackq tokens=*" %%I in (`"%VSWHERE%" -latest -products * -property installationPath`) do (
            if not defined VCVARS call :try "%%I\VC\Auxiliary\Build\vcvars64.bat"
        )
    )
)
if not defined VCVARS goto :novc
goto :havevc

:try
if exist %1 set "VCVARS=%~1"
goto :eof

:havevc

call "%VCVARS%" >nul 2>&1
if errorlevel 1 goto :novc

set "OUT=..\..\debug_logs\host_test"
if not exist "%OUT%" mkdir "%OUT%"

echo [host_test] compiling...
cl /nologo /W3 /utf-8 /DPICO_RP2350=1 /I stub /I ..\..\src host_main.c stub.c ..\..\src\kernel_res.c ..\..\src\kernel_res_borrow.c /Fo:..\..\debug_logs\host_test\ /Fe:..\..\debug_logs\host_test\host_test.exe > ..\..\debug_logs\host_test\host_build_log.txt 2>&1
set RC=%ERRORLEVEL%
if not "%RC%"=="0" goto :buildfail

echo [host_test] build ok, running
echo.
..\..\debug_logs\host_test\host_test.exe
set "RUNRC=%ERRORLEVEL%"
echo.
echo HOST_RUN_EXIT=%RUNRC%
echo HOST_BUILD_EXIT=0
REM The test's own exit code MUST propagate - otherwise a failing
REM self-test is reported as success.  (A stray "echo" would reset
REM ERRORLEVEL to 0, which is exactly how this was silently broken
REM before - cuotiben-gongju 13/14: silent success.)
exit /b %RUNRC%

:buildfail
echo [host_test] BUILD FAILED rc=%RC%
type ..\..\debug_logs\host_test\host_build_log.txt
echo HOST_BUILD_EXIT=%RC%
exit /b %RC%

:novc
echo [host_test] cannot set up MSVC - no vcvars64.bat found.
echo [host_test] tried the 2022/2019 edition paths, then vswhere.
echo [host_test] install "Desktop development with C++" or set VCVARS manually.
echo HOST_BUILD_EXIT=1
exit /b 1
