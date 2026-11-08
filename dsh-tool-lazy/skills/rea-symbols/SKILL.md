---
name: rea-symbols
description: REA「符号与重定位」工具组（PDB/DWARF、符号恢复）。需要这类逆向能力时先读本技能，再 tools_load('rea-symbols') 只加载这一组。
---
# 符号与重定位（约 15 个工具）

**能干什么**：PDB/DWARF、符号恢复。

**什么时候用**：有 pdb/dwarf、要做符号恢复或重定位修正时。

**怎么加载**：调用 	ools_load('rea-symbols') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-symbols')；默认 **10 分钟无调用会自动卸载**。
