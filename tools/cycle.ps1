# tools\cycle.ps1 —— 一条命令走完"编译 -> 烧写 -> 采集"整条链
#
# 为什么要这个脚本：
#   之前每轮调试都要手敲 6~8 条命令（cmake、ninja、开 openocd、跑 gdb、
#   关进程、读日志），既慢又大量重复，把上下文全浪费在样板命令上。
#   这里全部封装，只把【关键结论】打出来。
#
# 用法：
#   pwsh -File tools/cycle.ps1                  # 全流程
#   pwsh -File tools/cycle.ps1 -SkipBuild       # 只烧写+采集
#   pwsh -File tools/cycle.ps1 -GdbScript tools/gdb_diag.txt
#
# 产出：
#   debug_logs\build_log.txt   编译日志（只看 BUILD_EXIT / error:）
#   debug_logs\flash_log.txt   烧写日志
#   debug_logs\gdb_out.txt     采集结果（脚本里真正想看的输出）

param(
    [switch]$SkipBuild,
    [string]$GdbScript = "tools/gdb_diag.txt",
    [string]$Elf = "build/SPI_PICO_TEST.elf",
    [int]$GdbTimeoutMs = 60000
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$OCD_DIR = "$env:USERPROFILE\.pico-sdk\openocd\0.12.0+dev"
$OCD     = "$OCD_DIR\openocd.exe"
$OCD_S   = "$OCD_DIR\scripts"
$GDB     = "$env:USERPROFILE\.pico-sdk\toolchain\13_3_Rel1\bin\arm-none-eabi-gdb.exe"

function Stop-Ocd {
    # 只杀 openocd，不要碰当前 pwsh（曾经用 Get-Process pwsh 把自己杀掉过）
    Get-Process openocd -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
}

# ---------- 1. 编译 ----------
if (-not $SkipBuild) {
    # 先停掉 openocd：它占着调试器，且旧固件还在跑，会干扰
    Stop-Ocd
    cmd /c "tools\build.cmd" > $null 2>&1
    $bl = Get-Content debug_logs\build_log.txt
    $exit = ($bl | Select-String -Pattern "^BUILD_EXIT=").ToString()
    $errs = $bl | Select-String -Pattern "error:|Error " | Select-Object -First 5
    Write-Host "== BUILD =="
    Write-Host "  $exit"
    if ($errs) { Write-Host "  ERRORS:"; $errs | ForEach-Object { Write-Host "    $_" } }
    if ($exit -notmatch "BUILD_EXIT=0") { Write-Host "  编译失败，停止。"; exit 1 }
}

# ---------- 2. 烧写 ----------
Stop-Ocd
@'
adapter speed 1000
init
halt
program "C:/Users/Chen/Desktop/Pico/SPI_PICO_TEST/build/SPI_PICO_TEST.elf" verify
reset run
sleep 8000
halt
shutdown
'@ | Set-Content -Encoding ascii tools\ocd_flash_run.cfg

& $OCD -s $OCD_S -f interface/cmsis-dap.cfg -f target/rp2350.cfg -f tools/ocd_flash_run.cfg *> debug_logs\flash_log.txt
$fl = Get-Content debug_logs\flash_log.txt -ErrorAction SilentlyContinue
$verified = $fl | Select-String -Pattern "Verified OK|Programming Finished|Error" | ForEach-Object { $_.ToString().Trim() }
Write-Host "== FLASH =="
$verified | ForEach-Object { Write-Host "  $_" }
if (-not ($fl | Select-String -Pattern "Verified OK")) { Write-Host "  烧写未通过，停止。"; exit 1 }

# ---------- 3. 采集 ----------
Stop-Ocd
Start-Process -FilePath $OCD `
    -ArgumentList @("-s",$OCD_S,"-f","interface/cmsis-dap.cfg","-f","target/rp2350.cfg") `
    -RedirectStandardOutput debug_logs\ocd_server_log.txt -RedirectStandardError debug_logs\ocd_server_err.txt `
    -WindowStyle Hidden
Start-Sleep -Seconds 3

# ⚠️ GDB 必须带硬超时。
# 踩过的坑：GDB 的 "continue" 若断点从未命中，会无限等待，
# 前台命令直接卡死，只能人工关掉。所以这里用 Start-Process + WaitForExit(ms)，
# 超时就把 GDB 杀掉，脚本继续往下走，不会卡住整条流水线。
$gdbProc = Start-Process -FilePath $GDB `
    -ArgumentList @("-q","-batch","-x",$GdbScript,$Elf) `
    -RedirectStandardOutput debug_logs\gdb_out.txt -RedirectStandardError debug_logs\gdb_err.txt `
    -NoNewWindow -PassThru
if (-not $gdbProc.WaitForExit($GdbTimeoutMs)) {
    Write-Host "== GDB 超时（$($GdbTimeoutMs/1000) 秒），强制结束 =="
    try { $gdbProc.Kill($true) } catch {}
    Start-Sleep -Milliseconds 500
}
Stop-Ocd

Write-Host "== GDB ($GdbScript) =="
# 去掉 GDB 的样板噪音，只留脚本自己 echo 的内容
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
        $_ -notmatch '^\s*119\s' -and
        $_ -notmatch 'VECTRESET' -and
        $_ -notmatch "Set 'cortex_m reset_config"
    } | ForEach-Object { Write-Host "  $_" }
