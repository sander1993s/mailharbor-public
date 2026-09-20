import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createAccountStore } from '../server/account-store.mjs';
import { createAccounts } from '../server/accounts.mjs';
import { ACCOUNT_PRESETS } from './fixtures/accounts.mjs';
import { MAIL_PROVIDERS, accountDefinition } from '../server/providers.mjs';
import tls from 'node:tls';
import { MailHarborError, safeError } from '../server/validation.mjs';

const origin = 'https://mail.example.test:9443';
const owner = 'test-browser-session';
const registration = { provider: 'google', clientId: 'test-only.apps.googleusercontent.com', clientSecret: 'TEST_CLIENT_SECRET' };
const response = (values = {}) => new Response(JSON.stringify({ access_token: 'TEST_ACCESS', refresh_token: 'TEST_REFRESH', expires_in: 3600, ...values }), { status: 200 });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function memoryStore(initial = { schema: 1, accounts: ACCOUNT_PRESETS.map(item => ({ ...item, auth: null })), providers: {} }) {
  let data = structuredClone(initial), pending = Promise.resolve();
  return { read: () => structuredClone(data), update(change) {
    const next = pending.then(async () => { const copy = structuredClone(data); const value = await change(copy); data = copy; return value; });
    pending = next.catch(() => {}); return next;
  } };
}
function fixture(options = {}) {
  const store = options.store ?? memoryStore();
  const accounts = createAccounts({ store, publicOrigin: origin, testAccount: async () => ({ archivePath: 'Archive' }), fetcher: async () => response(), ...options });
  return { accounts, store };
}
async function googleConnect(accounts, id = 'private-gmail') {
  await accounts.configureProvider(registration);
  const url = new URL(accounts.startOAuth({ id }, owner).url);
  await accounts.finishOAuth('google', new URLSearchParams({ state: url.searchParams.get('state'), code: 'TEST_CODE' }), owner);
}

test('Microsoft adds SMTP consent on reconnect while preserving the scope of existing refresh grants', async () => {
  const requests = [];
  const { accounts, store } = fixture({ fetcher: async (url, options) => { requests.push(new URLSearchParams(options.body)); return response(); } });
  const microsoft = { provider: 'microsoft', clientId: '12345678-1234-1234-1234-123456789012', clientSecret: 'TEST_SECRET' };
  await accounts.configureProvider(microsoft);
  await store.update(data => { data.accounts = data.accounts.filter(item => item.provider !== 'microsoft'); data.accounts.push({ ...ACCOUNT_PRESETS.find(item => item.provider === 'microsoft'), revision: 'legacy', auth: {
    type: 'oauth', accessToken: 'OLD_ACCESS', refreshToken: 'OLD_REFRESH', expiresAt: 0
  } }); });
  await accounts.connectionOptions(accounts.get('private-outlook'));
  assert.equal(requests[0].get('scope'), 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access');
  const url = new URL(accounts.startOAuth({ id: 'private-outlook' }, owner).url);
  assert.match(url.searchParams.get('scope'), /https:\/\/outlook\.office\.com\/SMTP\.Send/u);
  await accounts.finishOAuth('microsoft', new URLSearchParams({ state: url.searchParams.get('state'), code: 'CODE' }), owner);
  assert.match(accounts.get('private-outlook').auth.oauthScope, /SMTP\.Send/u);
  await store.update(data => { data.accounts.find(item => item.id === 'private-outlook').auth.expiresAt = 0; });
  await accounts.connectionOptions(accounts.get('private-outlook'));
  assert.match(requests.at(-1).get('scope'), /SMTP\.Send/u); accounts.close();
});

test('Microsoft records the actual granted OAuth scope when consent returns a narrower grant', async () => {
  const { accounts } = fixture({ fetcher: async () => response({ scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access' }) });
  await accounts.configureProvider({ provider: 'microsoft', clientId: '12345678-1234-1234-1234-123456789012', clientSecret: 'TEST_SECRET' });
  const url = new URL(accounts.startOAuth({ id: 'private-outlook' }, owner).url);
  await accounts.finishOAuth('microsoft', new URLSearchParams({ state: url.searchParams.get('state'), code: 'CODE' }), owner);
  assert.doesNotMatch(accounts.get('private-outlook').auth.oauthScope, /SMTP/u); accounts.close();
});

test('account store encrypts secrets, serializes updates, survives reload, and rejects tampering', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-accounts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createAccountStore(directory);
  const blocked = gate();
  const first = store.update(async data => { await blocked.promise; data.providers.google = { clientSecret: 'PRIVATE_CLIENT_SECRET' }; });
  const second = store.update(data => { data.accounts.push({ id: 'fixture', auth: { password: 'PRIVATE_PASSWORD', refreshToken: 'PRIVATE_REFRESH' } }); });
  blocked.resolve(); await Promise.all([first, second]);
  const encoded = await readFile(path.join(directory, 'accounts.enc'), 'utf8');
  for (const secret of ['PRIVATE_CLIENT_SECRET', 'PRIVATE_PASSWORD', 'PRIVATE_REFRESH']) assert.ok(!encoded.includes(secret));
  const loaded = await createAccountStore(directory);
  assert.deepEqual(loaded.read(), store.read());
  const snapshot = loaded.read(); snapshot.accounts[0].auth.password = 'MODIFIED';
  assert.equal(loaded.read().accounts[0].auth.password, 'PRIVATE_PASSWORD');
  await assert.rejects(store.update(data => { data.accounts = []; throw new Error('test failure'); }));
  assert.equal(store.read().accounts.length, 1);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const name of ['accounts.key', 'accounts.enc']) assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600);
  }
  const envelope = JSON.parse(encoded); envelope.tag = Buffer.alloc(16).toString('base64');
  await writeFile(path.join(directory, 'accounts.enc'), JSON.stringify(envelope));
  await assert.rejects(createAccountStore(directory), error => error.code === 'configuration_error');
});

test('account metadata never returns secrets and IMAP connections pin the configured TLS endpoint', async () => {
  const { accounts } = fixture();
  await accounts.configureProvider(registration);
  await accounts.connectPassword({ id: 'business-imap', password: 'PRIVATE_MAIL_PASSWORD' });
  const metadata = JSON.stringify({ accounts: accounts.list(), registrations: accounts.registrations() });
  assert.ok(!metadata.includes('PRIVATE_MAIL_PASSWORD'));
  assert.ok(!metadata.includes(registration.clientSecret));
  const value = accounts.get('business-imap');
  const options = await accounts.connectionOptions(value);
  assert.equal(options.host, 'imap.example.com'); assert.equal(options.port, 993);
  assert.equal(options.secure, true); assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.logger, false); assert.equal(options.auth.user, 'business@example.com');
  await assert.rejects(accounts.connectionOptions({ ...value, host: '127.0.0.1' }), error => error.code === 'invalid_request');
  await assert.rejects(accounts.connectPassword({ id: 'business-imap', password: 'secret', host: '127.0.0.1' }), error => error.code === 'invalid_request');
  await assert.rejects(accounts.connectPassword({ id: 'private-outlook', password: 'secret' }), error => error.code === 'invalid_request');
  accounts.close();
});

test('only Google app passwords have ASCII grouping spaces removed', async () => {
  const { accounts } = fixture();
  await accounts.connectPassword({ id: 'private-gmail', password: 'abcd efgh ijkl mnop' });
  assert.equal(accounts.get('private-gmail').auth.password, 'abcdefghijklmnop');
  await accounts.connectPassword({ id: 'business-imap', password: ' keep spaces ' });
  assert.equal(accounts.get('business-imap').auth.password, ' keep spaces ');
  await assert.rejects(accounts.connectPassword({ id: 'private-gmail', password: '    ' }), error => error.code === 'invalid_request');
  accounts.close();
});

test('OAuth uses PKCE, binds state to provider/session, verifies before saving, and refuses replay', async () => {
  const exchanges = [], tested = [];
  const { accounts, store } = fixture({
    fetcher: async (url, options) => { exchanges.push({ url, options }); return response(); },
    testAccount: async value => { tested.push(value); return { archivePath: '[Gmail]/All Mail' }; }
  });
  await accounts.configureProvider(registration);
  const url = new URL(accounts.startOAuth({ id: 'private-gmail' }, owner).url);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), origin + '/oauth/google/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('login_hint'), 'personal@example.com');
  const params = new URLSearchParams({ state: url.searchParams.get('state'), code: 'TEST_CODE' });
  await assert.rejects(accounts.finishOAuth('google', params, 'other-session'), error => error.code === 'unauthorized');
  await assert.rejects(accounts.finishOAuth('microsoft', params, owner), error => error.code === 'unauthorized');
  assert.equal(exchanges.length, 0);
  assert.equal(await accounts.finishOAuth('google', params, owner), 'private-gmail');
  const sent = exchanges[0].options.body;
  assert.equal(createHash('sha256').update(sent.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(exchanges[0].options.redirect, 'error');
  assert.equal(tested[0].email, 'personal@example.com');
  assert.equal(store.read().accounts[0].auth.refreshToken, 'TEST_REFRESH');
  assert.ok(!JSON.stringify(accounts.list()).includes('TEST_REFRESH'));
  await assert.rejects(accounts.finishOAuth('google', params, owner), error => error.code === 'unauthorized');
  accounts.close();
});

test('OAuth denial consumes state; expiration and missing refresh tokens do not save accounts', async () => {
  const { accounts, store } = fixture({ fetcher: async () => response({ refresh_token: undefined }) });
  await accounts.configureProvider(registration);
  let url = new URL(accounts.startOAuth({ id: 'private-gmail' }, owner).url);
  const denied = new URLSearchParams({ state: url.searchParams.get('state'), error: 'access_denied' });
  await assert.rejects(accounts.finishOAuth('google', denied, owner), error => error.code === 'mailbox_login_required');
  await assert.rejects(accounts.finishOAuth('google', denied, owner), error => error.code === 'unauthorized');
  url = new URL(accounts.startOAuth({ id: 'private-gmail' }, owner).url);
  await assert.rejects(accounts.finishOAuth('google', new URLSearchParams({ state: url.searchParams.get('state'), code: 'code' }), owner), error => error.code === 'oauth_token_response');
  url = new URL(accounts.startOAuth({ id: 'private-gmail' }, owner).url);
  const now = Date.now;
  try {
    Date.now = () => now() + 11 * 60000;
    await assert.rejects(accounts.finishOAuth('google', new URLSearchParams({ state: url.searchParams.get('state'), code: 'code' }), owner), error => error.code === 'unauthorized');
  } finally { Date.now = now; }
  assert.equal(store.read().accounts.filter(item => item.auth).length, 0);
  accounts.close();
});

test('registration changes invalidate pending OAuth and cannot be overwritten by a late exchange', async () => {
  const entered = gate(), release = gate();
  const { accounts, store } = fixture({ fetcher: async () => { entered.resolve(); await release.promise; return response(); } });
  await accounts.configureProvider(registration);
  const url = new URL(accounts.startOAuth({ id: 'private-gmail' }, owner).url);
  const finishing = accounts.finishOAuth('google', new URLSearchParams({ state: url.searchParams.get('state'), code: 'code' }), owner);
  const rejected = assert.rejects(finishing, error => error.code === 'stale_message');
  await entered.promise;
  await accounts.configureProvider({ ...registration, clientId: 'replacement.apps.googleusercontent.com', clientSecret: 'NEW_SECRET' });
  release.resolve(); await rejected;
  assert.equal(store.read().accounts.filter(item => item.auth).length, 0);
  assert.equal(store.read().providers.google.clientSecret, 'NEW_SECRET');
  const again = new URL(accounts.startOAuth({ id: 'private-gmail' }, owner).url);
  await accounts.configureProvider({ ...registration, clientId: 'third.apps.googleusercontent.com' });
  await assert.rejects(accounts.finishOAuth('google', new URLSearchParams({ state: again.searchParams.get('state'), code: 'code' }), owner), error => error.code === 'unauthorized');
  accounts.close();
});

test('disconnect prevents in-flight password or OAuth testing from recreating an account', async () => {
  for (const method of ['password', 'oauth']) {
    const entered = gate(), release = gate();
    const { accounts, store } = fixture({ testAccount: async () => { entered.resolve(); await release.promise; return { archivePath: 'Archive' }; } });
    let connecting;
    const id = method === 'password' ? 'business-imap' : 'private-gmail';
    if (method === 'password') connecting = accounts.connectPassword({ id, password: 'TEST_PASSWORD' });
    else {
      await accounts.configureProvider(registration);
      const url = new URL(accounts.startOAuth({ id }, owner).url);
      connecting = accounts.finishOAuth('google', new URLSearchParams({ state: url.searchParams.get('state'), code: 'code' }), owner);
    }
    const rejected = assert.rejects(connecting, error => error.code === 'stale_message');
    await entered.promise; await accounts.disconnect(id); release.resolve(); await rejected;
    assert.equal(store.read().accounts.filter(item => item.auth).length, 0); accounts.close();
  }
});

test('refresh tokens rotate once for simultaneous connections and are retained when rotation is omitted', async () => {
  let requests = 0;
  const { accounts, store } = fixture({ fetcher: async (url, options) => {
    requests++;
    return response(requests === 2 ? { access_token: 'ACCESS_ROTATED', refresh_token: 'REFRESH_ROTATED' }
      : requests === 3 ? { access_token: 'ACCESS_LATER', refresh_token: undefined } : {});
  } });
  await googleConnect(accounts);
  await store.update(data => { data.accounts[0].auth.expiresAt = 0; });
  const expired = accounts.get('private-gmail');
  const connections = await Promise.all(Array.from({ length: 5 }, () => accounts.connectionOptions(expired)));
  assert.equal(requests, 2);
  assert.ok(connections.every(value => value.auth.accessToken === 'ACCESS_ROTATED'));
  assert.equal(store.read().accounts[0].auth.refreshToken, 'REFRESH_ROTATED');
  await store.update(data => { data.accounts[0].auth.expiresAt = 0; });
  await accounts.connectionOptions(accounts.get('private-gmail'));
  assert.equal(requests, 3);
  assert.equal(store.read().accounts[0].auth.refreshToken, 'REFRESH_ROTATED');
  accounts.close();
});

test('Google reconsent may retain an existing refresh token only for the same account and registration revision', async () => {
  let requests = 0, tested = 0;
  const { accounts, store } = fixture({
    fetcher: async () => response(++requests === 1 ? {} : { access_token: 'RECONSENT_ACCESS', refresh_token: undefined }),
    testAccount: async () => { tested++; return { archivePath: 'Archive' }; }
  });
  await googleConnect(accounts);
  const previous = accounts.get('private-gmail').revision;
  let url = new URL(accounts.startOAuth({ id: 'private-gmail' }, owner).url);
  await accounts.finishOAuth('google', new URLSearchParams({ state: url.searchParams.get('state'), code: 'code' }), owner);
  assert.equal(tested, 2);
  assert.equal(accounts.get('private-gmail').auth.refreshToken, 'TEST_REFRESH');
  assert.equal(accounts.get('private-gmail').auth.accessToken, 'RECONSENT_ACCESS');
  assert.notEqual(accounts.get('private-gmail').revision, previous);
  await accounts.configureProvider({ ...registration, clientSecret: 'ROTATED_CLIENT_SECRET' });
  url = new URL(accounts.startOAuth({ id: 'private-gmail' }, owner).url);
  await assert.rejects(accounts.finishOAuth('google', new URLSearchParams({ state: url.searchParams.get('state'), code: 'code' }), owner), error => error.code === 'oauth_token_response');
  assert.equal(tested, 2);
  assert.equal(store.read().accounts[0].auth.refreshToken, 'TEST_REFRESH');
  accounts.close();
});

test('a late refresh cannot overwrite a reconnected account or a changed OAuth registration', async () => {
  const entered = gate(), release = gate();
  let requests = 0;
  const { accounts, store } = fixture({ fetcher: async () => {
    if (++requests === 1) return response();
    entered.resolve(); await release.promise; return response({ access_token: 'STALE_ACCESS' });
  } });
  await googleConnect(accounts);
  await store.update(data => { data.accounts[0].auth.expiresAt = 0; });
  const refreshing = accounts.connectionOptions(accounts.get('private-gmail'));
  const rejected = assert.rejects(refreshing, error => error.code === 'stale_message');
  await entered.promise;
  await accounts.connectPassword({ id: 'private-gmail', password: 'NEW_ACCOUNT_CREDENTIAL' });
  release.resolve(); await rejected;
  assert.equal(accounts.get('private-gmail').auth.password, 'NEW_ACCOUNT_CREDENTIAL');
  await accounts.configureProvider({ ...registration, clientId: 'new-client.apps.googleusercontent.com' });
  assert.equal(accounts.get('private-gmail').auth.type, 'password');
  accounts.close();
});

test('archive selection requires the exact verified existing target and changes the account revision', async () => {
  let accepted = 'Archive';
  const { accounts } = fixture({ testAccount: async value => ({ archivePath: value.archivePath === accepted ? accepted : value.archivePath ? null : 'Archive' }) });
  await accounts.connectPassword({ id: 'business-imap', password: 'TEST_PASSWORD' });
  const before = accounts.get('business-imap').revision;
  await assert.rejects(accounts.setArchivePath('business-imap', 'Missing'), error => error.code === 'archive_unavailable');
  assert.equal(accounts.get('business-imap').revision, before);
  accepted = 'Business Archive';
  assert.deepEqual(await accounts.setArchivePath('business-imap', accepted), { archivePath: accepted });
  assert.equal(accounts.get('business-imap').archivePath, accepted);
  assert.notEqual(accounts.get('business-imap').revision, before);
  for (const value of ['', 'Bad\r\nINBOX', 'x'.repeat(1025), null]) await assert.rejects(accounts.setArchivePath('business-imap', value), error => error.code === 'invalid_request');
  accounts.close();
});

test('OAuth token diagnostics classify only fixed protocol names and redact malicious provider data', async () => {
  const privateText = 'PRIVATE_PROVIDER_TEXT https://evil.test/?code=PRIVATE_CODE&token=PRIVATE_TOKEN';
  const failures = [
    ...['invalid_client', 'unauthorized_client', 'invalid_scope', 'invalid_grant'].map(error => [
      `oauth_${error}`, async () => new Response(JSON.stringify({ error, error_description: privateText, error_uri: privateText }), { status: 400 })
    ]),
    ['oauth_token_transport', async () => { throw new Error(privateText); }],
    ['oauth_token_transport', async () => ({ ok: true, text: async () => { throw new Error(privateText); } })],
    ['oauth_token_response', async () => new Response(privateText, { status: 502 })],
    ['oauth_token_response', async () => new Response('null')],
    ['oauth_token_response', async () => new Response('[]')],
    ['oauth_token_response', async () => new Response(JSON.stringify({ error: '__proto__', error_description: privateText }), { status: 400 })],
    ['oauth_token_response', async () => new Response(JSON.stringify({ error: privateText }), { status: 400 })],
    ['oauth_token_response', async () => response({ expires_in: '3600' })],
    ['oauth_token_response', async () => ({ redirected: true, url: privateText })]
  ];
  for (const [expected, fetcher] of failures) {
    let tested = 0;
    const { accounts, store } = fixture({ fetcher, testAccount: async () => { tested++; return { archivePath: 'Archive' }; } });
    await accounts.configureProvider(registration);
    const url = new URL(accounts.startOAuth({ id: 'private-gmail' }, owner).url);
    const params = new URLSearchParams({ state: url.searchParams.get('state'), code: 'PRIVATE_AUTHORIZATION_CODE' });
    await assert.rejects(accounts.finishOAuth('google', params, owner), error => {
      assert.equal(error.code, expected);
      const publicError = safeError(error);
      assert.equal(publicError.code, expected);
      assert.ok(publicError.message);
      assert.doesNotMatch(JSON.stringify(publicError), /PRIVATE_|https:|evil\.test/u);
      assert.doesNotMatch(String(error), /PRIVATE_|evil\.test/u);
      return true;
    });
    assert.equal(tested, 0); assert.equal(store.read().accounts.filter(item => item.auth).length, 0);
    await assert.rejects(accounts.finishOAuth('google', params, owner), { code: 'unauthorized' });
    accounts.close();
  }
});

test('OAuth distinguishes IMAP rejection from connection failure only after a successful token exchange', async () => {
  for (const [error, expected] of [
    [new MailHarborError('mailbox_login_required', 'PRIVATE_IMAP_RESPONSE'), 'oauth_imap_authentication_failed'],
    [new MailHarborError('mailbox_timeout', 'PRIVATE_IMAP_RESPONSE'), 'oauth_imap_connection_failed'],
    [new Error('PRIVATE_IMAP_RESPONSE'), 'oauth_imap_connection_failed']
  ]) {
    let exchanges = 0, tested = 0;
    const { accounts, store } = fixture({ fetcher: async () => { exchanges++; return response(); },
      testAccount: async value => { tested++; assert.equal(value.auth.accessToken, 'TEST_ACCESS'); throw error; } });
    await accounts.configureProvider(registration);
    const url = new URL(accounts.startOAuth({ id: 'private-gmail' }, owner).url);
    await assert.rejects(accounts.finishOAuth('google', new URLSearchParams({ state: url.searchParams.get('state'), code: 'PRIVATE_CODE' }), owner), error => {
      assert.equal(error.code, expected);
      assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_|TEST_ACCESS/u);
      return true;
    });
    assert.equal(exchanges, 1); assert.equal(tested, 1); assert.equal(store.read().accounts.filter(item => item.auth).length, 0);
    accounts.close();
  }
});

test('a rejected refresh token is diagnosed without replacing existing credentials', async () => {
  let exchanges = 0;
  const { accounts, store } = fixture({ fetcher: async () => ++exchanges === 1 ? response() :
    new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'PRIVATE_REFRESH_DETAILS' }), { status: 400 }) });
  await googleConnect(accounts);
  await store.update(data => { data.accounts[0].auth.expiresAt = 0; });
  await assert.rejects(accounts.connectionOptions(accounts.get('private-gmail')), error => {
    assert.equal(error.code, 'oauth_invalid_grant');
    assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_REFRESH_DETAILS/u);
    return true;
  });
  assert.equal(store.read().accounts[0].auth.refreshToken, 'TEST_REFRESH');
  assert.equal(store.read().accounts[0].auth.accessToken, 'TEST_ACCESS');
  accounts.close();
});


test('new installations have no accounts; users can add independent accounts for every provider', async () => {
  const { accounts, store } = fixture({ store: memoryStore({ schema: 1, accounts: [], providers: {} }) });
  assert.deepEqual(accounts.list(), []);
  assert.ok(accounts.catalog().length >= 13);
  assert.ok(accounts.catalog().every(item => !Object.hasOwn(item, 'email')));
  for (const preset of MAIL_PROVIDERS.filter(item => !item.localBridge)) {
    const body = { provider: preset.id, email: `${preset.id}@example.test`, label: preset.label,
      ...(preset.id === 'imap' ? { incoming: { host: 'imap.example.test', port: 143, security: 'starttls' }, smtp: { host: 'smtp.example.test', port: 587, security: 'starttls' } } : {}) };
    const added = await accounts.add(body);
    assert.match(added.id, /^[a-f0-9]{32}$/u);
    assert.equal(added.connected, false);
    assert.throws(() => accounts.get(added.id), { code: 'mailbox_login_required' });
    if (preset.authMethods.includes('password')) {
      await accounts.connectPassword({ id: added.id, password: 'APP_PASSWORD' });
      const value = accounts.get(added.id), options = await accounts.connectionOptions(value);
      assert.equal(options.auth.user, body.email);
      assert.equal(options.secure, preset.id !== 'imap');
      assert.equal(options.doSTARTTLS, preset.id === 'imap');
      assert.equal(options.tls.rejectUnauthorized, true);
      assert.equal(accounts.smtpSettings(value).host, body.smtp?.host ?? preset.smtp.host);
    }
  }
  assert.equal(new Set(accounts.list().map(item => item.id)).size, 13);
  assert.ok(!JSON.stringify(accounts.list()).includes('APP_PASSWORD'));
  await assert.rejects(accounts.add({ provider: 'google', email: 'google@example.test' }), { code: 'invalid_request' });
  const first = accounts.list()[0]; await accounts.disconnect(first.id);
  assert.ok(!store.read().accounts.some(item => item.id === first.id));
  accounts.close();
});

test('generic configuration validates identity, endpoints, encryption and custom usernames before saving', async () => {
  const { accounts, store } = fixture({ store: memoryStore({ schema: 1, accounts: [], providers: {} }) });
  const base = { provider: 'imap', email: 'person@example.test', incoming: { host: 'imap.example.test', port: 993, security: 'tls' }, smtp: { host: 'smtp.example.test', port: 587, security: 'starttls' } };
  for (const body of [
    { ...base, provider: 'unknown' }, { ...base, email: 'a@example.test\r\nInjected: yes' }, { ...base, label: 'bad\nlabel' },
    { ...base, auth: { password: 'secret' } }, { ...base, allowLocalBridge: true }, { ...base, tlsCertificate: 'CA' },
    ...['127.0.0.1', '::1', 'localhost', 'imap.local', 'imap.example.test/path', 'user@imap.example.test', '127.1', '0x7f000001'].map(host => ({ ...base, incoming: { ...base.incoming, host } })),
    { ...base, incoming: { ...base.incoming, security: 'none' } }, { ...base, incoming: { ...base.incoming, port: 0 } },
    { ...base, smtp: { ...base.smtp, port: 65536 } }, { ...base, smtp: { ...base.smtp, rejectUnauthorized: false } },
    { provider: 'google', email: base.email, incoming: base.incoming }, { provider: 'microsoft', email: base.email, smtp: base.smtp }
  ]) await assert.rejects(accounts.add(body), { code: 'invalid_request' });
  assert.equal(store.read().accounts.length, 0);
  const { id } = await accounts.add({ ...base, username: 'incoming-login', smtp: { ...base.smtp, username: 'outgoing-login' } });
  await accounts.connectPassword({ id, password: 'IMAP_PASSWORD', smtpPassword: 'SMTP_PASSWORD' });
  assert.equal((await accounts.connectionOptions(accounts.get(id))).auth.user, 'incoming-login');
  assert.equal(accounts.smtpSettings(accounts.get(id)).username, 'outgoing-login');
  assert.doesNotMatch(JSON.stringify(accounts.list()), /IMAP_PASSWORD|SMTP_PASSWORD/u);
  accounts.close();
});

test('Proton Bridge requires explicit loopback opt-in and a valid certificate; TLS stays mandatory', async () => {
  const { accounts } = fixture({ store: memoryStore({ schema: 1, accounts: [], providers: {} }) });
  const base = { provider: 'proton', email: 'bridge@example.test', allowLocalBridge: true, tlsCertificate: tls.rootCertificates[0] };
  for (const body of [{ ...base, allowLocalBridge: false }, { ...base, tlsCertificate: undefined }, { ...base, tlsCertificate: 'not a certificate' },
    { ...base, incoming: { host: 'imap.example.test' } }, { ...base, smtp: { host: '127.0.0.2' } }, { ...base, incoming: { port: 443 } }]) {
    await assert.rejects(accounts.add(body), { code: 'invalid_request' });
  }
  const { id } = await accounts.add(base);
  await accounts.connectPassword({ id, password: 'BRIDGE_PASSWORD' });
  const options = await accounts.connectionOptions(accounts.get(id));
  assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 1143);
  assert.equal(options.doSTARTTLS, true); assert.equal(options.tls.rejectUnauthorized, true);
  assert.match(options.tls.ca, /BEGIN CERTIFICATE/u);
  assert.equal(accounts.smtpSettings(accounts.get(id)).port, 1025);
  assert.ok(!JSON.stringify(accounts.list()).includes('BEGIN CERTIFICATE'));
  accounts.close();
});

test('Microsoft 365 uses organization-capable OAuth and its own SMTP endpoint', async () => {
  const { accounts } = fixture({ store: memoryStore({ schema: 1, accounts: [], providers: {} }) });
  const { id } = await accounts.add({ provider: 'microsoft365', email: 'work@example.test' });
  await accounts.configureProvider({ provider: 'microsoft', clientId: '12345678-1234-1234-1234-123456789012', clientSecret: 'TEST_SECRET' });
  const url = new URL(accounts.startOAuth({ id }, owner).url);
  assert.equal(url.pathname, '/common/oauth2/v2.0/authorize');
  await accounts.finishOAuth('microsoft', new URLSearchParams({ state: url.searchParams.get('state'), code: 'TEST_CODE' }), owner);
  assert.equal(accounts.smtpSettings(accounts.get(id)).host, 'smtp.office365.com');
  await assert.rejects(accounts.connectPassword({ id, password: 'TEST_PASSWORD' }), { code: 'invalid_request' });
  accounts.close();
});
