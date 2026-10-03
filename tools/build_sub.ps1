<#
  build_sub.ps1 —— 一键编译独立子工程（probe_rp2040 / wboard_dvi / core1_monitor）

  为什么有它：那条 cmake 长命令在本会话被手打了 6 次以上，每次容易漏参数。
  按本项目规矩六："罪在当代、利在千秋"的工具，看到就直接做出来。

  用法：
      .\tools\build_sub.ps1 probe_rp2040
      .\tools\build_sub.ps1 wboard_dvi
      .\tools\build_sub.ps1 core1_monitor

  踩过的三个坑（写在这里，别再犯）：
    ① 【不要用管道捕获子进程输出】：本机沙箱禁止"子进程输出走管道"——
       这正是 tools\build.cmd 存在的原因（它重定向到文件）。本脚本让 cmake 直接印到终端。
    ② 【不要用反引号续行】：反引号后面多一个空格，续行就失效，
       参数会被拆散、变量甚至以【字面量】传给 cmake（本脚本为此挂了 4 轮 ✗）
       ⇒ 一律改用参数数组 @(...)。
    ③ 【不要用绝对路径给 -S/-B】：实测相对路径能过、绝对路径会在 SDK 平台预检查处失败；
       另外旧 build 目录里的 CMakeCache 带着上次平台参数，必须先清掉。
#>
param(
    [Parameter(Position=0, Mandatory=$true)][string]$Project,
    [string]$Target = "",
    [switch]$NoUf2
)
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)

$cmake = "$env:USERPROFILE\.pico-sdk\cmake\v3.31.5\bin\cmake.exe"
$ninja = "$env:USERPROFILE\.pico-sdk\ninja\v1.12.1\ninja.exe"
$sdk   = "$env:USERPROFILE\.pico-sdk\sdk\2.3.0"
$tc    = "$env:USERPROFILE\.pico-sdk\toolchain\13_3_Rel1"
$pt    = "$env:USERPROFILE\.pico-sdk\picotool\2.3.0\picotool\picotool.exe"
foreach ($f in @($cmake, $ninja, $sdk, $pt)) {
    if (-not (Test-Path $f)) { Write-Host "缺少工具: $f" -ForegroundColor Red; exit 1 }
}

switch ($Project) {
    'probe_rp2040'  { $platform = 'rp2040';       $board = 'pico';                       $exe = 'probe_rp2040' }
    'wboard_dvi'    { $platform = 'rp2350-arm-s'; $board = 'waveshare_rp2350_plus_16mb'; $exe = 'dvi_min' }
    'core1_monitor' { $platform = 'rp2040';       $board = 'pico';                       $exe = 'core1_monitor' }
    default         { Write-Host "未知工程 '$Project'" -ForegroundColor Red; exit 1 }
}
if (-not (Test-Path "$Project\CMakeLists.txt")) { Write-Host "找不到 $Project\CMakeLists.txt" -ForegroundColor Red; exit 1 }

if (Test-Path "$Project\build\CMakeCache.txt") {
    Remove-Item "$Project\build" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "（检测到旧缓存，已自动清理 $Project\build）" -ForegroundColor DarkGray
}

$env:PICO_SDK_PATH = $sdk
$env:PICO_TOOLCHAIN_PATH = $tc
$env:PATH = "$tc\bin;$env:PATH"

Write-Host "=== 配置 $Project ($platform / $board) ===" -ForegroundColor Cyan
$cmakeArgs = @(
    '-G', 'Ninja'
    '-S', $Project
    '-B', "$Project\build"
    "-DCMAKE_MAKE_PROGRAM=$ninja"
    "-DPICO_SDK_PATH=$sdk"
    "-DPICO_PLATFORM=$platform"
    "-DPICO_BOARD=$board"
    '-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY'
)
& $cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) { Write-Host "配置失败" -ForegroundColor Red; exit 1 }

Write-Host "=== 编译 ===" -ForegroundColor Cyan
if ($Target) { & $cmake --build "$Project\build" --target $Target }
else         { & $cmake --build "$Project\build" }
if ($LASTEXITCODE -ne 0) { Write-Host "编译失败" -ForegroundColor Red; exit 1 }

if (-not $NoUf2) {
    $names = @($exe)
    if ($Target) { $names += $Target }
    foreach ($n in $names) {
        $elf = "$Project\build\$n.elf"
        $uf2 = "$Project\build\$n.uf2"
        if ((Test-Path $elf) -and -not (Test-Path $uf2)) {
            & $pt uf2 convert -t elf $elf $uf2 > $null 2>&1
            if ($LASTEXITCODE -eq 0) { Write-Host "已生成 $n.uf2" -ForegroundColor Green }
        }
    }
}

Write-Host "=== 产物 ===" -ForegroundColor Cyan
Get-ChildItem "$Project\build" -Filter '*.uf2' -ErrorAction SilentlyContinue |
    ForEach-Object { "  {0,-24} {1,8} B  {2}" -f $_.Name, $_.Length, $_.LastWriteTime }
