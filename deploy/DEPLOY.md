# CodeAndPurrs 上线清单（小白版）

第一次把网站放到 `nekopurrs.uk` 上线。VPS = `178.128.127.91`（新加坡）。
按顺序做，每一步卡住就把报错发给 Claude。

---

## 第 0 步 · 配 DNS（只能你来，在买域名的网站后台做）

进你**买 `nekopurrs.uk` 的那个网站**（Namecheap / Cloudflare / GoDaddy / 阿里云…）的 DNS 管理页，加这几条 **A 记录**：

| 类型 | 主机名 (Host/Name) | 值 (Value/指向) |
|------|------|------|
| A | `@`（代表 nekopurrs.uk 本身） | `178.128.127.91` |
| A | `www` | `178.128.127.91` |
| A | `api` | `178.128.127.91` |

保存后等 5～30 分钟生效。验证：手机/电脑浏览器开 `http://nekopurrs.uk`，**只要不再是 NXDOMAIN**（哪怕显示 403/默认页）就说明 DNS 通了。

---

## 第 1 步 · VPS 装好基础环境（一次性）

SSH 登进 VPS 后：

```bash
# 装 Node 20 + nginx + certbot + pm2（Ubuntu/Debian）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx
sudo npm install -g pm2
```

## 第 2 步 · 拉代码 + 打包前端

```bash
sudo mkdir -p /var/www && cd /var/www
# 第一次：克隆（用你的仓库地址）
git clone https://github.com/NekoAshenUwU/CodeAndPurrs.git codeandpurrs
cd codeandpurrs
git checkout claude/codepurrs-progress-docs-lngqpl
npm install
npm run build      # 产出 dist/
```

## 第 3 步 · 配 key（聊天 / 语音）

```bash
cp .env.example .env
nano .env
```
至少填这几行（有就填，没有就留空走 mock）：
```
DEEPSEEK_API_KEY=...
GEMINI_API_KEY=...
OPENAI_API_KEY=...            # GPT-4o 用
ANTHROPIC_API_KEY=...         # Claude 用
ELEVENLABS_API_KEY=...        # 猫咪语音
ELEVENLABS_VOICE_ID=...       # 你选的音色 ID
```
存盘：`Ctrl+O` 回车 → `Ctrl+X`。

## 第 4 步 · 起后端（pm2 常驻）

```bash
cd /var/www/codeandpurrs
pm2 start npm --name purr-chat -- run proxy:start     # 聊天后端 8787
pm2 start npm --name purr-bridge -- run bridge:start  # 足迹后端 8788（可选）
pm2 save
pm2 startup        # 按提示再复制粘贴它给的那行，开机自启
pm2 logs purr-chat # 看到 openai:已配置 之类就对了
```

## 第 5 步 · 配 nginx（网站 + 接口转发）

```bash
# 主站配置（serve 前端 + 把 /api/ 转给 8787）
sudo cp deploy/nginx-nekopurrs.uk.conf.example /etc/nginx/sites-available/nekopurrs.uk
# 足迹接口子域名（/api/usage/ → 8788）
sudo cp deploy/nginx-api.nekopurrs.uk.conf.example /etc/nginx/sites-available/api.nekopurrs.uk

sudo ln -sf /etc/nginx/sites-available/nekopurrs.uk /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/api.nekopurrs.uk /etc/nginx/sites-enabled/

sudo nginx -t && sudo systemctl reload nginx   # 测试配置并重载
```

## 第 6 步 · 上 HTTPS（证书，自动续期）

```bash
sudo certbot --nginx -d nekopurrs.uk -d www.nekopurrs.uk -d api.nekopurrs.uk
```
按提示填邮箱、同意条款，选自动跳转 https。完成后打开 **https://nekopurrs.uk** 应该就能看到网站了。

---

## 以后更新网站（改了代码 / 拉了新分支）

```bash
cd /var/www/codeandpurrs
git pull
npm install
npm run build
pm2 restart purr-chat      # 只改了前端可不重启；改了后端/.env 才要
```
