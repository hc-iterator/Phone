# dsh-blank-reaper

空草稿会话**回收器**：每点一次「新会话」都会新建一个 0.9 KB 的空草稿会话，
这个插件保证**每个工作区只留最新的 1 个空草稿**，更旧的**移进回收站**（可恢复）。

- 不改 DSH 发行包、不改 `node_modules`、不动别的插件；
- 只碰"一条消息都没有"的会话，有对话的会话**在结构上就不可能被选中**；
- 不物理删除任何东西，全部可恢复。

## 为什么需要

Web GUI 点一次「新会话」就新建一个 0.9 KB 的空草稿会话（只有会话头 + 策略事件），
而且从不清掉。用户连点两次实测 205→206→207；16 天攒了 724 个。

之前试过的办法是改发行包里的 `dsh-api-session-controller` 让它复用空草稿 ——
**不采用**（用户不接受改 `node_modules`）。本插件在插件层做同一件事的外围治理。

## 策略与安全边界（最重要的一节）

1. **触发**：监听会话创建事件 `session/created`；每次有新会话，安排一次复查。
   另外每 10 分钟做一次周期性对账兜底（也用来慢慢消化历史积压）。
2. **先在单个工作区内清点**：把该工作区的"空草稿"按创建时间倒序排，
   **保留最新的 `keepPerWorkspace` 个（默认 1）**，更旧的才会被处理。
   只有"空草稿数 > 保留数"时才动手 —— **只有一个空草稿的工作区永远不碰**。
3. **宽限期 90 秒**：任何草稿创建/最后改动不到 90 秒，一律跳过（给用户打字的时间）。
   所以"刚点完新会话"的那一下，谁都动不了。
4. **只做"移进回收站"**，两种通道，都不物理删除：
   - 首选：harness 自己的归档通道 `workspaceRegistry.archiveSession(id, { stopActivity: true })`
     + `workspace.detachSession(id)`，再在**现成的回收站账本**
     `%DSH_HOME%\dsh-session-trash\trash.json` 里登记一条记录（带 `source: "dsh-blank-reaper"`）。
     于是用户在「设置 → 回收站」里点**恢复**就能原样回来，30 天后才由回收站插件清理。
   - 退路（拿不到 `workspaceRegistry`，例如命令行运行）：
     把会话目录搬到 `%DSH_HOME%\trash\blank-reaper\<时间戳>\<会话 id>\`，随时可以搬回来。
5. **跳过一切可疑对象**：日志解不开（坏帧）、读不出会话头、已归档、已置顶、
   已在回收站账本里、子代理会话（`origin: "subagent"`）、fork 出来的会话（有 `parentSession`）——全部不动。
6. **失败只记日志**：`session/created` 的监听器是**同步**执行的，同步抛错会**否决会话创建**，
   所以监听器里只做"排队"，全部逻辑包 `try/catch`；后台异常也只打日志，不影响主流程。
7. 单次对账最多搬 `maxReapsPerSweep`（默认 50）个，避免启动瞬间搬走几百个。

## 判定"空"的标准：直接复用 dsh-session-gc

不自己造口径，规则与 `dsh-plugins/dsh-session-gc/index.js` **完全一致**：

- 敏感标记（`dsh-session-gc/index.js:26`）：
  `'"user/message"'`、`'"assistant/message"'`、`'"turn/start"'`；
- 扫描方式（`dsh-session-gc/index.js:48-68`）：按 `zstd` 帧魔数 `28 B5 2F FD` 逐帧解压，
  第一行是会话头，**其余任何一行命中上面三个标记 ⇒ 判定"有对话"，永不选中**；
- 因此"空草稿" = 只有会话头 + 策略事件（`sandbox/mode`、`approval/policy`、
  `permission/preset` …）**且没有一条 user/assistant 消息、没有 turn/start**。

本插件额外做两件事（都只会让判定更保守）：解析会话头拿到 `createdAt` / `origin` / `parentSession`
用于排序和排除；文件大于 512 KB 直接当"有内容"跳过（空草稿实测 0.9 KB）。

## 事件名从哪来（不是猜的）

| 位置 | 内容 |
|---|---|
| `@deepseek-ai/dsh-session/lib/types/index.d.ts:41` | `'session/created'(this: Scoped<Session>, session: Session): void;`（`interface Events` 声明，`@mode emit`） |
| `@deepseek-ai/dsh-session/lib/index.js:1910` | 真正 `emit("session/created", …)` 的地方 |
| `@deepseek-ai/dsh-session/lib/types/index.js:1082` | 同一处的 types 构建副本 |
| `@deepseek-ai/dsh-permission-presets/lib/index.js:202` | 现成插件里的消费写法 `ctx.on("session/created", …)`，照它写 |

（`@deepseek-ai` 前缀的包都在 `C:\Users\Chen\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\` 下。）

运行时也核过一遍：`cordis_inspect_query(platform: host, provider: Event, method: listEvents, input: {event: "session/created"})`
返回 `mode: "emit"`、签名 `'session/created'(this: Scoped<Session>, session: Session): void`。

## 配置

在 patch 的 insert 里可加 `config`（全部可省略，默认值见下）：

| 键 | 默认 | 含义 |
|---|---|---|
| `graceMs` | `90000` | 宽限期（毫秒）：新草稿这么久之内绝不动 |
| `keepPerWorkspace` | `1` | 每个工作区保留几个空草稿 |
| `sweepIntervalMs` | `600000` | 周期对账间隔（10 分钟） |
| `startupDelayMs` | `60000` | 启动后多久做第一次对账 |
| `maxReapsPerSweep` | `50` | 单次对账最多回收几个 |
| `shareTrashStore` | `true` | 是否在现成回收站账本里登记（关掉就只是归档，UI 里看不到） |
| `dryRun` | `false` | `true` = 只报告，不动任何会话 |

## 安装

> 装好之前插件完全不生效。两步都做完、并让 DSH 重新加载配置后才开始工作。

**第 1 步：junction 到 profile 的 `node_modules`**（不复制文件，改代码立刻生效）

```powershell
$target = "C:\Users\Chen\Desktop\Pico\PicoPhone\dsh-plugins\dsh-blank-reaper"
$profileDir = (Get-Item env:DSH_PROFILE_DIR).Value      # 本机当前是 C:\固态盘秘钥\.dsh\profiles\web
$link = Join-Path $profileDir "node_modules\@local\dsh-blank-reaper"
New-Item -ItemType Junction -Path $link -Target $target
```

**第 2 步：在根 patch 加 insert**（`%DSH_HOME%\cordis.patch.yml`，本机 `C:\固态盘秘钥\.dsh\cordis.patch.yml`，
文件末尾追加即可；写法与现有的 `dsh-session-gc`、`dsh-projectdb` 完全一致）

```yaml
# 2026-11-08：空草稿会话回收（每工作区只留 1 个，更旧的进回收站，可恢复）
- insert:
    - id: dsh-blank-reaper
      name: '@local/dsh-blank-reaper'
```

⚠️ 这个文件是**顶层 YAML 数组**：追加时不要把缩进写坏，也不要把整段注释掉留空
（历史上写坏过一次，DSH 启动直接崩）。改完先自查语法（`js-yaml` 在 profile 的
`node_modules` 里，所以要先进 profile 目录）：

```powershell
cd $env:DSH_PROFILE_DIR
node -e "const y=require('js-yaml');const a=y.load(require('fs').readFileSync(process.env.DSH_HOME + '/cordis.patch.yml','utf8'));if(!Array.isArray(a))throw new Error('顶层必须是数组');console.log('yaml ok, entries =', a.length)"
```

再核对插件本身能否被 profile 解析（不启动服务）：

```powershell
cd $env:DSH_PROFILE_DIR
node --input-type=module -e "const m = await import('@local/dsh-blank-reaper'); console.log('apply:', typeof m.apply)"
```

想先只看不动，就加 `config: { dryRun: true }`：

```yaml
- insert:
    - id: dsh-blank-reaper
      name: '@local/dsh-blank-reaper'
      config:
        dryRun: true
```

## 回滚

1. 把根 patch 里那 3 行 `insert`（`id` / `name` / 可能的 `config`）删掉或注释掉 → 插件不再加载；
2. 删 junction：`Remove-Item "C:\固态盘秘钥\.dsh\profiles\web\node_modules\@local\dsh-blank-reaper"`
   （`Remove-Item` 删 junction 只删链接，**不会**删真实目录）；
3. 可选：删账本 `%DSH_HOME%\dsh-blank-reaper\state.json`（只是"谁被搬过"的记录）；
4. 已经搬走的会话不受影响，仍在回收站里，随时可恢复。

## 验证方法

不想重启、也不想动真实数据时，用命令行在**真实会话目录**上做只读预演（这是本插件自带的入口）：

```powershell
cd "C:\Users\Chen\Desktop\Pico\PicoPhone\dsh-plugins\dsh-blank-reaper"
node --check index.js          # 语法自检
node index.js --status         # 配置 + 已回收数量 + 账本路径
node index.js --scan           # 只报告：会搬哪些、为什么跳过（不动磁盘）
```

装好生效后（三种观察点）：

1. **Agent 工具**：让 Agent 调 `blank_reaper({action:"scan"})`（只报告）、
   `blank_reaper({action:"status"})`（配置与历史）、`blank_reaper({action:"sweep"})`（立即执行一次）；
2. **账本**：`%DSH_HOME%\dsh-blank-reaper\state.json` 里出现
   `{"reaped":{"<会话id>":{"at":…,"mode":"archive","workspace":"--…--"}}}`；
3. **回收站**：`%DSH_HOME%\dsh-session-trash\trash.json` 里出现 `"source": "dsh-blank-reaper"` 的记录，
   打开「设置 → 回收站」能看到这些空草稿并点恢复；
4. **行为验收**：连点两次「新会话」→ 等 90 秒宽限期过后，工作区里应该只剩最新的那个空草稿
   （旧的出现在回收站里，恢复后能原样打开）。

日志：`[dsh-blank-reaper] 回收空草稿 <id>（<工作区>，方式 archive|move）`。

## 为什么安全（不删有消息的会话）

1. **结构上证伪不了**：判定只认"日志里没有任何 user/assistant 消息、没有 turn/start"。
   有对话的会话一定含这些事件，**不可能被选中**（`dsh-session-gc` 用同一条规则清过 609 个，
   163 个有对话的会话全部完好）。
2. **必须有"更旧的备份品"才动手**：一个工作区里只有 1 个空草稿时，代码根本走不到回收分支。
3. **90 秒宽限期**：刚创建/刚改动的草稿一律跳过，用户正在打字的窗口不会被抽走。
4. **只搬不删**：归档 + 登记回收站（或搬到 `trash\blank-reaper\`），会话目录从头到尾没被删除；
   恢复 = 在回收站点一下。
5. **排除清单**：子代理会话、fork 会话、已归档、已置顶、坏帧、读不出头的会话全部不动。
6. **失败即放弃**：任何异常只写日志；监听器绝不抛错（抛错会否决会话创建）。
7. **不越界**：不写 DSH 自身文件、不改 `node_modules`、不动其它插件的代码；
   只往回收站账本里**追加**记录，且账本解析失败时**跳过登记**（绝不覆盖别人的记录）。

## 已知取舍 / 风险

- 如果你在空草稿 A 里**打了字但还没发送**，接着又点了「新会话」，A 会进回收站
  （它确实一条消息都没有）。文字还在输入框里；A 可以在回收站恢复。这是策略本身的取舍。
- 回收站账本由另一个插件（`dsh-session-trash`）拥有，本插件只按它的格式追加一条记录。
  万一两边同时写（概率极低），后写的那次可能丢掉另一次新增的一条 —— 但**不会**损坏已存在的记录，
  因为写入是"读-改-写 + 临时文件 rename"，且读不出来时直接放弃。
- 侧栏的"隐藏已删除"标记由回收站插件在前端页面加载时拉取，所以**已经打开着的页面可能要刷新一次**
  才看到那些空草稿消失（磁盘与账本已经正确）。
- 历史积压靠周期对账慢慢消化（每 10 分钟最多 50 个）；想立刻清完：
  `node index.js --sweep --min-age-min 60`（命令行只搬不归档，且只处理 60 分钟以上的草稿）。
- 本插件只治理"新会话产生的空草稿"，不修改 GUI 的创建逻辑；要根治创建点仍需改前端。

## 文件位置

| 路径 | 内容 |
|---|---|
| `dsh-plugins\dsh-blank-reaper\index.js` | 全部逻辑（Host 半边，无前端） |
| `dsh-plugins\dsh-blank-reaper\package.json` | ESM 包声明 |
| `%DSH_HOME%\dsh-blank-reaper\state.json` | 本插件账本（谁被搬过、用什么方式） |
| `%DSH_HOME%\dsh-session-trash\trash.json` | 回收站账本（共用的，本插件只追加） |
| `%DSH_HOME%\trash\blank-reaper\` | 退路通道的物理回收目录 |
