---
name: rea-network
description: REA「网络与证书」工具组（抓包、证书、协议解析）。需要这类逆向能力时先读本技能，再 tools_load('rea-network') 只加载这一组。
---
# 网络与证书（约 15 个工具）

**能干什么**：抓包、证书、协议解析。

**什么时候用**：分析网络协议、证书链、TLS 流量时。

**怎么加载**：调用 	ools_load('rea-network') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-network')；默认 **10 分钟无调用会自动卸载**。
