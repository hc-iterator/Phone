<#
  flash_backdoor.ps1 —— 用串口后门刷写板子（不用碰 BOOTSEL 按键）

  为什么有它：昨天"发 B 进 BOOT → 等盘出现 → 按 BOARD-ID 认板 → 拷 uf2 → 等重启"
  这个流程被手打了 6 次以上，每次都要现写一小段 python + 认盘 + 认串口。
  按规矩六：一次投入、此后每次受益的工具，看到就直接做。

  用法：
      .\tools\flash_backdoor.ps1                       # 列出当前能看到的板子与引导盘
      .\tools\flash_backdoor.ps1 -Board probe          # 把探针刷成 probe_rp2040.uf2
      .\tools\flash_backdoor.ps1 -Board dut            # 把待测板刷成指定固件
      .\tools\flash_backdoor.ps1 -Board dut -Firmware wboard_dvi\build\pin_toggle.uf2

  原理与安全点：
    · 固件里的后门命令是 B（进 BOOTSEL）与 R（重启），见 probe_rp2040/probe.c 与 wboard_dvi/*.c
    · 进 BOOT 后按 INFO_UF2.TXT 的 Board-ID 认板：RPI-RP2 = RP2040(探针)，RP2350 = 待测板
      ⇒ 绝不靠盘符（插拔后会变号）
    · 拷完等盘消失再返回，避免"以为烧完了其实还在写"
#>
param(
    [ValidateSet('probe','dut','')][string]$Board = '',
    [string]$Firmware = '',
    [int]$BootWaitSec = 8,
    [int]$FlashWaitSec = 15
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Get-BootDrives {
    Get-Volume -ErrorAction SilentlyContinue |
        Where-Object { $_.FileSystemLabel -match 'RP2350|RPI-RP2' } |
        ForEach-Object {
            $id = (Get-Content "$($_.DriveLetter):\INFO_UF2.TXT" -ErrorAction SilentlyContinue |
                   Select-String 'Board-ID').Line
            [pscustomobject]@{
                Letter = "$($_.DriveLetter):"
                Board  = if ($id -match 'RP2350') { 'dut' } elseif ($id -match 'RPI-RP2') { 'probe' } else { '?' }
                Info   = ($id -replace '\s+',' ').Trim()
            }
        }
}

function Get-SerialPorts {
    python -c "import serial.tools.list_ports as L; ps=[p for p in L.comports() if not (chr(66)+'luetooth' in (p.description or '') or chr(34013)+chr(29273) in (p.description or ''))]; print(' '.join(p.device for p in ps))" 2>$null
}

<#
  Get-BoardPorts —— 只列出【目标板自己】的串口（按 VID:PID 认）
  〔2026-10-06 加〕旧版是"对所有串口无差别猛发 6 次 B" ✗ —— 实测它把探针的 COM8 也一起发了。
  探针那版固件要求 ESC ESC 前缀才认 B，所以这次没出事；换一版固件就可能被推进 BOOTSEL，
  而探针当前跑的后门版固件【盘上没有备份】⇒ 那个方向一旦烧坏就回不来。
  ⇒ 按项目一贯的"按 VID:PID 认板"惯例，只对目标板的口发 B。
     dut   = RP2350 → 2E8A:0009
     probe = RP2040 → 2E8A:000C（debugprobe）或 2E8A:000A（core1_monitor），两块固件都算
#>
function Get-BoardPorts {
    param([ValidateSet('probe','dut')][string]$Which)
    $wantVid = '2E8A'
    $wantPid = if ($Which -eq 'dut') { @('0009') } else { @('000A','000C') }
    $rows = python -c @"
import serial.tools.list_ports as L
for p in L.comports():
    vid = ('%04X' % p.vid) if p.vid is not None else '----'
    pid = ('%04X' % p.pid) if p.pid is not None else '----'
    print(p.device, vid, pid)
"@ 2>$null
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($ln in ($rows -split "`r?`n")) {
        $t = $ln.Trim()
        if ($t -eq '') { continue }
        $f = $t -split '\s+'
        if ($f.Count -lt 3) { continue }
        if ($f[1] -notmatch $wantVid) { continue }
        $hit = $false
        foreach ($p in $wantPid) { if ($f[2] -match $p) { $hit = $true } }
        if ($hit) { [void]$out.Add($f[0]) }
    }
    return $out
}

# ---- 不带参数：只报告现状 ----
if ([string]::IsNullOrWhiteSpace($Board)) {
    Write-Host "=== 引导盘（按 BOARD-ID 认，不靠盘符）===" -ForegroundColor Cyan
    $drv = @(Get-BootDrives)
    if ($drv) { $drv | ForEach-Object { "  $($_.Letter)  => $($_.Board)  [$($_.Info)]" } }
    else { Write-Host "  （没有板子在 BOOTSEL）" -ForegroundColor DarkGray }
    Write-Host "`n=== 串口 ===" -ForegroundColor Cyan
    ((Get-SerialPorts) -split '\s+') | Where-Object { $_ -match '^COM' } | ForEach-Object { "  $_" }
    Write-Host "`n用法: .\tools\flash_backdoor.ps1 -Board probe|dut [-Firmware <uf2>]" -ForegroundColor Yellow
    exit 0
}

# ---- 默认固件 ----
$defaults = @{
    'probe' = 'probe_rp2040\build\probe_rp2040.uf2'
    'dut'   = 'wboard_dvi\build\dvi_min.uf2'
}
if ([string]::IsNullOrWhiteSpace($Firmware)) { $Firmware = $defaults[$Board] }
if (-not (Test-Path $Firmware)) {
    Write-Host "找不到固件: $Firmware" -ForegroundColor Red
    Write-Host "（先构建: .\tools\build_sub.ps1 <工程名>）" -ForegroundColor DarkGray
    exit 1
}
$fwSize = (Get-Item $Firmware).Length
Write-Host "目标板 = $Board    固件 = $Firmware ($fwSize B)" -ForegroundColor Cyan

# ---- 若已在 BOOT，直接刷 ----
$already = @(Get-BootDrives) | Where-Object { $_.Board -eq $Board } | Select-Object -First 1
if (-not $already) {
    Write-Host "板子不在 BOOT，尝试用串口后门 'B' ..." -ForegroundColor Cyan
    $sentOk = $false
    # 只对目标板自己的串口发 B（见 Get-BoardPorts 的注释：旧版是"对所有串口无差别发"✗）
    $boardPorts = @(Get-BoardPorts -Which $Board)
    if ($boardPorts.Count -eq 0) {
        Write-Host "  ✗ 没找到 $Board 的串口（按 VID:PID 认：dut=2E8A:0009，probe=2E8A:000A/000C）" -ForegroundColor Yellow
        Write-Host "    ⇒ 不向其它串口发 B —— 那会把别的板子推进 BOOTSEL" -ForegroundColor DarkGray
    }
    foreach ($port in $boardPorts) {
        $r = python -c @"
import serial, time, sys
try:
    s = serial.Serial('$port', 115200, timeout=0.4)
    s.dtr = True; s.rts = True
    time.sleep(0.25); s.reset_input_buffer()
    for _ in range(6):
        s.write(b'B'); s.flush(); time.sleep(0.08)
    s.close(); print('SENT')
except Exception as e:
    print('SKIP:' + str(e)[:40])
"@
        if ($r -match 'SENT') { Write-Host "  已向 $port 发送 B（$Board）" -ForegroundColor Green; $sentOk = $true }
    }
    if (-not $sentOk -and $boardPorts.Count -gt 0) { Write-Host "  $Board 的串口打不开（板子没插或已挂死）" -ForegroundColor Yellow }
    Write-Host "  等引导盘出现（最多 $BootWaitSec 秒）..."
    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalSeconds -lt $BootWaitSec) {
        Start-Sleep -Milliseconds 500
        $already = @(Get-BootDrives) | Where-Object { $_.Board -eq $Board } | Select-Object -First 1
        if ($already) { break }
    }
}
if (-not $already) {
    Write-Host "✗ 板子没进 BOOTSEL（若固件已挂死，后门收不到；需人手按 BOOTSEL）" -ForegroundColor Red
    exit 1
}

# ---- 拷入并等烧完 ----
Write-Host "拷贝到 $($already.Letter) ..." -ForegroundColor Cyan
Copy-Item $Firmware "$($already.Letter)\" -Force
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt $FlashWaitSec) {
    Start-Sleep -Milliseconds 700
    if (-not (Test-Path "$($already.Letter)\INFO_UF2.TXT")) { break }   # 盘消失 = 正在重启
}
Start-Sleep -Seconds 3
Write-Host "✓ 已刷入（$Board）" -ForegroundColor Green
Write-Host "  提示：重启后串口号可能变化，用 .\tools\ports.ps1 或本脚本不带参数再确认" -ForegroundColor DarkGray
