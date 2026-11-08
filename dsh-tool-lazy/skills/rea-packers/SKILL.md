---
name: rea-packers
description: REA「打包器 / 壳识别」工具组（UPX/VMProtect 等与脱壳）。需要这类逆向能力时先读本技能，再 tools_load('rea-packers') 只加载这一组。
---
# 打包器 / 壳识别（约 15 个工具）

**能干什么**：UPX/VMProtect 等与脱壳。

**什么时候用**：怀疑加壳、需要识别或脱壳时。

**怎么加载**：调用 	ools_load('rea-packers') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-packers')；默认 **10 分钟无调用会自动卸载**。
