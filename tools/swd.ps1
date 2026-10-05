<#
  swd.ps1 -- thin, safe wrapper around the project's openocd so nobody has to hand-write
  a .cmd/.cfg again.  ASCII-only stdout.

  WHY THIS EXISTS
    Every SWD action used to mean hand-writing a .cmd plus a .cfg in %TEMP%, then fighting
    cmd quoting and OEM code pages.  This tool generates ASCII-only config files itself,
    runs openocd inside a kill-on-close job object (no orphans holding the probe), and
    prints a filtered result.

  USAGE
    pwsh -File tools\swd.ps1 probe
    pwsh -File tools\swd.ps1 dump 0x10000000 0x400 debug_logs\vec.bin
    pwsh -File tools\swd.ps1 program build\PicoPhone.elf
    pwsh -File tools\swd.ps1 program build\PicoPhone.elf -Reset
    pwsh -File tools\swd.ps1 flashprobe
    pwsh -File tools\swd.ps1 <cmd> -AdapterSpeed 500 -TimeoutSec 60 -Raw

  SUBCOMMANDS
    probe                 init + report SWD DPIDR (prints "DPIDR 0x....")
    dump <addr> <len> <file>   dump_image, then report bytes written and the file path
    program <elf> [-Reset]     program + verify; -Reset appends reset and runs the target
    flashprobe            flash probe 0 (works even where printing does not)

  OPTIONS
    -AdapterSpeed N       kHz (default 1000)
    -Target name          default rp2350.dap.core0
    -TimeoutSec N         hard timeout for the openocd process (default 60)
    -Raw                  also print the full unfiltered openocd output
    -NoSelfHeal           do not auto-clean a stuck probe session on failure

  ⚠️  ABOUT halt (read this before asking for it)
    On this target a BARE "halt" DOES NOT WORK: the cores never enter halted state and a
    later "resume" reports "not halted".  The only command that stops them is
    "reset halt" -- and it RESETS the target (the running firmware is destroyed).
    Therefore this tool NEVER halts by default: probe/dump/flashprobe do not touch the
    target's execution state.  If you really need a halt, pass -ResetHalt to probe/dump;
    it runs "reset halt" and the output says explicitly that the target was RESET.
    Note also: memory reads while the target RUNS return garbage, so a dump is only
    meaningful after reset halt -- which is exactly why -ResetHalt exists.

  ⚠️  WHY WE USE dump_image (and not mdw/reg)
    With this machine's openocd invocation, "mdw" and "reg" print NOTHING (no error, no
    output), which looks exactly like "SWD is not working".  Commands that do not rely on
    console printing are reliable here: "flash probe 0" and "dump_image <file> <addr> <n>"
    (write to a file, read it offline).  For registers, use the "pc:" report that
    "reset halt" already prints.

  ORPHAN SAFETY
    openocd is started in a kill-on-close job object; a hard timeout plus a finally block
    always kills it.  If this wrapper is interrupted, the kernel reaps openocd, so it can
    never keep holding the probe.  On failure we also auto-run proc_guard.ps1 -Kill once
    and retry, which clears strays left by older sessions.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Command = '',
    [Parameter(Position = 1)][string]$Arg1 = '',
    [Parameter(Position = 2)][string]$Arg2 = '',
    [Parameter(Position = 3)][string]$Arg3 = '',
    [int]$AdapterSpeed = 1000,
    [string]$Target = 'rp2350.dap.core0',
    [int]$TimeoutSec = 60,
    [switch]$Reset,
    [switch]$ResetHalt,
    [switch]$Raw,
    [switch]$NoSelfHeal
)

$ErrorActionPreference = 'Continue'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:JobTypeReady = $false
$script:LastOpenError = ''
$OpenOcd = Join-Path $env:USERPROFILE '.pico-sdk\openocd\0.12.0+dev\openocd.exe'
$OcdScripts = Join-Path $env:USERPROFILE '.pico-sdk\openocd\0.12.0+dev\scripts'
$script:WorkDir = Join-Path $env:TEMP ('dsh_swd_' + $PID)

function Show-Usage {
    Write-Host "usage: pwsh -File tools\swd.ps1 probe"
    Write-Host "       pwsh -File tools\swd.ps1 dump <addr> <len> <file>"
    Write-Host "       pwsh -File tools\swd.ps1 program <elf> [-Reset]"
    Write-Host "       pwsh -File tools\swd.ps1 flashprobe"
    Write-Host "note: bare halt does not work here; see the header comment of this file."
}

# ---- kill-on-close job object (same pattern as proc_guard.ps1; see its header) ----
function Initialize-JobSupport {
    if ($script:JobTypeReady) { return $true }
    $sig = @'
using System;
using System.Runtime.InteropServices;
public static class DshJobW {
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
    $job = [DshJobW]::CreateJobObject([IntPtr]::Zero, $null)
    if ($job -eq [IntPtr]::Zero) { Write-Host "JOB-CREATE-FAILED"; return [IntPtr]::Zero }
    $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
    try {
        for ($i = 0; $i -lt 144; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
        [Runtime.InteropServices.Marshal]::WriteInt32($buf, 16, 0x2800)
        if (-not [DshJobW]::SetInformationJobObject($job, 9, $buf, 144)) {
            Write-Host ("JOB-SETINFO-FAILED err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
            [void][DshJobW]::CloseHandle($job)
            return [IntPtr]::Zero
        }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
    return $job
}

function Invoke-InJob {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSecLocal = 60
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
        if ($job -ne [IntPtr]::Zero) { try { [void][DshJobW]::AssignProcessToJobObject($job, $proc.Handle) } catch { } }
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutSecLocal * 1000)) {
            $timedOut = $true
            try { $proc.Kill() } catch { }
        }
        $out = ''; $err = ''
        try { $out = $outTask.GetAwaiter().GetResult() } catch { }
        try { $err = $errTask.GetAwaiter().GetResult() } catch { }
        $code = -1
        try { $code = $proc.ExitCode } catch { }
        return [pscustomobject]@{ ExitCode = $code; StdOut = $out; StdErr = $err; TimedOut = $timedOut }
    } finally {
        if ($null -ne $proc -and -not $proc.HasExited) { try { $proc.Kill() } catch { } }
        if ($job -ne [IntPtr]::Zero -and $script:JobTypeReady) { [void][DshJobW]::CloseHandle($job) }
        if ($null -ne $proc) { try { $proc.Dispose() } catch { } }
    }
}

function Show-Filtered {
    param([string]$Text, [string[]]$Patterns, [switch]$AlsoRaw)
    $lines = $Text -split "`r?`n"
    $hit = 0
    foreach ($ln in $lines) {
        foreach ($p in $Patterns) {
            if ($ln -match $p) { Write-Host ("  " + $ln.Trim()); $hit++; break }
        }
    }
    if ($hit -eq 0 -and -not $AlsoRaw) { Write-Host "  (no matching line in openocd output)" }
    if ($AlsoRaw) {
        Write-Host "  --- raw openocd output ---"
        foreach ($ln in $lines) { Write-Host ("  | " + $ln) }
        Write-Host "  --- end raw ---"
    }
    return $hit
}

function Invoke-SelfHeal {
    $pg = Join-Path $PSScriptRoot 'proc_guard.ps1'
    if (-not (Test-Path $pg)) { Write-Host "SELF-HEAL-SKIPPED proc_guard.ps1 not found"; return }
    Write-Host "SELF-HEAL running proc_guard.ps1 -Kill"
    $r = Invoke-InJob -FilePath 'pwsh' -Arguments @('-NoProfile', '-File', $pg, '-Kill') -TimeoutSecLocal 60
    foreach ($ln in ($r.StdOut -split "`r?`n")) {
        if ($ln -match '^(KILL |KILLED-TOTAL|LIST-COUNT)') { Write-Host ("  " + $ln) }
    }
}

# ---- run openocd once with a generated ASCII cfg ----
function Invoke-OpenOcd {
    param([string]$CfgBody, [string]$Tag)
    if (-not (Test-Path $OpenOcd)) {
        Write-Host ("OPENOCD-NOT-FOUND: " + $OpenOcd)
        return [pscustomobject]@{ ExitCode = 127; StdOut = ''; StdErr = ''; TimedOut = $false }
    }
    if (-not (Test-Path $script:WorkDir)) { New-Item -ItemType Directory -Path $script:WorkDir -Force | Out-Null }
    $cfg = Join-Path $script:WorkDir ($Tag + '.cfg')
    # ASCII only: cmd/OEM code pages mangled our Chinese comments in the past.
    $body = "adapter speed $AdapterSpeed`r`n" + $CfgBody
    Set-Content -Path $cfg -Value $body -Encoding ascii
    Write-Host ("CFG " + $cfg)
    $args = @('-s', $OcdScripts, '-f', 'interface/cmsis-dap.cfg', '-f', 'target/rp2350.cfg', '-f', $cfg)
    $r = Invoke-InJob -FilePath $OpenOcd -Arguments $args -TimeoutSecLocal $TimeoutSec
    if ($r.TimedOut) { Write-Host ("TIMEOUT openocd exceeded " + $TimeoutSec + "s and was killed") }
    Write-Host ("OPENOCD-EXIT " + $r.ExitCode)
    return $r
}

function Test-RetryNeeded {
    param([string]$Text)
    return ($Text -match 'Error|error|timeout|Timeout|unable to|failed|Failed|not halted|no device')
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
if ($Command -eq '') {
    Write-Host "SUBCOMMAND-REQUIRED"
    Show-Usage
    exit 1
}

$script:WorkDir = Join-Path $env:TEMP ('dsh_swd_' + $PID)
if (-not (Test-Path $script:WorkDir)) { New-Item -ItemType Directory -Path $script:WorkDir -Force | Out-Null }
Write-Host ("swd repo=" + $script:RepoRoot + " cmd=" + $Command + " speed=" + $AdapterSpeed + "kHz target=" + $Target)

$cfgBody = ''
$patterns = @()
$exitCode = 0

switch ($Command.ToLower()) {
    'probe' {
        $cfgBody = "init`r`ntargets $Target`r`n"
        if ($ResetHalt) { $cfgBody += "reset halt`r`n" }
        $cfgBody += "shutdown`r`n"
        $patterns = @('DPIDR', 'dap', 'Cortex-M', 'Examination', 'Error', 'error', 'halted', 'pc:')
        if ($ResetHalt) { Write-Host "WARNING -ResetHalt was given: this RAN 'reset halt' and therefore RESET the target" }
    }
    'dump' {
        if ($Arg1 -eq '' -or $Arg2 -eq '' -or $Arg3 -eq '') { Write-Host "DUMP-ARGS-REQUIRED: dump <addr> <len> <file>"; Show-Usage; exit 1 }
        $outPath = $Arg3
        $outPathFwd = $outPath -replace '\\', '/'
        $cfgBody = "init`r`ntargets $Target`r`n"
        if ($ResetHalt) { $cfgBody += "reset halt`r`n" }
        $cfgBody += "dump_image $outPathFwd $Arg1 $Arg2`r`nshutdown`r`n"
        $patterns = @('dumped', 'Error', 'error', 'DPIDR', 'halted')
        if ($ResetHalt) { Write-Host "WARNING -ResetHalt was given: this RAN 'reset halt' and therefore RESET the target" }
        else { Write-Host "NOTE: without -ResetHalt the target keeps running; memory reads while running return GARBAGE here" }
    }
    'program' {
        if ($Arg1 -eq '') { Write-Host "PROGRAM-ARGS-REQUIRED: program <elf> [-Reset]"; Show-Usage; exit 1 }
        if (-not (Test-Path $Arg1)) { Write-Host ("FILE-NOT-FOUND: " + $Arg1); exit 1 }
        $elfFwd = $Arg1 -replace '\\', '/'
        $cfgBody = "init`r`ntargets $Target`r`nprogram `"$elfFwd`" verify`r`n"
        if ($Reset) { $cfgBody += "reset run`r`n" }
        $cfgBody += "shutdown`r`n"
        $patterns = @('Verified', 'verified', 'Programming', 'Error', 'error', 'Flash', 'DPIDR')
    }
    'flashprobe' {
        $cfgBody = "init`r`ntargets $Target`r`nflash probe 0`r`nshutdown`r`n"
        $patterns = @('Flash Probe', 'flash', 'Error', 'error', 'DPIDR')
    }
    default {
        Write-Host ("UNKNOWN-SUBCOMMAND: " + $Command)
        Show-Usage
        exit 1
    }
}

$r = Invoke-OpenOcd -CfgBody $cfgBody -Tag $Command
$combined = ($r.StdOut + "`n" + $r.StdErr)
$hit = Show-Filtered -Text $combined -Patterns $patterns -AlsoRaw:$Raw

if ($r.ExitCode -ne 0 -or (Test-RetryNeeded -Text $combined)) {
    if (-not $NoSelfHeal) {
        Write-Host "FIRST-ATTEMPT-LOOKS-BAD (exit=" + $r.ExitCode + "); self-heal then retry once"
        Invoke-SelfHeal
        $r = Invoke-OpenOcd -CfgBody $cfgBody -Tag ($Command + '_retry')
        $combined = ($r.StdOut + "`n" + $r.StdErr)
        [void](Show-Filtered -Text $combined -Patterns $patterns -AlsoRaw:$Raw)
    }
}

if ($r.ExitCode -ne 0) { $exitCode = 1 }
if (Test-RetryNeeded -Text $combined) { $exitCode = 1 }
if ($hit -eq 0) { $exitCode = 1 }

switch ($Command.ToLower()) {
    'probe' {
        if ($combined -match 'DPIDR\s+(0x[0-9A-Fa-f]+)') { Write-Host ("DPIDR " + $Matches[1]) }
        else { Write-Host "DPIDR-NOT-REPORTED"; $exitCode = 1 }
    }
    'dump' {
        if (Test-Path $Arg3) {
            Write-Host ("DUMPED " + (Get-Item $Arg3).Length + " bytes -> " + $Arg3)
        } else {
            Write-Host ("DUMP-FAILED no file written: " + $Arg3)
            $exitCode = 1
        }
    }
    'flashprobe' {
        if ($combined -match '(RP2040 Flash Probe:[^\r\n]*)') { Write-Host ("FLASHPROBE " + $Matches[1].Trim()) }
    }
}

# cleanup our own temp cfg files
try { Remove-Item $script:WorkDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
Write-Host ("SWD-DONE exit=" + $exitCode)
exit $exitCode
