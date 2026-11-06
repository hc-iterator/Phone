<#
.SYNOPSIS
  往当前前台窗口输入文本（支持中文），可附带回车/Tab。

.DESCRIPTION
  为什么需要：`gui_click` 只能点，不能打字。CEF 类程序（钉钉、微信桌面版）既不暴露 UIA、
  PrintWindow 又是黑的 ⇒ 唯一可用的路径就是"聚焦 → 键盘输入"，而这个能力之前根本没有，
  只能临时借 `SendKeys` 抄近路（那不是工具，是漏洞）。

  实现：`SendInput` + `KEYEVENTF_UNICODE`，中文/emoji 都能打，不依赖输入法状态。
  （SendKeys 走的是虚拟键码，中文得靠 IME 编码，窗口一变就乱。）

  三级恢复：输入前快照鼠标/焦点/输入法，输入后还回去（复用 env-guard.ps1）。

.PARAMETER Text
  要输入的文本。`\n` 表示回车、`\t` 表示 Tab（按字面两字符处理，见 -Escapes）。

.PARAMETER Enter
  输完再按一次回车（发送消息常用）。

.PARAMETER Escapes
  把文本里的字面 `\n` `\t` 解释成回车/Tab。

.PARAMETER Hwnd
  可选：先把这个窗口激活再输入（不给就用当前前台窗口）。

.PARAMETER NoRestore
  不做三级恢复（默认会做）。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Text,
  [switch]$Enter,
  [switch]$Escapes,
  [string]$Hwnd = '',
  [switch]$NoRestore
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$guard = Join-Path $dir 'env-guard.ps1'

if (-not ('Typist' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class Typist {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUTK { public uint type; public KEYBDINPUT ki; public ulong pad; }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint n, INPUTK[] inputs, int cbSize);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  static void Send(INPUTK inp) { SendInput(1, new INPUTK[] { inp }, Marshal.SizeOf(typeof(INPUTK))); }

  /// 用 UNICODE 事件打一个字符：不经过输入法，中文/符号都直接到窗口。
  public static void Char(char c) {
    ushort code = c;
    INPUTK down = new INPUTK(); down.type = INPUT_KEYBOARD; down.ki.wScan = code; down.ki.dwFlags = KEYEVENTF_UNICODE;
    INPUTK up = new INPUTK(); up.type = INPUT_KEYBOARD; up.ki.wScan = code; up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    Send(down); Send(up);
  }

  /// 虚拟键（回车/Tab 这类控制键）
  public static void Vk(ushort vk) {
    INPUTK down = new INPUTK(); down.type = INPUT_KEYBOARD; down.ki.wVk = vk;
    INPUTK up = new INPUTK(); up.type = INPUT_KEYBOARD; up.ki.wVk = vk; up.ki.dwFlags = KEYEVENTF_KEYUP;
    Send(down); Send(up);
  }

  public static bool Focus(IntPtr h) {
    if (GetForegroundWindow() == h) return true;
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }
}
'@
}

if ($Escapes) {
  $Text = $Text -replace '\\n', "`n" -replace '\\t', "`t"
}

$wantRestore = -not $NoRestore
if ($wantRestore -and (Test-Path $guard)) { & pwsh -NoProfile -File $guard -Snapshot -Quiet 2>$null | Out-Null }

try {
  if ($Hwnd -ne '') {
    $h = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }
    if (-not [Typist]::Focus($h)) { [Console]::Error.WriteLine('[type] 无法把目标窗口切到前台'); exit 3 }
    Start-Sleep -Milliseconds 150
  }

  $count = 0
  foreach ($ch in $Text.ToCharArray()) {
    if ($ch -eq "`n" -or $ch -eq "`r") { [Typist]::Vk(0x0D); $count++ }
    elseif ($ch -eq "`t") { [Typist]::Vk(0x09); $count++ }
    else { [Typist]::Char($ch); $count++ }
    Start-Sleep -Milliseconds 12
  }
  if ($Enter) { [Typist]::Vk(0x0D); $count++ }

  "typed $count chars into " + $(if ($Hwnd -ne '') { $Hwnd } else { 'foreground' }) + $(if ($Enter) { ' +Enter' } else { '' })
}
finally {
  if ($wantRestore -and (Test-Path $guard)) {
    $a = @('-Restore', '-Quiet')
    if ($Hwnd -ne '') { $a += @('-Target', $Hwnd) }
    & pwsh -NoProfile -File $guard @a 2>$null | Out-Null
  }
}
