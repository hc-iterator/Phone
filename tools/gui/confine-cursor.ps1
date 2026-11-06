<#
.SYNOPSIS
  把物理鼠标限制在主屏内（不让它滑进虚拟屏），或解除限制。

.DESCRIPTION
  问题：虚拟显示器挂在 @1920,0，但它是**看不见的**。鼠标一旦滑进去，用户就"丢了指针"——
  没有物理边框挡着它，这是虚拟屏特有的坑（真副屏至少有屏幕边缘）。

  做法：`ClipCursor()` 把光标裁剪到主屏矩形。物理鼠标撞到 1919 就停住，滑不过去。

  为什么不是"改显示设置"：那需要每次插拔都调，而且会影响窗口重排；
  ClipCursor 是进程内的、即时的、退出即恢复。

  ⚠️ 裁剪对**合成的鼠标事件同样生效**，所以 Agent 要点虚拟屏时必须先解锁：
  `click-at.ps1` 已经内置了这个处理（目标在主屏外 ⇒ 临时解锁 → 点 → 重新锁）。

.PARAMETER On
  裁剪到主屏。

.PARAMETER Off
  解除裁剪。

.PARAMETER Status
  打印当前裁剪矩形（没有则显示 none）。
#>
[CmdletBinding()]
param(
  [switch]$On,
  [switch]$Off,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('CursorClip' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class CursorClip {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }

  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr rect);
  [DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);

  public const int SM_CXSCREEN = 0;
  public const int SM_CYSCREEN = 1;

  /// 裁剪到主屏（主屏原点恒为 0,0）。
  public static void ToPrimary() {
    RECT r = new RECT();
    r.Left = 0; r.Top = 0;
    r.Right = GetSystemMetrics(SM_CXSCREEN);
    r.Bottom = GetSystemMetrics(SM_CYSCREEN);
    IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RECT)));
    try { Marshal.StructureToPtr(r, p, false); ClipCursor(p); }
    finally { Marshal.FreeHGlobal(p); }
  }

  public static void Release() { ClipCursor(IntPtr.Zero); }

  public static void ToRect(int l, int t, int r, int b) {
    RECT rc = new RECT(); rc.Left = l; rc.Top = t; rc.Right = r; rc.Bottom = b;
    IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RECT)));
    try { Marshal.StructureToPtr(rc, p, false); ClipCursor(p); } finally { Marshal.FreeHGlobal(p); }
  }

  public static string Describe() {
    RECT r;
    if (!GetClipCursor(out r)) return "none";
    int w = r.Right - r.Left, h = r.Bottom - r.Top;
    int vw = GetSystemMetrics(78); int vh = GetSystemMetrics(79);
    if (vw <= 0) vw = GetSystemMetrics(SM_CXSCREEN);
    if (w >= vw && h >= (vh > 0 ? vh : GetSystemMetrics(1))) return "none";
    return string.Format("{0},{1} {2}x{3}", r.Left, r.Top, w, h);
  }
}
'@
}

if ($Status -or (-not $On -and -not $Off)) {
  $cur = [CursorClip]::Describe()
  $p = New-Object CursorClip+POINT
  [void][CursorClip]::GetCursorPos([ref]$p)
  "clip=$cur cursor=$($p.X),$($p.Y) primary=$([CursorClip]::GetSystemMetrics(0))x$([CursorClip]::GetSystemMetrics(1))"
  exit 0
}

if ($On) {
  # 如果光标此刻已经在虚拟屏里，先把它拉回主屏，否则裁剪会把"屏幕外的点"也锁进去
  $p = New-Object CursorClip+POINT
  [void][CursorClip]::GetCursorPos([ref]$p)
  $w = [CursorClip]::GetSystemMetrics(0); $h = [CursorClip]::GetSystemMetrics(1)
  if ($p.X -ge $w -or $p.Y -ge $h -or $p.X -lt 0 -or $p.Y -lt 0) {
    [void][CursorClip]::SetCursorPos([int]($w / 2), [int]($h / 2))
  }
  [CursorClip]::ToPrimary()
  "clip=on " + [CursorClip]::Describe()
  exit 0
}

# ClipCursor(NULL) 在某些情况下不会真正解除（实测：调完仍报 0,0 1920x1080）。
# 更可靠的做法是显式裁剪到**整个虚拟桌面**。
$vx = [CursorClip]::GetSystemMetrics(76); $vy = [CursorClip]::GetSystemMetrics(77)
$vw = [CursorClip]::GetSystemMetrics(78); $vh = [CursorClip]::GetSystemMetrics(79)
if ($vw -le 0) { $vw = [CursorClip]::GetSystemMetrics(0) }
if ($vh -le 0) { $vh = [CursorClip]::GetSystemMetrics(1) }
[CursorClip]::ToRect($vx, $vy, $vx + $vw, $vy + $vh)
"clip=off (virtual $vx,$vy ${vw}x${vh})"

