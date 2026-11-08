---
name: rea-mobile
description: REA「Android / iOS」工具组（APK/IPA 拆包与分析）。需要这类逆向能力时先读本技能，再 tools_load('rea-mobile') 只加载这一组。
---
# Android / iOS（约 15 个工具）

**能干什么**：APK/IPA 拆包与分析。

**什么时候用**：拆 apk/ipa、看 smali、plist、dex 时。

**怎么加载**：调用 	ools_load('rea-mobile') —— 只会把这一组工具注册进当前会话。
用完可 	ools_unload('rea-mobile')；默认 **10 分钟无调用会自动卸载**。
