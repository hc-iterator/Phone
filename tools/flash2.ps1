<#
  烧写（可靠版）：
    ① 若有 RP2350 BOOTSEL 盘 ⇒ 直接拷 uf2（最可靠）
    ② 否则走 SWD，带重试；【每次结束都 resume】（否则会把核心留在停止状态，害死下一次测量！）
  用法：
      .\tools\flash2.ps1                       # 烧 build\PicoPhone.elf/uf2
      .\tools\flash2.ps1 build\perms2\xxx.uf2  # 烧指定文件
      .\tools\flash2.ps1 -NoBootsel            # 强制走 SWD
#>
param(
    [Parameter(Position=0)][string]$Image = "",
    [int]$Retries = 12,
    [switch]$NoBootsel
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$tl  = Join-Path $env:USERPROFILE '.pico-sdk\toolchain\14_2_Rel1\bin'
$ocd = Join-Path $env:USERPROFILE '.pico-sdk\openocd\0.12.0+dev\openocd.exe'
$scr = Join-Path $env:USERPROFILE '.pico-sdk\openocd\0.12.0+dev\scripts'
$tmp = Join-Path $env:TEMP 'pico_flash'; New-Item -ItemType Directory -Force -Path $tmp | Out-Null
function Say($m, $c='Gray') { Write-Host $m -ForegroundColor $c }

$uf2 = $null; $elf = $null
if ([string]::IsNullOrWhiteSpace($Image)) {
    $uf2 = Join-Path $root 'build\PicoPhone.uf2'; $elf = Join-Path $root 'build\PicoPhone.elf'
} elseif (Test-Path $Image) {
    $p = (Resolve-Path $Image).Path
    if ($p -like '*.uf2') { $uf2 = $p } else { $elf = $p }
} else {
    foreach ($d in @((Join-Path $root 'build\perms2'), (Join-Path $root 'build\perms'), (Join-Path $root 'build'))) {
        if (Test-Path (Join-Path $d "$Image.uf2")) { $uf2 = Join-Path $d "$Image.uf2"; break }
        if (Test-Path (Join-Path $d "$Image.elf")) { $elf = Join-Path $d "$Image.elf"; break }
    }
}
if (-not $uf2 -and -not $elf) { Say "找不到映像 '$Image'" Yellow; exit 1 }
if ($uf2) { Say ("映像: " + $uf2) Cyan } else { Say ("映像: " + $elf) Cyan }

# ① BOOTSEL 优先
if (-not $NoBootsel) {
    $vol = Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.FileSystemLabel -match 'RP2350|RPI-RP2' } | Select-Object -First 1
    if ($vol -and $uf2) {
        Say "发现 BOOTSEL 盘 $($vol.DriveLetter): ⇒ 直接拷 uf2" Green
        Copy-Item $uf2 "$($vol.DriveLetter):\" -Force
        Say "已拷贝 ✓（板子会自动烧写并重启）" Green
        exit 0
    }
}
# ② SWD
if (-not $elf) { Say "SWD 路线需要 .elf；只有 uf2 时请走 BOOTSEL" Yellow; exit 1 }
$probe = Join-Path $tmp 'probe.cfg'
"adapter speed 500`ninit`nexit`n" | Set-Content -Path $probe -Encoding ascii
$ok = $false
for ($i = 1; $i -le $Retries; $i++) {
    $o = & cmd /c "`"$ocd`" -s `"$scr`" -f interface/cmsis-dap.cfg -f target/rp2350.cfg -f `"$probe`" 2>&1"
    if ($o -match 'DPIDR') { Say "  第 $i 次：SWD 通 ✓" Green; $ok = $true; break }
    Start-Sleep -Milliseconds 1500
}
if (-not $ok) { Say "SWD 连着 $Retries 次不通 ⇒ 请进 BOOTSEL 再跑一次" Yellow; exit 3 }
$cfg = Join-Path $tmp 'flash2.cfg'
@"
adapter speed 500
init
reset halt
program $($elf -replace '\\','/') verify
reset run
shutdown
"@ | Set-Content -Path $cfg -Encoding ascii
$o2 = & cmd /c "`"$ocd`" -s `"$scr`" -f interface/cmsis-dap.cfg -f target/rp2350.cfg -f `"$cfg`" 2>&1"
$v = $o2 | Where-Object { $_ -match 'Verified|Error|timed out|cannot' }
$v | ForEach-Object { Say $_ }
if ($v -match 'Verified OK') { Say "`n✅ 烧写成功" Green; exit 0 } else { Say "`n❌ 烧写失败" Red; exit 5 }
