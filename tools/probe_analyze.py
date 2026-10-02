#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
probe_analyze.py —— 分析 RP2040 探针 dump 出来的原始采样

输入：probe_rp2040 的 'd' 命令输出（BEGIN / 若干行 8 位十六进制 / END）
      每个 32 位字 = 4 个采样（PIO 左移入 ISR：先采的在最高字节）

采样里 8 根线的位序（与待测板引脚一一对应）：
    bit0 = GPIO0 = D2P (红+)     bit1 = GPIO1 = D2N (红-)
    bit2 = GPIO2 = D1P (绿+)     bit3 = GPIO3 = D1N (绿-)
    bit4 = GPIO4 = D0P (蓝+,含同步) bit5 = GPIO5 = D0N (蓝-)
    bit6 = GPIO6 = CLKP          bit7 = GPIO7 = CLKN

用法：
    python tools\probe_analyze.py sampler_capture.txt
    python tools\probe_analyze.py sampler_capture.txt --bitrate 252000000

输出：
  ① 基本统计：采样点数、每个引脚的高电平占比
  ② 判据检查（对照 pin_toggle 的期望图案：GPIO2/4/6 恒 1、GPIO1/3/5/7 恒 0）
  ③ 时钟恢复：从 CLK 差分找边沿 ⇒ 估算采样率与位率之比
  ④ 若位率可知 ⇒ 尝试按位抽取，做 TMDS 控制符号/数据符号统计

⚠️ 输出只用 ASCII：本机控制台是 GBK，打印中文或特殊符号会 UnicodeEncodeError。
"""
import sys
import collections

PIN_NAMES = ["D2P", "D2N", "D1P", "D1N", "D0P", "D0N", "CLKP", "CLKN"]

# TMDS 的 4 个控制符号（10 位）⇒ 分别对应 (HSYNC, VSYNC)
TMDS_CTRL = {
    0b1101010100: "CTL0 hsync=0 vsync=0",
    0b0010101011: "CTL1 hsync=0 vsync=1",
    0b0101010100: "CTL2 hsync=1 vsync=0",
    0b1010101011: "CTL3 hsync=1 vsync=1",
}


def load_words(path):
    words = []
    for line in open(path, "r", encoding="utf-8", errors="replace"):
        s = line.strip()
        if len(s) == 8 and all(c in "0123456789abcdefABCDEF" for c in s):
            words.append(int(s, 16))
    return words


def words_to_bits(words):
    """返回 8 个 bit 列表（每个长度 = 采样点数），顺序同 PIN_NAMES"""
    bits = [[] for _ in range(8)]
    for w in words:
        for shift in (24, 16, 8, 0):
            b = (w >> shift) & 0xFF
            for i in range(8):
                bits[i].append((b >> i) & 1)
    return bits


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    path = sys.argv[1]
    clk_hz = None
    if "--bitrate" in sys.argv:
        clk_hz = int(sys.argv[sys.argv.index("--bitrate") + 1])

    words = load_words(path)
    if not words:
        print("[!] no data words found in %s" % path)
        return 1
    bits = words_to_bits(words)
    n = len(bits[0])
    print("== basic ==")
    print("  words      : %d" % len(words))
    print("  samples    : %d" % n)

    print("\n== per-pin high ratio ==")
    ratios = []
    for i, name in enumerate(PIN_NAMES):
        ones = sum(bits[i])
        r = 100.0 * ones / n
        ratios.append(r)
        print("  %-5s (GPIO%d) : %6.2f%%  (%d/%d)" % (name, i, r, ones, n))

    # ---- 判据检查（pin_toggle 期望：GPIO2/4/6 恒 1，GPIO1/3/5/7 恒 0）----
    print("\n== pin_toggle criteria (expect GPIO2/4/6 ~100%%, GPIO1/3/5/7 ~0%%) ==")
    ok = True
    for i, want_high in ((2, True), (4, True), (6, True), (1, False), (3, False), (5, False), (7, False)):
        good = (ratios[i] > 99.0) if want_high else (ratios[i] < 1.0)
        flag = "OK " if good else "BAD"
        if not good:
            ok = False
        print("  [%s] GPIO%d expected %s, got %6.2f%%" %
              (flag, i, "HIGH" if want_high else "LOW", ratios[i]))
    print("  => %s" % ("PATH OK (sampling + wiring verified)" if ok else "PATH PROBLEM"))

    # ---- 时钟恢复 ----
    clkp, clkn = bits[6], bits[7]
    diff = [clkp[i] ^ clkn[i] for i in range(n)]
    edges = [i for i in range(1, n) if diff[i] != diff[i - 1]]
    print("\n== clock ==")
    print("  CLK differential edges : %d" % len(edges))
    if len(edges) > 8:
        gaps = [edges[i] - edges[i - 1] for i in range(1, len(edges))]
        gaps.sort()
        med = gaps[len(gaps) // 2]
        print("  edge gap: min=%d median=%d max=%d (samples)" % (gaps[0], med, gaps[-1]))
        if clk_hz:
            # 每个 bit 是半个 CLK 周期（DDR 时钟）⇒ 位周期 ≈ 2*med 个采样
            sample_hz = clk_hz
            bit_hz = sample_hz / (2.0 * med) if med else 0
            print("  estimated bit rate : %.1f Mbit/s  (target 252.0)" % (bit_hz / 1e6))
            print("  => ratio sample/bit : %.3f" % (sample_hz / bit_hz if bit_hz else 0))
    else:
        print("  (no toggling clock -- static signal, expected for pin_toggle)")

    # ---- 若能看到时钟，尝试抽符号 ----
    if len(edges) > 200 and clk_hz:
        gaps = sorted(edges[i] - edges[i - 1] for i in range(1, len(edges)))
        med = gaps[len(gaps) // 2]
        step = max(1, int(round(med)))          # 半个 CLK 周期 = 1 个 bit
        # 以第一个边沿为起点，按 step 抽采样点
        start = edges[0]
        sym_bits = {0: [], 1: [], 2: []}        # lane0=D0(蓝), lane1=D1(绿), lane2=D2(红)
        lane_pin = {0: 4, 1: 2, 2: 0}
        idx = start
        cur = {0: [], 1: [], 2: []}
        while idx < n:
            for lane in (0, 1, 2):
                cur[lane].append(bits[lane_pin[lane]][idx])
            if len(cur[0]) == 10:
                for lane in (0, 1, 2):
                    sym_bits[lane].append(cur[lane])
                    cur[lane] = []
            idx += step
        print("\n== TMDS symbols (tentative) ==")
        for lane in (0, 1, 2):
            vals = collections.Counter(tuple(v) for v in sym_bits[lane])
            ctrl = 0
            for v, cnt in vals.items():
                num = 0
                for b in v:
                    num = (num << 1) | b
                if num in TMDS_CTRL:
                    ctrl += cnt
            print("  lane%d: %d symbols, %d control, top: %s" %
                  (lane, len(sym_bits[lane]), ctrl,
                   [( ''.join(map(str, v)), c) for v, c in vals.most_common(2)]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
