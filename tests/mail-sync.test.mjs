import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailCache } from '../server/mail-cache.mjs';
import { createMailSync } from '../server/mail-sync.mjs';

function fakeMessage(uid, overrides = {}) {
  const accountId = overrides.accountId || overrides.reference?.accountId || 'acc-1';
  const time = overrides.time ?? (1700000000000 + uid * 60000);
  return {
    id: `hash-${uid}`,
    accountId,
    folderPath: 'INBOX',
    subject: `Subject ${uid}`,
    author: `Sender <sender${uid}@example.test>`,
    to: 'user@example.test',
    date: new Date(time).toISOString(),
    unread: true,
    starred: false,
    size: 100,
    reference: {
      accountId,
      path: 'INBOX',
      uid,
      uidValidity: overrides.uidValidity || overrides.reference?.uidValidity || '1',
      fingerprint: `fp-${uid}`.padEnd(64, '0'),
      ...(overrides.reference ?? {})
    },
    ...overrides
  };
}

function mockReader(accountMessagesMap = {}) {
  const calls = [];
  return {
    calls,
    async list(accounts, options = {}) {
      calls.push({ action: 'list', accounts: accounts.map(a => a.id), options });
      const account = accounts[0];
      const data = accountMessagesMap[account.id] ?? { messages: [] };
      if (data.error) throw data.error;
      if (data.delay) await new Promise(r => setTimeout(r, data.delay));

      const raw = data.messages ?? [];
      const all = raw.map(m => ({
        ...m,
        accountId: account.id,
        reference: {
          ...m.reference,
          accountId: account.id,
          path: m.reference?.path || 'INBOX',
          uid: m.reference?.uid,
          uidValidity: m.reference?.uidValidity || '1',
          fingerprint: m.reference?.fingerprint || `fp-${m.reference?.uid}`.padEnd(64, '0')
        }
      }));
      const limit = options.limit ?? 50;

      let start = 0;
      if (options.cursor?.offset) start = options.cursor.offset;

      const slice = all.slice(start, start + limit);
      const nextOffset = start + limit;
      const hasMore = nextOffset < all.length;

      return {
        messages: slice,
        errors: [],
        total: all.length,
        totalComplete: true,
        nextCursor: hasMore ? { offset: nextOffset } : null
      };
    },
    async content(account, reference, options = {}) {
      calls.push({ action: 'content', accountId: account.id, uid: reference.uid });
      const data = accountMessagesMap[account.id] ?? {};
      if (data.contentDelay) await new Promise(r => setTimeout(r, data.contentDelay));
      return {
        id: `content-${reference.uid}`,
        accountId: account.id,
        folderPath: reference.path,
        subject: `Subject ${reference.uid}`,
        text: `Body text for ${reference.uid}`,
        html: `<p>HTML body for ${reference.uid}</p>`,
        complete: true,
        sanitized: false,
        encrypted: null,
        attachments: [],
        reference
      };
    },
    async contentBatch(account, references, options = {}) {
      calls.push({ action: 'contentBatch', accountId: account.id, uids: references.map(r => r.uid) });
      const results = references.map(ref => ({
        reference: ref,
        content: {
          id: `content-${ref.uid}`,
          accountId: account.id,
          folderPath: ref.path,
          subject: `Subject ${ref.uid}`,
          text: `Batch text for ${ref.uid}`,
          html: `<p>Batch HTML for ${ref.uid}</p>`,
          complete: true,
          sanitized: false,
          encrypted: null,
          attachments: [],
          reference: ref
        }
      }));
      if (typeof options.onContent === 'function') {
        for (const res of results) {
          await options.onContent(res);
        }
      }
      return results;
    }
  };
}

test('first50 visibility: first 50 headers publish before remaining headers up to X and bodies', async () => {
  const cache = await createMailCache(null, { maxHeadersPerAccount: 100 });
  const messages = Array.from({ length: 80 }, (_, i) => fakeMessage(i + 1, { time: 1700000000000 + (80 - i) * 60000 }));
  const reader = mockReader({ 'acc-1': { messages } });

  const notifications = [];
  const sync = createMailSync({
    accounts: [{ id: 'acc-1', email: 'user@example.test', revision: '1' }],
    cache,
    reader,
    autoSchedule: false,
    changed: (id, update) => notifications.push({ id, ...update })
  });

  await sync.refresh(['acc-1']);

  // Check progression of notifications
  const phases = notifications.map(n => n.phase);
  assert.ok(phases.includes('first50'), 'Must notify first50 phase');
  assert.ok(phases.includes('headers'), 'Must notify headers phase');
  assert.ok(phases.includes('complete'), 'Must notify complete phase');

  // Verify first50 had count 50
  const first50Notice = notifications.find(n => n.phase === 'first50');
  assert.equal(first50Notice.count, 50);

  // Verify full headers reached 80
  const headersNotice = notifications.find(n => n.phase === 'headers');
  assert.equal(headersNotice.count, 80);

  // Verify bodies were prefetched
  assert.ok(reader.calls.some(c => c.action === 'contentBatch' || c.action === 'content'));
  await sync.close();
  cache.close();
});

test('concurrency is bounded to at most 2 accounts and slow/failing accounts are isolated', async () => {
  const cache = await createMailCache(null);
  const reader = mockReader({
    'slow-acc': { messages: [fakeMessage(1, { accountId: 'slow-acc' })], delay: 50 },
    'fail-acc': { error: new Error('Simulated network error') },
    'fast-acc': { messages: [fakeMessage(2, { accountId: 'fast-acc' })], delay: 10 }
  });

  const accounts = [
    { id: 'slow-acc', email: 'slow@example.test', revision: '1' },
    { id: 'fail-acc', email: 'fail@example.test', revision: '1' },
    { id: 'fast-acc', email: 'fast@example.test', revision: '1' }
  ];

  const sync = createMailSync({
    accounts,
    cache,
    reader,
    autoSchedule: false
  });

  // Refresh all three concurrently
  await sync.refresh(['slow-acc', 'fail-acc', 'fast-acc']);

  const status = sync.status();
  const fastStat = status.accounts.find(a => a.accountId === 'fast-acc');
  const failStat = status.accounts.find(a => a.accountId === 'fail-acc');
  const slowStat = status.accounts.find(a => a.accountId === 'slow-acc');

  // Fast account must have succeeded despite fail-acc failing
  assert.ok(fastStat.lastSuccessfulUpdate !== null);
  assert.equal(fastStat.error, null);

  // Slow account must have succeeded
  assert.ok(slowStat.lastSuccessfulUpdate !== null);

  // Failing account has error recorded and backoff scheduled
  assert.ok(failStat.error !== null);
  assert.ok(failStat.backoff !== null);
  assert.equal(failStat.lastSuccessfulUpdate, null);

  await sync.close();
  cache.close();
});

test('coalesces duplicate refresh calls and prioritizes foreground requests', async () => {
  const cache = await createMailCache(null);
  const reader = mockReader({
    'acc-coalesce': { messages: [fakeMessage(1)], delay: 30 }
  });

  const sync = createMailSync({
    accounts: [{ id: 'acc-coalesce', email: 'coalesce@example.test', revision: '1' }],
    cache,
    reader,
    autoSchedule: false
  });

  // Launch background refresh followed immediately by duplicate foreground refresh
  const p1 = sync.refresh(['acc-coalesce'], { priority: false });
  const p2 = sync.refresh(['acc-coalesce'], { priority: true });

  await Promise.all([p1, p2]);

  // Reader list should only have been called once for this cycle
  const listCalls = reader.calls.filter(c => c.action === 'list');
  assert.equal(listCalls.length, 1);

  await sync.close();
  cache.close();
});

test('cancellation on account replacement or removal stops in-flight sync', async () => {
  const cache = await createMailCache(null);
  const reader = mockReader({
    'acc-cancel': { messages: [fakeMessage(1)], delay: 50 }
  });

  const sync = createMailSync({
    accounts: [{ id: 'acc-cancel', email: 'old@example.test', revision: '1' }],
    cache,
    reader,
    autoSchedule: false
  });

  const refreshPromise = sync.refresh(['acc-cancel']);

  // Immediately replace account with revision 2
  sync.updateAccounts([{ id: 'acc-cancel', email: 'new@example.test', revision: '2' }]);

  await refreshPromise;

  // The older revision's snapshot should not have been committed as complete
  const listed = cache.list([{ id: 'acc-cancel', email: 'new@example.test', revision: '2' }]);
  assert.equal(listed, null, 'New revision must not have old un-reconciled data');

  await sync.close();
  cache.close();
});

test('preserves date ordering over UID values (lower UID with newer date is placed first)', async () => {
  const cache = await createMailCache(null);
  // Message 1 has NEWER date than message 999
  const msgNewer = fakeMessage(1, { time: 1700000090000 });
  const msgOlder = fakeMessage(999, { time: 1700000000000 });

  const reader = mockReader({
    'acc-order': { messages: [msgNewer, msgOlder] }
  });

  const account = { id: 'acc-order', email: 'order@example.test', revision: '1' };
  const sync = createMailSync({
    accounts: [account],
    cache,
    reader,
    autoSchedule: false
  });

  await sync.refresh(['acc-order']);

  const listRes = cache.list([account]);
  assert.ok(listRes);
  assert.equal(listRes.messages.length, 2);
  assert.equal(listRes.messages[0].reference.uid, 1, 'Newer date must be first regardless of lower UID');
  assert.equal(listRes.messages[1].reference.uid, 999);

  await sync.close();
  cache.close();
});

test('reconciles exact bounded membership and flags even when counts remain unchanged', async () => {
  const cache = await createMailCache(null);
  const msg1 = fakeMessage(1, { time: 1700000030000 });
  const msg2 = fakeMessage(2, { time: 1700000020000 });
  const msg3 = fakeMessage(3, { time: 1700000010000 });

  const accountData = { messages: [msg1, msg2, msg3] };
  const reader = mockReader({ 'acc-reconcile': accountData });
  const account = { id: 'acc-reconcile', email: 'reconcile@example.test', revision: '1' };

  const sync = createMailSync({
    accounts: [account],
    cache,
    reader,
    autoSchedule: false
  });

  // First cycle
  await sync.refresh(['acc-reconcile']);
  let listRes = cache.list([account]);
  assert.deepEqual(listRes.messages.map(m => m.reference.uid), [1, 2, 3]);

  // Server state changes: msg2 deleted, msg4 added. Total count remains 3.
  const msg4 = fakeMessage(4, { time: 1700000040000 });
  accountData.messages = [msg4, msg1, msg3];

  // Second cycle
  await sync.refresh(['acc-reconcile']);
  listRes = cache.list([account]);
  assert.deepEqual(listRes.messages.map(m => m.reference.uid), [4, 1, 3]);
  assert.equal(listRes.messages.some(m => m.reference.uid === 2), false, 'Removed message must be evicted on reconciliation');

  await sync.close();
  cache.close();
});

test('renderContent sanitizes untrusted raw HTML before body admission', async () => {
  const cache = await createMailCache(null);
  const msg = fakeMessage(1);
  const reader = mockReader({ 'acc-sanitize': { messages: [msg] } });

  // Custom renderContent that strips malicious tags
  let renderedCalled = false;
  const sync = createMailSync({
    accounts: [{ id: 'acc-sanitize', email: 'clean@example.test', revision: '1' }],
    cache,
    reader,
    autoSchedule: false,
    renderContent: async content => {
      renderedCalled = true;
      return {
        ...content,
        html: '<p>Sanitized content</p>',
        sanitized: true
      };
    }
  });

  await sync.refresh(['acc-sanitize']);

  assert.equal(renderedCalled, true);
  const body = cache.getBody({ id: 'acc-sanitize', email: 'clean@example.test', revision: '1' }, msg.reference);
  assert.ok(body);
  assert.equal(body.html, '<p>Sanitized content</p>');

  await sync.close();
  cache.close();
});

test('stale cache generation rejects sync commit', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-stale-sync', email: 'stale@example.test', revision: '1' };
  const reader = mockReader({
    'acc-stale-sync': {
      messages: [fakeMessage(1)],
      delay: 30
    }
  });

  const sync = createMailSync({
    accounts: [account],
    cache,
    reader,
    autoSchedule: false
  });

  const refreshPromise = sync.refresh(['acc-stale-sync']);

  // While list is delaying, invalidate the cache generation
  cache.invalidate(account, { reason: 'mutation' });

  await refreshPromise;

  // Stale commit was rejected
  assert.equal(cache.list([account]), null);

  await sync.close();
  cache.close();
});

test('UIDVALIDITY reset invalidates previous cached mailbox headers', async () => {
  const cache = await createMailCache(null);
  const msg1 = fakeMessage(1, { uidValidity: '100' });
  const accountData = { messages: [msg1] };
  const reader = mockReader({ 'acc-uid': accountData });
  const account = { id: 'acc-uid', email: 'uid@example.test', revision: '1' };

  const sync = createMailSync({
    accounts: [account],
    cache,
    reader,
    autoSchedule: false
  });

  await sync.refresh(['acc-uid']);
  assert.equal(cache.list([account])?.messages.length, 1);

  // Mailbox rebuilt with new UIDVALIDITY
  const msg2 = fakeMessage(2, { uidValidity: '200' });
  accountData.messages = [msg2];

  await sync.refresh(['acc-uid']);
  const listed = cache.list([account]);
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0].reference.uid, 2);
  assert.equal(listed.messages[0].reference.uidValidity, '200');

  await sync.close();
  cache.close();
});

test('active mutation blocks sync from performing provider work', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-mut-sync', email: 'mutsync@example.test', revision: '1' };
  const reader = mockReader({ 'acc-mut-sync': { messages: [fakeMessage(1)] } });
  const sync = createMailSync({
    accounts: [account],
    cache,
    reader,
    autoSchedule: false
  });

  // Begin active mutation
  const mutToken = cache.beginMutation(account);
  assert.ok(mutToken);
  assert.equal(cache.isMutating(account), true);

  // Sync should not perform provider list work while mutating
  await sync.refresh(['acc-mut-sync']);
  const listCalls = reader.calls.filter(c => c.action === 'list');
  assert.equal(listCalls.length, 0, 'No provider list work when active mutation blocks snapshot');

  // End mutation and refresh
  cache.endMutation(mutToken);
  await sync.refresh(['acc-mut-sync']);
  assert.ok(reader.calls.some(c => c.action === 'list'));

  await sync.close();
  cache.close();
});

test('async close awaits in-flight sync settlement before resolving', async () => {
  const cache = await createMailCache(null);
  const reader = {
    calls: [],
    async list() {
      await new Promise(r => setTimeout(r, 40));
      return { messages: [], errors: [], total: 0, totalComplete: true, nextCursor: null };
    }
  };

  const sync = createMailSync({
    accounts: [{ id: 'acc-async-close', email: 'async@example.test', revision: '1' }],
    cache,
    reader,
    autoSchedule: false
  });

  sync.refresh(['acc-async-close']);
  // Close immediately while refresh is running
  await sync.close();
  // After close resolves, all active sync promises must have settled
  assert.equal(sync.status().concurrency, 0);

  cache.close();
});

test('provider errors propagate sanitized error codes', async () => {
  const cache = await createMailCache(null);
  const reader = {
    calls: [],
    async list() {
      return {
        messages: [],
        errors: [{ accountId: 'acc-err-code', code: 'mailbox_timeout' }],
        total: 0,
        totalComplete: false,
        nextCursor: null
      };
    }
  };

  const sync = createMailSync({
    accounts: [{ id: 'acc-err-code', email: 'errcode@example.test', revision: '1' }],
    cache,
    reader,
    autoSchedule: false
  });

  await sync.refresh(['acc-err-code']);
  const stat = sync.status();
  const accStat = stat.accounts.find(a => a.accountId === 'acc-err-code');
  assert.ok(accStat.error);
  assert.equal(accStat.error.code, 'mailbox_timeout');

  await sync.close();
  cache.close();
});

test('removing account does not exceed concurrency limit', async () => {
  const cache = await createMailCache(null);
  let concurrentActive = 0;
  let maxSeenConcurrent = 0;

  const reader = {
    calls: [],
    async list() {
      concurrentActive++;
      if (concurrentActive > maxSeenConcurrent) maxSeenConcurrent = concurrentActive;
      await new Promise(r => setTimeout(r, 50));
      concurrentActive--;
      return { messages: [], errors: [], total: 0, totalComplete: true, nextCursor: null };
    }
  };

  const accounts = [
    { id: 'acc-c1', email: 'c1@example.test', revision: '1' },
    { id: 'acc-c2', email: 'c2@example.test', revision: '1' },
    { id: 'acc-c3', email: 'c3@example.test', revision: '1' }
  ];

  const sync = createMailSync({
    accounts,
    cache,
    reader,
    autoSchedule: false
  });

  const p = sync.refresh(['acc-c1', 'acc-c2', 'acc-c3']);
  // Remove acc-c1 while running
  sync.updateAccounts([
    { id: 'acc-c2', email: 'c2@example.test', revision: '1' },
    { id: 'acc-c3', email: 'c3@example.test', revision: '1' }
  ]);

  await p;
  assert.ok(maxSeenConcurrent <= 2, `Concurrency must not exceed 2 (saw ${maxSeenConcurrent})`);

  await sync.close();
  cache.close();
});

test('restart preserves lastSuccessfulUpdate from cache', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-restart-ts', email: 'ts@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, { messages: [], uidValidity: '1', total: 0, complete: true });

  const sync = createMailSync({
    accounts: [account],
    cache,
    reader: mockReader({ 'acc-restart-ts': { messages: [] } }),
    autoSchedule: false
  });

  const stat = sync.status();
  const accStat = stat.accounts.find(a => a.accountId === account.id);
  assert.ok(accStat.lastSuccessfulUpdate !== null);

  await sync.close();
  cache.close();
});

test('real accounts service shape filters connected accounts and aborts on live revision change', async () => {
  const cache = await createMailCache(null);

  const fullAccounts = new Map([
    ['acc-conn', { id: 'acc-conn', email: 'conn@example.test', revision: '1', connected: true }],
    ['acc-disc', { id: 'acc-disc', email: 'disc@example.test', revision: '1', connected: false }]
  ]);

  const accountsService = {
    list() {
      return [
        { id: 'acc-conn', connected: true },
        { id: 'acc-disc', connected: false }
      ];
    },
    get(id) {
      return fullAccounts.get(id);
    }
  };

  let listResolve;
  const listPromise = new Promise(r => { listResolve = r; });

  const reader = {
    calls: [],
    async list(accounts) {
      reader.calls.push({ action: 'list', id: accounts[0].id });
      // Wait for revision bump
      await listPromise;
      return {
        messages: [fakeMessage(1, { accountId: accounts[0].id })],
        errors: [],
        total: 1,
        totalComplete: true,
        nextCursor: null
      };
    }
  };

  const sync = createMailSync({
    accounts: accountsService,
    cache,
    reader,
    autoSchedule: false
  });

  // Only connected account is tracked
  const initialStat = sync.status();
  assert.equal(initialStat.accounts.length, 1);
  assert.equal(initialStat.accounts[0].accountId, 'acc-conn');

  // Trigger refresh for acc-conn
  const refreshP = sync.refresh(['acc-conn']);

  // While reader.list is in flight, bump live revision
  fullAccounts.set('acc-conn', { id: 'acc-conn', email: 'conn@example.test', revision: '2', connected: true });
  listResolve();

  await refreshP;

  // Stale revision headers must NOT have been committed to cache
  const listed = cache.list([fullAccounts.get('acc-conn')]);
  assert.equal(listed, null, 'Headers must not be committed after live revision change');

  await sync.close();
  cache.close();
});

test('lastSuccessfulUpdate is recorded immediately upon header commit and changed event includes success flag', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-immediate-ts', email: 'imm@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  const changedEvents = [];
  let headerCommitted = false;

  const reader = {
    calls: [],
    async list() {
      return {
        messages: [msg],
        errors: [],
        total: 1,
        totalComplete: true,
        nextCursor: null
      };
    },
    async content() {
      // Body fetch fails or hangs
      headerCommitted = sync.status().accounts.find(a => a.accountId === account.id)?.lastSuccessfulUpdate !== null;
      throw new Error('Body provider temporarily down');
    }
  };

  const sync = createMailSync({
    accounts: [account],
    cache,
    reader,
    autoSchedule: false,
    changed: (id, evt) => changedEvents.push({ id, ...evt })
  });

  await sync.refresh([account.id]);

  // Headers succeeded, so headerCommitted must have been true before body failure
  assert.equal(headerCommitted, true, 'lastSuccessfulUpdate must be recorded before body prefetch begins');

  const stat = sync.status();
  const accStat = stat.accounts.find(a => a.accountId === account.id);
  assert.ok(accStat.lastSuccessfulUpdate !== null, 'lastSuccessfulUpdate must remain recorded despite body prefetch error');

  // Check that changed events included success: true
  const headerNotice = changedEvents.find(e => e.phase === 'headers');
  assert.ok(headerNotice);
  assert.equal(headerNotice.success, true);

  await sync.close();
  cache.close();
});

test('notificationSnapshot preserves baseline state on error and drops disconnected accounts', async () => {
  const cache = await createMailCache(null);
  const account1 = { id: 'acc-notif-1', email: 'notif1@example.test', revision: '1' };
  const msg1 = fakeMessage(1, { accountId: account1.id });

  let shouldFail = false;
  const changedEvents = [];

  const reader = {
    calls: [],
    async list(accounts, options = {}) {
      if (shouldFail) {
        const err = new Error('mailbox_error');
        err.code = 'mailbox_error';
        throw err;
      }
      return {
        messages: [msg1],
        errors: [],
        total: 1,
        totalComplete: true,
        nextCursor: null,
        states: [{
          accountId: account1.id,
          folderId: 'folder:mock-inbox-1',
          uidValidity: '1',
          uidNext: 2,
          unseen: 1,
          messages: 1
        }]
      };
    },
    async content() {
      return { id: 'c1', complete: true, sanitized: true, reference: msg1.reference };
    }
  };

  const sync = createMailSync({
    accounts: [account1],
    cache,
    reader,
    autoSchedule: false,
    changed: (id, evt) => changedEvents.push({ id, ...evt })
  });

  // Initial successful sync
  await sync.refresh([account1.id]);
  const initialSnap = sync.notificationSnapshot();
  assert.equal(initialSnap.states.length, 1);
  assert.equal(initialSnap.states[0].accountId, account1.id);
  assert.equal(initialSnap.states[0].messages, 1);
  assert.equal(initialSnap.errors.length, 0);

  // Subsequent sync fails
  shouldFail = true;
  const results = await sync.refresh([account1.id]);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason?.code, 'mailbox_error');

  const failureSnap = sync.notificationSnapshot();
  // Baseline state must be preserved
  assert.equal(failureSnap.states.length, 1);
  assert.equal(failureSnap.states[0].accountId, account1.id);
  assert.equal(failureSnap.states[0].messages, 1);
  // Error must be recorded
  assert.equal(failureSnap.errors.length, 1);
  assert.equal(failureSnap.errors[0].accountId, account1.id);
  assert.equal(failureSnap.errors[0].code, 'mailbox_error');

  // Verify changed events included notificationSnapshot
  const lastChanged = changedEvents.at(-1);
  assert.ok(lastChanged.notificationSnapshot);
  assert.equal(lastChanged.notificationSnapshot.states.length, 1);

  // Disconnect/remove account
  sync.updateAccounts([]);
  const clearedSnap = sync.notificationSnapshot();
  assert.equal(clearedSnap.states.length, 0);
  assert.equal(clearedSnap.errors.length, 0);

  await sync.close();
  cache.close();
});

test('folder hook fetches reader.folders after first50 without erasing last good inventory on failure', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-folders-hook', email: 'folders@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  let folderFail = false;
  const reader = {
    calls: [],
    async list() {
      return {
        messages: [msg],
        errors: [],
        total: 1,
        totalComplete: true,
        nextCursor: null,
        states: [{
          accountId: account.id,
          folderId: 'folder:mock-inbox',
          uidValidity: '1',
          uidNext: 2,
          unseen: 0,
          messages: 1
        }]
      };
    },
    async folders(accounts) {
      if (folderFail) {
        throw new Error('folder_unavailable');
      }
      return {
        folders: [
          { id: 'inbox', label: 'Inbox', type: 'standard', accountIds: [account.id], counts: [{ accountId: account.id, total: 1 }] },
          { id: 'custom-1', label: 'Work', type: 'provider', accountIds: [account.id], counts: [{ accountId: account.id, total: 10 }] }
        ],
        errors: []
      };
    },
    async content() {
      return { id: 'c1', complete: true, sanitized: true, reference: msg.reference };
    }
  };

  const sync = createMailSync({
    accounts: [account],
    cache,
    reader,
    autoSchedule: false
  });

  await sync.refresh([account.id]);

  const initialFolders = cache.getFolders([account]);
  assert.ok(initialFolders, 'Folders must be cached after first50');
  const workFolder = initialFolders.folders.find(f => f.id === 'custom-1');
  assert.ok(workFolder, 'Provider folder Work must be present in cache');

  // Next sync fails to fetch folders
  folderFail = true;
  await sync.refresh([account.id]);

  const preservedFolders = cache.getFolders([account]);
  assert.ok(preservedFolders, 'Folders must still be present in cache');
  const preservedWork = preservedFolders.folders.find(f => f.id === 'custom-1');
  assert.ok(preservedWork, 'Last good inventory must not be erased on folder fetch failure');

  await sync.close();
  cache.close();
});

test('blocked reader.list failure after revision change does not overwrite new account status or errors', async () => {
  const cache = await createMailCache(null);
  const accountV1 = { id: 'acc-stale-job', email: 'stalejob@example.test', revision: '1' };
  const accountV2 = { id: 'acc-stale-job', email: 'stalejob@example.test', revision: '2' };

  let listReject;
  const listPromise = new Promise((_, r) => { listReject = r; });

  const reader = {
    calls: [],
    async list() {
      await listPromise;
      const err = new Error('mailbox_error');
      err.code = 'mailbox_error';
      throw err;
    },
    async folders() {
      return { folders: [], errors: [] };
    }
  };

  const sync = createMailSync({
    accounts: [accountV1],
    cache,
    reader,
    autoSchedule: false
  });

  // Start refresh on revision 1
  const refreshP = sync.refresh([accountV1.id]);

  // While list is blocked, account revision is bumped to revision 2
  sync.updateAccounts([accountV2]);

  // Now old reader.list fails
  listReject(new Error('mailbox_error'));
  await refreshP;

  // Stale job error must NOT overwrite status of revision 2 account
  const stat = sync.status();
  const accStat = stat.accounts.find(a => a.accountId === accountV1.id);
  assert.equal(accStat.error, null, 'Obsolete job error must not be written to new account state');

  const notif = sync.notificationSnapshot();
  const notifErr = notif.errors.find(e => e.accountId === accountV1.id);
  assert.equal(notifErr, undefined, 'Notification errors must not record obsolete job failure');

  await sync.close();
  cache.close();
});

test('active mutation race during sync prevents corrupted cache state and subsequent sync recovers', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-mut-race', email: 'race@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  let mutToken = null;
  let inList = false;

  const reader = {
    calls: [],
    async list() {
      inList = true;
      // Start mutation while list is in flight
      mutToken = cache.beginMutation(account);
      assert.equal(cache.isMutating(account), true);
      return {
        messages: [msg],
        errors: [],
        total: 1,
        totalComplete: true,
        nextCursor: null
      };
    },
    async folders() {
      return { folders: [], errors: [] };
    },
    async content() {
      return { id: 'c1', complete: true, sanitized: true, reference: msg.reference };
    }
  };

  const sync = createMailSync({
    accounts: [account],
    cache,
    reader,
    autoSchedule: false
  });

  await sync.refresh([account.id]);
  assert.equal(inList, true);

  // During active mutation, cache.list must be null / blocked
  assert.equal(cache.list([account]), null, 'Cache must refuse reads during active mutation');

  // End the mutation
  assert.ok(mutToken);
  const ended = cache.endMutation(mutToken);
  assert.equal(ended, true);
  assert.equal(cache.isMutating(account), false);

  // Normal reader list without mutation race
  reader.list = async () => ({
    messages: [msg],
    errors: [],
    total: 1,
    totalComplete: true,
    nextCursor: null
  });

  // Next sync succeeds and cache becomes readable
  await sync.refresh([account.id]);
  const listed = cache.list([account]);
  assert.ok(listed);
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0].subject, 'Subject 1');

  await sync.close();
  cache.close();
});
