# dsh-restart

给 Agent 一个**可靠重启 DSH** 的能力（用户 2026-10-17 要求）。

## 它做什么

工具 `dsh_restart`：

1. 把 doer 脚本写到 `%TEMP%\dsh_restart_doer.ps1` 与 `%TEMP%\dsh_restart.cmd`；
2. 用 `schtasks` 排定并**立即运行**一个脱离的计划任务（cmd + **绝对路径**的 powershell —— 这正是以前两次失败的点）；
3. doer 等 `delaySeconds`（默认 25s，让本轮回复先发出去）⇒ 杀掉 3080 监听进程 ⇒
   用 `node <dsh>\lib\bin.js web` 重新拉起（最多试 2 次）⇒ 轮询直到 3080 重新监听（最多 80s）⇒
   查微信插件 `/status` ⇒ 写结果 JSON ⇒ **用微信插件发一条通知**；
4. 重启后的 DSH 里，本插件把结果通过 `systemPrompt` 片段告诉 Agent（10 分钟内有效）。

## 安全阀

- `dsh_restart({ dryRun: true })` —— 只验证路径与目标 pid，**不杀不重启** ✓
- `dsh_restart({ delaySeconds: N })` —— 调整宽限期
- 结果文件：`%TEMP%\dsh_restart_result.json`（`{at, up, oldPid, newPid, pluginEnabled, accounts, ok}`）
- 日志：`%TEMP%\dsh_restart_log.txt`

## 已知限制

- **第一次**由工具触发的重启，发出的通知里**不含**微信那条（因为通知代码要等重启后重新加载才生效）；
  之后的每次重启都会通知。稳妥起见：重启后由 Agent 主动 `notify_wechat` 一条。
- 只支持 Windows（依赖 `schtasks` 与固定的 DSH 安装路径；路径在 `index.js` 顶部集中定义，换机器要改）。
- 重启会让当前会话中断（会话日志是持久的，重启后会恢复）；正在运行的一轮会丢失。
