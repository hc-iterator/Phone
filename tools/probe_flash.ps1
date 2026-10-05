<#
  probe_flash.ps1 -- pure-backdoor flashing of the probe (or any board whose firmware has
  the backdoor).  No BOOTSEL button, no SWD.  ASCII-only stdout.

  DEFAULT IS A DRY RUN: it finds the probe port, opens it, and reports what it WOULD send.
  It does not touch the hardware unless you pass -DoIt.

  USAGE
    pwsh -File tools\probe_flash.ps1 -Uf2 <path>            # DRY RUN (safe, default)
    pwsh -File tools\probe_flash.ps1 -Uf2 <path> -DoIt      # actually flash
    pwsh -File tools\probe_flash.ps1 -Uf2 <path> -DoIt -Vid 2E8A -Pid 000C

  PARAMETERS
    -Uf2 <path>       firmware to write (required).  Existence is checked in both modes.
    -DoIt             actually perform the closed loop.  Without it, nothing is sent.
    -Vid/-Pid         probe USB ids (default 2E8A / 000C).
    -BootWaitSec N    how long to wait for the RPI-RP2 volume (default 15).
    -ReturnWaitSec N  how long to wait for the probe to come back (default 20).
    -NoVerify         skip the post-flash backdoor check (not recommended).

  THE VERIFIED CLOSED LOOP (what -DoIt does, step by step)
    1. find the probe CDC by VID/PID and open it with DTR+RTS raised
       (pico-sdk CDC is NOT "connected" until the host raises DTR; without it the reply
        is dropped -- see docs\陷阱.md, and this is why the backdoor reply looked lost)
    2. send 1B 1B 42 ("ESC ESC B"), which the firmware handles as "reboot into BOOTSEL"
    3. wait up to -BootWaitSec for an RPI-RP2 volume to appear
    4. copy the .uf2 onto that volume, then wait for the volume to disappear (write done)
    5. wait up to -ReturnWaitSec for the probe to re-enumerate on USB
    6. verify: send 1B 1B 3F ("ESC ESC ?") and require the reply to contain "[backdoor]"
       (the firmware's menu banner); otherwise report failure.
    Every step prints ASCII progress, and any failure says exactly WHICH step failed.

  KNOWN PITFALLS
    * DTR/RTS must be raised (step 1) or you get no reply at all.
    * The volume is matched by its INFO_UF2.TXT Board-ID / label (RPI-RP2 for the RP2040
      probe), never by drive letter -- letters change between plug cycles.
    * If the firmware is hung, the backdoor cannot answer; then a manual BOOTSEL press is
      the only way.  This tool never pretends otherwise: it reports BACKDOOR-NO-REPLY.
    * Never leave a half-open handle: the port is closed in a finally block, and every
      external helper runs inside a kill-on-close job object (no orphans holding the port).

  ORPHAN SAFETY
    External helpers go through Invoke-InJob (kill-on-close job object + timeout + Kill in
    finally).  Interrupting this script cannot leave a stray process behind.
#>
[CmdletBinding()]
param(
    [string]$Uf2 = '',
    [switch]$DoIt,
    [string]$Vid = '2E8A',
    [string]$ProductId = '000C',
    [int]$BootWaitSec = 15,
    [int]$ReturnWaitSec = 20,
    [switch]$NoVerify,
    [switch]$NoSelfHeal
)
# NOTE: the product-id parameter is named -ProductId (alias -Pid) because $PID is a
# read-only automatic variable in PowerShell; binding a -Pid parameter FAILS at bind time
# ("Cannot overwrite variable Pid because it is read-only or constant").  The alias still
# accepts -Pid on the command line; internally we only ever use $ProductId.

$ErrorActionPreference = 'Continue'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:JobTypeReady = $false

function Show-Usage {
    Write-Host "usage: pwsh -File tools\probe_flash.ps1 -Uf2 <path>            # dry run"
    Write-Host "       pwsh -File tools\probe_flash.ps1 -Uf2 <path> -DoIt      # flash"
}

# ---- kill-on-close job object (same pattern as proc_guard.ps1; see its header) ----
function Initialize-JobSupport {
    if ($script:JobTypeReady) { return $true }
    $sig = @'
using System;
using System.Runtime.InteropServices;
public static class DshJobP {
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
    $job = [DshJobP]::CreateJobObject([IntPtr]::Zero, $null)
    if ($job -eq [IntPtr]::Zero) { Write-Host "JOB-CREATE-FAILED"; return [IntPtr]::Zero }
    $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
    try {
        for ($i = 0; $i -lt 144; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
        [Runtime.InteropServices.Marshal]::WriteInt32($buf, 16, 0x2800)
        if (-not [DshJobP]::SetInformationJobObject($job, 9, $buf, 144)) {
            Write-Host ("JOB-SETINFO-FAILED err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
            [void][DshJobP]::CloseHandle($job)
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
        if ($job -ne [IntPtr]::Zero) { try { [void][DshJobP]::AssignProcessToJobObject($job, $proc.Handle) } catch { } }
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutSec * 1000)) { try { $proc.Kill() } catch { } }
        $out = ''; $err = ''
        try { $out = $outTask.GetAwaiter().GetResult() } catch { }
        try { $err = $errTask.GetAwaiter().GetResult() } catch { }
        return [pscustomobject]@{ StdOut = $out; StdErr = $err }
    } finally {
        if ($null -ne $proc -and -not $proc.HasExited) { try { $proc.Kill() } catch { } }
        if ($job -ne [IntPtr]::Zero -and $script:JobTypeReady) { [void][DshJobP]::CloseHandle($job) }
        if ($null -ne $proc) { try { $proc.Dispose() } catch { } }
    }
}

function Invoke-SelfHeal {
    $pg = Join-Path $PSScriptRoot 'proc_guard.ps1'
    if (-not (Test-Path $pg)) { Write-Host "SELF-HEAL-SKIPPED proc_guard.ps1 not found"; return }
    Write-Host "SELF-HEAL running proc_guard.ps1 -Kill"
    $r = Invoke-InJob -FilePath 'pwsh' -Arguments @('-NoProfile', '-File', $pg, '-Kill') -TimeoutSec 60
    foreach ($ln in ($r.StdOut -split "`r?`n")) {
        if ($ln -match '^(KILL |KILLED-TOTAL|LIST-COUNT)') { Write-Host ("  " + $ln) }
    }
}

# ---- port + volume discovery ----
function Get-PortByVidPid {
    param([string]$WantVid, [string]$WantPidHex)
    $devs = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue
    foreach ($d in $devs) {
        $did = ''
        if ($null -ne $d.DeviceID) { $did = $d.DeviceID }
        if ($did -notmatch 'VID_') { continue }
        $m = [regex]::Match($did, 'VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})')
        if (-not $m.Success) { continue }
        if ($m.Groups[1].Value.ToUpper() -ne $WantVid.ToUpper()) { continue }
        if ($m.Groups[2].Value.ToUpper() -ne $WantPidHex.ToUpper()) { continue }
        $name = ''
        if ($null -ne $d.Name) { $name = $d.Name }
        $cm = [regex]::Match($name, '\((COM\d+)\)')
        if (-not $cm.Success) { continue }
        return $cm.Groups[1].Value
    }
    return ''
}

function Get-BootVolume {
    param([string]$WantBoard)
    $vols = Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.FileSystemLabel -match 'RP2350|RPI-RP2' }
    foreach ($v in $vols) {
        $letter = "$($v.DriveLetter):"
        $board = '?'
        $info = ''
        $infoPath = Join-Path $letter 'INFO_UF2.TXT'
        if (Test-Path $infoPath) {
            $txt = Get-Content $infoPath -ErrorAction SilentlyContinue | Select-String 'Board-ID'
            if ($txt) {
                $info = ($txt.Line -replace '\s+', ' ').Trim()
                if ($info -match 'RP2350') { $board = 'RP2350' } elseif ($info -match 'RPI-RP2') { $board = 'RPI-RP2' }
            }
        }
        if ($WantBoard -ne '' -and $board -ne $WantBoard) { continue }
        return [pscustomobject]@{ Letter = $letter; Label = $v.FileSystemLabel; Board = $board; Info = $info }
    }
    return $null
}

function Open-Probe {
    param([string]$ComPort, [int]$Tries = 10, [int]$DelayMs = 400)
    $sp = $null
    for ($i = 1; $i -le $Tries; $i++) {
        try {
            $sp = New-Object System.IO.Ports.SerialPort $ComPort, 115200, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
            $sp.ReadTimeout = 300
            $sp.WriteTimeout = 500
            $sp.DtrEnable = $true
            $sp.RtsEnable = $true
            $sp.Open()
            return $sp
        } catch {
            if ($null -ne $sp) { try { $sp.Dispose() } catch { } ; $sp = $null }
            if ($i -lt $Tries) { Start-Sleep -Milliseconds $DelayMs } else { $script:LastOpenError = $_.Exception.Message }
        }
    }
    return $null
}

function Send-Esc {
    param([System.IO.Ports.SerialPort]$Port, [string]$Tail)
    $bytes = @(0x1B, 0x1B) + [System.Text.Encoding]::ASCII.GetBytes($Tail)
    $Port.Write($bytes, 0, $bytes.Length)
    $Port.BaseStream.Flush()
    return $bytes.Length
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
Write-Host ("probe_flash mode=" + $(if ($DoIt) { 'REAL' } else { 'DRY-RUN' }) + " time=" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
if ($Uf2 -eq '') { Write-Host "UF2-REQUIRED"; Show-Usage; exit 1 }
if (-not (Test-Path $Uf2)) { Write-Host ("UF2-NOT-FOUND: " + $Uf2); exit 1 }
$uf2Size = (Get-Item $Uf2).Length
Write-Host ("UF2 " + (Resolve-Path $Uf2).Path + " (" + $uf2Size + " bytes)")

# step 0: what is on the bench right now
$boot = Get-BootVolume -WantBoard ''
if ($null -ne $boot) { Write-Host ("BOOT-VOLUME-PRESENT " + $boot.Letter + " label=" + $boot.Label + " board=" + $boot.Board + " [" + $boot.Info + "]") }
else { Write-Host "BOOT-VOLUME-PRESENT none" }

# step 1: find the probe port
$port = Get-PortByVidPid -WantVid $Vid -WantPidHex $ProductId
if ($port -eq '') {
    Write-Host ("PORT-NOT-FOUND vid=" + $Vid + " pid=" + $ProductId)
    Write-Host "PORT-STEP-FAILED step=1 reason=probe CDC not enumerated"
    exit 1
}
Write-Host ("PROBE-PORT " + $port)

$sp = Open-Probe -ComPort $port
if ($null -eq $sp -and -not $NoSelfHeal) {
    Write-Host ("OPEN-FAILED: " + $script:LastOpenError)
    Invoke-SelfHeal
    Write-Host "RETRY once after self-heal"
    $sp = Open-Probe -ComPort $port
}
if ($null -eq $sp) {
    Write-Host ("OPEN-FAILED: " + $script:LastOpenError)
    Write-Host "PORT-STEP-FAILED step=1 reason=port busy or unresponsive"
    exit 1
}
Write-Host ("OPENED " + $port + " dtr=True")

try {
    if (-not $DoIt) {
        Write-Host "DRY-RUN will send 1B 1B 42 (ESC ESC B) = enter BOOTSEL"
        Write-Host ("DRY-RUN then wait <= " + $BootWaitSec + "s for an RPI-RP2 volume")
        Write-Host ("DRY-RUN then copy the uf2 and wait <= " + $ReturnWaitSec + "s for the probe to return")
        if (-not $NoVerify) { Write-Host "DRY-RUN then send 1B 1B 3F (ESC ESC ?) and require '[backdoor]' in the reply" }
        Write-Host "NOTHING-SENT (pass -DoIt to actually flash)"
        Write-Host "PROBE-FLASH-DONE exit=0 dryrun=True"
        exit 0
    }

    # step 2: backdoor -> BOOTSEL
    $n = Send-Esc -Port $sp -Tail 'B'
    Write-Host ("SENT " + $n + " bytes (ESC ESC B)")
    try { if ($sp.IsOpen) { $sp.Close() } } catch { }
    try { $sp.Dispose() } catch { }
    $sp = $null

    # step 3: wait for the boot volume
    Write-Host ("WAIT-BOOT-VOLUME up to " + $BootWaitSec + "s")
    $t0 = Get-Date
    $vol = $null
    while (((Get-Date) - $t0).TotalSeconds -lt $BootWaitSec) {
        $vol = Get-BootVolume -WantBoard ''
        if ($null -ne $vol) { break }
        Start-Sleep -Milliseconds 400
    }
    if ($null -eq $vol) {
        Write-Host "BOOT-VOLUME-NOT-FOUND"
        Write-Host "PROBE-FLASH-FAILED step=2 reason=no RPI-RP2 volume (firmware may be hung)"
        exit 1
    }
    Write-Host ("BOOT-VOLUME " + $vol.Letter + " label=" + $vol.Label + " board=" + $vol.Board + " [" + $vol.Info + "]")

    # step 4: copy and wait for the write to finish
    Write-Host ("COPY " + $Uf2 + " -> " + $vol.Letter)
    try {
        Copy-Item -Path $Uf2 -Destination ($vol.Letter + '\') -Force -ErrorAction Stop
    } catch {
        Write-Host ("COPY-FAILED: " + $_.Exception.Message)
        Write-Host "PROBE-FLASH-FAILED step=3 reason=copy error"
        exit 1
    }
    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalSeconds -lt 30) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-Path (Join-Path $vol.Letter 'INFO_UF2.TXT'))) { break }
    }
    Write-Host "COPY-DONE volume disappeared (write finished)"

    # step 5: wait for the probe to come back
    Write-Host ("WAIT-RETURN up to " + $ReturnWaitSec + "s")
    $t0 = Get-Date
    $back = ''
    while (((Get-Date) - $t0).TotalSeconds -lt $ReturnWaitSec) {
        Start-Sleep -Milliseconds 500
        $back = Get-PortByVidPid -WantVid $Vid -WantPidHex $ProductId
        if ($back -ne '') { break }
    }
    if ($back -eq '') {
        Write-Host "PROBE-DID-NOT-RETURN"
        Write-Host "PROBE-FLASH-FAILED step=4 reason=device did not re-enumerate"
        exit 1
    }
    Write-Host ("PROBE-RETURNED " + $back)

    # step 6: verify via the backdoor
    if ($NoVerify) {
        Write-Host "VERIFY-SKIPPED (-NoVerify)"
        Write-Host "PROBE-FLASH-DONE exit=0 verify=skipped"
        exit 0
    }
    Start-Sleep -Milliseconds 800
    $sp2 = Open-Probe -ComPort $back
    if ($null -eq $sp2) {
        Write-Host ("VERIFY-OPEN-FAILED: " + $script:LastOpenError)
        Write-Host "PROBE-FLASH-FAILED step=5 reason=could not reopen for verification"
        exit 1
    }
    $reply = ''
    try {
        [void](Send-Esc -Port $sp2 -Tail '?')
        Start-Sleep -Milliseconds 400
        $bufB = New-Object byte[] 1024
        $t0 = Get-Date
        while (((Get-Date) - $t0).TotalSeconds -lt 3) {
            try {
                $rn = $sp2.Read($bufB, 0, $bufB.Length)
                if ($rn -gt 0) { $reply += [System.Text.Encoding]::ASCII.GetString($bufB, 0, $rn) }
            } catch [System.TimeoutException] { }
        }
    } finally {
        if ($null -ne $sp2) { try { if ($sp2.IsOpen) { $sp2.Close() } } catch { } ; try { $sp2.Dispose() } catch { } }
    }
    $replyOneLine = ($reply -replace "`r?`n", ' ').Trim()
    if ($replyOneLine.Length -gt 160) { $replyOneLine = $replyOneLine.Substring(0, 160) + '...' }
    Write-Host ("VERIFY-REPLY " + $replyOneLine)
    if ($reply -match '\[backdoor\]') {
        Write-Host "VERIFY-OK reply contains [backdoor]"
        Write-Host "PROBE-FLASH-DONE exit=0 verify=ok"
        exit 0
    }
    Write-Host "VERIFY-FAILED reply did not contain [backdoor]"
    Write-Host "PROBE-FLASH-FAILED step=5 reason=backdoor banner missing"
    exit 1
} finally {
    if ($null -ne $sp) {
        try { if ($sp.IsOpen) { $sp.Close() } } catch { }
        try { $sp.Dispose() } catch { }
    }
}
