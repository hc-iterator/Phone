# dsh-memory

两块长期存储，性质不同所以分开存。

## ① 用户画像（profile）

- **只有核心画像进 system prompt**：硬预算 **400 字符**（约 130 token），
  按 `pinned → importance → 更新时间` 排序截断，`pinned` 最多 5 条。
- 其余特征全部留在库里，用 `mem_profile_list` / `mem_profile_get` 现查。
  理由：人是多面的，400 字写不完；但每轮都塞 4000 字纯属浪费。

| 工具 | 作用 |
|---|---|
| `mem_profile_set` | 写一条（同 category+key 覆盖） |
| `mem_profile_list` | 列出（可按 category） |
| `mem_profile_del` | 删除一条 |

## ② 项目事实（project_fact）—— 工具，不是记忆

- **按工作区隔离**：工作区 = 会话 cwd 的绝对路径，同一项目下所有会话共享同一份。
- **只是精确事实**：`subject.attribute = value (+unit)`，唯一键 upsert，不会堆积。
- **默认不进 prompt**：用 `mem_fact_get` / `mem_fact_search` / `mem_fact_list` 现查。
- **删除 = 标记失效**（`invalid_at`），历史仍可查（"以前是不是这样"）。

| 工具 | 作用 |
|---|---|
| `mem_fact_put` | 写/更新一条事实 |
| `mem_fact_get` | 按 subject(+attribute) 精确取 |
| `mem_fact_search` | 子串搜索（subject/attribute/value/note） |
| `mem_fact_list` | 列本工作区全部有效事实 |
| `mem_fact_invalidate` | 标记失效 |

## 其它

- `mem_export`：导出 Markdown 给人看/手改（默认 `%DSH_HOME%\memory\memory.md`）
- `mem_stats`：条数 + **当前注入的确切文本**

## 存储

`%DSH_HOME%\memory\memory.db`（SQLite / WAL，Node 24 内置 `node:sqlite`，零依赖）。

## 工作区解析（踩过的坑）

1. `storages/workspace.json` 的 `tables.workspaces` 是**对象**（id → 工作区），不是数组；
   写成 `[0]` 会拿到 undefined ⇒ 权威来源形同虚设。
2. 兜底：扫 `sessions/<--路径编码-->/session-<uuid>`，目录名解码时**盘符要补冒号**
   （`C-Users-...` → `C:\Users\...`）。
3. 会话目录名带 `session-` 前缀，而 `exec.agent.id` 也带；两种形式都要认。
