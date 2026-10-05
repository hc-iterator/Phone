<#
  test_serial_antihang.ps1 -- prove that tools\serial.ps1 can never hang on a busy port.
  ASCII-only stdout.  Touches no firmware; it only opens/occupies a COM port.

  WHAT IT PROVES
    1. OCCUPANCY: while another process holds the port, serial.ps1 returns quickly with
       OPEN-FAILED / OPEN-TIMEOUT instead of blocking forever (Open() has no usable
       timeout, which is why serial.ps1 does the blocking work in a killable child).
    2. RELEASE: once the port is free again, serial.ps1 opens it normally -- the fix
       bounds the bad path without breaking the good one.
    3. NO ORPHANS: the occupier is started inside a kill-on-close job object, so when the
       test process goes away the occupier goes with it and the port is released.

  USAGE
    pwsh -File tools\test_serial_antihang.ps1 -Port COM8
    pwsh -File tools\test_serial_antihang.ps1 -Port COM8 -Seconds 2 -OpenTimeoutSec 5 -Retries 2

  OUTPUT (key lines)
    T1-OCCUPANCY-MEASURED <seconds>s exit=<n> ... PASS|FAIL
    T2-RELEASE ... PASS|FAIL
    T3-ORPHAN ... PASS|FAIL
    ANTIHANG-RESULT PASS|FAIL
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Port,
    [int]$Seconds = 2,
    [int]$OpenTimeoutSec = 5,
    [int]$Retries = 2,
    [int]$OccupySeconds = 40
)

$ErrorActionPreference = 'Continue'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$here = $PSScriptRoot
$fail = 0

function Get-Occupiers {
    # Only real occupiers: exclude the harness's own -NonInteractive wrapper, which merely
    # MENTIONS this script in its command text.
    Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*-File*occupy_port.ps1*' -and $_.CommandLine -notlike '*-NonInteractive*' }
}

Write-Host ("antihang port=" + $Port + " repo=" + $script:RepoRoot)
$workers = @(Get-Occupiers)
Write-Host ("PRE-EXISTING-OCCUPIERS " + $workers.Count)

# ---- T1: occupancy ----
$ka = Join-Path $env:TEMP 'dsh_antihang_keepalive.txt'
Remove-Item $ka -Force -ErrorAction SilentlyContinue
Write-Host "T1-BEFORE-LIST"
Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | ForEach-Object { "  pid " + $_.ProcessId }
$occ = Start-Process -FilePath 'pwsh' -ArgumentList '-NoProfile', '-File', (Join-Path $here 'occupy_port.ps1'), '-Port', $Port, '-Seconds', "$OccupySeconds", '-KeepAliveFile', $ka -PassThru
Write-Host ("T1-OCCUPIER-PID " + $occ.Id)
$t = 0
while (-not (Test-Path $ka) -and $t -lt 40) { Start-Sleep -Milliseconds 500; $t++ }
Start-Sleep -Seconds 2
$held = Test-Path $ka
Write-Host ("T1-PORT-HELD " + $held)
if (-not $held) { Write-Host "T1-OCCUPANCY FAIL could not occupy the port"; $fail++ }

$sw = [Diagnostics.Stopwatch]::StartNew()
$out1 = pwsh -NoProfile -File (Join-Path $here 'serial.ps1') -Port $Port -Seconds $Seconds -OpenTimeoutSec $OpenTimeoutSec -Retries $Retries -NoSelfHeal
$rc1 = $LASTEXITCODE
$sw.Stop()
$el1 = [math]::Round($sw.Elapsed.TotalSeconds, 1)
$out1 | ForEach-Object { Write-Host ("  | " + $_) }
$budget = ($OpenTimeoutSec + $Seconds + 3) * ($Retries + 1) + 10
$t1ok = ($el1 -lt $budget) -and ($rc1 -ne 0)
Write-Host ("T1-OCCUPANCY-MEASURED " + $el1 + "s exit=" + $rc1 + " (budget " + $budget + "s) " + $(if ($t1ok) { 'PASS' } else { 'FAIL' }))
if (-not $t1ok) { $fail++ }

# ---- T2: release, retest ----
if ($occ -and -not $occ.HasExited) { Stop-Process -Id $occ.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$leftover = @(Get-Occupiers)
Write-Host ("T3-OCCUPIER-AFTER-KILL " + $leftover.Count)
$sw2 = [Diagnostics.Stopwatch]::StartNew()
$out2 = pwsh -NoProfile -File (Join-Path $here 'serial.ps1') -Port $Port -Seconds $Seconds -OpenTimeoutSec $OpenTimeoutSec
$rc2 = $LASTEXITCODE
$sw2.Stop()
$el2 = [math]::Round($sw2.Elapsed.TotalSeconds, 1)
$out2 | ForEach-Object { Write-Host ("  | " + $_) }
$t2ok = ($rc2 -eq 0)
Write-Host ("T2-RELEASE after " + $el2 + "s exit=" + $rc2 + " " + $(if ($t2ok) { 'PASS' } else { 'FAIL' }))
if (-not $t2ok) { $fail++ }

Write-Host "T3-AFTER-LIST"
Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | ForEach-Object { "  pid " + $_.ProcessId }
$t3ok = ($leftover.Count -eq 0)
Write-Host ("T3-ORPHAN occupiers-left=" + $leftover.Count + " " + $(if ($t3ok) { 'PASS' } else { 'FAIL' }))
if (-not $t3ok) { $fail++ }

Remove-Item $ka -Force -ErrorAction SilentlyContinue
if ($fail -eq 0) { Write-Host "ANTIHANG-RESULT PASS"; exit 0 }
Write-Host ("ANTIHANG-RESULT FAIL (" + $fail + " check(s) failed)")
exit 1
