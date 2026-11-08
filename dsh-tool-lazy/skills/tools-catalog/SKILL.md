---
name: tools-catalog
description: 列出可用的按需工具组（pico / gui / rea）及每组工具数，说明怎么加载。当任务需要台架、屏幕操作或 REA 逆向工具时先读本技能，再 tools_load 对应组。
---
# 按需工具组

工具默认是**隐藏**的，只留三个管理工具：`tools_catalog` / `tools_load` / `tools_unload`。

1. 先 `tools_catalog`：看有哪些组、每组多少个工具、当前哪些已加载；
2. 需要哪组就 `tools_load { group: "pico" }`（或 `gui` / `rea`）；
3. 用完想省上下文就 `tools_unload { group: "pico" }`。

组按工具名前缀归属：`pico_*` / `gui_*` / `rea_*`。`rea` 是占位，需 REA 插件挂载后才有工具。
