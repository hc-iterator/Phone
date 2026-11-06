<#
.SYNOPSIS
  把一个窗口（即使被遮挡）截成 PNG。

.DESCRIPTION
  图形化能力的第二层：**Agent 只拿它点名的那个窗口**，永远不拿整屏。

  原理：`PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)` 让窗口**自己重绘**到内存 DC，
  所以被其它窗口盖住也能拿到内容（DWM 合成的程序有效；独占全屏/DRM/最小化的除外）。

.PARAMETER Hwnd
  窗口句柄（十进制或 0x 十六进制）。

.PARAMETER OutFile
  输出 PNG 路径。

.PARAMETER MaxWidth
  超过这个宽度就等比缩小（默认 0 = 不缩）。给模型看时建议 ≤1280。

.NOTES
  失败情形：最小化（DWM 停止合成）、UAC/登录桌面、DRM 保护内容、部分独占全屏。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Hwnd,
  [Parameter(Mandatory = $true, Position = 1)][string]$OutFile,
  [int]$MaxWidth = 0,
  [switch]$Raise,
  [switch]$PreferScreen
)

$ErrorActionPreference = 'Stop'
# 子进程默认走 GBK 控制台；不显式设 UTF-8，中文标题到父进程就是乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

if (-not ('GuiWinCapture' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class GuiWinCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  public const int DWMWA_CLOAKED = 14;
  public static int Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, DWMWA_CLOAKED, out v, sizeof(int)) == 0 ? v : -1; }
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  /// 前台锁定（Windows 的前台保护）会让 SetForegroundWindow 静默失败。
  /// 标准解法：先模拟一次 ALT 键，系统就把"下一个 SetForegroundWindow"当作用户意图放行。
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  /// 强力前台化：ALT 轻点 → SwitchToThisWindow → AttachThreadInput 后 SetForegroundWindow。
  public static bool ForceForeground(IntPtr h) {
    AltTap();
    SwitchToThisWindow(h, true);
    IntPtr fg = GetForegroundWindow();
    if (fg == h) return true;
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint me = GetCurrentThreadId();
    bool attached = AttachThreadInput(me, fgThread, true);
    bool ok = SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgThread, false);
    return ok || GetForegroundWindow() == h;
  }
  public static void AltTap() {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
  }

  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  public const uint PW_RENDERFULLCONTENT = 2;

  // 真实可见边界（去掉 Win10+ 的不可见边框阴影）
  public static bool TryBounds(IntPtr h, out RECT r) {
    int rc = DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT)));
    if (rc == 0 && r.Right > r.Left && r.Bottom > r.Top) return true;
    return GetWindowRect(h, out r);
  }
}
'@
}

$handle = if ($Hwnd -match '^0x') { [IntPtr]([Convert]::ToInt64($Hwnd, 16)) } else { [IntPtr][int64]$Hwnd }

$cloaked = [GuiWinCapture]::Cloaked($handle)
if ($cloaked -ne 0) {
  [Console]::Error.WriteLine("[capture] 该窗口已被系统 cloaked（值=$cloaked）：它在别的虚拟桌面或已挂起，当前桌面没有它的像素。")
  [Console]::Error.WriteLine("[capture] 换个桌面/把它调回本桌面再抓；这不是抓屏失败。")
  exit 6
}
if ([GuiWinCapture]::IsIconic($handle)) {
  [Console]::Error.WriteLine('[capture] 窗口已最小化：DWM 停止合成，通常拿不到内容。先还原再抓。')
  exit 3
}

$r = New-Object GuiWinCapture+RECT
if (-not [GuiWinCapture]::TryBounds($handle, [ref]$r)) {
  [Console]::Error.WriteLine('[capture] 拿不到窗口矩形（句柄无效？）')
  exit 2
}
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { [Console]::Error.WriteLine("[capture] 窗口尺寸非法 ${w}x${h}"); exit 2 }

$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$method = 'printwindow'

# WinUI3 / XAML 程序常常对 PrintWindow 返回**旧帧**：画面还是上一次的，看起来"没变化"，
# 于是"动作是否生效"会被误判。 -PreferScreen 改为直接抓屏幕上的窗口矩形，拿真实像素；
# 代价是窗口被遮挡时会抓到遮挡物，所以先检查它是不是前台，不是就明确警告（不静默）。
if ($PreferScreen) {
  $fg = [GuiWinCapture]::GetForegroundWindow()
  if ($fg -ne $handle) {
    [Console]::Error.WriteLine('[capture] -PreferScreen 但该窗口不是前台：可能抓到遮挡物，结论请谨慎。')
  }
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)), [System.Drawing.CopyPixelOperation]::SourceCopy)
  $ok = $true
  $method = 'screen-direct'
} else {
  $hdc = $g.GetHdc()
  $ok = $false
  try { $ok = [GuiWinCapture]::PrintWindow($handle, $hdc, [GuiWinCapture]::PW_RENDERFULLCONTENT) }
  finally { $g.ReleaseHdc($hdc) }
  if (-not $ok) {
    # 有些程序不响应 PW_RENDERFULLCONTENT，退回到 0
    $hdc2 = $g.GetHdc()
    try { $ok = [GuiWinCapture]::PrintWindow($handle, $hdc2, 0) } finally { $g.ReleaseHdc($hdc2) }
  }
}

# 抽查几个点，判断是不是全黑（DRM/不支持的常见表现）
# 抽查几个点，判断是不是全黑（DRM/不支持的常见表现）
$samples = @(
  @( [int]($w / 2), [int]($h / 2) ),
  @( [int]($w / 4), [int]($h / 4) ),
  @( [int]($w * 3 / 4), [int]($h * 3 / 4) )
)
$nonBlack = 0
foreach ($s in $samples) {
  try { $c = $bmp.GetPixel($s[0], $s[1]); if ($c.R -or $c.G -or $c.B) { $nonBlack++ } } catch {}
}
$allBlack = ($nonBlack -eq 0)

# ── 二级降级：PrintWindow 拿到全黑（UWP / DirectComposition 常见）时改用屏幕截取。
#    代价：只对可见像素有效；被遮挡时会截到遮挡物（所以 -Raise 可先把它推到前台）。
if ($allBlack) {
  if ($Raise) {
    [void][GuiWinCapture]::ShowWindow($handle, 9)   # SW_RESTORE
    [void][GuiWinCapture]::BringWindowToTop($handle)
    [void][GuiWinCapture]::ForceForeground($handle)
    Start-Sleep -Milliseconds 300
    $fgAfter = [GuiWinCapture]::GetForegroundWindow()
    if ($fgAfter -ne $handle) { [Console]::Error.WriteLine("[capture] 已尝试前台化，但系统没给它前台（前台锁定）。请手动点一下该窗口再抓。"); exit 5 }
  }
  # 关键纪律：屏幕截取只对"屏幕上真的看得到这个窗口"有效。
  # 如果它不是前台窗口，截到的会是它位置上别的窗口/桌面 —— 那就是一张**假图**，
  # 比失败更糟（Agent 会据此点错地方）。所以不是前台就拒绝，不返回假图。
  $fg = [GuiWinCapture]::GetForegroundWindow()
  if ($fg -ne $handle) {
    [Console]::Error.WriteLine("[capture] PrintWindow 拿到全黑（UWP/DirectComposition 常见），而该窗口当前不是前台窗口。")
    [Console]::Error.WriteLine("[capture] 此时屏幕截取会抓到别的东西 —— 拒绝返回假图。")
    [Console]::Error.WriteLine("[capture] 解决：加 -Raise（会抢焦点）重试，或改用 UIA 控件树读取内容。")
    exit 4
  }

  try {
    $g3 = [System.Drawing.Graphics]::FromImage($bmp)
    $g3.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)), [System.Drawing.CopyPixelOperation]::SourceCopy)
    $g3.Dispose()
    $method = if ($Raise) { 'screen-raised' } else { 'screen-fallback' }

    # 重新抽查：屏幕截取之后是否还是有内容
    $nb = 0
    foreach ($s in $samples) {
      try { $c = $bmp.GetPixel($s[0], $s[1]); if ($c.R -or $c.G -or $c.B) { $nb++ } } catch {}
    }
    $allBlack = ($nb -eq 0)
  }
  catch {
    [Console]::Error.WriteLine("[capture] 屏幕截取也失败：$($_.Exception.Message)")
  }
}

# 原始尺寸与缩放比必须在缩放**之前**固定下来：缩放会覆盖 $w/$h，
# 之后再算就会得到"图片尺寸 + scale=1"这种自洽但完全错误的换算依据。
$origW = $w; $origH = $h
$outScale = 1
if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
  $outScale = [math]::Round($MaxWidth / $w, 4)
  $nw = [int]($w * $outScale); $nh = [int]($h * $outScale)
  $small = New-Object System.Drawing.Bitmap($nw, $nh)
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $nw, $nh)
  $g2.Dispose()
  $bmp.Dispose()
  $bmp = $small
  $w = $nw; $h = $nh
}

$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $g.Dispose()

$bytes = (Get-Item $OutFile).Length
# 输出里必须带 **窗口原点 + 缩放比**：Agent 看到的是窗口内像素，要换算回屏幕坐标
# 只能靠这三样（origin.x/y、原尺寸、缩放比）。少了它们就只能瞎猜。
$ratio = $outScale
"captured hwnd=$($handle.ToInt64()) origin=$($r.Left),$($r.Top) window=${origW}x${origH} scale=$ratio image=$($w)x$($h) method=$method printWindow=$ok allBlack=$allBlack bytes=$bytes -> $OutFile"
"  换算：屏幕坐标 = origin + 图片像素 / scale"
if ($allBlack) { [Console]::Error.WriteLine('[capture] 抓到的图全黑：多半是 DRM/独占全屏/不支持的窗口。') }
exit 0









