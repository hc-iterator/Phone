# dsh-projectdb · 项目事实库

**不是记忆库。** 记忆库记"用户是怎样的人、今天干了什么"；这里记"项目里客观成立的事实"。
回答"PSRAM 的 max_sel 是多少"这类问题，一次 `proj_get` 就出结果，不必翻十几个 md。

## 四个硬设计

| 问题 | 方案 |
|---|---|
| 能不能回档 | 每次写入进 `fact_history`（追加式）；`proj_restore` 可回退到任意版本 |
| 删除能不能恢复 | **软删除**（`deleted_at`），`proj_undelete` 恢复；物理删除不提供工具 |
| 多 agent 同时改 | WAL + `busy_timeout=8000` + **事务内 upsert**，绝不"读-改-写"；同一键并发写不丢，后到者成为当前值，两者都在历史 |
| 冲突怎么办 | 同键多值时不选边：当前值取最新，其它值留在历史，`proj_conflicts` 列出来 |

## 工具

`proj_put` · `proj_get` · `proj_history` · `proj_restore` · `proj_delete` · `proj_undelete` · `proj_conflicts` · `proj_stats`

## 命令行

```
node index.js --import <jsonl>     # 批量导入（一行一个 JSON）
node index.js --get PSRAM max_sel  # 精确查询
node index.js --stats
```

## 数据

`%DSH_HOME%\projectdb\project.db`（SQLite / WAL）。

## 实测

- 导入 2830 条 → 有效事实 2776 条（1574 个主题），历史 2821 条，库 0.8 MB
- 并发测试：两个进程各写同一键 40 次 → **80 次全成功、零丢失、零锁错**
- 验收：`proj_get PSRAM max_sel` → `18`（带出处 `当前状态.md:162`）
