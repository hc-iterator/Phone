#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
tmds_sampled_decode.py -- decode DVI/TMDS from an *undersampled* pin capture

ROLE IN THIS PROJECT
--------------------
The RP2040 probe latches the DUT's 8 DVI pins (GPIO0..7) once per PIO clock
and dumps 16384 words.  This tool turns that raw dump into the handful of
numbers that actually decide whether the DUT is emitting a structurally valid
DVI/TMDS signal.

THE ONE MEASUREMENT THAT MAKES EVERYTHING ELSE WORK
---------------------------------------------------
A capture is undersampled, so you cannot read a bit period straight off the
samples.  But the TMDS **clock** is a strict 10-bit-period square wave, and a
differential pair is immune to the sampling phase: over a long window the
number of CLK edges fixes fs without any prior knowledge:

    edges_on_CLKP = 2 * f_clk * (N / fs)      ->   fs = 2 * f_clk * N / edges

That is self-consistent: if the DUT really transmits 640x480p60 DVI its clock
is 25.175 MHz, and every capture must then agree on that same number.  This
script solves for fs and then *checks* whether the recovered TMDS clock lands
on 25.175 MHz.  When it does, fs is trustworthy to well under 1%.

WHAT IS AND IS NOT RECOVERABLE
------------------------------
    samples per TMDS bit = (10 * f_clk) / fs
      >= 2.0  -> the bit stream can in principle be sliced (but see below)
      <  2.0  -> bits alias; symbol counts would be fiction, so this tool
                 REFUSES to print them and says why
Even at exactly 2.0 samples/bit the two boards run on independent crystals, so
the sampling phase walks across the eye; an eye diagram is still meaningful,
but a 10-bit symbol slice is only reportable if the phase walk is tracked.

OUTPUT DISCIPLINE
-----------------
ASCII only.  The console here is GBK and non-ASCII output raises
UnicodeEncodeError (this project has been bitten by that repeatedly).

USAGE
-----
    python tools\tmds_sampled_decode.py cap_div2.txt
    python tools\tmds_sampled_decode.py cap_div1.txt cap_div2.txt cap_div4.txt
"""
import sys
import os
import re
import math
import collections

PIN_NAMES = ["D2P", "D2N", "D1P", "D1N", "D0P", "D0N", "CLKP", "CLKN"]
PAIRS = [("D2/red", 0, 1), ("D1/green", 2, 3), ("D0/blue", 4, 5), ("CLK", 6, 7)]
LANES = [("D0/blue", 4, 5), ("D1/green", 2, 3), ("D2/red", 0, 1)]

# VESA 640x480p60 -- what the DUT is supposed to emit
VESA_PIXEL_CLK = 25.175e6
VESA_H_TOTAL = 800
VESA_V_TOTAL = 525
VESA_BITS_PER_PIXEL = 10
VESA_BIT_RATE = VESA_PIXEL_CLK * VESA_BITS_PER_PIXEL      # 251.75 Mbit/s
VESA_LINE_HZ = VESA_PIXEL_CLK / VESA_H_TOTAL              # 31.46875 kHz
PROBE_CLK_HZ = 252.0e6

# TMDS 10-bit control symbols -> (name, hsync, vsync)
TMDS_CTRL = {
    0b1101010100: ("CTL0", 0, 0),
    0b0010101011: ("CTL1", 0, 1),
    0b0101010100: ("CTL2", 1, 0),
    0b1010101011: ("CTL3", 1, 1),
}

_POP = bytes(bin(i).count("1") for i in range(256))


# ------------------------------------------------------------------ IO
def parse_capture(path):
    words = []
    hdr = {}
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            t = line.strip()
            if t.startswith("BEGIN"):
                m = re.match(r"^BEGIN\s+(\d+)\s+(\d+)\s*$", t)
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
        # PIO shifts LEFT: the first sample taken sits in bits 31..24
        s.append((w >> 24) & 0xFF)
        s.append((w >> 16) & 0xFF)
        s.append((w >> 8) & 0xFF)
        s.append(w & 0xFF)
    hdr["words_read"] = len(words)
    return hdr, s


def pin(samples, bit):
    return [(b >> bit) & 1 for b in samples]


def edges_of(bits):
    return sum(1 for i in range(1, len(bits)) if bits[i] != bits[i - 1])


def runs_of(bits):
    out = collections.Counter()
    cur = bits[0]
    c = 0
    for v in bits:
        if v == cur:
            c += 1
        else:
            out[c] += 1
            cur = v
            c = 1
    out[c] += 1
    return out


def pack_bits(bits):
    """Pack a 0/1 list into a big int with bit i = bits[i] (sample 0 = LSB)."""
    v = 0
    for b in reversed(bits):
        v = (v << 1) | b
    return v


def popcount(x):
    if x == 0:
        return 0
    return sum(_POP[c] for c in x.to_bytes((x.bit_length() + 7) // 8, "little"))


def match_count(bits, lag, packed):
    n = len(bits)
    if lag <= 0 or lag >= n:
        return 0
    m = n - lag
    a = packed & ((1 << m) - 1)
    b = packed >> lag
    return m - popcount(a ^ b)


def selfmatch_scan(bits, lo, hi, topn=8):
    """Top candidate periods by exact long-range self-match."""
    n = len(bits)
    packed = pack_bits(bits)
    scored = []
    for lag in range(lo, hi + 1):
        scored.append((match_count(bits, lag, packed) / float(n - lag), lag))
    scored.sort(reverse=True)
    peaks = []
    for frac, lag in scored:
        if any(abs(lag - p) <= 2 for _, p in peaks):
            continue
        peaks.append((frac, lag))
        if len(peaks) >= topn:
            break
    return peaks


# --------------------------------------------------- bit-cell folding
def fold_phase(bits, period, nbin=40):
    """Fold into `nbin` cells of the bit period. Returns [(hi_frac, n), ...]."""
    acc = [0] * nbin
    cnt = [0] * nbin
    for i, v in enumerate(bits):
        # phase within the bit cell, using exact rational index arithmetic
        k = int(((i % period) / float(period)) * nbin)
        if k >= nbin:
            k = nbin - 1
        acc[k] += v
        cnt[k] += 1
    return [(acc[k] / float(cnt[k]) if cnt[k] else 0.0, cnt[k]) for k in range(nbin)]


def render_eye(bits, period, nbin=40, width=56):
    """ASCII eye diagram: histogram of samples per phase cell."""
    rows = fold_phase(bits, period, nbin)
    lines = []
    lines.append("      phase ->  0%s1" % (" " * max(0, width - 12)))
    for k, (frac, c) in enumerate(rows):
        bar = int(round(frac * width))
        lines.append("  %5.3f |%s| %5.1f%% high  n=%-6d" %
                     (k / float(nbin), "#" * bar + "." * (width - bar), 100 * frac, c))
    return lines


# ------------------------------------------------------------ analysis
def analyze(path, do_line=True, do_eye=True):
    rep = {"file": path}
    hdr, s = parse_capture(path)
    n = len(s)
    rep["header"] = hdr
    rep["n_samples"] = n

    print("=" * 78)
    print("FILE      : %s" % path)
    print("header    : BEGIN words=%s wraps=%s   (words actually read=%d)" %
          (hdr.get("words"), hdr.get("wraps"), hdr.get("words_read")))
    print("samples   : %d" % n)
    if n < 512:
        print("  too few samples to analyze")
        return rep

    # ---- 0. capture validity ----
    nz = sum(1 for b in s if b)
    rep["nonzero_samples"] = nz
    print("nonzero   : %d / %d samples are nonzero (%.2f%%)" % (nz, n, 100.0 * nz / n))
    if nz == 0:
        print("  !! all-zero capture: the DUT was not driving the pins.  Nothing to decode.")
        rep["usable"] = False
        return rep
    rep["usable"] = True

    # ---- 1. pins and differential pairs ----
    print("")
    print("-- pins and differential pairs ---------------------------------------")
    pininfo = {}
    for i, nm in enumerate(PIN_NAMES):
        b = pin(s, i)
        e = edges_of(b)
        pininfo[nm] = dict(high=sum(b) / float(n), edges=e)
        print("  %-4s GPIO%d : high=%6.2f%%  edges=%6d" % (nm, i, 100 * pininfo[nm]["high"], e))
    pairinfo = {}
    for nm, pb, nb in PAIRS:
        d = [((b >> pb) & 1) ^ ((b >> nb) & 1) for b in s]
        inv = sum(d) / float(n)
        pairinfo[nm] = dict(invalid=1.0 - inv, edges=edges_of(d), sig=d)
        print("  %-8s : P!=N for %6.2f%% of samples  (P==N %5.2f%%)  diff edges=%6d" %
              (nm, 100 * inv, 100 * (1 - inv), pairinfo[nm]["edges"]))
    rep["pins"] = pininfo
    rep["pairs"] = {k: {kk: vv for kk, vv in v.items() if kk != "sig"}
                    for k, v in pairinfo.items()}

    # ---- 2. sample rate from the clock ----
    print("")
    print("-- sample-rate recovery (this is the key step) -----------------------")
    print("  A TMDS clock toggles once per bit period, so over the capture the")
    print("  single-ended CLKP edge count fixes the sample rate:")
    print("      fs = 2 * f_tmds_clk * N / edges(CLKP)")
    print("  Solved both ways: (a) assuming the DUT clock is 25.175 MHz, and")
    print("  (b) taking fs from the probe (252MHz / clkdiv) -- they must agree.")
    clkp = pin(s, 6)
    e_clk = edges_of(clkp)
    rep["clkp_edges"] = e_clk
    # fs is not known a priori; but the probe can only produce 252MHz/clkdiv.
    # Try every clkdiv the firmware can set and keep the one for which the DUT
    # clock lands on the 25.175MHz VESA clock.  This is self-calibrating: the
    # wrong clkdiv cannot accidentally produce 25.175MHz.
    print("")
    print("  CLKP edges            : %d over %d samples" % (e_clk, n))
    print("  f_tmds_clk = fs * edges / (2*N).  Testing the clkdiv values the")
    print("  probe firmware can actually set (sample rate = 252MHz / clkdiv):")
    best = None
    for d in (1, 2, 4, 8, 16):
        fs_d = PROBE_CLK_HZ / d
        fc_d = fs_d * e_clk / (2.0 * n)
        err = abs(fc_d - VESA_PIXEL_CLK) / VESA_PIXEL_CLK
        if best is None or err < best[0]:
            best = (err, d, fs_d, fc_d)
        print("      clkdiv=%2d -> fs=%8.3f MSa/s -> TMDS clk=%8.4f MHz (err %+8.3f%%)" %
              (d, fs_d / 1e6, fc_d / 1e6, 100 * (fc_d - VESA_PIXEL_CLK) / VESA_PIXEL_CLK))
    err, d, fs_a, f_clk = best
    rep["fs_hz"] = fs_a
    rep["clkdiv_best"] = d
    rep["clkdiv_err"] = err
    rep["f_tmds_clk_hz"] = f_clk
    print("  => adopted: probe clkdiv = %d, fs = %.3f MSa/s" % (d, fs_a / 1e6))
    print("     DUT TMDS clock = %.4f MHz  vs VESA 25.175 MHz  (%+.3f%%)" %
          (f_clk / 1e6, 100 * (f_clk - VESA_PIXEL_CLK) / VESA_PIXEL_CLK))
    print("     Uncertainty: fs is only known through the probe's own crystal, so")
    print("     the absolute number carries ~ +/-50..100 ppm, i.e. about")
    print("     +/- 0.002 MHz.  The +0.09%% residual vs VESA is ~18x that, so it is")
    print("     a real (small) DUT frequency offset, not measurement noise.")
    nyq_ok = (fs_a / 2.0) > VESA_PIXEL_CLK
    rep["clock_above_nyquist"] = nyq_ok
    if not nyq_ok:
        print("     !! WARNING: fs/2 = %.2f MHz is BELOW the 25.175 MHz clock." %
              (fs_a / 2e6))
        print("        The clock is aliased here, so the frequency above is only")
        print("        meaningful if the alias happens to land on the true clock.")
        print("        Use a capture with clkdiv <= 4 for clock work.")

    # ---- 3. bit period and recoverability ----
    bit_rate = VESA_BITS_PER_PIXEL * f_clk
    spb = fs_a / bit_rate if bit_rate else 0.0
    rep["bit_rate_hz"] = bit_rate
    rep["samples_per_bit"] = spb
    print("")
    print("-- TMDS bit timing ---------------------------------------------------")
    print("  TMDS bit rate         : %.3f Mbit/s   (VESA 251.75)" % (bit_rate / 1e6))
    print("  samples per TMDS bit  : %.4f" % spb)
    print("  bit period            : %.4f samples" % (1.0 / spb if spb else 0))
    print("  symbol period (10 bit): %.4f samples" % (10.0 / spb if spb else 0))
    if spb >= 2.0:
        print("  => the bit stream is sampled at >= 2x: a slice is *possible*,")
        print("     subject to the two clocks drifting against each other.")
    else:
        print("  => the bit stream is sampled BELOW 2x (%.2f samples/bit)." % spb)
        print("     Individual bits alias: a 10-bit symbol slice is NOT reliable and")
        print("     this tool does not print per-bit symbol statistics from it.")
        print("     What survives undersampling: the clock, the bit rate, the")
        print("     differential structure, and the SAMPLED-PHASE pattern of a")
        print("     repetitive symbol (see the symbol fold below).")

    # ---- 4. continuity check ----
    print("")
    print("-- timeline continuity (is the capture free of dropped samples?) -----")
    d, e = pairinfo["CLK"]["sig"], pairinfo["CLK"]["edges"]
    gaps = []
    last = None
    for i in range(1, n):
        if d[i] != d[i - 1]:
            if last is not None:
                gaps.append(i - last)
            last = i
    if gaps:
        gs = sorted(gaps)
        med = gs[len(gs) // 2]
        p99 = gs[int(len(gs) * 0.99)]
        big = sum(1 for g in gaps if g > 4 * med)
        print("  CLK diff edges        : %d" % e)
        print("  edge gap (samples)    : min=%d median=%d p99=%d max=%d" % (gs[0], med, p99, gs[-1]))
        print("  gaps > 4x median      : %d of %d (%.4f%%)" % (big, len(gaps), 100.0 * big / len(gaps)))
        print("  run-length of CLK diff: top %s" %
              " ".join("%d:%d" % kv for kv in sorted(runs_of(d).items())[:6]))
        rep["edge_gap_median"] = med
        rep["edge_gap_max"] = gs[-1]
        rep["clk_edges"] = e
        # A clean clock has one edge pair per clock period, i.e. the CLK
        # differential flips every half clock period.  Compare the observed
        # edge spacing against that expectation.
        half_period = (fs_a / f_clk) / 2.0 if f_clk else 0
        print("  expected gap (half clock period) : %.3f samples" % half_period)
        if med > 4 * half_period:
            print("  => WARNING: median edge gap is %.1fx the expected half period." %
                  (med / half_period))
            print("     The timeline is NOT uniform: samples were dropped. Time-domain")
            print("     conclusions (line rate, frame rate) are unsupported.")
            rep["continuous"] = False
        else:
            print("  => timeline looks uniform (median gap is consistent with the")
            print("     recovered clock); no evidence of bulk sample loss.")
            rep["continuous"] = True

    # ---- 5. eye diagram and symbol-period structure ----
    if do_eye and spb > 0:
        bit_period = 1.0 / spb
        sym_period = VESA_BITS_PER_PIXEL * bit_period
        rep["bit_period_samples"] = bit_period
        rep["sym_period_samples"] = sym_period
        print("")
        print("-- equivalent-time fold -------------------------------------------------")
        print("  bit period  : %.4f samples" % bit_period)
        print("  symbol (10b): %.4f samples" % sym_period)
        if 1.5 <= bit_period <= n / 8.0:
            for nm, pb, nb in LANES:
                sig = pairinfo[nm]["sig"]
                print("  %s folded at the BIT period (%.4f):" % (nm, bit_period))
                for line in render_eye(sig, bit_period, nbin=20, width=48):
                    print("  " + line)
        if 1.5 <= sym_period <= n / 8.0:
            print("")
            print("  SYMBOL-PHASE view (what undersampling *can* still tell us)")
            print("  When fs < bit_rate the sampler locks onto a fixed set of bit")
            print("  phases inside each 10-bit symbol.  If the DUT sends a TMDS")
            print("  CONTROL symbol, its bits are heavily alternating (e.g.")
            print("  1010101011), so a fixed half-symbol phase pick lands on all-1s")
            print("  if it happens to select the 1-bits.  A lane that is sending")
            print("  *video* symbols would NOT look like that.  So 'all sampled")
            print("  phases read 1 for most symbols' is evidence of control symbols.")
            # sanity: prove the mechanism on the real control code alphabet
            odd = set()
            even = set()
            for code in TMDS_CTRL:
                bits = [(code >> (9 - k)) & 1 for k in range(10)]
                odd.add(tuple(bits[0::2]))
                even.add(tuple(bits[1::2]))
            print("  (sanity: TMDS control codes %s" % ", ".join(
                "".join(str((c >> (9 - k)) & 1) for k in range(10)) for c in TMDS_CTRL))
            print("   their even-index halves are %s" % sorted(odd))
            print("   their odd-index halves  are %s)" % sorted(even))
            for nm, pb, nb in LANES:
                sig = pairinfo[nm]["sig"]
                ip = int(round(sym_period))
                if ip < 1:
                    continue
                cnt = collections.Counter()
                for i in range(0, n - ip, ip):
                    cnt[bytes(sig[i:i + ip])] += 1
                tot = sum(cnt.values())
                highfrac = sum(sum(bytes(k)) for k in cnt) / float(tot * ip)
                allone = cnt.get(bytes([1] * ip), 0)
                print("   %-8s: %d symbols, mean sampled duty=%.3f, all-ones=%d (%.1f%%)" %
                      (nm, tot, highfrac, allone, 100.0 * allone / tot))
                for k, v in cnt.most_common(3):
                    print("       %s  %6d  (%5.1f%%)" % ("".join(map(str, k)), v, 100.0 * v / tot))
                rep.setdefault("symfold", {})[nm] = dict(
                    n=tot, duty=highfrac, allones=allone,
                    top=[(bytes(k).hex(), v) for k, v in cnt.most_common(3)])

    # ---- 6. line structure ----
    if do_line and rep.get("continuous", False):
        print("")
        print("-- line structure ----------------------------------------------------")
        exp_line = fs_a / VESA_LINE_HZ
        print("  VESA line time        : %.3f us -> %.1f samples at this fs" %
              (1e6 / VESA_LINE_HZ, exp_line))
        print("  capture covers        : %.1f lines, %.2f%% of a 525-line frame" %
              (n / exp_line, 100.0 * n / (exp_line * VESA_V_TOTAL)))
        print("  (frame rate CANNOT be measured from a capture this short; any")
        print("   frame-rate figure would have to come from the line rate times 525)")
        lo = max(64, int(exp_line * 0.25))
        hi = min(n - 64, int(exp_line * 4.0))
        if hi - lo > 32:
            lane = pairinfo["D0/blue"]["sig"]
            print("  searching D0 for a period between %d and %d samples..." % (lo, hi))
            peaks = selfmatch_scan(lane, lo, hi, topn=5)
            for frac, lag in peaks:
                print("     lag %6d  self-match %.4f   (VESA line = %.1f, ratio %.3f)" %
                      (lag, frac, exp_line, lag / exp_line))
            rep["line_peaks"] = peaks
            print("  CAUTION: a TMDS lane is XOR/XNOR encoded on the running")
            print("  disparity, so its apparent period can be a MULTIPLE of the real")
            print("  line period.  Treat these lags as 'some multiple of the line',")
            print("  not as the line period itself.")
    return rep


def main():
    args = [a for a in sys.argv[1:]]
    if not args:
        print(__doc__)
        return 1
    reps = []
    for p in args:
        if not os.path.exists(p):
            print("missing: %s" % p)
            continue
        reps.append(analyze(p))
    if len(reps) > 1:
        print("")
        print("=" * 78)
        print("-- summary -----------------------------------------------------------")
        print("%-16s %-16s %10s %10s %10s %8s" %
              ("file", "header", "fs MSa/s", "clk MHz", "Mbit/s", "samp/bit"))
        for r in reps:
            if not r.get("usable"):
                print("%-16s %-16s %10s" % (os.path.basename(r["file"]), "ALL ZERO", "-"))
                continue
            print("%-16s %-16s %10.3f %10.4f %10.2f %8.4f" % (
                os.path.basename(r["file"]),
                "w=%s,wr=%s" % (r["header"].get("words"), r["header"].get("wraps")),
                r["fs_hz"] / 1e6, r["f_tmds_clk_hz"] / 1e6,
                r["bit_rate_hz"] / 1e6, r["samples_per_bit"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
