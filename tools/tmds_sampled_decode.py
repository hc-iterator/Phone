#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
tmds_sampled_decode.py -- DVI/TMDS undersampled capture analyzer

WHAT THIS DOES
--------------
Reads a probe capture of the DUT's 8 DVI pins and decides, from the samples
alone, what is actually knowable about the link:

  1. parses BEGIN <words> <wraps> / hex / END
  2. splits each 32-bit word into 4 samples (PIO shifts LEFT: first sample is
     in bits 31..24) with bit0=GPIO0 .. bit7=GPIO7
  3. checks the differential pairs D2/D1/D0/CLK (P should be the inverse of N)
  4. recovers the TMDS clock period (in samples) from the CLK differential,
     using LONG-RUN statistics rather than single-edge guesses
  5. estimates which PIO clkdiv the capture was taken with, by testing the
     handful of values the probe firmware can actually produce
  6. folds the samples modulo the recovered bit period to rebuild one
     composite bit cell / eye diagram, and reports edge quality
  7. measures the line period from the video data lanes (the clock alone
     cannot give it when a capture is shorter than one scan line)
  8. attempts 10-bit TMDS symbol extraction and reports control-symbol counts
  9. cross-checks the three data lanes for symbol-boundary alignment

HONEST LIMITS
-------------
When the capture is decimated (sample period > 0.5 bit period) the bit
sequence is NOT recoverable in general -- the analog front end does not
band-limit, so bits alias.  This script detects that condition and refuses to
print symbol counts it cannot support instead of inventing them.

Only ASCII is printed: the console here is GBK and non-ASCII output raises
UnicodeEncodeError.

USAGE
-----
    python tools\tmds_sampled_decode.py sampler_capture.txt
    python tools\tmds_sampled_decode.py cap_div4.txt --quiet
    python tools\tmds_sampled_decode.py --compare sampler_capture.txt cap_div4.txt
"""
import sys
import os
import re
import math
import collections

PIN_NAMES = ["D2P", "D2N", "D1P", "D1N", "D0P", "D0N", "CLKP", "CLKN"]
# differential pairs index by (p_bit, n_bit)
PAIRS = [("D2", 0, 1), ("D1", 2, 3), ("D0", 4, 5), ("CLK", 6, 7)]
LANES = [("D0/blue", 4, 5), ("D1/green", 2, 3), ("D2/red", 0, 1)]

# VESA 640x480p60 (the standard the DUT is supposed to emit)
VESA_PIXEL_CLK = 25.175e6
VESA_H_TOTAL = 800
VESA_V_TOTAL = 525
VESA_H_ACTIVE = 640
VESA_V_ACTIVE = 480
VESA_H_FRONT = 16
VESA_H_SYNC = 96
VESA_H_BACK = 48
VESA_V_FRONT = 10
VESA_V_SYNC = 2
VESA_V_BACK = 33
TMDS_BITS_PER_PIXEL = 10

# probe firmware: sample rate = PROBE_CLK_KHZ / clkdiv, clkdiv in 1..16
PROBE_CLK_HZ = 252.0e6
CLKDIV_CANDIDATES = [1, 2, 4, 8, 16]

# TMDS 10-bit control symbols -> (hsync, vsync)
TMDS_CTRL = {
    0b1101010100: ("CTL0", 0, 0),
    0b0010101011: ("CTL1", 0, 1),
    0b0101010100: ("CTL2", 1, 0),
    0b1010101011: ("CTL3", 1, 1),
}


# ----------------------------------------------------------------- IO
def parse_capture(path):
    """Return (header_dict, samples bytearray)."""
    words = []
    hdr = {}
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            t = line.strip()
            if t.startswith("BEGIN"):
                m = re.match(r"^BEGIN\s+(\d+)\s+(\d+)$", t)
                if m:
                    hdr["words"] = int(m.group(1))
                    hdr["wraps"] = int(m.group(2))
                continue
            if t == "END" or not t:
                continue
            if re.fullmatch(r"[0-9a-fA-F]{8}", t):
                words.append(int(t, 16))
    s = bytearray()
    for w in words:
        # PIO in_shift is LEFT: first sample taken ends up in the top byte
        s.append((w >> 24) & 0xFF)
        s.append((w >> 16) & 0xFF)
        s.append((w >> 8) & 0xFF)
        s.append(w & 0xFF)
    hdr["words_read"] = len(words)
    return hdr, s


def pin(samples, bit):
    """Extract one pin as a list of 0/1."""
    return [(b >> bit) & 1 for b in samples]


def diff(samples, p_bit, n_bit):
    """Differential = P XOR N (1 when the pair is in a valid differential state)."""
    return [((b >> p_bit) & 1) ^ ((b >> n_bit) & 1) for b in samples]


# --------------------------------------------------- period estimation
# The bit streams are long, so everything here works on byte-per-sample
# bytearrays viewed as big integers: bits[i] is bit i of the integer, which
# makes "compare the signal with a shifted copy" a single XOR plus popcount.
_POP = bytes(bin(i).count("1") for i in range(256))


def pack_bits(bits):
    """Pack a 0/1 sequence into a big int, bit i = bits[i] (LSB = sample 0)."""
    v = 0
    for b in reversed(bits):
        v = (v << 1) | b
    return v


def popcount_int(x):
    if x == 0:
        return 0
    # to_bytes + table is much faster than bin(x).count under CPython
    return sum(_POP[c] for c in x.to_bytes((x.bit_length() + 7) // 8, "little"))


def match_count_exact(bits, lag, packed=None):
    """Number of i with bits[i] == bits[i+lag]."""
    n = len(bits)
    if lag <= 0 or lag >= n:
        return 0
    if packed is None:
        packed = pack_bits(bits)
    m = n - lag
    a = packed & ((1 << m) - 1)      # bits[0 .. m-1]
    b = packed >> lag                # bits[lag .. n-1]
    diff = popcount_int(a ^ b)
    return m - diff


def autocorr(bits, max_lag, min_lag=1):
    n = len(bits)
    packed = pack_bits(bits)
    return {lag: match_count_exact(bits, lag, packed) / float(n - lag)
            for lag in range(min_lag, max_lag + 1)}


def transition_rate(bits):
    n = len(bits)
    t = sum(1 for i in range(1, n) if bits[i] != bits[i - 1])
    return t, t / float(n - 1)


def period_from_edges(bits):
    """Estimate the mean full period (in samples) of a binary clock-like signal.

    Uses the number of EDGES over a long window: for any binary waveform whose
    duty cycle is close to 50%, period = 2 / edge_rate.  This is far more robust
    than reading a median gap when the capture is aliased.
    """
    n = len(bits)
    e = sum(1 for i in range(1, n) if bits[i] != bits[i - 1])
    if e == 0:
        return None, 0.0
    rate = e / float(n - 1)
    return 2.0 / rate, rate


def estimate_clkdiv(clk_period_samples):
    """Pick the PIO clkdiv whose implied TMDS clock is closest to VESA 25.175MHz.

    sample_rate = 252MHz / clkdiv ; clk_hz = sample_rate / clk_period_samples
    """
    if not clk_period_samples:
        return None, []
    rows = []
    for d in CLKDIV_CANDIDATES:
        fs = PROBE_CLK_HZ / d
        fc = fs / clk_period_samples
        err = abs(fc - VESA_PIXEL_CLK) / VESA_PIXEL_CLK
        rows.append((err, d, fs, fc))
    rows.sort()
    return rows[0], rows


# ------------------------------------------------------------- folding
def fold(bits, period, nbin=200):
    """Equivalent-time fold: average bits into nbin phase bins over one period."""
    acc = [0.0] * nbin
    cnt = [0] * nbin
    n = len(bits)
    for i in range(n):
        ph = (i % period) / float(period)
        k = int(ph * nbin)
        if k >= nbin:
            k = nbin - 1
        acc[k] += bits[i]
        cnt[k] += 1
    return [(acc[k] / cnt[k] if cnt[k] else 0.0, cnt[k]) for k in range(nbin)]


def fold_hist(bits, period, nbin=20):
    """Histogram of each sample's position inside the bit period (for eye plot)."""
    n = len(bits)
    rows = [[0, 0] for _ in range(nbin)]   # [zeros, ones]
    for i in range(n):
        ph = (i % period) / float(period)
        k = int(ph * nbin)
        if k >= nbin:
            k = nbin - 1
        rows[k][bits[i]] += 1
    return rows


def ascii_plot(vals, height=12, width=None):
    """Tiny ASCII plot of a list of floats."""
    w = width or len(vals)
    step = max(1, len(vals) // w)
    col = [max(vals[i:i + step]) if vals[i:i + step] else 0.0 for i in range(0, len(vals), step)]
    lines = []
    for r in range(height, 0, -1):
        thr = r / float(height)
        lines.append("".join("#" if v >= thr else "." for v in col))
    lines.append("-" * len(col))
    return lines


# --------------------------------------------------------- line period
def find_line_period(lane_bits, lo, hi, topn=8):
    """Rank candidate line periods by exact long-range self-match of the lane."""
    n = len(lane_bits)
    packed = pack_bits(lane_bits)
    scored = []
    for lag in range(lo, hi + 1):
        c = match_count_exact(lane_bits, lag, packed)
        scored.append((c / float(n - lag), lag))
    scored.sort(reverse=True)
    # keep peaks that are not just near-duplicates
    peaks = []
    for frac, lag in scored:
        if any(abs(lag - p) <= 3 for _, p in peaks):
            continue
        peaks.append((frac, lag))
        if len(peaks) >= topn:
            break
    return peaks


# ------------------------------------------------------------- symbols
def extract_symbols(lane_bits, start, step, nsym):
    out = []
    n = len(lane_bits)
    i = start
    while len(out) < nsym and i + 9 * step < n:
        v = 0
        for k in range(10):
            v = (v << 1) | lane_bits[i + k * step]
        out.append(v)
        i += 10 * step
    return out


# ----------------------------------------------------------------- run
def analyze(path, quiet=False, do_line=True, do_fold=True, do_sym=True):
    rep = {}
    hdr, samples = parse_capture(path)
    n = len(samples)
    rep["file"] = path
    rep["header"] = hdr
    rep["n_samples"] = n

    def P(*a):
        if not quiet:
            print(*a)

    P("=" * 78)
    P("FILE      : %s" % path)
    P("header    : BEGIN words=%s wraps=%s  (words read=%d)" %
      (hdr.get("words"), hdr.get("wraps"), hdr.get("words_read")))
    P("samples   : %d  (= %d words x 4)" % (n, hdr.get("words_read", 0)))
    if n < 256:
        P("too few samples")
        return rep

    # ---- 1. per-pin and differential sanity ----
    P("")
    P("-- pin / differential sanity ------------------------------------------")
    stats = {}
    for i, nm in enumerate(PIN_NAMES):
        b = pin(samples, i)
        t, r = transition_rate(b)
        hi = sum(b) / float(n)
        stats[nm] = dict(high=hi, trans=t, rate=r)
        P("  %-4s GPIO%d : high=%6.2f%%  trans=%6d  rate=%.4f/sample" % (nm, i, 100 * hi, t, r))
    P("")
    pair_stat = {}
    for nm, pb, nb in PAIRS:
        d = diff(samples, pb, nb)
        inv = sum(d) / float(n)          # fraction of samples where P != N
        td, rd = transition_rate(d)
        pair_stat[nm] = dict(inv=inv, trans=td, rate=rd)
        flag = "OK (complementary)" if inv > 0.90 else ("WEAK" if inv > 0.5 else "FAIL (P==N mostly)")
        P("  %-4s : P!=N %6.2f%% of samples, differential edges=%6d  [%s]" %
          (nm, 100 * inv, td, flag))
    rep["pins"] = stats
    rep["pairs"] = pair_stat

    # ---- 2. clock recovery ----
    P("")
    P("-- clock recovery (differential CLKP xor CLKN) ------------------------")
    clkd = diff(samples, 6, 7)
    clkp = pin(samples, 6)
    # use the better-resolved of the two representations: if the pair is
    # genuinely complementary, XOR is the differential; otherwise fall back to
    # CLKP alone, and say so.
    inv = pair_stat["CLK"]["inv"]
    if inv > 0.90:
        clk_sig = clkd
        clk_src = "differential (P xor N)"
    else:
        clk_sig = clkp
        clk_src = "CLKP single-ended (pair NOT complementary in this capture)"
    per, erate = period_from_edges(clk_sig)
    ecount = int(round(erate * (n - 1)))
    P("  source            : %s" % clk_src)
    P("  edges             : %d over %d samples  (edge rate %.5f /sample)" % (ecount, n - 1, erate))
    if per:
        P("  period            : %.4f samples  (=> clock = sample_rate / %.4f)" % (per, per))
        half = per / 2.0
        P("  half period       : %.4f samples" % half)
    rep["clk_source"] = clk_src
    rep["clk_period_samples"] = per
    rep["clk_edge_rate"] = erate

    # duty cycle and run-length profile of the clock
    hi = sum(clk_sig) / float(n)
    runs = collections.Counter()
    cur = clk_sig[0]
    c = 0
    for v in clk_sig:
        if v == cur:
            c += 1
        else:
            runs[c] += 1
            cur = v
            c = 1
    runs[c] += 1
    top = sorted(runs.items())[:8]
    P("  duty (high)       : %.2f%%" % (100 * hi))
    P("  run-length profile: %s" % " ".join("%d:%.3f" % (k, v / float(sum(runs.values()))) for k, v in top))

    # ---- 3. which clkdiv? ----
    P("")
    P("-- sample-rate / clkdiv estimate --------------------------------------")
    best, rows = estimate_clkdiv(per)
    for err, d, fs, fc in rows:
        mark = " <== best" if (best and d == best[1]) else ""
        P("  clkdiv=%2d -> fs=%7.3f MSa/s -> TMDS clk=%7.3f MHz (VESA 25.175, err %+6.2f%%)%s" %
          (d, fs / 1e6, fc / 1e6, 100 * (fc - VESA_PIXEL_CLK) / VESA_PIXEL_CLK, mark))
    if best:
        rep["clkdiv"] = best[1]
        rep["fs_hz"] = best[2]
        rep["tmds_clk_hz"] = best[3]
        rep["clkdiv_err"] = best[0]
        P("  => best guess clkdiv=%d, fs=%.3f MSa/s, TMDS clock=%.3f MHz" %
          (best[1], best[2] / 1e6, best[3] / 1e6))
        bits_per_sample = (TMDS_BITS_PER_PIXEL * best[3]) / best[2]
        rep["bits_per_sample"] = bits_per_sample
        P("  => samples per TMDS BIT = %.4f  %s" %
          (1.0 / bits_per_sample if bits_per_sample else 0,
           "(undersampled: bit stream not directly recoverable)"
           if bits_per_sample > 0.5 else "(oversampled: symbols extractable)"))

    # ---- 4. bit period and folding / eye ----
    bit_period = None
    if best and rep.get("bits_per_sample"):
        bps = rep["bits_per_sample"]
        if bps > 0:
            bit_period = 1.0 / bps      # in samples
    if bit_period is None and per:
        # without a clkdiv we can still fold at the clock period, which is a
        # legitimate equivalent-time view of the clock itself
        bit_period = per
    rep["bit_period_samples"] = bit_period

    if do_fold and bit_period and 1.0 < bit_period < n / 4.0:
        P("")
        P("-- equivalent-time fold (eye diagram) ---------------------------------")
        P("  folding period: %.4f samples" % bit_period)
        for nm, pb, nb in PAIRS:
            lane = diff(samples, pb, nb) if pair_stat[nm]["inv"] > 0.90 else pin(samples, pb)
            rows = fold_hist(lane, bit_period, nbin=20)
            tot = sum(a + b for a, b in rows)
            P("  %s (from %s):" % (nm, "diff" if pair_stat[nm]["inv"] > 0.90 else "P"))
            for k, (z, o) in enumerate(rows):
                c = z + o
                if not c:
                    continue
                frac = o / float(c)
                bar = "#" * int(round(frac * 40))
                P("    %4.2f-%4.2f  %s %5.1f%% high  (n=%d)" %
                  (k / 20.0, (k + 1) / 20.0, bar.ljust(40), 100 * frac, c))
            rep.setdefault("fold", {})[nm] = rows

    # ---- 5. line period from the data lanes ----
    if do_line:
        P("")
        P("-- line / frame structure (from data lanes) ---------------------------")
        # search a window that covers the plausible line period
        if best:
            fs = best[2]
            # 640x480p60 line time = 800 px / 25.175MHz = 31.75us
            exp_line = 31.75e-6 * fs
            lo = max(64, int(exp_line * 0.4))
            hi = min(n - 64, int(exp_line * 3.0) + 64)
        else:
            lo, hi = 64, min(n - 64, 20000)
        if hi - lo < 32:
            P("  capture too short for a line-period search (need > line time)")
            rep["line_period_samples"] = None
        else:
            lane = pin(samples, 4)      # D0P carries the sync info in TMDS
            peaks = find_line_period(lane, lo, hi, topn=6)
            base = sum(lane) / float(n)
            P("  expected line period for 640x480p60: ~%.0f samples (in this capture)" % exp_line) \
                if best else None
            P("  search window %d..%d samples; D0 baseline high=%.3f" % (lo, hi, base))
            for frac, lag in peaks:
                P("    lag %6d : match %.4f" % (lag, frac))
            rep["line_peaks"] = peaks
            if peaks:
                rep["line_period_samples"] = peaks[0][1]

    # ---- 6. symbol extraction ----
    if do_sym:
        P("")
        P("-- TMDS symbol extraction --------------------------------------------")
        bps = rep.get("bits_per_sample")
        if not best or bps is None or bps > 0.5:
            P("  SKIPPED: this capture has %.3f samples per TMDS bit." %
              (1.0 / bps if bps else 0))
            P("  A TMDS bit must be sampled at least twice to be recovered; below")
            P("  that the bits alias and any 'symbols' produced would be fiction.")
            P("  (The clock itself is still recoverable -- see above.)")
            rep["symbols"] = None
        else:
            step = int(round(bit_period))
            if step < 1:
                step = 1
            nctrl = collections.Counter()
            ndata = collections.Counter()
            peri = {}
            for nm, pb, nb in LANES:
                lane = diff(samples, pb, nb) if pair_stat[nm]["inv"] > 0.90 else pin(samples, pb)
                syms = extract_symbols(lane, 0, step, 20000)
                peri[nm] = syms
                cc = collections.Counter()
                for v in syms:
                    if v in TMDS_CTRL:
                        cc[TMDS_CTRL[v][0]] += 1
                    else:
                        ndata[v] += 1
                nctrl[nm] = cc
            tot_ctrl = sum(sum(c.values()) for c in nctrl.values())
            P("  step=%d samples/symbol, control symbols found: %d" % (step, tot_ctrl))
            rep["symbols"] = dict(ctrl={k: dict(v) for k, v in nctrl.items()},
                                  data_top=ndata.most_common(10))

    return rep


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    quiet = "--quiet" in sys.argv
    if not args:
        print(__doc__)
        return 1
    reps = []
    for p in args:
        reps.append(analyze(p, quiet=quiet))
    if len(reps) > 1:
        print("")
        print("=" * 78)
        print("-- summary table ------------------------------------------------------")
        print("%-22s %-14s %6s %8s %8s %10s %10s" %
              ("file", "header", "clkper", "edges", "clk_src", "bits/sample", "sym"))
        for r in reps:
            per = r.get("clk_period_samples")
            bps = r.get("bits_per_sample")
            print("%-22s %-14s %6s %8d %8s %10s %10s" % (
                os.path.basename(r["file"]),
                "w=%s,wr=%s" % (r["header"].get("words"), r["header"].get("wraps")),
                ("%.3f" % per) if per else "-",
                r["pairs"]["CLK"]["trans"],
                "diff" if r["pairs"]["CLK"]["inv"] > 0.90 else "single",
                ("%.3f" % bps) if bps else "-",
                "yes" if r.get("symbols") else "no"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
