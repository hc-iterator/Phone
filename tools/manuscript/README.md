# 手稿"扫面化"流水线

把手机拍的**分块近拍**手写稿，合成"整体布局 + 局部高分辨率"的电子稿。

## 依赖

- Python 3.12 + opencv-python-headless + 
umpy
- 本机现成环境：PicoPhone\lbp2900plus-re\out\cv\Scripts\python.exe（uv 建的，不动系统 Python）

## 三步

`powershell
$py = "C:\Users\Chen\Desktop\Pico\PicoPhone\lbp2900plus-re\out\cv\Scripts\python.exe"

# 1) 配准拼合：整页做底（放大 N 倍），把局部近拍按 SIFT+RANSAC 单应贴回去
& $py mosaic.py 页05.jpg 纸2_拼合.png 2 页18.jpg 页19.jpg 页16.jpg 页17.jpg

# 2) 摆正 + 裁掉桌面边框（Otsu + 最大轮廓 + minAreaRect）
& $py papercrop.py 纸2_拼合.png 纸2_裁边.png 0.01

# 3) 去底色差 → 统一暖白纸色 → 保留红笔 → 锐化
& $py paperize.py 纸2_裁边.png 纸2_成品.png 0.7 F6F0DC
`

## 参数

| 脚本 | 参数 | 说明 |
|---|---|---|
| mosaic.py | <整页> <输出> <放大倍数> <局部...> | 放大倍数 2 ≈ 3840×2160；3 更锐但文件大 |
| papercrop.py | <输入> <输出> <边距比例> | 边距默认 0.01 |
| paperize.py | <输入> <输出> <锐化强度> <纸色 hex> | 纸色 F6F0DC 偏黄白；FAF7EE 更白；F2E8C9 更黄 |

## 坑

- **中文路径**：cv2.imread/imwrite 在 Windows 上读不了中文名，脚本里统一用 
p.fromfile + imdecode 绕开。
- **配准失败**：内点 < 30 会自动跳过那张局部（日志里能看到），不会贴歪。
- **红笔**：paperize 按 R 明显大于 G/B 检出红墨水单独着色，不会被漂白。
