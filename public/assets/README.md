# 素材处理说明（背景图 & 图标）

## 目录约定

```text
public/assets/
  icons/
    raw/          ← 原图丢这里（带假透明棋盘格的图标）
    *.png         ← 脚本处理后的「真透明」图标，前端用这里的
  backgrounds/
    raw/          ← 背景原图丢这里
    *.webp        ← 处理 / 转格式后的背景
```

## 一、怎么把图片传进仓库

你电脑/手机上的图我（云端）看不到，得先让图进仓库。两种方式选一种：

**方式 A：网页 / GitHub 上传（最简单）**

1. 打开 GitHub 仓库 → 进入 `public/assets/icons/raw/`
2. 点 `Add file` → `Upload files`，把所有图标拖进去
3. 提交（commit）
4. 回来跟我说「图传好了」，我 pull 下来批量处理

**方式 B：本地 git**

```bash
# 把图复制进 raw 目录后：
git add public/assets/icons/raw
git commit -m "上传图标原图"
git push
```

## 二、去掉假透明（棋盘格）

图传到 `raw/` 后，跑一条命令批量处理：

```bash
# 批量：raw/ 里所有图 → 输出到 icons/（真透明 PNG）
python3 scripts/remove_checkerboard.py public/assets/icons/raw public/assets/icons
```

效果没到位时调容差：

```bash
# 背景没去干净 → 调大容差
python3 scripts/remove_checkerboard.py public/assets/icons/raw public/assets/icons --tolerance=45

# 图标边缘被啃掉 → 调小容差
python3 scripts/remove_checkerboard.py public/assets/icons/raw public/assets/icons --tolerance=18

# 边缘有白色锯齿 → 加羽化
python3 scripts/remove_checkerboard.py public/assets/icons/raw public/assets/icons --feather
```

## 三、统一命名（前端按这个名字找图）

```text
icon-purr-channel.png       呼噜频道
icon-whisperline.png        耳边话
icon-meme-box.png           脑洞贴纸盒
icon-sweetie-pocket.png     甜甜口袋
icon-furever-fund.png       养老金小金库
icon-little-star-notes.png  日历上の星星
icon-catch-purring.png      浪哪了
icon-paw-trail.png          猫爪足迹
icon-purr-todos.png         待办呼噜
icon-switchcore.png         调频
icon-hidey-hole.png         小暗格
icon-export-pod.png         导出舱
```

## 四、背景图转 webp（更小更快）

```bash
python3 - <<'PY'
from PIL import Image
import os
src="public/assets/backgrounds/raw"
for f in os.listdir(src):
    if f.lower().endswith((".png",".jpg",".jpeg")):
        im=Image.open(os.path.join(src,f)).convert("RGB")
        out=os.path.join("public/assets/backgrounds", os.path.splitext(f)[0]+".webp")
        im.save(out,"webp",quality=82,method=6)
        print("ok", out)
PY
```
