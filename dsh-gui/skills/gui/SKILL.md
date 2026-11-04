---
name: gui
description: Use before operating a desktop window (click, type, read UI) or when a window must not disturb the user. Covers the action ladder (UIA → CDP → coordinates), the virtual display, and the traps that make an agent believe it succeeded when nothing happened.
---

# 图形化 / 屏幕操作

**选层顺序**（从最安静到最吵，能用上层就不要用下层）：

| 顺序 | 手段 | 抢焦点 | 适用 |
|---|---|---|---|
| 1 | `gui_uia` 的 `invoke` | ❌ | Win32 / UWP / WPF 等有 UIA provider 的原生控件 |
| 2 | `gui_browser` 的 `click` | ❌ | 浏览器 / Electron 的网页内容（CDP） |
| 3 | `gui_click` 坐标点击 | ✅ **会抢** | canvas、自绘 UI、游戏 |

## 一次典型操作

1. `gui_windows` 拿到句柄；
2. `gui_capture` 看一眼（或 `gui_zoom` 看清细节）；
3. 找控件：网页 `gui_browser tree`，原生 `gui_uia tree`；
4. 动作：`gui_uia invoke` / `gui_browser click` / 兜底 `gui_click`；
5. **`gui_verify` 证明它真的生效**（不要自己假设成功）。

## 不打扰用户

- `gui_launch` / `gui_place` 把窗口放到**虚拟屏**（`DISPLAY19 @1920,0`），用户看不见；
- 两者都用 `SWP_NOACTIVATE`，**不抢焦点**；
- 虚拟屏靠 `gui_vdd` + keeper 保活；**不要频繁插拔**——每插一次 Windows 会重排所有窗口。

## 坑（都实测过）

| 现象 | 原因 | 处理 |
|---|---|---|
| 截图全黑、屏幕截取得到**桌面壁纸** | 窗口 cloaked（别的虚拟桌面/已挂起） | 工具会直接拒绝（`exit 6`），换桌面再抓 |
| 打字成功但截图没变 | WinUI3 的 `PrintWindow` 返回**旧帧** | `gui_verify` 在前台时自动改用屏幕截取 |
| `[place] 挪动没生效` | 目标**提权**（regedit/mmc 之类） | 非提权进程挪不动提权窗口，别白试 |
| 点按钮有高亮但菜单不出 | 未解（怀疑按下即开/飞窗非标准 HWND） | 优先用键盘或 UIA 菜单项 |
| Chromium 只有 `Chrome Legacy Window` | 网页内容不暴露给 UIA | 走 CDP |
| CDP 连不上 | 浏览器没带 `--remote-debugging-port` | 用 `gui_launch` 带参数重启浏览器 |

## 自绘 UI 的兜底

没有控件树也没有 DOM 时，按颜色找：

```powershell
pwsh -File tools/gui/find-color.ps1 0x1234 '#005a9e' -Tolerance 20
# → 每个色块的中心点，交给 gui_click
```

## 深入

- `DeepSeekCode/docs/图形化能力-2026-11-01.md` —— 完整能力说明与三个坑的来龙去脉
- `DeepSeekCode/docs/图形化-用法速查.md` —— 每个工具的调用示例
