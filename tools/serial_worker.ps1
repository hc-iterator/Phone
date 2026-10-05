<#
  serial_worker.ps1 -- the part of serial.ps1 that is allowed to block.  ASCII-only stdout.

  WHY THIS FILE EXISTS
    [System.IO.Ports.SerialPort]::Open() BLOCKS FOREVER when the port is held by someone
    else, and ReadTimeout does NOT cover the open path.  In-process we therefore have no
    way to bound it: a helper that calls Open() on a busy port can hang for 10+ minutes,
    and -- worse -- that hung helper is itself holding the port, so every retry makes the
    lock worse (positive feedback).
    The fix is structural: this worker is always started as a CHILD process by serial.ps1,
    which waits with a hard timeout and kills the child on expiry.  The child runs inside a
    kill-on-close job object, so if serial.ps1 itself dies, the kernel reaps this worker
    too -- the port cannot stay locked by an orphan.

  USAGE (normally you do not call this directly; use tools\serial.ps1)
    pwsh -File tools\serial_worker.ps1 -Port COM8 -Baud 115200 -DurationSec 3
    pwsh -File tools\serial_worker.ps1 -Port COM8 -DurationSec 2 -SendHex "1B1B3F"
    pwsh -File tools\serial_worker.ps1 -Port COM8 -DurationSec 3 -OutFile debug_logs\a.bin

  PARAMETERS
    -Port COMx        required
    -Baud N           default 115200 (USB CDC ignores it)
    -DurationSec N    how long to read after opening (default 3)
    -NoDtr            do not raise DTR/RTS (pico-sdk CDC needs DTR; see serial.ps1)
    -OutFile <path>   write captured bytes here
    -SendHex <hex>    send these bytes first, e.g. 1B1B42 = ESC ESC B
    -OpenTimeoutMs N  per-read timeout, NOT an open timeout (default 250).
                      Open() cannot be given a timeout -- bounding the open is the PARENT's
                      job, which is exactly why this runs as a child.

  OUTPUT CONTRACT (parsed by serial.ps1; keep these markers stable)
    WORKER-RESULT: OK|FAIL
    WORKER-BYTES: <n>
    WORKER-FILE: <path or ->
    WORKER-ERROR: <one line>
    WORKER-OPENED / WORKER-SENT / WORKER-CAPTURED / WORKER-CLOSED   (progress lines)
#>
[CmdletBinding()]
param(
    [string]$Port = '',
    [int]$Baud = 115200,
    [int]$DurationSec = 3,
    [switch]$NoDtr,
    [string]$OutFile = '',
    [string]$SendHex = '',
    [int]$OpenTimeoutMs = 250
)

$ErrorActionPreference = 'Continue'
function W { param([string]$M) Write-Host $M }

if ($Port -eq '') { W "WORKER-ERROR: -Port required"; W "WORKER-RESULT: FAIL"; exit 2 }

$sp = $null
$captured = New-Object System.Collections.Generic.List[byte]
$readTotal = 0
try {
    try {
        $sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
        $sp.ReadTimeout = $OpenTimeoutMs
        $sp.WriteTimeout = 500
        if (-not $NoDtr) { $sp.DtrEnable = $true; $sp.RtsEnable = $true }
        # THIS is the call that can hang forever on a busy port; the parent bounds it.
        $sp.Open()
    } catch {
        W ("WORKER-ERROR: open failed: " + $_.Exception.Message)
        W "WORKER-RESULT: FAIL"
        exit 1
    }
    W "WORKER-OPENED $Port dtr=$(-not $NoDtr)"
    if ($SendHex -ne '') {
        $hex = ($SendHex -replace '[^0-9A-Fa-f]', '')
        if ($hex.Length % 2 -ne 0) { $hex = $hex + '0' }
        $bytes = New-Object byte[] ($hex.Length / 2)
        for ($i = 0; $i -lt $bytes.Length; $i++) {
            $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16)
        }
        try {
            $sp.Write($bytes, 0, $bytes.Length)
            $sp.BaseStream.Flush()
            W ("WORKER-SENT " + $bytes.Length + " bytes")
        } catch {
            W ("WORKER-ERROR: write failed: " + $_.Exception.Message)
        }
    }
    $t0 = Get-Date
    $buf = New-Object byte[] 4096
    while (((Get-Date) - $t0).TotalSeconds -lt $DurationSec) {
        try {
            $n = $sp.Read($buf, 0, $buf.Length)
            if ($n -gt 0) {
                for ($i = 0; $i -lt $n; $i++) { [void]$captured.Add($buf[$i]) }
                $readTotal += $n
            }
        } catch [System.TimeoutException] {
            # nothing arrived in this slice: normal
        } catch {
            W ("WORKER-ERROR: read failed: " + $_.Exception.Message)
            break
        }
    }
    if ($OutFile -ne '') {
        try {
            $dir = Split-Path -Parent $OutFile
            if ($dir -ne '' -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            [System.IO.File]::WriteAllBytes($OutFile, $captured.ToArray())
            W ("WORKER-CAPTURED " + $readTotal + " bytes -> " + $OutFile)
        } catch {
            W ("WORKER-ERROR: write file failed: " + $_.Exception.Message)
        }
    }
    W ("WORKER-BYTES: " + $readTotal)
    if ($OutFile -ne '') { W ("WORKER-FILE: " + $OutFile) } else { W "WORKER-FILE: -" }
    W "WORKER-RESULT: OK"
    exit 0
} finally {
    # Always release the handle; if this process is killed the OS closes it anyway.
    if ($null -ne $sp) {
        try { if ($sp.IsOpen) { $sp.Close() } } catch { }
        try { $sp.Dispose() } catch { }
        W "WORKER-CLOSED $Port"
    }
}
