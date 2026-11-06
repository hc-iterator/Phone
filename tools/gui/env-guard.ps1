<#
.SYNOPSIS
  动作前后的环境守卫：快照并在动作结束后恢复「鼠标位置 + 焦点窗口 + 输入法状态」。

.DESCRIPTION
  为什么要三级恢复：Agent 操作桌面时会动三样东西，用户能立刻感觉到：

    1. **鼠标位置** —— "鼠标自己跑了"（最刺眼）
    2. **前台窗口/焦点** —— 用户正在打的字跑进别的窗口，或输入框失焦
    3. **输入法** —— 中文/英文模式、全半角被改掉，用户下一个字就打错

  只恢复第 1 级是不够的：焦点没回来，用户还得自己点一下；输入法没回来，
  他会莫名其妙打出英文/全角。所以三级一起做。

  安全规则（重要）：**只有当我们确实把前台换掉了，才恢复焦点**。
  如果动作期间用户自己切了窗口（现在前台既不是快照值、也不是我们操作的目标），
  就**什么都别做** —— 硬抢回来比不恢复更烦。

.PARAMETER Snapshot
  记录当前环境到 %TEMP%\gui-env.json。

.PARAMETER Restore
  从 %TEMP%\gui-env.json 恢复。可给 -Target 表示"我们操作的那个窗口"。

.PARAMETER Target
  本次动作的目标窗口句柄（十进制或 0x）。用于判断"是不是我们换掉的前台"。

.PARAMETER Quiet
  不打印细节（供工具内部调用）。
#>
[CmdletBinding()]
param(
  [switch]$Snapshot,
  [switch]$Restore,
  [string]$Target = '',
  [switch]$CursorOnly,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$stateFile = Join-Path $env:TEMP 'gui-env.json'

if (-not ('GuiEnv' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class GuiEnv {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  [DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr h);
  [DllImport("imm32.dll")] public static extern bool ImmReleaseContext(IntPtr h, IntPtr imc);
  [DllImport("imm32.dll")] public static extern bool ImmGetConversionStatus(IntPtr imc, out uint conv, out uint sentence);
  [DllImport("imm32.dll")] public static extern bool ImmSetConversionStatus(IntPtr imc, uint conv, uint sentence);

  public const uint WM_INPUTLANGCHANGEREQUEST = 0x0050;

  public static int[] Cursor() {
    POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y };
  }

  public static long Foreground() {
    return GetForegroundWindow().ToInt64();
  }

  public static long KeyboardLayoutOf(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    uint tid = GetWindowThreadProcessId(h, IntPtr.Zero);
    return GetKeyboardLayout(tid).ToInt64();
  }

  /// 返回 [conv, sentence]；拿不到 IME 上下文时返回 null。
  public static int[] ImeState(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    IntPtr imc = ImmGetContext(h);
    if (imc == IntPtr.Zero) return null;
    uint conv, sent;
    bool ok = ImmGetConversionStatus(imc, out conv, out sent);
    ImmReleaseContext(h, imc);
    if (!ok) return null;
    return new int[] { (int)conv, (int)sent };
  }

  public static bool SetImeState(long hwnd, int conv, int sent) {
    IntPtr h = new IntPtr(hwnd);
    IntPtr imc = ImmGetContext(h);
    if (imc == IntPtr.Zero) return false;
    bool ok = ImmSetConversionStatus(imc, (uint)conv, (uint)sent);
    ImmReleaseContext(h, imc);
    return ok;
  }

  /// 强制恢复前台：ALT 轻点 + AttachThreadInput 两招并上。
  public static bool ForceForeground(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (GetForegroundWindow() == h) return true;
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return true;
    IntPtr fg = GetForegroundWindow();
    uint ft = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint me = GetCurrentThreadId();
    bool attached = AttachThreadInput(me, ft, true);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, ft, false);
    return GetForegroundWindow() == h;
  }

  public static void SwitchLayout(long hwnd, long layout) {
    PostMessageW(new IntPtr(hwnd), WM_INPUTLANGCHANGEREQUEST, IntPtr.Zero, new IntPtr(layout));
  }
}
'@
}

if ($Snapshot) {
  $fg = [GuiEnv]::Foreground()
  $cur = [GuiEnv]::Cursor()
  $ime = $null
  try { $ime = [GuiEnv]::ImeState($fg) } catch { $ime = $null }
  $state = [pscustomobject]@{
    at         = (Get-Date).ToString('o')
    cursorX    = $cur[0]
    cursorY    = $cur[1]
    foreground = $fg
    layout     = [GuiEnv]::KeyboardLayoutOf($fg)
    imeConv    = if ($ime) { $ime[0] } else { $null }
    imeSent    = if ($ime) { $ime[1] } else { $null }
  }
  $state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding utf8
  if (-not $Quiet) { "snapshot fg=$($state.foreground) cursor=$($state.cursorX),$($state.cursorY) ime=$($state.imeConv)/$($state.imeSent)" }
  exit 0
}

if (-not $Restore) {
  [Console]::Error.WriteLine('[env] 需要 -Snapshot 或 -Restore')
  exit 2
}

if (-not (Test-Path $stateFile)) {
  if (-not $Quiet) { '[env] 没有快照，跳过恢复' }
  exit 0
}
$s = Get-Content $stateFile -Raw | ConvertFrom-Json

$cur = [GuiEnv]::Cursor()
$nowFg = [GuiEnv]::Foreground()

# 安全规则：现在的前台既不是快照值、也不是我们操作的目标 ⇒ 用户自己切走了，别动
$target = 0
if ($Target -ne '') {
  $target = if ($Target -match '^0x') { [int64]([Convert]::ToInt64($Target, 16)) } else { [int64]$Target }
}
$userMoved = ($nowFg -ne [int64]$s.foreground) -and ($target -eq 0 -or $nowFg -ne $target)
if ($userMoved) {
  if (-not $Quiet) {
    "[env] 焦点现在是 $nowFg，既不是快照 $($s.foreground) 也不是目标 $target ⇒ 用户自己切走了，只恢复鼠标"
  }
  [void][GuiEnv]::SetCursorPos([int]$s.cursorX, [int]$s.cursorY)
  exit 0
}

# 只恢复光标：点击/输入本来就是要激活目标窗口，此时把焦点抢回去等于把动作撤销
# （实战：点开记事本 → 恢复把焦点还给浏览器 → 后面 gui_type 打到了浏览器）。
if ($CursorOnly) {
  [void][GuiEnv]::SetCursorPos([int]$s.cursorX, [int]$s.cursorY)
  if (-not $Quiet) { 'restored cursor-only' }
  exit 0
}

$restored = @()
# ① 焦点
if ($nowFg -ne [int64]$s.foreground) {
  if ([GuiEnv]::ForceForeground([int64]$s.foreground)) { $restored += 'focus' }
}
# ② 输入法（键盘布局 + 转换模式）
try {
  [GuiEnv]::SwitchLayout([int64]$s.foreground, [int64]$s.layout)
  if ($null -ne $s.imeConv -and $null -ne $s.imeSent) {
    if ([GuiEnv]::SetImeState([int64]$s.foreground, [int]$s.imeConv, [int]$s.imeSent)) { $restored += 'ime' }
  }
  $restored += 'layout'
} catch { }
# ③ 鼠标
[void][GuiEnv]::SetCursorPos([int]$s.cursorX, [int]$s.cursorY)
$restored += 'cursor'

if (-not $Quiet) { 'restored ' + ($restored -join '+') }
exit 0

