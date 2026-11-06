// 予予点歌第二个坑：「推过去后正在放的歌立刻停了，他的歌也没响」。
// 原因：旧的 spotifyPlayUris 对不活跃设备先发一次「切换设备 + 不播放」(transfer play:false)，
// 这一步本身就会把手机上正在放的歌暂停；350ms 后再发 play，手机还在切换中，经常吞掉不执行。
// 改法：不再单独 transfer，直接 PUT /me/player/play?device_id=…（Spotify 官方：这个调用自带切设备），
//       设备忙/没找到(404/502/503)时隔一会重试，最多 3 次。播不成也不会先把她正在听的歌停掉。
// 只改 server/proxy.mjs；改完 pm2 restart codeandpurrs（不用 build）。跟 apply-spotify-device-fix.mjs 互不冲突，先跑哪个都行。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const F = 'server/proxy.mjs';
const MARK = 'spotify-play-direct-v1';
let s = readFileSync(F, 'utf8');
if (s.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }
const fail = (why) => { console.error('没改任何东西：' + why); process.exit(1); };

const re = /async function spotifyPlayUris\(accessToken, device, uris\) \{[\s\S]*?\n\}\n/;
const m = s.match(re);
if (!m) fail('找不到 spotifyPlayUris 函数');
if (!m[0].includes("transfer")) fail('spotifyPlayUris 长得跟预想的不一样，先别动');

s = s.replace(re, `// ${MARK}：直接 play?device_id，不先 transfer(play:false)——那一步会先把正在放的歌停掉
async function spotifyPlayUris(accessToken, device, uris) {
  if (!device?.id) throw new Error('Spotify 没有可用的播放设备，请打开 Spotify App 后再点歌');
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
    const response = await fetch(\`https://api.spotify.com/v1/me/player/play?device_id=\${encodeURIComponent(device.id)}\`, {
      method: 'PUT',
      headers: { Authorization: \`Bearer \${accessToken}\`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris }),
    });
    if (response.ok || response.status === 204) return;
    const data = await response.json().catch(() => ({}));
    lastError = data?.error?.message || \`Spotify 播放失败（\${response.status}）\`;
    console.warn('[spotify] play 第' + (attempt + 1) + '次失败', response.status, lastError);
    if (![404, 502, 503].includes(response.status)) break;
  }
  throw new Error(lastError);
}
`);

copyFileSync(F, F + '.bak-before-spotify-play-direct');
writeFileSync(F, s);
try { execFileSync(process.execPath, ['--check', F], { stdio: 'pipe' }); }
catch (e) { copyFileSync(F + '.bak-before-spotify-play-direct', F); fail('语法检查没过，已还原：' + String(e.stderr || e)); }
console.log('SPOTIFY-DIRECT-OK 改好了，接着 pm2 restart codeandpurrs');
