import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailCache } from '../server/mail-cache.mjs';
import { createMailCacheReader } from '../server/mail-cache-reader.mjs';

function fakeMessage(uid, overrides = {}) {
  const accountId = overrides.accountId || 'acc-1';
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
    snippet: `Snippet text for message ${uid} with extra details`.padEnd(200, 'x'),
    attachments: Array.from({ length: 110 }, (_, i) => ({ filename: `file-${i}.txt`, size: 10 })),
    reference: {
      accountId,
      path: 'INBOX',
      uid,
      uidValidity: overrides.uidValidity || '1',
      fingerprint: `fp-${uid}`.padEnd(64, '0'),
      ...(overrides.reference ?? {})
    },
    ...overrides
  };
}

function mockStore(initial = {}) {
  let data = structuredClone(initial);
  return {
    read() { return structuredClone(data); },
    async update(fn) { data = await fn(structuredClone(data)); return structuredClone(data); }
  };
}

function mockRealAccountsService(accountsList) {
  let fullList = structuredClone(accountsList);
  return {
    list() {
      return fullList.map(a => ({
        id: a.id,
        email: a.email,
        connected: a.connected !== false
      }));
    },
    get(id) {
      const found = fullList.find(a => a.id === id);
      return found ? structuredClone(found) : null;
    },
    set(newList) {
      fullList = structuredClone(newList);
    }
  };
}

function mockProviderReader(calls = []) {
  return {
    calls,
    async list(accounts, options = {}) {
      calls.push({ action: 'list', accounts: accounts.map(a => a.id), options });
      if (!accounts || accounts.length === 0) {
        return {
          messages: [],
          errors: [],
          total: 0,
          totalComplete: true,
          nextCursor: null
        };
      }
      return {
        messages: [fakeMessage(1, { accountId: accounts[0]?.id || 'acc-1' })],
        errors: [],
        total: 1,
        totalComplete: true,
        nextCursor: null
      };
    },
    async folders(accounts, options = {}) {
      calls.push({ action: 'folders', accounts: accounts.map(a => a.id), options });
      return {
        folders: [
          { id: 'inbox', label: 'Inbox', type: 'standard', accountIds: accounts.map(a => a.id), counts: [] }
        ],
        errors: []
      };
    },
    async read(account, reference, options = {}) {
      calls.push({ action: 'read', accountId: account.id, reference, options });
      return {
        id: `read-${reference.uid}`,
        accountId: account.id,
        folderPath: reference.path,
        subject: `Read Subject ${reference.uid}`,
        body: `Read body for ${reference.uid}`,
        truncated: false,
        bodyUnavailable: false,
        attachments: [],
        reference
      };
    },
    async content(account, reference, options = {}) {
      calls.push({ action: 'content', accountId: account.id, reference, options });
      return {
        id: `content-${reference.uid}`,
        accountId: account.id,
        folderPath: reference.path,
        subject: `Content Subject ${reference.uid}`,
        text: `Content text for ${reference.uid}`,
        html: `<p>Content html for ${reference.uid}</p>`,
        complete: true,
        sanitized: false,
        encrypted: null,
        attachments: [],
        reference
      };
    },
    async apply(account, reference, action, options = {}) {
      calls.push({ action: 'apply', accountId: account.id, reference, actionType: action, options });
      return { applied: true };
    },
    async emptyTrash(account, options = {}) {
      calls.push({ action: 'emptyTrash', accountId: account.id, options });
      return { deleted: 1, remaining: 0, partial: false, errors: [] };
    },
    async manageFolder(account, request, options = {}) {
      calls.push({ action: 'manageFolder', accountId: account.id, request, options });
      return { applied: true, folder: { id: 'custom-folder', label: request.name, type: 'provider', accountIds: [account.id], counts: [] } };
    },
    async setProviderLabel(account, reference, request = {}, options = {}) {
      calls.push({ action: 'setProviderLabel', accountId: account.id, reference, request, options });
      return { applied: true };
    }
  };
}

test('initializes cached header cap from store if valid integer in 100..5000', async () => {
  const cache = await createMailCache(null);
  const store = mockStore({ mailCacheSettings: { maxHeadersPerAccount: 350 } });
  const reader = mockProviderReader();

  const adapter = await createMailCacheReader({
    reader,
    cache,
    store,
    enabled: true
  });

  const stat = adapter.status();
  assert.equal(stat.maxHeadersPerAccount, 350);

  cache.close();
});

test('leaves default header cap if store has invalid or out-of-range value', async () => {
  const cache = await createMailCache(null);
  const store = mockStore({ mailCacheSettings: { maxHeadersPerAccount: 99999 } });
  const reader = mockProviderReader();

  const adapter = await createMailCacheReader({
    reader,
    cache,
    store,
    enabled: true
  });

  const stat = adapter.status();
  assert.equal(stat.maxHeadersPerAccount, 500);

  cache.close();
});

test('disabled cache delegates list, folders, read, and content directly to provider with normalized metadata', async () => {
  const cache = await createMailCache(null);
  const calls = [];
  const reader = mockProviderReader(calls);
  const account = { id: 'acc-disabled', email: 'dis@example.test', revision: '1' };

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: false
  });

  const stat = adapter.status();
  assert.equal(stat.enabled, false);

  const listRes = await adapter.reader.list([account]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'list');
  assert.equal(listRes.source, 'provider');

  const folderRes = await adapter.reader.folders([account]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].action, 'folders');

  const ref = { accountId: account.id, path: 'INBOX', uid: 1, uidValidity: '1', fingerprint: 'fp-1'.padEnd(64, '0') };
  const readRes = await adapter.reader.read(account, ref);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].action, 'read');

  const contentRes = await adapter.reader.content(account, ref);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].action, 'content');
  assert.equal(contentRes.source, 'provider');

  cache.close();
});

test('disabled cache withMutation invalidates cache and runs work without refreshing', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-dis-mut', email: 'dismut@example.test', revision: '1' };
  let refreshCalled = false;
  const sync = { refresh: async () => { refreshCalled = true; }, status: () => ({ active: [], pending: [], accounts: [] }) };
  const reader = mockProviderReader();

  const adapter = await createMailCacheReader({
    reader,
    cache,
    sync,
    accounts: [account],
    enabled: false
  });

  let workDone = false;
  await adapter.withMutation(account, { reason: 'test-change' }, async () => {
    workDone = true;
  });

  assert.equal(workDone, true);
  assert.equal(refreshCalled, false, 'Disabled cache must not trigger sync refresh');

  cache.close();
});

test('reader.list on warm cache hit returns cached messages with zero provider calls', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-warm-list', email: 'warmlist@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  // Prime cache
  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [msg],
    uidValidity: '1',
    total: 1,
    complete: true,
    checkpoint: 'first50'
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const res = await adapter.reader.list([account]);
  assert.equal(calls.length, 0, 'Warm cache hit must make ZERO provider calls');
  assert.equal(res.source, 'cache');
  assert.equal(res.messages.length, 1);
  assert.equal(res.messages[0].subject, msg.subject);

  // Check snippet bounding <= 160 and attachments <= 100
  assert.ok(res.messages[0].snippet.length <= 160);
  assert.ok(res.messages[0].attachments.length <= 100);
  assert.equal(typeof res.messages[0].attachments[0].filename, 'string');
  assert.equal(res.messages[0].attachments[0].content, undefined, 'No attachment bytes allowed in list output');

  cache.close();
});

test('reader.list pagination wraps cache cursor and returns providerFallback on last page', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-page', email: 'page@example.test', revision: '1' };
  const messages = Array.from({ length: 60 }, (_, i) => fakeMessage(i + 1, { accountId: account.id }));

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages,
    uidValidity: '1',
    total: 100, // Provider total is greater than cached messages
    complete: true,
    checkpoint: 'first50'
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  // First page (limit 50)
  const page1 = await adapter.reader.list([account], { limit: 50 });
  assert.equal(calls.length, 0);
  assert.equal(page1.messages.length, 50);
  assert.ok(page1.nextCursor);
  assert.equal(page1.nextCursor.kind, 'cache');

  // Second page via wrapped cursor
  const page2 = await adapter.reader.list([account], { limit: 50, cursor: page1.nextCursor });
  assert.equal(calls.length, 0);
  assert.equal(page2.messages.length, 10);
  assert.equal(page2.nextCursor, null);
  assert.equal(page2.providerFallback, true, 'Final cache page must indicate providerFallback when provider has more');

  cache.close();
});

test('reader.list with live: true calls provider with live stripped and wraps provider cursor', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-live', email: 'live@example.test', revision: '1' };

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [fakeMessage(1, { accountId: account.id })],
    uidValidity: '1',
    total: 1,
    complete: true
  });

  const calls = [];
  const reader = {
    calls,
    async list(accounts, options = {}) {
      calls.push({ action: 'list', options });
      assert.equal(options.live, undefined, 'Live flag must be stripped when forwarding to provider');
      return {
        messages: [fakeMessage(99, { accountId: account.id })],
        errors: [],
        total: 99,
        totalComplete: true,
        nextCursor: 'prov-cursor-123'
      };
    }
  };

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const res = await adapter.reader.list([account], { live: true });
  assert.equal(calls.length, 1);
  assert.equal(res.source, 'provider');
  assert.equal(res.messages[0].reference.uid, 99);
  assert.deepEqual(res.nextCursor, { kind: 'provider', cursor: 'prov-cursor-123' });

  // Continuation of provider pagination
  const resPage2 = await adapter.reader.list([account], { cursor: res.nextCursor });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.cursor, 'prov-cursor-123');
  assert.equal(resPage2.source, 'provider');

  cache.close();
});

test('reader.list with search filter, false filters, scoped[], sort, query, or non-inbox folder bypasses cache to provider', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-search', email: 'search@example.test', revision: '1' };

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  // Query filter
  await adapter.reader.list([account], { query: 'invoice' });
  assert.equal(calls.length, 1);

  // Non-inbox folder
  await adapter.reader.list([account], { folder: 'sent' });
  assert.equal(calls.length, 2);

  // Body search
  await adapter.reader.list([account], { bodySearch: true });
  assert.equal(calls.length, 3);

  // filters with ANY key (including unread: false)
  await adapter.reader.list([account], { filters: { unread: false } });
  assert.equal(calls.length, 4);

  // scopedReferences: [] (meaningful empty search bypasses cache)
  await adapter.reader.list([account], { scopedReferences: [] });
  assert.equal(calls.length, 5);

  // Alternate sort
  await adapter.reader.list([account], { sort: 'date_asc' });
  assert.equal(calls.length, 6);

  cache.close();
});

test('reader.list rejects malformed and cross-source cursors, handles stale cache cursor with requiresRefresh and providerFallback', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-cursor-test', email: 'cursor@example.test', revision: '1' };
  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  // Malformed cursor: string
  await assert.rejects(
    adapter.reader.list([account], { cursor: 'malformed-string' }),
    { code: 'invalid_request' }
  );

  // Malformed cursor: invalid kind
  await assert.rejects(
    adapter.reader.list([account], { cursor: { kind: 'unknown', cursor: 123 } }),
    { code: 'invalid_request' }
  );

  // Cross-source cursor: cache cursor passed to provider request (live: true)
  await assert.rejects(
    adapter.reader.list([account], { live: true, cursor: { kind: 'cache', cursor: { offset: 10 } } }),
    { code: 'invalid_request' }
  );

  // Stale cache cursor
  const staleCursor = { kind: 'cache', cursor: { snapshotId: 'non-existent-snap', offset: 50 } };
  const res = await adapter.reader.list([account], { cursor: staleCursor });

  assert.equal(res.source, 'cache');
  assert.equal(res.requiresRefresh, true);
  assert.equal(res.providerFallback, true);
  assert.equal(res.messages.length, 0);

  cache.close();
});

test('reader.folders warm hit returns cached folders without calling provider', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-folders-warm', email: 'fwarm@example.test', revision: '1' };

  // Prime cache with headers and folders
  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [fakeMessage(1, { accountId: account.id })],
    uidValidity: '1',
    total: 1,
    complete: true
  });
  cache.putFolders(ticket, {
    folders: [
      { id: 'inbox', label: 'Inbox', type: 'standard', accountIds: [account.id], counts: [{ accountId: account.id, total: 1 }] },
      { id: 'custom-notes', label: 'Notes', type: 'provider', accountIds: [account.id], counts: [{ accountId: account.id, total: 5 }] }
    ]
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const res = await adapter.reader.folders([account]);
  assert.equal(calls.length, 0, 'Warm folder hit must make ZERO provider calls');
  assert.equal(res.source, 'cache');
  assert.ok(res.folders.some(f => f.id === 'custom-notes'));

  cache.close();
});

test('reader.folders cold miss calls provider and admits folders under snapshot ticket', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-folders-cold', email: 'fcold@example.test', revision: '1' };

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const res = await adapter.reader.folders([account]);
  assert.equal(calls.length, 1);
  assert.equal(res.source, 'provider');

  cache.close();
});

test('reader.read warm hit returns body and preserves current header unread/starred flags', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-read-warm', email: 'readwarm@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id, unread: false, starred: true });

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [msg],
    uidValidity: '1',
    total: 1,
    complete: true
  });
  cache.putBody(ticket, msg.reference, {
    text: 'Cached body content',
    html: '<p>Cached body content</p>',
    sanitized: true,
    complete: true,
    attachments: []
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const res = await adapter.reader.read(account, msg.reference);
  assert.equal(calls.length, 0, 'Warm read hit must make ZERO provider calls');
  assert.equal(res.source, 'cache');
  assert.equal(res.body, 'Cached body content');
  assert.equal(res.truncated, false);
  assert.equal(res.bodyUnavailable, false);
  assert.equal(res.unread, false, 'Unread flag must be preserved from header');
  assert.equal(res.starred, true, 'Starred flag must be preserved from header');

  cache.close();
});

test('reader.content warm hit returns cached sanitized content without provider call', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-content-warm', email: 'cwarm@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [msg],
    uidValidity: '1',
    total: 1,
    complete: true
  });
  cache.putBody(ticket, msg.reference, {
    text: 'Sanitized text',
    html: '<div>Sanitized html</div>',
    sanitized: true,
    complete: true,
    attachments: []
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const res = await adapter.reader.content(account, msg.reference);
  assert.equal(calls.length, 0, 'Warm content hit must make ZERO provider calls');
  assert.equal(res.source, 'cache');
  assert.equal(res.text, 'Sanitized text');
  assert.equal(res.html, '<div>Sanitized html</div>');

  cache.close();
});

test('reader.content cold miss fetches from provider, sanitizes, and admits into cache', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-content-cold', email: 'ccold@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  // Header exists in cache
  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [msg],
    uidValidity: '1',
    total: 1,
    complete: true
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const res = await adapter.reader.content(account, msg.reference);
  assert.equal(calls.length, 1);
  assert.equal(res.source, 'provider');
  assert.equal(res.sanitized, true);

  // Subsequent call should hit cache!
  const res2 = await adapter.reader.content(account, msg.reference);
  assert.equal(calls.length, 1, 'Subsequent call must hit cache without second provider call');
  assert.equal(res2.source, 'cache');

  cache.close();
});

test('reader.content with privateKey/certificate/includeInlineImages bypasses cache, returns source provider, and never admits', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-content-decrypt', email: 'cdecrypt@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [msg],
    uidValidity: '1',
    total: 1,
    complete: true
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  // Call with privateKey
  const res = await adapter.reader.content(account, msg.reference, { privateKey: 'secret-key' });
  assert.equal(calls.length, 1);
  assert.equal(res.source, 'provider');
  assert.equal(cache.hasBody(account, msg.reference), false, 'Decrypted content must NEVER be admitted into cache');

  // Call with certificate
  const resCert = await adapter.reader.content(account, msg.reference, { certificate: 'user-cert' });
  assert.equal(calls.length, 2);
  assert.equal(resCert.source, 'provider');

  // Call with includeInlineImages
  const resInline = await adapter.reader.content(account, msg.reference, { includeInlineImages: true });
  assert.equal(calls.length, 3);
  assert.equal(resInline.source, 'provider');

  cache.close();
});

test('reader.content > 2 MiB served to caller up to 8 MiB but not admitted to cache', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-large-content', email: 'large@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [msg],
    uidValidity: '1',
    total: 1,
    complete: true
  });

  const largeText = 'a'.repeat(2.5 * 1024 * 1024); // 2.5 MiB
  const calls = [];
  const reader = {
    calls,
    async content(acc, ref, options) {
      calls.push(options);
      assert.equal(options.maxDecodedBytes, 8 * 1024 * 1024);
      assert.equal(options.maxEncodedBytes, 32 * 1024 * 1024);
      return {
        id: 'large-msg',
        accountId: acc.id,
        folderPath: ref.path,
        text: largeText,
        html: '',
        complete: true,
        sanitized: true,
        attachments: [],
        reference: ref
      };
    }
  };

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const res = await adapter.reader.content(account, msg.reference);
  assert.equal(res.source, 'provider');
  assert.equal(res.text.length, largeText.length);
  assert.equal(cache.hasBody(account, msg.reference), false, 'Content > 2 MiB must not be admitted to cache');

  cache.close();
});

test('reader.content sanitizes content even when ticket is null/unavailable', async () => {
  const account = { id: 'acc-noticket', email: 'noticket@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  const reader = {
    async content(acc, ref) {
      return {
        id: 'dirty-content',
        accountId: acc.id,
        folderPath: ref.path,
        text: 'dirty text',
        html: '<p>Hello</p><script>alert("evil")</script>',
        complete: true,
        sanitized: false,
        attachments: [],
        reference: ref
      };
    }
  };

  // Cache is null (no ticket can ever be created)
  const adapter = await createMailCacheReader({
    reader,
    cache: null,
    accounts: [account],
    enabled: true
  });

  const res = await adapter.reader.content(account, msg.reference);
  assert.equal(res.source, 'provider');
  assert.equal(res.sanitized, true);
  assert.ok(!res.html.includes('<script>'), 'HTML must be sanitized even without cache ticket');
});

test('all four warm methods (list, folders, read, content) make zero synchronous provider calls', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-all-warm', email: 'allwarm@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [msg],
    uidValidity: '1',
    total: 1,
    complete: true
  });
  cache.putFolders(ticket, {
    folders: [{ id: 'inbox', label: 'Inbox', type: 'standard', accountIds: [account.id], counts: [] }]
  });
  cache.putBody(ticket, msg.reference, {
    text: 'Body warm',
    html: '<p>Body warm</p>',
    sanitized: true,
    complete: true,
    attachments: []
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  await adapter.reader.list([account]);
  await adapter.reader.folders([account]);
  await adapter.reader.read(account, msg.reference);
  await adapter.reader.content(account, msg.reference);

  assert.equal(calls.length, 0, 'All four warm methods must make ZERO synchronous provider calls');

  cache.close();
});

test('resolves real public list presets to full accounts and rejects stale account cache hits', async () => {
  const cache = await createMailCache(null);
  const fullAccount1 = { id: 'acc-1', email: 'acc1@example.test', revision: '2', connected: true, host: 'imap.test', provider: 'generic' };
  const fullAccount2 = { id: 'acc-2', email: 'acc2@example.test', revision: '1', connected: false, host: 'imap.test', provider: 'generic' };

  const accountsService = mockRealAccountsService([fullAccount1, fullAccount2]);
  const calls = [];
  const reader = mockProviderReader(calls);

  // Prime cache for acc-1 with revision 2
  const ticket = cache.beginSnapshot(fullAccount1, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [fakeMessage(1, { accountId: fullAccount1.id })],
    uidValidity: '1',
    total: 1,
    complete: true
  });

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: accountsService,
    enabled: true
  });

  // Status must only filter to connected accounts
  const stat = adapter.status();
  assert.equal(stat.accounts.length, 1);
  assert.equal(stat.accounts[0].accountId, 'acc-1');

  // Stale account caller (old revision 1) must not hit cache, must fall back to provider
  const staleCaller = { id: 'acc-1', email: 'acc1@example.test', revision: '1' };
  const res = await adapter.reader.list([staleCaller]);
  assert.equal(calls.length, 1);
  assert.equal(res.source, 'provider');

  cache.close();
});

test('null cache or unhealthy cache reports healthy: false, error: cache_unavailable, and falls back to provider', async () => {
  const account = { id: 'acc-null-cache', email: 'null@example.test', revision: '1' };
  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache: null,
    accounts: [account],
    enabled: true
  });

  const stat = adapter.status();
  assert.equal(stat.healthy, false);
  assert.equal(stat.error, 'cache_unavailable');

  const res = await adapter.reader.list([account]);
  assert.equal(calls.length, 1);
  assert.equal(res.source, 'provider');

  const readRes = await adapter.reader.read(account, { accountId: account.id, path: 'INBOX', uid: 1, uidValidity: '1', fingerprint: 'fp' });
  assert.equal(calls.length, 2);
  assert.equal(readRes.source, 'provider');
});

test('withMutation (3 args), automatic mutator wrapping, refcounts, failing provider, and cache throws', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-with-mut', email: 'withmut@example.test', revision: '1' };
  let refreshCalled = false;
  let refreshPriority = false;
  const sync = {
    refresh: async (ids, opts) => {
      refreshCalled = true;
      refreshPriority = opts?.priority === true;
    },
    status: () => ({ active: [], pending: [], accounts: [] })
  };
  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    sync,
    accounts: [account],
    enabled: true
  });

  // 1. Nested mutation maintains refcount
  let innerMutating = false;
  await adapter.withMutation(account, { reason: 'outer' }, async () => {
    assert.equal(cache.isMutating(account), true);

    await adapter.withMutation(account, { reason: 'inner' }, async () => {
      innerMutating = cache.isMutating(account);
      assert.equal(innerMutating, true);
    });

    assert.equal(cache.isMutating(account), true);
  });

  assert.equal(cache.isMutating(account), false);
  assert.equal(refreshCalled, true);
  assert.equal(refreshPriority, true);

  // 2. Automatic wrapping of known mutators on reader
  refreshCalled = false;
  const ref = { accountId: account.id, path: 'INBOX', uid: 1, uidValidity: '1', fingerprint: 'fp-1'.padEnd(64, '0') };

  await adapter.reader.apply(account, ref, 'mark_read', {});
  assert.equal(calls.some(c => c.action === 'apply'), true);
  assert.equal(refreshCalled, true);

  refreshCalled = false;
  await adapter.reader.emptyTrash(account, {});
  assert.equal(calls.some(c => c.action === 'emptyTrash'), true);
  assert.equal(refreshCalled, true);

  refreshCalled = false;
  await adapter.reader.manageFolder(account, { name: 'Folder1' });
  assert.equal(calls.some(c => c.action === 'manageFolder'), true);
  assert.equal(refreshCalled, true);

  refreshCalled = false;
  await adapter.reader.setProviderLabel(account, ref, { label: 'tag1' });
  assert.equal(calls.some(c => c.action === 'setProviderLabel'), true);
  assert.equal(refreshCalled, true);

  // 3. Provider error is thrown as the exact same error object
  const customError = new Error('delete_failed');
  customError.code = 'delete_failed';
  customError.customProp = 'custom-value';

  await assert.rejects(
    adapter.withMutation(account, { reason: 'fail-test' }, async () => {
      throw customError;
    }),
    err => err === customError && err.code === 'delete_failed' && err.customProp === 'custom-value'
  );

  // 4. Cache method throwing does not prevent provider work or mask provider error
  cache.beginMutation = () => { throw new Error('cache broken'); };
  let workDone = false;
  await adapter.withMutation(account, { reason: 'broken-cache' }, async () => {
    workDone = true;
  });
  assert.equal(workDone, true);

  cache.close();
});

test('status() returns exact public whitelist without internal leaks, oldest timestamp, and tick revision', async () => {
  const cache = await createMailCache(null);
  const account1 = { id: 'acc-1', email: 'acc1@example.test', password: 'secret-password-1', revision: '1' };
  const account2 = { id: 'acc-2', email: 'acc2@example.test', password: 'secret-password-2', revision: '1' };

  // Prime cache
  const t1 = cache.beginSnapshot(account1, 'INBOX');
  cache.commitHeaders(t1, { messages: [fakeMessage(1, { accountId: 'acc-1' })], uidValidity: '1', total: 1, complete: true });

  const t2 = cache.beginSnapshot(account2, 'INBOX');
  cache.commitHeaders(t2, { messages: [fakeMessage(2, { accountId: 'acc-2' })], uidValidity: '1', total: 1, complete: true });

  const sync = {
    status() {
      return {
        active: [],
        pending: [],
        accounts: [
          { accountId: 'acc-1', lastSuccessfulUpdate: 1000, lastAttemptedUpdate: 1100, error: null },
          { accountId: 'acc-2', lastSuccessfulUpdate: 2000, lastAttemptedUpdate: 2100, error: null }
        ]
      };
    }
  };

  const reader = mockProviderReader();

  const adapter = await createMailCacheReader({
    reader,
    cache,
    sync,
    accounts: [account1, account2],
    enabled: true
  });

  const stat = adapter.status();

  // Strict whitelist checks: no generation, dirty, reconciled, activeMutations, folderMetadata, namespaceKey
  assert.equal(stat.generation, undefined);
  assert.equal(stat.dirty, undefined);
  assert.equal(stat.reconciled, undefined);
  assert.equal(stat.activeMutations, undefined);
  assert.equal(stat.folderMetadata, undefined);
  assert.equal(stat.namespaceKey, undefined);

  for (const acc of stat.accounts) {
    assert.equal(acc.generation, undefined);
    assert.equal(acc.dirty, undefined);
    assert.equal(acc.reconciled, undefined);
    assert.equal(acc.activeMutations, undefined);
    assert.equal(acc.folderMetadata, undefined);
    assert.equal(acc.namespaceKey, undefined);
    assert.equal(acc.password, undefined);
  }

  const serialized = JSON.stringify(stat);
  assert.ok(!serialized.includes('secret-password-1'));
  assert.ok(!serialized.includes('secret-password-2'));

  // Verify list() oldest timestamp is 1000 (NOT maximum 2000)
  const listRes = await adapter.reader.list([account1, account2]);
  assert.equal(listRes.lastSuccessfulSync, 1000, 'lastSuccessfulSync must be OLDEST covered timestamp');

  // Verify revision ticks when cache changes
  const initialRevision = stat.revision;
  // Commit new message to advance generation/content
  const t3 = cache.beginSnapshot(account1, 'INBOX');
  cache.commitHeaders(t3, { messages: [fakeMessage(1, { accountId: 'acc-1' }), fakeMessage(3, { accountId: 'acc-1' })], uidValidity: '1', total: 2, complete: true });

  const updatedStat = adapter.status();
  assert.notEqual(updatedStat.revision, initialRevision, 'Revision must change when cache generation/content changes');

  cache.close();
});

test('configure({ maxHeadersPerAccount }) enforces exact object 100..5000, rejects extra keys, mutates store, and returns promptly', async () => {
  const cache = await createMailCache(null);
  const store = mockStore();
  const account = { id: 'acc-config', email: 'cfg@example.test', revision: '1' };
  let refreshCalled = false;
  const sync = {
    refresh: async () => { refreshCalled = true; },
    status: () => ({ active: [], pending: [], accounts: [] })
  };
  const reader = mockProviderReader();

  const adapter = await createMailCacheReader({
    reader,
    cache,
    sync,
    store,
    accounts: [account],
    enabled: true
  });

  // Rejects extra keys
  await assert.rejects(
    adapter.configure({ maxHeadersPerAccount: 500, extraKey: 'forbidden' }),
    { code: 'invalid_request' }
  );

  // Rejects < 100
  await assert.rejects(adapter.configure({ maxHeadersPerAccount: 50 }), { code: 'invalid_request' });

  // Rejects > 5000
  await assert.rejects(adapter.configure({ maxHeadersPerAccount: 6000 }), { code: 'invalid_request' });

  // Rejects non-integer
  await assert.rejects(adapter.configure({ maxHeadersPerAccount: '300' }), { code: 'invalid_request' });

  // Valid configure mutates store and returns promptly
  const updatedStat = await adapter.configure({ maxHeadersPerAccount: 1200 });
  assert.equal(updatedStat.maxHeadersPerAccount, 1200);
  assert.equal(store.read()?.mailCacheSettings?.maxHeadersPerAccount, 1200);
  assert.equal(refreshCalled, true);

  cache.close();
});

test('snippets extracted from cached body text without calling provider', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-snippet', email: 'snip@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id, snippet: '' });

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [msg],
    uidValidity: '1',
    total: 1,
    complete: true
  });
  cache.putBody(ticket, msg.reference, {
    text: 'Body snippet text from cached content',
    html: '<p>Body snippet text from cached content</p>',
    sanitized: true,
    complete: true,
    attachments: []
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const res = await adapter.reader.list([account]);
  assert.equal(calls.length, 0);
  assert.equal(res.messages[0].snippet, 'Body snippet text from cached content');

  cache.close();
});

test('clear() purges cache, triggers refresh if enabled, and returns status promptly', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-clear', email: 'clr@example.test', revision: '1' };
  const msg = fakeMessage(1, { accountId: account.id });

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [msg],
    uidValidity: '1',
    total: 1,
    complete: true
  });
  assert.equal(cache.status().headerCount, 1);

  let refreshCalled = false;
  const sync = {
    refresh: async () => { refreshCalled = true; },
    status: () => ({ active: [], pending: [], accounts: [] })
  };
  const reader = mockProviderReader();

  const adapter = await createMailCacheReader({
    reader,
    cache,
    sync,
    accounts: [account],
    enabled: true
  });

  const clearStat = await adapter.clear();
  assert.equal(clearStat.headerCount, 0);
  assert.equal(refreshCalled, true);

  cache.close();
});

test('refresh() queues coalesced sync and returns status promptly', async () => {
  const cache = await createMailCache(null);
  let refreshedIds = null;
  const sync = {
    refresh: async (ids) => { refreshedIds = ids; },
    status: () => ({ active: [], pending: [], accounts: [] })
  };
  const reader = mockProviderReader();

  const adapter = await createMailCacheReader({
    reader,
    cache,
    sync,
    enabled: true
  });

  const stat = await adapter.refresh(['acc-1']);
  assert.deepEqual(refreshedIds, ['acc-1']);
  assert.ok(stat);

  cache.close();
});

test('reader.list with empty accounts array returns truthful empty result when enabled and disabled', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-existing', email: 'existing@example.test', revision: '1' };

  // Prime cache with an existing account so we can verify no phantom coverage leaks into empty list result
  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [fakeMessage(1, { accountId: account.id })],
    uidValidity: '1',
    total: 1,
    complete: true
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  // 1. Enabled cache
  const adapterEnabled = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const resEnabled = await adapterEnabled.reader.list([]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accounts.length, 0);
  assert.deepEqual(resEnabled.messages, []);
  assert.equal(resEnabled.total, 0);
  assert.equal(resEnabled.totalComplete, true);
  assert.equal(resEnabled.nextCursor, null);
  assert.deepEqual(resEnabled.coverage.accountIds, []);
  assert.deepEqual(resEnabled.coverage.missingAccountIds, []);
  assert.equal(resEnabled.coverage.cached, 0);
  assert.equal(resEnabled.coverage.limited, false);
  assert.equal(resEnabled.coverage.status, 'complete');

  // 2. Disabled cache
  const adapterDisabled = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: false
  });

  const resDisabled = await adapterDisabled.reader.list([]);
  assert.equal(calls.length, 2);
  assert.deepEqual(resDisabled.messages, []);
  assert.equal(resDisabled.total, 0);
  assert.equal(resDisabled.totalComplete, true);
  assert.deepEqual(resDisabled.coverage.accountIds, []);
  assert.deepEqual(resDisabled.coverage.missingAccountIds, []);
  assert.equal(resDisabled.coverage.cached, 0);
  assert.equal(resDisabled.coverage.limited, false);
  assert.equal(resDisabled.coverage.status, 'complete');

  // 3. Validation: accepts five accounts, rejects over 100 accounts and invalid identities
  const a1 = { id: 'acc-1' }, a2 = { id: 'acc-2' }, a3 = { id: 'acc-3' }, a4 = { id: 'acc-4' }, a5 = { id: 'acc-5' };
  await assert.doesNotReject(adapterEnabled.reader.list([a1, a2, a3, a4, a5]));
  await assert.rejects(adapterEnabled.reader.list(Array.from({ length: 101 }, (_, i) => ({ id: 'account-' + i }))), { code: 'invalid_request' });
  await assert.rejects(adapterEnabled.reader.list([a1, a1]), { code: 'invalid_request' });
  await assert.rejects(adapterEnabled.reader.list([{ id: 'bad id with spaces' }]), { code: 'invalid_request' });

  cache.close();
});

test('normalizeCacheListResult mixed accounts configured 100 cap regression, warming first 50, and 500 default cases', async () => {
  const cache = await createMailCache(null);
  const store = mockStore({ mailCacheSettings: { maxHeadersPerAccount: 100 } });
  const accountA = { id: 'acc-a', email: 'acca@example.test', revision: '1' };
  const accountB = { id: 'acc-b', email: 'accb@example.test', revision: '1' };

  // Prime accountA with 100 cached messages of 5000 total (reconciled)
  const msgsA = Array.from({ length: 100 }, (_, i) => fakeMessage(i + 1, { accountId: accountA.id }));
  const tA = cache.beginSnapshot(accountA, 'INBOX');
  cache.commitHeaders(tA, {
    messages: msgsA,
    uidValidity: '1',
    total: 5000,
    complete: true,
    checkpoint: 'headers'
  });

  // Prime accountB with 30 cached messages of 30 total (reconciled)
  const msgsB = Array.from({ length: 30 }, (_, i) => fakeMessage(1000 + i + 1, { accountId: accountB.id }));
  const tB = cache.beginSnapshot(accountB, 'INBOX');
  cache.commitHeaders(tB, {
    messages: msgsB,
    uidValidity: '1',
    total: 30,
    complete: true,
    checkpoint: 'headers'
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    store,
    accounts: [accountA, accountB],
    enabled: true
  });

  // Page 1 (limit 50)
  const page1 = await adapter.reader.list([accountA, accountB], { limit: 50 });
  assert.equal(calls.length, 0);
  assert.equal(page1.source, 'cache');
  assert.equal(page1.coverage.status, 'partial');
  assert.equal(page1.coverage.cached, 130);
  assert.equal(page1.coverage.limited, true, 'Coverage must be limited because accountA hit retention cap of 100 headers');
  assert.equal(page1.totalComplete, true, 'totalComplete must remain true when total provider count is truthful');
  assert.equal(page1.total, 5030);
  assert.equal(page1.providerFallback, false);
  assert.ok(page1.nextCursor);

  // Page 2 (limit 50)
  const page2 = await adapter.reader.list([accountA, accountB], { limit: 50, cursor: page1.nextCursor });
  assert.equal(calls.length, 0);
  assert.equal(page2.messages.length, 50);
  assert.ok(page2.nextCursor);

  // Page 3 (final page, limit 50, remaining 30 items)
  const page3 = await adapter.reader.list([accountA, accountB], { limit: 50, cursor: page2.nextCursor });
  assert.equal(calls.length, 0);
  assert.equal(page3.messages.length, 30);
  assert.equal(page3.nextCursor, null);
  assert.equal(page3.providerFallback, true, 'Last cached page must signal providerFallback true when provider total > cached');

  // Warming first 50 case
  const accountWarm = { id: 'acc-warm', email: 'warm@example.test', revision: '1' };
  const msgsWarm = Array.from({ length: 50 }, (_, i) => fakeMessage(i + 1, { accountId: accountWarm.id }));
  const tWarm = cache.beginSnapshot(accountWarm, 'INBOX');
  cache.commitHeaders(tWarm, {
    messages: msgsWarm,
    uidValidity: '1',
    total: 2000,
    complete: false,
    checkpoint: 'first50'
  });

  const adapterWarm = await createMailCacheReader({
    reader,
    cache,
    accounts: [accountWarm],
    enabled: true
  });

  const warmRes = await adapterWarm.reader.list([accountWarm], { limit: 50 });
  assert.equal(calls.length, 0);
  assert.equal(warmRes.source, 'cache');
  assert.equal(warmRes.coverage.status, 'warming');
  assert.equal(warmRes.coverage.limited, false, 'Warming first 50 must have limited: false when cap not reached');
  assert.equal(warmRes.coverage.cached, 50);
  assert.equal(warmRes.totalComplete, false);

  // 500 default case (reconciled 500 cached of 1000)
  cache.updateSettings({ maxHeadersPerAccount: 500 });
  const account500 = { id: 'acc-500', email: '500@example.test', revision: '1' };
  const msgs500 = Array.from({ length: 500 }, (_, i) => fakeMessage(i + 1, { accountId: account500.id }));
  const t500 = cache.beginSnapshot(account500, 'INBOX');
  cache.commitHeaders(t500, {
    messages: msgs500,
    uidValidity: '1',
    total: 1000,
    complete: true,
    checkpoint: 'headers'
  });

  const adapter500 = await createMailCacheReader({
    reader,
    cache,
    accounts: [account500],
    enabled: true
  });

  const res500 = await adapter500.reader.list([account500], { limit: 50 });
  assert.equal(calls.length, 0);
  assert.equal(res500.coverage.status, 'partial');
  assert.equal(res500.coverage.limited, true);
  assert.equal(res500.coverage.cached, 500);
  assert.equal(res500.totalComplete, true);
  assert.equal(res500.total, 1000);

  cache.close();
});

test('cachedList fallback branches: cache cursor continuation never calls provider and returns explicit cache fallback flags', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-cont', email: 'cont@example.test', revision: '1' };
  const msgs = [fakeMessage(1, { accountId: account.id }), fakeMessage(2, { accountId: account.id })];

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: msgs,
    uidValidity: '1',
    total: 2,
    complete: true
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  // Warm first page gets cache cursor
  const page1 = await adapter.reader.list([account], { limit: 1 });
  assert.equal(calls.length, 0);
  assert.ok(page1.nextCursor);
  assert.equal(page1.nextCursor.kind, 'cache');
  const cacheCursor = page1.nextCursor;

  // Case 3a: Cache unavailable / unhealthy
  cache.healthy = () => false;
  const resUnhealthy = await adapter.reader.list([account], { cursor: cacheCursor });
  assert.equal(calls.length, 0, 'Provider must NEVER be called for cache cursor continuation when cache unhealthy');
  assert.equal(resUnhealthy.source, 'cache');
  assert.equal(resUnhealthy.requiresRefresh, true);
  assert.equal(resUnhealthy.providerFallback, true);
  assert.deepEqual(resUnhealthy.messages, []);
  assert.equal(resUnhealthy.nextCursor, null);
  assert.equal(resUnhealthy.total, null);
  assert.equal(resUnhealthy.totalComplete, false);
  assert.ok(['warming', 'partial'].includes(resUnhealthy.coverage.status));
  cache.healthy = () => true;

  // Case 3b: Failed cache list (returns null)
  const origList = cache.list;
  cache.list = () => null;
  const resNull = await adapter.reader.list([account], { cursor: cacheCursor });
  assert.equal(calls.length, 0, 'Provider must NEVER be called for cache cursor continuation when cache.list is null');
  assert.equal(resNull.source, 'cache');
  assert.equal(resNull.requiresRefresh, true);
  assert.equal(resNull.providerFallback, true);
  assert.deepEqual(resNull.messages, []);
  assert.equal(resNull.nextCursor, null);
  assert.equal(resNull.total, null);
  assert.equal(resNull.totalComplete, false);
  cache.list = origList;

  // Case 3c: Stale identity
  const staleAccount = { id: account.id, email: account.email, revision: 'stale-revision-2' };
  const resStale = await adapter.reader.list([staleAccount], { cursor: cacheCursor });
  assert.equal(calls.length, 0, 'Provider must NEVER be called for cache cursor continuation when account identity is stale');
  assert.equal(resStale.source, 'cache');
  assert.equal(resStale.requiresRefresh, true);
  assert.equal(resStale.providerFallback, true);
  assert.deepEqual(resStale.messages, []);
  assert.equal(resStale.nextCursor, null);
  assert.equal(resStale.total, null);
  assert.equal(resStale.totalComplete, false);

  cache.close();
});

test('cachedRead warm hit with empty text and non-empty html converts html to body text without calling provider', async () => {
  const cache = await createMailCache(null);
  const account = { id: 'acc-html-read', email: 'htmlread@example.test', revision: '1' };
  const msg1 = fakeMessage(1, { accountId: account.id, unread: true, starred: false });
  const msg2 = fakeMessage(2, { accountId: account.id, unread: false, starred: true });

  const ticket = cache.beginSnapshot(account, 'INBOX');
  cache.commitHeaders(ticket, {
    messages: [msg1, msg2],
    uidValidity: '1',
    total: 2,
    complete: true
  });

  // msg1: text is '' but html has visible body
  cache.putBody(ticket, msg1.reference, {
    text: '',
    html: '<p>Visible HTML body content</p>',
    sanitized: true,
    complete: true,
    attachments: []
  });

  // msg2: real empty body (text: '', html: '')
  cache.putBody(ticket, msg2.reference, {
    text: '',
    html: '',
    sanitized: true,
    complete: true,
    attachments: []
  });

  const calls = [];
  const reader = mockProviderReader(calls);

  const adapter = await createMailCacheReader({
    reader,
    cache,
    accounts: [account],
    enabled: true
  });

  const res1 = await adapter.reader.read(account, msg1.reference);
  assert.equal(calls.length, 0, 'Warm read must make ZERO provider calls');
  assert.equal(res1.source, 'cache');
  assert.equal(res1.body, 'Visible HTML body content');
  assert.equal(res1.unread, true);
  assert.equal(res1.starred, false);

  const res2 = await adapter.reader.read(account, msg2.reference);
  assert.equal(calls.length, 0, 'Warm read must make ZERO provider calls');
  assert.equal(res2.source, 'cache');
  assert.equal(res2.body, '', 'Empty real body should remain valid empty string');
  assert.equal(res2.unread, false);
  assert.equal(res2.starred, true);

  cache.close();
});
