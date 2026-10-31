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
  [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$p = Start-Process -FilePath $File -ArgumentList $Args -PassThru
"started pid=$($p.Id) file=$File"
if ($NoWait) { exit 0 }

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$placed = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 400
  try { $p.Refresh() } catch { break }
  if ($p.HasExited) { [Console]::Error.WriteLine('[launch] 进程已退出'); exit 4 }
  $list = & pwsh -NoProfile -File (Join-Path $dir 'list-windows.ps1') -Json 2>$null | ConvertFrom-Json
  $w = $list | Where-Object { $_.pid -eq $p.Id } | Select-Object -First 1
  if ($w) {
    $out = & pwsh -NoProfile -File (Join-Path $dir 'place-window.ps1') $w.hwndHex -Virtual 2>&1
    "window hwnd=$($w.hwndHex) title=$($w.title)"
    $out | ForEach-Object { "  $_" }
    $placed = $true
    break
  }
}
if (-not $placed) { [Console]::Error.WriteLine("[launch] 等不到窗口（${WaitSeconds}s）"); exit 5 }
