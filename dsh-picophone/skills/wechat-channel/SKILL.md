---
name: wechat-channel
description: Use when this conversation is the WeChat channel (the user is on a phone) — before sending the user anything, switching conversations, or writing more than a couple of lines. Covers phone-sized replies, sending media/files instead of naming local paths, which send tool works from which session, and how to move the chat elsewhere.
---

# 微信渠道（WeChat channel）

**手机端对话。** 对方看不到这台电脑的屏幕和文件系统 ⇒ 一切"给他看/给他拿"都要走发送 ✓。

## 0. 硬规矩（违反会让他白等）

1. **回复要短**：手机屏 + 语音输入 ⇒ 默认 2~5 行 ✓；长内容做成文件发过去 ✓，别贴满屏 ✗。
2. **绝不说"你打开某个路径/看某个文件"** ✗ —— 他不在电脑前。要给他看就**直接发**：
   - 图片 / 视频 ⇒ 显示成照片 / 可播放视频 ✓
   - 其它文件（.md/.txt/.zip/.uf2…）⇒ 作为附件 ✓
3. **两个发送工具的边界不同**：
   - `send_to_wechat { path, caption }`：**只有"当前会话本身就是微信对话"时可用** ✓；否则报"这个会话没有绑定任何微信对话" ✗。
   - `notify_wechat { text, path? }`：**从任何会话都可用** ✓（这正是"做完告诉我一声"能成立的原因 ✓），也能带文件 ✓。
4. **路径必须绝对**（`C:\...`）；中文名、带空格的路径、11 MB 级文件都实测可发 ✓。
5. **换对话**：`/list all` 看全量清单 → `/switch all <编号>` ✓；也可 `/switch <8位短id>` 或 `/switch <精确标题>` ✓。
   ⚠️ 裸数字 `/switch 2` 只在**本工作区**那份清单里解析 ✗（清单里明明印着第 2 条也会说找不到 ✗）。
6. **改动何时生效**：插件代码改动需重载/重启 DSH ✗；`/switch all`、技能目录都随重启生效 ✓。

## 0.5 投递依赖手机在线（2026-10-14 用户实测 ✓）

- 这个通道的消息**只有在手机端微信在线/活跃时才真正到达** ✓ —— 手机睡了、微信进程被杀、
  或该会话被折叠/免打扰时，对方**看不到** ✓（用户原话：「必须手机保持响应」✓）。
- ⇒ **绝不要假设"我发了 = 他看到了"** ✗。需要对方确认时，明确写「**请看手机**」✓；
  长内容优先让对方在**电脑前**的渠道看 ✓。
- 主机侧能证明的只有"**平台已接受**" ✓（原始回执形如
  `{"clientId":"dsh-wechat-…","serverMessageId":"…"}`，无错误字段 ✓）——
  **接受 ≠ 送达** ✓，这两件事从日志里分不出来 ✗（2026-10-14 为此排查了半天 ✓）。

## 1. 什么时候读这份技能

- 准备给他**发任何东西**（图 / 文件 / 长报告）之前 ✓
- 要**切换对话**，或他问"现在在哪个对话" ✓
- 发现自己在写**超过 3 行**的回复 ✓

## 2. 常见动作速查

| 想要 | 怎么做 |
|---|---|
| 给他看一张图 | `send_to_wechat`（或 `notify_wechat` 的 `path`）发 PNG/JPG ✓ |
| 给他一份报告 | 先写成 .md/.txt 再发 ✓（不要整段贴聊天 ✗） |
| 做完通知一声 | `notify_wechat { text }` 短句 ✓ |
| 换到别的会话 | `/list all` → `/switch all <编号>` ✓ |
| 中断当前任务 | `/cancel` ✓ |

## 3. 一句话记忆

**手机上只读短句；要看东西就发文件；换会话先 `/list all`。**
