import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { createMailNotifications } from '../server/mail-notifications.mjs';

const folderId = `folder:${'a'.repeat(64)}`;
const state = (uidNext = 2, overrides = {}) => ({ accountId: 'a', folderId, uidValidity: '1', uidNext, unseen: 1, messages: 1, ...overrides });
const registration = (endpoint = 'https://fcm.googleapis.com/fcm/send/device') => {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};
function harness() {
  let data = {}, pending = Promise.resolve(), result = { states: [state()], errors: [] }, currentTime = 100000;
  const account = { id: 'a', email: 'PRIVATE_OWNER@example.test', revision: '1' }, sent = [], calls = [];
  const store = { read: () => structuredClone(data), update(work) {
    const operation = pending.then(async () => { const copy = structuredClone(data); const value = await work(copy); data = copy; return value; });
    pending = operation.catch(() => {}); return operation;
  } };
  const accounts = { list: () => [{ id: 'a', connected: true }], get: () => ({ ...account }) };
  const reader = { changes: async (current, options) => { calls.push({ current, options }); return result; } };
  const push = { generateVAPIDKeys: () => ({ publicKey: 'PUBLIC_KEY', privateKey: 'PRIVATE_KEY' }),
    async sendNotification(...args) { sent.push(args); } };
  const notifications = createMailNotifications({ store, accounts, reader, push, origin: 'https://mail.example.test', now: () => currentTime, intervalMs: 600000 });
  return { notifications, store, accounts, account, reader, push, sent, calls, set: value => { result = value; currentTime += 1000; } };
}

test('notifications establish baseline, notify only increasing UIDNEXT, and send no mail data', async t => {
  const h = harness(); t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration()); await h.notifications.poll();
  assert.equal(h.sent.length, 0);
  h.set({ states: [state(2, { unseen: 0 })], errors: [] }); await h.notifications.poll(); assert.equal(h.sent.length, 0);
  h.set({ states: [state(3, { subject: 'PRIVATE_SUBJECT', body: 'PRIVATE_BODY' })], errors: [] }); await h.notifications.poll();
  assert.equal(h.sent.length, 1); const [subscription, payload, options] = h.sent[0];
  assert.equal(subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/device');
  assert.deepEqual(JSON.parse(payload), { title: 'New mail', body: 'Open MailHarbor to read your new mail.', url: '/#inbox' });
  assert.doesNotMatch(payload, /PRIVATE_|uidNext|accountId/); assert.equal(options.TTL, 3600);
  assert.doesNotMatch(JSON.stringify(h.store.read().mailNotifications.states), /PRIVATE_SUBJECT|PRIVATE_BODY/);
  await h.notifications.poll(); assert.equal(h.sent.length, 1);
  h.set({ states: [state(20, { uidValidity: '2' })], errors: [] }); await h.notifications.poll(); assert.equal(h.sent.length, 1);
});

test('temporary account errors preserve baseline; recovered arrivals notify once and errors are sanitized', async t => {
  const h = harness(); t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration()); await h.notifications.poll();
  h.set({ states: [], errors: [{ accountId: 'a', code: 'mailbox_error', message: 'PRIVATE_ERROR' }] });
  await h.notifications.poll(); assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2);
  assert.deepEqual(h.notifications.updates().errors, [{ accountId: 'a', code: 'mailbox_error' }]);
  h.set({ states: [state(4)], errors: [] }); await h.notifications.poll(); assert.equal(h.sent.length, 1);
});

test('expired push subscriptions are removed on 404/410 while transient failure remains retryable on next arrival', async t => {
  for (const statusCode of [404, 410, 503]) {
    const h = harness(); t.after(() => h.notifications.close());
    await h.notifications.subscribe(registration()); await h.notifications.poll();
    h.push.sendNotification = async () => { throw { statusCode }; };
    h.set({ states: [state(3)], errors: [] }); await h.notifications.poll();
    assert.equal(Object.keys(h.store.read().mailNotifications.subscriptions).length, statusCode === 503 ? 1 : 0);
    if (statusCode === 503) assert.deepEqual(h.notifications.updates().errors, [{ code: 'notification_unavailable' }]);
  }
});

test('push registrations reject private URLs, host suffix tricks, credentials, fragments, ports and invalid keys', async t => {
  const h = harness(); t.after(() => h.notifications.close());
  for (const endpoint of ['http://fcm.googleapis.com/send', 'https://127.0.0.1/send', 'https://localhost/send',
    'https://fcm.googleapis.com.evil.test/send', 'https://evil-fcm.googleapis.com/send', 'https://user@fcm.googleapis.com/send',
    'https://fcm.googleapis.com:8443/send', 'https://fcm.googleapis.com/send#fragment', 'https://[::1]/send']) {
    await assert.rejects(h.notifications.subscribe(registration(endpoint)), { code: 'invalid_request' });
  }
  for (const keys of [{ p256dh: 'x'.repeat(87), auth: 'x'.repeat(22) }, { p256dh: 'bad', auth: 'bad' }]) {
    await assert.rejects(h.notifications.subscribe({ ...registration(), keys }), { code: 'invalid_request' });
  }
  assert.equal(h.calls.length, 0); assert.deepEqual(h.store.read(), {});
});

test('polls are serialized, account changes discard late results and close cancels the active watcher', async t => {
  const h = harness(); t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration()); await h.notifications.poll();
  let release, signal, count = 0;
  h.reader.changes = async (_accounts, options) => { signal = options.signal; count++; return new Promise(resolve => { release = resolve; }); };
  const first = h.notifications.poll(), second = h.notifications.poll();
  assert.equal(count, 1); h.account.revision = '2'; release({ states: [state(3)], errors: [] }); await Promise.all([first, second]);
  assert.equal(h.sent.length, 0); assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2);
  const pending = h.notifications.poll(), closing = h.notifications.close();
  assert.equal(signal.aborted, true); release({ states: [state(4)], errors: [] }); await Promise.all([pending, closing]);
  assert.equal(h.sent.length, 0);
});

test('Windows push service endpoints are accepted and unsubscription normalizes HTTPS default ports', async t => {
  const h = harness(); t.after(() => h.notifications.close());
  const endpoint = 'https://wns.notify.windows.com:443/w/?token=opaque';
  await h.notifications.subscribe(registration(endpoint)); await h.notifications.poll();
  assert.equal((await h.notifications.settings()).devices, 1);
  await h.notifications.unsubscribe({ endpoint }); assert.equal((await h.notifications.settings()).devices, 0);
});
