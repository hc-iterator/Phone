# dsh-tool-lazy —— 按需加载工具组

**目的**：上下文里只留一行"有哪些工具组"，要用哪组才把该组工具放行到当前会话；用完可卸载。目标是让 REA 那 200+ 工具平时**零 schema 占用**。

## 三个工具

| 工具 | 作用 |
|---|---|
| `tools_catalog` | 列组：每组多少个工具、当前是否已加载（一行一组，不带 schema） |
| `tools_load { group }` | 把该组放行到**本会话** |
| `tools_unload { group }` | 把该组重新隐藏 |

内置组（按工具名前缀归属，插件加减工具后自动跟上）：

- `pico` ← `pico_*`（PicoPhone 台架）
- `gui`  ← `gui_*`（屏幕/窗口操作）
- `rea`  ← `rea_*`（REA；**占位**，需 REA 插件挂载后才有工具）

## 实现依据（host `tools` 服务契约）

```
register(definition): () => void      // 全局或"调用方 agent scope"注册；返回 disposer
restrict({ allow?, deny? }): () => void  // 只作用于调用方 agent scope 的【全局】工具；可叠加
schemas(scope?: ScopeKey): ToolSchema[]  // scope 传 agent = 该 agent 可见的工具
```

⇒ 本插件**不复制**别人的工具定义，只用 `restrict(deny)` 在**当前 agent 作用域**里把未加载组的工具挡掉；`schemas(agent)` 现场算组内容。

## 限制（重要）

1. **只对全局工具有效**：若某组工具是 preset/scope 内注册的（scope-local），`restrict` 会报错；本插件会捕获并把原因返回（不硬来）。
2. **限制按 agent 累积**：实现里每次变更先调用上一枚 disposer 再重新应用，避免限制无限叠加。
3. **不是省 token 的魔法**：它省的是**模型可见的 schema 数**；宿主侧注册仍在。

## 挂载方式

在需要的 **agent preset** 里加一行（不要装成全局 bundle，否则每个模式都会看到这 3 个工具）：

```yaml
          - id: tool-lazy
            name: '@local/dsh-tool-lazy'
```

## 自检

```powershell
node smoke-test.mjs     # 退出码 0 = 全过
```
