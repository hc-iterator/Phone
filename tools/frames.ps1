# tools\frames.ps1 —— 量"到底哪一边停了"
#
# 为什么要这个脚本：
#   排查 DVI 卡死时我把 Core0 和 Core1 的计数器搞混过，白绕了几轮。
#   `dvi0.dvi_frame_count` 是 Core1（引擎）的，`g_dvi_loop_frames` 是 Core0（画图）的，
#   两个必须分别读、分别看是否在增长。
#
# 用法：
#   pwsh -NoProfile -File tools/frames.ps1              # 复位自由运行 15s 后量两轮
#   pwsh -NoProfile -File tools/frames.ps1 -WarmupSec 20 -GapSec 8
#
# 结束时会让目标继续自由运行（monitor resume + detach），方便接着看屏幕。

param(
    [int]$WarmupSec = 15,
    [int]$GapSec = 8,
    [string]$Elf = "build/SPI_PICO_TEST.elf",
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

# ---------- 1. 烧写，然后复位自由运行（不占用调试口） ----------
#
# ⚠️ 必须烧写！踩过的坑：只 reset 不 flash，板子上跑的是【旧固件】，
#    而 GDB 用的是【新 ELF】，符号全错位，读出来的数字看着像真的
#    （实测读到了 0x09090909 这种规律值），非常容易误判。
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
"@ | Set-Content -Encoding ascii tools\ocd_flash_free.cfg
    & $OCD -s $OCD_S -f interface/cmsis-dap.cfg -f target/rp2350.cfg -f tools/ocd_flash_free.cfg *> debug_logs\flash_log.txt
    if (-not (Select-String -Path debug_logs\flash_log.txt -Pattern 'Verified OK' -Quiet)) {
        Write-Host "== 烧写未通过，停止 =="
        Get-Content debug_logs\flash_log.txt | Select-String -Pattern 'Error|error' | Select-Object -First 5
        exit 1
    }
    Write-Host "== 已烧写 ($Elf) =="
} else {
    @'
adapter speed 1000
init
reset run
shutdown
'@ | Set-Content -Encoding ascii tools\ocd_run_free.cfg
    & $OCD -s $OCD_S -f interface/cmsis-dap.cfg -f target/rp2350.cfg -f tools/ocd_run_free.cfg *> debug_logs\ocd_free_log.txt
}
Write-Host "== 自由运行，等待 $WarmupSec 秒 =="
Start-Sleep -Seconds $WarmupSec

# ---------- 2. 采样函数 ----------
@'
set confirm off
set pagination off
set height 0
target extended-remote localhost:3333
printf "SAMPLE core0_loop=%%u core1_frames=%%u marks=%%u\n", g_dvi_loop_frames, dvi0.dvi_frame_count, g_probe_marks
monitor resume
detach
quit
'@ -replace '%%','%' | Set-Content -Encoding ascii tools\gdb_sample.txt

function Sample([string]$tag) {
    $o = "debug_logs\sample_$tag.txt"
    $p = Start-Process -FilePath $GDB `
        -ArgumentList @("-q","-batch","-x","tools/gdb_sample.txt",$Elf) `
        -RedirectStandardOutput $o -RedirectStandardError "debug_logs\sample_$tag.err" `
        -NoNewWindow -PassThru
    if (-not $p.WaitForExit(40000)) { try { $p.Kill($true) } catch {} }
    $line = (Get-Content $o -ErrorAction SilentlyContinue | Where-Object { $_ -match 'SAMPLE' } | Select-Object -First 1)
    if (-not $line) { $line = "SAMPLE (采集失败，看 debug_logs\sample_$tag.err)" }
    Write-Host "  $tag : $line"
    return $line
}

Stop-Ocd
Start-Process -FilePath $OCD `
    -ArgumentList @("-s",$OCD_S,"-f","interface/cmsis-dap.cfg","-f","target/rp2350.cfg") `
    -RedirectStandardOutput debug_logs\ocd_server_log.txt -RedirectStandardError debug_logs\ocd_server_err.txt `
    -WindowStyle Hidden
Start-Sleep -Seconds 3

$t0 = Sample "t0"
Start-Sleep -Seconds $GapSec
$t1 = Sample "t1"
Stop-Ocd
