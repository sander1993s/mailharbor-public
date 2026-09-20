// Only the public application shell is cached. Mail, sessions, and OAuth never enter Cache Storage.
const CACHE = 'mailharbor-shell-v0.8.6';
const ASSETS = ['/', '/index.html', '/app.mjs', '/account-setup.mjs', '/api-request.mjs', '/mail.mjs', '/mail-attachments.mjs', '/mail-attachments.css', '/mail-conversation.mjs', '/mail-tools.mjs', '/mail-tools.css', '/telegram-settings.mjs', '/controls.mjs', '/controls.css', '/mail-content.mjs', '/mail-content.css', '/compose.mjs', '/compose.css', '/filing.mjs', '/processing.mjs', '/processing.css', '/styles.css', '/logo.png', '/manifest.webmanifest', '/vendor/pdfjs/pdf.mjs', '/vendor/pdfjs/pdf.worker.mjs'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('mailharbor-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !ASSETS.includes(url.pathname)) return;
  // Navigation and assets use the network first so a refresh sees a new release.
  event.respondWith(fetch(event.request).catch(async () => {
    const cached = await caches.match(url.pathname);
    return cached || new Response('MailHarbor is offline. Reconnect to your Tailscale network and reload.', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}});
  }));
});

// Push contains only a generic signal; subjects and senders stay on the server.
self.addEventListener('push', event => {
  event.waitUntil(self.registration.showNotification('New mail', {
    body: 'Open MailHarbor to check your mailboxes.', icon: '/logo.png', badge: '/logo.png', tag: 'mailharbor-new-mail'
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(async clients => {
    const client = clients.find(value => new URL(value.url).origin === self.location.origin);
    // Preserve unsaved compose text and attachments in an existing client.
    if (client) return client.focus();
    return self.clients.openWindow('/#inbox');
  }));
});
