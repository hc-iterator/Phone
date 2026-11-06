# B 路放大镜（zoom-at.ps1 / gui_zoom）Bug 测试报告

## 测试概览

- 脚本：`tools/gui/zoom-at.ps1`
- 测试目标：桌面上现成窗口/桌面区域（哔哩哔哩、360 浏览器窗口）
- 工具：`read_image` 亲眼看图 + `Add-Type System.Drawing` 像素级 `GetPixel` 断言
- 结论：**发现 1 条确定 Bug，1 条疑似边界问题**

---

## 已验证项（未发现问题）

| 验证项 | 参数 | 结果 |
|---|---|---|
| 奇数尺寸十字居中 | Size=121, (540,520) | 中心像素 (60,60) R=255 G=0 B=0，十字精确居中 ✅ |
| 偶数尺寸十字居中 | Size=120, (540,520) | 十字水平线落在 y=60 行中心，居中 ✅ |
| (x,y) 标签一致 | 全部 | 标签文字与传入坐标一致 ✅ |
| 主屏边缘坐标 | Size=100, (10,10) | 未崩溃，origin=(-40,-40)，十字在 (50,50) 居中 ✅ |
| 负坐标支持 | 脚本逻辑 | `$left/$top` 可为负，`CopyFromScreen` 接受负坐标，未崩溃 ✅（注：本机副屏在右侧，无法真实测负屏幕坐标）|
| `-Scale` 放大后十字对齐 | Size=100, Scale=3 | 放大后图 300×300，中心像素 (150,150) 红色，十字仍对齐中心 ✅ |
| origin 计算公式 | 全部 | 输出行 `origin=($left,$top)` 与 `(x - Size/2, y - Size/2)` 一致 ✅ |

---

## Bug 1：`origin=` 底部标签完全不可见（确定，严重度：中）

### 复现命令
```pwsh
tools\gui\zoom-at.ps1 540 520 $env:TEMP\zoom_odd_121.png -Size 121 -Scale 1
tools\gui\zoom-at.ps1 540 520 $env:TEMP\zoom_even_120.png -Size 120 -Scale 1
tools\gui\zoom-at.ps1 540 520 $env:TEMP\zoom_scale3.png -Size 100 -Scale 3
```

### 期望 vs 实际

- 期望：图片底部应有黄色文字 `origin=(480,460)`（或对应坐标）
- 实际：**0 个黄色像素**，`origin=` 标签完全缺失（附图：`$env:TEMP\zoom_odd_121.png`, `zoom_even_120.png`, `zoom_scale3.png`）

### 根本原因

`zoom-at.ps1` 第 73 行：
```powershell
$g.DrawString("origin=($left,$top)", $font, [System.Drawing.Brushes]::Yellow, 4, ($outSize - 18))
```
`$outSize` 直到第 91 行才被赋值：
```powershell
$outSize = "$($bmp.Width)x$($bmp.Height)"
```
第 73 行引用时 `$outSize` 为 `$null`，在算术表达式中被当作 0，所以 y 坐标为 `-18`，标签被画在图片区域之外，完全不可见。

### 修法

将 `$outSize` 的定义（第 91 行）移到第 73 行 `DrawString` 调用之前，或将第 73 行的 `$outSize - 18` 改为 `$Size - 18`（因为 scale=1 时两者相等；scale>1 时应使用缩放后的尺寸，建议提前计算 `$outSize`）。

建议修改：
```powershell
# 在第 50 行 $bmp 创建后，立即定义
$outSize = "$($bmp.Width)x$($bmp.Height)"
```
然后第 73 行即可正确使用。若 scale>1，需在缩放后重新计算并再次绘制标签，或在缩放前就确定最终尺寸。

---

## 疑似问题：Size=120 偶数尺寸时最右列出现异常红色像素（待进一步确认）

### 现象

`zoom_even_120.png` 最右列 (x=119) 在 y=2, 72, 73, 74 处有 4 个红色像素，形成短竖条。Size=121 图片中未出现此现象。

### 判断

可能是屏幕该区域实际像素，也可能是偶数尺寸截图边界处理问题。需在干净桌面区域重复测试以确认是否为脚本 Bug。

---

## 测试图片清单（全部在 %TEMP%）

- `zoom_odd_121.png` — Size=121 奇数尺寸
- `zoom_even_120.png` — Size=120 偶数尺寸
- `zoom_edge_10_10.png` — 主屏左上角边缘 (10,10)
- `zoom_scale3.png` — Scale=3 放大

---

## 总结

**1 条确定 Bug**：`origin=` 标签因变量先使用后定义而完全不可见。**十字居中、坐标标签、边缘/负坐标、Scale 放大对齐均正常。**