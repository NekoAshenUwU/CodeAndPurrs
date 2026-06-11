import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:5173';
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  permissions: ['microphone'],
});
const page = await context.newPage();

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

// 切到语音模式，按住录 2 秒再松开 → mock 转写 + mock 回复
await page.click('.chat-input__mode');
await page.waitForTimeout(200);
await page.screenshot({ path: 'shots/voice-mode.png' });

const hold = page.locator('.chat-input__hold');
await hold.hover();
await page.mouse.down();
await page.waitForTimeout(1800);
await page.mouse.up();
await page.waitForTimeout(5000); // 等转写 + mock 回复
// 点开「转文字」看看
const t2t = page.locator('.voice-wrap__t2t').last();
if (await t2t.count()) await t2t.click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/voice-live.png' });

await browser.close();
console.log('done');
