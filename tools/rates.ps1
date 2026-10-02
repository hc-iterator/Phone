<#
  算帧率——判断"引擎是否在跑"的首选手段（读固件自记的 (时间,IRQ) 序列，
  只需一次 halt，不受会话结束状态影响；不会像跨会话比计数器那样被骗）。
  实现上复用 peek.ps1，避免重复解析逻辑。
  用法：  .\tools\rates.ps1
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$peek = Join-Path $PSScriptRoot 'peek.ps1'

function Get-Words([string]$sym, [int]$count) {
    $out = & pwsh -NoProfile -File $peek $sym $count 2>&1
    $hex = @()
    foreach ($chunk in ($out -join ' ')) { }
    $txt = ($out | Out-String)
    foreach ($m in [regex]::Matches($txt, '\b([0-9a-f]{8})\b')) { $hex += [Convert]::ToUInt32($m.Groups[1].Value, 16) }
    return $hex
}

$nw = Get-Words 'g_rate_n' 1
if ($nw.Count -eq 0) { Write-Host "读不到 g_rate_n（这版固件可能没有该探针）" -ForegroundColor Red; exit 1 }
$n  = $nw[0]
$T  = Get-Words 'g_rate_t' 16
$C  = Get-Words 'g_rate_c' 16
$iq = Get-Words 'g_dvi_irq_count' 1

Write-Host ("样本数 N = {0}    当前 IRQ = {1}" -f $n, ($(if($iq){$iq[0]}else{'?'})))
if ($T.Count -lt 2 -or $C.Count -lt 2) { Write-Host "序列为空 ⇒ 应用可能没起来" -ForegroundColor Yellow; exit 0 }

$shown = [Math]::Min($n, [Math]::Min($T.Count, $C.Count))
for ($i = 1; $i -lt $shown; $i++) {
    $dt = ($T[$i] - $T[$i-1]) / 1e6
    $dc = $C[$i] - $C[$i-1]
    if ($dt -gt 0 -and $dc -ge 0) {
        $fps = $dc / $dt / 525.0
        $col = if ($fps -gt 45) { 'Green' } elseif ($fps -gt 5) { 'Yellow' } else { 'Red' }
        Write-Host ("  #{0}: dt={1:N3}s  行={2}  => {3:N1} fps" -f $i, $dt, $dc, $fps) -ForegroundColor $col
    }
}
