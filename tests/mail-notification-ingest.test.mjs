import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { createMailNotifications } from '../server/mail-notifications.mjs';

const folderId = `folder:${'a'.repeat(64)}`;
const state = (uidNext = 2, overrides = {}) => ({
  accountId: 'a',
  folderId,
  uidValidity: '1',
  uidNext,
  unseen: 1,
  messages: 1,
  ...overrides
});

const registration = (endpoint = 'https://fcm.googleapis.com/fcm/send/device') => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url')
    }
  };
};

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  let data = {}, pending = Promise.resolve(), result = { states: [state()], errors: [] }, currentTime = 100000;
  let account = { id: 'a', email: 'PRIVATE_OWNER@example.test', revision: '1' };
  const accountMap = new Map([['a', account]]);
  let connectedList = [{ id: 'a', connected: true }];
  const sent = [], calls = [];
  const store = {
    read: () => structuredClone(data),
    update(work) {
      const operation = pending.then(async () => {
        const copy = structuredClone(data);
        const value = await work(copy);
        data = copy;
        return value;
      });
      pending = operation.catch(() => {});
      return operation;
    }
  };
  const accounts = {
    list: () => structuredClone(connectedList),
    get: id => {
      const item = connectedList.find(c => c.id === id);
      if (!item || !item.connected) throw new Error('Account disconnected');
      if (accountMap.has(id)) return { ...accountMap.get(id) };
      return { ...account, id };
    }
  };
  const reader = {
    changes: async (current, opts) => {
      calls.push({ current, options: opts });
      return result;
    }
  };
  const push = {
    generateVAPIDKeys: () => ({ publicKey: 'PUBLIC_KEY', privateKey: 'PRIVATE_KEY' }),
    async sendNotification(...args) { sent.push(args); }
  };
  const notifications = createMailNotifications({
    store,
    accounts,
    reader,
    push,
    origin: 'https://mail.example.test',
    now: () => currentTime,
    intervalMs: 600000,
    ...options
  });
  return {
    notifications,
    store,
    accounts,
    account,
    accountMap,
    get connectedList() { return connectedList; },
    set connectedList(v) { connectedList = v; },
    reader,
    push,
    sent,
    calls,
    set: value => { result = value; currentTime += 1000; }
  };
}

test('a live cache health predicate resumes watched provider polling after runtime cache failure', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let cacheHealthy = true;
  const h = harness({ pollEnabled: () => !cacheHealthy });
  t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration());
  await h.notifications.ingest({ states: [state(2)], errors: [] });
  h.notifications.updates();
  t.mock.timers.tick(600000);
  await h.notifications.poll();
  assert.equal(h.calls.length, 0, 'healthy sync cache never duplicates provider STATUS polling');
  h.set({ states: [state(3)], errors: [] });
  cacheHealthy = false;
  t.mock.timers.tick(600000);
  await h.notifications.poll();
  assert.equal(h.calls.length, 1, 'the existing watched/subscribed interval takes over after failure');
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 3);
  assert.equal(h.sent.length, 1, 'new mail notifications continue from the sync baseline');
  assert.deepEqual(JSON.parse(h.sent[0][1]), { title: 'New mail', body: 'Open MailHarbor to read your new mail.', url: '/#inbox' });
});

test('a polling mode change rejects a late provider snapshot and close still stops the watcher', async t => {
  let enabled = true;
  const entered = createDeferred(), release = createDeferred();
  const h = harness({ pollEnabled: () => enabled });
  h.reader.changes = async () => { entered.resolve(); return release.promise; };
  const pending = h.notifications.poll(); await entered.promise;
  enabled = false; release.resolve({ states: [state(99)], errors: [] }); await pending;
  assert.equal(h.store.read().mailNotifications, undefined);
  await h.notifications.close(); enabled = true; await h.notifications.poll();
  assert.equal(h.store.read().mailNotifications, undefined);
});

test('ingest baseline/increment/repeat/UIDVALIDITY with generic push', async t => {
  const h = harness();
  t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration());

  // 1. Establish baseline via ingest
  await h.notifications.ingest({ states: [state(2)], errors: [] });
  assert.equal(h.sent.length, 0, 'first baseline does not notify');
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2);

  // 2. Increment UIDNEXT
  await h.notifications.ingest({
    states: [state(3, { subject: 'PRIVATE_SUBJECT', body: 'PRIVATE_BODY', credentials: 'SECRET_CREDENTIALS' })],
    errors: []
  });
  assert.equal(h.sent.length, 1, 'increasing UIDNEXT notifies once');
  const [subscription, payload, options] = h.sent[0];
  assert.equal(subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/device');
  assert.deepEqual(JSON.parse(payload), { title: 'New mail', body: 'Open MailHarbor to read your new mail.', url: '/#inbox' });
  assert.doesNotMatch(payload, /PRIVATE_|SECRET_|uidNext|accountId/);
  assert.equal(options.TTL, 3600);
  assert.doesNotMatch(JSON.stringify(h.store.read().mailNotifications.states), /PRIVATE_SUBJECT|PRIVATE_BODY|SECRET_CREDENTIALS/);
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 3);

  // 3. Repeat UIDNEXT
  await h.notifications.ingest({ states: [state(3)], errors: [] });
  assert.equal(h.sent.length, 1, 'repeated unchanged UIDNEXT does not notify');

  // 4. UIDVALIDITY reset
  await h.notifications.ingest({ states: [state(20, { uidValidity: '2' })], errors: [] });
  assert.equal(h.sent.length, 1, 'UIDVALIDITY reset does not notify');
  assert.equal(h.store.read().mailNotifications.states[0].uidValidity, '2');
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 20);
});

test('pollEnabled false all entrypoints don not read provider', async t => {
  const h = harness({ pollEnabled: false });
  t.after(() => h.notifications.close());

  // updates()
  const updates = h.notifications.updates();
  assert.equal(h.calls.length, 0);
  assert.equal(updates.checkedAt, null);

  // subscribe()
  await h.notifications.subscribe(registration());
  assert.equal(h.calls.length, 0);

  // manual poll()
  await h.notifications.poll();
  assert.equal(h.calls.length, 0);

  // ingest() works without calling reader.changes
  await h.notifications.ingest({ states: [state(2)], errors: [] });
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2);

  await h.notifications.ingest({ states: [state(3)], errors: [] });
  assert.equal(h.calls.length, 0);
  assert.equal(h.sent.length, 1);
});

test('queued snapshot capture mutation protection + sequential duplicate notification', async t => {
  const h = harness();
  t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration());

  // Mutation protection: synchronous mutation immediately after enqueue does not affect ingest
  const mutableSnapshot = {
    states: [state(2)],
    errors: []
  };
  const ingestPromise = h.notifications.ingest(mutableSnapshot);
  mutableSnapshot.states[0].uidNext = 999;
  mutableSnapshot.states.push(state(50));
  mutableSnapshot.errors.push({ code: 'mailbox_error' });
  await ingestPromise;

  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2, 'mutated uidNext was not adopted');
  assert.equal(h.store.read().mailNotifications.states.length, 1, 'pushed state was not adopted');
  assert.equal(h.notifications.updates().errors.length, 0, 'pushed error was not adopted');

  // Sequential ordered notifications
  const p1 = h.notifications.ingest({ states: [state(3)], errors: [] });
  const p2 = h.notifications.ingest({ states: [state(4)], errors: [] });
  await Promise.all([p1, p2]);
  assert.equal(h.sent.length, 2, 'both increments notified in sequence');
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 4);

  // Duplicate snapshots: first notifies, second detects already-committed state and does not notify
  const p3 = h.notifications.ingest({ states: [state(5)], errors: [] });
  const p4 = h.notifications.ingest({ states: [state(5)], errors: [] });
  await Promise.all([p3, p4]);
  assert.equal(h.sent.length, 3, 'first increment notified, duplicate did not notify');
});

test('revision/disconnect during queued store commit does not persist stale result/push', async t => {
  const h = harness();
  t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration());
  await h.notifications.ingest({ states: [state(2)], errors: [] });
  assert.equal(h.sent.length, 0);

  const originalUpdate = h.store.update;
  let interceptUpdate = false;
  let enteredGate = createDeferred();
  let releaseGate = createDeferred();

  h.store.update = async work => {
    if (interceptUpdate) {
      interceptUpdate = false;
      enteredGate.resolve();
      await releaseGate.promise;
    }
    return originalUpdate.call(h.store, work);
  };

  // 1. Revision change during queued store commit
  interceptUpdate = true;
  enteredGate = createDeferred();
  releaseGate = createDeferred();
  const ingestPromise = h.notifications.ingest({ states: [state(10)], errors: [] });

  try {
    await enteredGate.promise;
    // While store commit is blocked, change revision
    h.account.revision = '2';
  } finally {
    releaseGate.resolve();
  }
  await ingestPromise;

  assert.equal(h.sent.length, 0, 'no push sent on revision change');
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2, 'stale uidNext not persisted');

  // 2. Disconnect during queued store commit
  interceptUpdate = true;
  enteredGate = createDeferred();
  releaseGate = createDeferred();
  const ingestPromise2 = h.notifications.ingest({ states: [state(20)], errors: [] });

  try {
    await enteredGate.promise;
    // While commit is blocked, disconnect account
    h.connectedList = [];
  } finally {
    releaseGate.resolve();
  }
  await ingestPromise2;

  assert.equal(h.sent.length, 0, 'no push sent on disconnect');
  assert.equal(h.store.read().mailNotifications.states?.length ?? 0, 0, 'disconnected account removed, stale state not persisted');
});

test('failed account baseline retained/recovery', async t => {
  const h = harness();
  t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration());
  await h.notifications.ingest({ states: [state(2)], errors: [] });
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2);

  // Transient account error preserves baseline
  await h.notifications.ingest({
    states: [],
    errors: [{ accountId: 'a', code: 'mailbox_error', message: 'PRIVATE_ERROR_DETAIL' }]
  });
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2);
  assert.deepEqual(h.notifications.updates().errors, [{ accountId: 'a', code: 'mailbox_error' }]);
  assert.equal(h.sent.length, 0);

  // Recovery arrival notifies
  await h.notifications.ingest({ states: [state(5)], errors: [] });
  assert.equal(h.sent.length, 1);
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 5);
  assert.deepEqual(h.notifications.updates().errors, []);

  // Disconnected account removed during valid ingestion
  h.connectedList = [];
  await h.notifications.ingest({ states: [], errors: [] });
  assert.equal(h.store.read().mailNotifications.states.length, 0, 'disconnected account baseline removed');
  assert.ok(h.notifications.updates().checkedAt, 'empty valid snapshot updates checkedAt');
});

test('invalid/foreign states safe errors', async t => {
  const h = harness();
  t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration());
  await h.notifications.ingest({ states: [state(2)], errors: [] });

  // Foreign account ID
  await h.notifications.ingest({
    states: [state(3, { accountId: 'foreign-account-id' })],
    errors: []
  });
  assert.deepEqual(h.notifications.updates().errors, [{ code: 'mailbox_error' }]);
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2);
  assert.equal(h.sent.length, 0);

  // Malformed folderId
  await h.notifications.ingest({
    states: [state(3, { folderId: 'folder:not-64-hex' })],
    errors: []
  });
  assert.deepEqual(h.notifications.updates().errors, [{ code: 'mailbox_error' }]);
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2);

  // Malformed uidValidity
  await h.notifications.ingest({
    states: [state(3, { uidValidity: 'bad-validity' })],
    errors: []
  });
  assert.deepEqual(h.notifications.updates().errors, [{ code: 'mailbox_error' }]);

  // Malformed uidNext (< 1)
  await h.notifications.ingest({
    states: [state(0)],
    errors: []
  });
  assert.deepEqual(h.notifications.updates().errors, [{ code: 'mailbox_error' }]);

  // Duplicate conflicting physical states
  await h.notifications.ingest({
    states: [state(3), state(4)],
    errors: []
  });
  assert.deepEqual(h.notifications.updates().errors, [{ code: 'mailbox_error' }]);
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2);

  // Over-limit states array (> 10000)
  const hugeStates = Array.from({ length: 10001 }, () => state(3));
  await h.notifications.ingest({ states: hugeStates, errors: [] });
  assert.deepEqual(h.notifications.updates().errors, [{ code: 'mailbox_error' }]);

  // Non-object snapshot
  await h.notifications.ingest(null);
  assert.deepEqual(h.notifications.updates().errors, [{ code: 'mailbox_error' }]);
});

test('close drops queued/late data and aborts active reader', async t => {
  const h = harness();
  t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration());
  await h.notifications.poll();
  await h.notifications.ingest({ states: [state(2)], errors: [] });

  // Active reader is aborted on close, late result ignored
  const readerEntered = createDeferred();
  const readerRelease = createDeferred();
  let readerSignal;
  h.reader.changes = async (_accounts, options) => {
    readerSignal = options.signal;
    readerEntered.resolve();
    return readerRelease.promise;
  };
  const pollPromise = h.notifications.poll();

  try {
    await readerEntered.promise;
    assert.equal(readerSignal.aborted, false);

    const closePromise = h.notifications.close();
    assert.equal(readerSignal.aborted, true, 'reader signal was aborted');

    readerRelease.resolve({ states: [state(10)], errors: [] });
    await Promise.all([pollPromise, closePromise]);
  } finally {
    readerRelease.resolve({ states: [state(10)], errors: [] });
  }

  assert.equal(h.sent.length, 0, 'late reader result did not notify');
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2, 'late reader result not persisted');

  // Post-close ingest is dropped
  await h.notifications.ingest({ states: [state(20)], errors: [] });
  assert.equal(h.sent.length, 0, 'post-close ingest did not notify');
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2, 'post-close ingest not persisted');

  // Queued ingestion dropped by close
  const h2 = harness();
  t.after(() => h2.notifications.close());
  await h2.notifications.subscribe(registration());
  await h2.notifications.poll();
  await h2.notifications.ingest({ states: [state(2)], errors: [] });

  const storeEntered = createDeferred();
  const storeRelease = createDeferred();
  let intercept = true;
  const origUpdate = h2.store.update;
  h2.store.update = async work => {
    if (intercept) {
      intercept = false;
      storeEntered.resolve();
      await storeRelease.promise;
    }
    return origUpdate.call(h2.store, work);
  };

  const p1 = h2.notifications.ingest({ states: [state(3)], errors: [] });
  const p2 = h2.notifications.ingest({ states: [state(4)], errors: [] });

  try {
    await storeEntered.promise;
    const closeP = h2.notifications.close();
    storeRelease.resolve();
    await Promise.all([p1, p2, closeP]);
  } finally {
    storeRelease.resolve();
  }

  assert.notEqual(h2.store.read().mailNotifications.states[0]?.uidNext, 4, 'queued snapshot was dropped on close');
});

test('two accounts: origin account change after store commit before push suppresses stale notification', async t => {
  const h = harness();
  t.after(() => h.notifications.close());

  const folderIdB = `folder:${'b'.repeat(64)}`;
  h.accountMap.set('b', { id: 'b', email: 'ACCOUNT_B@example.test', revision: '1' });
  h.connectedList = [
    { id: 'a', connected: true },
    { id: 'b', connected: true }
  ];

  await h.notifications.subscribe(registration());
  await h.notifications.ingest({
    states: [
      state(2, { accountId: 'a', folderId }),
      state(2, { accountId: 'b', folderId: folderIdB })
    ],
    errors: []
  });
  assert.equal(h.sent.length, 0);

  // Hook store.update so immediately after commit resolves, but before processSnapshot pushes:
  // we change origin account 'a' revision, while unrelated account 'b' remains connected/valid.
  let hookActive = true;
  const origUpdate = h.store.update;
  h.store.update = async work => {
    const res = await origUpdate.call(h.store, work);
    if (hookActive) {
      hookActive = false;
      h.account.revision = '2';
      h.accountMap.get('a').revision = '2';
    }
    return res;
  };

  // Only account 'a' has mail arrival (uidNext 2 -> 3)
  await h.notifications.ingest({
    states: [
      state(3, { accountId: 'a', folderId }),
      state(2, { accountId: 'b', folderId: folderIdB })
    ],
    errors: []
  });

  // Account 'b' is still connected, but account 'a' caused the arrival and changed revision:
  // No push notification should be sent!
  assert.equal(h.sent.length, 0, 'no push sent when origin account changed after store commit');
});

test('multi-device push suppresses second notification if origin account disconnects during first send', async t => {
  const h = harness();
  t.after(() => h.notifications.close());

  const dev1 = registration('https://fcm.googleapis.com/fcm/send/device-1');
  const dev2 = registration('https://fcm.googleapis.com/fcm/send/device-2');
  await h.notifications.subscribe(dev1);
  await h.notifications.subscribe(dev2);
  await h.notifications.ingest({ states: [state(2)], errors: [] });
  assert.equal(h.sent.length, 0);

  const firstSendEntered = createDeferred();
  const firstSendRelease = createDeferred();
  let sendCount = 0;

  h.push.sendNotification = async (...args) => {
    sendCount++;
    h.sent.push(args);
    if (sendCount === 1) {
      firstSendEntered.resolve();
      await firstSendRelease.promise;
    }
  };

  const ingestPromise = h.notifications.ingest({ states: [state(3)], errors: [] });

  try {
    await firstSendEntered.promise;
    assert.equal(h.sent.length, 1, 'first device send was initiated');
    // While first send is awaiting, origin account disconnects
    h.connectedList = [];
  } finally {
    firstSendRelease.resolve();
  }

  await ingestPromise;

  assert.equal(h.sent.length, 1, 'second device push was suppressed after disconnect');
  const [sub, payload, options] = h.sent[0];
  assert.equal(sub.endpoint, dev1.endpoint);
  assert.deepEqual(JSON.parse(payload), { title: 'New mail', body: 'Open MailHarbor to read your new mail.', url: '/#inbox' });
  assert.doesNotMatch(payload, /PRIVATE_|accountId|uidNext/);
  assert.equal(options.TTL, 3600);
});

test('queued account revision and disconnect scopes errors and skips stale/foreign account-specific rows', async t => {
  const h = harness();
  t.after(() => h.notifications.close());
  await h.notifications.subscribe(registration());
  await h.notifications.ingest({ states: [state(2)], errors: [] });
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2);

  const origUpdate = h.store.update;
  let intercept = false;
  let enteredGate = createDeferred();
  let releaseGate = createDeferred();

  h.store.update = async work => {
    if (intercept) {
      intercept = false;
      enteredGate.resolve();
      await releaseGate.promise;
    }
    return origUpdate.call(h.store, work);
  };

  // 1. Revision change during queued error commit:
  // Account-specific error for revised account 'a' must be skipped (not published, not downgraded to anonymous).
  // Generic safe error without accountId must still be kept.
  intercept = true;
  enteredGate = createDeferred();
  releaseGate = createDeferred();

  const ingest1 = h.notifications.ingest({
    states: [],
    errors: [
      { accountId: 'a', code: 'mailbox_error', message: 'PRIVATE_STALE_ERROR', extraField: 123 },
      { code: 'provider_error' }
    ]
  });

  try {
    await enteredGate.promise;
    // While store commit is blocked, revision changes
    h.account.revision = '2';
  } finally {
    releaseGate.resolve();
  }
  await ingest1;

  // Stale error for 'a' is skipped; generic provider_error is preserved
  assert.deepEqual(h.notifications.updates().errors, [{ code: 'provider_error' }]);
  assert.equal(h.store.read().mailNotifications.states[0].uidNext, 2, 'baseline retained');

  // 2. Disconnect during queued error commit:
  // Account-specific error for disconnected account 'a' is skipped.
  intercept = true;
  enteredGate = createDeferred();
  releaseGate = createDeferred();

  const ingest2 = h.notifications.ingest({
    states: [],
    errors: [{ accountId: 'a', code: 'mailbox_error', message: 'PRIVATE_DISCONNECT_ERROR' }]
  });

  try {
    await enteredGate.promise;
    // While store commit is blocked, account disconnects
    h.connectedList = [];
  } finally {
    releaseGate.resolve();
  }
  await ingest2;

  // Disconnected account error skipped, previous generic error cleared
  assert.deepEqual(h.notifications.updates().errors, []);
  assert.equal(h.store.read().mailNotifications.states.length, 0, 'disconnected baseline cleared');
  assert.ok(h.notifications.updates().checkedAt, 'checkedAt updated on valid snapshot');

  // 3. Stale foreign account error is not downgraded to anonymous error
  // Reconnect account 'a'
  h.connectedList = [{ id: 'a', connected: true }];
  h.account.revision = '3';
  await h.notifications.ingest({
    states: [],
    errors: [{ accountId: 'foreign-account-id', code: 'mailbox_error', message: 'FOREIGN' }]
  });

  // Foreign account error was skipped, NOT downgraded to [{ code: 'mailbox_error' }]
  assert.deepEqual(h.notifications.updates().errors, []);
});
