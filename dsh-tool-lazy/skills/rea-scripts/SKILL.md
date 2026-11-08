---
name: rea-scripts
description: REA「脚本引擎」工具组（内置脚本、批处理、插件 API）。需要这类逆向能力时先读本技能，再 tools_load('rea-scripts') 只加载这一组。
---
# 脚本引擎（约 15 个工具）

**能干什么**：内置脚本、批处理、插件 API。

**什么时候用**：要用 REA 自带脚本批量处理或自动化时。

**怎么加载**：调用 	ools_load('rea-scripts') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-scripts')；默认 **10 分钟无调用会自动卸载**。
