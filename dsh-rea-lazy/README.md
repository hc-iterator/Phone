# dsh-rea-lazy —— REA(MCP) 工具按任务分组懒加载

## 为什么
`@deepseek-ai/dsh-mcp-client` 激活时**一次性注册全部 207 个工具**（约 +250k tokens），没有过滤配置。
本插件连上 MCP 后**只 tools/list 不注册**；`tools_load` 时才把该组/该工具按 **calling agent scope** 注册；引用计数卸载；10 分钟无调用自动回收。

## 装法
```yaml
# 在需要的 agent preset 里加一行（不要装成全局 bundle）
          - id: rea-lazy
            name: '@local/dsh-rea-lazy'
            config:
              thirdPartyDir: C:\Users\Chen\Desktop\Pico\PicoPhone\_third_party   # 可选，默认自动推
```
依赖：`@modelcontextprotocol/client`（DSH 自带，只 import 不改）；REA 用 `npx -y rea-agents@6.7.0 mcp`，若 npx 缓存里已有则直接跑缓存（快）。

## 验证四步
1. `tools_catalog` → 应列 **20 组**（含每组的工具数）；
2. `tools_load { group: 'fn-analysis' }` → 返回"新注册 N 个"，`tools_catalog` 显示该组已加载；
3. 用 `listTools`（或再跑一次 load）核对工具数**确实增加**；
4. `tools_unload { group: 'fn-analysis' }` → 工具数**回落**（被其它已加载组引用的保留）。

## 连不上时
报错会直接点名：`npx` 首次拉包慢/无网络、`GHIDRA_INSTALL_DIR`/`JAVA_HOME` 路径不存在、MCP 进程启动失败。

## 自检
```powershell
node --check index.js
node smoke-test.mjs   # 离线（假 MCP 客户端）：幂等/引用计数/回收/单工具加载
```
