---
name: rea-firmware
description: REA「固件 / 嵌入式」工具组（解包、RTOS 符号、启动链）。需要这类逆向能力时先读本技能，再 tools_load('rea-firmware') 只加载这一组。
---
# 固件 / 嵌入式（约 15 个工具）

**能干什么**：解包、RTOS 符号、启动链。

**什么时候用**：拆固件、看 uboot/RTOS、squashfs/jffs 时。

**怎么加载**：调用 	ools_load('rea-firmware') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-firmware')；默认 **10 分钟无调用会自动卸载**。
