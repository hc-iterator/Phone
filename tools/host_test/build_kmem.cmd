@echo off
REM ============================================================
REM  tools\host_test\build_kmem.cmd
REM
REM  Build and run the KERNEL MEMORY MANAGER self-test on the PC.
REM
REM  Why a second script: stub.c stubs kernel_mem out entirely (it
REM  defines fake kmem_alloc/kmem_free so the kres tests can link),
REM  so kernel_mem.c itself can never be in the same binary.
REM  This target links the REAL kernel_mem.c instead.
REM
REM  NOTE: the verdict is a HOST-SIDE verdict.  It verifies logic,
REM  not hardware behaviour.  PSRAM/DMA/PIO still need the board.
REM
REM  IMPORTANT: keep this file pure ASCII (cuotiben-gongju 14).
REM  IMPORTANT: do NOT hardcode the Visual Studio edition
REM  (cuotiben-gongju 16) - probe the known editions, then vswhere.
REM ============================================================
setlocal
cd /d "%~dp0"

REM -- locate vcvars64.bat: known editions first, then vswhere ------
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

echo [host_kmem] compiling...
cl /nologo /W3 /utf-8 /DPICO_RP2350=1 /I stub /I ..\..\src host_kmem_main.c ..\..\src\kernel_mem.c /Fo:..\..\debug_logs\host_test\ /Fe:..\..\debug_logs\host_test\host_kmem.exe > ..\..\debug_logs\host_test\host_kmem_build_log.txt 2>&1
set RC=%ERRORLEVEL%
if not "%RC%"=="0" goto :buildfail

echo [host_kmem] build ok, running
echo.
..\..\debug_logs\host_test\host_kmem.exe
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
echo [host_kmem] BUILD FAILED rc=%RC%
type ..\..\debug_logs\host_test\host_kmem_build_log.txt
echo HOST_BUILD_EXIT=%RC%
exit /b %RC%

:novc
echo [host_kmem] cannot set up MSVC - no vcvars64.bat found.
echo [host_kmem] tried the 2022/2019 edition paths, then vswhere.
echo HOST_BUILD_EXIT=1
exit /b 1
