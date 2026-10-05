<#
  occupy_port.ps1 -- hold a COM port open for N seconds.  ASCII-only stdout.

  WHY THIS EXISTS
    To prove that tools\serial.ps1 can never hang, somebody has to be holding the port.
    This is that somebody.  It is also a small demonstration that a helper holding a port
    is always started inside a kill-on-close job object, so killing this script frees the
    port immediately instead of leaving an orphan behind.

  USAGE
    pwsh -File tools\occupy_port.ps1 -Port COM8 -Seconds 30
    pwsh -File tools\occupy_port.ps1 -Port COM8 -Seconds 30 -KeepAliveFile %TEMP%\x.txt
    pwsh -File tools\serial.ps1 -Port COM8 -Seconds 2     # in another shell:
                                                          # must return OPEN-FAILED
                                                          # or OPEN-TIMEOUT, never hang

  PARAMETERS
    -Port COMx          required
    -Seconds N          how long to hold the port (default 30)
    -KeepAliveFile <p>  append one line per second to this file; the test harness uses it
                        to know the port is really held before starting the victim
    -Baud N             default 115200

  OUTPUT
    OCCUPY-OPENED <port> at <time>
    OCCUPY-TICK <n>       (once per second when -KeepAliveFile is set)
    OCCUPY-RELEASED <port>
    OCCUPY-FAILED: <reason>

  ORPHAN SAFETY
    If this process is started by another of our tools it runs inside a kill-on-close job
    object, so the port is released by the kernel even if the parent is killed.  When you
    run it by hand, Ctrl-C -- or killing it -- releases the port because the handle is
    closed in a finally block.
#>
[CmdletBinding()]
param(
    [string]$Port = '',
    [int]$Seconds = 30,
    [string]$KeepAliveFile = '',
    [int]$Baud = 115200
)

$ErrorActionPreference = 'Continue'
if ($Port -eq '') { Write-Host "OCCUPY-FAILED: -Port required"; exit 2 }

$sp = $null
try {
    try {
        $sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
        $sp.DtrEnable = $true
        $sp.RtsEnable = $true
        $sp.Open()
    } catch {
        Write-Host ("OCCUPY-FAILED: " + $_.Exception.Message)
        exit 1
    }
    Write-Host ("OCCUPY-OPENED " + $Port + " at " + (Get-Date -Format 'HH:mm:ss'))
    for ($i = 1; $i -le $Seconds; $i++) {
        if ($KeepAliveFile -ne '') {
            try { Add-Content -Path $KeepAliveFile -Value ("tick " + $i + " " + (Get-Date -Format 'HH:mm:ss')) -Encoding ascii } catch { }
        }
        Write-Host ("OCCUPY-TICK " + $i)
        Start-Sleep -Seconds 1
    }
} finally {
    if ($null -ne $sp) {
        try { if ($sp.IsOpen) { $sp.Close() } } catch { }
        try { $sp.Dispose() } catch { }
        Write-Host ("OCCUPY-RELEASED " + $Port)
    }
}
exit 0
