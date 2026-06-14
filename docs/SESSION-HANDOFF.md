# CodeAndPurrs · 会话交接（SESSION HANDOFF）

> 给**新会话/新窗口**的第一份必读。读完这份就能无缝接着干，不用翻聊天记录。
> 最后更新：2026-06-14。开发分支：**`claude/codepurrs-progress-docs-lngqpl`**（所有改动都在这条分支，未合并到 `main`）。

## 0. 一句话现状
猫爪足迹（Paw Trail）页前端 + VPS 接收端**已基本完成并反复打磨**；首页 hero 已升级。剩下：首页白天/夜晚新背景图、Codex 安卓 App、VPS 部署、收尾合并。

## 1. 怎么跑 / 验收
- 前端：`npm run build`（tsc + vite，必须通过）；`npm run dev`（web+聊天后端）；`npm run preview`(4173)。
- 截图验收用 Playwright：`npx playwright install chromium` 后写个小脚本访问 `http://localhost:4173/paw-trail`，可 `document.querySelector('.paw-page').className='paw-page is-day'`（或 `is-night`）强制时段。
- Usage Bridge：`npm run bridge:test`（单测）、`npm run bridge:verify`（端到端）、`npm run bridge:start`（起 8788 端口，独立于聊天后端 8787）。
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
1. **首页 CodeAndPurrs 白天/夜晚新背景图**：用户说会让 GPT 画两张（同构图换光照、中间留干净、装饰四周、~1080 宽竖图）。来了就转 webp 接到 `home-dream.webp`/`home-dream-night.webp`，按 `is-day/is-night` 切。
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
  - **待办**：「调频」房间（`switchcore`，现 `status:'soon'` 未建页）将来负责**设全局默认模型 + 模型花名册/性格口味**，写 `purr-channel:provider`，新窗口据此继承。即「调频设默认 + 聊天页快切」。
- **输入区玻璃珠**（VisionOS 风，CSS+SVG，`.chat-glass-btn` 系列）：`+`更多菜单（图片/红包/表情，字体 **ShunFeng 顺风顺水** 子集 `shunfeng-menu.woff2`，仅占位待接后端）｜语音键两态（麦克风⇄按住跳动音波，松开发送·移开取消）｜`↑`发送（深紫内盘）。

## 10. 房间产品设定（建功能时按这个来）
- **浪哪了**（Catch Purring）= 让 AI 能**追踪用户定位**。
- **甜甜口袋**（Sweetie Pocket）= **记录每一笔**用户与 AI 互发的虚拟红包（流水账）。
- **小金库**（Furever Fund）= **累计**虚拟红包，**双方分开计算**（用户一份、AI 一份）。
- 关联：呼噜频道 `+` 菜单的**红包**接 甜甜口袋(流水)+小金库(累计)；**表情包**接 脑洞贴纸盒/Meme 房间收藏。
