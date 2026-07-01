#!/usr/bin/env python3
"""
去掉「假透明」背景（近白底 / 灰白棋盘格都支持），输出真正透明的 PNG。

为什么不用简单漫水填充：
    手绘图标常带浅色高光，简单按颜色漫水会顺着「近白高光」钻进图标内部，
    把浅色区域挖出黑洞（典型：export-pod 机身出现黑点）。

本脚本做法：
    1. 从四边采样，识别背景色（近白 / 棋盘格灰）。
    2. 背景候选 = 接近背景色 且 低饱和度。
    3. 取「前景连通块」，按面积过滤掉噪点、但保留 detached 的星星/爱心/贴纸。
    4. 对前景做 fill-holes：图标内部被误判的白色高光自动填回 —— 杜绝黑洞。
    5. 轻微羽化边缘，去锯齿。

用法：
    python3 scripts/remove_checkerboard.py 输入.png 输出.png
    python3 scripts/remove_checkerboard.py public/assets/icons/raw public/assets/icons

参数：
    --sat=N        背景最大饱和度阈值，默认 14。背景偏彩就调大。
    --tol=N        与背景采样色的容差，默认 22。
    --min-frac=F   前景最小连通块占比，默认 0.0008。掉了小贴纸就调小。
    --feather=F    边缘羽化半径，默认 0.6。
"""
import sys
import os
from collections import Counter

import numpy as np
from scipy import ndimage
from PIL import Image, ImageFilter


def detect_bg_colors(arr, band=3, max_colors=4, min_share=0.05):
    """从四边采样，返回主要背景色 (R,G,B) 列表。"""
    h, w = arr.shape[:2]
    edges = np.concatenate([
        arr[:band].reshape(-1, 3), arr[-band:].reshape(-1, 3),
        arr[:, :band].reshape(-1, 3), arr[:, -band:].reshape(-1, 3),
    ])
    counter = Counter(map(tuple, edges))
    total = sum(counter.values())
    colors = [c for c, n in counter.most_common(max_colors) if n / total >= min_share]
    return colors or [counter.most_common(1)[0][0]]


def smart_cut(in_path, out_path, sat=14, tol=22, min_frac=0.0008, feather=0.6):
    im = Image.open(in_path).convert("RGB")
    arr = np.asarray(im).astype(np.int16)
    mx, mn = arr.max(2), arr.min(2)

    bg_colors = detect_bg_colors(arr)
    near_bg = np.zeros(arr.shape[:2], bool)
    for c in bg_colors:
        d = np.abs(arr - np.array(c)).max(2)
        near_bg |= (d <= tol)
    bg = near_bg & ((mx - mn) <= sat)            # 接近背景色 且 低饱和

    fg = ~bg
    lbl, n = ndimage.label(fg)
    if n == 0:
        im.save(out_path)
        return
    sizes = ndimage.sum(np.ones_like(lbl), lbl, index=range(1, n + 1))
    thresh = min_frac * arr.shape[0] * arr.shape[1]
    keep = [i + 1 for i, s in enumerate(sizes) if s >= thresh]
    fg_keep = np.isin(lbl, keep)
    fg_filled = ndimage.binary_fill_holes(fg_keep)   # 填回内部高光，杜绝黑洞

    alpha = (fg_filled * 255).astype(np.uint8)
    out = Image.fromarray(np.dstack([np.asarray(im), alpha]), "RGBA")
    if feather:
        out.putalpha(out.getchannel("A").filter(ImageFilter.GaussianBlur(feather)))

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    out.save(out_path)
    removed = int((alpha == 0).sum())
    pct = removed / alpha.size * 100
    print(f"  [完成] {os.path.basename(in_path)} -> {out_path}  "
          f"背景色={bg_colors[:2]}  保留{len(keep)}块  去掉{pct:.0f}%")


# 兼容旧调用名
remove_checkerboard = lambda i, o, tolerance=22, feather=0.6: smart_cut(
    i, o, tol=tolerance, feather=feather)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    kw = {}
    for a in sys.argv[1:]:
        if a.startswith("--sat="):
            kw["sat"] = int(a.split("=")[1])
        elif a.startswith("--tol="):
            kw["tol"] = int(a.split("=")[1])
        elif a.startswith("--min-frac="):
            kw["min_frac"] = float(a.split("=")[1])
        elif a.startswith("--feather="):
            kw["feather"] = float(a.split("=")[1])

    if not args:
        print(__doc__)
        sys.exit(1)

    src = args[0]
    if os.path.isdir(src):
        dst = args[1] if len(args) > 1 else os.path.dirname(src.rstrip("/"))
        exts = (".png", ".webp", ".bmp", ".tif", ".tiff")
        files = [f for f in sorted(os.listdir(src)) if f.lower().endswith(exts)]
        print(f"批量处理 {len(files)} 张：{src} -> {dst}")
        for f in files:
            smart_cut(os.path.join(src, f),
                      os.path.join(dst, os.path.splitext(f)[0] + ".png"), **kw)
    else:
        dst = args[1] if len(args) > 1 else os.path.splitext(src)[0] + "_clean.png"
        smart_cut(src, dst, **kw)


if __name__ == "__main__":
    main()
