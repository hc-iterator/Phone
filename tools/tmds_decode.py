#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TMDS 采样解码器 —— 把采样探针抓到的原始数据变成【能判断的事实】

为什么需要它：本项目在软件层已证明"编码数据正确"，但电脑显示器【不认】我们的信号。
=> 唯一没测过的就是【引脚上的真实电波形】。这个脚本把探针抓到的东西解出来。

输入格式（探针 'd' 命令的输出）：
    BEGIN <buf_words> <wraps>
    00080afd          <- 每行一个 32 位十六进制字
    ...
    END

采样怎么变成 8 根线的电平：
    PIO 的 in pins,8 是【左移】入 ISR（先采的在高位），每 4 个采样推出 1 个字
    => 字 bits 31..24 = 第 1 个采样，23..16 = 第 2 个，15..8 = 第 3 个，7..0 = 第 4 个
    => 每个采样字节里：bit0=GPIO_BASE+0 ... bit7=GPIO_BASE+7
       基址 32 时：bit0=32(D2P) bit1=33(D2N) bit2=34(D1P) bit3=35(D1N)
                   bit4=36(D0P) bit5=37(D0N) bit6=38(CLKP) bit7=39(CLKN)

⚠️ 采样率 ≈ 位率（都是 252MHz 左右）⇒ 平均只有约 1 采样/位，
   所以【不能】简单按位切。正确做法是利用两块板晶振的微小频差：
   采到的 CLK 会呈现"拍频"图案 ⇒ 从拍频周期反推 DUT 的真实位率，
   并用等效时间采样重建更高分辨率的波形。本脚本先把拍频量出来。
"""
import sys, re, statistics

# ---------------------------------------------------------------- TMDS 常量
# 4 个控制符号（10 位）：CTL0..CTL3
TMDS_CTRL = {
    0b1101010100: "CTL0(HSYNC=0,VSYNC=0)",
    0b0010101011: "CTL1(HSYNC=0,VSYNC=1)",
    0b0101010100: "CTL2(HSYNC=1,VSYNC=0)",
    0b1010101011: "CTL3(HSYNC=1,VSYNC=1)",
}

def parse_hexdump(path):
    words, n, wraps = [], None, None
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            m = re.match(r"^BEGIN\s+(\d+)\s+(\d+)$", line)
            if m:
                n, wraps = int(m.group(1)), int(m.group(2)); continue
            if line in ("END", "") or line.startswith("#"):
                continue
            if re.match(r"^[0-9a-fA-F]{8}$", line):
                words.append(int(line, 16))
    return words, n, wraps

def words_to_samples(words):
    """每个字按【高字节在前】拆成 4 个采样字节"""
    out = bytearray()
    for w in words:
        out.append((w >> 24) & 0xFF)
        out.append((w >> 16) & 0xFF)
        out.append((w >>  8) & 0xFF)
        out.append( w        & 0xFF)
    return out

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        print("用法: python tmds_decode.py <hexdump.txt>")
        return 1
    words, n, wraps = parse_hexdump(sys.argv[1])
    print(f"读入 {len(words)} 个字（声明 {n}），wraps={wraps}")
    if not words:
        print("没有数据。先让探针 dump（命令 d），把输出存成文件。")
        return 1

    samples = words_to_samples(words)
    print(f"得到 {len(samples)} 个采样点（每点 8 根线的瞬时电平）")

    # 拆 8 根线。基址 32 的顺序：0=D2P 1=D2N 2=D1P 3=D1N 4=D0P 5=D0N 6=CLKP 7=CLKN
    clkp = [(b >> 6) & 1 for b in samples]
    clkn = [(b >> 7) & 1 for b in samples]

    # 差分时钟：过渡次数反映位率。先看基本统计
    trans_p = sum(1 for i in range(1, len(clkp)) if clkp[i] != clkp[i-1])
    trans_n = sum(1 for i in range(1, len(clkn)) if clkn[i] != clkn[i-1])
    diff    = [clkp[i] ^ clkn[i] for i in range(len(samples))]
    trans_d = sum(1 for i in range(1, len(diff)) if diff[i] != diff[i-1])
    print(f"\n=== 时钟线统计 ===")
    print(f"  CLKP 跳变 {trans_p} 次，CLKN 跳变 {trans_n} 次，差分(异或)跳变 {trans_d} 次")
    print(f"  样本数 {len(samples)} ⇒ 平均每 {len(samples)/max(trans_d,1):.2f} 个采样一次跳变")

    # 拍频估计：统计"两次跳变之间间隔"的分布
    gaps = [i for i in range(1, len(diff)) if diff[i] != diff[i-1]]
    if len(gaps) > 3:
        d = [gaps[i]-gaps[i-1] for i in range(1, len(gaps))]
        d = [x for x in d if x > 0]
        print(f"  跳变间隔：最小 {min(d)}，中位 {statistics.median(d):.0f}，最大 {max(d)}")
        print(f"  ⇒ 若中位≈1，说明采样率≈位率（1 采样/位）；拍频体现在间隔的【分布】上")
    print(f"\n  前 64 个采样（看有没有规律）：")
    bits = "".join(str(b) for b in diff[:64])
    print(f"    差分时钟: {bits}")
    for name, idx in (("D2P", 0), ("D1P", 2), ("D0P", 4)):
        bb = "".join(str((s >> idx) & 1) for s in samples[:64])
        print(f"    {name}    : {bb}")
    print("\n（下一步：用拍频反推位率并重建波形——需要真实数据才能定噪声水平）")
    return 0

if __name__ == "__main__":
    sys.exit(main())
