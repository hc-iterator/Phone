<#
.SYNOPSIS
  用 MSAA（IAccessible）列出一个窗口里的控件：名字、角色、矩形、可点。

.DESCRIPTION
  为什么还要 MSAA：这台机器上 UIA 只能拿到 HWND 级的 Pane（连 regedit 都只有 4 个后代），
  但 MSAA 是更老、更通用的通道，很多原生程序（Win32/MFC/Delphi）只实现它。
  它同样给"名字 + 角色 + 屏幕矩形"，足够让 Agent 按 id 点名点击。

  输出字段：
    path      从根到该控件的子索引路径（稳定，可下次直接复现）
    role      ROLE_SYSTEM_* 的名字（PUSHBUTTON / TEXT / MENUITEM ...）
    name      控件文本
    rect      屏幕矩形 { x, y, w, h }
    state     STATE_SYSTEM_* 的摘要（不可用/不可见/选中）
    actionable 是否属于"可点"角色（按钮/菜单项/链接/列表项/页签…）

.PARAMETER Hwnd
  窗口句柄（十进制或 0x）。

.PARAMETER MaxDepth
  递归深度，默认 4。

.PARAMETER MaxNodes
  最多返回节点数，默认 300。

.PARAMETER OnlyActionable
  只保留可点的。

.PARAMETER Json
  输出 JSON。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Hwnd,
  [int]$MaxDepth = 4,
  [int]$MaxNodes = 300,
  [switch]$OnlyActionable,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName Accessibility

if (-not ('Msaa' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class Msaa {
  [DllImport("oleacc.dll")]
  public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
  public const uint OBJID_CLIENT = 0xFFFFFFFC;

  public static object FromWindow(IntPtr hwnd) {
    Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); // IID_IAccessible
    object acc;
    int hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, ref iid, out acc);
    if (hr != 0) return null;
    return acc;
  }
}
'@
}

$handle = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }

$root = [Msaa]::FromWindow($handle)
if ($null -eq $root) {
  [Console]::Error.WriteLine('[msaa] AccessibleObjectFromWindow 失败（该窗口没有 MSAA provider）')
  exit 2
}

$rows = New-Object System.Collections.ArrayList
$budget = $MaxNodes

function RoleName($child) {
  try {
    $r = $child.accRole(0)
    if ($r -is [string]) { return $r }
    return [string][System.Enum]::GetName([System.Windows.Forms.AccessibleRole], [int]$r)
  } catch {
    try { return [string][System.Enum]::GetName([System.Windows.Forms.AccessibleRole], [int]$child.accRole(0)) } catch { return '' }
  }
}

function Visit($node, $depth, $path) {
  if ($null -eq $node -or $rows.Count -ge $budget) { return }

  $name = ''
  try { $name = [string]$node.accName(0) } catch { }
  if ([string]::IsNullOrWhiteSpace($name)) { try { $name = [string]$node.accValue(0) } catch { } }

  $role = ''
  try { $role = [string]$node.accRole(0) } catch { }
  if ($role -match '^\d+$') {
    try { $role = [System.Enum]::GetName([System.Windows.Forms.AccessibleRole], [int]$role) } catch { }
  }

  $rect = $null
  try {
    $l = 0; $t = 0; $w = 0; $h = 0
    $node.accLocation([ref]$l, [ref]$t, [ref]$w, [ref]$h, 0)
    if ($w -gt 0 -and $h -gt 0) { $rect = [pscustomobject]@{ x = [int]$l; y = [int]$t; w = [int]$w; h = [int]$h } }
  } catch { }

  $stateText = ''
  $actionable = $false
  try {
    $st = [int]$node.accState(0)
    $bits = @()
    if ($st -band 0x1) { $bits += '不可用' }        # STATE_SYSTEM_UNAVAILABLE
    if ($st -band 0x8000) { $bits += '不可见' }     # STATE_SYSTEM_INVISIBLE
    if ($st -band 0x2) { $bits += '选中' }          # STATE_SYSTEM_SELECTED
    if ($st -band 0x4) { $bits += '聚焦' }          # STATE_SYSTEM_FOCUSED
    $stateText = ($bits -join ',')
    # 可点角色：按钮 / 菜单项 / 链接 / 页签 / 列表项 / 复选 / 单选 / 下拉
    $actionable = ($role -match 'PUSHBUTTON|MENUITEM|LINK|PAGETAB|LISTITEM|CHECKBUTTON|RADIOBUTTON|COMBOBOX|SPLITBUTTON|BUTTONDROPDOWN')
  } catch { }

  if ((-not $OnlyActionable) -or $actionable) {
    [void]$rows.Add([pscustomobject]@{
      path = $path; role = $role; name = $name; rect = $rect; state = $stateText; actionable = $actionable; depth = $depth
    })
  }

  if ($depth -ge $MaxDepth) { return }
  $count = 0
  try { $count = [int]$node.accChildCount } catch { $count = 0 }
  for ($i = 1; $i -le $count -and $rows.Count -lt $budget; $i++) {
    $child = $null
    try { $child = $node.get_accChild($i) } catch { $child = $null }
    if ($null -ne $child -and $child -isnot [int]) {
      Visit $child ($depth + 1) ("$path/$i")
    } else {
      # 简单元素：直接读当前节点上的子信息
      $nm = ''
      try { $nm = [string]$node.accName($i) } catch { }
      $rl = ''
      try {
        $rv = $node.accRole($i)
        $rl = if ($rv -match '^\d+$') { [System.Enum]::GetName([System.Windows.Forms.AccessibleRole], [int]$rv) } else { [string]$rv }
      } catch { }
      $rc = $null
      try {
        $l = 0; $t = 0; $w = 0; $h = 0
        $node.accLocation([ref]$l, [ref]$t, [ref]$w, [ref]$h, $i)
        if ($w -gt 0 -and $h -gt 0) { $rc = [pscustomobject]@{ x = [int]$l; y = [int]$t; w = [int]$w; h = [int]$h } }
      } catch { }
      $act = ($rl -match 'PUSHBUTTON|MENUITEM|LINK|PAGETAB|LISTITEM|CHECKBUTTON|RADIOBUTTON|COMBOBOX')
      if ((-not $OnlyActionable) -or $act) {
        [void]$rows.Add([pscustomobject]@{ path = "$path/$i"; role = $rl; name = $nm; rect = $rc; state = ''; actionable = $act; depth = $depth + 1 })
      }
    }
  }
}

Visit $root 0 '0'

if ($Json) { $rows | ConvertTo-Json -Depth 4 -AsArray; return }

"控件: $($rows.Count)"
$rows | Where-Object { $_.rect -ne $null -or $_.name } | Format-Table -AutoSize @(
  @{ n = 'depth'; e = { $_.depth } },
  @{ n = 'role'; e = { $_.role } },
  @{ n = 'name'; e = { if ($_.name.Length -gt 26) { $_.name.Substring(0, 26) + '…' } else { $_.name } } },
  @{ n = 'rect'; e = { if ($_.rect) { '{0},{1} {2}x{3}' -f $_.rect.x, $_.rect.y, $_.rect.w, $_.rect.h } else { '' } } },
  @{ n = '可点'; e = { $_.actionable } },
  @{ n = 'path'; e = { $_.path } }
) | Out-String | Write-Output
