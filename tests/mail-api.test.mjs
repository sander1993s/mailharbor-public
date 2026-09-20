import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailApi, MAIL_FOLDERS } from '../server/mail-api.mjs';
import { MailHarborError } from '../server/validation.mjs';
import { createMailTags } from '../server/mail-tags.mjs';

const item = (accountId = 'a') => ({ id: `${accountId}-message`, accountId, account: 'Fixture mailbox', folderPath: 'INBOX',
  subject: 'Fixture subject', author: 'Sender', to: 'Recipient', date: '2026-09-13T10:00:00Z', unread: true, starred: false,
  reference: { accountId, path: 'INBOX', uid: 1, uidValidity: '9', fingerprint: accountId.repeat(64) } });
function harness(overrides = {}) {
  let clock = 0;
  const saved = new Map(['a', 'b'].map(id => [id, { id, email: `${id}@example.test`, revision: 'v1', auth: { password: 'PRIVATE_PASSWORD' } }]));
  const accounts = { list: () => [...saved.values()].map(({ id }) => ({ id, connected: true, email: `${id}@example.test` })),
    get: id => { if (!saved.has(id)) throw new MailHarborError('mailbox_login_required'); return structuredClone(saved.get(id)); } };
  const calls = [];
  const reader = {
    async folders(current) { calls.push('folders'); return { folders: MAIL_FOLDERS.map(value => ({ ...value, accountIds: current.map(value => value.id) })), errors: [] }; },
    async list(current, settings) {
      calls.push(['list', current.map(value => value.id), structuredClone(settings.cursor)]);
      return { messages: current.map(value => item(value.id)), nextCursor: settings.cursor ? null : { private: 'PRIVATE_CURSOR', page: 2 }, errors: [] };
    },
    async read(account, reference) { calls.push(['read', account.id, reference]); return { ...item(account.id), body: 'Private body', truncated: false, bodyUnavailable: false }; },
    async apply(account, reference, action) { calls.push(['apply', account.id, reference, action]); return { applied: true }; },
    ...overrides
  };
  let mailTags, customMailLabels, pending = Promise.resolve();
  const store = { read: () => structuredClone({ accounts: [...saved.values()], mailTags, customMailLabels }), update(change) {
    const operation = pending.then(async () => { const data = this.read(); const result = await change(data); mailTags = data.mailTags; customMailLabels = data.customMailLabels; return result; });
    pending = operation.catch(() => {}); return operation;
  } };
  const tags = createMailTags({ store, now: () => clock });
  const createApi = () => createMailApi({ accounts, reader, tags, now: () => clock, retentionMs: 1000 });
  const api = createApi();
  return { api, saved, calls, tags, accounts, reader, createApi, tick: () => { clock += 1001; } };
}

test('mail references and pagination stay server-side; explicit read does not apply a mailbox change', async t => {
  const h = harness(); t.after(() => h.api.close());
  const first = await h.api.list({ folder: 'inbox' });
  assert.equal(first.messages.length, 2);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|reference|fingerprint|uidValidity/);
  const next = await h.api.list({ folder: 'inbox', cursor: first.nextCursor });
  assert.equal(next.nextCursor, null);
  assert.deepEqual(h.calls[1][2], { private: 'PRIVATE_CURSOR', page: 2 });
  const read = await h.api.read({ id: first.messages[0].id });
  assert.equal(read.message.body, 'Private body');
  assert.equal(read.message.unread, true);
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE_|reference/);
  assert.equal(h.calls.some(value => value[0] === 'apply'), false);
});

test('cursors cannot change account scope, query or folder, and revisions invalidate old references', async t => {
  const h = harness(); t.after(() => h.api.close());
  const first = await h.api.list({ folder: 'inbox', accountIds: ['a'], query: 'invoice' });
  for (const change of [{ folder: 'trash' }, { accountIds: ['b'] }, { query: 'jobs' }]) {
    await assert.rejects(h.api.list({ folder: 'inbox', accountIds: ['a'], query: 'invoice', cursor: first.nextCursor, ...change }), { code: 'stale_message' });
  }
  h.saved.get('a').revision = 'v2';
  await assert.rejects(h.api.read({ id: 'a-message' }), { code: 'stale_message' });
  await assert.rejects(h.api.apply({ id: 'a-message', action: 'mark_read' }), { code: 'stale_message' });
  await assert.rejects(h.api.list({ folder: 'inbox', accountIds: ['a'], query: 'invoice', cursor: first.nextCursor }), { code: 'stale_message' });
});

test('unknown actions, arbitrary references and invalid search inputs fail before provider access', async t => {
  const h = harness(); t.after(() => h.api.close());
  for (const input of [{ folder: '../../INBOX' }, { folder: 'inbox', query: 'x'.repeat(201) },
    { folder: 'inbox', query: 'x\r\n' }, { folder: 'inbox', accountIds: [] }, { folder: 'inbox', accountIds: ['a', 'a'] },
    { folder: 'inbox', cursor: '../anything' }, { folder: 'inbox', limit: 50000 }]) {
    await assert.rejects(h.api.list(input), { code: 'invalid_request' });
  }
  await assert.rejects(h.api.read({ id: 'unseen-message' }), { code: 'stale_message' });
  await assert.rejects(h.api.apply({ id: 'a-message', action: 'expunge' }), { code: 'invalid_request' });
  await assert.rejects(h.api.read({ id: 'a-message', reference: item().reference }), { code: 'invalid_request' });
  assert.deepEqual(h.calls, []);
});

test('empty account list is usable and unavailable folders still have clear entries', async t => {
  const h = harness(); t.after(() => h.api.close()); h.saved.clear();
  const folders = await h.api.folders();
  assert.equal(folders.folders.length, 21);
  assert.ok(folders.folders.every(value => value.accountIds.length === 0));
  assert.deepEqual(await h.api.list({ folder: 'inbox' }), { folder: 'inbox', messages: [], nextCursor: null, errors: [], total: 0, totalComplete: true });
  assert.deepEqual(h.calls, []);
});

test('partial account errors expose safe codes and preserve other messages', async t => {
  const h = harness({ async list() { return { messages: [item('a')], errors: [{ accountId: 'b', code: 'mailbox_login_required', message: 'PRIVATE_PROVIDER_ERROR' }] }; } });
  t.after(() => h.api.close());
  const value = await h.api.list({ folder: 'inbox' });
  assert.equal(value.messages.length, 1);
  assert.deepEqual(value.errors, [{ accountId: 'b', code: 'mailbox_login_required' }]);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_/);
});

test('explicit flag actions work and expired references and pages cannot be reused', async t => {
  const h = harness(); t.after(() => h.api.close());
  const first = await h.api.list({ folder: 'inbox' });
  for (const action of ['mark_read', 'mark_unread', 'star', 'unstar']) assert.deepEqual(await h.api.apply({ id: 'a-message', action }), { applied: true });
  assert.equal(h.calls.filter(value => value[0] === 'apply').length, 4);
  h.tick();
  await assert.rejects(h.api.read({ id: 'a-message' }), { code: 'stale_message' });
  await assert.rejects(h.api.list({ folder: 'inbox', cursor: first.nextCursor }), { code: 'stale_message' });
});

test('disconnect aborts pending work and rejects late data even if provider ignores abort', async t => {
  let release, signal;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ async list(current, options) { signal = options.signal; await gate; return { messages: [item('a')] }; } });
  t.after(() => h.api.close());
  const pending = h.api.list({ folder: 'inbox' });
  h.api.invalidateAccount('a');
  assert.equal(signal.aborted, true);
  release();
  await assert.rejects(pending, { code: 'stale_message' });
  await assert.rejects(h.api.read({ id: 'a-message' }), { code: 'stale_message' });
});

test('disconnect preserves the stale-message reason when the reader honors cancellation', async t => {
  const h = harness({
    async list(current, { signal }) {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new MailHarborError('cancelled')), { once: true });
      });
    }
  });
  t.after(() => h.api.close());
  const pending = h.api.list({ folder: 'inbox' });
  h.api.invalidateAccount('a');
  await assert.rejects(pending, { code: 'stale_message' });
  await assert.rejects(h.api.read({ id: 'a-message' }), { code: 'stale_message' });
});

test('simultaneous changes to the same message cannot race, and close cancels active reads', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ async apply() { await gate; return { applied: true }; } });
  await h.api.list({ folder: 'inbox' });
  const applying = h.api.apply({ id: 'a-message', action: 'star' });
  await assert.rejects(h.api.apply({ id: 'a-message', action: 'unstar' }), { code: 'busy' });
  const closing = h.api.close(); release();
  await assert.rejects(applying, { code: 'cancelled' });
  await closing;
});

test('shared labels survive API restart, filter across accounts, and never call provider writes', async t => {
  const h = harness(); t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });
  await h.api.setTag({ id: 'a-message', tag: 'coupons', enabled: true });
  await h.api.setTag({ id: 'b-message', tag: 'coupons', enabled: true });
  await h.api.setTag({ id: 'b-message', tag: 'jobs', enabled: true });
  await h.api.close();
  const restarted = h.createApi(); t.after(() => restarted.close());
  const coupons = await restarted.list({ folder: 'tag:coupons' });
  assert.equal(coupons.total, 2);
  assert.deepEqual(coupons.messages.map(message => message.accountId).sort(), ['a', 'b']);
  assert.doesNotMatch(JSON.stringify(coupons), /reference|fingerprint|uidValidity|PRIVATE_/);
  assert.equal((await restarted.list({ folder: 'tag:coupons', accountIds: ['a'] })).total, 1);
  assert.equal((await restarted.list({ folder: 'tag:jobs', query: 'missing' })).total, 0);
  const jobs = await restarted.list({ folder: 'tag:jobs' });
  assert.deepEqual(jobs.messages[0].tags, ['coupons', 'jobs']);
  await restarted.setTag({ id: jobs.messages[0].id, tag: 'jobs', enabled: false });
  assert.equal((await restarted.list({ folder: 'tag:jobs' })).total, 0);
  assert.equal((await restarted.list({ folder: 'tag:coupons' })).total, 2);
  const folders = await restarted.folders();
  assert.deepEqual(folders.folders.find(folder => folder.id === 'tag:coupons').counts, [{ accountId: 'a', total: 1 }, { accountId: 'b', total: 1 }]);
  assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'apply'), false);
});

test('label changes invalidate tag pagination instead of skipping or repeating saved messages', async t => {
  const h = harness(); t.after(() => h.api.close());
  for (let uid = 1; uid <= 52; uid++) {
    const message = item('a');
    message.reference = { ...message.reference, uid, fingerprint: uid.toString(16).padStart(64, '0') };
    await h.tags.set({ account: h.accounts.get('a'), message, reference: message.reference, tag: 'coupons', enabled: true });
  }
  const first = await h.api.list({ folder: 'tag:coupons' });
  assert.equal(first.messages.length, 50); assert.equal(first.total, 52);
  const second = await h.api.list({ folder: 'tag:coupons', cursor: first.nextCursor });
  assert.equal(second.messages.length, 2);
  assert.equal(new Set([...first.messages, ...second.messages].map(message => message.id)).size, 52);
  await h.api.setTag({ id: first.messages[0].id, tag: 'coupons', enabled: false });
  await assert.rejects(h.api.list({ folder: 'tag:coupons', cursor: first.nextCursor }), { code: 'stale_message' });
});

test('source and label-view aliases share the same mutation lock', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ async apply() { await gate; return { applied: true }; } });
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });
  await h.api.setTag({ id: 'a-message', tag: 'jobs', enabled: true });
  const alias = (await h.api.list({ folder: 'tag:jobs' })).messages[0].id;
  assert.notEqual(alias, 'a-message');
  const pending = h.api.apply({ id: 'a-message', action: 'star' });
  await assert.rejects(h.api.apply({ id: alias, action: 'unstar' }), { code: 'busy' });
  await assert.rejects(h.api.setTag({ id: alias, tag: 'jobs', enabled: false }), { code: 'busy' });
  release(); await pending;
  assert.equal((await h.api.list({ folder: 'tag:jobs' })).messages[0].starred, true);
});

test('shutdown waits for the tag metadata transaction after a provider flag action', async () => {
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const h = harness();
  await h.api.list({ folder: 'inbox' });
  const original = h.tags.observe;
  h.tags.observe = async (...args) => { reached(); await gate; return original(...args); };
  const action = h.api.apply({ id: 'a-message', action: 'star' });
  const rejected = assert.rejects(action, { code: 'cancelled' });
  await entered;
  let finished = false;
  const closing = h.api.close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release(); await rejected; await closing;
  assert.equal(finished, true);
});

test('delete clears every source and label alias and affected cursor while preserving the other account', async t => {
  const h = harness({ async list(current, settings) {
    return { messages: current.map(account => {
      const message = item(account.id), archive = settings.folder === 'archive';
      return { ...message, id: archive ? `${account.id}-archive` : message.id,
        reference: { ...message.reference, fingerprint: 'a'.repeat(64), path: archive ? 'Archive' : 'INBOX', uid: archive ? 90 : 1 } };
    }), nextCursor: settings.cursor ? null : { page: 2 }, errors: [] };
  } });
  t.after(() => h.api.close());
  const first = await h.api.list({ folder: 'inbox' });
  await h.api.setTag({ id: 'a-message', tag: 'jobs', enabled: true });
  await h.api.setTag({ id: 'b-message', tag: 'jobs', enabled: true });
  const labeled = await h.api.list({ folder: 'tag:jobs' });
  const alias = labeled.messages.find(message => message.accountId === 'a').id;
  await h.api.list({ folder: 'archive' });
  const unaffected = await h.api.list({ folder: 'inbox', accountIds: ['b'] });
  const version = h.tags.version();
  assert.deepEqual(await h.api.apply({ id: 'a-message', action: 'delete' }), { applied: true });
  assert.deepEqual(h.calls.find(call => call[0] === 'apply'), ['apply', 'a', item('a').reference, 'delete']);
  assert.equal(h.tags.version(), version + 1);
  for (const id of ['a-message', 'a-archive', alias]) {
    await assert.rejects(h.api.read({ id }), { code: 'stale_message' });
    await assert.rejects(h.api.apply({ id, action: 'delete' }), { code: 'stale_message' });
  }
  await assert.rejects(h.api.list({ folder: 'inbox', cursor: first.nextCursor }), { code: 'stale_message' });
  assert.equal((await h.api.list({ folder: 'inbox', accountIds: ['b'], cursor: unaffected.nextCursor })).messages.length, 1);
  const jobs = await h.api.list({ folder: 'tag:jobs' });
  assert.deepEqual(jobs.messages.map(message => message.accountId), ['b']);
  assert.deepEqual((await h.api.folders()).folders.find(folder => folder.id === 'tag:jobs').counts,
    [{ accountId: 'a', total: 0 }, { accountId: 'b', total: 1 }]);
});

test('failed or unconfirmed deletion retains labels, readable references and pagination', async t => {
  for (const mode of ['throws', 'unconfirmed']) await t.test(mode, async t => {
    const h = harness({ async apply() {
      if (mode === 'throws') throw new MailHarborError('mailbox_error');
      return { applied: false };
    } });
    t.after(() => h.api.close());
    const first = await h.api.list({ folder: 'inbox' });
    await h.api.setTag({ id: 'a-message', tag: 'jobs', enabled: true });
    const alias = (await h.api.list({ folder: 'tag:jobs' })).messages[0].id, version = h.tags.version();
    await assert.rejects(h.api.apply({ id: 'a-message', action: 'delete' }), { code: 'mailbox_error' });
    assert.equal(h.tags.version(), version);
    assert.deepEqual((await h.api.read({ id: alias })).message.tags, ['jobs']);
    assert.equal((await h.api.list({ folder: 'inbox', cursor: first.nextCursor })).messages.length, 2);
  });
});

test('successful deletion rejects late reads, lists and downloads without resurrecting aliases or labels', async t => {
  const h = harness(); t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });
  await h.api.setTag({ id: 'a-message', tag: 'jobs', enabled: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.reader.read = async () => { await gate; return { ...item('a'), body: 'Late body' }; };
  h.reader.list = async () => { await gate; return { messages: [item('a')], nextCursor: { page: 2 } }; };
  h.reader.attachment = async () => { await gate; return { filename: 'late.pdf', mimeType: 'application/pdf', bytes: Buffer.from('Late attachment') }; };
  const pending = [h.api.read({ id: 'a-message' }), h.api.list({ folder: 'inbox' }),
    h.api.attachment({ id: 'a-message', attachmentId: '2' })].map(operation => assert.rejects(operation, { code: 'stale_message' }));
  assert.deepEqual(await h.api.apply({ id: 'a-message', action: 'delete' }), { applied: true });
  release(); await Promise.all(pending);
  assert.equal((await h.api.list({ folder: 'tag:jobs' })).total, 0);
  await assert.rejects(h.api.read({ id: 'a-message' }), { code: 'stale_message' });
  await assert.rejects(h.api.attachment({ id: 'a-message', attachmentId: '2' }), { code: 'stale_message' });
});

test('a label refresh during deletion cleanup cannot leave a newly registered stale alias', async t => {
  const h = harness(); t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });
  await h.api.setTag({ id: 'a-message', tag: 'jobs', enabled: true });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  const forget = h.tags.forget;
  h.tags.forget = async (...args) => { entered(); await gate; return forget(...args); };
  const deleting = h.api.apply({ id: 'a-message', action: 'delete' });
  await reached;
  let aliases = [];
  try { aliases = (await h.api.list({ folder: 'tag:jobs' })).messages.map(message => message.id); }
  catch (error) { assert.ok(['stale_message', 'busy'].includes(error.code)); }
  finally { release(); }
  await deleting;
  assert.equal((await h.api.list({ folder: 'tag:jobs' })).total, 0);
  for (const id of aliases) await assert.rejects(h.api.read({ id }), { code: 'stale_message' });
});

test('attachment metadata is whitelisted and bytes are fetched only through the verified download API', async t => {
  const bytes = Buffer.from('PRIVATE_ATTACHMENT_BYTES'), details = { id: '2.1', filename: 'Invoice.pdf', mimeType: 'application/pdf', size: bytes.length };
  const h = harness({
    async list() { return { messages: [{ ...item('a'), body: 'PRIVATE_LIST_BODY', attachments: [{ ...details, bytes }] }] }; },
    async read() { return { ...item('a'), body: 'Visible text', bodyUnavailable: false,
      attachments: [{ ...details, bytes, reference: item('a').reference, providerSecret: 'PRIVATE_ATTACHMENT_SECRET' }] }; },
    async attachment(account, reference, attachmentId, { signal }) {
      assert.equal(account.id, 'a'); assert.deepEqual(reference, item('a').reference);
      assert.equal(attachmentId, details.id); assert.equal(signal.aborted, false);
      return { filename: details.filename, mimeType: details.mimeType, bytes };
    }
  });
  t.after(() => h.api.close());
  const listing = await h.api.list({ folder: 'inbox' });
  assert.deepEqual(listing.messages[0].attachments, [details]);
  assert.doesNotMatch(JSON.stringify(listing), /PRIVATE_|"bytes"|"body"/);
  const read = await h.api.read({ id: 'a-message' });
  assert.deepEqual(read.message.attachments, [details]);
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE_|"bytes"|reference|providerSecret/);
  const download = await h.api.attachment({ id: 'a-message', attachmentId: details.id });
  assert.deepEqual(download, { filename: details.filename, mimeType: details.mimeType, bytes });
  assert.equal(h.calls.some(call => call[0] === 'apply'), false);
});

test('attachment requests reject arbitrary parts, references, expired messages and changed account revisions', async t => {
  let downloads = 0;
  const h = harness({ async attachment() { downloads++; return { filename: 'file.txt', bytes: Buffer.from('safe') }; } });
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });
  for (const attachmentId of ['', '../2', '2.HEADER', '2\r\n', '2\n', '2..1', '0', '01', '1.0', 2, '1'.repeat(201), Array(21).fill('1').join('.')]) {
    await assert.rejects(h.api.attachment({ id: 'a-message', attachmentId }), { code: 'invalid_request' }, `Invalid part ${JSON.stringify(attachmentId)}`);
  }
  await assert.rejects(h.api.attachment({ id: 'a-message', attachmentId: '2', reference: item().reference }), { code: 'invalid_request' });
  await assert.rejects(h.api.attachment({ id: 'unknown-message', attachmentId: '2' }), { code: 'stale_message' });
  h.saved.get('a').revision = 'v2';
  await assert.rejects(h.api.attachment({ id: 'a-message', attachmentId: '2' }), { code: 'stale_message' });
  h.tick();
  await assert.rejects(h.api.attachment({ id: 'b-message', attachmentId: '2' }), { code: 'stale_message' });
  assert.equal(downloads, 0);
});

test('attachment bytes cannot escape after the account changes during a provider download', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ async attachment() { await gate; return { filename: 'file.txt', bytes: Buffer.from('private') }; } });
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });
  const pending = assert.rejects(h.api.attachment({ id: 'a-message', attachmentId: '2' }), { code: 'stale_message' });
  h.saved.get('a').revision = 'v2';
  release(); await pending;
});

test('malformed attachment download results report unavailable instead of returning invalid bytes', async t => {
  const h = harness(); t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });
  for (const result of [null, { filename: 'file.txt', bytes: 'not a buffer' }, { bytes: Buffer.from('missing filename') }]) {
    h.reader.attachment = async () => result;
    await assert.rejects(h.api.attachment({ id: 'a-message', attachmentId: '2' }), { code: 'attachment_unavailable' });
  }
});

test('advanced search options bind cursors and malformed filters fail before provider access', async t => {
  const h = harness(); t.after(() => h.api.close());
  const first = await h.api.list({ folder: 'all', filters: { unread: true, since: '2026-09-01' }, sort: 'subject_asc', bodySearch: true });
  for (const change of [{ filters: { unread: false, since: '2026-09-01' } }, { sort: 'date_asc' }, { bodySearch: false }]) {
    await assert.rejects(h.api.list({ folder: 'all', filters: { unread: true, since: '2026-09-01' }, sort: 'subject_asc', bodySearch: true, cursor: first.nextCursor, ...change }), { code: 'stale_message' });
  }
  const count = h.calls.length;
  for (const filters of [{ unread: 'yes' }, { before: '2026-02-30' }, { minSize: -1 }, { minSize: 2, maxSize: 1 }, { body: '\n' }]) {
    await assert.rejects(h.api.list({ folder: 'inbox', filters }), { code: 'invalid_request' });
  }
  assert.equal(h.calls.length, count);
});

test('advanced label search matches only saved fingerprints through provider search and keeps opaque pagination', async t => {
  const h = harness(); t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });
  for (const id of ['a-message', 'b-message']) await h.api.setTag({ id, tag: 'jobs', enabled: true });
  const requests = [];
  h.reader.list = async (_current, options) => {
    requests.push(options); assert.equal(options.folder, 'all'); assert.equal(options.bodySearch, true);
    assert.deepEqual(options.scopedReferences.map(reference => reference.fingerprint).sort(), ['a'.repeat(64), 'b'.repeat(64)]);
    const message = item(options.cursor ? 'b' : 'a');
    if (!options.cursor) { message.reference.path = 'Archive'; message.reference.uid = 55; message.folderPath = 'Archive'; }
    return { messages: [message], total: 2, totalComplete: true, errors: [], nextCursor: options.cursor ? null : { provider: 'PRIVATE_TAG_SEARCH_CURSOR' } };
  };
  const first = await h.api.list({ folder: 'tag:jobs', query: 'contract', filters: { unread: true }, bodySearch: true });
  assert.equal(first.messages.length, 1); assert.match(first.messages[0].id, /^tag-/u); assert.equal(first.total, 2);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|fingerprint|reference|uidValidity/);
  assert.equal(h.tags.entries([h.accounts.get('a')], { tag: 'jobs' })[0].reference.path, 'Archive');
  const next = await h.api.list({ folder: 'tag:jobs', query: 'contract', filters: { unread: true }, bodySearch: true, cursor: first.nextCursor });
  assert.equal(next.messages[0].accountId, 'b'); assert.equal(next.nextCursor, null);
  assert.deepEqual(requests[1].cursor, { provider: 'PRIVATE_TAG_SEARCH_CURSOR' });
});

test('label changes during an advanced provider query invalidate the late result', async t => {
  const h = harness(); t.after(() => h.api.close()); await h.api.list({ folder: 'inbox' });
  await h.api.setTag({ id: 'a-message', tag: 'jobs', enabled: true });
  let release;
  h.reader.list = async () => new Promise(resolve => { release = resolve; });
  const pending = assert.rejects(h.api.list({ folder: 'tag:jobs', filters: { unread: true } }), { code: 'stale_message' });
  await h.api.setTag({ id: 'a-message', tag: 'jobs', enabled: false });
  release({ messages: [item()], total: 1, totalComplete: true, errors: [] }); await pending;
});

test('bulk actions require explicit permanent-delete confirmation, process serially, and sanitize partial failures', async t => {
  const h = harness(); t.after(() => h.api.close()); await h.api.list({ folder: 'inbox' });
  let active = 0;
  h.reader.apply = async (account, _reference, action) => {
    assert.equal(active++, 0); await new Promise(resolve => setImmediate(resolve)); active--;
    if (account.id === 'b') throw new Error('PRIVATE_PROVIDER_ERROR');
    return { applied: true };
  };
  await assert.rejects(h.api.bulk({ ids: ['a-message', 'b-message'], action: 'delete_permanent' }), { code: 'invalid_request' });
  await assert.rejects(h.api.bulk({ ids: ['a-message', 'a-message'], action: 'star' }), { code: 'invalid_request' });
  const result = await h.api.bulk({ ids: ['a-message', 'b-message'], action: 'star' });
  assert.deepEqual(result.applied, ['a-message']); assert.equal(result.failed[0].id, 'b-message');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('provider-confirmed moves yield expiring single-use undo that restores local tags and hides references', async t => {
  const h = harness(); t.after(() => h.api.close()); await h.api.list({ folder: 'inbox' });
  await h.api.setTag({ id: 'a-message', tag: 'jobs', enabled: true });
  const destinationId = `folder:${'d'.repeat(64)}`;
  h.reader.apply = async (_account, reference, action, options) => {
    if (action === 'delete') {
      const moved = { ...reference, path: 'Trash', uid: 33 };
      return { applied: true, reference: moved, undo: { reference: moved, destinationId } };
    }
    assert.equal(action, 'move'); assert.equal(options.destinationId, destinationId);
    return { applied: true, reference: { ...reference, path: 'INBOX', uid: 44 } };
  };
  const deleted = await h.api.apply({ id: 'a-message', action: 'delete' });
  assert.match(deleted.undoToken, /^[A-Za-z0-9_-]{32}$/u); assert.doesNotMatch(JSON.stringify(deleted), /fingerprint|reference|Trash/);
  assert.deepEqual(h.tags.tagsFor(h.accounts.get('a'), item().reference), []);
  assert.deepEqual(await h.api.undo({ token: deleted.undoToken }), { applied: true });
  assert.deepEqual(h.tags.tagsFor(h.accounts.get('a'), item().reference), ['jobs']);
  assert.equal(h.tags.entries([h.accounts.get('a')], { tag: 'jobs' })[0].reference.uid, 44);
  await assert.rejects(h.api.undo({ token: deleted.undoToken }), { code: 'stale_message' });
});

test('folder management and confirmed empty-trash invalidate account aliases while label definitions refresh', async t => {
  const h = harness({ async manageFolder(_account, request) { return { applied: true, folder: { id: `folder:${'c'.repeat(64)}`, label: request.name } }; },
    async emptyTrash() { return { deleted: 2, remaining: 0, partial: false, errors: [] }; } });
  t.after(() => h.api.close()); await h.api.list({ folder: 'inbox' });
  await assert.rejects(h.api.emptyTrash({ accountId: 'a' }), { code: 'invalid_request' });
  await h.api.manageFolder({ accountId: 'a', action: 'create', name: 'Receipts' });
  await assert.rejects(h.api.read({ id: 'a-message' }), { code: 'stale_message' });
  assert.equal((await h.api.read({ id: 'b-message' })).message.accountId, 'b');
  await h.api.list({ folder: 'inbox' }); await h.api.emptyTrash({ accountId: 'a', confirm: true });
  await assert.rejects(h.api.read({ id: 'a-message' }), { code: 'stale_message' });
  const label = (await h.api.manageLabel({ action: 'create', label: 'Receipts' })).label;
  assert.ok((await h.api.folders()).folders.some(folder => folder.id === `tag:${label.id}`));
  await h.api.manageLabel({ action: 'delete', id: label.id });
  await assert.rejects(h.api.list({ folder: `tag:${label.id}` }), { code: 'invalid_request' });
});

test('empty-trash public results strip provider UIDs, private diagnostics and unknown fields', async t => {
  const h = harness({ async emptyTrash() { return { deleted: 1, remaining: 2, partial: true, raw: 'PRIVATE_RAW',
    errors: [{ uid: 12345, code: 'stale_message', reference: item().reference, message: 'PRIVATE_PROVIDER' }] }; } });
  t.after(() => h.api.close());
  const result = await h.api.emptyTrash({ accountId: 'a', confirm: true });
  assert.deepEqual(result, { deleted: 1, remaining: 2, partial: true, errors: [{ code: 'stale_message' }] });
  assert.doesNotMatch(JSON.stringify(result), /12345|uid|reference|PRIVATE/);
});

test('withMessage cancels disconnected reads, rejects late deletion results and isolates mutable references', async t => {
  const h = harness(); t.after(() => h.api.close()); await h.api.list({ folder: 'inbox' });
  await h.api.withMessage({ id: 'a-message' }, async (_account, reference) => { reference.uid = 1234; });
  assert.equal(h.api.resolve('a-message').reference.uid, 1);
  let release, captured;
  const pending = assert.rejects(h.api.withMessage({ id: 'a-message' }, async (_account, _reference, signal) => {
    captured = signal; return new Promise(resolve => { release = resolve; });
  }), { code: 'stale_message' });
  h.api.invalidateAccount('a'); assert.equal(captured.aborted, true); release('PRIVATE_LATE'); await pending;
  await h.api.list({ folder: 'inbox' });
  const late = assert.rejects(h.api.withMessage({ id: 'a-message' }, async () => new Promise(resolve => { release = resolve; })), { code: 'stale_message' });
  await h.api.apply({ id: 'a-message', action: 'delete' }); release('PRIVATE_LATE'); await late;
});

test('mail account selection supports more than the old four predefined accounts', async t => {
  const h = harness(); t.after(() => h.api.close());
  for (const id of ['c', 'd', 'e', 'f']) h.saved.set(id, { id, email: `${id}@example.test`, label: id, revision: 'v1', auth: { password: 'TEST_PASSWORD' } });
  const accountIds = [...h.saved.keys()];
  const result = await h.api.list({ folder: 'inbox', accountIds });
  assert.equal(result.messages.length, 6);
  assert.deepEqual(h.calls.at(-1)[1], accountIds);
  await assert.rejects(h.api.list({ folder: 'inbox', accountIds: Array.from({ length: 101 }, (_, i) => `account-${i}`) }), { code: 'invalid_request' });
});
