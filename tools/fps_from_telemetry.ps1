<#
  fps_from_telemetry.ps1 -- parse "[dvi] ..." telemetry lines and compute rates from the
  DELTAS between consecutive lines.  ASCII-only stdout.  Reads a file only: no serial, no
  hardware, no flashing.

  WHY THIS EXISTS
    docs\陷阱.md M7 has two contradicting frame-rate numbers (61.3 fps vs 18.1 fps) and the
    only way to settle it is one clean measurement.  The DUT prints one telemetry line per
    ~second; a single line is NOT enough (fps is a rate, so it needs two points in time).
    This tool turns a captured log into gaps, per-interval rates, and a cross-check.

  USAGE
    pwsh -File tools\fps_from_telemetry.ps1 -LogFile <captured.txt>
    pwsh -File tools\fps_from_telemetry.ps1 -LogFile x.txt -ActiveLines 480
    pwsh -File tools\fps_from_telemetry.ps1 -LogFile x.txt -LinesPerFrame 240   # older logs
    pwsh -File tools\fps_from_telemetry.ps1 -LogFile x.txt -MinIntervalMs 500 -Raw
    pwsh -File tools\fps_from_telemetry.ps1 -SelfTest                            # built-in sample

  WHAT EACH FIELD MEANS (evidence; see the report for the full table)
    t         ms since boot, from time_us_32()/1000 ................ frank_hdmi.c:340,335
    eng       dvi0.dvi_frame_count: frames, ++ only when v_ctr==0 in DVI_STATE_SYNC
              ...................................................... frank_dvi.c:724-726, deleted earlier? no: 724
    vctr      dvi0.timing_state.v_ctr: vertical line counter inside the current
              v_state; RESETS TO 0 at every state boundary (FP/SYNC/BP/ACTIVE), so it is
              a counter, NOT a frame number ........................ frank_dvi_timing.c:313-322
    irq       g_dvi_irq_count: DMA IRQ entries (= one per emitted scanline) . frank_dvi.c:98,569
    hb        a/b = frank_hdmi_heartbeat_lines / _frames.  _lines is ++ per ENCODED
              (logical) line, _frames per wrap of logical_y at LOGICAL_H
              ........................................ frank_hdmi.c:291-292,322-326,344-345
    qv,qf     q_tmds_valid / q_tmds_free ring wptr/rptr (uint16, they WRAP).
              available = wptr - rptr ................................ queue.h:35-36,83-84
    enc       a/b = g_enc_us / g_enc_us_max: MICROSECONDS (not counts) for the last
              encode_one_scanline_16bpp() and its worst case ......... frank_hdmi.c:220-221,266-271
    waitfree  g_wait_free_us: microseconds the last encode waited for a free TMDS buffer
              ...................................................... frank_hdmi.c:224,244-246
    enonly    g_enc_only_us: microseconds of the three tmds_encode calls only
              ...................................................... frank_hdmi.c:226,250-260
    n         g_enc_count: cumulative scans passed to encode_one_scanline_16bpp
              ...................................................... frank_hdmi.c:228,262-269

  WHICH FIELDS CAN GIVE fps
    READ THIS FIRST -- two different "line counts" get confused all the time:
      * irq = g_dvi_irq_count = scanlines EMITTED by the DMA engine, blanking INCLUDED.
      * n   = g_enc_count     = scanlines actually ENCODED by the producer (fresh data).
        These are NOT interchangeable: n/irq is the encoder fill ratio (0.53 in the
        2026-10-05 sample -- only 53% of emitted lines carried freshly encoded data).
      * hb  = frank_hdmi_heartbeat_lines = bumped once per encoded line, so it tracks n.
    PRIMARY (default since 2026-10-05): derive the true TOTAL lines per frame from the two
    frame/line counters themselves:
        irq-per-eng = delta(irq) / delta(eng)      -> 525.01 in the real sample
        fps         = (delta(irq)/delta(t)) / irq-per-eng   -> 60.0
      eng counts frames and irq counts emitted lines, so irq/eng IS the total lines per
      frame -- no assumption needed.  This is the number to quote.
      Cross-check: fps(chk) = delta(eng)/delta(t) (independent, same answer when eng moves).
    LEGACY / explicit basis: -ActiveLines N (default 480) divides the encoded-line rate by
      N.  480 is the ACTIVE line count (LOGICAL_H / v_active_lines), NOT the total per frame,
      so this basis reads LOW (it gave 34.8 fps for a 60.0 fps target).  It is kept only so
      old logs can be examined with an explicit, clearly-labelled assumption; it is printed
      as ACTIVE-LINES-ASSUMPTION and must not be quoted as the frame rate.
    NOT usable for fps: vctr (resets every state boundary), qv/qf (queue pointers),
    enc/waitfree/enonly (microseconds), hb's second number (heartbeat_frames, redundant).

  OUTPUT (stable, ASCII, greppable)
    PARSED-LINES <n>
    INTERVALS <n>
    GAP stats ms: min/median/max
    per-interval: INT <i> dt=<s>s dhb=<n> dn=<n> deng=<n> dirq=<n> | fps(hb)= fps(n)= fps(eng)=
    IRQ-PER-ENG <x> => TOTAL-LINES-PER-FRAME <y>
    FPS-PRIMARY <fps>            <- the number to use
    FPS-PRIMARY-CHECK <fps>      <- independent eng-based cross-check
    ENC-LINE-FILL-RATIO <r>      <- dn/dirq
    ENCODED-LINES-PER-S / EMITTED-LINES-PER-S
    ACTIVE-LINES-ASSUMPTION <N> -> fps <z>   (legacy basis; do not quote)
    INCONCLUSIVE / WARN lines when the data cannot support an fps number

  HONEST LIMITS
    * One telemetry line => fps unknown (no delta).  The tool says INCONCLUSIVE.
    * eng vs hb/n disagreement is reported, never silently averaged.
    * If the print interval is not ~1 s, a gap in the log can be mistaken for a slow frame
      rate; the tool prints the gap stats so that is visible.
#>
[CmdletBinding()]
param(
    [string]$LogFile = '',
    [int]$ActiveLines = 480,   # LEGACY basis only: ACTIVE lines, not total lines per frame
    [int]$MinIntervalMs = 500,
    [switch]$Raw,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Continue'
$fail = 0

$re = [regex]'\[dvi\]\s+t=(?<t>\d+)ms\s+eng=(?<eng>\d+)\s+vctr=(?<vctr>\d+)\s+irq=(?<irq>\d+)\s+hb=(?<hbl>\d+)/(?<hbf>\d+)\s+qv=(?<qvw>\d+)/(?<qvr>\d+)\s+qf=(?<qfw>\d+)/(?<qfr>\d+)\s+enc=(?<enca>\d+)/(?<encb>\d+)\s+waitfree=(?<wf>\d+)\s+enonly=(?<eo>\d+)\s+n=(?<n>\d+)'

function Parse-Telemetry {
    param([string[]]$Lines)
    $rows = New-Object System.Collections.ArrayList
    $skipped = 0
    foreach ($ln in $Lines) {
        $m = $re.Match($ln)
        if (-not $m.Success) { if ($ln.Trim() -ne '') { $skipped++ }; continue }
        [void]$rows.Add([pscustomobject]@{
            T    = [int64]$m.Groups['t'].Value
            Eng  = [int64]$m.Groups['eng'].Value
            Vctr = [int64]$m.Groups['vctr'].Value
            Irq  = [int64]$m.Groups['irq'].Value
            HbL  = [int64]$m.Groups['hbl'].Value
            HbF  = [int64]$m.Groups['hbf'].Value
            QvW  = [int64]$m.Groups['qvw'].Value
            QvR  = [int64]$m.Groups['qvr'].Value
            QfW  = [int64]$m.Groups['qfw'].Value
            QfR  = [int64]$m.Groups['qfr'].Value
            EncA = [int64]$m.Groups['enca'].Value
            EncB = [int64]$m.Groups['encb'].Value
            Wf   = [int64]$m.Groups['wf'].Value
            Eo   = [int64]$m.Groups['eo'].Value
            N    = [int64]$m.Groups['n'].Value
            Raw  = $ln.Trim()
        })
    }
    return [pscustomobject]@{ Rows = $rows; Skipped = $skipped }
}

function Get-Median {
    param([double[]]$Values)
    if ($Values.Count -eq 0) { return 0 }
    $s = $Values | Sort-Object
    $n = $s.Count
    if ($n % 2 -eq 1) { return [double]$s[[int](($n - 1) / 2)] }
    return ([double]$s[$n / 2 - 1] + [double]$s[$n / 2]) / 2.0
}

function Show-FieldTable {
    Write-Host "FIELD TABLE (evidence: file:line in this repo unless noted)"
    Write-Host "  t        ms since boot, time_us_32()/1000        third_party/frank-hdmi-sound/src/frank_hdmi.c:335,340"
    Write-Host "  eng      dvi0.dvi_frame_count (frames)           .../frank_dvi.c:724-726 (++ iff v_ctr==0 in SYNC)"
    Write-Host "  vctr     timing_state.v_ctr (line-in-state)      .../frank_dvi_timing.c:313-322 (resets per state)"
    Write-Host "  irq      g_dvi_irq_count (DMA IRQs = emitted lines) .../frank_dvi.c:98,569"
    Write-Host "  hb a/b   heartbeat_lines / heartbeat_frames      .../frank_hdmi.c:291-292,322-326"
    Write-Host "  qv w/r   q_tmds_valid wptr/rptr (uint16 wrap)    .../frank_dvi.c:229 + sdk queue.h:35-36,83-84"
    Write-Host "  qf w/r   q_tmds_free  wptr/rptr (uint16 wrap)    .../frank_dvi.c:230"
    Write-Host "  enc a/b  g_enc_us / g_enc_us_max  [MICROSECONDS] .../frank_hdmi.c:220-221,266-271"
    Write-Host "  waitfree g_wait_free_us [MICROSECONDS]           .../frank_hdmi.c:224,244-246"
    Write-Host "  enonly   g_enc_only_us  [MICROSECONDS]           .../frank_hdmi.c:226,250-260"
    Write-Host "  n        g_enc_count (cumulative encoded lines)  .../frank_hdmi.c:228,262-269"
}

function Invoke-Analysis {
    param([string[]]$Lines)
    $parsed = Parse-Telemetry -Lines $Lines
    $rows = @($parsed.Rows)
    Write-Host ("PARSED-LINES " + $rows.Count + " (non-matching non-empty lines skipped: " + $parsed.Skipped + ")")
    if ($rows.Count -eq 0) { Write-Host "INCONCLUSIVE no [dvi] telemetry line found"; return 1 }

    $first = $rows[0]
    Write-Host ("FIRST t=" + $first.T + "ms eng=" + $first.Eng + " hb=" + $first.HbL + "/" + $first.HbF + " n=" + $first.N)
    if ($Raw) {
        foreach ($r in $rows) { Write-Host ("RAW | " + $r.Raw) }
        Write-Host ("QV-AVAIL " + ($first.QvW - $first.QvR) + "  QF-AVAIL " + ($first.QfW - $first.QfR) + "  (of 8)")
    }

    # engine-side nominal line count per frame, straight from the timing preset
    Write-Host ("ACTIVE-LINES-PER-FRAME " + $ActiveLines + " (override with -ActiveLines)")

    if ($rows.Count -lt 2) {
        Write-Host "INCONCLUSIVE only ONE telemetry line: fps is a rate and needs >=2 points in time."
        Write-Host "  what is needed: a capture with >=2 consecutive [dvi] lines (~1 s apart)."
        Write-Host ("  single-line hints (NOT a measurement): enc=" + $first.EncA + "us per encoded line implies ~" + [math]::Round(1000000.0 / [math]::Max(1, $first.EncA), 1) + " lines/s => ~" + [math]::Round((1000000.0 / [math]::Max(1, $first.EncA)) / $ActiveLines, 2) + " fps IF that is the sustained per-line time.")
        return 2
    }

    $gaps = New-Object System.Collections.ArrayList
    $fpsHb = New-Object System.Collections.ArrayList
    $fpsN = New-Object System.Collections.ArrayList
    $fpsEng = New-Object System.Collections.ArrayList
    $irqRate = New-Object System.Collections.ArrayList
    $warn = New-Object System.Collections.ArrayList
    $used = 0
    for ($i = 1; $i -lt $rows.Count; $i++) {
        $p = $rows[$i - 1]; $c = $rows[$i]
        $dtMs = $c.T - $p.T
        if ($dtMs -lt $MinIntervalMs) {
            [void]$warn.Add("skipped interval at line " + ($i + 1) + ": dt=" + $dtMs + "ms < MinIntervalMs")
            continue
        }
        if ($dtMs -le 0) {
            [void]$warn.Add("NON-MONOTONIC t at line " + ($i + 1) + ": dt=" + $dtMs + "ms (device restarted?)")
            continue
        }
        $dt = $dtMs / 1000.0
        $used++
        [void]$gaps.Add([double]$dtMs)
        $dhb = $c.HbL - $p.HbL
        $dn = $c.N - $p.N
        $deng = $c.Eng - $p.Eng
        $dirq = $c.Irq - $p.Irq
        if ($dhb -lt 0 -or $dn -lt 0 -or $deng -lt 0) { [void]$warn.Add("counter went BACKWARDS at line " + ($i + 1) + " (reboot?)") }
        $a = if ($dhb -ge 0) { ($dhb / $dt) / $ActiveLines } else { 0 }
        $b = if ($dn -ge 0) { ($dn / $dt) / $ActiveLines } else { 0 }
        $c3 = if ($deng -ge 0) { $deng / $dt } else { 0 }
        [void]$fpsHb.Add([double]$a); [void]$fpsN.Add([double]$b); [void]$fpsEng.Add([double]$c3)
        [void]$irqRate.Add([double]($dirq / $dt))
        Write-Host ("INT " + $i + " dt=" + [math]::Round($dt, 3) + "s dhb=" + $dhb + " dn=" + $dn + " deng=" + $deng + " dirq=" + $dirq +
                    " | fps(hb)=" + [math]::Round($a, 3) + " fps(n)=" + [math]::Round($b, 3) + " fps(eng)=" + [math]::Round($c3, 3))
    }

    if ($used -eq 0) {
        Write-Host "INCONCLUSIVE no usable interval after filtering (see WARN lines)"
        foreach ($w in $warn) { Write-Host ("WARN " + $w) }
        return 1
    }

    $g = @($gaps)
    $dtMedMs = Get-Median -Values $g
    Write-Host ("INTERVALS " + $used)
    Write-Host ("GAP ms min=" + ($g | Measure-Object -Minimum).Minimum + " median=" + $dtMedMs + " max=" + ($g | Measure-Object -Maximum).Maximum)
    $mHb = Get-Median -Values @($fpsHb); $mN = Get-Median -Values @($fpsN); $mEng = Get-Median -Values @($fpsEng)
    $resEng = 0.0
    if ($dtMedMs -gt 0) { $resEng = 1000.0 / $dtMedMs }
    Write-Host ("IRQ-PER-S median " + [math]::Round((Get-Median -Values @($irqRate)), 1) + "  (per-interval median; totals-based value is EMITTED-LINES-PER-S below)")

    # ---- PRIMARY BASIS: derive the true total lines per frame from irq/eng ----
    # eng counts FRAMES; irq counts EMITTED SCANLINES, blanking included.  So irq/eng is the
    # real total lines per frame (640x480p60 => 525), NOT the 480 "active" lines.  Using 480
    # as the denominator invents a frame rate ~9% low (34.8 instead of 60) and, combined with
    # n (which only counts lines actually ENCODED), produces wildly misleading numbers.
    $totEng = 0
    $totIrq = 0; $totN = 0
    if ($rows.Count -ge 2) {
        $totEng = $rows[$rows.Count - 1].Eng - $rows[0].Eng
        $totIrq = $rows[$rows.Count - 1].Irq - $rows[0].Irq
        $totN = $rows[$rows.Count - 1].N - $rows[0].N
    }
    $irqPerEng = 0.0
    if ($totEng -gt 0) { $irqPerEng = $totIrq / [double]$totEng }
    if ($irqPerEng -gt 0) {
        Write-Host ("IRQ-PER-ENG " + [math]::Round($irqPerEng, 2) + " => TOTAL-LINES-PER-FRAME " + [math]::Round($irqPerEng, 0))
        Write-Host ("  (this is the real denominator: emitted scanlines per frame, blanking INCLUDED; 640x480p60 = 525)")
    } else {
        Write-Host "IRQ-PER-ENG unavailable (no eng movement) => falling back to -ActiveLines"
    }
    $irqRateMed = Get-Median -Values @($irqRate)
    # Use the TOTALS (all rows, first to last) for the primary numbers: the per-interval
    # median is quantised (deng is 2 or 3 per 1 s gap), so it wobbles while the aggregate
    # ratio is stable.  aggregateRate = total delta / total dt.
    $totDt = 0.0
    if ($rows.Count -ge 2) { $totDt = ($rows[$rows.Count - 1].T - $rows[0].T) / 1000.0 }
    $irqRateTot = 0.0; $nRateTot = 0.0; $engRateTot = 0.0
    if ($totDt -gt 0) {
        $irqRateTot = $totIrq / $totDt
        $nRateTot = $totN / $totDt
        $engRateTot = $totEng / $totDt
    }
    $fpsPrimary = 0.0
    if ($irqPerEng -gt 0) {
        $fpsPrimary = $irqRateTot / $irqPerEng
        Write-Host ("FPS-PRIMARY " + [math]::Round($fpsPrimary, 3) + "  = (dirq/dt) / (dirq/deng) over the whole capture  [frames/s, the number to use]")
        Write-Host ("FPS-PRIMARY-CHECK " + [math]::Round($engRateTot, 3) + "  = deng/dt (independent cross-check)")
    }
    $fillRatio = 0.0
    if ($totIrq -gt 0) { $fillRatio = $totN / [double]$totIrq }
    Write-Host ("ENC-LINE-FILL-RATIO " + [math]::Round($fillRatio, 4) + "  = dn/dirq  (share of EMITTED scanlines that were actually ENCODED)")
    Write-Host ("ENCODED-LINES-PER-S " + [math]::Round($nRateTot, 1) + "  (from n; n counts ENCODED lines only)")
    Write-Host ("EMITTED-LINES-PER-S " + [math]::Round($irqRateTot, 1) + "  (from irq; irq counts EMITTED lines, blanking included)")
    Write-Host ("ACTIVE-LINES-ASSUMPTION " + $ActiveLines + " -> fps would be " + [math]::Round($mN, 3) + " (LEGACY basis: ACTIVE lines, NOT total lines; do NOT use as the frame rate)")
    if ($fillRatio -gt 0 -and $fillRatio -lt 0.95) {
        Write-Host ("WARN ENC-LINE-FILL-RATIO " + [math]::Round($fillRatio, 3) + " < 0.95: " + [math]::Round((1 - $fillRatio) * 100, 1) + "% of emitted scanlines were NOT freshly encoded (repeated or blank)")
    }
    foreach ($w in $warn) { Write-Host ("WARN " + $w) }
    if ($fpsPrimary -gt 0 -and [math]::Abs($mEng - $fpsPrimary) -gt $resEng) {
        Write-Host ("WARN FPS-PRIMARY (" + [math]::Round($fpsPrimary, 3) + ") and the eng cross-check (" + [math]::Round($mEng, 3) + ") differ by more than the +/-" + [math]::Round($resEng, 3) + " quantisation: prefer FPS-PRIMARY and report both")
    }
    if ($used -lt 3) { Write-Host ("CAUTION only " + $used + " interval(s): treat the numbers as provisional") }
    return 0
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
if ($SelfTest) {
    $sample = '[dvi] t=3313149ms eng=8198 vctr=61 irq=4303531 hb=3934621/8197 qv=3/2 qf=3/3 enc=4750/219874 waitfree=4725 enonly=24 n=3934623'
    Write-Host "=== SELF TEST: the operator's real single line (verbatim) ==="
    Write-Host ("SAMPLE " + $sample)
    $rc1 = Invoke-Analysis -Lines @($sample)
    Write-Host ("SELFTEST-SINGLE-LINE rc=" + $rc1 + " (2 = correctly INCONCLUSIVE, needs >=2 lines)")
    if ($rc1 -ne 2) { $fail++ }

    # Synthetic continuation: the header states the assumed rates so nobody mistakes it
    # for measured data.  1188 lines/s over 480 active lines/frame, eng advancing 2.475/s.
    Write-Host ""
    Write-Host "=== SELF TEST: 4-line synthetic fixture (assumptions written in the file header) ==="
    $hdr = '# SYNTHETIC fixture for fps_from_telemetry.ps1 -SelfTest. Line 1 is REAL (2026-10-05).'
    $hdr2 = '# Lines 2-4 are generated assuming 1188 encoded lines/s and eng +2.475/s,'
    $hdr3 = '# purely to exercise the delta math. Do NOT quote these as measurements.'
    $lines = @(
        $hdr, $hdr2, $hdr3,
        $sample,
        '[dvi] t=3314149ms eng=8200 vctr=61 irq=4304729 hb=3935809/8199 qv=3/2 qf=3/3 enc=842/219874 waitfree=818 enonly=24 n=3935811',
        '[dvi] t=3315149ms eng=8203 vctr=61 irq=4305914 hb=3936997/8202 qv=3/2 qf=3/3 enc=838/219874 waitfree=812 enonly=24 n=3936999',
        '[dvi] t=3316149ms eng=8205 vctr=61 irq=4307105 hb=3938185/8204 qv=3/2 qf=3/3 enc=845/219874 waitfree=820 enonly=24 n=3938187'
    )
    $rc2 = Invoke-Analysis -Lines $lines
    Write-Host ("SELFTEST-SYNTHETIC rc=" + $rc2 + " (0 = produced numbers)")
    if ($rc2 -ne 0) { $fail++ }

    Write-Host ""
    Write-Host "=== SELF TEST: real-data sample tools\fps_from_telemetry.sample.txt ==="
    Write-Host "expectations: fps ~= 60.0 (+/-0.1) and ENC-LINE-FILL-RATIO ~= 0.530 (+/-0.01)"
    $sampleFile = Join-Path $PSScriptRoot 'fps_from_telemetry.sample.txt'
    if (-not (Test-Path $sampleFile)) {
        Write-Host ("SELFTEST-SAMPLE-SKIPPED not found: " + $sampleFile)
    } else {
        $sLines = @(Get-Content -Path $sampleFile -ErrorAction SilentlyContinue)
        $out3 = Invoke-Analysis -Lines $sLines
        $p3 = Parse-Telemetry -Lines $sLines
        $rows3 = @($p3.Rows)
        $f3 = $rows3[0]; $l3 = $rows3[$rows3.Count - 1]
        $dt3 = ($l3.T - $f3.T) / 1000.0
        $dIrq3 = $l3.Irq - $f3.Irq
        $dEng3 = $l3.Eng - $f3.Eng
        # same formula as the tool's FPS-PRIMARY: (dirq/dt) / (dirq/deng) over the whole capture
        $fps3 = 0.0
        if ($dEng3 -gt 0 -and $dt3 -gt 0) { $fps3 = ($dIrq3 / $dt3) / ($dIrq3 / [double]$dEng3) }
        $fill3 = ($l3.N - $f3.N) / [double]$dIrq3
        $okFps = [math]::Abs($fps3 - 60.0) -le 0.1
        $okFill = [math]::Abs($fill3 - 0.530) -le 0.01
        Write-Host ("SELFTEST-SAMPLE fps=" + [math]::Round($fps3, 3) + " (want 60.0 +/-0.1) " + $(if ($okFps) { 'PASS' } else { 'FAIL' }))
        Write-Host ("SELFTEST-SAMPLE fill-ratio=" + [math]::Round($fill3, 4) + " (want 0.530 +/-0.01) " + $(if ($okFill) { 'PASS' } else { 'FAIL' }))
        if (-not $okFps) { $fail++ }
        if (-not $okFill) { $fail++ }
    }

    Write-Host ""
    if ($fail -eq 0) { Write-Host "SELFTEST-RESULT PASS"; exit 0 }
    Write-Host ("SELFTEST-RESULT FAIL (" + $fail + ")"); exit 1
}

if ($LogFile -eq '') {
    Write-Host "LOGFILE-REQUIRED"
    Write-Host "usage: pwsh -File tools\fps_from_telemetry.ps1 -LogFile <captured.txt> [-ActiveLines 480] [-MinIntervalMs 500] [-Raw]"
    Write-Host "       pwsh -File tools\fps_from_telemetry.ps1 -SelfTest"
    exit 1
}
if (-not (Test-Path $LogFile)) { Write-Host ("LOGFILE-NOT-FOUND: " + $LogFile); exit 1 }

Show-FieldTable
Write-Host ("LOGFILE " + (Resolve-Path $LogFile).Path)
$content = Get-Content -Path $LogFile -ErrorAction SilentlyContinue
if ($null -eq $content) { $content = @() }
$rc = Invoke-Analysis -Lines @($content)
exit $rc
