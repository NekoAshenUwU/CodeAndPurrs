// 自动唤醒的口气更像平常的予予：1~3 句、最多 120 字（原来 1~2 句、60 字），思考从 low 调到 medium，
// 截断上限 120→240，并提醒他用平时聊天的口气。只改 server/autowake.mjs；之后 pm2 restart codeandpurrs。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = process.argv[2] || 'server/autowake.mjs';
let src = readFileSync(FILE, 'utf8');
if (src.includes('用你平时跟她聊天的口气')) {
  console.log('已经改过了，不用再跑。');
  process.exit(0);
}
const did = [];
const lenRe = /只发一条自然的短消息，1到2句、最多60个中文字符；/;
if (lenRe.test(src)) {
  src = src.replace(lenRe, '只发一条自然的消息，1到3句、最多120个中文字符；用你平时跟她聊天的口气、称呼和小脾气，别变得客气、正式或像在汇报；');
  did.push('长度和口气');
}
const capRe = /const MAX_WAKE_CHARS = \d+;/;
if (capRe.test(src)) { src = src.replace(capRe, 'const MAX_WAKE_CHARS = 240;'); did.push('截断上限'); }
const thinkRe = /(memoryTools: false,\s*\n\s*thinking: )'low'/;
if (thinkRe.test(src)) { src = src.replace(thinkRe, "$1'medium'"); did.push('思考'); }
if (!did.length) {
  console.error('没改任何东西：一个锚点都没找到（「只发一条自然的短消息…」/ MAX_WAKE_CHARS / thinking: \'low\'）');
  process.exit(1);
}
copyFileSync(FILE, `${FILE}.bak-before-voice`);
writeFileSync(FILE, src);
try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'inherit' });
} catch {
  copyFileSync(`${FILE}.bak-before-voice`, FILE);
  console.error('改完语法检查没过，已经还原');
  process.exit(1);
}
console.log('VOICE-OK 改了：' + did.join('、') + '，接着 pm2 restart codeandpurrs');
