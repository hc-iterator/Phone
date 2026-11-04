## gui_launch

启动一个程序并将其窗口放置到虚拟显示器上，使用户看不到它。使用 SetWindowPos 并带有 SWP_NOACTIVATE：不会窃取焦点。优先使用此工具，而不是自行启动程序，否则窗口会出现在用户的主屏幕上。

## gui_place

将一个窗口移动到虚拟显示器（或指定坐标）上，但不激活它。当窗口由其他程序启动且位于用户屏幕上时使用此工具。

## gui_vdd

管理 Parsec 虚拟显示器：`status`（设备和屏幕列表）、`add`（插入虚拟显示器）、`remove`（按索引拔出）。一个 keeper 进程每 50 ms 向驱动发送 ping；如果没有该进程，虚拟显示器会在大约 1 秒后被拔出。

## gui_browser

通过 CDP 与 Chromium 浏览器或 Electron 应用进行交互：`tree` 返回可点击元素的精确矩形、文本和 CSS 选择器；`click` 通过选择器触发真实点击；`type` 设置输入值；`list` 显示目标；`eval` 运行单个表达式。此工具不会移动真实鼠标，因此可在虚拟显示器上无焦点状态下工作。

## gui_uia

通过 UI Automation 读取或操作窗口。`tree` 返回每个控件的类型、名称、AutomationId 和精确矩形；`invoke` 通过 AutomationId 或名称触发控件，且不会移动鼠标或窃取焦点——优先于坐标点击。适用于 Win32/UWP/WPF 应用；Chromium 网页内容不暴露（请使用 gui_browser/CDP 代替）。
