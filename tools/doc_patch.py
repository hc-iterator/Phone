#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doc_patch.py —— 往文档里【安全地】插入/替换多行文本块（本项目专用小工具）

为什么有它（2026-10-05）：
  主 AI 反复"现场手写 Python 脚本"去改中文文档，于是**同样的错反复犯** ✗：
    · 脚本里 print("✓") 在 GBK 控制台崩，而且**崩在写文件之后** ⇒ "改了一半" / "以为改了" ✗
    · Python 源码嵌在 PowerShell 字符串里 ⇒ 反引号被吃、双引号嵌套 SyntaxError ✗
    · 锚点找不到时**静默什么都没干** ⇒ 提交信息却声称改了 ✗（记录不实）
  ⇒ 按项目规矩"别每次造轮子" ✗ ⇒ 收敛成这**一个**工具，并带自测。

用法（**payload 永远从文件读**，别从命令行传长中文 ✓）：
  python tools/doc_patch.py <目标文件> after-line   <锚点> <payload文件>
  python tools/doc_patch.py <目标文件> before-line  <锚点> <payload文件>
  python tools/doc_patch.py <目标文件> replace-line <锚点> <payload文件>
  python tools/doc_patch.py <目标文件> append       -      <payload文件>
  python tools/doc_patch.py --selftest

约定：
  · 锚点 = **行内子串**（不含换行）✓；命中**第一行** ✓
  · 幂等：payload 的**第一行**若已出现在目标文件里 ⇒ 打印 SKIP 并以 0 退出 ✓
  · 找不到锚点 ⇒ 打印 MISS 并以 **2** 退出 ✓（绝不静默 ✓）
  · 输出**纯 ASCII** ✓（GBK 控制台安全 ✓）；中文只进文件、不进 stdout ✓
"""
import io
import os
import sys
import tempfile

EXIT_OK = 0
EXIT_MISS = 2
EXIT_USAGE = 3


def read_text(path):
    with io.open(path, encoding="utf-8") as f:
        return f.read()


def write_text(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def apply_patch(target, mode, anchor, payload):
    text = read_text(target)
    first_payload_line = payload.strip().split("\n")[0].strip()
    if first_payload_line and first_payload_line in text:
        print("SKIP already-present")
        return EXIT_OK

    lines = text.split("\n")
    pay_lines = payload.rstrip("\n").split("\n")

    if mode == "append":
        out = "\n".join(lines).rstrip("\n") + "\n\n" + "\n".join(pay_lines) + "\n"
        write_text(target, out)
        print("OK append")
        return EXIT_OK

    idx = None
    for i, line in enumerate(lines):
        if anchor in line:
            idx = i
            break
    if idx is None:
        print("MISS anchor")
        return EXIT_MISS

    if mode == "after-line":
        new_lines = lines[:idx + 1] + [""] + pay_lines + lines[idx + 1:]
    elif mode == "before-line":
        new_lines = lines[:idx] + pay_lines + [""] + lines[idx:]
    elif mode == "replace-line":
        new_lines = lines[:idx] + pay_lines + lines[idx + 1:]
    else:
        print("BAD mode: %s" % mode)
        return EXIT_USAGE

    write_text(target, "\n".join(new_lines))
    print("OK %s at line %d" % (mode, idx + 1))
    return EXIT_OK


def selftest():
    ok = True
    tmp = tempfile.mkdtemp(prefix="docpatch_")
    cases = [
        ("after-line", "ANCHOR-1", ["base\nANCHOR-1\ntail\n"], "base\nANCHOR-1\n\nNEW-A\ntail\n"),
        ("before-line", "ANCHOR-1", ["base\nANCHOR-1\ntail\n"], "base\nNEW-B\n\nANCHOR-1\ntail\n"),
        ("replace-line", "ANCHOR-1", ["base\nANCHOR-1\ntail\n"], "base\nNEW-C\ntail\n"),
        ("append", "x", ["base\n"], "base\n\nNEW-D\n"),
    ]
    for mode, anchor, initial, expected in cases:
        p = os.path.join(tmp, mode + ".md")
        write_text(p, initial[0])
        payload = {"after-line": "NEW-A", "before-line": "NEW-B",
                   "replace-line": "NEW-C", "append": "NEW-D"}[mode]
        rc = apply_patch(p, mode, anchor, payload + "\n")
        got = read_text(p)
        good = (rc == EXIT_OK and got == expected)
        print("selftest %-13s %s" % (mode, "PASS" if good else "FAIL"))
        if not good:
            ok = False
            print("  expected=[%s]" % expected.replace("\n", "\\n"))
            print("  got     =[%s]" % got.replace("\n", "\\n"))
    # MISS 与 SKIP 两条路径
    p = os.path.join(tmp, "miss.md")
    write_text(p, "nothing here\n")
    rc = apply_patch(p, "after-line", "NOPE", "X\n")
    print("selftest miss-anchor   %s" % ("PASS" if rc == EXIT_MISS else "FAIL"))
    ok = ok and (rc == EXIT_MISS)
    p2 = os.path.join(tmp, "skip.md")
    write_text(p2, "has NEW-Z already\nlast\n")
    rc = apply_patch(p2, "append", "-", "NEW-Z\n")
    print("selftest skip-idem    %s" % ("PASS" if rc == EXIT_OK and read_text(p2) == "has NEW-Z already\nlast\n" else "FAIL"))
    ok = ok and (rc == EXIT_OK and read_text(p2) == "has NEW-Z already\nlast\n")
    print("SELFTEST %s" % ("ALL PASS" if ok else "FAILED"))
    return EXIT_OK if ok else 1


def main(argv):
    if len(argv) >= 2 and argv[1] == "--selftest":
        return selftest()
    if len(argv) != 5:
        print(__doc__)
        return EXIT_USAGE
    target, mode, anchor, payload_file = argv[1], argv[2], argv[3], argv[4]
    if not os.path.isfile(target):
        print("MISS target file")
        return EXIT_MISS
    if not os.path.isfile(payload_file):
        print("MISS payload file")
        return EXIT_MISS
    payload = read_text(payload_file)
    return apply_patch(target, mode, anchor, payload)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
