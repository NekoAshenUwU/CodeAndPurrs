#!/usr/bin/env python3
"""
去掉「假透明棋盘格」背景，输出真正透明的 PNG。

用法：
    # 处理单个文件
    python3 scripts/remove_checkerboard.py 输入.png 输出.png

    # 批量处理整个文件夹（默认：raw/ -> 上一层）
    python3 scripts/remove_checkerboard.py public/assets/icons/raw public/assets/icons

原理：
    Photoshop / 各种画图软件显示的「透明」其实是灰白小方格。如果你导出时
    没真的存成透明，这些灰白方格就被画进像素里了（= 假透明）。
    本脚本会：
      1. 从图片四条边采样，自动找出棋盘格用的那两种灰/白颜色。
      2. 从四边向内 flood-fill（漫水填充），把连着边缘、且颜色接近棋盘格的
         像素设成透明。
      3. 图标内部本来就有的灰/白（不连到边缘的）会被保留，不会误删。

参数：
    --tolerance N   颜色容差，默认 30。背景没去干净就调大（如 45），
                    图标边缘被啃掉就调小（如 18）。
    --feather       对边缘做 1px 羽化，去掉锯齿白边。
"""
import sys
import os
from collections import Counter

from PIL import Image


def sample_border_colors(img, band=2):
    """采样四条边的像素，返回出现最多的颜色列表。"""
    w, h = img.size
    px = img.load()
    counter = Counter()
    for x in range(w):
        for y in range(band):
            counter[px[x, y][:3]] += 1
            counter[px[x, h - 1 - y][:3]] += 1
    for y in range(h):
        for x in range(band):
            counter[px[x, y][:3]] += 1
            counter[px[w - 1 - x, y][:3]] += 1
    return counter


def detect_checker_colors(img, max_colors=4, min_share=0.08):
    """从边缘自动识别棋盘格颜色（通常是 2 种灰/白）。"""
    counter = sample_border_colors(img)
    total = sum(counter.values())
    colors = []
    for color, cnt in counter.most_common(max_colors):
        if cnt / total >= min_share:
            colors.append(color)
    # 至少保留出现最多的一种
    if not colors and counter:
        colors = [counter.most_common(1)[0][0]]
    return colors


def close_to_any(c, targets, tol):
    for t in targets:
        if abs(c[0] - t[0]) <= tol and abs(c[1] - t[1]) <= tol and abs(c[2] - t[2]) <= tol:
            return True
    return False


def remove_checkerboard(in_path, out_path, tolerance=30, feather=False):
    img = Image.open(in_path).convert("RGBA")
    w, h = img.size
    px = img.load()

    checker = detect_checker_colors(img)
    if not checker:
        print(f"  [跳过] {in_path} 找不到边缘背景色")
        img.save(out_path)
        return

    # 从四条边把所有「贴边」像素入栈，做漫水填充
    visited = bytearray(w * h)
    stack = []

    def consider(x, y):
        idx = y * w + x
        if visited[idx]:
            return
        visited[idx] = 1
        if close_to_any(px[x, y][:3], checker, tolerance):
            stack.append((x, y))

    for x in range(w):
        consider(x, 0)
        consider(x, h - 1)
    for y in range(h):
        consider(0, y)
        consider(w - 1, y)

    removed = 0
    while stack:
        x, y = stack.pop()
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, 0)
        removed += 1
        if x > 0:
            consider(x - 1, y)
        if x < w - 1:
            consider(x + 1, y)
        if y > 0:
            consider(x, y - 1)
        if y < h - 1:
            consider(x, y + 1)

    if feather:
        # 简单羽化：边缘半透明像素直接 +1px 透明，去白边锯齿
        from PIL import ImageFilter
        alpha = img.getchannel("A").filter(ImageFilter.MinFilter(3))
        img.putalpha(alpha)

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    img.save(out_path)
    pct = removed / (w * h) * 100
    print(f"  [完成] {os.path.basename(in_path)} -> {out_path}  "
          f"棋盘格色={checker}  去掉 {removed}px ({pct:.0f}%)")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    tol = 30
    feather = False
    for a in sys.argv[1:]:
        if a.startswith("--tolerance"):
            tol = int(a.split("=")[1]) if "=" in a else 30
        if a == "--feather":
            feather = True

    if len(args) < 1:
        print(__doc__)
        sys.exit(1)

    src = args[0]
    if os.path.isdir(src):
        dst = args[1] if len(args) > 1 else os.path.dirname(src.rstrip("/"))
        exts = (".png", ".webp", ".bmp", ".tif", ".tiff")
        files = [f for f in sorted(os.listdir(src)) if f.lower().endswith(exts)]
        if not files:
            print(f"{src} 里没有可处理的图片（支持 {exts}）")
            return
        print(f"批量处理 {len(files)} 张图：{src} -> {dst}")
        for f in files:
            stem = os.path.splitext(f)[0]
            remove_checkerboard(os.path.join(src, f),
                                os.path.join(dst, stem + ".png"),
                                tol, feather)
    else:
        dst = args[1] if len(args) > 1 else os.path.splitext(src)[0] + "_clean.png"
        remove_checkerboard(src, dst, tol, feather)


if __name__ == "__main__":
    main()
