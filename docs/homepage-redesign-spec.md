# 首页改造设计需求 ＋ 实现映射（v1）

> 目标一句话：**hero 区的精致度要追上图标——让首页从「海报」变成「入口」。**
> 现状诊断：十二枚 3D 奶感门牌图标精致度拉满，但 hero 区是「渐变底 + 文字 + 两颗按钮」的平面结构，立体感与下方图标落差明显。门牌是立体的，门面是平的。
>
> 本文 = 设计需求（保留原文）＋ **实现映射**（现状 / 改法 / 文件），让谁来写都能直接照着改。

## 现有代码地图（开工前先认路）

| 关注点 | 在哪 | 现状 |
|---|---|---|
| 首页结构 | `src/pages/HomePage.tsx` | hero 卡片 + 房间网格，无 mascot |
| 全站样式 | `src/styles/global.css` | v2「仙气浪漫风」token 已就位；hero 斜高光 `sheen`、点击果冻弹、reduced-motion 兜底都有 |
| 氛围层 | `src/components/ambient/Atmosphere.tsx` | 已有 14 颗光尘 + "看不见的猫"自动爪印串 |
| 情书光标 | `src/components/ambient/LoveCursor.tsx` | 静置数分钟自己敲情话，被打断就溜走 |
| 减动开关 | `src/components/ambient/usePrefersReducedMotion.ts` | 所有动效都应接它 |
| 房间卡 | `src/components/RoomCard.tsx` | 玻璃图标框 + hover 上浮 + 点击果冻弹 |
| Mascot 素材 | `public/assets/mascot/neko.png`、`ashen.png` | ✅ 已有，直接用 |
| 时段背景 | `global.css` `.home-page` / `::before` | ❌ 目前固定渐变 + `home-dream.webp`，不随时间变 |

---

## 0. 已有资产（不要重新生成，直接使用）

| 资产 | 状态 | 路径 |
|------|------|------|
| 12 枚房间图标 | ✅ | `public/assets/icons/{id}.png` |
| 背景图 | ✅ | `public/rooms/*.webp`、`public/assets/backgrounds/*.webp` |
| 猫咪 Mascot | ✅ | `public/assets/mascot/neko.png`、`ashen.png` |
| 聊天头像 | ✅ | 呼噜频道内使用 |
| 花样字体 | ✅ | `public/fonts/*.woff2`，已 `@font-face` + 子集化 |

**原则：素材已就位，本次重点是「布局、动效、氛围」，不需要新画任何图。**

---

## 1. Hero 区：呼噜本噜出场（★★★）

**需求**：首页全是「房间门牌」，看不到住在里面的猫，没有主角。
- Mascot 放在 hero 卡片**顶部边沿**，趴在上沿 / 从卡后探出半个头。
- 极轻 idle：尾巴缓摆 / 身体随呼吸起伏（`translateY 1–2px`，周期 3–4s，ease-in-out 循环）。
- 不遮标题，锚定右上角或顶部居中，溢出卡片边界制造层次。

**实现映射**
- 现状：`HomePage.tsx` hero 卡内无 mascot。
- 改法：`.hero-card` 顶部加一张 `<img class="hero-mascot" src=…/mascot/neko.png>`；`.hero-card` 已是 `overflow:hidden`，要让 mascot 探头需把它放到卡**外层包裹**或对 mascot 用 `position:absolute; top:负值` 且**临时解除该方向裁剪**（建议：在 `.hero-card` 外加 `.hero` 包裹，mascot 绝对定位于包裹层、卡片 `overflow:hidden` 不变）。
- idle 动效：`@keyframes hero-breathe { 50% { transform: translateY(-2px) } }`，`animation: hero-breathe 3.5s ease-in-out infinite`；reduced-motion 关。
- 文件：`HomePage.tsx`（加节点）、`global.css`（加 `.hero-mascot` 样式）。

---

## 2. Hero 卡片：从「卡」变成「窗」（★★★）

**需求**
- 卡片**后方**一层缓慢流动的极光 / 云层（gradient animation 或可平移循环氛围图，周期 ≥ 20s 极慢）。
- 卡片内部散布星屑 **15–25 颗**，缓慢漂浮 + 透明度呼吸。
- 卡片边缘一圈**呼吸光晕**：`box-shadow` 紫粉，透明度 0.15–0.35 缓慢循环，周期 4–6s。
- 所有动效「察觉得到但不抢戏」，仙气感的关键是慢和淡。

**实现映射**
- 现状：`.hero-card::before` 已有斜高光 `sheen`（保留）。无后方极光、无卡内星屑、无呼吸光晕。
- 改法：
  - 极光：`.hero` 包裹层加 `::before` 一层多色径向/线性渐变，`animation` 极慢平移（`background-position`，≥20s）；放在卡片 `z-index` 之下。
  - 卡内星屑：复用 `Atmosphere` 的 `.dust` 思路，做一个 `<HeroSparkles>` 子组件或在卡内渲染 15–25 个 `.spark` span（`opacity` 呼吸 + 轻飘）；数量计入全局粒子预算（§7）。
  - 呼吸光晕：给 `.hero-card` 加 `@keyframes hero-halo` 切 `box-shadow` 外发光透明度（4–6s），与现有 inset 阴影叠加。
- 文件：`global.css` 为主；星屑可在 `HomePage.tsx` 内联或新建 `ambient/HeroSparkles.tsx`。

---

## 3. 房间街区：做出悬浮感（★★）

**需求**
- 图标**奇偶列错落**：偶数列整体下移 12–20px。
- 每块门牌底下垫**极淡云影**（模糊椭圆，opacity ≤ 0.15）。
- 门牌缓慢上下浮 **2–3px**，周期 3–5s，各图标相位随机错开。
- 滚动时背景星屑约 0.5 倍速移动，做**视差**，让整条街「飘在云上」。
- hover/按压：轻微放大 `scale(1.04)` + 投影加深。

**实现映射**
- 现状：`.rooms-grid` 规整网格；`.room-tile` 已有 hover 上浮 + 点击果冻弹，但无错落 / 云影 / 持续浮动 / 视差。
- 改法：
  - 错落：`.rooms-grid` 用 `:nth-child` 按列下移不可靠（列数随断点变）。建议给每个 tile 传一个随机/索引相位变量 `--phase`，并用 `nth-child(even)` 在**当前列数**下偏移——或更稳：JS 在 `RoomCard` 上算 `style={{'--offset', '--phase'}}`。
  - 云影：`.room-tile__icon::after` 已被点击光环占用，新增一个 `.room-tile__icon` 的 `::before` 之外的影子用 `filter: drop-shadow` 或在 tile 底加一个模糊椭圆 span（opacity ≤0.15）。
  - 持续浮动：`@keyframes tile-float { 50%{transform:translateY(-2.5px)} }`，`animation-delay: var(--phase)`；与现有 hover/tap `transform` 注意叠加（hover 时可暂停 float）。
  - 视差：滚动监听给 `.atmosphere` / 星屑层一个 `translateY(scrollY * 0.5)`（`transform`，被动监听、rAF 节流）。
  - hover 放大改 `scale(1.04)`（现为 `translateY(-4px)`，可二者择一或叠加）。
- 文件：`RoomCard.tsx`（相位变量）、`global.css`（云影/浮动/hover）、`Atmosphere.tsx` 或 `HomePage.tsx`（滚动视差）。

---

## 4. 会呼吸的时间背景（★★）

**需求**：背景渐变按本地时段切换（与「猫爪足迹」的呼吸背景同一套语言，两页一致）：

| 时段 | 色调 |
|------|------|
| 05–10 清晨 | 奶橘 → 浅粉，柔雾 |
| 10–17 白天 | 天蓝 → 淡紫 |
| 17–20 傍晚 | 粉紫晚霞 |
| 20–05 深夜 | 深空紫 + 细碎星点（星点仅夜间） |

**实现提示**：CSS 变量定义四套渐变，JS 按 `new Date().getHours()` 切 body class；切换加 `transition: background 2s ease`；色值压低饱和度、与图标马卡龙色协调。

**实现映射**
- 现状：`.home-page` 固定 `linear-gradient` + `::before` 固定壁纸 `home-dream.webp`。
- 改法：
  - 在 `:root` 定义 `--bg-dawn / --bg-day / --bg-dusk / --bg-night` 四套渐变变量。
  - `HomePage` 挂载时按小时给 `<main class="home-page is-dawn|is-day|is-dusk|is-night">`，`.home-page` 用 `--bg-now` 驱动、`transition: background 2s ease`。
  - 现有 `home-dream.webp` 壁纸：可保留压在渐变下做底纹（降 opacity），或夜间淡出。
  - 深夜星点：复用 `Atmosphere`，仅 `is-night` 时显示星点档。
  - **与 §6 猫爪足迹的 ⓪ 呼吸背景共用同一套时段→渐变映射**（抽成共享常量，别两处各写一套）。
- 文件：`HomePage.tsx`（class 切换）、`global.css`（四套变量 + 过渡）、可抽 `ambient/timeOfDay.ts` 共享。

---

## 5. 彩蛋：指尖留爪印（★ 锦上添花）

**需求**
- 手指滑动 / 鼠标拖动轨迹上间隔生成**极淡小爪印**（现有爪印素材缩小 + 降透明度）。
- 每枚 0.8–1s 内渐隐，同屏 ≤ 8 枚。
- 随机轻转 ±20°，更像真实踩出。
- 移动端**别和滚动打架**：仅 `touchmove` 且页面未滚动时触发，或降级成「点击处冒一枚」。

**实现映射**
- 现状：`Atmosphere` 里已有"看不见的猫"**自动**爪印（`PAW_SVG` + `.paw` + `pawfade`）——素材和淡入淡出可直接复用，但那是自走的，不跟手。
- 改法：新增 `ambient/PawCursor.tsx`（或并进 `LoveCursor` 同类）：监听 `pointermove`/`touchmove`，节流按移动距离间隔落爪印，复用 `PAW_SVG` + 一个 `.paw--trail` 类（更淡、0.8–1s 渐隐、随机旋转）；维护活动爪印数 ≤8；触屏判断未滚动才触发。
- 文件：新建 `ambient/PawCursor.tsx`，`HomePage.tsx` 挂载，`global.css` 加 `.paw--trail`。

---

## 6. 字体与排版规范

**需求**
- 英文标题继续现有花体。
- 中文装饰句「你敲下第一个字，我便有了余生」**可读性偏弱** → 加深一档或加 1px 同色描边 / 微弱发光，保持可爱但读得清。
- 正文/标签延续可爱圆体，数字用圆润字体保「奶感」。
- 字体 `font-display: swap` + 子集化（中文花体大，只打包用到的字符）。

**实现映射**
- 现状：`@font-face` 全部 `font-display: swap` ✅；注释标明已子集化 ✅；`.vow` 用浅色流动渐变（这正是"偏弱"的来源）。
- 改法：只需调 `.vow` 可读性——给文字加 `text-shadow`/`drop-shadow` 微弱发光，或把渐变停靠色整体**加深一档**（当前 `#a3b4f2…#f4bcd4` 偏浅）。reduced-motion 下 `.vow` 已固定到位，注意改后仍清晰。
- 文件：`global.css` 的 `.vow`。

---

## 7. 性能与体验红线

1. 动画优先 `transform` / `opacity`，避免重排。
2. 粒子总数（光尘 + 卡内星屑 + 指尖爪印 + 夜间星点）同屏 **≤ 35**——现有光尘 14 颗，预算要统筹分配。
3. `@media (prefers-reduced-motion: reduce)` 关闭所有漂浮 / 粒子，只留静态渐变（现有兜底已覆盖大部分，新加的件都要补进这个媒体查询）。
4. 移动端优先，**Redmi 真机流畅才算过关**。
5. 只动首页布局与动效，**不改任何现有路由与房间功能逻辑**。

---

## 8. 验收清单

- [ ] Mascot 趴在 hero 卡片上，有呼吸 / 摆尾 idle 动效
- [ ] Hero 卡片后有流动氛围层 + 边缘呼吸光晕 + 少量星屑
- [ ] 房间图标错落悬浮、带云影、滚动有视差
- [ ] 背景颜色随真实时段变化，切换平滑（与猫爪足迹同一套）
- [ ] 指尖爪印彩蛋可用，且不干扰滚动
- [ ] 中文装饰句在浅色背景上清晰可读
- [ ] 手机端流畅无卡顿，reduced-motion 下优雅降级

---

## 9. 落地顺序建议

1. §4 时段背景（抽 `timeOfDay.ts`，和猫爪足迹共用）——基底先铺。
2. §1 Hero mascot + §2 卡片三件套（呼吸光晕最便宜、极光次之、星屑算预算）。
3. §6 装饰句可读性（一行改完，性价比最高）。
4. §3 房间悬浮 / 云影 / 视差。
5. §5 指尖爪印彩蛋（最后，锦上添花）。

> 全程接 `usePrefersReducedMotion`；每加一个粒子件就回看 §7 第 2 条预算。
