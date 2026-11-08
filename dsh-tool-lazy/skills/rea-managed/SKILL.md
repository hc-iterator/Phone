---
name: rea-managed
description: REA「.NET / Java」工具组（IL 与字节码反编译）。需要这类逆向能力时先读本技能，再 tools_load('rea-managed') 只加载这一组。
---
# .NET / Java（约 20 个工具）

**能干什么**：IL 与字节码反编译。

**什么时候用**：处理 .NET assembly 或 Java class/jar 时。

**怎么加载**：调用 	ools_load('rea-managed') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-managed')；默认 **10 分钟无调用会自动卸载**。
