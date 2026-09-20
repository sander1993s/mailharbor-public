import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, closeServer } from '../server/app.mjs';
import { createWebFactory } from '../server/web-app.mjs';
import { createMailCacheReader } from '../server/mail-cache-reader.mjs';
import { MailHarborError } from '../server/validation.mjs';

const origin = 'https://mail.example.test:9443';
const pairingToken = 'test-only-pairing-token-abcdefghijklmnopqrstuvwxyz';
const botToken = '123456:PRIVATE_SYNTHETIC_BOT_TOKEN_12345';
function memoryStore() {
  let data = { schema: 1, providers: {}, accounts: [{ id: 'business-imap', provider: 'imap', email: 'business@example.test', label: 'Business', host: 'imap.example.test', port: 993, secure: true,
    auth: { type: 'password', password: 'PRIVATE_ACCOUNT_PASSWORD' }, revision: 'revision-one', connectedAt: '2026-09-20' }] };
  let chain = Promise.resolve();
  return { read: () => structuredClone(data), update(change) {
    const result = chain.then(async () => { const copy = structuredClone(data); const returned = await change(copy); data = copy; return returned; });
    chain = result.catch(() => {}); return result;
  } };
}
async function app(t, { verifyError } = {}) {
  const store = memoryStore(), calls = [];
  const telegramSender = {
    async verify(input) { calls.push('verify'); if (verifyError) throw verifyError; return { botId: 123456, chatId: input.chatId }; },
    async send(input) { input.beforeSend?.(); calls.push('send'); return { messageId: 17 }; }
  };
  const notificationReader = { async checkpoint() { calls.push('checkpoint'); return { path: 'INBOX', uidValidity: '1', afterUid: 42 }; } };
  const factory = createWebFactory({ origin, stateDir: '/unused-with-injected-store' }, { store, telegramSender, notificationReader,
    reader: { async list() { return { messages: [], errors: [] }; } },
    notifications: { updates: () => ({}), close() {} }, processing: { status: () => ({ enabled: false }), async close() {} },
    labelSync: { async close() {} } });
  const server = createServer({ pairingToken }, async () => { throw new Error('No Agy call is allowed'); }, { createWeb: factory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const request = (route, { method = 'GET', session, input, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const body = input === undefined ? raw : JSON.stringify(input);
    const requestHeaders = { Host: new URL(origin).host,
      ...(session ? { Cookie: session.cookie, 'X-Mailharbor-CSRF': session.csrf } : {}),
      ...(method !== 'GET' ? { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers };
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method,
      headers: Object.fromEntries(Object.entries(requestHeaders).filter(([, value]) => value !== undefined)) }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject); req.end(body);
  });
  const login = async () => {
    const response = await request('/api/session', { method: 'POST', input: { token: pairingToken } });
    assert.equal(response.status, 200);
    return { csrf: response.body.csrf, cookie: response.headers['set-cookie'][0].split(';')[0] };
  };
  return { request, login, calls, store };
}

test('Telegram settings, explicit tests and retries require an authenticated same-origin CSRF request', async t => {
  const h = await app(t);
  assert.equal((await h.request('/api/mail/telegram')).status, 401);
  for (const route of ['/api/mail/telegram', '/api/mail/telegram/test', '/api/mail/telegram/retry']) {
    assert.equal((await h.request(route, { method: 'POST', input: {} })).status, 401);
  }
  const session = await h.login();
  for (const route of ['/api/mail/telegram', '/api/mail/telegram/test', '/api/mail/telegram/retry']) {
    for (const headers of [{ 'X-Mailharbor-CSRF': undefined }, { Origin: 'https://attacker.example.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const result = await h.request(route, { method: 'POST', session, input: {}, headers });
      assert.equal(result.status, 401, route); assert.doesNotMatch(result.text, /PRIVATE_/u);
    }
  }
  assert.deepEqual(h.calls, []);
});

test('saving and enabling Telegram config never sends a message and never returns credentials', async t => {
  const h = await app(t), session = await h.login();
  const saved = await h.request('/api/mail/telegram', { method: 'POST', session, input: { accountId: 'business-imap', token: botToken, chatId: '987654', language: 'nl-BE' } });
  assert.equal(saved.status, 200); assert.equal(saved.body.verified, true); assert.equal(saved.body.enabled, false);
  assert.deepEqual(h.calls, ['verify']); assert.doesNotMatch(saved.text, /PRIVATE_|987654/u);
  assert.equal(h.store.read().mailTelegram.token, botToken);
  const enabled = await h.request('/api/mail/telegram', { method: 'POST', session, input: { enabled: true } });
  assert.equal(enabled.status, 200); assert.equal(enabled.body.enabled, true);
  assert.deepEqual(h.calls, ['verify', 'checkpoint']);
  const status = await h.request('/api/mail/telegram', { session });
  assert.equal(status.status, 200); assert.equal(status.headers['cache-control'], 'no-store');
  assert.doesNotMatch(status.text + enabled.text, /PRIVATE_|987654/u);
  const sent = await h.request('/api/mail/telegram/test', { method: 'POST', session, input: {} });
  assert.equal(sent.status, 200); assert.deepEqual(sent.body, { sent: true, messageId: 17 });
  assert.deepEqual(h.calls, ['verify', 'checkpoint', 'send']);
});

test('Telegram API rejects malformed bodies, unsupported settings and premature actions before dependencies', async t => {
  const h = await app(t), session = await h.login();
  for (const input of [{ enabled: 'true' }, { enabled: true, accountId: '../different' }, { language: 'xx' },
    { token: 'bad' }, { chatId: '-100123' }, { threshold: 0.1 }]) {
    assert.equal((await h.request('/api/mail/telegram', { method: 'POST', session, input })).status, 400);
  }
  assert.equal((await h.request('/api/mail/telegram', { method: 'POST', session, raw: '{broken' })).status, 400);
  assert.equal((await h.request('/api/mail/telegram', { method: 'POST', session, input: { token: 'x'.repeat(33000) } })).status, 413);
  assert.equal((await h.request('/api/mail/telegram', { method: 'POST', session, input: { enabled: true } })).status, 422);
  assert.equal((await h.request('/api/mail/telegram/test', { method: 'POST', session, input: {} })).status, 422);
  assert.equal((await h.request('/api/mail/telegram/test', { method: 'POST', session, input: { chatId: 'other' } })).status, 400);
  assert.equal((await h.request('/api/mail/telegram/retry', { method: 'POST', session, input: { id: '../private' } })).status, 400);
  assert.deepEqual(h.calls, []);
});

test('Telegram verification failures expose only enumerated safe diagnostics and save no secret', async t => {
  const h = await app(t, { verifyError: new MailHarborError('telegram_forbidden', 'PRIVATE_TOKEN_AND_PROVIDER_REPLY') }), session = await h.login();
  const response = await h.request('/api/mail/telegram', { method: 'POST', session, input: { token: botToken, chatId: '987654' } });
  assert.equal(response.status, 422); assert.equal(response.body.error.code, 'telegram_forbidden');
  assert.doesNotMatch(response.text, /PRIVATE_/u); assert.equal(h.store.read().mailTelegram, undefined);
  assert.deepEqual(h.calls, ['verify']);
});

test('capture hooks cover decorated reader and explicit mutations even when mailbox cache is disabled', async () => {
  const account = { id: 'business-imap', email: 'a@example.test', host: 'mail.example.test', revision: 'one' };
  const reference = { accountId: account.id, path: 'INBOX', uidValidity: '1', uid: 1, fingerprint: 'a'.repeat(64) };
  const events = [];
  const adapter = await createMailCacheReader({ accounts: [account], enabled: false,
    cache: { beginMutation() { events.push('cache-start'); return {}; }, endMutation() { events.push('cache-end'); } },
    beforeMutation: async (current, change) => { events.push('capture'); assert.equal(current.revision, 'one'); assert.deepEqual(change.references, [reference]); },
    reader: { async apply(current, ref, action) { events.push('provider'); assert.equal(action, 'archive'); return { applied: true }; } } });
  await adapter.reader.apply(account, reference, 'archive');
  assert.deepEqual(events, ['capture', 'cache-start', 'provider', 'cache-end']);
  events.length = 0;
  await adapter.withMutation(account, { reason: 'moveBatch', references: [reference] }, async () => events.push('provider'));
  assert.deepEqual(events, ['capture', 'cache-start', 'provider', 'cache-end']);
});

test('failed durable capture prevents provider and cache mutations through both wrappers', async () => {
  const account = { id: 'business-imap', email: 'a@example.test', revision: 'one' };
  let writes = 0;
  const adapter = await createMailCacheReader({ accounts: [account], enabled: false,
    cache: { beginMutation() { writes++; } }, beforeMutation: async () => { throw new MailHarborError('notification_unavailable'); },
    reader: { async apply() { writes++; } } });
  await assert.rejects(adapter.reader.apply(account, { path: 'INBOX' }, 'archive'), { code: 'notification_unavailable' });
  await assert.rejects(adapter.withMutation(account, { reason: 'moveBatch' }, async () => { writes++; }), { code: 'notification_unavailable' });
  assert.equal(writes, 0);
});
