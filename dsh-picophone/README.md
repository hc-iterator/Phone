# dsh-picophone

把 PicoPhone 台架上「每轮都要手打一遍」的接口，装成 DSH 里可以直接调用的能力。

## 装了什么

**9 个 Agent 工具**（模型可直接调用）：

| 工具 | 干什么 | 背后是 |
|---|---|---|
| `pico_status` | 路径 / 工具链版本 / git 分支与干净度 / 2E8A 设备 / **台架锁占用者** / **烧写账本最后一条** / 悬挂进程；`probeSerial: true` 会顺手采 2 秒串口；**同时返回 json**（两轮状态可机器比对） | `tools/proc_guard.ps1 -List` + vswhere + git |
| `pico_build` | 编根固件、子工程、或主机侧自检；返回退出码 + 日志尾 + 产物时间戳；成功时落 `build_info.txt`（源码 commit + 脏否 + 工具链），失败时额外摘**首批 5 条错误** | `tools/build.cmd`、`tools/build_sub.ps1`、`tools/host_test/run_all.cmd` |
| `pico_flash` | 烧 uf2 到 dut/probe/sampler（后门 / BOOTSEL / picotool / **auto**）；**写前核对 BOOTSEL 盘身份**（不匹配硬拒，除非 `force`）；占台架锁；**追加 `debug_logs/flash_ledger.jsonl`** | `tools/flash_backdoor.ps1`、`tools/flash_bootsel.ps1`、`picotool` |
| `pico_serial` | 按 VID:PID 读串口 N 秒、可发字符串；**默认就落盘到 %TEMP% 并把正文回显**；**占台架锁**（并发读会被明确拒绝） | `tools/serial.ps1`（内含 kill-on-close 作业对象 + 硬超时） |
| `pico_console` | **常驻串口会话**：`open` 一次（只付一次 4~5 s 的开口成本）→ `send`/`read`/`expect` 随便用 → `close`；`expect` 支持 `until` 正则，不用猜睡眠；**每行带墙钟时间戳**；空闲超时自动关并释放锁 | 自带 `serial-session.ps1` 常驻 worker（JSON 行协议） |
| `pico_temp` | %TEMP% 下的 ls / read / write / append / stat / mkdir / rm / **cp / mv**；write 支持 `encoding: base64` | `node:fs`，路径被围栏在 %TEMP% 内 |
| `pico_git` | 主仓库或 `_agents/<名字>` 空间里跑 git；写操作要 `mutate: true` | `git -c safe.directory=…` |
| `pico_run` | 跑仓库 `tools/` **或项目 `dsh-plugins/`** 下的任何 ps1/cmd/bat/py（swd、proc_guard、agent_space、check_docs_refs、fps_from_telemetry…） | 直接 spawn |
| `pico_exec` | 跑白名单里的可执行文件（cmake·ninja·git·picotool·**openocd**·python·**node**·**arm-none-eabi-***·**vswhere**·**msbuild**） | 直接 spawn，**子进程 PATH 会自动补上 `~\.pico-sdk` 的 cmake/ninja/toolchain/picotool/openocd 目录 + VS 的 vswhere/MSBuild 目录**（系统 PATH 里没有这些，不补就 ENOENT）。`cl` 不在白名单：它没有 VS 开发环境（INCLUDE/LIB）跑不起来，MSVC 那条路走 `pico_build host-test` |

**1 个人工命令**：`/pico` —— 上面全部能力外加 `swd` / `procs` / `docs` / `agents` / `lock` 子命令。
输入 `/pico help` 看用法。

## 为什么叫「越权」

插件跑在 Host 进程里，直接 `spawn`，**不经过会话 shell 的沙箱**。所以
CMake/ninja/VS 工具链、烧写 uf2、读串口、%TEMP% 读写都能真正落地 —— 这正是它的用途，
也意味着这些能力不受沙箱约束。围栏放在插件内部：

- 全部子进程 `windowsHide: true`（不弹窗）+ 硬超时，超时杀整棵进程树；
- `pico_run` 只允许仓库 `tools/` 下的脚本；`pico_exec` 只允许白名单可执行文件（**不含 shell**）；
- `pico_temp` 只允许 %TEMP% 内的路径；`pico_exec` 的 cwd 只允许项目目录或 %TEMP%；
- `pico_git` 对 commit/push/reset/checkout 等写操作要求显式 `mutate: true`；
- 输出统一截断（头 60% + 尾 40%），不会把整份日志塞进上下文。

## 配置

`cordis.patch.yml` 的 `config` 可覆盖默认值（不填就用插件里的默认）：

```yaml
- insert:
    - id: picophone
      name: dsh-picophone
      config:
        root: 'C:\Users\Chen\Desktop\Pico\PicoPhone'
        repo: null            # 默认 <root>\DeepSeekCode
        tempRoot: null        # 默认系统 %TEMP%
        powershell: 'pwsh'
        python: 'python'
        timeoutMs: 900000     # 构建默认超时
        maxOutputChars: 14000 # 单次结果截断长度
        profileName: 'web'    # Host 里探不到 profile 名时手填（见「已知事项」的 A/B 对照）
        serialKeep: 20        # pico_serial 自动落盘的抓包最多留几份（只删 picophone_serial_*.txt）
        allowExec: ['cmake', 'ninja', 'git', 'picotool', 'openocd', 'python']
        devices:
          dut: { vid: '2E8A', pid: '0009' }
          probe: { vid: '2E8A', pid: '000C' }
          sampler: { vid: '2E8A', pid: '000A' }
```

## 安装 / 卸载

安装（在当前 profile 里）：

```
plugin_manager install_bundle  target = <这个目录的绝对路径>
```

卸载：

- Agent 侧：`plugin_manager remove_bundle  target = dsh-picophone`；
- 人侧一键：[../uninstall-picophone-plugin.cmd](../uninstall-picophone-plugin.cmd)（双击即可，只撤销本插件加进 profile 的 4 处：
  dependencies 条目、`dsh.profile.bundles` 条目、`- id: picophone` 覆盖行、`node_modules` 软链接；
  **不碰 pnpm、不碰别的插件与依赖、不碰项目源码与 git 仓库**）。
  想看会删什么加 `-DryRun`，想跳过确认加 `-Yes`，想连源码一起删加 `-PurgeSource`。

## 冒烟测试

```
node --check index.js
node smoke-test.mjs      # 假 ctx 注册后逐项调用：读写 %TEMP%、四道围栏、dry-run 烧写、串口枚举、/pico help
```

`smoke-test.mjs` **不碰硬件**（串口只读、烧写只 dry-run），但**不是"只写 %TEMP%"**：
它最后会真跑一次 `pico_build root` —— 那会**覆盖** `<repo>\build\build_info.txt`，并在 `debug_logs\` 下重写构建日志。
不需要构建那一段就加 `--no-build`（或设 `SMOKE_NO_BUILD=1`）；%TEMP% 下的临时目录跑完会自己清理。

## 2026-10-06 需求清单落地情况

来源：DVI 攻坚会话列的 12 条摩擦清单（P0 全做）。每条都在 `smoke-test.mjs` 里跑过，
除非下表另注。

| # | 需求 | 状态 | 落地方式 |
|---|---|---|---|
| 1 | 跨进程台架锁 | ✅ | `$DSH_HOME\picophone.lock`：`wx` 独占创建，内容含 pid / session / 干什么 / 起始时间；占用时**直接报"谁在占、占多久"**，不静默排队；占用进程已死或超过 `lockStaleMs`（默认 10 min）自动接手；`serial` / `flash` / `console` 全走它；`/pico lock [clear]` 看/清 |
| 2 | 板子指纹 + 烧写账本 | ✅（账本未上机） | `pico_build` 成功落 `build_info.txt`（源码 commit + 脏否 + 工具链 + 时间）；`pico_flash` 追加 `debug_logs/flash_ledger.jsonl`（uf2 大小 + sha256 前 16 位 + 源码 commit + 结果 + 哪个会话烧的）；`pico_status` 报"最后烧的是哪份" |
| 3 | 串口会话保持 | ✅ | 新工具 `pico_console` + 常驻 worker `serial-session.ps1`（JSON 行协议）；`open` 只付一次开口成本 |
| 4 | send → until（expect） | ✅ | `pico_console {op:"expect", data:"G\r", escapes:true, until:"MATCH", timeoutMs:3000}`；命中就早返回，超时明确回"超时无匹配（已读 N 字节 / M 行）" |
| 5 | status 自带串口采样 | ✅ | `pico_status {probeSerial:true, probeSeconds:2}` ⇒ 多一栏"板上最近说过的话" |
| 6 | BOOTSEL 盘身份校验 | ✅ | 读盘上 `INFO_UF2.TXT` 的 `Board-ID` 与登记值比对（dut=`RP2350`，probe/sampler=`RPI-RP2`）；不匹配**硬拒**并列出实际看到的盘，只有 `force:true` 才放行 |
| 7 | 抓包带墙钟时间戳 | ✅ | 会话读到的每行前置到达时刻 `HH:mm:ss.mmm`（实测直接看出 `[wait]` 每 ~2.00 s 一条）；`stamp:false` 可关 |
| 8 | 构建失败自动摘首错 | ✅ | 失败时额外回 `file:line: error: …` 前 5 条（含 undefined reference / build stopped） |
| 9 | exec 加 node、run 放行 dsh-plugins/ | ✅ | 两条都加，围栏仍然拒仓库外脚本（实测拒绝 `..\..\子Agent须知.md`） |
| 10 | 返回结构化字段 | ✅ | status / build / flash / serial / console 的结果都附 `json`（工具路径与版本、git head/dirty、端口、锁占用者、最后烧写、构建来源、errors…） |
| 11 | pico_temp base64 + cp/mv | ✅ | `write {encoding:"base64"}`（写解码后的字节）、`op:"cp"` / `op:"mv"`（仍围栏在 %TEMP% 内） |
| 12 | flash `--method auto` | ⚠️ 已实现、**未上机实测** | backdoor → picotool → 都失败时明说"需要人按 BOOTSEL"；真实烧写才算验证 |

### 追加（同一晚，验证会话二次复验抓到的残留）

- **`build_info.txt` 的 `session` 是空的** —— 已修：`ctx` 一路传进 `opBuild` → `writeBuildInfo()`。
  **Host 自己跑出来的那份实测**：`"session": "session-d2113834-3ee8-47f8-8dda-6b2e60b7177c"` ✓
- **`profile` 这一格在 Host 里仍是 `''`** —— 下面是决定性 A/B（同一份代码、同一台机器，只差运行环境）：

  | 谁跑的 | `session` | `profile` |
  |---|---|---|
  | Host 自己（`host.json`） | 真会话号 ✓ | `''` |
  | smoke test（`smoke.json`） | 真会话号 | `'web'` |

  根因：`DSH_PROFILE` / `DSH_SESSION_ID` 这类变量 **Harness 只注入给它派出去的子进程，Host 自己没有**；
  而第二退路 `ctx.get('hmr')?.baseDir` 在现场也探不到 ⇒ 只能留空
  （守卫要求父目录确实叫 `profiles`，**宁可空着也不写一个错的 profile 名**）。
  **手填口子**：`config: { profileName: 'web' }`；`apply` 里现在是
  `cfg.profileName = cfg.profileName || detectProfileName(ctx)` —— 早先写成直接赋值，会把 config 里的值清成 `''`（这是个真缺陷，已修）。
  不填就留空：状态页不显示它，只出现在锁文件、`build_info.txt` 与烧写账本里。

## 2026-10-06 晚 · 验证会话报的两条 + 自逮两条

**验证会话（重启后那一代）报的：**

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| ① | 锁文件里 `"session": "(unknown)"`、`"profile": ""` | Host 进程的 env 里**没有** `DSH_SESSION_ID`（Harness 只把它注入给派出去的子进程），而插件读的是 Host 自己的 `process.env` | 改成从**工具调用上下文**取：`exec.agent.id` → 退路 `ctx.get('agents').currentInitiator()` → 再退路 env → 都没有就写一句人话（不再写 `(unknown)`）。锁定文案现在形如 `会话=session-xxxx · profile=web` |
| ② | 时间戳会骗人：open 后隔 8 秒再读，4 组 `[wait]/[clk]` 全挤在 5 毫秒内 | worker 只在收到 `read` 时才排空串口，之前的数据堆在驱动缓冲里、一次性吐、一次性盖戳 | worker 改成**持续排空**：主循环每 ~20ms 把端口里的字节搬进行缓冲，**按到达时刻逐行打戳**；`read` 只从缓冲取。实测：不读 6 秒后一次读回 11 行、**8 个互不相同的到达时刻**（`18:54:17.352 … 18:54:21.087`，2 秒周期清清楚楚） |

**修这两条时自逮的两条（都是我自己写出来的）：**

| 坑 | 现象 | 根因 / 修法 |
|---|---|---|
| 🔴 `[Console]::In.ReadLineAsync()` 是**同步阻塞**实现 | 插件只发一条 `open` 就永远等不到回应（20 s 超时）；手动一次灌 4 行命令却"看着正常" | .NET 的 `Console.In` 是 `SyncTextReader`，其 `ReadLineAsync()` ≡ `Task.FromResult(ReadLine())` ⇒ **取下一行会在处理当前行之前就卡住**。改成用 `StreamReader` 包 `OpenStandardInput()`（真异步），并且**处理完当前行才去取下一行** |
| 🔴 脚本作用域变量撞车 | `read` 回显的 `bytes` 是 `"71,13,168,…"` 一串数字 | `send` 分支里 `$bytes = ...GetBytes(...)` 落在脚本作用域，把累计计数 `$script:bytes` 覆盖成字节数组（那串正好是 `G\r` 的字节）。改名为 `$payloadBytes` |

> 教训一句话：**PowerShell 里的"异步"和 C# 里的"异步"不是一回事**，涉及等待/排空的循环必须真异步；
> 而脚本作用域的变量在分支里随手一写，就能污染同名状态。

## 已知事项

- 🔴 **凡是读 `process.env.DSH_*` 的分支，smoke test 会给出与真实运行【相反】的答案。**
  因为 smoke 本身就是 Harness 派出去的子进程 —— 它泡在有这些变量的环境里，而 **Host 自己没有**。
  同一个坑已经骗过两次：
  | 字段 | smoke 看到的 | Host 自己写出来的 |
  |---|---|---|
  | `session` | 真会话号 | `(unknown)`（第一版） |
  | `profile` | `'web'` | `''` |

  ⇒ **规则**：这类字段一律从 `ctx` / 调用上下文取；**要验它，只能看 Host 自己产出的文件**
  （台架锁、`build_info.txt`、烧写账本），**别拿 smoke 的输出当证据**。
  〔这条要不要进项目 `docs\陷阱.md` 由主线决定 —— 本插件只在自己的 README 里留档。〕

- **改了源码要重启 DSH 才生效**。Host 插件的模块代际是进程级缓存：`plugin_manager` 的
  关/开、甚至 `remove_bundle` + `install_bundle` 都不会重新 import（实测两次都仍是旧代码）。
  改完先用 `node smoke-test.mjs` 验（那是全新模块），再挑时间重启。
- **2026-10-06 已修、待重启生效的三处**：
  ① `pico_exec` 子进程 PATH 没带工具链目录 ⇒ ninja/openocd/arm-none-eabi-*/vswhere/msbuild 全 ENOENT
     （`pico_status` 用绝对路径所以显示 ✓，两处口径不一致）；现在统一由 `discoverToolDirs()` 注入。
  ② `pico_serial` 读到了字节却不显示正文 ⇒ 现在默认落盘 + 回显。
  ③ `noUf2: true` 描述过度承诺 ⇒ 子工程 CMake 的 `pico_add_extra_outputs()` 本来就会让 ninja 生成 uf2，
     该参数只省掉 `build_sub.ps1:119` 那次多余转换；描述已按事实改写。
- 输出里的 ANSI 颜色转义已由 `stripAnsi()` 剥掉（同属"待重启生效"）。
- `pico_run` 跑 `who_can_i_reuse.ps1` 这类 `Format-Table` 脚本时，列宽按 PowerShell 重定向默认宽度截断，
  中段会显示 `…`；需要完整表格就用 `pico_exec` 调 `python`/自己解析文件。
- 🔴 **PowerShell 参数不许叫 `-Pid`**：`$PID` 是只读自动变量，赋值抛
  `Cannot overwrite variable Pid because it is read-only or constant`，端口会静默变成空串。
  `serial-session.ps1` 第一版就踩了这个坑（`tools\serial.ps1` 当年也是），现在用 `-ProductId`。
- `pico_console` 同一时刻只允许一个在途请求（串口本来就是串行的）；并发调用会被告知"还有一个请求在途"。
- **`pico_serial` 每读一次会在 %TEMP% 落一份抓包**（`serial.ps1` 只在给了 `-OutFile` 时才写正文，所以插件自己补一个），
  久了会攒成几十个 ⇒ 现在每次读完**顺手剪枝**：只留最近 `serialKeep`（默认 20）份，
  且只认 `picophone_serial_*.txt` 这一种名字，别的一律不碰（实测 30 → 20）。
  `pico_console` 的会话读**不落盘**（从内存缓冲取），所以不受影响。

