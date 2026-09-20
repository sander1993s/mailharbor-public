import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { createAccountStore } from '../server/account-store.mjs';
import { createDrive, DRIVE_SCOPE } from '../server/drive.mjs';

const DRIVE_EXPECTED_EMAIL = 'drive@example.com';
const CLIENT = 'mailharbor-fixture.apps.googleusercontent.com';
const SECRET = 'PRIVATE_DRIVE_CLIENT_SECRET';
const ACCESS = 'PRIVATE_DRIVE_ACCESS_TOKEN';
const REFRESH = 'PRIVATE_DRIVE_REFRESH_TOKEN';
const OWNER = 'private-browser-session';
const ORIGIN = 'https://mail.example.test:9443';
const MIME_FOLDER = 'application/vnd.google-apps.folder';
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const pdf = Buffer.from('%PDF-1.7\r\n\x00\xffOriginal invoice bytes\r\n%%EOF', 'latin1');
const input = overrides => ({ bytes: pdf, mimeType: 'application/pdf', filename: 'invoice.pdf', entityLabel: 'Example Studio', year: 2026, quarter: 3, ...overrides });
const response = (value, status = 200, headers = {}) => new Response(value === null ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function memoryStore() {
  let data = { schema: 1, accounts: [{ id: 'existing', auth: { password: 'PRIVATE_MAIL_PASSWORD' } }], providers: { google: { clientSecret: 'UNRELATED_PROVIDER_SECRET' } } }, pending = Promise.resolve();
  return {
    read: () => structuredClone(data),
    update(change) {
      const work = pending.then(async () => { const copy = structuredClone(data); await change(copy); data = copy; });
      pending = work.catch(() => {}); return work;
    }
  };
}
function fakeGoogle(store) {
  const root = { id: 'my-drive-root', name: 'My Drive', mimeType: MIME_FOLDER, ownedByMe: true, shared: false, trashed: false };
  const state = { files: new Map([[root.id, root]]), uploads: new Map(), requests: [], created: [], counter: 0, tokens: 0, identity: { sub: 'private-user-subject', email: DRIVE_EXPECTED_EMAIL, email_verified: true }, scope: DRIVE_SCOPE, before: null, uncertain: null, uploadLocation: null };
  function create(metadata, bytes) {
    assert.ok(Object.values(store.read().mailDrive.allocations).some(entry => entry.id === metadata.id), 'An ID must be durably allocated before creating any Drive item.');
    if (state.files.has(metadata.id)) return response({ error: { message: 'PRIVATE_PROVIDER_CONFLICT' } }, 409);
    const file = { ...metadata, parents: metadata.parents.map(parent => parent === 'root' ? root.id : parent), ownedByMe: true, shared: false, trashed: false, ...(bytes ? { size: String(bytes.length), md5Checksum: digest('md5', bytes), sha256Checksum: digest('sha256', bytes) } : {}) };
    state.files.set(file.id, file); state.created.push({ metadata: structuredClone(metadata), bytes: bytes ? Buffer.from(bytes) : null });
    if (bytes && state.uncertain === 'after') { state.uncertain = null; throw new Error(`PRIVATE_PROVIDER_FAILURE ${ACCESS}`); }
    return response(file);
  }
  state.fetcher = async (urlText, options) => {
    const url = new URL(urlText);
    state.requests.push({ url, options });
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    if (state.before) { const result = await state.before(url, options); if (result) return result; }
    if (url.href === 'https://oauth2.googleapis.com/token') {
      state.tokens++;
      assert.ok(options.body instanceof URLSearchParams);
      assert.equal(options.body.get('client_id'), CLIENT);
      assert.equal(options.body.get('client_secret'), SECRET);
      return response({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: 'Bearer', scope: state.scope });
    }
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') return response(state.identity);
    assert.equal(url.origin, 'https://www.googleapis.com', 'Only fixed Google endpoints receive Drive requests.');
    assert.equal(options.headers.Authorization, `Bearer ${ACCESS}`);
    if (url.pathname === '/drive/v3/files/generateIds') return response({ ids: [`allocated-${++state.counter}`], space: 'drive' });
    if (url.pathname === '/drive/v3/files' && options.method === 'GET') {
      const query = url.searchParams.get('q');
      const parent = query.match(/'([^']+)' in parents/u)?.[1], name = query.match(/name='([^']+)'/u)?.[1];
      const properties = [...query.matchAll(/appProperties has \{ key='([^']+)' and value='([^']*)' \}/gu)].map(match => [match[1], match[2]]);
      return response({ files: [...state.files.values()].filter(file => file.trashed !== true && file.parents?.includes(parent === 'root' ? root.id : parent) && (!name || file.name === name) && properties.every(([key, value]) => file.appProperties?.[key] === value)) });
    }
    if (url.pathname.startsWith('/drive/v3/files/') && options.method === 'GET') {
      const id = url.pathname.split('/').at(-1), file = state.files.get(id === 'root' ? root.id : id);
      return response(file || { error: { message: 'PRIVATE_FILE_NOT_FOUND' } }, file ? 200 : 404);
    }
    if (url.pathname === '/drive/v3/files' && options.method === 'POST') return create(JSON.parse(options.body));
    if (url.pathname === '/upload/drive/v3/files' && options.method === 'POST') {
      if (url.searchParams.get('uploadType') === 'resumable') {
        const metadata = JSON.parse(options.body);
        if (state.files.has(metadata.id)) return response({}, 409);
        state.uploads.set(metadata.id, metadata);
        return response(null, 200, { Location: state.uploadLocation || `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${metadata.id}` });
      }
      const boundary = options.headers['Content-Type'].split('boundary=')[1];
      const body = Buffer.from(options.body), metadataStart = body.indexOf('\r\n\r\n') + 4, metadataEnd = body.indexOf(`\r\n--${boundary}`, metadataStart);
      const metadata = JSON.parse(body.subarray(metadataStart, metadataEnd).toString('utf8'));
      const dataStart = body.indexOf('\r\n\r\n', metadataEnd + 4) + 4, dataEnd = body.lastIndexOf(`\r\n--${boundary}--`);
      assert.equal(String(body.length), options.headers['Content-Length']);
      if (state.uncertain === 'before') { state.uncertain = null; throw new Error(`PRIVATE_NETWORK_ERROR ${SECRET}`); }
      return create(metadata, body.subarray(dataStart, dataEnd));
    }
    if (url.pathname === '/upload/drive/v3/files' && options.method === 'PUT') return create(state.uploads.get(url.searchParams.get('upload_id')), Buffer.from(options.body));
    assert.fail(`Unexpected test request ${url.pathname}`);
  };
  return state;
}
async function setup({ store = memoryStore(), connected = true } = {}) {
  let time = 1000000;
  const google = fakeGoogle(store), drive = createDrive({ store, publicOrigin: ORIGIN, fetcher: google.fetcher, now: () => time });
  await drive.configure({ expectedEmail: DRIVE_EXPECTED_EMAIL, clientId: CLIENT, clientSecret: SECRET });
  const authorize = async () => {
    const url = new URL(drive.start(OWNER).url);
    return drive.finish(new URLSearchParams({ state: url.searchParams.get('state'), code: 'PRIVATE_AUTHORIZATION_CODE' }), OWNER);
  };
  if (connected) await authorize();
  return { store, google, drive, authorize, advance: milliseconds => { time += milliseconds; }, now: () => time };
}

test('limited Drive scope files invoices without access to My Drive root metadata', async () => {
  const h = await setup();
  h.google.before = async url => url.pathname === '/drive/v3/files/root' ? response({ error: { code: 404 } }, 404) : undefined;
  const first = await h.drive.fileInvoice(input());
  assert.equal(first.deduplicated, false);
  assert.equal((await h.drive.fileInvoice(input())).deduplicated, true);
  assert.equal(h.google.requests.some(call => call.url.pathname === '/drive/v3/files/root'), false);
  assert.deepEqual(h.google.created[0].metadata.parents, ['root']);
  const folder = [...h.google.files.values()].find(file => file.name === 'Invoices');
  folder.parents = ['another-private-folder'];
  await assert.rejects(h.drive.fileInvoice(input()), { code: 'drive_error' });
  assert.equal(h.google.created.filter(item => item.bytes).length, 1);
});

test('Drive OAuth uses exact scopes and PKCE, binds and consumes state, and returns no credentials', async () => {
  const h = await setup({ connected: false });
  const url = new URL(h.drive.start(OWNER).url), params = new URLSearchParams({ state: url.searchParams.get('state'), code: 'PRIVATE_AUTHORIZATION_CODE' });
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), DRIVE_SCOPE);
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/oauth/drive/callback`);
  assert.equal(url.searchParams.get('login_hint'), DRIVE_EXPECTED_EMAIL);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(h.drive.finish(params, 'another-session'), { code: 'unauthorized' });
  assert.equal(h.google.tokens, 0);
  const result = await h.drive.finish(params, OWNER);
  const exchanged = h.google.requests.find(call => call.url.href === 'https://oauth2.googleapis.com/token').options.body;
  assert.equal(createHash('sha256').update(exchanged.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(result.connected, true); assert.equal(result.email, DRIVE_EXPECTED_EMAIL);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|refreshToken|accessToken|clientSecret/);
  await assert.rejects(h.drive.finish(params, OWNER), { code: 'unauthorized' });
  const expired = new URL(h.drive.start(OWNER).url); h.advance(600000);
  await assert.rejects(h.drive.finish(new URLSearchParams({ state: expired.searchParams.get('state'), code: 'expired' }), OWNER), { code: 'unauthorized' });
  assert.equal(h.google.tokens, 1);
});

test('only the verified private account and exact granted scopes may connect', async () => {
  for (const identity of [{ email: 'user@example.com', email_verified: true, sub: 'other' }, { email: DRIVE_EXPECTED_EMAIL, email_verified: false, sub: 'private' }]) {
    const h = await setup({ connected: false }); h.google.identity = identity;
    await assert.rejects(h.authorize(), { code: 'drive_wrong_account' });
    assert.equal(h.drive.status().connected, false);
  }
  const h = await setup({ connected: false }); h.google.scope = `${DRIVE_SCOPE} https://www.googleapis.com/auth/drive`;
  await assert.rejects(h.authorize(), { code: 'drive_login_required' });
  assert.equal(h.drive.status().connected, false);
  h.google.scope = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file';
  await h.authorize(); assert.equal(h.drive.status().connected, true);
});

test('registration and tokens persist encrypted without changing mailbox credentials; disconnect is local', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-drive-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('mailharbor-drive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createAccountStore(directory), h = await setup({ store });
  const before = store.read();
  await h.drive.fileInvoice(input());
  const reopenedStore = await createAccountStore(directory), reopened = createDrive({ store: reopenedStore, publicOrigin: ORIGIN, fetcher: h.google.fetcher, now: h.now });
  assert.equal(reopened.status().connected, true); assert.ok(reopened.status().rootFolderId);
  const ciphertext = await readFile(path.join(directory, 'accounts.enc'), 'utf8');
  for (const secret of [SECRET, ACCESS, REFRESH, 'invoice.pdf', DRIVE_EXPECTED_EMAIL]) assert.equal(ciphertext.includes(secret), false);
  const calls = h.google.requests.length;
  await reopened.disconnect();
  assert.equal(h.google.requests.length, calls, 'Disconnect must not revoke unrelated Google grants.');
  assert.deepEqual(reopenedStore.read().accounts, before.accounts); assert.deepEqual(reopenedStore.read().providers, before.providers);
  assert.equal(reopened.status().configured, true); assert.equal(reopened.status().connected, false);
  assert.ok(reopenedStore.read().mailDrive.allocations['folder:Invoices']);
  assert.doesNotMatch(JSON.stringify(reopened.status()), /PRIVATE_|refreshToken|accessToken|clientSecret/);
});

test('configuration changes and disconnect invalidate an in-flight OAuth exchange and refresh', async () => {
  const h = await setup({ connected: false }), blocked = gate();
  h.google.before = async url => { if (url.href === 'https://oauth2.googleapis.com/token') await blocked.promise; };
  const connecting = h.authorize(); await nextTurn();
  await h.drive.configure({ expectedEmail: DRIVE_EXPECTED_EMAIL, clientId: CLIENT, clientSecret: 'REPLACED_SECRET' });
  blocked.resolve(); await assert.rejects(connecting, { code: 'drive_login_required' });
  assert.equal(h.drive.status().connected, false);

  const second = await setup(), refreshGate = gate(); second.advance(3600000);
  second.google.before = async url => { if (url.href === 'https://oauth2.googleapis.com/token') await refreshGate.promise; };
  const uploading = second.drive.fileInvoice(input()); await nextTurn();
  await second.drive.disconnect(); refreshGate.resolve();
  await assert.rejects(uploading, { code: 'drive_login_required' });
  assert.equal(second.drive.status().connected, false);
  assert.equal(second.google.created.length, 0);
});

test('queued uploads refresh once and preserve exact bytes, entity and quarter separation', async () => {
  const h = await setup(); h.advance(3600000);
  const xml = Buffer.from('<?xml version="1.0"?><Invoice><Amount>123.45</Amount></Invoice>');
  const [first, same, nextQuarter, otherEntity] = await Promise.all([
    h.drive.fileInvoice(input()), h.drive.fileInvoice(input({ filename: 'different-original-name.pdf' })),
    h.drive.fileInvoice(input({ quarter: 4 })), h.drive.fileInvoice(input({ bytes: xml, mimeType: 'application/xml', filename: 'original.xml', entityLabel: 'Example Company' }))
  ]);
  assert.equal(h.google.tokens, 2, 'One authorization exchange plus one serialized refresh.');
  assert.equal(first.deduplicated, false); assert.equal(same.deduplicated, true); assert.equal(first.fileId, same.fileId);
  assert.notEqual(first.fileId, nextQuarter.fileId); assert.notEqual(first.fileId, otherEntity.fileId);
  assert.equal(nextQuarter.folderPath, 'Invoices/Example Studio/2026/Q4');
  assert.equal(otherEntity.folderPath, 'Invoices/Example Company/2026/Q3');
  const created = h.google.created.filter(item => item.bytes);
  assert.equal(created.length, 3); assert.deepEqual(created[0].bytes, pdf); assert.deepEqual(created[2].bytes, xml);
  assert.equal(h.google.created.filter(item => item.metadata.name === 'Invoices').length, 1);
  assert.equal(h.google.created.filter(item => item.metadata.name === 'Example Studio').length, 1);
  assert.doesNotMatch(JSON.stringify([first, same, nextQuarter, otherEntity]), /PRIVATE_|accessToken|refreshToken/);
});

test('uncertain create retries after restart reuse the persisted ID and never create duplicates', async () => {
  for (const uncertainty of ['before', 'after']) {
    const h = await setup(); h.google.uncertain = uncertainty;
    await assert.rejects(h.drive.fileInvoice(input()), error => {
      assert.equal(error.code, 'drive_error'); assert.doesNotMatch(String(error), /PRIVATE_/); return true;
    });
    const allocated = Object.values(h.store.read().mailDrive.allocations).find(entry => entry.metadata.appProperties.kind === 'invoice');
    assert.equal(allocated.complete, false);
    const restarted = createDrive({ store: h.store, publicOrigin: ORIGIN, fetcher: h.google.fetcher, now: h.now });
    const result = await restarted.fileInvoice(input());
    assert.equal(result.fileId, allocated.id);
    assert.equal(h.google.created.filter(item => item.bytes).length, 1);
    assert.equal(Object.values(h.store.read().mailDrive.allocations).find(entry => entry.id === allocated.id).complete, true);
  }
});

test('foreign, duplicate or shared folders and ambiguous invoice matches stop without modifying them', async () => {
  const h = await setup();
  h.google.files.set('foreign-folder', { id: 'foreign-folder', name: 'Invoices', mimeType: MIME_FOLDER, parents: ['my-drive-root'], ownedByMe: true, shared: false, trashed: false, appProperties: {} });
  await assert.rejects(h.drive.fileInvoice(input()), { code: 'drive_error' });
  assert.equal(h.google.created.length, 0);
  h.google.files.delete('foreign-folder');
  const first = await h.drive.fileInvoice(input()), file = h.google.files.get(first.fileId);
  h.google.files.set('duplicate-invoice', { ...structuredClone(file), id: 'duplicate-invoice' });
  await assert.rejects(h.drive.fileInvoice(input()), { code: 'drive_duplicate_ambiguous' });
  h.google.files.delete('duplicate-invoice');
  const folder = [...h.google.files.values()].find(item => item.name === 'Invoices'); folder.shared = true;
  await assert.rejects(h.drive.fileInvoice(input()), { code: 'drive_error' });
  assert.equal(h.google.created.filter(item => item.bytes).length, 1);
  assert.equal(h.google.requests.some(call => ['PATCH', 'DELETE'].includes(call.options.method)), false);
});

test('larger original files use a bounded resumable upload and reject foreign session URLs', async () => {
  const h = await setup(), bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 0xf3); pdf.copy(bytes);
  const filed = await h.drive.fileInvoice(input({ bytes }));
  assert.equal(filed.sha256, digest('sha256', bytes));
  assert.deepEqual(h.google.created.find(item => item.bytes).bytes, bytes);
  assert.equal(h.google.requests.filter(call => call.options.method === 'PUT').length, 1);
  const bad = await setup(); bad.google.uploadLocation = 'https://attacker.invalid/upload?uploadType=resumable&upload_id=secret';
  await assert.rejects(bad.drive.fileInvoice(input({ bytes })), { code: 'drive_error' });
  assert.equal(bad.google.requests.some(call => call.url.hostname === 'attacker.invalid'), false);
});

test('file validation and mismatched stored content fail before unsafe uploads', async () => {
  const h = await setup(); const before = h.google.requests.length;
  for (const change of [{ bytes: Buffer.alloc(0) }, { bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }, { bytes: Buffer.from('not a PDF') }, { mimeType: 'text/html' }, { filename: '../escape.pdf' }, { year: '2026' }, { year: 10000 }, { quarter: 5 }, { entityLabel: '../unsafe' }, { sha256: '0'.repeat(64) }]) {
    await assert.rejects(h.drive.fileInvoice(input(change)), { code: 'invalid_request' });
  }
  assert.equal(h.google.requests.length, before);
  const first = await h.drive.fileInvoice(input());
  h.google.files.get(first.fileId).md5Checksum = '0'.repeat(32);
  await assert.rejects(h.drive.fileInvoice(input()), { code: 'drive_error' });
  assert.equal(h.google.created.filter(item => item.bytes).length, 1);
  const boundary = await h.drive.fileInvoice(input({ year: 9999 }));
  assert.equal(boundary.folderPath, 'Invoices/Example Studio/9999/Q3', 'Drive accepts the same four-digit year range as the invoice planner.');
});

test('bounded provider responses and redirected endpoints never expose credentials in errors', async () => {
  const redirected = response({ error: SECRET });
  Object.defineProperty(redirected, 'redirected', { value: true });
  for (const replacement of [response({ unexpected: SECRET.repeat(10000) }), redirected]) {
    const h = await setup({ connected: false });
    h.google.before = async url => url.href === 'https://oauth2.googleapis.com/token' ? replacement : undefined;
    await assert.rejects(h.authorize(), error => { assert.equal(error.code, 'drive_error'); assert.doesNotMatch(String(error), /PRIVATE_/); return true; });
    assert.equal(h.drive.status().connected, false);
  }
});

test('close aborts and waits for active work and cannot restore late tokens', async () => {
  const h = await setup({ connected: false }), blocked = gate(); let requestSignal;
  h.google.before = async (url, options) => { if (url.href === 'https://oauth2.googleapis.com/token') { requestSignal = options.signal; await blocked.promise; } };
  const connecting = h.authorize(); await nextTurn();
  let done = false; const closing = h.drive.close().then(() => { done = true; });
  assert.equal(requestSignal.aborted, true); await nextTurn(); assert.equal(done, false);
  blocked.resolve(); await assert.rejects(connecting, { code: 'drive_login_required' }); await closing;
  assert.equal(h.drive.status().connected, false);
  assert.throws(() => h.drive.start(OWNER), { code: 'busy' });
  await assert.rejects(h.drive.fileInvoice(input()), { code: 'busy' });
});


test('Drive starts with no assumed account and requires an explicitly selected address', async () => {
  const store = memoryStore(), google = fakeGoogle(store), drive = createDrive({ store, publicOrigin: ORIGIN, fetcher: google.fetcher });
  assert.equal(drive.status().expectedEmail, ''); assert.equal(drive.status().configured, false);
  await assert.rejects(drive.configure({ clientId: CLIENT, clientSecret: SECRET }), { code: 'invalid_request' });
  await assert.rejects(drive.configure({ clientId: CLIENT, clientSecret: SECRET, expectedEmail: 123 }), { code: 'invalid_request' });
  assert.equal(google.requests.length, 0);
  await drive.close();
});

test('changing the configured Drive account invalidates connection and another account allocations', async () => {
  const h = await setup(); await h.drive.fileInvoice(input());
  assert.ok(Object.keys(h.store.read().mailDrive.allocations).length > 0);
  const pending = new URL(h.drive.start(OWNER).url);
  await h.drive.configure({ clientId: CLIENT, expectedEmail: 'second@example.com' });
  assert.equal(h.drive.status().connected, false); assert.equal(h.drive.status().expectedEmail, 'second@example.com');
  assert.deepEqual(h.store.read().mailDrive.allocations, {});
  await assert.rejects(h.drive.finish(new URLSearchParams({ state: pending.searchParams.get('state'), code: 'fixture' }), OWNER), { code: 'unauthorized' });
  await assert.rejects(h.authorize(), { code: 'drive_wrong_account' });
  h.google.identity.email = 'second@example.com';
  assert.equal((await h.authorize()).email, 'second@example.com');
  await h.drive.close();
});
