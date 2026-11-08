---
name: rea-formats
description: REA「文件格式」工具组（固件、镜像、容器、压缩）。需要这类逆向能力时先读本技能，再 tools_load('rea-formats') 只加载这一组。
---
# 文件格式（约 20 个工具）

**能干什么**：固件、镜像、容器、压缩。

**什么时候用**：要拆解未知格式、镜像或压缩包时。

**怎么加载**：调用 	ools_load('rea-formats') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-formats')；默认 **10 分钟无调用会自动卸载**。
