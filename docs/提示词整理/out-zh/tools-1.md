## status

汇报 PicoPhone 台架状态：受管路径、工具链版本、git 分支/头提交/脏状态、VID 为 2E8A 的 USB 设备、持有 rig lock 的对象、闪存台账中的最近镜像、以及卡死的调试进程。只读；在文本旁以 json 对象同步返回相同事实，便于两次运行做机械对比。

## github

通过本机加速器从 GitHub 抓取 URL。hosts 文件把 github.com、api.github.com 与 raw.githubusercontent.com 指向 127.0.0.1，由 Steam++.Accelerator 终结 TLS 并转发；这会导致 web_fetch（非公网 IP）与普通 TLS 客户端（无其证书吊销列表）失效。本工具直接与该加速器通信，返回状态行与响应体。可传完整 URL、以 `/` 开头的 API 路径（如 `/rate_limit`）、或 `owner/repo` 形式。

## gui_windows

列出 Agent 可观测的顶层窗口：句柄、进程、尺寸与屏幕位置、标题、最小化标志。这是 Agent 获知窗口存在的唯一途径 —— 它永远不会收到全屏截图。传 `all: true` 可包含隐藏的辅助窗口（噪声大；仅供调试）。

## gui_capture

按句柄截取单个窗口并保存为 PNG，返回文件路径。使用带 PW_RENDERFULLCONTENT 的 PrintWindow，因此被遮挡的窗口仍能返回自身内容（最小化、受 DRM 保护、独占全屏的窗口返回黑帧）。优于任意全屏截图：Agent 只会看到它指名的那个窗口。

## gui_zoom

放大镜：给定一个屏幕坐标点，返回一张以该点为中心的小图（默认 100x100 原生分辨率），带红色十字准星，以及把图像映射回绝对坐标的 `origin`。当 Agent 能看到某物却读不清时使用 —— 它永远不必盲目猜坐标。
