# dsh-gui

图形化 / 屏幕操作能力的宿主插件（从 `dsh-picophone` 拆出，2026-11-04）。

## 为什么单独拆出来

台架（编译/烧写/串口）和"看屏幕、点窗口"是两件不相关的事。混在一个插件里有两个坏处：

1. 台架的系统提示词被迫夹带 GUI 说明（8 行的台架段就是被这么撑起来的）；
2. 两边的改动互相牵连——改 GUI 的一个脚本要动台架插件的 3000 行文件。

拆开后：**台架提示词缩成一句话**，GUI 细节进技能文档；两个插件的变更互不影响。

## 工具（10 个）

| 工具 | 作用 | 抢焦点 |
|---|---|---|
| `gui_windows` | 列顶层窗口（句柄/进程/位置/标题） | ❌ |
| `gui_capture` | 按句柄截单个窗口为 PNG | ❌ |
| `gui_zoom` | 放大镜：给点返回带十字的小图 + origin | ❌ |
| `gui_launch` | 启动程序并放到虚拟屏 | ❌ |
| `gui_place` | 把已有窗口挪到虚拟屏 | ❌ |
| `gui_vdd` | 管理 Parsec 虚拟显示器（status/add/remove） | ❌ |
| `gui_browser` | CDP：tree/click/type/eval（浏览器、Electron） | ❌ |
| `gui_uia` | UIA：tree/invoke（原生控件，不移动鼠标） | ❌ |
| `gui_click` | 坐标点击（真实注入） | ✅ 会抢 |
| `gui_verify` | 动作前后像素对比，判定 changed/unchanged | ❌ |

动作优先级：**UIA Invoke > CDP click > 坐标点击**。

## 依赖

- 脚本在 `DeepSeekCode/tools/gui/*.ps1`（默认按插件位置推算：`../../DeepSeekCode`，可用配置 `repo` 覆盖）
- 必须跑在**宿主进程**里：`pico_run` 的 workspace-write 沙箱会挡住 GDI/桌面访问

## 配置

```yaml
- id: gui
  name: '@local/dsh-gui'
  config:
    repo: 'C:\Users\Chen\Desktop\Pico\PicoPhone\DeepSeekCode'   # 可选
```

## 已知坑

- 别的虚拟桌面上的窗口是 **cloaked** 的：`gui_capture` 会**直接拒绝**，不会返回桌面壁纸冒充成功。
- WinUI3 的 `PrintWindow` 会返回**旧帧**：`gui_verify` 在窗口为前台时改用屏幕截取。
- 虚拟屏不要频繁插拔：每插一次 Windows 会重排所有窗口。
