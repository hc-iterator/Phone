#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
tmds_decode_oversampled.py -- 从【过采样】的引脚采样流里切出 TMDS 符号

它解决什么问题
==============
探针（RP2040）用 PIO 采 DUT 的 8 根 DVI 线，`d` 命令输出：

    BEGIN <字数> <stall>
    00080afd                 <- 每行一个 8 位十六进制字
    ...
    END

每个 32 位字含 4 个采样，**高字节在前**（bit31..24 = 第 1 个采样）。
每个采样字节里 **bit0 = GPIO0 …… bit7 = GPIO7**，线序：
    0=D2P 1=D2N 2=D1P 3=D1N 4=D0P 5=D0N 6=CLKP 7=CLKN

DUT 加了"慢扫描档"（DVI_SM_CLKDIV=8 ⇒ 串行器 SM 分频 8）之后：
    采样率 fs = sys_clk / probe_clkdiv
    位率   br = sys_clk / dut_sm_clkdiv
    ⇒ 每 TMDS 位采样数 = br 与 fs 之比 = dut_sm_clkdiv / probe_clkdiv
默认 252MHz / probe_clkdiv=1 / dut_sm_clkdiv=8 ⇒ 8 采样/位，够切 10 bit 符号了。
（上一轮的 1 采样/位就是"给不出符号统计"的根因；本脚本把"采样不够"做成
 **显式拒绝**而不是给一个编出来的数字 —— 见 §0 的 NOTE。）

位序（最容易悄悄错的地方，先写清楚）
====================================
DUT 固件：third_party/frank-hdmi-sound/src/frank_serialiser.pio:64
    sm_config_set_out_shift(&c, true /*shift_right*/, !debug, 10*DVI_SYMBOLS_PER_WORD);
⇒ OSR 右移 ⇒ **符号的 bit0（最低位）先上线**。
所以本脚本组装符号时：**最先采到的位 = bit0**：

    sym = b[0] | b[1]<<1 | ... | b[9]<<9        (b[0] 最早)

⚠️ 反了会怎样：CTL0 0b1101010100 的比特反转正好是 CTL1 0b0010101011。
于是"控制符号命中率"**照样很高**，只是 hsync/vsync 被对调 —— 一个不会报错的
静默错误。这就是本脚本必须支持 `--expect`（拿真值逐符号比对）的原因，
`--symbol-bitorder msb-first` 就是用来给这条判据做反面测试的。

控制符号数值从哪来
==================
third_party/frank-hdmi-sound/src/frank_dvi_timing.c:260
    const uint32_t dvi_ctrl_syms[4] = {0xd5354, 0x2acab, 0x55154, 0xaaeab};
每个字低 10 bit 是符号数值，数组索引 = (vsync<<1)|hsync（线上电平）：
    0x354 CTL0 (v=0,h=0)   0x0AB CTL1 (v=0,h=1)
    0x154 CTL2 (v=1,h=0)   0x2AB CTL3 (v=1,h=1)
640x480p60 预设 h/v 都是负极性 ⇒ 空闲=1、脉冲=0。

符号栅格怎么建（关键算法）
==========================
1. 时钟 lane 是 PWM 方波（frank_serialiser.c:117-127：wrap=9、电平 5/5、
   周期正好 = 10 个 TMDS 位），所以**每个时钟上升沿都落在位边界上**。
2. 相邻两次上升沿之间的间隔 P 就是"10 个位"的实测长度。
   把 [A_k, A_k+1] 均分 10 份 ⇒ 得到 10 个位槽，**每个位槽取中间的采样**。
   ⇒ 逐符号重新锚定 ⇒ 板间频差（实测约 +900 ppm）不会累积成相位漂移。
   （若用"固定位周期"开环推算，65536 个采样之后误差可达几十个采样 ——
     这是不能用固定周期的原因。本脚本用逐符号锚定，把漂移吸收掉。）
3. **符号相位（哪 10 个位算一个符号）是搜出来的，不是假设的**：
   PWM 和 PIO 没有同步启动（frank_serialiser.c:154 注释原话），
   所以上升沿可能在符号起点，也可能在符号中间。这里对 j=0..9 全部试一遍，
   取"三条 lane 的控制符号命中总数"最大的 j。
   ⚠️ 判据是"谁更显著"：如果最佳 j 与次佳 j 差距很小，本脚本会明说
   `ROTATION-MARGIN: weak`，不硬说相位找到了。

输出纪律
========
纯 ASCII（本机控制台是 GBK，非 ASCII 会 UnicodeEncodeError）。
所有"没测到的"一律写 CANNOT-DETERMINE / 待验证，不写成结论。

用法
====
    python tools\tmds_decode_oversampled.py build_test\synth_ok.txt
    python tools\tmds_decode_oversampled.py build_test\synth_ok.txt ^
        --expect build_test\synth_ok_truth.txt
    python tools\tmds_decode_oversampled.py cap_slow.txt --probe-clkdiv 1 --dut-sm-clkdiv 8

退出码：0 = PASS（给了真值）或 INFO（没给真值，但速率自洽）；
        1 = FAIL（真值比对不达标 / 速率不自洽 / 采样不够拒绝解码）；2 = 用法错。
"""

import argparse
import collections
import math
import os
import re
import statistics
import sys

# ---------------------------------------------------------------- 常量

PIN_NAMES = ["D2P", "D2N", "D1P", "D1N", "D0P", "D0N", "CLKP", "CLKN"]

# (lane 名, P 位号, N 位号, DUT 引脚)。顺序 = 真值文件里的列顺序。
LANES = [("D0/blue", 4, 5, 36), ("D1/green", 2, 3, 34), ("D2/red", 0, 1, 32)]
LANE_KEYS = ["D0", "D1", "D2"]
CLK_P = 6
CLK_N = 7

# 控制符号：数值 -> (名字, v 电平, h 电平)。数值取自固件 dvi_ctrl_syms（见文件头）。
CTRL = {
    0x354: ("CTL0", 0, 0),
    0x0AB: ("CTL1", 0, 1),
    0x154: ("CTL2", 1, 0),
    0x2AB: ("CTL3", 1, 1),
}
CTRL_ORDER = ["CTL0", "CTL1", "CTL2", "CTL3"]


def popcount(x):
    return bin(x & 0xFFFFFFFF).count("1")


# ---------------------------------------------------------------- 读采样流

def parse_capture(path):
    """读 `d` 命令格式，返回 (header dict, samples bytearray)。"""
    hdr = {"words": None, "stall": None, "words_read": 0}
    words = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            t = line.strip()
            if not t:
                continue
            if t.startswith("BEGIN"):
                m = re.match(r"^BEGIN\s+(\d+)\s+(\d+)\s*$", t)
                if m:
                    hdr["words"] = int(m.group(1))
                    hdr["stall"] = int(m.group(2))
                continue
            if t == "END":
                continue
            if len(t) == 8:
                try:
                    words.append(int(t, 16))
                except ValueError:
                    pass
    s = bytearray()
    for w in words:
        # 4 个采样一字，高字节在前（第一个采样在 bit31..24）
        s.append((w >> 24) & 0xFF)
        s.append((w >> 16) & 0xFF)
        s.append((w >> 8) & 0xFF)
        s.append(w & 0xFF)
    hdr["words_read"] = len(words)
    return hdr, s


# ---------------------------------------------------------------- 基本信号处理

def diff_slice(samples, pbit, nbit):
    """
    差分切片：P!=N 时取 P 的电平；P==N（不可能出现的电平）时保持上一次的值。
    返回 (比特流 bytearray, P==N 的采样数)。
    """
    out = bytearray(len(samples))
    bad = 0
    prev = 0
    for i in range(len(samples)):
        b = samples[i]
        p = (b >> pbit) & 1
        q = (b >> nbit) & 1
        if p != q:
            prev = p
        else:
            bad += 1
        out[i] = prev
    return out, bad


def count_transitions(bits):
    n = 0
    for i in range(1, len(bits)):
        if bits[i] != bits[i - 1]:
            n += 1
    return n


def rising_edges(bits):
    return [i for i in range(1, len(bits)) if bits[i] == 1 and bits[i - 1] == 0]


def median(xs):
    if not xs:
        return float("nan")
    ys = sorted(xs)
    n = len(ys)
    return float(ys[n // 2]) if n % 2 else 0.5 * (ys[n // 2 - 1] + ys[n // 2])


def pct(xs, q):
    if not xs:
        return float("nan")
    ys = sorted(xs)
    i = int(round(q * (len(ys) - 1)))
    return float(ys[i])


# ---------------------------------------------------------------- 位栅格

def build_bit_grid(samples, streams, clk, max_anchors=None, phase=None):
    """
    用 CLK 上升沿把采样流切成"位槽"，每个位槽取中间采样。

    phase: {lane_key: 亚位相位偏移(采样)}，默认全 0。
      ★ 2026-10-04 修：DVI 允许时钟 lane 与数据 lane 之间有相位差，而三条数据 lane 是
        三个独立 PIO SM、启动时刻不同 ⇒ 各有自己的【位边界偏移】。实测（DUT 250 / 探针 c64，
        位周期仅 3.9 采样）：D0≈+2.5、D1≈+1.0、D2≈+7.5 采样。不做这个补偿时，
        跳变密的 lane 采样点会落在跳变附近 ⇒ clean-bit 崩（D0=0.20 / D1=0.94 / D2=0.71）；
        补偿后三路都回到 0.9996~0.9999。

    返回 dict:
      anchors     上升沿采样下标
      spacing     相邻锚点间距（采样）
      bits        {lane: bytearray}，第 g 个位 = 第 (g//10) 个锚点周期里的第 (g%10) 槽
      bitpos      每个位的中心采样下标
      clean       {lane: 干净位数}（位槽内部采样与该位取值全一致才算干净）
      nbit        位总数
    """
    anchors = rising_edges(clk)
    if max_anchors:
        anchors = anchors[:max_anchors]
    spacing = []
    bits = dict((k, bytearray()) for k in LANE_KEYS)
    clean = dict((k, 0) for k in LANE_KEYS)
    bitpos = []
    N = len(samples)
    for k in range(len(anchors) - 1):
        a0 = anchors[k]
        a1 = anchors[k + 1]
        P = a1 - a0
        if P < 10:            # 一个符号周期至少要有 10 个采样才谈得上切位
            continue
        spacing.append(P)
        for b in range(10):
            c0 = int(round(a0 + P * (b + 0.5) / 10.0))
            if c0 >= N:
                c0 = N - 1
            bitpos.append(c0)
            for key, (name, pbit, nbit, pin) in zip(LANE_KEYS, LANES):
                ph = 0.0 if not phase else phase.get(key, 0.0)
                lo = a0 + P * b / 10.0 + ph
                hi = a0 + P * (b + 1) / 10.0 + ph
                c = int(round(0.5 * (lo + hi)))
                if c < 0:
                    c = 0
                if c >= N:
                    c = N - 1
                i_lo = int(math.floor(lo)) + 1
                i_hi = int(math.ceil(hi)) - 1
                if i_lo < 0:
                    i_lo = 0
                if i_hi >= N:
                    i_hi = N - 1
                v = streams[name][c]
                bits[key].append(v)
                ok = True
                for i in range(i_lo, i_hi + 1):
                    if streams[name][i] != v:
                        ok = False
                        break
                if ok:
                    clean[key] += 1
    return {"anchors": anchors, "spacing": spacing, "bits": bits,
            "clean": clean, "bitpos": bitpos, "nbit": len(bitpos)}


def lane_clean_fraction(samples, stream, clk, phase, max_anchors=None):
    """单条 lane 在给定亚位相位下的 clean-bit 比例（供相位搜索用）。"""
    anchors = rising_edges(clk)
    if max_anchors:
        anchors = anchors[:max_anchors]
    N = len(samples)
    ok = tot = 0
    for k in range(len(anchors) - 1):
        a0 = anchors[k]
        P = anchors[k + 1] - a0
        if P < 10:
            continue
        for b in range(10):
            lo = a0 + P * b / 10.0 + phase
            hi = a0 + P * (b + 1) / 10.0 + phase
            c = int(round(0.5 * (lo + hi)))
            if c < 0 or c >= N:
                continue
            i_lo = int(math.floor(lo)) + 1
            i_hi = int(math.ceil(hi)) - 1
            if i_lo < 0:
                i_lo = 0
            if i_hi >= N:
                i_hi = N - 1
            v = stream[c]
            good = True
            for i in range(i_lo, i_hi + 1):
                if stream[i] != v:
                    good = False
                    break
            tot += 1
            if good:
                ok += 1
    return ok / max(tot, 1)


def search_lane_phase(samples, streams, clk, step=0.5, span_bits=2.0):
    """逐 lane 搜索使 clean-bit 最大的亚位相位偏移，返回 {lane_key: phase}。"""
    anchors = rising_edges(clk)
    if len(anchors) < 3:
        return dict((k, 0.0) for k in LANE_KEYS)
    sp = [anchors[i + 1] - anchors[i] for i in range(len(anchors) - 1)]
    Tb = statistics.median(sp) / 10.0
    n = int(round(span_bits * Tb / step))
    out = {}
    for key, (name, pbit, nbit, pin) in zip(LANE_KEYS, LANES):
        st = streams[name]
        best_f, best_p = -1.0, 0.0
        for j in range(n + 1):
            ph = j * step
            f = lane_clean_fraction(samples, st, clk, ph)
            if f > best_f:
                best_f, best_p = f, ph
        out[key] = best_p
    return out



def symbols_from_bits(bitarr, offset, msb_first=False):
    """把位流按 [offset, offset+10) 切符号。最先的位 = bit0（除非 msb_first）。"""
    n = (len(bitarr) - offset) // 10
    out = []
    ap = out.append
    for s in range(n):
        base = offset + 10 * s
        v = 0
        if msb_first:
            for b in range(10):
                v |= bitarr[base + b] << (9 - b)
        else:
            for b in range(10):
                v |= bitarr[base + b] << b
        ap(v)
    return out


def choose_rotation(bits, msb_first=False):
    """
    搜符号相位 j（0..9）：取三条 lane 的控制符号命中总数最大的 j。
    返回 (best_j, best_hits, second_hits, hits_table)
    """
    hits_table = []
    for j in range(10):
        h = 0
        for key in LANE_KEYS:
            for v in symbols_from_bits(bits[key], j, msb_first):
                if v in CTRL:
                    h += 1
        hits_table.append(h)
    order = sorted(range(10), key=lambda j: (-hits_table[j], j))
    best_j = order[0]
    second = hits_table[order[1]] if len(order) > 1 else 0
    return best_j, hits_table[best_j], second, hits_table


def choose_rotation_per_lane(bits, msb_first=False):
    """
    逐 lane 选符号相位 j：每条 lane 各自取【本 lane 控制符号命中最多】的 j。

    为什么必须逐 lane（2026-10-04 实测，见 docs/陷阱.md M16 第 12 轮）：
      三条 lane 的 PIO SM 不是从同一位偏移起步的，符号边界相对公共 CLK 锚点
      可以相差整数个位 ⇒ 用【全局一个 j】会把某些 lane 切错，
      消隐段就被合并/看错（例：把 前肩16+同步96+后肩48 合并成一个 160 的 run）。
      实测同一包数据：同步 lane(gpio4/5) 的 j=0，两条数据 lane 的 j=1。

    判据用"本 lane 控制符号命中数"，对两条 lane 都有效：
      同步 lane 消隐段含 96 个 CTL2；数据 lane 消隐段是 160 个 sym_no_sync(CTL0)。
    返回 {lane: (best_j, best_hits, second_hits, hits_table)}
    """
    out = {}
    for key in LANE_KEYS:
        tab = []
        for j in range(10):
            h = 0
            for v in symbols_from_bits(bits[key], j, msb_first):
                if v in CTRL:
                    h += 1
            tab.append(h)
        order = sorted(range(10), key=lambda j: (-tab[j], j))
        out[key] = (order[0], tab[order[0]],
                    tab[order[1]] if len(order) > 1 else 0, tab)
    return out


# ---------------------------------------------------------------- 真值比对

def parse_truth(path):
    t = {"lanes": LANE_KEYS, "syms": [], "nsym": None}
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            parts = s.split()
            if parts[0] in ("SAMPLES", "SAMPLES_PER_BIT", "BIT_RATE_DUT", "PPM",
                            "CLK_RISING_AT_BIT", "NSYM", "LANES"):
                t[parts[0]] = parts[1:]
                if parts[0] == "NSYM":
                    t["nsym"] = int(parts[1])
                continue
            if parts[0].isdigit() and len(parts) >= 4:
                t["syms"].append((int(parts[0], 10), int(parts[1], 16),
                                  int(parts[2], 16), int(parts[3], 16)))
    return t


def compare(dec, truth, shifts=(-2, -1, 0, 1, 2)):
    """
    dec: {lane: [symbol,...]}（解码结果）
    truth: parse_truth 的结果
    逐个符号比对，允许一个**全局**符号位移（真实捕获从哪一符号开始是任意的）。
    位移必须三条 lane 一致 —— 不允许逐 lane 各自平移（那会把 lane 错位掩盖掉）。
    返回 dict。
    """
    best = None
    for delta in shifts:
        tot = 0
        ok = 0
        per = dict((k, [0, 0]) for k in LANE_KEYS)
        for idx, v0, v1, v2 in truth["syms"]:
            j = idx + delta
            if j < 0 or j >= len(dec["D0"]):
                continue
            tot += 1
            vals = (v0, v1, v2)
            allok = True
            for li, key in enumerate(LANE_KEYS):
                per[key][1] += 1
                if dec[key][j] == vals[li]:
                    per[key][0] += 1
                else:
                    allok = False
            if allok:
                ok += 1
        # 位移用【三条 lane 的命中总数】来选（比 all3 更稳：破坏数据时 all3 恒 0，
        # 会让诊断信息全部退化）。判定仍然用最严的 all3。
        score = sum(v[0] for v in per.values())
        rec = {"delta": delta, "total": tot, "all3": ok, "score": score,
               "rate": (ok / tot) if tot else 0.0, "per": per}
        if best is None or (rec["score"], -abs(delta)) > (best["score"], -abs(best["delta"])):
            best = rec
    best["nsym_truth"] = len(truth["syms"])
    best["coverage"] = (best["total"] / best["nsym_truth"]) if best["nsym_truth"] else 0.0
    return best


# ---------------------------------------------------------------- 行结构

def run_lengths(syms):
    """返回 [(符号值/None, 长度), ...]；None 表示数据符号串。"""
    runs = []
    i = 0
    n = len(syms)
    while i < n:
        is_ctl = syms[i] in CTRL
        j = i + 1
        while j < n and ((syms[j] in CTRL) == is_ctl):
            if is_ctl and syms[j] != syms[i]:
                break
            if (not is_ctl) and (syms[j] in CTRL):
                break
            j += 1
        runs.append((syms[i] if is_ctl else None, j - i))
        i = j
    return runs


def line_structure(syms):
    """
    统计控制符号游程。返回 dict：
      runs_by_code  {CTLx: Counter(长度->次数)}
      data_runs     Counter(长度->次数)
      class_runs    Counter(长度->次数)  （不管哪个控制符号，只数"控制段"长度）
      period        {code: (mode_delta, count)} 同种符号相邻游程起点间距的众数
    """
    runs = run_lengths(syms)
    runs_by_code = dict((c, collections.Counter()) for c in CTRL_ORDER)
    data_runs = collections.Counter()
    class_runs = collections.Counter()
    starts = dict((c, []) for c in CTRL_ORDER)
    idx = 0
    for val, ln in runs:
        if val is None:
            data_runs[ln] += 1
        else:
            nm = CTRL[val][0]
            runs_by_code[nm][ln] += 1
            class_runs[ln] += 1
            starts[nm].append(idx)
        idx += ln
    period = {}
    for c in CTRL_ORDER:
        st = starts[c]
        if len(st) >= 3:
            d = collections.Counter()
            for i in range(1, len(st)):
                d[st[i] - st[i - 1]] += 1
            mode, cnt = d.most_common(1)[0]
            period[c] = (mode, cnt, len(st))
    return {"runs_by_code": runs_by_code, "data_runs": data_runs,
            "class_runs": class_runs, "period": period, "starts": starts}


# ---------------------------------------------------------------- 单文件解码

def decode_one(path, args, out):
    """对一个捕获文件做全部分析。返回 (verdict, info dict)。"""
    def W(s=""):
        out.write(s + "\n")
    W("=" * 78)
    W("FILE %s" % path)
    W("=" * 78)
    try:
        hdr, samples = parse_capture(path)
    except OSError as e:
        W("ERROR cannot read: %s" % e)
        return "FAIL", {}
    N = len(samples)
    fs = args.sys_clk / args.probe_clkdiv
    bit_rate_nom = args.sys_clk / args.dut_sm_clkdiv
    spb_nom = args.dut_sm_clkdiv / args.probe_clkdiv

    W("[0] PARAMS / INPUT")
    W("  words_in_header=%s words_read=%d samples=%d stall=%s"
      % (hdr["words"], hdr["words_read"], N, hdr["stall"]))
    if hdr["stall"]:
        W("  NOTE stall=%s -> the probe reported an RX FIFO stall: samples may be LOST."
          % hdr["stall"])
    if hdr["words"] is not None and hdr["words"] != hdr["words_read"]:
        W("  NOTE header says %d words but %d hex lines were read."
          % (hdr["words"], hdr["words_read"]))
    W("  sys_clk=%.6g Hz  probe_clkdiv=%.6g  dut_sm_clkdiv=%.6g"
      % (args.sys_clk, args.probe_clkdiv, args.dut_sm_clkdiv))
    W("  ==> sample_rate fs = sys_clk/probe_clkdiv = %.6g Sa/s" % fs)
    W("  ==> bit_rate  (nominal) = sys_clk/dut_sm_clkdiv = %.6g bit/s" % bit_rate_nom)
    W("  ==> samples per TMDS bit (nominal) = dut_sm_clkdiv/probe_clkdiv = %.6g"
      % spb_nom)

    # ---- 差分切片
    streams = {}
    bad = {}
    for key, (name, pbit, nbit, pin) in zip(LANE_KEYS, LANES):
        st, b = diff_slice(samples, pbit, nbit)
        streams[name] = st
        bad[name] = b
    clk, clk_bad = diff_slice(samples, CLK_P, CLK_N)
    clkp = bytearray((b >> CLK_P) & 1 for b in samples)
    clkn = bytearray((b >> CLK_N) & 1 for b in samples)

    W("")
    W("[1] RATE SELF-CONSISTENCY (two independent estimates vs nominal)")
    e_diff = count_transitions(clk)
    e_p = count_transitions(clkp)
    e_n = count_transitions(clkn)
    W("  CLK differential transitions = %d ; CLKP alone = %d ; CLKN alone = %d"
      % (e_diff, e_p, e_n))
    W("  P==N (invalid differential level) samples: CLK=%d %s"
      % (clk_bad, " ".join("%s=%d" % (n, bad[n]) for n in streams)))
    if e_diff <= 0 or N <= 1:
        W("  CANNOT-DETERMINE: no clock transitions at all -> wrong pins or no signal.")
        return "FAIL", {}
    # 估计 1：整窗跳变计数。CLK 一个周期 2 次跳变，周期 = 10 个 TMDS 位。
    f_clk_meas = e_diff * fs / (2.0 * N)
    br_trans = 10.0 * f_clk_meas
    rel_trans = br_trans / bit_rate_nom - 1.0
    quant = 1.0 / e_diff
    W("  est-1 (transition count over whole window):")
    W("    f_clk = e * fs / (2N) = %.6g Hz ; bit_rate = 10*f_clk = %.6g bit/s"
      % (f_clk_meas, br_trans))
    W("    relative to nominal: %+.3f%% (edge-count quantisation bound ~%.3f%%)"
      % (rel_trans * 100.0, quant * 100.0))
    anchors = rising_edges(clk)
    spacing = [anchors[i + 1] - anchors[i] for i in range(len(anchors) - 1)]
    if spacing:
        P_med = median(spacing)
        spb_meas = P_med / 10.0
        br_edge = fs / spb_meas
        rel_edge = br_edge / bit_rate_nom - 1.0
        W("  est-2 (median rising-edge spacing):")
        W("    rising edges=%d spacing min/p50/p99/max = %d/%.1f/%.1f/%d samples"
          % (len(anchors), min(spacing), P_med, pct(spacing, 0.99), max(spacing)))
        W("    samples per CLK period = %.3f -> samples per TMDS bit = %.4f"
          % (P_med, spb_meas))
        W("    bit_rate = fs / spb = %.6g bit/s ; relative to nominal: %+.3f%%"
          % (br_edge, rel_edge * 100.0))
    else:
        spb_meas = float("nan")
        rel_edge = float("nan")
        W("  est-2: CANNOT-DETERMINE (fewer than 2 rising edges)")
    # 估计 3（最精细）：首尾锚点跨度 / 位总数。误差 ~1 个采样摊到几千个位上
    #   ⇒ 能分辨到几十 ppm，这才是"板间频差"唯一量的出来的估计量。
    if len(anchors) >= 3:
        nper = len(anchors) - 1
        span = anchors[-1] - anchors[0]
        spb_fine = span / float(10 * nper)
        ppm_fine = (spb_fine / spb_nom - 1.0) * 1e6
        W("  est-3 (first-to-last anchor span, finest):")
        W("    span=%d samples over %d CLK periods -> samples per TMDS bit = %.5f"
          % (span, nper, spb_fine))
        W("    drift vs nominal = %+.0f ppm  (negative = DUT bit SHORTER = DUT faster)"
          % ppm_fine)
        W("    resolution ~ %.0f ppm (1 sample over %d bit periods)"
          % (1e6 / (10.0 * nper), nper))
    else:
        spb_fine = float("nan")
        ppm_fine = float("nan")
    # 容差要跟着"证据强度"走：边沿很少时，±1 个边沿就是很大的相对误差。
    # tol_eff = max(用户容差, 3/边沿数)；est-2 另有 ±0.5 采样的量化 ⇒ max(用户容差, 1/P)。
    tol_trans = max(args.rate_tol, 3.0 * quant)
    tol_edge = max(args.rate_tol, (1.0 / P_med)) if spacing else args.rate_tol
    # est-3 是 ppm 量纲：容差用 --drift-tol-ppm（默认 5000 ppm，足够包容两块板
    # 的晶振差 ~900ppm，又远小于"clkdiv 写错"那种成倍的错），再兜一个量化下限。
    tol_fine_ppm = (max(args.drift_tol_ppm, 3e6 / (10.0 * nper))
                    if len(anchors) >= 3 else 0.0)
    rate_ok = (abs(rel_trans) <= tol_trans) and (not spacing or abs(rel_edge) <= tol_edge)
    if len(anchors) >= 3 and abs(ppm_fine) > tol_fine_ppm:
        rate_ok = False
    ppm_implied = rel_trans * 1e6
    W("  VERDICT-rate: %s (tol: est-1 %.2f%% [3/e], est-2 %.2f%% [1/P], est-3 %.0f ppm)"
      % ("CONSISTENT" if rate_ok else "*** INCONSISTENT ***",
         tol_trans * 100.0, tol_edge * 100.0, tol_fine_ppm))
    W("    implied board-to-board ppm (est-1) = %+.0f" % ppm_implied)
    W("    NOTE both estimates share the assumed fs=sys_clk/probe_clkdiv; they validate the")
    W("    RATIO dut_sm_clkdiv/probe_clkdiv and the DUT's real bit rate, not an absolute")
    W("    time base. A wrong --probe-clkdiv shows up here as a large mismatch.")

    # ---- 采样够不够
    if spacing and spb_meas < args.min_spb:
        W("")
        W("[1b] REFUSE: measured %.3f samples per TMDS bit < %.2f required."
          % (spb_meas, args.min_spb))
        W("  Slicing 10-bit symbols needs >=2 samples/bit; below that the symbol values")
        W("  would be fiction. This tool refuses instead of printing made-up numbers.")
        W("  (Same discipline as the previous round's report.)")
        W("VERDICT: REFUSE")
        return "REFUSE", {"rate_ok": rate_ok, "spb_meas": spb_meas}

    # ---- 位栅格
    W("")
    W("[2] BIT GRID (anchored on every CLK rising edge; drift absorbed per symbol)")
    # ★ 2026-10-04：先逐 lane 搜索【亚位相位偏移】。三条数据 lane 是三个独立 PIO SM、
    #   启动时刻不同 ⇒ 位边界各有偏移；不补偿时跳变密的 lane clean-bit 会崩。
    grid0 = build_bit_grid(samples, streams, clk)
    for key, (name, pbit, nbit_, pin) in zip(LANE_KEYS, LANES):
        cf0 = grid0["clean"][key] / float(max(grid0["nbit"], 1))
        W("  clean-bit fraction %-4s = %.4f  (all samples strictly inside the bit slot"
          " agree with the centre sample)" % (key, cf0))
    phases = search_lane_phase(samples, streams, clk)
    W("  per-lane bit-phase offsets found (samples, searched 0..2 bit periods): "
      + ", ".join("%s=%+.1f" % (k, phases[k]) for k in LANE_KEYS))
    if any(abs(phases[k]) > 0.51 for k in LANE_KEYS):
        W("  NOTE => lanes are NOT phase-aligned to the CLK rising edge; re-slicing with")
        W("          the offsets above. (DVI allows a clock/data phase offset.)")
        grid = build_bit_grid(samples, streams, clk, phase=phases)
        for key, (name, pbit, nbit_, pin) in zip(LANE_KEYS, LANES):
            W("  clean-bit fraction %-4s = %.4f  (after phase compensation)"
              % (key, grid["clean"][key] / float(max(grid["nbit"], 1))))
    else:
        grid = grid0
    nbit = grid["nbit"]
    W("  anchors used=%d  bit slots=%d (= %d symbols worth of bits)"
      % (max(0, len(grid["anchors"]) - 1), nbit, nbit // 10))
    if nbit < 50:
        W("  CANNOT-DETERMINE: too few bit slots (%d)." % nbit)
        W("VERDICT: FAIL")
        return "FAIL", {}
    if nbit < 200:
        W("  WARNING: only %d bit slots (%d symbols) - statistics below are weak."
          % (nbit, nbit // 10))
    W("  NOTE drift: the grid is re-anchored every symbol (10 bits), so the ~+900 ppm")
    W("  board-to-board offset shifts the whole grid, it does NOT accumulate. The")
    W("  measured samples/bit above already contains that offset.")

    # ---- 符号相位
    W("")
    W("[3] SYMBOL PHASE (which 10 bits form a symbol) -- searched, not assumed")
    if getattr(args, "global_rotation", False):
        best_j, best_hits, second_hits, hits_table = choose_rotation(
            grid["bits"], args.symbol_bitorder == "msb-first")
        per_lane = dict((k, (best_j, best_hits, second_hits, hits_table)) for k in LANE_KEYS)
        W("  --global-rotation 指定：三条 lane 共用 j=%d hits=%d runner-up=%d"
          % (best_j, best_hits, second_hits))
    else:
        per_lane = choose_rotation_per_lane(grid["bits"],
                                            args.symbol_bitorder == "msb-first")
        for key in LANE_KEYS:
            j, h, sec, tab = per_lane[key]
            W("  %-4s: chosen j=%d hits=%d runner-up=%d   hits(j)=%s"
              % (key, j, h, sec, " ".join(str(x) for x in tab)))
            margin_l = "strong" if (sec == 0 and h > 0) or (h >= 4 * max(1, sec)) else "weak"
            if margin_l == "weak":
                W("        WARNING: %s 的符号相位未被证据确立（runner-up 太接近）" % key)
        best_j = per_lane[LANE_KEYS[0]][0]      # 仅用于下游兼容字段
        best_hits = per_lane[LANE_KEYS[0]][1]
        second_hits = per_lane[LANE_KEYS[0]][2]
        hits_table = per_lane[LANE_KEYS[0]][3]
    margin = "strong" if (second_hits == 0 and best_hits > 0) or \
                         (best_hits >= 4 * max(1, second_hits)) else "weak"
    W("  ROTATION-MARGIN(按 %s 记): %s" % (LANE_KEYS[0], margin))
    syms = dict((k, symbols_from_bits(grid["bits"][k], per_lane[k][0],
                                      args.symbol_bitorder == "msb-first"))
                for k in LANE_KEYS)
    W("  bit order used: %s  (LSB-first is proven by frank_serialiser.pio:64"
      " sm_config_set_out_shift(shift_right=true))" % args.symbol_bitorder)

    # ---- 分类
    W("")
    W("[4] SYMBOL CLASSIFICATION")
    tot_ctl = 0
    for key in LANE_KEYS:
        ss = syms[key]
        c = collections.Counter(ss)
        nc = sum(v for k, v in c.items() if k in CTRL)
        tot_ctl += nc
        W("  lane %-4s symbols=%d  control=%d (%.2f%%)  data=%d"
          % (key, len(ss), nc, 100.0 * nc / max(1, len(ss)), len(ss) - nc))
        W("    control histogram: " + " ".join(
            "%s=%d" % (nm, c[code]) for code, (nm, _v, _h) in
            sorted(CTRL.items(), key=lambda kv: CTRL_ORDER.index(kv[1][0]))))
        data = [(v, n) for v, n in c.items() if v not in CTRL]
        data.sort(key=lambda kv: (-kv[1], kv[0]))
        W("    top data symbols (value:count:popcount): " + " ".join(
            "0x%03x:%d:%d" % (v, n, popcount(v)) for v, n in data[:20]))
        if data:
            pc = collections.Counter()
            for v, n in data:
                pc[popcount(v)] += n
            W("    data popcount histogram: " + " ".join(
                "%d:%d" % (k, pc[k]) for k in sorted(pc)))
    W("    NOTE on popcount: DVI's spec 8b/10b encoder emits only 4/6 ones (5 is not")
    W("    reachable for data), but frank-hdmi-sound's pixel-doubling table can emit")
    W("    complementary 1/9 pairs (frank_tmds_table.h entry0 = 0x100 | 0x1ff<<10,")
    W("    verified bit-exact in make_tmds_testdata.py --check-dut-table).")
    W("    Which encoder the LIVE build uses is TO-BE-VERIFIED -> popcount is printed")
    W("    as information, NOT used as a pass/fail judge.")

    # ---- 行结构
    W("")
    W("[5] LINE STRUCTURE (control-symbol run lengths)")
    W("  Expected for 640x480p60 if the firmware follows frank_dvi_timing.c:")
    W("    lane D0/blue is TMDS_SYNC_LANE (frank_dvi.h:31) -> blanking = 16 idle +")
    W("    96 sync + 48 idle = 160; the other two lanes emit 0x354 for all 160")
    W("    (frank_dvi_timing.c:477-491). Across a line boundary the two idle runs of")
    W("    one line meet the next line's front porch -> runs of 64 and 96.")
    W("    h/v are both NEGATIVE polarity in the 640x480p60 preset, so idle=1, pulse=0:")
    W("    active line -> CTL3(64) / CTL2(96) on D0 ; vblank line -> longer CTL3 runs.")
    W("  This is a PREDICTION from the source, not a measurement. TO-BE-VERIFIED.")
    structs = {}
    for key in LANE_KEYS:
        st = line_structure(syms[key])
        structs[key] = st
        W("  lane %-4s" % key)
        for c in CTRL_ORDER:
            cnt = st["runs_by_code"][c]
            if not cnt:
                continue
            top = cnt.most_common(12)
            W("    RUNLEN %s %s n=%d : %s" % (key, c, sum(cnt.values()),
              " ".join("%d x%d" % (ln, n) for ln, n in sorted(top, key=lambda kv: -kv[1]))))
        if st["data_runs"]:
            top = st["data_runs"].most_common(6)
            W("    RUNLEN %s DATA n=%d : %s" % (key, sum(st["data_runs"].values()),
              " ".join("len%d x%d" % (ln, n) for ln, n in top)))
            W("    (a DATA run of 640 symbols = one full active region)")
        if st["period"]:
            for c, (mode, cnt, nstarts) in sorted(st["period"].items()):
                W("    PERIOD %s %s: start-to-start mode=%d symbols (x%d of %d starts)"
                  % (key, c, mode, cnt, nstarts))
            # ★ 2026-10-04：把控制 run 的【起始符号位置】也打出来，便于量行周期
            #   （640x480p60 一行 = 800 符号；同一种控制码相邻起点之差就是行周期）
            for c in CTRL_ORDER:
                stt = st["starts"].get(c) or []
                if len(stt) >= 2:
                    gaps = [stt[i] - stt[i - 1] for i in range(1, len(stt))]
                    W("    STARTS %s %s: %s   gaps=%s"
                      % (key, c, ",".join(str(x) for x in stt[:12]), gaps[:12]))
        else:
            W("    PERIOD %s: CANNOT-DETERMINE (need >=3 runs of one control code;"
              " one capture holds only ~%d symbols ~= 1 line of 800)"
              % (key, len(syms[key])))

    # ---- 三 lane 对齐
    W("")
    W("[6] THREE-LANE ALIGNMENT (judged by where control symbols appear)")
    is_ctl = dict((k, [1 if v in CTRL else 0 for v in syms[k]]) for k in LANE_KEYS)
    n = min(len(is_ctl[k]) for k in LANE_KEYS)
    all3 = sum(1 for i in range(n) if is_ctl["D0"][i] and is_ctl["D1"][i] and is_ctl["D2"][i])
    W("  symbol index where ALL 3 lanes are control = %d / %d (%.2f%%)"
      % (all3, n, 100.0 * all3 / max(1, n)))
    W("  per-lane control-symbol count (same window): " + " ".join(
        "%s=%d" % (k, sum(is_ctl[k][:n])) for k in LANE_KEYS))
    W("  bit-offset scan (shift one lane by d bits, count all-3-control indices):")
    for key in LANE_KEYS:
        row = []
        for d in (-2, -1, 0, 1, 2):
            if d == 0:
                row.append("0:%d" % all3)
                continue
            arr = symbols_from_bits(grid["bits"][key], per_lane[key][0] + d,
                                    args.symbol_bitorder == "msb-first")
            m = min(n, len(arr))
            c = sum(1 for i in range(m) if arr[i] in CTRL and
                    is_ctl["D0"][i] and is_ctl["D1"][i] and is_ctl["D2"][i])
            row.append("%+d:%d" % (d, c))
        W("    %-4s %s" % (key, " ".join(row)))
    W("  (offset 0 must be the clear maximum; if not, the lanes are NOT aligned and")
    W("   every per-lane conclusion above is suspect.)")

    # ---- 真值比对
    info = {"rate_ok": rate_ok, "spb_meas": spb_meas, "rot": best_j,
            "rot_hits": best_hits, "rot_margin": margin, "sym_n": len(syms["D0"]),
            "ctl_hits": tot_ctl}
    if args.expect:
        W("")
        W("[7] COMPARE AGAINST GROUND TRUTH (%s)" % args.expect)
        try:
            truth = parse_truth(args.expect)
        except OSError as e:
            W("  ERROR cannot read truth: %s" % e)
            W("VERDICT: FAIL")
            return "FAIL", info
        W("  truth NSYM=%s SAMPLES_PER_BIT=%s CLK_RISING_AT_BIT=%s PPM=%s"
          % (truth.get("NSYM"), truth.get("SAMPLES_PER_BIT"),
             truth.get("CLK_RISING_AT_BIT"), truth.get("PPM")))
        cmp = compare(syms, truth)
        info["match"] = cmp
        tp = truth.get("PPM")
        if tp:
            want = -float(tp[0])
            W("  drift cross-check: truth PPM=%+.0f (positive = DUT faster) => decoder"
              % float(tp[0]))
            W("    est-3 should read about %+.0f ppm ; it reads %+.0f ppm (diff %+.0f,"
              % (want, ppm_fine, ppm_fine - want))
            W("    method resolution ~%.0f ppm (1 sample over %d bit periods);"
              % (1e6 / (10.0 * nper) if len(anchors) >= 3 else float("nan"), nper))
            W("    verdict gate is %.0f ppm" % tol_fine_ppm)
        W("  best global symbol shift delta=%+d ; compared=%d/%d (coverage %.4f)"
          % (cmp["delta"], cmp["total"], cmp["nsym_truth"], cmp["coverage"]))
        W("  all-3-lanes exact match = %d / %d" % (cmp["all3"], cmp["total"]))
        for key in LANE_KEYS:
            o, t = cmp["per"][key]
            W("    lane %-4s match %d/%d = %.4f" % (key, o, t, (o / t) if t else 0.0))
        W("MATCH-RATE: %.4f (lane D0=%.4f D1=%.4f D2=%.4f shift=%+d compared=%d/%d)"
          % (cmp["rate"],
             (cmp["per"]["D0"][0] / cmp["per"]["D0"][1]) if cmp["per"]["D0"][1] else 0.0,
             (cmp["per"]["D1"][0] / cmp["per"]["D1"][1]) if cmp["per"]["D1"][1] else 0.0,
             (cmp["per"]["D2"][0] / cmp["per"]["D2"][1]) if cmp["per"]["D2"][1] else 0.0,
             cmp["delta"], cmp["total"], cmp["nsym_truth"]))
        match_ok = (cmp["rate"] >= args.min_match) and (cmp["coverage"] >= args.min_coverage)
        W("  judge: match_rate >= %.4f ? %s ; coverage >= %.2f ? %s"
          % (args.min_match, cmp["rate"] >= args.min_match, args.min_coverage,
             cmp["coverage"] >= args.min_coverage))
        if not rate_ok:
            W("  also: rate self-consistency FAILED -> verdict FAIL regardless of match.")
        verdict = "PASS" if (match_ok and rate_ok) else "FAIL"
    else:
        W("")
        W("[7] NO GROUND TRUTH GIVEN (--expect missing)")
        W("  Without a reference the only checks available are: rate consistency, a")
        W("  strong rotation margin, and how many control symbols were found.")
        W("  WEAK-JUDGE: control-symbol hits=%d (a lenient judge would call this"
          " 'decoded'), rotation-margin=%s" % (tot_ctl, margin))
        W("  Those are NOT sufficient to claim the symbols are correct - see")
        W("  tools/TMDS_OVERSAMPLED_REPORT.md: a lenient judge passes corrupted data.")
        verdict = "INFO" if rate_ok else "FAIL"
    W("VERDICT: %s" % verdict)
    return verdict, info


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(
        description="Decode TMDS symbols from an OVERSAMPLED DVI pin capture "
                    "(probe 'd' command format). ASCII output only.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="exit code: 0 = PASS/INFO, 1 = FAIL/REFUSE, 2 = usage error")
    ap.add_argument("captures", nargs="+", help="capture file(s) in probe 'd' format")
    ap.add_argument("--sys-clk", type=float, default=252e6,
                    help="nominal system clock of both boards, Hz (default 252e6)")
    ap.add_argument("--probe-clkdiv", type=float, default=1.0,
                    help="probe PIO sampling divider (default 1 -> 252 MSa/s)")
    ap.add_argument("--dut-sm-clkdiv", type=float, default=8.0,
                    help="DUT serialiser SM divider (default 8 -> slow-scan 31.5 Mbit/s)")
    ap.add_argument("--global-rotation", action="store_true",
                    help="三条 lane 共用一个符号相位 j（旧行为）。默认逐 lane 各自搜 j —— "
                         "因为三条 lane 的符号边界相对公共 CLK 锚点可差整数个位，"
                         "共用 j 会把消隐段（前肩16/同步96/后肩48）合并看错。见 docs/陷阱.md M16。")
    ap.add_argument("--symbol-bitorder", choices=["lsb-first", "msb-first"],                    default="lsb-first",
                    help="bit order inside a 10-bit symbol (default lsb-first, proven "
                         "by frank_serialiser.pio:64)")
    ap.add_argument("--expect", help="ground-truth file from make_tmds_testdata.py")
    ap.add_argument("--min-match", type=float, default=0.99,
                    help="required exact-match rate vs ground truth (default 0.99)")
    ap.add_argument("--min-coverage", type=float, default=0.90,
                    help="required fraction of truth symbols actually compared (default 0.90)")
    ap.add_argument("--rate-tol", type=float, default=0.02,
                    help="allowed relative mismatch between measured and nominal bit rate")
    ap.add_argument("--drift-tol-ppm", type=float, default=5000.0,
                    help="allowed board-to-board drift (est-3) in ppm (default 5000; the "
                         "measured DUT/probe crystal offset is ~900 ppm)")
    ap.add_argument("--min-spb", type=float, default=2.0,
                    help="refuse to slice symbols below this many samples per bit")
    args = ap.parse_args()

    if args.expect and len(args.captures) != 1:
        ap.error("--expect works with exactly one capture file")

    out = sys.stdout
    worst = "INFO"
    for path in args.captures:
        v, _info = decode_one(path, args, out)
        if v == "FAIL" or v == "REFUSE":
            worst = "FAIL"
        elif v == "PASS" and worst == "INFO":
            worst = "PASS"
    if len(args.captures) > 1:
        out.write("")
        out.write("=" * 78)
        out.write("AGGREGATE over %d files (worst case wins)" % len(args.captures))
        out.write("VERDICT: %s" % worst)
    return 0 if worst in ("PASS", "INFO") else 1


if __name__ == "__main__":
    sys.exit(main())
