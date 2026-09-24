import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, closeServer } from '../server/app.mjs';
import { createWebFactory } from '../server/web-app.mjs';
import { ACCOUNT_PRESETS } from './fixtures/accounts.mjs';
import { MailHarborError } from '../server/validation.mjs';

const origin = 'https://mail.example.test:9443';
const host = new URL(origin).host;
const token = 'test-only-pairing-token-abcdefghijklmnopqrstuvwxyz';
const message = (id = 'opaque-test-message') => ({ id, account: 'Test mailbox', author: 'Test sender', subject: 'Test subject', date: '2026-09-09',
  body: 'PRIVATE_TEST_EMAIL_BODY', truncated: false, bodyUnavailable: false });
const result = input => ({ briefing: 'One message to review.', items: input.messages.map(value => ({ id: value.id,
  summary: 'Review this message.', priority: 'normal', category: 'other', recommendation: 'keep', reason: 'Needs review.' })) });
const scanned = (messages = [message()]) => ({ messages, references: new Map(messages.map(value => [value.id, { opaque: true }])), totalUnread: 49, inboxCount: 1 });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('processing actions require authenticated CSRF and calendar downloads reveal no data anonymously', async t => {
  const actions = [], configurations = [];
  const processing = { status: () => ({ enabled: false, counts: { discovered: 0 } }), async action(value) { actions.push(value); return { enabled: true }; },
    async configure(value) { configurations.push(value); return { saved: true }; }, appointment: () => null, async close() {} };
  const app = await harness(t, { processing });
  for (const route of ['/api/mail/processing/status', '/api/mail/calendar?id=opaque']) assert.equal((await app.call(route)).status, 401);
  const session = await app.login();
  assert.equal((await app.call('/api/mail/processing', { method: 'POST', session, input: { action: 'start' }, headers: { 'X-Mailharbor-CSRF': undefined } })).status, 401);
  assert.equal((await app.call('/api/mail/processing/settings', { method: 'POST', session, input: { providerConsent: true }, headers: { Origin: 'https://attacker.example' } })).status, 401);
  assert.deepEqual(actions, []); assert.deepEqual(configurations, []);
  assert.equal((await app.call('/api/mail/processing', { method: 'POST', session, input: { action: 'start', unexpected: true } })).status, 400);
  assert.equal((await app.call('/api/mail/processing', { method: 'POST', session, input: { action: 'start' } })).status, 202);
  assert.deepEqual(actions, ['start']);
  assert.equal((await app.call('/api/mail/calendar?id=x&id=y', { session })).status, 400);
  assert.equal((await app.call('/api/mail/calendar?id=unknown', { session })).status, 409);
  assert.equal(app.runs(), 0);
});

test('processing review APIs require authentication, constrain queries and apply CSRF to resolutions', async t => {
  const calls = [];
  const processing = {status: () => ({enabled: false}), async close() {},
    reviewList(input) { calls.push(['list', input]); return {items: [{id: 'opaque_hash', subject: 'PRIVATE_REVIEW_SUBJECT'}], nextAfter: null}; },
    reviewMessage(id) { calls.push(['message', id]); return {body: 'PRIVATE_REVIEW_BODY', truncated: false, bodyUnavailable: false}; },
    resolveReview(input) { calls.push(['resolve', input]); return {saved: true}; }};
  const app = await harness(t, {processing});
  for (const route of ['/api/mail/processing/review', '/api/mail/processing/review/message?id=opaque_hash']) {
    const response = await app.call(route); assert.equal(response.status, 401); assert.doesNotMatch(response.text, /PRIVATE_REVIEW/);
  }
  const session = await app.login();
  for (const query of ['?category=other', '?category=held&category=review', '?after=x&after=y', '?after=', '?limit=100000', '?after=../private']) assert.equal((await app.call(`/api/mail/processing/review${query}`, {session})).status, 400, query);
  for (const query of ['', '?id=', '?id=x&id=y', '?id=x&raw=true', '?id=../private']) assert.equal((await app.call(`/api/mail/processing/review/message${query}`, {session})).status, 400, query);
  assert.equal((await app.call('/api/mail/processing/review', {method: 'POST', session, input: {id: 'opaque_hash', action: 'keep'}, headers: {'X-Mailharbor-CSRF': undefined}})).status, 401);
  assert.equal((await app.call('/api/mail/processing/review', {method: 'POST', session, input: {id: 'opaque_hash', action: 'retry'}, headers: {Origin: 'https://attacker.example'}})).status, 401);
  for (const input of [{id: 'x', action: 'delete'}, {id: '../private', action: 'keep'}, {id: 'x', action: 'retry', labels: []}, {id: 'x', action: 'confirm', force: true}]) assert.equal((await app.call('/api/mail/processing/review', {method: 'POST', session, input})).status, 400);
  assert.deepEqual(calls, []);
  const listed = await app.call('/api/mail/processing/review?category=failed&after=opaque_hash', {session});
  assert.equal(listed.status, 200); assert.equal(listed.headers['cache-control'], 'no-store'); assert.equal(listed.body.items[0].id, 'opaque_hash');
  assert.equal((await app.call('/api/mail/processing/review/message?id=opaque_hash', {session})).body.body, 'PRIVATE_REVIEW_BODY');
  assert.equal((await app.call('/api/mail/processing/review', {method: 'POST', session, input: {id: 'opaque_hash', action: 'keep'}})).status, 200);
  assert.deepEqual(calls, [['list', {category: 'failed', after: 'opaque_hash'}], ['message', 'opaque_hash'], ['resolve', {id: 'opaque_hash', action: 'keep'}]]);
  assert.equal(app.runs(), 0); assert.equal(app.mailboxCalls.apply, 0);
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function memoryStore() {
  let data = { schema: 1, providers: {}, accounts: [{ ...ACCOUNT_PRESETS.find(value => value.id === 'business-imap'),
    auth: { type: 'password', password: 'PRIVATE_ACCOUNT_PASSWORD' }, revision: 'initial-revision', connectedAt: '2026-09-09', archivePath: 'Archive' }] };
  let pending = Promise.resolve();
  return { read: () => structuredClone(data), update(change) {
    const next = pending.then(async () => { const copy = structuredClone(data); const value = await change(copy); data = copy; return value; });
    pending = next.catch(() => {}); return next;
  } };
}
async function harness(t, options = {}) {
  const store = options.store ?? memoryStore();
  const mailboxCalls = { test: 0, scan: 0, apply: 0 };
  const mailboxes = {
    async test(value) { mailboxCalls.test++; return { archivePath: value.archivePath ?? 'Archive', folders: [{ path: 'INBOX', specialUse: '' }, { path: 'Archive', specialUse: '\\Archive' }, { path: 'Business Archive', specialUse: '' }] }; },
    async scan(selected, settings) { mailboxCalls.scan++; settings.onProgress({ phase: 'headers', checked: 49 }); return scanned(); },
    async apply(selected, references, ids) { mailboxCalls.apply++; return { applied: ids, failed: [] }; },
    ...options.mailboxes
  };
  let runs = 0, capturedJobs;
  const factory = createWebFactory({ origin, stateDir: '/unused-with-injected-store', ...options.config }, { store, mailboxes, reader: options.reader, fetcher: options.fetcher, drive: options.drive, invoices: options.invoices, processing: options.processing,
    composer: options.composer, content: options.content, notifications: options.notifications, labelSync: options.labelSync, labelReader: options.labelReader });
  const server = createServer({ pairingToken: token }, options.runner ?? (async input => { runs++; return result(input); }), {
    agyLogin: options.agyLogin,
    createWeb(context) { capturedJobs = context.jobs; return factory({ ...context, jobs: options.wrapJobs ? options.wrapJobs(context.jobs) : context.jobs }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const port = server.address().port;
  function call(route, { method = 'GET', session, input, headers = {}, raw } = {}) {
    const bytes = input !== undefined ? JSON.stringify(input) : raw;
    const requestHeaders = { Host: host,
      ...(session ? { Cookie: session.cookie, 'X-Mailharbor-CSRF': session.csrf } : {}),
      ...(!['GET', 'HEAD'].includes(method) ? { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } : {}),
      ...(bytes !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {}), ...headers };
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port, path: route, method,
        headers: Object.fromEntries(Object.entries(requestHeaders).filter(([, value]) => value !== undefined)) }, response => {
        const chunks = []; response.on('data', chunk => { chunks.push(chunk); });
        response.on('end', () => {
          const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
          resolve({ status: response.statusCode, headers: response.headers, text, bytes,
            body: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
        });
      });
      request.on('error', reject); request.end(bytes);
    });
  }
  async function login() {
    const response = await call('/api/session', { method: 'POST', input: { token } });
    assert.equal(response.status, 200);
    return { csrf: response.body.csrf, cookie: response.headers['set-cookie'][0].split(';')[0], response };
  }
  async function create(session) {
    const response = await call('/api/briefings', { method: 'POST', session, input: { accountIds: ['business-imap'], language: 'en' } });
    assert.equal(response.status, 202); return response.body;
  }
  async function finish(session, id) {
    for (let i = 0; i < 100; i++) {
      const response = await call(`/api/briefings/${id}`, { session });
      if (['completed', 'failed', 'cancelled'].includes(response.body.status)) return response;
      await pause(5);
    }
    throw new Error('Briefing did not complete');
  }
  return { call, login, create, finish, store, mailboxCalls, jobs: () => capturedJobs, runs: () => runs, close: () => closeServer(server) };
}

test('Agy reconnect routes require browser authentication, CSRF and strict bounded inputs before touching login', async t => {
  const calls = [];
  const agyLogin = {
    status(owner) { calls.push(['status', owner]); return { state: 'idle' }; },
    start(owner) { calls.push(['start', owner]); return { state: 'starting' }; },
    submitCode(owner, code) { calls.push(['code', owner, code]); return { state: 'verifying' }; },
    cancel(owner) { calls.push(['cancel', owner]); return { state: 'cancelled' }; },
    close() {}
  };
  const app = await harness(t, { agyLogin });
  for (const [route, method, input] of [['/api/agy/login', 'GET'], ['/api/agy/login', 'POST', {}], ['/api/agy/login', 'DELETE'], ['/api/agy/login/code', 'POST', { code: 'fixture-code' }]]) {
    assert.equal((await app.call(route, { method, input })).status, 401);
  }
  const session = await app.login();
  for (const [route, method, input] of [['/api/agy/login', 'POST', {}], ['/api/agy/login', 'DELETE'], ['/api/agy/login/code', 'POST', { code: 'fixture-code' }]]) {
    assert.equal((await app.call(route, { method, input, session, headers: { 'X-Mailharbor-CSRF': undefined } })).status, 401);
    assert.equal((await app.call(route, { method, input, session, headers: { Origin: 'https://attacker.example' } })).status, 401);
    assert.equal((await app.call(route, { method, input, session, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 401);
  }
  for (const route of ['/api/agy/login?force=1', '/api/agy/login/code?code=private']) {
    assert.equal((await app.call(route, { session })).status, 400);
  }
  for (const input of [{ command: 'agy' }, { owner: 'other' }, { args: [] }]) {
    assert.equal((await app.call('/api/agy/login', { method: 'POST', session, input })).status, 400);
  }
  for (const input of [{}, { code: '' }, { code: '   ' }, { code: 1 }, { code: 'short' }, { code: 'x'.repeat(2049) }, { code: 'code\ncommand' }, { code: '/command' }, { code: 'fixture-code', owner: 'other' }]) {
    assert.equal((await app.call('/api/agy/login/code', { method: 'POST', session, input })).status, 400);
  }
  assert.equal((await app.call('/api/agy/login', { method: 'DELETE', session, input: {} })).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await app.call('/api/agy/login', { session })).body.state, 'idle');
  assert.equal((await app.call('/api/agy/login', { method: 'POST', session, input: {} })).status, 202);
  assert.equal((await app.call('/api/agy/login/code', { method: 'POST', session, input: { code: 'fixture-code' } })).status, 202);
  const cancelled = await app.call('/api/agy/login', { method: 'DELETE', session });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.headers['cache-control'], 'no-store');
  assert.equal(cancelled.headers['referrer-policy'], 'no-referrer');
  assert.deepEqual(calls, [['status', session.csrf], ['start', session.csrf], ['code', session.csrf, 'fixture-code'], ['cancel', session.csrf]]);
  assert.equal(app.runs(), 0); assert.equal(app.mailboxCalls.scan, 0);
});

test('Agy login owner binding follows the browser session and logout cancels only that session', async t => {
  const owners = [], cancelled = [];
  let owner, closed = 0;
  const agyLogin = {
    start(value) { owner = value; return { state: 'awaiting_code', url: 'https://accounts.google.com/o/oauth2/v2/auth?state=FIXTURE_STATE' }; },
    status(value) { owners.push(value); return value === owner ? { state: 'awaiting_code', url: 'https://accounts.google.com/o/oauth2/v2/auth?state=FIXTURE_STATE' } : { state: 'idle' }; },
    submitCode(value) { owners.push(value); if (value !== owner) throw new MailHarborError('not_found', 'PRIVATE_RAW_CLI_TEXT'); return { state: 'verifying' }; },
    cancel(value) { cancelled.push(value); if (value !== owner) throw new MailHarborError('not_found'); owner = null; return { state: 'cancelled' }; },
    close() { closed++; }
  };
  const app = await harness(t, { agyLogin }), first = await app.login(), second = await app.login();
  await app.call('/api/agy/login', { method: 'POST', session: first, input: {} });
  assert.match((await app.call('/api/agy/login', { session: first })).body.url, /FIXTURE_STATE/);
  assert.doesNotMatch((await app.call('/api/agy/login', { session: second })).text, /FIXTURE_STATE/);
  const denied = await app.call('/api/agy/login/code', { method: 'POST', session: second, input: { code: 'fixture-code' } });
  assert.equal(denied.status, 404); assert.doesNotMatch(denied.text, /PRIVATE_RAW_CLI_TEXT/);
  assert.equal((await app.call('/api/agy/login', { method: 'DELETE', session: second })).status, 404);
  await app.call('/api/session', { method: 'DELETE', session: second });
  assert.equal(owner, first.csrf); assert.deepEqual(cancelled, [second.csrf, second.csrf]);
  await app.call('/api/session', { method: 'DELETE', session: first });
  assert.equal(owner, null); assert.deepEqual(cancelled, [second.csrf, second.csrf, first.csrf]);
  assert.equal((await app.call('/api/agy/login', { session: first })).status, 401);
  assert.deepEqual(owners, [first.csrf, second.csrf, second.csrf]);
  await app.close(); await app.close(); assert.equal(closed, 1);
});

test('expired browser sessions cancel their Agy login without exposing its state', async t => {
  const cancelled = [];
  const app = await harness(t, { agyLogin: { cancel: owner => { cancelled.push(owner); }, close() {}, status() { throw new Error('Expired sessions must not read login state'); } } });
  const session = await app.login(), now = Date.now();
  t.mock.method(Date, 'now', () => now + 8 * 86400000);
  assert.equal((await app.call('/api/agy/login', { session })).status, 401);
  await Promise.resolve();
  assert.deepEqual(cancelled, [session.csrf]);
});

test('label sync status is private and explicit retries require CSRF and a strict action', async t => {
  let requests = 0;
  const state = { pending: 2, synced: 4, failed: 0, mode: 'gmail_labels_primary_folders' };
  const labelSync = { status: () => state, request() { requests++; return state; }, async close() {} };
  const app = await harness(t, { labelSync });
  assert.equal((await app.call('/api/mail/labels/sync')).status, 401);
  assert.equal((await app.call('/api/mail/labels/sync', { method: 'POST', input: { action: 'sync' } })).status, 401);
  const session = await app.login();
  assert.equal((await app.call('/api/mail/labels/sync', { method: 'POST', session, input: { action: 'sync' }, headers: { 'X-Mailharbor-CSRF': undefined } })).status, 401);
  for (const input of [{}, { action: 'delete' }, { action: 'sync', force: true }]) assert.equal((await app.call('/api/mail/labels/sync', { method: 'POST', session, input })).status, 400);
  assert.equal(requests, 0);
  assert.deepEqual((await app.call('/api/mail/labels/sync', { session })).body, state);
  assert.equal((await app.call('/api/mail/labels/sync', { method: 'POST', session, input: { action: 'sync' } })).status, 202);
  assert.equal(requests, 1);
});

test('background label acknowledgements preserve active folder reads and unrelated message handles', async t => {
  const started = gate(), released = gate(), acknowledged = gate();
  let folderSignal;
  const mail = {id:'labelled-fixture',accountId:'business-imap',account:'Fixture',folderPath:'INBOX',subject:'Labelled message',date:'2026-09-18',
    reference:{accountId:'business-imap',path:'INBOX',uid:9,uidValidity:'1',fingerprint:'a'.repeat(64)}};
  const unrelated = {...mail,id:'unrelated-fixture',subject:'Unrelated message',reference:{...mail.reference,uid:10,fingerprint:'b'.repeat(64)}};
  const processing = {status:() => ({enabled:false}),async close(){},async withMailboxWrite(work){return work();},
    canRelocateCategory:() => true,relocateCategory(){},appointment:() => null};
  const labelReader = {async sync(_account, entries, callbacks) {
    for (const entry of entries) await callbacks.onResult(entry, {status:'synced',kind:'folders',moved:true,managedLabels:[],
      reference:{...entry.reference,path:'MailHarbor/Invoices',uid:20}});
    acknowledged.resolve(); return {results:[]};
  }};
  const app = await harness(t, {processing,labelReader,reader:{
    async list(){return {messages:[mail,unrelated],errors:[]};},
    async folders(_accounts,{signal}){folderSignal=signal;started.resolve();await released.promise;return {folders:[],errors:[]};},
    async read(){return {...unrelated,body:'Unaffected message body',bodyUnavailable:false};}
  }});
  const session = await app.login();
  assert.equal((await app.call('/api/mail/list',{method:'POST',session,input:{folder:'inbox'}})).status,200);
  assert.equal((await app.call('/api/mail/tags',{method:'POST',session,input:{id:mail.id,tag:'invoices',enabled:true}})).status,200);
  const folders = app.call('/api/mail/folders',{session}); await started.promise;
  try {
    assert.equal((await app.call('/api/mail/labels/sync',{method:'POST',session,input:{action:'sync'}})).status,202);
    await acknowledged.promise;
    assert.equal(folderSignal.aborted,false);
  } finally {released.resolve();}
  assert.equal((await folders).status,200);
  const message = await app.call('/api/mail/message',{method:'POST',session,input:{id:unrelated.id}});
  assert.equal(message.status,200); assert.equal(message.body.message.body,'Unaffected message body');
});

test('compose, full-content, notifications and mailbox operations enforce authentication and CSRF before dependencies', async t => {
  const invoked = [];
  const record = name => async () => { invoked.push(name); return {}; };
  const composer = Object.fromEntries(['settings', 'configure', 'verify', 'context', 'save', 'send', 'close'].map(name => [name, record(name)]));
  const content = Object.fromEntries(['read', 'source', 'headers', 'zip', 'preview'].map(name => [name, record(name)]));
  const notifications = Object.fromEntries(['updates', 'settings', 'subscribe', 'unsubscribe', 'close'].map(name => [name, record(name)]));
  const app = await harness(t, { composer, content, notifications });
  const read = ['/api/mail/smtp', '/api/mail/updates', '/api/mail/notifications'];
  const writes = ['/api/mail/smtp', '/api/mail/smtp/test', '/api/mail/compose/context', '/api/mail/draft', '/api/mail/send', '/api/mail/content', '/api/mail/decrypt',
    '/api/mail/source', '/api/mail/headers', '/api/mail/attachments', '/api/mail/attachment-preview', '/api/mail/bulk', '/api/mail/undo', '/api/mail/trash/empty',
    '/api/mail/folders/manage', '/api/mail/labels/manage', '/api/mail/provider-labels', '/api/mail/provider-labels/apply', '/api/mail/notifications'];
  for (const route of read) assert.equal((await app.call(route)).status, 401, route);
  for (const route of writes) assert.equal((await app.call(route, { method: 'POST', input: {} })).status, 401, route);
  assert.equal((await app.call('/api/mail/notifications', { method: 'DELETE', input: {} })).status, 401);
  const session = await app.login();
  for (const route of writes) {
    assert.equal((await app.call(route, { method: 'POST', session, input: {}, headers: { 'X-Mailharbor-CSRF': undefined } })).status, 401, route);
    assert.equal((await app.call(route, { method: 'POST', session, input: {}, headers: { Origin: 'https://attacker.example' } })).status, 401, route);
  }
  assert.equal((await app.call('/api/mail/notifications', { method: 'DELETE', session, input: {}, headers: { 'X-Mailharbor-CSRF': undefined } })).status, 401);
  assert.deepEqual(invoked, []); assert.equal(app.runs(), 0);
});

test('compose routes preserve payloads and allow bounded attachments without widening ordinary JSON request limits', async t => {
  const calls = [];
  const composer = { settings: () => ({ accounts: [{ accountId: 'business-imap' }] }), close() {},
    async configure(input) { calls.push(['configure', input]); return { saved: true }; }, async verify(input) { calls.push(['verify', input]); return { verified: true }; },
    async context(input) { calls.push(['context', input]); return { text: 'PRIVATE_CONTEXT', accountId: 'business-imap' }; },
    async save(input) { calls.push(['save', input]); return { saved: true, draftId: 'saved-draft' }; },
    async send(input) { calls.push(['send', input]); return { sent: true, status: 'sent' }; } };
  const app = await harness(t, { composer }), session = await app.login();
  assert.equal((await app.call('/api/mail/smtp', { session })).body.accounts[0].accountId, 'business-imap');
  const context = await app.call('/api/mail/compose/context', { method: 'POST', session, input: { id: 'original', mode: 'reply_all' } });
  assert.equal(context.body.text, 'PRIVATE_CONTEXT'); assert.equal(context.headers['cache-control'], 'no-store');
  const payload = { accountId: 'business-imap', to: 'fixture@example.test', text: 'Test', attachments: [{ filename: 'fixture.bin', mimeType: 'application/octet-stream', content: 'A'.repeat(1024 * 1024) }], requestId: 'request_12345678901234567890' };
  for (const route of ['/api/mail/draft', '/api/mail/send']) assert.equal((await app.call(route, { method: 'POST', session, input: payload })).status, 200);
  assert.deepEqual(calls.find(call => call[0] === 'send')[1], payload);
  const rejectedBody = async operation => { assert.equal((await operation).status, 413); };
  await rejectedBody(app.call('/api/mail/smtp', { method: 'POST', session, input: payload }));
  await rejectedBody(app.call('/api/mail/smtp', { method: 'POST', session, input: payload, headers: { 'Content-Length': undefined } }));
  await rejectedBody(app.call('/api/mail/compose/context', { method: 'POST', session, input: payload }));
  const oversized = `{"text":"${'x'.repeat(36 * 1024 * 1024)}"}`;
  await rejectedBody(app.call('/api/mail/send', { method: 'POST', session, raw: oversized }));
  assert.equal(calls.filter(call => call[0] === 'send').length, 1);
  assert.equal((await app.call('/api/mail/smtp/test', { method: 'POST', session, input: { accountId: 'business-imap' } })).body.verified, true);
  assert.equal(app.runs(), 0);
});

test('complete content routes use verified browsing references and export safe uncached binary downloads', async t => {
  const calls = [], bytes = Buffer.from([0, 128, 255, 13, 10, 60, 115, 99, 114, 105, 112, 116, 62]);
  const mail = { id: 'content-message', accountId: 'business-imap', folderPath: 'INBOX',
    reference: { accountId: 'business-imap', path: 'INBOX', uid: 9, uidValidity: '1', fingerprint: 'c'.repeat(64) } };
  const check = (name, account, reference, options) => { calls.push(name); assert.equal(account.id, mail.accountId); assert.deepEqual(reference, mail.reference); assert.ok(options.signal instanceof AbortSignal); };
  const content = {
    async read(account, reference, options) { check('read', account, reference, options); return { text: 'PRIVATE_COMPLETE_CONTENT', html: '<p>Safe content</p>' }; },
    async source(account, reference, options) { check('source', account, reference, options); return { bytes, filename: '../résumé"\r\nX-Evil: yes.eml', mimeType: 'text/html' }; },
    async headers(account, reference, options) { check('headers', account, reference, options); return { bytes, filename: 'headers.txt', mimeType: 'text/plain' }; },
    async preview(account, reference, attachmentId, options) { check('preview', account, reference, options); assert.equal(attachmentId, '2'); return { text: 'Office text', kind: 'office' }; },
    async zip(account, reference, attachments, options) { check('zip', account, reference, options); assert.deepEqual(attachments, [{ id: '2', filename: 'fixture.txt' }]); return { bytes, filename: 'attachments.zip', mimeType: 'application/zip' }; }
  };
  const app = await harness(t, { content, reader: { async list() { return { messages: [mail], errors: [] }; }, async read() { return { ...mail, attachments: [{ id: '2', filename: 'fixture.txt' }] }; } } });
  const session = await app.login();
  assert.equal((await app.call('/api/mail/content', { method: 'POST', session, input: { id: mail.id } })).status, 409);
  await app.call('/api/mail/list', { method: 'POST', session, input: { folder: 'inbox' } });
  for (const route of ['content', 'source', 'headers', 'attachments', 'attachment-preview']) {
    const input = { id: mail.id, ...(route === 'attachment-preview' ? { attachmentId: '2' } : {}) };
    assert.equal((await app.call(`/api/mail/${route}`, { method: 'POST', session, input: { ...input, reference: mail.reference } })).status, 400);
    const response = await app.call(`/api/mail/${route}`, { method: 'POST', session, input });
    assert.equal(response.status, 200, route); assert.equal(response.headers['cache-control'], 'no-store');
    if (['source', 'headers', 'attachments'].includes(route)) {
      assert.deepEqual(response.bytes, bytes); assert.equal(response.headers['content-type'], 'application/octet-stream');
      assert.equal(response.headers['x-content-type-options'], 'nosniff'); assert.equal(response.headers['x-evil'], undefined);
      assert.match(response.headers['content-security-policy'], /sandbox/); assert.match(response.headers['content-disposition'], /^attachment; filename="[^"\r\n]*"; filename\*=UTF-8''/);
    } else assert.doesNotMatch(response.text, /reference|uidValidity|PRIVATE_ACCOUNT_PASSWORD/);
  }
  assert.deepEqual(calls, ['read', 'source', 'headers', 'zip', 'preview']);
  await app.store.update(data => { data.accounts[0].revision = 'reconnected'; });
  assert.equal((await app.call('/api/mail/source', { method: 'POST', session, input: { id: mail.id } })).status, 409);
  assert.equal(calls.length, 5); assert.equal(app.runs(), 0);
});

test('unified inbox APIs require session and CSRF, hide references, and never submit an AI job', async t => {
  const calls = [];
  const mail = { id: 'message-fixture', accountId: 'business-imap', account: 'Fixture mailbox', folderPath: 'INBOX',
    subject: 'Unified subject', author: 'Fixture sender', to: 'Fixture recipient', date: '2026-09-13T10:00:00Z', unread: true, starred: false,
    reference: { accountId: 'business-imap', path: 'INBOX', uid: 9, uidValidity: '1', fingerprint: 'a'.repeat(64) } };
  const app = await harness(t, { reader: {
    async folders() { calls.push('folders'); return { folders: [{ id: 'inbox', label: 'Inbox', accountIds: ['business-imap'] }], errors: [] }; },
    async list() { calls.push('list'); return { messages: [mail], nextCursor: null, errors: [] }; },
    async read() { calls.push('read'); return { ...mail, body: 'PRIVATE_PREVIEW_BODY', truncated: false, bodyUnavailable: false }; },
    async apply() { calls.push('apply'); return { applied: true }; }
  } });
  assert.equal((await app.call('/api/mail/folders')).status, 401);
  const session = await app.login();
  for (const route of ['/api/mail/list', '/api/mail/message', '/api/mail/action', '/api/mail/tags', '/api/mail/attachment']) {
    assert.equal((await app.call(route, { method: 'POST', session, input: {}, headers: { 'X-Mailharbor-CSRF': undefined } })).status, 401);
  }
  assert.deepEqual(calls, []);
  const folders = await app.call('/api/mail/folders', { session });
  assert.equal(folders.body.folders.length, 21);
  assert.doesNotMatch(folders.text, /PRIVATE_ACCOUNT_PASSWORD/);
  const list = await app.call('/api/mail/list', { method: 'POST', session, input: { folder: 'inbox' } });
  assert.equal(list.status, 200);
  assert.equal(list.headers['cache-control'], 'no-store');
  assert.equal(list.body.messages[0].unread, true);
  assert.doesNotMatch(list.text, /PRIVATE_|reference|uidValidity/);
  const preview = await app.call('/api/mail/message', { method: 'POST', session, input: { id: 'message-fixture' } });
  assert.equal(preview.body.message.body, 'PRIVATE_PREVIEW_BODY');
  assert.doesNotMatch(preview.text, /PRIVATE_REFERENCE|reference|uidValidity/);
  assert.equal(calls.includes('apply'), false);
  const tagged = await app.call('/api/mail/tags', { method: 'POST', session, input: { id: 'message-fixture', tag: 'coupons', enabled: true } });
  assert.equal(tagged.status, 200);
  assert.deepEqual(tagged.body.tags, ['coupons']);
  const coupons = await app.call('/api/mail/list', { method: 'POST', session, input: { folder: 'tag:coupons' } });
  assert.equal(coupons.status, 200);
  assert.equal(coupons.body.total, 1);
  assert.deepEqual(coupons.body.messages[0].tags, ['coupons']);
  assert.doesNotMatch(coupons.text, /reference|fingerprint|uidValidity|PRIVATE_/);
  assert.equal((await app.call('/api/mail/tags', { method: 'POST', session, input: { id: 'message-fixture', tag: 'unknown', enabled: true } })).status, 400);
  assert.equal(calls.includes('apply'), false, 'Labels do not mutate the original mailbox');
  assert.equal((await app.call('/api/mail/action', { method: 'POST', session, input: { id: 'message-fixture', action: 'mark_read' } })).status, 200);
  assert.equal((await app.call('/api/mail/action', { method: 'POST', session, input: { id: 'message-fixture', action: 'expunge' } })).status, 400);
  assert.equal((await app.call('/api/mail/action', { method: 'POST', session, input: { id: 'message-fixture', action: 'delete' } })).status, 200);
  assert.equal((await app.call('/api/mail/message', { method: 'POST', session, input: { id: 'message-fixture' } })).status, 409);
  assert.equal((await app.call('/api/mail/list', { method: 'POST', session, input: { folder: 'tag:coupons' } })).body.total, 0);
  assert.equal(app.runs(), 0);
});

test('attachment downloads preserve binary bytes, require CSRF, and force safe uncached downloads', async t => {
  const bytes = Buffer.from([0, 255, 1, 128, 60, 115, 99, 114, 105, 112, 116, 62]);
  const mail = { id: 'attachment-message', accountId: 'business-imap', account: 'Test', folderPath: 'INBOX',
    reference: { accountId: 'business-imap', path: 'INBOX', uid: 9, uidValidity: '1', fingerprint: 'b'.repeat(64) } };
  let downloads = 0, failure;
  const app = await harness(t, { reader: {
    async list() { return { messages: [mail], errors: [] }; },
    async attachment(account, reference, part) {
      downloads++; assert.equal(account.id, mail.accountId); assert.deepEqual(reference, mail.reference); assert.equal(part, '2');
      if (failure) throw new MailHarborError(failure);
      return { filename: '../résumé"\r\nX-Evil: yes.html', mimeType: 'text/html', bytes };
    }
  } });
  const route = '/api/mail/attachment', input = { id: mail.id, attachmentId: '2' };
  assert.equal((await app.call(route, { method: 'POST', input })).status, 401);
  const session = await app.login();
  await app.call('/api/mail/list', { method: 'POST', session, input: { folder: 'inbox' } });
  assert.equal((await app.call(route, { method: 'POST', session, input, headers: { 'X-Mailharbor-CSRF': undefined } })).status, 401);
  assert.equal((await app.call(route, { method: 'POST', session, input, headers: { Origin: 'https://attacker.test' } })).status, 401);
  for (const bad of [{ ...input, attachmentId: '../2' }, { ...input, reference: mail.reference }]) {
    assert.equal((await app.call(route, { method: 'POST', session, input: bad })).status, 400);
  }
  assert.equal(downloads, 0);
  const file = await app.call(route, { method: 'POST', session, input });
  assert.equal(file.status, 200); assert.deepEqual(file.bytes, bytes);
  assert.equal(file.headers['content-type'], 'application/octet-stream');
  assert.equal(file.headers['content-length'], String(bytes.length));
  assert.equal(file.headers['cache-control'], 'no-store');
  assert.equal(file.headers['x-content-type-options'], 'nosniff');
  assert.match(file.headers['content-disposition'], /^attachment; filename="[^"\r\n]*"; filename\*=UTF-8''/);
  assert.match(file.headers['content-disposition'], /r%C3%A9sum%C3%A9/);
  assert.equal(file.headers['x-evil'], undefined);
  assert.match(file.headers['content-security-policy'], /sandbox/);
  for (const [code, status] of [['attachment_too_large', 413], ['attachment_unavailable', 404], ['stale_message', 409]]) {
    failure = code;
    const response = await app.call(route, { method: 'POST', session, input });
    assert.equal(response.status, status); assert.equal(response.body.error.code, code);
  }
  assert.equal(app.runs(), 0);
});

test('invoice and Drive routes require session and CSRF, keep OAuth session-bound, and never call AI', async t => {
  const calls = [];
  const drive = { status: () => ({configured:false,connected:false}),
    async configure(value) { calls.push(['configure', Object.keys(value)]); return this.status(); },
    start(binding) { calls.push(['start',binding]); return {url:'https://accounts.google.com/o/oauth2/v2/auth'}; },
    async finish(params,binding) { calls.push(['finish',binding]); throw new MailHarborError('drive_wrong_account','PRIVATE_REMOTE_TEXT'); },
    async disconnect() { calls.push(['disconnect']); return this.status(); }, async close() {} };
  const invoices = { status: () => ({enabled:false,running:false,counts:{},recent:[]}),
    async configure(input) { calls.push(['settings',input]); return this.status(); },
    start(input) { calls.push(['scan',input]); return {job:{status:'running'}}; }, async close() {} };
  const app = await harness(t,{drive,invoices});
  for (const route of ['/api/drive','/api/invoices','/oauth/drive/callback?state=unused']) assert.equal((await app.call(route)).status,401);
  const session = await app.login();
  for (const route of ['/api/drive/configure','/api/drive/connect','/api/drive/disconnect','/api/invoices/settings','/api/invoices/scan']) {
    assert.equal((await app.call(route,{method:'POST',session,input:{},headers:{'X-Mailharbor-CSRF':undefined}})).status,401);
    assert.equal((await app.call(route,{method:'POST',session,input:{unexpected:true}})).status,400);
  }
  assert.deepEqual(calls,[]);
  assert.equal((await app.call('/api/drive/connect',{method:'POST',session,input:{}})).status,200);
  assert.equal(calls.at(-1)[1],session.csrf);
  const callback = await app.call('/oauth/drive/callback?state=unused&code=fixture',{session});
  assert.equal(callback.status,303); assert.equal(calls.at(-1)[1],session.csrf);
  assert.equal(callback.headers.location,'/?driveConnectionError=1#accounts');
  const status=await app.call('/api/drive',{session});
  assert.equal(status.body.oauthFailure.code,'drive_wrong_account'); assert.doesNotMatch(status.text,/PRIVATE_REMOTE_TEXT/);
  assert.equal((await app.call('/api/invoices/scan',{method:'POST',session,input:{limit:1000}})).status,202);
  assert.equal((await app.call('/api/invoices/settings',{method:'POST',session,input:{enabled:true}})).status,200);
  assert.equal(app.runs(),0);
});

test('mailbox session timeouts remain distinct and never submit an AI job', async t => {
  const app = await harness(t, { mailboxes: {
    async scan() { throw new MailHarborError('mailbox_timeout', 'PRIVATE_PROVIDER_DIAGNOSTIC'); }
  } });
  const session = await app.login();
  const created = await app.create(session);
  const finished = await app.finish(session, created.id);
  assert.equal(finished.body.status, 'failed');
  assert.equal(finished.body.error.code, 'mailbox_timeout');
  assert.ok(!finished.text.includes('PRIVATE_PROVIDER_DIAGNOSTIC'));
  assert.equal(app.runs(), 0);
});

test('public shell reveals no email data; API requires a Secure HttpOnly session and sends no-store', async t => {
  const app = await harness(t);
  const shell = await app.call('/');
  assert.equal(shell.status, 200);
  assert.equal(shell.headers['cache-control'], 'no-store');
  assert.match(shell.headers['content-security-policy'], /frame-ancestors 'none'/);
  for (const secret of ['PRIVATE_TEST_EMAIL_BODY', 'PRIVATE_ACCOUNT_PASSWORD', token]) assert.ok(!shell.text.includes(secret));
  const denied = await app.call('/api/accounts');
  assert.equal(denied.status, 401); assert.ok(!denied.text.includes('ExampleSoftwareSolutions'));
  assert.equal(denied.headers['cache-control'], 'no-store');
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  const session = await app.login();
  const cookie = session.response.headers['set-cookie'][0];
  assert.match(cookie, /^__Host-mailharbor=[A-Za-z0-9_-]{43};/);
  for (const attribute of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure']) assert.ok(cookie.includes(attribute));
  assert.ok(!cookie.includes('Domain='));
  assert.ok(!session.response.text.includes(token));
  const accounts = await app.call('/api/accounts', { session });
  assert.equal(accounts.status, 200); assert.equal(accounts.headers['cache-control'], 'no-store');
  assert.ok(!accounts.text.includes('PRIVATE_ACCOUNT_PASSWORD'));
  assert.equal((await app.call('/api/session', { session })).body.csrf, session.csrf);
});

test('Host, Origin, fetch-site, CSRF, and body type checks reject forged writes before mailbox access', async t => {
  const app = await harness(t);
  for (const headers of [{ Host: 'evil.example.test' }, { Host: 'mail.example.test' }, { Origin: 'https://evil.example.test' },
    { Origin: undefined }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await app.call('/api/session', { method: 'POST', input: { token }, headers })).status, 401);
  }
  const session = await app.login();
  for (const headers of [{ 'X-Mailharbor-CSRF': undefined }, { 'X-Mailharbor-CSRF': 'wrong' }, { Origin: 'https://mail.example.test:9444' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await app.call('/api/briefings', { method: 'POST', session, input: { accountIds: ['business-imap'] }, headers })).status, 401);
  }
  assert.equal((await app.call('/api/briefings', { method: 'POST', session, raw: '{', headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await app.call('/api/briefings', { method: 'POST', session, raw: 'x'.repeat(32769) })).status, 413);
  assert.equal(app.mailboxCalls.scan, 0);
  assert.equal((await app.call('/../server/accounts.mjs', { session })).status, 404);
});

test('login throttling cannot be bypassed by varying a supplied Tailscale identity header', async t => {
  const app = await harness(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await app.call('/api/session', { method: 'POST', input: { token: 'wrong' }, headers: { 'Tailscale-User-Login': `attempt-${i}` } })).status, 401);
  }
  assert.equal((await app.call('/api/session', { method: 'POST', input: { token: 'wrong' }, headers: { 'Tailscale-User-Login': 'fresh-name' } })).status, 429);
});

test('Tailscale sign-in requires an explicitly allowed identity and a secure configured origin', async t => {
  const app = await harness(t, { config: { allowedTailscaleLogins: ['owner@example.test'] } });
  assert.equal((await app.call('/api/session', { method: 'POST', input: { tailscale: true }, headers: { 'Tailscale-User-Login': 'stranger@example.test' } })).status, 401);
  const success = await app.call('/api/session', { method: 'POST', input: { tailscale: true }, headers: { 'Tailscale-User-Login': 'owner@example.test' } });
  assert.equal(success.status, 200);
  assert.match(success.headers['set-cookie'][0], /Secure/);
  for (const config of [{ origin: 'http://mail.example.test' }, { origin: origin + '/path' }, { origin, allowedTailscaleLogins: 'owner@example.test' }]) {
    assert.throws(() => createWebFactory(config), error => error.code === 'configuration_error');
  }
});

test('two browser sessions share the owner history while logout revokes only its own session', async t => {
  const app = await harness(t);
  const first = await app.login(), second = await app.login();
  assert.notEqual(first.cookie, second.cookie); assert.notEqual(first.csrf, second.csrf);
  const created = await app.create(first);
  const completed = await app.finish(second, created.id);
  assert.equal(completed.body.status, 'completed');
  assert.equal(completed.body.messages[0].body, 'PRIVATE_TEST_EMAIL_BODY');
  assert.equal(completed.body.result.items[0].id, completed.body.messages[0].id);
  assert.equal((await app.call('/api/briefings', { session: second })).body.briefings[0].id, created.id);
  assert.equal((await app.call('/api/session', { method: 'DELETE', session: first })).status, 200);
  assert.equal((await app.call(`/api/briefings/${created.id}`, { session: first })).status, 401);
  assert.equal((await app.call(`/api/briefings/${created.id}`, { session: second })).status, 200);
  assert.equal(app.runs(), 1);
});

test('web OAuth callbacks require the browser session that started the flow and reject replay', async t => {
  let exchanges = 0;
  const app = await harness(t, { fetcher: async () => { exchanges++; return new Response(JSON.stringify({ access_token: 'TEST_ACCESS', refresh_token: 'TEST_REFRESH', expires_in: 3600 })); } });
  const first = await app.login(), second = await app.login();
  const added = await app.call('/api/accounts', { method: 'POST', session: first, input: { provider: 'google', email: 'oauth@example.test' } });
  assert.equal(added.status, 201);
  assert.equal((await app.call('/api/providers', { method: 'POST', session: first, input: { provider: 'google', clientId: 'test.apps.googleusercontent.com', clientSecret: 'PRIVATE_CLIENT_SECRET' } })).status, 200);
  const start = await app.call('/api/accounts/oauth', { method: 'POST', session: first, input: { id: added.body.id } });
  const authorization = new URL(start.body.url);
  const callback = '/oauth/google/callback?' + new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'TEST_CODE' });
  assert.equal((await app.call(callback)).status, 401);
  const wrongSession = await app.call(callback, { session: second });
  assert.equal(wrongSession.headers.location, '/?connectionError=1#accounts');
  assert.equal((await app.call('/api/accounts', { session: second })).body.oauthFailure.code, 'unauthorized');
  assert.equal((await app.call('/api/accounts', { session: first })).body.oauthFailure, null);
  assert.equal((await app.call('/?connectionError=1', { session: second })).status, 200);
  assert.equal(exchanges, 0);
  assert.equal((await app.call(callback, { session: first })).headers.location, '/?connected=1#accounts');
  assert.equal((await app.call('/api/accounts', { session: first })).body.oauthFailure, null);
  const landing = await app.call('/?connected=1', { session: first });
  assert.equal(landing.status, 200);
  assert.equal(landing.headers['cache-control'], 'no-store');
  assert.ok(!landing.text.includes('TEST_ACCESS'));
  assert.equal((await app.call('/?arbitrary=1', { session: first })).status, 404);
  assert.equal((await app.call(callback, { session: first })).headers.location, '/?connectionError=1#accounts');
  assert.equal(exchanges, 1);
  const metadata = await app.call('/api/accounts', { session: first });
  for (const secret of ['TEST_ACCESS', 'TEST_REFRESH', 'PRIVATE_CLIENT_SECRET']) assert.ok(!metadata.text.includes(secret));
});

test('OAuth callback failures are session-local, sanitized and cleared on retry and success', async t => {
  let mode = 'token', exchanges = 0;
  const privateText = 'PRIVATE_DESCRIPTION https://evil.test/?token=PRIVATE_ACCESS&code=PRIVATE_CODE';
  const app = await harness(t, { fetcher: async () => {
    exchanges++;
    return mode === 'token' ? new Response(JSON.stringify({ error: 'invalid_client', error_description: privateText, error_uri: privateText }), { status: 400 }) :
      new Response(JSON.stringify({ access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_in: 3600 }));
  }, mailboxes: { async test() {
    if (mode === 'imap') throw new MailHarborError('mailbox_login_required', privateText);
    return { archivePath: 'Archive' };
  } } });
  const first = await app.login(), second = await app.login();
  const added = await app.call('/api/accounts', { method: 'POST', session: first, input: { provider: 'microsoft', email: 'oauth@example.test' } });
  assert.equal(added.status, 201);
  await app.call('/api/providers', { method: 'POST', session: first, input: { provider: 'microsoft', clientId: '11111111-2222-3333-4444-555555555555', clientSecret: 'PRIVATE_CLIENT_SECRET' } });
  async function start() {
    const result = await app.call('/api/accounts/oauth', { method: 'POST', session: first, input: { id: added.body.id } });
    assert.equal(result.status, 200);
    assert.equal((await app.call('/api/accounts', { session: first })).body.oauthFailure, null);
    return '/oauth/microsoft/callback?' + new URLSearchParams({ state: new URL(result.body.url).searchParams.get('state'), code: 'PRIVATE_CODE' });
  }
  for (const [nextMode, expected] of [['token', 'oauth_invalid_client'], ['imap', 'oauth_imap_authentication_failed']]) {
    mode = nextMode;
    const callback = await start();
    const failed = await app.call(callback, { session: first });
    assert.equal(failed.status, 303); assert.equal(failed.headers.location, '/?connectionError=1#accounts');
    assert.equal(failed.text, '');
    const own = await app.call('/api/accounts', { session: first });
    assert.equal(own.body.oauthFailure.provider, 'microsoft'); assert.equal(own.body.oauthFailure.code, expected);
    assert.deepEqual(Object.keys(own.body.oauthFailure).sort(), ['code', 'message', 'provider']);
    assert.ok(own.body.oauthFailure.message); assert.equal(own.headers['cache-control'], 'no-store');
    assert.doesNotMatch(own.text, /PRIVATE_|evil\.test/u);
    assert.equal((await app.call('/api/accounts', { session: second })).body.oauthFailure, null);
    assert.equal(Boolean(app.store.read().accounts.find(value => value.id === added.body.id)?.auth), false);
  }
  mode = 'success';
  const callback = await start();
  assert.equal((await app.call(callback, { session: first })).headers.location, '/?connected=1#accounts');
  const connected = await app.call('/api/accounts', { session: first });
  assert.equal(connected.body.oauthFailure, null);
  assert.equal(connected.body.accounts.find(value => value.id === added.body.id).connected, true);
  assert.doesNotMatch(connected.text, /PRIVATE_|evil\.test/u);
  assert.equal(exchanges, 3);
  assert.equal((await app.call('/?connectionError=oauth_invalid_client', { session: first })).status, 404);
});

test('a late OAuth callback cannot restore a cleared failure after a newer attempt starts', async t => {
  const entered = gate(), release = gate();
  const app = await harness(t, { fetcher: async () => {
    entered.resolve(); await release.promise;
    return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'PRIVATE_OLD_FAILURE' }), { status: 400 });
  } });
  const session = await app.login();
  const added = await app.call('/api/accounts', { method: 'POST', session, input: { provider: 'google', email: 'oauth@example.test' } });
  assert.equal(added.status, 201);
  await app.call('/api/providers', { method: 'POST', session, input: { provider: 'google', clientId: 'test.apps.googleusercontent.com', clientSecret: 'PRIVATE_SECRET' } });
  const start = await app.call('/api/accounts/oauth', { method: 'POST', session, input: { id: added.body.id } });
  const pending = app.call('/oauth/google/callback?' + new URLSearchParams({ state: new URL(start.body.url).searchParams.get('state'), code: 'PRIVATE_CODE' }), { session });
  await entered.promise;
  assert.equal((await app.call('/api/accounts/oauth', { method: 'POST', session, input: { id: added.body.id } })).status, 200);
  release.resolve();
  assert.equal((await pending).headers.location, '/?connectionError=1#accounts');
  assert.equal((await app.call('/api/accounts', { session })).body.oauthFailure, null);
});

test('explicit archive-folder changes are verified, persisted, and invalidate old review actions', async t => {
  const app = await harness(t);
  const session = await app.login();
  const created = await app.create(session); await app.finish(session, created.id);
  const saved = await app.call('/api/accounts/business-imap/archive', { method: 'POST', session, input: { path: 'Business Archive' } });
  assert.equal(saved.status, 200); assert.deepEqual(saved.body, { archivePath: 'Business Archive' });
  assert.equal(app.store.read().accounts[0].archivePath, 'Business Archive');
  const stale = await app.call(`/api/briefings/${created.id}/actions`, { method: 'POST', session, input: { action: 'archive', ids: [message().id] } });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'stale_message');
  assert.equal(app.mailboxCalls.apply, 0);
});

test('manual actions require valid reviewed IDs and completed intact messages; successful IDs cannot replay', async t => {
  const app = await harness(t);
  const session = await app.login(), created = await app.create(session); await app.finish(session, created.id);
  const route = `/api/briefings/${created.id}/actions`;
  for (const input of [{ action: 'delete', ids: [message().id] }, { action: 'archive', ids: ['invented'] },
    { action: 'archive', ids: [message().id, message().id] }]) {
    assert.equal((await app.call(route, { method: 'POST', session, input })).status, 400);
  }
  const applied = await app.call(route, { method: 'POST', session, input: { action: 'mark_read', ids: [message().id] } });
  assert.equal(applied.status, 200); assert.deepEqual(applied.body.applied, [message().id]);
  assert.equal((await app.call(route, { method: 'POST', session, input: { action: 'mark_read', ids: [message().id] } })).status, 400);
  assert.equal(app.mailboxCalls.apply, 1);
  const refreshed = await app.call(`/api/briefings/${created.id}`, { session });
  assert.equal(refreshed.body.messages.length, 0); assert.equal(refreshed.body.result.items.length, 0);
});

test('truncated messages cannot archive, and empty inboxes complete without an AI job', async t => {
  const app = await harness(t, { mailboxes: { scan: async () => scanned([{ ...message(), truncated: true }]) } });
  const session = await app.login(), created = await app.create(session); await app.finish(session, created.id);
  assert.equal((await app.call(`/api/briefings/${created.id}/actions`, { method: 'POST', session, input: { action: 'archive', ids: [message().id] } })).status, 400);
  assert.equal(app.mailboxCalls.apply, 0);
  const empty = await harness(t, { mailboxes: { scan: async () => scanned([]) } });
  const emptySession = await empty.login(), emptyCreated = await empty.create(emptySession);
  assert.equal((await empty.finish(emptySession, emptyCreated.id)).body.status, 'completed');
  assert.equal(empty.runs(), 0);
});

test('cancelling an unfinished scan prevents late results from reaching the model', async t => {
  const release = gate();
  const app = await harness(t, { mailboxes: { scan: async () => { await release.promise; return scanned(); } } });
  const session = await app.login(), created = await app.create(session);
  const cancelled = await app.call(`/api/briefings/${created.id}`, { method: 'DELETE', session });
  assert.equal(cancelled.body.status, 'cancelled');
  release.resolve(); await pause(10);
  const stored = await app.call(`/api/briefings/${created.id}`, { session });
  assert.equal(stored.body.status, 'cancelled'); assert.deepEqual(stored.body.messages, []);
  assert.equal(app.runs(), 0);
});

test('a job submitted after batch cancellation is cancelled and its result erased', async t => {
  const entered = gate(), release = gate();
  let jobId;
  const app = await harness(t, { wrapJobs: jobs => ({ ...jobs, async submit(input, owner) {
    const job = await jobs.submit(input, owner); jobId = job.id; entered.resolve(); await release.promise; return job;
  } }) });
  const session = await app.login(), created = await app.create(session); await entered.promise;
  await app.call(`/api/briefings/${created.id}`, { method: 'DELETE', session });
  release.resolve(); await pause(10);
  assert.deepEqual(app.jobs().get(jobId, 'mailharbor-owner'), { id: jobId, status: 'cancelled' });
  const stored = await app.call(`/api/briefings/${created.id}`, { session });
  assert.equal(stored.body.status, 'cancelled'); assert.deepEqual(stored.body.messages, []); assert.equal(stored.body.result, undefined);
});

test('disconnect aborts a pending scan and an in-flight mutation blocks competing cancellation', async t => {
  const scanEntered = gate(), scanRelease = gate();
  let scanSignal;
  const app = await harness(t, { mailboxes: { scan: async (selected, { signal }) => { scanSignal = signal; scanEntered.resolve(); await scanRelease.promise; return scanned(); } } });
  const session = await app.login(), created = await app.create(session); await scanEntered.promise;
  assert.equal((await app.call('/api/accounts/business-imap', { method: 'DELETE', session })).status, 200);
  assert.equal(scanSignal.aborted, true); scanRelease.resolve();
  assert.equal((await app.finish(session, created.id)).body.status, 'cancelled');
  const actionEntered = gate(), actionRelease = gate();
  const actions = await harness(t, { mailboxes: { apply: async (selected, refs, ids) => { actionEntered.resolve(); await actionRelease.promise; return { applied: ids, failed: [] }; } } });
  const actionSession = await actions.login(), batch = await actions.create(actionSession); await actions.finish(actionSession, batch.id);
  const action = actions.call(`/api/briefings/${batch.id}/actions`, { method: 'POST', session: actionSession, input: { action: 'mark_read', ids: [message().id] } });
  await actionEntered.promise;
  assert.equal((await actions.call(`/api/briefings/${batch.id}`, { method: 'DELETE', session: actionSession })).status, 429);
  actionRelease.resolve(); assert.equal((await action).status, 200);
});
