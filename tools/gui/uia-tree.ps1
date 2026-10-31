<#
.SYNOPSIS
  列出一个窗口里的 UI 控件树（UIA）：类型、名字、矩形、是否可点。

.DESCRIPTION
  图形化能力的第四层，也是**最可靠的一层**：不靠像素、不靠猜坐标。

  为什么优先 UIA：
    - 它直接告诉我们"这是个按钮"，以及它的**精确屏幕矩形**；
    - 带 `InvokePattern` 的控件可以**后台直接触发**，不抢焦点、不动鼠标（连副屏都不用）；
    - 像素识别（OCR/形状）只在 UIA 拿不到东西时（自绘 canvas、游戏）才用。

  输出为 JSON 数组，字段：
    id         AutomationId（可能为空，但同窗口内通常唯一）
    type       ControlType（Button / Edit / MenuItem / Text ...）
    name       显示文本（按钮上的字就在这）
    rect       屏幕矩形 { x, y, w, h }
    enabled    是否可用
    offscreen  是否在屏幕外（UIA 自报，偶有滞后）
    clickable  是否支持 InvokePattern（true 则可后台点击）
    depth      树深
    path       从根到它的索引路径（用于稳定重复定位）

.PARAMETER Hwnd
  目标窗口句柄（十进制或 0x 十六进制）。

.PARAMETER MaxDepth
  递归深度，默认 6（整棵树可能上千节点，够用就行）。

.PARAMETER MaxNodes
  最多返回多少个节点，默认 400。

.PARAMETER OnlyClickable
  只保留可点击的（看界面结构时最有用）。

.PARAMETER Json
  输出 JSON（默认给人看的表格）。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Hwnd,
  [int]$MaxDepth = 6,
  [int]$MaxNodes = 400,
  [switch]$OnlyClickable,
  [switch]$Json,
  [switch]$Raw
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$handle = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }

try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
} catch {
  [Console]::Error.WriteLine("[uia] FromHandle 失败：$($_.Exception.Message)")
  exit 2
}
if ($null -eq $root) {
  [Console]::Error.WriteLine('[uia] 拿不到根元素（句柄无效，或该窗口没有 UIA provider）')
  exit 2
}

$walker = if ($Raw) { [System.Windows.Automation.TreeWalker]::RawViewWalker } else { [System.Windows.Automation.TreeWalker]::ControlViewWalker }
$invokePattern = [System.Windows.Automation.InvokePattern]::Pattern
$rows = New-Object System.Collections.ArrayList
$budget = $MaxNodes

function Visit($el, $depth, $path) {
  if ($null -eq $el) { return }
  if ($rows.Count -ge $budget) { return }

  $clickable = $false
  try {
    $p = $null
    $clickable = $el.TryGetCurrentPattern($invokePattern, [ref]$p)
  } catch { $clickable = $false }

  $r = $null
  try { $r = $el.Current.BoundingRectangle } catch { $r = $null }

  $id = ''; $type = ''; $name = ''
  $enabled = $false; $offscreen = $false
  try { $id = [string]$el.Current.AutomationId } catch { }
  try { $type = ([string]$el.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', '' } catch { }
  try { $name = [string]$el.Current.Name } catch { }
  try { $enabled = [bool]$el.Current.IsEnabled } catch { }
  try { $offscreen = [bool]$el.Current.IsOffscreen } catch { }

  $rect = $null
  if ($r -and $r.Width -gt 0) { $rect = [pscustomobject]@{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }

  $row = [pscustomobject]@{
    id        = $id
    type      = $type
    name      = $name
    rect      = $rect
    enabled   = $enabled
    offscreen = $offscreen
    clickable = [bool]$clickable
    depth     = $depth
    path      = $path
  }
  if (-not $OnlyClickable -or $clickable) { [void]$rows.Add($row) }

  if ($depth -ge $MaxDepth) { return }
  $child = $null
  try { $child = $walker.GetFirstChild($el) } catch { $child = $null }
  $i = 0
  while ($null -ne $child -and $rows.Count -lt $budget) {
    Visit $child ($depth + 1) ("$path/$i")
    $i++
    try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
  }
}

Visit $root 0 '0'

if ($Json) { $rows | ConvertTo-Json -Depth 4 -AsArray; return }

"节点: $($rows.Count)（root: $($root.Current.Name)）"
$rows | Where-Object { $_.rect -ne $null } | Format-Table -AutoSize @(
  @{ n = 'depth'; e = { $_.depth } },
  @{ n = 'type'; e = { $_.type } },
  @{ n = 'name'; e = { if ($_.name.Length -gt 24) { $_.name.Substring(0, 24) + '…' } else { $_.name } } },
  @{ n = 'rect'; e = { '{0},{1} {2}x{3}' -f $_.rect.x, $_.rect.y, $_.rect.w, $_.rect.h } },
  @{ n = '可点'; e = { $_.clickable } },
  @{ n = 'id'; e = { $_.id } }
) | Out-String | Write-Output

