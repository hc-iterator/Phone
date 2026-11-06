<#
.SYNOPSIS
  在屏幕坐标点一下（真实注入鼠标），用于"自绘 UI / 需要真点击"的兜底路径。

.DESCRIPTION
  优先级说明：能走 UIA Invoke 或 CDP click 的，**不要**用这个 ——
  它们不移动真实光标、不抢焦点。这个脚本只在两者都不行时用（canvas、游戏、自绘控件）。

  关键正确性：SendInput 的绝对坐标是**按整个虚拟桌面**归一化的 0..65535，
  不是单块屏、也不是主屏。所以这里先取虚拟桌面的左上角与宽高，再换算。
  副屏在主屏左侧时 X 为负，这里也处理了。

.PARAMETER X / Y
  目标屏幕坐标（虚拟桌面坐标系，可为负）。

.PARAMETER Button
  left / right / middle，默认 left。

.PARAMETER DoubleClick
  双击。

.PARAMETER Restore
  点完后把光标放回原处（默认 true）：不给用户留下"鼠标自己跑了"的感觉。

.EXAMPLE
  pwsh -File click-at.ps1 2000 300
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][int]$X,
  [Parameter(Mandatory = $true, Position = 1)][int]$Y,
  [ValidateSet('left', 'right', 'middle')][string]$Button = 'left',
  [switch]$DoubleClick,
  [bool]$Restore = $true,
  [string]$Hwnd = '',
  [ValidateSet('screen','window')][string]$Coord = 'screen'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('MouseIn' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class MouseIn {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public MOUSEINPUT mi; }

  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  public const int SM_XVIRTUALSCREEN = 76;
  public const int SM_YVIRTUALSCREEN = 77;
  public const int SM_CXVIRTUALSCREEN = 78;
  public const int SM_CYVIRTUALSCREEN = 79;

  public const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004,
                    RIGHTDOWN = 0x0008, RIGHTUP = 0x0010,
                    MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040,
                    ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;

  public static void Send(uint flags, int absX, int absY) {
    INPUT inp = new INPUT();
    inp.type = 0; // INPUT_MOUSE
    inp.mi.dx = absX;
    inp.mi.dy = absY;
    inp.mi.dwFlags = flags | MOVE | ABSOLUTE | VIRTUALDESK;
    SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
}

$vx = [MouseIn]::GetSystemMetrics([MouseIn]::SM_XVIRTUALSCREEN)
$vy = [MouseIn]::GetSystemMetrics([MouseIn]::SM_YVIRTUALSCREEN)
$vw = [MouseIn]::GetSystemMetrics([MouseIn]::SM_CXVIRTUALSCREEN)
$vh = [MouseIn]::GetSystemMetrics([MouseIn]::SM_CYVIRTUALSCREEN)

# 虚拟屏会把物理鼠标锁在主屏内（confine-cursor.ps1）；要点的坐标在锁外 ⇒ 临时解锁，点完再锁回去。
$confineScript = Join-Path $PSScriptRoot 'confine-cursor.ps1'
$primaryW = [MouseIn]::GetSystemMetrics(0)
$primaryH = [MouseIn]::GetSystemMetrics(1)
$needsUnclip = ($X -ge $primaryW -or $Y -ge $primaryH -or $X -lt 0 -or $Y -lt 0)
if ($needsUnclip -and (Test-Path $confineScript)) {
  & pwsh -NoProfile -File $confineScript -Off 2>$null | Out-Null
}

# 两种坐标系必须显式区分（否则"我点的 100,50"到底是屏幕还是窗口，全靠猜）：
#   screen = 虚拟桌面绝对坐标（默认）
#   window = 相对窗口左上角（需同时给 -Hwnd）
if ($Coord -eq 'window') {
  if ($Hwnd -eq '') { [Console]::Error.WriteLine('[click] -Coord window 必须同时给 -Hwnd'); exit 2 }
  if (-not ('ClickRect' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ClickRect {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  public static RECT Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0) return r;
    GetWindowRect(h, out r); return r;
  }
}
"@
  }
  $hh = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }
  $wr = [ClickRect]::Bounds($hh)
  $X = $wr.Left + $X; $Y = $wr.Top + $Y
  "coords: window-relative -> screen ($X,$Y) using origin $($wr.Left),$($wr.Top)"
}

if ($X -lt $vx -or $Y -lt $vy -or $X -ge ($vx + $vw) -or $Y -ge ($vy + $vh)) {
  [Console]::Error.WriteLine("[click] ($X,$Y) 不在虚拟桌面 $vx,$vy ${vw}x${vh} 内")
  exit 2
}

# 归一化到 0..65535（整块虚拟桌面）
$ax = [int](($X - $vx) * 65535 / [Math]::Max(1, $vw - 1))
$ay = [int](($Y - $vy) * 65535 / [Math]::Max(1, $vh - 1))

# 鼠标操作自带激活：先把目标窗口切到前台，再点。
# 这样"点"和"后续输入"作用在同一个窗口上，不会串到用户正在用的窗口。
if ($Hwnd -ne '') {
  if (-not ('ClickFg' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ClickFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static bool Force(IntPtr h) {
    if (GetForegroundWindow() == h) return true;
    // 前台锁（Windows 前台保护）会让 SetForegroundWindow 静默失败；先模拟一次 ALT 轻点，
    // 系统就把"下一个 SetForegroundWindow"当作用户意图放行。
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return true;
    uint ft = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint me = GetCurrentThreadId();
    bool at = AttachThreadInput(me, ft, true);
    SetForegroundWindow(h);
    if (at) AttachThreadInput(me, ft, false);
    return GetForegroundWindow() == h;
  }
}
"@
  }
  $h = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }
  if (-not [ClickFg]::Force($h)) { [Console]::Error.WriteLine('[click] 无法激活目标窗口'); exit 3 }
  Start-Sleep -Milliseconds 150
}

$orig = New-Object MouseIn+POINT
[void][MouseIn]::GetCursorPos([ref]$orig)

$down = switch ($Button) { 'left' { [MouseIn]::LEFTDOWN } 'right' { [MouseIn]::RIGHTDOWN } default { [MouseIn]::MIDDLEDOWN } }
$up = switch ($Button) { 'left' { [MouseIn]::LEFTUP } 'right' { [MouseIn]::RIGHTUP } default { [MouseIn]::MIDDLEUP } }

for ($i = 0; $i -lt $(if ($DoubleClick) { 2 } else { 1 }); $i++) {
  [MouseIn]::Send([uint32]$down, $ax, $ay)
  Start-Sleep -Milliseconds 40
  [MouseIn]::Send([uint32]$up, $ax, $ay)
  if ($DoubleClick) { Start-Sleep -Milliseconds 60 }
}

if ($needsUnclip -and (Test-Path $confineScript)) {
  & pwsh -NoProfile -File $confineScript -On 2>$null | Out-Null
}

if ($Restore) {
  Start-Sleep -Milliseconds 60
  [void][MouseIn]::SetCursorPos($orig.X, $orig.Y)
}

"clicked ($X,$Y) button=$Button double=$($DoubleClick.IsPresent) abs=$ax,$ay vdesk=$vx,$vy ${vw}x${vh} restored=$Restore"




