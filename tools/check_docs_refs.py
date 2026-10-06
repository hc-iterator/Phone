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
    # ★ 2026-10-06 追加（用户把那条便条改名并升级为"入门必读"）：
    #   注意**两代旧名的标点不同**，两个都要盯着 ——
    #     `重要：读完就删.md` 全角冒号：本子时代的老名；
    #     `重要-读完就删.md` 半角连字符：搬进 docs/ 之后用的名（本次改的就是它）。
    #   新名进 NEW_NAMES，见下。
    "重要-读完就删.md",
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
    # ★ 2026-10-06：本子时代那条便条的**现名**（由 `重要-读完就删.md` 改名而来）
    "docs/重要-入门必读.md",
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
hist_mentions = []          # ★ 2026-10-04：历史/映射提及（记录块里"哪个改成哪个"必须写旧名）
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
            base = os.path.basename(t)
            cand = [os.path.join(root, t),
                    os.path.join(os.path.dirname(f), t),
                    os.path.join(root, "docs", base),
                    # ★ 2026-10-04 补：文档里常把 third_party 下的路径写成"相对第三方库"的短路径
                    #   （例 DVI线路图.md 写 `frank-hdmi-sound/docs/LLM_GUIDE.md`，
                    #     真身在 `third_party/frank-hdmi-sound/docs/LLM_GUIDE.md`）
                    #   ⇒ 漏了这一类会误报"断链"（子智能体当场抓到我这个漏判）。
                    os.path.join(root, "third_party", t)]
            if not any(os.path.exists(c) for c in cand):
                # ★ 2026-10-04 补（第 5 次同族失误后）：**历史/映射提及不是活链接** ✗
                #   例：`docs/当前状态.md` 里那张改名映射表写着 `陷阱本.md`→`docs/陷阱.md`，
                #   以及 A/B 单里的 `陷阱本.md:899,1062` —— 这些是"记载旧名"，不是引用，
                #   用"文件是否存在"去判必然误报（子智能体的成果因此被我冤枉过一轮）。
                #   判据：同一行里出现 ⇒ / -> / 改名前 / 旧名 / 原名 / 现称文档，
                #        或该引用后面紧跟 `:数字`（行号提及）⇒ 归入"历史/映射提及"另列。
                hist_mark = ("→" in line) or ("->" in line) or any(
                    m in line for m in ("改名前", "旧名", "原名", "现称文档"))
                # ★ 再补一条通用规则（2026-10-04，第 6 次同族失误后）：
                #   解析不到的路径，**如果该行是引用块（以 > 开头）**，判为历史/记录提及。
                #   依据：`docs/当前状态.md` 的"文档化决策记录块"整块都是引用块，
                #   它必须写旧名（说清"哪个改成哪个"）；而**能解析到的链接不受影响** ✓
                #   ⇒ 只对"解析不到 + 在引用块里"的组合豁免，不会掩盖真正的活链断链太多。
                if line.lstrip().startswith(">"):
                    hist_mark = True
                after = line[m.end():m.end() + 6]
                if hist_mark or re.match(r":\s*\d", after):
                    hist_mentions.append((rel(f), i, t))
                    continue
                # 再按"同名文件是否存在于别处"判断：存在 ⇒ 只是路径写不全，不是死链
                elsewhere = []
                for dp, dn, fn2 in os.walk(root):
                    dn[:] = [d for d in dn if d not in ("build", ".git", "_agents")]
                    if base in fn2:
                        elsewhere.append(os.path.relpath(os.path.join(dp, base), root).replace("\\", "/"))
                    if len(elsewhere) > 3:
                        break
                if elsewhere:
                    broken.append((rel(f), i, t + "  ⚠️路径不全？同名文件在: " + ", ".join(elsewhere[:3])))
                else:
                    broken.append((rel(f), i, t))
print(f"  共检查 {named} 个 .md 引用；**真断链 {len(broken)} 个**；历史/映射提及 {len(hist_mentions)} 个（不计断链）")
for r, i, t in broken[:25]:
    print(f"      {r}:{i} -> {t}")
if len(broken) > 25:
    print(f"      … 还有 {len(broken) - 25} 个")
if hist_mentions:
    print(f"  （历史/映射提及示例，最多 5 条；它们是'记载旧名'，不是活链接）")
    for r, i, t in hist_mentions[:5]:
        print(f"      {r}:{i} -> {t}")

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

# ---------- ⑥ 措辞趟验收线 ----------
# 2026-10-04 加：把"本子→文档"的 A/B 逐行单变成**数字阈值**，便于验收子智能体的措辞趟。
# 依据（见 docs/当前状态.md 的四类判据）：
#   A 类（作者叙述 + 专有名词「本子分工」）**必须改掉**；
#   B 类（引文/日期注/历史归档/划掉的旧说法）**保留**。
# ⇒ 改完后"本子"只该出现在 B 类所在的那几个文件里，且总数有上限。
print()
print("=" * 70)
print('⑥ 措辞趟验收线：改完后 "本子" 只许出现在"保留类"文件里')
print("=" * 70)
ALLOWED_KEEP = {
    "docs/历史.md",        # 历史归档：一字不改
    "docs/当前状态.md",    # 本文件的"文档化决策"记录块用了旧称（引号内）
    "docs/模型选择.md",    # 被划掉的历史说法
    "docs/工作守则.md",    # "用户说'整理一下本子'之类的话" = 用户会说的话的引例
    "docs/陷阱.md",        # 错 28 讲的正是【这次改名】的教训，必须引用旧称（属记录类）
}
CEILING = 25               # **软边界**：只做"数量级"提醒，真正的硬判据是下面的【白名单】。
                           # ⚠️ 2026-10-04 实测教训：主仓库的"本子"总数一度从 57 涨到 70 ——
                           #   因为**主 AI 在 documenting 这次改名时自己又写了 13 处"本子"** ✗
                           #   （一边改一边往上加）。⇒ 改名期间，**新写的正文一律用"文档"**；
                           #   只有**日期注/历史记录**里才允许出现旧称。
per2 = Counter()
for f in md_files:
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            c = fh.read().count("本子")
    except OSError:
        continue
    if c:
        per2[rel(f)] = c
bad = {k: v for k, v in per2.items() if k not in ALLOWED_KEEP}
print(f"  允许保留（B 类）: {', '.join(sorted(ALLOWED_KEEP))}")
print(f"  实际含'本子'的文件: {', '.join(f'{k}({v})' for k, v in sorted(per2.items())) or '（无）'}")
if bad:
    print(f"  ✗ 这些文件不该再有'本子'（A 类应已改掉）: {bad}")
else:
    print("  ✓ 只出现在允许保留的文件里")
tot2 = sum(per2.values())
print(f"  总数 = {tot2}（上限 {CEILING}）{'✓' if tot2 <= CEILING else '✗ 超了'}")
for pat, strict in (("本子分工", True), ("本子使用指南", False)):
    hits = []
    for f in md_files:
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh, 1):
                    if pat in line:
                        hits.append(f"{rel(f)}:{i}")
        except OSError:
            pass
    if strict:
        print(f"    「{pat}」残留 {len(hits)} 处 {'✓' if not hits else '✗ ' + ', '.join(hits[:6])}")
    else:
        note = '✓' if not hits else '（第2趟前允许存在）' + ', '.join(hits[:4])
        print(f"    「{pat}」（文件名，第2趟后应为 0）残留 {len(hits)} 处 {note}")

print("\n完成。")
