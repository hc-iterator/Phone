#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文档改名/换术语的【验收判据】（主 AI 审子智能体 diff 用）。

背景：用户拍板把"本子"体系正式化为"文档"（措辞 + 文件名都换）。
子智能体在隔离副本里执行；主 AI 用本脚本在**改名前**留基线、**改名后**验收。

四类判据：
  ① 旧文件名残留：老的 `陷阱本.md` 等名字还出现在哪儿（带行号）——
     ⚠️ 允许出现在**加日期注/历史归档**里（项目规矩：被推翻的说法只划掉加注，不删），
        所以这里只**报告**，由人判断，不自动判失败。
  ② 术语残留：`本子` 出现次数（按文件），改后应大幅下降。
  ③ **断链检查**：文档里出现的 `xxx.md` 路径引用，目标文件是否存在（这是硬判据）。
  ④ 计数纪律：`陷阱本.md` 与 `开工前自检.md` 里那套 "N / N / N = N" 是否一致。

用法：
  python tools/check_docs_refs.py [仓库根]
不传参数则用脚本所在仓库的上一级（即 DeepSeekCode 根）。
"""
import os
import re
import sys
from collections import Counter, defaultdict

# ⚠️ 2026-10-04：本机控制台是 GBK，文档里有 ✅/⚠️ 这类字符 ⇒ 直接 print 会
#   UnicodeEncodeError 崩掉（同 `tmds_decode.py` 当年那个坑）。
#   强制 UTF-8 + errors=replace，保证脚本在任何代码页下都能跑完。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

OLD_NAMES = [
    "陷阱本.md", "需求本.md", "小本本.md", "小本本-附录B-DVI攻坚流水.md",
    "指令本.md", "历史本.md", "模型本.md", "引路本.md", "资源表.md",
    "开工前自检.md", "文档与代码规范.md", "本子使用指南.md", "重要：读完就删.md",
]
# ★ 2026-10-04 修正（由 %TEMP% 里的改名演习抓出）：
#   有 3 个文件是【名字不变、只搬进 docs/】：资源表 / 开工前自检 / 文档与代码规范。
#   它们改后仍会以 `docs/资源表.md` 这种形式出现在正文里 ⇒ 用"裸子串匹配"会把
#   **正确的新引用**误判成"旧名残留" ✗（演习里误报 18 处 + 26 处）。
#   ⇒ 判据改成：只把【前面没有 docs/ 或 docs\ 前缀】的裸名字算残留。
KEEP_NAME = {"资源表.md", "开工前自检.md", "文档与代码规范.md"}
def _residual_patterns(name):
    """返回用于判'旧名残留'的正则；对不改名的三个文件要求前面没有 docs/ 前缀。"""
    if name in KEEP_NAME:
        return [re.compile(r"(?<!docs/)(?<!docs\\)" + re.escape(name))]
    return [re.compile(re.escape(name))]
# 新名字（改后应出现）
NEW_NAMES = [
    "docs/陷阱.md", "docs/需求.md", "docs/实测数据.md", "docs/DVI攻坚流水.md",
    "docs/工作守则.md", "docs/历史.md", "docs/模型选择.md", "docs/导引.md",
    "docs/资源表.md", "docs/开工前自检.md", "docs/文档与代码规范.md",
]

here = os.path.dirname(os.path.abspath(__file__))
root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(here)
print("检查根目录:", root)

md_files = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames
                   if d not in ("build", ".git", "_agents", "third_party", "libs", "node_modules")]
    for fn in filenames:
        if fn.endswith(".md"):
            md_files.append(os.path.join(dirpath, fn))
md_files.sort()
print(f"扫描 {len(md_files)} 个 .md\n")

rel = lambda p: os.path.relpath(p, root).replace("\\", "/")

# ---------- ① 旧名残留 ----------
print("=" * 70)
print("① 旧文件名残留（只报告；加日期注/历史归档里出现是允许的）")
print("=" * 70)
hits_old = defaultdict(list)
for f in md_files:
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh, 1):
                for n in OLD_NAMES:
                    if any(p.search(line) for p in _residual_patterns(n)):
                        hits_old[n].append((rel(f), i, line.strip()[:110]))
    except OSError:
        pass
if not hits_old:
    print("  （无残留）")
else:
    for n in OLD_NAMES:
        if n in hits_old:
            print(f"  {n}: {len(hits_old[n])} 处")
            for r, i, l in hits_old[n][:6]:
                print(f"      {r}:{i}: {l}")
            if len(hits_old[n]) > 6:
                print(f"      … 还有 {len(hits_old[n]) - 6} 处")

# ---------- ② 术语残留 ----------
print()
print("=" * 70)
print('② 术语 "本子" 残留（按文件计数）')
print("=" * 70)
tot = 0
per = Counter()
for f in md_files:
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            c = fh.read().count("本子")
    except OSError:
        continue
    if c:
        per[rel(f)] = c
        tot += c
for r, c in per.most_common():
    print(f"  {r}: {c}")
print(f"  合计 = {tot}")

# ---------- ③ 断链检查 ----------
print()
print("=" * 70)
print("③ 断链检查（硬判据）：文档里引用的 .md 路径是否存在")
print("=" * 70)
REF = re.compile(r"[A-Za-z0-9_\-./\u4e00-\u9fff：]+\.md")
SELF = {"README.md"}
broken = []
named = 0
for f in md_files:
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        continue
    for i, line in enumerate(lines, 1):
        for m in REF.finditer(line):
            t = m.group(0)
            # 只查"像路径"的：含 / 或属于本项目的已知文档名
            looks_like_path = ("/" in t) or any(t.endswith(n) for n in
                                               [os.path.basename(x) for x in OLD_NAMES + NEW_NAMES])
            if not looks_like_path:
                continue
            named += 1
            cand = [os.path.join(root, t),
                    os.path.join(os.path.dirname(f), t),
                    os.path.join(root, "docs", os.path.basename(t))]
            if not any(os.path.exists(c) for c in cand):
                broken.append((rel(f), i, t))
print(f"  共检查 {named} 个 .md 引用；断链 {len(broken)} 个")
for r, i, t in broken[:25]:
    print(f"      {r}:{i} -> {t}")
if len(broken) > 25:
    print(f"      … 还有 {len(broken) - 25} 个")

# ---------- ④ 计数纪律 ----------
print()
print("=" * 70)
print("④ 计数纪律：'14 / 6 / 26 = 46' 这类说法在各文件里是否一致")
print("   ⚠️ 放宽理解：**记录历史基线的行**（例如'当前状态'里写'改名前基线 14/6/26=46'）")
print("      是**有意保留的旧值**，不算冲突；只要求'现行的那个计数'在两处同步。")
print("=" * 70)
CNT = re.compile(r"(\d+)\s*/\s*(\d+)\s*/\s*(\d+)\s*=\s*(\d+)")
found = defaultdict(list)
for f in md_files:
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh, 1):
                for m in CNT.finditer(line):
                    found[m.group(0).replace(" ", "")].append(f"{rel(f)}:{i}")
    except OSError:
        pass
for k, v in found.items():
    print(f"  {k}  -> {len(v)} 处: {', '.join(v[:6])}")
if len(found) > 1:
    print("  ⚠️ 出现了多种计数写法 ⇒ 需要人工核对是否同步（改条目就要两处一起改）")

# ---------- ⑤ 非 .md 文件里的旧名引用 ----------
# 2026-10-04 补：本脚本原先只扫 *.md ✗，而脚本/模板/构建文件里也会引用本子名
#（例：tools/AGENT_SPACE_RULES.template.md、tools/build_sub.ps1 的注释）。
# 改名时这些地方**必须一起改**，否则以后新建隔离空间会指向不存在的文件。
# 按用户要求：**扩展现有脚本**，不另写一份。
print()
print("=" * 70)
print("⑤ 非 .md 文本文件里的旧名引用（改名时必须一起改）")
print("=" * 70)
TEXT_EXT = {".ps1", ".cmd", ".bat", ".py", ".c", ".h", ".cpp", ".hpp", ".txt",
            ".cmake", ".json", ".yml", ".yaml", ".sh", ".pio", ".cfg", ".md",
            ".gitignore", ".template", ""}
SKIP_DIRS = {"build", ".git", "_agents", "third_party", "libs", "node_modules",
             "debug_logs", ".vscode", "freertos", "CMSIS_DAP"}
# ★ 本脚本自己【故意】列出全部旧名（那是它的对照表）⇒ 别把自己算成"待改引用" ✗
SELF_NAME = "tools/check_docs_refs.py"
hits_nonmd = defaultdict(list)
scanned = 0
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
    for fn in filenames:
        p = os.path.join(dirpath, fn)
        ext = os.path.splitext(fn)[1].lower()
        if ext == ".md" or (ext not in TEXT_EXT and fn not in ("CMakeLists.txt", ".gitignore", "get-version.sh")):
            continue
        if rel(p) == SELF_NAME:
            continue
        try:
            if os.path.getsize(p) > 2_000_000:
                continue
            with open(p, encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh, 1):
                    for n in OLD_NAMES:
                        if any(pt.search(line) for pt in _residual_patterns(n)):
                            hits_nonmd[rel(p)].append((i, n, line.strip()[:100]))
            scanned += 1
        except OSError:
            pass
print(f"  扫描 {scanned} 个非 .md 文本文件")
if not hits_nonmd:
    print("  （无引用）")
else:
    tot2 = sum(len(v) for v in hits_nonmd.values())
    print(f"  共 {tot2} 处，分布在 {len(hits_nonmd)} 个文件：")
    for f in sorted(hits_nonmd, key=lambda k: -len(hits_nonmd[k])):
        print(f"    {f}: {len(hits_nonmd[f])} 处")
        for i, n, l in hits_nonmd[f][:3]:
            print(f"        :{i} [{n}] {l}")

print("\n完成。")
