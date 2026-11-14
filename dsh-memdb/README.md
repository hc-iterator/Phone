# dsh-memdb —— 记忆库 v0

**记住"用户是怎样的人、今天干了什么"。** 三张表 + 四个工具（`mem_event` / `mem_timeline` / `mem_who` / `mem_summarize`）。

> v1 口径（用户 2026-11-08 定案）：**不做定时收工摘要、不做开场注入**——"能力摆着，AI 自己决定读不读"。
> 所以每个读工具的描述末尾都写了"需要时读它；不读也不影响其它功能"，写事件由 agent 自己判断
> "一段活告一段落"时调 `mem_summarize`。

与项目库（`dsh-projectdb`，`proj_*`）**共用同一个 SQLite 文件**：

```
%DSH_HOME%\projectdb\project.db     ← 事实表 + 事件表 + 画像表，同一个库，不另建
```

规划文档：`DeepSeekCode/docs/记忆库规划.md`（v0 只做本文件描述的范围）。

## 一、四个工具

### `mem_event({kind, subject, summary, source?, refs?})`

写一条时间线事件。**只记结论，不记过程。**

| 参数 | 说明 |
|---|---|
| `kind` | 必填，只允许 `decision`（决定）/ `milestone`（里程碑）/ `incident`（事故）/ `preference`（偏好）/ `todo`（待办）；写错**直接拒绝**（schema 里也有 CHECK 兜底） |
| `subject` | 必填，这件事关于什么，几个字（如「项目库 v1 上线」）。超 100 字截断 |
| `summary` | 必填，一句话结论。**上限 120 字，超了自动截断并提示** |
| `source` | 可选，出处：`文件:行`、URL、插件目录 |
| `refs` | 可选，关联：会话 id、issue 号、另一条事件 |

返回示例：

```
已记录 #5：2026-11-08 里程碑 项目库 v1 上线 — 项目事实库上线，2804 条事实入库…
```

`source` 与 `refs` 合并后存进 `refs` 列（JSON `{source, items}`），时间线里显示为「（出处 …）」——这样"带日期与出处"不用再加列。

### `mem_timeline({from?, to?, kind?, limit?})`

按时间**倒序**列事件，每条一行：`日期 类型 主题 — 摘要`。

- 默认最近 **20 条**，`limit` 上限 200；
- `from` / `to` 传 `YYYY-MM-DD`，按**本地自然日**（`from` 取当天 00:00，`to` 取当天 23:59:59.999）；
- `kind` 只看一种类型；
- 有 `from`/`to` 时按 `at` 过滤，`at` 是**事情发生的时间**，不是记录时间。

示例：

```
2026-11-08 里程碑 REA 207 工具按需加载 — REA 的 207 个工具改为 20 组按需加载…（出处 dsh-plugins/dsh-rea-lazy）
2026-11-08 里程碑 agent 消息插队修复 — 延迟 41.6s → 1.13s…
```

### `mem_who()`

返回当前用户画像（一段可读文本 + `N/600 字，更新于 …`）。没有画像时明确说「尚未建立」。
描述里明确写了"需要判断用户想要什么时读它；不需要就不读，不读不影响其它功能"——读不读由 agent 判断。

### `mem_summarize({entries, profile?})`

**收口用**：一段活告一段落（或用户说"记一下"）时，把这段工作一次收成几条事件，并可顺手改写画像。

| 参数 | 说明 |
|---|---|
| `entries` | `[{kind, subject, summary, source?}, …]`，一条一个结论，最多 40 条；**与 `mem_event` 同一套校验与截断**（kind 五选一、summary ≤120 字截断、subject ≤100 字截断） |
| `profile` | 可选，改写后的**完整**画像（≤600 字，整段重写而不是追加；旧值进 `profile_history`） |

两条硬规则：

1. **先全部校验、再统一写入**——任何一条 entry 非法（如 `kind: "note"`），整批拒绝，一条都不落盘；
2. 画像超 600 字同样整批拒绝（事件也不写），提示「请**改写**而非追加」。

返回：

```
已写入 3 条事件（#12-#14）；画像：已更新画像（157/600 字，旧版已进 profile_history）
```

所以"写一条"用 `mem_event`，"收一段"用 `mem_summarize`；不需要记的活就别调。

## 二、表结构

```sql
-- 事件：追加式，永不覆盖、永不过期（它就是历史）
CREATE TABLE events(
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,          -- 事情发生的时间（毫秒）
  kind TEXT NOT NULL CHECK (kind IN ('decision','milestone','incident','preference','todo')),
  subject TEXT NOT NULL,
  summary TEXT NOT NULL,        -- ≤120 字（写入时强制截断）
  source_session TEXT,          -- 哪个会话记的
  refs TEXT,                    -- JSON {source, items}
  created_at INTEGER NOT NULL   -- 什么时候被记下来的（与 at 不是一回事）
);
CREATE INDEX ix_events_at ON events(at DESC, id DESC);
CREATE INDEX ix_events_kind ON events(kind);

-- 画像：只保留一行当前值（CHECK 把"只有一行"写进 schema）
CREATE TABLE profile(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  text TEXT NOT NULL,           -- ≤600 字，超了拒绝写入（不截断）
  updated_at INTEGER NOT NULL,
  session TEXT
);

-- 画像历史：每次改画像，旧文本追加到这里（可回档）
CREATE TABLE profile_history(
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  session TEXT,
  at INTEGER NOT NULL,
  op TEXT NOT NULL              -- insert | replace
);
CREATE INDEX ix_profile_hist ON profile_history(profile_id, at);
```

**硬规则**

- 摘要 ≤120 字：超了**截断 + 提示**（宁可留半句，也不让工具调用失败）；
- 画像 ≤600 字：超了**拒绝**并提示「请**改写**而非追加」——画像膨胀不可逆；
- 写入走 `BEGIN IMMEDIATE` + `busy_timeout=8000` + WAL，与项目库同一套并发机制。

## 三、和项目库的边界（最重要的一条）

| | 项目库 `proj_*` | 记忆库 `mem_*` |
|---|---|---|
| 形状 | 键值 `subject.attribute = value` | 事件（时间线）+ 画像（一段文本） |
| 回答的问题 | 「PSRAM 的 `max_sel` 是多少」——**客观成立的事实** | 「用户讨厌什么」「今天做了什么」——**人和历史** |
| 写入 | 同键覆盖，旧值进 `fact_history` | 事件只追加不改；画像只有一份当前值，旧值进 `profile_history` |
| 过期 | 事实会过期，要更新 | 事件**永不**过期 |
| 共用 | 同一个 `project.db`、同一套 WAL/事务/软删习惯 | 同上 |

一句话分工：**能写成"某个东西等于多少"的进项目库；能写成"某天发生了什么事 / 用户是什么样的人"的进记忆库。**
派活时要说清"这是事实还是事件"，别把两边的表混着写。

## 四、CLI（v0 没的工具能力都在这里）

```powershell
cd dsh-plugins\dsh-memdb

node index.js --event '{"kind":"milestone","subject":"…","summary":"…","source":"…"}'
node index.js --timeline [--from 2026-11-08] [--to 2026-11-08] [--kind milestone] [--limit 5]
node index.js --who
node index.js --set-profile "画像文本（≤600 字，旧的进历史）"
node index.js --set-profile-file .\profile.txt
node index.js --profile-history
node index.js --seed [YYYY-MM-DD]     # 灌首批四条里程碑（幂等，重复跑只跳过）
node index.js --stats
node index.js --self-test             # 12 项冒烟，用 %TEMP% 临时库，绝不碰真库
```

画像写入**没有**做成独立工具（v1 口径：画像由 `mem_summarize` 的 `profile` 参数改写），
CLI 的 `--set-profile` / `--set-profile-file` 是给人手动校准用的后门。

## 五、自测覆盖（`node index.js --self-test`，12/12）

1. 写事件成功；
2. 时间线能读回，且格式是「日期 类型 主题 — 摘要」；
3. `kind` 非法被拒；
4. 摘要超 120 字被截断并提示；
5. 画像超 600 字被拒（提示"改写"）；
6. 画像更新把旧文本写进 `profile_history`；
7. 画像表始终只有一行；
8. 时间线的 `kind` / 日期过滤生效；
9. `mem_summarize` 批量写两条事件；
10. `mem_summarize` 顺手改写画像（旧值进历史）；
11. entries 里有一条非法 → **整批拒绝**，事件数不变；
12. 画像超长时 `mem_summarize` 整批拒绝（事件也不写）。

测试用 `DSH_MEMDB_DB` 指到 `%TEMP%\dsh-memdb-test-*\test.db` 的临时文件。
**生产环境不要设这个变量**，否则就脱离共享库了。

## 六、启用方式

1. 把本目录 junction 到 profile：
   `cmd /c mklink /J "<profile>\node_modules\@local\dsh-memdb" "C:\...\dsh-plugins\dsh-memdb"`
2. 在 `%DSH_HOME%\cordis.patch.yml` 里追加：

   ```yaml
   - insert:
       - id: dsh-memdb
         name: '@local/dsh-memdb'
   ```

3. 插件在启动时装载。本次交付按要求**没有重启**：改工具描述/新增 `mem_summarize` 后，
   通过重写 `cordis.patch.yml`（改注释即可）触发了 loader 重新加载，工具表当场热更新成功。

## 七、遗留 / 下一步

- **明确不做**（用户 2026-11-08 否掉）：定时/收工触发的自动摘要（"收工时间不确定"）、
  开场自动注入（"别改会话初始化，强制他读反而不好"）。能力摆着，读不读由 agent 自己判断。
- **`--from-session <会话id>`**（可选）：读某个会话的结论段落自动抽事件——需要能可靠判断
  "哪段是结论"，不确定就先不写，避免灌一堆噪声；
- **画像回档工具**：`profile_history` 已经存好了，还差一个 `mem_profile_restore`；
- **事件纠错**：目前事件只追加，写错了只能用 CLI 直改库（以后补 `mem_event_fix`）；
- 旧插件 `dsh-memory`（另一套库 `%DSH_HOME%\memory\memory.db`，已冻结）与本插件**无关**，不要混用。
