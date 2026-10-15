# dsh-wechat-plugin 本地补丁（2026-10-12）

位置：`C:\固态盘秘钥\.dsh\profiles\web\node_modules\dsh-wechat-plugin\`
（**不在任何 git 仓库里** ⇒ 插件重装/升级会丢失，故在此留档，便于重打。）

## 1. `/switch all <编号>`：跨工作区按编号切换（新增）

**文件**：`dist/core/lib/router.js` 的 `case '/switch'`

**改动**：在 `const target = resolveTarget(args, all, own);` 前后加入：

```js
const scoped = /^all\s+(.+)$/i.exec(args.trim());
const target = resolveTarget(scoped?.[1] ?? args, all, scoped ? all : own);
if (target === undefined) {
    return {
        kind: 'reply',
        text: scoped
            ? '找不到这个对话。用 /list all 看清单，再回 /switch all <编号>。'
            : '找不到这个对话。回复「列表」看清单，再回复数字；跨工作区请用 /switch all <编号>。',
    };
}
```

**为什么**：`/list all` 会打印其它工作区的会话并编号，但裸数字只在**本工作区**清单里解析（`numbered = own`）⇒ 用户看着第 2 条回 `2` 得到"找不到" ✗。显式 `all` 无状态、不猜。

**配套文案**：`renderSessionList` 在 `held.length === 0`（正在展示全量清单）时提示 `/switch all <编号>`；`HELP_TEXT` 加一行；`lib/host.js` 里"工具列清单"那段同样区分两种情况。

## 2. 每轮提示词改短 + 技能按需读

- 技能：`dsh-plugins/dsh-picophone/skills/wechat-channel/SKILL.md`（随预设的 `customSkillDirs` 挂载，模型想读才读）
- `dist/core/lib/state.js` 的 `DEFAULT_SETTINGS.presenceNote` 由整段说明改成一句指针：
  `[渠道：微信] 手机端对话：回复要短，给他看东西就直接发文件。详细要求见技能 wechat-channel。`

## 3. 已撤销的改动（仅备查，勿重打）

曾在 `lib/host.js` 给"工具卡片"加失败熔断（`#toolCardsBroken`）。用户判断"警告多 ≠ 不能用"，**已完整回退**（`工具卡片发送失败` 两处 catch 恢复原样）。

## 4. 背景：工具卡片为何一直报错

微信侧不接受该卡片类型：`errcode=-2 errmsg=prepare failed`，且常返回空 body ⇒ `JSON.parse('')` 抛 `Unexpected end of JSON input`。插件把最近错误放在内存环形缓冲（上限 50 条，`lib/host.js:2531`），所以设置页看起来"永远 50 条"。属噪音，不影响收发。

## 5. 模型命令（2026-10-15 追加）

**`dist/core/lib/router.js`**：新增两个命令
- `/models` —— 调 `gateway.modelList()`（宿主 API ✓）列可用模型并编号；清单存内存（每对话一份 ⇒ 重载后编号失效，故同时支持写全）
- `/model` —— 不带参数看当前（`gateway.currentModel()` ✓）；`/model <编号>` 或 `/model <provider/model>` 切换（`gateway.selectModel()` ✓）
- 类里加了 `#modelLists = new Map();`；`HELP_TEXT` 补两行

**`lib/host.js`**（`#gateway()` 里）：新增三个方法
```js
modelList:  async () => ctx.sessionController.modelCatalog()  → 展平成 [{provider, model, label}]
currentModel: async (sessionId) => ctx.sessionController.inspect(sessionId) → { provider, model }
selectModel: async (sessionId, provider, model) =>
                 ctx.sessionController.selectModel({ sessionId, provider, model })
```
宿主 API 出处：`@deepseek-ai/dsh-api-session-controller` 的 `session/modelCatalog`、`session/selectModel`（`SessionSelectModelRequest extends ModelSelection { sessionId }`）✓

**验证**：桩网关单测五条路径全绿 ✓（看当前 / 列表 / 按编号切 / 写全切 / 越界提示 ✓，`selectModel` 参数正确 ✓）；
**生效方式**：`plugin_manager set_bundle dsh-wechat-plugin enabled:false → true`（热重载 ✓，实测 `apply: mounted`、`errors=0` ✓，无需整机重启 ✓，游标持久化 ⇒ 不丢消息 ✓）。
