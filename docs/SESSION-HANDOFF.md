# CodeAndPurrs · 会话交接（SESSION HANDOFF）

> 给**新会话/新窗口（含 GPT 接手）**的第一份必读。读完这份就能无缝接着干，不用翻聊天记录。
> 最后更新：2026-06-15。开发分支：**`claude/codepurrs-progress-docs-lngqpl`**（所有改动都在这条分支，未合并到 `main`；`main` 很旧，别基于它）。

## ⭐ 0. 一句话现状（2026-06-15）
**网站已正式上线 `https://nekopurrs.uk`**（DigitalOcean VPS + nginx + certbot HTTPS + pm2）。
今天完成：呼噜频道聊天窗/调频/多模型花名册、后端接入 OpenAI+Anthropic、首页主视觉大改版（HFSoda 主 Logo、山海标语、萤火虫氛围、液态玻璃按键、去扫光/手电筒）。
**待办**：① 业主在 VPS `.env` 填 API key（现在聊天是 mock）② GPT/Claude 模型实测 ③ 红包/表情包/定位等房间功能 ④ Codex 安卓 App ⑤ 合并回 main。

## ⭐ 0.5 线上部署 & 更新（最重要）
- **VPS**：DigitalOcean `178.128.127.91`（主机名 `nekopurrs-mcp`，新加坡）。这台还跑着 mcp/vault/tang/neko-jinku 等站，**别动它们的 nginx/pm2**。
- **项目路径**：`/var/www/codeandpurrs`，分支 `claude/codepurrs-progress-docs-lngqpl`。
- **前端**：nginx 直接 serve `dist/`（站点配置 `/etc/nginx/sites-available/nekopurrs.uk`，见 `deploy/nginx-nekopurrs.uk.conf.example`）。`/api/` 反代到 `127.0.0.1:8787`。
- **聊天后端**：pm2 进程 **`purr-chat`**（`npm run proxy:start` → `server/proxy.mjs`，端口 8787）。
- **🔁 改完代码线上更新（每次必跑）**：
  ```bash
  cd /var/www/codeandpurrs && git pull && npm run build
  # 只改前端：到此即可（nginx 读 dist，无需重启）
  # 改了后端/.env：再 pm2 restart purr-chat
  ```
- **DNS**：Cloudflare，`@`/`www`/`api` 三条 A 记录 → `178.128.127.91`，**Proxy 必须灰云 DNS only**（橙云会挡 certbot + 影响 SSE 流式）。
- **完整首次部署步骤**：`deploy/DEPLOY.md`（小白版，DNS→环境→拉码→key→pm2→nginx→certbot）。

## 1. 怎么跑 / 验收
- 前端：`npm run build`（tsc + vite，必须通过）；`npm run dev`（web+聊天后端）；`npm run preview`(4173)。
- 截图验收用 Playwright（已装）：脚本访问 `http://localhost:4173/`；**夜晚版**用 `await context.clock.install({ time: new Date('2026-06-14T23:10:00') })` 再 goto（首页按本地时间自动切 dawn/day/dusk/night）。聊天页 `/purr-channel`、调频页 `/switchcore`、足迹页 `/paw-trail`。
- Usage Bridge：`npm run bridge:test`、`npm run bridge:verify`、`npm run bridge:start`（8788，独立于聊天 8787）。
- 图片处理：环境有 `python3 + PIL + numpy + fonttools/pyftsubset`（抠图、转 webp、拼接、字体子集都用它）。

## 2. 关键约定（务必遵守）
- **只在分支 `claude/codepurrs-progress-docs-lngqpl` 开发**，commit 后 `git push -u origin <branch>`（失败指数退避重试，别新建分支）。
- **数据契约唯一真相 = `docs/neko-usage-bridge-spec.md` §4**（`schemaVersion:1`）。
- 机主时区 **`Asia/Kuching`**（亚庇，UTC+8，不是上海）。
- VPS 接口域名 **`https://api.nekopurrs.uk`**（不是 bridge.codeandpurrs.com）。
- 网站域名 `nekopurrs.uk`；VPS IP `178.128.127.91`；VPS 在新加坡。
- 风格：莫兰迪马卡龙 + Jelly Glass + VisionOS 玻璃珠 + 低饱和；reduced-motion 必须降级。
- 全局文字墨紫 `#4A3B6B`/`#5d4a7e`；龙珠体只用**子集** `public/fonts/longzhu-paw.woff2`（4.7KB，新增用字要重跑 pyftsubset）。
- GitHub token/密钥不要外发、不要截图。

## 3. 已完成 —— Paw Trail 页（`src/pages/PawTrailPage.tsx` + `src/services/usageBridge.ts`）
当前真实状态（注意：很多旧描述已被推翻，以此处为准）：
- **路由** `/paw-trail`；`rooms.ts` 中 `paw-trail` 标 `ready`，首页点门牌可进。
- **数据**：`usageBridge.ts` 读 §4 的 `{ok,meta,data}`，base `api.nekopurrs.uk`（env `VITE_USAGE_BRIDGE_BASE_URL` 可覆盖）；**bridge 没上线时回退 demo 示例数据**（apps：小红书/微信/抖音/ChatGPT/Claude）。
- **背景**：两张 GPT 画框图（用户给的，边轨猫咪+App图标、中间留白）**交叉淡化拼成一张、只叠一次不重复**：
  - 白天 `public/rooms/paw-trail-stack.webp`，夜晚 `public/rooms/paw-trail-stack-night.webp`（月亮深空版），按 `.paw-page.is-night` 自动切。
  - 背景层 `.paw-sky` = `position:absolute; inset:0`，`background-size:100% auto; no-repeat`（**不裁左右边轨**）。页高≈1432px < 叠加≈1448px 刚好铺满。**别再用 cover/repeat**（cover 会裁到中间留白、repeat 会把顶部猫复制到下半页切脸——都踩过坑）。
  - 卡片是 frosted glass（`--paw-card` 白天 `rgba(255,250,252,0.46)`/夜 `0.4`，`backdrop-filter: blur(11px)`），让可爱背景透出来。
- **① 活动环**：真·进度环（SVG circle + dasharray/dashoffset）。**每日目标 `DAILY_GOAL_MS = 12h`**（满圈），`4h12m≈35%`，封顶满圈，入场 0→比例动画 1s。彩虹果冻管状（粉→紫→青渐变 stroke + round cap + 同色 drop-shadow 外发光），**从 12 点顺时针填**（注意：`.paw-ring` svg 不要再加 rotate，旋转只在 `.paw-ring__fill` circle 上一次，否则双重旋转变成从 6 点起）。环内放 mascot 立绘 `paw-hero.webp`（48% 宽，不遮挡环）+ 流光渐变数字 + 「今日」药丸。**不要**那条白色高光内圈（`.paw-ring__hi` 已 display:none）。
- **mascot 立绘** `public/assets/mascot/paw-hero.webp`（女孩抱白猫，已抠掉棋盘格假透明）。
- **② 猫咪点评**：本地启发式文案（深夜催睡/超量护眼/克制夸夸）。**文案措辞待棠棠定，先别擅自删/改**。
- **③ 爪印榜**：标题+副标题「✦ 记着每一步，遇见更好的自己 ✦」；每行 = **半透明玻璃珠 App Icon**（`.paw-tile`，品牌色，真数据有 `iconBase64` 就显示真 logo，Claude 占位用 `✦` 不用「C」）+ 名称 `#534C74` + 进度条 + 时长 `#7B7398`(龙珠体，**禁止与进度条同色**)。进度条按 App 指定双色渐变（见 `APP_BAR`：小红书/微信/抖音/ChatGPT/Claude）。
- **④ 这一周的脚步**：7 根柱**各取图二莫兰迪马卡龙一色的「浅→深」渐变**（`TREND_GRADS`，浅端也带饱和、不发白）；柱顶星座连线**做细做透**（点缀）+ 柱身白爪印剪影；今天高亮。底部统计 chip（解锁/第一次拿起/最后放下/通知）用**龙珠体**。
- **已删除**：原「一天的爪印 · 星河沙滩」整块时间线模块（价值低、删了）。相关 CSS 可能有死代码残留，无害。
- 页脚「ta 自愿分享的一天 · 只看不扰」。

## 4. 已完成 —— VPS 接收端（零依赖 Node）
- `server/usageBridgeServer.mjs`（核心）+ `server/usageBridge.mjs`（启动器，端口 8788，**不动**聊天后端 `server/proxy.mjs`）。
- Endpoints：`POST /api/usage/ingest|ping`、`GET /api/usage/latest|day|trend`、`POST /api/usage/prune`、`DELETE /api/usage/day|owner`、`GET /api/usage/health`。
- 读取统一 `{ok, meta{owner,lastIngestAt,stale}, data}`，服务端算 `stale`（>6h）；校验 `device{owner}`、§4 字段名、`hourly[24]`、可选 `sessions[]`/`recentDays[]`；`X-Bridge-Token` 鉴权；CORS；保留天数 prune。
- 存储 `server/data/usage/<owner>/<date>.json`（已 gitignore）。
- 测试：`test/usageBridgeServer.test.mjs`（11/11 过）；脚本 `scripts/usageBridgeSmoke.mjs`、`usageBridgeVerify.mjs`。
- 部署样例：`deploy/nginx-api.nekopurrs.uk.conf.example`、`deploy/usage-bridge.service.example`。
- 来源：基于 Codex PR #1，但**只摘后端并对齐 §4**；PR 里的 11 张 `file_*.png`(~15MB 垃圾) 和它改写的 spec/字段名 **未采纳**。

## 5. 已完成 —— 首页 hero 升级
- 见 `docs/homepage-redesign-spec.md`。时段背景（`timeOfDay.ts` 共用，白天 `home-dream.webp`、夜 `home-dream-night.webp`）、hero mascot 呼吸、卡后极光、卡内星屑、门牌错落悬浮+云影+视差+液态按压+光跟手走、`PawCursor` 指尖爪印。
- hero 文字：英文标题**冷紫粉玻璃发光** + shimmer 扫光；中文标语**暖蜜桃粉发光**；深夜各自有亮色 + 描边 + 柔光（深夜卡片是深烟熏玻璃防糊）。

## 6. 待办 TODO（新窗从这里继续）
1. ~~**首页 CodeAndPurrs 白天/夜晚新背景图**~~ ✅ 已完成：`home-dream.webp` + `home-dream-night.webp` 已接，CSS 按 `is-day/is-night` 切。
2. **ashen 版 Paw Trail 背景**：用户给的第二组图（Grab/KFC/Gemini 那套）可做 ashen 专属；目前页面 owner 固定 `neko`。要做 owner 切换 + 各自 stack 图。
3. **Mascot 点评文案**：等棠棠定措辞再改；可选升级成调 `/api/chat` 现生成（现在是本地映射）。
4. **Codex 安卓 App handoff**：把这几条补进给 Codex 的安卓交接（`docs/neko-usage-bridge-spec.md` §2 已有大部分）：采集要带 **`iconBase64`**（Top N 应用图标转小 PNG base64）、**`sessions[]`**、`tz="Asia/Kuching"`、POST 到 `https://api.nekopurrs.uk/api/usage/ingest`、别往仓库根目录丢图。
5. **VPS 部署**：DNS 加 `api` A 记录→`178.128.127.91`；`certbot --nginx -d api.nekopurrs.uk`；nginx 反代 `/api/usage/`→`127.0.0.1:8788`；`npm run bridge:start`（或 systemd）。配 `USAGE_BRIDGE_TOKEN`。上线后前端 demo 自动换真数据。
6. **Codex PR #1**：建议**关闭**（后端已被对齐重做、前端另写、安卓另起）。用户尚未点头关，确认后再关。
7. **合并**：择期把 `claude/codepurrs-progress-docs-lngqpl` 合回 `main`（注意 `main` 很旧、缺很多，需谨慎）。

## 7. 文件地图（速查）
- 页面：`src/pages/PawTrailPage.tsx`、`HomePage.tsx`、`PurrChannelPage.tsx`；路由 `src/App.tsx`。
- 服务：`src/services/usageBridge.ts`（足迹读取+demo）、`chat.ts`、`voice.ts`。
- 氛围件：`src/components/ambient/`（`timeOfDay.ts`、`Atmosphere.tsx`、`PawCursor.tsx`、`LoveCursor.tsx`、`usePrefersReducedMotion.ts`）。
- 样式：`src/styles/global.css`（**很长、多轮叠加，靠后者覆盖**；Paw Trail 段在文件后半，改样式优先在末尾追加覆盖块）。
- 后端：`server/usageBridgeServer.mjs`、`server/usageBridge.mjs`、`server/proxy.mjs`(聊天)。
- 素材：`public/rooms/`（`paw-trail-stack.webp`/`-night.webp`、`home-dream.webp`/`-night.webp`、各房间图）；`public/assets/mascot/`（`neko.png`、`ashen.png`、`paw-hero.webp`）；`public/fonts/`（`longzhu-paw.woff2` 子集等）。
- 文档：`docs/neko-usage-bridge-spec.md`(契约)、`homepage-redesign-spec.md`、`codeandpurrs-current-progress.md`、本文件。

## 8. 踩过的坑（别重犯）
- 背景用 `cover` → 裁掉画框图四周的猫/图标；用 `repeat-y` → 把顶部猫复制到下半页被切。**正解：两张拼一张、`100% auto` + `no-repeat`、absolute 贯穿全页**。
- 进度环 svg 和 circle **各转一次 -90°** → 从 6 点起。只转一次。
- 卡片太不透明 → 盖死可爱背景；太透 + 弱模糊 → 字糊。当前平衡：`0.46` + `blur(11px)`。
- 夜间发光字：白卡配浅字会糊 → 夜间用**深烟熏卡 + 亮字 + 细描边**。
- 中文字体全量 1.5MB → 必须 pyftsubset 子集化。

## 9. 呼噜频道 · 聊天窗 & 输入区（`src/pages/PurrChannelPage.tsx`）
- **聊天窗列表**：进频道先看到窗口列表（`WindowList`），右上玻璃按键 `cg-newwin` 开新窗口；每窗可**行内重命名**、**删除**（连记录一起删），卡片显示 名称/预览/相对时间。
- **存储**：窗口元信息 `codeandpurrs:purr-channel:windows`（`WindowMeta[]`，含 `provider`）；每窗记录 `purr-channel:turns:<id>`。旧版单一对话 `purr-channel:turns` 首次进入自动迁成「之前的对话」窗口。
- **模型（已定）**：**每个窗口各记模型**（存 `WindowMeta.provider`）；聊天页顶栏快速切换只改当前窗口。新窗口继承**全局默认** `purr-channel:provider`。
- **调频页 ✅ 已建**（`src/pages/SwitchCorePage.tsx`，路由 `/switchcore`，房间 `switchcore` 已转 `ready`）：设**默认模型** + 写**「关于我」(profile)** 和 **「猫咪人设」(instructions)**，自动存。
  - 共享配置：`src/services/purrConfig.ts`（keys `purr-channel:provider/profile/instructions` + `BASE_PERSONA` + `buildSystemPrompt()`）。
  - 注入方式：聊天 `toMessages()` 每次发送都 `buildSystemPrompt(modelId)` 现拼，实时生效。
  - **每个模型各自人设 ✅**：`purr-channel:personas` = `{ [modelId]: {name, persona} }`。`buildSystemPrompt(modelId)` 优先用该模型专属人设（带名字），没设则回退「默认人设」(`instructions`) 再回退 `BASE_PERSONA`；末尾附「关于我」(`profile`，全局)。调频页有「每个模型的人设」编辑器（选模型→改名字/性格，已设的胶囊带紫点）。
  - 后续可加：profile/人设 是否要支持每窗覆盖；导入/导出人设。
- **模型花名册**（`src/data/models.ts`：`MODELS`/`MODEL_GROUPS`/`getModel`）：DeepSeek、Gemini、GPT(GPT-4/o3/GPT-5.5T)、Claude(Sonnet 4.6/Opus 4.6/Opus 4.8)。
  - 存的是 model **id**（老值 `deepseek`/`gemini` 仍有效）；`getModel(id)` → 后端 `provider`+`model`。
  - **liquid glass 胶囊**（`.model-pill.is-on` 星云幻境渐变，名字 ShunFeng 字体）：调频页按品牌分组、聊天顶栏 `.model-chip` 点开 `.model-pop` 分组列表。
  - **后端 ✅ 已接 4 家**（`server/proxy.mjs`）：deepseek/openai 走 OpenAI 兼容 `callOpenAICompatible`；gemini、anthropic(Claude messages API) 各自实现。路由按 `PROVIDERS[body.provider]` 派发。
  - **VPS 要配的 key**（`.env`，见 `.env.example`）：`OPENAI_API_KEY`(GPT-4/o3)、`ANTHROPIC_API_KEY`(Claude)。没配对应 key 的会走 mock。
  - **⚠️ 模型名**：`GPT-5.5T`(`gpt-5.5t`) 是占位，OpenAI 没这个模型，用前要在 `src/data/models.ts` 换成账号真实可用的名字（如 `gpt-4o`/`gpt-4.1`）。
- **输入区玻璃珠**（VisionOS 风，CSS+SVG，`.chat-glass-btn` 系列）：`+`更多菜单（图片/红包/表情，字体 **ShunFeng 顺风顺水** 子集 `shunfeng-menu.woff2`，仅占位待接后端）｜语音键两态（麦克风⇄按住跳动音波，松开发送·移开取消）｜`↑`发送（深紫内盘）。

## 10. 房间产品设定（建功能时按这个来）
- **浪哪了**（Catch Purring）= 让 AI 能**追踪用户定位**。
- **甜甜口袋**（Sweetie Pocket）= **记录每一笔**用户与 AI 互发的虚拟红包（流水账）。
- **小金库**（Furever Fund）= **累计**虚拟红包，**双方分开计算**（用户一份、AI 一份）。
- 关联：呼噜频道 `+` 菜单的**红包**接 甜甜口袋(流水)+小金库(累计)；**表情包**接 脑洞贴纸盒/Meme 房间收藏。

---

## 11. 🐙 给 GPT / 下一棒 —— 今天(2026-06-15)做了什么 + 接着干什么

### 11.1 今天完成（都在分支 `claude/codepurrs-progress-docs-lngqpl`，已 push）
1. **首次上线**：DNS(Cloudflare)→VPS nginx 站点→certbot HTTPS→pm2 起聊天后端。站点 `https://nekopurrs.uk` 已可访问。部署文件：`deploy/DEPLOY.md`、`deploy/nginx-nekopurrs.uk.conf.example`。
2. **呼噜频道（`src/pages/PurrChannelPage.tsx`）**：
   - 聊天窗列表（开新窗口/行内重命名/删除，记录按窗口分存）。详见 §9。
   - 输入区液态玻璃按键（`+`菜单 / 语音两态 / `↑`发送），见 §9 + §11.3 坑。
   - 模型每窗各记 + 顶栏胶囊弹层切换。
3. **调频页（`src/pages/SwitchCorePage.tsx`，路由 `/switchcore`）**：默认模型 + 关于我 + 每模型名字/人设。配置在 `src/services/purrConfig.ts`，模型表 `src/data/models.ts`。
4. **后端多模型（`server/proxy.mjs`）**：deepseek/gemini/**openai/anthropic** 四家，按 `PROVIDERS[body.provider]` 派发。
5. **首页主视觉大改版（`src/pages/HomePage.tsx` + `src/styles/global.css` + `src/components/`）**：
   - 去掉标题扫光、hero 卡 sheen 反光、房间图标跟手"手电筒"光（`room-tile__glow` 连 RoomCard 跟手 JS 一起删）。
   - 背景 **萤火虫光斑**（`Atmosphere.tsx` 的 `DUST`/`.dust`：大小不一+柔焦+多色+明灭）；hero 标题旁 **光粒聚拢**（`HERO_SPARKS`/`.hero-spark`）。
   - **主 Logo CodeAndPurrs** 换 **HFSoda** 字体 + stronger-dreamy 渐变（蓝紫→藕紫→青薄荷，白天加深一档显色、夜晚提亮版）。`.hero-card h1`。
   - **中文标语** 换 **山海潮玩星球(ShanHai)** 字体 + 逐行渐变（白天玻璃海蓝→蓝紫；夜晚月光蓝白+冷色层次）。`.vow` / `.vow span`。
   - CTA 按钮「进入呼噜频道/看看房间」换草棵体 + 液态玻璃药丸（主按钮马卡龙虹彩）。

### 11.2 ⚠️ 立刻要业主/你做的（否则功能是 mock）
- 业主需在 **VPS `/var/www/codeandpurrs/.env`** 填 key（见 `.env.example`）：`OPENAI_API_KEY`(GPT-4o)、`ANTHROPIC_API_KEY`(Claude)、`DEEPSEEK_API_KEY`、`GEMINI_API_KEY`、`ELEVENLABS_API_KEY`+`ELEVENLABS_VOICE_ID`(猫咪语音)。填完 `pm2 restart purr-chat`。**没填 key 的模型会走 mock 假回复。**
- `gpt-5.5t` 已收起，当前 GPT 选项=`gpt-4o`。要加别的模型在 `src/data/models.ts` 改（id=后端真实模型名）。

### 11.3 ⚠️ 踩过的坑（改字/配色/玻璃时别重犯）
- **白色描边/白色 text-shadow 会把字"洗白发糊"**：在浅底或花背景上，`-webkit-text-stroke:...rgba(255,255,255)` 或 `text-shadow:0 1px 1px white` 会镶一圈白雾，深色被洗淡。要显色就**去白柔光**，用很淡的深色投影做立体。
- **居中多行文字用整块渐变 → 只显中间一种色**：渐变铺在元素框上，居中行左右留白吃掉了渐变两端的颜色。**解法：每行包 `<span>` + `width:fit-content`**，让渐变贴每行宽度（标语就是这么修好"海蓝不见了"的）。
- **浅底 vs 深底颜色观感**：同一组中等饱和色，深底上显、浅底上发淡。浅底（白天）要比深底（夜晚）**整体加深一档**才有同样的饱满感。
- **HFSoda 偏宽**：`.hero-card h1` 用 `font-size: min(14.6cqi, 5rem)` + 缩了 hero 卡左右 padding 到 12px 才放得下且够大；`white-space:nowrap` + 卡 `overflow:hidden`，字号过大会被裁。改字号后务必量 `scrollWidth<=clientWidth`。
- **liquid glass 玻璃质感**做法：磨砂底 + 顶部高光(`::before`) + 虹彩折射描边(`::after` 用 mask 只留边框) + 选中态马卡龙/conic 流光。参考 `.model-pill`、`.chat-glass-btn`。
- 子集字体放 `public/fonts/`，用 `pyftsubset 源.ttf --text="用到的字" --flavor=woff2`（中文务必子集化，整包 MB 级）。已装 fonttools。

### 11.4 待办 TODO（建议优先级）
1. **业主填 key + 实测 GPT/Claude**（最快见效）。
2. **红包**功能：呼噜频道 `+` 菜单 → 接 **甜甜口袋**(流水)+**小金库**(累计，双方分开)。见 §10。
3. **表情包**：`+` 菜单 → 接 **脑洞贴纸盒/Meme 房间**收藏。
4. **浪哪了**(定位追踪) 等其余房间（现状多为 `status:'soon'`，见 `src/data/rooms.ts`）。
5. **猫爪足迹 bridge 上线**：起 `pm2 start npm --name purr-bridge -- run bridge:start`(8788) + 配 `api.nekopurrs.uk` nginx(`deploy/nginx-api.nekopurrs.uk.conf.example`) + certbot；红米采集 App 上报（契约见 `docs/neko-usage-bridge-spec.md`）。没上线时足迹页回退 demo 数据。
6. **Codex 安卓 App**（采集端，见 spec）。
7. 择期合并回 `main`（注意 main 很旧）。

### 11.5 给 GPT 的工作约定
- 所有改动提交到分支 `claude/codepurrs-progress-docs-lngqpl`（或新分支），**别推 main**。
- 每次改完 `npm run build` 必须过；视觉改动用 Playwright 截图自检（日/夜两版）。
- 视觉风格基调：仙气、梦幻、柔和、玻璃感、蓝紫青马卡龙；**不要**大面积发光/blur、不要灰雾脏边、不要把字洗白。
- 改完告诉业主在 VPS 跑 `cd /var/www/codeandpurrs && git pull && npm run build`（改后端再 `pm2 restart purr-chat`）。
