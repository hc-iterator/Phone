# core1_monitor —— 探针板 Core1 串口调试监视器 + 采样器（穷人版 SWD）

**解决的问题**：探针板（13 元的 RP2040 核心板）没有引出 SWD，唯一的通道是 USB 串口 + BOOTSEL。
一旦固件跑挂（Core0 卡在死循环里），串口就没人应答了，只能靠人手按 BOOTSEL 才能救回来。
本固件把**串口服务整个搬到 Core1**，于是 **Core0 死不死都不影响串口**；`P`（暂停）/`B`（进 BOOTSEL）
在任何状态下都可用。

> ⚠️ **2026-10-04 用户更正（写这条时的口径要改）**：
> **真正"没有引出 SWD"的是【被测那块】（DUT / RP2350B-Plus-W）** —— 所以调不到它，
> 才走上"串口抓包 + 软件后门"这条路。
> **探针（RP2040）这边**：当时认为"**给探针上 SWD 没啥必要**"（是个判断，不是板子做不到）
> ⇒ 别把"DUT 没有 SWD"说成"探针没有 SWD"。

**第二件活（v1.1）**：把**采样器合并进来**了。以前探针要么跑监视器、要么跑采样器（两个固件），
而**干活时（跑采样器）挂死照样没人救**。现在一个固件同时具备：
Core1 串口服务 + 自救 + Core0 的 PIO 采样。采样器跑飞 = Core0 挂死 = 本固件已被上机验证过能扛住的那种故障。

产物：`core1_monitor/build/core1_monitor.uf2`（约 112 KB，RP2040 family）。

---

## 0. 上机验证状态（2026-10-03）

**独立监视器版（v1.0）与合并版（v1.1）的 `S` / `X` / `P` / `B` 全部实测通过**：

```
S ⇒ 完整状态 OK（含 sys_clk / overclock OK / flash / Core0 心跳）
X ⇒ 故意挂死 Core0 ⇒ "heartbeat frozen = it is really hung"
S ⇒ "WARN: heartbeat frozen -> Core0 looks hung"（监视器自己活着）
P ⇒ "ERR: Core0 no response (hung?) -- nothing was paused, and this monitor is fine."
B ⇒ 板子真的进了 BOOTSEL（出现 RPI-RP2 盘）  <= 灵魂功能成立，不再需要人手按键
```

> ⚠️ **协议细节（实测踩到）**：命令**必须以 CR（`\r`，或 `\n`）结尾**才会被执行。
> 只发裸字符时固件只回显、不动作 —— 一开始容易被误判成"固件坏了"。

### v1.1.1 修掉的一个真 bug（上机抓到，值得记下来）

**症状**：合并版第一次真正动用采样器（`m` / `d`）时，**Core0 自己死了**（`m`/`d` 报 `Core0 no response`）。
`g` 却正常 —— 因为 `g` 只读 SIO，是当时唯一不碰 RX FIFO 的采样命令。

**根因**：`samp_drain_fifo()` 被我写成了

```c
while (!pio_sm_is_rx_fifo_empty(pio, sm)) { (void)pio_sm_get(pio, sm); }   // 错
```

"抽到空为止"看着天经地义，但 **PIO 的产量可以高于 CPU 的抽取速度**：
默认 `clkdiv=1` 时 PIO 是 **63 Mwords/s**（每 4 个 clk_sys 推 1 个字），而 CPU 紧循环抽只有 ~30 Mwords/s
⇒ RX FIFO **永远不会空** ⇒ Core0 就死在这个循环里。

**改法（三层，缺一不可）**：

1. 倒 FIFO 改成**有界**：先读电平，只抽这么多个（RX FIFO 只有 4 深），再夹 8 的上限。
2. 默认分频从 `1.0` 改成 **12**：clkdiv=1 在本板上本来就不可用（FIFO 恒满 ⇒ 每次采集都丢样），
   默认 12 只要 5.25 Mwords/s，余量很大，第一次 `d` 就是干净的。要满速自己发 `c1`。
3. 加**采样器看门狗**（Core0 侧）：复用本来就在跑的 1ms 心跳闹钟，任何一次采样操作超过预算
   （capture 800ms / measure 500ms / 其它 200ms）就在中断里立 `abort`，采样循环看到就退出，
   Core1 收到的是"这次操作被中止(status=1)"而不是"Core0 没了"。
   ⇒ 以后就算又有人写出无界循环，Core0 也只会"这次采集失败"，**绝不会整个核消失**。

**顺带修掉的三个**：

* `s`（小写）以前被我错接成监视器状态（而文档写的是采样器状态）⇒ 现在 `S`=监视器、`s`=采样器。
* `clkdiv` 解码位域写错：PIO 的 `SM_CLKDIV` 是 **INT 在 [31:16]、FRAC 在 [15:8]**，
  我原来写成 `>>8 / &0xFF`，会把 12 解成 3072 ⇒ 采样率 / `expect` 全错。现在直接引用
  `PIO_SM0_CLKDIV_INT_LSB / FRAC_LSB` 宏，不再凭印象。
* 采样请求失败的提示不再一律说"Core0 挂了"：现在用**心跳**区分
  "真挂死"、"活着但没答采样请求（协议错位）"和"操作被看门狗中止"三种情况。

---

## 1. 怎么烧

探针板没有 SWD，所以只有一条路：**BOOTSEL**。

1. 按住板上的 **BOOTSEL** 键，插 USB（或按一下 RUN），松开 ⇒ 电脑出现一个名为 `RP2`（或 `RPI-RP2`）的 U 盘。
2. 把 `core1_monitor.uf2` 拖进那个 U 盘。板子自己重启，U 盘消失。
3. 出现一个新的串口（Windows 上是 `COMx`，名字类似 `USB Serial Device`）。打开它。

用 picotool 也可以（同样要求板子在 BOOTSEL 态）：

```powershell
& "$env:USERPROFILE\.pico-sdk\picotool\2.3.0\picotool\picotool.exe" load -v -x core1_monitor\build\core1_monitor.uf2
```

**串口工具设置**：CDC 的波特率无所谓（填 115200 即可），但请**关掉本地回显（Local Echo）**，
因为固件自己会回显你敲的字符（开了会看到双份）；**每条命令必须以 CR/回车结尾**（见上面的警告）。

打开后应该看到：

```
=== core1_monitor 1.1 : Core1 serial debug monitor (poor man's SWD) ===
USB CDC is serviced by Core1. Core0 never touches stdio.
Type ? for help.
mon>
```

---

## 2. 命令表

### 2.1 监视器/自救

| 命令 | 作用 |
|---|---|
| `?` | 帮助 |
| `S` | 状态：sys_clk、超频结果、Core0 是否被暂停/挂死、Flash 大小 + JEDEC ID、采样器摘要 |
| `r <addr> [n]` | 读 n 个 32 位字（n ≤ 64，默认 1） |
| `w <addr> <val>` | 写一个 32 位字（**只允许 SRAM**） |
| `P` | 暂停 Core0（Core0 进 WFI 等命令；Core1 照常服务） |
| `C` | 继续 Core0 |
| `R` | 重启设备（`watchdog_reboot`） |
| `B` | 重启进 BOOTSEL（`reset_usb_boot`）——**灵魂功能，任何状态下都能用** |
| `E <addr>` | 擦除包含该地址的 4KB 扇区（**addr 必须 4KB 对齐**） |
| `F <addr> <len> [H]` | 擦除 + 写入 len 字节 + **读回校验**（`H` = 十六进制文本输入） |
| `X` | **自测用**：故意让 Core0 挂死（关中断 + 死循环），验证监视器不受影响 |

### 2.2 采样器（跑在 Core0，PIO0，采 GPIO0..7）

引脚映射固定：`GPIO0=D2P(红+) 1=D2N 2=D1P(绿+) 3=D1N 4=D0P(蓝+,含同步) 5=D0N 6=CLKP 7=CLKN`

| 命令 | 作用 |
|---|---|
| `c<div>` | 设 PIO 分频（1~64，**十进制**，可连写也可空格）。采样率 = sys_clk / clkdiv。推荐 **11~12** |
| `m` | 量"CPU 抽 FIFO"的实际搬运速率 + 打 FIFO/FDEBUG 状态（诊断用） |
| `d` | 采一包（**16384 字 = 65536 个采样**）并十六进制 dump |
| `s` | 采样器状态（实时问 Core0；Core0 挂了就报"无响应"+ 上次已知值） |
| `g` | 用 SIO 直接读 GPIO0..7 五次（与 PIO 交叉验证：是线的问题还是 PIO 通路的问题） |

> **上电默认 `clkdiv = 12`（21 MSa/s）**，不是满速。理由见第 0 节那个 bug：
> `clkdiv=1` 时 PIO 产 63 Mwords/s 而 CPU 抽不过来，FIFO 恒满、每次采集都丢样。
> 要满速请自己发 `c1`（那时 `m` 会明确报 RXSTALL）。

> ⚠️ `c`/`C` 与 `r`/`R` 一样**靠大小写区分**：小写 `c<div>` = 设采样分频；大写 `C` = 继续 Core0。
> `S`（大写）= 监视器总状态（只读缓存，Core0 挂了也秒回）；`s`（小写）= 采样器状态（会问 Core0）。
> 所以 **Core0 挂死时先用 `S` 看心跳**，`s` 会明确告诉你是"真挂死"还是"只是没答采样请求"。

### 数字格式（重要）

* **地址和值一律按十六进制**（`0x` 可写可不写）：`r 20000000`、`w 20000000 CAFEBABE`、`E 101FF000`。
  之所以不"智能猜十进制"：`20000000`、`10100000` 这种全数字的地址，猜错就会打到别的地址上。
* **个数和长度按十进制**（写 `0x` 前缀才是十六进制）：`F 10100000 256` 就是 256 字节。
  命令回显里 `len` 会同时打出十进制和 `0x`，写错了一眼能看出来。
* **`r` 是小写、`R` 是大写**，这是任务规定的两条不同命令。
  顺手做了个防误触：`R 20000000` 这种"带参数的重启"会被拒绝，并提示你用 `r`。

---

## 3. 每条命令的用法示例

> 下面 `mon>` 是固件打印的提示符，其余是固件输出。`#` 开头的行是说明，不用敲。

### `?` 帮助

```
mon> ?
Commands. addr/val are ALWAYS hex (0x optional). counts are decimal (0x.. = hex).
  ?                 this help
  S                 status: sys_clk / Core0 state / flash size + JEDEC id
  r <addr> [n]      read n 32-bit words (n<=64 dec), e.g. r 20000000 / r 10000000 8
  w <addr> <val>    write one 32-bit word (SRAM only), e.g. w 20000000 CAFEBABE
  ...
```

### `S` 状态

```
mon> S
monitor   : core1_monitor 1.1, this is Core1
sys_clk   : 252000000 Hz
peri_clk  : 125000000 Hz
overclock : OK (target 252000 kHz)
flash     : build limit 2048 KB, JEDEC id EF4015, chip 2048 KB
usable    : up to 10200000
image     : 10000000..1000def4 (writing here is refused on purpose)
core0     : running, heartbeat 48213 -> 48234
            ok: alive (~21 ticks/20ms)
core-fifo : status 00000000 (rx not empty = 0)
sampler   : clkdiv 12 (last known) -> 21000 kSa/s, last capture 16384 words, stall=0
```

`JEDEC id EF4015` = 厂商 `EF`(Winbond) / 类型 `40` / 容量 `15`(=2MB)。
`sampler` 那一行读的是**缓存值**（所以 Core0 挂死时 `S` 也不会变慢）；要看实时值请用 `s`。
Core0 挂死时这两行会变成：

```
core0     : running, heartbeat 48213 -> 48213
            WARN: heartbeat frozen -> Core0 looks hung
sampler   : clkdiv 12 (last known) -> 21000 kSa/s, last capture 16384 words, stall=0
```

### `r` 读内存

```
mon> r 20000000
20000000: 00000000
mon> r 20000000 8
20000000: 00000000 00000001 00000002 00000003
20000010: 00000004 00000005 00000006 00000007
mon> r 10000000 4
10000000: 00000000 20000000 1000bbed 00000000
```

### `w` 写内存（只允许 SRAM）

```
mon> w 20000000 CAFEBABE
w 20000000: 00000000 -> CAFEBABE (readback CAFEBABE) OK
mon> w 10000000 1234
ERR: w only accepts SRAM (20000000-20041FFF); flash -> F/E, peripherals refused
```

### `P` / `C` 暂停与继续（灵魂功能）

```
mon> P
Core0 paused (state=PAUSED (WFI loop)). Core1 is still serving this port. C = resume
mon> S
core0     : PAUSED (WFI loop), heartbeat 51234 -> 51234
mon> C
Core0 resumed (state=running)
```

Core0 **已经挂死**时（比如先敲了 `X`）：

```
mon> P
ERR: Core0 no response (hung?) -- nothing was paused, and this monitor is fine.
     P cannot stop a core that is already stuck. R / B still work.
```

注意：这时候串口**照样活着**，`S`、`R`、`B` 全都还能用。这就是本固件存在的意义。

### `R` 重启

```
mon> R
rebooting now (watchdog_reboot). This port will re-enumerate.
```

### `B` 进 BOOTSEL（最有用的一条）

```
mon> B
rebooting into BOOTSEL (RP2 mass storage). Close this port.
```

⚠️ 敲完这条，CDC 串口会消失，电脑上会出现 `RP2` U 盘。**先把串口工具关掉**再拖 UF2。
这一条不碰任何共享资源，所以**不管 Core0 是暂停、挂死还是正在跑，都一定能用** —— 这就是"再也不用人手按 BOOTSEL"。

### `E` 擦一个 4KB 扇区

```
mon> E 101FF000
E: erasing 101FF000..10200000 (4KB)
done. verify: 4096 bytes not 0xFF (expect 0) -> OK
mon> E 101FF800
ERR: E needs a 4KB aligned addr. Sector containing 101FF800 is 101FF000
     (refused on purpose: an unaligned erase would wipe its neighbours too)
```

### `F` 写 Flash（两种输入协议，任选）

`F <addr> <len>` 之后固件打印 `READY`，然后**主机接着发数据**；写完自动**读回校验**。
无论哪种模式，写之前都会先擦掉覆盖到的整个扇区，编程长度按 256 字节向上取整（不足的部分填 `0xFF`），
所以**同一扇区里 addr 之前的那部分数据会被一起擦掉**（这是 Flash 的物理特性，不是 bug）。

`len` 上限 32768 字节（RAM 缓冲区限制）。

#### 协议 A：原始字节（默认，不带 `H`）

`READY` 之后直接发 `len` 个**原始字节**。适合脚本/二进制文件。

```
mon> F 10100000 16
F: addr 10100000 len 16 (0x10) (RAW-BINARY input)
   erase   10100000..10101000
   program 10100000..10101000 (tail padded with 0xFF)
READY: send 16 bytes now; a Z-only line or 10 s of silence aborts
................
got 16 bytes
writing...
verify: 0/16 bytes differ (sum flash=00000120 expect=00000120) -> OK
```

> 原始模式下没有转义字符，所以中途想放弃只能等 10 秒静默超时（然后会报 `-1 idle timeout`）。

#### 协议 B：十六进制文本（带 `H`，手敲/复制粘贴最舒服）

`READY` 之后发十六进制文本，规则：

* 空白、`,`、`:`、`-` 全都被忽略（所以 `AA BB`、`AABB`、`AA,BB` 都行）；
* `#` 到行尾是注释；
* **单独一行 `Z`** 表示主动中止；
* 换行时如果还剩半个字节（奇数个十六进制字符）会报错（`-2 odd nibble`）；
* 收到 `len` 个字节就自动结束（多发的字符会留在缓冲里，等下一条命令）。

```
mon> F 10100000 16 H
F: addr 10100000 len 16 (0x10) (HEX-TEXT input)
   erase   10100000..10101000
   program 10100000..10101000 (tail padded with 0xFF)
READY: send 16 bytes now; a Z-only line or 10 s of silence aborts
# 下面这 16 个字节就是我们要写的内容
00 01 02 03 04 05 06 07
08 09 0a 0b 0c 0d 0e 0f
got 16 bytes
writing...
verify: 0/16 bytes differ (sum flash=00000078 expect=00000078) -> OK
```

校验失败时长这样（会指出第一处不一致）：

```
verify: 3/256 bytes differ (sum flash=0000ff10 expect=0000fe0d) -> FAIL
        first diff at 10100040: flash=00 expect=aa
```

#### 主机侧怎么发（省事版）

同目录下带了一个小工具 `host/mon.ps1`（PowerShell，无第三方依赖）：

```powershell
# 先看一眼状态
pwsh -NoProfile -File core1_monitor\host\mon.ps1 -Port COM7 -Cmd "S"

# 把文件的原始字节写进 10100000
pwsh -NoProfile -File core1_monitor\host\mon.ps1 -Port COM7 -Addr 10100000 -SendFile .\payload.bin

# 用十六进制文本模式写（内容一样，走协议 B，方便人看日志）
pwsh -NoProfile -File core1_monitor\host\mon.ps1 -Port COM7 -Addr 10100000 -SendFile .\payload.bin -Hex

# 擦一个扇区 / 暂停 Core0 / 进 BOOTSEL
pwsh -NoProfile -File core1_monitor\host\mon.ps1 -Port COM7 -Cmd "E 101FF000"
pwsh -NoProfile -File core1_monitor\host\mon.ps1 -Port COM7 -Cmd "P"
pwsh -NoProfile -File core1_monitor\host\mon.ps1 -Port COM7 -Cmd "B"
```

### `X` 自测：故意让 Core0 挂死

```
mon> X
X: asking Core0 to hang on purpose (interrupts off + dead loop)...
Core0 heartbeat 62011 -> 62011 (frozen = it is really hung).
This monitor is still alive on Core1. Try S / P (no response expected),
then R or B -- both still work. That is the whole point of this firmware.
```

之后 `S` 会显示心跳冻结、`P`/`C` 会报"无响应"，而 `R`/`B` 照常工作。
（注意：`X` 之后 Core0 关着中断死在 flash 里，所以这时 **写 Flash 会被拒绝**——见下面的"已知限制"。
用 `R` 或 `B` 就能恢复。）

### 采样器：`c<div>` 设采样率

```
mon> c12
OK clkdiv=12.00  =>  21000 kSa/s  (words/s = 5250000)
   sample rate = sys_clk(252000000 Hz) / clkdiv(12); 4 samples per 32-bit word
```

`12` 表示 PIO 每 12 个 clk_sys 周期采一次 ⇒ 252 MHz / 12 = **21 MSa/s**。
推荐从 **11~12** 开始（这是 probe_rp2040 时代的推荐档，FIFO 不会溢出）。
上电默认就是 12，所以第一次用不必先发 `c12`。

### 采样器：`m` 量搬运速率 + FIFO 状态

```
mon> m
MEAS moved=10512 words in 2001 us => 5254372 words/s (expect 5250000 at clkdiv=12)
     rxf=0 sm_en=1 fdebug=00000000
     => drain rate looks fine (bottleneck is not here)
     ok: no RXSTALL during the window -> no sample loss at this rate.
```

* `moved` 是 2ms 窗口内 CPU 实际抽走的字数；`expect` = `sys_clk / clkdiv / 4`
  （PIO 程序是 `in pins,8` + autopush 32 位 ⇒ **每 4 个采样推 1 个字**）。
* **窗口内的 `RXSTALL` 是判据**：置位 = RX FIFO 满过 = SM 停顿过 = **采样丢过**。
  看到 `WARN` 就把 `clkdiv` 加大重试（见第 3 节 `s` 下面关于两个 rxstall 的说明）。
* 用整数打印（`words/s`、`kSa/s`），不走 `%f`。

### 采样器：`d` 采一包并 dump（与旧固件的格式完全一致）

```
mon> d
d: capturing 16384 words (65536 samples) ...
captured 16384 words (65536 samples) in 3204 us, sys_clk 252000000 Hz, clkdiv 12
fifo: rxf=0 sm_en=1 fdebug=00000000 rxstall=0
buffer: nonzero=16384/16384 first_nonzero=0
BEGIN 16384 0
40080087
2a0c1b3f
...
END
```

* **格式**：`BEGIN <字数> <stall>` / **每行一个 8 位十六进制字** / `END`。
  `tools/tmds_decode.py`、`tools/tmds_sampled_decode.py`、`tools/sampler_capture.py` 可以直接吃。
* ⚠️ **第二字段的含义变了**：旧固件那里是 DMA 回卷次数 `wraps`，而"CPU 抽 FIFO"方案里没有 DMA。
  现在它表示**本次采集期间 PIO 是否因 RX FIFO 满停顿过**：`0` = 没丢样（时间轴连续），
  `1` = 丢过（请加大 `clkdiv` 重采）。已核对：上位机三个脚本只把它读出来打印，不参与计算。
* `nonzero=0` 或 `first_nonzero=-1` 说明**采到全 0** ⇒ 九成是 PAD 输入通路/引脚功能的问题
  （`pio_gpio_init` 那三个坑之一），配合 `g` 命令一起判断。
* 16384 行 hex 会走 Core1 的 USB 顺畅吐出去（每 512 行 flush + 踢一次 tud_task）；这段时间
  Core0 已经采完了，Core1 不等任何人。

### 采样器：`s` 状态 / `g` 交叉验证

```
mon> s
sampler   : PIO0 SM0, in-pins 0..7  (GPIO0=D2P 1=D2N 2=D1P 3=D1N 4=D0P 5=D0N 6=CLKP 7=CLKN)
clk       : sys_clk 252000000 Hz, clkdiv 12.00 -> 21000 kSa/s (4 samples/word)
sm        : enabled=1  rx fifo level=3  fdebug=00000001
rxstall   : now=1  during last window=0   (1 = samples may have been lost;
            'now' is usually 1 because nobody drains the FIFO between commands)
buffer    : nonzero=16384/16384 first_nonzero=0 (all-zero = PAD input path problem)
last cap  : 16384 words, stall=0
```

> ⚠️ **两个 `rxstall` 要分清**：
> * `now` = 此刻的 RXSTALL。命令与命令之间没人抽 FIFO，FIFO 必然满、这个位**通常就是 1**，不用管它。
> * `during last window` = **上一次 `d`/`m` 的窗口期间**有没有丢样 —— **这个才是判据**。
>   它在窗口结束的那一刻被快照下来（晚一步就会被"之后又满了"污染成假警报）。
>   `d` 的 `BEGIN` 第二字段用的也是这个值。

```
mon> g
GPIO   : 7 6 5 4 3 2 1 0
read0  : 1 0 1 0 1 1 0 0   0xac
read1  : 1 0 1 0 1 1 0 0   0xac
read2  : 0 1 0 1 0 0 1 1   0x53
read3  : 1 0 1 0 1 1 0 0   0xac
read4  : 1 0 1 0 1 1 0 0   0xac
changes in 5 reads: 2 (levels are moving -> a live signal is present)
```

`g` 用的是 SIO 的 pad 输入（`gpio_get`），**不改 FUNCSEL、不打扰正在跑的 PIO**。
电平在动 = 线/信号是活的，那"采到全 0"就只能是 PIO 那一侧的问题。

### 采样器 + 自救：Core0 挂死时

```
mon> X
Core0 heartbeat 62011 -> 62011 (frozen = it is really hung).
mon> d
ERR: Core0 no response (hung?) -- sampler is dead, no data.
mon> s
ERR: Core0 no response (hung?) -- sampler is dead.
     last known: clkdiv=12 -> 21000 kSa/s, last capture 16384 words, stall=0
mon> S
... core0: running, heartbeat ... frozen ... WARN ...
sampler   : clkdiv 12 (last known) -> 21000 kSa/s, last capture 16384 words, stall=0
mon> B
rebooting into BOOTSEL (RP2 mass storage). Close this port.
```

**这就是合并的意义**：采样器（跑在 Core0）挂了，串口照样活着，`S`/`B`/`R` 照样能用，
不用再伸手去按 BOOTSEL 键。

> 注意：`P` 暂停 Core0 之后，采样器命令会直接告诉你 `Core0 is PAUSED -- send C to resume first`，
> 不会让你白等一次超时（暂停的定义就是 Core0 不再处理 FIFO）。

---

## 4. 安全边界（故意做窄的地方）

| 范围 | 允许的操作 |
|---|---|
| `00000000`–`00003FFF`（bootrom） | 读 |
| `10000000`–`10000000+可用Flash`（XIP） | 读（写请走 `F`/`E`） |
| `20000000`–`20041FFF`（SRAM 264KB） | 读 + 写 |
| 其它地址（外设寄存器、未映射区…） | **一律拒绝** |

为什么要拒绝：在这些地址上取数会吃 BusFault → HardFault，那等于"监视器自己挂了"，
跟本固件的存在目的正好相反。外设寄存器还有读副作用问题，所以也不放开。
（真要读外设，可以把这段白名单改宽后重新烧写。）

**绝对拒绝的两件事**：

1. **`10000000` 起的头 4KB**（boot2 + 向量表）：写坏就真变砖，任何 `E`/`F` 只要碰到它就拒绝。
2. **正在运行的固件自己占用的 flash 范围**（`__flash_binary_start`..`__flash_binary_end`）：
   擦掉正在执行的代码，这条命令会在中途断气。要换固件请走 `B`(BOOTSEL) + picotool。

---

## 5. 设计要点（为什么它能不死）

1. **USB 服务在 Core1，不在 Core0。**
   SDK 的 `stdio_usb_init()` 有一条硬检查：只能在"默认 alarm pool 所属的核"（也就是 Core0）上初始化，
   在 Core1 上调会直接失败/panic。所以固件是：**Core0 负责初始化，然后把 USB 的两条中断
   （`USBCTRL_IRQ` + stdio_usb 动态认领的那个 user IRQ）从自己的 NVIC 上摘下来，挂到 Core1 的 NVIC 上**。
   NVIC 是每核私有的（PPB 基址），而中断处理函数表是全局共享的，所以换核服务完全可行。
   换核之后 Core0 再也不碰 stdio —— 于是 Core0 挂死（哪怕关着中断死循环）串口照样活着。
2. **Core1 上所有等待都自带超时，而且从不用 `sleep_ms()`。**
   `sleep_ms()` / `multicore_fifo_pop_timeout_us()` 内部会把"叫醒我"的闹钟挂到 **Core0 的 alarm pool** 上；
   如果 Core0 关着中断挂死了，那个闹钟永远不会响，Core1 就会卡在 `__wfe()` 里 —— 那就等于自己造了个挂死。
   所以 Core1 上一律用 `time_us_64()` 比较 + 自旋。
3. **写 Flash 前先请 Core0 进 RAM "停车位"。**
   `flash_range_erase/program` 和 `flash_do_cmd` 内部会关掉 XIP；XIP 一关，任何从 flash 取指的核都会卡死。
   Core0 平时就是在 flash 里跑代码，所以进 flash 操作前，Core1 通过 FIFO 请 Core0 跳进一个
   `__no_inline_not_in_flash_func`（放 RAM）的小函数，在里面关中断 + 纯 RAM 自旋；
   Core1 拿到 ACK 才动手，干完把 `g_flash_release` 置 1 放行。
   拿不到 ACK（Core0 真挂了）就**拒绝**这次 flash 操作并报错。Core1 自己在 flash 期间也关中断。
4. **Core0 的 WFI 有明确唤醒源。**
   M0+ 的 WFI 必须有中断才会醒。Core0 建了一个 1ms 的 repeating timer 当心跳/唤醒源；
   万一这个闹钟没建起来（alarm pool 满了），代码会退化成忙等而不是睡死。
5. **命令解析不猜、不崩。** 空行什么都不做；参数缺失给用法；命令必须是单字母；
   `R` 带参数会被拒绝（防误触）；长度/地址的进制规则固定（见上）。
6. **采样器为什么放 Core0 而不是 Core1。**
   Core1 的职责是"永不挂死的串口"，让它再去跑 PIO/抽 FIFO 等于把两个风险绑在一起。
   放 Core0 之后，采样器跑飞就是"Core0 挂死"——恰恰是本固件已被上机验证能扛住的那种故障；
   Core1 只负责下命令（FIFO + 超时）和把 16384 行 hex 从 USB 吐出去。
   数据交换用**共享 RAM 里的一个结果结构体 + 单字 ACK**：结果字段有十来个，全塞 FIFO（只有 8 深）
   容易和别的请求互相插队。
7. **采样器保留 252 MHz 超频（vreg 1.25V）。**
   上位机 `tools/tmds_sampled_decode.py` 里 `PROBE_CLK_HZ = 252.0e6` 是**硬编码**的，报告也写着
   "固件只能产生 252MHz/clkdiv" ⇒ 采样率是**契约**，不能偷偷改。
   超频只在 **Core1 启动之前**做一次（做完才 launch Core1），所以监视器那套"永不挂死"的性质
   一点没被削弱 —— Core1 服务 USB 期间时钟不再变化；USB 用的是独立的 clk_usb(48MHz)。
   而且用 `set_sys_clock_khz(..., false)`（尽力而为）：万一上不去就留在默认时钟继续跑并如实报告，
   **绝不在启动阶段 panic**（那时 Core1 还没起来，panic 就等于又要人手按 BOOTSEL）。
8. **采集前先倒掉 FIFO 存货。** SM 从上电起就在跑，FIFO 早就满了、RXSTALL 也早就置位过；
   倒掉 + 清标志之后，"丢样标志"才只反映**本次窗口内**，缓冲里也是一段连续的新数据
   （代价是窗口之前少 <16 个采样，见第 6 节）。
9. **`usb_kick()` 必须限速。** 等 Core0 的自旋循环里如果每次迭代都 `irq_set_pending()`，
   主循环几乎全部时间都耗在 ISR 里；所以改成 1ms 一踢（`usb_kick_throttled()`）。
10. **采样器看门狗：Core0 不允许被采样路径弄死。**
    1ms 心跳闹钟兼当看门狗：采样操作超预算就在中断里立 `abort`，采样循环（capture / measure）
    看到就退出，Core1 收到"被中止"，而不是被拖死。
    这是 v1.1 被真板打脸之后补的 —— 教训写在文件头和第 0 节：
    **凡是"直到满足某条件"的循环，都要先问"这条件会不会永远不成立"。**
    （Core1 侧同时保留了心跳体检：超时后能区分"真挂死 / 活着但没答请求 / 被中止"。）

---

## 6. 已知限制 / 注意事项

* **不能写自己正在跑的 flash 范围**（见上），换固件请用 `B` + picotool。
* **Core0 挂死时不能写 Flash**（会被拒绝）：写 flash 需要 Core0 进 RAM 停车位，挂了就停不进去。
  这也意味着 `X` 之后不能写 flash —— 先 `R`/`B` 恢复正常。
* **写 Flash 期间 USB 会短暂停顿**：Core1 关中断，每个 4KB 扇区大约 40~50 ms（32KB 约 0.4 s）。
  上位机看到的只是"卡一下"，不会掉线。
* **`E` 要求 4KB 对齐**：不对齐会直接拒绝并告诉你它落在哪个扇区，避免"顺手"擦掉邻居数据。
* **`F` 会擦掉覆盖到的整个扇区**：同一个扇区里 `addr` 之前的数据也一起没了（Flash 物理特性）。
* **`len` 上限 32768 字节**：RAM 缓冲区限制。大文件请分多次写。
* **暂停时 Core0 只是 WFI**：它会继续响应中断（这是 `C` 能生效的前提），并不是"冻结整个核"。
  要观察 Core0 的现场请用 `r` 读 SRAM。
* 上位机串口工具请关闭本地回显；**命令必须以 CR/回车结尾**。
* **采样器（Core0）相关**：
  * `s`/`d`/`c`/`m`/`g` 都需要 Core0 活着；`P` 暂停或 `X` 挂死时它们会明确报出来（不会假死）。
  * **上电默认 `clkdiv = 12`**（不是满速）。`c1` 会丢样（PIO 比 CPU 抽得快），只适合做压力/回归测试。
  * **采样器看门狗**：capture 800ms / measure 500ms / 其它 200ms 为预算；超了报 `aborted (status=1)`，
    Core0 不会因此死掉。这是 v1.1.1 补的兜底。
  * **`d` 会在采集前把 FIFO 里已有的字（≤4 个）倒掉**，让缓冲从干净的新数据开始：
    代价是时间轴开头少掉 <16 个采样（**在窗口之前**），换来的是"窗口内部连续" +
    "丢样标志只反映窗口内"。比旧 DMA 方案（窗口内部断裂）严格更好。
  * **采样缓冲是 16384 字固定大小**（64 KB，静态分配）。要更大的包得改 `SAMP_WORDS` 重新编译。
  * **写 Flash 期间采样会丢样**：XIP 关闭时 PIO 还在跑，但没人抽 FIFO（Core0 在停车位里）。
    采样与写 Flash 不要同时用。
  * **主频与采样率的契约**：`fs = sys_clk / clkdiv`，而固件会把 sys_clk 超到 **252 MHz**
    （见第 5 节）。`S` 会如实报 `overclock: OK/FAILED`；万一某颗板子上不去，采样率就不是 252MHz/clkdiv 了，
    送分析脚本时要按实际 sys_clk 换算。

---

## 7. 自己重新编译

一条命令（推荐，`tools/build_sub.ps1` 会自动处理工具链/平台/板级，并把 elf 转 uf2）：

```powershell
cd C:\Users\Chen\Desktop\Pico\PicoPhone\DeepSeekCode
pwsh -NoProfile -File tools\build_sub.ps1 core1_monitor
```

> ⚠️ 别给这条命令接管道（本机沙箱禁止子进程输出走管道）。
> 该脚本检测到旧 `build\CMakeCache.txt` 会先自动清理，避免上次的平台参数残留。

手工跑的话（等价）：

```powershell
$cmake="$env:USERPROFILE\.pico-sdk\cmake\v3.31.5\bin\cmake.exe"
$ninja="$env:USERPROFILE\.pico-sdk\ninja\v1.12.1\ninja.exe"
$sdk="$env:USERPROFILE\.pico-sdk\sdk\2.3.0"
$tc="$env:USERPROFILE\.pico-sdk\toolchain\13_3_Rel1"
$env:PICO_SDK_PATH=$sdk; $env:PICO_TOOLCHAIN_PATH=$tc; $env:PATH="$tc\bin;$env:PATH"
& $cmake -G Ninja -S core1_monitor -B core1_monitor\build -DCMAKE_MAKE_PROGRAM="$ninja" `
  -DPICO_SDK_PATH="$sdk" -DPICO_PLATFORM=rp2040 -DPICO_BOARD=pico `
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY
& $cmake --build core1_monitor\build
```

`pico_add_extra_outputs()` 会顺带生成 `.uf2`；如果只想单纯从 elf 转一次：

```powershell
& "$env:USERPROFILE\.pico-sdk\picotool\2.3.0\picotool\picotool.exe" uf2 convert -t elf `
  core1_monitor\build\core1_monitor.elf core1_monitor\build\core1_monitor.uf2
```

> `CMakeLists.txt` 开头那段 `sdkVersion / toolchainVersion / picotoolVersion / pico-vscode.cmake`
> 是**必须**的：没有它，SDK 会去现场编译 pioasm/picotool 这些主机工具，然后因为找不到主机 C++ 编译器而失败
> （`sampler.pio` → `sampler.pio.h` 这一步正是靠它提供的 pioasm）。
> 那段代码会把 `PICO_TOOLCHAIN_PATH` 指到 `15_2_Rel1`（比命令行里给的 `13_3_Rel1` 优先），两个工具链都在的话都能编过。

---

## 8. 上机自测清单（拿到板子后按顺序做）

**第一轮：监视器/自救（v1.0 已通过，回归时再跑）**

1. 烧 `core1_monitor.uf2`，打开串口 ⇒ 看到 banner 和 `mon>`。**开机不应该需要按任何键。**
2. `S` ⇒ 有 sys_clk、Flash 大小、JEDEC ID、Core0 心跳在涨。
3. `r 0 4` / `r 20000000 8` / `r 10000000 4` ⇒ 都能读出数；`r 40000000 1` ⇒ 被拒绝（不是崩掉）。
4. `P` ⇒ Core0 暂停；`S` 显示 PAUSED；`C` ⇒ 恢复。来回几次确认状态没跑偏。
5. **灵魂测试**：`X`（Core0 故意挂死）⇒
   * `S` 应显示心跳冻结；
   * `P` 应报 `Core0 no response` 而**串口不死**；
   * `R` `B` 仍然有效。
6. `E 101FF000` ⇒ 擦除成功、verify 是 0 个非 0xFF；再 `r 101FF000 4` ⇒ 全 `FFFFFFFF`。
7. `F 10100000 16 H` 按例子敲 16 个字节 ⇒ 写出 + 校验 OK；然后 `r 10100000 4` 看数据对不对。
8. `F 10000000 256` / `E 10000000` / `F 10000000 256`（镜像内）⇒ 都应被拒绝。
9. `B` ⇒ 串口消失、出现 `RP2` 盘 ⇒ 拖任意 UF2 能烧进去（证明"再也不用按 BOOTSEL"）。
10. 断电重上电 ⇒ 还能进 `mon>`。

**第二轮：采样器（v1.1 新增，重点）**

11. `S` ⇒ `overclock : OK`，且 `sys_clk : 252000000 Hz`。
    若显示 FAILED，先别往下测采样率，把这一屏贴回来（采样率契约变了）。
12. **接线**：探针 GPIO0..7 ← 待测板 GPIO0..7，外加共地；待测板在跑 DVI 输出。
13. `g` ⇒ 五次读数里 `changes` **不为 0** ⇒ 线是活的。
    若一直是同一个静态值，先查接线/待测板有没有在输出（这一步能把"线的问题"和"PIO 的问题"分开）。
14. `s` ⇒ `sm enabled=1`、`fdebug` 有值；注意两个 `rxstall` 的区别（见第 3 节）。
15. `c12` ⇒ 打印 `clkdiv=12.00` 和 `21000 kSa/s`（若显示 3072.00 之类的怪数字，是位域解码又错了）。
16. `m` ⇒ `moved` 应该接近 `expect`，并看 **窗口内的 `RXSTALL`**：
    * 出现 `WARN: ... samples WERE lost` ⇒ 把 `clkdiv` 加大（`c16` / `c32`）再来一次，直到没有这个警告；
    * `moved` 远小于 `expect` ⇒ 瓶颈在抽 FIFO 这一侧，同样加大 `clkdiv`。
17. **回归测试（v1.1.1 修的那个 bug）**：故意发 `c1`（满速，PIO 63 Mwords/s > CPU 抽取能力），
    然后连发 `m` 和 `d`：
    * 期望：**Core0 不能死**。`m`/`d` 要么正常返回并报 `rxstall`/丢样警告，要么明确报"被中止"；
    * 无论哪种，之后 `S` 的 **`core0` 心跳必须仍在涨**；若报 `FROZEN`，说明这个 bug 又回来了。
18. `d` ⇒ 应该看到 `captured 16384 words ...`、`nonzero=16384/16384`、`BEGIN 16384 0` / 16384 行 hex / `END`。
    **把这一屏存成 txt，直接喂 `tools/tmds_sampled_decode.py`**（格式与旧固件一致，见第 3 节）。
19. **合并的意义（重点）**：在待测板还在输出的情况下 `X`（Core0 故意挂死）⇒
    * `d` / `s` 应报 `Core0 ... hung`（并且 `s` 会用心跳告诉你"真挂死"还是"没答请求"）；
    * `S` / `r` / `P` / `B` **照常可用**；
    * `B` 能进 BOOTSEL。⇒ 采样器挂了也不用按按键。
20. `P` 之后敲 `d` ⇒ 应立刻提示 `Core0 is PAUSED -- send C to resume it first`（不白等超时）。

有任何一条不符合预期，请把那一屏原样贴回来（固件输出全是 ASCII，不会因为编码炸掉）。
