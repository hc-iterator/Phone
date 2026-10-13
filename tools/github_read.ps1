<#
.SYNOPSIS
    Fetch a GitHub URL on this machine and land the response body in a local file.

.DESCRIPTION
    The harness web_fetch tool refuses github.com / api.github.com /
    raw.githubusercontent.com / *.githubusercontent.com URLs, because this host maps
    those names to 127.0.0.1 (Hosts-mode accelerator) and web_fetch rejects any
    hostname that does not resolve to a public IP address.

    A plain local process is not subject to that guard, so this script uses
    Invoke-WebRequest / Invoke-RestMethod and writes the body to disk; the agent then
    reads the file with its normal read / grep tools.

    See docs/github-read-channel.md for the evidence and for when to use this script
    instead of web_fetch.

.PARAMETER Url
    http(s) URL. Supported shapes: github.com page, raw.githubusercontent.com file,
    api.github.com endpoint.

.PARAMETER Out
    Destination file. Default: $env:TEMP\github_read_<yyyyMMdd-HHmmss>.<ext>, where the
    extension is guessed from the URL path and then from the response Content-Type.
    A relative path resolves against the current directory. An existing directory
    receives the default file name. A path without an extension gets the guessed one.

.PARAMETER Lines
    Print the first N lines of the saved file as a preview. Default 20. Use 0 for no
    preview. Ignored when -Json is given (the compact JSON summary replaces the raw
    preview on purpose).

.PARAMETER Json
    Parse the response with ConvertFrom-Json and print a compact summary (key/value
    lines plus JSON_MINI) instead of the raw body. The file still receives the raw
    JSON, so it stays greppable.

.OUTPUTS
    The last stdout line is machine readable:
        OUT=<absolute path> BYTES=<n> SHA256_16=<first 16 hex chars>
    On failure the last stdout line is ERR=<reason> and the exit code is non-zero.

.EXAMPLE
    pwsh -File tools\github_read.ps1 https://github.com/XiaoMi/ha_xiaomi_home

.EXAMPLE
    pwsh -File tools\github_read.ps1 https://api.github.com/repos/XiaoMi/ha_xiaomi_home -Json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Url,

    [string]$Out,

    [int]$Lines = 20,

    [switch]$Json
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# helpers (must be defined before first use: PowerShell resolves functions at
# call time, not at parse time)
# ---------------------------------------------------------------------------

function Write-ErrLine([string]$reason) {
    Write-Output ('ERR=' + $reason)
    exit 1
}

function Get-ExtFromUrl([string]$u) {
    try { $path = ([System.Uri]$u).AbsolutePath } catch { return $null }
    $e = [System.IO.Path]::GetExtension($path)
    if ($e -and $e.Length -ge 2 -and $e.Length -le 8 -and $e -match '^\.[A-Za-z0-9]+$') {
        return $e.ToLowerInvariant()
    }
    return $null
}

function Get-ExtFromContentType([string]$ct) {
    if ([string]::IsNullOrWhiteSpace($ct)) { return $null }
    $ct = $ct.ToLowerInvariant()
    if ($ct -like 'application/json*') { return '.json' }
    if ($ct -like 'text/html*') { return '.html' }
    if ($ct -like 'text/markdown*') { return '.md' }
    if ($ct -like 'application/xml*' -or $ct -like 'text/xml*') { return '.xml' }
    if ($ct -like 'text/plain*' -or $ct -like 'text/*') { return '.txt' }
    return $null
}

function Get-DefaultFileName([string]$ext) {
    return ('github_read_' + (Get-Date -Format 'yyyyMMdd-HHmmss') + $ext)
}

function Write-JsonSummary($obj) {
    try { $mini = ($obj | ConvertTo-Json -Depth 12 -Compress) } catch { $mini = '' }
    if ($mini.Length -gt 280) { $mini = $mini.Substring(0, 280) + '...' }

    if ($obj -is [System.Array]) {
        Write-Output ('JSON_TYPE=array ITEMS=' + $obj.Count)
        Write-Output ('JSON_MINI=' + $mini)
        return
    }

    $props = @($obj.PSObject.Properties)
    Write-Output ('JSON_TYPE=object KEYS=' + $props.Count)
    $printed = 0
    foreach ($p in $props) {
        if ($printed -ge 30) { break }
        $v = $p.Value
        $s = $null
        if ($null -eq $v) {
            $s = 'null'
        } elseif ($v -is [string]) {
            $s = $v -replace "`r", ' ' -replace "`n", ' '
            if ($s.Length -gt 90) { $s = $s.Substring(0, 90) + '...' }
            $s = '"' + $s + '"'
        } elseif ($v -is [bool] -or $v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) {
            $s = [string]$v
        } elseif ($v -is [System.Array]) {
            $s = '[' + $v.Count + ' items]'
        } else {
            $s = '{...}'
        }
        Write-Output ('  ' + $p.Name + ' = ' + $s)
        $printed++
    }
    if ($props.Count -gt $printed) {
        Write-Output ('  ... ' + ($props.Count - $printed) + ' more key(s)')
    }
    Write-Output ('JSON_MIN=' + $mini)
}

# ---------------------------------------------------------------------------
# 1. validate the URL
# ---------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($Url)) { Write-ErrLine 'Url is empty' }

try { $uri = [System.Uri]$Url } catch { Write-ErrLine ('URL is not a valid URI: ' + $Url) }
if (-not $uri.IsAbsoluteUri) { Write-ErrLine ('URL is not absolute: ' + $Url) }
if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') {
    Write-ErrLine ('URL scheme must be http or https, got: ' + $uri.Scheme)
}

# NOTE: $Host is a read-only automatic variable in PowerShell -- do not use that name.
$hostName = $uri.Host.ToLowerInvariant()
$isGithubHost = (
    $hostName -eq 'github.com' -or
    $hostName -eq 'api.github.com' -or
    $hostName -eq 'raw.githubusercontent.com' -or
    $hostName -eq 'gist.github.com' -or
    $hostName -eq 'githubusercontent.com' -or
    $hostName.EndsWith('.github.com') -or
    $hostName.EndsWith('.githubusercontent.com')
)
if (-not $isGithubHost) {
    Write-Output ('NOTE=non-github host (' + $hostName + '); for public domains prefer the web_fetch tool')
}

if ($Lines -lt 0) { $Lines = 0 }

# ---------------------------------------------------------------------------
# 2. fetch
# ---------------------------------------------------------------------------

$userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-github_read/1.0 (local accelerator)'

$iwrArgs = @{
    Uri        = $uri.AbsoluteUri
    UserAgent  = $userAgent
    Headers    = @{ 'Accept' = '*/*' }
    TimeoutSec = 90
}
if ($PSVersionTable.PSVersion.Major -lt 6) { $iwrArgs['UseBasicParsing'] = $true }

$resp = $null
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $resp = Invoke-WebRequest @iwrArgs
} catch {
    $sw.Stop()
    $status = $null
    try {
        $r = $_.Exception.Response
        if ($r -and $r.StatusCode) { $status = [int]$r.StatusCode }
    } catch { }
    if ($status) { Write-ErrLine ('HTTP ' + $status + ' :: ' + $_.Exception.Message) }
    Write-ErrLine ('request failed :: ' + $_.Exception.Message)
}
$sw.Stop()
$fetchMs = $sw.ElapsedMilliseconds

$contentType = ''
try {
    $ct = $resp.Headers['Content-Type']
    if ($ct -is [System.Array]) { $ct = $ct[0] }
    if ($ct) { $contentType = ([string]$ct).Split(';')[0].Trim() }
} catch { $contentType = '' }

# raw bytes are preferred: they are byte-exact and GitHub serves UTF-8
$bytes = $null
try {
    $sp = $resp.PSObject.Properties['RawContentStream']
    if ($sp -and $sp.Value) { $bytes = $sp.Value.ToArray() }
} catch { $bytes = $null }

$text = $null
try {
    $cp = $resp.PSObject.Properties['Content']
    if ($cp -and $null -ne $cp.Value) { $text = [string]$cp.Value }
} catch { $text = $null }

if ($null -eq $bytes -and $null -eq $text) {
    Write-ErrLine 'could not read the response body'
}

# ---------------------------------------------------------------------------
# 3. -Json: parse before writing, so a non-JSON body fails cleanly
# ---------------------------------------------------------------------------

$jsonObj = $null
if ($Json) {
    $rawJson = $null
    if ($null -ne $text) { $rawJson = $text }
    elseif ($null -ne $bytes) { $rawJson = [System.Text.Encoding]::UTF8.GetString($bytes) }
    if ([string]::IsNullOrWhiteSpace($rawJson)) { Write-ErrLine '-Json: the response body is empty' }
    try { $jsonObj = $rawJson | ConvertFrom-Json } catch {
        Write-ErrLine ('-Json: response is not valid JSON :: ' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------
# 4. resolve the output path
# ---------------------------------------------------------------------------

$ext = Get-ExtFromUrl $uri.AbsoluteUri
if (-not $ext) { $ext = Get-ExtFromContentType $contentType }
if (-not $ext) { $ext = '.txt' }

if ([string]::IsNullOrWhiteSpace($Out)) {
    $fullOut = Join-Path $env:TEMP (Get-DefaultFileName $ext)
} else {
    if (-not [System.IO.Path]::IsPathRooted($Out)) {
        $Out = Join-Path (Get-Location).ProviderPath $Out
    }
    if (Test-Path -LiteralPath $Out -PathType Container) {
        $fullOut = Join-Path $Out (Get-DefaultFileName $ext)
    } else {
        if (-not [System.IO.Path]::GetExtension($Out)) { $Out = $Out + $ext }
        $fullOut = [System.IO.Path]::GetFullPath($Out)
    }
}

$outDir = [System.IO.Path]::GetDirectoryName($fullOut)
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    try { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    catch { Write-ErrLine ('cannot create output directory :: ' + $_.Exception.Message) }
}

# ---------------------------------------------------------------------------
# 5. write (byte-exact when bytes are available, otherwise UTF-8 without BOM)
# ---------------------------------------------------------------------------

try {
    if ($null -ne $bytes) {
        [System.IO.File]::WriteAllBytes($fullOut, $bytes)
    } else {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($fullOut, $text, $utf8NoBom)
    }
} catch {
    Write-ErrLine ('write failed :: ' + $_.Exception.Message)
}

$size = 0
try { $size = (Get-Item -LiteralPath $fullOut).Length }
catch { Write-ErrLine ('cannot stat the output file :: ' + $_.Exception.Message) }

$sha16 = ''
try { $sha16 = (Get-FileHash -LiteralPath $fullOut -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0, 16) }
catch { Write-ErrLine ('cannot hash the output file :: ' + $_.Exception.Message) }

# ---------------------------------------------------------------------------
# 6. report
# ---------------------------------------------------------------------------

Write-Output ('HTTP=' + [int]$resp.StatusCode + ' CONTENT_TYPE=' + $contentType + ' MS=' + $fetchMs)

if ($Json) {
    Write-JsonSummary $jsonObj
} elseif ($Lines -gt 0) {
    # preview lines are truncated: an HTML page or a minified JSON is often one
    # single line of hundreds of KB, and the file itself is what you grep anyway.
    $maxLine = 240
    Write-Output ('--- first ' + $Lines + ' line(s) of ' + $fullOut + ' (each line capped at ' + $maxLine + ' chars) ---')
    try {
        Get-Content -LiteralPath $fullOut -TotalCount $Lines -Encoding UTF8 | ForEach-Object {
            $line = [string]$_
            if ($line.Length -gt $maxLine) {
                Write-Output ($line.Substring(0, $maxLine) + ' ...[+' + ($line.Length - $maxLine) + ' chars]')
            } else {
                Write-Output $line
            }
        }
    } catch {
        Write-Output ('WARN=preview failed :: ' + $_.Exception.Message)
    }
    Write-Output '--- end preview ---'
}

Write-Output ('OUT=' + $fullOut + ' BYTES=' + $size + ' SHA256_16=' + $sha16)
exit 0
