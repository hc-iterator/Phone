<#
.SYNOPSIS
  把一个窗口挪到指定位置/虚拟屏，**不抢焦点**。

.DESCRIPTION
  为什么需要：Agent 开的窗口默认落在主屏，会挡在用户眼前。有了虚拟屏（Parsec VDD 的
  DISPLAY19 / @1920,0）之后，所有 Agent 窗口都应该被挪过去 —— 用户看不见，
  但它始终处于合成状态，截图和 UIA 都正常。

  关键：用 `SWP_NOACTIVATE` + `HWND_TOP`，**不改变前台窗口**，
  这样不会打断用户正在做的事（这是"不打扰"的核心）。

.PARAMETER Hwnd
  窗口句柄（十进制或 0x）。

.PARAMETER Virtual
  挪到"非主屏"那块（即虚拟屏）。默认行为。

.PARAMETER X / Y / W / H
  显式指定位置与尺寸；给 Y 不给 H 时保持原高。

.PARAMETER MonitorIndex
  指定显示器序号（0 = 主屏，1 = 第二块），与 -Virtual 二选一。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Hwnd,
  [switch]$Virtual,
  [int]$X = [int]::MinValue,
  [int]$Y = [int]::MinValue,
  [int]$W = 0,
  [int]$H = 0,
  [int]$MonitorIndex = -1
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

if (-not ('WinPlace' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class WinPlace {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);

  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;

  public static bool Move(IntPtr h, int x, int y, int w, int hh) {
    return SetWindowPos(h, IntPtr.Zero, x, y, w, hh,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
}
'@
}

$handle = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }

# 目标屏
$screens = [System.Windows.Forms.Screen]::AllScreens
$target = $null
if ($MonitorIndex -ge 0) {
  $all = $screens | Sort-Object DeviceName
  if ($MonitorIndex -lt $all.Count) { $target = $all[$MonitorIndex] }
} elseif ($Virtual) {
  # 非主屏里优先选"最右边那块"（Parsec 虚拟屏默认接在主屏右侧）
  $nonPrimary = $screens | Where-Object { -not $_.Primary }
  if ($nonPrimary) { $target = $nonPrimary | Sort-Object { $_.Bounds.X } -Descending | Select-Object -First 1 }
}
if ($null -eq $target) {
  $nonPrimary = $screens | Where-Object { -not $_.Primary }
  if ($nonPrimary) { $target = $nonPrimary | Sort-Object { $_.Bounds.X } -Descending | Select-Object -First 1 }
}
if ($null -eq $target) {
  [Console]::Error.WriteLine('[place] 没有第二块屏（虚拟屏没起来？先跑 vdd.ps1 -Serve）')
  exit 2
}

$r = New-Object WinPlace+RECT
[void][WinPlace]::GetWindowRect($handle, [ref]$r)
$curW = $r.Right - $r.Left; $curH = $r.Bottom - $r.Top

$nx = if ($X -ne [int]::MinValue) { $X } else { $target.Bounds.X + 40 }
$ny = if ($Y -ne [int]::MinValue) { $Y } else { $target.Bounds.Y + 40 }
$nw = if ($W -gt 0) { $W } else { [Math]::Min($curW, $target.Bounds.Width - 80) }
$nh = if ($H -gt 0) { $H } else { [Math]::Min($curH, $target.Bounds.Height - 80) }

# 实测：刚启动的程序 SetWindowPos 会偶发失败（窗口正在重建/还没稳定），
# 一次失败就放弃会让窗口留在主屏上（用户会看到）。所以重试并**核对结果**。
$ok = $false
for ($try = 1; $try -le 5; $try++) {
  $ok = [WinPlace]::Move($handle, $nx, $ny, $nw, $nh)
  Start-Sleep -Milliseconds 120
  [void][WinPlace]::GetWindowRect($handle, [ref]$r)
  $nowX = $r.Left; $nowY = $r.Top
  if ($nowX -eq $nx -and $nowY -eq $ny) { break }
  if (-not $ok) { Start-Sleep -Milliseconds 200 }
}
[void][WinPlace]::GetWindowRect($handle, [ref]$r)
if ($r.Left -ne $nx -or $r.Top -ne $ny) {
  [Console]::Error.WriteLine("[place] 挪动没生效：想去 $nx,$ny，实际 $($r.Left),$($r.Top)（窗口可能已销毁或拒绝移动）")
  exit 3
}
"placed hwnd=$($handle.ToInt64()) -> screen=$($target.DeviceName) rect=$($r.Left),$($r.Top) $($r.Right - $r.Left)x$($r.Bottom - $r.Top)"

