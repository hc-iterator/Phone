#  clear_rig_lock.ps1 -- RETIRED 2026-10-06. It only DIAGNOSES now; it never deletes.
#
#  What it used to do:
#    Delete a stale rig lock at $DSH_HOME\picophone.lock -- a path OUTSIDE the session
#    workspace, which the session shell cannot write. It worked only because pico_run
#    spawned the script directly from the Host process, bypassing any sandbox.
#
#  [2026-10-06 note] pico_run now runs inside the DSH sandbox (workspace-write).
#    Writing outside the workspace is denied by the OS -- measured:
#      UnauthorizedAccessException for C:\Users\Chen\Desktop\... and for $DSH_HOME\...
#    So this script can no longer delete the lock, and pretending otherwise would just
#    produce a confusing failure. Evidence: DeepSeekCode\台架接口沙箱化说明.md section 3
#    (rows 5 and 6). The previous implementation is kept in git history (commit ed01fd4).
#
#  Use instead:
#    /pico lock clear     -- the plugin deletes it from the Host process (not sandboxed)
#    /pico lock           -- who holds it, since when, how long
#
#  This file stays useful as a READ-ONLY diagnosis (reading outside the workspace is
#  still allowed, so it works inside the sandbox):
#    pico_run tools/clear_rig_lock.ps1
#
#  Staleness rule (same as the plugin): holder process gone, or lock age > MaxAgeMin
#  (plugin default lockStaleMs = 600000 ms = 10 min).
#
#  Output is ASCII only: printing check marks / emoji / Chinese to a GBK console is a
#  known crash in this project (docs/陷阱.md 错 29).
#
#  Exit codes: 0 = lock free; 1 = lock present (NOT deleted, by design); 2 = error.

[CmdletBinding()]
param(
    [switch]$Clear,                 # accepted for compatibility; ignored (nothing is deleted)
    [switch]$Force,                 # accepted for compatibility; ignored
    [int]$MaxAgeMin = 10,           # staleness threshold in minutes, aligned with the plugin
    [string]$Path = ''              # default: $DSH_HOME\picophone.lock
)

$ErrorActionPreference = 'Continue'

if ($Clear -or $Force) {
    Write-Host "NOTE: -Clear / -Force are ignored -- this script no longer deletes anything." -ForegroundColor Yellow
    Write-Host "      Use  /pico lock clear  instead."
    Write-Host ""
}

$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$lock = if ($Path -ne '') { $Path } else { Join-Path $home_ 'picophone.lock' }

if (-not (Test-Path -LiteralPath $lock)) {
    Write-Host "VERDICT = FREE"
    Write-Host "  lock file: $lock (does not exist)"
    exit 0
}

$raw = Get-Content -LiteralPath $lock -Raw -ErrorAction SilentlyContinue
$info = $null
try { $info = $raw | ConvertFrom-Json } catch { $info = $null }

if ($null -eq $info) {
    Write-Host "VERDICT = UNREADABLE"
    Write-Host "  lock file: $lock"
    Write-Host "  cannot parse it as JSON -> use /pico lock, or delete the file by hand"
    exit 1
}

$since = 0
try { $since = [int64]$info.since } catch { $since = 0 }
$ageMin = 0
if ($since -gt 0) {
    $ageMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $since
    $ageMin = [math]::Round($ageMs / 60000.0, 2)
}

$alive = $false
if ($info.pid) {
    try { $null = Get-Process -Id ([int]$info.pid) -ErrorAction Stop; $alive = $true } catch { $alive = $false }
}
$stale = (-not $alive) -or ($ageMin -gt $MaxAgeMin)

Write-Host ("VERDICT = " + $(if ($stale) { "STALE" } else { "HELD" }))
Write-Host ("  what    : " + $info.what)
Write-Host ("  pid     : " + $info.pid + "   holder-alive=" + $alive)
Write-Host ("  session : " + $info.session)
Write-Host ("  age     : " + $ageMin + " min (threshold " + $MaxAgeMin + " min)")
Write-Host ("  lock    : " + $lock)
Write-Host ""
Write-Host "NOT DELETED (by design, 2026-10-06). To clear it:  /pico lock clear"
exit 1
