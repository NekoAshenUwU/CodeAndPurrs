import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:5173';
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});

// 首页
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/home.png' });

// 进入呼噜频道
await page.goto(`${BASE}/purr-channel`, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
await page.screenshot({ path: 'shots/chat-empty.png' });

// 发一条消息，等 mock 流式回完（含思考链）
await page.fill('textarea', '今天有点累，陪我说说话好不好');
await page.keyboard.press('Enter');
await page.waitForTimeout(4500);
await page.screenshot({ path: 'shots/chat-live.png' });

await browser.close();
console.log('done');
