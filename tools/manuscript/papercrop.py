"""papercrop.py —— 找到纸的四边，摆正并裁掉边框（桌面/本子/别的纸）

用法: python papercrop.py <in.png> <out.png> [margin_ratio]

做法:
  1. 灰度 + 高斯 + Otsu 阈值（亮=纸）
  2. 形态学闭运算连成一片，取最大轮廓的 minAreaRect
  3. 按矩形角度旋转摆正，再裁到矩形（留一点边距）
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


def rotate(img, angle, center=None):
    h, w = img.shape[:2]
    if center is None:
        center = (w / 2, h / 2)
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nW, nH = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += nW / 2 - center[0]
    M[1, 2] += nH / 2 - center[1]
    return cv2.warpAffine(img, M, (nW, nH), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    margin = float(sys.argv[3]) if len(sys.argv) > 3 else 0.01

    img = imread_u(src)
    if img is None:
        print("读不到", src)
        return 1
    h, w = img.shape[:2]
    small = cv2.resize(img, (w // 4, h // 4), interpolation=cv2.INTER_AREA)
    g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    g = cv2.GaussianBlur(g, (5, 5), 0)
    _, th = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, k, iterations=3)
    cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        print("没找到纸的轮廓，原样输出")
        imwrite_u(dst, img)
        return 0
    c = max(cnts, key=cv2.contourArea)
    rect = cv2.minAreaRect(c)
    (cx, cy), (rw, rh), ang = rect
    print(f"纸的矩形: center=({cx*4:.0f},{cy*4:.0f}) size={rw*4:.0f}x{rh*4:.0f} angle={ang:.2f}")
    if rw < rh:          # 让长边保持竖直的判断只用于打印，不影响裁切
        pass
    # 把角度规范到 [-45,45]，避免把纸转 90 度
    a = ang
    if a > 45:
        a -= 90
    if a < -45:
        a += 90
    rot = rotate(img, a)
    # 旋转后重新找一次矩形再裁
    g2 = cv2.cvtColor(cv2.resize(rot, (rot.shape[1] // 4, rot.shape[0] // 4)), cv2.COLOR_BGR2GRAY)
    _, th2 = cv2.threshold(cv2.GaussianBlur(g2, (5, 5), 0), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    th2 = cv2.morphologyEx(th2, cv2.MORPH_CLOSE, k, iterations=3)
    cnts2, _ = cv2.findContours(th2, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cnts2:
        x, y, ww, hh = cv2.boundingRect(max(cnts2, key=cv2.contourArea))
        x, y, ww, hh = x * 4, y * 4, ww * 4, hh * 4
    else:
        x, y, ww, hh = 0, 0, rot.shape[1], rot.shape[0]
    mx, my = int(ww * margin), int(hh * margin)
    x0, y0 = max(0, x + mx), max(0, y + my)
    x1, y1 = min(rot.shape[1], x + ww - mx), min(rot.shape[0], y + hh - my)
    out = rot[y0:y1, x0:x1]
    imwrite_u(dst, out)
    print("裁切:", (x0, y0, x1, y1), "->", out.shape)
    return 0


if __name__ == "__main__":
    sys.exit(main())
