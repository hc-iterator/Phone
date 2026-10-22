# dsh-picophone 工具逻辑清单

> 逐工具清点 `C:\Users\Chen\Desktop\Pico\PicoPhone\dsh-plugins\dsh-picophone\`（`index.js` 1972 行，
> 辅以 `serial-session.ps1` 258 行、`cordis.patch.yml`、`package.json`）。
> 本文只描述**代码里真实存在**的行为；每条关键结论给 `文件:行号`（未写文件名的一律指 `index.js`）。
> 生成时间：2026-10-06。**只读分析，未运行任何工具、未碰硬件。**

---

## 0. 总览与共同约定

### 0.1 注册了什么

| 类别 | 数量 | 证据 |
|---|---|---|
| Agent 工具 | **9 个** | `buildToolDefinitions()` 返回 9 个 `tool(...)`：`index.js:1570-1758`（status/build/flash/serial/console/temp/git/run/exec） |
| 人侧命令 | 1 个 `/pico` | `index.js:1960-1967` |

⚠️ **注释与代码不一致（照抄，不美化）**：文件头 `index.js:7-8` 写「Agent 工具（8 个）」且只列到 `pico_exec`，**漏了 `pico_console`**；
`cordis.patch.yml:2` 也写「注册 8 个 pico_* 工具」。**实际代码是 9 个**（`index.js:1570-1758`，其中 `console` 在 `index.js:1664-1686`）。

工具名由 `tool()` 拼成 `pico_<name>`：`index.js:1552`。
执行入口统一：`index.js:1561-1564` —— `sessionId` 取自 `exec?.agent?.id ?? cfg.agentsService?.currentInitiator?.()?.id ?? null`。

### 0.2 配置默认值（`DEFAULTS`，`index.js:43-99`）

| 键 | 默认值 | 行号 |
|---|---|---|
| `root` | `C:\Users\Chen\Desktop\Pico\PicoPhone` | `44` |
| `repo` | `null` ⇒ 解析为 `<root>\DeepSeekCode` | `45`, `164` |
| `tempRoot` | `null` ⇒ 解析为 `os.tmpdir()` | `46`, `165` |
| `python` / `powershell` | `python` / `pwsh` | `47-48` |
| `timeoutMs` / `shortTimeoutMs` | `900000` / `120000` | `49-50` |
| `maxOutputChars` | `14000` | `51` |
| `extraPath` | `[]`（空 = 自动探测 `~\.pico-sdk`） | `53` |
| `toolVersions` | cmake `v3.31.5`、ninja `v1.12.1`、toolchain `15_2_Rel1`、picotool `2.3.0`、openocd `0.12.0+dev` | `55-61` |
| `lockPath` | `null` ⇒ `$DSH_HOME\picophone.lock`（无 `DSH_HOME` 则 `~\.dsh\picophone.lock`） | `63`, `457-461` |
| `lockStaleMs` | `600000`（10 分钟） | `64` |
| `profileName` | `''`（可手填） | `66` |
| `sessionIdleMs` / `sessionOpenTimeoutMs` | `120000` / `20000` | `68-69` |
| `serialKeep` | `20` | `71` |
| `boardIds` | `dut: RP2350`、`probe: RPI-RP2`、`sampler: RPI-RP2` | `73` |
| `devices` | `dut` = `2E8A:0009` serial `C7771D72049EEF63`；`probe` = `2E8A:000C` serial 空；`sampler` = `2E8A:000A` serial `503558607A848D9F` | `74-78` |
| `allowExec` | cmake, ninja, git, picotool, openocd, python, py, arm-none-eabi-{gcc,g++,objdump,objcopy,nm,size}, vswhere, msbuild, node（共 16 项） | `81-98` |

`allowExec` 在 `resolveConfig` 里被**强制小写**：`index.js:167`。
`cfg.devices` 与 `DEFAULTS.devices` 做浅合并（可局部覆盖）：`index.js:166`。

### 0.3 三条横切机制

1. **子进程 PATH 前缀**：`discoverToolDirs()`（`105-156`）扫 `~\.pico-sdk\{cmake,ninja,toolchain,picotool,openocd}`，
   首选版本排最前、其余按名称倒序；再用 `vswhere -latest -property installationPath` 找出 VS 的 MSBuild 目录（`144-153`）。
   结果拼进 `toolPathPrefix`（`169`），由 `spawnEnv()` 前置到 `PATH`（`745-752`）。
2. **硬超时 + 杀进程树**：`runProcess()`（`256-356`）统一 `windowsHide:true`、stdout/stderr 各封顶 `4 MiB`（`286`）、
   超时后 `killTree()`（`242-253`）用 `taskkill /PID <pid> /T /F` 杀整棵树。
3. **输出裁剪**：`clip()`（`193-198`）超长时保留前 60% + 后 40%，中间写 `... [省略 N 字符] ...`；
   ANSI 转义由 `stripAnsi()` 去掉（`176-178`）；解码优先 UTF-8，失败退 GBK（`180-191`）。

---

## 1. `pico_status`

| 项 | 值 |
|---|---|
| 参数 | `probeSerial`（boolean，可选）、`probeSeconds`（number，可选，见 §1.2）、`probeTarget`（`dut`\|`probe`\|`sampler`，可选） |
| 默认值 | 无 `default` 字段；`probeSeconds` 实测默认 **2**（`1079`），`probeTarget` 默认 **`dut`**（`1082`） |
| 必填 | 无（`required` 未设置，`1576-1583`） |

### 1.1 正向行为

实现 `opStatus`（`977-1088`）。它**不 spawn 任何项目脚本**去改状态，只读 + 调 `proc_guard.ps1 -List`。输出分 8 段：

| 段 | 内容 | 行号 |
|---|---|---|
| 路径 | `root` / `repo` / `tempRoot` / `_firmware_backup\fw_full_153154.uf2` 的 `大小 B + mtime` / `_agents` 目录名列表 | `980-986` |
| 工具链 | 5 个绝对路径 + 存在与否（`✓`/`✗`）；SDK 路径**硬编码 `sdk\2.3.0`**（`992`，与 `toolVersions` 无关） | `989-999` |
| 版本 | 依次跑 `cmake --version`、`ninja --version`、`gcc -dumpfullversion`、`picotool version`、`python --version`（各 30 s 超时），取首行前 120 字 | `1001-1017` |
| VS | `vswhere -latest -property displayName` | `1019-1027` |
| PATH 前缀 | 打印 `toolPathPrefix` 的每个目录 | `1030-1031` |
| git | 仅 `main`：`rev-parse --abbrev-ref HEAD`、`log --oneline -1`、`status --porcelain` ⇒ `干净` / `脏(N 项)` | `1035-1043` |
| 设备 | `Get-PnpDevice -PresentOnly` 过滤 `VID_2E8A`，只列 `InstanceId` | `1047-1059` |
| 台架锁 | 锁文件内容 + `lockHolderText()` | `1062-1065` |
| 烧写账本 | 末尾 3 条 | `1067-1071` |
| 悬挂进程 | `tools\proc_guard.ps1 -List`（60 s 超时），输出裁到 4000 字 | `1074-1076` |
| 可选串口采样 | `probeSerial:true` 时调 `opSerial`（默认 `dut`、2 s） | `1078-1085` |

返回：`{ ok:true, exitCode:0, text, json }`（`1087`）。`json` 结构见 `979`：
`{ paths, tools, git, ports, lock, lastFlash, probe }`。

### 1.2 与 schema 描述不一致处（照抄代码）

schema 说 `probeSeconds`「default 2 s」（`1581`）—— 代码确实是 `2`（`1079`），一致。
但 schema **没有** `default` 关键字，默认值只存在于代码里（`1079`、`1082`）。

### 1.3 失败返回

`opStatus` 本身**没有 `ok:false` 分支**：所有子步骤失败都被转成文本（例如枚举失败写 `(枚举失败)`，`1057`；
`proc_guard` 无输出写 `(无输出)`，`1076`）。唯一会失败的是 `/pico status` 命令层的 try/catch：
`执行失败: <message>`（`1941-1943`）。

---

## 2. `pico_build`

| 项 | 值 |
|---|---|
| 参数 | `target`（string）、`buildSub`（string）、`noUf2`（boolean）、`cacheArgs`（string[]）、`timeoutMs`（number） |
| 默认值 | `target` → 代码 `'root'`（`1091`）；`buildSub` → 代码 `'build'`（`1122`）；`timeoutMs` → `cfg.timeoutMs` = 900000（`1092`） |
| 必填 | `['target']`（`1594`） |

### 2.1 正向行为（三条分支）

**A. `target` ∈ {`host-test`,`host_test`,`hosttest`}**（`1095`）
- 跑 `tools\host_test\run_all.cmd`（`1096-1097`），返回其 exit code 与输出。

**B. `target` ∈ {`root`,`PicoPhone`,`main`}**（`1101`）
- 跑 `tools\build.cmd`（`1102-1103`）。
- 读 `debug_logs\build_log.txt`（`1104-1110`），返回**日志尾部 40 行**（`1104`、`1114`）。
- 产物信息取 `build\PicoPhone.uf2`（`1115`）。
- **成功时**写 `build\build_info.txt`（`1111`）；**失败时**额外给「首批错误」（`1112`、`1118`）。

**C. 其它 = 子工程**（`1122-1136`）
- 参数拼装：`<target> -BuildSub <buildSub>`（`1123`），`-NoUf2`（`1124`），`-CacheArgs <...>`（`1125-1127`）。
- 跑 `tools\build_sub.ps1`（`1128-1129`）。
- 产物目录 `<repo>\<target>\<buildSub>`，列出其中所有 `.uf2`（`1130`、`1133`、`424-433`）。
- **成功时**写 `<outDir>\build_info.txt`（`1131`）。

### 2.2 副作用（写哪些文件）

- `<productDir>\build_info.txt`（仅当 `res.ok` 为真）：`writeBuildInfo()`（`654-671`）。
  字段：`target`、`builtAt`(ISO)、`source`{branch, head, subject, dirty}（`repoStamp()` `600-614`）、
  `toolchain`（= `cfg.toolVersions`）、`node`(process.version)、`session`、`profile`（`655-663`）。
- 构建脚本自己写的日志（`debug_logs\build_log.txt` 等）—— 由脚本负责，插件只读。

### 2.3 失败返回（穷尽）

| 原文 | 触发条件 | 行号 |
|---|---|---|
| `不支持的脚本类型: ${scriptPath}` | 脚本扩展名不是 `.ps1/.cmd/.bat/.py`（发生在 `runProjectScript` 内） | `398` |
| `首批错误` 段内的条目 | 构建失败时从日志/stdout/stderr 抽前 5 条 | `726-738`, `1112`, `1118`, `1132`, `1135` |

`firstErrors()`（`726-738`）的匹配规则：`<file>.<ext>:<line>[:<col>]: (error|fatal error|Error): <msg>`，
或含 `undefined reference to` / `multiple definition of` / `ninja: build stopped` / `FAILED:` 的行（`728`、`734`）。

> 注意：**`opBuild` 没有自己的 `ok:false` 早退分支**（除脚本类型那条间接路径）；
> 失败只体现为 `ok = res.ok`、`exitCode = res.exitCode`（`1098`、`1119`、`1136`）。

---

## 3. `pico_flash`

| 项 | 值 |
|---|---|
| 参数 | `board`（`dut`\|`probe`\|`sampler`）、`firmware`（string）、`method`（`backdoor`\|`bootsel`\|`picotool`\|`list`\|`auto`）、`force`（boolean）、`skipVolumeCheck`（boolean）、`dryRun`（boolean）、`timeoutMs`（number） |
| 默认值 | `method` → 代码 `'backdoor'`（`1140`）；`timeoutMs` → `cfg.shortTimeoutMs` = 120000（`1141`）；`board` 缺省时内部按 `'dut'` 处理（`1157`, `1166`, `1195`, `1218`, `1233`, `1256`） |
| 必填 | `['board']`（`1625`） |

### 3.1 正向行为

- **`method:'list'`**（`1144-1155`）：跑 `tools\flash_backdoor.ps1`（无参数，60 s 超时）+ 枚举 BOOTSEL 盘，
  **不取锁**。返回 `json.volumes`。
- **dryRun**（`1181-1190`）：按 method 打印将要执行的命令（`planFor()` `1175-1179`）+ 盘身份核对结果，**不碰硬件**。
  `auto` 会打印 `backdoor` 与 `picotool` 两条。
- **真刷**（`1195-1256`）：
  1. 取台架锁（`1195-1196`），**finally 里释放**（`1226-1228`）。
  2. `auto` 时依次试 `backdoor` → `picotool`（`1204`）；`picotool` 无 firmware 则跳过（`1206-1209`）；
     `picotool`/`bootsel` 且盘身份没过则跳过（`1210-1213`）。
  3. 实际调用：`picotool load -x <firmware>`（`1214`）／`tools\flash_bootsel.ps1 [-Firmware x]`（`1216`）／
     `tools\flash_backdoor.ps1 -Board <board> [-Firmware x]`（`1218-1220`）。
  4. 追加账本条目（`1231-1244`），见 §6。

### 3.2 围栏/安全

| 机制 | 说明 | 行号 |
|---|---|---|
| 盘身份核对 | `checkBootVolume()` 读每个盘的 `INFO_UF2.TXT` 的 `Board-ID`，与 `boardIds[board]` 比对 | `703-722` |
| 不匹配 | **硬拒**：`拒绝烧写 ✗ BOOTSEL 盘身份不匹配…` 并列实际看到的盘 | `715-721` |
| `force:true` | 放行，但文本带 `⚠️ 强制作业：盘身份不匹配…` | `714` |
| `skipVolumeCheck:true` | 完全跳过核对，文本 `(按要求跳过盘身份核对)` | `1166` |
| 无 BOOTSEL 盘 | 返回 `kind:'none'`；`backdoor`/`auto` 下改写成「预检：当前没有 BOOTSEL 盘 —— 正常…」 | `709`, `1167-1173` |
| 盘枚举范围 | 只扫盘符 `C:`–`Z:`（`67`–`90`） | `682` |
| firmware 解析 | 非绝对路径时按 `cfg.repo` 解析 | `1159` |

### 3.3 失败返回（穷尽）

| 原文 | 触发条件 | 行号 |
|---|---|---|
| `固件不存在: ${firmware}` | 给了 firmware 但路径不存在 | `1160` |
| `method=${method} 需要 firmware。` | 非 `backdoor`/`auto` 方法且未给 firmware（`dryRun` 之后判断） | `1191-1192` |
| `台架被占用 ✗ …`（整段） | 锁被别人持有且非陈锁 | `554-560`，经 `1196` 返回 |
| `台架锁创建失败: <msg>` | `openSync(file,'wx')` 非 `EEXIST` 错误 | `540` |
| `台架锁竞争失败（重试后仍被占）` | 两轮尝试后仍失败 | `563` |
| `拒绝烧写 ✗ BOOTSEL 盘身份不匹配（期望 <board> → Board-ID "<want>"，实际看到：…）本台架没引出 RUN 脚，BOOTSEL 按钮是唯一救援手段；写错板代价很大。确认无误要强来就加 force: true。` | 盘在但 `Board-ID` 不等于登记值且未 `force` | `715-721` |
| `⚠️ 强制作业：盘身份不匹配（期望 <board> → "<want>"）` | `force:true` 且不匹配（`ok:true`，但文本警告） | `714` |
| `当前没有 BOOTSEL 盘（找不到 INFO_UF2.TXT）。` | 一个盘都没有（`kind:'none'`；backdoor/auto 下会被改写） | `709` |
| `backdoor 与 picotool 都没成 ⇒ 需要人按 BOOTSEL（本台架没引出 RUN 脚，按钮是唯一救援）` | `auto` 且全失败时的「下一步」段 | `1253-1255` |
| `(账本写入失败)` | 账本追加抛错 | `1250`（`appendFlashLedger` 返回 false，`620-628`） |

`attempts` 里会出现这些**跳过原因**文本（`1207`、`1211`）：
`picotool: 跳过（没给 firmware）`、`<m>: 跳过（当前没有 BOOTSEL 盘）`、`<m>: 跳过（盘身份没通过）`。

---

## 4. `pico_serial`

| 项 | 值 |
|---|---|
| 参数 | `target`（enum）、`port`、`vid`、`pid`、`seconds`（number）、`send`（string）、`escapes`（bool）、`outFile`（string）、`list`（bool）、`timeoutMs`（number） |
| 默认值 | `target` → 代码 `'dut'`（`1271`）；`seconds` → 代码 `5`（`1280`）；`timeoutMs` → `cfg.shortTimeoutMs` = 120000（`1260`） |
| 必填 | 无（`1648`） |

### 4.1 正向行为

调 `tools\serial.ps1`（`1302`、`1309`），参数拼装：

- `list:true` → `-List`（`1265`），**不取锁**、不落盘（`1301-1304`）。
- 否则：`-Port <port>`（`1268`）或 `-Vid <vid> -ProductId <pid>`（`1276`）；
  `-Seconds <n>`（`1281`）；`-Send <text> [-Escapes]`（`1282-1285`）；
  **总是**加 `-OutFile`（`1298`）——未给 `outFile` 时自动用 `%TEMP%\picophone_serial_<stamp>.txt`（`1294`）。
- 相对 `outFile` 会被 `safeTempPath()` 强制落在 `%TEMP%` 内（`1297`、`435-439`）。
- 返回文本含 `落盘`（路径）与 `读到的内容`（该文件末尾 120 行，`1311-1314`）。

> 代码注释说明理由：`serial.ps1` 只在给 `-OutFile` 时才把正文落盘，stdout 里只有 `READ n bytes`（`1286-1287`）。

### 4.2 围栏/安全

- **台架锁**：取锁 `serial <label>`（`1306`），失败返回 `json:{locked:true}`（`1307`），
  **finally 释放**并在自动落盘时清理旧抓包（`1316-1319`）。
- **抓包轮转**：`pruneSerialCaptures()` 只删 `%TEMP%` 下匹配 `^picophone_serial_.*\.txt$` 的文件，
  保留最近 `serialKeep`（默认 20）份（`209-234`，`71`）。

### 4.3 失败返回（穷尽）

| 原文 | 触发条件 | 行号 |
|---|---|---|
| `未知目标 ${target}；请给 target(dut\|probe\|sampler) 或 vid+pid，或直接给 port。` | 未给 `port`，且目标不在 `devices` 表里 / 表里没有 vid 或 pid | `1275` |
| `台架被占用 ✗ …` 等锁文本 | 锁被占用 | `1307`（文本来自 `554-560`/`540`/`563`） |
| `路径越出 %TEMP%: ${rel}`（抛错→被 `opTemp`/`opSerial` 捕获或冒泡） | `outFile` 相对路径解析后落在 `%TEMP%` 之外 | `437` |

> `opSerial` 自身没有把 `serial.ps1` 的非零退出码转成 `ok:false` 的特判：直接 `ok = res.ok`（`1303`、`1315`）。

---

## 5. `pico_console`

| 项 | 值 |
|---|---|
| 参数 | `op`（`open`\|`send`\|`read`\|`expect`\|`close`\|`list`）、`sessionId`、`target`、`port`、`baud`、`data`、`escapes`、`until`、`timeoutMs`、`stamp` |
| 默认值 | `op` → 代码 `'list'`（`941`）；`sessionId` → 代码 `'default'`（`829`、`942`）；`baud` → 代码 `115200`（`890`）；`timeoutMs` → 代码 `2000`（`910`）；`stamp` → 代码「不 false 就是 true」（`913`、`230`）；`target` → 代码 `'dut'`（`882`） |
| 必填 | `['op']`（`1671`） |

### 5.1 正向行为与常驻 worker

`pico_console` 不直接开串口，而是**拉起常驻子进程** `<插件目录>\serial-session.ps1`（`838`、`845-850`），
用**一行一个 JSON** 的协议通信（`775-794` 写、`796-826` 读）。
worker 侧协议与事件定义：`serial-session.ps1:15-23`。

| op | 行为 | 行号 |
|---|---|---|
| `list` | 列内存中的会话（id / port / owner / 起于 / 空闲秒数 / 活着） | `944-949` |
| `open` | 已有同名活会话则直接复用（`830-834`）；否则取锁 → 起 worker → 发 `open`（`828-901`） | `828-901` |
| `send` | 发 `{cmd:'send',data,escapes}`，15 s 请求超时 | `903-907` |
| `read` | 发 `{cmd:'read',timeoutMs,until,stamp}`，请求超时 = `timeoutMs + 8000` | `909-922` |
| `expect` | 先 `send`（若给了 `data`）再 `read`；**必须有 `until`** | `960-969` |
| `close` | 发 `{cmd:'close'}` + 关 stdin + 800 ms 后 `killTree` | `924-938` |

worker 侧关键实现：**持续排空**（主循环每轮调 `Pump`，`serial-session.ps1:90-101`、`251-252`），
按**到达时刻**逐行打戳 `HH:mm:ss.fff`（`74-87`）；`read` 只从行缓冲取（`103-144`）。
缓冲上限 5000 行（`40`、`85`）。DTR/RTS 打开时强制拉高（`183-184`）。

### 5.2 围栏/安全

- **台架锁**：`open` 时取锁（`835`）；锁随会话持有，`close` 或子进程退出时释放（`878`、`936`）。
- **空闲自动关闭**：`sessionTouch()` 重置 `sessionIdleMs`（默认 120 s）定时器，到点调 `sessionClose(..., '空闲超时自动关闭')`（`765-772`、`68`）。
- **一问一答互斥**：同一会话同时只允许一个在途请求，否则回 `busy`（`775-780`）。

### 5.3 失败返回（穷尽）

| 原文 | 触发条件 | 行号 |
|---|---|---|
| `会话 ${s.id} 还有一个请求在途，稍后再试。` | 并发请求同一会话 | `778` |
| `会话 ${s.id} 在 ${timeoutMs}ms 内没有任何回应（端口卡住或板子没反应）。` | 请求超时 | `783` |
| `写入会话失败: <msg>` | 向 worker stdin 写入抛错 | `791` |
| `会话错误: ${event.message}` | worker 回 `{"event":"error"}` | `819` |
| `缺少 ${worker}` | 找不到 `serial-session.ps1` | `841` |
| `启动会话进程失败: <msg>` | spawn worker 抛错 | `853` |
| `<worker 的 open 错误文本>\n子进程 stderr（前 1500 字）:\n…\n（实测 open 本身要 4.5~4.7s；超时多半是端口被占或在 BOOTSEL 里没跑应用）` | `open` 请求失败 | `894-897`（文本在 `897`） |
| `台架被占用 ✗ …` 等锁文本 | 锁被占用 | `836` |
| `没有会话 ${id}。` | `close` 一个不存在的会话 | `926` |
| `没有会话 ${id}；先用 op:"open" 打开（open 要 4~5 秒，但只用付一次）。` | `send`/`read`/`expect`/`close` 时会话不存在或子进程已退出 | `954-955` |
| `expect 需要 until（正则）。` | `op:'expect'` 未给 `until` | `961` |
| `未知 op: ${op}（open/send/read/expect/close/list）` | op 不在枚举内 | `972` |

worker（`serial-session.ps1`）自己会回的 `error` 文本（会以 `会话错误: …` 呈现）：

| worker 原文 | 触发条件 | 行号 |
|---|---|---|
| `read failed: <msg>` | 排空端口时抛错 | `99` |
| `bad json` | stdin 行不是合法 JSON | `164` |
| `找不到端口（VID/PID 没匹配到，或端口没给）` | `Resolve-Port` 返回空 | `175` |
| `open failed: <msg>` | `SerialPort.Open()` 抛错（**被占用时会永久阻塞**，见 `serial-session.ps1:25`） | `188` |
| `port not open` | `send`/`read` 时端口未打开 | `201`、`225` |
| `write failed: <msg>` | 写端口抛错 | `219` |
| `unknown cmd: ${cmd}` | 未知 `cmd` | `244` |

另外 `sessionRead` 的**超时无匹配**不是错误（`ok:true`），文本：
`超时无匹配（读了 N 字节 / M 行；不是"没打印"就是板子没反应）：`（`918-921`）。

### 5.4 已知坑（worker 注释照抄要点）

- `serial-session.ps1:9-13` —— 必须**持续排空**，否则 8 秒里每 2 秒一条的 4 组输出会挤在 5 ms 内，**时间戳会骗人**。
- `serial-session.ps1:25` —— `Open()` 在被占用时**永久阻塞**，父进程必须靠超时 + 杀进程树兜住。
- `serial-session.ps1:26`、`50-52` —— 参数名**不能**叫 `-Pid`（`$PID` 只读），故用 `-ProductId`。
- `serial-session.ps1:148-153` —— ①`[Console]::In.ReadLineAsync()` 是**同步阻塞**实现 ⇒ 只发一条 `open` 永远等不到回应；②取下一行必须放在处理完当前行之后。
- `serial-session.ps1:212-213` —— `send` 分支变量**不能**叫 `$bytes`，会污染累计计数 `$script:bytes`。
- `serial-session.ps1:122-128` —— 超时时把没等到换行的**残行**也交出去，免得"发完没下文"看起来像丢数据。

---

## 6. `pico_temp`

| 项 | 值 |
|---|---|
| 参数 | `op`（`path`\|`ls`\|`read`\|`write`\|`append`\|`stat`\|`mkdir`\|`rm`\|`cp`\|`mv`）、`path`、`from`、`content`、`encoding`（`utf8`\|`base64`）、`maxBytes`（number） |
| 默认值 | `op` → 代码 `'path'`（`1342`）；`maxBytes` → 代码 `200000`（`1344`） |
| 必填 | `['op']`（`1694`） |

### 6.1 正向行为（`opTemp`，`1341-1425`）

| op | 行为 | 行号 |
|---|---|---|
| `path` | 返回 `cfg.tempRoot` | `1352` |
| `ls` | 目录则列前 400 项（`DIR/FILE` + 大小 + mtime）；文件则给 `artifactInfo` | `1354-1370` |
| `stat` | 类型/大小/修改时间 | `1372-1376` |
| `read` | 只显示**末尾** `maxBytes` 字节（超限时附注 `[只显示末尾 N / M 字节]`） | `1378-1384` |
| `write`/`append` | `encoding:'base64'` 时先解码再写；`write` 覆盖、`append` 追加 | `1386-1401` |
| `cp`/`mv` | `copyFileSync` / `renameSync`（两端都过 `safeTempPath`） | `1403-1411` |
| `mkdir` | 递归创建 | `1413-1416` |
| `rm` | `rmSync(target, {recursive:true, force:true})` | `1418-1422` |

### 6.2 围栏

**路径围栏**：入口处 `safeTempPath()`（`1347`、`435-439`），`isInside()`（`236-240`）按解析后的绝对路径判前缀，
抛错文本 `路径越出 %TEMP%: ${rel}`（`437`）。`cp`/`mv` 的 `from` 也单独校验（`1404`）。

### 6.3 失败返回（穷尽）

| 原文 | 触发条件 | 行号 |
|---|---|---|
| `路径越出 %TEMP%: ${rel}` | 路径逃出 `%TEMP%`（被 catch 后原样回） | `437` → `1348-1350` |
| `不存在: ${target}` | `ls` / `stat` / `read` / `rm` 目标不存在（**四处同一句话**） | `1355`、`1373`、`1379`、`1419` |
| `源不存在: ${from}` | `cp`/`mv` 源不存在 | `1406` |
| `未知 op: ${op}` | op 不在枚举内 | `1424` |

---

## 7. `pico_git`

| 项 | 值 |
|---|---|
| 参数 | `repo`（string）、`args`（string[]）、`mutate`（boolean）、`timeoutMs`（number） |
| 默认值 | `repo` → 代码 `'main'`（`442-443`）；`args` → 代码 `['status','--short','--branch']`（`1430`）；`timeoutMs` → 代码 `120000`（`1440`） |
| 必填 | `['args']`（`1713`） |

### 7.1 正向行为

`opGit`（`1427-1443`）：
- 仓库解析 `resolveRepoArg()`（`441-448`）：`''`/`main`/`DeepSeekCode` ⇒ `cfg.repo`；其它当作 `_agents\<name>`。
- 组参 `gitArgsFor()`：`-c safe.directory=<root 正斜杠>/* -C <dir>`（`450-452`）。
- 跑 `git`（`1441`），输出经 `describeRun`。返回 text + exitCode。

### 7.2 围栏/安全

**写操作闸门**：`mutating` 列表共 20 个动词（`1431`）：
`commit, push, pull, fetch, reset, checkout, switch, merge, rebase, add, rm, mv, stash, clean, tag, branch, revert, cherry-pick, gc`。
取**第一个不以 `-` 开头的 token** 作 verb（`1432`）；命中且 `mutate !== true` 即拒（`1433-1439`）。

### 7.3 失败返回（穷尽）

| 原文 | 触发条件 | 行号 |
|---|---|---|
| `非法空间名: ${key}` | 解析后的目录不在 `<root>\_agents` 内 | `445` |
| `空间不存在: ${dir}` | `<root>\_agents\<name>` 不存在 | `446` |
| `git ${verb} 会改变仓库状态。确认后带 mutate: true 重试（仓库: ${dir}）。` | 写动词且未给 `mutate:true` | `1434-1438` |

> 这两条 `throw` 会被 `opGit` 的调用方（工具层）冒泡；`/pico git` 在 `dispatchCommand` 的 try/catch 里变成 `执行失败: <msg>`（`1941-1943`）。

---

## 8. `pico_run`

| 项 | 值 |
|---|---|
| 参数 | `script`（string）、`args`（string[]）、`timeoutMs`（number） |
| 默认值 | `timeoutMs` → 代码 `cfg.shortTimeoutMs` = 120000（`1461`） |
| 必填 | `['script']`（`1730`） |

### 8.1 正向行为

`opRun`（`1447-1464`）：相对 `cfg.repo` 解析脚本（`1450`），按扩展名分派
（`.ps1`→`pwsh -NoProfile -NonInteractive -File`，`.cmd`/`.bat`→`cmd /c`，`.py`→`python`，`shellFor()` `373-379`、`382-403`）。

### 8.2 围栏

允许根**只有两个**：`<repo>\tools` 与 `<root>\dsh-plugins`（`1451`），用 `isInside()` 判定（`1452`）。
扩展名白名单 `SCRIPT_EXT = {.ps1,.cmd,.bat,.py}`（`1445`、`1455`）。

### 8.3 失败返回（穷尽）

| 原文 | 触发条件 | 行号 |
|---|---|---|
| `需要 script（相对仓库的脚本路径，例如 tools/build.cmd）。` | `script` 为空 | `1449` |
| `只允许运行仓库 tools/ 与项目 dsh-plugins/ 下的脚本；被拒绝: ${scriptPath}` | 路径不在两个允许根内（例如 `..\..\`） | `1453` |
| `只允许 .ps1/.cmd/.bat/.py；被拒绝: ${scriptPath}` | 扩展名不在白名单 | `1456` |
| `脚本不存在: ${scriptPath}` | 文件不存在 | `1458` |
| `不支持的脚本类型: ${scriptPath}` | 走到 `runProjectScript` 的兜底分支 | `398` |

---

## 9. `pico_exec`

| 项 | 值 |
|---|---|
| 参数 | `file`（string）、`args`（string[]）、`cwd`（string）、`input`（string）、`timeoutMs`（number） |
| 默认值 | `cwd` → 代码 `cfg.repo`（`1473`）；`timeoutMs` → 代码 `cfg.shortTimeoutMs` = 120000（`1482`） |
| 必填 | `['file']`（`1746`） |

### 9.1 正向行为

`opExec`（`1466-1485`）：取 `path.basename(file)` 去掉 `.exe` 并小写（`1469`），查 `allowExec` 白名单（`1470`），
`runProcess(file, args, { cwd, timeoutMs, input })`（`1483`）。
`input` 会写进子进程 stdin（`256-257`、`349-354`）。

### 9.2 围栏/安全

- **白名单**：`cfg.allowExec`（16 项，见 §0.2），大小写不敏感（`167`、`1470`）。
- **cwd 围栏**：必须落在 `cfg.root` 或 `cfg.tempRoot` 内（`1476`）。
- 注释说明：**不放 shell**，也不放 `cl`（`79-80`、`1742`）。

### 9.3 失败返回（穷尽）

| 原文 | 触发条件 | 行号 |
|---|---|---|
| `需要 file（白名单内的可执行文件）。` | `file` 为空 | `1468` |
| `不在白名单内: ${base}\n允许: <列表>` | basename 不在 `allowExec` | `1471` |
| `cwd 必须落在项目目录或 %TEMP% 内；被拒绝: ${resolved}` | `cwd` 解析后越界 | `1477` |

---

## 10. 人侧 `/pico` 命令

### 10.1 注册与解析

- 注册：`name:'pico'`、`input.hint`、handler 把 `invocation.rawInput` 交给 `dispatchCommand`
  （`1960-1967`），`sessionId` 取 `invocation.agent?.id ?? null`（`1965`）。
  （占用者摘要文本见 `lockHolderText()` `480-487`。）
- 解析：`line.trim().split(/\s+/)`（`1805`）；`parseFlags()`（`1783-1802`）把 `--key value` 收进 Map，
  `--key` 后紧跟另一个 `--` 或结尾时值为 `true`。
- 返回包装：`ok ? {kind:'success'} : {kind:'error'}`（`1812`）；整体 try/catch ⇒
  `执行失败: <msg>`（`1941-1943`）。

### 10.2 子命令与旗标映射

| 子命令 | 别名 | 映射到 | 旗标 | 行号 |
|---|---|---|---|---|
| `help` / `?` / 空 | — | 直接回 `HELP` | — | `1806`、`1810` |
| `status` | `env` | `opStatus` | `--probe`、`--seconds N`、`--target <板>` | `1816-1826` |
| `lock` | — | 内联：`clear`/`unlock`/`--force` ⇒ 删锁；否则报告占用者 | — | `1827-1839` |
| `console` | — | `opConsole` | `--data`、`--until`、`--timeout ms`、`--target`、`--port`、`--esc`、`--no-stamp`；位置参数 `rest[1]`=sessionId、`rest[2..]`=data | `1840-1857` |
| `build` | — | `opBuild` | `--sub`、`--no-uf2`/`--nouf2`、`--D<名字>[=值]` ⇒ `-D<名字>[=值]` | `1858-1871` |
| `flash` | — | `opFlash` | `--list`、`--method`、`--dry`/`--dry-run`；位置 `rest[0]`=board、`rest[1]`=firmware | `1872-1883` |
| `serial` | — | `opSerial` | `--list`、`--send`、`--esc`/`--escapes`、`--out`；位置 `rest[0]`=target、`rest[1]`=秒数 | `1884-1896` |
| `swd` | — | `opSwd`（**原样转发**给 `tools\swd.ps1`） | — | `1897-1898` |
| `procs` | `guard` | `opProcs` | 位置 `tail[1]`=COM 号 ⇒ `-WaitFree` | `1899-1903` |
| `temp` | — | `opTemp` | 位置：`tail[0]`=op、`tail[1]`=相对路径、`tail[2..]` 拼成 content | `1904-1909` |
| `git` | — | `opGit` | `--mutate`；`rest[0]` 为 `main`/`agent`/`agent/...`/存在的空间名时被当作 repo | `1910-1922` |
| `run` | — | `opRun` | — | `1923-1925` |
| `exec` | — | `opExec` | — | `1926-1928` |
| `docs` | — | `opDocs` | 位置 `tail[0]`=action | `1929-1932` |
| `agents` | — | `opAgents` | `--force`、`--recreate`；`rest[1]`=name | `1933-1937` |
| 其它 | — | `未知子命令: ${verb}\n\n${HELP}` | — | `1938-1939` |

### 10.3 只在命令侧存在的 4 个子命令

`swd` / `procs`（别名 `guard`）/ `docs` / `agents` 没有对应的 Agent 工具，只从 `/pico` 到达
（`1530-1544` 的 `OPS` 表里它们在，但 `buildToolDefinitions()` 没为它们建工具，`1570-1758`）。

### 10.4 `dispatchCommand` 的失败返回（穷尽）

| 原文 | 触发条件 | 行号 |
|---|---|---|
| `用法: /pico run <tools下的脚本> [参数...]` | `run` 无参数 | `1924` |
| `用法: /pico exec <白名单可执行文件> [参数...]` | `exec` 无参数 | `1927` |
| `未知子命令: ${verb}\n\n${HELP}` | 未列出的子命令 | `1939` |
| `已删除台架锁 ${file}`（成功文本）／`删除失败: <msg>` | `lock clear` 的成/败 | `1833`、`1835` |
| `台架被占用: …` ／ `台架空闲（${file} 不存在）` | `lock` 查询 | `1838` |
| `执行失败: <msg>` | 任何子命令抛错（含 `opGit` 的空间名错误等） | `1942` |

`HELP` 全文在 `1762-1781`。注意 HELP 第 `1780` 行列了 9 个工具名（含 `pico_console`），
**与文件头注释的「8 个」不一致**（见 §0.1）。

---

## 11. 台架锁（横切）

| 项 | 内容 | 行号 |
|---|---|---|
| 锁文件路径 | `cfg.lockPath` 优先；否则 `$DSH_HOME\picophone.lock`，`DSH_HOME` 缺失则 `~\.dsh\picophone.lock` | `457-461` |
| 获取方式 | `openSync(file,'wx')` **独占创建**，成功即占 | `531-537` |
| 锁内容 | `{token,pid,session,profile,what,since,sinceText}` | `521-530` |
| 陈锁判定 1 | `now - info.since > cfg.lockStaleMs`（默认 600000 ms = 10 min） | `543`、`64` |
| 陈锁判定 2 | `pidAlive(pid)` 为假（`process.kill(pid,0)` 抛非 `EPERM`） | `544`、`463-470` |
| 陈锁处理 | **仅第 0 次尝试**才删锁重试（共 2 轮） | `545-552` |
| 占用文案 | `台架被占用 ✗ …\n  占用者: <what · pid=… · 会话=… · profile=… · 起于 … （已占用 Ns）>\n  锁文件: …\n串口/烧写不是可并发资源 —— …` | `553-560`（`return` 在 `554`） |
| 失败文案 | `台架锁创建失败: <msg>`（非 EEXIST）／`台架锁竞争失败（重试后仍被占）`（两轮后） | `540`、`563` |
| 释放 | `releaseRigLock()`：**读到锁文件且 token 相同**才删 | `566-574` |
| 释放时机 | `flash` 在 `finally`（`1226-1228`）；`serial` 在 `finally`（`1316-1319`）；`console` 在 `open` 失败时（`896`）、子进程 `close` 事件（`875-879`）、`sessionClose`（`936`） | 同左 |

**哪些 op 会占锁**：
`pico_flash`（真刷，非 `list`/`dryRun`，`1195`）、`pico_serial`（非 `list`，`1306`）、`pico_console` 的 `open`（`835`）。
**不占锁**：`pico_status`、`pico_build`、`pico_temp`、`pico_git`、`pico_run`、`pico_exec`、
`pico_flash method:'list'`、`pico_serial list:true`、`pico_console list/send/read`（后三者复用已持有的锁）。

---

## 12. 烧写账本与 build_info.txt（横切）

### 12.1 `debug_logs\flash_ledger.jsonl`（JSONL，一行一条）

- 路径：`<repo>\debug_logs\flash_ledger.jsonl`（`616-618`）。
- 写入：`appendFlashLedger()` 追加一行 JSON（`620-628`），**每次真刷都写一条**（成功或失败）。
- 字段（`1231-1243`）：`timeText`、`board`、`method`、`ok`、`exitCode`、`firmware`（= 指纹对象）、
  `source`（= `repoStamp()`）、`session`、`profile`、`pid`、`attempts`。
- 指纹对象由 `firmwareFingerprint()` 产生（`586-598`）：`path`、`name`、`exists`、`bytes`、`mtime`、
  `sha256_16`（sha256 前 16 位十六进制，`578-584`）。
- 读取：`flashLedgerTail(cfg, 3)` 取末尾 3 条，解析失败退化成 `{raw: line}`（`630-645`、`647-651`）；
  被 `pico_status` 使用（`1069-1071`）。
- README 标注：**账本「未上机」**（`README.md:96`）。

### 12.2 `build_info.txt`（JSON）

- 路径：**构建成功时**写到产物目录 —— 根工程是 `<repo>\build\build_info.txt`（`1111`），
  子工程是 `<repo>\<target>\<buildSub>\build_info.txt`（`1131`）。
- 写入函数 `writeBuildInfo()`（`654-671`）：内容 `{target, builtAt, source{branch,head,subject,dirty},
  toolchain(=cfg.toolVersions), node, session, profile}`（`655-663`）。
- 摘要文本 `buildInfoText()`：`<branch>@<head><(脏)|(干净)> · <subject> · 构建于 <time>`（`673-676`）。
- **失败不写**：`res.ok` 为假时不调用（`1111`、`1131`）。

---

## 13. 已知边界 / 未实测项（照抄注释与 README 要点）

| 项 | 原文要点 | 出处 |
|---|---|---|
| 锁文件与 `session` 的来源 | 「⚠️ Host 进程的 env 里**没有** `DSH_SESSION_ID`（Harness 只把它注入给派出去的子进程），所以第一顺位才是正路；取不到时写成一句人话，不写 `(unknown)`」 | `488-500` |
| `profile` 取不到时 | 「宁可留空，也不要写个错的」；退路 `ctx.get('hmr')?.baseDir` 需父目录确实叫 `profiles` | `502-516` |
| `profileName` 赋值 | 「⚠️ 必须是 `cfg.profileName \|\| …`：直接赋值会把 config 里手填的 profileName 清成 `''`」 | `1952-1953` |
| `-ActiveLines` 无关（本插件） | — | — |
| 参数名不能叫 `-Pid` | worker 注释：`$PID` 只读 ⇒ 端口会变空串 | `serial-session.ps1:26`、`50-52` |
| `Open()` 阻塞 | 「⚠️ `Open()` 在被占用时会**永久阻塞**——父进程必须用超时 + 杀进程树来兜住它（插件里做了）」 | `serial-session.ps1:25` |
| 时间戳必须按到达时刻 | 「必须**持续排空**……否则时间戳会骗人」 | `serial-session.ps1:9-13` |
| `Console.ReadLineAsync` 坑 | 「.NET 的 `Console.In` 是 `SyncTextReader`……改成用 `StreamReader` 包 `OpenStandardInput()`」 | `serial-session.ps1:148-153` |
| `$script:bytes` 撞车 | 「`send` 分支里 `$bytes` 落到脚本作用域，把累计计数覆盖成字节数组」 | `serial-session.ps1:212-213` |
| 刷写前置 | 「盘身份核对（#6）：这一条是清单里**唯一能砸硬件的**」 | `1162` |
| 无 RUN 脚 | 「本台架没引出 RUN 脚，BOOTSEL 按钮是唯一救援手段」 | `720`、`1254` |
| `method:'auto'` | README：**「⚠️ 已实现、未上机实测」** —— 「backdoor → picotool → 都失败时明说『需要人按 BOOTSEL』；真实烧写才算验证」 | `README.md:106` |
| 烧写账本 | README：「✅（**账本未上机**）」 | `README.md:96` |
| smoke test 的局限 | README：「🔴 凡是读 `process.env.DSH_*` 的分支，smoke test 会给出与真实运行【相反】的答案」 | `README.md:147` |
| `DSH_PROFILE` 在 Host 里为空 | README 的 A/B 对照表：Host 跑出来 `profile` 为 `''`，smoke test 为 `'web'` | `README.md:112-124` |

---

## 14. 代码与注释/文档不一致之处（照抄事实，不推测意图）

| 处 | 注释/文档说 | 代码实际 |
|---|---|---|
| 工具数量 | `index.js:7-8`「Agent 工具（8 个）」且未列 `pico_console`；`cordis.patch.yml:2`「注册 8 个 pico_* 工具」 | **9 个**（`1570-1758`，`console` 在 `1664-1686`）；`HELP` 里 `1780` 行列了 9 个 |
| SDK 路径 | `toolVersions` 里没有 SDK 版本键（`55-61`） | `pico_status` 把 SDK 路径**硬编码**为 `sdk\2.3.0`（`992`） |
| schema 默认值 | 工具描述里写了默认值（如 `1581`、`1613`） | schema **没有** `default` 关键字；默认值只存在于 `op*` 代码里 |
| `pico_status` 的 `probeSeconds` | 描述「default 2 s」 | 代码也是 2（`1079`）——**一致** |
| `pico_serial` 的 `outFile` | 描述「Defaults to a timestamped file in %TEMP%」 | 代码一致（`1294`），但**即使不指定也一定落盘**（`1290-1299`） |

---

## 15. 本文未做的事

- **未运行任何工具**：没有调用 `pico_*`、没有开串口、没有 SWD、没有烧写、没有构建。
- **未修改主仓库任何文件**：本文只写在本子智能体自己的空间（`_agents\evidence\docs\`）。
- **未读**主仓库 `DeepSeekCode\` 下的实现细节，除了以下几处**只验证存在性**（不读内容）：
  `tools\{build.cmd, build_sub.ps1, host_test\run_all.cmd, flash_backdoor.ps1, flash_bootsel.ps1,
  serial.ps1, swd.ps1, proc_guard.ps1, check_docs_refs.py, doc_patch.py, who_can_i_reuse.ps1,
  sync_agent_spaces.ps1, agent_space.ps1}` —— 全部存在。
- 被调用脚本**内部**的失败分支（例如 `serial.ps1` 自己打印的 `OPEN-TIMEOUT`、`swd.ps1` 的 `HALT-GUARD`）
  **不属于本插件代码**，本文只在「插件如何转述」层面提及，未逐条清点。
