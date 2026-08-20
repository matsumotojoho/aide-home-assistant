// Aide Service Worker — Web Push受信 + 通知クリックでアプリを開く
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Aide', body: '' };
  try {
    data = event.data.json();
  } catch (e) {
    /* noop */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Aide', {
      body: data.body || '',
      icon: '/icon-180.png',
      badge: '/icon-180.png',
      tag: 'aide-' + (data.level || 'info'),
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
