---
name: rea-workflow
description: REA「流程编排」工具组（会话、任务、报告与证据）。需要这类逆向能力时先读本技能，再 tools_load('rea-workflow') 只加载这一组。
---
# 流程编排（约 15 个工具）

**能干什么**：会话、任务、报告与证据。

**什么时候用**：要串多步逆向流程、记录证据、出报告时。

**怎么加载**：调用 	ools_load('rea-workflow') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-workflow')；默认 **10 分钟无调用会自动卸载**。
