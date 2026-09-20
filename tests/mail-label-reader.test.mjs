import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMailLabelReader } from '../server/mail-label-reader.mjs';
import { mailFingerprint } from '../server/mailboxes.mjs';

const account = { id: 'fixture', email: 'fixture@example.test' };
const mail = (uid = 1, extra = {}) => ({ uid, size: 120, internalDate: new Date('2026-09-01T12:00:00Z'),
  envelope: { messageId: '<fixture@example.test>', subject: 'PRIVATE_SUBJECT', date: new Date('2026-09-01T12:00:00Z'), from: [{ address: 'sender@example.test' }] },
  flags: new Set(['\\Flagged', '$Important']), labels: new Set(['\\Inbox', 'Personal']), emailId: '12345', ...extra });
const reference = (value = mail(), path = 'INBOX', uidValidity = '1') => ({ accountId: account.id, path, uidValidity, uid: value.uid, fingerprint: mailFingerprint(value) });
const entry = (extra = {}) => ({ key: 'item-1', reference: reference(), labels: ['MailHarbor/Invoices'], managedLabels: [], primaryLabel: 'MailHarbor/Invoices', ...extra });
const defaultOptions = () => ({ verify: async () => true, beforeMove: async () => {}, onResult: async () => {} });

function harness(options = {}) {
  const calls = [], clients = [];
  const state = { capabilities: ['MOVE', 'UIDPLUS'], ...options };
  state.folders = (options.folders ?? [{ path: 'INBOX', messages: [mail()] }]).map(value => ({ delimiter: '/', flags: new Set(), uidValidity: 1n,
    ...value, messages: new Map((value.messages ?? []).map(message => [message.uid, structuredClone(message)])) }));
  class Client extends EventEmitter {
    constructor(input) { super(); this.options = input; this.capabilities = new Set(state.capabilities); clients.push(this); }
    command(action) { assert.ok(!this.closed); assert.ok(!this.fetching, 'No command inside FETCH'); calls.push({ action, path: this.folder?.path }); }
    async connect() { this.command('connect'); }
    close() { this.closed = true; }
    async list() { this.command('list'); await state.onList?.(this); return state.folders; }
    async getMailboxLock(path, { readOnly }) {
      this.command('open'); assert.ok(!this.locked, 'No nested locks'); this.locked = true;
      this.folder = state.folders.find(folder => folder.path === path);
      if (!this.folder) { this.locked = false; throw new Error('PRIVATE_FOLDER_ERROR'); }
      this.mailbox = { path, uidValidity: this.folder.uidValidity, readOnly: Boolean(readOnly || this.folder.readOnly) };
      await state.onLock?.(this);
      return { release: () => { this.locked = false; } };
    }
    async *fetch(range, query, request) {
      this.command('fetch'); assert.deepEqual(request, { uid: true, binary: false });
      assert.equal(query.bodyParts, undefined); assert.equal(query.source, undefined);
      this.fetching = true;
      try {
        await state.onFetch?.(Number(range), this);
        for (const value of state.beforeRows ?? []) yield structuredClone(value);
        const value = this.folder.messages.get(Number(range));
        if (value) {
          const copy = structuredClone(value);
          if (state.omitSelectedLabel) copy.labels.delete(this.folder.path);
          yield copy;
        }
        for (const value of state.afterRows ?? []) yield structuredClone(value);
      } finally { this.fetching = false; }
    }
    async search(criteria, request) {
      this.command('search'); assert.deepEqual(request, { uid: true });
      await state.onSearch?.(this);
      if (state.searchResult) return state.searchResult;
      return [...this.folder.messages.values()].filter(value => criteria.emailId ? value.emailId === criteria.emailId :
        String(value.envelope.messageId).includes(criteria.header['Message-ID'])).map(value => value.uid);
    }
    async mailboxCreate(path) {
      this.command('create'); calls.at(-1).target = path;
      if (!state.folders.some(folder => folder.path === path)) state.folders.push({ path, delimiter: state.delimiter ?? '/', flags: new Set(), uidValidity: 1n, messages: new Map() });
      await state.onCreate?.(path, this);
      return { path, created: true };
    }
    async mailboxSubscribe(path) { this.command('subscribe'); calls.at(-1).target = path; return !state.subscribeFails; }
    async messageFlagsAdd(range, labels, request) { return this.labels('add', range, labels, request); }
    async messageFlagsRemove(range, labels, request) { return this.labels('remove', range, labels, request); }
    async labels(action, range, labels, request) {
      this.command(action); assert.deepEqual(request, { uid: true, useLabels: true }); assert.equal(this.mailbox.readOnly, false);
      calls.at(-1).labels = labels; calls.at(-1).uid = Number(range);
      const original = this.folder.messages.get(Number(range));
      if (!state.labelNoop) for (const folder of state.folders) for (const value of folder.messages.values()) {
        if (value.emailId !== original.emailId) continue;
        for (const label of labels) action === 'add' ? value.labels.add(label) : value.labels.delete(label);
        if (action === 'remove' && labels.includes(folder.path)) folder.messages.delete(value.uid);
      }
      await state.onLabels?.(action, this);
      return true;
    }
    async messageMove(range, path, request) {
      this.command('move'); assert.deepEqual(request, { uid: true }); assert.equal(this.mailbox.readOnly, false);
      assert.ok(this.capabilities.has('MOVE')); assert.ok(this.capabilities.has('UIDPLUS'));
      const source = this.folder, target = state.folders.find(folder => folder.path === path), original = source.messages.get(Number(range));
      calls.at(-1).target = path;
      const targetUid = Math.max(0, ...target.messages.keys()) + 1;
      const moved = { ...structuredClone(original), uid: targetUid };
      if (state.changedMove) moved.envelope.subject = 'CHANGED_IDENTITY';
      target.messages.set(targetUid, moved);
      if (!state.keepSource) source.messages.delete(Number(range));
      await state.onMove?.(this);
      return state.noMapping ? {} : { path: source.path, destination: path, uidValidity: target.uidValidity, uidMap: new Map([[Number(range), targetUid]]) };
    }
    async messageCopy() { assert.fail('Never COPY'); }
    async messageDelete() { assert.fail('Never delete/expunge'); }
    async mailboxClose() { assert.fail('Never CLOSE'); }
  }
  const reader = createMailLabelReader({ connectionOptions: async () => ({ auth: { user: 'fixture', pass: 'PRIVATE_PASSWORD' },
    logger: true, tls: { rejectUnauthorized: false } }), createClient: input => new Client(input), sessionTimeoutMs: 5000 });
  return { reader, state, clients, calls, sync: (entries = [entry()], options = {}) => reader.sync(account, entries, { ...defaultOptions(), ...options }) };
}

test('Gmail creates and subscribes owned hierarchy, writes only selected labels, preserving all other flags and labels', async () => {
  const original = mail(1, { labels: new Set(['\\Inbox', 'Personal', 'MailHarbor/Old', 'MailHarbor/Unowned']) });
  const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [original] }, { path: '[Gmail]/All Mail', specialUse: '\\All', messages: [{ ...original, uid: 11 }] }] });
  const seen = [];
  const result = await h.sync([entry({ managedLabels: ['MailHarbor/Old'] })], { onResult: async (input, result) => { seen.push(result); } });
  assert.equal(h.clients.length, 1); assert.equal(h.clients[0].options.tls.rejectUnauthorized, true); assert.equal(h.clients[0].options.logger, false);
  assert.deepEqual(h.calls.filter(call => ['add', 'remove'].includes(call.action)).map(call => [call.action, call.path, call.labels]),
    [['add', '[Gmail]/All Mail', ['MailHarbor/Invoices']], ['remove', '[Gmail]/All Mail', ['MailHarbor/Old']]]);
  assert.deepEqual(h.calls.filter(call => call.action === 'create').map(call => call.target), ['MailHarbor', 'MailHarbor/Invoices']);
  assert.deepEqual(h.calls.filter(call => call.action === 'subscribe').map(call => call.target), ['MailHarbor', 'MailHarbor/Invoices']);
  const saved = h.state.folders[1].messages.get(11);
  assert.deepEqual(saved.flags, original.flags);
  assert.deepEqual(saved.labels, new Set(['\\Inbox', 'Personal', 'MailHarbor/Unowned', 'MailHarbor/Invoices']));
  assert.deepEqual(result.results[0], { key: 'item-1', ...seen[0] });
  assert.equal(seen[0].reference.path, '[Gmail]/All Mail'); assert.equal(seen[0].moved, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|example.test|envelope|flags/);
});

test('Gmail removes a selected owned label through All Mail and does not lose its stable reference', async () => {
  const original = mail(7, { labels: new Set(['MailHarbor/Old', 'Personal']) });
  const h = harness({ capabilities: ['X-GM-EXT-1'], omitSelectedLabel: true, folders: [{ path: 'MailHarbor/Old', messages: [original] },
    { path: '[Gmail]/All Mail', specialUse: '\\All', messages: [{ ...original, uid: 11 }] }] });
  const value = await h.sync([entry({ reference: reference(original, 'MailHarbor/Old'), managedLabels: ['MailHarbor/Old'], labels: [], primaryLabel: null })]);
  assert.equal(value.results[0].status, 'synced'); assert.equal(value.results[0].reference.uid, 11);
  assert.equal(h.state.folders[0].messages.size, 0); assert.equal(h.state.folders[1].messages.get(11).labels.has('MailHarbor/Old'), false);
});

test('Gmail detects ignored STORE responses and does not persist success', async () => {
  const h = harness({ capabilities: ['X-GM-EXT-1'], labelNoop: true });
  let successes = 0;
  const value = await h.sync(undefined, { onResult: async () => { successes++; } });
  assert.deepEqual(value.results, [{ key: 'item-1', error: { code: 'mailbox_error' } }]); assert.equal(successes, 0);
});

test('Gmail rejects a provider response that changes an unrelated label or read flag', async () => {
  for (const mutation of [message => message.labels.delete('Personal'), message => message.flags.add('\\Seen')]) {
    const h = harness({ capabilities: ['X-GM-EXT-1'], onLabels: (action, client) => mutation(client.folder.messages.get(1)) });
    const value = await h.sync();
    assert.equal(value.results[0].error.code, 'mailbox_error');
  }
});

test('repeated synchronization is idempotent and existing folders are subscribed once per session', async () => {
  const original = mail(1, { labels: new Set(['MailHarbor/Invoices', 'Personal']) });
  const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [original, mail(2, { ...original, uid: 2 })] },
    { path: 'MailHarbor' }, { path: 'MailHarbor/Invoices' }] });
  const value = await h.sync([entry(), entry({ key: 'item-2', reference: reference(original, 'INBOX') })]);
  assert.equal(value.results.length, 2); assert.equal(h.calls.some(call => ['create', 'add', 'remove'].includes(call.action)), false);
  assert.equal(h.calls.filter(call => call.action === 'subscribe').length, 2);
});

test('non-Gmail native MOVE persists intent first and verifies exact mapped destination and source absence', async () => {
  const h = harness(), order = [];
  h.state.onMove = () => { order.push('move'); };
  const value = await h.sync(undefined, { beforeMove: async (input, intent) => {
    order.push('persist'); assert.deepEqual(intent, { source: reference(), destinationPath: 'MailHarbor/Invoices', messageId: '<fixture@example.test>' });
  }, onResult: async (input, result) => { order.push('result'); assert.equal(result.moved, true); } });
  assert.deepEqual(order, ['persist', 'move', 'result']);
  assert.equal(value.results[0].kind, 'folders'); assert.equal(value.results[0].reference.path, 'MailHarbor/Invoices');
  assert.deepEqual(h.state.folders.find(folder => folder.path === 'MailHarbor/Invoices').messages.get(1).flags, mail().flags);
});

test('non-Gmail honors a dot hierarchy delimiter for native folder creation and journal destination', async () => {
  const h = harness({ delimiter: '.', folders: [{ path: 'INBOX', delimiter: '.', messages: [mail()] }] });
  let intent;
  const value = await h.sync(undefined, { beforeMove: async (input, saved) => { intent = saved; } });
  assert.equal(intent.destinationPath, 'MailHarbor.Invoices'); assert.equal(value.results[0].reference.path, 'MailHarbor.Invoices');
  assert.deepEqual(h.calls.filter(call => call.action === 'create').map(call => call.target), ['MailHarbor', 'MailHarbor.Invoices']);
});

test('non-Gmail protects actual Sent, Drafts, Trash, Junk, and Archive folders and leaves no-primary mail in place', async () => {
  for (const [path, specialUse] of [['Verzonden', '\\Sent'], ['Concepten', '\\Drafts'], ['Verwijderd', '\\Trash'], ['Ongewenst', '\\Junk'], ['Archief', '\\Archive'], ['Archive', ''], ['Sent Items', '']]) {
    const h = harness({ folders: [{ path, specialUse, messages: [mail()] }] });
    const value = await h.sync([entry({ reference: reference(mail(), path) })]);
    assert.equal(value.results[0].status, 'protected', path); assert.equal(h.calls.some(call => ['move', 'create'].includes(call.action)), false);
  }
  const h = harness(), value = await h.sync([entry({ labels: [], primaryLabel: null })]);
  assert.equal(value.results[0].moved, false); assert.equal(h.calls.some(call => ['move', 'create'].includes(call.action)), false);
});

test('MOVE and UIDPLUS are both required, and unsafe fallbacks are never invoked', async () => {
  for (const capabilities of [[], ['MOVE'], ['UIDPLUS']]) {
    const h = harness({ capabilities }), value = await h.sync();
    assert.equal(value.results[0].error.code, 'move_unavailable'); assert.equal(h.calls.some(call => ['create', 'move'].includes(call.action)), false);
  }
});

test('reconnect, abort, changed UIDVALIDITY and changed fingerprint prevent mutations', async () => {
  const revoked = harness(); let permitted = true;
  revoked.state.onList = () => { permitted = false; };
  await assert.rejects(revoked.sync(undefined, { verify: async () => permitted }), error => error.code === 'stale_message');
  const aborted = harness(), controller = new AbortController(); aborted.state.onList = () => controller.abort();
  await assert.rejects(aborted.sync(undefined, { signal: controller.signal }), error => error.code === 'cancelled');
  for (const extra of [{ uidValidity: 2n }, { messages: [mail(1, { size: 999 })] }]) {
    const h = harness({ folders: [{ path: 'INBOX', messages: [mail()], ...extra }] }), value = await h.sync();
    assert.equal(value.results[0].error.code, 'stale_message'); assert.equal(h.calls.some(call => ['create', 'move'].includes(call.action)), false);
  }
  assert.equal(revoked.calls.some(call => call.action === 'move'), false); assert.equal(aborted.calls.some(call => call.action === 'move'), false);
});

test('a reconnect during durable journal save stops the queued move', async () => {
  const h = harness(); let permitted = true;
  const value = await h.sync(undefined, { verify: async () => permitted, beforeMove: async () => { permitted = false; } });
  assert.equal(value.results[0].error.code, 'stale_message'); assert.equal(h.calls.some(call => call.action === 'move'), false);
});

test('each Gmail mutation rechecks its entry generation after acquiring the write lock', async () => {
  let permitted = true;
  const input = entry(), verified = [];
  const h = harness({ capabilities: ['X-GM-EXT-1'], onLock: client => { if (!client.mailbox.readOnly) permitted = false; } });
  const value = await h.sync([input], { verify: async current => {
    verified.push(current);
    if (current) assert.equal(current, input);
    return !current || permitted;
  } });
  assert.equal(value.results[0].error.code, 'stale_message');
  assert.ok(verified.filter(current => current === input).length > 3);
  assert.equal(h.calls.some(call => ['add', 'remove'].includes(call.action)), false);
});

test('a missing COPYUID mapping recovers only one complete fingerprint in the destination', async () => {
  const h = harness({ noMapping: true }), value = await h.sync();
  assert.equal(value.results[0].moved, true); assert.equal(value.results[0].reference.path, 'MailHarbor/Invoices');
  assert.equal(h.calls.filter(call => call.action === 'move').length, 1); assert.equal(h.calls.some(call => call.action === 'search'), true);
});

test('resume after interrupted MOVE searches only the recorded destination and never repeats an absent source', async () => {
  const h = harness(); let intent;
  h.state.onMove = () => { throw new Error('PRIVATE_CONNECTION_FAILURE'); };
  const first = await h.sync(undefined, { beforeMove: async (input, value) => { intent = value; } });
  assert.equal(first.results[0].error.code, 'mailbox_error');
  h.state.onMove = null;
  const resumed = await h.sync([entry({ intent })]);
  assert.equal(resumed.results[0].moved, true); assert.equal(h.calls.filter(call => call.action === 'move').length, 1);
  assert.deepEqual(h.calls.filter(call => call.action === 'search').map(call => call.path), ['MailHarbor/Invoices']);
});

test('resume may retry the exact source safely when the prior MOVE did not happen', async () => {
  const h = harness();
  const value = await h.sync([entry({ intent: { source: reference(), destinationPath: 'MailHarbor/Invoices', messageId: '<fixture@example.test>' } })]);
  assert.equal(value.results[0].moved, true); assert.equal(h.calls.filter(call => call.action === 'move').length, 1);
});

test('an obsolete intent never moves a still-present source after categories change or are cleared', async () => {
  const intent = { source: reference(), destinationPath: 'MailHarbor/Invoices', messageId: '<fixture@example.test>' };
  for (const primaryLabel of [null, 'MailHarbor/Travel']) {
    const h = harness(), acknowledged = [];
    const value = await h.sync([entry({ intent, primaryLabel, labels: primaryLabel ? [primaryLabel] : [] })], {
      onResult: async (input, result) => { acknowledged.push(result); }, beforeMove: async () => { assert.fail('Do not persist an obsolete move again'); }
    });
    assert.equal(value.results[0].status, 'synced'); assert.equal(value.results[0].moved, false);
    assert.equal(value.results[0].needsSync, Boolean(primaryLabel));
    assert.deepEqual(value.results[0].reference, reference()); assert.equal(acknowledged.length, 1);
    assert.equal(h.calls.some(call => ['move', 'create', 'subscribe'].includes(call.action)), false);
  }
});

test('an obsolete intent still recovers its completed move when the exact source is absent', async () => {
  const intent = { source: reference(), destinationPath: 'MailHarbor/Invoices', messageId: '<fixture@example.test>' };
  for (const primaryLabel of [null, 'MailHarbor/Travel']) {
    const h = harness({ folders: [{ path: 'INBOX' }, { path: 'MailHarbor/Invoices', messages: [mail(7)] }] });
    const value = await h.sync([entry({ intent, primaryLabel, labels: primaryLabel ? [primaryLabel] : [] })]);
    assert.equal(value.results[0].moved, true); assert.equal(value.results[0].reference.path, 'MailHarbor/Invoices');
    assert.equal(value.results[0].needsSync, Boolean(primaryLabel));
    assert.equal(value.results[0].reference.uid, 7); assert.equal(h.calls.some(call => call.action === 'move'), false);
  }
});

test('recovery rejects duplicate fingerprints, broad searches, and changed destination identities', async () => {
  const intent = { source: reference(), destinationPath: 'MailHarbor/Invoices', messageId: '<fixture@example.test>' };
  for (const options of [{ folders: [{ path: 'INBOX' }, { path: 'MailHarbor/Invoices', messages: [mail(2), mail(3)] }] },
    { folders: [{ path: 'INBOX' }, { path: 'MailHarbor/Invoices', messages: [mail(2, { size: 999 })] }] },
    { searchResult: Array.from({ length: 65 }, (_, i) => i + 1), folders: [{ path: 'INBOX' }, { path: 'MailHarbor/Invoices' }] }]) {
    const h = harness(options), value = await h.sync([entry({ intent })]);
    assert.equal(value.results[0].error.code, 'stale_message'); assert.equal(h.calls.some(call => call.action === 'move'), false);
  }
  const changed = harness({ changedMove: true }), value = await changed.sync();
  assert.equal(value.results[0].error.code, 'stale_message');
});

test('a provider retaining the source is never reported as a completed MOVE', async () => {
  const h = harness({ keepSource: true }), value = await h.sync();
  assert.equal(value.results[0].error.code, 'mailbox_error');
});

test('unsolicited rows cannot substitute the selected UID or hide a partial flags update', async () => {
  const h = harness({ capabilities: ['X-GM-EXT-1'], beforeRows: [mail(99)], afterRows: [{ uid: 1, flags: new Set(['\\Deleted']) }] });
  const value = await h.sync(); assert.equal(value.results[0].error.code, 'stale_message');
  assert.equal(h.calls.some(call => ['create', 'add', 'remove'].includes(call.action)), false);
});

test('durable result completion is awaited before the next batch entry and callback failure stops the batch', async () => {
  const h = harness({ folders: [{ path: 'INBOX', messages: [mail(1), mail(2)] }] });
  let completed = 0;
  h.state.onMove = () => { assert.equal(h.calls.filter(call => call.action === 'move').length, completed + 1); };
  const values = [entry(), entry({ key: 'item-2', reference: reference(mail(2)) })];
  await h.sync(values, { onResult: async () => { await new Promise(resolve => setTimeout(resolve, 1)); completed++; } });
  assert.equal(completed, 2); assert.equal(h.clients.length, 1);
  const failed = harness({ folders: [{ path: 'INBOX', messages: [mail(1), mail(2)] }] });
  await assert.rejects(failed.sync(values, { onResult: async () => { throw new Error('PRIVATE_STORE_ERROR'); } }), error => error.code === 'mailbox_error' && !error.message.includes('PRIVATE'));
  assert.equal(failed.calls.filter(call => call.action === 'move').length, 1);
});

test('completion may advance its own generation without invalidating the next entry', async () => {
  const h = harness({ folders: [{ path: 'INBOX', messages: [mail(1), mail(2)] }] }), complete = new Set();
  const values = [entry(), entry({ key: 'item-2', reference: reference(mail(2)) })];
  const result = await h.sync(values, { verify: async input => !input || !complete.has(input.key), onResult: async input => { complete.add(input.key); } });
  assert.equal(result.results.length, 2); assert.equal(result.results.every(item => item.status === 'synced'), true);
});

test('a category edit during MOVE still acknowledges the verified physical move for reconciliation', async () => {
  let changed = false, acknowledged = false;
  const h = harness({ onMove: () => { changed = true; } });
  const result = await h.sync(undefined, { verify: async input => !input || !changed, onResult: async (input, outcome) => {
    assert.equal(outcome.moved, true); acknowledged = true;
  } });
  assert.equal(result.results[0].status, 'synced'); assert.equal(acknowledged, true);
});

test('invalid owned labels, mismatched intent identities and oversized batches are rejected before connecting', async () => {
  const h = harness();
  for (const values of [[entry({ labels: ['Personal'], primaryLabel: null })], [entry({ managedLabels: ['\\Inbox'] })],
    [entry({ labels: ['MailHarbor/../Sent'], primaryLabel: null })], Array.from({ length: 26 }, (_, i) => entry({ key: String(i) })),
    [entry({ intent: { source: reference(mail(2)), destinationPath: 'MailHarbor/Invoices', messageId: '<fixture@example.test>' } })]]) {
    await assert.rejects(h.sync(values), error => ['invalid_request', 'stale_message'].includes(error.code));
  }
  assert.equal(h.clients.length, 0);
});
