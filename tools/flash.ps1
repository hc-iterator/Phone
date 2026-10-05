<#
  一键烧写：优先找 CMSIS-DAP(SWD) 用 openocd 烧；SWD 不通就找 RP2350 的 BOOTSEL 盘拷 uf2。
  用法：
      .\tools\flash.ps1                          # 烧 build\PicoPhone.uf2/elf（当前构建）
      .\tools\flash.ps1 invonly_lane2_pin32      # 烧 build\perms\invonly_lane2_pin32.uf2
      .\tools\flash.ps1 perm3_lane012_34_36_32   # 烧某个排列
      .\tools\flash.ps1 D:\path\to\foo.uf2       # 直接给路径
  说明：
      * SWD 路线需要 .elf 或 .bin/.hex；对 .uf2 我会先在本脚本里转成 .bin（带 0x10000000 基址）。
      * BOOTSEL 路线直接拷 .uf2，最省事（但需要你按住 BOOTSEL 拔插 USB）。
#>
param(
    [Parameter(Position = 0)][string]$Image = "",
    [int]$Retries = 12,
    [int]$SettleMs = 1500
)
$ErrorActionPreference = 'Continue'

$root   = Split-Path -Parent $PSScriptRoot
$build  = Join-Path $root 'build'
$perms  = Join-Path $build 'perms'
$tmp    = Join-Path $env:TEMP 'pico_flash'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$sdk      = Join-Path $env:USERPROFILE '.pico-sdk'
$ocd      = Join-Path $sdk 'openocd\0.12.0+dev\openocd.exe'
$ocdScr   = Join-Path $sdk 'openocd\0.12.0+dev\scripts'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

# ---------------------------------------------------------------- 1) 找目标文件
$uf2 = $null; $elf = $null; $bin = $null
if ([string]::IsNullOrWhiteSpace($Image)) {
    $uf2 = Join-Path $build 'PicoPhone.uf2'
    $elf = Join-Path $build 'PicoPhone.elf'
} elseif (Test-Path $Image) {
    $uf2 = (Resolve-Path $Image).Path
} else {
    foreach ($d in @($perms, $build, $root)) {
        $p = Join-Path $d "$Image.uf2"
        if (Test-Path $p) { $uf2 = $p; break }
        $p = Join-Path $d "$Image.elf"
        if (Test-Path $p) { $elf = $p; break }
    }
}
if ($uf2) { $elf = [IO.Path]::ChangeExtension($uf2, '.elf') }
if (-not $uf2 -and -not $elf -and -not $bin) {
    Say "找不到映像：'$Image'。可选：" Yellow
    Get-ChildItem $perms -Filter '*.uf2' -ErrorAction SilentlyContinue | ForEach-Object { Say ("   " + $_.BaseName) }
    exit 1
}
if ($uf2) { Say ("映像: " + $uf2 + "  (" + [math]::Round((Get-Item $uf2).Length/1KB) + " KB)") Cyan }
elseif ($elf) { Say ("映像: " + $elf) Cyan }

# ------------------------------------------------- 2) 若只有 uf2，转成 bin 供 SWD 用
function Convert-Uf2ToBin($uf2Path, $binPath) {
    $bytes = [IO.File]::ReadAllBytes($uf2Path)
    $chunks = @{}
    $minAddr = [uint32]::MaxValue; $maxAddr = [uint32]::MinValue
    for ($o = 0; $o + 512 -le $bytes.Length; $o += 512) {
        $m0 = [BitConverter]::ToUInt32($bytes, $o)
        $m1 = [BitConverter]::ToUInt32($bytes, $o + 4)
        if ($m0 -ne 0x0A324655 -or $m1 -ne 0x9E5D5157) { continue }
        $addr = [BitConverter]::ToUInt32($bytes, $o + 12)
        $size = [BitConverter]::ToUInt32($bytes, $o + 16)
        if ($size -eq 0 -or $size -gt 476) { continue }
        $payload = New-Object byte[] $size
        [Array]::Copy($bytes, $o + 32, $payload, 0, $size)
        $chunks[[uint32]$addr] = $payload
        if ($addr -lt $minAddr) { $minAddr = $addr }
        if (($addr + $size) -gt $maxAddr) { $maxAddr = $addr + $size }
    }
    if ($chunks.Count -eq 0) { return $null }
    # 基址取最低地址；中间空洞填 0xFF
    $total = [int]($maxAddr - $minAddr)
    $out = New-Object byte[] $total
    for ($i = 0; $i -lt $total; $i++) { $out[$i] = 0xFF }
    foreach ($k in $chunks.Keys) {
        [Array]::Copy($chunks[$k], 0, $out, [int]($k - $minAddr), $chunks[$k].Length)
    }
    [IO.File]::WriteAllBytes($binPath, $out)
    return [uint32]$minAddr
}

# ---------------------------------------------------------------- 3) 优先看 BOOTSEL 盘
$vol = Get-Volume -ErrorAction SilentlyContinue |
       Where-Object { $_.FileSystemLabel -match 'RP2350|RPI-RP2' } | Select-Object -First 1
if ($vol) {
    $dst = "$($vol.DriveLetter):\"
    Say "发现 BOOTSEL 盘 $dst ⇒ 直接拷 uf2（最省事）" Green
    if (-not $uf2) { Say "但没有 .uf2 文件可拷（只有 elf）⇒ 改用 SWD" Yellow }
    else {
        Copy-Item $uf2 $dst -Force
        Say "已拷贝 ⇒ 板子会自动烧写并重启。做完后这块盘会消失。" Green
        exit 0
    }
}

# ---------------------------------------------------------------- 4) SWD 路线
if (-not (Test-Path $ocd)) { Say "找不到 openocd：$ocd" Red; exit 2 }
$base = $null
if ($uf2 -and -not (Test-Path $elf)) {
    $binPath = Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($uf2) + '.bin')
    $base = Convert-Uf2ToBin $uf2 $binPath
    if ($base) { Say ("已把 uf2 转成 bin（基址 0x{0:X8}）" -f $base) DarkGray }
}
$probe = Join-Path $tmp 'probe.cfg'
"adapter speed 1000`ninit`nexit`n" | Set-Content -Path $probe -Encoding ascii

Say "尝试 SWD（最多 $Retries 次）..." Cyan
$ok = $false
for ($i = 1; $i -le $Retries; $i++) {
    $o = & cmd /c "`"$ocd`" -s `"$ocdScr`" -f interface/cmsis-dap.cfg -f target/rp2350.cfg -f `"$probe`" 2>&1"
    if ($o -match 'DPIDR') { Say "  第 $i 次：SWD 通 ✓" Green; $ok = $true; break }
    Write-Host ("  第 {0} 次：不通，重试…" -f $i) -ForegroundColor DarkGray
    Start-Sleep -Milliseconds $SettleMs
}
if (-not $ok) {
    Say "SWD 连着 $Retries 次都不通。" Yellow
    Say "⇒ 请按住 BOOTSEL 拔插 USB（进 BOOT），脚本再跑一次就会走 U 盘那条路。" Yellow
    exit 3
}

$target = $elf
$progArgs = "`"$($elf -replace '\\','/')`" verify"
if (-not (Test-Path $elf)) {
    if (-not $base) { $binPath = Join-Path $tmp 'fw.bin'; $base = Convert-Uf2ToBin $uf2 $binPath }
    if (-not $base) { Say "无法从 uf2 得到 bin" Red; exit 4 }
    $target = $binPath
    $progArgs = "`"$($binPath -replace '\\','/')`" 0x{0:X8} verify" -f $base
}
$cfg = Join-Path $tmp 'flash.cfg'
@"
adapter speed 1000
init
reset halt
program $progArgs
reset run
shutdown
"@ | Set-Content -Path $cfg -Encoding ascii
$o2 = & cmd /c "`"$ocd`" -s `"$ocdScr`" -f interface/cmsis-dap.cfg -f target/rp2350.cfg -f `"$cfg`" 2>&1"
$v = ($o2 | Where-Object { $_ -match 'Verified|Error|timed out|cannot' })
$v | ForEach-Object { Say $_ }
if ($v -match 'Verified OK') { Say "`n✅ 烧写成功（SWD 路线）" Green; exit 0 }
else { Say "`n❌ 烧写失败" Red; exit 5 }
