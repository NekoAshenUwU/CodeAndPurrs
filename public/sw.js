// 极简 service worker：只为让浏览器把站点当作可安装的 PWA。
// 故意不做任何缓存（避免出现"改了不更新"的旧缓存问题），一律走网络。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // no-op：交给浏览器默认网络请求处理
});
