import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposeRecovery, MAX_STORE_RECOVERIES, MAX_RECOVERY_ATTACHMENT_BYTES } from '../server/compose-recovery.mjs';

function memoryStore(initialData = {}) {
  let data = { accounts: [], providers: {}, composeRecoveries: {}, composePreferences: {}, ...initialData };
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(data),
    update: change => {
      const op = queue.then(async () => {
        const next = structuredClone(data);
        const res = await change(next);
        data = next;
        return res;
      });
      queue = op.catch(() => {});
      return op;
    }
  };
}

async function fixture(options = {}) {
  const account = { id: 'acct-1', label: 'Account 1', email: 'user@example.test', revision: 'rev-1', ...options.account };
  const store = options.store || memoryStore({ accounts: [account] });
  await store.update(data => {
    if (!data.accounts?.some(a => a.id === account.id)) {
      data.accounts = [account, ...(data.accounts || [])];
    }
  });
  const accounts = {
    get: id => {
      const found = store.read().accounts?.find(a => a.id === id);
      if (!found) return null;
      return found;
    },
    list: () => store.read().accounts || []
  };
  let currentTime = options.now || 1700000000000;
  const now = () => currentTime;
  const setTime = t => { currentTime = t; };
  const advanceTime = ms => { currentTime += ms; };
  const recovery = createComposeRecovery({ accounts, store, now });
  return { recovery, store, accounts, account, now, setTime, advanceTime };
}

test('save creates recovery at revision 0 and updates matching revision', async () => {
  const { recovery } = await fixture();
  const content = {
    accountId: 'acct-1',
    to: 'recipient@example.test',
    subject: 'Subject 1',
    text: 'Body text 1'
  };

  const created = await recovery.save({ composeId: 'draft-1', revision: 0, content });
  assert.equal(created.saved, true);
  assert.equal(created.composeId, 'draft-1');
  assert.equal(created.revision, 1);

  const read = await recovery.read({ composeId: 'draft-1' });
  assert.equal(read.composeId, 'draft-1');
  assert.equal(read.revision, 1);
  assert.equal(read.content.text, 'Body text 1');

  // Updating with matching revision 1 bumps to 2
  const updated = await recovery.save({
    composeId: 'draft-1',
    revision: 1,
    content: { ...content, text: 'Body text 2' }
  });
  assert.equal(updated.saved, true);
  assert.equal(updated.revision, 2);

  const readUpdated = await recovery.read({ composeId: 'draft-1' });
  assert.equal(readUpdated.revision, 2);
  assert.equal(readUpdated.content.text, 'Body text 2');
});

test('idempotent lost-ack replay preserves revision and timestamp without duplicate or conflict', async () => {
  const { recovery } = await fixture();
  const content = {
    accountId: 'acct-1',
    to: 'recipient@example.test',
    subject: 'Subject 1',
    text: 'Body text 1'
  };

  const first = await recovery.save({ composeId: 'draft-1', revision: 0, content });
  assert.equal(first.revision, 1);

  // Client resends with revision 0 after losing initial ACK
  const replay0 = await recovery.save({ composeId: 'draft-1', revision: 0, content });
  assert.equal(replay0.replayed, true);
  assert.equal(replay0.revision, 1);
  assert.equal(replay0.updatedAt, first.updatedAt);

  // Client sends revision 1 and server updates to revision 2
  const second = await recovery.save({ composeId: 'draft-1', revision: 1, content: { ...content, text: 'Edit 2' } });
  assert.equal(second.revision, 2);

  // Client resends revision 1 after losing second ACK
  const replay1 = await recovery.save({ composeId: 'draft-1', revision: 1, content: { ...content, text: 'Edit 2' } });
  assert.equal(replay1.replayed, true);
  assert.equal(replay1.revision, 2);
  assert.equal(replay1.updatedAt, second.updatedAt);
});

test('concurrent edits with stale revision or different content are rejected', async () => {
  const { recovery } = await fixture();
  const content = { accountId: 'acct-1', to: 'test@example.test', subject: 'Subj', text: 'V1' };

  await recovery.save({ composeId: 'draft-1', revision: 0, content });
  await recovery.save({ composeId: 'draft-1', revision: 1, content: { ...content, text: 'V2' } });

  // Out-of-order save with revision 0 and different content
  await assert.rejects(
    recovery.save({ composeId: 'draft-1', revision: 0, content: { ...content, text: 'Conflicting V0' } }),
    err => err.code === 'stale_message'
  );

  // Mismatched future revision
  await assert.rejects(
    recovery.save({ composeId: 'draft-1', revision: 5, content: { ...content, text: 'V5' } }),
    err => err.code === 'stale_message'
  );
});

test('account isolation rejects cross-account and stale revision access', async () => {
  const { recovery, store } = await fixture();
  const content = { accountId: 'acct-1', subject: 'Isolated', text: 'Private' };
  await recovery.save({ composeId: 'draft-1', revision: 0, content });

  // Modifying account revision in store invalidates access
  await store.update(data => {
    data.accounts[0].revision = 'rev-changed';
  });

  await assert.rejects(recovery.read({ composeId: 'draft-1' }), err => err.code === 'stale_message');
  await assert.rejects(
    recovery.save({ composeId: 'draft-1', revision: 1, content: { ...content, text: 'New text' } }),
    err => err.code === 'stale_message'
  );

  // Non-existent account fails
  await assert.rejects(
    recovery.save({ composeId: 'draft-2', revision: 0, content: { accountId: 'no-such-account', subject: 'X', text: 'Y' } }),
    err => err.code === 'stale_message'
  );
});

test('bounded storage prevents silent content eviction when limit is reached', async () => {
  const { recovery } = await fixture();
  // Fill up to MAX_STORE_RECOVERIES
  for (let i = 0; i < MAX_STORE_RECOVERIES; i++) {
    await recovery.save({
      composeId: `draft-${i}`,
      revision: 0,
      content: { accountId: 'acct-1', subject: `Draft ${i}`, text: `Text ${i}` }
    });
  }

  // Next draft creation must fail with busy, NOT silently evict older drafts
  await assert.rejects(
    recovery.save({
      composeId: 'draft-overflow',
      revision: 0,
      content: { accountId: 'acct-1', subject: 'Overflow', text: 'Overflow' }
    }),
    err => err.code === 'busy'
  );

  // Verify first draft was preserved
  const first = await recovery.read({ composeId: 'draft-0' });
  assert.equal(first.content.subject, 'Draft 0');
});

test('expiry removes old unlocked entries but protects unresolved submitted or uncertain drafts', async () => {
  const { recovery, store, advanceTime } = await fixture();
  await recovery.save({
    composeId: 'unlocked-old',
    revision: 0,
    content: { accountId: 'acct-1', subject: 'Old unlocked', text: 'Expires' }
  });
  await recovery.save({
    composeId: 'locked-submitted',
    revision: 0,
    content: { accountId: 'acct-1', subject: 'Old locked', text: 'Protected' }
  });

  // Durably mark the locked draft as submitted
  await store.update(data => {
    data.composeRecoveries['locked-submitted'].locked = true;
    data.composeRecoveries['locked-submitted'].state = 'submitted';
    data.composeRecoveries['locked-submitted'].requestId = 'req_12345678901234567890';
  });

  // Advance time beyond 14 days (15 days)
  advanceTime(15 * 86400000);

  // Saving another draft triggers cleanup
  await recovery.save({
    composeId: 'new-draft',
    revision: 0,
    content: { accountId: 'acct-1', subject: 'New', text: 'New' }
  });

  // Unlocked old draft is expired
  await assert.rejects(recovery.read({ composeId: 'unlocked-old' }), err => err.code === 'invalid_request');

  // Submitted draft remains protected
  const protectedDraft = await recovery.read({ composeId: 'locked-submitted' });
  assert.equal(protectedDraft.locked, true);
  assert.equal(protectedDraft.state, 'submitted');
});

test('attached-content persistence survives service recreation', async () => {
  const { store, accounts } = await fixture();
  const firstInstance = createComposeRecovery({ accounts, store });
  const sampleBase64 = Buffer.from('Binary attachment content for draft recovery').toString('base64');
  const content = {
    accountId: 'acct-1',
    subject: 'Attached draft',
    text: 'See attached',
    attachments: [{ filename: 'test.bin', mimeType: 'application/octet-stream', content: sampleBase64 }]
  };

  await firstInstance.save({ composeId: 'with-attachment', revision: 0, content });

  // Recreate service instance with the same store
  const recreatedInstance = createComposeRecovery({ accounts, store });
  const read = await recreatedInstance.read({ composeId: 'with-attachment' });
  assert.equal(read.content.subject, 'Attached draft');
  assert.equal(read.content.attachments.length, 1);
  assert.equal(read.content.attachments[0].filename, 'test.bin');
  assert.equal(read.content.attachments[0].content, sampleBase64);
  assert.equal(Buffer.from(read.content.attachments[0].content, 'base64').toString('utf8'), 'Binary attachment content for draft recovery');
});

test('discard removes unlocked draft and preserves send ledger for locked draft', async () => {
  const { recovery, store } = await fixture();
  await recovery.save({
    composeId: 'to-discard',
    revision: 0,
    content: { accountId: 'acct-1', subject: 'Discard me', text: 'Gone' }
  });

  const disc = await recovery.discard({ composeId: 'to-discard', revision: 1 });
  assert.equal(disc.discarded, true);
  await assert.rejects(recovery.read({ composeId: 'to-discard' }), err => err.code === 'invalid_request');

  // Locked draft discard clears recovery view while preserving sendRequests
  await recovery.save({
    composeId: 'locked-draft',
    revision: 0,
    content: { accountId: 'acct-1', subject: 'Locked', text: 'Text' }
  });
  await store.update(data => {
    data.composeRecoveries['locked-draft'].locked = true;
    data.sendRequests = { req_sent_id: { state: 'sent', digest: 'abc', accountId: 'acct-1' } };
  });

  await recovery.discard({ composeId: 'locked-draft', revision: 1 });
  assert.equal(store.read().composeRecoveries['locked-draft'], undefined);
  assert.equal(store.read().sendRequests['req_sent_id'].state, 'sent');
});

test('per-account signatures support read, update, clear, and character boundaries', async () => {
  const { recovery } = await fixture();

  // Initially empty
  const initial = await recovery.preferences({ accountId: 'acct-1' });
  assert.equal(initial.signature, '');

  // Set signature
  await recovery.configurePreferences({ accountId: 'acct-1', signature: 'Best regards,\nUser' });
  const updated = await recovery.preferences({ accountId: 'acct-1' });
  assert.equal(updated.signature, 'Best regards,\nUser');

  // Clear signature
  await recovery.configurePreferences({ accountId: 'acct-1', signature: '' });
  const cleared = await recovery.preferences({ accountId: 'acct-1' });
  assert.equal(cleared.signature, '');

  // Oversized signature > 10k is rejected
  await assert.rejects(
    recovery.configurePreferences({ accountId: 'acct-1', signature: 'a'.repeat(10001) }),
    err => err.code === 'invalid_request'
  );

  // Illegal control characters rejected
  await assert.rejects(
    recovery.configurePreferences({ accountId: 'acct-1', signature: 'Signature\u0000illegal' }),
    err => err.code === 'invalid_request'
  );
});

test('strict account scope allows changing From on unlocked local recovery without providerDraftId', async () => {
  const { store, recovery } = await fixture();
  const acct2 = { id: 'acct-2', label: 'Account 2', email: 'user2@example.test', revision: 'rev-2' };
  await store.update(data => { data.accounts.push(acct2); });

  const content1 = { accountId: 'acct-1', to: 'someone@example.test', subject: 'Switch test', text: 'Hello' };
  await recovery.save({ composeId: 'switchable', revision: 0, content: content1 });

  // Switching From to acct-2 succeeds on unlocked local draft
  const switched = await recovery.save({
    composeId: 'switchable',
    revision: 1,
    content: { ...content1, accountId: 'acct-2' }
  });
  assert.equal(switched.saved, true);
  assert.equal(switched.revision, 2);

  const readSwitched = await recovery.read({ composeId: 'switchable' });
  assert.equal(readSwitched.accountId, 'acct-2');

  // If draft has providerDraftId, account switch is rejected
  await store.update(data => {
    data.composeRecoveries['switchable'].content.providerDraftId = 'remote-draft-123';
  });
  await assert.rejects(
    recovery.save({
      composeId: 'switchable',
      revision: 2,
      content: { ...content1, accountId: 'acct-1', providerDraftId: 'remote-draft-123' }
    }),
    err => err.code === 'invalid_request'
  );

  // If old account revision changed in store, switch attempt fails stale_message
  await store.update(data => {
    delete data.composeRecoveries['switchable'].content.providerDraftId;
    data.accounts.find(a => a.id === 'acct-2').revision = 'rev-2-bumped';
  });
  await assert.rejects(
    recovery.save({
      composeId: 'switchable',
      revision: 2,
      content: { ...content1, accountId: 'acct-1' }
    }),
    err => err.code === 'stale_message'
  );
});

test('strict account scope omits inaccessible accounts from list and fails read and discard', async () => {
  const { store, recovery } = await fixture();
  const acct2 = { id: 'acct-2', label: 'Account 2', email: 'user2@example.test', revision: 'rev-2' };
  await store.update(data => { data.accounts.push(acct2); });

  await recovery.save({ composeId: 'draft-acct1', revision: 0, content: { accountId: 'acct-1', subject: 'A1', text: 'T1' } });
  await recovery.save({ composeId: 'draft-acct2', revision: 0, content: { accountId: 'acct-2', subject: 'A2', text: 'T2' } });

  const listBefore = await recovery.list();
  assert.equal(listBefore.drafts.length, 2);

  // Invalidate acct-2 revision
  await store.update(data => {
    data.accounts.find(a => a.id === 'acct-2').revision = 'rev-2-disconnected';
  });

  // list() must omit the inaccessible draft
  const listAfter = await recovery.list();
  assert.equal(listAfter.drafts.length, 1);
  assert.equal(listAfter.drafts[0].composeId, 'draft-acct1');

  // read() on inaccessible draft must fail stale_message
  await assert.rejects(recovery.read({ composeId: 'draft-acct2' }), err => err.code === 'stale_message');

  // discard() on inaccessible draft must also fail stale_message
  await assert.rejects(recovery.discard({ composeId: 'draft-acct2', revision: 1 }), err => err.code === 'stale_message');
});

test('per-account preferences recheck account revision inside store.update and isolate on reconnect', async () => {
  const { store, recovery } = await fixture();

  // Reject non-string signature
  await assert.rejects(
    recovery.configurePreferences({ accountId: 'acct-1', signature: { text: 'object signature' } }),
    err => err.code === 'invalid_request'
  );
  await assert.rejects(
    recovery.configurePreferences({ accountId: 'acct-1', signature: 12345 }),
    err => err.code === 'invalid_request'
  );
  await assert.rejects(
    recovery.configurePreferences({ accountId: 'acct-1', signature: 'Sig', extra: true }),
    err => err.code === 'invalid_request'
  );

  const configured = await recovery.configurePreferences({ accountId: 'acct-1', signature: 'My Sig' });
  assert.equal(configured.signature, 'My Sig');
  assert.equal(configured.accountRevision, 'rev-1');

  const pref = await recovery.preferences({ accountId: 'acct-1' });
  assert.equal(pref.signature, 'My Sig');
  assert.equal(pref.accountRevision, 'rev-1');

  // Reconnect account with new revision
  await store.update(data => {
    data.accounts[0].revision = 'rev-1-reconnected';
  });

  // Old signature is NOT resurrected after reconnect
  const afterReconnect = await recovery.preferences({ accountId: 'acct-1' });
  assert.equal(afterReconnect.signature, '');
  assert.equal(afterReconnect.accountRevision, 'rev-1-reconnected');
});

test('canonical base64 enforcement and store byte cap using Buffer.byteLength', async () => {
  const { recovery } = await fixture();

  // Non-canonical base64 (e.g. invalid padding or illegal chars) is rejected
  await assert.rejects(
    recovery.save({
      composeId: 'bad-b64',
      revision: 0,
      content: {
        accountId: 'acct-1',
        subject: 'Bad b64',
        text: 'Text',
        attachments: [{ filename: 'test.bin', mimeType: 'application/octet-stream', content: 'a===' }]
      }
    }),
    err => err.code === 'invalid_request'
  );

  // Attachment exceeding max bytes rejected
  const oversizedB64 = Buffer.alloc(MAX_RECOVERY_ATTACHMENT_BYTES + 10).toString('base64');
  await assert.rejects(
    recovery.save({
      composeId: 'huge-att',
      revision: 0,
      content: {
        accountId: 'acct-1',
        subject: 'Huge',
        text: 'Text',
        attachments: [{ filename: 'huge.bin', mimeType: 'application/octet-stream', content: oversizedB64 }]
      }
    }),
    err => err.code === 'attachment_too_large' || err.code === 'invalid_request'
  );
});

test('markSubmitted, markComplete and markFailed isolate requests and protect unrelated state', async () => {
  const { store, recovery } = await fixture();
  const content = { accountId: 'acct-1', to: 'test@example.test', subject: 'Lifecycle', text: 'Text' };
  await recovery.save({ composeId: 'rec-life', revision: 0, content });

  const data = store.read();
  // markSubmitted validates revision and locks with requestId
  recovery.markSubmitted({
    composeId: 'rec-life',
    requestId: 'req-1',
    accountId: 'acct-1',
    recoveryRevision: 1,
    data
  });
  assert.equal(data.composeRecoveries['rec-life'].locked, true);
  assert.equal(data.composeRecoveries['rec-life'].requestId, 'req-1');

  // Distinct concurrent requestId on same recovery is rejected
  assert.throws(
    () => recovery.markSubmitted({
      composeId: 'rec-life',
      requestId: 'req-2',
      accountId: 'acct-1',
      recoveryRevision: 1,
      data
    }),
    err => err.code === 'send_uncertain'
  );

  // markComplete with mismatched requestId cannot touch record
  recovery.markComplete({
    composeId: 'rec-life',
    requestId: 'unrelated-req',
    accountId: 'acct-1',
    result: { sent: true },
    data
  });
  assert.ok(data.composeRecoveries['rec-life']); // Record was not deleted

  // markFailed with mismatched requestId cannot clear locked state
  recovery.markFailed({
    composeId: 'rec-life',
    requestId: 'unrelated-req',
    accountId: 'acct-1',
    code: 'smtp_error',
    definitelyRejected: true,
    data
  });
  assert.equal(data.composeRecoveries['rec-life'].locked, true);

  // Matching markComplete deletes recovery
  recovery.markComplete({
    composeId: 'rec-life',
    requestId: 'req-1',
    accountId: 'acct-1',
    result: { sent: true },
    data
  });
  assert.equal(data.composeRecoveries['rec-life'], undefined);
});

test('reconnect during queued new save is rejected with stale_message and leaves no record', async () => {
  const { recovery, store } = await fixture();
  const content = { accountId: 'acct-1', to: 'recipient@example.test', subject: 'Queued test', text: 'Text' };

  let unblock;
  const block = new Promise(resolve => { unblock = resolve; });

  // Block the store queue with a pending operation
  const blockingOp = store.update(async () => {
    await block;
  });

  // Queue an account revision update right after the blocking op
  const bumpPromise = store.update(async data => {
    data.accounts[0].revision = 'rev-1-reconnected-during-save';
  });

  // While queue is blocked, start recovery.save (preflight captures initial revision rev-1)
  const savePromise = recovery.save({ composeId: 'queued-new', revision: 0, content });

  const assertion = assert.rejects(savePromise, err => err.code === 'stale_message');

  // Unblock queue so operations process sequentially
  unblock();
  await blockingOp;
  await bumpPromise;
  await assertion;

  // Verify no record was created in the store
  assert.equal(store.read().composeRecoveries?.['queued-new'], undefined);
});

test('removed account is not resurrected by fallback and unknown account fails stale_message consistently', async () => {
  const { recovery, store } = await fixture();
  const content = { accountId: 'acct-1', subject: 'Subj', text: 'Body' };
  await recovery.save({ composeId: 'rec-acct-test', revision: 0, content });

  // Remove account completely from store data.accounts
  await store.update(data => {
    data.accounts = [];
  });

  // read fails stale_message
  await assert.rejects(recovery.read({ composeId: 'rec-acct-test' }), err => err.code === 'stale_message');

  // save fails stale_message
  await assert.rejects(
    recovery.save({ composeId: 'rec-acct-test', revision: 1, content }),
    err => err.code === 'stale_message'
  );

  // discard fails stale_message
  await assert.rejects(
    recovery.discard({ composeId: 'rec-acct-test', revision: 1 }),
    err => err.code === 'stale_message'
  );

  // configurePreferences fails stale_message
  await assert.rejects(
    recovery.configurePreferences({ accountId: 'acct-1', signature: 'Sig' }),
    err => err.code === 'stale_message'
  );

  // preferences on unknown account fails stale_message
  await assert.rejects(
    recovery.preferences({ accountId: 'acct-1' }),
    err => err.code === 'stale_message'
  );

  // list() omits the draft
  const listRes = await recovery.list();
  assert.equal(listRes.drafts.length, 0);
});

test('discard is disallowed with busy while state is saving or submitted, allowed after terminal state', async () => {
  const { recovery, store } = await fixture();
  const content = { accountId: 'acct-1', subject: 'Discard state test', text: 'Body' };
  await recovery.save({ composeId: 'state-disc', revision: 0, content });

  // Set state to saving
  await store.update(data => {
    data.composeRecoveries['state-disc'].locked = true;
    data.composeRecoveries['state-disc'].state = 'saving';
  });
  await assert.rejects(
    recovery.discard({ composeId: 'state-disc', revision: 1 }),
    err => err.code === 'busy'
  );

  // Set state to submitted
  await store.update(data => {
    data.composeRecoveries['state-disc'].state = 'submitted';
  });
  await assert.rejects(
    recovery.discard({ composeId: 'state-disc', revision: 1 }),
    err => err.code === 'busy'
  );

  // Set state to terminal uncertain
  await store.update(data => {
    data.composeRecoveries['state-disc'].state = 'uncertain';
    data.sendRequests = { req_test: { state: 'uncertain', digest: 'abc', accountId: 'acct-1' } };
  });
  const discUncertain = await recovery.discard({ composeId: 'state-disc', revision: 1 });
  assert.equal(discUncertain.discarded, true);
  assert.equal(store.read().composeRecoveries['state-disc'], undefined);
  assert.equal(store.read().sendRequests['req_test'].state, 'uncertain');

  // Re-save and test partial terminal state
  await recovery.save({ composeId: 'state-partial', revision: 0, content });
  await store.update(data => {
    data.composeRecoveries['state-partial'].locked = true;
    data.composeRecoveries['state-partial'].state = 'partial';
  });
  const discPartial = await recovery.discard({ composeId: 'state-partial', revision: 1 });
  assert.equal(discPartial.discarded, true);
  assert.equal(store.read().composeRecoveries['state-partial'], undefined);
});

test('reserved IDs (__proto__, prototype, constructor) are rejected invalid_request and do not pollute Object.prototype', async () => {
  const { recovery } = await fixture();
  const reserved = ['__proto__', 'prototype', 'constructor'];

  for (const reservedId of reserved) {
    await assert.rejects(
      recovery.read({ composeId: reservedId }),
      err => err.code === 'invalid_request'
    );
    await assert.rejects(
      recovery.save({ composeId: reservedId, revision: 0, content: { accountId: 'acct-1', text: 'Hi' } }),
      err => err.code === 'invalid_request'
    );
    await assert.rejects(
      recovery.discard({ composeId: reservedId, revision: 1 }),
      err => err.code === 'invalid_request'
    );
    await assert.rejects(
      recovery.save({ composeId: 'draft-valid', revision: 0, content: { accountId: reservedId, text: 'Hi' } }),
      err => err.code === 'invalid_request'
    );
    await assert.rejects(
      recovery.save({ composeId: 'draft-valid', revision: 0, content: { accountId: 'acct-1', providerDraftId: reservedId, text: 'Hi' } }),
      err => err.code === 'invalid_request'
    );
    await assert.rejects(
      recovery.preferences({ accountId: reservedId }),
      err => err.code === 'invalid_request'
    );
    await assert.rejects(
      recovery.configurePreferences({ accountId: reservedId, signature: 'Sig' }),
      err => err.code === 'invalid_request'
    );
  }

  assert.equal(Object.prototype.digest, undefined);
  assert.equal(Object.prototype.locked, undefined);
  assert.equal(Object.prototype.revision, undefined);
  assert.equal(Object.prototype.state, undefined);
});
