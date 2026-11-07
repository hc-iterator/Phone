<#
.SYNOPSIS
  虚拟屏上的窗口被"从任务栏点中"时，把它搬到主屏。

.DESCRIPTION
  背景：任务栏只画在主屏，却会列出虚拟屏上的窗口。点它的图标，Windows 只会把焦点给那个
  窗口——窗口仍然留在虚拟屏（用户看不见），表现就是"点了没反应"。

  摘掉图标不可行（那样连切回它的入口都没了）。所以反过来：**保留图标，点它就搬过来**。

  怎么判断"是用户点了任务栏"：窗口变成前台的同一时刻，**光标停在任务栏矩形内**。
    · 用户点任务栏图标 ⇒ 光标就在任务栏上 ⇒ 搬家
    · 我们自己的工具激活虚拟屏窗口（点击/输入）⇒ 光标在虚拟屏坐标上 ⇒ 不搬
  任务栏矩形实时取 Shell_TrayWnd / Shell_SecondaryTrayWnd，换主题/改大小都不会失效。

.PARAMETER Watch
  循环监视（keeper 里就是这种方式调用）。不给就只检查一次。

.PARAMETER IntervalMs
  轮询间隔，默认 100 毫秒。

.PARAMETER Log
  动作日志路径（默认 %TEMP%\gui-bring.log），便于事后核对"到底搬了没"。
#>
[CmdletBinding()]
param(
  [switch]$Watch,
  [int]$IntervalMs = 100,
  [string]$Log = (Join-Path $env:TEMP 'gui-bring.log')
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

if (-not ('Bring' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class Bring {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);

  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
  }
  public const uint MONITOR_DEFAULTTONEAREST = 2;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;

  /// 窗口是否"不在主屏"。用中心点判断，避免被 DWM 边框误导。
  public static bool IsOffPrimary(IntPtr h, RECT primary) {
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    int cx = (r.Left + r.Right) / 2, cy = (r.Top + r.Bottom) / 2;
    bool onPrimary = cx >= primary.Left && cx < primary.Right && cy >= primary.Top && cy < primary.Bottom;
    return !onPrimary;
  }

  /// 把窗口搬到主屏居中（保持大小，放不下就缩到工作区）。
  public static bool MoveToPrimary(IntPtr h, RECT primary) {
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    int w = r.Right - r.Left, hgt = r.Bottom - r.Top;
    if (w <= 0 || hgt <= 0) return false;
    IntPtr mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    int maxW = primary.Right - primary.Left, maxH = primary.Bottom - primary.Top;
    if (GetMonitorInfo(mon, ref mi)) {
      maxW = mi.rcWork.Right - mi.rcWork.Left;
      maxH = mi.rcWork.Bottom - mi.rcWork.Top;
    }
    if (w > maxW) w = maxW;
    if (hgt > maxH) hgt = maxH;
    int x = primary.Left + (primary.Right - primary.Left - w) / 2;
    int y = primary.Top + (primary.Bottom - primary.Top - hgt) / 2;
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    return SetWindowPos(h, IntPtr.Zero, x, y, w, hgt, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }

  /// 光标是否落在任务栏（主任务栏或副屏任务栏、或它的溢出/托盘子窗口里）。
  public static bool CursorOnTaskbar() {
    POINT p; GetCursorPos(out p);
    IntPtr tb = FindWindow("Shell_TrayWnd", null);
    if (tb != IntPtr.Zero) {
      RECT r;
      if (GetWindowRect(tb, out r) && p.X >= r.Left && p.X <= r.Right && p.Y >= r.Top && p.Y <= r.Bottom) return true;
    }
    IntPtr stb = FindWindow("Shell_SecondaryTrayWnd", null);
    if (stb != IntPtr.Zero) {
      RECT r;
      if (GetWindowRect(stb, out r) && p.X >= r.Left && p.X <= r.Right && p.Y >= r.Top && p.Y <= r.Bottom) return true;
    }
    // 托盘弹出面板（点 ^ 展开后光标在面板里，也算"从任务栏点出来的")
    IntPtr top = FindWindow("TopLevelWindowForOverflowXaml", null);
    if (top != IntPtr.Zero) {
      RECT r;
      if (GetWindowRect(top, out r) && p.X >= r.Left && p.X <= r.Right && p.Y >= r.Top && p.Y <= r.Bottom) return true;
    }
    return false;
  }

  public static string Title(IntPtr h) {
    var sb = new System.Text.StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }
  public static string ClassOf(IntPtr h) {
    var sb = new System.Text.StringBuilder(256);
    GetClassName(h, sb, 256);
    return sb.ToString();
  }
}
'@
}

$screens = [System.Windows.Forms.Screen]::AllScreens
$primary = ($screens | Where-Object { $_.Primary } | Select-Object -First 1).Bounds
$primaryRect = New-Object Bring+RECT
$primaryRect.Left = $primary.Left; $primaryRect.Top = $primary.Top
$primaryRect.Right = $primary.Right; $primaryRect.Bottom = $primary.Bottom

# 不搬这些（任务栏自己、桌面外壳、输入法候选）
$skipClasses = @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Progman', 'WorkerW', 'Windows.UI.Core.CoreWindow')

function Check-Once {
  $fg = [Bring]::GetForegroundWindow()
  if ($fg -eq [IntPtr]::Zero) { return $null }
  $cls = [Bring]::ClassOf($fg)
  if ($skipClasses -contains $cls) { return $null }
  if (-not [Bring]::IsWindowVisible($fg)) { return $null }
  if (-not [Bring]::IsOffPrimary($fg, $primaryRect)) { return $null }
  # 关键判据：光标在任务栏上 ⇒ 用户刚点了任务栏图标
  if (-not [Bring]::CursorOnTaskbar()) { return $null }
  $title = [Bring]::Title($fg)
  if ([Bring]::MoveToPrimary($fg, $primaryRect)) {
    return "bring: 0x$($fg.ToInt64().ToString('X')) [$title]"
  }
  return $null
}

function Append-Log([string]$line) {
  try { ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $line) | Out-File -FilePath $Log -Encoding utf8 -Append } catch { }
}

if (-not $Watch) {
  $r = Check-Once
  if ($r) { $r; Append-Log $r } else { 'no-op' }
  exit 0
}

$lastFg = [IntPtr]::Zero
while ($true) {
  $fg = [Bring]::GetForegroundWindow()
  if ($fg -ne $lastFg) {
    $lastFg = $fg
    $r = Check-Once
    if ($r) { $r; Append-Log $r }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
