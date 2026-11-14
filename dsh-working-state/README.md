# dsh-working-state

**两件事显式化：现在是什么工作模式、每个会话在团队里是什么角色。**

用户会离开电脑（睡觉/上班），或者用微信远程指挥。同一个会话池里有人负责指挥、
有人负责干活、有人只是来问一句。这个插件把这两件事存成一份可查询的状态，
让每个 agent 都能先问一句"我现在在哪、我是谁"，再决定怎么说话、要不要等审批。

## 两区

| 区 | 内容 | 位置 |
|---|---|---|
| 全局区 | `mode` ∈ `local`（用户本地监督）/ `wechat`（微信远程）/ `away`（离开、睡觉） | `%DSH_HOME%\working-state.json` |
| 会话区 | 每个会话一条：`role` ∈ `manager` / `worker` / `other`，加 `setBy`、`at`、`public` | 同一个文件的 `sessions` 字段 |

默认模式是 **`local`**（最保守：有人在看）。

## 四个工具

| 工具 | 谁能调 | 做什么 |
|---|---|---|
| `ws_get` | 任何 agent | 读全局模式 + 本会话角色（顺带告诉你可选模式） |
| `ws_set` | 管理员或用户本人 | 改全局模式；原子写 |
| `ws_tag` | **仅管理员** | 给某会话打角色；可标 `public` 让 worker 看见 |
| `ws_list` | 任何 agent | 管理员看全部；worker 看公开的 + 自己；other 只看自己 |

## 枚举怎么来的（不是编的）

| 事实 | 出处 |
|---|---|
| 会话身份只认 `exec.agent.id` | 与 `dsh-admin-gate` 同规矩：不接受自报 |
| 管理员名单 | 只读借用 `%DSH_HOME%\pm\state.json` 的 `admins[]`（`dsh-admin-gate` 是唯一写者） |
| "用户本人" | 该会话最近一条 `user/message` 的 `source.kind === 'user'` 且在 30 分钟内（**沿用 admin-gate 的同一个时间窗**） |
| 会话清单 | `sessionController.list()` → `SessionSummary[]`，只取 `sessionId`（`cordis_inspect_query` 查过真实字段：`sessionId / running / blank / parentSessionId / origin / updatedAt`） |

## 状态文件

```json
{
  "version": 1,
  "updatedAt": "2026-11-12T19:50:00.000Z",
  "mode": "wechat",
  "modeSetBy": { "sessionId": "session-…", "at": "…" },
  "sessions": {
    "session-…": { "role": "worker", "setBy": "session-…", "at": "…", "public": true }
  },
  "rev": 7
}
```

- **原子写**：先写 `working-state.json.tmp` 再 `rename`，读的人永远看不到半截 JSON；
- **单飞锁**：所有"读-改-写"排队（进程内），并发 `ws_tag` 不会互相覆盖；
- **坏了不覆盖**：JSON 解析失败时改名成 `working-state.json.broken-<时间戳>` 留证，然后按默认值启动。

## 安装（还没装，需要审批）

```yaml
# %DSH_HOME%\cordis.patch.yml 追加
- insert:
    - id: dsh-working-state
      name: '@local/dsh-working-state'
```

再加一条 junction（或 `link:` 依赖）指向本目录，然后**重启 DSH**。

## 自测

```
node selftest.mjs      →  SELFTEST=PASS（9 组 26 项）
```

覆盖：默认模式、切换+持久化、角色可见性三分支、非管理员改模式被拒、用户不能绕过 `ws_tag`、
原子写（无 `.tmp` 残留）、20 路并发写一条不丢、非法模式/角色/会话 id、状态文件损坏恢复。

## 已知限制

- `ws_list` 的"所有会话"依赖 `sessionController.list()`；拿不到时只列本地打过角色的记录（不虚构会话）。
- 角色只存在本插件里，**不改变任何实际权限**；真正的权限闸门仍然是 `dsh-admin-gate`。
- `public` 只是"给 worker 看"的可见性开关，不是安全边界。
