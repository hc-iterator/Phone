<#
.SYNOPSIS
  启动一个程序，并把它（以及它的第一个窗口）直接放到虚拟屏上。

.DESCRIPTION
  Agent 要开窗口时应该走这里，而不是直接 Start-Process：
  否则窗口会落在主屏、挡在用户眼前。

  流程：启动 → 轮询该进程的主窗口 → 用 SetWindowPos(SWP_NOACTIVATE) 挪到虚拟屏。
  全程**不抢焦点**，用户正在做的事情不会被打断。

.PARAMETER File
  可执行文件（notepad.exe / chrome.exe / 完整路径都行）。

.PARAMETER Args
  参数数组。

.PARAMETER WaitSeconds
  等窗口出现的最长时间，默认 15 秒。

.PARAMETER NoWait
  发出后就退出，不等待窗口（适合自己会开窗的程序）。

.EXAMPLE
  pwsh -File launch-on-vd.ps1 notepad.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$File,
  [string[]]$Args = @(),
  [int]$WaitSeconds = 15,
  [string]$TitleMatch = '',
  [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 先记录启动前已有的窗口；UWP（calculator: / ms-settings: 这类）拿不到 pid，
# 只能用"启动后新出现的窗口"来认领。
$before = (& pwsh -NoProfile -File (Join-Path $dir 'list-windows.ps1') -Json 2>$null | ConvertFrom-Json) | ForEach-Object { $_.hwndHex }
$isProtocol = $File -match '^[A-Za-z][A-Za-z0-9+.-]*:$'
if ($isProtocol) { Start-Process -FilePath $File; $p = $null }
else { $p = Start-Process -FilePath $File -ArgumentList $Args -PassThru }
"started pid=$($p.Id) file=$File"
if ($NoWait) { exit 0 }

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$placed = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 400
  try { $p.Refresh() } catch { break }
  if ($p -and $p.HasExited) { [Console]::Error.WriteLine('[launch] 进程已退出'); exit 4 }
  $list = & pwsh -NoProfile -File (Join-Path $dir 'list-windows.ps1') -All -Json 2>$null | ConvertFrom-Json
  $w = if ($p) { $list | Where-Object { $_.pid -eq $p.Id } | Select-Object -First 1 }
       elseif ($TitleMatch -ne '') { $list | Where-Object { $_.title -match $TitleMatch } | Select-Object -First 1 }
       else { $list | Where-Object { $before -notcontains $_.hwndHex } | Select-Object -First 1 }
  if ($w) {
    # 关键：UWP/部分程序在"窗口出现 → 被挪走"之间会在主屏露一下脸（用户实测："挡着我了"）。
    # 发现窗口的第一件事是把它最小化，挪好再还原 —— 这样闪的是任务栏，不是用户眼前。
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LSW { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }' -ErrorAction SilentlyContinue
    $hh = if ($w.hwndHex -match '^0x') { [IntPtr]([Convert]::ToInt64($w.hwndHex,16)) } else { [IntPtr][int64]$w.hwndHex }
    $out = & pwsh -NoProfile -File (Join-Path $dir 'place-window.ps1') $w.hwndHex -Virtual 2>&1
    [void][LSW]::ShowWindow($hh, 9)   # SW_RESTORE
    "window hwnd=$($w.hwndHex) title=$($w.title)"
    $out | ForEach-Object { "  $_" }
    $placed = $true
    break
  }
}
if (-not $placed) { [Console]::Error.WriteLine("[launch] 等不到窗口（${WaitSeconds}s）"); exit 5 }








