// 予予点歌第三个坑：「歌一推，我正在听的歌就停了，连播放列表都没了，他的歌也不响」。
// 日志证实：歌确实送到了她手机（25080RABDG），Spotify 也收下了，但手机没放出来。
// 原因：搜歌时没带 market 参数 → Spotify 不告诉我们这首歌在马来西亚能不能放，
//       is_playable 过滤形同虚设，常常挑中别的地区的版本。手机收到一整串放不了的歌，
//       把原来的列表换掉之后就卡住不动。
// 改法：搜歌带 market=from_token（按她账号所在地区搜），Spotify 会自动换成本地能放的版本，
//       放不了的直接过滤掉。只改 server/proxy.mjs；改完 pm2 restart codeandpurrs（不用 build）。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const F = 'server/proxy.mjs';
const MARK = 'spotify-market-v1';
let s = readFileSync(F, 'utf8');
if (s.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }
const anchor = "url.searchParams.set('limit', String(limit));";
if (s.split(anchor).length !== 2) { console.error('没改任何东西：搜歌那一行找不到或不止一处'); process.exit(1); }
s = s.replace(anchor, `${anchor}\n  url.searchParams.set('market', 'from_token'); // ${MARK}：只要她所在地区能放的版本`);
copyFileSync(F, F + '.bak-before-spotify-market');
writeFileSync(F, s);
try { execFileSync(process.execPath, ['--check', F], { stdio: 'pipe' }); }
catch (e) { copyFileSync(F + '.bak-before-spotify-market', F); console.error('语法检查没过，已还原'); process.exit(1); }
console.log('SPOTIFY-MARKET-OK 改好了，接着 pm2 restart codeandpurrs');
