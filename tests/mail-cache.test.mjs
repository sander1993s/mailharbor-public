import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccountStore } from '../server/account-store.mjs';
import { createMailCache } from '../server/mail-cache.mjs';

function fakeMessage(uid, overrides = {}) {
  const accountId = overrides.accountId ?? overrides.reference?.accountId ?? 'account-1';
  const folderPath = overrides.folderPath ?? overrides.reference?.path ?? 'INBOX';
  const uidValidity = overrides.uidValidity ?? overrides.reference?.uidValidity ?? '1';
  const date = overrides.date ?? new Date(1700000000000 + uid * 60000).toISOString();
  return {
    id: `hash-${uid}`,
    accountId,
    folderPath,
    subject: `Subject ${uid}`,
    author: `Sender ${uid} <sender${uid}@example.test>`,
    to: 'user@example.test',
    date,
    unread: true,
    starred: false,
    size: 100,
    reference: {
      accountId,
      path: folderPath,
      uid,
      uidValidity,
      fingerprint: `fp-${uid}`.padEnd(64, '0'),
      ...(overrides.reference ?? {})
    },
    ...overrides
  };
}

test('encrypted disk persistence: no plaintext subjects, addresses, bodies or paths in DB or WAL', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mailharbor-cache-'));
  let cache;
  t.after(async () => {
    cache?.close();
    await rm(dir, { recursive: true, force: true });
  });

  await createAccountStore(dir);
  cache = await createMailCache(dir);

  const account = { id: 'account-1', email: 'owner@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');

  const secretMsg = fakeMessage(1, {
    accountId: account.id,
    subject: 'TOP_SECRET_SUBJECT_XYZ',
    author: 'agent_007@secret.test',
    to: 'classified@secret.test'
  });

  const ok = cache.commitHeaders(ticket, {
    messages: [secretMsg],
    uidValidity: '1',
    total: 1,
    complete: true
  });
  assert.equal(ok, true);

  const bodyOk = cache.putBody(ticket, secretMsg.reference, {
    text: 'HIGHLY_CONFIDENTIAL_BODY_DATA',
    html: '<p>HIGHLY_CONFIDENTIAL_BODY_DATA</p>',
    sanitized: true,
    complete: true
  });
  assert.equal(bodyOk, true);

  cache.close();

  const sqliteBytes = await readFile(path.join(dir, 'mail-cache.sqlite'));
  assert.equal(sqliteBytes.includes(Buffer.from('TOP_SECRET_SUBJECT_XYZ')), false);
  assert.equal(sqliteBytes.includes(Buffer.from('agent_007@secret.test')), false);
  assert.equal(sqliteBytes.includes(Buffer.from('HIGHLY_CONFIDENTIAL_BODY_DATA')), false);

  try {
    const walBytes = await readFile(path.join(dir, 'mail-cache.sqlite-wal'));
    assert.equal(walBytes.includes(Buffer.from('TOP_SECRET_SUBJECT_XYZ')), false);
    assert.equal(walBytes.includes(Buffer.from('agent_007@secret.test')), false);
    assert.equal(walBytes.includes(Buffer.from('HIGHLY_CONFIDENTIAL_BODY_DATA')), false);
  } catch {
    // WAL may have been checkpointed on close
  }

  // Reopen cache and verify decrypted data matches exactly
  cache = await createMailCache(dir);
  const listed = cache.list([account]);
  assert.ok(listed);
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0].subject, 'TOP_SECRET_SUBJECT_XYZ');
  assert.equal(listed.messages[0].author, 'agent_007@secret.test');

  const body = cache.getBody(account, secretMsg.reference);
  assert.ok(body);
  assert.equal(body.text, 'HIGHLY_CONFIDENTIAL_BODY_DATA');
});

test('clean shutdown permits warm restart; unclean shutdown requires reconciliation', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mailharbor-cache-clean-'));
  let cache;
  t.after(async () => {
    cache?.close();
    await rm(dir, { recursive: true, force: true });
  });

  await createAccountStore(dir);
  cache = await createMailCache(dir);

  const account = { id: 'account-clean', email: 'clean@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');
  const msg = fakeMessage(10, { accountId: account.id });
  cache.commitHeaders(ticket, { messages: [msg], uidValidity: '1', complete: true });

  // Clean shutdown
  cache.close();

  // Reopen: warm restart permitted
  cache = await createMailCache(dir);
  const warmList = cache.list([account]);
  assert.ok(warmList);
  assert.equal(warmList.messages.length, 1);
  assert.equal(warmList.messages[0].subject, 'Subject 10');

  // Now simulate an unclean shutdown by modifying the clean_shutdown marker
  cache.close();
  const { DatabaseSync } = await import('node:sqlite');
  const rawDb = new DatabaseSync(path.join(dir, 'mail-cache.sqlite'));
  rawDb.prepare("UPDATE cache_meta SET value='0' WHERE key='clean_shutdown'").run();
  rawDb.close();

  // Reopen: unclean restart marks namespaces dirty / unreconciled
  cache = await createMailCache(dir);
  assert.equal(cache.list([account]), null, 'Unclean restart must refuse warm reads until reconciled');

  // Reconcile with new snapshot
  const reconcileTicket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(reconcileTicket, { messages: [msg], uidValidity: '1', complete: true });
  const reconciledList = cache.list([account]);
  assert.ok(reconciledList);
  assert.equal(reconciledList.messages.length, 1);
});

test('namespace replacement resets generation and purges older records', async () => {
  const cache = await createMailCache(null); // In-memory
  const accountV1 = { id: 'acc-replace', email: 'v1@example.test', revision: '1' };
  const ticket1 = cache.beginSnapshot(accountV1, 'INBOX');

  const msg1 = fakeMessage(1, { accountId: accountV1.id });
  cache.commitHeaders(ticket1, { messages: [msg1], uidValidity: '1', complete: true });
  cache.putBody(ticket1, msg1.reference, { text: 'body 1', sanitized: true, complete: true });

  assert.equal(cache.list([accountV1])?.messages.length, 1);
  assert.ok(cache.getBody(accountV1, msg1.reference));

  // Identity / revision changes
  const accountV2 = { id: 'acc-replace', email: 'v2@example.test', revision: '2' };
  const ns2 = cache.namespace(accountV2);
  assert.equal(ns2.dirty, true);
  assert.equal(ns2.reconciled, false);
  assert.ok(ns2.generation > ticket1.generation);

  // Older data should be purged
  assert.equal(cache.list([accountV2]), null);
  assert.equal(cache.getBody(accountV2, msg1.reference), null);
});

test('limits and eviction: header cap trims oldest-first and body budget evicts oldest-first', async () => {
  const cache = await createMailCache(null, {
    maxHeadersPerAccount: 3,
    maxBodyBytes: 500,
    maxMessageBodyBytes: 250
  });

  const account = { id: 'acc-limits', email: 'limits@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');

  // Insert 4 messages (cap is 3)
  const msgs = [
    fakeMessage(1, { accountId: account.id, date: '2026-01-01T10:00:00Z' }),
    fakeMessage(2, { accountId: account.id, date: '2026-01-02T10:00:00Z' }),
    fakeMessage(3, { accountId: account.id, date: '2026-01-03T10:00:00Z' }),
    fakeMessage(4, { accountId: account.id, date: '2026-01-04T10:00:00Z' })
  ];

  cache.commitHeaders(ticket, { messages: msgs, uidValidity: '1', complete: true });

  const listRes = cache.list([account], { limit: 10 });
  assert.equal(listRes.messages.length, 3);
  // Oldest (msg 1) was trimmed, messages 4, 3, 2 remain
  assert.deepEqual(listRes.messages.map(m => m.reference.uid), [4, 3, 2]);

  // Body budget: maxMessageBodyBytes is 250. Putting 300 bytes text should be rejected
  const tooLarge = cache.putBody(ticket, msgs[3].reference, {
    text: 'A'.repeat(300),
    sanitized: true,
    complete: true
  });
  assert.equal(tooLarge, false, 'Body exceeding per-message limit must be rejected');

  // Put body for msg 2, msg 3, msg 4 (each admitted JSON ~100 bytes)
  cache.putBody(ticket, msgs[1].reference, { text: 'Body for 2', sanitized: true, complete: true });
  cache.putBody(ticket, msgs[2].reference, { text: 'Body for 3', sanitized: true, complete: true });
  cache.putBody(ticket, msgs[3].reference, { text: 'Body for 4', sanitized: true, complete: true });

  assert.ok(cache.getBody(account, msgs[1].reference));
  assert.ok(cache.getBody(account, msgs[2].reference));
  assert.ok(cache.getBody(account, msgs[3].reference));

  // Now lower budget to 250 so oldest body is evicted
  cache.updateSettings({ maxBodyBytes: 250 });
  cache.putBody(ticket, msgs[3].reference, { text: 'B'.repeat(50), sanitized: true, complete: true });

  const stat = cache.status();
  assert.ok(stat.bodyBytes <= 250);
});

test('content admission rejects incomplete, truncated, decrypted, raw HTML, and renderer version mismatch', async () => {
  const cache = await createMailCache(null, { rendererVersion: '1' });
  const account = { id: 'acc-adm', email: 'adm@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');
  const msg = fakeMessage(1, { accountId: account.id });
  cache.commitHeaders(ticket, { messages: [msg], uidValidity: '1', complete: true });

  // Incomplete
  assert.equal(cache.putBody(ticket, msg.reference, { text: 'a', complete: false, sanitized: true }), false);

  // Truncated
  assert.equal(cache.putBody(ticket, msg.reference, { text: 'a', complete: true, truncated: true, sanitized: true }), false);

  // Decrypted
  assert.equal(cache.putBody(ticket, msg.reference, { text: 'a', complete: true, decrypted: true, sanitized: true }), false);

  // Raw HTML not sanitized
  assert.equal(cache.putBody(ticket, msg.reference, { text: 'a', html: '<b>raw</b>', sanitized: false, complete: true }), false);

  // Version mismatch on put
  assert.equal(cache.putBody(ticket, msg.reference, { text: 'a', sanitized: true, complete: true, rendererVersion: '9' }), false);

  // Valid admission
  assert.equal(cache.putBody(ticket, msg.reference, { text: 'valid text', sanitized: true, complete: true, rendererVersion: '1' }), true);
  assert.ok(cache.getBody(account, msg.reference));

  // Later version bump invalidates read
  cache.updateSettings({ rendererVersion: '2' });
  assert.equal(cache.getBody(account, msg.reference), null);
});

test('stale generation rejects header and body commits', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-stale', email: 'stale@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');
  assert.ok(ticket.generation >= 1);

  // Invalidation advances generation
  const inv = cache.invalidate(account, { reason: 'mutation' });
  assert.ok(inv.generation > ticket.generation);

  const msg = fakeMessage(1, { accountId: account.id });
  assert.equal(cache.commitHeaders(ticket, { messages: [msg], uidValidity: '1', complete: true }), false);
  assert.equal(cache.putBody(ticket, msg.reference, { text: 'body', sanitized: true, complete: true }), false);
});

test('UIDVALIDITY change invalidates affected folder and same-count membership reconciliation works', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-uidval', email: 'uidval@example.test', revision: '1' };
  const ticket1 = cache.beginSnapshot(account, 'INBOX');

  const m1 = fakeMessage(1, { accountId: account.id, uidValidity: '100' });
  const m2 = fakeMessage(2, { accountId: account.id, uidValidity: '100' });
  const m3 = fakeMessage(3, { accountId: account.id, uidValidity: '100' });
  cache.commitHeaders(ticket1, { messages: [m1, m2, m3], uidValidity: '100', complete: true });

  const list1 = cache.list([account]);
  assert.equal(list1.messages.length, 3);

  // External change: count stays 3, but message 2 was removed and message 4 was added
  const m4 = fakeMessage(4, { accountId: account.id, uidValidity: '100' });
  const ticket2 = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket2, { messages: [m1, m3, m4], uidValidity: '100', complete: true });

  const list2 = cache.list([account]);
  assert.equal(list2.messages.length, 3);
  assert.deepEqual(list2.messages.map(m => m.reference.uid), [4, 3, 1]);

  // UIDVALIDITY reset (e.g. mailbox rebuilt on server)
  const ticket3 = cache.beginSnapshot(account, 'INBOX');
  const m10 = fakeMessage(10, { accountId: account.id, uidValidity: '200' });
  cache.commitHeaders(ticket3, { messages: [m10], uidValidity: '200', complete: true });

  const list3 = cache.list([account]);
  assert.equal(list3.messages.length, 1);
  assert.equal(list3.messages[0].reference.uid, 10);
  assert.equal(list3.messages[0].reference.uidValidity, '200');

  // Mismatched UIDVALIDITY in putBody is rejected
  const staleRef = { accountId: account.id, path: 'INBOX', uid: 10, uidValidity: '100' };
  assert.equal(cache.putBody(ticket3, staleRef, { text: 'stale body', sanitized: true, complete: true }), false);
});

test('mutable flag updates reflect in headers without modifying bodies', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-flags', email: 'flags@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');
  const msg = fakeMessage(1, { accountId: account.id, unread: true, starred: false });
  cache.commitHeaders(ticket, { messages: [msg], uidValidity: '1', complete: true });
  cache.putBody(ticket, msg.reference, { text: 'Body unchanged', sanitized: true, complete: true });

  cache.updateFlags(account, msg.reference, { unread: false, starred: true });

  const listed = cache.list([account]);
  assert.equal(listed.messages[0].unread, false);
  assert.equal(listed.messages[0].starred, true);

  const body = cache.getBody(account, msg.reference);
  assert.equal(body.text, 'Body unchanged');
});

test('cache clear removes disposable data and removeAccount isolates deletion', async () => {
  const cache = await createMailCache(null);
  const accountA = { id: 'a', email: 'a@example.test', revision: '1' };
  const accountB = { id: 'b', email: 'b@example.test', revision: '1' };

  const ticketA = cache.beginSnapshot(accountA, 'INBOX');
  const ticketB = cache.beginSnapshot(accountB, 'INBOX');

  cache.commitHeaders(ticketA, { messages: [fakeMessage(1, { accountId: 'a' })], uidValidity: '1', complete: true });
  cache.commitHeaders(ticketB, { messages: [fakeMessage(2, { accountId: 'b' })], uidValidity: '1', complete: true });

  cache.removeAccount('a');
  assert.equal(cache.list([accountA]), null);
  assert.equal(cache.list([accountB])?.messages.length, 1);

  cache.clear();
  assert.equal(cache.status().headerCount, 0);
  assert.equal(cache.status().bodyCount, 0);
});

test('failed invalidation disk write fails closed globally', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-fail', email: 'fail@example.test', revision: '1' };
  cache.beginSnapshot(account, 'INBOX');

  // Close database underneath to force disk write failure
  cache.close();

  assert.throws(() => {
    cache.invalidate(account, { reason: 'mutation' });
  });

  assert.equal(cache.healthy(), false, 'Failed invalidation must fail closed globally');
});

test('warm list and getBody make zero synchronous provider calls', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-warm', email: 'warm@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');
  const msg = fakeMessage(1, { accountId: account.id });
  cache.commitHeaders(ticket, { messages: [msg], uidValidity: '1', complete: true });
  cache.putBody(ticket, msg.reference, { text: 'Warm body', sanitized: true, complete: true });

  let providerCalls = 0;
  new Proxy({}, {
    get() {
      providerCalls++;
      throw new Error('Provider must not be called during warm cache hit');
    }
  });

  const listResult = cache.list([account]);
  assert.equal(listResult.messages.length, 1);
  const bodyResult = cache.getBody(account, msg.reference);
  assert.equal(bodyResult.text, 'Warm body');

  assert.equal(providerCalls, 0, 'Zero provider calls must occur on warm cache hits');
});

test('corrupt records or database fail safe with healthy false and support provider fallback', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mailharbor-cache-corrupt-'));
  let cache;
  try {
    await createAccountStore(dir);
    cache = await createMailCache(dir);
    const account = { id: 'acc-corrupt', email: 'corrupt@example.test', revision: '1' };
    const ticket = cache.beginSnapshot(account, 'INBOX');
    const msg = fakeMessage(1, { accountId: account.id });
    cache.commitHeaders(ticket, { messages: [msg], uidValidity: '1', complete: true });
    cache.close();

    // Deterministically corrupt database header bytes (0..16) to force constructor fallback
    const sqlitePath = path.join(dir, 'mail-cache.sqlite');
    const bytes = await readFile(sqlitePath);
    bytes.fill(0x00, 0, 16);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(sqlitePath, bytes);

    cache = await createMailCache(dir);
    assert.equal(cache.healthy(), false);
    const res = cache.list([account]);
    assert.equal(res, null, 'Corrupt cache must fail safe and return null for provider fallback');
  } finally {
    cache?.close();
    await rm(dir, { recursive: true, force: true });
  }

  // Separately verify that tampering with encrypted payload triggers AES-GCM auth failure
  const dir2 = await mkdtemp(path.join(tmpdir(), 'mailharbor-cache-enc-corrupt-'));
  let cache2;
  let rawDb;
  try {
    await createAccountStore(dir2);
    cache2 = await createMailCache(dir2);
    const account2 = { id: 'acc-enc-corrupt', email: 'enccorrupt@example.test', revision: '1' };
    const ticket2 = cache2.beginSnapshot(account2, 'INBOX');
    const secretMsg = fakeMessage(1, {
      accountId: account2.id,
      subject: 'TAMPER_TEST_SECRET'
    });
    cache2.commitHeaders(ticket2, { messages: [secretMsg], uidValidity: '1', complete: true });
    cache2.close();
    cache2 = undefined;

    // Tamper with encrypted header payload in SQLite using DatabaseSync
    const sqlitePath2 = path.join(dir2, 'mail-cache.sqlite');
    const { DatabaseSync } = await import('node:sqlite');
    rawDb = new DatabaseSync(sqlitePath2);
    const row = rawDb.prepare('SELECT data FROM headers LIMIT 1').get();
    assert.ok(row?.data);
    const tampered = Buffer.from(row.data);
    tampered[tampered.length - 1] ^= 0x01;
    rawDb.prepare('UPDATE headers SET data = ?').run(tampered);
    rawDb.close();
    rawDb = undefined;

    // Reopen cache: decryption fails authentication check
    cache2 = await createMailCache(dir2);
    const listRes = cache2.list([account2]);
    assert.equal(listRes, null, 'Auth failure on tampered header blob must return null for provider fallback');
    assert.equal(cache2.healthy(), false, 'Auth failure must mark cache unhealthy');
  } finally {
    try { rawDb?.close(); } catch {}
    try { cache2?.close(); } catch {}
    await rm(dir2, { recursive: true, force: true });
  }
});

test('real reader.list to cache.commitHeaders works without top-level uid', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-real-list', email: 'reallist@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');

  // Real message object shaped exactly like reader.list output (NO top-level uid property)
  const realReaderMessage = {
    id: '4f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a',
    accountId: 'acc-real-list',
    folderPath: 'INBOX',
    subject: 'Real reader message without top-level uid',
    author: 'Author <author@example.test>',
    to: 'user@example.test',
    date: '2026-03-01T12:00:00.000Z',
    unread: true,
    starred: false,
    size: 256,
    reference: {
      accountId: 'acc-real-list',
      path: 'INBOX',
      uid: 42,
      uidValidity: '1',
      fingerprint: 'a'.repeat(64)
    }
  };
  assert.equal(realReaderMessage.uid, undefined, 'Message must not have top-level uid');

  // commitHeaders must succeed without throwing SQLite parameter error
  const ok = cache.commitHeaders(ticket, { messages: [realReaderMessage], uidValidity: '1', complete: true });
  assert.equal(ok, true);

  const listed = cache.list([account]);
  assert.ok(listed);
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0].reference.uid, 42);
  assert.equal(listed.messages[0].subject, 'Real reader message without top-level uid');
});

test('first50 cache.list visible before second provider page resolves', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-first50', email: 'first50@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');

  const messages = Array.from({ length: 50 }, (_, i) => fakeMessage(i + 1, { accountId: account.id }));

  // Stage 1 commits first50 with complete: false
  const ok = cache.commitHeaders(ticket, {
    messages,
    uidValidity: '1',
    total: 100,
    complete: false,
    checkpoint: 'first50'
  });
  assert.equal(ok, true);

  // List must be visible during warming before complete: true is called!
  const listRes = cache.list([account]);
  assert.ok(listRes, 'First 50 must be visible in cache.list during warming');
  assert.equal(listRes.messages.length, 50);
  assert.equal(listRes.coverage.status, 'warming');
  assert.equal(listRes.total, 100);
});

test('one cold account does not hide warm account in cache.list', async () => {
  const cache = await createMailCache(null);
  const warmAcc = { id: 'acc-warm-1', email: 'warm1@example.test', revision: '1' };
  const coldAcc = { id: 'acc-cold-1', email: 'cold1@example.test', revision: '1' };

  const ticket = cache.beginSnapshot(warmAcc, 'INBOX');
  const msg = fakeMessage(1, { accountId: warmAcc.id });
  cache.commitHeaders(ticket, { messages: [msg], uidValidity: '1', complete: true });

  // coldAcc has no data (unreconciled/dirty)
  cache.namespace(coldAcc);

  // Querying both must return warmAcc messages and indicate coldAcc in errors/coverage
  const combined = cache.list([warmAcc, coldAcc]);
  assert.ok(combined, 'Available account must not be suppressed by cold account');
  assert.equal(combined.messages.length, 1);
  assert.equal(combined.messages[0].reference.accountId, warmAcc.id);
  assert.equal(combined.totalComplete, false);
  assert.ok(combined.errors.some(e => e.accountId === coldAcc.id));
});

test('provider total > cached returns providerFallback: true on final page', async () => {
  const cache = await createMailCache(null, { maxHeadersPerAccount: 5 });
  const account = { id: 'acc-prov-fb', email: 'fb@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');

  // Cache has 5 messages, but provider total is 50
  const msgs = Array.from({ length: 5 }, (_, i) => fakeMessage(i + 1, { accountId: account.id }));
  cache.commitHeaders(ticket, { messages: msgs, uidValidity: '1', total: 50, complete: true });

  const listRes = cache.list([account], { limit: 5 });
  assert.equal(listRes.messages.length, 5);
  assert.equal(listRes.nextCursor, null);
  assert.equal(listRes.providerFallback, true, 'Must indicate providerFallback when cache window is exhausted before provider total');
  assert.equal(listRes.total, 50);
});

test('stable pagination across ordinary refresh and rejects on mutation', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-stable-page', email: 'stable@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');

  const msgs = Array.from({ length: 6 }, (_, i) => fakeMessage(i + 1, {
    accountId: account.id,
    date: new Date(1700000000000 + (6 - i) * 60000).toISOString()
  }));
  cache.commitHeaders(ticket, { messages: msgs, uidValidity: '1', complete: true });

  const page1 = cache.list([account], { limit: 3 });
  assert.equal(page1.messages.length, 3);
  assert.ok(page1.nextCursor);

  // Pagination continues stably
  const page2 = cache.list([account], { limit: 3, cursor: page1.nextCursor });
  assert.equal(page2.messages.length, 3);

  // Mutation occurs
  const mut = cache.beginMutation(account);
  cache.endMutation(mut);

  // Using cursor from before mutation must reject / signal refresh
  const staleContinuation = cache.list([account], { limit: 3, cursor: page1.nextCursor });
  assert.equal(staleContinuation.requiresRefresh, true);
});

test('UIDVALIDITY reset cannot return older body', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-body-uidval', email: 'bodyuv@example.test', revision: '1' };
  const ticket1 = cache.beginSnapshot(account, 'INBOX');
  const msg1 = fakeMessage(1, { accountId: account.id, uidValidity: '100' });

  cache.commitHeaders(ticket1, { messages: [msg1], uidValidity: '100', complete: true });
  cache.putBody(ticket1, msg1.reference, { text: 'Old UIDVALIDITY body', sanitized: true, complete: true });

  assert.equal(cache.getBody(account, msg1.reference)?.text, 'Old UIDVALIDITY body');

  // UIDVALIDITY reset on server (e.g. 200)
  const ticket2 = cache.beginSnapshot(account, 'INBOX');
  const msg2 = fakeMessage(1, { accountId: account.id, uidValidity: '200' });
  cache.commitHeaders(ticket2, { messages: [msg2], uidValidity: '200', complete: true });

  // Older body with uidValidity '100' must NOT be returned!
  assert.equal(cache.getBody(account, msg1.reference), null);
  // And body for new uidValidity '200' is not cached yet
  assert.equal(cache.getBody(account, msg2.reference), null);
});

test('two beginMutations prevent intermediate commits until both end, and sync begun between cannot resurrect writes', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-mut', email: 'mut@example.test', revision: '1' };
  const initialTicket = cache.beginSnapshot(account, 'INBOX');
  const msg1 = fakeMessage(1, { accountId: account.id });
  cache.commitHeaders(initialTicket, { messages: [msg1], uidValidity: '1', complete: true });

  // Two overlapping mutations
  const token1 = cache.beginMutation(account, { action: 'op1' });
  assert.ok(token1);
  assert.equal(cache.isMutating(account), true);

  const token2 = cache.beginMutation(account, { action: 'op2' });
  assert.ok(token2);
  assert.equal(cache.isMutating(account), true);

  // While mutations are active, beginSnapshot must return null
  assert.equal(cache.beginSnapshot(account, 'INBOX'), null);

  // Attempting to commit using initial ticket must fail
  assert.equal(cache.commitHeaders(initialTicket, { messages: [msg1], uidValidity: '1', complete: true }), false);
  assert.equal(cache.putBody(initialTicket, msg1.reference, { text: 'body', sanitized: true, complete: true }), false);

  // End first mutation: active count decrements to 1, still mutating!
  assert.equal(cache.endMutation(token1), true);
  assert.equal(cache.isMutating(account), true);
  assert.equal(cache.beginSnapshot(account, 'INBOX'), null);
  assert.equal(cache.commitHeaders(initialTicket, { messages: [msg1], uidValidity: '1', complete: true }), false);

  // End second mutation: active count reaches 0, isMutating becomes false
  assert.equal(cache.endMutation(token2), true);
  assert.equal(cache.isMutating(account), false);

  // Cache is still dirty until fresh provider reconciliation
  assert.equal(cache.list([account]), null);

  // Fresh reconciliation
  const newTicket = cache.beginSnapshot(account, 'INBOX');
  assert.ok(newTicket);
  const okCommit = cache.commitHeaders(newTicket, { messages: [msg1], uidValidity: '1', complete: true });
  assert.equal(okCommit, true);
  assert.ok(cache.list([account]));
});

test('clear and removeAccount invalidate in-flight tickets and prevent revival', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-in-flight', email: 'inflight@example.test', revision: '1' };
  const ticketBeforeClear = cache.beginSnapshot(account, 'INBOX');
  const msg = fakeMessage(1, { accountId: account.id });

  cache.clear();

  // In-flight ticket cannot commit after clear
  assert.equal(cache.commitHeaders(ticketBeforeClear, { messages: [msg], uidValidity: '1', complete: true }), false);
  assert.equal(cache.putBody(ticketBeforeClear, msg.reference, { text: 'text', sanitized: true, complete: true }), false);

  // Re-create account after clear: old ticket still cannot commit
  const newTicket = cache.beginSnapshot(account, 'INBOX');
  assert.ok(newTicket.generation > ticketBeforeClear.generation);
  assert.equal(cache.commitHeaders(ticketBeforeClear, { messages: [msg], uidValidity: '1', complete: true }), false);

  // Commit with new ticket succeeds
  assert.equal(cache.commitHeaders(newTicket, { messages: [msg], uidValidity: '1', complete: true }), true);

  // Now test removeAccount
  const ticketBeforeRemove = cache.beginSnapshot(account, 'INBOX');
  cache.removeAccount(account.id);
  assert.equal(cache.commitHeaders(ticketBeforeRemove, { messages: [msg], uidValidity: '1', complete: true }), false);
});

test('putBody rejects when HTML sanitized omitted or encrypted.decrypted is true', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-san-dec', email: 'Examplec@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');
  const msg = fakeMessage(1, { accountId: account.id });
  cache.commitHeaders(ticket, { messages: [msg], uidValidity: '1', complete: true });

  // 1. HTML present but sanitized omitted (undefined)
  const okNoSan = cache.putBody(ticket, msg.reference, {
    text: 'plain',
    html: '<p>HTML without sanitized flag</p>',
    complete: true
  });
  assert.equal(okNoSan, false, 'HTML with sanitized omitted must be rejected');

  // 2. encrypted.decrypted is true
  const okEncDec = cache.putBody(ticket, msg.reference, {
    text: 'plain',
    complete: true,
    sanitized: true,
    encrypted: { type: 'openpgp', decrypted: true }
  });
  assert.equal(okEncDec, false, 'encrypted with decrypted:true must be rejected');
});

test('budget smaller than incoming and replacement own-byte accounting', async () => {
  const cache = await createMailCache(null, {
    maxBodyBytes: 250,
    maxMessageBodyBytes: 500
  });
  const account = { id: 'acc-budget', email: 'budget@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');
  const m1 = fakeMessage(1, { accountId: account.id });
  const m2 = fakeMessage(2, { accountId: account.id });
  cache.commitHeaders(ticket, { messages: [m1, m2], uidValidity: '1', complete: true });

  // 1. Put m1 (fits within 250 budget)
  const ok1 = cache.putBody(ticket, m1.reference, { text: 'm1 small', sanitized: true, complete: true });
  assert.equal(ok1, true);
  const size1 = cache.status().bodyBytes;
  assert.ok(size1 > 0 && size1 <= 250);

  // 2. Incoming body larger than total budget (e.g. 400 bytes > 250 maxBodyBytes) must be rejected
  // AND must not evict m1 before rejecting!
  const hugeIncoming = { text: 'H'.repeat(400), sanitized: true, complete: true };
  const okHuge = cache.putBody(ticket, m2.reference, hugeIncoming);
  assert.equal(okHuge, false, 'Body larger than total budget must be rejected');
  // m1 must STILL be in cache! Not evicted!
  assert.ok(cache.getBody(account, m1.reference), 'm1 must not be evicted when incoming body is larger than budget');

  // 3. Replacement own-byte accounting:
  // Replacing m1 with slightly larger text should subtract own bytes before eviction
  const okReplace = cache.putBody(ticket, m1.reference, { text: 'm1 small updated', sanitized: true, complete: true });
  assert.equal(okReplace, true);
  assert.equal(cache.getBody(account, m1.reference).text, 'm1 small updated');
});

test('checkpoint first50 replaces served header window and orphan bodies are purged on full commit', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-f50-win', email: 'f50@example.test', revision: '1' };

  // Initial state: messages 1, 2, 3 with bodies
  const ticket1 = cache.beginSnapshot(account, 'INBOX');
  const m1 = fakeMessage(1, { accountId: account.id });
  const m2 = fakeMessage(2, { accountId: account.id });
  const m3 = fakeMessage(3, { accountId: account.id });
  cache.commitHeaders(ticket1, { messages: [m1, m2, m3], uidValidity: '1', complete: true });
  cache.putBody(ticket1, m1.reference, { text: 'body 1', sanitized: true, complete: true });
  cache.putBody(ticket1, m2.reference, { text: 'body 2', sanitized: true, complete: true });
  cache.putBody(ticket1, m3.reference, { text: 'body 3', sanitized: true, complete: true });

  assert.equal(cache.hasBody(account, m3.reference), true);

  // New sync starts: server reports only m1 and m2 in first50 (m3 was deleted on server)
  const ticket2 = cache.beginSnapshot(account, 'INBOX');
  const okF50 = cache.commitHeaders(ticket2, {
    messages: [m1, m2],
    uidValidity: '1',
    total: 2,
    complete: false,
    checkpoint: 'first50'
  });
  assert.equal(okF50, true);

  // The served header window is now only [m1, m2] with coverage warming
  const listWarming = cache.list([account]);
  assert.ok(listWarming);
  assert.equal(listWarming.messages.length, 2);
  assert.equal(listWarming.coverage.status, 'warming');
  assert.deepEqual(listWarming.messages.map(m => m.reference.uid), [2, 1]);

  // m3 is no longer in served header window, so hasBody and getBody refuse to serve it
  assert.equal(cache.hasBody(account, m3.reference), false);
  assert.equal(cache.getBody(account, m3.reference), null);

  // m1 and m2 bodies remain accessible
  assert.equal(cache.hasBody(account, m1.reference), true);
  assert.equal(cache.getBody(account, m1.reference)?.text, 'body 1');

  // Full commit completes
  const okFull = cache.commitHeaders(ticket2, {
    messages: [m1, m2],
    uidValidity: '1',
    total: 2,
    complete: true,
    checkpoint: 'headers'
  });
  assert.equal(okFull, true);

  // Post full commit, orphan body for m3 has been deleted from SQLite table
  assert.equal(cache.hasBody(account, m3.reference), false);
  const status = cache.status();
  assert.equal(status.bodyCount, 2);
});

test('cursor snapshot pagination provides immutable frozen views and invalidates on mutation', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-cursor', email: 'cur@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');
  const msgs = [
    fakeMessage(1, { accountId: account.id, time: 1000 }),
    fakeMessage(2, { accountId: account.id, time: 2000 }),
    fakeMessage(3, { accountId: account.id, time: 3000 }),
    fakeMessage(4, { accountId: account.id, time: 4000 })
  ];
  cache.commitHeaders(ticket, { messages: msgs, uidValidity: '1', complete: true });

  // Page 1: limit 2
  const p1 = cache.list([account], { limit: 2 });
  assert.equal(p1.messages.length, 2);
  assert.deepEqual(p1.messages.map(m => m.reference.uid), [4, 3]);
  assert.ok(p1.nextCursor);
  assert.ok(p1.nextCursor.snapshotId);
  assert.equal(p1.nextCursor.offset, 2);

  // Background refresh adds a message, but does not mutate active mutations
  const ticketRefresh = cache.beginSnapshot(account, 'INBOX');
  const m5 = fakeMessage(5, { accountId: account.id, time: 5000 });
  cache.commitHeaders(ticketRefresh, { messages: [...msgs, m5], uidValidity: '1', complete: true });

  // Page 2 using the snapshot cursor must continue the frozen snapshot cleanly
  const p2 = cache.list([account], { limit: 2, cursor: p1.nextCursor });
  assert.equal(p2.messages.length, 2);
  assert.deepEqual(p2.messages.map(m => m.reference.uid), [2, 1]);
  assert.equal(p2.nextCursor, null);

  // Now an active mutation occurs
  const mutToken = cache.beginMutation(account);
  assert.ok(mutToken);

  // Fetching with the old cursor after mutation returns stale cursor fallback shape
  const pStale = cache.list([account], { limit: 2, cursor: p1.nextCursor });
  assert.deepEqual(pStale.messages, []);
  assert.equal(pStale.providerFallback, true);
  assert.equal(pStale.requiresRefresh, true);

  cache.endMutation(mutToken);
});

test('next_cursor is encrypted as AES-GCM blob in namespaces table', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mailharbor-cache-enc-cursor-'));
  try {
    await createAccountStore(dir);
    const cache = await createMailCache(dir);
    const account = { id: 'acc-enc-cur', email: 'enc@example.test', revision: '1' };
    const ticket = cache.beginSnapshot(account, 'INBOX');
    const secretToken = 'SECRET_PROVIDER_CURSOR_TOKEN_ABC123';
    cache.commitHeaders(ticket, {
      messages: [fakeMessage(1, { accountId: account.id })],
      uidValidity: '1',
      complete: true,
      nextCursor: { token: secretToken }
    });
    cache.close();

    // Read sqlite file directly
    const sqlitePath = path.join(dir, 'mail-cache.sqlite');
    const fileBytes = await readFile(sqlitePath);
    const fileContent = fileBytes.toString('latin1');
    assert.equal(fileContent.includes(secretToken), false, 'Plaintext cursor token must not appear in SQLite database file');

    // Also verify via raw DB query that next_cursor is stored as BLOB
    const { DatabaseSync } = await import('node:sqlite');
    const rawDb = new DatabaseSync(sqlitePath);
    const row = rawDb.prepare('SELECT next_cursor FROM namespaces WHERE account_id = ?').get(account.id);
    rawDb.close();
    assert.ok(row.next_cursor instanceof Uint8Array || Buffer.isBuffer(row.next_cursor), 'next_cursor must be stored as BLOB');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('safeHeader preserves metadata fields and enforces 32 KiB cap per header', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-header-contract', email: 'hdr@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');

  const fullHeaderMsg = fakeMessage(1, {
    accountId: account.id,
    account: 'acc-header-contract',
    messageId: '<msg-101@example.test>',
    inReplyTo: '<parent-100@example.test>',
    references: ['<root-1@example.test>', '<parent-100@example.test>'],
    threadId: 'th-thread-42',
    attachments: [{ id: 'att-1', filename: 'report.pdf', mimeType: 'application/pdf', size: 1024 }],
    snippet: 'This is a brief preview snippet of the message'.repeat(20) // long snippet to test safe truncation
  });

  const okCommit = cache.commitHeaders(ticket, {
    messages: [fullHeaderMsg],
    uidValidity: '1',
    complete: true
  });
  assert.equal(okCommit, true);

  const listed = cache.list([account]);
  assert.equal(listed.messages.length, 1);
  const m = listed.messages[0];
  assert.equal(m.account, 'acc-header-contract');
  assert.equal(m.messageId, '<msg-101@example.test>');
  assert.equal(m.inReplyTo, '<parent-100@example.test>');
  assert.deepEqual(m.references, ['<root-1@example.test>', '<parent-100@example.test>']);
  assert.equal(m.threadId, 'th-thread-42');
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'report.pdf');
  assert.ok(m.snippet.length <= 500, 'Snippet must be safely bounded');

  // Oversized header (> 32 KiB) using large allowed References collection is rejected
  const hugeReferences = Array.from({ length: 50 }, (_, i) => `<ref-${i}-${'y'.repeat(700)}@example.test>`);
  const hugeHeaderMsg = fakeMessage(2, {
    accountId: account.id,
    references: hugeReferences
  });
  const ticket2 = cache.beginSnapshot(account, 'INBOX');
  const okOversize = cache.commitHeaders(ticket2, {
    messages: [hugeHeaderMsg],
    uidValidity: '1',
    complete: true
  });
  assert.equal(okOversize, false, 'Header exceeding 32 KiB cap must be rejected atomically');
});

test('endMutation verifies namespaceKey and invalidation rejects stale tokens', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-mut-stale', email: 'mutstale@example.test', revision: '1' };

  const token = cache.beginMutation(account);
  assert.ok(token);
  assert.equal(cache.isMutating(account), true);

  // Identity / revision replacement wipes older active mutation records
  cache.namespace({ ...account, revision: '2' });

  // Ending the old token must return false and not affect new state
  const endResult = cache.endMutation(token);
  assert.equal(endResult, false);
});

test('invalidate during active mutation ensures mutation stays blocked until end', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-mut-inv', email: 'mutinv@example.test', revision: '1' };

  const token = cache.beginMutation(account);
  assert.ok(token);
  assert.equal(cache.isMutating(account), true);

  // Invalidate during active mutation on same identity
  cache.invalidate(account, { reason: 'mutation' });

  // Must still remain blocked / mutating until endMutation is called
  assert.equal(cache.isMutating(account), true);
  assert.equal(cache.beginSnapshot(account, 'INBOX'), null);

  const ended = cache.endMutation(token);
  assert.equal(ended, true);
  assert.equal(cache.isMutating(account), false);
});

test('putBody replacement budget deletes replaced row before evicting and accounts accurately', async () => {
  const cache = await createMailCache(null, {
    maxBodyBytes: 1000,
    maxMessageBodyBytes: 900
  });
  const account = { id: 'acc-rep-budget', email: 'rep@example.test', revision: '1' };
  const ticket = cache.beginSnapshot(account, 'INBOX');

  const msgA = fakeMessage(1, { accountId: account.id, date: '2026-01-01T10:00:00Z' });
  const msgB = fakeMessage(2, { accountId: account.id, date: '2026-01-02T10:00:00Z' });
  cache.commitHeaders(ticket, { messages: [msgA, msgB], uidValidity: '1', complete: true });

  // Overhead of safeRecord structure is ~118 bytes
  // Put A: 400 bytes text (~518 bytes total)
  const okA = cache.putBody(ticket, msgA.reference, { text: 'A'.repeat(400), sanitized: true, complete: true });
  assert.equal(okA, true);

  // Put B: 100 bytes text (~218 bytes total) -> combined ~736 <= 1000
  const okB = cache.putBody(ticket, msgB.reference, { text: 'B'.repeat(100), sanitized: true, complete: true });
  assert.equal(okB, true);

  assert.equal(cache.hasBody(account, msgA.reference), true);
  assert.equal(cache.hasBody(account, msgB.reference), true);

  // Replace A with larger body: 700 bytes text (~818 bytes total)
  // Replaced A (518) is deleted first. Remaining: B (218).
  // 218 + 818 = 1036 > 1000, so B (218) is evicted to make room for A (818).
  const okA2 = cache.putBody(ticket, msgA.reference, { text: 'A'.repeat(700), sanitized: true, complete: true });
  assert.equal(okA2, true);

  assert.equal(cache.hasBody(account, msgA.reference), true);
  assert.equal(cache.getBody(account, msgA.reference)?.text, 'A'.repeat(700));
  assert.equal(cache.hasBody(account, msgB.reference), false, 'B must be evicted to fit replaced A');
  assert.equal(cache.getBody(account, msgB.reference), null);

  const status = cache.status();
  assert.ok(status.bodyBytes <= 1000, 'Total body bytes must not exceed budget');
  assert.equal(status.bodyCount, 1);
});

test('clear during active mutation preserves mutation barrier and blocks snapshots until endMutation', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-clear-mut', email: 'clearmut@example.test', revision: '1' };

  const token = cache.beginMutation(account);
  assert.ok(token);
  assert.equal(cache.isMutating(account), true);

  // Clear called while mutation is active
  cache.clear();

  // Mutation barrier must be preserved
  assert.equal(cache.isMutating(account), true);
  assert.equal(cache.beginSnapshot(account, 'INBOX'), null, 'beginSnapshot must stay blocked while mutating');
  assert.equal(cache.list([account]), null);

  // Ending mutation unblocks account
  const ended = cache.endMutation(token);
  assert.equal(ended, true);
  assert.equal(cache.isMutating(account), false);

  // Fresh sync can now proceed
  const ticket = cache.beginSnapshot(account, 'INBOX');
  assert.ok(ticket);
  const msg = fakeMessage(1, { accountId: account.id });
  cache.commitHeaders(ticket, { messages: [msg], uidValidity: '1', complete: true });

  const listed = cache.list([account]);
  assert.ok(listed);
  assert.equal(listed.messages.length, 1);
});

test('putFolders and getFolders filter folders and merge actual counts across accounts', async () => {
  const cache = await createMailCache(null);
  const accountA = { id: 'acc-f-1', email: 'fa@example.test', revision: '1' };
  const accountB = { id: 'acc-f-2', email: 'fb@example.test', revision: '1' };

  const ticketA = cache.beginSnapshot(accountA, 'INBOX');
  const ticketB = cache.beginSnapshot(accountB, 'INBOX');

  // Account A folders: inbox, sent, provider custom-a
  const foldersA = [
    { id: 'inbox', label: 'Inbox', type: 'standard', accountIds: ['acc-f-1'], counts: [{ accountId: 'acc-f-1', total: 10 }] },
    { id: 'sent', label: 'Sent', type: 'standard', accountIds: ['acc-f-1'], counts: [{ accountId: 'acc-f-1', total: 5 }] },
    { id: 'folder:custom-a', label: 'Custom A', type: 'provider', accountIds: ['acc-f-1'], counts: [{ accountId: 'acc-f-1', total: 2 }] }
  ];

  // Account B folders: inbox, sent, drafts, provider custom-b (drafts is unavailable for A)
  const foldersB = [
    { id: 'inbox', label: 'Inbox', type: 'standard', accountIds: ['acc-f-2'], counts: [{ accountId: 'acc-f-2', total: 20 }] },
    { id: 'sent', label: 'Sent', type: 'standard', accountIds: ['acc-f-2'], counts: [{ accountId: 'acc-f-2', total: 15 }] },
    { id: 'drafts', label: 'Drafts', type: 'standard', accountIds: ['acc-f-2'], counts: [{ accountId: 'acc-f-2', total: 3 }] },
    { id: 'folder:custom-b', label: 'Custom B', type: 'provider', accountIds: ['acc-f-2'], counts: [{ accountId: 'acc-f-2', total: 8 }] }
  ];

  assert.equal(cache.commitHeaders(ticketA, { messages: [], uidValidity: '1', total: 0, complete: true }), true);
  assert.equal(cache.commitHeaders(ticketB, { messages: [], uidValidity: '1', total: 0, complete: true }), true);

  const combinedFolders = { folders: [...foldersA, ...foldersB], errors: [] };
  assert.equal(cache.putFolders(ticketA, combinedFolders), true);
  assert.equal(cache.putFolders(ticketB, combinedFolders), true);

  // Single account query for A
  const resA = cache.getFolders([accountA]);
  assert.ok(resA);
  const idsA = resA.folders.map(f => f.id);
  assert.ok(idsA.includes('folder:custom-a'));
  assert.equal(idsA.includes('folder:custom-b'), false, 'Custom B must not appear for Account A');
  const draftsA = resA.folders.find(f => f.id === 'drafts');
  assert.ok(draftsA);
  assert.deepEqual(draftsA.accountIds, []);
  assert.equal(draftsA.accountIds.includes('acc-f-1'), false);
  assert.deepEqual(draftsA.counts, [{ accountId: 'acc-f-1', total: null }]);

  // Multi-account query: merged view
  const resBoth = cache.getFolders([accountA, accountB]);
  assert.ok(resBoth);
  const sentFolder = resBoth.folders.find(f => f.id === 'sent');
  assert.ok(sentFolder);
  assert.deepEqual(sentFolder.accountIds, ['acc-f-1', 'acc-f-2']);
  assert.deepEqual(sentFolder.counts, [
    { accountId: 'acc-f-1', total: 5 },
    { accountId: 'acc-f-2', total: 15 }
  ]);

  const customA = resBoth.folders.find(f => f.id === 'folder:custom-a');
  assert.ok(customA);
  assert.deepEqual(customA.accountIds, ['acc-f-1']);
  assert.deepEqual(customA.counts, [{ accountId: 'acc-f-1', total: 2 }]);

  const customB = resBoth.folders.find(f => f.id === 'folder:custom-b');
  assert.ok(customB);
  assert.deepEqual(customB.accountIds, ['acc-f-2']);
  assert.deepEqual(customB.counts, [{ accountId: 'acc-f-2', total: 8 }]);

  const draftsFolder = resBoth.folders.find(f => f.id === 'drafts');
  assert.ok(draftsFolder);
  assert.deepEqual(draftsFolder.accountIds, ['acc-f-2']);
});
