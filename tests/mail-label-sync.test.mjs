import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailIndex } from '../server/mail-index.mjs';
import { createMailLabelSync, categoryNames, primaryCategory } from '../server/mail-label-sync.mjs';

const reference = { accountId: 'mail', path: 'INBOX', uid: 7, uidValidity: '12', fingerprint: 'a'.repeat(64) };
const target = { ...reference, path: 'MailHarbor/Invoices', uid: 20, uidValidity: '34' };
const account = { id: 'mail', provider: 'imap', email: 'mail@example.test', revision: 'one' };
const definitions = [{ id: 'invoices', label: 'Invoices' }, { id: 'newsletters', label: 'Newsletters' }, { id: 'custom_receipts', label: 'Receipts' }];
const tagged = (extra = {}) => ({ accountId: account.id, email: account.email, reference, tags: ['invoices'], manual: [], message: { date: '2026-09-18', messageId: '<one@example.test>', folderPath: 'INBOX' }, ...extra });
async function setup(t, options = {}) {
  const index = await createMailIndex(); let clock = 10000, current = { ...account, ...options.account }, writer = false, allowed = true;
  const calls = [], relocated = [], changed = [];
  const processing = {
    async withMailboxWrite(work) { assert.equal(writer, false); writer = true; try { return await work(); } finally { writer = false; } },
    canRelocateCategory() { assert.equal(writer, true); return allowed; },
    relocateCategory(...args) { assert.equal(writer, true); relocated.push(args); }
  };
  const reader = { async sync(acct, entries, callbacks) {
    assert.equal(writer, true); calls.push(structuredClone(entries));
    if (options.sync) return options.sync(acct, entries, callbacks, index);
    for (const entry of entries) {
      await callbacks.verify(entry);
      await callbacks.beforeMove(entry, { source: entry.reference, destinationPath: target.path, messageId: entry.message.messageId });
      await callbacks.onResult(entry, { status: 'synced', reference: target, managedLabels: [], kind: 'folders', moved: true });
    }
    return { results: [] };
  } };
  let defs = structuredClone(definitions), worker;
  const create = () => createMailLabelSync({ index, accounts: { get: () => structuredClone(current) }, tags: { definitions: () => defs }, processing, reader,
    now: () => clock, autoSchedule: false, changed: id => changed.push(id) });
  worker = create();
  t.after(async () => { await worker.close(); index.close(); });
  return { index, calls, relocated, changed, processing, get worker() { return worker; }, add: (key = 'one', value = tagged()) => index.putTag(key, value),
    advance() { clock += 120000; }, disallow() { allowed = false; }, reconnect() { current.revision = 'two'; }, rename() { defs[0].label = 'Bills'; },
    async restart() { await worker.close(); worker = create(); } };
}

test('primary category prefers explicit custom labels and names are safe and distinct', () => {
  assert.equal(primaryCategory(tagged({ tags: ['invoices', 'newsletters'], manual: ['newsletters'] }), definitions), 'newsletters');
  assert.equal(primaryCategory(tagged({ tags: ['invoices', 'custom_receipts'], manual: ['invoices', 'custom_receipts'] }), definitions), 'custom_receipts');
  assert.equal(primaryCategory(tagged({ tags: ['unknown'] }), definitions), null);
  const names = categoryNames([{ id: 'one', label: 'A/B%' }, { id: 'two', label: 'A:B%' }]);
  assert.equal(new Set(names.values()).size, 2);
  assert.ok([...names.values()].every(name => /^MailHarbor\/[^/%:*]+$/u.test(name)));
});

test('tag writes atomically queue work; exact relocation and tag reference commit together', async t => {
  const h = await setup(t); h.add();
  assert.equal(h.index.get('labelSync', 'one').state, 'pending');
  await h.worker.poll();
  assert.equal(h.worker.status().synced, 1); assert.equal(h.worker.status().pending, 0);
  assert.deepEqual(h.relocated[0], [account, reference, target]);
  assert.deepEqual(h.index.get('tags', 'one').reference, target);
  assert.equal(h.index.get('labelSync', 'one').intent, null);
  assert.deepEqual(h.index.get('labelSync', 'one').retiredReferences, [{ reference, retiredAt: 10000 }]);
  assert.deepEqual(h.changed, ['mail']);
  await h.worker.poll(); assert.equal(h.calls.length, 1);
});

test('failed outer transaction rolls back both tag and sync journal', async t => {
  const h = await setup(t);
  assert.throws(() => h.index.transaction(() => { h.add(); throw new Error('rollback'); }));
  assert.equal(h.index.get('tags', 'one'), null); assert.equal(h.index.get('labelSync', 'one'), null);
});

test('equivalent reordered source references still adopt a confirmed destination', async t => {
  const h = await setup(t, { sync: async (acct, entries, cb, index) => {
    const entry = entries[0];
    index.putTag(entry.key, tagged({ reference: { fingerprint: reference.fingerprint, uidValidity: reference.uidValidity, uid: reference.uid, path: reference.path, accountId: reference.accountId } }));
    await cb.onResult(entry, { status: 'synced', reference: target, managedLabels: [], moved: true }); return { results: [] };
  } });
  h.add(); await h.worker.poll(); assert.deepEqual(h.index.get('tags', 'one').reference, target);
});

test('legacy stored tags backfill after restart and renamed categories enqueue a new desired folder', async t => {
  const h = await setup(t); await h.worker.close(); h.add();
  assert.equal(h.index.get('labelSync', 'one'), null);
  await h.restart(); await h.worker.poll(); assert.equal(h.worker.status().synced, 1);
  h.rename(); await h.worker.poll();
  assert.equal(h.calls[1][0].primaryLabel, 'MailHarbor/Bills');
});

test('protected organizer locations never reach provider transport, Gmail labels remain eligible', async t => {
  const h = await setup(t); h.add(); h.disallow(); await h.worker.poll();
  assert.equal(h.calls.length, 0); assert.equal(h.worker.status().protected, 1);
  const gmail = await setup(t, { account: { provider: 'google' }, sync: async (acct, entries, cb) => {
    await cb.verify(entries[0]); await cb.onResult(entries[0], { status: 'synced', reference, managedLabels: entries[0].labels, kind: 'labels', moved: false }); return { results: [] };
  } });
  gmail.add(); gmail.disallow(); await gmail.worker.poll(); assert.equal(gmail.worker.status().synced, 1); assert.equal(gmail.relocated.length, 0);
});

test('organizer intents defer filing until resolved', async t => {
  const h = await setup(t); h.add(); h.index.put('messages', 'one', { locations: [{ intent: { action: 'archive' } }] });
  await h.worker.poll(); assert.equal(h.calls.length, 0); assert.equal(h.worker.status().pending, 1);
  h.index.remove('messages', 'one'); h.advance(); await h.worker.poll(); assert.equal(h.worker.status().synced, 1);
});

test('paused or busy organizer preflight defers labels without spending their retry budget', async t => {
  for (const code of ['cancelled', 'busy']) {
    const h = await setup(t); h.add();
    let writers = 0;
    h.processing.categoryMoveDeferred = () => { throw Object.assign(new Error(code), { code }); };
    h.processing.withMailboxWrite = async () => { writers++; };
    await h.worker.poll();
    const saved = h.index.get('labelSync', 'one');
    assert.equal(writers, 0); assert.equal(saved.attempts, 0); assert.equal(saved.state, 'pending');
    assert.equal(saved.retryAt, 40000); assert.equal(h.calls.length, 0);
  }
});

test('a full page of deferred organizer intents does not starve later label jobs', async t => {
  const h = await setup(t);
  for (let position = 0; position < 100; position++) {
    const key = `blocked-${String(position).padStart(3, '0')}`;
    h.add(key); h.index.put('messages', key, { locations: [{ intent: { action: 'archive' } }] });
  }
  h.add('zz-eligible');
  await h.worker.poll();
  assert.equal(h.calls.length, 0);
  assert.equal(h.index.get('labelSync', 'blocked-000').retryAt, 40000);
  await h.worker.poll();
  assert.deepEqual(h.calls.map(batch => batch.map(entry => entry.key)), [['zz-eligible']]);
  assert.equal(h.worker.status().synced, 1);
  assert.equal(h.worker.status().pending, 100);
});

test('uncertain moves preserve durable intent through restart and recover without clearing it early', async t => {
  let first = true;
  const h = await setup(t, { sync: async (acct, entries, cb, index) => {
    const entry = entries[0]; await cb.verify(entry);
    if (first) {
      first = false; await cb.beforeMove(entry, { source: reference, destinationPath: target.path, messageId: entry.message.messageId });
      throw Object.assign(new Error('connection lost'), { code: 'mailbox_error' });
    }
    assert.deepEqual(entry.intent.source, reference); assert.deepEqual(index.get('tags', entry.key).reference, reference);
    await cb.onResult(entry, { status: 'synced', reference: target, managedLabels: [], kind: 'folders', moved: true }); return { results: [] };
  } });
  h.add(); await h.worker.poll(); assert.ok(h.index.get('labelSync', 'one').intent);
  await h.restart(); h.advance(); await h.worker.poll(); assert.equal(h.worker.status().synced, 1); assert.equal(h.relocated.length, 1);
});

test('new desired labels arriving during a completed move are retained and queued separately', async t => {
  const h = await setup(t, { sync: async (acct, entries, cb, index) => {
    const entry = entries[0]; await cb.beforeMove(entry, { source: reference, destinationPath: target.path, messageId: entry.message.messageId });
    index.putTag(entry.key, tagged({ tags: ['newsletters'], manual: ['newsletters'] }));
    await cb.onResult(entry, { status: 'synced', reference: target, managedLabels: [], kind: 'folders', moved: true }); return { results: [] };
  } });
  h.add(); await h.worker.poll();
  assert.equal(h.index.get('labelSync', 'one').primaryLabel, 'MailHarbor/Newsletters'); assert.equal(h.worker.status().pending, 1);
  assert.deepEqual(h.index.get('tags', 'one').reference, target); assert.deepEqual(h.index.get('tags', 'one').manual, ['newsletters']);
});

test('three bounded failures require explicit retry and never report a synced message', async t => {
  const h = await setup(t, { sync: async (acct, entries) => ({ results: entries.map(entry => ({ key: entry.key, error: { code: 'stale_message' } })) }) });
  h.add(); for (let i = 0; i < 3; i++) { await h.worker.poll(); h.advance(); }
  assert.equal(h.worker.status().failed, 1); assert.equal(h.worker.status().synced, 0);
  await h.worker.poll(); assert.equal(h.calls.length, 3);
  h.worker.request(); await h.worker.poll(); assert.equal(h.calls.length, 4);
});

test('account reconnect or desired changes revoke stale provider writes', async t => {
  const h = await setup(t, { sync: async (acct, entries, cb) => { h.reconnect(); await cb.verify(entries[0]); throw new Error('unreachable'); } });
  h.add(); await h.worker.poll(); assert.equal(h.worker.status().pending, 1); assert.equal(h.worker.status().synced, 0);
  assert.equal(h.index.get('labelSync', 'one').error, 'stale_message');
});

test('a deleted tag still reconciles an uncertain move, and changed destinations remain pending', async t => {
  let first = true;
  const h = await setup(t, { sync: async (acct, entries, cb) => {
    const entry = entries[0];
    if (first) { first = false; await cb.beforeMove(entry, { source: reference, destinationPath: target.path, messageId: entry.message.messageId }); throw { code: 'mailbox_error' }; }
    assert.ok(entry.intent); assert.deepEqual(entry.reference, reference); assert.equal(entry.primaryLabel, null);
    await cb.onResult(entry, { status: 'synced', reference, managedLabels: [], moved: false }); return { results: [] };
  } });
  h.add(); await h.worker.poll(); h.add('one', tagged({ deleted: true, tags: [] }));
  assert.equal(h.index.get('labelSync', 'one').state, 'pending');
  await h.worker.poll(); assert.equal(h.index.get('labelSync', 'one').intent, null); assert.equal(h.index.get('tags', 'one').deleted, true);
});

test('interrupted Gmail label writes preserve all possibly applied owned names for the next generation', async t => {
  const h = await setup(t, { account: { provider: 'google' }, sync: async (acct, entries, cb, index) => {
    const entry = entries[0];
    assert.ok(index.get('labelSync', entry.key).managedLabels.includes('MailHarbor/Invoices'));
    index.putTag(entry.key, tagged({ tags: ['newsletters'] }));
    await assert.rejects(cb.verify(entry), { code: 'stale_message' });
    return { results: [{ key: entry.key, error: { code: 'stale_message' } }] };
  } });
  h.add(); await h.worker.poll();
  const saved = h.index.get('labelSync', 'one');
  assert.deepEqual(saved.labels, ['MailHarbor/Newsletters']); assert.deepEqual(saved.managedLabels, ['MailHarbor/Invoices']); assert.equal(saved.state, 'pending');
});
