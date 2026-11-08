---
name: rea-binary
description: REA「ELF / PE / Mach-O 解析」工具组（节区、导入导出、头结构）。需要这类逆向能力时先读本技能，再 tools_load('rea-binary') 只加载这一组。
---
# ELF / PE / Mach-O 解析（约 20 个工具）

**能干什么**：节区、导入导出、头结构。

**什么时候用**：要看清文件结构、依赖了哪些库、有哪些节区时。

**怎么加载**：调用 	ools_load('rea-binary') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-binary')；默认 **10 分钟无调用会自动卸载**。
