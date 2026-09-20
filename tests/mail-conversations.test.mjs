import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMailboxSession, mailFingerprint } from '../server/mailboxes.mjs';
import { createMailConversations } from '../server/mail-conversations.mjs';
import { MailHarborError } from '../server/validation.mjs';

const NOW = Date.parse('2026-09-13T12:00:00Z');

/**
 * Construct a synthetic IMAP message object.
 * @param {number} uid
 * @param {object} [overrides]
 * @returns {object}
 */
const makeMail = (uid, overrides = {}) => ({
  uid,
  size: 150,
  internalDate: new Date('2026-01-01'),
  flags: new Set(),
  envelope: {
    date: new Date(NOW - uid * 60000),
    subject: `Subject ${uid}`,
    from: [{ name: 'Sender', address: 'sender@example.test' }],
    to: [{ name: 'Recipient', address: 'recipient@example.test' }],
    cc: [],
    replyTo: [],
    messageId: `<${uid}@example.test>`,
    inReplyTo: '',
    references: ''
  },
  labels: new Set(),
  ...overrides
});

/**
 * Build test harness with synthetic IMAP clients.
 * @param {object} config
 * @param {object} [options]
 * @returns {object}
 */
function harness(config, options = {}) {
  const clients = [];
  const calls = [];
  const states = Object.fromEntries(
    Object.entries(config).map(([id, value]) => [
      id,
      {
        capabilities: [],
        ...value,
        folders: (value.folders ?? [{ path: 'INBOX', messages: [makeMail(1)] }]).map(folder => ({
          flags: new Set(),
          uidValidity: 1n,
          ...folder,
          messages: new Map((folder.messages ?? []).map(m => [m.uid, m]))
        }))
      }
    ])
  );

  function matches(message, criteria) {
    return Object.entries(criteria).every(([key, value]) => {
      if (key === 'or') return value.some(item => matches(message, item));
      if (key === 'deleted') return message.flags.has('\\Deleted') === value;
      if (key === 'seen') return message.flags.has('\\Seen') === value;
      if (key === 'flagged') return message.flags.has('\\Flagged') === value;
      if (key === 'header') {
        return Object.entries(value).every(([hKey, hVal]) => {
          const needle = String(hVal).toLowerCase();
          const k = hKey.toLowerCase();
          if (k === 'message-id') {
            const envMsgId = String(message.envelope?.messageId ?? '');
            const rawHeaders = Buffer.isBuffer(message.headers)
              ? message.headers.toString('utf8')
              : String(message.headers ?? '');
            return envMsgId.toLowerCase().includes(needle) || rawHeaders.toLowerCase().includes(needle);
          }
          if (k === 'in-reply-to') {
            const envInReplyTo = String(message.envelope?.inReplyTo ?? '');
            const rawHeaders = Buffer.isBuffer(message.headers)
              ? message.headers.toString('utf8')
              : String(message.headers ?? '');
            return envInReplyTo.toLowerCase().includes(needle) || rawHeaders.toLowerCase().includes(needle);
          }
          if (k === 'references') {
            const envRefs = String(message.envelope?.references ?? '');
            const rawHeaders = Buffer.isBuffer(message.headers)
              ? message.headers.toString('utf8')
              : String(message.headers ?? '');
            return envRefs.toLowerCase().includes(needle) || rawHeaders.toLowerCase().includes(needle);
          }
          return false;
        });
      }
      return false;
    });
  }

  class FakeClient extends EventEmitter {
    constructor(opts) {
      super();
      this.options = opts;
      this.state = states[opts.auth?.user];
      this.capabilities = new Set(this.state?.capabilities ?? []);
      this.fetching = false;
      clients.push(this);
    }

    async connect() {
      if (this.state?.error) throw this.state.error;
      await this.state?.onConnect?.(this);
    }

    close() {
      this.closed = true;
    }

    command() {
      assert.equal(this.fetching, false, 'Do not issue commands inside a FETCH iterator');
    }

    async list() {
      this.command();
      return this.state.folders.map(f => ({ path: f.path, flags: f.flags, specialUse: f.specialUse }));
    }

    async getMailboxLock(path, lockOpts) {
      this.command();
      if (this.state?.lockError) throw this.state.lockError;
      const folder = this.state.folders.find(f => f.path.toUpperCase() === path.toUpperCase() || f.path === path);
      if (!folder) throw new Error(`Mailbox does not exist: ${path}`);
      if (folder.lockError) throw folder.lockError;
      this.folder = folder;
      this.mailbox = {
        path,
        uidValidity: folder.uidValidity,
        readOnly: lockOpts.readOnly,
        permanentFlags: folder.flags
      };
      calls.push({ action: 'lock', path, readOnly: lockOpts.readOnly });
      return {
        release() {
          calls.push({ action: 'unlock', path });
        }
      };
    }

    async search(criteria, searchOpts) {
      this.command();
      assert.deepEqual(searchOpts, { uid: true });
      calls.push({ action: 'search', criteria, folder: this.folder?.path });
      if (this.folder?.searchError) throw this.folder.searchError;
      await this.state?.onSearch?.(criteria, this);
      return [...this.folder.messages.values()]
        .filter(m => matches(m, criteria))
        .map(m => m.uid);
    }

    async *fetch(range, query, fetchOpts) {
      this.command();
      assert.deepEqual(fetchOpts, { uid: true, binary: false });
      if (this.folder?.fetchError) throw this.folder.fetchError;
      const uids = range.split(',').map(Number);
      calls.push({ action: 'fetch', uids, folder: this.folder?.path });
      this.fetching = true;
      try {
        for (const uid of uids) {
          if (this.folder.messages.has(uid)) {
            const m = this.folder.messages.get(uid);
            const clone = structuredClone(m);
            if (m.headers) clone.headers = Buffer.isBuffer(m.headers) ? Buffer.from(m.headers) : m.headers;
            yield clone;
          }
        }
      } finally {
        this.fetching = false;
      }
    }

    async fetchOne(uid, query, fetchOpts) {
      this.command();
      assert.equal(fetchOpts.uid, true);
      assert.equal(fetchOpts.binary, false);
      calls.push({ action: 'fetchOne', uid: Number(uid), folder: this.folder?.path });
      const m = this.folder.messages.get(Number(uid));
      if (!m) return false;
      const clone = structuredClone(m);
      if (m.headers) clone.headers = Buffer.isBuffer(m.headers) ? Buffer.from(m.headers) : m.headers;
      return clone;
    }
  }

  const { session, active } = createMailboxSession({
    connectionOptions: async account => ({ auth: { user: account.id } }),
    createClient: opts => new FakeClient(opts),
    sessionTimeoutMs: options.sessionTimeoutMs ?? 120_000
  });

  const conversations = createMailConversations({
    session,
    active,
    fingerprint: mailFingerprint,
    now: options.now ?? (() => Date.now()),
    maxCacheEntries: options.maxCacheEntries ?? 200,
    cursorTtlMs: options.cursorTtlMs ?? 300_000,
    defaultBudget: options.defaultBudget ?? {}
  });

  return { conversations, clients, calls, states };
}

// 1. Root + Sent reply + INBOX grandchild discovered from middle outside page
test('root+Sent reply+INBOX grandchild discovered from middle outside page', async () => {
  const root = makeMail(10, {
    envelope: {
      date: new Date('2026-09-01T10:00:00Z'),
      subject: 'Discussion',
      messageId: '<root@example.test>',
      inReplyTo: '',
      references: ''
    }
  });
  const middle = makeMail(20, {
    envelope: {
      date: new Date('2026-09-01T11:00:00Z'),
      subject: 'Re: Discussion',
      messageId: '<middle@example.test>',
      inReplyTo: '<root@example.test>',
      references: '<root@example.test>'
    }
  });
  const sentReply = makeMail(25, {
    envelope: {
      date: new Date('2026-09-01T12:00:00Z'),
      subject: 'Re: Discussion',
      messageId: '<sent@example.test>',
      inReplyTo: '<middle@example.test>',
      references: '<root@example.test> <middle@example.test>'
    }
  });
  const grandchild = makeMail(30, {
    envelope: {
      date: new Date('2026-09-01T13:00:00Z'),
      subject: 'Re: Discussion',
      messageId: '<grandchild@example.test>',
      inReplyTo: '<sent@example.test>',
      references: '<root@example.test> <middle@example.test> <sent@example.test>'
    }
  });

  const account = { id: 'acc1', email: 'acc1@example.test' };
  const { conversations } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', messages: [middle, grandchild] },
        { path: 'Archive', messages: [root] },
        { path: 'Sent', messages: [sentReply] }
      ]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 20,
    fingerprint: mailFingerprint(middle)
  };

  const result = await conversations.load(account, reference);

  assert.equal(result.complete, true);
  assert.equal(result.nextCursor, null);
  assert.equal(result.errors.length, 0);
  assert.equal(result.messages.length, 4);

  const messageIds = result.messages.map(m => m.messageId);
  assert.deepEqual(messageIds, [
    '<root@example.test>',
    '<middle@example.test>',
    '<sent@example.test>',
    '<grandchild@example.test>'
  ]);

  const middleMsg = result.messages.find(m => m.messageId === '<middle@example.test>');
  assert.equal(middleMsg.folderPath, 'INBOX');
  assert.equal(middleMsg.reference.uid, 20);

  const rootMsg = result.messages.find(m => m.messageId === '<root@example.test>');
  assert.equal(rootMsg.folderPath, 'Archive');
  assert.equal(rootMsg.reference.uid, 10);
});

// 2. Disconnected same-subject excluded
test('disconnected same-subject excluded', async () => {
  const middle = makeMail(1, {
    envelope: {
      subject: 'Quarterly Review',
      messageId: '<middle@example.test>',
      inReplyTo: '',
      references: ''
    }
  });
  const disconnected = makeMail(2, {
    envelope: {
      subject: 'Quarterly Review',
      messageId: '<unrelated@example.test>',
      inReplyTo: '',
      references: ''
    }
  });

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [{ path: 'INBOX', messages: [middle, disconnected] }]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(middle)
  };

  const result = await conversations.load(account, reference);

  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, '<middle@example.test>');
});

// 3. Missing-ancestor siblings
test('missing-ancestor siblings', async () => {
  const siblingA = makeMail(1, {
    envelope: {
      subject: 'Reply A',
      messageId: '<siblingA@example.test>',
      inReplyTo: '<root@example.test>',
      references: '<root@example.test>'
    }
  });
  const siblingB = makeMail(2, {
    envelope: {
      subject: 'Reply B',
      messageId: '<siblingB@example.test>',
      inReplyTo: '<root@example.test>',
      references: '<root@example.test>'
    }
  });

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [{ path: 'INBOX', messages: [siblingA, siblingB] }]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(siblingA)
  };

  const result = await conversations.load(account, reference);

  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 2);
  const ids = result.messages.map(m => m.messageId).sort();
  assert.deepEqual(ids, ['<siblingA@example.test>', '<siblingB@example.test>']);
});

// 4. Cycles
test('cycles terminate cleanly without infinite loop', async () => {
  const msgA = makeMail(1, {
    envelope: {
      subject: 'Cycle A',
      messageId: '<cycleA@example.test>',
      inReplyTo: '<cycleB@example.test>',
      references: '<cycleB@example.test>'
    }
  });
  const msgB = makeMail(2, {
    envelope: {
      subject: 'Cycle B',
      messageId: '<cycleB@example.test>',
      inReplyTo: '<cycleA@example.test>',
      references: '<cycleA@example.test>'
    }
  });

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [{ path: 'INBOX', messages: [msgA, msgB] }]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(msgA)
  };

  const result = await conversations.load(account, reference);

  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 2);
});

// 5. Substring false positives
test('substring false positives rejected by exact token intersection', async () => {
  const target = makeMail(1, {
    envelope: {
      subject: 'Target Message',
      messageId: '<target@example.test>',
      inReplyTo: '',
      references: ''
    }
  });
  const evilSubstring = makeMail(2, {
    envelope: {
      subject: 'Evil Message',
      messageId: '<target@example.test.evil.invalid>',
      inReplyTo: '',
      references: ''
    }
  });

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [{ path: 'INBOX', messages: [target, evilSubstring] }]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(target)
  };

  const result = await conversations.load(account, reference);

  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, '<target@example.test>');
});

// 6. Account/cursor isolation
test('account and cursor isolation rejects foreign or expired cursor', async () => {
  const mailA = makeMail(1, { envelope: { messageId: '<msgA@example.test>' } });
  const mailB = makeMail(2, { envelope: { messageId: '<msgB@example.test>' } });

  const accountA = { id: 'accA', email: 'a@example.test', updatedAt: '2026-09-01' };
  const accountB = { id: 'accB', email: 'b@example.test', updatedAt: '2026-09-01' };

  let currentTime = 1000;
  const { conversations } = harness(
    {
      accA: { folders: [{ path: 'INBOX', messages: [mailA] }, { path: 'Archive', messages: [] }] },
      accB: { folders: [{ path: 'INBOX', messages: [mailB] }] }
    },
    {
      now: () => currentTime,
      cursorTtlMs: 5000,
      defaultBudget: { maxSearchesPerCall: 1 }
    }
  );

  const refA = {
    accountId: accountA.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(mailA)
  };

  const refB = {
    accountId: accountB.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 2,
    fingerprint: mailFingerprint(mailB)
  };

  const resA = await conversations.load(accountA, refA, { budget: { maxSearchesPerCall: 1 } });
  assert.equal(resA.complete, false);
  assert.ok(typeof resA.nextCursor === 'string');
  const cursor = resA.nextCursor;

  await assert.rejects(
    () => conversations.load(accountB, refB, { cursor }),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );

  const refAWrong = { ...refA, uid: 999 };
  await assert.rejects(
    () => conversations.load(accountA, refAWrong, { cursor }),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );

  await assert.rejects(
    () => conversations.load(accountA, refA, { cursor: 'non_existent_random_cursor' }),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );

  const resA2 = await conversations.load(accountA, refA, { budget: { maxSearchesPerCall: 1 } });
  assert.ok(resA2.nextCursor);
  currentTime += 10000;

  await assert.rejects(
    () => conversations.load(accountA, refA, { cursor: resA2.nextCursor }),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );
});

// 7. Stale fingerprint
test('stale fingerprint rejects with stale_message', async () => {
  const message = makeMail(1, { envelope: { messageId: '<msg@example.test>', subject: 'Original' } });
  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [message] }] }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: '0000000000000000000000000000000000000000000000000000000000000000'
  };

  await assert.rejects(
    () => conversations.load(account, reference),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );
});

// 8. Folder UIDVALIDITY change during continuation
test('folder UIDVALIDITY change during continuation invalidates cached UIDs', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const reply = makeMail(10, { envelope: { messageId: '<reply@example.test>', inReplyTo: '<root@example.test>' } });

  const account = { id: 'acc1' };
  const { conversations, states } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', uidValidity: 1n, messages: [root] },
        { path: 'Archive', uidValidity: 1n, messages: [reply] },
        { path: 'Sent', uidValidity: 1n, messages: [] }
      ]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  // Step 1: Page until Archive message is present and continuation is pending
  let step1;
  let cursor = null;
  while (true) {
    step1 = await conversations.load(account, reference, {
      cursor,
      budget: { maxSearchesPerCall: 1, maxFetchesPerCall: 1 }
    });
    cursor = step1.nextCursor;
    if (step1.messages.some(m => m.folderPath === 'Archive') && !step1.complete && cursor) {
      break;
    }
    assert.ok(cursor, 'Continuation must be pending');
  }

  assert.ok(step1.messages.some(m => m.folderPath === 'Archive'));
  assert.equal(step1.complete, false);
  assert.ok(step1.nextCursor);

  // Now change Archive UIDVALIDITY before continuation
  const archiveFolder = states.acc1.folders.find(f => f.path === 'Archive');
  archiveFolder.uidValidity = 2n;

  // Continuation detects UIDVALIDITY change, rejects stale_message
  await assert.rejects(
    () => conversations.load(account, reference, { cursor: step1.nextCursor }),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );
});

// 9. Deletion
test('deletion: deleted seed rejects stale_message, deleted neighbor excluded', async () => {
  const seedDeleted = makeMail(1, {
    flags: new Set(['\\Deleted']),
    envelope: { messageId: '<deletedSeed@example.test>' }
  });

  const account = { id: 'acc1' };
  const { conversations: conv1 } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [seedDeleted] }] }
  });

  const refDeleted = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(seedDeleted)
  };

  await assert.rejects(
    () => conv1.load(account, refDeleted),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );

  const seedAlive = makeMail(10, { envelope: { messageId: '<alive@example.test>' } });
  const neighborDeleted = makeMail(20, {
    flags: new Set(['\\Deleted']),
    envelope: { messageId: '<neighbor@example.test>', inReplyTo: '<alive@example.test>' }
  });

  const { conversations: conv2 } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [seedAlive, neighborDeleted] }] }
  });

  const refAlive = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 10,
    fingerprint: mailFingerprint(seedAlive)
  };

  const res = await conv2.load(account, refAlive);
  assert.equal(res.complete, true);
  assert.equal(res.messages.length, 1);
  assert.equal(res.messages[0].messageId, '<alive@example.test>');
});

// 10. Malformed/truncated headers
test('malformed or missing headers safely defaults to selected-only', async () => {
  const malformed = makeMail(1, {
    envelope: {
      messageId: 'no_brackets_at_all',
      inReplyTo: '',
      references: ''
    },
    headers: Buffer.from('Garbage-Header: test\r\n')
  });

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [malformed] }] }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(malformed)
  };

  const result = await conversations.load(account, reference);
  assert.equal(result.complete, true);
  assert.equal(result.nextCursor, null);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, '');
  assert.equal(result.messages[0].folderPath, 'INBOX');
});

// 11. Per-call budget eventually complete
test('per-call budget eventually complete', async () => {
  const m1 = makeMail(1, { envelope: { date: new Date('2026-09-01T10:00:00Z'), messageId: '<m1@example.test>' } });
  const m2 = makeMail(2, { envelope: { date: new Date('2026-09-01T11:00:00Z'), messageId: '<m2@example.test>', inReplyTo: '<m1@example.test>' } });
  const m3 = makeMail(3, { envelope: { date: new Date('2026-09-01T12:00:00Z'), messageId: '<m3@example.test>', inReplyTo: '<m2@example.test>' } });

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', messages: [m1] },
        { path: 'Sent', messages: [m2] },
        { path: 'Archive', messages: [m3] }
      ]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(m1)
  };

  let cursor = null;
  let complete = false;
  let iterations = 0;
  let lastResult;

  while (!complete && iterations++ < 20) {
    lastResult = await conversations.load(account, reference, {
      cursor,
      budget: { maxSearchesPerCall: 1, maxFetchesPerCall: 1 }
    });
    complete = lastResult.complete;
    cursor = lastResult.nextCursor;
  }

  assert.equal(complete, true);
  assert.equal(lastResult.nextCursor, null);
  assert.equal(lastResult.messages.length, 3);
  const ids = lastResult.messages.map(m => m.messageId);
  assert.deepEqual(ids, ['<m1@example.test>', '<m2@example.test>', '<m3@example.test>']);
});

// 12. Partial errors resumable
test('partial errors resumable without endlessly repeating failed folder', async () => {
  const m1 = makeMail(1, { envelope: { messageId: '<m1@example.test>' } });
  const m2 = makeMail(2, { envelope: { messageId: '<m2@example.test>', inReplyTo: '<m1@example.test>' } });

  const account = { id: 'acc1' };
  const { conversations, states } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', messages: [m1] },
        { path: 'Broken', messages: [], searchError: new Error('Simulated IMAP failure') },
        { path: 'Sent', messages: [m2] }
      ]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(m1)
  };

  const step1 = await conversations.load(account, reference, { budget: { maxSearchesPerCall: 2 } });
  assert.equal(step1.complete, false);
  assert.ok(step1.nextCursor);
  assert.ok(step1.errors.some(e => e.folderPath === 'Broken'));

  const brokenFolder = states.acc1.folders.find(f => f.path === 'Broken');
  delete brokenFolder.searchError;

  const step2 = await conversations.load(account, reference, { cursor: step1.nextCursor });
  assert.equal(step2.complete, true);
  assert.equal(step2.messages.length, 2);
  assert.equal(step2.errors.length, 0);
});

// 13. Cancellation release
test('cancellation release rejects cancelled and releases resources', async () => {
  const mail = makeMail(1, { envelope: { messageId: '<cancel@example.test>' } });
  const account = { id: 'acc1' };
  const controller = new AbortController();

  const { conversations, calls } = harness({
    acc1: {
      folders: [{ path: 'INBOX', messages: [mail] }],
      onSearch() {
        controller.abort();
      }
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(mail)
  };

  await assert.rejects(
    () => conversations.load(account, reference, { signal: controller.signal }),
    err => err instanceof MailHarborError && err.code === 'cancelled'
  );

  const locks = calls.filter(c => c.action === 'lock').length;
  const unlocks = calls.filter(c => c.action === 'unlock').length;
  assert.ok(locks > 0);
  assert.equal(locks, unlocks);
});

// 14. Gmail emailId copies selected preferred while ordinary copies kept
test('Gmail emailId copies selected preferred while ordinary copies kept', async () => {
  const gmailInboxCopy = makeMail(10, {
    emailId: '1234567890',
    envelope: { messageId: '<msg@example.test>', subject: 'Gmail Copy' }
  });
  const gmailAllMailCopy = makeMail(20, {
    emailId: '1234567890',
    envelope: { messageId: '<msg@example.test>', subject: 'Gmail Copy' }
  });

  const accountGmail = { id: 'accGmail' };
  const { conversations: gmailConv } = harness({
    accGmail: {
      capabilities: ['X-GM-EXT-1'],
      folders: [
        { path: 'INBOX', messages: [gmailInboxCopy] },
        { path: '[Gmail]/All Mail', messages: [gmailAllMailCopy] }
      ]
    }
  });

  const gmailRef = {
    accountId: accountGmail.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 10,
    fingerprint: mailFingerprint(gmailInboxCopy)
  };

  const gmailResult = await gmailConv.load(accountGmail, gmailRef);
  assert.equal(gmailResult.complete, true);
  assert.equal(gmailResult.messages.length, 1);
  assert.equal(gmailResult.messages[0].folderPath, 'INBOX');
  assert.equal(gmailResult.messages[0].reference.uid, 10);

  const standardInboxCopy = makeMail(10, {
    envelope: { messageId: '<msg@example.test>', subject: 'Standard Copy' }
  });
  const standardArchiveCopy = makeMail(20, {
    envelope: { messageId: '<msg@example.test>', subject: 'Standard Copy' }
  });

  const accountStandard = { id: 'accStandard' };
  const { conversations: standardConv } = harness({
    accStandard: {
      capabilities: [],
      folders: [
        { path: 'INBOX', messages: [standardInboxCopy] },
        { path: 'Archive', messages: [standardArchiveCopy] }
      ]
    }
  });

  const standardRef = {
    accountId: accountStandard.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 10,
    fingerprint: mailFingerprint(standardInboxCopy)
  };

  const standardResult = await standardConv.load(accountStandard, standardRef);
  assert.equal(standardResult.complete, true);
  assert.equal(standardResult.messages.length, 2);
  const paths = standardResult.messages.map(m => m.folderPath).sort();
  assert.deepEqual(paths, ['Archive', 'INBOX']);
});

// 15. Candidate pagination with >250 candidates and maxFetchesPerCall=1
test('candidate pagination with >250 candidates and maxFetchesPerCall=1 finds later candidates', async () => {
  const root = makeMail(1, { envelope: { date: new Date('2026-09-01T09:00:00Z'), messageId: '<root@example.test>' } });
  const archiveReplies = [];
  for (let i = 10; i < 270; i++) {
    archiveReplies.push(makeMail(i, {
      envelope: {
        date: new Date(NOW - i * 60000),
        messageId: `<reply${i}@example.test>`,
        inReplyTo: '<root@example.test>'
      }
    }));
  }

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', messages: [root] },
        { path: 'Archive', messages: archiveReplies }
      ]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  // Step 1: maxFetchesPerCall = 1. Fetches first chunk (at most 250 UIDs from Archive).
  const step1 = await conversations.load(account, reference, {
    budget: { maxFetchesPerCall: 1, maxSearchesPerCall: 5, maxCandidatesPerFolder: 1000, maxTotalMessages: 500 }
  });
  assert.equal(step1.complete, false);
  assert.ok(step1.nextCursor);
  assert.equal(step1.messages.length, 251);

  // Step 2: Continue with same limits until complete
  let currentResult = step1;
  let iterations = 0;
  while (!currentResult.complete && iterations++ < 1000) {
    currentResult = await conversations.load(account, reference, {
      cursor: currentResult.nextCursor,
      budget: { maxFetchesPerCall: 1, maxSearchesPerCall: 5, maxCandidatesPerFolder: 1000, maxTotalMessages: 500 }
    });
  }
  assert.equal(currentResult.complete, true);
  assert.equal(currentResult.nextCursor, null);
  assert.equal(currentResult.messages.length, 261);
  const foundLast = currentResult.messages.some(m => m.messageId === '<reply269@example.test>');
  assert.equal(foundLast, true);
  assert.ok(iterations > 0 && iterations < 1000);
});

// 16. Cap terminal partial when maxTotalMessages is reached
test('cap terminal partial when maxTotalMessages is reached', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const reply1 = makeMail(2, { envelope: { messageId: '<reply1@example.test>', inReplyTo: '<root@example.test>' } });
  const reply2 = makeMail(3, { envelope: { messageId: '<reply2@example.test>', inReplyTo: '<root@example.test>' } });

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [{ path: 'INBOX', messages: [root, reply1, reply2] }]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  const result = await conversations.load(account, reference, { budget: { maxTotalMessages: 2 } });
  assert.equal(result.complete, false);
  assert.equal(result.nextCursor, null);
  assert.equal(result.messages.length, 2);
  assert.ok(result.errors.some(e => e.code === 'mailbox_error'));
});

// 17. Transient FETCH error retry clears error on success
test('transient FETCH error retry clears error on success', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const reply = makeMail(10, { envelope: { messageId: '<reply@example.test>', inReplyTo: '<root@example.test>' } });

  const account = { id: 'acc1' };
  const { conversations, states } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', messages: [root] },
        { path: 'Archive', messages: [reply], fetchError: new Error('Transient fetch failure') }
      ]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  const step1 = await conversations.load(account, reference);
  assert.equal(step1.complete, false);
  assert.ok(step1.nextCursor);
  assert.ok(step1.errors.some(e => e.folderPath === 'Archive'));

  // Clear transient fetchError
  const archiveFolder = states.acc1.folders.find(f => f.path === 'Archive');
  delete archiveFolder.fetchError;

  const step2 = await conversations.load(account, reference, { cursor: step1.nextCursor });
  assert.equal(step2.complete, true);
  assert.equal(step2.errors.length, 0);
  assert.equal(step2.messages.length, 2);
});

// 18. Known completed-folder UIDVALIDITY invalidation
test('known completed-folder UIDVALIDITY invalidation', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const reply = makeMail(10, { envelope: { messageId: '<reply@example.test>', inReplyTo: '<root@example.test>' } });
  const grandchild = makeMail(20, { envelope: { messageId: '<grandchild@example.test>', inReplyTo: '<reply@example.test>' } });

  const account = { id: 'acc1' };
  const { conversations, states } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', uidValidity: 1n, messages: [root] },
        { path: 'Archive', uidValidity: 1n, messages: [reply] },
        { path: 'Sent', uidValidity: 1n, messages: [grandchild] }
      ]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  let step1;
  let cursor = null;
  while (true) {
    step1 = await conversations.load(account, reference, {
      cursor,
      budget: { maxSearchesPerCall: 1, maxFetchesPerCall: 1 }
    });
    cursor = step1.nextCursor;
    if (step1.messages.some(m => m.folderPath === 'Archive') && !step1.complete && cursor) {
      break;
    }
    assert.ok(cursor, 'Continuation must be pending');
  }

  assert.ok(step1.messages.some(m => m.folderPath === 'Archive'));
  assert.equal(step1.complete, false);
  assert.ok(step1.nextCursor);

  const archiveFolder = states.acc1.folders.find(f => f.path === 'Archive');
  archiveFolder.uidValidity = 2n;

  await assert.rejects(
    () => conversations.load(account, reference, { cursor: step1.nextCursor }),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );
});

// 19. Revision change rejects with stale_message
test('revision change rejects with stale_message', async () => {
  const m1 = makeMail(1, { envelope: { messageId: '<m1@example.test>' } });
  const m2 = makeMail(2, { envelope: { messageId: '<m2@example.test>', inReplyTo: '<m1@example.test>' } });

  const account = { id: 'acc1', revision: 'rev-100' };
  const { conversations } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', messages: [m1] },
        { path: 'Sent', messages: [m2] }
      ]
    }
  });

  const reference = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(m1)
  };

  const step1 = await conversations.load(account, reference, { budget: { maxSearchesPerCall: 1 } });
  assert.ok(step1.nextCursor);

  const changedAccount = { ...account, revision: 'rev-101' };
  await assert.rejects(
    () => conversations.load(changedAccount, reference, { cursor: step1.nextCursor }),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );
});

// 20. Invalid budget rejected and hard bounds enforced
test('invalid budget rejected and hard bounds enforced', async () => {
  const mail = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [mail] }] }
  });

  const ref = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(mail)
  };

  await assert.rejects(
    () => conversations.load(account, ref, { budget: { maxSearchesPerCall: 0 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );

  await assert.rejects(
    () => conversations.load(account, ref, { budget: { maxFetchesPerCall: -5 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );

  await assert.rejects(
    () => conversations.load(account, ref, { budget: { maxCandidatesPerFolder: NaN } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );

  await assert.rejects(
    () => conversations.load(account, ref, { budget: { maxTotalMessages: Infinity } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );

  await assert.rejects(
    () => conversations.load(account, ref, { budget: { unauthorizedHack: 123 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
});

// 21. Raw folded header fallback and truncation partial
test('raw folded header fallback and truncation partial', async () => {
  const root = makeMail(1, {
    envelope: {
      messageId: '<root@example.test>',
      inReplyTo: '',
      references: ''
    }
  });
  const foldedReply = makeMail(2, {
    envelope: {
      messageId: '',
      inReplyTo: '',
      references: ''
    },
    headers: Buffer.from(
      'Message-ID: <foldedReply@example.test>\r\nReferences: <root@example.test>\r\nIn-Reply-To: <root@example.test>\r\n'
    )
  });

  const account = { id: 'acc1' };
  const { conversations: convA } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [root, foldedReply] }] }
  });

  const refA = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  const resA = await convA.load(account, refA);
  assert.equal(resA.complete, true);
  assert.equal(resA.messages.length, 2);
  const ids = resA.messages.map(m => m.messageId).sort();
  assert.deepEqual(ids, ['<foldedReply@example.test>', '<root@example.test>']);

  const over100Refs = Array.from({ length: 110 }, (_, i) => `<ref${i}@example.test>`).join(' ');
  const truncatedMail = makeMail(10, {
    envelope: {
      messageId: '<trunc@example.test>',
      references: over100Refs
    }
  });

  const { conversations: convB } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [truncatedMail] }] }
  });

  const refB = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 10,
    fingerprint: mailFingerprint(truncatedMail)
  };

  const resB = await convB.load(account, refB);
  assert.equal(resB.complete, false);
  assert.equal(resB.nextCursor, null);
  assert.ok(resB.errors.some(e => e.code === 'mailbox_error'));
});

// 22. Unsolicited and duplicate UID rejection in FETCH stream
test('unsolicited and duplicate UID rejection in FETCH stream', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const reply = makeMail(2, { envelope: { messageId: '<reply@example.test>', inReplyTo: '<root@example.test>' } });
  const unsolicited = makeMail(999, { envelope: { messageId: '<unsolicited@example.test>', inReplyTo: '<root@example.test>' } });

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [{ path: 'INBOX', messages: [root, reply] }],
      onConnect(client) {
        const origFetch = client.fetch.bind(client);
        client.fetch = async function* (range, query, fetchOpts) {
          for await (const msg of origFetch(range, query, fetchOpts)) {
            yield msg;
            yield structuredClone(msg);
          }
          yield structuredClone(unsolicited);
        };
      }
    }
  });

  const ref = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  const result = await conversations.load(account, ref);
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages.some(m => m.reference.uid === 999), false);
});

// 23. Public messages include deterministic id SHA256 and account metadata
test('public messages include deterministic id SHA256 and account metadata', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const account = { id: 'acc1', label: 'My Work Mail', email: 'user@example.test' };
  const { conversations } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [root] }] }
  });

  const ref = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  const result = await conversations.load(account, ref);
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 1);
  const msg = result.messages[0];
  assert.equal(msg.account, 'My Work Mail');
  assert.equal(msg.accountId, 'acc1');
  assert.equal(typeof msg.id, 'string');
  assert.equal(msg.id.length, 64);
  assert.match(msg.id, /^[a-f0-9]{64}$/);
});

// 24. Stable all-folder iteration without skipping folders
test('stable all-folder iteration discovers across all folders without skipping', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const replyA = makeMail(10, { envelope: { messageId: '<replyA@example.test>', inReplyTo: '<root@example.test>' } });
  const replyB = makeMail(20, { envelope: { messageId: '<replyB@example.test>', inReplyTo: '<root@example.test>' } });
  const replyC = makeMail(30, { envelope: { messageId: '<replyC@example.test>', inReplyTo: '<root@example.test>' } });

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', messages: [root] },
        { path: 'Alpha', messages: [replyA] },
        { path: 'Beta', messages: [replyB] },
        { path: 'Gamma', messages: [replyC] }
      ]
    }
  });

  const ref = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  let current = null;
  let cursor = null;
  let iters = 0;
  while ((!current || !current.complete) && iters++ < 20) {
    current = await conversations.load(account, ref, {
      cursor,
      budget: { maxSearchesPerCall: 1, maxFetchesPerCall: 1 }
    });
    cursor = current.nextCursor;
  }

  assert.equal(current.complete, true);
  assert.equal(current.nextCursor, null);
  assert.equal(current.messages.length, 4);
  const paths = current.messages.map(m => m.folderPath).sort();
  assert.deepEqual(paths, ['Alpha', 'Beta', 'Gamma', 'INBOX']);
});

// 25. Persistent error terminal partial after max 3 retries
test('persistent error terminal partial after max 3 retries', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', messages: [root] },
        { path: 'Faulty', messages: [], searchError: new Error('Persistent failure') }
      ]
    }
  });

  const ref = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  const step1 = await conversations.load(account, ref);
  assert.equal(step1.complete, false);
  assert.ok(step1.nextCursor);
  assert.ok(step1.errors.some(e => e.folderPath === 'Faulty'));

  const step2 = await conversations.load(account, ref, { cursor: step1.nextCursor });
  assert.equal(step2.complete, false);
  assert.ok(step2.nextCursor);
  assert.ok(step2.errors.some(e => e.folderPath === 'Faulty'));

  const step3 = await conversations.load(account, ref, { cursor: step2.nextCursor });
  assert.equal(step3.complete, false);
  assert.equal(step3.nextCursor, null);
  assert.ok(step3.errors.some(e => e.folderPath === 'Faulty' || e.code === 'mailbox_error'));
});

// 26. Oversized and malformed header terminal partial
test('oversized or malformed header produces terminal partial', async () => {
  const root = makeMail(1, {
    envelope: {
      messageId: '<root@example.test>',
      references: 'some invalid references without angle brackets'
    }
  });

  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [root] }] }
  });

  const ref = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  const res = await conversations.load(account, ref);
  assert.equal(res.complete, false);
  assert.equal(res.nextCursor, null);
  assert.ok(res.errors.some(e => e.code === 'mailbox_error'));
});

// 27. Clear while load awaits invalidates inflight cursor and cache
test('clear while load awaits invalidates inflight cursor', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const reply = makeMail(2, { envelope: { messageId: '<reply@example.test>', inReplyTo: '<root@example.test>' } });
  const account = { id: 'acc1' };

  let conv;
  const { conversations } = harness({
    acc1: {
      folders: [
        { path: 'INBOX', messages: [root] },
        { path: 'Archive', messages: [reply] }
      ],
      async onSearch() {
        if (conv) conv.clear();
      }
    }
  });
  conv = conversations;

  const ref = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  await assert.rejects(
    () => conversations.load(account, ref, { budget: { maxSearchesPerCall: 1 } }),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );
});

// 28. Seed validity changed in fetchOne
test('seed validity changed in fetchOne throws stale_message', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: {
      folders: [{ path: 'INBOX', uidValidity: 1n, messages: [root] }],
      onConnect(client) {
        const origFetchOne = client.fetchOne.bind(client);
        client.fetchOne = async (uid, query, fetchOpts) => {
          client.mailbox.uidValidity = 2n;
          return origFetchOne(uid, query, fetchOpts);
        };
      }
    }
  });

  const ref = {
    accountId: account.id,
    path: 'INBOX',
    uidValidity: '1',
    uid: 1,
    fingerprint: mailFingerprint(root)
  };

  await assert.rejects(
    () => conversations.load(account, ref),
    err => err instanceof MailHarborError && err.code === 'stale_message'
  );
});

// 29. Initial seed token cap terminal
test('initial seed token cap produces terminal partial', async () => {
  const refs = Array.from({ length: 10 }, (_, i) => `<ref${i}@example.test>`).join(' ');
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>', references: refs } });
  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [root] }] }
  });
  const ref = { accountId: account.id, path: 'INBOX', uidValidity: '1', uid: 1, fingerprint: mailFingerprint(root) };
  const res = await conversations.load(account, ref, { budget: { maxTotalTokens: 5 } });
  assert.equal(res.complete, false);
  assert.equal(res.nextCursor, null);
  assert.ok(res.errors.some(e => e.code === 'mailbox_error'));
});

// 30. Hard option upper bounds
test('hard option upper bounds enforced', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const account = { id: 'acc1' };
  const { conversations } = harness({
    acc1: { folders: [{ path: 'INBOX', messages: [root] }] }
  });
  const ref = { accountId: account.id, path: 'INBOX', uidValidity: '1', uid: 1, fingerprint: mailFingerprint(root) };

  await assert.rejects(
    () => conversations.load(account, ref, { budget: { maxSearchesPerCall: 101 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
  await assert.rejects(
    () => conversations.load(account, ref, { budget: { maxFetchesPerCall: 201 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
  await assert.rejects(
    () => conversations.load(account, ref, { budget: { maxCandidatesPerFolder: 2001 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
  await assert.rejects(
    () => conversations.load(account, ref, { budget: { maxTotalMessages: 501 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
  await assert.rejects(
    () => conversations.load(account, ref, { budget: { maxTotalTokens: 1001 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );

  assert.throws(
    () => createMailConversations({ session: () => {}, active: new WeakSet(), fingerprint: () => '', maxCacheEntries: 201 }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
  assert.throws(
    () => createMailConversations({ session: () => {}, active: new WeakSet(), fingerprint: () => '', cursorTtlMs: 900_001 }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
  assert.throws(
    () => createMailConversations({ session: () => {}, active: new WeakSet(), fingerprint: () => '', defaultBudget: { maxSearchesPerCall: 101 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
});

// 31. Empty/missing-selected LIST partial
test('empty or missing-selected LIST yields terminal partial mailbox_error', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const account = { id: 'acc1' };

  // Empty folders
  const { conversations: convEmpty } = harness({
    acc1: {
      folders: [{ path: 'INBOX', messages: [root] }],
      onConnect(client) {
        client.list = async () => [];
      }
    }
  });
  const ref = { accountId: account.id, path: 'INBOX', uidValidity: '1', uid: 1, fingerprint: mailFingerprint(root) };
  const resEmpty = await convEmpty.load(account, ref);
  assert.equal(resEmpty.complete, false);
  assert.equal(resEmpty.nextCursor, null);
  assert.ok(resEmpty.errors.some(e => e.code === 'mailbox_error'));

  // Missing selected selectable path
  const { conversations: convMissing } = harness({
    acc1: {
      folders: [{ path: 'INBOX', messages: [root] }, { path: 'Archive', messages: [] }],
      onConnect(client) {
        client.list = async () => [{ path: 'Archive', flags: new Set() }];
      }
    }
  });
  const resMissing = await convMissing.load(account, ref);
  assert.equal(resMissing.complete, false);
  assert.equal(resMissing.nextCursor, null);
  assert.ok(resMissing.errors.some(e => e.code === 'mailbox_error'));
});

// 32. Malformed Gmail IDs don't dedup
test('malformed Gmail IDs do not dedup', async () => {
  const mail1 = makeMail(10, {
    emailId: 'bad id with spaces!',
    envelope: { messageId: '<m1@example.test>', subject: 'Subject' }
  });
  const mail2 = makeMail(20, {
    emailId: 'bad id with spaces!',
    envelope: { messageId: '<m2@example.test>', inReplyTo: '<m1@example.test>', subject: 'Subject' }
  });

  const account = { id: 'accGmail' };
  const { conversations } = harness({
    accGmail: {
      capabilities: ['X-GM-EXT-1'],
      folders: [
        { path: 'INBOX', messages: [mail1] },
        { path: 'Archive', messages: [mail2] }
      ]
    }
  });

  const ref = { accountId: account.id, path: 'INBOX', uidValidity: '1', uid: 10, fingerprint: mailFingerprint(mail1) };
  const result = await conversations.load(account, ref);
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 2);
  const uids = result.messages.map(m => m.reference.uid).sort();
  assert.deepEqual(uids, [10, 20]);
});

// 33. Header query includes required 3 fields
test('header query includes required Message-ID, References, and In-Reply-To', async () => {
  const root = makeMail(1, { envelope: { messageId: '<root@example.test>' } });
  const account = { id: 'acc1' };
  let fetchOneQuery = null;
  const { conversations } = harness({
    acc1: {
      folders: [{ path: 'INBOX', messages: [root] }],
      onConnect(client) {
        const origFetchOne = client.fetchOne.bind(client);
        client.fetchOne = async (uid, query, fetchOpts) => {
          fetchOneQuery = query;
          return origFetchOne(uid, query, fetchOpts);
        };
      }
    }
  });
  const ref = { accountId: account.id, path: 'INBOX', uidValidity: '1', uid: 1, fingerprint: mailFingerprint(root) };
  await conversations.load(account, ref);
  assert.ok(fetchOneQuery);
  assert.ok(Array.isArray(fetchOneQuery.headers));
  assert.ok(fetchOneQuery.headers.includes('Message-ID'));
  assert.ok(fetchOneQuery.headers.includes('References'));
  assert.ok(fetchOneQuery.headers.includes('In-Reply-To'));
});
