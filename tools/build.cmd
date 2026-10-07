@echo off
REM ⚠️ 这是【不运行的副本】：pico_* 工具执行的是 C:\Users\Chen\Desktop\Pico\_picophone_trust\runtime\ 下的同名文件（由 pico_amend/审批同步）。

REM ============================================================================
REM  tools\build.cmd - configure + build the PicoPhone firmware
REM
REM  Why this exists: the shell sandbox blocks capturing a child process's
REM  output through a pipe, so cmake/ninja cannot be run directly from the
REM  agent's PowerShell. Redirecting their output to a file inside the
REM  workspace and reading that file afterwards avoids the pipe entirely.
REM
REM  It writes only inside this repository:
REM     build\            (cmake + ninja output)
REM     debug_logs\build_log.txt  (captured stdout+stderr of both steps)
REM
REM  Read debug_logs\build_log.txt to see the result. Last line is BUILD_EXIT=<code>.
REM ============================================================================

cd /d "%~dp0.."

set "CMAKE=%USERPROFILE%\.pico-sdk\cmake\v3.31.5\bin\cmake.exe"
set "NINJA=%USERPROFILE%\.pico-sdk\ninja\v1.12.1\ninja.exe"
if not exist debug_logs mkdir debug_logs
set "LOG=debug_logs\build_log.txt"

if not exist "%CMAKE%" ( echo ERROR: cmake not found at %CMAKE% > "%LOG%" & echo BUILD_EXIT=1 >> "%LOG%" & exit /b 1 )
if not exist "%NINJA%" ( echo ERROR: ninja not found at %NINJA% > "%LOG%" & echo BUILD_EXIT=1 >> "%LOG%" & exit /b 1 )

echo ==== cmake configure ==== > "%LOG%"

REM  2026-10-05: stale-cache guard (ASCII only).
REM  Symptom hit for real: with an EXISTING build\CMakeCache.txt that records a
REM  different toolchain, cmake prints
REM    "You have changed variables that require your cache to be deleted"
REM  then re-runs configure FROM THE CACHE ONLY (command-line -D values are dropped),
REM  where CMAKE_MAKE_PROGRAM may point at an old/nonexistent ninja => configure fails with
REM    "CMake was unable to find a build program corresponding to Ninja".
REM  build_sub.ps1 already wipes stale caches; this file did not. Do the same here:
REM  if the cached toolchain is not the one declared below, wipe build and configure clean.
REM  NOTE: no parentheses and no nested if-blocks in this guard - cmd.exe parses the
REM  whole block first, so a paren inside an echo text closes the block early.
set "STALECACHE="
if exist "build\CMakeCache.txt" findstr /C:"toolchain/15_2_Rel1" "build\CMakeCache.txt" > nul 2>&1
if exist "build\CMakeCache.txt" if errorlevel 1 set "STALECACHE=1"
if defined STALECACHE echo ==== stale build cache: toolchain mismatch, wiping build folder ==== >> "%LOG%"
if defined STALECACHE rmdir /s /q build

REM  Explicitly pass CMAKE_MAKE_PROGRAM and the compilers.
REM  Trap we already hit: after deleting build\CMakeCache.txt, CMake reports
REM    "CMake was unable to find a build program corresponding to Ninja"
REM  because it no longer remembers ninja from the cache and ninja is not in PATH.
REM  Keep the command on ONE line: with ^ continuation, a trailing space at the
REM  end of a line breaks parsing.
REM  KEEP THIS FILE PURE ASCII.  cmd.exe reads .cmd with the OEM code page, so
REM  UTF-8 non-ASCII comments get mangled and can split the command line apart
REM  (this file had 210 non-ASCII bytes and worked only by luck - see cuotiben 14).
REM  Toolchain declaration. Must match toolchainVersion in CMakeLists.txt (15_2_Rel1).
REM  NOTE: the -DCMAKE_*_COMPILER paths below are only a fallback. CMakeLists.txt
REM  includes pico-vscode.cmake, which sets PICO_TOOLCHAIN_PATH from its
REM  toolchainVersion variable, and the SDK's find_compiler.cmake overwrites the
REM  environment/cache value with it (proved by a controlled test on 2026-10-05).
REM  To change the toolchain, change toolchainVersion in CMakeLists.txt first.
set "TOOLCHAIN=%USERPROFILE%\.pico-sdk\toolchain\15_2_Rel1\bin"
"%CMAKE%" -G Ninja -S . -B build -DCMAKE_MAKE_PROGRAM="%NINJA%" -DCMAKE_C_COMPILER="%USERPROFILE%\.pico-sdk\toolchain\15_2_Rel1\bin\arm-none-eabi-gcc.exe" -DCMAKE_CXX_COMPILER="%USERPROFILE%\.pico-sdk\toolchain\15_2_Rel1\bin\arm-none-eabi-g++.exe" -DCMAKE_ASM_COMPILER="%USERPROFILE%\.pico-sdk\toolchain\15_2_Rel1\bin\arm-none-eabi-gcc.exe" >> "%LOG%" 2>&1
set CFG=%ERRORLEVEL%

echo. >> "%LOG%"
echo ==== ninja build ==== >> "%LOG%"
"%NINJA%" -C build >> "%LOG%" 2>&1
set BLD=%ERRORLEVEL%

echo. >> "%LOG%"
echo ---- artifacts ---- >> "%LOG%"
if exist "build\PicoPhone.uf2" (
    for %%F in ("build\PicoPhone.uf2") do echo uf2: %%~zF bytes  %%~tF >> "%LOG%"
) else (
    echo uf2: MISSING >> "%LOG%"
)
echo CMAKE_EXIT=%CFG% >> "%LOG%"
echo BUILD_EXIT=%BLD% >> "%LOG%"

if not "%BLD%"=="0" exit /b %BLD%
exit /b 0
