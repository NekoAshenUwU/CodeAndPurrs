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

## 第 7 步 · 开登录锁（只让自己进，强烈建议）

> 配了「家版 CC」（`CLAUDE_CODE_OAUTH_TOKEN`，走订阅额度）就**务必开登录锁**，
> 否则别人/粉丝也能调你的接口、烧你的订阅，踩条款有封号风险。
>
> 原理：后端设 `APP_ACCESS_TOKEN` → 接口必须带对的口令才放行（否则 401）；
> 前端构建时设 `VITE_REQUIRE_ACCESS=1` → 打开网站先弹口令框。**两个要一起开**，
> 只开后端、前端没带口令 = 全站 401 进不去。

**手机 DigitalOcean Console 操作（没有 Ctrl 键，整段复制粘贴+回车即可，不用 nano）：**

第 1 段 · 生成一串强口令并记下来（这串就是你以后进网站要输的口令）：
```
cd /var/www/codeandpurrs && openssl rand -hex 24 | tee .access-token.txt
```

第 2 段 · 把口令 + 前端开关写进 `.env`（先删旧行再写新行，重复跑也安全）：
```
cd /var/www/codeandpurrs && TOK=$(cat .access-token.txt) && sed -i '/^APP_ACCESS_TOKEN=/d;/^VITE_REQUIRE_ACCESS=/d' .env && printf 'APP_ACCESS_TOKEN=%s\nVITE_REQUIRE_ACCESS=1\n' "$TOK" >> .env && echo 写好了 && grep -E '^APP_ACCESS_TOKEN=|^VITE_REQUIRE_ACCESS=' .env
```

第 3 段 · 重新打包前端（`VITE_REQUIRE_ACCESS` 是构建时读的，必须重 build）+ 重启后端：
```
cd /var/www/codeandpurrs && npm run build && pkill -f proxy.mjs; nohup node --env-file=.env server/proxy.mjs > proxy.log 2>&1 & sleep 2 && head -3 proxy.log
```
> 用 pm2 部署的话，第 3 段把最后改成 `npm run build && pm2 restart purr-chat`。

**验证**：手机无痕窗口开 `https://nekopurrs.uk` → 应先弹「访问口令」框；输入第 1 段那串 hex 才进得去。
没开锁时 `curl` 能直接打通 `/api/chat`，开锁后不带头会回 `401 {"error":"unauthorized"}`：
```
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://nekopurrs.uk/api/chat -H 'Content-Type: application/json' -d '{"provider":"deepseek","messages":[]}'
```
开锁后应回 `401`。

> 换口令：重跑第 1～3 段即可（旧口令立刻失效，所有已登录的页面下次请求会被踢回口令框）。

---

## 以后更新网站（改了代码 / 拉了新分支）

```bash
cd /var/www/codeandpurrs
git pull
npm install
npm run build
pm2 restart purr-chat      # 只改了前端可不重启；改了后端/.env 才要
```
