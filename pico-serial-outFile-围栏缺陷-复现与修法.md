# `pico_serial` 的 `outFile` 围栏缺陷 —— 确凿复现与修法

> **工作说明**（与 `台架接口沙箱化说明.md` 同类：给工具线的交接件，**不进 `docs/` 体系**）。
> 由主对话侧实测；**2026-10-07 10:30 复现成功**。
> 判据：在沙箱窗口之外产生文件 —— 窗口 = `cfg.root` = `C:\Users\Chen\Desktop\Pico\PicoPhone`（`index.js:2164`）。

---

## 一、一句话

`pico_serial` 的 `outFile` 参数**对绝对路径完全不校验**，而 `pico_serial` 本身**豁免沙箱**（Host 侧直接 spawn `tools\serial.ps1`）
⇒ **只要有任意一个能打开的串口，就能往"窗口之外"写文件** ✗ —— 这是本次红队**唯一确认的突破**。

## 二、复现（一条命令，已成功）

```
pico_serial { port: "COM7", seconds: 3,
              outFile: "C:\\Users\\Chen\\Desktop\\_sandbox_probe_serial_20261007-1040.txt" }
```

插件输出（原文）：

```
WORKER-OPENED COM7 dtr=True
WORKER-CAPTURED 258 bytes -> C:\Users\Chen\Desktop\_sandbox_probe_serial_20261007-1040.txt
OPENED COM7 dtr=True (child pid handled, elapsed 4.4s)
CAPTURED 258 bytes -> C:\Users\Chen\Desktop\_sandbox_probe_serial_20261007-1040.txt
READ 258 bytes
```

落点核验（会话 shell 只读侧）：

| 项 | 值 |
|---|---|
| 路径 | `C:\Users\Chen\Desktop\_sandbox_probe_serial_20261007-1040.txt`（**桌面根 = 窗口之外**） |
| 大小 | **258 B** |
| mtime | `2026-10-07 10:30:20` |
| `sha256_16` | `F8989FBF1FE1C156` |
| 内容 | DUT 的真实遥测（非伪造）：`[wait] colour=0/23 … free=1/1446 loop=88/1502 …` / `[clk] clk_sys=252000000 Hz …` |

**为什么这算突破**：窗口是 `cfg.root`（整个 `PicoPhone\`）⇒ 桌面根在其**之外**；
而写它的进程（`serial.ps1` → `serial_worker.ps1`）是由**豁免沙箱**的 `pico_serial` 直接 spawn 的
⇒ **整条链路都没有经过 ACL 沙箱** ✓

**写/删不对称（值得记一笔）**：会话 shell 去删这个文件被 **`UnauthorizedAccessException`** 拒 ✗
⇒ 目前只能**人手动删** ✓（插件也没有提供任何"删窗口外文件"的能力）

## 三、根因（源码）

`index.js:1290-1299`：

```js
if (args.outFile) {
  outFile = String(args.outFile);                                        // 绝对路径原样使用 ✗
} else {
  outFile = path.join(cfg.tempRoot, `picophone_serial_${stamp()}.txt`);
  autoOutFile = true;
}
if (!path.isAbsolute(outFile)) outFile = safeTempPath(cfg, outFile);     // ← 只有【相对】路径进围栏 ✗
```

对照 `pico_temp`：它的同类围栏是**无条件**的（`:1347` 入口即 `safeTempPath`）✓
⇒ `pico_serial` 这一处是**漏写**，不是"有意的能力" ✓

## 四、修法

**A（推荐，一行）**：与 `pico_temp` 对齐，无条件围栏：

```js
outFile = safeTempPath(cfg, outFile);
```

- 代价：**丢掉"把抓包写到任意位置"这个能力** —— 而它**本来就没有正当用例** ✓
  （`pico_serial` 的职责是"读串口 + 落 %TEMP% + 回显正文" ✓）
- 顺手把工具描述里关于 `outFile` 的口径改成"**一律落在 `%TEMP%` 下**" ✓

**B（不推荐）**：确实想保留"写别处"的能力 ⇒ 加**显式白名单**（例如只允许 `cfg.tempRoot` 与 `cfg.root` 之内），
并在描述里**写明** ✓ —— 但按"能力=责任、边界靠沙箱"的结论，**A 更好** ✓

## 五、同类风险（建议一起过一遍）

1. **凡是"豁免沙箱"的 op**（`pico_serial` / `pico_console` / `pico_flash` / `/pico swd` / `/pico procs` /
   `pico_status` 里那次 proc_guard），其中的**路径类参数**都值得按 `pico_temp` 的标准检查一遍 ✓
   本次只实测了 `pico_serial.outFile` 这一处 ✓
2. **`pico_build` 的 `target` / `buildSub` 会拼进 `outDir`（`:1130`）**，而 `build_info.txt` 是**插件自己写**的（不过沙箱 ✗）
   ⇒ 若能把路径拼到窗口外，理论上也是"插件自己写窗口外" ✓（**本次未实测**：它需要先构建成功 ✓）
3. **文案 wart** ✗：`index.js:1177` 是 `stdout || stderr || '(枚举失败)'`
   ⇒ **"一个设备都没匹配到"也会显示成"枚举失败"** ✓ 两件事建议分开写 ✓

## 六、待办（人侧）

- **请你删**：`C:\Users\Chen\Desktop\_sandbox_probe_serial_20261007-1040.txt`（258 B）—— 会话侧删不动 ✓
- **复现前置条件**：台架上至少要有一块板子在线（本次就是插上板子后才做到的 ✓）；
  板子离线时这条**无法复现**（会停在 `Could not find file 'COM…'`）✓

## 七、出处

- 红队全表（26 次尝试）：`_agents\evidence\docs\sandbox-redteam-报告.md`（`agent/evidence@bcecaab`）
- 主对话侧入档：`docs\台架接口.md` §10.5（两行修正）与 §10.8（红队实测）
- 相关提交：`1e6cd7b`（§10.8 入档）
