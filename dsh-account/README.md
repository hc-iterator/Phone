# dsh-account

两个工具，回答两个问题：**我还有多少钱**、**我烧了多少 token**。

| 工具 | 作用 |
|---|---|
| `account_balance` | 查 DeepSeek 账户余额（总余额 / 充值 / 赠金，人民币），缓存 60 秒，`force:true` 强制刷新 |
| `usage_tokens` | token 用量：`today` / `days`（默认 7 天）/ `session` / `all`，输入、输出、缓存命中分开计 |
| `usage_reindex` | 建/刷新用量索引（增量，未变动的文件跳过） |

## 余额怎么来的

直接调官方 `GET https://api.deepseek.com/user/balance`，凭据来源：
1. 环境变量 `DEEPSEEK_API_KEY`；
2. `%DSH_HOME%\.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`。

**没有走小鲸鱼插件的 `/dsh-whale/balance.json`**：那条路由被 DSH 的连接栅栏挡着（实测 401），
宿主内部调自己的 HTTP 又拿不到 Web 会话凭据。直接问官方更短、更快。

## token 用量怎么来的

DSH 每条 `assistant/message` 都带 `usage`：
`inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / totalTokens`。
按会话日志聚合，日志是**多帧 zstd**（追加写入），所以按 magic 逐帧解码。

**缓存命中要单独看**：`cacheReadTokens` 每次调用都会把整段上下文算进去，
数值天然很大（实测历史累计 49.8 亿），混进"输入"里会让账完全看不懂。

## 索引与性能

- 存在 `%DSH_HOME%\usage\usage.db`（SQLite / WAL，零依赖）；
- 按 `(mtime, size)` 记住已索引文件，只重解变动的；
- 查 `today` 时只碰今天改过的文件，一般 1 秒内；
- 第一次查 `all` 需要全量走一遍（769 个会话约 10 分钟），建议先跑 `usage_reindex`。
