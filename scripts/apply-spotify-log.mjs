// Spotify 出错时把原话写进 pm2 日志（以前只回给前端闪一下，服务器这边什么都不留，没法查）。
// 需要先跑过 apply-spotify-device-fix.mjs。只改 server/proxy.mjs；改完 pm2 restart codeandpurrs。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const F = 'server/proxy.mjs';
const MARK = 'spotify-log-v1';
let s = readFileSync(F, 'utf8');
if (s.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }
const line = 'const message = friendlySpotifyError(String(err?.message || err));';
const n = s.split(line).length - 1;
if (!n) { console.error('没改任何东西：先跑 apply-spotify-device-fix.mjs'); process.exit(1); }
s = s.split(line).join(`${line}\n        console.warn('[spotify] ${MARK}', requestPath, message);`);
copyFileSync(F, F + '.bak-before-spotify-log');
writeFileSync(F, s);
try { execFileSync(process.execPath, ['--check', F], { stdio: 'pipe' }); }
catch (e) { copyFileSync(F + '.bak-before-spotify-log', F); console.error('语法检查没过，已还原'); process.exit(1); }
console.log(`SPOTIFY-LOG-OK 加好了（${n} 处），接着 pm2 restart codeandpurrs`);
