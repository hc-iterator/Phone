<#
.SYNOPSIS
  把一个窗口（即使被遮挡）截成 PNG。

.DESCRIPTION
  图形化能力的第二层：**Agent 只拿它点名的那个窗口**，永远不拿整屏。

  原理：`PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)` 让窗口**自己重绘**到内存 DC，
  所以被其它窗口盖住也能拿到内容（DWM 合成的程序有效；独占全屏/DRM/最小化的除外）。

.PARAMETER Hwnd
  窗口句柄（十进制或 0x 十六进制）。

.PARAMETER OutFile
  输出 PNG 路径。

.PARAMETER MaxWidth
  超过这个宽度就等比缩小（默认 0 = 不缩）。给模型看时建议 ≤1280。

.NOTES
  失败情形：最小化（DWM 停止合成）、UAC/登录桌面、DRM 保护内容、部分独占全屏。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Hwnd,
  [Parameter(Mandatory = $true, Position = 1)][string]$OutFile,
  [int]$MaxWidth = 0
)

$ErrorActionPreference = 'Stop'
# 子进程默认走 GBK 控制台；不显式设 UTF-8，中文标题到父进程就是乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

if (-not ('GuiWinCapture' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class GuiWinCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  public const uint PW_RENDERFULLCONTENT = 2;

  // 真实可见边界（去掉 Win10+ 的不可见边框阴影）
  public static bool TryBounds(IntPtr h, out RECT r) {
    int rc = DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT)));
    if (rc == 0 && r.Right > r.Left && r.Bottom > r.Top) return true;
    return GetWindowRect(h, out r);
  }
}
'@
}

$handle = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }

if ([GuiWinCapture]::IsIconic($handle)) {
  [Console]::Error.WriteLine('[capture] 窗口已最小化：DWM 停止合成，通常拿不到内容。先还原再抓。')
  exit 3
}

$r = New-Object GuiWinCapture+RECT
if (-not [GuiWinCapture]::TryBounds($handle, [ref]$r)) {
  [Console]::Error.WriteLine('[capture] 拿不到窗口矩形（句柄无效？）')
  exit 2
}
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { [Console]::Error.WriteLine("[capture] 窗口尺寸非法 ${w}x${h}"); exit 2 }

$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = $false
try { $ok = [GuiWinCapture]::PrintWindow($handle, $hdc, [GuiWinCapture]::PW_RENDERFULLCONTENT) }
finally { $g.ReleaseHdc($hdc); }

$allBlack = $false
if (-not $ok) {
  # 有些程序不响应 PW_RENDERFULLCONTENT，退回到 0
  $hdc2 = $g.GetHdc()
  try { $ok = [GuiWinCapture]::PrintWindow($handle, $hdc2, 0) } finally { $g.ReleaseHdc($hdc2) }
}

# 抽查几个点，判断是不是全黑（DRM/不支持的常见表现）
$samples = @(
  @( [int]($w / 2), [int]($h / 2) ),
  @( [int]($w / 4), [int]($h / 4) ),
  @( [int]($w * 3 / 4), [int]($h * 3 / 4) )
)
$nonBlack = 0
foreach ($s in $samples) {
  try { $c = $bmp.GetPixel($s[0], $s[1]); if ($c.R -or $c.G -or $c.B) { $nonBlack++ } } catch {}
}
$allBlack = ($nonBlack -eq 0)

if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
  $scale = $MaxWidth / $w
  $nw = [int]($w * $scale); $nh = [int]($h * $scale)
  $small = New-Object System.Drawing.Bitmap($nw, $nh)
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $nw, $nh)
  $g2.Dispose()
  $bmp.Dispose()
  $bmp = $small
  $w = $nw; $h = $nh
}

$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $g.Dispose()

$bytes = (Get-Item $OutFile).Length
"captured hwnd=$($handle.ToInt64()) ${w}x${h} printWindow=$ok allBlack=$allBlack bytes=$bytes -> $OutFile"
if ($allBlack) { [Console]::Error.WriteLine('[capture] 抓到的图全黑：多半是 DRM/独占全屏/不支持的窗口。') }
exit 0

