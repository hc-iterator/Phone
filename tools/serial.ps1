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
    -OpenTimeoutSec N   hard per-attempt budget for the blocking part (default 5).
                        Open() can block FOREVER on a busy port and ReadTimeout does not
                        cover it, so the blocking work runs in a child we can kill.
    -Retries N    extra attempts after the first (default 2).  Every attempt is bounded
                  by -OpenTimeoutSec, so a stuck port can never hang this script.
    -List         list matching ports and exit (touches no device).
    -NoSelfHeal   do not auto-clean stuck helper processes between attempts.

  TIMEOUT / ANTI-HANG CONTRACT (this is the important part)
    Nothing here touches the serial port in-process.  Each attempt starts
    tools\serial_worker.ps1 as a CHILD process inside a kill-on-close job object and waits
    with a hard timeout of (-OpenTimeoutSec + -Seconds + 3)s.  On expiry the child is
    killed and the port handle dies with it, so we cannot end up in the classic positive
    feedback where the hung helper itself keeps the port locked.  Outcomes:
      OPEN-TIMEOUT <port> after <N>s   child was killed; the port was busy/blocking
      OPEN-FAILED: <reason>            child exited with an error (e.g. access denied)
    Because the child lives in the job object, if THIS script is killed the kernel reaps
    the child too, so an orphan can never keep holding the port.

  OUTPUT (stable, ASCII, greppable)
    TARGET-PORT <port>
    BUDGET per attempt = <N>s ..., retries=<n>
    ATTEMPT <i>/<n> worker=...
    OPENED <port> dtr=True (child pid handled, elapsed <s>s)
    SENT <n> bytes
    CAPTURED <n> bytes -> <file>        (only with -OutFile)
    READ <n> bytes                      (always)
    OPEN-TIMEOUT <port> after <N>s
    OPEN-FAILED: <reason>
    PORT-NOT-FOUND: vid=.... pid=....

  KNOWN PITFALLS (all of these bit us for real)
    1. DTR/RTS MUST be raised.  pico-sdk's USB CDC does not consider itself connected
       until the host asserts DTR; without it the firmware's printf output is simply
       dropped, and you get nothing (which looks exactly like "the board is dead").
       The worker raises DTR+RTS unless -NoDtr is given.
    2. Open() on a port held by someone else blocks indefinitely with NO usable timeout.
       That is why the blocking work is a child process (see above).
    3. "signpost timeout" / access denied: a previous orphaned helper (or openocd) still
       holds the handle.  Between attempts we run proc_guard.ps1 -Kill; the real fix is
       the kill-on-close job object, which makes such orphans impossible.
    4. Do not send data unless you mean it: -Send can trigger the firmware's own
       backdoor (ESC ESC B enters BOOTSEL).  Nothing is sent unless -Send is given.
    5. -Pid is an alias of -ProductId because $PID is read-only in PowerShell.
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
    [int]$OpenTimeoutSec = 5,
    [int]$Retries = 2,
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

# Same as ConvertTo-Bytes but returns a hex string, because the worker child takes -SendHex.
function ConvertTo-Hex {
    param([string]$Text, [switch]$DoEscapes)
    $bytes = ConvertTo-Bytes -Text $Text -DoEscapes:$DoEscapes
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) { [void]$sb.Append($b.ToString('X2')) }
    return $sb.ToString()
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

# ---- run the blocking part in a child process, with a HARD timeout ----
# This is the whole point of serial_worker.ps1: Open() can block forever on a busy port
# and ReadTimeout does not cover it, so the open is bounded by killing the child instead.
function Invoke-SerialChild {
    param(
        [string]$ComPort,
        [int]$TimeoutSecLocal,
        [switch]$RaiseDtr,
        [string]$WantFile
    )
    $worker = Join-Path $PSScriptRoot 'serial_worker.ps1'
    if (-not (Test-Path $worker)) {
        Write-Host "WORKER-MISSING: serial_worker.ps1 not found"
        return [pscustomobject]@{ Ok = $false; TimedOut = $false; Bytes = 0; File = ''; Error = 'worker missing'; StdOut = ''; Secs = 0 }
    }
    $wargs = @('-NoProfile', '-File', $worker, '-Port', $ComPort, '-Baud', "$Baud", '-DurationSec', "$Seconds")
    if (-not $RaiseDtr) { $wargs += '-NoDtr' }
    if ($WantFile -ne '') { $wargs += @('-OutFile', $WantFile) }
    if ($Send -ne '') { $wargs += @('-SendHex', (ConvertTo-Hex -Text $Send -DoEscapes:$Escapes)) }
    $t0 = Get-Date
    $r = Invoke-InJob -FilePath 'pwsh' -Arguments $wargs -TimeoutSec $TimeoutSecLocal
    $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    $text = ($r.StdOut + "`n" + $r.StdErr)
    $bytes = 0
    $file = ''
    $err = ''
    $ok = $false
    foreach ($ln in ($text -split "`r?`n")) {
        if ($ln -match '^WORKER-BYTES:\s*(\d+)') { $bytes = [int]$Matches[1] }
        elseif ($ln -match '^WORKER-FILE:\s*(.+)$') { $file = $Matches[1].Trim() }
        elseif ($ln -match '^WORKER-ERROR:\s*(.+)$') { $err = $Matches[1].Trim() }
        elseif ($ln -match '^WORKER-RESULT:\s*OK') { $ok = $true }
    }
    return [pscustomobject]@{
        Ok       = ($ok -and -not $r.TimedOut)
        TimedOut = [bool]$r.TimedOut
        Bytes    = $bytes
        File     = $file
        Error    = $err
        StdOut   = $text
        Secs     = $secs
    }
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
# One attempt budget = open timeout + the requested read window + a small margin.
$attemptBudget = $OpenTimeoutSec + $Seconds + 3
Write-Host ("BUDGET per attempt = " + $attemptBudget + "s (open " + $OpenTimeoutSec + "s + read " + $Seconds + "s + 3s), retries=" + $Retries)

$attempt = 0
$result = $null
$outPathForWorker = $OutFile
while ($attempt -lt $Retries + 1) {
    $attempt++
    Write-Host ("ATTEMPT " + $attempt + "/" + ($Retries + 1) + " worker=pwsh -File tools\serial_worker.ps1 -Port " + $Port)
    $result = Invoke-SerialChild -ComPort $Port -TimeoutSecLocal $attemptBudget -RaiseDtr:$raiseDtr -WantFile $outPathForWorker
    if ($result.Ok) { break }
    if ($result.TimedOut) {
        Write-Host ("OPEN-TIMEOUT " + $Port + " after " + $attemptBudget + "s (child killed; a busy port can block Open() forever)")
    } else {
        if ($result.Error -ne '') { Write-Host ("OPEN-FAILED: " + $result.Error) } else { Write-Host "OPEN-FAILED: worker reported failure" }
    }
    if ($attempt -le $Retries) {
        if (-not $NoSelfHeal) { Invoke-SelfHeal }
        Write-Host ("RETRY " + $attempt + " done, trying again")
    }
}

foreach ($ln in ($result.StdOut -split "`r?`n")) {
    if ($ln -match '^WORKER-(OPENED|SENT|CAPTURED|CLOSED)') { Write-Host $ln.Trim() }
}
if ($result.Ok) {
    Write-Host ("OPENED " + $Port + " dtr=" + $raiseDtr + " (child pid handled, elapsed " + $result.Secs + "s)")
    if ($OutFile -ne '') { Write-Host ("CAPTURED " + $result.Bytes + " bytes -> " + $OutFile) }
    Write-Host ("READ " + $result.Bytes + " bytes")
    exit 0
}

Write-Host ("ELAPSED-TOTAL approx " + $attempt + " attempt(s)")
if ($result.TimedOut) { Write-Host ("OPEN-TIMEOUT " + $Port + " after " + $attemptBudget + "s") }
else { Write-Host ("OPEN-FAILED: " + $(if ($result.Error -ne '') { $result.Error } else { 'worker reported failure' })) }
exit 1
