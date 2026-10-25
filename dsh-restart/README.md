# dsh-restart

## 这是什么

给 Agent 和人一个**可靠重启 DSH Host** 的能力：Agent 调工具 `dsh_restart`（人敲 `/restartdsh`），延迟后停掉 3080 监听进程、重新拉起，**重启完成后把结果作为一条消息回送给当初发起的那条会话**。

- **入口**：`index.js` 的 `apply()` —— 一处注册工具 `dsh_restart`、`/restartdsh`、`/killdsh`，以及结果回送。
- **运行时落盘**：全部在 `%LOCALAPPDATA%\dsh-restart\` —— doer 脚本 `dsh_restart_doer.ps1`、静默启动 `dsh_restart_silent.vbs`、日志（`dsh_restart_log.txt` / `dsh_restart_plugin.log`）、结果 `dsh_restart_result.json`、请求 `dsh_restart_request.json`。
- **当前不变式（很重要，改代码前先读）**：计划任务的触发器**固定钉在 9999 年**，任务**只靠 `schtasks /run` 执行一次**，绝不靠触发器到点自己响（以前取"现在+5 分钟"⇒ 5 分钟后自己又杀一遍 3080）；**新 Host 启动时 `apply` 会删掉残留任务**；结果回送走 **`agent.followup`** 并带 `source: { kind: 'tool' }`（不能退回 `sessionController.prompt`，那会把通知变成"人类输入"）。
- **改代码必须重启 Host 才生效** —— ESM 模块是进程级缓存，`plugin_manager` 的 enable/disable 只是重挂同一份缓存。

给 Agent 一个**可靠重启 DSH** 的能力（Chen 那边 2026-10-17 提出，2026-10-25 移植到 Rain 这台机器）。

## 它做什么

工具 `dsh_restart`：

1. 把 doer 脚本写到 `%LOCALAPPDATA%\dsh-restart\`，并**写回来自检哈希**；
2. 用 `schtasks` 排定并**立即运行**一个脱离的计划任务（`wscript` 静默 → **绝对路径**的 powershell —— 这正是以前两次失败的点）；
3. doer 等 `delaySeconds`（**工具默认 30s**；`/restartdsh` 传 **5s**）⇒ 杀掉 3080 监听进程 ⇒
   用 `node <dsh>\lib\bin.js web --no-open` 重新拉起（最多试 2 次）⇒ 轮询直到 3080 重新监听（最多 80s）⇒
   写结果 JSON ⇒ 重启后的插件把结果**推回发起会话**（`agent.followup` + `source:{kind:'tool'}`）。
   （曾有 `systemPrompt` 片段兜底 10 分钟，2026-10-25 删除：它在系统提示里，每轮都占上下文、出现/消失各作废一次缓存前缀，而内容与那条消息完全重复。）

## 本机移植时改了什么（2026-10-25）

| 项 | 原来 | 现在 | 为什么 |
|---|---|---|---|
| 脚本目录 | `%TEMP%` | `%LOCALAPPDATA%\dsh-restart\` | **安全**：workspace-write 沙箱下文件工具可写根 = 工作区 + `/tmp` + `tmpdir()`（`dsh-sandbox` 的 `writableRoots`）⇒ `%TEMP%` 根目录 Agent 写得到，而 doer 有一段等待窗口 ⇒ 放那儿等于"改脚本 = 沙箱外任意代码"。另：`%TEMP%` 会被清理 |
| 写文件 | 直接 `writeFileSync` | 写完读回**比 SHA256**，不符即拒绝 | 把"这份确实是我刚写的"变成显式断言 |
| 微信探测 | 轮询 `/.dsh-wechat-plugin/status`，`ok = up && pluginOk` | **整段删掉**，`ok = up` | 本机没有微信插件（实测 404）⇒ 保留会白等 60 秒并把每次都写成 `ok=false`（假故障） |
| 结果文案 | 带"微信插件=FAIL，账号=N" | 只报 `3080 监听` 与 pid 变化 | 同上，不再报不存在的东西 |

**这台机器上没有、也不需要微信插件。** 微信在 Chen 那边只是"最可信的健康信号 + 曾经的播报出口"，两者都已摘除。

## 三个入口

| 入口 | 谁能触发 | 干什么 |
|---|---|---|
| `dsh_restart` 工具 | Agent | 排定重启，默认 **30s** 宽限（让 Agent 把这轮回复说完）；`{dryRun:true}` 只验路径与目标 pid |
| `/restartdsh` 命令 | 只有人能手敲 | 同一条路径，delay **5s**（命令结果即时返回，不用等） |
| `/killdsh` 命令 | 只有人能手敲 | 只杀不拉 |

## 安全阀

- `dsh_restart({ dryRun: true })` —— 只验证路径与目标 pid，**不杀不重启**
- `dsh_restart({ delaySeconds: N })` —— 调整宽限期
- 结果文件：`%LOCALAPPDATA%\dsh-restart\dsh_restart_result.json`（`{at, up, oldPid, newPid, pluginEnabled, accounts, ok}`）
- 日志：`%LOCALAPPDATA%\dsh-restart\dsh_restart_log.txt`（doer）、`dsh_restart_plugin.log`（插件侧）

## 已知限制

- **它杀的是"监听 3080 的那个 pid"**，不是"名叫 dsh 的进程" —— 3080 上跑别的东西时会杀错。
- 重启会让当前会话中断（会话日志持久，重启后恢复）；**正在生成的那一轮会丢**（工具默认留 30 秒宽限让 Agent 说完，人手命令只 5 秒；要改就传 `delaySeconds`）。
- 只支持 Windows（`schtasks` + `wscript` + 绝对路径）。
- 失败兜底：万一拉不起来，手动在任意终端跑 `node C:\Users\Rain\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open`（或 `dsh web --no-open`）。

## 踩过的坑（2026-10-17 实测，都已修）

1. **计划任务里的 `-Delay %1` 会拿到空值** ⇒ 延迟必须**写死进脚本**。
2. **计划任务的环境 PATH 极简** ⇒ 必须用绝对路径 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`。
3. **PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM** ⇒ 结果文件 `JSON.parse` 抛错 ⇒ 读取端一律剥 BOM，写入端用 `[IO.File]::WriteAllText(..., UTF8Encoding($false))`。
4. **计划任务不能跑 `.cmd`**：以登录用户身份运行会显示控制台窗口 ⇒ 用 `wscript.exe //B //Nologo <vbs>` + `sh.Run(cmd, 0, False)`。
5. **重启期间不要查插件状态**：DSH 还没挂载完 ⇒ 查到的 `false` 是假阴性，要**轮询**。
6. **重载 = 重启进程**：ESM 模块无法在进程内卸载，`plugin_manager` 的 enable/disable 只是重挂**同一份缓存**；改插件代码必须重启 DSH。
7. **通知目标**：用户要的是"告诉操作的 Agent"，不是发微信 ⇒ 用 `sessionController.prompt({requestId, sessionId, mode:'queue', content:[...]})` 推进调用工具的会话；会话 id 取 `exec.agent.id`。**（2026-10-25 起这条已废弃**：`prompt` 会把 source 重建成 `kind:'user'`，重启通知在 goal 眼里等同人类输入 ⇒ 改走 `agent.followup` + `source:{kind:'tool'}`，见文首不变式。）
