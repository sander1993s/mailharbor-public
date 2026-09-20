import { TEST_ENTITIES } from './fixtures/invoice-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createInvoiceFiling } from '../server/invoice-filing.mjs';
import { createMailTags } from '../server/mail-tags.mjs';
import { invoiceDigest } from '../server/invoices.mjs';
import { MailHarborError } from '../server/validation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const account = { id: 'private', email: 'private@example.test', label: 'Private account', revision: 'one', auth: { password: 'PRIVATE_PASSWORD' } };
const reference = identity => ({ accountId: account.id, path: 'INBOX', uid: identity === 'second' ? 2 : 1, uidValidity: '123', fingerprint: hash(identity) });
const message = (identity = 'first', overrides = {}) => ({
  id: `private-browser-${identity}`, accountId: account.id, account: account.label, folderPath: 'INBOX', subject: 'Your invoice',
  author: 'Supplier <supplier@example.test>', to: 'Customer <private@example.test>', date: '2026-09-13T09:00:00.000Z', unread: true, starred: false,
  reference: reference(identity), invoiceDocuments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf' }], ...overrides
});
const document = (identity = 'first') => ({ filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: Buffer.from(`%PDF-1.7\nPRIVATE_ORIGINAL_${identity}\n%%EOF`) });
const facts = (values = {}) => ({ documentType: 'invoice', invoiceNumber: 'INV-001', invoiceDate: '2026-03-31', customer: { name: 'Customer', vat: 'BE0000000000' }, total: 121, ...values });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function memoryStore() {
  let data = { invoiceFiling: { schema: 1, settings: { enabled: false, entities: TEST_ENTITIES }, records: {}, sources: {}, lastRun: null }, schema: 1, accounts: [structuredClone(account)], providers: { google: { clientSecret: 'PRIVATE_PROVIDER' } } }, pending = Promise.resolve();
  return {
    read: () => structuredClone(data), update(change) {
      const next = pending.then(async () => { const copy = structuredClone(data); const result = await change(copy); data = copy; return result; });
      pending = next.catch(() => {}); return next;
    }
  };
}
function memoryIndex() {
  const documents = new Map(), writes = [];
  const id = (kind, key) => `${kind}:${key}`;
  return {
    writes,
    get: (kind, key) => structuredClone(documents.get(id(kind, key)) ?? null),
    put(kind, key, value) { writes.push({ kind, key }); documents.set(id(kind, key), structuredClone(value)); },
    remove(kind, key) { documents.delete(id(kind, key)); },
    list(kind, { after = '', limit = 100 } = {}) {
      return [...documents.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([key, value]) => ({ key: key.slice(kind.length + 1), value: structuredClone(value) })).filter(item => item.key > after).sort((a, b) => a.key.localeCompare(b.key)).slice(0, limit);
    },
    count: kind => [...documents.keys()].filter(key => key.startsWith(`${kind}:`)).length
  };
}
function fixture(t, overrides = {}) {
  const store = overrides.store || memoryStore();
  const calls = { lists: [], downloads: [], extracts: [], uploads: [], tags: [] };
  const accounts = {
    list: () => store.read().accounts.map(value => ({ ...value, connected: true })),
    get(id) { const found = store.read().accounts.find(value => value.id === id); if (!found) throw new MailHarborError('mailbox_login_required'); return found; }
  };
  const localTags = createMailTags({ store });
  const reader = { async list(values, options) {
    calls.lists.push({ accounts: values, ...options });
    const result = overrides.list ? await overrides.list(values, options, calls) : { messages: [message()], nextCursor: null, errors: [] };
    return { total: result.messages?.length || 0, totalComplete: !result.errors?.length, ...result };
  } };
  const attachments = { async read(value, ref, options) {
    calls.downloads.push({ account: value, reference: ref, ...options });
    return overrides.download ? overrides.download(value, ref, options, calls) : { documents: [document()], skipped: [] };
  } };
  const drive = { async fileInvoice(input, options) {
    calls.uploads.push({ ...input, bytes: Buffer.from(input.bytes), ...options });
    return overrides.upload ? overrides.upload(input, options, calls) : { fileId: `file-${calls.uploads.length}`, sha256: invoiceDigest(input.bytes), deduplicated: false };
  } };
  const tags = { ...localTags, async set(input) { calls.tags.push(input.tag); return localTags.set(input); } };
  const extract = async (input, options) => {
    calls.extracts.push({ ...input, bytes: Buffer.from(input.bytes), ...options });
    return overrides.extract ? overrides.extract(input, options, calls) : { text: '', facts: facts(), reason: null };
  };
  const engine = createInvoiceFiling({ store, accounts, reader, attachments, drive, tags, index: overrides.index, extract, now: () => Date.UTC(2026, 8, 13, 12) });
  t.after(() => engine.close());
  return { engine, calls, store, accounts, tags: localTags };
}
async function finished(engine) {
  for (let turn = 0; turn < 300; turn++) { if (!engine.status().running) return engine.status(); await nextTurn(); }
  throw new Error('Fixture filing job did not finish.');
}

test('manual filing returns an immediate job, uploads exact original bytes, and persists only safe metadata', async t => {
  const { engine, calls, store, tags } = fixture(t);
  assert.equal(engine.status().enabled, false); await nextTurn(); assert.equal(calls.lists.length, 0);
  const started = engine.start({ limit: 1000 });
  assert.equal(started.job.status, 'running'); assert.equal(engine.status().running, true);
  const status = await finished(engine);
  assert.equal(status.lastRun.status, 'completed'); assert.equal(status.lastRun.scanComplete, true);
  assert.equal(status.lastRun.scanned, 1); assert.equal(status.lastRun.filed, 1);
  assert.equal(status.counts.filed, 1); assert.equal(calls.uploads.length, 1);
  assert.deepEqual(calls.uploads[0].bytes, document().bytes);
  assert.equal(calls.uploads[0].entityLabel, 'Example Studio'); assert.equal(calls.uploads[0].year, 2026); assert.equal(calls.uploads[0].quarter, 1);
  assert.deepEqual(tags.tagsFor(account, reference('first')), ['invoices']);
  assert.equal(status.recent[0].file.webViewLink, 'https://drive.google.com/file/d/file-1/view');
  assert.equal(status.recent[0].file.folderPath, 'Invoices/Example Studio/2026/Q1');
  const serialized = JSON.stringify(store.read().invoiceFiling), publicStatus = JSON.stringify(status);
  for (const secret of ['PRIVATE_ORIGINAL', 'PRIVATE_PASSWORD', 'PRIVATE_PROVIDER', 'bytes']) assert.equal(serialized.includes(secret), false);
  for (const secret of [reference('first').fingerprint, 'uidValidity', 'reference', 'private-browser-', 'sha256', 'PRIVATE_ORIGINAL']) assert.equal(publicStatus.includes(secret), false);
  assert.deepEqual(store.read().accounts[0].auth, account.auth); assert.equal(store.read().providers.google.clientSecret, 'PRIVATE_PROVIDER');
});

test('stable source and SHA deduplication avoid repeat downloads and repeated uploads across messages', async t => {
  let selected = message();
  const { engine, calls } = fixture(t, { list: async () => ({ messages: [selected], errors: [], nextCursor: null }) });
  engine.start(); await finished(engine);
  engine.start(); let status = await finished(engine);
  assert.equal(calls.downloads.length, 1); assert.equal(calls.uploads.length, 1); assert.equal(status.lastRun.duplicates, 1);
  selected = message('second');
  engine.start(); status = await finished(engine);
  assert.equal(calls.downloads.length, 2); assert.equal(calls.extracts.length, 1); assert.equal(calls.uploads.length, 1);
  assert.equal(status.counts.filed, 1); assert.equal(status.counts.duplicates, 1); assert.equal(calls.tags.length, 2);
});

test('failed or partial pages retry the same cursor before any document processing', async t => {
  const events = [];
  const { engine, calls } = fixture(t, {
    async list(_, options, seen) {
      events.push('list');
      if (seen.lists.length === 1) return { messages: Array.from({ length: 100 }, (_, index) => message(`ordinary-${index}`, { subject: 'Ordinary update', invoiceDocuments: [] })), total: 101, nextCursor: { after: 'page-one' }, errors: [] };
      assert.deepEqual(options.cursor, { after: 'page-one' });
      if (seen.lists.length === 2) return { messages: [message('second')], total: 101, nextCursor: null, totalComplete: false, errors: [{ accountId: account.id, code: 'mailbox_timeout' }] };
      return { messages: [message('second')], total: 101, nextCursor: null, errors: [] };
    },
    async download() { events.push('download'); return { documents: [document()], skipped: [] }; }
  });
  engine.start({ limit: 101 }); const status = await finished(engine);
  assert.equal(status.lastRun.status, 'completed'); assert.equal(status.lastRun.scanned, 101); assert.equal(calls.lists.length, 3);
  assert.deepEqual(events.slice(0, 3), ['list', 'list', 'list']);
  assert.equal(calls.lists[0].folder, 'inbox'); assert.equal(calls.lists[0].includeAttachments, true);
});

test('persistent incomplete scans fail safely without tagging or filing the partial page', async t => {
  const { engine, calls } = fixture(t, { list: async () => ({ messages: [message()], errors: [{ accountId: account.id, code: 'PRIVATE_DIAGNOSTIC' }], nextCursor: { after: 'partial' } }) });
  engine.start(); const status = await finished(engine);
  assert.equal(calls.lists.length, 2); assert.equal(calls.downloads.length, 0); assert.equal(calls.tags.length, 0); assert.equal(calls.uploads.length, 0);
  assert.equal(status.lastRun.status, 'failed'); assert.equal(status.lastRun.scanComplete, false);
  assert.equal(JSON.stringify(status).includes('PRIVATE_DIAGNOSTIC'), false);
});

test('waiting Drive entries retry by downloading originals even when their source leaves the newest inbox scan', async t => {
  let visible = true, connected = false;
  const { engine, calls, store } = fixture(t, {
    list: async () => ({ messages: visible ? [message()] : [], errors: [], nextCursor: null }),
    upload: async input => {
      if (!connected) throw new MailHarborError('drive_login_required');
      return { fileId: 'retry-file', sha256: invoiceDigest(input.bytes), deduplicated: false };
    }
  });
  engine.start(); let status = await finished(engine);
  assert.equal(status.lastRun.status, 'completed'); assert.equal(status.counts.waitingDrive, 1);
  assert.deepEqual(status.recent[0].reasons, ['drive_login_required']);
  assert.equal(JSON.stringify(store.read().invoiceFiling).includes('PRIVATE_ORIGINAL'), false);
  visible = false; connected = true;
  engine.start(); status = await finished(engine);
  assert.equal(status.lastRun.scanned, 0); assert.equal(calls.downloads.length, 2); assert.equal(calls.uploads.length, 2);
  assert.equal(status.counts.waitingDrive, 0); assert.equal(status.counts.filed, 1);
  assert.deepEqual(calls.uploads[1].bytes, document().bytes);
});

test('recognized ambiguous invoices and portal-only candidates are tagged for review and never uploaded', async t => {
  const { engine, calls, tags } = fixture(t, {
    list: async () => ({ messages: [message(), message('second', { subject: 'Your invoice is available in the portal', invoiceDocuments: [] })], errors: [], nextCursor: null }),
    extract: async () => ({ text: '', facts: facts({ invoiceDate: '', customer: { name: 'Unknown customer', vat: '' } }), reason: null })
  });
  engine.start(); const status = await finished(engine);
  assert.equal(status.counts.needsReview, 2); assert.equal(calls.uploads.length, 0); assert.equal(calls.downloads.length, 1);
  assert.deepEqual(tags.tagsFor(account, reference('first')), ['invoices']); assert.deepEqual(tags.tagsFor(account, reference('second')), ['invoices']);
  assert.ok(status.recent.some(record => record.reasons.includes('document_missing')));
  assert.ok(status.recent.some(record => record.reasons.includes('missing_invoice_date') && record.reasons.includes('missing_customer_identity')));
});

test('proforma documents remain untagged and safe review records retain parse failures without bytes', async t => {
  const { engine, calls } = fixture(t, {
    list: async () => ({ messages: [message(), message('second')], errors: [], nextCursor: null }),
    download: async (_, ref) => ({ documents: [document(ref.uid === 2 ? 'second' : 'first')], skipped: [] }),
    extract: async input => Buffer.from(input.bytes).includes(Buffer.from('second')) ? { text: '', facts: {}, reason: 'document_needs_ocr' } : { text: 'Proforma invoice', facts: facts(), reason: null }
  });
  engine.start(); const status = await finished(engine);
  assert.equal(status.counts.notInvoices, 1); assert.equal(status.counts.needsReview, 1); assert.equal(calls.uploads.length, 0);
  assert.equal(calls.tags.length, 1); assert.ok(status.recent.some(record => record.reasons.includes('document_needs_ocr')));
});

test('start rejects overlap and close aborts and waits for late downloads without late tags, uploads, or ledger writes', async t => {
  const entered = gate(), release = gate();
  const { engine, calls, store } = fixture(t, { download: async (_, __, { signal }) => { entered.resolve(signal); await release.promise; return { documents: [document()], skipped: [] }; } });
  engine.start(); const signal = await entered.promise;
  assert.throws(() => engine.start(), error => error.code === 'busy');
  let closed = false;
  const completion = engine.close().then(() => { closed = true; });
  await nextTurn(); assert.equal(signal.aborted, true); assert.equal(closed, false);
  release.resolve(); await completion;
  assert.equal(calls.tags.length, 0); assert.equal(calls.uploads.length, 0); assert.equal(calls.extracts.length, 0);
  assert.deepEqual(store.read().invoiceFiling.records, {}); assert.equal(engine.status().lastRun.status, 'cancelled');
  assert.throws(() => engine.start(), error => error.code === 'busy');
});

test('an account revision change during parsing prevents all subsequent label, upload and ledger effects', async t => {
  const entered = gate(), release = gate();
  const { engine, calls, store } = fixture(t, { extract: async () => { entered.resolve(); await release.promise; return { text: '', facts: facts(), reason: null }; } });
  engine.start(); await entered.promise;
  await store.update(data => { data.accounts[0].revision = 'reconnected'; });
  release.resolve(); const status = await finished(engine);
  assert.equal(status.lastRun.status, 'failed'); assert.ok(status.lastRun.errors.some(error => error.code === 'stale_message'));
  assert.equal(calls.tags.length, 0); assert.equal(calls.uploads.length, 0); assert.deepEqual(store.read().invoiceFiling.records, {});
});

test('enabled scheduling runs every twenty minutes and cannot overlap a running manual scan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = gate(), release = gate();
  const { engine, calls } = fixture(t, { list: async () => { entered.resolve(); await release.promise; return { messages: [], errors: [], nextCursor: null }; } });
  await engine.configure({ enabled: true }); assert.equal(engine.status().intervalMinutes, 20);
  engine.start(); await entered.promise;
  t.mock.timers.tick(10 * 60 * 1000); await nextTurn(); assert.equal(calls.lists.length, 1);
  release.resolve(); await finished(engine);
  t.mock.timers.tick(20 * 60 * 1000); await nextTurn(); await finished(engine); assert.equal(calls.lists.length, 2);
  await engine.configure({ enabled: false });
  t.mock.timers.tick(40 * 60 * 1000); await nextTurn(); assert.equal(calls.lists.length, 2);
});

test('a full ledger preserves unresolved entries and rejects an additional filing before upload', async t => {
  const store = memoryStore(), index = memoryIndex();
  await store.update(data => {
    data.invoiceFiling = { schema: 1, settings: { enabled: false, entities: TEST_ENTITIES }, records: {}, sources: {}, lastRun: null };
    for (let number = 0; number < 10000; number++) {
      const id = hash(`unresolved-${number}`);
      data.invoiceFiling.records[id] = { id, status: 'needs_review', accountId: account.id, account: account.label, subject: 'Retain this review', filename: '', reasons: ['document_missing'], updatedAt: '2026-01-01T00:00:00.000Z' };
    }
  });
  const before = store.read().invoiceFiling.records;
  const { engine, calls } = fixture(t, { store, index });
  engine.enqueue({ account, message: message(), reference: reference('first') });
  engine.start(); const status = await finished(engine);
  assert.equal(status.lastRun.status, 'failed'); assert.ok(status.lastRun.errors.some(error => error.code === 'invoice_limit'));
  assert.equal(calls.uploads.length, 0); assert.deepEqual(store.read().invoiceFiling.records, before);
  assert.equal(index.count('invoiceQueue'), 1, 'A full filing ledger must preserve pending all-history work.');
});

test('transient parsing failures are retried and successful downloads resolve obsolete missing-document reviews', async t => {
  const parseFixture = fixture(t, { extract: async (_, __, calls) => calls.extracts.length === 1 ? { reason: 'document_parse_timeout' } : { text: '', facts: facts() } });
  parseFixture.engine.start(); let status = await finished(parseFixture.engine);
  assert.equal(status.counts.needsReview, 1); assert.equal(parseFixture.calls.uploads.length, 0);
  parseFixture.engine.start(); status = await finished(parseFixture.engine);
  assert.equal(parseFixture.calls.extracts.length, 2); assert.equal(status.counts.needsReview, 0); assert.equal(status.counts.filed, 1);

  const downloadFixture = fixture(t, { download: async (_, __, ___, calls) => {
    if (calls.downloads.length === 1) throw new MailHarborError('mailbox_timeout');
    return { documents: [document()], skipped: [] };
  } });
  downloadFixture.engine.start(); status = await finished(downloadFixture.engine);
  assert.equal(status.counts.needsReview, 1); assert.ok(status.recent[0].reasons.includes('document_unavailable'));
  downloadFixture.engine.start(); status = await finished(downloadFixture.engine);
  assert.equal(status.counts.needsReview, 0); assert.equal(status.counts.filed, 1);
  assert.equal(Object.keys(downloadFixture.store.read().invoiceFiling.records).length, 1);
});

test('scan validation rejects incomplete totals, duplicate logical messages, and increasing message dates', async t => {
  for (const response of [
    { messages: [message()], total: undefined, totalComplete: true },
    { messages: [message()], total: 1, totalComplete: undefined },
    { messages: [message()], total: -1, totalComplete: true },
    { messages: [message()], total: 2, totalComplete: true },
    { messages: [message(), message()], total: 2, totalComplete: true },
    { messages: [message(), message('second', { date: '2026-10-01T00:00:00Z' })], total: 2, totalComplete: true }
  ]) {
    const { engine, calls } = fixture(t, { list: async () => ({ errors: [], nextCursor: null, ...response }) });
    engine.start(); const status = await finished(engine);
    assert.equal(status.lastRun.status, 'failed'); assert.equal(status.lastRun.scanComplete, false);
    assert.equal(calls.lists.length, 2); assert.equal(calls.uploads.length, 0); assert.equal(calls.downloads.length, 0);
  }
});

test('a fifteen-minute deadline aborts an unfinished operation and leaves no late document effects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = gate();
  const { engine, calls } = fixture(t, { download: async (_, __, { signal }) => {
    entered.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  engine.start(); await entered.promise;
  t.mock.timers.tick(15 * 60 * 1000); const status = await finished(engine);
  assert.equal(status.lastRun.status, 'failed'); assert.ok(status.lastRun.errors.some(error => error.code === 'invoice_timeout'));
  assert.equal(calls.uploads.length, 0); assert.equal(calls.tags.length, 0); assert.equal(status.counts.needsReview, 0);
});

test('Dutch compound invoice subjects without documents are retained as invoice review candidates', async t => {
  const { engine, calls } = fixture(t, { list: async () => ({ messages: [message('first', { subject: 'Uw voorschotfactuur staat klaar', invoiceDocuments: [] })], errors: [], nextCursor: null }) });
  engine.start(); const status = await finished(engine);
  assert.equal(status.counts.needsReview, 1); assert.equal(calls.tags.length, 1); assert.equal(calls.uploads.length, 0);
  assert.deepEqual(status.recent[0].reasons, ['document_missing']);
});

test('whole-mailbox invoice candidates are queued once without message bodies and survive a restart', async t => {
  const index = memoryIndex(), store = memoryStore(), list = async () => ({ messages: [], errors: [], nextCursor: null });
  const first = fixture(t, { index, store, list });
  const historical = message('historical', { subject: 'Purchase details', date: '2021-03-15T10:00:00Z', invoiceDocuments: undefined, body: 'PRIVATE_MESSAGE_BODY' });
  const ref = { ...historical.reference, path: 'Purchases/2021', uid: 456 };
  assert.deepEqual(first.engine.enqueue({ account, message: historical, reference: ref }), { queued: true, alreadyProcessed: false });
  first.engine.enqueue({ account, message: historical, reference: ref });
  assert.equal(index.count('invoiceQueue'), 1); assert.equal(index.writes.length, 1);
  assert.equal(first.engine.status().counts.queued, 1);
  const stored = JSON.stringify(index.list('invoiceQueue'));
  for (const secret of ['PRIVATE_MESSAGE_BODY', 'PRIVATE_PASSWORD', 'private-browser', 'invoiceDocuments']) assert.equal(stored.includes(secret), false);
  await first.engine.close();
  const second = fixture(t, { index, store, list });
  second.engine.start(); const status = await finished(second.engine);
  assert.equal(status.lastRun.scanned, 0); assert.equal(status.lastRun.filed, 1);
  assert.equal(second.calls.downloads.length, 1); assert.equal(second.calls.downloads[0].reference.path, 'Purchases/2021');
  assert.equal(second.calls.downloads[0].reference.uid, 456);
  assert.equal(index.count('invoiceQueue'), 0);
  assert.deepEqual(second.engine.enqueue({ account, message: historical, reference: ref }), { queued: false, alreadyProcessed: true });
  assert.equal(index.writes.length, 1, 'A complete invoice must not be requeued or rewritten on each retention pass.');
});

test('current Inbox references supersede queued locations without duplicate downloads', async t => {
  const index = memoryIndex();
  const { engine, calls } = fixture(t, { index });
  engine.enqueue({ account, message: message(), reference: { ...reference('first'), path: 'Old folder', uid: 999 } });
  engine.start(); const status = await finished(engine);
  assert.equal(status.counts.filed, 1); assert.equal(calls.downloads.length, 1); assert.equal(calls.uploads.length, 1);
  assert.equal(calls.downloads[0].reference.path, 'INBOX'); assert.equal(calls.downloads[0].reference.uid, 1);
  assert.equal(index.count('invoiceQueue'), 0);
});

test('queued invoice references require the connected account revision and can be refreshed after reconnection', async t => {
  const index = memoryIndex();
  const { engine, calls, store, accounts } = fixture(t, { index, list: async () => ({ messages: [], errors: [], nextCursor: null }) });
  engine.enqueue({ account, message: message(), reference: reference('first') });
  await store.update(data => { data.accounts[0].revision = 'new-revision'; });
  assert.throws(() => engine.enqueue({ account, message: message(), reference: reference('first') }), error => error.code === 'stale_message');
  engine.start(); await finished(engine);
  assert.equal(calls.downloads.length, 0); assert.equal(index.count('invoiceQueue'), 1);
  const refreshed = { ...reference('first'), path: 'Saved invoices', uid: 800 };
  engine.enqueue({ account: accounts.get(account.id), message: message(), reference: refreshed });
  engine.start(); const status = await finished(engine);
  assert.equal(status.counts.filed, 1); assert.equal(calls.downloads[0].reference.uid, 800); assert.equal(index.count('invoiceQueue'), 0);
});

test('queued invoices remain durable when the newest Inbox scan is incomplete', async t => {
  const index = memoryIndex();
  const { engine, calls, store } = fixture(t, { index, list: async () => ({ messages: [], total: 1, errors: [], nextCursor: null }) });
  engine.enqueue({ account, message: message(), reference: { ...reference('first'), path: 'Archive' } });
  engine.start(); const status = await finished(engine);
  assert.equal(status.lastRun.status, 'failed'); assert.equal(calls.downloads.length, 0); assert.equal(calls.uploads.length, 0);
  assert.equal(index.count('invoiceQueue'), 1); assert.equal(Object.keys(store.read().invoiceFiling.sources).length, 0);
});

test('queued missing-document reviews and transient failures hand off to the durable filing ledger', async t => {
  const index = memoryIndex();
  const { engine, calls } = fixture(t, { index, list: async () => ({ messages: [], errors: [], nextCursor: null }), download: async (_, __, ___, calls) => {
    if (calls.downloads.length === 1) throw new MailHarborError('mailbox_timeout');
    return { documents: [], skipped: [] };
  } });
  engine.enqueue({ account, message: message('first', { subject: 'Payment details', invoiceDocuments: [] }), reference: { ...reference('first'), path: 'Orders' } });
  engine.start(); let status = await finished(engine);
  assert.equal(status.counts.needsReview, 1); assert.equal(index.count('invoiceQueue'), 0);
  assert.deepEqual(status.recent[0].reasons, ['document_unavailable']);
  engine.start(); status = await finished(engine);
  assert.equal(calls.downloads.length, 2); assert.equal(status.counts.needsReview, 1);
  assert.deepEqual(status.recent[0].reasons, ['document_missing']);
  assert.equal(calls.tags.length, 2);
});

test('a newly queued location during filing is retained until its own durable handoff', async t => {
  const index = memoryIndex(), entered = gate(), release = gate();
  const { engine, calls } = fixture(t, { index, list: async () => ({ messages: [], errors: [], nextCursor: null }), upload: async input => {
    entered.resolve(); await release.promise;
    return { fileId: 'concurrent-file', sha256: invoiceDigest(input.bytes), deduplicated: false };
  } });
  engine.enqueue({ account, message: message(), reference: reference('first') });
  engine.start(); await entered.promise;
  engine.enqueue({ account, message: message(), reference: { ...reference('first'), path: 'Recently moved', uid: 77 } });
  release.resolve(); await finished(engine);
  assert.equal(index.count('invoiceQueue'), 1, 'The worker must not erase a newer queue entry while removing its old snapshot.');
  engine.start(); await finished(engine);
  assert.equal(index.count('invoiceQueue'), 0); assert.equal(calls.downloads.length, 1); assert.equal(calls.uploads.length, 1);
});

test('each scan processes a bounded queue batch and later scans resume the remaining candidates', async t => {
  const index = memoryIndex();
  const { engine, calls } = fixture(t, { index, list: async () => ({ messages: [], errors: [], nextCursor: null }) });
  for (let number = 1; number <= 3; number++) {
    const value = message(`historical-${number}`, { subject: 'Receipt details' });
    engine.enqueue({ account, message: value, reference: { ...value.reference, path: 'Receipts', uid: number } });
  }
  engine.start({ limit: 1 }); await finished(engine);
  assert.equal(calls.downloads.length, 1); assert.equal(index.count('invoiceQueue'), 2);
  engine.start({ limit: 1 }); await finished(engine);
  assert.equal(calls.downloads.length, 2); assert.equal(index.count('invoiceQueue'), 1);
  engine.start({ limit: 1 }); await finished(engine);
  assert.equal(calls.downloads.length, 3); assert.equal(index.count('invoiceQueue'), 0);
  assert.equal(calls.uploads.length, 1, 'Distinct mail sources containing one original must retain document-level deduplication.');
});


test('unconfigured invoice destinations hold uploads and configuration retries relevant reviews', async t => {
  const store = memoryStore(); await store.update(data => { delete data.invoiceFiling; });
  const { engine, calls } = fixture(t, { store });
  assert.deepEqual(engine.status().entities, []);
  engine.start(); await finished(engine); assert.equal(calls.uploads.length, 0); assert.equal(engine.status().counts.needsReview, 1);
  await engine.configure({ entities: [{ id: 'my_business', label: 'My Example Business', vat: 'BE0000000000' }] });
  engine.start(); await finished(engine); assert.equal(calls.uploads.length, 1); assert.equal(calls.uploads[0].entityLabel, 'My Example Business');
  assert.equal(engine.status().recent[0].entity, 'my_business');
  await assert.rejects(engine.configure({ entities: [{ id: '../unsafe', label: 'Example', vat: 'BE0000000000' }] }), { code: 'invalid_request' });
});
