# dsh-auto-compact（v0.3）

**任务正常结束后，Agent 自己压一轮；任务进行中不掺和。**

`compaction-basic` 的自动压缩挂在 `agent/pre-step`（每走一步之前），阈值是
`min(上下文窗口 × 0.8, 预算)`——天生发生在**任务中途**。本插件不改它，
只补一个**任务结束时的压缩时机**。

## 版本差别

| | v0.1 | v0.2 | v0.3 |
|---|---|---|---|
| 触发条件 | idle 且用量 ≥ 窗口 × 0.5 | idle 且**最后一条 `turn/end` 是正常完成** | 同 v0.2 |
| 阈值 | 有（0.5） | **没有**，阈值以下也压 | 同 v0.2 |
| 日志 | 只进 ctx.logger | 写 `%TEMP%\dsh-auto-compact.log` | 同上 |
| 开关 | 无 | `enabled`（默认开） | 同上 |
| 失败 | 记 warn | 记日志，不重试 | 同上 |
| 台账 | 无 | 无 | **每次真压写一行持久 JSONL**（项目管理员 2026-11-12 要求） |

## 项目侧台账（v0.3）

`%TEMP%` 会被系统清理，光靠它事后查不了"压了几次、花了多少 token"。所以每次**真压**
（`compacted` / `noop` / `fail`）另写一行 JSONL：

```json
{"at":"2026-11-12T19:40:00.123Z","session":"session-abc","outcome":"compacted","seqs":12,"tokens":48213}
```

- 默认位置：`%DSH_HOME%\logs\dsh-auto-compact-ledger.jsonl`（持久目录，不是临时目录）；
- 位置可用 `ledgerFile` 改；PicoPhone 想直接进项目日志就写
  `ledgerFile: C:/Users/Chen/Desktop/Pico/PicoPhone/DeepSeekCode/debug_logs/auto_compact_ledger.jsonl`；
- 写不进去只安静失败一次，绝不影响会话。

## 判定链

```
agent/status === 'idle'
      ↓ setTimeout(settleDelayMs，默认 20 ms，让 turn/end 先落进会话日志)
读 session.snapshotEvents()，倒着找最后一条 turn/end
      ↓ reason.kind === 'completed' ?  （aborted / blocked / error / max-tokens /
                                        interrupted / forked 一律不压）
同会话 10 分钟内已经试过 → "skip: too soon"
      ↓
compaction.compactNow(agent, signal)     ← 与 /compact 同一个入口
      ↓
成功："compacted ok: N 段历史（约 M tokens）" 或 "compacted ok: nothing useful (no-op)"
失败："fail: …（不重试，等下一轮任务结束）"
```

`turn/end` 的判定还有一条保护：如果最近一条 `turn/start` 比最后一条 `turn/end` 更晚，
说明新一轮还没跑完 → 记 `skip: turn not completed (open)`，不压。

## 服务名与签名（不是猜的）

| 事实 | 出处 |
|---|---|
| 服务名 `compaction` | `cordis_inspect_query`(Service) + `dsh-compaction/lib/index.js`：`CompactionEngine extends Service`，`super(ctx, "compaction")` |
| `compactNow(agent, signal, sourceCommandId?)` | `cordis_inspect_query` 原文签名：`compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult \| null>` |
| "阈值以下也压"是它的本分 | 同一处 description：*Explicitly compact useful history even below automatic pressure thresholds* |
| `turn/end` 是会话日志事件 | `SessionEventMap['turn/end'] = { turn, reason: TurnEndReason }`；`TurnEndReasonMap` 的 kind 只有 `completed` 算正常 |
| 忙时抛 `ManualCompactionError('busy')` | 同一处 throws 列表；所以要等 idle 并捕获 |

### ⚠️ 两个坑（别改回去）

1. **`compaction` 不在 host 平面**：`dsh-web-app` 在根层 `disabled: true`，
   真正的挂载在每个 agent preset 的分组里（`isolate: { compaction: true }`）。
   所以本插件**故意不写** `inject: ['compaction']`——根级 inject 会永远等不到服务，
   插件根本不加载。改成运行期从 `agent.ctx` 往上解析（`serviceOf()`）。
2. **`compactNow` 的第二个参数是 `AbortSignal`，不是 ctx**。别照"印象"多塞一个上下文对象。

## 配置（全部可选，写错回落默认）

```yaml
- insert:
    - id: dsh-auto-compact
      name: '@local/dsh-auto-compact'
      config:
        enabled: true               # 开关，默认 true
        minIntervalMinutes: 10      # 同会话两次尝试的最小间隔（失败也算），默认 10
        dryRun: false              # true = 只记 "dryRun: would compact now"，不真压
        includeSubagents: false    # 子会话默认不压
        logFile: ...               # 默认 %TEMP%\dsh-auto-compact.log
        settleDelayMs: 20          # idle 之后延后多久判定
```

> 注意：本机根 patch（`%DSH_HOME%\cordis.patch.yml`）里现在是
> `dryRun: true` + `thresholdRatio: 0.5`。**`dryRun: true` 要删掉才会真压**；
> `thresholdRatio` 在 v0.2 已无意义（留着也无害）。

## 验证

1. **装上没**：重启后看 `%TEMP%\dsh-auto-compact.log`，应有
   `已启用：任务正常结束即压一轮（阈值不设下限），节流 10 分钟…`。
2. **触发一次**：随便哪个空闲会话结束一轮，日志出现
   `session=<id> compacted ok: …`；10 分钟内再来一次是
   `session=<id> skip: too soon (约 N 分钟后再试…)`。
3. **取消的任务不该压**：中途打断一轮，日志应是
   `skip: turn not completed (other (reason=aborted))`。
4. **离线自测**：`node smoke-test.mjs`（11 组，不需要 DSH、不需要模型）。

## 安装（本机已装，仅作备查）

junction：`C:\固态盘秘钥\.dsh\profiles\web\node_modules\@local\dsh-auto-compact`
→ `dsh-plugins\dsh-auto-compact`；patch 条目在 `%DSH_HOME%\cordis.patch.yml`。
**改本插件源码需要重启 DSH 才生效**（模块已加载在内存里）。

## 回滚

1. 根 patch 里删掉那段 `- insert: … dsh-auto-compact`（文件必须是合法 YAML 数组）；
2. 删 junction（`rmdir`，只删链接不动源码）；
3. 重启。

## 已知限制

- `agent/status` 只在状态**变化**时发；若一轮结束前后状态没变，这次判定会被跳过。
- `settleDelayMs` 默认 20 ms 是经验值：太短可能读到上一轮的 `turn/end`，
  真遇到错位就把它调大（或看日志里 `skip: turn not completed (open)` 的比例）。
- 压缩本身要调一次摘要模型 ⇒ 每个任务结束多一次调用（10 分钟节流兜底）。
