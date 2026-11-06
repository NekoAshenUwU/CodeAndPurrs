// 予予点歌「卡片出来了但没声音」的修复。
// 原因：手机上的 Spotify App 被系统杀掉后，Spotify 设备列表里只剩「他的歌单 · CodeAndPurrs」
// 这个网页播放器的残影（页面早关了），服务器把十首歌送给了它 → 接口说成功，实际谁也没在放。
// 改法：1) 选设备时跳过不活跃的网页播放器残影，宁可明确报错让她打开 Spotify App；
//       2) 送完歌再问一次 Spotify 是不是真的在放，没在放就如实报错，不再假装成功；
//       3) 「no list was loaded」这类英文报错翻成人话。
// 只改 server/proxy.mjs，改完 pm2 restart codeandpurrs 即可（不用 build）。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const F = 'server/proxy.mjs';
const MARK = 'spotify-device-fix-v1';
let s = readFileSync(F, 'utf8');
if (s.includes(MARK)) { console.log('已经改过了，不用再跑。'); process.exit(0); }
const fail = (why) => { console.error('没改任何东西：' + why); process.exit(1); };

const pickOld = 'const device = usable.find((item) => item.is_active) || usable[0];';
if (!s.includes(pickOld)) fail('找不到 ai-play 里选设备那一行');
const playOld = 'await spotifyPlayUris(session.accessToken, device, tracks.map((track) => track.uri));';
if (!s.includes(playOld)) fail('找不到 ai-play 里送歌那一行');
const helperAnchor = 'async function planSpotifyPick(prompt) {';
if (!s.includes(helperAnchor)) fail('找不到 planSpotifyPick');

s = s.replace(pickOld, `// ${MARK}：网页播放器只有正在用的时候才算数，否则它多半是关掉页面后留下的残影
        const isWebGhost = (item) => /CodeAndPurrs/i.test(String(item?.name || '')) && !item?.is_active;
        const real = usable.filter((item) => !isWebGhost(item));
        const device = real.find((item) => item.is_active)
          || real.find((item) => item.type === 'Smartphone')
          || real[0];
        if (!device) throw new Error('手机上的 Spotify 没开着（可能被系统清后台了）：先打开 Spotify App，放后台就行，再让他点一次');`);

s = s.replace(playOld, `${playOld}
        await confirmSpotifyPlaying(session.accessToken, device);`);

s = s.replace(helperAnchor, `// ${MARK}：送完歌确认真的响了，没响就如实报错
async function confirmSpotifyPlaying(accessToken, device) {
  for (const wait of [1200, 1800]) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: \`Bearer \${accessToken}\` },
    });
    if (response.status === 204) continue;
    const data = await response.json().catch(() => ({}));
    if (data?.is_playing && (!data?.device?.id || data.device.id === device.id)) return;
  }
  throw new Error(\`歌送到「\${device.name || 'Spotify'}」了，但它没响：打开手机上的 Spotify App 再让他点一次\`);
}

function friendlySpotifyError(message) {
  if (/no list was loaded|No active device|NO_ACTIVE_DEVICE/i.test(message)) {
    return '现在没有在放的歌单：先打开手机上的 Spotify App，再让他点一次歌';
  }
  return message;
}

${helperAnchor}`);

// ai-play 和 control 的报错都过一遍翻译
const errLine = "const message = String(err?.message || err);";
const count = s.split(errLine).length - 1;
if (count < 1) fail('找不到报错处理那几行');
s = s.split(errLine).join('const message = friendlySpotifyError(String(err?.message || err));');

copyFileSync(F, F + '.bak-before-spotify-device-fix');
writeFileSync(F, s);
try { execFileSync(process.execPath, ['--check', F], { stdio: 'pipe' }); }
catch (e) { copyFileSync(F + '.bak-before-spotify-device-fix', F); fail('语法检查没过，已还原：' + String(e.stderr || e)); }
console.log(`SPOTIFY-FIX-OK 改好了（报错翻译 ${count} 处），接着 pm2 restart codeandpurrs`);
