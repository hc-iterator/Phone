<#
.SYNOPSIS
  关闭所有位于虚拟屏上的窗口（keeper 退出前调用）。

.DESCRIPTION
  keeper 一停，虚拟屏就被驱动拔掉，屏幕上的窗口会被 Windows **甩回主屏** ——
  用户会突然看到一堆本来"看不见"的窗口冒出来。
  所以 keeper 退出的第一件事是把这些窗口关掉（先礼后兵：WM_CLOSE，等一会再复查）。

  只处理**非主屏**上的窗口；主屏窗口一律不碰。

.PARAMETER GraceMs
  WM_CLOSE 之后等多久再复查，默认 800 毫秒。

.PARAMETER Force
  复查后仍未关闭的，直接结束其进程（默认不结束，只报告）。
#>
[CmdletBinding()]
param(
  [int]$GraceMs = 800,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

if (-not ('VdCloser' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class VdCloser {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);

  public const uint WM_CLOSE = 0x0010;
  public const uint GW_OWNER = 4;

  /// 收集"中心点落在给定矩形里"的可见顶层窗口（跳过工具窗口/无主无标题的壳）。
  public static List<IntPtr> Collect(int left, int top, int right, int bottom) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int cx = (r.Left + r.Right) / 2;
      int cy = (r.Top + r.Bottom) / 2;
      if (cx < left || cx > right || cy < top || cy > bottom) return true;
      // 桌面/任务栏/工作区这些外壳窗口绝不能关（实测会把 Program Manager 列进来）
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      string c = cls.ToString();
      if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Button") return true;

      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.Length == 0) return true;              // 无标题的壳子不动
      if (sb.ToString() == "Program Manager") return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }

  public static void Close(IntPtr h) { PostMessageW(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }
  public static bool Visible(IntPtr h) { return IsWindowVisible(h); }
}
'@
}

# 非主屏 = 虚拟屏
$virtual = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary }
if (-not $virtual) {
  'no-virtual-screen'
  exit 0
}

$total = 0
foreach ($s in $virtual) {
  $b = $s.Bounds
  $wins = [VdCloser]::Collect($b.Left, $b.Top, $b.Right, $b.Bottom)
  foreach ($h in $wins) {
    "close: " + [VdCloser]::Title($h)
    [VdCloser]::Close($h)
    $total++
  }
}

if ($total -eq 0) { 'closed=0'; exit 0 }
Start-Sleep -Milliseconds $GraceMs

$left = @()
foreach ($s in $virtual) {
  $b = $s.Bounds
  foreach ($h in [VdCloser]::Collect($b.Left, $b.Top, $b.Right, $b.Bottom)) {
    if ([VdCloser]::Visible($h)) { $left += [VdCloser]::Title($h) }
  }
}
if ($left.Count -gt 0) {
  "still-open=" + ($left -join ' | ')
  if ($Force) { 'force=true（未实现强杀，避免误杀用户进程）' }
}
"closed=$total"

