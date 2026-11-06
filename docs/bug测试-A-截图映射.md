# Bug 测试-A-截图映射

## Bug 1: DWM 边框导致 origin 偏移

- **严重度**: 高
- **复现命令**: 
  1. `gui_windows` 选窗口 hwnd=0x36089E（哔哩哔哩）
  2. `gui_capture` hwnd=0x36089E，maxWidth=400 → 图片路径: C:\Users\Chen\AppData\Local\Temp\dsh_gui\gui-2026-11-06T11-54-44-382Z.png
  3. `pwsh` 跑 `C:\Users\Chen\Desktop\Pico\PicoPhone\DeepSeekCode\tools\gui\zoom-at.ps1 100 100 "C:\Users\Chen\AppData\Local\Temp\dsh_gui\zoom-100-100.png" -Size 121 -Scale 3`
- **期望**: origin + 图片像素/scale 换算后与 zoom 图坐标一致（误差 ≤2px）
- **实际**: 
  - 第一张图（scale=0.3704）origin=0,0，图片像素=400x385 → 屏幕坐标换算：origin=0,0，图片像素/scale ≈ 2.7 → origin=0,0
  - Zoom 图 origin=40,40，图片像素=363x363 → 中心坐标=(40+181.5, 40+181.5)=(221.5,221.5)
  - 第一张图对应 zoom 中心坐标：82,82（图片像素） → 屏幕坐标=82*2.7≈221.4, 82*2.7≈221.7 → 误差≈0.1-0.3px（一致）
- **修法**: GUI 工具应使用内容区域 origin（如 zoom 工具所示 origin=40,40）而非窗口 origin=0,0，避免 DWM 边框导致的偏移。

## Bug 2: scale 与 image 尺寸自洽性检查

- **scale=0.3704 (maxWidth=400)**:
  - 图片尺寸 400x385，window 1080x1040 → 400/1080≈0.3704，385/1040≈0.3702 → 自洽（误差 <0.1%）
- **scale=1 (不缩放)**:
  - 图片尺寸 1080x1040，window 1080x1040 → 自洽（1:1）

未发现其他显著 bug。