# 过采样 TMDS 符号解码报告

> 本轮范围：只做**解码器 + 合成数据自证**。
> 没有板子、没有真实串口数据 ⇒ 真实数据的解码结论**一条都没有**。
> 涉及真实硬件的说法一律标 **待验证**。
>
> 新增文件：
> - `tools/tmds_decode_oversampled.py` —— 过采样 TMDS 符号解码器
> - `tools/make_tmds_testdata.py` —— 合成数据生成器 + 真值 + 破坏档 + `--selftest`
> - `tools/TMDS_OVERSAMPLED_REPORT.md` —— 本文件

---

## 0. 一句话结论

**解码器写好了，并且用合成数据证明了它对：**

1. 8 采样/位（`DVI_SM_CLKDIV=8` + 探针 `clkdiv=1`）下，逐符号比对通过率 **1.0000**
   （818/818 个符号，三条 lane 全对），`VERDICT: PASS`；
2. 注入的 **+900 ppm 板间频差**被测出来是 **-898 ppm**（= DUT 快 900 ppm），
   相位漂移被"逐符号锚定"吸收掉，没有累积；
3. **10 个破坏/变体档全部符合预期**：正常 2 档 PASS，6 档破坏 FAIL，
   抽稀档 REFUSE，参数写错档 FAIL；
4. **宽松判据（只看控制符号/速率、不给真值）被破坏数据骗过 6/10 次** ——
   这就是 `docs/陷阱.md` **错 17**"过于宽松的检查脚本 = 发免死金牌"的现场复现。

**一句话最值钱的发现**：TMDS 位序反了（MSB 先送）**不会报错**，
而是把 `CTL0 ↔ CTL1` 对调（= hsync/vsync 对调）、把 `CTL2/CTL3` 变成两个"看起来像数据"的
符号 `0x0AA/0x355`。控制符号命中数从 534 只掉到 375 —— **任何"按控制符号命中率判成功"
的判据都会说"解出来了"**。必须拿真值逐符号比对。

---

## 1. 判据：凭什么说"解对了"

| # | 判据 | 阈值 | 凭什么信它 |
|---|---|---|---|
| J1 | **逐符号真值比对通过率**（三条 lane 同时精确相等） | `>= 0.99` | 唯一能抓"静默错"的判据（见 §4.4） |
| J2 | 比对覆盖率（真值里有多少符号被真的比到了） | `>= 0.90` | 防止"只比 3 个符号就宣布通过" |
| J3 | 速率自洽：CLK 边沿反推的位率 vs `sys_clk/dut_sm_clkdiv` | `2%`（est-1/est-2）；`5000 ppm`（est-3） | 独立于符号切分的第二条证据；抓 `--probe-clkdiv/--dut-sm-clkdiv` 写错 |
| J4 | 实测每 TMDS 位采样数 | `>= 2.0`，否则 **REFUSE** | 上一轮的教训：1 采样/位下的符号统计是编的 |
| J5 | 符号相位搜索的"显著性"（最佳 j 的控制符号命中数 vs 次佳） | `best >= 4*max(1,second)` | 不显著时**明说相位没找到**，不说"找到了" |

**J1 不是自证的**：它必须同时满足两件事才可信 ——
(a) 正常数据上 J1 真的能到 1.0000（不然判据太严，会误杀）；
(b) 破坏数据上 J1 真的会掉下来（不然判据恒真，等于没有判据）。
§4.3 的 10 档矩阵就是这两件事的实测。

**J1 的阈值 0.99 是量出来的，不是拍的**：正常档实测 1.0000（818/818），
最接近的一次破坏是"半位错位"0.8753 —— 所以 0.99 既能过正常档、又能拦住半位错位。
（顺带说明：0.99 不是"随便定"的，若把阈值放到 0.80，"半位错位"这档就会漏过去，
见 §4.2 的说明。）

---

## 2. 输入与位序：先把最容易错的地方钉死

### 2.1 输入格式（= 探针 `d` 命令输出）

```
BEGIN <字数> <stall>
00080afd                 <- 每行一个 8 位十六进制字，共 <字数> 行
...
END
```

- 每字 4 个采样，**高字节在前**（bit31..24 = 第 1 个采样）；
- 每个采样字节 **bit0 = GPIO0 …… bit7 = GPIO7**；
- 线序 `0=D2P 1=D2N 2=D1P 3=D1N 4=D0P 5=D0N 6=CLKP 7=CLKN`；
- 差分切片：`P != N` 时取 `P` 电平；`P == N`（不该出现）时保持上一次的值，
  并**计数上报**（`P==N (invalid differential level) samples`）。

### 2.2 位序 = **LSB 先送**（不是猜的，有源码）

`third_party/frank-hdmi-sound/src/frank_serialiser.pio:64`

```c
sm_config_set_out_shift(&c, true /*shift_right*/, !debug, 10 * DVI_SYMBOLS_PER_WORD);
```

OSR 右移 ⇒ 符号的 **bit0（最低位）先上线**。
所以解码器组装符号时：**最先采到的位 = bit0**

```
sym = b[0] | b[1]<<1 | ... | b[9]<<9        (b[0] 最早)
```

同一段代码还确认了两件事：
- `out pc, 1` 的小把戏（地址 0 = side `0b10`、地址 1 = side `0b01`）
  ⇒ 1 个 SM 周期 = 1 个 TMDS 位，且 **D+ 电平 = 逻辑位本身，不反相**；
- 调试版 UART 分支（`pull ifempty side 1` / `nop side 0` / 10×`out pins,1`）
  与"右移 = LSB 先送、1 = 高电平"完全自洽 —— 旁证。

### 2.3 控制符号数值（取自 DUT 真实固件）

`third_party/frank-hdmi-sound/src/frank_dvi_timing.c:260`

```c
const uint32_t __dvi_const(dvi_ctrl_syms)[4] = {
    0xd5354, 0x2acab, 0x55154, 0xaaeab
};
```

每个字 = 同一个 10 bit 符号连写两遍，低 10 bit 就是符号数值；
索引 = `(vsync<<1)|hsync`（**线上电平**）：

| 数值 | 名字 | v 电平 | h 电平 |
|---|---|---|---|
| `0x354` | CTL0 | 0 | 0 |
| `0x0AB` | CTL1 | 0 | 1 |
| `0x154` | CTL2 | 1 | 0 |
| `0x2AB` | CTL3 | 1 | 1 |

### 2.4 编码器自检：与固件表 **64/64 逐位相同**

合成数据里的"数据符号"不是随便造的，而是本脚本按 DVI 1.0 图 3-5 直译的编码器编出来的
（移植自 `third_party/libdvi/tmds_table_gen.py`，并在注释里保留出处）。
它必须能复现 DUT 固件里那张像素加倍表：

```
> python tools\make_tmds_testdata.py --check-dut-table
ENCODER-VS-DUT-TABLE: OK  (64/64 entries identical to the DUT table, imbalance returns to 0 per pair)
```

⇒ 合成数据里的数据符号与 DUT 真实输出的编码规则**逐位一致**，
不是"我自己编一套再自己解回来"的空转。

### 2.5 位序反了会怎样（先算清楚，再用它当反面测试）

四个控制符号的比特反转：

| 原 | 反转后 | 还是控制符号吗 |
|---|---|---|
| CTL0 `1101010100` | `0010101011` = **CTL1** | 是（**换成另一个控制符号**） |
| CTL1 `0010101011` | `1101010100` = **CTL0** | 是 |
| CTL2 `0101010100` | `0010101010` = `0x0AA` | **不是** |
| CTL3 `1010101011` | `1101010101` = `0x355` | **不是** |

⇒ 位序反了以后：一半控制符号"变成另一个控制符号"（静默对调 hsync/vsync），
另一半混进"数据"里。**命中率只掉 30%，不会报错。** 这就是必须逐符号比对的原因。

---

## 3. 解码器怎么工作

输出的六节与小节号一一对应。

### 3.1 `[1]` 速率自洽（三条独立估计）

- 标称：`fs = sys_clk/probe_clkdiv`、`bit_rate = sys_clk/dut_sm_clkdiv`、
  **每 TMDS 位采样数 = `dut_sm_clkdiv/probe_clkdiv`**（这三条在 `[0]` 里显式打印）；
- **est-1**：整窗跳变计数。CLK 一个周期 2 次跳变、周期 = 10 个 TMDS 位 ⇒
  `bit_rate = 5 * E * fs / N`。量化误差 `~1/E`（1639 个边沿 ⇒ 0.061%）；
- **est-2**：相邻上升沿间距的中位数 `P` ⇒ `bit_rate = 10*fs/P`；
- **est-3（最精细）**：首尾锚点跨度 / 位总数。误差 ~1 个采样摊到 8000 个位上
  ⇒ 分辨到 **122 ppm**（65536 采样）/ **15 ppm**（524288 采样）。
  **这是唯一量得出板间频差的估计量。**
- 三个估计都共用同一个假设的 `fs` ⇒ 它们验的是
  **`dut_sm_clkdiv/probe_clkdiv` 这个比值和 DUT 的真实位率**，不是一个绝对时基。
  这一点在输出里写明了，不许含糊。

### 3.2 `[2]` 位栅格 + `[3]` 符号相位（漂移怎么处理）

时钟 lane 是 PWM 方波（`frank_serialiser.c:117-127`：`wrap=9`、电平 5/5、
**周期正好 = 10 个 TMDS 位**），所以每个时钟上升沿都落在位边界上。

1. 取 CLK 差分流的**上升沿**当锚点；相邻锚点间距 `P` = "10 个位"的实测长度；
2. `[A_k, A_{k+1}]` 均分 10 份 ⇒ 10 个位槽，**每个位槽取中间采样**；
3. **逐符号重新锚定** ⇒ +900 ppm 的频差不会累积
   （若用固定位周期开环推算，65536 个采样后误差可达几十个采样 —— 这是不能用固定周期的原因）；
4. **符号相位是搜出来的**：PWM 与 PIO 没有同步启动
   （`frank_serialiser.c:154` 注释原话："The DVI spec allows for phase offset between
   clock and data links. So PWM and PIO do not need to be synchronised perfectly."），
   上升沿可能落在符号起点、也可能落在符号中间。对 `j=0..9` 全试一遍，
   取"三条 lane 的控制符号命中总数"最大的 `j`；
5. **显著性判据**：最佳 `j` 的命中数必须是次佳的 4 倍以上，否则打印
   `ROTATION-MARGIN: weak` 并声明"符号相位没被证据确立"。
6. 附带输出 `clean-bit fraction`（位槽内部采样是否都一致）作为**栅格质量参考**。
   注意它**不是判据**：8 采样/位 + ±1 采样锚点量化下它只有 0.977，
   而符号仍然 100% 对 —— 采样点量化误差落在位边界那两个采样上，属正常。

### 3.3 `[4]` 符号分类

- 4 个控制符号按 §2.3 的数值分类；
- 其余按数据符号统计，给每条 lane 的 **top-20 直方图**（`值:次数:popcount`）；
- 给数据符号的 popcount 直方图，但**只当信息、不当判据**（理由见 §5.4）。

### 3.4 `[5]` 行结构

- 控制符号**游程长度**直方图（每条 lane、每个控制符号各一份）；
- 同种控制符号**相邻游程起点的间距**众数 = 行周期（单位：符号）；
- 输出里同时打印**从固件源码推出的预期结构**，并明确标注
  "This is a PREDICTION from the source, not a measurement. TO-BE-VERIFIED."

### 3.5 `[6]` 三 lane 对齐

- 统计"三条 lane **同时**是控制符号"的符号下标占比；
- 再把某一条 lane 整体平移 `d = -2..+1` 个**位**（不是符号），
  看"同时是控制符号"的数量 —— **`d=0` 必须是明显最大值**，
  否则说明三条 lane 的符号边界没对齐，上面每一条逐 lane 结论都作废。

### 3.6 `[7]` 真值比对

- 允许一个**全局**符号位移 `delta ∈ [-2,+2]`（真实捕获从哪个符号开始是任意的）；
  **不允许逐 lane 各自平移**（那会把 lane 错位掩盖掉）；
- 位移用"三条 lane 命中总数"选（比 all3 稳，破坏数据时 all3 恒 0 会让诊断退化），
  **判定仍然用最严的 all3 精确相等**；
- 通过率 < 阈值 ⇒ `VERDICT: FAIL`，退出码 1。

---

## 4. 自证结果（原始输出）

一条命令复现全部：

```
python tools\make_tmds_testdata.py --selftest
```

### 4.1 正常数据（必须通过）

`build_test\big.txt`：16384 字 = 65536 采样，8 采样/位，注入 **+900 ppm** 与
采样抖动 σ=0.05 采样，随机种子固定。

```
[1] RATE SELF-CONSISTENCY (two independent estimates vs nominal)
  CLK differential transitions = 1639 ; CLKP alone = 1639 ; CLKN alone = 1639
  P==N (invalid differential level) samples: CLK=0 D0/blue=0 D1/green=0 D2/red=0
  est-1 (transition count over whole window):
    f_clk = e * fs / (2N) = 3.15115e+06 Hz ; bit_rate = 10*f_clk = 3.15115e+07 bit/s
    relative to nominal: +0.037% (edge-count quantisation bound ~0.061%)
  est-2 (median rising-edge spacing):
    rising edges=819 spacing min/p50/p99/max = 79/80.0/80.0/81 samples
    samples per CLK period = 80.000 -> samples per TMDS bit = 8.0000
    bit_rate = fs / spb = 3.15e+07 bit/s ; relative to nominal: +0.000%
  est-3 (first-to-last anchor span, finest):
    span=65382 samples over 818 CLK periods -> samples per TMDS bit = 7.99291
    drift vs nominal = -886 ppm  (negative = DUT bit SHORTER = DUT faster)
    resolution ~ 122 ppm (1 sample over 818 bit periods)
  VERDICT-rate: CONSISTENT (tol: est-1 2.00% [3/e], est-2 2.00% [1/P], est-3 5000 ppm)

[2] BIT GRID (anchored on every CLK rising edge; drift absorbed per symbol)
  anchors used=818  bit slots=8180 (= 818 symbols worth of bits)
  clean-bit fraction D0   = 0.9770  (all samples strictly inside the bit slot agree with the centre sample)
  clean-bit fraction D1   = 0.9780  (all samples strictly inside the bit slot agree with the centre sample)
  clean-bit fraction D2   = 0.9782  (all samples strictly inside the bit slot agree with the centre sample)

[3] SYMBOL PHASE (which 10 bits form a symbol) -- searched, not assumed
  hits(j) = control-symbol count over all 3 lanes, for j=0..9:
    j0=534 j1=0 j2=0 j3=5 j4=7 j5=1 j6=0 j7=0 j8=0 j9=0
  chosen j=0 hits=534 ; runner-up hits=7
  ROTATION-MARGIN: strong

[6] THREE-LANE ALIGNMENT (judged by where control symbols appear)
  symbol index where ALL 3 lanes are control = 178 / 818 (21.76%)
  bit-offset scan (shift one lane by d bits, count all-3-control indices):
    D0   -2:0 -1:0 0:178 +1:0 +2:0
    D1   -2:0 -1:0 0:178 +1:0 +2:0
    D2   -2:0 -1:0 0:178 +1:0 +2:0

[7] COMPARE AGAINST GROUND TRUTH (build_test\big_truth.txt)
  truth NSYM=['820'] SAMPLES_PER_BIT=['7.992806'] CLK_RISING_AT_BIT=['0'] PPM=['900']
  drift cross-check: truth PPM=+900 (positive = DUT faster) => decoder
    est-3 should read about -900 ppm ; it reads -886 ppm (diff +14,
    method resolution ~122 ppm (1 sample over 818 bit periods);
    verdict gate is 5000 ppm
  best global symbol shift delta=-1 ; compared=818/820 (coverage 0.9976)
  all-3-lanes exact match = 818 / 818
    lane D0   match 818/818 = 1.0000
    lane D1   match 818/818 = 1.0000
    lane D2   match 818/818 = 1.0000
MATCH-RATE: 1.0000 (lane D0=1.0000 D1=1.0000 D2=1.0000 shift=-1 compared=818/820)
  judge: match_rate >= 0.9900 ? True ; coverage >= 0.90 ? True
VERDICT: PASS
```

读法（这几条要一起看）：

- **注入 900 ppm ⇒ 测出 886 ppm**（分辨率 122 ppm，差 14 ppm）。漂移确实被吸收了。
  更长的窗口把分辨率压到 15 ppm：524288 采样的档测出 **-898 ppm**（真值 900）。
- `CLKP alone`、`CLKN alone`、差分跳变三个数**完全相同（1639）**
  ⇒ 差分对是干净的、切片方式没丢边沿。
- `shift=-1` 是**允许**的全局位移：捕获起点那个不完整的时钟周期被丢掉了
  （宁可少一个符号，也不拿一个假锚点去切栅格；这也正是真实捕获会遇到的情况）。
- 覆盖率 0.9976：真值 820 个符号里比了 818 个（丢掉窗口两端的不完整符号）。

### 4.2 合法变体：CLK 上升沿落在符号中间（必须仍然通过）

把时钟相位挪半个符号周期（`--corrupt clk-phase-5`）。
这是**板子上真实可能的合法状态**（PWM 与 PIO 不同步启动）。
若解码器"假设上升沿就是符号起点"，这档就会全错。

```
CASE ok-clk-phase-5         corrupt=clk-phase-5  loose=INFO    strict=PASS    want=PASS    OK  1.0000 (... shift=-1 compared=818/820)
```

⇒ 通过率仍是 1.0000 ⇒ **符号相位确实是搜出来的，不是假设的**。

### 4.3 破坏档矩阵（必须失败的）

```
== SELFTEST: synth data -> decode -> verdict ==
sys_clk=2.52e+08 probe_clkdiv=1 dut_sm_clkdiv=8 words=16384 ppm=900 jitter=0.050
ENCODER-VS-DUT-TABLE: OK  (64/64 entries identical to the DUT table, imbalance returns to 0 per pair)
CASE ok                     corrupt=none         loose=INFO    strict=PASS    want=PASS    OK  1.0000 (lane D0=1.0000 D1=1.0000 D2=1.0000 shift=-1 compared=818/820)
CASE ok-clk-phase-5         corrupt=clk-phase-5  loose=INFO    strict=PASS    want=PASS    OK  1.0000 (lane D0=1.0000 D1=1.0000 D2=1.0000 shift=-1 compared=818/820)
CASE bad-msb-first          corrupt=msb-first    loose=INFO    strict=FAIL    want=FAIL    OK  0.0000 (lane D0=0.0171 D1=0.0220 D2=0.0257 shift=-1 compared=818/820)
CASE bad-shift-1bit         corrupt=shift-1bit   loose=INFO    strict=FAIL    want=FAIL    OK  0.0000 (lane D0=1.0000 D1=0.0000 D2=1.0000 shift=-1 compared=818/820)
CASE bad-half-bit           corrupt=half-bit     loose=INFO    strict=FAIL    want=FAIL    OK  0.8753 (lane D0=0.9010 D1=0.8973 D2=0.8949 shift=-1 compared=818/820)
CASE bad-invert-D2          corrupt=invert-D2    loose=INFO    strict=FAIL    want=FAIL    OK  0.0000 (lane D0=1.0000 D1=1.0000 D2=0.0000 shift=-1 compared=818/820)
CASE bad-noise-D0           corrupt=noise-D0     loose=INFO    strict=FAIL    want=FAIL    OK  0.8032 (lane D0=0.8032 D1=1.0000 D2=1.0000 shift=-1 compared=818/820)
CASE bad-subsample-8        corrupt=subsample-8  loose=REFUSE  strict=REFUSE  want=REFUSE  OK
CASE ok-but-wrong-probediv  corrupt=none         loose=FAIL    strict=FAIL    want=FAIL    OK  1.0000 (lane D0=1.0000 D1=1.0000 D2=1.0000 shift=-1 compared=818/820)
CASE ok-but-decoder-msb     corrupt=none         loose=INFO    strict=FAIL    want=FAIL    OK  0.0000 (lane D0=0.0171 D1=0.0220 D2=0.0257 shift=-1 compared=818/820)

loose judge was fooled by corrupted data: 6 / 10
SELFTEST: PASS
```

逐档说明（这一节是整份报告的重点）：

| 档 | 做了什么破坏 | 严格判据 | 说明 |
|---|---|---|---|
| `bad-msb-first` | 生成时改成 MSB 先送 | FAIL 0.0000 | 位序反（§2.5）。逐 lane 只剩 1.7%~2.6% 巧合命中 |
| `bad-shift-1bit` | D1 相对 CLK 错 1 个位 | FAIL 0.0000 | **诊断指得准**：D0=1.0000 / D1=**0.0000** / D2=1.0000 |
| `bad-half-bit` | 三条数据 lane 整体错半个位 | FAIL **0.8753** | ⚠️ **最接近漏网的一档**（见下） |
| `bad-invert-D2` | D2 的差分极性取反（P/N 对调） | FAIL 0.0000 | **诊断指得准**：D2=**0.0000**，另两条 1.0000 |
| `bad-noise-D0` | D0 上 2% 采样级极性翻转 | FAIL 0.8032 | D0=0.8032，另两条 1.0000 |
| `bad-subsample-8` | 每 8 个采样取 1 个（= 1 采样/位） | **REFUSE** | 实测 1.00 采样/位 < 2 ⇒ **拒绝出符号**，不给编的数字 |
| `ok-but-wrong-probediv` | 同一份**好**数据，但命令行写 `--probe-clkdiv 2` | FAIL | 符号本身仍 100% 对（**速率判据单独有牙**，见下） |
| `ok-but-decoder-msb` | 同一份好数据，解码器强制 `--symbol-bitorder msb-first` | FAIL 0.0000 | **位序主张的反面测试**：换位序就解不出来 |

三条值得单独讲的：

1. **`ok-but-wrong-probediv`**：数据完全正确、逐符号比对 **1.0000**，
   但速率自洽判据报 `*** INCONSISTENT ***`（实测位率只有标称的一半）⇒ 总判定 FAIL。
   这证明 §3.1 那条独立证据**不是摆设** ——
   参数写错时，符号可能照样"解出来了"，只有速率对不上。
2. **`bad-invert-D2`**：`~CTL0 == CTL1`（互补 = 换成另一个控制符号，见 §2.5），
   所以这条 lane 的**控制符号命中数一个都没少**（相位搜索命中数仍是 534，
   与正常档一模一样），宽松判据完全看不出来；
   只有逐符号比对能抓（D2 = 0.0000）。
3. **`bad-half-bit` = 0.8753**：这是本轮**最诚实的负面结果** ——
   8 采样/位 + 中心采样对半个位的错位**相当宽容**，仍有 87.5% 的符号是对的。
   它被拦住纯粹是因为阈值定在 0.99。
   ⇒ 若有人把阈值放宽到 0.8，这一档就会漏过去。
   （这也是为什么 §1 里说 0.99 是量出来的：正常档 1.0000、最危险档 0.8753。）

### 4.3b 上一轮的死结（1 采样/位）——本轮仍然**拒绝**

把 DUT 的 `dut_sm_clkdiv` 设回 1（= 慢扫描档之前的状态，位率 252 Mbit/s ≈ 探针 252 MSa/s），
生成 / 解码都按 1 采样/位：

```
> python tools\make_tmds_testdata.py --out build_test\fast.txt --truth build_test\fast_truth.txt --words 16384 --dut-sm-clkdiv 1
> python tools\tmds_decode_oversampled.py build_test\fast.txt --dut-sm-clkdiv 1
  ==> samples per TMDS bit (nominal) = dut_sm_clkdiv/probe_clkdiv = 1
    samples per CLK period = 10.000 -> samples per TMDS bit = 1.0000
    span=65521 samples over 6558 CLK periods -> samples per TMDS bit = 0.99910
  VERDICT-rate: CONSISTENT (tol: est-1 2.00% [3/e], est-2 10.00% [1/P], est-3 5000 ppm)
[1b] REFUSE: measured 1.000 samples per TMDS bit < 2.00 required.
  Slicing 10-bit symbols needs >=2 samples/bit; below that the symbol values
  would be fiction. This tool refuses instead of printing made-up numbers.
  (Same discipline as the previous round's report.)
VERDICT: REFUSE      (退出码 1)
```

⇒ 上一轮"给不出符号统计"的立场**被保留下来了**，而且是**实测**进来的：
门槛不是照抄参数，而是用**量出来的**每位数采样数判的。
（注意：速率自洽判据本身是"一致"的 —— 1 采样/位是**位率**问题，不是速率算错。
两件事分开判，输出里都能看到。）

### 4.3c 不给真值时（真实数据的默认跑法）工具怎么说话

```
> python tools\tmds_decode_oversampled.py build_test\big.txt
  WEAK-JUDGE: control-symbol hits=534 (a lenient judge would call this 'decoded'), rotation-margin=strong
VERDICT: INFO
```

它**不会**说"解对了"，只说 `INFO` + `WEAK-JUDGE`，
并把"这一档为什么不能当结论"写清楚（本文件 §4.4）。



### 4.4 最要命的一条：位序反了**不会报错**，而是对调 hsync/vsync

`--corrupt msb-first` 那份数据（内容是好的、只是位序反）的解码原始输出：

```
  hits(j) = control-symbol count over all 3 lanes, for j=0..9:
    j0=375 j1=0 j2=0 j3=0 j4=0 j5=0 j6=0 j7=0 j8=2 j9=156
  chosen j=0 hits=375 ; runner-up hits=156
  ROTATION-MARGIN: weak
  WARNING: the best rotation is not clearly better than the runner-up -> the
  symbol phase is NOT established by this evidence. Treat section 3+ as UNVERIFIED.
    control histogram: CTL0=16 CTL1=3 CTL2=0 CTL3=0          <- 真值是 CTL2=96 / CTL3=63
    top data symbols: 0x0aa:96:4 0x355:63:6 ...              <- 真值的 CTL2=0x154 / CTL3=0x2ab 被反转成这两个
    control histogram: CTL0=0 CTL1=178 CTL2=0 CTL3=0         <- 真值是 CTL0=178
    control histogram: CTL0=0 CTL1=178 CTL2=0 CTL3=0
MATCH-RATE: 0.0000 (lane D0=0.0171 D1=0.0220 D2=0.0257 shift=-1 compared=818/820)
  judge: match_rate >= 0.9900 ? False ; coverage >= 0.90 ? True
VERDICT: FAIL
```

对照 §2.5 的预测，**逐条命中**：

- `0x2AB`(CTL3) 反转 → `0x355`：在输出里以"数据符号 `0x355:63`"出现（真值 63 个 CTL3）✔
- `0x154`(CTL2) 反转 → `0x0AA`：以"数据符号 `0x0aa:96`"出现（真值 96 个 CTL2）✔
- `0x354`(CTL0) 反转 → `0x0AB`(CTL1)：D1/D2 的 178 个 CTL0 **原数变成 178 个 CTL1** ✔
- `0x0AB`(CTL1) 反转 → `0x354`(CTL0)：D0 上的 16 个 CTL1 变成 16 个 CTL0 ✔

⇒ 一个"只看控制符号命中率"的判据会看到 **375 个控制符号**（正常是 534），
判"解出来了"（`loose=INFO`），而实际上 **hsync/vsync 被静默对调、数据全错**。
这就是 `docs/陷阱.md` 错 17 最典型的形态。

### 4.5 行结构：检测器验证过了，但单次真实捕获只有 ~1 行

**先说做不到的**：真实探针一次 `d` 采集 = 16384 字 = 65536 采样
= **819 个符号**（8 采样/位），而 640x480p60 一行是 **800 个符号**。
⇒ **单次捕获装不下两行**，行周期/场结构**测不出来**。
工具在这种情况下打印：

```
    PERIOD D0: CANNOT-DETERMINE (need >=3 runs of one control code; one capture holds only ~818 symbols ~= 1 line of 800)
```

**但检测器本身是对的**，用 8 行合成数据验证
（命令：`--words 131072 --lines 8 --vblank-lines 2 --vsync-lines 2`；
脚本会把行数自动加长到 10 行以盖满采样窗口）：

```
    RUNLEN D0 CTL0 n=2 : 96 x2
    RUNLEN D0 CTL1 n=3 : 16 x1 704 x1 688 x1
    RUNLEN D0 CTL2 n=7 : 96 x7
    RUNLEN D0 CTL3 n=13 : 16 x5 48 x4 15 x1 704 x1 688 x1 47 x1
    RUNLEN D0 DATA n=4 : len640 x4
    PERIOD D0 CTL2: start-to-start mode=800 symbols (x5 of 7 starts)
    RUNLEN D1 CTL0 n=5 : 159 x2 160 x2 3360 x1
    RUNLEN D2 CTL0 n=5 : 159 x2 160 x2 3360 x1
MATCH-RATE: 1.0000 (lane D0=1.0000 D1=1.0000 D2=1.0000 shift=-1 compared=6558/6560)
VERDICT: PASS
```

**与固件源码推出的结构逐条对上**（这同时验证了生成器和解码器）：

- **行周期 = 800 个符号**（由 D0 上 CTL2 游程的起点间距量出，5/7 个间距是 800）✔
- `CTL2` 游程长度 **96** = 行同步脉冲宽度（VESA 640x480p60 的 hsync=96）✔
- `CTL3` 游程 **16 / 48** = 前肩/后肩（0x2AB = (v=1,h=1)，因为 h/v 都是**负极性**、空闲电平为 1）✔
- 场消隐行上 `CTL3` 合并成长游程 **688/704** ✔（48+640，再并上下一行的前肩 16）
- 场同步行上出现 `CTL1` **704/688** 与 `CTL0` **96** ✔（v 电平翻成 0）
- **D1/D2 整段 160 个 `CTL0`**、以及跨 4 行的 `CTL0` 长游程 **3360** ✔
  （= 4 行 × 800 + 160，与 `frank_dvi_timing.c:477-491` 的 `sym_no_sync` 一致）

⇒ **行结构检测器可用**（真数据够长就能用），但**一次采集不够长**。
要拿行/场结构，必须多次采集并按行拼接 —— 而那需要知道相邻两次采集之间丢了多少个符号，
**现在没有办法知道，所以不做**（宁可说做不到）。

---

## 5. 没解决的 / 存疑的 / 待验证的

1. **相位跟踪：解决的是"整数位旋转 + 板间频差"，没解决"分数位错位"。**
   符号相位靠 `j=0..9` 的整数位搜索；栅格靠逐符号锚定吸收频差。
   但**若 CLK 边沿与数据位边界差半个位（分数偏移）**，
   本方法只能靠"中心采样 + 8 采样/位"的余量硬扛 ——
   `bad-half-bit` 档实测 0.8753，**会掉 12.5% 的符号**。
   真实板子上 PWM 与 PIO 都按 sys_clk 计数，理论上偏差应是整数个位时间
   （加 pad 传播延迟 ~ns 级），但**这一条没有实测过 ⇒ 待验证**。
2. **位序：LSB 先送有源码证据（`frank_serialiser.pio:64`），
   但"证据链的最后一步"是 pad 是否反相。**
   源码里有一处实验代码 `frank_serialiser.c:106`：
   `if (cfg->pins_tmds[i] == 32) inv = !inv; /* 实验：只反 lane2(红) */`
   ⇒ **D2（探针 GPIO0/1）这条 lane 的极性可能被反相**。
   解码器目前**没有**自动纠正它，只是在比对失败时逐 lane 给出命中率
   （`bad-invert-D2` 那一档会显示 D2=0.0000、另两条 1.0000）。
   **真数据一到手，若看到"两条 lane 100%、一条 0%"，就应怀疑这一处。⇒ 待验证。**
3. **DC 平衡：没有实现 8b/10b 解码，也没有把 running disparity 当判据。**
   现在只把数据符号的 popcount 直方图打出来**当信息**。
   不敢当判据的原因见下一条。
4. **DUT 有效区到底用哪个编码器，没查清 ⇒ 待验证。**
   - `frank_tmds_table.h`（"pixel-doubling"表，64 项）里就存在 popcount = 1/9 的符号
     （entry0 = `0x100 | 0x1ff<<10`，本条已用 `--check-dut-table` 实测确认）；
   - 而 `src/dvi_screen.c` 的注释说上屏走的是 **`encode_one_scanline_16bpp()`**（16bpp 编码器）；
   - 两者不是同一条路径。**哪个在跑没实测。**
   所以本轮**不拿 popcount 当判据** —— 拿一个没验证的假设当判据，
   就是错 17 里那种"宽松/错误的检查脚本"。
5. **每行到底是不是 800 个符号，待验证。**
   `frank_dvi_timing.c:388 _dvi_fill_unused_slots()` 会给每条 lane 塞"续命段"
   （同步 lane 2 槽、数据 lane 5 槽，每槽 1 字 = 2 符号）；
   同文件 110-113 行的注释**断言**"多出来的字会在行边界被丢弃、不累积"。
   这只是注释里的断言。合成数据按 800 生成，**解码器不假设 800**，
   会实测游程与行周期 —— 真实数据一跑就知道。
6. **真实捕获的窗口对不齐**：真实数据从哪一位、哪一符号开始是随机的，
   本工具用"全局位移 ±2 符号"容差 + 丢掉起点那个不完整时钟周期来处理。
   这会让**每次都比真值少一两个符号**（覆盖率 ~0.997），属预期，不是缺陷。
7. **未做**：帧率/场结构（一次采集不够长）；多板/多通道；串口采集本身；
   `core1_monitor/` 与 `third_party/` 一个字都没改（只读了 4 个源文件取证）。

---

## 6. 复现命令（全部带超时、不用管道抓子进程输出）

```powershell
# 0) 编码器 vs DUT 固件表（必须 64/64）
python tools\make_tmds_testdata.py --check-dut-table

# 1) 一条命令跑完全部自证（正常必须通过、破坏必须失败），退出码 0 = 全符合预期
python tools\make_tmds_testdata.py --selftest

# 2) 生成一份正常合成数据 + 真值
python tools\make_tmds_testdata.py --out build_test\big.txt --truth build_test\big_truth.txt --words 16384 --lines 4

# 3) 解码 + 拿真值逐符号比对
python tools\tmds_decode_oversampled.py build_test\big.txt --expect build_test\big_truth.txt

# 4) 只解码、不给真值（真实数据就是这么跑）
python tools\tmds_decode_oversampled.py build_test\big.txt
```

**真实数据一到手就能跑的那条命令**（原样替换文件名即可）：

```powershell
python tools\tmds_decode_oversampled.py <采集文件.txt> --sys-clk 252e6 --probe-clkdiv 1 --dut-sm-clkdiv 8
```

- `--probe-clkdiv`：探针 `core1_monitor` 里那个采样分频（`SAMP_DIV_DEFAULT`）。
  走 1 就是 252 MSa/s（8 采样/位）；若是 2 就是 126 MSa/s（4 采样/位，仍然够用）。
- `--dut-sm-clkdiv`：DUT 的 `DVI_SM_CLKDIV`（慢扫描档 = 8）。
- 想一次看多个文件（例如 `cap_div1.txt` 那一批）：把文件名并列传进去即可，
  末尾会打一条 `AGGREGATE`（最坏情况胜出）。
- 退出码：`0` = PASS/INFO，`1` = FAIL/REFUSE，`2` = 用法错。

解码器会**显式打印**：采样率、位率、**每 TMDS 位采样数**（`[0]` 节），
以及从 CLK 边沿独立反推的位率（`[1]` 节）和两者是否一致。

---

## 7. 附：给真实数据的三条可证伪预测

这三条是从固件源码读出来的（不是猜），真数据一跑就能被推翻。
**本轮一条都还没验证。**

| # | 预测 | 依据 | 若预测错，说明什么 |
|---|---|---|---|
| P1 | **D0/blue 是同步 lane**：它的消隐段是 `CTL3`/`CTL2`（不是一整片 CTL0）；**D1/D2 消隐段全是 `CTL0`(0x354)** | `frank_dvi.h:31 #define TMDS_SYNC_LANE 0 // blue!`；`frank_dvi_timing.c:477-491` | 探针的线序映射或 DUT 的 lane 分配与文档不符 |
| P2 | **D2（GPIO0/1）可能整条反相**：它的符号会表现为"互补"（CTL0↔CTL1），逐 lane 比对会显示 D0/D1 对、D2 全错 | `frank_serialiser.c:106` 的 `pins_tmds==32 → inv=!inv` 实验 | 若 D2 正常，说明那次实验已被撤销/未编译进去 |
| P3 | **消隐游程应是 64 与 96 两种**（不是 160 一整段），且 `CTL2` 游程就是 96 | 负极性 ⇒ 空闲=1、脉冲=0；前肩16 + 后肩48 在行边界合并成 64；hsync=96 | 极性与预设不符，或探针在那里丢了采样 |

---

## 8. commit 列表

| 短 hash | 标题 |
|---|---|
| `e9eaac0` | 基线: 上届文档/模型本落定 + 慢扫描验证档 + 构建忽略规则 |
| `7ae3f53` | 工具: 过采样 TMDS 符号解码器 + 合成数据生成器（本轮新增，尚未自证完毕） |
| `ba54b22` | 自证: 破坏档矩阵 10/10 符合预期（宽松判据被绕过 6/10） |
| （本报告） | 报告: 过采样 TMDS 符号解码报告（判据/原始输出/待验证项） |

> 分支：`agent/dsflash`（**没有 remote，不 push**：主 AI 自己来取提交）。
> 本报告提交的短 hash 见最终回复。
