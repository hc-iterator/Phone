<#
.SYNOPSIS
  列出当前所有顶层窗口（可抓屏的那种），输出 JSON。

.DESCRIPTION
  图形化能力的第一层：**先告诉 Agent"有哪些窗口"**，再由它点名要哪个。
  Agent 永远拿不到整屏，只拿它点名的那个窗口。

  字段说明：
    hwnd      窗口句柄（十进制；十六进制见 hwndHex）
    title     标题（空标题的窗口通常没用，默认过滤）
    pid       进程号
    process   进程名
    rect      { x, y, w, h }（x/y 为屏幕坐标，可为负——副屏在左侧时就是这样）
    minimized 是否最小化（最小化的窗口通常抓不到内容）
    visible   是否可见

.NOTES
  - 用 EnumWindows 枚举顶层窗口；子窗口/控件由 UIA 那层处理。
  - 过滤掉 0×0、无标题、以及 shell 上那几个伪窗口。
#>
[CmdletBinding()]
param(
  [switch]$IncludeUntitled,
  [switch]$All,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
# 子进程默认走 GBK 控制台；不显式设 UTF-8，中文标题到父进程就是乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('GuiWinEnum' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class GuiWinEnum {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  public static List<IntPtr> All() {
    var list = new List<IntPtr>();
    EnumWindows((h, p) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
'@
}

$rows = @()
foreach ($h in [GuiWinEnum]::All()) {
  $len = [GuiWinEnum]::GetWindowTextLength($h)
  $sb = New-Object System.Text.StringBuilder ([Math]::Max(2, $len + 2))
  [void][GuiWinEnum]::GetWindowText($h, $sb, $sb.Capacity)
  $title = $sb.ToString()
  if (-not $IncludeUntitled -and [string]::IsNullOrWhiteSpace($title)) { continue }

  $r = New-Object GuiWinEnum+RECT
  if (-not [GuiWinEnum]::GetWindowRect($h, [ref]$r)) { continue }
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  if ($w -le 0 -or $ht -le 0) { continue }

  $procId = 0
  [void][GuiWinEnum]::GetWindowThreadProcessId($h, [ref]$procId)
  $procName = ''
  try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $procName = "pid$procId" }

  # 默认只留"真窗口"：可见、非最小化、够大、不是 shell 伪窗口/辅助隐藏窗口。
  if (-not $All) {
    if (-not [GuiWinEnum]::IsWindowVisible($h)) { continue }
    if ([GuiWinEnum]::IsIconic($h)) { continue }
    if ($w -lt 80 -or $ht -lt 60) { continue }
    if ($title -match '^(GDI\+ Window|DWM Notification Window|Task Host Window|Program Manager|Window|Form|.NotificationWindowHelper|WxTrayIconMessageWindow)') { continue }
  }

  $rows += [pscustomobject]@{
    hwnd      = $h.ToInt64()
    hwndHex   = ('0x{0:X}' -f $h.ToInt64())
    title     = $title
    pid       = $procId
    process   = $procName
    rect      = [pscustomobject]@{ x = $r.Left; y = $r.Top; w = $w; h = $ht }
    minimized = [GuiWinEnum]::IsIconic($h)
    visible   = [GuiWinEnum]::IsWindowVisible($h)
  }
}

if ($Json) { $rows | ConvertTo-Json -Depth 4 -AsArray; return }

"窗口数: $($rows.Count)"
$rows | Sort-Object { $_.process } | Format-Table -AutoSize @(
  @{ n = 'hwnd'; e = { $_.hwndHex } },
  @{ n = '进程'; e = { $_.process } },
  @{ n = 'pid'; e = { $_.pid } },
  @{ n = '位置'; e = { '{0},{1} {2}x{3}' -f $_.rect.x, $_.rect.y, $_.rect.w, $_.rect.h } },
  @{ n = '最小化'; e = { $_.minimized } },
  @{ n = '标题'; e = { if ($_.title.Length -gt 42) { $_.title.Substring(0, 42) + '…' } else { $_.title } } }
) | Out-String | Write-Output



