#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
make_tmds_testdata.py -- 合成"已知内容"的过采样 TMDS 采样流（合成数据生成器）

为什么需要这个脚本
==================
tools/tmds_decode_oversampled.py 要从探针 `d` 命令的输出里切出 TMDS 符号。
但"能切出符号"本身**不是证据** —— 必须：
  1. 拿【已知答案】的采样流喂它，看它解不解得回来（逐符号比对通过率）；
  2. 再拿【故意破坏】的采样流喂它，看它会不会照样报成功。
     （`陷阱本.md` 错 17：过于宽松的检查脚本 = 给被测代码发免死金牌。）
本脚本就是干这个的：造数据 + 写真值 + 故意破坏 + 一条命令把整条链跑完。

采样流格式（= 探针 `d` 命令格式，解码器唯一的输入格式）
=====================================================
    BEGIN <字数> <stall>
    00080afd                 <- 每行一个 8 位十六进制字，共 <字数> 行
    ...
    END
每个 32 位字含 4 个采样，**高字节在前**（bit31..24 = 第 1 个采样）。
每个采样字节里：**bit0 = GPIO0 …… bit7 = GPIO7**。

探针的 8 根线（本脚本与解码器共用这一张表）
==========================================
    0=D2P 1=D2N 2=D1P 3=D1N 4=D0P 5=D0N 6=CLKP 7=CLKN
DUT 侧（src/dvi_screen.c:40 "FRANK_HDMI_PIN_CLK=38, D0=36, D1=34, D2=32"）：
    D0=blue=GPIO36, D1=green=GPIO34, D2=red=GPIO32, CLK=GPIO38。

位序：最容易悄悄错的地方，先写清楚
==================================
DUT 固件用的是 frank-hdmi-sound 的 PIO 串行器：
    third_party/frank-hdmi-sound/src/frank_serialiser.pio:64
        sm_config_set_out_shift(&c, true /*shift_right*/, !debug,
                                10 * DVI_SYMBOLS_PER_WORD);
⇒ OSR 右移 ⇒ **符号的 bit0（最低位）先上线**（"LSB 先送"）。
再加那段 out-pc 小把戏（地址 0 带 side 0b10、地址 1 带 side 0b01）：
D+ 电平 = 逻辑位本身，**不反相**，且 1 个 SM 周期 = 1 个 TMDS 位。
所以本脚本按 "bit0 先发" 生成；解码器也必须按 "最先采到的位 = bit0" 组装。
⚠️ 位序反了**不会明显报错**：CTL0 0b1101010100 会被读成 CTL1 0b0010101011
（两者互为比特反转），于是 hsync/vsync 被对调 —— 现象"看起来很合理"。
这正是必须拿真值逐符号比对、不能只看"控制符号命中率"的原因。

控制符号数值：取自 DUT 真实固件，不是从别处抄的
==============================================
    third_party/frank-hdmi-sound/src/frank_dvi_timing.c:260
        const uint32_t dvi_ctrl_syms[4] = {0xd5354, 0x2acab, 0x55154, 0xaaeab};
每个字低 10 bit 就是一个控制符号的数值；数组索引 = (vsync<<1)|hsync（**线上电平**）：
    0x354 CTL0 (v=0,h=0)     0x0AB CTL1 (v=0,h=1)
    0x154 CTL2 (v=1,h=0)     0x2AB CTL3 (v=1,h=1)
640x480p60 预设（frank_dvi_timing.c:29 dvi_timing_640x480p_60hz）h/v 都是**负极性**
⇒ 空闲电平 = 1、同步脉冲期间 = 0（src/dvi_screen.c:41 记录了本工程用的就是这个预设）。
⇒ 【有效行】消隐段 = 16 空闲 + 96 脉冲 + 48 空闲 = 160 个符号；
   同步 lane（D0/blue）发 0x2AB(sym_off) 与 0x154(sym_on)；
   另外两条 lane 发 sym_no_sync = 0x354 一整段（frank_dvi_timing.c:477-491）。
⇒ 【场消隐行】同步 lane 整行都是控制符号（末 640 个也是 sym_off）；
   另外两条 lane 整行 0x354。

每行 800 个符号（640x480p60）：本脚本按 800 生成。
⚠️ 待验证：DUT 固件里 `_dvi_fill_unused_slots()`（frank_dvi_timing.c:388）会给每条
   lane 塞"续命段"（同步 2 槽、数据 5 槽，各 1 字=2 符号）。同文件 110-113 行的注释
   断言"这些多出来的字会在行边界被丢弃、不累积" ⇒ 每行仍应是 800 个符号。
   这一条是**注释里的断言**，本脚本没有实测过；解码器会在真实数据上实测行长，
   不假设 800。

用法
====
    # 一条命令跑完自证（正常→通过；破坏→必须失败）
    python tools\make_tmds_testdata.py --selftest

    # 只造一份数据 + 真值
    python tools\make_tmds_testdata.py --out build_test\synth_ok.txt ^
        --truth build_test\synth_ok_truth.txt --words 16384 --ppm 900

本脚本只写文件，不碰串口、不碰 core1_monitor、不碰 third_party（只【读】一个头文件
做编码器自检，见 --check-dut-table）。
"""

import argparse
import math
import os
import random
import re
import subprocess
import sys

# ---------------------------------------------------------------- 常量表

# 探针字节里的 GPIO 位号：(P, N)。顺序 = 解码器输出的 lane 顺序。
LANE_ORDER = ["D0", "D1", "D2"]
LANE_PINS = {"D0": (4, 5), "D1": (2, 3), "D2": (0, 1)}   # D0=blue D1=green D2=red
CLK_PINS = (6, 7)

# 控制符号数值（取自 dvi_ctrl_syms，见文件头）
CTL0 = 0x354   # (v=0,h=0)  0b1101010100
CTL1 = 0x0AB   # (v=0,h=1)  0b0010101011
CTL2 = 0x154   # (v=1,h=0)  0b0101010100
CTL3 = 0x2AB   # (v=1,h=1)  0b1010101011
CTRL_CODES = (CTL0, CTL1, CTL2, CTL3)
CTRL_NAMES = {CTL0: "CTL0", CTL1: "CTL1", CTL2: "CTL2", CTL3: "CTL3"}


def ctrl_code(v_wire, h_wire):
    """按线上电平取控制符号数值。索引 = (v<<1)|h，与固件 dvi_ctrl_syms[] 一致。"""
    return CTRL_CODES[(int(v_wire) << 1) | int(h_wire)]


# 640x480p60（VESA DMT id 1）
H_FRONT, H_SYNC, H_BACK, H_ACTIVE = 16, 96, 48, 640
V_FRONT, V_SYNC, V_BACK, V_ACTIVE = 10, 2, 33, 480
H_TOTAL = H_FRONT + H_SYNC + H_BACK + H_ACTIVE     # 800
V_TOTAL = V_FRONT + V_SYNC + V_BACK + V_ACTIVE     # 525
H_POL_NEG = True     # dvi_timing_640x480p_60hz: h_sync_polarity = false
V_POL_NEG = True
SYNC_LANE = "D0"     # frank_dvi.h:31  #define TMDS_SYNC_LANE 0 // blue!


# ---------------------------------------------------------------- TMDS 编码器
# 移植自 third_party/libdvi/tmds_table_gen.py（DVI 1.0 规范 Figure 3-5 的直译）。
# 保留原注释里的一句关键事实：如果 x 是偶数，且编码器当前失衡为 0，
# 那么"先编 x 再编 x+1"得到的符号对净失衡为 0 —— 库就是靠这条做成无状态查表的。
def _popcount(x):
    return bin(x).count("1")


def _byte_imbalance(x):
    """等价于规范的 N1(q) - N0(q)。"""
    return 2 * _popcount(x) - 8


class TmdsEncoder(object):
    """DVI 1.0 Figure 3-5（T.M.D.S. Encode Algorithm）的直译。"""

    def __init__(self):
        self.imbalance = 0

    def encode(self, d, c=0, de=1):
        if not de:
            self.imbalance = 0
            return (CTL0, CTL1, CTL2, CTL3)[c]
        # 先做"最少跳变"变换，得到 9 bit 的 q_m（bit8 标记走了哪个分支）
        q_m = d & 0x1
        if _popcount(d) > 4 or (_popcount(d) == 4 and not d & 0x1):
            for i in range(7):
                q_m = q_m | (~(q_m >> i ^ d >> i + 1) & 0x1) << i + 1
        else:
            for i in range(7):
                q_m = q_m | ((q_m >> i ^ d >> i + 1) & 0x1) << i + 1
            q_m = q_m | 0x100
        # 再修直流平衡
        inversion_mask = 0x2FF
        if self.imbalance == 0 or _byte_imbalance(q_m & 0xFF) == 0:
            q_out = q_m ^ (0 if q_m & 0x100 else inversion_mask)
            if q_m & 0x100:
                self.imbalance += _byte_imbalance(q_m & 0xFF)
            else:
                self.imbalance -= _byte_imbalance(q_m & 0xFF)
        elif (self.imbalance > 0) == (_byte_imbalance(q_m & 0xFF) > 0):
            q_out = q_m ^ inversion_mask
            self.imbalance += ((q_m & 0x100) >> 7) - _byte_imbalance(q_m & 0xFF)
        else:
            q_out = q_m
            self.imbalance += _byte_imbalance(q_m & 0xFF) - ((~q_m & 0x100) >> 7)
        return q_out


def dut_table_path(repo_root):
    return os.path.join(repo_root, "third_party", "frank-hdmi-sound", "src",
                        "frank_tmds_table.h")


def read_dut_table(repo_root):
    """读 DUT 固件里那张 64 项像素加倍表（只读，不改）。"""
    path = dut_table_path(repo_root)
    out = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            m = re.match(r"^\s*0x([0-9a-fA-F]+)u?\s*,", line)
            if m:
                out.append(int(m.group(1), 16))
    return out


def check_encoder_vs_dut_table(repo_root):
    """
    自检：本脚本的编码器必须能逐项复现 DUT 固件里那张表。
    （表头写着 "Generated from tmds_table_gen.py"，即同一个算法。）
    判据：64/64 项全等，且每对符号编完后 running disparity 回到 0。
    """
    table = read_dut_table(repo_root)
    if len(table) != 64:
        return False, "table entry count is not 64 (read %d)" % len(table)
    bad = []
    for k, want in enumerate(table):
        enc = TmdsEncoder()
        sym0 = enc.encode(4 * k, 0, 1)
        sym1 = enc.encode(4 * k + 1, 0, 1)
        got = sym0 | (sym1 << 10)
        if got != want or enc.imbalance != 0:
            bad.append((k, want, got, enc.imbalance))
    if bad:
        k, want, got, imb = bad[0]
        return False, ("entry %d differs: table=0x%05x ours=0x%05x imbalance=%d (%d bad)"
                       % (k, want, got, imb, len(bad)))
    return True, "64/64 entries identical to the DUT table, imbalance returns to 0 per pair"


# ---------------------------------------------------------------- 行结构

class Payload(object):
    """有效像素区的数据符号来源。默认用 DUT 那张 64 项表（= 固件真实输出）。"""

    def __init__(self, kind, rng, dut_table):
        self.kind = kind
        self.rng = rng
        self.dut_table = dut_table
        self.enc = {name: TmdsEncoder() for name in LANE_ORDER}

    def next_pair(self, lane):
        """给一条 lane 取一对符号（DUT 表保证一对净失衡为 0）。"""
        if self.kind == "dut-table" and self.dut_table:
            w = self.rng.choice(self.dut_table)
            return [(w >> 0) & 0x3FF, (w >> 10) & 0x3FF]
        e = self.enc[lane]
        d0 = self.rng.randrange(256)
        d1 = self.rng.randrange(256)
        return [e.encode(d0, 0, 1), e.encode(d1, 0, 1)]


def build_line(kind, payload):
    """
    造一行，返回 {lane: [10bit 符号, ...]} 与这一行的"真值标签"。

    kind: 'active' 有效行 / 'vblank' 场消隐行 / 'vsync' 场同步脉冲行
    按固件语义（frank_dvi_timing.c:474 dvi_setup_scanline_for_active /
                        :422 dvi_setup_scanline_for_vblank）：
      vsync 线上电平 = 0 if (该行在 v 同步脉冲内 == 负极性) else 1
      h 线上电平：消隐区空闲 = 1、同步脉冲期间 = 0（负极性）
      同步 lane 消隐 = sym_off / sym_on；其余 lane 整段 = 0x354(sym_no_sync)
    """
    vsync_asserted = (kind == "vsync")
    v_wire = int(not vsync_asserted) if V_POL_NEG else int(vsync_asserted)
    h_idle = 1 if H_POL_NEG else 0
    h_pulse = 0 if H_POL_NEG else 1
    sym_off = ctrl_code(v_wire, h_idle)
    sym_on = ctrl_code(v_wire, h_pulse)
    no_sync = ctrl_code(0, 0)          # 0x354，与固件 sym_no_sync 同

    active = (kind == "active")
    out = {}
    for lane in LANE_ORDER:
        if lane == SYNC_LANE:
            syms = ([sym_off] * H_FRONT + [sym_on] * H_SYNC + [sym_off] * H_BACK)
        else:
            syms = [no_sync] * (H_FRONT + H_SYNC + H_BACK)
        if active:
            i = 0
            while i < H_ACTIVE:                 # 每次吐一对（与固件的成对编码一致）
                pair = payload.next_pair(lane)
                syms.append(pair[0])
                if i + 1 < H_ACTIVE:
                    syms.append(pair[1])
                i += 2
        else:
            tail = sym_off if lane == SYNC_LANE else no_sync
            syms += [tail] * H_ACTIVE
        assert len(syms) == H_TOTAL, (lane, len(syms))
        out[lane] = syms
    return out, {"kind": kind, "v_wire": v_wire, "sym_off": sym_off, "sym_on": sym_on}


def build_stream(n_lines, first_kind, payload, vsync_lines=2, vblank_lines=0):
    """
    造连续若干行。first_kind 决定第一行是什么，之后按
    vblank_lines 行场消隐 → vsync_lines 行场同步 → 其余有效行 循环。
    """
    seq = []
    k = {"active": 0, "vblank": 1, "vsync": 2}[first_kind]
    for n in range(n_lines):
        if n == 0:
            kind = first_kind
        else:
            period = max(1, vblank_lines + vsync_lines + 8)
            ph = (n - 1) % period
            if ph < vblank_lines:
                kind = "vblank"
            elif ph < vblank_lines + vsync_lines:
                kind = "vsync"
            else:
                kind = "active"
        per_lane, _meta = build_line(kind, payload)
        seq.append((kind, per_lane))
    return seq


# ---------------------------------------------------------------- 渲染成采样流

def render(lines, args):
    """
    把符号序列渲染成探针采样流（每个采样一个字节，bit0..7 = GPIO0..7）。

    时间模型（都在"探针采样"这个单位里）：
      - 每个 DUT 位占 spb_eff = (dut_sm_clkdiv/probe_clkdiv) / (1 + ppm*1e-6) 个采样；
        ppm > 0 表示 **DUT 板比探针板快** 900 ppm ⇒ 它的位更短。
      - 第 n 个采样的时刻 = n + 抖动_n（iid 正态，单位：采样）。
      - 数据 lane 的位 = 符号的 bit(b%10)（LSB 先送）；msb_first 时反过来。
      - CLK lane（PWM，wrap=9、电平 5/5、A 通道反相）：
        一个符号周期 = 10 个位，前 5 个位高、后 5 个位低（clk_phase=0），
        clk_phase=5 表示反过来（= 上升沿落在符号中间）。
        这两种在真实板子上都可能，因为 PWM 与 PIO 没有同步启动
        （frank_serialiser.c:154 注释原话："The DVI spec allows for phase
         offset between clock and data links. So PWM and PIO do not need to be
         synchronised perfectly."）⇒ 解码器不能假设上升沿就在符号起点。
    """
    n_samples = args.words * 4
    fs_ppm = 1.0 + args.ppm * 1e-6
    spb = (float(args.dut_sm_clkdiv) / float(args.probe_clkdiv)) / fs_ppm

    # 拍平成"全流符号"数组，便于按位取
    lane_syms = {name: [] for name in LANE_ORDER}
    for _kind, per_lane in lines:
        for name in LANE_ORDER:
            lane_syms[name].extend(per_lane[name])
    n_sym_total = min(len(v) for v in lane_syms.values())

    # 抖动序列（固定种子 ⇒ 可复现）
    rng = random.Random(args.seed * 7919 + 13)
    if args.jitter > 0:
        jit = [rng.gauss(0.0, args.jitter) for _ in range(n_samples)]
    else:
        jit = [0.0] * n_samples

    shifts = {name: float(args.corrupt_shift.get(name, 0.0)) for name in LANE_ORDER}
    inverted = set(args.corrupt_invert_lanes)

    out = bytearray(n_samples)
    bits_used = 0
    bit_cache = {}
    for n in range(n_samples):
        t_bit = (n + jit[n]) / spb
        b = int(t_bit // 1)
        if b < 0:
            b = 0
        if b > bits_used:
            bits_used = b
        byte = 0
        for name in LANE_ORDER:
            bb = int((t_bit - shifts[name]) // 1)
            if bb < 0:
                bb = 0
            si = bb // 10
            if si >= n_sym_total:
                si = n_sym_total - 1
            idx = bb % 10
            if args.corrupt_msb_first:
                idx = 9 - idx
            v = (lane_syms[name][si] >> idx) & 1
            if name in inverted:
                v ^= 1
            pbit, nbit = LANE_PINS[name]
            if v:
                byte |= (1 << pbit)
            else:
                byte |= (1 << nbit)
        # 时钟 lane
        within = b % 10
        if args.clk_phase:
            clk_high = 1 if within >= 5 else 0
        else:
            clk_high = 1 if within < 5 else 0
        pbit, nbit = CLK_PINS
        if clk_high:
            byte |= (1 << pbit)
        else:
            byte |= (1 << nbit)
        out[n] = byte

    # 采样级破坏
    if args.corrupt_subsample > 1:
        out = bytearray(out[::args.corrupt_subsample])
    if args.corrupt_noise_frac > 0:
        rng2 = random.Random(args.seed * 104729 + 7)
        names = args.corrupt_noise_lanes or ["D0"]
        for name in names:
            pbit, nbit = LANE_PINS[name]
            for n in range(len(out)):
                if rng2.random() < args.corrupt_noise_frac:
                    out[n] ^= (1 << pbit) | (1 << nbit)   # 整对翻（差分极性翻）

    truth = {
        "n_samples": len(out),
        "samples_per_bit": spb,
        "bit_rate_dut": float(args.sys_clk) / float(args.dut_sm_clkdiv) * fs_ppm,
        "ppm": args.ppm,
        "clk_rising_at_bit": (5 if args.clk_phase else 0),
        "n_sym": min(n_sym_total, bits_used // 10 + 1),
        "lane_syms": lane_syms,
    }
    return out, truth


def write_capture(path, samples, stall=0, words=None):
    """写成 `d` 命令格式：BEGIN <字数> <stall> / 每行 8 位十六进制 / END。"""
    n = len(samples)
    nw = n // 4
    if words is not None:
        nw = min(nw, words)
    lines = ["BEGIN %d %d" % (nw, stall)]
    for w in range(nw):
        s0 = samples[4 * w + 0]
        s1 = samples[4 * w + 1]
        s2 = samples[4 * w + 2]
        s3 = samples[4 * w + 3]
        lines.append("%08x" % ((s0 << 24) | (s1 << 16) | (s2 << 8) | s3))
    lines.append("END")
    with open(path, "w", encoding="ascii", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    return nw


def write_truth(path, truth, corrupt_name):
    """
    真值文件格式（纯 ASCII，解码器 --expect 直接读）：
        # 注释行
        SAMPLES / SAMPLES_PER_BIT / BIT_RATE_DUT / PPM / CLK_RISING_AT_BIT / NSYM
        每行一个符号： <索引> <D0 三位十六进制> <D1> <D2>
    符号数值按 "最先发送的位 = bit0" 组装（见文件头的位序说明）。
    """
    with open(path, "w", encoding="ascii", newline="\n") as f:
        f.write("# TMDS_SYNTH_TRUTH v1\n")
        f.write("# corrupt=%s\n" % corrupt_name)
        f.write("SAMPLES %d\n" % truth["n_samples"])
        f.write("SAMPLES_PER_BIT %.6f\n" % truth["samples_per_bit"])
        f.write("BIT_RATE_DUT %.1f\n" % truth["bit_rate_dut"])
        f.write("PPM %d\n" % truth["ppm"])
        f.write("CLK_RISING_AT_BIT %d\n" % truth["clk_rising_at_bit"])
        f.write("NSYM %d\n" % truth["n_sym"])
        f.write("LANES %s\n" % " ".join(LANE_ORDER))
        ls = truth["lane_syms"]
        for i in range(truth["n_sym"]):
            f.write("%d %03x %03x %03x\n" % (i, ls["D0"][i], ls["D1"][i], ls["D2"][i]))


# ---------------------------------------------------------------- 破坏档

CORRUPT_PROFILES = {
    "none": {},
    # 位序反（符号 MSB 先发）：控制符号会被读成另一个控制符号或非法值
    "msb-first": {"msb_first": True},
    # 数据 lane 相对 CLK 整体错位 1 位（最典型的"栅格对不上"）
    "shift-1bit": {"shift": {"D1": 1.0}},
    # 数据 lane 相对 CLK 错位半个位（栅格落在眼图上）
    "half-bit": {"shift": {"D0": 0.5, "D1": 0.5, "D2": 0.5}},
    # 某条 lane 的差分极性取反（P/N 对调；固件 pins_tmds==32 就有一处反相实验）
    "invert-D2": {"invert_lanes": ["D2"]},
    # 某条 lane 2% 采样级噪声
    "noise-D0": {"noise_frac": 0.02, "noise_lanes": ["D0"]},
    # 抽稀 8 倍 ⇒ 1 采样/位 ⇒ 低于"每 TMDS 位 2 采样"的硬门槛，解码器必须拒绝
    "subsample-8": {"subsample": 8},
    # CLK 上升沿落在符号中间（合法配置，用来正面测试"符号相位搜索"）
    "clk-phase-5": {"clk_phase": 5},
}


def apply_profile(args, name):
    prof = CORRUPT_PROFILES[name]
    args.corrupt_shift = dict(prof.get("shift", {}))
    args.corrupt_invert_lanes = list(prof.get("invert_lanes", []))
    args.corrupt_msb_first = bool(prof.get("msb_first", False))
    args.corrupt_noise_frac = float(prof.get("noise_frac", 0.0))
    args.corrupt_noise_lanes = list(prof.get("noise_lanes", []))
    args.corrupt_subsample = int(prof.get("subsample", 1))
    args.clk_phase = int(prof.get("clk_phase", args.clk_phase or 0))
    return args


# ---------------------------------------------------------------- 主流程

def generate(args, out_path, truth_path, corrupt_name):
    for p in (out_path, truth_path):
        d = os.path.dirname(os.path.abspath(p))
        if d and not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
    rng = random.Random(args.seed)
    dut_table = read_dut_table(args.repo_root) if args.payload == "dut-table" else []
    payload = Payload(args.payload, rng, dut_table)
    # 行数必须够盖住整个采样窗口：否则渲染时会把最后一个符号"夹住"重复，
    # 在窗口尾部造出一段假的长 DATA 游程（第一版踩过：真值是 4 个 640 的 DATA 段，
    # 解码器却报了一个 799 的长游程）。
    spb = ((float(args.dut_sm_clkdiv) / float(args.probe_clkdiv))
           / (1.0 + args.ppm * 1e-6))
    need_bits = int(args.words * 4 / spb) + 40
    need_lines = int(math.ceil(need_bits / float(10 * H_TOTAL))) + 1
    n_lines = max(args.lines, need_lines)
    if n_lines != args.lines:
        print("NOTE auto-extending symbol stream: --lines %d -> %d lines to cover"
              " %d samples" % (args.lines, n_lines, args.words * 4))
    lines = build_stream(n_lines, args.first_line, payload,
                         vsync_lines=args.vsync_lines, vblank_lines=args.vblank_lines)
    samples, truth = render(lines, args)
    nw = write_capture(out_path, samples, stall=args.stall, words=args.words)
    write_truth(truth_path, truth, corrupt_name)
    return nw, truth


def run_decoder(args, cap, expect=None, extra=None, log_path=None):
    """跑解码器。⚠️ 不用管道捕获输出：stdout/stderr 直接重定向到文件。"""
    cmd = [sys.executable, os.path.join(args.repo_root, "tools", "tmds_decode_oversampled.py"),
           cap,
           "--sys-clk", "%.6g" % args.sys_clk,
           "--probe-clkdiv", "%.6g" % args.probe_clkdiv,
           "--dut-sm-clkdiv", "%.6g" % args.dut_sm_clkdiv]
    if expect:
        cmd += ["--expect", expect, "--min-match", "%.4f" % args.min_match]
    if extra:
        cmd += extra
    fh = open(log_path, "w", encoding="utf-8") if log_path else None
    try:
        rc = subprocess.call(cmd, cwd=args.repo_root,
                             stdout=fh if fh else None, stderr=subprocess.STDOUT if fh else None)
    finally:
        if fh:
            fh.close()
    return rc


def read_verdict(log_path, key="VERDICT:"):
    try:
        with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
            txt = f.read()
    except OSError:
        return "?", ""
    val = "?"
    for line in txt.splitlines():
        if line.startswith(key):
            val = line.split(":", 1)[1].strip()
    return val, txt


SELFTEST_CASES = [
    # 名称, 生成档, 解码器额外参数, 期望判定（带真值比对）
    ("ok",                     "none",        None,                       "PASS"),
    ("ok-clk-phase-5",         "clk-phase-5", None,                       "PASS"),
    ("bad-msb-first",          "msb-first",   None,                       "FAIL"),
    ("bad-shift-1bit",         "shift-1bit",  None,                       "FAIL"),
    ("bad-half-bit",           "half-bit",    None,                       "FAIL"),
    ("bad-invert-D2",          "invert-D2",   None,                       "FAIL"),
    ("bad-noise-D0",           "noise-D0",    None,                       "FAIL"),
    ("bad-subsample-8",        "subsample-8", None,                       "REFUSE"),
    ("ok-but-wrong-probediv",  "none",        ["--probe-clkdiv", "2"],    "FAIL"),
    ("ok-but-decoder-msb",     "none",        ["--symbol-bitorder", "msb-first"], "FAIL"),
]


def selftest(args):
    work = os.path.join(args.repo_root, "build_test")
    os.makedirs(work, exist_ok=True)
    print("== SELFTEST: synth data -> decode -> verdict ==")
    print("sys_clk=%.6g probe_clkdiv=%.6g dut_sm_clkdiv=%.6g words=%d ppm=%d jitter=%.3f"
          % (args.sys_clk, args.probe_clkdiv, args.dut_sm_clkdiv, args.words, args.ppm,
             args.jitter))

    ok, msg = check_encoder_vs_dut_table(args.repo_root)
    print("ENCODER-VS-DUT-TABLE: %s  (%s)" % ("OK" if ok else "MISMATCH", msg))
    if not ok:
        print("SELFTEST: FAIL  (encoder does not match the DUT table; nothing below is meaningful)")
        return 1

    rows = []
    all_ok = True
    for name, prof, extra, want in SELFTEST_CASES:
        a = argparse.Namespace(**vars(args))
        apply_profile(a, prof)
        cap = os.path.join(work, "synth_%s.txt" % name)
        truth = os.path.join(work, "synth_%s_truth.txt" % name)
        nw, tr = generate(a, cap, truth, prof)

        # (1) 宽松判据：不给真值 —— 这正是"上届按控制符号命中率下结论"的做法
        loose_log = os.path.join(work, "log_%s_loose.txt" % name)
        rc_loose = run_decoder(a, cap, expect=None, extra=extra, log_path=loose_log)
        v_loose, txt_loose = read_verdict(loose_log)

        # (2) 严格判据：拿真值逐符号比对
        strict_log = os.path.join(work, "log_%s_strict.txt" % name)
        rc_strict = run_decoder(a, cap, expect=truth, extra=extra, log_path=strict_log)
        v_strict, txt_strict = read_verdict(strict_log)

        match = ""
        for line in txt_strict.splitlines():
            if line.startswith("MATCH-RATE:"):
                match = line.split(":", 1)[1].strip()

        okcase = (v_strict == want)
        all_ok = all_ok and okcase
        rows.append((name, prof, v_loose, v_strict, want, "OK" if okcase else "MISMATCH", match))
        print("CASE %-22s corrupt=%-12s loose=%-7s strict=%-7s want=%-7s %s  %s"
              % (name, prof, v_loose, v_strict, want, "OK" if okcase else "*** MISMATCH ***",
                 match))

    print("")
    print("-- summary (loose = no ground truth, only control-symbol/rate checks; strict = per-symbol compare vs truth) --")
    print("%-22s %-12s %-8s %-8s %-8s %s" % ("case", "corrupt", "loose", "strict", "want", "match"))
    for name, prof, vl, vs, want, res, match in rows:
        print("%-22s %-12s %-8s %-8s %-8s %s" % (name, prof, vl, vs, want, match))

    n_loose_fooled = sum(1 for r in rows if r[3] == "FAIL" and r[2] in ("INFO", "PASS"))
    print("")
    print("loose judge was fooled by corrupted data: %d / %d" % (n_loose_fooled, len(rows)))
    print("SELFTEST: %s" % ("PASS" if all_ok else "FAIL"))
    return 0 if all_ok else 1


def main():
    ap = argparse.ArgumentParser(
        description="合成过采样 TMDS 采样流（d 命令格式）+ 真值 + 破坏档，用于给解码器做自证。",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", help="输出的采样流文件（d 命令格式）")
    ap.add_argument("--truth", help="输出的真值文件（解码器 --expect 用）")
    ap.add_argument("--words", type=int, default=16384,
                    help="采样流字数（每字 4 个采样；探针 d 命令固定 16384）")
    ap.add_argument("--lines", type=int, default=4,
                    help="造多少行符号（每行 800 个符号）；不够盖住采样窗口时自动加长")
    ap.add_argument("--first-line", choices=["active", "vblank", "vsync"], default="active",
                    help="第一行是什么（真实捕获落在哪一段是随机的）")
    ap.add_argument("--vblank-lines", type=int, default=0, help="每周期里场消隐行数")
    ap.add_argument("--vsync-lines", type=int, default=2, help="每周期里场同步行数（VESA=2）")
    ap.add_argument("--payload", choices=["dut-table", "spec-random"], default="dut-table",
                    help="有效区数据符号来源：固件那张 64 项表 / 按规范编码器随机编")
    ap.add_argument("--sys-clk", type=float, default=252e6, help="DUT/探针标称系统时钟 Hz")
    ap.add_argument("--probe-clkdiv", type=float, default=1.0, help="探针 PIO 采样分频")
    ap.add_argument("--dut-sm-clkdiv", type=float, default=8.0, help="DUT 串行器 SM 分频")
    ap.add_argument("--ppm", type=int, default=900, help="DUT 相对探针板的频差 ppm（正=DUT 快）")
    ap.add_argument("--jitter", type=float, default=0.05, help="采样时刻抖动标准差（单位：采样）")
    ap.add_argument("--stall", type=int, default=0, help="写进 BEGIN 行的 stall 字段")
    ap.add_argument("--seed", type=int, default=20261004, help="随机种子")
    ap.add_argument("--corrupt", choices=sorted(CORRUPT_PROFILES.keys()), default="none",
                    help="破坏档（见 CORRUPT_PROFILES）")
    ap.add_argument("--check-dut-table", action="store_true",
                    help="只跑编码器与固件表的自检，然后退出")
    ap.add_argument("--selftest", action="store_true",
                    help="一条命令跑完：正常必须通过、破坏必须失败")
    ap.add_argument("--min-match", type=float, default=0.99,
                    help="严格判据要求的逐符号比对通过率（默认 0.99）")
    args = ap.parse_args()

    args.repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    args.corrupt_shift = {}
    args.corrupt_invert_lanes = []
    args.corrupt_msb_first = False
    args.corrupt_noise_frac = 0.0
    args.corrupt_noise_lanes = []
    args.corrupt_subsample = 1
    args.clk_phase = 0
    apply_profile(args, args.corrupt)

    if args.check_dut_table:
        ok, msg = check_encoder_vs_dut_table(args.repo_root)
        print("ENCODER-VS-DUT-TABLE: %s  (%s)" % ("OK" if ok else "MISMATCH", msg))
        return 0 if ok else 1

    if args.selftest:
        return selftest(args)

    if not args.out or not args.truth:
        ap.error("要么给 --selftest，要么同时给 --out 与 --truth")
    nw, truth = generate(args, args.out, args.truth, args.corrupt)
    print("CAPTURE %s  words=%d samples=%d" % (args.out, nw, truth["n_samples"]))
    print("TRUTH   %s  nsym=%d" % (args.truth, truth["n_sym"]))
    print("CORRUPT %s" % args.corrupt)
    print("SAMPLES_PER_BIT %.6f  (dut_sm_clkdiv/probe_clkdiv/(1+ppm))"
          % truth["samples_per_bit"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
