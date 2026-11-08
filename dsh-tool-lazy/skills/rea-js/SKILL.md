---
name: rea-js
description: REA「JS / Electron」工具组（打包、混淆、热更新）。需要这类逆向能力时先读本技能，再 tools_load('rea-js') 只加载这一组。
---
# JS / Electron（约 20 个工具）

**能干什么**：打包、混淆、热更新。

**什么时候用**：逆向 Electron 应用、asar、webpack 产物时。

**怎么加载**：调用 	ools_load('rea-js') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-js')；默认 **10 分钟无调用会自动卸载**。
