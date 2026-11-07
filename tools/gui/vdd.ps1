<#




<#
.SYNOPSIS
  控制 Parsec 虚拟显示器（VDD）：加一块、拔一块、保活、看状态。

.DESCRIPTION
  为什么需要：Windows 只合成"当前桌面上存在的显示器"。虚拟显示器给 DSH 一块
  **始终存在、始终被合成**的画面区域，于是按窗口截图（PrintWindow）和 UIA 点击都能用，
  而用户不需要真的接第二块屏。

  关键事实（来自 parsec-vdd 的 core/parsec-vdd.h）：
    - 设备接口 GUID : {00b41627-04c4-429e-a26e-0265cf50c8fa}
    - IOCTL_ADD     : 0x0022e004   返回新显示器的 index
    - IOCTL_REMOVE  : 0x0022a008   参数是 **16 位大端** 的 index
    - IOCTL_UPDATE  : 0x0022a00c   保活；**必须每 <100 ms 调一次**，否则约 1 秒后自动拔掉

.PARAMETER Add
  插一块虚拟显示器。

.PARAMETER Remove
  拔掉指定 index 的虚拟显示器。

.PARAMETER KeepAliveSeconds
  保活多少秒（默认 0 = 不保活；单独运行时给 30 就够验证）。

.PARAMETER Status
  只打印设备状态与当前显示器数量。

.EXAMPLE
  pwsh -File vdd.ps1 -Status
  pwsh -File vdd.ps1 -Add -KeepAliveSeconds 20
#>
[CmdletBinding()]
param(
  [switch]$Add,
  [int]$Remove = -1,
  [switch]$Status,
  [int]$KeepAliveSeconds = 0,
  [switch]$Serve,
  [switch]$Enable,
  [switch]$Disable,
  [switch]$Reset,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# ── 自愈：虚拟屏卡死时的硬重置 ────────────────────────────────────────────────
# 症状（2026-11-06 实遇）：ADD 返回 >=0，但 Windows 屏幕上就是不出现第二块屏；
# 反复 add/remove 也无效 —— 驱动内部状态卡住了。这个分支按"清干净再重来"处理，
# 并在最后如实说明"要不要重启系统"，而不是假装成功。
if ($Reset) {
  $pwshExe = (Get-Process -Id $PID).Path
  $me = $PID
  Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*-File*vdd.ps1*' -and $_.CommandLine -notlike '*Get-CimInstance*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  "1) 已停所有 keeper"
  Remove-Item (Join-Path $env:TEMP 'picophone-vdd-keeper.lock') -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4

  # 拔掉所有可能残留的虚拟屏
  1..3 | ForEach-Object {
    & $pwshExe -NoProfile -File $PSCommandPath -Remove 0 2>$null | Out-Null
    Start-Sleep -Seconds 2
  }
  "2) 已尝试拔除残留显示器"
  Start-Sleep -Seconds 4

  New-Item -ItemType File -Path (Join-Path $env:TEMP 'picophone-vdd.enable') -Force | Out-Null
  Start-Process -FilePath $pwshExe -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-Serve') -WindowStyle Hidden | Out-Null
  "3) keeper 已重启，等待屏幕出现…"

  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  $ok = $false
  for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 2
    $n = ([System.Windows.Forms.Screen]::AllScreens | Measure-Object).Count
    if ($n -ge 2) { $ok = $true; "   第${i}次检查：屏幕数=$n ✓"; break }
  }
  if (-not $ok) {
    "❌ 重置失败：ADD 说成功，但系统里始终只有 1 块屏。"
    "   这是驱动内部状态卡死，脚本层修不了。可尝试："
    "   · 设备管理器里禁用再启用 'Parsec Virtual Display Adapter'；"
    "   · 或重启系统（最稳）。"
    exit 3
  }
  "reset=ok"
  exit 0
}

# ── 开关：虚拟屏与 keeper 绑定（用户要求：keeper 跟着虚拟屏生、跟着虚拟屏死）──
$enableFlag = Join-Path $env:TEMP 'picophone-vdd.enable'
$keeperCmd = 'pwsh.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Serve'

function Get-Keepers {
  Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*-File*vdd.ps1*Serve*' -and $_.CommandLine -notlike '*Get-CimInstance*' }
}

if ($Enable) {
  New-Item -ItemType File -Path $enableFlag -Force | Out-Null
  $existing = Get-Keepers
  if ($existing) { "keeper 已在运行: " + (($existing | ForEach-Object { $_.ProcessId }) -join ',') }
  else {
    # 用绝对路径的 pwsh + Start-Process：WMI 创建时 PATH 里不一定有 pwsh.exe（实测起来就退）。
    $pwshExe = (Get-Process -Id $PID).Path
    $p = Start-Process -FilePath $pwshExe -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Serve') -WindowStyle Hidden -PassThru
    "keeper 已拉起: pid=$($p.Id)"
  }
  Start-Sleep -Seconds 7
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  $scr = [System.Windows.Forms.Screen]::AllScreens
  "屏幕数=$($scr.Count)"; foreach ($s in $scr) { "  $($s.DeviceName) $($s.Bounds.Width)x$($s.Bounds.Height) @$($s.Bounds.X),$($s.Bounds.Y)" }
  exit 0
}

if ($Disable) {
  # 必须先关窗、再停 keeper：keeper 被强杀时 finally 不会执行，
  # 而虚拟屏一拔，屏上的窗口就会被 Windows 甩回主屏（用户会突然看到本来看不见的窗口）。
  $closer = Join-Path $PSScriptRoot 'close-vd-windows.ps1'
  if (Test-Path $closer) { & pwsh -NoProfile -File $closer -GraceMs 800 2>$null | ForEach-Object { "  $_" } }
  Start-Sleep -Milliseconds 300
  $k = Get-Keepers
  foreach ($p in $k) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  "已停 keeper: " + $(if ($k) { ($k | ForEach-Object { $_.ProcessId }) -join ',' } else { '(无)' })
  Remove-Item $enableFlag -Force -ErrorAction SilentlyContinue
  $confine = Join-Path $PSScriptRoot 'confine-cursor.ps1'
  if (Test-Path $confine) { & pwsh -NoProfile -File $confine -Off 2>$null | Out-Null }
  Start-Sleep -Seconds 4
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  "屏幕数=" + ([System.Windows.Forms.Screen]::AllScreens | Measure-Object).Count + "  鼠标裁剪已解除"
  exit 0
}

if (-not ('VddCtl' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class VddCtl {
  [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
  public static extern int CM_Get_Device_Interface_List_SizeW(out uint len, ref Guid guid, IntPtr devId, uint flags);
  [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
  public static extern int CM_Get_Device_Interface_ListW(ref Guid guid, IntPtr devId, StringBuilder buf, uint len, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inBuf, uint inSize, byte[] outBuf, uint outSize, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inBuf, uint inSize, out uint outVal, uint outSize, out uint returned, IntPtr overlapped);

  public static readonly Guid ADAPTER = new Guid("00b41627-04c4-429e-a26e-0265cf50c8fa");
  public const uint IOCTL_ADD = 0x0022e004;
  public const uint IOCTL_REMOVE = 0x0022a008;
  public const uint IOCTL_UPDATE = 0x0022a00c;
  const uint GENERIC_RW = 0xC0000000;
  const uint SHARE_RW = 0x00000003;
  const uint OPEN_EXISTING = 3;
  const uint FILE_FLAG_OVERLAPPED = 0x40000000;
  const uint FILE_ATTRIBUTE_NORMAL = 0x80;

  public static string FindInterface() {
    Guid g = ADAPTER;
    uint len = 0;
    int rc = CM_Get_Device_Interface_List_SizeW(out len, ref g, IntPtr.Zero, 1);
    if (rc != 0 || len == 0) return null;
    var sb = new StringBuilder((int)len);
    rc = CM_Get_Device_Interface_ListW(ref g, IntPtr.Zero, sb, len, 1);
    if (rc != 0) return null;
    string all = sb.ToString();
    foreach (string s in all.Split('\0')) if (s.Length > 0) return s;
    return null;
  }

  public static IntPtr Open() {
    string path = FindInterface();
    if (path == null) return IntPtr.Zero;
    IntPtr h = CreateFileW(path, GENERIC_RW, SHARE_RW, IntPtr.Zero, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED, IntPtr.Zero);
    return h;
  }

  // 同步等待：用 OVERLAPPED + 事件，等价于头文件里的 GetOverlappedResultEx(5s)
  [StructLayout(LayoutKind.Sequential)]
  public struct NativeOverlappedLite {
    public IntPtr Internal, InternalHigh, Offset, OffsetHigh, hEvent;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateEventW(IntPtr sa, bool manual, bool initial, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetOverlappedResult(IntPtr hFile, ref NativeOverlappedLite ov, out uint transferred, bool wait);

  public static int Ioctl(IntPtr h, uint code, byte[] data, int dataLen) {
    if (h == IntPtr.Zero) return -1;
    byte[] inBuf = new byte[32];
    if (data != null && dataLen > 0) Array.Copy(data, inBuf, Math.Min(dataLen, 32));
    var ov = new NativeOverlappedLite();
    ov.hEvent = CreateEventW(IntPtr.Zero, true, false, IntPtr.Zero);
    uint returned = 0, transferred = 0;
    byte[] outBuf = new byte[4];
    bool ok = DeviceIoControl(h, code, inBuf, (uint)inBuf.Length, outBuf, 4, out returned, IntPtr.Zero);
    int val = -1;
    if (ok) {
      val = BitConverter.ToInt32(outBuf, 0);
    } else {
      uint err = (uint)Marshal.GetLastWin32Error();
      if (err == 997) { // ERROR_IO_PENDING
        WaitForSingleObject(ov.hEvent, 5000);
        if (GetOverlappedResult(h, ref ov, out transferred, true) && transferred >= 4)
          val = BitConverter.ToInt32(outBuf, 0);
      }
    }
    if (ov.hEvent != IntPtr.Zero) CloseHandle(ov.hEvent);
    return val;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool EnumDisplayDevicesW(string dev, uint devNum, ref DISPLAY_DEVICE dd, uint flags);

  /// 枚举适配器（不是监视器）；StateFlags bit0=ATTACHED_TO_DESKTOP bit1=MULTI_DRIVER bit2=PRIMARY_DEVICE
  public static string EnumDisplayDevice(int index) {
    var dd = new DISPLAY_DEVICE();
    dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
    if (!EnumDisplayDevicesW(null, (uint)index, ref dd, 0)) return null;
    bool attached = (dd.StateFlags & 0x1) != 0;
    bool primary = (dd.StateFlags & 0x4) != 0;
    return string.Format("{0} [{1}]{2}{3}", dd.DeviceString, dd.DeviceName, attached ? "" : " (未附加)", primary ? " ★主屏" : "");
  }

  public static int Add(IntPtr h) { int i = Ioctl(h, IOCTL_ADD, null, 0); Ioctl(h, IOCTL_UPDATE, null, 0); return i; }
  public static void Ping(IntPtr h) { Ioctl(h, IOCTL_UPDATE, null, 0); }
  public static void Remove(IntPtr h, int index) {
    // 16-bit BE
    ushort v = (ushort)(((index & 0xFF) << 8) | ((index >> 8) & 0xFF));
    Ioctl(h, IOCTL_REMOVE, BitConverter.GetBytes(v), 2);
    Ioctl(h, IOCTL_UPDATE, null, 0);
  }
}
'@
}

function Show-Status {
  $dev = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Parsec' -or $_.InstanceId -match 'DISPLAY\\0000' }
  if ($dev) { foreach ($d in $dev) { "设备: $($d.FriendlyName) | $($d.Status)" } } else { '设备: 未找到 Parsec 虚拟显示适配器' }
  $mons = @()
  for ($i = 0; $i -lt 8; $i++) {
    $d = [VddCtl]::EnumDisplayDevice($i)
    if ($null -eq $d) { break }
    $mons += $d
  }
"显示器(适配器级): $($mons.Count)"
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $screens = [System.Windows.Forms.Screen]::AllScreens
    "实际屏幕数: $($screens.Count)"
    foreach ($s in $screens) { "  $($s.DeviceName)  $($s.Bounds.Width)x$($s.Bounds.Height) @$($s.Bounds.X),$($s.Bounds.Y)  primary=$($s.Primary)" }
  } catch { }
  foreach ($m in $mons) { "  $m" }
}

  if ($Serve) {
    # 总开关：没有这个标志文件就直接退出。
    # 原因：别的会话会反复把 keeper 拉起来，而每插一次虚拟显示器，Windows 就会重排窗口
    # （用户看到的就是“到处弹窗”）。有开关后，乱拉也只会空转，不会插屏。
    $enableFlag = Join-Path $env:TEMP 'picophone-vdd.enable'
    if (-not (Test-Path $enableFlag)) {
      [Console]::Error.WriteLine('[vdd] 未启用（缺 picophone-vdd.enable），本实例不插屏、直接退出')
      exit 0
    }
    # 单实例守卫：两个 keeper 并存会互相抢，实测会退化成"进程在、屏不亮"，
    # 而且杀掉其中一个时那块屏会跟着消失（屏是跟着"加它的那个 keeper"活的）。
    $mutex = New-Object System.Threading.Mutex($false, 'PicoVddKeeper')
    if (-not $mutex.WaitOne(0)) {
      [Console]::Error.WriteLine('[vdd] 已有 keeper 在运行，本实例退出（避免双 keeper 抢设备）')
      exit 0
    }
  } elseif ($Status -or (-not $Add -and $Remove -lt 0)) {
    Show-Status
    if (-not $Add -and $Remove -lt 0) { exit 0 }
  }

$h = [VddCtl]::Open()
if ($h -eq [IntPtr]::Zero) {
  [Console]::Error.WriteLine('打不开 VDD 设备接口：驱动没装好，或接口 GUID 不匹配。')
  exit 2
}
"设备接口: $([VddCtl]::FindInterface())"

try {
  if ($Add) {
    $idx = [VddCtl]::Add($h)
    if ($idx -lt 0) { [Console]::Error.WriteLine('ADD 返回 -1：驱动拒绝（常见于 0.38 版本或设备异常）'); exit 3 }
    "已插入虚拟显示器 index=$idx"
  }
  if ($Remove -ge 0) {
    [VddCtl]::Remove($h, $Remove)
    "已拔掉 index=$Remove"
  }
  if ($Serve) {
    $logPath = Join-Path $env:TEMP 'vdd-keeper.log'
    "=== keeper 启动 $(Get-Date) ===" | Out-File -FilePath $logPath -Encoding utf8 -Append
    # 先确保有一块屏。实测：DSH 重启后 keeper 一启动就 ADD 常常返回 -1（驱动还没就绪），
    # 结果"进程在、屏不出来"。这里重试到真的加出来为止。
    $existing = -1
    for ($try = 1; $try -le 15; $try++) {
      $existing = [VddCtl]::Add($h)
      "ADD#$try -> $existing" | Out-File -FilePath $logPath -Encoding utf8 -Append
      if ($existing -ge 0) { break }
      Start-Sleep -Seconds 2
    }
      # 虚拟屏插上了，但它是"看不见的"：把物理鼠标锁在主屏内，别让用户把指针滑进去丢掉。
      # 解锁在 finally 里（keeper 退出即恢复），否则用户会莫名其妙被锁住。
      # ⚠️ 必须在本进程内锁鼠标：之前 spawn 一个 pwsh 去锁，那 2 秒里没 ping
      # ⇒ 驱动认为 keeper 死了 ⇒ 把刚插上的虚拟屏拔掉（实测：ADD 后屏出现又消失）。
      if (-not ('VddClip' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class VddClip {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr r);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  public static void ToPrimary() {
    RECT r = new RECT();
    r.Left = 0; r.Top = 0; r.Right = GetSystemMetrics(0); r.Bottom = GetSystemMetrics(1);
    IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RECT)));
    try { Marshal.StructureToPtr(r, p, false); ClipCursor(p); } finally { Marshal.FreeHGlobal(p); }
  }
  public static void Release() { ClipCursor(IntPtr.Zero); }
}
"@
      }
      [VddClip]::ToPrimary()
    $n = 0
    try {
      while ($true) {
        [VddCtl]::Ping($h)
          # 裁剪要**持续维持**：ClipCursor 是全局共享状态，任何别的进程（我们的 click-at 解裁剪、
          # 其它工具、甚至某些游戏）一调用就会清掉。之前只在插屏时锁一次，实测几分钟后鼠标就能跑进虚拟屏。
          # 每 20 次心跳（约 1 秒）重新锁一次，代价可以忽略。
          if ($n % 20 -eq 0) { try { [VddClip]::ToPrimary() } catch { } }
        Start-Sleep -Milliseconds 50
        $n++
        if ($n % 1200 -eq 0) { "alive $([int]($n/20)) s" | Out-File -FilePath $logPath -Encoding utf8 -Append }
          # 绑父进程：DSH 被硬杀时清理函数不会执行，只能靠这里发现"爹没了"→ 清理并退出，
          # 否则会留下一个继续 pinging 的孤儿 keeper 和一块没人管的假屏。
          if ($ParentPid -gt 0 -and ($n % 40 -eq 0)) {
            $parentAlive = $false
            try { $null = Get-Process -Id $ParentPid -ErrorAction Stop; $parentAlive = $true } catch { $parentAlive = $false }
            if (-not $parentAlive) {
              "父进程 $ParentPid 已消失，keeper 退出" | Out-File -FilePath $logPath -Encoding utf8 -Append
              break
            }
          }
      }
    } finally {
      # 虚拟屏一拔，屏上的窗口会被 Windows 甩回主屏（用户会突然看到一堆"本来看不见"的窗口）。
      # 所以退出时先把虚拟屏上的窗口关掉，再解除鼠标裁剪。只关非主屏上的窗口，主屏一律不碰。
      try {
        $closer = Join-Path $PSScriptRoot 'close-vd-windows.ps1'
        if (Test-Path $closer) { & pwsh -NoProfile -File $closer -GraceMs 800 2>$null | Out-File -FilePath $logPath -Encoding utf8 -Append }
      } catch { }
      try { [VddClip]::Release() } catch {} ; [void][VddCtl]::CloseHandle($h); "=== keeper 退出 $(Get-Date) ===" | Out-File -FilePath $logPath -Encoding utf8 -Append }
    exit 0
  }
  if ($KeepAliveSeconds -gt 0) {
    "保活 $KeepAliveSeconds 秒（每 50 ms ping 一次）…"
    $deadline = (Get-Date).AddSeconds($KeepAliveSeconds)
    while ((Get-Date) -lt $deadline) { [VddCtl]::Ping($h); Start-Sleep -Milliseconds 50 }
    '保活结束'
  }
}
finally { [void][VddCtl]::CloseHandle($h) }

Start-Sleep -Milliseconds 800
Show-Status














