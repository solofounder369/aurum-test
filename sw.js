// Aurum service worker: lets the app be installed and opens the right chat when a notification is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // network as normal; present so the app can be installed

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const chat = (e.notification.data && e.notification.data.chat) || '';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        c.postMessage({open: chat});
        return;
      }
    }
    await self.clients.openWindow('./' + (chat ? '?chat=' + encodeURIComponent(chat) : ''));
  })());
});
