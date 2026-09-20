import test from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { createMailComposer } from '../server/mail-compose.mjs';
import { mailFingerprint } from '../server/mailboxes.mjs';

const original = Buffer.from('From: Author <author@example.test>\r\nReply-To: Replies <reply@example.test>\r\nTo: Sender <sender@example.test>, peer@example.test\r\nCc: other@example.test\r\nBcc: hidden@example.test\r\nSubject: Hello\r\nMessage-ID: <original@example.test>\r\nReferences: <parent@example.test>\r\nDate: Fri, 18 Sep 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal body\r\n');
function memoryStore() {
  let data = { accounts: [], providers: {} }, queue = Promise.resolve();
  return { read: () => structuredClone(data), update(change) { const operation = queue.then(async () => { const next = structuredClone(data); const result = await change(next); data = next; return result; }); queue = operation.catch(() => {}); return operation; } };
}
async function fixture(options = {}) {
  const store = options.store || memoryStore();
  const account = { id: 'fixture', label: 'Fixture', email: 'sender@example.test', host: 'imap.example.test', provider: 'imap', revision: 'revision',
    auth: { type: 'password', password: 'PRIVATE_PASSWORD' }, ...options.account };
  await store.update(data => { data.accounts = [account]; });
  const accounts = { get: id => { const item = store.read().accounts.find(value => value.id === id); if (!item) throw { code: 'mailbox_login_required' }; return item; },
    list: () => store.read().accounts.map(value => ({ ...value, connected: true })), connectionOptions: async () => {
      if (options.connectionOptionsHook) await options.connectionOptionsHook();
      return { host: account.host, auth: { pass: account.auth.password, accessToken: 'TEST_ACCESS' } };
    } };
  const calls = [], transports = [], messages = new Map();
  const message = { uid: 10, flags: new Set(['\\Draft']), size: original.length, source: original,
    envelope: { messageId: '<original@example.test>', subject: 'Hello', from: [{ address: 'author@example.test' }], date: '2026-09-18T10:00:00Z' }, internalDate: '2026-09-18T10:00:00Z' };
  messages.set(10, message);
  const reference = { accountId: account.id, path: 'Drafts', uid: 10, uidValidity: '123', fingerprint: mailFingerprint(message) };
  const createClient = () => {
    const client = { capabilities: new Set(options.noUidPlus ? [] : ['UIDPLUS']), mailbox: { path: 'Drafts', uidValidity: 123n }, on() {}, close() { calls.push(['close']); }, async connect() {},
      async list() { return [{ path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Sent', specialUse: '\\Sent' }]; },
      async getMailboxLock(path, options) { calls.push(['lock', path, options]); client.mailbox.path = path; return { release() {} }; },
      async fetchOne(uid, query, options) { calls.push(['fetch', uid, query, options]); return messages.get(Number(uid)); },
      async append(path, raw, flags) {
        calls.push(['append', path, raw, flags]);
        if (options.appendHook) await options.appendHook();
        if (options.appendFails) throw new Error('PRIVATE provider message');
        const parsed = await simpleParser(raw), uid = messages.size + 100;
        messages.set(uid, { uid, flags: new Set(flags), size: raw.length, source: raw,
          envelope: { messageId: parsed.messageId, subject: parsed.subject, from: parsed.from?.value }, internalDate: new Date().toISOString() });
        return { uid, uidValidity: 123n };
      },
      async messageDelete(uid, options) { calls.push(['delete', uid, options]); if (options?.uid !== true) throw new Error('UID required'); if (options.deleteFails) return false; messages.delete(Number(uid)); return !options.deleteFails; }
    };
    if (options.deleteFails) client.messageDelete = async (uid, options) => { calls.push(['delete', uid, options]); return false; };
    return client;
  };
  const createTransport = settings => {
    transports.push(settings);
    return { async sendMail(value) { calls.push(['smtp', value]); if (options.smtpError) throw options.smtpError; return options.smtpResult || { accepted: value.envelope.to, rejected: [] }; },
      async verify() { calls.push(['verify']); if (options.verifyError) throw options.verifyError; return true; }, close() { calls.push(['smtpClose']); } };
  };
  const composer = createMailComposer({ accounts, store, resolveMessage: async () => ({ account: accounts.get(account.id), reference }),
    invalidateMessage: id => calls.push(['invalidate', id]), createTransport, createClient });
  return { composer, store, calls, transports, messages, reference, account, accounts, createClient, createTransport };
}
const payload = values => ({ accountId: 'fixture', to: 'Recipient <recipient@example.test>', cc: '', bcc: '', subject: 'Test subject', text: 'A test message',
  attachments: [], requestId: 'request_12345678901234567890', ...values });

test('SMTP uses fixed account identity, verified TLS, explicit envelope, MIME attachments, hidden Bcc and provider Sent copy', async () => {
  const { composer, calls, transports } = await fixture();
  const result = await composer.send(payload({ bcc: 'hidden@example.test', attachments: [{ filename: 'sample.bin', mimeType: 'application/octet-stream', content: 'AAECAw==' }] }));
  assert.equal(result.sent, true); assert.equal(result.status, 'sent');
  const settings = transports[0];
  assert.equal(settings.host, 'imap.example.test'); assert.equal(settings.port, 587); assert.equal(settings.requireTLS, true);
  assert.equal(settings.tls.rejectUnauthorized, true); assert.equal(settings.auth.user, 'sender@example.test');
  const sent = calls.find(call => call[0] === 'smtp')[1];
  assert.deepEqual(sent.envelope, { from: 'sender@example.test', to: ['recipient@example.test', 'hidden@example.test'] });
  const parsed = await simpleParser(sent.raw); assert.equal(parsed.from.value[0].address, 'sender@example.test'); assert.equal(parsed.bcc, undefined);
  assert.deepEqual(parsed.attachments[0].content, Buffer.from([0, 1, 2, 3]));
  const copy = calls.find(call => call[0] === 'append'); assert.equal(copy[1], 'Sent');
  assert.equal((await simpleParser(copy[2])).bcc.value[0].address, 'hidden@example.test'); composer.close();
});

test('provider-managed Sent copies are not appended for Gmail and Outlook', async () => {
  for (const provider of ['google', 'microsoft']) {
    const { composer, calls, transports } = await fixture({ account: { provider, auth: { type: 'oauth', oauthScope: 'https://outlook.office.com/SMTP.Send' } } });
    await composer.send(payload()); assert.equal(calls.filter(call => call[0] === 'append').length, 0);
    assert.equal(transports[0].auth.type, 'OAuth2'); assert.equal(transports[0].host, provider === 'google' ? 'smtp.gmail.com' : 'smtp-mail.outlook.com'); composer.close();
  }
});

test('durable send ledger deduplicates after recreation and rejects changed content with reused request ID', async () => {
  const fixtureValue = await fixture(), { composer, calls, store, accounts, createClient, createTransport } = fixtureValue;
  const first = await composer.send(payload()); const replay = await composer.send(payload()); assert.equal(replay.replayed, true); assert.equal(replay.messageId, first.messageId);
  await assert.rejects(composer.send(payload({ text: 'Changed' })), error => error.code === 'invalid_request'); composer.close();
  const recreated = createMailComposer({ store, accounts, createClient, createTransport });
  assert.equal((await recreated.send(payload())).replayed, true); assert.equal(calls.filter(call => call[0] === 'smtp').length, 1); recreated.close();
});

test('ambiguous SMTP outcome stays blocked across retries and exposes no provider secrets', async () => {
  const { composer, calls, store } = await fixture({ smtpError: Object.assign(new Error('PRIVATE_TOKEN'), { code: 'ETIMEDOUT' }) });
  for (let i = 0; i < 2; i++) await assert.rejects(composer.send(payload()), error => error.code === 'send_uncertain' && !String(error).includes('PRIVATE_TOKEN'));
  assert.equal(calls.filter(call => call[0] === 'smtp').length, 1); assert.equal(store.read().sendRequests[payload().requestId].state, 'uncertain'); composer.close();
});

test('SMTP rejections are definite, authentication has clear diagnostic, partial recipients never auto-retry', async () => {
  for (const [smtpError, code] of [[{ code: 'EAUTH' }, 'smtp_login_required'], [{ responseCode: 550, code: 'EMESSAGE' }, 'smtp_error']]) {
    const { composer, calls } = await fixture({ smtpError }); await assert.rejects(composer.send(payload()), error => error.code === code);
    await assert.rejects(composer.send(payload()), error => error.code === code); assert.equal(calls.filter(call => call[0] === 'smtp').length, 1); composer.close();
  }
  const { composer, calls } = await fixture({ smtpResult: { accepted: ['recipient@example.test'], rejected: ['other@example.test'] } });
  const result = await composer.send(payload({ cc: 'other@example.test' })); assert.equal(result.status, 'partial'); assert.equal(result.warning, 'send_partial'); assert.deepEqual(result.rejected, ['other@example.test']);
  await composer.send(payload({ cc: 'other@example.test' })); assert.equal(calls.filter(call => call[0] === 'smtp').length, 1); composer.close();
});

test('sender spoofing, CRLF injection, remote attachments and unbounded metadata fail before SMTP', async () => {
  const { composer, calls } = await fixture();
  for (const change of [{ from: 'attacker@example.test' }, { to: 'recipient@example.test\r\nBcc: attacker@example.test' }, { subject: 'Subject\r\nX-Evil: yes' },
    { references: '<parent@example.test>\r\nBcc: other@example.test' }, { inReplyTo: '<id>' }, { text: 'x'.repeat(200001) },
    { attachments: [{ filename: 'file.txt', mimeType: 'text/plain', content: 'a===', path: 'C:/secrets' }] }]) {
    await assert.rejects(composer.send(payload(change)), error => error.code === 'invalid_request');
  }
  assert.equal(calls.length, 0); composer.close();
});

test('new drafts append Draft flag and replacing drafts targets only verified UID with UIDPLUS', async () => {
  const { composer, calls, messages } = await fixture();
  const saved = await composer.save(payload({ requestId: undefined, bcc: 'hidden@example.test' })); assert.equal(saved.saved, true);
  const append = calls.find(call => call[0] === 'append'); assert.equal(append[1], 'Drafts'); assert.deepEqual(append[3], ['\\Draft']);
  assert.equal((await simpleParser(append[2])).bcc.value[0].address, 'hidden@example.test');
  const edited = await composer.save(payload({ draftId: saved.draftId })); assert.notEqual(edited.draftId, saved.draftId);
  const deleted = calls.find(call => call[0] === 'delete'); assert.deepEqual(deleted.slice(1), ['101', { uid: true }]);
  assert.equal(messages.has(10), true, 'unrelated draft remains'); composer.close();
});

test('draft replacement refuses missing UIDPLUS, stale fingerprints and non-draft messages before appending', async () => {
  for (const kind of ['capability', 'fingerprint', 'flag']) {
    const { composer, calls, messages } = await fixture({ noUidPlus: kind === 'capability' });
    if (kind === 'fingerprint') messages.get(10).envelope.subject = 'Modified';
    if (kind === 'flag') messages.get(10).flags = new Set();
    await assert.rejects(composer.save(payload({ draftId: 'original' })), error => ['draft_unavailable', 'stale_message'].includes(error.code));
    assert.equal(calls.filter(call => ['delete', 'append'].includes(call[0])).length, 0); composer.close();
  }
});

test('draft append acknowledgement failure is ambiguous and cleanup failure reports saved new draft honestly', async () => {
  const failed = await fixture({ appendFails: true }); await assert.rejects(failed.composer.save(payload()), error => error.code === 'draft_partial'); failed.composer.close();
  const partial = await fixture({ deleteFails: true }); const result = await partial.composer.save(payload({ draftId: 'original' }));
  assert.equal(result.saved, true); assert.equal(result.warning, 'draft_cleanup_failed'); assert.equal(partial.messages.has(10), true); partial.composer.close();
});

test('reply, reply-all, forward and draft edit preserve expected recipients without leaking original Bcc', async () => {
  const { composer } = await fixture();
  const reply = await composer.context({ id: 'original', mode: 'reply' }); assert.match(reply.to, /reply@example.test/); assert.equal(reply.cc, ''); assert.equal(reply.bcc, '');
  assert.equal(reply.inReplyTo, '<original@example.test>'); assert.equal(reply.references, '<parent@example.test> <original@example.test>'); assert.match(reply.text, /> Original body/);
  const all = await composer.context({ id: 'original', mode: 'reply_all' }); assert.match(all.cc, /peer@example.test/); assert.match(all.cc, /other@example.test/); assert.doesNotMatch(all.cc, /sender@example.test/);
  const forward = await composer.context({ id: 'original', mode: 'forward' }); assert.equal(forward.to, ''); assert.equal(forward.inReplyTo, ''); assert.match(forward.subject, /^Fwd:/);
  const edit = await composer.context({ id: 'original', mode: 'edit' }); assert.equal(edit.draftId, 'original'); assert.match(edit.bcc, /hidden@example.test/); assert.match(edit.text, /Original body/); composer.close();
});

test('replying to own sent message addresses original recipients and deduplicates reply-all Cc', async () => {
  const { composer, messages, reference } = await fixture();
  const message = messages.get(10);
  message.source = Buffer.from(original.toString('utf8').replace('From: Author <author@example.test>', 'From: Sender <sender@example.test>')
    .replace('Reply-To: Replies <reply@example.test>', 'Reply-To: Sender <sender@example.test>'));
  message.size = message.source.length; message.envelope.from = [{ address: 'sender@example.test' }]; reference.fingerprint = mailFingerprint(message);
  const reply = await composer.context({ id: 'original', mode: 'reply' }); assert.equal(reply.to, 'peer@example.test'); assert.equal(reply.cc, '');
  const all = await composer.context({ id: 'original', mode: 'reply_all' }); assert.equal(all.to, 'peer@example.test'); assert.equal(all.cc, 'other@example.test'); assert.equal(all.bcc, '');
  composer.close();
});

test('sent-copy failure does not lose acceptance or permit duplicate sends', async () => {
  const { composer, calls } = await fixture({ appendFails: true }); const result = await composer.send(payload());
  assert.equal(result.sent, true); assert.equal(result.warning, 'sent_copy_failed'); await composer.send(payload());
  assert.equal(calls.filter(call => call[0] === 'smtp').length, 1); composer.close();
});

test('SMTP configuration validates hosts and never exposes passwords; connection test sends no email', async () => {
  const { composer, transports, calls } = await fixture();
  await assert.rejects(composer.configure({ accountId: 'fixture', host: '127.0.0.1', port: 587, sentCopy: true }), error => error.code === 'invalid_request');
  await composer.configure({ accountId: 'fixture', host: 'smtp.example.test', port: 465, sentCopy: true, username: 'smtp-user', password: 'SMTP_SECRET', useMailboxPassword: false });
  assert.ok(!JSON.stringify(composer.settings()).includes('SMTP_SECRET')); assert.ok(!JSON.stringify(composer.settings()).includes('PRIVATE_PASSWORD'));
  await composer.verify({ accountId: 'fixture' }); assert.equal(transports[0].auth.pass, 'SMTP_SECRET'); assert.equal(transports[0].auth.user, 'smtp-user'); assert.equal(transports[0].host, 'smtp.example.test'); assert.equal(transports[0].secure, true); assert.equal(calls.filter(call => call[0] === 'smtp').length, 0); composer.close();
});

test('existing Microsoft IMAP-only grant requires explicit reconnect for SMTP without token refresh scope escalation', async () => {
  const { composer, transports } = await fixture({ account: { provider: 'microsoft', auth: { type: 'oauth' } } });
  assert.equal(composer.settings().accounts[0].needsReconnect, true);
  await assert.rejects(composer.send(payload()), error => error.code === 'smtp_login_required'); assert.equal(transports.length, 0); composer.close();
});

test('rich text sanitizes dangerous HTML, builds multipart alternative with plain text, and enforces safe links', async () => {
  const { composer, calls } = await fixture();
  const dangerousHtml = '<p>Hello <b>World</b><script>alert(1)</script><img src="http://evil.com/leak.jpg"><a href="http://example.com" onclick="steal()">Click here</a></p>';
  const result = await composer.send(payload({
    text: 'Hello World Click here',
    html: dangerousHtml
  }));
  assert.equal(result.sent, true);
  const sent = calls.find(call => call[0] === 'smtp')[1];
  const parsed = await simpleParser(sent.raw);
  assert.equal(parsed.text.trim(), 'Hello World Click here');
  assert.ok(parsed.html);
  assert.doesNotMatch(parsed.html, /<script|alert\(1\)|steal\(\)|evil\.com|<img/);
  assert.match(parsed.html, /<b>World<\/b>/);
  assert.match(parsed.html, /<a href="http:\/\/example\.com" target="_blank" rel="noopener noreferrer">Click here<\/a>/);
  composer.close();
});

test('persisted provider draftId survives service recreation and allows UIDPLUS replacement', async () => {
  const { composer, store, accounts, createClient, createTransport, calls } = await fixture();
  const saved = await composer.save(payload({ requestId: undefined }));
  assert.equal(saved.saved, true);
  const draftId = saved.draftId;
  composer.close();

  // Recreate composer from store
  const recreated = createMailComposer({ accounts, store, createClient, createTransport });
  const replaced = await recreated.save(payload({ draftId, text: 'Replaced content' }));
  assert.equal(replaced.saved, true);
  assert.notEqual(replaced.draftId, draftId);
  const deleteCalls = calls.filter(call => call[0] === 'delete');
  assert.ok(deleteCalls.length >= 1);
  recreated.close();
});

test('send integration with recovery validates content, locks during submission, and deletes on success', async () => {
  const { composer, store } = await fixture();
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: '',
    bcc: '',
    subject: 'Test subject',
    text: 'A test message',
    attachments: []
  };
  const savedRec = await composer.recovery.save({ composeId: 'rec-test', revision: 0, content });
  assert.equal(savedRec.revision, 1);

  // Rejects silently changed content without saving
  await assert.rejects(
    composer.send(payload({ composeId: 'rec-test', recoveryRevision: 1, text: 'Modified without saving' })),
    err => err.code === 'invalid_request'
  );

  // Send with exact matching recovery
  const result = await composer.send(payload({ composeId: 'rec-test', recoveryRevision: 1 }));
  assert.equal(result.sent, true);

  // Successfully sent recovery is removed from active recoveries, while sendRequests ledger is preserved
  assert.equal(store.read().composeRecoveries['rec-test'], undefined);
  assert.equal(store.read().sendRequests[payload().requestId].state, 'sent');
  composer.close();
});

test('uncertain SMTP outcome locks recovery across service recreation', async () => {
  const { composer, store, accounts, createClient, createTransport } = await fixture({
    smtpError: Object.assign(new Error('NETWORK_TIMEOUT'), { code: 'ETIMEDOUT' })
  });
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: '',
    bcc: '',
    subject: 'Test subject',
    text: 'A test message',
    attachments: []
  };
  await composer.recovery.save({ composeId: 'rec-uncertain', revision: 0, content });

  await assert.rejects(composer.send(payload({ composeId: 'rec-uncertain', recoveryRevision: 1 })), err => err.code === 'send_uncertain');
  composer.close();

  // Recreate composer and check recovery status
  const recreated = createMailComposer({ accounts, store, createClient, createTransport });
  const rec = await recreated.recovery.read({ composeId: 'rec-uncertain' });
  assert.equal(rec.locked, true);
  assert.equal(rec.state, 'uncertain');

  // Attempting to save over a locked recovery is rejected
  await assert.rejects(
    recreated.recovery.save({ composeId: 'rec-uncertain', revision: 1, content: { ...content, text: 'Edit' } }),
    err => err.code === 'stale_message'
  );
  recreated.close();
});

test('definite pre-submit SMTP rejection safely unlocks recovery', async () => {
  const { composer } = await fixture({ smtpError: { code: 'EAUTH' } });
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: '',
    bcc: '',
    subject: 'Test subject',
    text: 'A test message',
    attachments: []
  };
  await composer.recovery.save({ composeId: 'rec-auth-fail', revision: 0, content });

  await assert.rejects(
    composer.send(payload({ composeId: 'rec-auth-fail', recoveryRevision: 1 })),
    err => err.code === 'smtp_login_required'
  );

  const rec = await composer.recovery.read({ composeId: 'rec-auth-fail' });
  assert.equal(rec.locked, false);
  assert.equal(rec.state, 'draft');
  composer.close();
});

test('two distinct concurrent requestIds on same recovery submit SMTP at most once', async () => {
  const { composer, calls } = await fixture();
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: '',
    bcc: '',
    subject: 'Concurrent send test',
    text: 'A test message',
    attachments: []
  };
  await composer.recovery.save({ composeId: 'concurrent-rec', revision: 0, content });

  const p1 = composer.send(payload({
    composeId: 'concurrent-rec',
    recoveryRevision: 1,
    requestId: 'req_11111111111111111111',
    subject: 'Concurrent send test'
  }));
  const p2 = composer.send(payload({
    composeId: 'concurrent-rec',
    recoveryRevision: 1,
    requestId: 'req_22222222222222222222',
    subject: 'Concurrent send test'
  }));

  const results = await Promise.allSettled([p1, p2]);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0].value.sent, true);
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0].reason?.code === 'send_uncertain' || rejected[0].reason?.code === 'invalid_request',
    `Expected send_uncertain or invalid_request, got ${rejected[0].reason?.code}`
  );

  const smtpCalls = calls.filter(call => call[0] === 'smtp');
  assert.equal(smtpCalls.length, 1);
  composer.close();
});

test('edit, discard, or account reconnect during async pre-submit prevents stale send', async () => {
  // Case A: Edit occurs while pre-submit awaits
  {
    let unpause;
    const pause = new Promise(done => { unpause = done; });
    const { composer, calls } = await fixture({
      connectionOptionsHook: () => pause
    });
    const content = { accountId: 'fixture', to: 'Recipient <recipient@example.test>', cc: '', bcc: '', subject: 'Race test A', text: 'V1', attachments: [] };
    await composer.recovery.save({ composeId: 'race-edit', revision: 0, content });

    const sendPromise = composer.send(payload({
      composeId: 'race-edit',
      recoveryRevision: 1,
      requestId: 'req_race_edit_1234567890',
      subject: 'Race test A',
      text: 'V1'
    }));

    // While pre-submit is paused, edit the recovery record to revision 2
    await composer.recovery.save({
      composeId: 'race-edit',
      revision: 1,
      content: { ...content, text: 'V2 edit' }
    });

    unpause();
    await assert.rejects(sendPromise, err => err.code === 'stale_message');
    assert.equal(calls.filter(call => call[0] === 'smtp').length, 0);
    composer.close();
  }

  // Case B: Discard occurs while pre-submit awaits
  {
    let unpause;
    const pause = new Promise(done => { unpause = done; });
    const { composer, calls } = await fixture({
      connectionOptionsHook: () => pause
    });
    const content = { accountId: 'fixture', to: 'Recipient <recipient@example.test>', cc: '', bcc: '', subject: 'Race test B', text: 'V1', attachments: [] };
    await composer.recovery.save({ composeId: 'race-disc', revision: 0, content });

    const sendPromise = composer.send(payload({
      composeId: 'race-disc',
      recoveryRevision: 1,
      requestId: 'req_race_disc_1234567890',
      subject: 'Race test B',
      text: 'V1'
    }));

    // While pre-submit is paused, discard the draft
    await composer.recovery.discard({ composeId: 'race-disc', revision: 1 });

    unpause();
    await assert.rejects(sendPromise, err => err.code === 'invalid_request');
    assert.equal(calls.filter(call => call[0] === 'smtp').length, 0);
    composer.close();
  }

  // Case C: Account reconnect occurs while pre-submit awaits
  {
    let unpause;
    const pause = new Promise(done => { unpause = done; });
    const { composer, calls, store } = await fixture({
      connectionOptionsHook: () => pause
    });
    const content = { accountId: 'fixture', to: 'Recipient <recipient@example.test>', cc: '', bcc: '', subject: 'Race test C', text: 'V1', attachments: [] };
    await composer.recovery.save({ composeId: 'race-reconn', revision: 0, content });

    const sendPromise = composer.send(payload({
      composeId: 'race-reconn',
      recoveryRevision: 1,
      requestId: 'req_race_reconn_12345678',
      subject: 'Race test C',
      text: 'V1'
    }));

    // While pre-submit is paused, reconnect account (bump revision in store)
    await store.update(data => {
      data.accounts[0].revision = 'new-revision-reconnected';
    });

    unpause();
    await assert.rejects(sendPromise, err => err.code === 'stale_message');
    assert.equal(calls.filter(call => call[0] === 'smtp').length, 0);
    composer.close();
  }
});

test('exact accepted replay after record removal succeeds and does not resubmit', async () => {
  const { composer, store, calls } = await fixture();
  const content = { accountId: 'fixture', to: 'Recipient <recipient@example.test>', cc: '', bcc: '', subject: 'Replay test', text: 'Text', attachments: [] };
  await composer.recovery.save({ composeId: 'rec-replay', revision: 0, content });

  const sendPayload = payload({
    composeId: 'rec-replay',
    recoveryRevision: 1,
    subject: 'Replay test',
    text: 'Text',
    requestId: 'req_replay_12345678901234'
  });

  const first = await composer.send(sendPayload);
  assert.equal(first.sent, true);
  assert.equal(store.read().composeRecoveries?.['rec-replay'], undefined);
  assert.equal(calls.filter(c => c[0] === 'smtp').length, 1);

  // Client replays exact request after lost ACK
  const replayed = await composer.send(sendPayload);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.messageId, first.messageId);
  assert.equal(calls.filter(c => c[0] === 'smtp').length, 1);
  composer.close();
});

test('HTML omission, changed reply reference, and non-trim text mismatch are rejected', async () => {
  const { composer } = await fixture();
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: '',
    bcc: '',
    subject: 'Html ref test',
    text: 'Body text',
    html: '<p>Body text</p>',
    inReplyTo: '<orig@example.test>',
    references: '<ref1@example.test>',
    attachments: []
  };
  await composer.recovery.save({ composeId: 'rec-strict', revision: 0, content });

  // 1. Omission of html in send payload is rejected
  await assert.rejects(
    composer.send(payload({
      composeId: 'rec-strict',
      recoveryRevision: 1,
      subject: 'Html ref test',
      text: 'Body text',
      inReplyTo: '<orig@example.test>',
      references: '<ref1@example.test>'
    })),
    err => err.code === 'invalid_request'
  );

  // 2. Changed references is rejected
  await assert.rejects(
    composer.send(payload({
      composeId: 'rec-strict',
      recoveryRevision: 1,
      subject: 'Html ref test',
      text: 'Body text',
      html: '<p>Body text</p>',
      inReplyTo: '<orig@example.test>',
      references: '<different-ref@example.test>'
    })),
    err => err.code === 'invalid_request'
  );

  // 3. Trailing space in text (no trim-based equivalence) is rejected
  await assert.rejects(
    composer.send(payload({
      composeId: 'rec-strict',
      recoveryRevision: 1,
      subject: 'Html ref test',
      text: 'Body text ',
      html: '<p>Body text</p>',
      inReplyTo: '<orig@example.test>',
      references: '<ref1@example.test>'
    })),
    err => err.code === 'invalid_request'
  );
  composer.close();
});

test('manual provider save lock after ambiguous append across service recreation', async () => {
  const { composer, store, accounts, createClient, createTransport } = await fixture({ appendFails: true });
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: '',
    bcc: '',
    subject: 'Ambiguous append test',
    text: 'Draft content',
    attachments: []
  };
  await composer.recovery.save({ composeId: 'rec-ambig', revision: 0, content });

  // Manual save with recovery encounters append failure (after appended = true)
  await assert.rejects(
    composer.save(payload({
      composeId: 'rec-ambig',
      recoveryRevision: 1,
      requestId: undefined,
      subject: 'Ambiguous append test',
      text: 'Draft content'
    })),
    err => err.code === 'draft_partial'
  );

  // Recovery is locked with draft_uncertain
  const recBefore = store.read().composeRecoveries['rec-ambig'];
  assert.equal(recBefore.locked, true);
  assert.equal(recBefore.state, 'draft_uncertain');
  composer.close();

  // Recreate composer across service restart
  const recreated = createMailComposer({ accounts, store, createClient, createTransport });
  const recAfter = await recreated.recovery.read({ composeId: 'rec-ambig' });
  assert.equal(recAfter.locked, true);
  assert.equal(recAfter.state, 'draft_uncertain');

  // Second manual save attempt after ambiguous append is blocked across service recreation
  await assert.rejects(
    recreated.save(payload({
      composeId: 'rec-ambig',
      recoveryRevision: 1,
      requestId: undefined,
      subject: 'Ambiguous append test',
      text: 'Draft content'
    })),
    err => err.code === 'stale_message'
  );
  recreated.close();
});

test('successful manual save updates recovery ID/revision and no duplicate on subsequent replacement', async () => {
  const { composer, store, calls } = await fixture();
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: '',
    bcc: '',
    subject: 'Manual save test',
    text: 'Draft v1',
    attachments: []
  };
  await composer.recovery.save({ composeId: 'rec-manual', revision: 0, content });

  // 1. Initial manual save
  const firstSave = await composer.save(payload({
    composeId: 'rec-manual',
    recoveryRevision: 1,
    requestId: undefined,
    subject: 'Manual save test',
    text: 'Draft v1'
  }));
  assert.equal(firstSave.saved, true);
  assert.ok(firstSave.draftId);
  assert.equal(firstSave.composeId, 'rec-manual');
  assert.equal(firstSave.recoveryRevision, 2);

  // Check recovery adopted providerDraftId and bumped revision
  const readRec = await composer.recovery.read({ composeId: 'rec-manual' });
  assert.equal(readRec.revision, 2);
  assert.equal(readRec.content.providerDraftId, firstSave.draftId);

  // Persist edited recovery before manual replacement
  const edited = await composer.recovery.save({
    composeId: 'rec-manual',
    revision: 2,
    content: { ...readRec.content, text: 'Draft v2' }
  });
  assert.equal(edited.revision, 3);

  // 2. Subsequent replacement using returned draftId and recoveryRevision
  const secondSave = await composer.save(payload({
    composeId: 'rec-manual',
    recoveryRevision: edited.revision,
    draftId: firstSave.draftId,
    requestId: undefined,
    subject: 'Manual save test',
    text: 'Draft v2'
  }));
  assert.equal(secondSave.saved, true);
  assert.ok(secondSave.draftId);
  assert.notEqual(secondSave.draftId, firstSave.draftId);
  assert.equal(secondSave.composeId, 'rec-manual');
  assert.equal(secondSave.recoveryRevision, edited.revision + 1);

  // Check UIDPLUS delete was called for the old draft
  const deleteCalls = calls.filter(c => c[0] === 'delete');
  assert.ok(deleteCalls.length >= 1);

  // Previous draft was deleted from savedDrafts
  assert.equal(store.read().savedDrafts[firstSave.draftId], undefined);
  assert.ok(store.read().savedDrafts[secondSave.draftId]);
  composer.close();
});

test('savedDrafts bounded map never evicts a draft reference currently used by recovery', async () => {
  const { composer, store } = await fixture();
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: '',
    bcc: '',
    subject: 'Protected draft test',
    text: 'Draft v1',
    attachments: []
  };
  await composer.recovery.save({ composeId: 'rec-protected', revision: 0, content });

  const saveRes = await composer.save(payload({
    composeId: 'rec-protected',
    recoveryRevision: 1,
    requestId: undefined,
    subject: 'Protected draft test',
    text: 'Draft v1'
  }));
  const protectedDraftId = saveRes.draftId;

  // Fill savedDrafts with 510 dummy drafts to force pruning
  await store.update(data => {
    for (let i = 0; i < 510; i++) {
      data.savedDrafts[`dummy-draft-${i}`] = {
        accountId: 'fixture',
        revision: 'revision',
        reference: { accountId: 'fixture', path: 'Drafts', uid: 200 + i, uidValidity: '123', fingerprint: 'f'.repeat(64) },
        updatedAt: new Date().toISOString()
      };
    }
  });

  // Save another unlinked draft to trigger pruning
  await composer.save(payload({ requestId: undefined, text: 'Trigger pruning' }));

  // Verify the draft used by recovery was NOT evicted
  assert.ok(store.read().savedDrafts[protectedDraftId], 'Draft used by recovery must not be evicted');
  composer.close();
});

test('pre-APPEND failure safely unlocks recovery', async () => {
  const { composer } = await fixture({ noUidPlus: true });
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: '',
    bcc: '',
    subject: 'Pre-append fail',
    text: 'Text',
    attachments: []
  };
  await composer.recovery.save({ composeId: 'rec-pre-fail', revision: 0, content });

  await assert.rejects(
    composer.save(payload({
      composeId: 'rec-pre-fail',
      recoveryRevision: 1,
      requestId: undefined,
      subject: 'Pre-append fail',
      text: 'Text'
    })),
    err => err.code === 'draft_unavailable'
  );

  const rec = await composer.recovery.read({ composeId: 'rec-pre-fail' });
  assert.equal(rec.locked, false);
  assert.equal(rec.state, 'draft');
  composer.close();
});

test('manual save with recovery rejects changed body, omitted/replaced providerDraftId, or changed refs BEFORE APPEND', async () => {
  const { composer, calls } = await fixture();
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: 'cc@example.test',
    bcc: '',
    subject: 'Digest match test',
    text: 'Original body',
    attachments: [],
    inReplyTo: '<orig@example.test>',
    references: '<ref@example.test>'
  };
  await composer.recovery.save({ composeId: 'rec-digest-check', revision: 0, content });

  // 1. Changed body rejected BEFORE append
  await assert.rejects(
    composer.save(payload({
      composeId: 'rec-digest-check',
      recoveryRevision: 1,
      requestId: undefined,
      subject: 'Digest match test',
      text: 'Different body text',
      to: 'Recipient <recipient@example.test>',
      cc: 'cc@example.test',
      inReplyTo: '<orig@example.test>',
      references: '<ref@example.test>'
    })),
    err => err.code === 'invalid_request'
  );
  assert.equal(calls.filter(c => c[0] === 'append').length, 0);
  let rec = await composer.recovery.read({ composeId: 'rec-digest-check' });
  assert.equal(rec.revision, 1);
  assert.equal(rec.locked, false);
  assert.equal(rec.content.text, 'Original body');

  // 2. Changed refs rejected BEFORE append
  await assert.rejects(
    composer.save(payload({
      composeId: 'rec-digest-check',
      recoveryRevision: 1,
      requestId: undefined,
      subject: 'Digest match test',
      text: 'Original body',
      to: 'Recipient <recipient@example.test>',
      cc: 'cc@example.test',
      inReplyTo: '<orig@example.test>',
      references: '<different-ref@example.test>'
    })),
    err => err.code === 'invalid_request'
  );
  assert.equal(calls.filter(c => c[0] === 'append').length, 0);
  rec = await composer.recovery.read({ composeId: 'rec-digest-check' });
  assert.equal(rec.revision, 1);
  assert.equal(rec.locked, false);
  assert.equal(rec.content.text, 'Original body');

  // Valid initial save to attach providerDraftId
  const validSave = await composer.save(payload({
    composeId: 'rec-digest-check',
    recoveryRevision: 1,
    requestId: undefined,
    subject: 'Digest match test',
    text: 'Original body',
    to: 'Recipient <recipient@example.test>',
    cc: 'cc@example.test',
    inReplyTo: '<orig@example.test>',
    references: '<ref@example.test>'
  }));
  assert.equal(validSave.saved, true);
  const assignedDraftId = validSave.draftId;
  rec = await composer.recovery.read({ composeId: 'rec-digest-check' });
  assert.equal(rec.revision, 2);
  assert.equal(rec.content.providerDraftId, assignedDraftId);
  const appendCount = calls.filter(c => c[0] === 'append').length;

  // 3. Omitted providerDraftId rejected BEFORE append
  await assert.rejects(
    composer.save(payload({
      composeId: 'rec-digest-check',
      recoveryRevision: 2,
      requestId: undefined,
      subject: 'Digest match test',
      text: 'Original body',
      to: 'Recipient <recipient@example.test>',
      cc: 'cc@example.test',
      inReplyTo: '<orig@example.test>',
      references: '<ref@example.test>'
    })),
    err => err.code === 'invalid_request'
  );
  assert.equal(calls.filter(c => c[0] === 'append').length, appendCount);

  // 4. Replaced providerDraftId rejected BEFORE append
  await assert.rejects(
    composer.save(payload({
      composeId: 'rec-digest-check',
      recoveryRevision: 2,
      draftId: 'different-draft-id-123',
      requestId: undefined,
      subject: 'Digest match test',
      text: 'Original body',
      to: 'Recipient <recipient@example.test>',
      cc: 'cc@example.test',
      inReplyTo: '<orig@example.test>',
      references: '<ref@example.test>'
    })),
    err => err.code === 'invalid_request'
  );
  assert.equal(calls.filter(c => c[0] === 'append').length, appendCount);

  // Content remained untouched
  rec = await composer.recovery.read({ composeId: 'rec-digest-check' });
  assert.equal(rec.revision, 2);
  assert.equal(rec.locked, false);
  assert.equal(rec.content.providerDraftId, assignedDraftId);
  assert.equal(rec.content.text, 'Original body');
  composer.close();
});

test('race test: discard during deferred append cannot erase currently saving draft; stale operation no overwrite', async () => {
  let unpauseAppend;
  const pauseAppend = new Promise(resolve => { unpauseAppend = resolve; });
  const { composer, store } = await fixture({
    appendHook: () => pauseAppend
  });
  const content = {
    accountId: 'fixture',
    to: 'Recipient <recipient@example.test>',
    cc: '',
    bcc: '',
    subject: 'Deferred append test',
    text: 'Draft v1',
    attachments: []
  };
  await composer.recovery.save({ composeId: 'rec-saving-race', revision: 0, content });

  const savePromise = composer.save(payload({
    composeId: 'rec-saving-race',
    recoveryRevision: 1,
    requestId: undefined,
    subject: 'Deferred append test',
    text: 'Draft v1'
  }));

  // Wait until recovery state is saving
  while (store.read().composeRecoveries?.['rec-saving-race']?.state !== 'saving') {
    await new Promise(r => setImmediate(r));
  }

  // Attempt to discard while draft is in saving state -> must be rejected with busy
  await assert.rejects(
    composer.recovery.discard({ composeId: 'rec-saving-race', revision: 1 }),
    err => err.code === 'busy'
  );

  // Saving draft was NOT erased
  const savingRec = store.read().composeRecoveries['rec-saving-race'];
  assert.ok(savingRec);
  assert.equal(savingRec.state, 'saving');
  assert.equal(savingRec.locked, true);

  // Unpause append and let save complete
  unpauseAppend();
  const saveRes = await savePromise;
  assert.equal(saveRes.saved, true);

  const completedRec = await composer.recovery.read({ composeId: 'rec-saving-race' });
  assert.equal(completedRec.revision, 2);
  assert.equal(completedRec.locked, false);
  assert.equal(completedRec.content.providerDraftId, saveRes.draftId);

  // Verify stale operation cannot overwrite newer/recreated state
  await store.update(data => {
    data.composeRecoveries['rec-saving-race'].revision = 5;
    data.composeRecoveries['rec-saving-race'].providerSaveId = 'newer-save-id';
  });

  // Stale completion with older providerSaveId does not mutate recovery
  await store.update(data => {
    const rec = data.composeRecoveries['rec-saving-race'];
    if (rec && rec.providerSaveId === 'stale-save-id' && rec.state === 'saving') {
      rec.content.providerDraftId = 'stale-draft';
    }
  });
  assert.notEqual(store.read().composeRecoveries['rec-saving-race'].content.providerDraftId, 'stale-draft');
  assert.equal(store.read().composeRecoveries['rec-saving-race'].revision, 5);
  composer.close();
});

test('reserved IDs (__proto__, prototype, constructor) are rejected with invalid_request and do not pollute Object.prototype', async () => {
  const { composer } = await fixture();
  const reserved = ['__proto__', 'prototype', 'constructor'];

  for (const reservedId of reserved) {
    await assert.rejects(
      composer.save(payload({ composeId: reservedId, recoveryRevision: 1 })),
      err => err.code === 'invalid_request'
    );
    await assert.rejects(
      composer.save(payload({ draftId: reservedId })),
      err => err.code === 'invalid_request'
    );
    await assert.rejects(
      composer.send(payload({ composeId: reservedId, recoveryRevision: 1 })),
      err => err.code === 'invalid_request'
    );
    await assert.rejects(
      composer.send(payload({ draftId: reservedId })),
      err => err.code === 'invalid_request'
    );
    await assert.rejects(
      composer.context({ id: reservedId, mode: 'reply' }),
      err => err.code === 'invalid_request'
    );
  }

  assert.equal(Object.prototype.digest, undefined);
  assert.equal(Object.prototype.locked, undefined);
  assert.equal(Object.prototype.state, undefined);
  assert.equal(Object.prototype.reference, undefined);
  composer.close();
});
