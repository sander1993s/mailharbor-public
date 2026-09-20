import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccountStore } from '../server/account-store.mjs';
import { createMailIndex } from '../server/mail-index.mjs';
import { createMailProcessing } from '../server/mail-processing.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const stamp = Date.parse('2026-09-17T12:00:00Z');
const account = { id: 'fixture', email: 'fixture@example.test', revision: 'one', connected: true, label: 'Synthetic account' };
const keyOf = message => hash([account.id, account.email, message.reference.fingerprint]);
const mail = uid => ({ accountId: account.id, account: account.label, subject: `Synthetic message ${uid}`, author: 'sender@example.test',
  to: account.email, folderPath: 'INBOX', role: 'inbox', date: '2026-01-01T12:00:00Z', receivedAt: '2026-01-01T12:00:00Z',
  unread: false, starred: false, reference: { accountId: account.id, path: 'INBOX', uid, uidValidity: '1', fingerprint: hash(`fixture-${uid}`) } });
const classification = (id, labels = ['jobs'], confidence = 0.99) => ({ id, labels, confidence, junk: 'legitimate', junkConfidence: 0.99,
  dates: { couponExpiry: null, tenderDeadline: null, appointmentStart: null, appointmentEnd: null }, dateConfidence: 0.99, appointment: null });

async function fixture(t, messages = [mail(1)]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mailharbor-safety-'));
  const store = await createAccountStore(directory), indices = new Set(), processors = new Set(), databases = new Set();
  const metrics = { reads: [], models: [], moves: [], marks: [], tags: [], events: [] };
  let onMove = null, onObserve = null, current = stamp;
  const reader = {
    async folders() { return { folders: [{ path: 'INBOX', role: 'inbox' }] }; },
    async scan(_, { afterUid = 0, limit = 100 }) {
      const found = messages.filter(message => message.reference.uid > afterUid).slice(0, limit);
      return { messages: copy(found), afterUid: found.at(-1)?.reference.uid ?? afterUid,
        uidValidity: '1', highWatermark: messages.at(-1)?.reference.uid ?? 0, done: true };
    },
    async read(_, reference, { verify } = {}) {
      verify?.(); metrics.reads.push(copy(reference));
      return { ...copy(messages.find(message => message.reference.fingerprint === reference.fingerprint)), reference: copy(reference),
        body: 'PRIVATE_BODY_MUST_NEVER_PERSIST', bodyUnavailable: false, truncated: false, contentReasons: [], extractionVersion: '2' };
    },
    async readBatch(value, references, options) {
      const result = [];
      for (const reference of references) result.push(await reader.read(value, reference, options));
      return { messages: result, errors: [] };
    },
    async markRead(_, references, { verify } = {}) {
      verify?.(); metrics.marks.push(...copy(references));
      return { results: references.map(reference => ({ reference, status: 'already_read' })) };
    },
    async move(_, reference, action, { verify } = {}) {
      verify?.(); metrics.moves.push({ reference: copy(reference), action }); metrics.events.push('provider_move');
      await onMove?.(reference, action);
      return { status: 'applied', reference: { ...reference, path: 'Trash', uid: reference.uid + 1000 }, targetPath: 'Trash' };
    }
  };
  t.after(async () => {
    for (const processor of processors) await processor.close();
    for (const db of databases) db.close();
    for (const index of indices) index.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    metrics,
    async index() { const value = await createMailIndex(directory); indices.add(value); return value; },
    seed(index, message, result = classification(keyOf(message))) {
      const key = keyOf(message);
      index.put('messages', key, { key, accountId: account.id, email: account.email, message: copy(message), reference: copy(message.reference),
        receivedAt: message.receivedAt, discoveredAt: stamp, locations: [{ reference: copy(message.reference), role: 'inbox', read: true, handled: null }],
        classification: result, complete: true, nextAt: stamp, review: false },
      { state: result ? 'ready' : 'pending', due: stamp });
      return key;
    },
    processor(index) {
      const value = createMailProcessing({ index, store, reader, accounts: { list: () => [copy(account)], get: () => copy(account) },
        tags: { manualFor: () => [], async automatic(value) { metrics.events.push('tag_write'); metrics.tags.push(copy(value.reference)); },
          async observe(...args) { await onObserve?.(...args); } },
        classify: async request => { metrics.models.push(copy(request)); return { items: request.messages.map(message => classification(message.id)) }; },
        now: () => current, autoSchedule: false });
      processors.add(value); return value;
    },
    async closeProcessor(processor) { await processor.close(); processors.delete(processor); },
    closeIndex(index) { index.close(); indices.delete(index); },
    sql() { const db = new DatabaseSync(path.join(directory, 'mail-index.sqlite')); databases.add(db); return db; },
    onMove(callback) { onMove = callback; },
    onObserve(callback) { onObserve = callback; },
    time(value) { current = value; },
    async run(processor, action = 'start') {
      await processor.configure({ providerConsent: true }); await processor.action(action); await processor.drain(); return processor.status();
    }
  };
}

test('owner Keep persists across SQLite reopen and suppresses classification and moves after rediscovery', async t => {
  const h = await fixture(t), first = await h.index(), key = h.seed(first, mail(1), null);
  const original = h.processor(first);
  await original.resolveReview({ id: key, action: 'keep' });
  assert.equal(first.get('messages', key).ownerDecision.action, 'keep');
  await h.closeProcessor(original); h.closeIndex(first);
  const reopened = await h.index(), restarted = h.processor(reopened);
  await h.run(restarted);
  const saved = reopened.get('messages', key);
  assert.equal(saved.ownerDecision.action, 'keep'); assert.equal(saved.classification, null);
  assert.deepEqual(h.metrics.models, []); assert.deepEqual(h.metrics.moves, []);
  assert.equal(restarted.reviewList({ category: 'review' }).items.length, 0);
  assert.equal(restarted.reviewList({ category: 'held' }).items[0].id, key);
});

test('failed post-MOVE label refresh recovers from its committed destination after SQLite reopen without another MOVE', async t => {
  const h = await fixture(t), index = await h.index(), key = h.seed(index, mail(1)), processor = h.processor(index);
  h.onObserve(() => { throw new Error('synthetic label refresh failure'); });
  const status = await h.run(processor);
  assert.equal(status.lastRun.status, 'failed');
  assert.equal(h.metrics.moves.length, 1);
  const saved = index.get('messages', key);
  assert.equal(saved.locations[0].handled, 'trash'); assert.equal(saved.locations[0].intent, null);
  assert.equal(saved.reference.path, 'Trash'); assert.equal(saved.tagRefreshPending, true);
  assert.ok(saved.nextAt != null, 'The committed destination still has due metadata recovery work');
  await h.closeProcessor(processor); h.closeIndex(index);
  h.onObserve(null); h.time(stamp + 3600000);
  const reopened = await h.index(), restarted = h.processor(reopened), tagCount = h.metrics.tags.length;
  await h.run(restarted);
  const recovered = reopened.get('messages', key);
  assert.equal(recovered.tagRefreshPending, false);
  assert.equal(recovered.locations[0].handled, 'trash');
  assert.deepEqual(h.metrics.tags.slice(tagCount), [saved.reference]);
  assert.equal(h.metrics.moves.length, 1, 'Refreshing local labels must not replay the committed external MOVE');
  assert.deepEqual(h.metrics.models, [], 'The cached classification is reused');
});

test('SQLITE_FULL on the actual index connection rolls back state and blocks subsequent writes until reopen', async t => {
  const h = await fixture(t);
  // max_page_count is connection-local. Capture only the real connection opened
  // for this index; all SQL and persistence still run through native SQLite.
  const originalExec = DatabaseSync.prototype.exec;
  let database, index;
  DatabaseSync.prototype.exec = function(...args) { database ??= this; return originalExec.apply(this, args); };
  try { index = await h.index(); } finally { DatabaseSync.prototype.exec = originalExec; }
  assert.ok(database);
  const key = h.seed(index, mail(1)), original = index.get('messages', key), summary = index.processingSummary();
  const pages = database.prepare('PRAGMA page_count').get().page_count;
  assert.equal(database.prepare(`PRAGMA max_page_count=${pages}`).get().max_page_count, pages);
  assert.throws(() => index.put('messages', key, { ...original, fixturePadding: 'x'.repeat(1024 * 1024) },
    { state: 'pending', analysis: 'pending', category: 'failed', reasons: ['fixture_full'] }), error => {
    assert.equal(error.errcode, 13, 'The injected failure must be SQLITE_FULL, not a generic mocked exception');
    return true;
  });
  assert.equal(index.healthy(), false);
  assert.deepEqual(index.get('messages', key), original); assert.deepEqual(index.processingSummary(), summary);
  assert.throws(() => index.put('messages', 'must-not-persist', {}), /requires recovery/u);
  assert.throws(() => index.claimLease('processor', 'must-not-start', stamp), /requires recovery/u);
  h.closeIndex(index);
  const reopened = await h.index();
  assert.deepEqual(reopened.get('messages', key), original); assert.deepEqual(reopened.processingSummary(), summary);
  assert.equal(reopened.get('messages', 'must-not-persist'), null);
  assert.equal(reopened.healthy(), true);
});

test('confirmed categories preserve invoice protection in SQLite and live review bodies stay outside durable records', async t => {
  const h = await fixture(t), first = await h.index();
  const key = h.seed(first, mail(1), classification(keyOf(mail(1)), ['invoices'], 0.5));
  const processor = h.processor(first);
  await processor.resolveReview({ id: key, action: 'confirm', labels: ['jobs'] });
  const confirmed = first.get('messages', key);
  assert.deepEqual(confirmed.classification.labels, ['invoices', 'jobs']);
  assert.equal(confirmed.classification.confidence, 1); assert.equal(confirmed.ownerDecision.action, 'confirm');
  assert.equal(JSON.stringify(first.list('messages')).includes('PRIVATE_BODY_MUST_NEVER_PERSIST'), false);
  await h.closeProcessor(processor); h.closeIndex(first);
  const reopened = await h.index(), restarted = h.processor(reopened);
  await h.run(restarted);
  assert.deepEqual(reopened.get('messages', key).classification.labels, ['invoices', 'jobs']);
  assert.deepEqual(h.metrics.moves, [], 'Seven-year invoice protection survives confirm, restart and processing');
  assert.deepEqual(h.metrics.models, [], 'A confirmed cached classification is reused');
  assert.equal(JSON.stringify(reopened.list('messages')).includes('PRIVATE_BODY_MUST_NEVER_PERSIST'), false);
});

test('a second processor cannot migrate or run while the first owns the SQLite lease; close permits restart', async t => {
  const h = await fixture(t), first = await h.index(), second = await h.index();
  const key = h.seed(first, mail(1));
  const processor = h.processor(first), saved = first.get('meta', 'processingSettings');
  assert.throws(() => h.processor(second), { code: 'busy' });
  assert.deepEqual(first.get('meta', 'processingSettings'), saved);
  assert.equal(second.get('messages', key).classification.id, key);
  await h.closeProcessor(processor);
  const replacement = h.processor(second);
  assert.equal(replacement.status().running, false);
  assert.equal(replacement.status().counts.analyzed, 1);
  await h.run(replacement, 'preview');
  assert.deepEqual(h.metrics.moves, []); assert.deepEqual(h.metrics.marks, []);
});

test('a failed SQLite move checkpoint stops following provider effects and preserves the durable uncertain intent', async t => {
  const h = await fixture(t, [mail(1), mail(2)]), index = await h.index();
  const keys = [h.seed(index, mail(1)), h.seed(index, mail(2))], processor = h.processor(index), sql = h.sql();
  h.onMove(() => {
    sql.exec("CREATE TRIGGER fixture_failed_checkpoint BEFORE UPDATE ON documents WHEN NEW.kind='messages' BEGIN SELECT RAISE(ABORT, 'fixture failed checkpoint'); END;");
    h.metrics.events.push('storage_failure_armed');
  });
  await assert.rejects(h.run(processor));
  assert.equal(index.healthy(), false); assert.equal(h.metrics.moves.length, 1);
  assert.deepEqual(h.metrics.events.slice(h.metrics.events.indexOf('storage_failure_armed')), ['storage_failure_armed']);
  const movedKey = keys.find(key => index.get('messages', key).reference.uid === h.metrics.moves[0].reference.uid);
  assert.equal(index.get('messages', movedKey).locations[0].handled, null);
  assert.equal(index.get('messages', movedKey).locations[0].intent.action, 'trash');
  assert.equal(processor.status().workerState, 'blocked');
  assert.equal(processor.status().enabled, false);
  await assert.rejects(processor.action('start'), { code: 'configuration_error' });
  assert.equal(h.metrics.moves.length, 1);
  sql.exec('DROP TRIGGER fixture_failed_checkpoint;');
  await h.closeProcessor(processor); h.closeIndex(index);
  const reopened = await h.index();
  assert.equal(reopened.get('messages', movedKey).locations[0].intent.action, 'trash');
  assert.equal(reopened.get('messages', movedKey).locations[0].handled, null);
  assert.ok(keys.every(key => reopened.get('messages', key).classification.labels.includes('jobs')));
});
