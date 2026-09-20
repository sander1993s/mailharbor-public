import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, closeServer } from '../server/app.mjs';
import { createWebFactory } from '../server/web-app.mjs';
import { ACCOUNT_PRESETS } from './fixtures/accounts.mjs';
import { MailHarborError } from '../server/validation.mjs';

const origin = 'https://experience.example.test:9443', host = new URL(origin).host;
const token = 'experience-fixture-token-abcdefghijklmnopqrstuvwxyz';
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const reference = { accountId: 'business-imap', path: 'INBOX', uid: 1, uidValidity: '1', fingerprint: 'a'.repeat(64) };
const header = { id: 'sample-message', accountId: 'business-imap', account: 'Fixture', subject: 'Synthetic mail', author: 'a@example.test',
  date: '2026-09-20T08:00:00Z', folderPath: 'INBOX', reference };
const listResult = () => ({ messages: [structuredClone(header)], total: 1, totalComplete: true, errors: [], nextCursor: null });
const flatStatus = { enabled: false, healthy: true, available: true, maxHeadersPerAccount: 500, accounts: [], refreshing: false };

async function harness(t, { deps = {}, config = {}, accountIds = ['business-imap'], runner } = {}) {
  let data = { schema: 1, providers: {}, accounts: ACCOUNT_PRESETS.filter(a => accountIds.includes(a.id)).map(a => ({ ...a, revision: 'r1',
    connectedAt: '2026-09-20', archivePath: 'Archive', auth: { type: 'password', password: 'fixture-only' } })) };
  let pending = Promise.resolve();
  const store = { read: () => structuredClone(data), update(change) { const next = pending.then(async () => {
    const copy = structuredClone(data); const result = await change(copy); data = copy; return result;
  }); pending = next.catch(() => {}); return next; } };
  const reader = { async folders() { return { folders: [], errors: [] }; }, async list() { return listResult(); },
    async read() { return { ...header, body: 'Synthetic body', attachments: [] }; } };
  const notifications = { async ingest() {}, async close() {} };
  const mailboxes = { async test() { return { archivePath: 'Archive', folders: [{ path: 'INBOX' }, { path: 'Archive' }, { path: 'Other' }] }; },
    async scan() { return { messages: [], references: new Map(), totalUnread: 0, inboxCount: 1 }; }, async apply() { return { applied: [], failed: [] }; } };
  const baseDeps = { store, reader, mailboxes, mailCache: null, notifications,
    processing: { async close() {} }, labelSync: { async close() {} }, invoices: { async close() {} }, drive: { async close() {} }, ...deps };
  const factory = createWebFactory({ origin, stateDir: '/unused-synthetic', ...config }, baseDeps);
  const server = createServer({ pairingToken: token }, runner ?? (async () => { throw new Error('AI must not run'); }), { createWeb: factory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const port = server.address().port;
  function start(route, { method = 'GET', session, input, headers = {} } = {}) {
    const bytes = input === undefined ? undefined : JSON.stringify(input);
    let request;
    const promise = new Promise((resolve, reject) => {
      const supplied = { Host: host, ...(session ? { Cookie: session.cookie, 'X-Mailharbor-CSRF': session.csrf } : {}),
        ...(!['GET', 'HEAD'].includes(method) ? { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } : {}),
        ...(bytes !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {}), ...headers };
      request = http.request({ hostname: '127.0.0.1', port, path: route, method,
        headers: Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== undefined)) }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: response.statusCode, headers: response.headers, text,
            body: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
        });
      }); request.on('error', reject); request.end(bytes);
    });
    return { request, promise };
  }
  const call = (route, options) => start(route, options).promise;
  const login = async () => { const result = await call('/api/session', { method: 'POST', input: { token } }); assert.equal(result.status, 200);
    return { csrf: result.body.csrf, cookie: result.headers['set-cookie'][0].split(';')[0] }; };
  return { call, start, login, server, store, reader };
}

test('new public assets are fixed GET/HEAD routes and reject queries or arbitrary vendor paths', async t => {
  const app = await harness(t);
  for (const route of ['/mail-attachments.mjs', '/mail-attachments.css', '/mail-conversation.mjs', '/api-request.mjs', '/vendor/pdfjs/pdf.mjs', '/vendor/pdfjs/pdf.worker.mjs']) {
    const result = await app.call(route); assert.equal(result.status, 200, route); assert.equal(result.headers['cache-control'], 'no-store');
    assert.match(result.headers['content-type'], route.endsWith('.css') ? /text\/css/ : /javascript/);
    assert.equal((await app.call(route, { method: 'HEAD' })).text, '');
    assert.notEqual((await app.call(`${route}?x=1`)).status, 200);
  }
  for (const route of ['/vendor/pdfjs/other.mjs', '/vendor/pdfjs/../../package.json']) assert.notEqual((await app.call(route)).status, 200);
});

test('conversation and inline content routes preserve verified handles and strict input boundaries', async t => {
  const calls = [];
  const app = await harness(t, { deps: { conversations: { async load(account, ref, options) {
    calls.push(['conversation', account.id, ref.uid, !!options.signal]); return { ...listResult(), complete: true, nextCursor: null };
  }, destroy() {} }, content: { async read(account, ref, options) { calls.push(['content', options.includeInlineImages]); return { html: '<p>Safe</p>', complete: true }; } } } });
  assert.equal((await app.call('/api/mail/conversation', { method: 'POST', input: { id: header.id } })).status, 401);
  const session = await app.login();
  assert.equal((await app.call('/api/mail/list', { method: 'POST', session, input: { folder: 'inbox' } })).status, 200);
  const conversation = await app.call('/api/mail/conversation', { method: 'POST', session, input: { id: header.id } });
  assert.equal(conversation.status, 200); assert.equal(conversation.body.complete, true); assert.doesNotMatch(conversation.text, /fingerprint|uidValidity/);
  assert.equal((await app.call('/api/mail/content', { method: 'POST', session, input: { id: header.id, includeInlineImages: 'true' } })).status, 400);
  assert.equal((await app.call('/api/mail/content', { method: 'POST', session, input: { id: header.id, includeInlineImages: true } })).status, 200);
  assert.deepEqual(calls, [['conversation', 'business-imap', 1, true], ['content', true]]);
});

test('recovery uses composer service and stays outside provider mutation barriers', async t => {
  const calls = [], barriers = [];
  const recovery = Object.fromEntries(['list', 'save', 'read', 'discard', 'preferences', 'configurePreferences'].map(name => [name, async input => { calls.push([name, input]); return { saved: true }; }]));
  const app = await harness(t, { deps: { composer: { recovery, close() {} }, createMailCacheReader: async ({ reader }) => ({ reader,
    withMutation: async (a, c, work) => { barriers.push(a.id); return work(); } }) } });
  const base = '/api/mail/compose';
  assert.equal((await app.call(`${base}/recovery`)).status, 401);
  const session = await app.login();
  const operations = [['/recovery', { composeId: 'draft1', revision: 0, content: {} }], ['/recovery/read', { composeId: 'draft1' }],
    ['/recovery/discard', { composeId: 'draft1', revision: 1 }], ['/preferences/read', { accountId: 'business-imap' }],
    ['/preferences', { accountId: 'business-imap', signature: 'Signature' }]];
  for (const [route, input] of operations) {
    assert.equal((await app.call(base + route, { method: 'POST', session, input: { ...input, unexpected: true } })).status, 400);
    assert.equal((await app.call(base + route, { method: 'POST', session, input, headers: { 'X-Mailharbor-CSRF': undefined } })).status, 401);
    assert.equal((await app.call(base + route, { method: 'POST', session, input })).status, 200);
  }
  assert.equal((await app.call(`${base}/recovery`, { session })).status, 200);
  assert.equal(calls.length, 6); assert.deepEqual(barriers, []);
});

test('cache flag, early sync notifications and content readers use their correct sources', async t => {
  for (const [enabled, healthy] of [[false, true], [true, false], [true, true]]) {
    const events = [], original = { async list() { return listResult(); } }, decorated = { ...original };
    const snapshot = { states: [], errors: [] };
    const app = await harness(t, { config: { mailCache: { enabled } }, deps: { mailCache: undefined, notifications: undefined, reader: original,
      createMailCache: async (directory, options) => { assert.equal(directory, null); assert.equal(options.rendererVersion, '2'); return { healthy: () => healthy, close() { events.push('cache-close'); } }; },
      createMailNotifications: options => { events.push(['notifications', typeof options.pollEnabled === 'function' ? options.pollEnabled() : options.pollEnabled]); assert.equal(options.reader, original); return { ingest: data => { assert.equal(data, snapshot); events.push('ingest'); }, close() {} }; },
      createMailSync: options => { events.push('sync'); assert.equal(options.autoSchedule, true); assert.equal(options.reader, original); options.changed('business-imap', { notificationSnapshot: snapshot }); return { close() { events.push('sync-close'); } }; },
      createMailCacheReader: async options => { assert.equal(options.enabled, enabled); assert.equal(options.reader, original); return { reader: decorated, status: () => flatStatus, withMutation: (a, c, work) => work() }; },
      createMailContent: options => { assert.equal(options.reader, decorated); assert.equal(options.inlineReader, original); return {}; }
    } });
    const session = await app.login(); assert.equal((await app.call('/api/mail/cache', { session })).status, 200);
    assert.deepEqual(events.slice(0, enabled && healthy ? 3 : 1), enabled && healthy ? [['notifications', false], 'sync', 'ingest'] : [['notifications', true]]);
    await closeServer(app.server);
    if (enabled && healthy) assert.ok(events.indexOf('sync-close') < events.indexOf('cache-close'));
  }
});

test('cache controls validate scope and disconnect purges cache before notifying', async t => {
  const calls = [], refresh = gate();
  const app = await harness(t, { deps: { mailCache: { healthy: () => true, async removeAccount(id) { calls.push(['purge', id]); }, close() {} },
    sync: { updateAccounts() { calls.push('update'); }, notificationSnapshot: () => ({ states: [], errors: [] }), close() {} },
    notifications: { ingest() { calls.push('ingest'); }, close() {} },
    createMailCacheReader: async ({ reader }) => ({ reader, withMutation: (a, c, work) => work(), status: () => flatStatus,
      configure: input => { calls.push(['config', input]); return flatStatus; }, clear: () => { calls.push('clear'); return flatStatus; },
      refresh: ids => { calls.push(['refresh', ids]); void refresh.promise; return flatStatus; } }) } });
  const session = await app.login();
  for (const accountIds of [[], ['missing'], ['business-imap', 'business-imap'], 'business-imap']) assert.equal((await app.call('/api/mail/cache/refresh', { method: 'POST', session, input: { accountIds } })).status, 400);
  assert.equal((await app.call('/api/mail/cache/refresh', { method: 'POST', session, input: { accountIds: ['business-imap'] } })).status, 200);
  assert.deepEqual(calls.shift(), ['refresh', ['business-imap']]);
  assert.equal((await app.call('/api/mail/cache', { method: 'POST', session, input: { maxHeadersPerAccount: 500 } })).status, 200);
  assert.equal((await app.call('/api/mail/cache/clear', { method: 'POST', session, input: {} })).status, 200);
  assert.equal((await app.call('/api/accounts/business-imap', { method: 'DELETE', session })).status, 200);
  assert.deepEqual(calls.slice(-3), [['purge', 'business-imap'], 'update', 'ingest']); refresh.resolve();
});

test('runtime cache health drives notification fallback without reconstructing the service', async t => {
  let healthy = true, pollEnabled, constructed = 0;
  const app = await harness(t, { config: { mailCache: { enabled: true } }, deps: {
    mailCache: { healthy: () => healthy, close() {} }, notifications: undefined,
    createMailNotifications: options => { constructed++; pollEnabled = options.pollEnabled; return { ingest() {}, close() {} }; },
    createMailSync: () => ({ close() {} }),
    createMailCacheReader: async ({ reader }) => ({ reader, withMutation: (a, c, work) => work() })
  } });
  await app.login(); assert.equal(typeof pollEnabled, 'function'); assert.equal(pollEnabled(), false);
  healthy = false; assert.equal(pollEnabled(), true); assert.equal(constructed, 1);
});

test('browser disconnect cancels only reads and releases the read pool', async t => {
  const entered = gate(), aborted = gate(), release = gate(); let count = 0;
  const app = await harness(t, { deps: { reader: { async list(accounts, { signal }) {
    if (++count === 1) { signal.addEventListener('abort', () => aborted.resolve(), { once: true }); entered.resolve(); await release.promise; }
    return listResult();
  } } } });
  const session = await app.login();
  const started = app.start('/api/mail/list', { method: 'POST', session, input: { folder: 'inbox' } });
  const disconnected = started.promise.catch(() => {});
  await entered.promise; started.request.destroy(); await aborted.promise; await disconnected;
  try { assert.equal((await app.call('/api/mail/list', { method: 'POST', session, input: { folder: 'inbox' } })).status, 200); }
  finally { release.resolve(); }
});

test('shutdown waits for a disconnected provider draft and its cache barrier finally', async t => {
  const entered = gate(), release = gate(), events = [];
  const app = await harness(t, { deps: { composer: { async save() { events.push('provider'); entered.resolve(); await release.promise; events.push('saved'); return { saved: true }; }, close() { events.push('composer-close'); } },
    mailCache: { healthy: () => true, close() { events.push('cache-close'); } }, sync: { close() { events.push('sync-close'); } },
    createMailCacheReader: async ({ reader }) => ({ reader, async withMutation(account, change, work) { events.push('begin'); try { return await work(); } finally { events.push('end'); } } }) } });
  const session = await app.login();
  const started = app.start('/api/mail/draft', { method: 'POST', session, input: { accountId: 'business-imap' } });
  const disconnected = started.promise.catch(() => {}); await entered.promise; started.request.destroy(); await disconnected;
  const stopping = closeServer(app.server); await tick(); assert.equal(events.includes('cache-close'), false);
  release.resolve(); await stopping;
  assert.ok(events.indexOf('begin') < events.indexOf('provider')); assert.ok(events.indexOf('saved') < events.indexOf('end'));
  assert.ok(events.indexOf('sync-close') < events.indexOf('cache-close')); assert.ok(events.indexOf('end') < events.indexOf('cache-close'));
});

test('external processing and label writers preserve context, guard stale accounts and end barriers on errors', async t => {
  let processingReader, labelReader; const events = [], marker = {};
  const processing = { marker, async markRead(account, ref) { assert.equal(this.marker, marker); assert.equal(ref.uid, 1); events.push('mark'); return 42; },
    async move() { events.push('move'); throw new MailHarborError('move_unavailable'); }, async moveBatch() { events.push('batch'); return ['ok']; } };
  const labels = { marker, async sync() { assert.equal(this.marker, marker); events.push('labels'); return { synced: true }; } };
  const app = await harness(t, { deps: { processing: undefined, labelSync: undefined, processingReader: processing, labelReader: labels,
    createMailProcessing: options => { processingReader = options.reader; return { close() {} }; },
    createMailLabelSync: options => { labelReader = options.reader; return { close() {} }; },
    createMailCacheReader: async ({ reader }) => ({ reader, async withMutation(a, c, work) { events.push('begin'); try { return await work(); } finally { events.push('end'); } } }) } });
  await app.login(); const account = app.store.read().accounts[0];
  assert.equal(await processingReader.markRead(account, reference), 42);
  await assert.rejects(processingReader.move(account, reference, 'archive'), error => error.code === 'move_unavailable');
  assert.deepEqual(await processingReader.moveBatch(account, [{ reference }]), ['ok']);
  assert.deepEqual(await labelReader.sync(account, [{ reference }]), { synced: true });
  assert.deepEqual(events, ['begin', 'mark', 'end', 'begin', 'move', 'end', 'begin', 'batch', 'end', 'begin', 'labels', 'end']);
  await app.store.update(data => { data.accounts[0].revision = 'r2'; });
  assert.throws(() => processingReader.markRead(account, reference), error => error.code === 'stale_message');
  assert.equal(events.length, 12);
});

test('legacy bulk mutation enters every account barrier before one provider call', async t => {
  const events = [], accountIds = ['business-imap', 'private-gmail'];
  const message = { id: 'legacy-message', account: 'Fixture', author: 'a@example.test', subject: 'Synthetic', date: '2026-09-20',
    body: 'Synthetic body', truncated: false, bodyUnavailable: false };
  const app = await harness(t, { accountIds, runner: async input => ({ briefing: 'Review', items: input.messages.map(item => ({ id: item.id,
    summary: 'Review', priority: 'normal', category: 'other', recommendation: 'keep', reason: 'Review' })) }),
    deps: { mailboxes: { async scan() { return { messages: [message], references: new Map([[message.id, reference]]), totalUnread: 1, inboxCount: 2 }; },
      async apply(selected) { events.push(['provider', selected.map(a => a.id)]); return { applied: [message.id], failed: [] }; } },
    createMailCacheReader: async ({ reader }) => ({ reader, async withMutation(account, change, work) {
      events.push(['begin', account.id]); try { return await work(); } finally { events.push(['end', account.id]); }
    } }) } });
  const session = await app.login();
  const created = await app.call('/api/briefings', { method: 'POST', session, input: { accountIds, language: 'en' } });
  assert.equal(created.status, 202);
  let batch;
  for (let index = 0; index < 50; index++) {
    batch = await app.call(`/api/briefings/${created.body.id}`, { session });
    if (batch.body.status === 'completed') break;
    await tick();
  }
  assert.equal(batch.body.status, 'completed');
  const applied = await app.call(`/api/briefings/${created.body.id}/actions`, { method: 'POST', session, input: { ids: [message.id], action: 'mark_read' } });
  assert.equal(applied.status, 200);
  assert.deepEqual(events, [['begin', 'business-imap'], ['begin', 'private-gmail'], ['provider', accountIds], ['end', 'private-gmail'], ['end', 'business-imap']]);
});
