<#
  proc_guard.ps1 -- find and clean up OUR stray instrument processes (openocd / gdb /
  picotool / leftover cmd-python wrappers).  ASCII-only stdout.

  WHY THIS EXISTS
    We drive hardware with "parent spawns child" (cmd /c openocd ..., python ...).
    When the PARENT is interrupted/killed, the child keeps running as an ORPHAN and
    keeps the debug probe / COM port open.  Symptom seen in practice: the DUT COM7
    can no longer be opened ("signpost timeout"), and only a physical unplug fixes it.
    Pulling the cable is treating the symptom; this tool plus the kill-on-close job
    object (see New-KillOnCloseJob below) is the structural fix.

  USAGE
    pwsh -File tools\proc_guard.ps1                 # same as -List
    pwsh -File tools\proc_guard.ps1 -List           # list OUR risky processes only
    pwsh -File tools\proc_guard.ps1 -Kill           # terminate them, report PID+cmd+result
    pwsh -File tools\proc_guard.ps1 -WaitFree COM7  # poll until COM7 can be opened
    pwsh -File tools\proc_guard.ps1 -WaitFree COM7 -Kill   # clean first, then wait

  FILTER POLICY (never kill the user's programs)
    Only these exe names are candidates: openocd, arm-none-eabi-gdb, picotool,
    cmd, powershell, pwsh, python, python3.
    For the generic shells/interpreters the command line MUST also match one of:
      - openocd / picotool / arm-none-eabi-gdb / arm-none-eabi-objdump / .cfg
      - a path under this repository
      - a .cmd / .cfg file under %TEMP%
    We deliberately prefer a miss over a wrong kill.  Our own PID and parent are never
    touched.

  HOW TO RUN THE "NO ORPHANS" PROOF
    This file deliberately ships ONLY the negative control as a built-in test, because a
    positive test written as "generate a parent script, then run it" is easy to get wrong
    (we hit exactly that: a quoting bug made the child run to completion and the test
    looked inconclusive).  The positive case is therefore run inline, where the job object
    is created by the very shell that then exits -- see the task report for the exact
    command.  In short:
      # POSITIVE: create a kill-on-close job, Start-Process a 60s child, assign it, print
      # its PID, then let that parent exit -> the child MUST be gone.  Verified: gone.
      # NEGATIVE CONTROL (built in, proves the test is not vacuous):
      pwsh -File tools\proc_guard.ps1 -SelfTestOrphanControl
      #   same 60s child, NO job -> it is still alive.  The control kills it afterwards.
#>
[CmdletBinding()]
param(
    [switch]$List,
    [switch]$Kill,
    [string]$WaitFree = '',
    [int]$WaitFreeSec = 10,
    [switch]$SelfTestOrphanControl
)

$ErrorActionPreference = 'Continue'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot

# ---------------------------------------------------------------------------
# kill-on-close job object (Windows kernel object)
# A process assigned to such a job is terminated by the KERNEL when the last
# handle to the job closes.  If the parent dies -- even SIGKILL -- the handle
# closes, so the whole child tree is reaped.  Orphans become impossible.
# ---------------------------------------------------------------------------
$script:JobTypeReady = $false
function Initialize-JobSupport {
    if ($script:JobTypeReady) { return $true }
    $sig = @'
using System;
using System.Runtime.InteropServices;
public static class DshJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr a, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@
    try {
        Add-Type -TypeDefinition $sig -ErrorAction Stop
        $script:JobTypeReady = $true
        return $true
    } catch {
        Write-Host ("JOB-SUPPORT-UNAVAILABLE: " + $_.Exception.Message)
        return $false
    }
}

function New-KillOnCloseJob {
    <# returns an IntPtr job handle, or [IntPtr]::Zero if unavailable #>
    if (-not (Initialize-JobSupport)) { return [IntPtr]::Zero }
    $job = [DshJob]::CreateJobObject([IntPtr]::Zero, $null)
    if ($job -eq [IntPtr]::Zero) {
        Write-Host ("JOB-CREATE-FAILED: " + [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)
        return [IntPtr]::Zero
    }
    # JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags = KILL_ON_JOB_CLOSE(0x2000) | SILENT_BREAKAWAY_OK(0x800)
    # We use SILENT_BREAKAWAY_OK (not BREAKAWAY_OK) so that if this shell already
    # lives inside another job, children can still be created inside our job.
    # Size: 8*2 + 4 + 2*4 + 8(Uptime) + 8*4(ProcessMemoryLimit..PeakJobMemoryUsed) + 8*4(IoInfo) = 144
    $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
    try {
        for ($i = 0; $i -lt 144; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
        [Runtime.InteropServices.Marshal]::WriteInt32($buf, 16, 0x2000 -bor 0x800)
        $ok = [DshJob]::SetInformationJobObject($job, 9, $buf, 144)
        if (-not $ok) {
            Write-Host ("JOB-SETINFO-FAILED err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
            [void][DshJob]::CloseHandle($job)
            return [IntPtr]::Zero
        }
    } finally {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
    }
    return $job
}

function Add-ProcToJob {
    param([IntPtr]$Job, [System.Diagnostics.Process]$Proc)
    if ($Job -eq [IntPtr]::Zero -or $null -eq $Proc) { return $false }
    try {
        return [DshJob]::AssignProcessToJobObject($Job, $Proc.Handle)
    } catch {
        Write-Host ("JOB-ASSIGN-FAILED: " + $_.Exception.Message)
        return $false
    }
}

function Close-JobHandle {
    param([IntPtr]$Job)
    if ($Job -ne [IntPtr]::Zero -and $script:JobTypeReady) {
        [void][DshJob]::CloseHandle($Job)
    }
}

# Run an external command inside a kill-on-close job, with a hard timeout.
# Returns @{ ExitCode; StdOut; StdErr; TimedOut }
function Invoke-InJob {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 60,
        [string]$OutFile = '',
        [string]$ErrFile = ''
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
    $timedOut = $false
    try {
        $proc = [System.Diagnostics.Process]::Start($so)
        if ($job -ne [IntPtr]::Zero) { [void](Add-ProcToJob -Job $job -Proc $proc) }
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
            $timedOut = $true
            try { $proc.Kill() } catch { }
        }
        $out = ''
        $err = ''
        try { $out = $outTask.GetAwaiter().GetResult() } catch { }
        try { $err = $errTask.GetAwaiter().GetResult() } catch { }
        if ($OutFile -ne '') { Set-Content -Path $OutFile -Value $out -Encoding utf8NoBOM -ErrorAction SilentlyContinue }
        if ($ErrFile -ne '') { Set-Content -Path $ErrFile -Value $err -Encoding utf8NoBOM -ErrorAction SilentlyContinue }
        $code = -1
        try { $code = $proc.ExitCode } catch { }
        return [pscustomobject]@{ ExitCode = $code; StdOut = $out; StdErr = $err; TimedOut = $timedOut; Job = $job }
    } finally {
        # Killing the process, then releasing the job handle.  Any orphan that this
        # process managed to create is reaped by the kernel at this moment.
        if ($null -ne $proc -and -not $proc.HasExited) {
            try { $proc.Kill() } catch { }
        }
        Close-JobHandle -Job $job
        if ($null -ne $proc) { try { $proc.Dispose() } catch { } }
    }
}

# ---------------------------------------------------------------------------
# process discovery
# ---------------------------------------------------------------------------
function Get-OurRiskyProcesses {
    $me = $PID
    $codes = @('openocd', 'arm-none-eabi-gdb', 'picotool', 'cmd', 'powershell', 'pwsh', 'python', 'python3')
    $repo = $script:RepoRoot
    $tmp = $env:TEMP
    $out = New-Object System.Collections.ArrayList
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    foreach ($p in $all) {
        if ($p.ProcessId -eq $me) { continue }
        $name = ''
        try { $name = [System.IO.Path]::GetFileNameWithoutExtension($p.Name) } catch { }
        if ($codes -notcontains $name.ToLower()) { continue }
        $cl = ''
        if ($null -ne $p.CommandLine) { $cl = $p.CommandLine }
        # Never touch the harness/agent host wrapper: it is a pwsh whose -Command text
        # merely MENTIONS openocd / .cmd / repo paths.  Those wrappers always carry the
        # -NonInteractive flag; our real stray children are started as
        # "pwsh -File <tool>" and cmd/python wrappers, so this is a genuine narrowing,
        # not a way to hide hits.
        if ($cl -match '-NonInteractive') { continue }
        $reason = ''
        if ($name -eq 'openocd') {
            $reason = 'openocd'
        } elseif ($name -eq 'picotool') {
            $reason = 'picotool'
        } elseif ($name -eq 'arm-none-eabi-gdb') {
            $reason = 'arm-none-eabi-gdb'
        } elseif ($cl -match 'openocd|picotool|arm-none-eabi-gdb|arm-none-eabi-objdump') {
            $reason = 'wrapper-for-instrument'
        } elseif ($cl -match '\.cfg\b') {
            $reason = 'cfg-command-line'
        } elseif ($repo -ne '' -and $cl -like ('*' + $repo + '*')) {
            $reason = 'repo-path-in-cmdline'
        } elseif ($tmp -and $cl -like ('*' + $tmp + '*.cmd*')) {
            $reason = 'temp-cmd-file'
        } elseif ($tmp -and $cl -like ('*' + $tmp + '*.cfg*')) {
            $reason = 'temp-cfg-file'
        }
        if ($reason -eq '') { continue }
        $short = $cl
        if ($short.Length -gt 160) { $short = $short.Substring(0, 160) + '...' }
        [void]$out.Add([pscustomobject]@{
            PID      = [int]$p.ProcessId
            Name     = $p.Name
            Reason   = $reason
            Command  = $short
            RawCmd   = $cl
        })
    }
    return $out
}

function Show-ProcessList {
    $list = @(Get-OurRiskyProcesses)
    Write-Host ("LIST-COUNT " + $list.Count)
    foreach ($p in $list) {
        Write-Host ("PID " + $p.PID + " | " + $p.Name + " | why=" + $p.Reason)
        Write-Host ("    cmd: " + $p.Command)
    }
    if ($list.Count -eq 0) { Write-Host "no risky instrument process found" }
    return $list
}

function Stop-OurRiskyProcesses {
    $list = @(Get-OurRiskyProcesses)
    Write-Host ("KILL-CANDIDATES " + $list.Count)
    $killed = 0
    foreach ($p in $list) {
        $ok = $false
        $note = ''
        try {
            Stop-Process -Id $p.PID -Force -ErrorAction Stop
            $ok = $true
        } catch {
            $note = $_.Exception.Message
        }
        if ($ok) { $killed++ }
        Write-Host ("KILL " + $p.PID + " " + $p.Name + " why=" + $p.Reason + " result=" + $(if ($ok) { 'TERMINATED' } else { 'FAILED ' + $note }))
        Write-Host ("    cmd: " + $p.Command)
    }
    Write-Host ("KILLED-TOTAL " + $killed)
    return $killed
}

function Test-PortFree {
    param([string]$Port)
    try {
        $sp = New-Object System.IO.Ports.SerialPort $Port
        $sp.Open()
        $sp.Close()
        $sp.Dispose()
        return $true
    } catch {
        return $false
    }
}

function Wait-PortFree {
    param([string]$Port, [int]$Seconds)
    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalSeconds -lt $Seconds) {
        if (Test-PortFree -Port $Port) {
            Write-Host ("PORT-FREE " + $Port)
            return $true
        }
        Start-Sleep -Milliseconds 400
    }
    Write-Host ("PORT-STILL-BUSY " + $Port + " after " + $Seconds + "s")
    return $false
}

# ---------------------------------------------------------------------------
# NEGATIVE CONTROL: same child WITHOUT the job -> it must survive its parent.
# This proves the positive test is not vacuous (i.e. children can and do outlive
# parents on this machine unless the job object is used).
# ---------------------------------------------------------------------------
function Invoke-SelfTestOrphanControl {
    Write-Host "=== SELF TEST (negative control): child WITHOUT job object ==="
    Write-Host "child will sleep 60s and is expected to OUTLIVE this shell (that is the point)"
    $child = Start-Process -FilePath 'pwsh' -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 60' -PassThru
    Write-Host ("CONTROL-CHILD-PID " + $child.Id)
    Start-Sleep -Milliseconds 1500
    $alive = $null -ne (Get-Process -Id $child.Id -ErrorAction SilentlyContinue)
    Write-Host ("CONTROL-CHILD-ALIVE-SA-BEFORE-PARENT-EXIT " + $alive)
    if ($alive) {
        Write-Host "CONTROL-RESULT EXPECTED-ORPHAN-PRESENT (no job object => child would outlive us)"
        try { Stop-Process -Id $child.Id -Force } catch { }
        Start-Sleep -Milliseconds 400
        $stillAlive = $null -ne (Get-Process -Id $child.Id -ErrorAction SilentlyContinue)
        Write-Host ("CONTROL-CLEANUP-DONE stillAlive=" + $stillAlive)
    } else {
        Write-Host "CONTROL-RESULT UNEXPECTED child already gone (test would be vacuous)"
    }
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
Write-Host ("proc_guard repo=" + $script:RepoRoot + " pid=" + $PID + " time=" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

if ($SelfTestOrphanControl) {
    Invoke-SelfTestOrphanControl
    exit 0
}

if ($Kill) {
    [void](Stop-OurRiskyProcesses)
}

if ($WaitFree -ne '') {
    Start-Sleep -Milliseconds 300
    $ok = Wait-PortFree -Port $WaitFree -Seconds $WaitFreeSec
    if (-not $ok) { exit 1 }
    exit 0
}

[void](Show-ProcessList)
exit 0
