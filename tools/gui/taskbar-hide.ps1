<#
.SYNOPSIS
  把窗口从任务栏上摘掉（或还回去），窗口本身不动。

.DESCRIPTION
  为什么需要：任务栏只画在主屏上，但会把**所有显示器**的窗口都列出来。
  虚拟屏上的窗口于是在主屏任务栏上留一排图标，点了也切不过来（Windows 只会把焦点给它，
  不会把窗口搬到主屏），纯属干扰。

  做法：COM 的 `ITaskbarList`（CLSID 56FDF344-FD6D-11d0-958A-006097C9A090）：
    · DeleteTab(hwnd) —— 任务栏按钮消失，窗口仍然正常显示/可见
    · AddTab(hwnd)    —— 按钮回来
  这比改 WS_EX_TOOLWINDOW 温和：不动窗口样式，不会影响 Alt+Tab 之外的行为太多，
  而且随时可以 AddTab 还原。

.PARAMETER Hide
  要摘掉任务栏按钮的窗口句柄。

.PARAMETER Show
  要恢复任务栏按钮的窗口句柄。

.PARAMETER HideVirtual
  一次性把所有"中心点在非主屏上"的窗口都摘掉。

.PARAMETER ShowAll
  把自己摘过的窗口全部还原（配合会记录状态的文件）。
#>
[CmdletBinding(DefaultParameterSetName = 'Hide')]
param(
  [Parameter(ParameterSetName = 'Hide', Position = 0)][string]$Hide = '',
  [Parameter(ParameterSetName = 'Show', Position = 0)][string]$Show = '',
  [Parameter(ParameterSetName = 'HideVirtual')][switch]$HideVirtual,
  [Parameter(ParameterSetName = 'ShowAll')][switch]$ShowAll
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

if (-not ('TaskbarList' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
public class CTaskbarList { }

[ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITaskbarList {
  void HrInit();
  void AddTab(IntPtr hwnd);
  void DeleteTab(IntPtr hwnd);
  void ActivateTab(IntPtr hwnd);
  void SetActiveAlt(IntPtr hwnd);
}

public class TaskbarHider {
  static ITaskbarList _list;
  public static ITaskbarList List() {
    if (_list == null) {
      _list = (ITaskbarList)new CTaskbarList();
      _list.HrInit();
    }
    return _list;
  }
  public static void Hide(IntPtr h) { try { List().DeleteTab(h); } catch {} }
  public static void Show(IntPtr h) { try { List().AddTab(h); } catch {} }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
}
'@
}

function Parse-Hwnd([string]$s) {
  if ($s -match '^0x') { return [IntPtr]([Convert]::ToInt64($s, 16)) }
  return [IntPtr][int64]$s
}

# 记住"被我们摘掉的窗口"，还原时用（存 %TEMP%，进程间共享）
$stateFile = Join-Path $env:TEMP 'gui-taskbar-hidden.json'
function Read-State {
  try { return @(Get-Content $stateFile -Raw | ConvertFrom-Json) } catch { return @() }
}
function Write-State($arr) {
  try { ($arr | ConvertTo-Json -Compress) | Set-Content -LiteralPath $stateFile -Encoding utf8 } catch { }
}

if ($HideVirtual) {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $primary = $screens | Where-Object { $_.Primary } | Select-Object -First 1
  $pb = $primary.Bounds
  $hidden = Read-State
  $count = 0
  [TaskbarHider]::EnumWindows({
    param($h, $l)
    if (-not [TaskbarHider]::IsWindowVisible($h)) { return $true }
    $r = New-Object TaskbarHider+RECT
    if (-not [TaskbarHider]::GetWindowRect($h, [ref]$r)) { return $true }
    $cx = [int](($r.Left + $r.Right) / 2)
    $cy = [int](($r.Top + $r.Bottom) / 2)
    $onPrimary = ($cx -ge $pb.Left -and $cx -lt ($pb.Right) -and $cy -ge $pb.Top -and $cy -lt ($pb.Bottom))
    if ($onPrimary) { return $true }
    $sb = New-Object System.Text.StringBuilder 256
    [void][TaskbarHider]::GetWindowText($h, $sb, 256)
    if ($sb.Length -eq 0) { return $true }
    $cls = New-Object System.Text.StringBuilder 256
    [void][TaskbarHider]::GetClassName($h, $cls, 256)
    $c = $cls.ToString()
    if ($c -eq 'Progman' -or $c -eq 'WorkerW' -or $c -eq 'Shell_TrayWnd') { return $true }
    [TaskbarHider]::Hide($h)
    $script:count++
    if (-not ($hidden | Where-Object { $_.hwnd -eq $h.ToInt64() })) {
      $hidden += [pscustomobject]@{ hwnd = $h.ToInt64(); title = $sb.ToString() }
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  Write-State $hidden
  "hidden=$count total=$($hidden.Count)"
  exit 0
}

if ($ShowAll) {
  $hidden = Read-State
  foreach ($item in $hidden) {
    [TaskbarHider]::Show([IntPtr][int64]$item.hwnd)
  }
  Write-State @()
  "restored=$($hidden.Count)"
  exit 0
}

if ($Show -ne '') {
  $h = Parse-Hwnd $Show
  [TaskbarHider]::Show($h)
  $hidden = Read-State | Where-Object { $_.hwnd -ne $h.ToInt64() }
  Write-State $hidden
  "shown $Show"
  exit 0
}

if ($Hide -ne '') {
  $h = Parse-Hwnd $Hide
  [TaskbarHider]::Hide($h)
  $sb = New-Object System.Text.StringBuilder 256
  [void][TaskbarHider]::GetWindowText($h, $sb, 256)
  $hidden = Read-State
  if (-not ($hidden | Where-Object { $_.hwnd -eq $h.ToInt64() })) {
    $hidden += [pscustomobject]@{ hwnd = $h.ToInt64(); title = $sb.ToString() }
    Write-State $hidden
  }
  "hidden $Hide ($($sb.ToString()))"
  exit 0
}

'用法：-Hide <hwnd> | -Show <hwnd> | -HideVirtual | -ShowAll'
