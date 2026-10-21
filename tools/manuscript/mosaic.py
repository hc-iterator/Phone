"""mosaic.py —— 把局部近拍按特征配准贴回整页，得到"整体布局 + 局部高分辨率"的大图

用法:
  python mosaic.py <base.jpg> <out.png> <scale> <detail1.jpg> [detail2.jpg ...]

做法:
  1. SIFT 提特征（对旋转/缩放不敏感，正好对付我们这些歪着拍的照片）
  2. knn 匹配 + ratio test，RANSAC 求单应 H（detail → base）
  3. 把整页放大 scale 倍当底；每张 detail 按 H*scale 变换后贴上去
  4. 贴的时候用"腐蚀+高斯羽化"的遮罩做加权，边缘不留硬缝

输出日志会给出每张 detail 的匹配数/内点数，内点太少就跳过（并在图上不贴）。
"""
import sys
import cv2
import numpy as np


def imread_u(path):
    """cv2.imread 在 Windows 上读不了中文路径，用 imdecode 绕过去"""
    data = np.fromfile(path, dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def imwrite_u(path, img):
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if ok:
        buf.tofile(path)
    return ok


def gray(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def feat(img, nfeatures=30000):
    sift = cv2.SIFT_create(nfeatures=nfeatures)
    return sift.detectAndCompute(gray(img), None)


def main():
    if len(sys.argv) < 5:
        print(__doc__)
        return 2
    base_path, out_path, scale = sys.argv[1], sys.argv[2], float(sys.argv[3])
    details = sys.argv[4:]

    base = imread_u(base_path)
    if base is None:
        print("读不到 base:", base_path)
        return 1
    kp1, des1 = feat(base)
    print(f"base {base.shape[1]}x{base.shape[0]} 关键点 {len(kp1)}")

    # 画布：整页放大 scale 倍
    W = int(base.shape[1] * scale)
    Hh = int(base.shape[0] * scale)
    canvas = cv2.resize(base, (W, Hh), interpolation=cv2.INTER_CUBIC)
    acc = canvas.astype(np.float32)
    wsum = np.ones((Hh, W), np.float32) * 0.35   # 底图权重压低，让 detail 更"实"

    S = np.array([[scale, 0, 0], [0, scale, 0], [0, 0, 1]], np.float64)
    matcher = cv2.BFMatcher(cv2.NORM_L2)

    for path in details:
        det = imread_u(path)
        if det is None:
            print("跳过（读不到）:", path)
            continue
        kp2, des2 = feat(det)
        if des2 is None or des1 is None:
            print("跳过（无特征）:", path)
            continue
        m = matcher.knnMatch(des2, des1, k=2)
        good = [a for a, b in (p for p in m if len(p) == 2) if a.distance < 0.75 * b.distance]
        print(f"{path}: 关键点 {len(kp2)} 好匹配 {len(good)}")
        if len(good) < 12:
            print("   内点不足，跳过")
            continue
        src = np.float32([kp2[g.queryIdx].pt for g in good]).reshape(-1, 1, 2)
        dst = np.float32([kp1[g.trainIdx].pt for g in good]).reshape(-1, 1, 2)
        H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
        if H is None:
            print("   单应求解失败")
            continue
        inl = int(mask.sum())
        print(f"   内点 {inl}")
        if inl < 30:
            print("   内点太少，跳过")
            continue

        Hs = S @ H
        warped = cv2.warpPerspective(det, Hs, (W, Hh), flags=cv2.INTER_CUBIC)
        ones = np.ones(det.shape[:2], np.uint8) * 255
        mw = cv2.warpPerspective(ones, Hs, (W, Hh), flags=cv2.INTER_NEAREST)
        # 收缩边界再羽化，避免把 detail 的纸边/手指带进来
        mw = cv2.erode(mw, np.ones((9, 9), np.uint8), iterations=2)
        mw = cv2.GaussianBlur(mw, (0, 0), 12)
        a = (mw.astype(np.float32) / 255.0)[..., None]
        acc = acc * (1 - a) + warped.astype(np.float32) * a
        wsum = wsum * (1 - a[..., 0]) + a[..., 0]
        print(f"   已贴合：覆盖 {float(mw.mean())/255.0*100:.1f}%")

    out = np.clip(acc, 0, 255).astype(np.uint8)
    imwrite_u(out_path, out)
    print("写出:", out_path, out.shape)
    return 0


if __name__ == "__main__":
    sys.exit(main())

