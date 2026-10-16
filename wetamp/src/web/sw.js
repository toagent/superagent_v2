self.addEventListener('push', event => {
  const data = event.data?.json();
  if (!data || typeof data.url !== 'string' || !/^\/\?decision=[a-f0-9]{64}$/.test(data.url))
    return;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.png',
      tag: data.url,
      data: { url: data.url },
    })
  );
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data.url, self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(self.clients.openWindow(url.href));
});
// Deliberately no fetch handler: approval responses and sessions are never cached.
