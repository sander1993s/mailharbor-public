import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createMailProcessing } from '../server/mail-processing.mjs';
import { createMailLabelSync } from '../server/mail-label-sync.mjs';
import { createMailboxSession } from '../server/mailboxes.mjs';
import { MailHarborError } from '../server/validation.mjs';
import { CLASSIFIER_VERSION, SCHEMA_VERSION, PROMPT_VERSION } from '../server/mail-classifier.mjs';
import { CONTENT_EXTRACTION_VERSION } from '../server/body.mjs';
import { POLICY_VERSION } from '../server/mail-policy.mjs';
import { PROCESSING_VERSION } from '../server/mail-processing-state.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const account = { id: 'private', email: 'private@example.test', label: 'Private', revision: 'one', connected: true };
const stamp = Date.parse('2026-09-13T12:00:00Z');
const classification = (id, labels = ['jobs'], extra = {}) => ({ id, labels, confidence: 0.99, junk: 'legitimate', junkConfidence: 0.99,
  dates: { couponExpiry: null, tenderDeadline: null, appointmentStart: null, appointmentEnd: null }, dateConfidence: 0.99, appointment: null, ...extra });
const mail = (uid = 1, extra = {}) => {
  const path = extra.folderPath ?? 'INBOX';
  return { accountId: account.id, account: account.label, folderPath: path, subject: 'Example job alert', author: 'sender@example.test',
    to: account.email, role: 'inbox', date: '2026-01-01T12:00:00Z', receivedAt: '2026-01-01T12:00:00Z', unread: true, starred: false,
    reference: { accountId: account.id, path, uid, uidValidity: '100', fingerprint: hash(`message-${uid}`) }, ...extra };
};
const keyOf = message => hash([account.id, account.email, message.reference.fingerprint]);

function memoryIndex() {
  let values = new Map();
  const key = (kind, id) => `${kind}:${id}`;
  return {
    token: hash,
    get(kind, id) { return copy(values.get(key(kind, id))?.value ?? null); },
    put(kind, id, value, { state = '', due = null, owner = '', category = '', analysis = '', age = null, reasons = [] } = {}) {
      values.set(key(kind, id), { kind, key: id, value: copy(value), state, due, owner, category, analysis, age, reasons: copy(reasons) });
    },
    remove(kind, id) { values.delete(key(kind, id)); },
    list(kind, { state, before, after = '', limit = 100, owner, category, order = 'key' } = {}) {
      return [...values.values()].filter(row => row.kind === kind && row.key > after && (state === undefined || row.state === state) &&
        (owner === undefined || row.owner === owner) && (category === undefined || row.category === category) &&
        (before === undefined || (row.due !== null && row.due <= before))).sort((a, b) =>
          (order === 'due' ? (a.due ?? -Infinity) - (b.due ?? -Infinity) || (a.age ?? -Infinity) - (b.age ?? -Infinity) :
            order === 'newest' ? (b.age ?? -Infinity) - (a.age ?? -Infinity) || (a.due ?? -Infinity) - (b.due ?? -Infinity) : 0) || a.key.localeCompare(b.key))
        .slice(0, limit).map(row => ({ key: row.key, value: copy(row.value) }));
    },
    count(kind, state) { return [...values.values()].filter(row => row.kind === kind && (state === undefined || row.state === state)).length; },
    transaction(work) { const before = copy(values); try { return work(); } catch (error) { values = before; throw error; } }
  };
}
function seed(index, message, result, { nextAt = stamp, role = message.role, complete = true } = {}) {
  const key = keyOf(message);
  index.put('messages', key, { key, accountId: account.id, email: account.email, message, reference: message.reference,
    receivedAt: message.receivedAt, locations: [{ reference: message.reference, role, read: !message.unread, handled: null }],
    classification: result === null ? null : { ...result, id: key }, complete, nextAt, review: false }, { state: result === null ? 'pending' : 'ready', due: nextAt });
  return key;
}
function harness(t, { index = memoryIndex(), messages = [mail()], folders, classify: classifier, move, readError = false,
  enqueueInvoice, store = { read: () => ({}) }, readerOverrides = {}, tagsOverrides = {}, autoSchedule = false,
  accountStore = { list: () => [copy(account)], get: () => copy(account) } } = {}) {
  let current = stamp;
  const data = copy(messages);
  const metrics = { scans: [], model: [], reads: [], marked: [], markBatches: [], moves: [], tags: [] };
  const available = folders ?? [...new Map(data.map(message => [message.folderPath, { path: message.folderPath, role: message.role }])).values()];
  const reader = {
    async folders() { return { folders: copy(available) }; },
    async scan(_, options) {
      metrics.scans.push(copy({ path: options.path, afterUid: options.afterUid ?? 0 }));
      const all = data.filter(message => message.reference.path === options.path), after = options.afterUid ?? 0;
      const found = all.filter(message => message.reference.uid > after).sort((a, b) => a.reference.uid - b.reference.uid).slice(0, options.limit ?? 100);
      return { messages: copy(found), afterUid: found.at(-1)?.reference.uid ?? after, uidValidity: '100', done: !all.some(message => message.reference.uid > (found.at(-1)?.reference.uid ?? after)) };
    },
    async markRead(_, references) {
      metrics.markBatches.push(copy(references));
      metrics.marked.push(...copy(references));
      return { results: references.map(reference => ({ reference, status: 'applied' })) };
    },
    async readBatch(_, references) {
      metrics.reads.push(...copy(references));
      if (readError) return { messages: [], errors: references.map(reference => ({ reference, code: 'stale_message' })) };
      return { messages: references.map(reference => ({ ...copy(data.find(message => message.reference.fingerprint === reference.fingerprint) ?? mail(reference.uid)),
        reference: copy(reference), body: 'A complete job notification body.', truncated: false, bodyUnavailable: false })), errors: [] };
    },
    async move(_, reference, action) {
      metrics.moves.push({ reference: copy(reference), action });
      if (move) return move(reference, action, metrics.moves.length);
      return { status: 'applied', reference: { ...reference, path: action === 'trash' ? 'Trash' : action === 'rescue' ? 'INBOX' : 'Archive', uid: reference.uid + 1000 } };
    }
  };
  Object.assign(reader, readerOverrides);
  const processing = createMailProcessing({ index, store, accounts: accountStore, reader,
    tags: { async automatic(value) { metrics.tags.push(copy({ labels: value.labels, reference: value.reference })); }, manualFor: () => [], async observe() {}, ...tagsOverrides },
    classify: async (request, signal) => { metrics.model.push(copy(request)); return classifier ? classifier(request, signal) : { items: request.messages.map(message => classification(message.id)) }; },
    enqueueInvoice, now: () => current, autoSchedule });
  t.after(() => processing.close());
  return { processing, index, metrics, time(value) { current = Date.parse(value); },
    async run(action = 'start') { await processing.configure({ providerConsent: true }); await processing.action(action); await processing.drain(); return processing.status(); } };
}

test('initial scan marks mail read, classifies once, applies labels, and moves due mail to Trash', async t => {
  const h = harness(t);
  const result = await h.run();
  assert.equal(result.lastRun.status, 'completed');
  assert.equal(h.metrics.marked.length, 1);
  assert.equal(h.metrics.model.length, 1);
  assert.deepEqual(h.metrics.tags[0].labels, ['jobs']);
  assert.deepEqual(h.metrics.moves.map(value => value.action), ['trash']);
  assert.equal(result.counts.analyzed, 1);
  assert.equal(result.counts.trashed, 1);
  const record = h.index.get('messages', keyOf(mail()));
  assert.equal(record.classification.labels[0], 'jobs');
  assert.equal(record.locations[0].read, true);
  assert.equal(record.locations[0].handled, 'trash');
  assert.ok(!JSON.stringify(record).includes('A complete job notification body.'));
});

test('error history is bounded and sanitized while each run separates new errors from the lifetime total', async t => {
  let failing = true;
  const h = harness(t, { messages: [], folders: Array.from({ length: 51 }, (_, i) => ({ path: `private-folder-${i}`, role: 'other' })),
    readerOverrides: { async scan() {
      if (failing) throw new MailHarborError('mailbox_error', 'sensitive-provider-response-and-token');
      return { messages: [], afterUid: 0, uidValidity: '100', highWatermark: 0, done: true };
    } } });
  const failed = await h.run();
  assert.equal(failed.lastRun.errorCount, 51);
  assert.equal(failed.counts.errors, 51);
  assert.equal(failed.recentErrors.length, 50);
  assert.ok(failed.recentErrors.every(error => error.code === 'mailbox_error' && error.phase === 'discovering' && error.accountId === account.id));
  assert.ok(!JSON.stringify(failed.recentErrors).includes('sensitive'));
  assert.ok(!JSON.stringify(failed.recentErrors).includes('private-folder'));
  failing = false;
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(h.processing.status().lastRun.errorCount, 0);
  assert.equal(h.processing.status().counts.errors, 51);
  await h.processing.close();
  const resumed = harness(t, { index: h.index, messages: [] });
  assert.deepEqual(resumed.processing.status().recentErrors, failed.recentErrors);
});

test('folder cursor and classification survive restart without reading, classifying or moving the same mail again', async t => {
  const first = harness(t);
  await first.run(); await first.processing.close();
  const resumed = harness(t, { index: first.index });
  const result = await resumed.run();
  assert.equal(result.lastRun.status, 'completed');
  assert.equal(resumed.metrics.scans[0].afterUid, 1);
  assert.equal(resumed.metrics.reads.length, 0);
  assert.equal(resumed.metrics.model.length, 0);
  assert.equal(resumed.metrics.moves.length, 0);
  assert.equal(result.counts.trashed, 1);
});

test('duplicate folder copies share one classification while their distinct locations are marked read', async t => {
  const first = mail(), second = mail(17, { folderPath: 'Copies', role: 'other', reference: { ...first.reference, path: 'Copies', uid: 17 } });
  const h = harness(t, { messages: [first, second] });
  await h.run();
  assert.equal(h.index.count('messages'), 1);
  assert.equal(h.metrics.model.flatMap(request => request.messages).length, 1);
  assert.equal(h.metrics.marked.length, 2);
  assert.equal(h.metrics.moves.length, 2);
});

test('future retention executes after its saved due time without another model request', async t => {
  const h = harness(t, { messages: [mail(1, { date: '2026-09-01T12:00:00Z', receivedAt: '2026-09-01T12:00:00Z' })] });
  const first = await h.run();
  assert.equal(first.counts.analyzed, 1);
  assert.equal(h.metrics.moves.length, 0);
  assert.equal(h.index.count('messages', 'ready'), 1);
  h.time('2026-10-01T12:00:00Z');
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(h.metrics.model.length, 1);
  assert.deepEqual(h.metrics.moves.map(value => value.action), ['trash']);
});

test('quota failure retains the pending message and read progress without labeling or moving it', async t => {
  const h = harness(t, { classify: () => { throw new MailHarborError('quota_exhausted'); } });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'failed');
  assert.equal(result.pauseReason, 'quota_exhausted');
  assert.equal(Date.parse(result.retryAt), stamp + 5 * 3600000);
  assert.equal(result.counts.pending, 1);
  assert.equal(h.metrics.marked.length, 1);
  assert.equal(h.metrics.tags.length, 0);
  assert.equal(h.metrics.moves.length, 0);
  assert.equal(h.index.get('messages', keyOf(mail())).classification, null);
});

test('interrupted MOVE keeps its durable intent and classification for safe replay', async t => {
  const first = harness(t, { move: () => { throw new MailHarborError('mailbox_error'); } });
  await first.run();
  const saved = first.index.get('messages', keyOf(mail()));
  assert.equal(saved.classification.labels[0], 'jobs');
  assert.equal(saved.locations[0].intent.action, 'trash');
  await first.processing.close();
  const resumed = harness(t, { index: first.index, move: () => ({ status: 'absent' }) });
  resumed.time('2026-09-13T12:15:00Z');
  await resumed.run();
  assert.equal(resumed.metrics.model.length, 0);
  assert.equal(resumed.metrics.moves.length, 1);
  assert.equal(resumed.index.get('messages', keyOf(mail())).locations[0].handled, 'absent');
});

test('preview discovers and classifies a useful bounded sample without changing read flags, folders, or labels', async t => {
  const h = harness(t);
  const result = await h.run('preview');
  assert.equal(result.lastRun.status, 'completed');
  assert.equal(result.counts.analyzed, 1);
  assert.equal(result.preview.counts.trash, 1);
  assert.equal(h.metrics.marked.length, 0);
  assert.equal(h.metrics.moves.length, 0);
  assert.equal(h.metrics.tags.length, 0);
});

test('preview counts an already classified location once and never mutates its labels', async t => {
  const index = memoryIndex(); seed(index, mail(), classification('placeholder'));
  const h = harness(t, { index, messages: [], folders: [] });
  const result = await h.run('preview');
  assert.equal(result.preview.counts.trash, 1);
  assert.equal(h.metrics.tags.length, 0);
  assert.equal(h.metrics.moves.length, 0);
});

test('classification uses smaller batches and saved preview results are not sent again', async t => {
  const h = harness(t, { messages: Array.from({ length: 26 }, (_, index) => mail(index + 1)) });
  const preview = await h.run('preview');
  assert.equal(preview.counts.analyzed, 12);
  assert.deepEqual(h.metrics.model.map(value => value.messages.length), [12]);
  await h.processing.action('start'); await h.processing.drain();
  assert.deepEqual(h.metrics.model.map(value => value.messages.length), [12, 12, 2]);
  assert.equal(new Set(h.metrics.model.flatMap(value => value.messages.map(message => message.id))).size, 26);
});

test('a provider timeout halves and persists the next classification batch without changing mail in preview', async t => {
  const h = harness(t, { messages: Array.from({ length: 26 }, (_, index) => mail(index + 1)), classify: () => { throw new MailHarborError('timeout'); } });
  const result = await h.run('preview');
  assert.equal(result.batchSize, 6); assert.equal(result.retryAt, null); assert.equal(result.enabled, false);
  assert.equal(result.counts.analyzed, 0); assert.equal(h.metrics.moves.length, 0); assert.equal(h.metrics.marked.length, 0);
  await h.processing.close();
  const restarted = harness(t, { index: h.index, messages: Array.from({ length: 26 }, (_, index) => mail(index + 1)) });
  await restarted.run('preview');
  assert.equal(restarted.metrics.model[0].messages.length, 6);
});

test('missing move destination remains retryable and succeeds after the mailbox target is fixed', async t => {
  let fixed = false;
  const h = harness(t, { move: reference => fixed ? { status: 'applied', reference: { ...reference, path: 'Trash', uid: 1001 } } : { status: 'target_unavailable' } });
  await h.run();
  assert.equal(h.processing.status().counts.technicalFailures, 1);
  fixed = true; h.time('2026-09-14T12:00:00Z');
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(h.metrics.model.length, 1);
  assert.equal(h.processing.status().counts.trashed, 1);
});

test('confirming a tender grace period reevaluates prior held mail without another classification', async t => {
  const h = harness(t, { classify: request => ({ items: request.messages.map(message => classification(message.id, ['tenders'], {
    dates: { ...classification('').dates, tenderDeadline: '2026-01-01' }
  })) }) });
  await h.run();
  assert.equal(h.processing.status().counts.automaticHolds, 1);
  await h.processing.configure({ tenderGraceMonths: 2 });
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(h.metrics.model.length, 1);
  assert.equal(h.processing.status().counts.archived, 1);
});

test('body read errors are reported as technical failures and are not counted as analyzed', async t => {
  const h = harness(t, { readError: true });
  const result = await h.run();
  assert.equal(result.counts.technicalFailures, 1); assert.equal(result.counts.needsReview, 0);
  assert.equal(result.counts.analyzed, 0);
  assert.equal(h.metrics.model.length, 0);
  assert.equal(h.metrics.moves.length, 0);
});

test('calendar action is hidden when category classification is uncertain even if dates are confident', async t => {
  const index = memoryIndex();
  seed(index, mail(), classification('placeholder', ['appointments'], { confidence: 0.2, dates: { ...classification('').dates,
    appointmentStart: '2026-09-14T10:00:00Z', appointmentEnd: '2026-09-14T11:00:00Z' }, appointment: { title: 'Maybe a meeting', location: '' } }));
  const h = harness(t, { index, messages: [], folders: [] });
  assert.equal(h.processing.appointment(account, mail().reference), null);
});

test('familiar sender display text cannot bypass the junk confidence threshold', async t => {
  const index = memoryIndex();
  index.put('correspondents', index.token(`correspondent:${account.id}:${account.email}:known@example.test`), { known: true });
  const incoming = mail(1, { role: 'junk', folderPath: 'Junk', author: 'Known known@example.test <attacker@example.test>' });
  const h = harness(t, { index, messages: [incoming],
    classify: request => ({ items: request.messages.map(message => classification(message.id, ['jobs'], { junkConfidence: 0.979 })) }) });
  await h.run();
  assert.equal(h.metrics.moves.length, 0);
  assert.equal(h.processing.status().counts.rescued, 0);
});

test('high-confidence legitimate first-time senders leave Junk and receive cached normal retention afterward', async t => {
  const incoming = mail(1, { role: 'junk', folderPath: 'Junk', author: 'first-time-recruiter@example.test' });
  const h = harness(t, { messages: [incoming] });
  await h.run();
  assert.deepEqual(h.metrics.moves.map(value => value.action), ['rescue']);
  assert.equal(h.processing.status().counts.rescued, 1);
  h.time('2026-09-13T12:15:00Z');
  await h.processing.action('start'); await h.processing.drain();
  assert.deepEqual(h.metrics.moves.map(value => value.action), ['rescue', 'trash']);
  assert.equal(h.metrics.model.length, 1);
  assert.equal(h.processing.status().counts.trashed, 1);
});

test('historical invoices queued for Drive filing keep their original mailbox reference until filing finishes', async t => {
  const index = memoryIndex();
  const incoming = mail(1, { date: '2018-01-01T12:00:00Z', receivedAt: '2018-01-01T12:00:00Z' });
  const h = harness(t, { index, messages: [incoming],
    classify: request => ({ items: request.messages.map(message => classification(message.id, ['invoices'])) }),
    enqueueInvoice: value => { index.put('invoiceQueue', keyOf(incoming), { reference: value.reference }); return { queued: true }; } });
  await h.run();
  assert.equal(h.metrics.moves.length, 0);
  assert.deepEqual(index.get('invoiceQueue', keyOf(incoming)).reference, incoming.reference);
  assert.equal(h.processing.status().counts.automaticHolds, 1); assert.equal(h.processing.status().reasonCounts.invoice_waiting, 1);
});

test('rescuing a legitimate invoice refreshes its durable filing reference after the MOVE', async t => {
  const index = memoryIndex(), incoming = mail(1, { folderPath: 'Junk', role: 'junk' });
  const h = harness(t, { index, messages: [incoming],
    classify: request => ({ items: request.messages.map(message => classification(message.id, ['invoices'])) }),
    enqueueInvoice: value => { index.put('invoiceQueue', keyOf(incoming), { reference: value.reference }); return { queued: true }; } });
  await h.run();
  assert.deepEqual(h.metrics.moves.map(value => value.action), ['rescue']);
  const reference = index.get('invoiceQueue', keyOf(incoming)).reference;
  assert.equal(reference.path, 'INBOX'); assert.equal(reference.uid, 1001);
});

test('a folder failure is reported as partial and is retried without claiming a complete scan', async t => {
  const h = harness(t, { readerOverrides: { async scan() { throw new MailHarborError('mailbox_timeout'); } } });
  const status = await h.run();
  assert.equal(status.lastRun.status, 'partial'); assert.equal(status.counts.analyzed, 0);
  assert.equal(status.counts.errors, 1); assert.equal(status.enabled, true);
});

test('connection-level mailbox diagnostics back off an account while generic operation errors do not', async t => {
  const reasons = ['timeout', 'connection_closed', 'connection_reset', 'connection_refused', 'dns_error', 'tls_error',
    'throttled', 'authentication_failed', 'server_rejected', 'protocol_error', 'unknown', undefined];
  for (const reason of reasons) await t.test(reason ?? 'generic', async t => {
    let attempts = 0;
    const h = harness(t, { messages: [], folders: [], readerOverrides: { async folders() {
      attempts++;
      const error = new MailHarborError('mailbox_error');
      if (reason) error.mailboxDiagnostic = { reason, command: 'AUTHENTICATE' };
      throw error;
    } } });
    const first = await h.run(), shouldBackoff = !['server_rejected', 'protocol_error', 'unknown', undefined].includes(reason);
    const saved = h.index.get('meta', 'processingSettings').accountBackoff?.[account.id];
    assert.equal(Boolean(saved), shouldBackoff);
    if (shouldBackoff) {
      assert.equal(saved.attempts, 1); assert.equal(saved.code, 'mailbox_error'); assert.equal(saved.revision, account.revision);
      assert.ok(saved.until >= stamp + 15 * 60000 && saved.until < stamp + 15 * 60000 + 30000);
      assert.equal(first.accounts[0].discoveryComplete, false);
    }
    await h.processing.action('start'); await h.processing.drain();
    assert.equal(attempts, shouldBackoff ? 1 : 2);
  });
});

test('wrapped Gmail AUTHENTICATE timeout survives restart as account cooldown while healthy mail keeps progressing', async t => {
  const index = memoryIndex(), healthy = { ...account, id: 'healthy', email: 'healthy@example.test', label: 'Healthy' };
  const allAccounts = [account, healthy], arrivals = [], diagnostics = [], modelIds = [], moves = [], processors = [];
  let current = stamp, connections = 0;
  const transport = createMailboxSession({ connectionOptions: async () => ({ auth: { user: 'fixture', pass: 'private-fixture' } }),
    createClient: () => new class extends EventEmitter {
      async connect() { connections++; await this.exec('AUTHENTICATE'); }
      async exec() { throw Object.assign(new Error('private authentication response'), { code: 'ETIMEDOUT' }); }
      close() {}
    }() });
  const addArrival = uid => {
    const message = mail(uid, { unread: false, accountId: healthy.id, account: healthy.label, to: healthy.email });
    message.reference.accountId = healthy.id; arrivals.push(message);
  };
  const reader = {
    async folders(value, { signal }) {
      if (value.id === account.id) {
        try { return await transport.session(value, signal, async () => ({ folders: [] })); }
        catch (error) { diagnostics.push({ code: error.code, diagnostic: error.mailboxDiagnostic }); throw error; }
      }
      return { folders: [{ path: 'INBOX', role: 'inbox' }] };
    },
    async scan(value, { afterUid = 0 }) {
      assert.equal(value.id, healthy.id);
      const found = arrivals.filter(message => message.reference.uid > afterUid);
      return { messages: copy(found), afterUid: found.at(-1)?.reference.uid ?? afterUid, uidValidity: '100', done: true };
    },
    async markRead() { assert.fail('All fixture mail is already read'); },
    async readBatch(value, references) {
      assert.equal(value.id, healthy.id);
      return { messages: references.map(reference => ({ ...copy(arrivals.find(message => message.reference.uid === reference.uid)),
        body: 'A complete job alert.', bodyUnavailable: false, truncated: false })), errors: [] };
    },
    async move(value, reference, action) {
      assert.equal(value.id, healthy.id); moves.push(reference.uid);
      return { status: 'applied', reference: { ...reference, path: 'Trash', uid: reference.uid + 1000 } };
    }
  };
  const create = () => {
    const processing = createMailProcessing({ index, reader, store: { read: () => ({}) },
      accounts: { list: () => copy(allAccounts), get: id => copy(allAccounts.find(value => value.id === id)) },
      tags: { manualFor: () => [], async automatic() {}, async observe() {} },
      classify: async request => { modelIds.push(...request.messages.map(message => message.id));
        return { items: request.messages.map(message => classification(message.id)) }; },
      now: () => current, autoSchedule: false });
    processors.push(processing); return processing;
  };
  t.after(async () => { for (const processor of processors) await processor.close(); });
  const run = async processor => { await processor.configure({ providerConsent: true }); await processor.action('start'); await processor.drain(); };
  addArrival(1);
  const first = create(); await run(first);
  assert.deepEqual(diagnostics, [{ code: 'mailbox_error', diagnostic: { command: 'AUTHENTICATE', reason: 'timeout', status: null, responseCode: null } }]);
  assert.equal(connections, 1); assert.deepEqual(moves, [1]); assert.equal(first.status().counts.analyzed, 1);
  const cooldown = index.get('meta', 'processingSettings').accountBackoff[account.id];
  assert.ok(cooldown.until >= stamp + 15 * 60000); assert.equal(cooldown.attempts, 1);
  assert.equal(first.status().recentErrors[0].mailboxDiagnostic.reason, 'timeout');
  assert.equal(JSON.stringify(first.status()).includes('private authentication response'), false);
  await first.close();
  current = cooldown.until - 1; addArrival(2);
  const restarted = create(); await run(restarted);
  assert.equal(connections, 1, 'Restart cannot bypass the saved connection cooldown');
  assert.deepEqual(moves, [1, 2]); assert.equal(restarted.status().counts.analyzed, 2);
  current = cooldown.until; addArrival(3); await run(restarted);
  assert.equal(connections, 2); assert.deepEqual(moves, [1, 2, 3]);
  const next = index.get('meta', 'processingSettings').accountBackoff[account.id];
  assert.equal(next.attempts, 2); assert.ok(next.until >= current + 30 * 60000 && next.until < current + 30 * 60000 + 30000);
  assert.equal(new Set(modelIds).size, 3); assert.equal(modelIds.length, 3);
});

test('mailbox authentication failures stay account-local during flags, body reads and moves', async t => {
  for (const stage of ['flags', 'body', 'body_result', 'move']) await t.test(stage, async t => {
    const index = memoryIndex(), healthy = { ...account, id: 'healthy', email: 'healthy@example.test', label: 'Healthy' };
    const brokenMail = mail(1, { unread: stage === 'flags' });
    const healthyMail = mail(2, { unread: false, accountId: healthy.id, to: healthy.email }); healthyMail.reference.accountId = healthy.id;
    const data = [brokenMail, healthyMail], connected = [account, healthy], modelIds = [], bodyAccounts = [], moved = [];
    let current = stamp, failing = true, authenticationCalls = 0;
    const authFailure = () => { authenticationCalls++; return new MailHarborError('mailbox_login_required'); };
    if (stage === 'move') seed(index, brokenMail, classification('placeholder'));
    const processing = createMailProcessing({ index, store: { read: () => ({}) },
      accounts: { list: () => copy(connected), get: id => copy(connected.find(value => value.id === id)) },
      tags: { manualFor: () => [], async automatic() {}, async observe() {} },
      reader: {
        async folders() { return { folders: [{ path: 'INBOX', role: 'inbox' }] }; },
        async scan(value, { afterUid = 0 }) {
          const found = data.filter(message => message.reference.accountId === value.id && message.reference.uid > afterUid);
          return { messages: copy(found), afterUid: found.at(-1)?.reference.uid ?? afterUid, uidValidity: '100', done: true };
        },
        async markRead(value, references) {
          if (failing && value.id === account.id && stage === 'flags') throw authFailure();
          return { results: references.map(reference => ({ reference, status: 'applied' })) };
        },
        async readBatch(value, references) {
          bodyAccounts.push(value.id);
          if (failing && value.id === account.id && stage === 'body') throw authFailure();
          if (failing && value.id === account.id && stage === 'body_result') {
            const error = authFailure(); return { messages: [], errors: references.map(reference => ({ reference, code: error.code })) };
          }
          return { messages: references.map(reference => ({ ...copy(data.find(message => message.reference.uid === reference.uid)),
            reference, body: 'Complete fictional job notification', bodyUnavailable: false, truncated: false })), errors: [] };
        },
        async move(value, reference) {
          if (failing && value.id === account.id && stage === 'move') throw authFailure();
          moved.push(value.id); return { status: 'applied', reference: { ...reference, path: 'Trash', uid: reference.uid + 1000 } };
        }
      },
      classify: async request => { modelIds.push(...request.messages.map(message => message.id)); return { items: request.messages.map(message => classification(message.id)) }; },
      now: () => current, autoSchedule: false });
    t.after(() => processing.close());
    await processing.configure({ providerConsent: true }); await processing.action('start'); await processing.drain();
    const first = processing.status(), held = index.get('messages', keyOf(brokenMail));
    assert.equal(first.enabled, true); assert.equal(first.lastRun.status, 'partial'); assert.equal(first.pauseReason, null);
    assert.equal(first.counts.analyzed, stage === 'move' ? 2 : 1);
    assert.equal(authenticationCalls, 1); assert.ok(moved.includes(healthy.id));
    assert.equal(held.readAttempts ?? 0, 0); assert.equal(held.classificationAttempts ?? 0, 0);
    assert.equal(held.readError ?? null, null);
    if (stage === 'flags') assert.ok(!bodyAccounts.includes(account.id), 'Failed flag authentication must prevent a body connection to that account');
    if (stage === 'move') assert.equal(held.locations[0].intent.action, 'trash');
    const cooldown = index.get('meta', 'processingSettings').accountBackoff[account.id];
    assert.equal(cooldown.code, 'mailbox_login_required'); assert.equal(cooldown.attempts, 1);
    await processing.action('start'); await processing.drain();
    assert.equal(authenticationCalls, 1, 'An active account cooldown is preserved');
    current = cooldown.until + 1; failing = false;
    await processing.action('start'); await processing.drain();
    assert.equal(processing.status().counts.analyzed, 2); assert.ok(moved.includes(account.id));
    assert.equal(index.get('meta', 'processingSettings').accountBackoff[account.id], undefined);
    assert.equal(new Set(modelIds).size, stage === 'move' ? 1 : 2); assert.equal(modelIds.length, stage === 'move' ? 1 : 2);
  });
});

test('verified mailbox recovery resets consecutive connection backoff before a later isolated failure', async t => {
  let fail = true;
  const h = harness(t, { messages: [], folders: [], readerOverrides: { async folders() {
    if (fail) throw new MailHarborError('mailbox_login_required');
    return { folders: [] };
  } } });
  await h.run();
  const first = h.index.get('meta', 'processingSettings').accountBackoff[account.id];
  h.time(new Date(first.until + 1).toISOString()); fail = false;
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(h.index.get('meta', 'processingSettings').accountBackoff[account.id], undefined);
  fail = true; await h.processing.action('start'); await h.processing.drain();
  const next = h.index.get('meta', 'processingSettings').accountBackoff[account.id];
  assert.equal(next.attempts, 1);
  assert.ok(next.until >= first.until + 1 + 15 * 60000 && next.until < first.until + 1 + 15 * 60000 + 30000);
});

test('one failed body-read batch increments account backoff once while preserving each message retry', async t => {
  const messages = Array.from({ length: 12 }, (_, offset) => mail(offset + 1, { unread: false }));
  let calls = 0;
  const h = harness(t, { messages, readerOverrides: { async readBatch() { calls++; throw new MailHarborError('mailbox_timeout'); } } });
  await h.run();
  const saved = h.index.get('meta', 'processingSettings').accountBackoff[account.id];
  assert.equal(saved.attempts, 1); assert.equal(calls, 1);
  assert.ok(saved.until >= stamp + 15 * 60000 && saved.until < stamp + 15 * 60000 + 30000);
  for (const message of messages) {
    const record = h.index.get('messages', keyOf(message));
    assert.equal(record.readAttempts, 1); assert.equal(record.readError, 'mailbox_timeout');
    assert.equal(record.readRetryAt, stamp + 15 * 60000);
  }
});

test('a yielded move stage cannot reset account backoff without a verified provider operation', async t => {
  const index = memoryIndex();
  index.put('meta', 'processingSettings', { accountBackoff: { [account.id]: { revision: account.revision, attempts: 3, until: stamp - 1 } } });
  seed(index, mail(1, { unread: false }), classification('placeholder'));
  let writing;
  const h = harness(t, { index, messages: [], folders: [],
    readerOverrides: { async folders() { throw new MailHarborError('mailbox_error'); } },
    tagsOverrides: { async automatic() { writing = h.processing.withMailboxWrite(() => {}); } } });
  await h.run(); await writing;
  assert.equal(h.metrics.moves.length, 0);
  assert.equal(index.get('meta', 'processingSettings').accountBackoff[account.id].attempts, 3);
});

test('invalid model output cannot substitute IDs or classify a batch partially before actions', async t => {
  const h = harness(t, { messages: [mail(1), mail(2)], classify: request => ({ items: [classification(request.messages[0].id), classification(request.messages[0].id)] }) });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'partial');
  assert.equal(result.counts.analyzed, 0);
  assert.equal(h.index.count('messages', 'pending'), 2);
  assert.equal(result.counts.retrying, 2);
  assert.equal(h.index.count('messages', 'review'), 0);
  assert.equal(h.metrics.moves.length, 0);
  assert.equal(h.metrics.tags.length, 0);
});

test('one invalid single-message reply waits for its durable retry while later mail progresses and restart preserves the delay', async t => {
  const index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 1 });
  const messages = [mail(1), mail(2)].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const badKey = keyOf(messages[0]), goodKey = keyOf(messages[1]);
  const h = harness(t, { index, messages, classify: request => request.messages[0].id === badKey ? { items: [] } :
    { items: request.messages.map(message => classification(message.id)) } });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'partial'); assert.equal(result.enabled, true);
  assert.equal(result.counts.analyzed, 1); assert.equal(result.counts.needsReview, 0); assert.equal(result.counts.retrying, 1); assert.equal(result.counts.errors, 1);
  assert.equal(result.lastRun.errorCount, 1); assert.equal(result.recentErrors[0].phase, 'classifying');
  assert.equal(result.recentErrors[0].accountId, account.id);
  const bad = index.get('messages', badKey);
  assert.equal(bad.classification, null); assert.equal(bad.classificationError, 'invalid_model_output');
  assert.equal(bad.classificationFailedAt, stamp); assert.equal(bad.complete, true); assert.equal(bad.nextAt, stamp + 15 * 60000);
  assert.equal(bad.classificationAttempts, 1);
  assert.deepEqual(bad.reference, messages[0].reference);
  assert.ok(!JSON.stringify(bad).includes('A complete job notification body.'));
  assert.equal(index.list('messages', { state: 'review', before: stamp }).length, 0);
  assert.equal(index.get('messages', goodKey).locations[0].handled, 'trash');
  assert.ok(h.metrics.tags.every(value => value.reference.fingerprint !== bad.reference.fingerprint));
  assert.ok(h.metrics.moves.every(value => value.reference.fingerprint !== bad.reference.fingerprint));
  await h.processing.close();
  const resumed = harness(t, { index, messages }); resumed.time('2026-09-13T12:14:59Z');
  await resumed.run();
  assert.equal(resumed.metrics.model.length, 0); assert.equal(resumed.metrics.moves.length, 0);
  assert.equal(resumed.processing.status().counts.retrying, 1);
});

test('three consecutive invalid single-message replies pause the provider without quarantining the remaining backlog', async t => {
  const index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 1 });
  const h = harness(t, { index, messages: [mail(1), mail(2), mail(3), mail(4), mail(5)], classify: () => {
    throw new MailHarborError('invalid_model_output', 'PRIVATE_MODEL_REPLY_MUST_NOT_PERSIST');
  } });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'failed'); assert.equal(result.enabled, true);
  assert.equal(result.pauseReason, 'invalid_model_output'); assert.equal(h.metrics.model.length, 3);
  assert.equal(result.counts.errors, 3); assert.equal(result.lastRun.errorCount, 3);
  assert.equal(result.counts.needsReview, 0); assert.equal(result.counts.retrying, 3); assert.equal(result.counts.pending, 5); assert.equal(result.counts.analyzed, 0);
  assert.equal(Date.parse(result.retryAt), stamp + 15 * 60000); assert.equal(result.workerState, 'retrying');
  assert.equal(index.get('meta', 'processingSettings').invalidSingleStreak, 3);
  assert.equal(h.metrics.moves.length, 0); assert.equal(h.metrics.tags.length, 0);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_MODEL_REPLY_MUST_NOT_PERSIST'));
});

test('a successful classification resets the consecutive invalid-single stop counter', async t => {
  const index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 1 });
  let attempts = 0;
  const h = harness(t, { index, messages: [mail(1), mail(2), mail(3), mail(4), mail(5)], classify: request => {
    attempts++;
    return attempts === 3 ? { items: request.messages.map(message => classification(message.id)) } : { items: [] };
  } });
  const result = await h.run();
  assert.equal(attempts, 5); assert.equal(result.enabled, true); assert.equal(result.lastRun.status, 'partial');
  assert.equal(result.counts.analyzed, 1); assert.equal(result.counts.needsReview, 0); assert.equal(result.counts.retrying, 4);
  assert.equal(index.get('meta', 'processingSettings').invalidSingleStreak, 2);
});

test('an invalid multi-message reply halves the batch and accepts none of its partial output', async t => {
  const index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 4 });
  let attempts = 0, h;
  h = harness(t, { index, messages: [mail(1), mail(2), mail(3), mail(4)], classify: request => {
    attempts++;
    if (attempts === 1) return { items: request.messages.map((message, position) => classification(position === 1 ? 'f'.repeat(64) : message.id)) };
    if (attempts === 2) {
      assert.equal(index.count('messages', 'pending'), 4); assert.equal(index.count('messages', 'review'), 0);
      assert.equal(h.metrics.tags.length, 0); assert.equal(h.metrics.moves.length, 0);
      assert.ok(index.list('messages').every(row => row.value.classification === null));
    }
    return { items: request.messages.map(message => classification(message.id)) };
  } });
  const result = await h.run();
  assert.deepEqual(h.metrics.model.map(value => value.messages.length), [4, 2, 2]);
  assert.equal(result.lastRun.status, 'partial'); assert.equal(result.enabled, true); assert.equal(result.batchSize, 2);
  assert.equal(result.counts.errors, 1); assert.equal(result.counts.analyzed, 4); assert.equal(result.counts.needsReview, 0);
  assert.equal(result.counts.trashed, 4); assert.equal(index.get('meta', 'processingSettings').invalidSingleStreak, 0);
});

test('all already classified retention work is drained before the run reports completion', async t => {
  const index = memoryIndex();
  for (let uid = 1; uid <= 450; uid++) seed(index, mail(uid, { unread: false }), classification('placeholder'));
  const h = harness(t, { index, messages: [], folders: [] });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'completed');
  assert.equal(result.counts.trashed, 450);
  assert.equal(h.index.count('messages', 'ready'), 0);
  assert.equal(h.metrics.model.length, 0);
});

test('retention batches read flags across records and checkpoints each bounded MOVE before the next one', async t => {
  const index = memoryIndex(), batches = [], handled = [];
  for (let uid = 1; uid <= 65; uid++) seed(index, mail(uid), classification('placeholder'));
  const h = harness(t, { index, messages: [], folders: [], readerOverrides: {
    async moveBatch(_, operations, { onResult }) {
      batches.push(operations.length);
      assert.ok(operations.length <= 40);
      for (const operation of operations) {
        const key = keyOf({ reference: operation.reference });
        const before = index.get('messages', key);
        assert.equal(before.locations[0].intent.action, 'trash');
        assert.equal(before.locations[0].handled, null);
        await onResult({ ...operation, result: { status: 'applied', reference: { ...operation.reference, path: 'Trash', uid: operation.reference.uid + 1000 } } });
        const after = index.get('messages', key);
        assert.equal(after.locations[0].handled, 'trash');
        assert.equal(after.locations[0].intent, null);
        handled.push(key);
      }
    }
  } });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'completed');
  assert.deepEqual(h.metrics.markBatches.map(batch => batch.length), [65]);
  assert.deepEqual(batches, [40, 25]);
  assert.equal(new Set(handled).size, 65);
  assert.equal(result.counts.trashed, 65);
});

test('partial batch failure preserves completed results and outstanding intents for restart without reclassification', async t => {
  const index = memoryIndex();
  for (let uid = 1; uid <= 65; uid++) seed(index, mail(uid, { unread: false }), classification('placeholder'));
  let completedKey, interruptedKey;
  const first = harness(t, { index, messages: [], folders: [], readerOverrides: {
    async moveBatch(_, operations, { onResult }) {
      assert.equal(operations.length, 40);
      const completed = operations[0]; completedKey = keyOf({ reference: completed.reference });
      await onResult({ ...completed, result: { status: 'applied', reference: { ...completed.reference, path: 'Trash', uid: completed.reference.uid + 1000 } } });
      interruptedKey = keyOf({ reference: operations[1].reference });
      throw new MailHarborError('mailbox_timeout');
    }
  } });
  const failed = await first.run();
  assert.equal(failed.lastRun.status, 'partial');
  assert.equal(index.get('messages', completedKey).locations[0].handled, 'trash');
  assert.equal(index.get('messages', interruptedKey).locations[0].intent.action, 'trash');
  assert.equal(index.count('messages', 'review'), 64);
  await first.processing.close();
  const replayed = [];
  const resumed = harness(t, { index, messages: [], folders: [], readerOverrides: {
    async moveBatch(_, operations, { onResult }) {
      for (const operation of operations) {
        const key = keyOf({ reference: operation.reference });
        assert.notEqual(key, completedKey);
        replayed.push(key);
        await onResult({ ...operation, result: key === interruptedKey ? { status: 'absent' } :
          { status: 'applied', reference: { ...operation.reference, path: 'Trash', uid: operation.reference.uid + 1000 } } });
      }
    }
  } });
  resumed.time(new Date(failed.accountBackoff[account.id].until).toISOString());
  const result = await resumed.run();
  assert.equal(result.lastRun.status, 'completed');
  assert.equal(new Set(replayed).size, 64);
  assert.equal(resumed.metrics.model.length, 0);
  assert.equal(result.counts.trashed, 64);
  assert.equal(index.get('messages', interruptedKey).locations[0].handled, 'absent');
  assert.equal(index.get('messages', interruptedKey).review, true);
});

test('a failed due move is deferred without blocking new classifications or repeating them on retry', async t => {
  const index = memoryIndex();
  seed(index, mail(1, { unread: false }), classification('placeholder'));
  const h = harness(t, { index, messages: [mail(2)], move: reference => {
    if (reference.uid === 1) throw new MailHarborError('mailbox_error');
    return { status: 'applied', reference: { ...reference, path: 'Trash', uid: 1002 } };
  } });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'partial');
  assert.equal(result.lastRun.errorCount, 1);
  assert.equal(result.recentErrors[0].phase, 'applying');
  assert.equal(h.metrics.model.flatMap(request => request.messages).length, 1);
  assert.equal(result.counts.trashed, 1);
  const deferred = index.get('messages', keyOf(mail(1)));
  assert.equal(deferred.locations[0].intent.action, 'trash');
  assert.equal(deferred.nextAt, stamp + 15 * 60000);
  assert.equal(deferred.review, true);
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(h.metrics.moves.length, 2);
  assert.equal(h.metrics.model.flatMap(request => request.messages).length, 1);
});

test('all folder headers and read batches finish before the first classifier call, with fair pagination and one classification per message', async t => {
  const messages = Array.from({ length: 203 }, (_, offset) => mail(offset + 1, {
    ...(offset >= 201 ? { folderPath: 'Other', role: 'other' } : {}),
    receivedAt: '2026-09-13T12:00:00Z', date: '2026-09-13T12:00:00Z'
  }));
  let h;
  h = harness(t, { messages, classify: request => {
    assert.equal(h.metrics.marked.length, 203);
    assert.deepEqual(h.metrics.scans.map(value => [value.path, value.afterUid]), [['INBOX', 0], ['Other', 0], ['INBOX', 100], ['INBOX', 200]]);
    assert.deepEqual(h.metrics.markBatches.map(batch => batch.length), [100, 2, 100, 1]);
    assert.ok(request.messages.length <= 12);
    return { items: request.messages.map(message => classification(message.id)) };
  } });
  const status = await h.run();
  assert.equal(status.lastRun.status, 'completed');
  assert.equal(status.counts.markedRead, 203);
  assert.equal(status.counts.analyzed, 203);
  const ids = h.metrics.model.flatMap(request => request.messages.map(message => message.id));
  assert.equal(ids.length, 203); assert.equal(new Set(ids).size, 203);
  assert.equal(h.metrics.moves.length, 0);
});

test('cached preview messages behind the folder cursor are marked read in a batch before new discovery or AI', async t => {
  const index = memoryIndex();
  for (let uid = 1; uid <= 12; uid++) seed(index, mail(uid), null);
  index.put('folders', hash([account.id, account.email, 'INBOX']), { afterUid: 12, uidValidity: '100', done: true });
  let h;
  h = harness(t, { index, messages: Array.from({ length: 6 }, (_, offset) => mail(offset + 13)), classify: request => {
    assert.equal(h.metrics.marked.length, 18);
    assert.deepEqual(h.metrics.markBatches.map(batch => batch.length), [12, 6]);
    return { items: request.messages.map(message => classification(message.id)) };
  } });
  const status = await h.run();
  assert.equal(status.lastRun.status, 'completed');
  assert.equal(h.metrics.scans[0].afterUid, 12);
  assert.equal(status.counts.analyzed, 18);
});

test('a failed read-flag batch persists its retry before advancing discovery and reuses classification after read recovery', async t => {
  const first = harness(t, { readerOverrides: { async markRead() { throw new MailHarborError('mailbox_error'); } } });
  await first.run();
  assert.equal(first.index.get('folders', hash([account.id, account.email, 'INBOX'])).afterUid, 1);
  assert.equal(first.index.count('messages'), 1);
  assert.equal(first.metrics.model.length, 1);
  assert.equal(first.metrics.moves.length, 0);
  assert.equal(first.index.get('messages', keyOf(mail())).locations[0].read, false);
  await first.processing.close();
  const resumed = harness(t, { index: first.index });
  resumed.time('2026-09-13T12:15:00Z');
  const status = await resumed.run();
  assert.equal(status.lastRun.status, 'completed');
  assert.equal(resumed.metrics.scans[0].afterUid, 1);
  assert.equal(resumed.metrics.marked.length, 1);
  assert.equal(resumed.metrics.model.length, 0);
  assert.equal(resumed.metrics.moves.length, 1);
  assert.equal(resumed.index.get('folders', hash([account.id, account.email, 'INBOX'])).afterUid, 1);
});

test('one read-flag failure backs off the account, continues classification, and prevents moves until flags recover', async t => {
  let calls = 0;
  const messages = Array.from({ length: 26 }, (_, i) => mail(i + 1));
  const h = harness(t, { messages, readerOverrides: { async markRead() {
    calls++;
    const error = new MailHarborError('mailbox_error');
    error.mailboxDiagnostic = { command: 'UID STORE', reason: 'server_rejected', status: 'NO', responseCode: 'NOPERM', responseText: 'private provider reply' };
    throw error;
  } } });
  const first = await h.run();
  assert.equal(first.lastRun.status, 'partial');
  assert.equal(first.lastRun.errorCount, 1);
  assert.deepEqual(first.recentErrors[0].mailboxDiagnostic, { command: 'UID STORE', reason: 'server_rejected', status: 'NO', responseCode: 'NOPERM' });
  assert.equal(first.counts.analyzed, 26);
  assert.equal(calls, 1);
  assert.equal(h.metrics.moves.length, 0);
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(calls, 1);
  assert.equal(h.metrics.model.flatMap(request => request.messages).length, 26);
  await h.processing.close();
  const resumed = harness(t, { index: h.index, messages });
  resumed.time('2026-09-13T12:15:00Z');
  const result = await resumed.run();
  assert.equal(result.lastRun.errorCount, 0);
  assert.equal(resumed.metrics.marked.length, 26);
  assert.equal(resumed.metrics.moves.length, 26);
  assert.equal(resumed.metrics.model.length, 0);
});

test('marking cached read-error mail preserves review state without retrying body analysis', async t => {
  const first = harness(t, { readError: true });
  await first.run('preview'); await first.processing.close();
  const resumed = harness(t, { index: first.index });
  const result = await resumed.run();
  assert.equal(result.lastRun.status, 'completed');
  assert.equal(resumed.metrics.marked.length, 1);
  assert.equal(resumed.metrics.reads.length, 0);
  assert.equal(resumed.metrics.model.length, 0);
  assert.equal(result.counts.technicalFailures, 1); assert.equal(result.counts.needsReview, 0);
});

test('unfinished folder pages retain their UID high watermark and a later run starts a fresh arrival snapshot', async t => {
  const calls = [], messages = [mail(1), mail(2), mail(3)];
  const h = harness(t, { messages, readerOverrides: {
    async scan(_, options) {
      calls.push({ afterUid: options.afterUid ?? 0, highWatermark: options.highWatermark ?? null });
      const after = options.afterUid ?? 0;
      const ceiling = options.highWatermark ?? (after === 0 ? 2 : 3);
      const selected = messages.filter(message => message.reference.uid > after && message.reference.uid <= ceiling).slice(0, 1);
      const next = selected.at(-1)?.reference.uid ?? after;
      return { messages: copy(selected), afterUid: next, uidValidity: '100', highWatermark: ceiling, done: next >= ceiling };
    }
  } });
  const first = await h.run();
  assert.equal(first.counts.analyzed, 2);
  assert.deepEqual(calls, [{ afterUid: 0, highWatermark: null }, { afterUid: 1, highWatermark: 2 }]);
  await h.processing.action('start'); await h.processing.drain();
  assert.deepEqual(calls.at(-1), { afterUid: 2, highWatermark: null });
  assert.equal(h.processing.status().counts.analyzed, 3);
  assert.equal(h.metrics.model.flatMap(request => request.messages).length, 3);
});

test('Gmail Inbox and label aliases with the same physical identity execute one MOVE and checkpoint all aliases together', async t => {
  const first = mail(1, { emailId: '17899912345678901' });
  const second = mail(17, { emailId: first.emailId, folderPath: 'All Mail', role: 'archive', reference: { ...first.reference, path: 'All Mail', uid: 17 } });
  const third = mail(23, { emailId: first.emailId, folderPath: 'Custom label', role: 'other', reference: { ...first.reference, path: 'Custom label', uid: 23 } });
  const index = memoryIndex(); let mutations = 0;
  const h = harness(t, { index, messages: [first, second, third], readerOverrides: {
    async folders() { return { gmail: true, folders: [{ path: 'INBOX', role: 'inbox' }, { path: 'All Mail', role: 'archive' }, { path: 'Custom label', role: 'other' }] }; },
    async moveBatch(_, operations, { onResult }) {
      assert.equal(operations.length, 1);
      const operation = operations[0]; mutations++;
      assert.ok(index.get('messages', keyOf(first)).locations.every(location => location.intent?.action === 'trash'));
      await onResult({ ...operation, result: { status: 'applied', reference: { ...operation.reference, path: 'Trash', uid: 1001 } } });
      const saved = index.get('messages', keyOf(first));
      assert.ok(saved.locations.every(location => location.handled === 'trash' && location.intent === null));
      assert.ok(saved.locations.every(location => location.gmail && location.emailId === first.emailId));
      assert.equal(saved.review, false);
    }
  } });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'completed'); assert.equal(mutations, 1);
  assert.equal(result.counts.trashed, 1); assert.equal(result.counts.needsReview, 0);
  assert.equal(h.metrics.model.flatMap(request => request.messages).length, 1);
});

test('matching Gmail fingerprints do not collapse different physical message IDs', async t => {
  const first = mail(1, { emailId: '17899912345678901' });
  const second = mail(17, { emailId: '17899912345678902', folderPath: 'All Mail', role: 'archive', reference: { ...first.reference, path: 'All Mail', uid: 17 } });
  const h = harness(t, { messages: [first, second], readerOverrides: {
    async folders() { return { gmail: true, folders: [{ path: 'INBOX', role: 'inbox' }, { path: 'All Mail', role: 'archive' }] }; }
  } });
  await h.run();
  assert.equal(h.metrics.moves.length, 2);
  assert.ok(h.index.get('messages', keyOf(first)).locations.every(location => location.handled === 'trash'));
});

test('an absent chosen Gmail alias leaves its other alias retryable until a verified result completes the physical action', async t => {
  const first = mail(1, { emailId: '17899912345678901' });
  const second = mail(17, { emailId: first.emailId, folderPath: 'All Mail', role: 'archive', reference: { ...first.reference, path: 'All Mail', uid: 17 } });
  const h = harness(t, { messages: [first, second], move: (reference, action, count) => count === 1 ? { status: 'absent' } :
    { status: 'applied', reference: { ...reference, path: 'Trash', uid: 1001 } }, readerOverrides: {
    async folders() { return { gmail: true, folders: [{ path: 'INBOX', role: 'inbox' }, { path: 'All Mail', role: 'archive' }] }; }
  } });
  await h.run();
  const waiting = h.index.get('messages', keyOf(first));
  assert.equal(waiting.locations[0].handled, 'absent');
  assert.equal(waiting.locations[1].handled, null);
  assert.equal(waiting.locations[1].intent.action, 'trash');
  assert.equal(waiting.nextAt, stamp + 15 * 60000);
  assert.equal(h.processing.status().counts.trashed, 0);
  h.time('2026-09-13T12:15:00Z');
  await h.processing.action('start'); await h.processing.drain();
  assert.deepEqual(h.metrics.moves.map(value => value.reference.path), ['INBOX', 'All Mail']);
  assert.equal(h.processing.status().counts.trashed, 1);
  assert.ok(h.index.get('messages', keyOf(first)).locations.every(location => location.handled === 'trash'));
  assert.equal(h.processing.status().counts.needsReview, 0);
  assert.equal(h.metrics.model.flatMap(request => request.messages).length, 1);
});

test('a Gmail Sent alias protects the same physical Inbox message for the longer Sent retention', async t => {
  const first = mail(1, { emailId: '17899912345678901' });
  const sent = mail(17, { emailId: first.emailId, folderPath: 'Sent', role: 'sent', reference: { ...first.reference, path: 'Sent', uid: 17 } });
  const h = harness(t, { messages: [first, sent], readerOverrides: {
    async folders() { return { gmail: true, folders: [{ path: 'INBOX', role: 'inbox' }, { path: 'Sent', role: 'sent' }] }; }
  } });
  await h.run();
  assert.equal(h.metrics.moves.length, 0);
  assert.equal(h.index.get('messages', keyOf(first)).nextAt, Date.parse('2033-01-01T12:00:00Z'));
  assert.equal(h.processing.status().counts.needsReview, 0);
});

test('old Gmail folder checkpoints are enriched once without classifying cached mail again', async t => {
  const index = memoryIndex(), first = mail(1, { emailId: '17899912345678901' });
  seed(index, first, classification('placeholder'));
  index.put('folders', hash([account.id, account.email, 'INBOX']), { afterUid: 1, uidValidity: '100', done: true });
  const h = harness(t, { index, messages: [first], readerOverrides: {
    async folders() { return { gmail: true, folders: [{ path: 'INBOX', role: 'inbox' }] }; }
  } });
  await h.run();
  assert.equal(h.metrics.scans[0].afterUid, 0);
  assert.equal(h.metrics.model.length, 0);
  assert.equal(index.get('messages', keyOf(first)).locations[0].emailId, first.emailId);
  assert.equal(index.get('folders', hash([account.id, account.email, 'INBOX'])).gmailIdentityVersion, 1);
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(h.metrics.scans.at(-1).afterUid, 1);
  assert.equal(h.metrics.moves.length, 1);
});

test('apply-mode timeout schedules its saved one-minute retry rather than the normal fifteen-minute sweep', async t => {
  const waits = [], original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, wait, ...args) => {
    if (wait >= 1000) { waits.push(wait); return { unref() {} }; }
    return original(callback, wait, ...args);
  });
  const h = harness(t, { autoSchedule: true, classify: () => { throw new MailHarborError('timeout'); } });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'failed');
  assert.equal(result.pauseReason, 'timeout');
  assert.equal(result.enabled, true);
  assert.equal(result.batchSize, 6);
  assert.equal(Date.parse(result.retryAt), stamp + 60000);
  assert.equal(waits.at(-1), 60000);
  assert.equal(waits.includes(15 * 60000), false);
});

test('a long classification backlog discovers and marks new arrivals after fifteen minutes without repeating cached AI', async t => {
  const incoming = Array.from({ length: 13 }, (_, offset) => mail(offset + 1));
  const scans = []; let h;
  h = harness(t, { messages: incoming, readerOverrides: {
    async scan(_, options) {
      const after = options.afterUid ?? 0, ceiling = options.highWatermark ?? incoming.at(-1).reference.uid;
      scans.push({ after, ceiling, classifications: h.metrics.model.length });
      const messages = incoming.filter(message => message.reference.uid > after && message.reference.uid <= ceiling);
      return { messages: copy(messages), afterUid: ceiling, uidValidity: '100', highWatermark: ceiling, done: true };
    }
  }, classify: request => {
    if (h.metrics.model.length === 1) {
      assert.equal(h.metrics.marked.length, 13);
      incoming.push(mail(14));
      h.time('2026-09-13T12:15:00Z');
    } else {
      assert.equal(h.metrics.marked.length, 14);
      assert.deepEqual(scans, [{ after: 0, ceiling: 13, classifications: 0 }, { after: 13, ceiling: 14, classifications: 1 }]);
    }
    return { items: request.messages.map(message => classification(message.id)) };
  } });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'completed');
  assert.equal(result.counts.analyzed, 14);
  assert.equal(h.metrics.marked.length, 14);
  const ids = h.metrics.model.flatMap(request => request.messages.map(message => message.id));
  assert.equal(ids.length, 14); assert.equal(new Set(ids).size, 14);
  assert.equal(scans.length, 2);
});

test('transient body failures retry locally after fifteen minutes and classify exactly once after successful content', async t => {
  let attempts = 0;
  const h = harness(t, { readerOverrides: {
    async readBatch(_, references) {
      attempts++;
      if (attempts === 1) return { messages: [], errors: references.map(reference => ({ reference, code: 'mailbox_timeout' })) };
      return { messages: references.map(reference => ({ ...mail(reference.uid), reference, body: 'A complete job notification.', truncated: false, bodyUnavailable: false })), errors: [] };
    }
  } });
  const first = await h.run();
  assert.equal(first.lastRun.status, 'partial'); assert.equal(first.counts.pending, 1);
  assert.equal(first.counts.needsReview, 0); assert.equal(h.metrics.model.length, 0);
  const waiting = h.index.get('messages', keyOf(mail()));
  assert.equal(waiting.readRetryAt, stamp + 15 * 60000); assert.equal(waiting.readAttempts, 1);
  h.time('2026-09-13T12:14:59Z');
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(attempts, 1); assert.equal(h.metrics.model.length, 0);
  h.time(new Date(first.accountBackoff[account.id].until).toISOString());
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(attempts, 2); assert.equal(h.metrics.model.length, 1);
  assert.equal(h.processing.status().counts.analyzed, 1);
  assert.equal(h.index.get('messages', keyOf(mail())).readError, null);
  assert.equal(h.index.get('messages', keyOf(mail())).readRetryAt, null);
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(attempts, 2); assert.equal(h.metrics.model.length, 1);
});

test('whole-batch transient body errors stop after three attempts and remain technical failures across restart', async t => {
  let attempts = 0;
  const h = harness(t, { readerOverrides: { async readBatch() { attempts++; throw new MailHarborError('mailbox_error'); } } });
  await h.run();
  h.time('2026-09-13T12:15:00Z');
  await h.processing.action('start'); await h.processing.drain();
  h.time('2026-09-13T12:30:00Z');
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(attempts, 3); assert.equal(h.metrics.model.length, 0);
  const saved = h.index.get('messages', keyOf(mail()));
  assert.equal(saved.readAttempts, 3); assert.equal(saved.readRetryAt, null); assert.equal(saved.nextAt, null);
  assert.equal(h.index.count('messages', 'pending'), 0); assert.equal(h.index.count('messages', 'review'), 1);
  await h.processing.close();
  const resumed = harness(t, { index: h.index });
  resumed.time('2026-09-14T12:00:00Z');
  await resumed.run();
  assert.equal(resumed.metrics.reads.length, 0); assert.equal(resumed.metrics.model.length, 0);
  assert.equal(resumed.processing.status().counts.technicalFailures, 1); assert.equal(resumed.processing.status().counts.needsReview, 0);
});

test('classification attempt budget survives restarts and an exhausted message is never retried by a successful breaker probe', async t => {
  const index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 1 });
  const id = keyOf(mail()); let current = stamp;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const h = harness(t, { index, classify: () => { throw new MailHarborError('invalid_model_output'); } });
    h.time(new Date(current).toISOString());
    await h.run();
    const saved = index.get('messages', id);
    assert.equal(saved.classificationAttempts, attempt);
    assert.equal(saved.classification, null);
    assert.equal(h.metrics.model.filter(call => call.messages.some(message => message.id === id)).length, 1);
    assert.equal(h.metrics.moves.length, 0);
    if (attempt < 3) { assert.equal(saved.retryAt, current + 15 * 60000 * 2 ** (attempt - 1)); current = saved.retryAt; }
    else { assert.equal(saved.retryAt, null); assert.equal(h.processing.status().counts.technicalFailures, 1); }
    await h.processing.close();
  }
  const recovered = harness(t, { index }); recovered.time('2026-09-14T12:00:00Z');
  await recovered.run();
  assert.equal(recovered.metrics.model.length, 1); // Only a synthetic provider probe.
  assert.ok(recovered.metrics.model.every(call => call.messages.every(message => message.id !== id)));
  assert.equal(index.get('messages', id).classificationAttempts, 3);
  assert.equal(index.get('messages', id).classification, null);
  assert.equal(recovered.metrics.moves.length, 0);
});

test('failed breaker probes use one synthetic message and increase cooldown without consuming untouched backlog', async t => {
  const index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 1 });
  const messages = Array.from({ length: 8 }, (_, offset) => mail(offset + 1));
  const h = harness(t, { index, messages, classify: () => { throw new MailHarborError('invalid_model_output'); } });
  const stopped = await h.run();
  const before = index.list('messages').map(({ key, value }) => [key, value.classificationAttempts ?? 0]);
  assert.equal(h.metrics.model.length, 3);
  const deadline = Date.parse(stopped.retryAt);
  h.time(new Date(deadline).toISOString()); await h.processing.action('start'); await h.processing.drain();
  const status = h.processing.status();
  assert.equal(h.metrics.model.length, 4);
  assert.equal(h.metrics.model.at(-1).messages.length, 1);
  assert.equal(h.metrics.model.at(-1).messages[0].subject, 'Synthetic job alert');
  assert.deepEqual(index.list('messages').map(({ key, value }) => [key, value.classificationAttempts ?? 0]), before);
  assert.equal(Date.parse(status.retryAt), deadline + 30 * 60000);
  assert.equal(status.enabled, true); assert.equal(status.workerState, 'retrying');
  assert.equal(h.metrics.moves.length, 0);
});

test('fast valid batches recover throughput above one and persist the adaptive controller', async t => {
  const index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 1 });
  const h = harness(t, { index, messages: Array.from({ length: 18 }, (_, offset) => mail(offset + 1)) });
  const result = await h.run();
  assert.deepEqual(h.metrics.model.slice(0, 4).map(call => call.messages.length), [1, 1, 1, 2]);
  assert.ok(result.batchSize > 1 && result.batchSize <= 12);
  assert.equal(new Set(h.metrics.model.flatMap(call => call.messages.map(message => message.id))).size, 18);
  assert.equal(result.counts.analyzed, 18);
  await h.processing.close();
  const restarted = harness(t, { index, messages: [] });
  assert.equal(restarted.processing.status().batchSize, result.batchSize);
});

test('valid batches above one minute recover throughput, but near-timeout and partial batches do not', async t => {
  for (const [latency, expected] of [[75000, 2], [95000, 1]]) {
    const index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 1 });
    let clock = stamp;
    const h = harness(t, { index, messages: Array.from({ length: 6 }, (_, offset) => mail(offset + 1)), classify: request => {
      clock += latency; h.time(new Date(clock).toISOString());
      return { items: request.messages.map(message => classification(message.id)) };
    } });
    await h.run();
    assert.equal(h.metrics.model[3].messages.length, expected);
  }
  const index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 6, fastSuccesses: 2 });
  const partial = harness(t, { index, messages: [mail(1)] });
  assert.equal((await partial.run()).batchSize, 6);
});

test('move and invoice holds never interrupt discovery or starve the real organizer with label polls', { timeout: 5000 }, async t => {
  const index = memoryIndex(), data = Array.from({ length: 26 }, (_, offset) => mail(offset + 1, { unread: false }));
  const invoiceFiling = { sources: {}, records: {} };
  let entered, release, writerCalls = 0, labelCalls = 0, clock = stamp;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { index, messages: data, store: { read: () => ({ invoiceFiling }) }, readerOverrides: { async scan() {
    entered(); await gate; return { messages: data, afterUid: 26, uidValidity: '100', done: true };
  } } });
  // This separate classified message has an unresolved retention journal, so
  // filing must wait while the organizer continues classifying unrelated mail.
  const blocked = seed(index, mail(90, { unread: false }), classification('placeholder', ['invoices']), { nextAt: stamp + 86400000 });
  const record = index.get('messages', blocked); record.locations[0].intent = { action: 'trash' };
  index.put('messages', blocked, record, { state: 'ready', due: stamp + 86400000 });
  index.put('labelSync', blocked, { accountId: account.id, email: account.email, reference: record.reference, state: 'pending', retryAt: clock }, { state: 'pending', due: clock });
  const sync = createMailLabelSync({ index, accounts: { get: () => account }, tags: { definitions: () => [] },
    processing: { ...h.processing, withMailboxWrite(work) { writerCalls++; return h.processing.withMailboxWrite(work); } },
    reader: { async sync() { labelCalls++; return { results: [] }; } }, now: () => clock, autoSchedule: false });
  t.after(() => sync.close());
  await h.processing.configure({ providerConsent: true }); await h.processing.action('start'); await ready;
  for (let i = 0; i < 3; i++) { await sync.poll(); clock += 31000; }
  record.locations[0].intent = null;
  index.put('messages', blocked, record, { state: 'ready', due: stamp + 86400000 });
  index.put('invoiceQueue', blocked, { pending: true });
  for (let i = 0; i < 3; i++) { await sync.poll(); clock += 31000; }
  index.remove('invoiceQueue', blocked);
  invoiceFiling.sources[blocked] = { complete: true, recordIds: ['waiting'] };
  invoiceFiling.records.waiting = { status: 'waiting_drive' };
  for (let i = 0; i < 3; i++) { await sync.poll(); clock += 31000; }
  release(); await h.processing.drain();
  assert.equal(writerCalls, 0); assert.equal(labelCalls, 0); assert.equal(sync.status().pending, 1);
  assert.equal(h.metrics.model.flatMap(request => request.messages).length, 26);
  invoiceFiling.records.waiting.status = 'filed';
  await sync.poll();
  assert.equal(writerCalls, 1); assert.equal(labelCalls, 1);
});

test('productive label writers resume discovery checkpoints and allow classification between turns', { timeout: 10000 }, async t => {
  const index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 1 });
  const data = [mail(1, { unread: false }), mail(2, { unread: false })];
  const folders = Array.from({ length: 4 }, (_, offset) => ({ path: offset ? `Folder${offset}` : 'INBOX', role: offset ? 'other' : 'inbox' }));
  let inventories = 0, queued = null, sync, labelCalls = 0, labelNumber = 0;
  function enqueue() {
    const key = `label-${++labelNumber}`, reference = { ...mail(100 + labelNumber).reference };
    const value = { accountId: account.id, email: account.email, reference, tags: ['jobs'], manual: [], message: {} };
    index.put('tags', key, value);
    index.put('labelSync', key, { ...value, labels: ['MailHarbor/Jobs'], primaryLabel: 'MailHarbor/Jobs',
      desiredHash: hash([account.id, account.email, ['MailHarbor/Jobs'], 'MailHarbor/Jobs', false]), generation: 1,
      managedLabels: [], state: 'pending', retryAt: stamp }, { state: 'pending', due: stamp });
    queued = sync.poll();
  }
  const h = harness(t, { index, messages: data, folders, readerOverrides: {
    async folders() { inventories++; return { folders }; },
    async scan(_, options) {
      await Promise.resolve();
      h.metrics.scans.push(options.path); enqueue();
      return { messages: options.path === 'INBOX' ? data : [], afterUid: 2, uidValidity: '100', done: true };
    },
    async readBatch(_, references) {
      enqueue();
      return { messages: references.map(reference => ({ ...data.find(message => message.reference.uid === reference.uid),
        body: 'Complete fictional job notification', bodyUnavailable: false, truncated: false })), errors: [] };
    }
  } });
  sync = createMailLabelSync({ index, accounts: { get: () => account }, tags: { definitions: () => [{ id: 'jobs', label: 'Jobs' }] },
    processing: h.processing, reader: { async sync(_, entries, callbacks) {
      labelCalls++;
      assert.equal(h.processing.status().running, false);
      for (const entry of entries) { await callbacks.verify(entry); await callbacks.onResult(entry, { status: 'synced', managedLabels: [] }); }
      return { results: [] };
    } }, now: () => stamp, autoSchedule: false });
  t.after(() => sync.close());
  await h.processing.configure({ providerConsent: true });
  for (let run = 0; run < 8 && h.processing.status().counts.analyzed < 2; run++) {
    queued = null; await h.processing.action('start'); await h.processing.drain(); await queued;
  }
  assert.equal(h.processing.status().counts.analyzed, 2);
  assert.equal(inventories, 1); assert.deepEqual(h.metrics.scans, folders.map(folder => folder.path));
  assert.equal(labelCalls, 6); assert.equal(sync.status().pending, 0);
});

test('periodic inventory refresh includes new accounts and current revisions during a long analysis run', async t => {
  const additional = { ...account, id: 'additional', email: 'additional@example.test' };
  let connected = [account], clock = stamp, accountChange = false;
  const inventories = [], index = memoryIndex(); index.put('meta', 'processingSettings', { batchSize: 1 });
  const h = harness(t, { index, messages: [mail(1), mail(2)],
    accountStore: { list() {
      // Apply the external account update between completed processing stages.
      if (accountChange) { connected = [{ ...account, revision: 'two' }, additional]; accountChange = false; }
      return copy(connected);
    }, get: id => copy(connected.find(value => value.id === id)) },
    readerOverrides: { async folders(value) { inventories.push([value.id, value.revision]); return { folders: value.id === account.id ? [{ path: 'INBOX', role: 'inbox' }] : [] }; } },
    classify(request) {
      accountChange = true; clock += 16 * 60000; h.time(new Date(clock).toISOString());
      return { items: request.messages.map(message => classification(message.id)) };
    }
  });
  await h.run();
  assert.equal(h.processing.status().counts.analyzed, 2);
  assert.ok(inventories.some(([id]) => id === additional.id));
  assert.ok(inventories.some(([id, revision]) => id === account.id && revision === 'two'));
});

test('owner Pause during body reads cancels the selected unit before any provider request', { timeout: 5000 }, async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { messages: [mail(1, { unread: false })], readerOverrides: { async readBatch(_, references) {
    entered(); await gate;
    return { messages: references.map(reference => ({ ...mail(reference.uid), reference,
      body: 'Fictional notification', bodyUnavailable: false, truncated: false })), errors: [] };
  } } });
  await h.processing.configure({ providerConsent: true }); await h.processing.action('start'); await ready;
  const paused = h.processing.action('pause'); release(); await paused;
  assert.equal(h.metrics.model.length, 0); assert.equal(h.processing.status().enabled, false);
  assert.equal(h.processing.status().counts.analyzed, 0);
});

test('migration preserves 400 successful classifications, requeues 41 failures once, and preserves a historical pause', async t => {
  const index = memoryIndex();
  index.put('meta', 'processingSettings', { enabled: false, retryAt: new Date(stamp + 15 * 60000).toISOString(),
    pauseReason: 'invalid_model_output', lastRun: { status: 'running', startedAt: new Date(stamp - 1000).toISOString() } });
  const saved = new Map();
  for (let uid = 1; uid <= 441; uid++) {
    const key = seed(index, mail(uid, { unread: false }), uid <= 400 ? classification('placeholder', ['invoices']) : null);
    const record = index.get('messages', key);
    if (uid > 400) { record.classificationError = 'invalid_model_output'; record.classificationAttempts = 3; record.nextAt = null; record.review = true; }
    else { record.classifierVersion = 1; saved.set(key, copy(record.classification)); }
    index.put('messages', key, record);
  }
  const h = harness(t, { index, messages: [], folders: [] });
  const migrated = h.processing.status();
  assert.equal(migrated.enabled, false); assert.equal(migrated.retryAt, null);
  assert.equal(migrated.workerState, 'blocked'); assert.equal(migrated.lastRun.status, 'interrupted');
  assert.equal(migrated.migration.successfulPreserved, 400); assert.equal(migrated.migration.requeuedFailures, 41);
  assert.equal(migrated.counts.analyzed, 400); assert.equal(migrated.counts.pending, 41); assert.equal(migrated.counts.retrying, 41);
  for (const [key, classification] of saved) {
    assert.deepEqual(index.get('messages', key).classification, classification);
    assert.equal(index.get('messages', key).classifierVersion, 1);
  }
  const failure = index.list('messages', { state: 'pending' })[0];
  failure.value.classificationAttempts = 2;
  index.put('messages', failure.key, failure.value, { state: 'pending', due: stamp });
  await h.processing.close();
  const restarted = harness(t, { index, messages: [], folders: [] });
  assert.equal(index.get('messages', failure.key).classificationAttempts, 2);
  assert.equal(restarted.processing.status().migration.requeuedFailures, 41);
  assert.equal(restarted.metrics.model.length, 0); assert.equal(restarted.metrics.moves.length, 0);
});

test('failed body refresh obeys read deadlines and exhausts after three attempts while retaining its old protective result', async t => {
  const index = memoryIndex();
  const id = seed(index, mail(1, { unread: false }), classification('placeholder', ['invoices']), { complete: false });
  const original = index.get('messages', id).classification;
  let attempts = 0;
  const h = harness(t, { index, messages: [], folders: [], readerOverrides: {
    async readBatch(_, references) { attempts++; return { messages: [], errors: references.map(reference => ({ reference, code: 'mailbox_error' })) }; }
  } });
  await h.run();
  assert.equal(attempts, 1); assert.equal(index.get('messages', id).readAttempts, 1);
  for (let attempt = 2; attempt <= 3; attempt++) {
    const deadline = index.get('messages', id).readRetryAt;
    h.time(new Date(deadline - 1).toISOString()); await h.processing.action('start'); await h.processing.drain();
    assert.equal(attempts, attempt - 1);
    h.time(new Date(deadline).toISOString()); await h.processing.action('start'); await h.processing.drain();
    assert.equal(attempts, attempt);
  }
  assert.deepEqual(index.get('messages', id).classification, original);
  assert.equal(index.get('messages', id).readRetryAt, null);
  assert.equal(h.processing.status().counts.technicalFailures, 1);
  assert.equal(h.processing.status().counts.retrying, 0);
  assert.equal(h.metrics.model.length, 0); assert.equal(h.metrics.moves.length, 0);
  await h.processing.close();
  const restarted = harness(t, { index, messages: [], folders: [] }); restarted.time('2026-09-14T12:00:00Z');
  await restarted.run();
  assert.equal(restarted.metrics.reads.length, 0); assert.equal(restarted.metrics.model.length, 0); assert.equal(restarted.metrics.moves.length, 0);
  assert.deepEqual(index.get('messages', id).classification, original);
});

test('uncertain MOVE outcomes consume the persisted pilot cap before any second provider mutation', async t => {
  const index = memoryIndex();
  for (let uid = 1; uid <= 2; uid++) seed(index, mail(uid, { unread: false }), classification('placeholder'));
  const h = harness(t, { index, messages: [], folders: [], move: () => { throw new MailHarborError('mailbox_error'); } });
  await h.processing.configure({ maxActions: 1 });
  const status = await h.run();
  assert.equal(h.metrics.moves.length, 1);
  assert.equal(status.lastRun.actionAttempts, 1);
  assert.equal(index.get('meta', 'processingSettings').lastRun.actionAttempts, 1);
  assert.equal(status.counts.moved, 0);
  assert.equal(index.list('messages').filter(row => row.value.locations.some(location => location.intent)).length, 1);
  await h.processing.close();
  const restarted = harness(t, { index, messages: [], folders: [] }); restarted.time('2026-09-14T12:00:00Z');
  await restarted.run();
  assert.equal(restarted.metrics.moves.length, 0);
  assert.equal(index.get('meta', 'processingSettings').pilotCounters.actionAttempts, 1);
  await restarted.processing.action('start'); await restarted.processing.drain();
  assert.equal(restarted.metrics.moves.length, 0);
});

test('owner confirmation excludes concurrent writers and cannot undo a Pause received during its body read', async t => {
  const index = memoryIndex();
  index.put('meta', 'processingSettings', { enabled: true, providerConsent: true });
  const id = seed(index, mail(1, { unread: false }), classification('placeholder', ['jobs'], { confidence: 0.5 }));
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { index, messages: [], folders: [], readerOverrides: {
    async read(_, reference) { entered(); await gate; return { reference, body: 'Complete mail.', truncated: false, bodyUnavailable: false }; }
  } });
  const resolving = h.processing.resolveReview({ id, action: 'confirm', labels: ['jobs'] });
  await ready;
  assert.equal(h.processing.categoryMoveDeferred(account, index.get('messages', id).reference), true);
  await assert.rejects(h.processing.resolveReview({ id, action: 'keep' }), error => error.code === 'busy');
  await assert.rejects(h.processing.action('start'), error => error.code === 'busy');
  await h.processing.action('pause');
  release();
  const finished = await resolving;
  assert.equal(finished.enabled, false);
  assert.equal(h.processing.status().enabled, false);
  assert.equal(index.get('messages', id).ownerDecision.action, 'confirm');
  assert.equal(h.processing.categoryMoveDeferred(account, index.get('messages', id).reference), false);
  assert.equal(h.metrics.moves.length, 0); assert.equal(h.metrics.model.length, 0);
});

test('independent version migrations preserve owner decisions and unrelated retry budgets across restart', async t => {
  const versions = { processing: PROCESSING_VERSION, classifier: CLASSIFIER_VERSION, schema: SCHEMA_VERSION,
    prompt: PROMPT_VERSION, extractor: CONTENT_EXTRACTION_VERSION, policy: POLICY_VERSION };
  for (const changed of ['classifier', 'schema', 'prompt', 'extractor', 'policy']) await t.test(changed, async t => {
    const index = memoryIndex(), oldVersions = { ...versions, [changed]: changed === 'extractor' ? 'old-extractor' : versions[changed] - 1 };
    index.put('meta', 'processingSettings', { enabled: false, versions: oldVersions, reliabilityVersion: PROCESSING_VERSION });
    const future = stamp + 86400000;
    const add = (uid, result, overrides = {}) => {
      const id = seed(index, mail(uid, { unread: false }), result, { nextAt: future });
      const record = { ...index.get('messages', id), processingVersion: PROCESSING_VERSION, migrationKey: hash(oldVersions),
        extractionVersion: CONTENT_EXTRACTION_VERSION, ...overrides };
      index.put('messages', id, record);
      return id;
    };
    const kept = add(1, classification('placeholder', ['invoices']), { nextAt: null, complete: false, extractionVersion: oldVersions.extractor,
      ownerDecision: { action: 'keep', at: stamp - 1000 } });
    const confirmed = add(2, classification('placeholder', ['invoices']), { ownerDecision: { action: 'confirm', at: stamp - 1000 } });
    const exhausted = add(3, null, { classificationError: 'invalid_model_output', classificationErrorVersion: CLASSIFIER_VERSION,
      classificationRetryVersion: hash({ classifier: CLASSIFIER_VERSION, schema: SCHEMA_VERSION, prompt: PROMPT_VERSION }),
      classificationAttempts: 3, retryAt: null, nextAt: null, review: true });
    const relevantFailure = add(4, null, { classificationError: 'invalid_model_output', classificationErrorVersion: oldVersions.classifier,
      classificationAttempts: 3, retryAt: null, nextAt: null, review: true });
    const incomplete = add(5, classification('placeholder', ['invoices']), { complete: false, extractionVersion: oldVersions.extractor,
      readError: 'mailbox_error', readAttempts: 3, readRetryAt: null, retryAt: null, nextAt: null, review: true });
    const ordinary = add(6, classification('placeholder', ['invoices']));
    const replacement = add(7, classification('placeholder', ['invoices']), { classificationError: 'invalid_model_output',
      classificationErrorVersion: oldVersions.classifier, classificationAttempts: 3, retryAt: null, nextAt: null,
      refreshRequested: true, review: true });
    const protectedReplacement = copy(index.get('messages', replacement).classification);
    const ownerBefore = [kept, confirmed].map(id => index.get('messages', id));
    const h = harness(t, { index, messages: [], folders: [] });
    assert.equal(h.processing.status().enabled, false);
    for (const [position, id] of [kept, confirmed].entries()) {
      assert.deepEqual(index.get('messages', id).ownerDecision, ownerBefore[position].ownerDecision);
      assert.deepEqual(index.get('messages', id).classification, ownerBefore[position].classification);
    }
    assert.equal(index.list('messages', { state: 'done' }).some(row => row.key === kept), true);
    assert.equal(index.get('messages', kept).refreshRequested, undefined);
    assert.equal(index.get('messages', exhausted).classificationAttempts, 3);
    assert.equal(index.get('messages', exhausted).retryAt, null);
    const classifierChanged = ['classifier', 'schema', 'prompt'].includes(changed);
    assert.equal(index.get('messages', relevantFailure).classificationAttempts, classifierChanged ? 0 : 3);
    assert.equal(index.get('messages', relevantFailure).retryAt, classifierChanged ? stamp : null);
    assert.equal(index.get('messages', replacement).classificationAttempts, classifierChanged ? 0 : 3);
    assert.equal(index.get('messages', replacement).retryAt, classifierChanged ? stamp : null);
    assert.equal(index.list('messages', { state: 'pending' }).some(row => row.key === replacement), classifierChanged);
    assert.deepEqual(index.get('messages', replacement).classification, protectedReplacement);
    assert.equal(index.get('messages', ordinary).nextAt, changed === 'policy' ? stamp : future);
    if (changed === 'extractor') {
      const recovered = index.get('messages', incomplete);
      assert.equal(recovered.refreshRequested, true);
      assert.equal(recovered.readError, null);
      assert.equal(recovered.readAttempts, 0);
      assert.equal(index.list('messages', { state: 'pending' }).some(row => row.key === incomplete), true);
      assert.deepEqual(recovered.classification.labels, ['invoices']);
    } else assert.equal(index.get('messages', incomplete).readAttempts, 3);
    const after = index.list('messages');
    await h.processing.close();
    const restarted = harness(t, { index, messages: [], folders: [] });
    assert.deepEqual(index.list('messages'), after);
    assert.equal(restarted.metrics.model.length, 0); assert.equal(restarted.metrics.moves.length, 0);
    await restarted.processing.close();
    // Simulate failures since the migration, then an unrelated policy transition.
    // Old error/extraction versions remain deliberately untouched here.
    const pendingFailure = index.get('messages', relevantFailure); pendingFailure.classificationAttempts = 2;
    index.put('messages', relevantFailure, pendingFailure);
    const pendingReplacement = index.get('messages', replacement); pendingReplacement.classificationAttempts = 2;
    index.put('messages', replacement, pendingReplacement);
    const pendingRead = index.get('messages', incomplete); pendingRead.readAttempts = 2; pendingRead.readError = 'mailbox_error';
    index.put('messages', incomplete, pendingRead);
    const settings = index.get('meta', 'processingSettings'); settings.versions.policy = 'unrelated-old-policy';
    for (const { key, value } of index.list('messages')) {
      value.migrationKey = hash(settings.versions); index.put('messages', key, value);
    }
    index.put('meta', 'processingSettings', settings);
    const next = harness(t, { index, messages: [], folders: [] });
    assert.equal(index.get('messages', relevantFailure).classificationAttempts, 2);
    assert.equal(index.get('messages', replacement).classificationAttempts, 2);
    assert.deepEqual(index.get('messages', replacement).classification, protectedReplacement);
    assert.equal(index.get('messages', incomplete).readAttempts, 2);
    assert.equal(next.processing.status().enabled, false);
    assert.equal(next.metrics.model.length, 0); assert.equal(next.metrics.moves.length, 0);
  });
});

test('archive repair requeues only old Gmail Inbox checkpoints and preserves owners, intents and AI budgets', async t => {
  const index = memoryIndex();
  const versions = { processing: PROCESSING_VERSION, classifier: CLASSIFIER_VERSION, schema: SCHEMA_VERSION,
    prompt: PROMPT_VERSION, extractor: CONTENT_EXTRACTION_VERSION, policy: POLICY_VERSION };
  index.put('meta', 'processingSettings', { enabled: false, versions, reliabilityVersion: PROCESSING_VERSION,
    counts: { moved: 9, archived: 9 }, pilotCounters: { actionAttempts: 5, classified: 2 } });
  const add = (uid, overrides = {}) => {
    const message = mail(uid, { unread: false });
    const id = seed(index, message, classification('placeholder', ['security']), { nextAt: null });
    const record = index.get('messages', id);
    Object.assign(record, { migrationKey: hash(versions), extractionVersion: CONTENT_EXTRACTION_VERSION,
      classificationAttempts: 2, readAttempts: 2, archiveRecheckVersion: 0,
      locations: [{ ...record.locations[0], gmail: true, emailId: String(uid), handled: 'archive' }] }, overrides);
    index.put('messages', id, record);
    return id;
  };
  const repair = add(1), repairBefore = index.get('messages', repair);
  repairBefore.locations.push({ ...copy(repairBefore.locations[0]), role: 'archive', reference: { ...repairBefore.reference, path: 'All Mail', uid: 101 } });
  // A distinct physical copy must retain its independent checkpoint.
  repairBefore.locations.push({ ...copy(repairBefore.locations[0]), emailId: '999', reference: { ...repairBefore.reference, path: 'Copy', uid: 201 } });
  index.put('messages', repair, repairBefore);
  const destination = add(2);
  const destinationRecord = index.get('messages', destination);
  destinationRecord.reference = { ...destinationRecord.reference, path: 'All Mail', uid: 102 };
  index.put('messages', destination, destinationRecord);
  const nonGmail = add(3);
  const nonGmailRecord = index.get('messages', nonGmail); nonGmailRecord.locations[0].gmail = false;
  index.put('messages', nonGmail, nonGmailRecord);
  const kept = add(4, { ownerDecision: { action: 'keep', at: stamp - 1 } });
  const confirmed = add(5, { ownerDecision: { action: 'confirm', at: stamp - 1 } });
  const intent = add(6);
  const intentRecord = index.get('messages', intent); intentRecord.locations[0].intent = { action: 'archive', at: stamp - 1 };
  index.put('messages', intent, intentRecord);
  const repairedBefore = add(7, { archiveRecheckVersion: 1 });
  const unchanged = [destination, nonGmail, kept, confirmed, intent, repairedBefore].map(id => [id, copy(index.get('messages', id))]);
  const h = harness(t, { index, messages: [], folders: [] });
  const repaired = index.get('messages', repair);
  assert.deepEqual(repaired.locations.map(location => location.handled), [null, null, 'archive']);
  assert.deepEqual(repaired.classification, repairBefore.classification);
  assert.equal(repaired.nextAt, stamp); assert.equal(repaired.archiveRecheckVersion, 1);
  assert.equal(repaired.classificationAttempts, 2); assert.equal(repaired.readAttempts, 2);
  for (const [id, before] of unchanged) {
    const after = index.get('messages', id);
    assert.deepEqual(after.locations, before.locations);
    assert.deepEqual(after.classification, before.classification);
    assert.deepEqual(after.ownerDecision, before.ownerDecision);
    assert.equal(after.nextAt, before.nextAt);
  }
  assert.equal(h.processing.status().enabled, false);
  assert.equal(h.processing.status().migration.archiveRechecks, 1);
  assert.equal(h.processing.status().counts.moved, 9);
  assert.equal(h.processing.status().pilot.actionAttempts, 5);
  assert.equal(h.metrics.model.length, 0); assert.equal(h.metrics.moves.length, 0);
  const afterMigration = index.list('messages');
  await h.processing.close();
  const reopened = harness(t, { index, messages: [], folders: [] });
  assert.deepEqual(index.list('messages'), afterMigration);
  assert.equal(reopened.processing.status().migration.archiveRechecks, 1);
});

test('mailbox writer drains the paid classification and yields before another model or retention batch', { timeout: 5000 }, async t => {
  const index = memoryIndex();
  index.put('meta', 'processingSettings', { batchSize: 1 });
  let entered, release, modelSignal, writerEntered = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { index, messages: [mail(1), mail(2)], classify: async (request, signal) => {
    modelSignal = signal; entered(); await gate;
    return { items: request.messages.map(message => classification(message.id)) };
  } });
  await h.processing.configure({ providerConsent: true, maxClassifications: 10 });
  await h.processing.action('start');
  await ready;
  const writing = h.processing.withMailboxWrite(async () => {
    writerEntered = true;
    assert.equal(h.processing.status().running, false);
    assert.equal(modelSignal.aborted, false);
    assert.equal(h.metrics.model.length, 1);
    assert.equal(h.metrics.moves.length, 0);
    assert.equal(h.processing.status().counts.analyzed, 1);
    assert.equal(h.processing.status().pilot.classified, 1);
    return 'checkpointed';
  });
  await Promise.resolve();
  assert.equal(writerEntered, false);
  assert.equal(modelSignal.aborted, false);
  release();
  assert.equal(await writing, 'checkpointed');
  assert.equal(h.processing.status().enabled, true);
  assert.equal(h.metrics.model.length, 1);
  assert.equal(h.metrics.moves.length, 0);
  assert.equal(index.list('messages', { state: 'pending' }).length, 1);
});

test('mailbox writer excludes other writers and cannot undo a user Pause', { timeout: 5000 }, async t => {
  const index = memoryIndex();
  index.put('meta', 'processingSettings', { enabled: true, providerConsent: true });
  const id = seed(index, mail(1, { unread: false }), classification('placeholder', ['invoices']));
  const h = harness(t, { index, messages: [], folders: [] });
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const writing = h.processing.withMailboxWrite(async () => { entered(); await gate; });
  await ready;
  await assert.rejects(h.processing.withMailboxWrite(() => {}), error => error.code === 'busy');
  await assert.rejects(h.processing.resolveReview({ id, action: 'keep' }), error => error.code === 'busy');
  await assert.rejects(h.processing.configure({ tenderGraceDays: 2 }), error => error.code === 'busy');
  await assert.rejects(h.processing.action('start'), error => error.code === 'busy');
  await assert.rejects(h.processing.action('preview'), error => error.code === 'busy');
  await h.processing.action('pause');
  release(); await writing;
  assert.equal(h.processing.status().enabled, false);
  assert.equal(h.metrics.model.length, 0);
  assert.equal(h.metrics.moves.length, 0);
  // A failed writer also releases exclusivity without changing the user's state.
  await assert.rejects(h.processing.withMailboxWrite(() => { throw new Error('failed operation'); }), /failed operation/u);
  await h.processing.withMailboxWrite(() => {});
  assert.equal(h.processing.status().enabled, false);
});

test('mailbox writer preserves a quota backoff completed while draining classification', { timeout: 5000 }, async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { classify: async () => { entered(); await gate; throw new MailHarborError('quota_exhausted'); } });
  await h.processing.configure({ providerConsent: true, maxClassifications: 3, maxActions: 2 });
  await h.processing.action('start'); await ready;
  let backoff;
  const writing = h.processing.withMailboxWrite(() => { backoff = h.processing.status().retryAt; });
  release(); await writing;
  const result = h.processing.status();
  assert.equal(result.enabled, true);
  assert.equal(result.pauseReason, 'quota_exhausted');
  assert.equal(result.retryAt, backoff);
  assert.ok(Date.parse(backoff) > stamp);
  assert.equal(result.pilot.maxClassifications, 3);
  assert.equal(result.pilot.maxActions, 2);
  assert.equal(result.pilot.classified, 0);
  assert.equal(result.pilot.actionAttempts, 0);
  assert.equal(h.metrics.model.length, 1);
});

test('category relocation updates only the verified location and retains classification and retention checkpoints', async t => {
  const index = memoryIndex(), message = mail(1, { unread: false });
  const id = seed(index, message, classification('placeholder', ['invoices', 'newsletters']));
  const h = harness(t, { index, messages: [], folders: [] });
  const before = index.get('messages', id);
  Object.assign(before, { nextAt: stamp + 60000, ownerDecision: { action: 'confirm', at: stamp - 5000 },
    classificationAttempts: 2, readAttempts: 1, complete: true, lastHandledAt: stamp - 1000 });
  before.locations.push({ ...copy(before.locations[0]), reference: { ...before.reference, path: 'Copies', uid: 99 } });
  index.put('messages', id, before);
  const source = copy(before.reference), target = { ...source, path: 'MailHarbor - Invoices', uidValidity: '200', uid: 501 };
  assert.equal(h.processing.canRelocateCategory(account, source), false);
  assert.throws(() => h.processing.relocateCategory(account, source, target), error => error.code === 'busy');
  const result = await h.processing.withMailboxWrite(() => {
    assert.equal(h.processing.canRelocateCategory(account, source), true);
    assert.deepEqual(index.get('messages', id), before);
    return h.processing.relocateCategory(account, source, target);
  });
  assert.deepEqual(result, { updated: true });
  const expected = copy(before);
  expected.reference = target; expected.message.folderPath = target.path;
  expected.locations[0].reference = target; expected.locations[0].role = 'other';
  assert.deepEqual(index.get('messages', id), expected);
  assert.equal(index.list('messages', { before: stamp + 60000, state: 'ready' })[0].key, id);
  assert.equal(h.metrics.model.length, 0); assert.equal(h.metrics.moves.length, 0);
  assert.deepEqual(await h.processing.withMailboxWrite(() => h.processing.relocateCategory(account, target, target)), { updated: false });
  assert.equal(await h.processing.withMailboxWrite(() => h.processing.canRelocateCategory(account, source)), false);
  const unseen = mail(55).reference;
  assert.equal(await h.processing.withMailboxWrite(() => h.processing.canRelocateCategory(account, unseen)), true);
  assert.deepEqual(await h.processing.withMailboxWrite(() => h.processing.relocateCategory(account, unseen, { ...unseen, path: target.path })), { updated: false });
});

test('category relocation rejects intents, protected roles, completed retention and stale identities', async t => {
  const index = memoryIndex(), message = mail(1, { unread: false });
  const id = seed(index, message, classification('placeholder', ['invoices']));
  const h = harness(t, { index, messages: [], folders: [] });
  const original = index.get('messages', id), source = original.reference;
  const target = { ...source, path: 'MailHarbor - Invoices', uid: 500 };
  const cases = [
    ...['sent', 'drafts', 'junk', 'trash', 'archive'].map(role => ({ mutate: record => { record.locations[0].role = role; } })),
    ...['archive', 'trash', 'rescue', 'absent', 'changed', 'target_unavailable'].map(handled => ({ mutate: record => { record.locations[0].handled = handled; } })),
    { mutate: record => { record.locations[0].gmail = true; record.locations[0].emailId = '123'; } },
    { mutate: record => { record.ownerDecision = { action: 'keep', at: stamp }; } },
    { code: 'busy', mutate: record => { record.locations[0].intent = { action: 'archive', at: stamp }; } },
    { mutate: record => { record.locations[0].reference.uidValidity = '999'; } },
    { mutate: record => { record.locations = []; } }
  ];
  for (const { mutate, code = 'stale_message' } of cases) {
    const record = copy(original); mutate(record); index.put('messages', id, record);
    assert.equal(await h.processing.withMailboxWrite(() => h.processing.categoryMoveDeferred(account, source)), code === 'busy');
    assert.equal(await h.processing.withMailboxWrite(() => h.processing.canRelocateCategory(account, source)), false);
    await assert.rejects(h.processing.withMailboxWrite(() => h.processing.relocateCategory(account, source, target)), error => error.code === code);
    assert.deepEqual(index.get('messages', id), record);
  }
  index.put('messages', id, original);
  assert.equal(await h.processing.withMailboxWrite(() => h.processing.canRelocateCategory({ ...account, revision: 'reconnected' }, source)), false);
  assert.equal(await h.processing.withMailboxWrite(() => h.processing.canRelocateCategory(account, { ...source, uid: 0 })), false);
  await assert.rejects(h.processing.withMailboxWrite(() => h.processing.relocateCategory({ ...account, revision: 'reconnected' }, source, target)), error => error.code === 'stale_message');
  await assert.rejects(h.processing.withMailboxWrite(() => h.processing.relocateCategory(account, source, { ...target, fingerprint: hash('other') })), error => error.code === 'stale_message');
  assert.deepEqual(index.get('messages', id), original);
});

test('custom manual labels do not invalidate classification or weaken built-in retention protection', async t => {
  const h = harness(t, { tagsOverrides: { manualFor: () => ['custom_0123456789abcdef0123456789abcdef', 'invoices'] } });
  const result = await h.run();
  assert.equal(result.lastRun.status, 'completed');
  assert.equal(result.counts.analyzed, 1);
  assert.equal(result.counts.errors, 0);
  assert.equal(h.metrics.moves.length, 0);
  assert.equal(h.metrics.model.length, 1);
  assert.deepEqual(h.index.get('messages', keyOf(mail())).classification.labels, ['jobs']);
  assert.equal(h.index.get('messages', keyOf(mail())).nextAt, Date.parse('2033-01-01T12:00:00Z'));
});

test('pending category journal preserves its source and blocks organizer mutations while unrelated mail proceeds', { timeout: 5000 }, async t => {
  const index = memoryIndex(), source = mail(), key = seed(index, source, classification('placeholder'));
  const targetReference = { ...source.reference, path: 'MailHarbor/Jobs', uid: 501, uidValidity: '100' };
  const target = { ...copy(source), folderPath: targetReference.path, role: 'other', reference: targetReference };
  index.put('labelSync', key, { intent: { source: source.reference, destinationPath: targetReference.path } });
  const h = harness(t, { index, messages: [source, target, mail(2)] });
  const original = index.get('messages', key);
  const result = await h.run();
  assert.equal(result.lastRun.status, 'completed');
  assert.deepEqual(index.get('messages', key), original);
  assert.deepEqual(h.metrics.marked.map(reference => reference.uid), [2]);
  assert.deepEqual(h.metrics.reads.map(reference => reference.uid), [2]);
  assert.deepEqual(h.metrics.moves.map(item => item.reference.uid), [2]);
  assert.equal(h.metrics.model.length, 1);
  assert.equal(index.list('messages', { state: 'ready', before: stamp }).some(row => row.key === key), false);
  await assert.rejects(h.processing.resolveReview({ id: key, action: 'keep' }), error => error.code === 'busy');
  await assert.rejects(h.processing.reviewMessage(key), error => error.code === 'busy');
  assert.deepEqual(index.get('messages', key), original);
  await h.processing.withMailboxWrite(() => {
    assert.equal(h.processing.canRelocateCategory(account, source.reference), true);
    assert.deepEqual(h.processing.relocateCategory(account, source.reference, targetReference), { updated: true });
    index.remove('labelSync', key);
  });
  assert.equal(index.get('messages', key).nextAt, original.nextAt);
  await h.processing.action('start'); await h.processing.drain();
  assert.equal(h.metrics.model.length, 1);
  assert.deepEqual(h.metrics.moves.map(item => item.reference.uid), [2, 501]);
  assert.deepEqual(index.get('messages', key).classification, original.classification);
});

test('journal-held pending mail cannot monopolize classification slots or spend model requests', { timeout: 5000 }, async t => {
  const index = memoryIndex();
  index.put('meta', 'processingSettings', { batchSize: 1 });
  const blocked = [];
  for (let uid = 1; uid <= 15; uid++) {
    const message = mail(uid, { receivedAt: '2010-01-01T12:00:00Z' });
    const key = seed(index, message, null);
    index.put('labelSync', key, { intent: { source: message.reference, destinationPath: 'MailHarbor/Jobs' } });
    blocked.push(key);
  }
  const h = harness(t, { index, messages: [mail(99)] });
  const before = blocked.map(key => index.get('messages', key));
  const result = await h.run();
  assert.equal(result.lastRun.status, 'completed');
  assert.equal(h.metrics.model.length, 1);
  assert.deepEqual(h.metrics.reads.map(reference => reference.uid), [99]);
  assert.deepEqual(h.metrics.marked.map(reference => reference.uid), [99]);
  assert.deepEqual(h.metrics.moves.map(item => item.reference.uid), [99]);
  assert.deepEqual(blocked.map(key => index.get('messages', key)), before);
});

test('unindexed journal-held mail remains discoverable after recovery without changing its location first', { timeout: 5000 }, async t => {
  const index = memoryIndex(), source = mail(), key = keyOf(source);
  const targetReference = { ...source.reference, path: 'MailHarbor/Jobs', uid: 501 };
  const target = { ...copy(source), folderPath: targetReference.path, role: 'other', reference: targetReference };
  index.put('labelSync', key, { intent: { source: source.reference, destinationPath: targetReference.path } });
  const h = harness(t, { index, messages: [target, mail(2)] });
  await h.run();
  assert.equal(index.get('messages', key), null);
  assert.deepEqual(h.metrics.reads.map(reference => reference.uid), [2]);
  const cursor = index.get('folders', hash([account.id, account.email, targetReference.path]));
  assert.ok(cursor.afterUid < 501);
  assert.equal(cursor.done, false);
  await h.processing.withMailboxWrite(() => {
    assert.equal(h.processing.canRelocateCategory(account, source.reference), true);
    assert.deepEqual(h.processing.relocateCategory(account, source.reference, targetReference), { updated: false });
    index.remove('labelSync', key);
  });
  await h.processing.action('start'); await h.processing.drain();
  assert.deepEqual(h.metrics.reads.map(reference => reference.uid), [2, 501]);
  assert.equal(h.metrics.model.length, 2);
  assert.equal(index.get('messages', key).classification.labels[0], 'jobs');
});

test('category moves wait for queued or protected invoice filing and become eligible after successful filing', async t => {
  const index = memoryIndex(), source = mail(1, { unread: false }), key = seed(index, source, classification('placeholder', ['invoices']));
  const target = { ...source.reference, path: 'MailHarbor/Invoices', uid: 500 };
  const ledger = { sources: {}, records: {} };
  const h = harness(t, { index, messages: [], folders: [], store: { read: () => ({ invoiceFiling: copy(ledger) }) } });
  const original = index.get('messages', key);
  const blocked = async () => h.processing.withMailboxWrite(async () => {
    assert.equal(h.processing.categoryMoveDeferred(account, source.reference), true);
    assert.equal(h.processing.canRelocateCategory(account, source.reference), false);
    assert.throws(() => h.processing.relocateCategory(account, source.reference, target), error => error.code === 'busy');
    assert.deepEqual(index.get('messages', key), original);
  });
  index.put('invoiceQueue', key, { reference: source.reference });
  await blocked();
  index.remove('invoiceQueue', key);
  ledger.sources[key] = { complete: false, recordIds: [] };
  await blocked();
  ledger.sources[key] = { complete: true, recordIds: ['invoice-one'] };
  ledger.records['invoice-one'] = { status: 'waiting_drive' };
  await blocked();
  ledger.records['invoice-one'].status = 'needs_review';
  await blocked();
  ledger.records['invoice-one'].status = 'filed';
  await h.processing.withMailboxWrite(() => {
    assert.equal(h.processing.categoryMoveDeferred(account, source.reference), false);
    assert.equal(h.processing.canRelocateCategory(account, source.reference), true);
    assert.deepEqual(h.processing.relocateCategory(account, source.reference, target), { updated: true });
  });
  assert.equal(index.get('messages', key).reference.path, target.path);
  const unseen = mail(55).reference, unseenKey = keyOf(mail(55));
  index.put('invoiceQueue', unseenKey, { reference: unseen });
  await h.processing.withMailboxWrite(() => {
    assert.equal(h.processing.categoryMoveDeferred(account, unseen), true);
    assert.equal(h.processing.canRelocateCategory(account, unseen), false);
    assert.throws(() => h.processing.relocateCategory(account, unseen, { ...unseen, path: target.path }), error => error.code === 'busy');
  });
  assert.equal(index.get('messages', unseenKey), null);
});
