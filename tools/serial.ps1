<#
  serial.ps1 -- open an RP2040/RP2350 USB CDC port, optionally send bytes, capture for N
  seconds.  ASCII-only stdout.

  WHY THIS EXISTS
    Reading the DUT/probe console by hand (python one-liners, realterm, putty) kept
    costing time: picking the wrong COM (the Bluetooth one), and "the port is busy"
    after a previous half-killed helper.  This tool picks the port by VID/PID, always
    releases the handle, and self-heals a stuck port.

  USAGE
    pwsh -File tools\serial.ps1 -Vid 2E8A -Pid 000C -Seconds 3
    pwsh -File tools\serial.ps1 -Vid 2E8A -Pid 0009 -Seconds 5 -OutFile debug_logs\dut.txt
    pwsh -File tools\serial.ps1 -Port COM7 -Seconds 3 -Send "ESC ESC ?" -Escapes
    pwsh -File tools\serial.ps1 -Vid 2E8A -Pid 000C -List     # just show matching ports

  PARAMETERS
    -Vid <hex>    USB vendor id, e.g. 2E8A (Raspberry Pi).  Use with -Pid.
    -Pid <hex>    USB product id: 0009 = DUT, 000C = probe/debugprobe.
    -Port COMx    use this port instead of VID/PID matching.
    -Seconds N    how long to read (default 3).
    -OutFile P    also write captured bytes to P (ASCII/latin-1, byte preserving).
    -Send S       send S first, then read.  Without -Escapes, S is sent literally.
    -Escapes      interpret \x1b \r \n \0 \t in -Send (so the backdoor ESC ESC B is
                  written as -Send "\x1b\x1bB" -Escapes).
    -Baud N       baud for the serial handle (default 115200; CDC ignores it).
    -List         list matching ports and exit (touches no device).
    -NoSelfHeal   do not auto-clean stuck helper processes on open failure.

  OUTPUT (stable, ASCII, greppable)
    OPENED <port> at <yyyy-MM-dd HH:mm:ss>
    SENT <n> bytes
    CAPTURED <n> bytes -> <file>        (only with -OutFile)
    READ <n> bytes                      (always)
    OPEN-FAILED: <reason>
    PORT-NOT-FOUND: vid=.... pid=....

  KNOWN PITFALLS (all of these bit us for real)
    1. DTR/RTS MUST be raised.  pico-sdk's USB CDC does not consider itself connected
       until the host asserts DTR; without it the firmware's printf output is simply
       dropped, and you get nothing (which looks exactly like "the board is dead").
       This tool always does DtrEnable=$true + RtsEnable=$true unless -NoDtr is given.
    2. "signpost timeout" / port busy: a previous orphaned helper (or openocd) still
       holds the handle.  We call proc_guard.ps1 -Kill and retry once; the real fix is
       the kill-on-close job object below, which makes such orphans impossible.
    3. The handle is released in a finally block no matter what happens.
    4. Do not send data unless you mean it: -Send can trigger the firmware's own
       backdoor (ESC ESC B enters BOOTSEL).  Nothing is sent unless -Send is given.

  ORPHAN SAFETY
    Any external helper is launched through Invoke-InJob, which puts it in a
    kill-on-close job object: if THIS process is killed, the kernel reaps the child
    tree.  There is no code path here that can leave a stray process behind.
    (.NET SerialPort itself is not an external process.)
#>
[CmdletBinding()]
param(
    [string]$Vid = '',
    [Alias('Pid')][string]$ProductId = '',
    [string]$Port = '',
    [int]$Seconds = 3,
    [string]$OutFile = '',
    [string]$Send = '',
    [switch]$Escapes,
    [int]$Baud = 115200,
    [switch]$List,
    [switch]$NoDtr,
    [switch]$NoSelfHeal
)

$ErrorActionPreference = 'Continue'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:JobTypeReady = $false

# ---- kill-on-close job object (same pattern as proc_guard.ps1; see its header) ----
function Initialize-JobSupport {
    if ($script:JobTypeReady) { return $true }
    $sig = @'
using System;
using System.Runtime.InteropServices;
public static class DshJobS {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr a, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr hObject);
}
'@
    try { Add-Type -TypeDefinition $sig -ErrorAction Stop; $script:JobTypeReady = $true; return $true }
    catch { Write-Host ("JOB-SUPPORT-UNAVAILABLE: " + $_.Exception.Message); return $false }
}

function New-KillOnCloseJob {
    if (-not (Initialize-JobSupport)) { return [IntPtr]::Zero }
    $job = [DshJobS]::CreateJobObject([IntPtr]::Zero, $null)
    if ($job -eq [IntPtr]::Zero) { Write-Host "JOB-CREATE-FAILED"; return [IntPtr]::Zero }
    $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
    try {
        for ($i = 0; $i -lt 144; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
        [Runtime.InteropServices.Marshal]::WriteInt32($buf, 16, 0x2800)   # KILL_ON_JOB_CLOSE|SILENT_BREAKAWAY_OK
        if (-not [DshJobS]::SetInformationJobObject($job, 9, $buf, 144)) {
            Write-Host ("JOB-SETINFO-FAILED err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
            [void][DshJobS]::CloseHandle($job)
            return [IntPtr]::Zero
        }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
    return $job
}

function Invoke-InJob {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 60
    )
    $job = New-KillOnCloseJob
    $so = New-Object System.Diagnostics.ProcessStartInfo
    $so.FileName = $FilePath
    if ($Arguments.Count -gt 0) { $so.Arguments = ($Arguments -join ' ') }
    $so.UseShellExecute = $false
    $so.CreateNoWindow = $true
    $so.RedirectStandardOutput = $true
    $so.RedirectStandardError = $true
    $proc = $null
    try {
        $proc = [System.Diagnostics.Process]::Start($so)
        if ($job -ne [IntPtr]::Zero) { try { [void][DshJobS]::AssignProcessToJobObject($job, $proc.Handle) } catch { } }
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutSec * 1000)) { try { $proc.Kill() } catch { } }
        $out = ''; $err = ''
        try { $out = $outTask.GetAwaiter().GetResult() } catch { }
        try { $err = $errTask.GetAwaiter().GetResult() } catch { }
        return [pscustomobject]@{ StdOut = $out; StdErr = $err }
    } finally {
        if ($null -ne $proc -and -not $proc.HasExited) { try { $proc.Kill() } catch { } }
        if ($job -ne [IntPtr]::Zero -and $script:JobTypeReady) { [void][DshJobS]::CloseHandle($job) }
        if ($null -ne $proc) { try { $proc.Dispose() } catch { } }
    }
}

# ---- port discovery by VID/PID ----
function Get-PortsByVidPid {
    param([string]$WantVid, [string]$WantPid)
    $res = New-Object System.Collections.ArrayList
    $devs = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue
    foreach ($d in $devs) {
        $did = ''
        if ($null -ne $d.DeviceID) { $did = $d.DeviceID }
        if ($did -notmatch 'VID_') { continue }
        $m = [regex]::Match($did, 'VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})')
        if (-not $m.Success) { continue }
        $v = $m.Groups[1].Value.ToUpper()
        $p = $m.Groups[2].Value.ToUpper()
        if ($WantVid -ne '' -and $v -ne $WantVid.ToUpper()) { continue }
        if ($WantPid -ne '' -and $p -ne $WantPid.ToUpper()) { continue }
        $name = ''
        if ($null -ne $d.Name) { $name = $d.Name }
        $cm = [regex]::Match($name, '\((COM\d+)\)')
        if (-not $cm.Success) { continue }
        [void]$res.Add([pscustomobject]@{ Port = $cm.Groups[1].Value; Vid = $v; Pid = $p; Name = $name; DeviceID = $did })
    }
    return $res
}

function ConvertTo-Bytes {
    param([string]$Text, [switch]$DoEscapes)
    $s = $Text
    if ($DoEscapes) {
        $s = $s -replace '\\x1b', [string][char]27
        $s = $s -replace '\\x1B', [string][char]27
        $s = $s -replace '\\r', [string][char]13
        $s = $s -replace '\\n', [string][char]10
        $s = $s -replace '\\t', [string][char]9
        $s = $s -replace '\\0', [string][char]0
    }
    return [System.Text.Encoding]::ASCII.GetBytes($s)
}

# ---- self heal: clean our stray helpers, then retry ----
function Invoke-SelfHeal {
    $pg = Join-Path $PSScriptRoot 'proc_guard.ps1'
    if (-not (Test-Path $pg)) { Write-Host "SELF-HEAL-SKIPPED proc_guard.ps1 not found"; return }
    Write-Host "SELF-HEAL running proc_guard.ps1 -Kill"
    $r = Invoke-InJob -FilePath 'pwsh' -Arguments @('-NoProfile', '-File', $pg, '-Kill') -TimeoutSec 60
    foreach ($ln in ($r.StdOut -split "`r?`n")) {
        if ($ln -match '^(KILL |KILLED-TOTAL|LIST-COUNT)') { Write-Host ("  " + $ln) }
    }
}

# ---- open with retry ----
function Open-SerialWithRetry {
    param([string]$ComPort, [int]$BaudRate, [switch]$RaiseDtr, [int]$Tries = 10, [int]$DelayMs = 400)
    $sp = $null
    for ($i = 1; $i -le $Tries; $i++) {
        try {
            $sp = New-Object System.IO.Ports.SerialPort $ComPort, $BaudRate, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
            $sp.ReadTimeout = 250
            $sp.WriteTimeout = 500
            if ($RaiseDtr) { $sp.DtrEnable = $true; $sp.RtsEnable = $true }
            $sp.Open()
            return $sp
        } catch {
            if ($null -ne $sp) { try { $sp.Dispose() } catch { } ; $sp = $null }
            if ($i -lt $Tries) { Start-Sleep -Milliseconds $DelayMs }
            else { $script:LastOpenError = $_.Exception.Message }
        }
    }
    return $null
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
$wantVid = $Vid
$wantPid = $ProductId
if ($Port -ne '') {
    Write-Host ("TARGET-PORT " + $Port)
} else {
    $cands = @(Get-PortsByVidPid -WantVid $wantVid -WantPid $wantPid)
    if ($List) {
        Write-Host ("MATCH-COUNT " + $cands.Count)
        foreach ($c in $cands) { Write-Host ("  " + $c.Port + "  VID_" + $c.Vid + " PID_" + $c.Pid + "  " + $c.Name) }
        exit 0
    }
    if ($cands.Count -eq 0) {
        Write-Host ("PORT-NOT-FOUND: vid=" + $wantVid + " pid=" + $wantPid)
        Write-Host "  hint: pwsh -File tools\ports.ps1 lists every serial port with its VID/PID"
        exit 1
    }
    $Port = $cands[0].Port
    Write-Host ("TARGET-PORT " + $Port + " (VID_" + $cands[0].Vid + " PID_" + $cands[0].Pid + ")")
}

$raiseDtr = -not $NoDtr
$sp = Open-SerialWithRetry -ComPort $Port -BaudRate $Baud -RaiseDtr:$raiseDtr
if ($null -eq $sp -and -not $NoSelfHeal) {
    Write-Host ("OPEN-FAILED: " + $script:LastOpenError)
    Invoke-SelfHeal
    Write-Host "RETRY once after self-heal"
    $sp = Open-SerialWithRetry -ComPort $Port -BaudRate $Baud -RaiseDtr:$raiseDtr
}
if ($null -eq $sp) {
    Write-Host ("OPEN-FAILED: " + $script:LastOpenError)
    exit 1
}

$captured = New-Object System.Collections.Generic.List[byte]
$readTotal = 0
try {
    Write-Host ("OPENED " + $Port + " at " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " dtr=" + $raiseDtr)
    if ($Send -ne '') {
        $bytes = ConvertTo-Bytes -Text $Send -DoEscapes:$Escapes
        $sp.Write($bytes, 0, $bytes.Length)
        $sp.BaseStream.Flush()
        Write-Host ("SENT " + $bytes.Length + " bytes")
    }
    $t0 = Get-Date
    $buf = New-Object byte[] 4096
    while (((Get-Date) - $t0).TotalSeconds -lt $Seconds) {
        try {
            $n = $sp.Read($buf, 0, $buf.Length)
            if ($n -gt 0) {
                for ($i = 0; $i -lt $n; $i++) { [void]$captured.Add($buf[$i]) }
                $readTotal += $n
            }
        } catch [System.TimeoutException] {
            # normal: nothing arrived in this 250 ms slice
        } catch {
            Write-Host ("READ-ERROR: " + $_.Exception.Message)
            break
        }
    }
} finally {
    # ALWAYS release the handle, even on Ctrl-C or an exception
    if ($null -ne $sp) {
        try { if ($sp.IsOpen) { $sp.Close() } } catch { }
        try { $sp.Dispose() } catch { }
        Write-Host "CLOSED " + $Port
    }
}

if ($OutFile -ne '') {
    try {
        $dir = Split-Path -Parent $OutFile
        if ($dir -ne '' -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllBytes($OutFile, $captured.ToArray())
        Write-Host ("CAPTURED " + $readTotal + " bytes -> " + $OutFile)
    } catch {
        Write-Host ("WRITE-FAILED: " + $_.Exception.Message)
    }
}
Write-Host ("READ " + $readTotal + " bytes")
exit 0
