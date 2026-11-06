<#
.SYNOPSIS
  用 UIA 直接“按名字/ID 触发”一个控件 —— 不移动鼠标、不抢焦点。

.DESCRIPTION
  这是动作层里**代价最小**的一条：`InvokePattern.Invoke()` 由系统直接投递给控件，
  鼠标不动、前台不变，用户正在做的事不会被打断。
  只要目标控件支持 Invoke，就优先用它；不支持才退到坐标点击（click-at.ps1）。

  匹配规则（按优先级）：
    1. -AutomationId 精确相等
    2. -Name 精确相等 → 再退到包含
    3. -Type 限定控件类型（Button/MenuItem/…）

  动作方式：
    invoke    调 InvokePattern（按钮/菜单项/链接）
    value     调 ValuePattern 设值（输入框）
    select    调 SelectionItemPattern.Select（列表项/页签）

.PARAMETER Hwnd
  窗口句柄（十进制或 0x）。

.PARAMETER Name
  控件显示文本（如「7」「确定」）。

.PARAMETER AutomationId
  控件 AutomationId（更稳，界面改文字也不影响）。

.PARAMETER Type
  限定 ControlType，例如 Button、MenuItem、ListItem、Edit。

.PARAMETER Method
  invoke / value / select，默认 invoke。

.PARAMETER Value
  Method=value 时要写入的文本。

.PARAMETER Index
  匹配到多个时取第几个（0 起），默认 0。

.EXAMPLE
  pwsh -File uia-invoke.ps1 0x1234 -Name '7'
  pwsh -File uia-invoke.ps1 0x1234 -AutomationId 'num7Button'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Hwnd,
  [string]$Name = '',
  [string]$AutomationId = '',
  [string]$Type = '',
  [ValidateSet('invoke', 'value', 'select')][string]$Method = 'invoke',
  [string]$Value = '',
  [int]$Index = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if ($Name -eq '' -and $AutomationId -eq '') {
  [Console]::Error.WriteLine('[uia] 至少要给 -Name 或 -AutomationId')
  exit 2
}

$handle = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($null -eq $root) { [Console]::Error.WriteLine('[uia] 拿不到根元素'); exit 2 }

$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

$exact = @(); $contains = @()
foreach ($el in $all) {
  if ($Type -ne '' -and $el.Current.ControlType.ProgrammaticName -ne ('ControlType.' + $Type)) { continue }
  if ($AutomationId -ne '') {
    if ($el.Current.AutomationId -eq $AutomationId) { $exact += $el }
    continue
  }
  if ($el.Current.Name -eq $Name) { $exact += $el }
  elseif ($el.Current.Name -like "*$Name*") { $contains += $el }
}

$cands = if ($exact.Count -gt 0) { $exact } else { $contains }
if ($cands.Count -eq 0) {
  [Console]::Error.WriteLine("[uia] 没找到控件（name='$Name' id='$AutomationId' type='$Type'）；该窗口共 $($all.Count) 个元素")
  exit 3
}
if ($Index -ge $cands.Count) {
  [Console]::Error.WriteLine("[uia] 只匹配到 $($cands.Count) 个，取不到第 $Index 个")
  exit 3
}
$target = $cands[$Index]

$r = $target.Current.BoundingRectangle
$desc = "type=$($target.Current.ControlType.ProgrammaticName -replace '^ControlType\.','') name='$($target.Current.Name)' id='$($target.Current.AutomationId)' rect=$([int]$r.X),$([int]$r.Y) $([int]$r.Width)x$([int]$r.Height)"

switch ($Method) {
  'invoke' {
    $pat = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
      [Console]::Error.WriteLine("[uia] 该控件不支持 Invoke（$desc）")
      exit 4
    }
    try { $pat.Invoke() }
    catch {
      [Console]::Error.WriteLine("[uia] 调用失败：$($_.Exception.Message)")
      [Console]::Error.WriteLine("[uia] 常见原因：控件 enabled=false（Qt/CEF 的搜索框常这样）。")
      [Console]::Error.WriteLine("[uia] 兜底：先 gui_click 点到它，再 gui_type(hwnd=...) 输入。")
      exit 5
    }
    "invoked $desc"
  }
  'value' {
    $pat = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
      [Console]::Error.WriteLine("[uia] 该控件不支持 Value（$desc）")
      exit 4
    }
    try { $pat.SetValue($Value) }
    catch {
      [Console]::Error.WriteLine("[uia] 设值失败：$($_.Exception.Message)")
      [Console]::Error.WriteLine("[uia] 常见原因：控件 enabled=false（Qt 的搜索框实测如此），UIA 拒绝写值。")
      [Console]::Error.WriteLine("[uia] 兜底：gui_click 点到输入框 → gui_type(hwnd=..., text=...) 走键盘输入。")
      exit 5
    }
    "value-set $desc -> '$Value'"
  }
  'select' {
    $pat = $null
    if (-not $target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
      [Console]::Error.WriteLine("[uia] 该控件不支持 SelectionItem（$desc）")
      exit 4
    }
    $pat.Select()
    "selected $desc"
  }
}

