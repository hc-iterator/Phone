#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""backdoor_filter 的【算法镜像】自测。

⚠️ 这是把 src/backdoor.c 的状态机逐行照抄到 Python 的自测，
   **不等于固件实测**（固件要真刷上去才知道）。用途只是：
   在没有宿主机 C 编译器的情况下，先把"字节账"算对 ——
   尤其是"单字节 ESC 必须原样转发"和"分片边界"这两处容易错的地方。
"""
ESC = 0x1B


class Filter:
    def __init__(self):
        self.pending_esc = False
        self.expect_cmd = False
        self.notes = []

    def handle_cmd(self, b):
        c = chr(b)
        if c in "Bb":
            self.notes.append("CMD:BOOTSEL")
            return True
        if c in "Rr":
            self.notes.append("CMD:REBOOT")
            return True
        if c == "?":
            self.notes.append("CMD:HELP")
            return True
        self.notes.append("CMD:UNKNOWN(esc dropped, byte forwarded)")
        return False

    def filt(self, buf):
        out = bytearray()
        for b in buf:
            if self.expect_cmd:
                self.expect_cmd = False
                if self.handle_cmd(b):
                    continue
            if self.pending_esc:
                self.pending_esc = False
                if b == ESC:
                    self.expect_cmd = True
                    continue
                out.append(ESC)
                out.append(b)
                continue
            if b == ESC:
                self.pending_esc = True
                continue
            out.append(b)
        return bytes(out)


def show(name, chunks, expect):
    f = Filter()
    got = b""
    for c in chunks:
        got += f.filt(c)
    ok = (got == expect)
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
    print(f"      输入分片 {[c.hex() for c in chunks]}")
    print(f"      转发得到 {got.hex()}   （期望 {expect.hex()}）")
    if f.notes:
        print(f"      命令记录 {f.notes}")
    return ok


allok = True
# 1) 普通数据原样通过
allok &= show("普通数据", [b"hello"], b"hello")
# 2) 单个 ESC 必须原样转发（不能被吃掉）
allok &= show("单字节 ESC 转发", [b"A" + bytes([ESC]) + b"B"], b"A" + bytes([ESC]) + b"B")
# 3) ESC ESC 命令被吃掉（'?' 会回帮助，但不转发给目标板）
allok &= show("ESC ESC ?", [bytes([ESC, ESC]) + b"?"], b"")
# 4) 分片边界：ESC 在上一片末尾，命令在下一片开头
allok &= show("跨分片 ESC ESC", [bytes([ESC]), bytes([ESC, ord('?')])], b"")
# 5) 跨分片但凑不成命令：两个 ESC 被丢弃，后续字节照常转发
allok &= show("跨分片非命令", [b"X" + bytes([ESC]), bytes([ESC]) + b"Y"], b"XY")
# 6) 命令后紧跟普通数据
allok &= show("命令后接数据", [bytes([ESC, ESC]) + b"?" + b"data"], b"data")
# 7) 冒牌序列：ESC ESC 后接未知字节 => 只丢那两个 ESC，该字节【照常转发】（并回警告）
allok &= show("ESC ESC + 未知字节", [bytes([ESC, ESC]) + b"Q" + b"Z"], b"QZ")

print("\n===== 算法镜像自测:", "全部通过" if allok else "有失败", "=====")
