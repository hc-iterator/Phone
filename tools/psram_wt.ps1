# tools\psram_wt.ps1 —— 跑 PSRAM 连续写入实验
#
# 为什么要单独一个脚本：
#   cycle.ps1 里写死了 sleep 8000（8 秒），而这个实验每挂死一步就要
#   等看门狗 3 秒 + 重新启动约 1 秒，最多 15 步 ⇒ 需要一分多钟。
#   而且实验期间**不能占着调试口**（让板子真正自由跑，看门狗才好使）。
#
# 流程：烧写 → 彻底断开调试器 → 自由跑 -RunSec 秒 → 接上读结果
#
# 用法：
#   pwsh -NoProfile -File tools/psram_wt.ps1
#   pwsh -NoProfile -File tools/psram_wt.ps1 -RunSec 120 -SkipFlash

param(
    [int]$RunSec = 90,
    [string]$Elf = "build/SPI_PICO_TEST.elf",
    [string]$GdbScript = "tools/gdb_wt.txt",
    [int]$GdbTimeoutMs = 60000,
    [switch]$SkipFlash
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$OCD_DIR = "$env:USERPROFILE\.pico-sdk\openocd\0.12.0+dev"
$OCD     = "$OCD_DIR\openocd.exe"
$OCD_S   = "$OCD_DIR\scripts"
$GDB     = "$env:USERPROFILE\.pico-sdk\toolchain\13_3_Rel1\bin\arm-none-eabi-gdb.exe"

function Stop-Ocd {
    Get-Process openocd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
}

Stop-Ocd

if (-not $SkipFlash) {
    $elfAbs = (Resolve-Path $Elf).Path -replace '\\','/'
    @"
adapter speed 1000
init
halt
program "$elfAbs" verify
reset run
shutdown
"@ | Set-Content -Encoding ascii tools\ocd_wt_flash.cfg

    & $OCD -s $OCD_S -f interface/cmsis-dap.cfg -f target/rp2350.cfg -f tools/ocd_wt_flash.cfg *> debug_logs\flash_log.txt
    if (-not (Select-String -Path debug_logs\flash_log.txt -Pattern 'Verified OK' -Quiet)) {
        Write-Host "== 烧写未通过 =="
        Get-Content debug_logs\flash_log.txt | Select-String -Pattern 'Error|error' | Select-Object -First 5
        exit 1
    }
    Write-Host "== 已烧写 =="
}

Write-Host "== 自由运行 $RunSec 秒（实验会自动被看门狗复位并续跑）=="
Start-Sleep -Seconds $RunSec
Stop-Ocd

# ---- 接上读结果 ----
Start-Process -FilePath $OCD `
    -ArgumentList @("-s",$OCD_S,"-f","interface/cmsis-dap.cfg","-f","target/rp2350.cfg") `
    -RedirectStandardOutput debug_logs\ocd_server_log.txt -RedirectStandardError debug_logs\ocd_server_err.txt `
    -WindowStyle Hidden
Start-Sleep -Seconds 3

$gdbProc = Start-Process -FilePath $GDB `
    -ArgumentList @("-q","-batch","-x",$GdbScript,$Elf) `
    -RedirectStandardOutput debug_logs\gdb_out.txt -RedirectStandardError debug_logs\gdb_err.txt `
    -NoNewWindow -PassThru
if (-not $gdbProc.WaitForExit($GdbTimeoutMs)) {
    Write-Host "== GDB 超时，强制结束 =="
    try { $gdbProc.Kill($true) } catch {}
    Start-Sleep -Milliseconds 500
}
Stop-Ocd

Write-Host "== 结果 =="
Get-Content debug_logs\gdb_out.txt |
    Where-Object {
        $_ -notmatch '^\s*$' -and
        $_ -notmatch 're-reading symbols' -and
        $_ -notmatch 'has changed' -and
        $_ -notmatch 'Hardware thread awareness' -and
        $_ -notmatch '^Info :' -and
        $_ -notmatch '^Warn :' -and
        $_ -notmatch 'multi-threaded target' -and
        $_ -notmatch 'pico_default_asm_volatile' -and
        $_ -notmatch 'VECTRESET' -and
        $_ -notmatch "Set 'cortex_m reset_config"
    } | ForEach-Object { Write-Host "  $_" }
