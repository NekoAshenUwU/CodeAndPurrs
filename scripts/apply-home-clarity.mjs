// 首页：傍晚那层粉紫纱减半，不再灰蒙蒙；房间名/英文名加深色描边光，看得清；
// 房间右上角的青绿小灯换成樱花粉。只在 global.css 末尾追加；之后 npm run build && pm2 restart codeandpurrs
import { readFileSync, writeFileSync } from 'node:fs';
const CSS = 'src/styles/global.css';
const MARK = 'home-clarity-v1';
let css = readFileSync(CSS, 'utf8');
if (css.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }
css += `

/* ===== ${MARK}：首页不再灰蒙蒙，字看得清，小灯换樱花粉 ===== */
.timesky__layer--dusk {
  background: linear-gradient(165deg, rgba(245, 180, 210, 0.18), rgba(150, 120, 200, 0.16));
}
.timesky__layer--dawn {
  background: linear-gradient(165deg, rgba(255, 214, 180, 0.2), rgba(250, 200, 220, 0.14));
}
.room-tile__name {
  color: #4a2f78;
  text-shadow: 0 0 6px rgba(255, 255, 255, 0.95), 0 0 12px rgba(255, 255, 255, 0.7);
}
.room-tile__english {
  color: #6a4aa8;
  text-shadow: 0 0 6px rgba(255, 255, 255, 0.95), 0 0 10px rgba(255, 255, 255, 0.6);
}
.home-page.is-dusk .room-tile__name,
.home-page.is-night .room-tile__name {
  color: #ffffff;
  text-shadow: 0 0 2px rgba(60, 30, 100, 0.9), 0 1px 6px rgba(70, 40, 120, 0.85), 0 0 14px rgba(255, 170, 215, 0.55);
}
.home-page.is-dusk .room-tile__english,
.home-page.is-night .room-tile__english {
  color: #fff3fb;
  text-shadow: 0 0 2px rgba(60, 30, 100, 0.85), 0 1px 5px rgba(70, 40, 120, 0.8);
}
.room-tile__dot.is-ready {
  background: radial-gradient(circle at 35% 35%, #ffe3f1 0%, #ff9fcd 55%, #f27bb5 100%);
  box-shadow: 0 0 0 3px rgba(255, 159, 205, 0.25), 0 0 8px rgba(255, 140, 195, 0.75), inset 0 0 0 1px rgba(255, 255, 255, 0.75);
}
`;
writeFileSync(CSS, css);
console.log('HOME-OK 首页改好了，接着 npm run build && pm2 restart codeandpurrs');
