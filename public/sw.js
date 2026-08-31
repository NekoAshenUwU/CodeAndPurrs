// CodeAndPurrs service worker：不缓存页面，专门负责真后台自动唤醒。
// 推送本身不带私密正文；SW 被唤醒后用同源 HttpOnly 设备 cookie 领取消息。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // no-op：交给浏览器默认网络请求处理
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const response = await fetch('/api/autowake/push-message', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) return;
    const body = await response.json();
    const message = body?.message;
    if (!message?.id || !message?.content) return;

    const url = `/purr-channel?autowakeWindow=${encodeURIComponent(message.windowId || '')}&autowake=${encodeURIComponent(message.id)}`;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'codeandpurrs:autowake', id: message.id });

    await self.registration.showNotification(message.assistantName || message.windowName || 'CodeAndPurrs', {
      body: message.content,
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      tag: `codeandpurrs-autowake-${message.id}`,
      renotify: true,
      data: { url, id: message.id },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || '/purr-channel', self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (!client.url.startsWith(self.location.origin)) continue;
      await client.focus();
      if ('navigate' in client) await client.navigate(target);
      return;
    }
    await self.clients.openWindow(target);
  })());
});
