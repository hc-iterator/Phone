<#
  build_sub.ps1 —— 一键编译独立子工程（probe_rp2040 / wboard_dvi / core1_monitor）

  为什么有它：那条 cmake 长命令在本会话被手打了 6 次以上，每次容易漏参数。
  按本项目规矩六："罪在当代、利在千秋"的工具，看到就直接做出来。

  用法：
      .\tools\build_sub.ps1 probe_rp2040
      .\tools\build_sub.ps1 wboard_dvi
      .\tools\build_sub.ps1 core1_monitor

      # 慢扫描档（DVI 位率降到 1/8 = 31.5 Mbit/s，供 252 MSa/s 探针解 TMDS 符号）：
      .\tools\build_sub.ps1 wboard_dvi -BuildSub build_slow -CacheArgs '-DWBOARD_DVI_SM_CLKDIV=8'

  ★ 2026-10-04 关键修正：cmake / ninja 一律经【cmd.exe 的文件重定向】调用，不用 PowerShell 直连。
    原因（实测坐实，不是推测）：
      PowerShell 抓子进程输出走的是【匿名管道】，而本机沙箱禁止管道
      ⇒ 直接 `& $cmake ...` 会让 cmake 在配置阶段【访问违例崩溃】（退出码 -1073741819 = 0xC0000005），
        而且【不打印任何错误】，看起来像"配置失败但没原因"。
      cmd.exe 的 `>` 是【文件句柄直传】，不建管道 ⇒ 这才是能过的路。
      （这与 tools\build.cmd 存在的原因完全一致；本条已同步进 `docs/陷阱.md` 错 18。）

  其余三个坑（写在这里，别再犯）：
    ① 【不要用管道捕获子进程输出】——见上，已用 cmd /c + 文件重定向规避。
    ② 【不要用反引号续行】：反引号后面多一个空格，续行就失效，
       参数会被拆散、变量甚至以【字面量】传给 cmake（本脚本为此挂了 4 轮 ✗）
       ⇒ 一律改用参数数组 @(...)。
    ③ 【不要用绝对路径给 -S/-B】：实测相对路径能过、绝对路径会在 SDK 平台预检查处失败；
       另外旧 build 目录里的 CMakeCache 带着上次平台参数，必须先清掉。
#>
param(
    [Parameter(Position=0, Mandatory=$true)][string]$Project,
    [string]$Target = "",
    [switch]$NoUf2,
    # 额外传给 cmake 配置阶段的参数（每个元素自带 -D，例：'-DWBOARD_DVI_SM_CLKDIV=8'）
    [string[]]$CacheArgs = @(),
    # 构建目录名。慢扫描档请用 build_slow，免得把全速产物覆盖掉
    [string]$BuildSub = "build"
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

$buildDir = "$Project\$BuildSub"

switch ($Project) {
    'probe_rp2040'  { $platform = 'rp2040';       $board = 'pico';                       $exe = 'probe_rp2040' }
    'wboard_dvi'    { $platform = 'rp2350-arm-s'; $board = 'waveshare_rp2350_plus_16mb'; $exe = 'dvi_min' }
    'core1_monitor' { $platform = 'rp2040';       $board = 'pico';                       $exe = 'core1_monitor' }
    default         { Write-Host "未知工程 '$Project'" -ForegroundColor Red; exit 1 }
}
if (-not (Test-Path "$Project\CMakeLists.txt")) { Write-Host "找不到 $Project\CMakeLists.txt" -ForegroundColor Red; exit 1 }

if (Test-Path "$buildDir\CMakeCache.txt") {
    Remove-Item $buildDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "（检测到旧缓存，已自动清理 $buildDir）" -ForegroundColor DarkGray
}

$env:PICO_SDK_PATH = $sdk
$env:PICO_TOOLCHAIN_PATH = $tc
$env:PATH = "$tc\bin;$env:PATH"

# 日志进 debug_logs/（本项目硬规则：脚本每跑一次就重写的文件一律放这儿）
$logDir = Join-Path (Get-Location) 'debug_logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ("build_{0}{1}.txt" -f $Project, ($BuildSub -replace '^build$',''))

# ── 配置（经 cmd /c 重定向到文件，避开沙箱的管道禁区）───────────────────────
Write-Host "=== 配置 $Project ($platform / $board) -> $buildDir ===" -ForegroundColor Cyan
$cfgParts = @(
    "`"$cmake`""
    '-G Ninja'
    "-S $Project"
    "-B $buildDir"
    "`"-DCMAKE_MAKE_PROGRAM=$ninja`""
    "`"-DPICO_SDK_PATH=$sdk`""
    "-DPICO_PLATFORM=$platform"
    "-DPICO_BOARD=$board"
    '-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY'
)
if ($CacheArgs.Count -gt 0) {
    Write-Host ("    额外参数: {0}" -f ($CacheArgs -join ' ')) -ForegroundColor DarkGray
    $cfgParts += $CacheArgs
}
cmd /c (($cfgParts -join ' ') + " > `"$log`" 2>&1")
$cfgExit = $LASTEXITCODE
Write-Host "cmake configure exit = $cfgExit" -ForegroundColor $(if ($cfgExit -eq 0) {'Green'} else {'Red'})
if ($cfgExit -ne 0) {
    Write-Host "----- 配置日志（$log）-----" -ForegroundColor Yellow
    Get-Content $log -Tail 60
    exit 1
}

# ── 编译 ───────────────────────────────────────────────────────────────────
Write-Host "=== 编译 ===" -ForegroundColor Cyan
$buildCmd = "`"$cmake`" --build $buildDir"
if ($Target) { $buildCmd += " --target $Target" }
cmd /c ($buildCmd + " >> `"$log`" 2>&1")
$buildExit = $LASTEXITCODE
Write-Host "ninja build exit = $buildExit" -ForegroundColor $(if ($buildExit -eq 0) {'Green'} else {'Red'})
if ($buildExit -ne 0) {
    Write-Host "----- 编译日志（$log）-----" -ForegroundColor Yellow
    Get-Content $log -Tail 40
    exit 1
}

# ── elf -> uf2 ─────────────────────────────────────────────────────────────
if (-not $NoUf2) {
    $names = @($exe)
    if ($Target) { $names += $Target }
    foreach ($n in $names) {
        $elf = "$buildDir\$n.elf"
        $uf2 = "$buildDir\$n.uf2"
        if (Test-Path $elf) {
            cmd /c ("`"$pt`" uf2 convert -t elf `"$elf`" `"$uf2`" > nul 2>&1")
            if ($LASTEXITCODE -eq 0) { Write-Host "已生成 $n.uf2" -ForegroundColor Green }
            else { Write-Host "uf2 转换失败: $n" -ForegroundColor Red }
        }
    }
}

Write-Host "=== 产物 ===" -ForegroundColor Cyan
Get-ChildItem "$buildDir" -Filter '*.uf2' -ErrorAction SilentlyContinue |
    ForEach-Object { "  {0,-24} {1,8} B  {2}" -f $_.Name, $_.Length, $_.LastWriteTime }
