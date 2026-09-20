import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailApi, MAIL_FOLDERS } from '../server/mail-api.mjs';
import { MailHarborError } from '../server/validation.mjs';
import { createMailTags } from '../server/mail-tags.mjs';

const synthItem = (accountId = 'synth-a', uid = 1, fp = 'a'.repeat(64)) => ({
  id: `${accountId}-msg-${uid}`,
  accountId,
  account: 'Synthetic Account',
  folderPath: 'INBOX',
  subject: `Synthetic Subject ${uid}`,
  author: 'sender@synth.test',
  to: 'receiver@synth.test',
  date: '2026-09-20T10:00:00Z',
  unread: true,
  starred: false,
  reference: { accountId, path: 'INBOX', uid, uidValidity: '12345', fingerprint: fp }
});

function harness(overrides = {}) {
  let clock = 1000;
  const saved = new Map(['synth-a', 'synth-b'].map(id => [id, { id, email: `${id}@synth.test`, revision: 'rev-1' }]));
  const accounts = {
    list: () => [...saved.values()].map(({ id }) => ({ id, connected: true, email: `${id}@synth.test` })),
    get: id => {
      if (!saved.has(id)) throw new MailHarborError('mailbox_login_required');
      return structuredClone(saved.get(id));
    }
  };
  const calls = [];
  const reader = {
    async folders(current) {
      calls.push('folders');
      return { folders: MAIL_FOLDERS.map(f => ({ ...f, accountIds: current.map(a => a.id) })), errors: [] };
    },
    async list(current, settings) {
      calls.push(['list', current.map(a => a.id), settings]);
      return { messages: current.map(a => synthItem(a.id, 1)), nextCursor: settings?.cursor ? null : { page: 2 }, errors: [] };
    },
    async read(account, reference) {
      calls.push(['read', account.id, reference]);
      return { ...synthItem(account.id, reference.uid, reference.fingerprint), body: 'Synthetic body', truncated: false, bodyUnavailable: false };
    },
    async attachment(account, reference, attachmentId) {
      calls.push(['attachment', account.id, reference, attachmentId]);
      return { filename: 'file.pdf', mimeType: 'application/pdf', bytes: Buffer.from('synthetic-bytes') };
    },
    async apply(account, reference, action) {
      calls.push(['apply', account.id, reference, action]);
      return { applied: true };
    },
    ...overrides.reader
  };
  const conversations = overrides.conversations !== undefined ? overrides.conversations : {
    async load(account, reference, options) {
      calls.push(['conversations.load', account.id, reference, options?.cursor]);
      return {
        messages: [
          synthItem(account.id, reference.uid, reference.fingerprint),
          synthItem(account.id, 2, 'b'.repeat(64))
        ],
        complete: true,
        nextCursor: null,
        errors: []
      };
    },
    clear() { calls.push('conversations.clear'); },
    destroy() { calls.push('conversations.destroy'); }
  };
  let mailTags, customMailLabels, pending = Promise.resolve();
  const store = {
    read: () => structuredClone({ accounts: [...saved.values()], mailTags, customMailLabels }),
    update(change) {
      const op = pending.then(async () => {
        const data = this.read();
        const res = await change(data);
        mailTags = data.mailTags;
        customMailLabels = data.customMailLabels;
        return res;
      });
      pending = op.catch(() => {});
      return op;
    }
  };
  const tags = createMailTags({ store, now: () => clock });
  const api = createMailApi({
    accounts,
    reader,
    tags,
    conversations,
    now: () => clock,
    retentionMs: 1000
  });
  return {
    api,
    saved,
    calls,
    accounts,
    reader,
    conversations,
    tick: (ms = 1001) => { clock += ms; }
  };
}

test('basic conversation headers become readable with no ref/UID/fingerprint leaks', async t => {
  const h = harness();
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });
  const conv = await h.api.conversation({ id: 'synth-a-msg-1' });
  assert.equal(conv.messages.length, 2);
  assert.equal(conv.complete, true);
  assert.equal(conv.nextCursor, null);
  assert.equal(conv.errors.length, 0);
  assert.doesNotMatch(JSON.stringify(conv), /reference|fingerprint|uidValidity|PRIVATE_/);

  const secondId = conv.messages[1].id;
  const readResult = await h.api.read({ id: secondId });
  assert.equal(readResult.message.id, secondId);
  assert.equal(readResult.message.body, 'Synthetic body');
  assert.doesNotMatch(JSON.stringify(readResult), /reference|fingerprint|uidValidity|PRIVATE_/);

  const att = await h.api.attachment({ id: secondId, attachmentId: '1' });
  assert.equal(att.filename, 'file.pdf');
});

test('cursor continuation wraps backend and rejects wrong selected id/account/owner/revision/expiry', async t => {
  let backendCursorSeen = null;
  const h = harness({
    conversations: {
      async load(account, reference, options) {
        backendCursorSeen = options?.cursor;
        if (!options?.cursor) {
          return {
            messages: [synthItem(account.id, 1), synthItem(account.id, 2, 'b'.repeat(64))],
            complete: false,
            nextCursor: 'BACKEND_PRIVATE_CURSOR_TOKEN_123',
            errors: []
          };
        }
        return {
          messages: [synthItem(account.id, 1), synthItem(account.id, 3, 'c'.repeat(64))],
          complete: true,
          nextCursor: null,
          errors: []
        };
      },
      clear() {},
      destroy() {}
    }
  });
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });

  const first = await h.api.conversation({ id: 'synth-a-msg-1' });
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(first.nextCursor, /BACKEND_PRIVATE/);

  // Invalid cursor format
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1', cursor: 'short-cursor' }), { code: 'invalid_request' });

  // Wrong selected id / foreign selection
  await assert.rejects(h.api.conversation({ id: 'synth-b-msg-1', cursor: first.nextCursor }), { code: 'stale_message' });

  // Continuation with valid cursor
  const second = await h.api.conversation({ id: 'synth-a-msg-1', cursor: first.nextCursor });
  assert.equal(second.complete, true);
  assert.equal(backendCursorSeen, 'BACKEND_PRIVATE_CURSOR_TOKEN_123');

  // Single-use: replaying cursor fails
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1', cursor: first.nextCursor }), { code: 'stale_message' });

  // Expired cursor
  const forExpiry = await h.api.conversation({ id: 'synth-a-msg-1' });
  h.tick(1001);
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1', cursor: forExpiry.nextCursor }), { code: 'stale_message' });

  // Refresh list after expiry before revision scenario
  await h.api.list({ folder: 'inbox' });

  // Revision mismatch
  const forRev = await h.api.conversation({ id: 'synth-a-msg-1' });
  h.saved.get('synth-a').revision = 'rev-2';
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1', cursor: forRev.nextCursor }), { code: 'stale_message' });
});

test('hostile crossaccount response rejected before any records remembered', async t => {
  const hostileMsg = synthItem('synth-b', 99, 'f'.repeat(64));
  const h = harness({
    conversations: {
      async load(account, reference) {
        return {
          messages: [synthItem(account.id, 1), hostileMsg],
          complete: true,
          nextCursor: null,
          errors: []
        };
      },
      clear() {},
      destroy() {}
    }
  });
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });

  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1' }), { code: 'mailbox_error' });
  await assert.rejects(h.api.read({ id: hostileMsg.id }), { code: 'stale_message' });

  // Missing selected reference in returned batch
  const h2 = harness({
    conversations: {
      async load(account) {
        return {
          messages: [synthItem(account.id, 999, 'e'.repeat(64))],
          complete: true,
          nextCursor: null,
          errors: []
        };
      },
      clear() {},
      destroy() {}
    }
  });
  t.after(() => h2.api.close());
  await h2.api.list({ folder: 'inbox' });
  await assert.rejects(h2.api.conversation({ id: 'synth-a-msg-1' }), { code: 'mailbox_error' });
});

test('concurrent disconnect/move invalidates late conversation', async t => {
  let release;
  const gate = new Promise(res => { release = res; });
  const h = harness({
    conversations: {
      async load(account, reference) {
        await gate;
        return {
          messages: [synthItem(account.id, reference.uid, reference.fingerprint), synthItem(account.id, 5, '5'.repeat(64))],
          complete: true,
          nextCursor: null,
          errors: []
        };
      },
      clear() {},
      destroy() {}
    }
  });
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });

  const pending = h.api.conversation({ id: 'synth-a-msg-1' });
  h.api.invalidateAccount('synth-a');
  release();
  await assert.rejects(pending, { code: 'stale_message' });
  await assert.rejects(h.api.read({ id: 'synth-a-msg-5' }), { code: 'stale_message' });
});

test('safe snippet and attachment fields exclude bytes, source, and private extras', async t => {
  const h = harness({
    conversations: {
      async load(account, reference) {
        return {
          messages: [
            {
              ...synthItem(account.id, reference.uid, reference.fingerprint),
              snippet: 'Safe snippet preview '.repeat(35),
              attachments: [
                { id: '1.1', filename: 'Report.pdf', mimeType: 'application/pdf', size: 2048, bytes: Buffer.from('PRIVATE_BYTES'), source: 'raw', providerSecret: 'PRIVATE_SECRET' },
                { id: 'bad.id/x', filename: 'hack.sh', mimeType: 'application/x-sh', size: 10 }
              ]
            }
          ],
          complete: true,
          nextCursor: null,
          errors: []
        };
      },
      clear() {},
      destroy() {}
    }
  });
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });

  const conv = await h.api.conversation({ id: 'synth-a-msg-1' });
  assert.equal(conv.messages[0].snippet.length, 500);
  assert.deepEqual(conv.messages[0].attachments, [{ id: '1.1', filename: 'Report.pdf', mimeType: 'application/pdf', size: 2048 }]);
  assert.doesNotMatch(JSON.stringify(conv), /PRIVATE_BYTES|PRIVATE_SECRET|source|providerSecret/);
});

test('live boolean validation, cursor binding/forwarding and top-level cache metadata whitelist', async t => {
  let listOptionsSeen = null;
  const h = harness({
    reader: {
      async list(current, settings) {
        listOptionsSeen = settings;
        return {
          messages: current.map(a => synthItem(a.id, 1)),
          source: 'cache',
          providerFallback: true,
          coverage: {
            status: 'complete',
            cached: 50,
            limited: false,
            accountIds: ['synth-a', 'foreign-acc'],
            missingAccountIds: []
          },
          lastSuccessfulSync: 1720000000000,
          refreshing: false,
          revision: 'rev-cache-123',
          cache: { privateCacheKey: 'PRIVATE_CACHE_INTERNALS' },
          privateExtra: 'PRIVATE_EXTRA_VAL',
          nextCursor: settings?.cursor ? null : { page: 2 },
          errors: []
        };
      }
    }
  });
  t.after(() => h.api.close());

  // Strict live boolean validation
  await assert.rejects(h.api.list({ folder: 'inbox', live: 'true' }), { code: 'invalid_request' });
  await assert.rejects(h.api.list({ folder: 'inbox', live: 1 }), { code: 'invalid_request' });

  // Forwarding live: true
  const liveResult = await h.api.list({ folder: 'inbox', live: true, accountIds: ['synth-a'] });
  assert.equal(listOptionsSeen.live, true);
  assert.equal(liveResult.source, 'cache');
  assert.equal(liveResult.providerFallback, true);
  assert.deepEqual(liveResult.coverage, {
    status: 'complete',
    cached: 50,
    limited: false,
    accountIds: ['synth-a'],
    missingAccountIds: []
  });
  assert.equal(liveResult.lastSuccessfulSync, 1720000000000);
  assert.equal(liveResult.refreshing, false);
  assert.equal(liveResult.revision, 'rev-cache-123');
  assert.equal('cache' in liveResult, false);
  assert.doesNotMatch(JSON.stringify(liveResult), /PRIVATE_CACHE_INTERNALS|PRIVATE_EXTRA_VAL|foreign-acc/);

  // Live cursor binding prevents switching live mode
  const nonLiveResult = await h.api.list({ folder: 'inbox', live: false });
  await assert.rejects(h.api.list({ folder: 'inbox', live: true, cursor: nonLiveResult.nextCursor }), { code: 'stale_message' });
});

test('cancelled pre-aborted and pending list/read/conversation/withMessage release pool and do not remember late results', async t => {
  let releaseList, releaseRead, releaseConv, releaseWith;
  const listGate = new Promise(r => { releaseList = r; });
  const readGate = new Promise(r => { releaseRead = r; });
  const convGate = new Promise(r => { releaseConv = r; });
  const withGate = new Promise(r => { releaseWith = r; });

  const h = harness({
    reader: {
      async list(_current, { signal }) {
        await listGate;
        if (signal.aborted) throw signal.reason;
        return { messages: [synthItem('synth-a', 10)], errors: [] };
      },
      async read(_account, _ref, { signal }) {
        await readGate;
        if (signal.aborted) throw signal.reason;
        return { ...synthItem('synth-a', 1), body: 'Late body' };
      }
    },
    conversations: {
      async load(_account, _ref, { signal }) {
        await convGate;
        if (signal.aborted) throw signal.reason;
        return { messages: [synthItem('synth-a', 1), synthItem('synth-a', 20, '2'.repeat(64))], complete: true, errors: [] };
      },
      clear() {},
      destroy() {}
    }
  });
  t.after(() => h.api.close());

  // 1. Pre-aborted signal rejects cancelled immediately without starting provider work
  const preAborted = AbortSignal.abort();
  await assert.rejects(h.api.list({ folder: 'inbox' }, { signal: preAborted }), { code: 'cancelled' });
  await assert.rejects(h.api.read({ id: 'synth-a-msg-1' }, { signal: preAborted }), { code: 'cancelled' });
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1' }, { signal: preAborted }), { code: 'cancelled' });
  await assert.rejects(h.api.withMessage({ id: 'synth-a-msg-1' }, async () => {}, { signal: preAborted }), { code: 'cancelled' });

  // 2. Pending cancellation for list promptly releases pool
  const listCtrl = new AbortController();
  const pendingList = h.api.list({ folder: 'inbox' }, { signal: listCtrl.signal });
  listCtrl.abort(new Error('arbitrary browser disconnect'));
  await assert.rejects(pendingList, { code: 'cancelled' });
  // Verify 4-operation pool is released even though listGate is not yet resolved:
  const quickFolds = await Promise.all([h.api.folders(), h.api.folders(), h.api.folders(), h.api.folders()]);
  assert.equal(quickFolds.length, 4);
  releaseList();
  await assert.rejects(h.api.read({ id: 'synth-a-msg-10' }), { code: 'stale_message' });

  // Populate valid record for read, conversation, withMessage
  h.reader.list = async current => ({ messages: current.map(a => synthItem(a.id, 1)), errors: [] });
  await h.api.list({ folder: 'inbox' });

  // 3. Pending cancellation for read
  const readCtrl = new AbortController();
  const pendingRead = h.api.read({ id: 'synth-a-msg-1' }, { signal: readCtrl.signal });
  readCtrl.abort();
  await assert.rejects(pendingRead, { code: 'cancelled' });
  releaseRead();

  // 4. Pending cancellation for conversation
  const convCtrl = new AbortController();
  const pendingConv = h.api.conversation({ id: 'synth-a-msg-1' }, { signal: convCtrl.signal });
  convCtrl.abort();
  await assert.rejects(pendingConv, { code: 'cancelled' });
  releaseConv();
  await assert.rejects(h.api.read({ id: 'synth-a-msg-20' }), { code: 'stale_message' });

  // 5. Pending cancellation for withMessage
  const withCtrl = new AbortController();
  const pendingWith = h.api.withMessage({ id: 'synth-a-msg-1' }, async () => withGate, { signal: withCtrl.signal });
  withCtrl.abort();
  await assert.rejects(pendingWith, { code: 'cancelled' });
  releaseWith();
});

test('external listener cleanup on completion and cancellation', async t => {
  const h = harness();
  t.after(() => h.api.close());

  function createTrackedSignal() {
    const ctrl = new AbortController();
    let listeners = 0;
    const originalAdd = ctrl.signal.addEventListener.bind(ctrl.signal);
    const originalRemove = ctrl.signal.removeEventListener.bind(ctrl.signal);
    ctrl.signal.addEventListener = (...args) => {
      listeners++;
      return originalAdd(...args);
    };
    ctrl.signal.removeEventListener = (...args) => {
      listeners--;
      return originalRemove(...args);
    };
    return { ctrl, signal: ctrl.signal, getCount: () => listeners };
  }

  // Normal completion cleans up listener
  const tracked1 = createTrackedSignal();
  await h.api.list({ folder: 'inbox' }, { signal: tracked1.signal });
  assert.equal(tracked1.getCount(), 0);

  // Cancellation cleans up listener
  const tracked2 = createTrackedSignal();
  let release;
  const gate = new Promise(r => { release = r; });
  h.reader.list = async () => { await gate; return { messages: [], errors: [] }; };
  const pending = h.api.list({ folder: 'inbox' }, { signal: tracked2.signal });
  tracked2.ctrl.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(tracked2.getCount(), 0);
  release();
});

test('existing API behavior preserved and missing conversations fails gracefully', async t => {
  const h = harness({ conversations: null });
  t.after(() => h.api.close());

  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1' }), { code: 'mailbox_error' });
  const folders = await h.api.folders();
  assert.equal(folders.folders.length, 21);
  const listRes = await h.api.list({ folder: 'inbox' });
  assert.equal(listRes.messages.length, 2);
});

test('inbox list includes sanitized metadata-only attachments and drops bytes, source, and private data', async t => {
  const bytes = Buffer.from('PRIVATE_LIST_ATTACHMENT_BYTES');
  const h = harness({
    reader: {
      async list(current) {
        return {
          messages: current.map(a => ({
            ...synthItem(a.id, 1),
            attachments: [
              {
                id: '1.1',
                filename: 'invoice.pdf',
                mimeType: 'application/pdf',
                size: bytes.length,
                bytes,
                source: 'raw-mime',
                providerSecret: 'PRIVATE_SECRET_LEAK',
                extraInternal: 'DO_NOT_EXPOSE'
              },
              {
                id: 'invalid..part',
                filename: 'bad.sh',
                mimeType: 'text/plain',
                size: 12
              }
            ]
          })),
          errors: []
        };
      }
    }
  });
  t.after(() => h.api.close());

  const listing = await h.api.list({ folder: 'inbox' });
  assert.equal(listing.messages.length, 2);
  const msg = listing.messages[0];
  assert.ok(Array.isArray(msg.attachments));
  assert.equal(msg.attachments.length, 1);
  assert.deepEqual(msg.attachments[0], {
    id: '1.1',
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
    size: bytes.length
  });
  assert.doesNotMatch(JSON.stringify(listing), /PRIVATE_|source|providerSecret|extraInternal|bad\.sh/);
});

test('close cancels pending externally-signaled read whose backend ignores abort and returns promptly', async t => {
  let backendSignal = null;
  const foreverPending = new Promise(() => {});
  const h = harness({
    reader: {
      async read(account, reference, { signal }) {
        backendSignal = signal;
        await foreverPending;
        return { ...synthItem(account.id, reference.uid, reference.fingerprint), body: 'never' };
      }
    }
  });
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });

  const clientCtrl = new AbortController();
  const readPromise = h.api.read({ id: 'synth-a-msg-1' }, { signal: clientCtrl.signal });

  const closeStart = Date.now();
  const closePromise = h.api.close();

  await assert.rejects(readPromise, { code: 'cancelled' });
  await closePromise;
  assert.ok(Date.now() - closeStart < 2000, 'close() returned promptly');
  assert.equal(backendSignal?.aborted, true);
});

test('malformed conversation response rejects with mailbox_error and cannot register new rows', async t => {
  const newMsg = synthItem('synth-a', 20, '2'.repeat(64));
  let testResponse = {};
  const h = harness({
    conversations: {
      async load(account, reference) {
        return {
          messages: [
            synthItem(account.id, reference.uid, reference.fingerprint),
            newMsg
          ],
          complete: false,
          nextCursor: null,
          errors: [],
          ...testResponse
        };
      },
      clear() {},
      destroy() {}
    }
  });
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });

  // 1. Malformed nextCursor: number
  testResponse = { nextCursor: 12345 };
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1' }), { code: 'mailbox_error' });
  await assert.rejects(h.api.read({ id: newMsg.id }), { code: 'stale_message' });

  // 2. complete=true incompatible with non-null cursor
  testResponse = { complete: true, nextCursor: 'some-cursor' };
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1' }), { code: 'mailbox_error' });
  await assert.rejects(h.api.read({ id: newMsg.id }), { code: 'stale_message' });

  // 3. Duplicate message IDs in messages
  testResponse = {
    complete: true,
    nextCursor: null,
    messages: [
      synthItem('synth-a', 1),
      newMsg,
      { ...synthItem('synth-a', 3, '3'.repeat(64)), id: newMsg.id }
    ]
  };
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1' }), { code: 'mailbox_error' });
  await assert.rejects(h.api.read({ id: newMsg.id }), { code: 'stale_message' });

  // 4. Duplicate physical references in messages
  testResponse = {
    complete: true,
    nextCursor: null,
    messages: [
      synthItem('synth-a', 1),
      newMsg,
      { id: 'synth-a-msg-3', accountId: 'synth-a', reference: structuredClone(newMsg.reference) }
    ]
  };
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1' }), { code: 'mailbox_error' });
  await assert.rejects(h.api.read({ id: newMsg.id }), { code: 'stale_message' });

  // 5. ID collision with existing record having different reference
  testResponse = {
    complete: true,
    nextCursor: null,
    messages: [
      synthItem('synth-a', 1),
      { ...newMsg, id: 'synth-b-msg-1' }
    ]
  };
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1' }), { code: 'mailbox_error' });
});

test('conversation rejects foreign account errors without leak, and normalizes absent accountId', async t => {
  let backendErrors = [];
  const h = harness({
    conversations: {
      async load(account, reference) {
        return {
          messages: [synthItem(account.id, reference.uid, reference.fingerprint)],
          complete: true,
          nextCursor: null,
          errors: backendErrors
        };
      },
      clear() {},
      destroy() {}
    }
  });
  t.after(() => h.api.close());
  await h.api.list({ folder: 'inbox' });

  // Foreign account in errors rejected with mailbox_error; does not leak foreign account details
  backendErrors = [{ accountId: 'unknown-foreign-account', code: 'mailbox_login_required', detail: 'PRIVATE_LEAK' }];
  await assert.rejects(h.api.conversation({ id: 'synth-a-msg-1' }), { code: 'mailbox_error' });

  // Missing accountId is normalized to selected account, and private fields stripped
  backendErrors = [{ code: 'mailbox_login_required', detail: 'PRIVATE_LEAK' }];
  const conv = await h.api.conversation({ id: 'synth-a-msg-1' });
  assert.deepEqual(conv.errors, [{ accountId: 'synth-a', code: 'mailbox_login_required' }]);
  assert.doesNotMatch(JSON.stringify(conv), /PRIVATE_LEAK|detail/);
});
