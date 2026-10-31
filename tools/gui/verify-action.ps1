<#
.SYNOPSIS
  做一件事，然后证明它到底有没有发生（前后截图对比）。

.DESCRIPTION
  这是整套图形化能力的**验收环节**，直接针对"猜错了还不自知"：
  任何动作（点击、输入、按键）之后，都用**像素变化**给出一个客观结论。

  流程：抓窗口 → 执行 -Action → 等一下 → 再抓 → 比像素 → 给结论。

  结论只有三种，且必须明确：
    changed     有 X% 像素变化 ⇒ 动作生效
    unchanged   几乎没变      ⇒ **可能没点中/被禁用/点在空白处**
    error       抓不到图      ⇒ 无法判断（不猜）

.PARAMETER Hwnd
  窗口句柄。

.PARAMETER Command
  要执行的命令文本（用 -File 调用脚本时，scriptblock 传不进来，只能传字符串）。

.PARAMETER Threshold
  变化像素占比超过多少算"变了"，默认 0.1%。

.PARAMETER SettleMs
  动作后等多久再抓，默认 600 ms。

.EXAMPLE
  pwsh -File verify-action.ps1 0x1234 -Command "& '<dir>\click-at.ps1' 2000 300"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Hwnd,
  [Parameter(Mandatory = $true)][string]$Command,
  [double]$Threshold = 0.1,
  [int]$SettleMs = 600
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cap = Join-Path $dir 'capture-window.ps1'

function ShotPath($tag) { Join-Path $env:TEMP ("verify-$tag-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.png') }

$before = ShotPath 'before'
& pwsh -NoProfile -File $cap $Hwnd $before 2>$null | Out-Null
if (-not (Test-Path $before)) {
  [Console]::Error.WriteLine('[verify] 抓不到"动作前"的图，无法判断（不猜）')
  exit 3
}

# 基线：连续两张"什么都不做"的图，差异就是光标闪烁/动画的噪声。
# 没有这一步，"点空白处"会因为光标闪烁被判成 changed（实测 1.75%）。
$before2 = ShotPath 'base'
& pwsh -NoProfile -File $cap $Hwnd $before2 2>$null | Out-Null
$baseRatio = 0
if (Test-Path $before2) {
  $b1 = [System.Drawing.Bitmap]::FromFile($before)
  $b2 = [System.Drawing.Bitmap]::FromFile($before2)
  if ($b1.Width -eq $b2.Width -and $b1.Height -eq $b2.Height) {
    $st = [Math]::Max(1, [int]([Math]::Sqrt(($b1.Width * $b1.Height) / 20000.0)))
    $tt = 0; $dd = 0
    for ($y = 0; $y -lt $b1.Height; $y += $st) {
      for ($x = 0; $x -lt $b1.Width; $x += $st) {
        $tt++
        $p1 = $b1.GetPixel($x, $y); $p2 = $b2.GetPixel($x, $y)
        if ([Math]::Abs($p1.R - $p2.R) -gt 8 -or [Math]::Abs($p1.G - $p2.G) -gt 8 -or [Math]::Abs($p1.B - $p2.B) -gt 8) { $dd++ }
      }
    }
    if ($tt -gt 0) { $baseRatio = [Math]::Round(100.0 * $dd / $tt, 3) }
  }
  $b1.Dispose(); $b2.Dispose()
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$actionError = $null
try { Invoke-Expression $Command }
catch { $actionError = $_.Exception.Message }
$sw.Stop()

Start-Sleep -Milliseconds $SettleMs
$after = ShotPath 'after'
& pwsh -NoProfile -File $cap $Hwnd $after 2>$null | Out-Null
if (-not (Test-Path $after)) {
  [Console]::Error.WriteLine('[verify] 抓不到"动作后"的图 ⇒ 窗口可能已关闭/崩溃')
  exit 3
}

$b = [System.Drawing.Bitmap]::FromFile($before)
$a = [System.Drawing.Bitmap]::FromFile($after)

if ($b.Width -ne $a.Width -or $b.Height -ne $a.Height) {
  "changed reason=size-changed before=$($b.Width)x$($b.Height) after=$($a.Width)x$($a.Height) actionMs=$($sw.ElapsedMilliseconds) actionError=$actionError"
  $b.Dispose(); $a.Dispose()
  exit 0
}

# 采样比较：大图按步长抽样，够快也够敏感
$step = [Math]::Max(1, [int]([Math]::Sqrt(($b.Width * $b.Height) / 20000.0)))
$total = 0; $diff = 0
for ($y = 0; $y -lt $b.Height; $y += $step) {
  for ($x = 0; $x -lt $b.Width; $x += $step) {
    $total++
    $pb = $b.GetPixel($x, $y); $pa = $a.GetPixel($x, $y)
    if ([Math]::Abs($pb.R - $pa.R) -gt 8 -or [Math]::Abs($pb.G - $pa.G) -gt 8 -or [Math]::Abs($pb.B - $pa.B) -gt 8) { $diff++ }
  }
}
$b.Dispose(); $a.Dispose()

$ratio = if ($total -gt 0) { [Math]::Round(100.0 * $diff / $total, 3) } else { 0 }
$effective = [Math]::Max($Threshold, [Math]::Round($baseRatio * 3, 3))
$verdict = if ($ratio -ge $effective) { 'changed' } else { 'unchanged' }

"$verdict ratio=$ratio% (采样 $total 点，差异 $diff) threshold=$effective% base=$baseRatio% actionMs=$($sw.ElapsedMilliseconds) actionError=$actionError"
if ($verdict -eq 'unchanged') {
  [Console]::Error.WriteLine('[verify] 界面完全没变化 ⇒ 可能没点中、控件被禁用，或点在空白处。不要假设成功。')
}


