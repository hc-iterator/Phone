<#
.SYNOPSIS
  关闭一个窗口（等价于点它的 ×），并验证它是否真的消失。

.DESCRIPTION
  为什么单独做一个：UIA 对 WinUI3/自绘窗口（任务管理器、部分 Electron/CEF）只暴露 Pane，
  标题栏的关闭按钮根本不在可访问树里，`uia-invoke` 没法点。
  这时只剩两条路：坐标点 ×（脆弱，窗口一动就偏）或直接发关闭消息（本脚本）。

  做法（先礼后兵，都不杀进程）：
    1. PostMessage(WM_CLOSE)                —— 与点 × 完全同一条消息
    2. 等 GraceMs，还活着就 PostMessage(WM_SYSCOMMAND, SC_CLOSE) —— 有些窗口只理后者
    3. 再等，仍活着就报告失败（**不** TerminateProcess，那会让应用丢未保存数据）
  最后用 IsWindow 复核，返回明确结论，避免"以为关了其实没关"。

.PARAMETER Hwnd
  窗口句柄（0x 十六进制或十进制）。

.PARAMETER GraceMs
  每一步之后等多久，默认 800 毫秒。

.PARAMETER Force
  最后一步允许 TerminateProcess（默认关闭；会让应用丢未保存数据，慎用）。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Hwnd,
  [int]$GraceMs = 800,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('Closer' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Closer {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  public const uint WM_CLOSE = 0x0010;
  public const uint WM_SYSCOMMAND = 0x0112;
  public const int SC_CLOSE = 0xF060;

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }
}
'@
}

$h = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }
if (-not [Closer]::IsWindow($h)) { [Console]::Error.WriteLine("[close] 不是有效窗口：$Hwnd"); exit 3 }

$title = [Closer]::Title($h)
"target: 0x$($h.ToInt64().ToString('X')) [$title]"

# 步骤 1：WM_CLOSE（和点 × 完全同一条消息）
[void][Closer]::PostMessageW($h, [Closer]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds $GraceMs
if (-not [Closer]::IsWindow($h)) { "closed=yes via WM_CLOSE"; exit 0 }

# 步骤 2：还没关，试系统菜单的"关闭"（部分窗口只理这个）
[void][Closer]::PostMessageW($h, [Closer]::WM_SYSCOMMAND, [IntPtr][int][Closer]::SC_CLOSE, [IntPtr]::Zero)
Start-Sleep -Milliseconds $GraceMs
if (-not [Closer]::IsWindow($h)) { "closed=yes via SC_CLOSE"; exit 0 }

# 步骤 3：仍活着
if ($Force) {
  $pid2 = 0
  [void][Closer]::GetWindowThreadProcessId($h, [ref]$pid2)
  try {
    Stop-Process -Id $pid2 -Force -ErrorAction Stop
    "closed=forced pid=$pid2"
    exit 0
  } catch {
    [Console]::Error.WriteLine("[close] 强杀失败：$($_.Exception.Message)")
    exit 5
  }
}

[Console]::Error.WriteLine("[close] 窗口拒绝关闭（可能正在弹确认框，或程序自己拦截了 WM_CLOSE）：[$title]")
"closed=no"
exit 4
