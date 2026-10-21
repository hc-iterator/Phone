"""paperize.py —— 把拼合结果"扫面化"：去底色差、统一成暖白纸色、保留红笔、锐化

用法：
  python paperize.py <in.png> <out.png> [sharp] [paper_hex]

做法：
  1. 用形态学闭运算 + 大半径高斯估出"纸面光照场"（bg），再把亮度除以它 → flat
     （纸≈1，墨≈0.2~0.5），这一步把局部照片和整页底板的亮度/色温差抹平
  2. 把 flat 重新着色成暖白纸色（默认 #F6F0DC），墨色用近黑
  3. 红笔单独检测（R 明显大于 G/B），换成红色墨水，不被漂白
  4. 非锐化掩模锐化
"""
import sys
import cv2
import numpy as np


def imread_u(path):
    data = np.fromfile(path, dtype=np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR) if data.size else None


def imwrite_u(path, img):
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if ok:
        buf.tofile(path)
    return ok


def hex2bgr(h):
    h = h.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return np.array([b, g, r], np.float32)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    sharp = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
    paper = hex2bgr(sys.argv[4] if len(sys.argv) > 4 else "F6F0DC")

    img = imread_u(src)
    if img is None:
        print("读不到", src)
        return 1
    img = img.astype(np.float32)
    b, g, r = img[..., 0], img[..., 1], img[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b

    # 1) 光照场：闭运算把墨"填掉"，再高斯抹平
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61, 61))
    bg = cv2.morphologyEx(lum, cv2.MORPH_CLOSE, k)
    bg = cv2.GaussianBlur(bg, (0, 0), 30)
    flat = lum / np.maximum(bg, 1.0)
    flat = np.clip(flat, 0, 1.3)

    # 2) 重新着色：纸色 * flat^gamma
    shade = np.clip(flat, 0, 1) ** 0.92
    out = paper[None, None, :] * shade[..., None]

    # 3) 红笔：R 明显高于 G/B 的地方保留红色墨水
    redness = r - np.maximum(g, b)
    redmask = np.clip((redness - 20.0) / 60.0, 0, 1)
    redmask = cv2.GaussianBlur(redmask, (0, 0), 1.2)[..., None]
    red_ink = np.array([70, 70, 205], np.float32)
    out = out * (1 - redmask) + red_ink[None, None, :] * shade[..., None] * redmask

    # 4) 锐化
    blur = cv2.GaussianBlur(out, (0, 0), 1.2)
    out = cv2.addWeighted(out, 1 + sharp, blur, -sharp, 0)
    out = np.clip(out, 0, 255).astype(np.uint8)

    imwrite_u(dst, out)
    print("写出:", dst, out.shape)
    return 0


if __name__ == "__main__":
    sys.exit(main())
