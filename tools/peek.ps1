<#
  读运行中目标的内存（按【符号名】而不是地址），不 reset。
  用法：
      .\tools\peek.ps1 g_dvi_irq_count                       # 读 1 个字
      .\tools\peek.ps1 g_rate_t 8                            # 读 8 个字
      .\tools\peek.ps1 dvi0 -Off 0x708                       # 符号 + 偏移
      .\tools\peek.ps1 @(g_rate_n,g_rate_t,g_rate_c) 8       # 一次读多个符号
  输出：每行 "符号 = 0x........"
#>
param(
    [Parameter(Position=0)]$Sym,
    [Parameter(Position=1)][int]$Count = 1,
    [int]$Off = 0,
    [string]$Elf = ""
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Elf) { $Elf = Join-Path $root 'build\SPI_PICO_TEST.elf' }
$tl  = Join-Path $env:USERPROFILE '.pico-sdk\toolchain\14_2_Rel1\bin'
$ocd = Join-Path $env:USERPROFILE '.pico-sdk\openocd\0.12.0+dev\openocd.exe'
$scr = Join-Path $env:USERPROFILE '.pico-sdk\openocd\0.12.0+dev\scripts'
$tmp = Join-Path $env:TEMP 'pico_flash'; New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$nm = & (Join-Path $tl 'arm-none-eabi-nm.exe') -n $Elf 2>$null
$lines = @()
foreach ($s in @($Sym)) {
    $m = $nm | Select-String -Pattern ("\s" + [regex]::Escape($s) + "$") | Select-Object -First 1
    if (-not $m) { Write-Host "找不到符号 $s" -ForegroundColor Red; continue }
    $a = [Convert]::ToUInt32(($m.Line -split '\s+')[0], 16) + $Off
    $lines += "echo $s=[capture {mdw 0x$('{0:x}' -f $a) $Count}]"
}
if ($lines.Count -eq 0) { exit 1 }
$cfg = Join-Path $tmp 'peek.cfg'
(@("adapter speed 500", "init", "halt") + $lines + @("resume", "shutdown")) -join "`n" |
    Set-Content -Path $cfg -Encoding ascii
$o = & cmd /c "`"$ocd`" -s `"$scr`" -f interface/cmsis-dap.cfg -f target/rp2350.cfg -f `"$cfg`" 2>&1"
$o | Where-Object { $_ -match '^\s*0x[0-9a-f]+:|=' -and $_ -notmatch 'Info|Error' } | ForEach-Object { $_.Trim() }
