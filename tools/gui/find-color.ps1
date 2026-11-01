<#
.SYNOPSIS
  在一个窗口（或整屏）里找指定颜色的位置，返回可点的中心点。

.DESCRIPTION
  为什么需要：自绘 UI（canvas、游戏、Electron 自绘控件）既没有 UIA 控件树，
  也没有可靠的 DOM，唯一稳定线索就是**颜色**——按钮通常是固定配色。

  做法：抓一次图，按容差找同色像素，做连通域聚类，返回每个色块的
  外接矩形与中心点；再大也能用，因为只比较采样点。

.PARAMETER Hwnd
  窗口句柄；给 `screen` 则扫描整个虚拟桌面。

.PARAMETER Color
  `#RRGGBB` 或 `R,G,B`。

.PARAMETER Tolerance
  每个通道允许的偏差，默认 16。

.PARAMETER MinSize
  色块最小边长（像素），默认 6，用来滤掉抗锯齿噪点。

.PARAMETER Top
  返回前 N 个色块（按面积从大到小），默认 5。

.PARAMETER Json
  输出 JSON（含每个色块的 box/center/area）。

.EXAMPLE
  pwsh -File find-color.ps1 0x1234 '#0F6CBD'
  pwsh -File find-color.ps1 screen '#FF0000' -Tolerance 8
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Hwnd,
  [Parameter(Mandatory = $true, Position = 1)][string]$Color,
  [int]$Tolerance = 16,
  [int]$MinSize = 6,
  [int]$Top = 5,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

function ParseColor($s) {
  if ($s -match '^#?([0-9a-fA-F]{6})$') {
    $hex = $Matches[1]
    return @([Convert]::ToInt32($hex.Substring(0, 2), 16), [Convert]::ToInt32($hex.Substring(2, 2), 16), [Convert]::ToInt32($hex.Substring(4, 2), 16))
  }
  if ($s -match '^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$') {
    return @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  }
  throw "颜色格式应为 #RRGGBB 或 R,G,B：$s"
}

$want = ParseColor $Color
$tmp = Join-Path $env:TEMP ("findcolor-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.png')
$offX = 0; $offY = 0

if ($Hwnd -eq 'screen') {
  Add-Type -AssemblyName System.Windows.Forms
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $offX = $b.X; $offY = $b.Y
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, (New-Object System.Drawing.Size($b.Width, $b.Height)))
  $g.Dispose()
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
} else {
  # 复用 capture-window，保证和"看到的"是同一张图；窗口在前台就用屏幕截取，避开 WinUI3 的旧帧。
  if (-not ('FgProbe2' -as [type])) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FgProbe2 { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
  }
  $handle = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }
  $args = @('-File', (Join-Path $dir 'capture-window.ps1'), $Hwnd, $tmp)
  if ([FgProbe2]::GetForegroundWindow() -eq $handle) { $args += '-PreferScreen' }
  & pwsh -NoProfile @args 2>$null | Out-Null
  if (-not (Test-Path $tmp)) { [Console]::Error.WriteLine('[findcolor] 抓不到窗口图'); exit 3 }
}

$bmp = [System.Drawing.Bitmap]::FromFile($tmp)
$w = $bmp.Width; $h2 = $bmp.Height

# 2x2 采样 + 连通域（并查集简化为 BFS 网格）
$step = 2
$cols = [int][Math]::Ceiling($w / $step); $rows = [int][Math]::Ceiling($h2 / $step)
$hit = New-Object 'bool[,]' $cols, $rows
for ($gy = 0; $gy -lt $rows; $gy++) {
  for ($gx = 0; $gx -lt $cols; $gx++) {
    $px = [Math]::Min($gx * $step, $w - 1); $py = [Math]::Min($gy * $step, $h2 - 1)
    $c = $bmp.GetPixel($px, $py)
    if ([Math]::Abs($c.R - $want[0]) -le $Tolerance -and [Math]::Abs($c.G - $want[1]) -le $Tolerance -and [Math]::Abs($c.B - $want[2]) -le $Tolerance) {
      $hit[$gx, $gy] = $true
    }
  }
}
$bmp.Dispose()

$visited = New-Object 'bool[,]' $cols, $rows
$blobs = New-Object System.Collections.ArrayList
for ($gy = 0; $gy -lt $rows; $gy++) {
  for ($gx = 0; $gx -lt $cols; $gx++) {
    if (-not $hit[$gx, $gy] -or $visited[$gx, $gy]) { continue }
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($gx, $gy)); $visited[$gx, $gy] = $true
    $minX = $gx; $maxX = $gx; $minY = $gy; $maxY = $gy; $count = 0
    while ($queue.Count -gt 0) {
      $cur = $queue.Dequeue(); $cx = $cur[0]; $cy = $cur[1]; $count++
      if ($cx -lt $minX) { $minX = $cx }; if ($cx -gt $maxX) { $maxX = $cx }
      if ($cy -lt $minY) { $minY = $cy }; if ($cy -gt $maxY) { $maxY = $cy }
      foreach ($d in @(@(1, 0), @(-1, 0), @(0, 1), @(0, -1))) {
        $nx = $cx + $d[0]; $ny = $cy + $d[1]
        if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $cols -or $ny -ge $rows) { continue }
        if ($hit[$nx, $ny] -and -not $visited[$nx, $ny]) { $visited[$nx, $ny] = $true; $queue.Enqueue(@($nx, $ny)) }
      }
    }
    $bw = ($maxX - $minX + 1) * $step; $bh = ($maxY - $minY + 1) * $step
    if ($bw -lt $MinSize -or $bh -lt $MinSize) { continue }
    $left = $minX * $step; $top = $minY * $step
    [void]$blobs.Add([pscustomobject]@{
      x = $left + $offX; y = $top + $offY; w = $bw; h = $bh
      cx = [int]($left + $bw / 2) + $offX; cy = [int]($top + $bh / 2) + $offY
      area = $count * $step * $step
    })
  }
}

$sorted = $blobs | Sort-Object -Property area -Descending | Select-Object -First $Top

if ($Json) { $sorted | ConvertTo-Json -Depth 3 -AsArray; return }

"颜色 $Color 容差 $Tolerance → 找到 $($blobs.Count) 块，返回前 $($sorted.Count)"
$sorted | Format-Table -AutoSize @(
  @{ n = '中心'; e = { '{0},{1}' -f $_.cx, $_.cy } },
  @{ n = 'box'; e = { '{0},{1} {2}x{3}' -f $_.x, $_.y, $_.w, $_.h } },
  @{ n = 'area'; e = { $_.area } }
) | Out-String | Write-Output
if ($blobs.Count -eq 0) { [Console]::Error.WriteLine('[findcolor] 没找到该颜色的色块：换容差，或确认窗口真的显示了这个颜色') }

