# core1_monitor —— 探针板 Core1 串口调试监视器（穷人版 SWD）

**解决的问题**：探针板（13 元的 RP2040 核心板）没有引出 SWD，唯一的通道是 USB 串口 + BOOTSEL。
一旦固件跑挂（Core0 卡在死循环里），串口就没人应答了，只能靠人手按 BOOTSEL 才能救回来。
本固件把**串口服务整个搬到 Core1**，于是 **Core0 死不死都不影响串口**；`P`（暂停）/`B`（进 BOOTSEL）
在任何状态下都可用。

产物：`core1_monitor/build/core1_monitor.uf2`（约 94 KB，RP2040 family）。

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
因为固件自己会回显你敲的字符（开了会看到双份），并且请用**行模式/单字符即时发送**（不要等回车才发）。

打开后应该看到：

```
=== core1_monitor 1.0 : Core1 serial debug monitor (poor man's SWD) ===
USB CDC is serviced by Core1. Core0 never touches stdio.
Type ? for help.
mon>
```

---

## 2. 命令表

| 命令 | 作用 |
|---|---|
| `?` | 帮助 |
| `S` | 状态：sys_clk、Core0 是否被暂停/挂死、Flash 大小 + JEDEC ID |
| `r <addr> [n]` | 读 n 个 32 位字（n ≤ 64，默认 1） |
| `w <addr> <val>` | 写一个 32 位字（**只允许 SRAM**） |
| `P` | 暂停 Core0（Core0 进 WFI 等命令；Core1 照常服务） |
| `C` | 继续 Core0 |
| `R` | 重启设备（`watchdog_reboot`） |
| `B` | 重启进 BOOTSEL（`reset_usb_boot`）——**灵魂功能，任何状态下都能用** |
| `E <addr>` | 擦除包含该地址的 4KB 扇区（**addr 必须 4KB 对齐**） |
| `F <addr> <len> [H]` | 擦除 + 写入 len 字节 + **读回校验**（`H` = 十六进制文本输入） |
| `X` | **自测用**：故意让 Core0 挂死（关中断 + 死循环），验证监视器不受影响 |

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
monitor   : core1_monitor 1.0, this is Core1
sys_clk   : 125000000 Hz
peri_clk  : 125000000 Hz
flash     : build limit 2048 KB, JEDEC id EF4015, chip 2048 KB
usable    : up to 10200000
image     : 10000000..1000bbec (writing here is refused on purpose)
core0     : running, heartbeat 48213 -> 48234
            ok: alive (~21 ticks/20ms)
core-fifo : status 00000000 (rx not empty = 0)
```

`JEDEC id EF4015` = 厂商 `EF`(Winbond) / 类型 `40` / 容量 `15`(=2MB)。
Core0 挂死时这一行会变成：

```
core0     : running, heartbeat 48213 -> 48213
            WARN: heartbeat frozen -> Core0 looks hung
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
* 上位机串口工具请关闭本地回显。

---

## 7. 自己重新编译

在 `DeepSeekCode` 目录下（PowerShell）：

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
> 是**必须**的：没有它，SDK 会去现场编译 pioasm/picotool 这些主机工具，然后因为找不到主机 C++ 编译器而失败。
> 那段代码会把 `PICO_TOOLCHAIN_PATH` 指到 `15_2_Rel1`（比命令行里给的 `13_3_Rel1` 优先），两个工具链都在的话都能编过。

---

## 8. 上机自测清单（拿到板子后按顺序做）

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
8. `F 10000000 256` ⇒ 应被拒绝（头 4KB 保护）。
9. `E 10000000` ⇒ 应被拒绝（boot2 保护）。
10. `F 10000000 256`（镜像范围内）⇒ 应被拒绝并提示用 BOOTSEL。
11. `B` ⇒ 串口消失、出现 `RP2` 盘 ⇒ 拖任意 UF2 能烧进去（证明"再也不用按 BOOTSEL"）。
12. 断电重上电 ⇒ 还能进 `mon>`。

有任何一条不符合预期，请把那一屏原样贴回来（固件输出全是 ASCII，不会因为编码炸掉）。
