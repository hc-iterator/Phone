# dsh-timer

三个小功能，一个插件：

| 工具 | 作用 |
|---|---|
| `timer_stopwatch` | **正计时**：start / stop / reset / status（停表后累计保留，reset 才清零） |
| `timer_countdown` | **倒计时**：start(seconds) / cancel / status（全局只有一个，第二个会被拒） |
| `timer_now` | **现在几点**：本地时间 + UTC + 时区 + epoch |

## 两个设计决定

1. **每个对话一份**：用 `exec.agent.id` 做隔离键。A 会话的倒计时不会出现在 B 会话，也不会被别的会话 reset 清零。DSH 一停计时也停——它不是系统闹钟。
2. **定时器 unref**：倒计时不会吊住 DSH 进程（否则长倒计时会让程序关不掉）。

## 已知限制

- 倒计时到期**不会主动弹通知**，只把状态标成"已结束"；要主动提醒需上层轮询 `timer_countdown status`。
- 状态活在内存里：DSH 重启后所有计时归零（这是有意的，不是 bug）。

