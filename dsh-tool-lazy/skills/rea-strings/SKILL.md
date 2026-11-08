---
name: rea-strings
description: REA「字符串与常量」工具组（提取、搜索、编码识别）。需要这类逆向能力时先读本技能，再 tools_load('rea-strings') 只加载这一组。
---
# 字符串与常量（约 15 个工具）

**能干什么**：提取、搜索、编码识别。

**什么时候用**：找提示语、URL、密钥、魔数或判断编码时。

**怎么加载**：调用 	ools_load('rea-strings') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-strings')；默认 **10 分钟无调用会自动卸载**。
