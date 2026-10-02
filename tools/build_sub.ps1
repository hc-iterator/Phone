<#
  build_sub.ps1 —— 一条命令编译独立子工程（probe_rp2040 / wboard_dvi / core1_monitor）

  为什么有它：这条 cmake 长命令（工具链路径 + PICO_PLATFORM + pico-vscode 配置 +
  CMAKE_TRY_COMPILE_TARGET_TYPE）在本会话里被手打了 6 次以上，每次都容易漏参数。
  规矩六：这种"一次投入、此后每次受益"的工具，看到就直接做。

  用法：
      .\tools\build_sub.ps1 probe_rp2040
      .\tools\build_sub.ps1 wboard_dvi -Clean
      .\tools\build_sub.ps1 core1_monitor -Target pin_toggle
      .\tools\build_sub.ps1 probe_rp2040 -NoUf2      # 不转换 uf2

  说明：
    · 自动按工程名判断平台（rp2040 / rp2350-arm-s）与板级
    · 自动加 pico-vscode.cmake 相关的搜索路径（PICO_TOOLCHAIN_PATH）
    · 编完自动用【预编译的】picotool 把 elf 转成 uf2（不需要现场编译 picotool）
#>
param(
    [Parameter(Position=0, Mandatory=$true)][string]$Project,
    [switch]$Clean,
    [string]$Target = "",
    [switch]$NoUf2
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# ---- 定位工具 ----
$cmake = "$env:USERPROFILE\.pico-sdk\cmake\v3.31.5\bin\cmake.exe"
$ninja = "$env:USERPROFILE\.pico-sdk\ninja\v1.12.1\ninja.exe"
$sdk   = "$env:USERPROFILE\.pico-sdk\sdk\2.3.0"
$tc    = "$env:USERPROFILE\.pico-sdk\toolchain\13_3_Rel1"
$pt    = "$env:USERPROFILE\.pico-sdk\picotool\2.3.0\picotool\picotool.exe"
foreach ($f in @($cmake,$ninja,$pt)) { if (-not (Test-Path $f)) { Write-Host "缺少工具: $f" -ForegroundColor Red; exit 1 } }
if (-not (Test-Path $sdk)) { Write-Host "缺少 SDK: $sdk" -ForegroundColor Red; exit 1 }

# ---- 按工程名决定平台与板级 ----
switch -Wildcard ($Project) {
    'probe_rp2040'  { $platform='rp2040';       $board='pico';                        $exe='probe_rp2040' }
    'wboard_dvi'    { $platform='rp2350-arm-s'; $board='waveshare_rp2350_plus_16mb';  $exe='dvi_min' }
    'core1_monitor' { $platform='rp2040';       $board='pico';                        $exe='core1_monitor' }
    default         { Write-Host "未知工程 '$Project'（支持 probe_rp2040 / wboard_dvi / core1_monitor）" -ForegroundColor Red; exit 1 }
}

$src = Join-Path $root $Project
$bld = Join-Path $src  'build'
if (-not (Test-Path (Join-Path $src 'CMakeLists.txt'))) { Write-Host "找不到 $Project\CMakeLists.txt" -ForegroundColor Red; exit 1 }
# ★ 关键：只要存在旧的 CMakeCache.txt 就必须清掉。
#   原因：PICO_PLATFORM / PICO_BOARD 是"整个工程"级设置，SDK 在做平台预检查时
#   先读缓存；缓存里是上一次的平台参数就会在 pico_pre_load_platform 处直接失败 ✗
#   （本工具第一次实测就踩到了：手打命令时我顺手删了 build 所以没事）
if ($Clean -or (Test-Path (Join-Path $bld 'CMakeCache.txt'))) {
    Remove-Item $bld -Recurse -Force -ErrorAction SilentlyContinue
    if (-not $Clean) { Write-Host "（检测到旧缓存，已自动清理 $Project\build）" -ForegroundColor DarkGray }
}

$env:PICO_SDK_PATH = $sdk
$env:PICO_TOOLCHAIN_PATH = $tc
$env:PATH = "$tc\bin;$env:PATH"

Write-Host "=== 配置 $Project ($platform / $board) ===" -ForegroundColor Cyan
& $cmake -G Ninja -S $src -B $bld -DCMAKE_MAKE_PROGRAM="$ninja" `
    -DPICO_SDK_PATH="$sdk" -DPICO_PLATFORM=$platform -DPICO_BOARD=$board `
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Host "配置失败" -ForegroundColor Red; exit 1 }

Write-Host "=== 编译 ===" -ForegroundColor Cyan
if ($Target) { & $cmake --build $bld --target $Target | Out-Host } else { & $cmake --build $bld | Out-Host }
if ($LASTEXITCODE -ne 0) { Write-Host "编译失败" -ForegroundColor Red; exit 1 }

# ---- 若没有 uf2，用预编译 picotool 转 ----
if (-not $NoUf2) {
    $names = if ($Target) { @($Target) } else { @($exe) }
    foreach ($n in $names) {
        $elf = Join-Path $bld "$n.elf"
        $uf2 = Join-Path $bld "$n.uf2"
        if ((Test-Path $elf) -and -not (Test-Path $uf2)) {
            & $pt uf2 convert -t elf $elf $uf2 | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-Host "已生成 $n.uf2" -ForegroundColor Green }
        }
    }
}

Write-Host "=== 产物 ===" -ForegroundColor Cyan
Get-ChildItem $bld -Filter '*.uf2' -ErrorAction SilentlyContinue |
    ForEach-Object { "  {0,-28} {1,8} B  {2}" -f $_.Name, $_.Length, $_.LastWriteTime }
