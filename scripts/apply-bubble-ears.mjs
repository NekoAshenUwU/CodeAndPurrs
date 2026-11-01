// 聊天气泡戴耳朵：老婆的气泡右上角戴猫耳朵，予予的气泡左上角戴雪豹耳朵，都斜着跨在圆角上。
// 图片在 public/ears/（上线命令会一起取下来），这里只在 global.css 末尾追加样式。
// 之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CSS = 'src/styles/global.css';
const MARK = 'bubble-ears-v3';
for (const f of ['public/ears/ears-cat.png', 'public/ears/ears-leopard.png']) {
  if (!existsSync(f)) {
    console.error(`没改任何东西：缺图片 ${f}`);
    process.exit(1);
  }
}
let css = readFileSync(CSS, 'utf8');
if (css.includes(MARK)) {
  console.log('已经加过了，不用再跑。');
  process.exit(0);
}
css += `

/* ===== ${MARK}：气泡戴耳朵（老婆 = 猫耳，予予 = 雪豹耳），斜跨在气泡的上圆角 ===== */
.bubble-row { padding-top: 10px; }
.bubble--user::after,
.bubble--bot::after {
  content: "";
  position: absolute;
  z-index: 2;
  pointer-events: none;
  background-position: center;
  background-size: contain;
  background-repeat: no-repeat;
}
.bubble--user::after {
  right: -9px;
  top: -13px;
  width: 50px;
  height: 30px;
  background-image: url("/ears/ears-cat.png");
  transform: rotate(36deg);
}
.bubble--bot::after {
  left: -6px;
  top: -10px;
  width: 52px;
  height: 26px;
  background-image: url("/ears/ears-leopard.png");
  transform: rotate(-36deg);
}
`;
writeFileSync(CSS, css);
console.log('EARS-OK 加好了，接着 npm run build && pm2 restart codeandpurrs');
