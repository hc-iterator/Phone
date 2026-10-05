<#
  一次生成 6 种 lane 引脚排列的 uf2，放到 build\perms2\ 下，供拖盘逐个试。
  用途：判定"D0/D1/D2 与 DVI 三通道的对应关系"（哪个排列能让颜色正确）。

  用法：  .\tools\make_perms.ps1
  产物：  build\perms2\perm_01_std_36_34_32.uf2  ...  perm_06_rev_32_34_36.uf2

  注意：脚本会临时改写 CMakeLists.txt 里的 FRANK_HDMI_PIN_D0/D1/D2，
        结束后【恢复原样】。原样是什么，就是运行前那一刻的值。
#>
$ErrorActionPreference = 'Stop'

$root  = Split-Path -Parent $PSScriptRoot
$f     = Join-Path $root 'CMakeLists.txt'
$out   = Join-Path $root 'build\perms2'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$orig = Get-Content $f -Raw

$perms = @(
    @{ n = '01_std_36_34_32'; a = 36; b = 34; c = 32 },   # 官方/库的表：D0=36 D1=34 D2=32
    @{ n = '02_36_32_34';     a = 36; b = 32; c = 34 },
    @{ n = '03_34_36_32';     a = 34; b = 36; c = 32 },
    @{ n = '04_34_32_36';     a = 34; b = 32; c = 36 },
    @{ n = '05_32_36_34';     a = 32; b = 36; c = 34 },
    @{ n = '06_rev_32_34_36'; a = 32; b = 34; c = 36 }
)

foreach ($p in $perms) {
    $c = $orig
    $c = [regex]::Replace($c, 'FRANK_HDMI_PIN_D0=\d+', "FRANK_HDMI_PIN_D0=$($p.a)")
    $c = [regex]::Replace($c, 'FRANK_HDMI_PIN_D1=\d+', "FRANK_HDMI_PIN_D1=$($p.b)")
    $c = [regex]::Replace($c, 'FRANK_HDMI_PIN_D2=\d+', "FRANK_HDMI_PIN_D2=$($p.c)")
    Set-Content $f -Value $c -NoNewline
    & cmd /c "tools\build.cmd" 2>&1 | Out-Null
    $log = Join-Path $root 'debug_logs\build_log.txt'
    if ((Get-Content $log -Tail 1) -match 'BUILD_EXIT=0') {
        Copy-Item (Join-Path $root 'build\PicoPhone.uf2') (Join-Path $out "perm_$($p.n).uf2") -Force
        Write-Host "  perm_$($p.n): D0=$($p.a) D1=$($p.b) D2=$($p.c)  => 已生成" -ForegroundColor Green
    } else {
        Write-Host "  perm_$($p.n): 编译失败" -ForegroundColor Red
    }
}

# 恢复原样
Set-Content $f -Value $orig -NoNewline
& cmd /c "tools\build.cmd" 2>&1 | Out-Null
Write-Host "`nCMakeLists.txt 已恢复；uf2 在 $out" -ForegroundColor Cyan
Get-ChildItem $out -Filter '*.uf2' | Sort-Object Name | ForEach-Object { Write-Host "  $($_.Name)" }
