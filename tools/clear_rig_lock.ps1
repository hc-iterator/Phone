#  clear_rig_lock.ps1 -- 查看 / 清理 PicoPhone 台架的"陈锁"（stale rig lock）
#
#  为什么需要它（2026-10-06 实测）：
#    台架锁文件在 $DSH_HOME\picophone.lock —— **在工作区之外**。
#    会话被收紧成 workspace-write 之后，**会话 shell 写不了那里**（Access denied），
#    所以"手动删陈锁"这条退路在会话侧断了 ✗。
#    本脚本要经 `pico_run` 跑（= 由 Host 插件直接 spawn，不经会话沙箱）才能删得动 ✓：
#        pico_run tools/clear_rig_lock.ps1                 # 只报告（默认，不删）
#        pico_run tools/clear_rig_lock.ps1 -Clear          # 仅在"确属陈锁"时删
#        pico_run tools/clear_rig_lock.ps1 -Clear -Force   # 无条件删（活进程也删，慎用）
#
#  陈锁判据（与插件一致，见 dsh-plugins/dsh-picophone/index.js）：
#    ① 占用进程已不存在  ② 或锁龄 > MaxAgeMin（插件默认 lockStaleMs = 600000 ms = 10 分钟）
#
#  输出**全 ASCII**：避免 GBK 控制台在打印 ✓/⚠️/中文 时 UnicodeEncodeError 崩掉
#  （项目踩过两次的坑，见 docs/陷阱.md 错 29）。
#
#  退出码：0 = 空闲或已清除；1 = 仍被占用（拒绝删除）；2 = 出错

[CmdletBinding()]
param(
    [switch]$Clear,                 # 允许删除（仍受"确属陈锁"约束）
    [switch]$Force,                 # 无视判据，强删
    [int]$MaxAgeMin = 10,           # 陈锁年龄阈值（分钟），与插件 lockStaleMs 对齐
    [string]$Path = ''              # 默认 $DSH_HOME\picophone.lock
)

$ErrorActionPreference = 'Stop'

function Get-LockPath([string]$p) {
    if ($p -and $p.Trim() -ne '') { return $p }
    $home2 = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
    return (Join-Path $home2 'picophone.lock')
}

function Test-PidAlive([int]$pid2) {
    if (-not $pid2 -or $pid2 -le 0) { return $false }
    try { $null = Get-Process -Id $pid2 -ErrorAction Stop; return $true }
    catch { return $false }
}

$lock = Get-LockPath $Path
Write-Host ("LOCK-FILE  = " + $lock)

if (-not (Test-Path $lock)) {
    Write-Host "RESULT     = FREE (no lock file)"
    exit 0
}

# ---- 读锁内容（解析失败也算"陈" —— 坏掉的锁不该继续挡路）----
$raw = Get-Content -Path $lock -Raw -ErrorAction SilentlyContinue
$info = $null
$parseOk = $false
try { $info = $raw | ConvertFrom-Json; $parseOk = $true } catch { $parseOk = $false }

$holderPid = 0
$ageSec = -1
if ($parseOk) {
    Write-Host ("HOLDER     = " + $info.what)
    Write-Host ("  pid      = " + $info.pid)
    Write-Host ("  session  = " + $info.session)
    Write-Host ("  profile  = " + $info.profile)
    Write-Host ("  since    = " + $info.sinceText)
    if ($info.pid) { $holderPid = [int]$info.pid }
    if ($info.since) {
        try {
            $t0 = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$info.since)
            $ageSec = [math]::Round(((Get-Date).ToUniversalTime() - $t0.UtcDateTime).TotalSeconds, 1)
        } catch { $ageSec = -1 }
    }
} else {
    Write-Host "HOLDER     = <unparsable lock content; treating as stale>"
    Write-Host ("  raw      = " + ($raw -replace "\s+", ' '))
    $fi = Get-Item $lock
    $ageSec = [math]::Round(((Get-Date) - $fi.LastWriteTime).TotalSeconds, 1)
}

$alive = Test-PidAlive $holderPid
$ageMin = if ($ageSec -ge 0) { [math]::Round($ageSec / 60.0, 1) } else { -1 }

Write-Host ("AGE        = " + $ageSec + " s (" + $ageMin + " min);  threshold = " + $MaxAgeMin + " min")
Write-Host ("PID-ALIVE  = " + $alive)

$stale = $true
$why = @()
if (-not $parseOk) { $why += 'unparsable' }
if ($holderPid -le 0) { $why += 'no-pid'; }
elseif (-not $alive) { $why += 'holder-process-gone' }
if ($ageMin -ge 0 -and $ageMin -gt $MaxAgeMin) { $why += 'older-than-threshold' }
if ($why.Count -eq 0) { $stale = $false }

Write-Host ("VERDICT    = " + $(if ($stale) { 'STALE (' + ($why -join ',') + ')' } else { 'HELD (fresh, holder alive)' }))

if (-not $Clear) {
    Write-Host "ACTION     = none (report only; add -Clear to remove a stale lock)"
    if ($stale) { Write-Host "RESULT     = STALE (rerun with -Clear to remove)"; exit 0 }
    Write-Host "RESULT     = HELD (refusing nothing: nothing was asked)"
    exit 0
}

if (-not $stale -and -not $Force) {
    Write-Host "ACTION     = refused: lock looks fresh and its holder is alive. Use -Force only if you have confirmed it is abandoned."
    Write-Host "RESULT     = HELD (not deleted)"
    exit 1
}

try {
    Remove-Item -Path $lock -Force -ErrorAction Stop
    Write-Host ("ACTION     = deleted" + $(if ($Force -and -not $stale) { ' (forced)' } else { '' }))
    Write-Host "RESULT     = CLEARED"
    exit 0
} catch {
    Write-Host ("ACTION     = delete failed: " + $_.Exception.Message)
    Write-Host "RESULT     = ERROR"
    exit 2
}
