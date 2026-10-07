@echo off
REM ⚠️ 这是【不运行的副本】：pico_* 工具执行的是 C:\Users\Chen\Desktop\Pico\_picophone_trust\runtime\ 下的同名文件（由 pico_amend/审批同步）。

REM ============================================================
REM  tools\host_test\run_all.cmd
REM
REM  ONE entry point for every host-side (PC) kernel self-test.
REM
REM  Why: there are several host targets now (kres ledger, borrow
REM  scheduler, kmem buddy allocator) and each has its own build
REM  script.  Running them one by one is easy to get wrong - you
REM  forget one and then believe "everything passes".
REM  This script runs them all and prints a single verdict.
REM
REM  Usage:   tools\host_test\run_all.cmd
REM
REM  IMPORTANT: the verdict is a HOST-SIDE verdict.  It proves the
REM  LOGIC compiles and behaves, NOT that the board works.
REM  Hardware behaviour (PSRAM/DMA/PIO/MPU) still needs the board.
REM  Read the top of the guide book: nothing has been on hardware
REM  since 65cf367 (2026-09-28), and the SWD link is physically down.
REM
REM  IMPORTANT: keep this file pure ASCII.  cmd.exe reads .cmd with
REM  the OEM code page.  (a) UTF-8 non-ASCII text gets mangled and
REM  can split the command line apart while still printing a FAKE
REM  success; (b) a bare "!" is EATEN by enabledelayedexpansion.
REM  Both bit this project already - cuotiben-gongju 14.
REM  So: English labels only, and no "!" anywhere in echoed text.
REM  IMPORTANT: do NOT hardcode a Visual Studio edition
REM  (cuotiben-gongju 16) - the sub-scripts probe for it instead.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist "..\..\debug_logs\host_test" mkdir "..\..\debug_logs\host_test"

set FAILED=0
set SUMMARY=

echo ============================================================
echo  Host-side kernel self-tests
echo  (verdict is HOST-SIDE only - the board is not involved)
echo ============================================================
echo.

REM -- 1) kres ledger + borrow scheduler -------------------------
call :run "kres ledger + borrow scheduler" build.cmd kres

REM -- 2) kmem buddy allocator -----------------------------------
call :run "kmem buddy allocator" build_kmem.cmd kmem

echo ============================================================
if "%FAILED%"=="0" (
    echo  RESULT: ALL HOST TESTS PASSED
) else (
    echo  RESULT: !FAILED! TARGET^(S^) FAILED
    echo  FAILED:!SUMMARY!
)
echo ============================================================
echo.
echo Remember: a host-side pass does NOT mean it works on the board.
exit /b %FAILED%

REM ------------------------------------------------------------
:run
REM %1 = label, %2 = build script, %3 = short log tag
set "TAGLOG=..\..\debug_logs\host_test\run_%~3.txt"
echo ---- %~1 ----
call "%~2" > "%TAGLOG%" 2>&1
set "RC=!ERRORLEVEL!"
if not "!RC!"=="0" (
    set /a FAILED+=1
    set "SUMMARY=!SUMMARY! %~1"
)
echo   exit=!RC!
findstr /B /C:"HOST_BUILD_EXIT=" /C:"HOST_RUN_EXIT=" "%TAGLOG%"
echo.
goto :eof
