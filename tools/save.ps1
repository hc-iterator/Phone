<#
  保存状态：git add -A + commit + push（带重试）。
  用法：
      .\tools\save.ps1 "提交说明"
      .\tools\save.ps1 "提交说明" -NoPush
  说明：本工程规矩 30 —— "提交就等于本地提交 + 同步到远程"。
        推送失败会重试（网络/凭据抖动），并始终打印最终的同步状态。
#>
param(
    [Parameter(Position=0)][string]$Message = "",
    [string]$Body = "",
    [switch]$NoPush,
    [int]$Retries = 4
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Message)) { Write-Host "用法: .\tools\save.ps1 \"提交说明\"" -ForegroundColor Yellow; exit 1 }

git -C $root add -A
$staged = (git -C $root diff --cached --name-only) -join ', '
if ([string]::IsNullOrWhiteSpace($staged)) { Write-Host "没有改动可提交" -ForegroundColor Yellow }
else {
    if ([string]::IsNullOrWhiteSpace($Body)) { git -C $root commit -q -m $Message }
    else { git -C $root commit -q -m $Message -m $Body }
    if ($LASTEXITCODE -ne 0) { Write-Host "commit 失败" -ForegroundColor Red; exit 1 }
    Write-Host "已提交：$((git -C $root log --oneline -1))" -ForegroundColor Green
}

if (-not $NoPush) {
    $branch = (git -C $root rev-parse --abbrev-ref HEAD).Trim()
    $ok = $false
    for ($i = 1; $i -le $Retries; $i++) {
        git -C $root push -q origin $branch 2>$null
        if ($LASTEXITCODE -eq 0) { Write-Host "已推送到 origin/$branch ✓" -ForegroundColor Green; $ok = $true; break }
        Write-Host "  推送第 $i 次失败，重试…" -ForegroundColor DarkGray
        Start-Sleep -Seconds 2
    }
    if (-not $ok) { Write-Host "推送失败（本地提交已保存，稍后再推）" -ForegroundColor Yellow }
}

$dirty = (git -C $root status --porcelain | Measure-Object).Count
$diff = (git -C $root rev-list --left-right --count "origin/$(git -C $root rev-parse --abbrev-ref HEAD)...HEAD") -join '/'
Write-Host "未提交=$dirty  与远程差(左远/右本)=$diff"
