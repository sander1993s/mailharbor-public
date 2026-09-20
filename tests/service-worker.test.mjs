import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/sw.mjs', import.meta.url), 'utf8');
function harness({ windows = [], offline = false } = {}) {
  const handlers = new Map(), cached = [], fetched = [], matches = [], notifications = [], opened = [], deleted = [];
  const self = { location: { origin: 'https://mail.example.test' }, addEventListener: (name, callback) => handlers.set(name, callback),
    clients: { matchAll: async () => windows, openWindow: async url => opened.push(url), claim: async () => {} },
    registration: { showNotification: async (...args) => notifications.push(args) } };
  const caches = { open: async () => ({ addAll: async assets => cached.push(...assets) }), keys: async () => ['mailharbor-shell-old', 'other-app-cache'],
    delete: async key => deleted.push(key), match: async key => { matches.push(key); return new Response('public cached shell'); } };
  vm.runInNewContext(source, { self, caches, URL, Response, fetch: async request => { fetched.push(request.url); if (offline) throw new Error('offline'); return new Response('public live shell'); } });
  async function dispatch(type, values = {}) {
    let waiting, responding;
    const event = { ...values, waitUntil: promise => { waiting = promise; }, respondWith: promise => { responding = promise; } };
    handlers.get(type)(event); await waiting; return responding ? await responding : null;
  }
  return { dispatch, cached, fetched, matches, notifications, opened, deleted };
}

test('notification clicks focus existing OAuth/index clients without reloading unsaved compose state', async () => {
  for (const path of ['/?connected=1#accounts', '/index.html#inbox', '/#inbox']) {
    const client = { url: `https://mail.example.test${path}`, unsavedDraft: 'PRIVATE_UNSAVED_DRAFT', async focus() { this.focused = true; },
      async navigate() { this.unsavedDraft = ''; throw new Error('Notification must not navigate an existing app document'); } };
    const fixture = harness({ windows: [{ url: 'https://other.example.test/', async focus() { assert.fail('Do not focus another origin'); } }, client] });
    let closed = false;
    await fixture.dispatch('notificationclick', { notification: { close() { closed = true; } } });
    assert.equal(closed, true); assert.equal(client.focused, true); assert.equal(client.unsavedDraft, 'PRIVATE_UNSAVED_DRAFT'); assert.deepEqual(fixture.opened, []);
  }
  const fixture = harness(); await fixture.dispatch('notificationclick', { notification: { close() {} } }); assert.deepEqual(fixture.opened, ['/#inbox']);
});

test('push displays a fixed generic notification and ignores arbitrary remote payload content', async () => {
  const fixture = harness();
  await fixture.dispatch('push', { data: { json: () => ({ title: 'PRIVATE_SUBJECT', body: 'PRIVATE_MAIL_BODY', url: 'https://evil.example/' }) } });
  const [title, options] = fixture.notifications[0]; assert.equal(title, 'New mail'); assert.equal(options.tag, 'mailharbor-new-mail');
  assert.doesNotMatch(JSON.stringify(fixture.notifications), /PRIVATE_|evil\.example/);
});

test('service worker caches only public shell assets and never intercepts API, OAuth or cross-origin requests', async () => {
  const fixture = harness({ offline: true }); await fixture.dispatch('install');
  assert.ok(fixture.cached.includes('/compose.mjs')); assert.ok(fixture.cached.includes('/mail-content.css'));
  assert.ok(fixture.cached.every(path => path.startsWith('/') && !/[?#]/u.test(path) && !/^\/(?:api|oauth)\//u.test(path)));
  for (const [path, method] of [['/api/mail/message', 'POST'], ['/api/mail/content', 'POST'], ['/api/mail/smtp', 'GET'], ['/api/session', 'GET'],
    ['/oauth/google/callback?code=PRIVATE_CODE', 'GET'], ['/?connected=1', 'GET'], ['/index.html?token=PRIVATE_TOKEN', 'GET'], ['/app.mjs', 'POST'],
    ['https://other.example.test/app.mjs', 'GET']]) {
    assert.equal(await fixture.dispatch('fetch', { request: { url: new URL(path, 'https://mail.example.test').href, method } }), null, path);
  }
  assert.deepEqual(fixture.matches, []); assert.deepEqual(fixture.fetched, []);
  const response = await fixture.dispatch('fetch', { request: { url: 'https://mail.example.test/app.mjs', method: 'GET' } });
  assert.equal(await response.text(), 'public cached shell'); assert.deepEqual(fixture.matches, ['/app.mjs']);
  await fixture.dispatch('activate'); assert.deepEqual(fixture.deleted, ['mailharbor-shell-old']);
});
