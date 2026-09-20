import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMailProcessingReader } from '../server/mail-processing-reader.mjs';
import { mailFingerprint } from '../server/mailboxes.mjs';
import { MailHarborError } from '../server/validation.mjs';
import { searchCompiler } from '../node_modules/imapflow/dist/esm/search-compiler.js';
import { BODY_SOURCE_LIMIT, PROCESSING_SOURCE_LIMIT, CONTENT_EXTRACTION_VERSION } from '../server/body.mjs';

const account = { id: 'a', email: 'a@example.test', label: 'Fixture account' };
const verify = async () => true;
const mail = (uid, overrides = {}) => ({ uid, size: 12, internalDate: new Date('2026-09-01T10:00:00Z'), flags: new Set(),
  envelope: { date: new Date('2026-08-30T10:00:00Z'), subject: `Message ${uid}`, from: [{ address: 'sender@example.test' }],
    to: [{ address: 'a@example.test' }], messageId: `<${uid}@example.test>` },
  labels: new Set(), bodyStructure: { part: '1', type: 'text/plain', size: 12 }, body: 'Message body', ...overrides });
const reference = (message, path = 'INBOX', uidValidity = '1') => ({ accountId: 'a', path, uidValidity, uid: message.uid, fingerprint: mailFingerprint(message) });

function harness(config = {}, options = {}) {
  const calls = [], clients = [];
  const state = { capabilities: ['MOVE'], ...config,
    folders: (config.folders ?? [{ path: 'INBOX', messages: [mail(1)] }, { path: 'Archive', specialUse: '\\Archive' },
      { path: 'Trash', specialUse: '\\Trash' }, { path: 'Spam', specialUse: '\\Junk' }]).map(folder => ({
      flags: new Set(), uidValidity: 1n, ...folder, uidNext: folder.uidNext ?? Math.max(0, ...(folder.messages ?? []).map(message => message.uid)) + 1,
      messages: new Map((folder.messages ?? []).map(message => [message.uid, message])) })) };
  class Client extends EventEmitter {
    constructor(options) { super(); this.options = options; this.capabilities = new Set(state.capabilities); clients.push(this); }
    command() { assert.equal(this.fetching, undefined, 'No command may run inside a FETCH iterator'); assert.ok(!this.closed); }
    async connect() { await state.onConnect?.(this); }
    close() { this.closed = true; }
    async list() { this.command(); calls.push({ action: 'list' }); return state.folders; }
    async getMailboxLock(path, options) {
      this.command(); assert.equal(this.locked, undefined, 'Never acquire a nested mailbox lock');
      this.folder = state.folders.find(folder => folder.path === path);
      if (!this.folder) throw new Error('private folder error');
      this.mailbox = { path, uidValidity: this.folder.uidValidity, uidNext: this.folder.uidNext,
        exists: this.folder.messages.size, readOnly: this.folder.readOnly || options.readOnly };
      this.locked = true;
      calls.push({ action: 'open', path, readOnly: options.readOnly });
      await state.onMailboxLock?.(path, this);
      return { release: () => { delete this.locked; } };
    }
    async search(criteria, options) {
      this.command(); assert.deepEqual(options, { uid: true });
      if (criteria.emailId) {
        assert.deepEqual(Object.keys(criteria), ['emailId']);
        calls.push({ action: 'email_search', path: this.folder.path, emailId: criteria.emailId });
        return state.emailSearchResult ?? [...this.folder.messages.values()].filter(message => message.emailId === criteria.emailId).map(message => message.uid);
      }
      assert.deepEqual(Object.keys(criteria), ['uid', 'deleted']); assert.equal(criteria.deleted, false);
      const [start, end] = criteria.uid.split(':').map(Number);
      assert.ok(start > 0 && end >= start && end - start < 4096);
      calls.push({ action: 'search', start, end });
      await state.onSearch?.(criteria, this);
      return state.searchResult ?? [...this.folder.messages.values()].filter(message => message.uid >= start && message.uid <= end &&
        !message.flags.has('\\Deleted')).map(message => message.uid).reverse();
    }
    async *fetch(range, query, options) {
      if (options.binary === false) {
        this.command();
        for (const message of typeof state.beforeSingleRows === 'function' ? state.beforeSingleRows(Number(range), this) : state.beforeSingleRows ?? []) yield structuredClone(message);
        const message = await this.fetchOne(range, query, options);
        if (message) yield message;
        for (const message of typeof state.afterSingleRows === 'function' ? state.afterSingleRows(Number(range), this) : state.afterSingleRows ?? []) yield structuredClone(message);
        return;
      }
      this.command(); assert.deepEqual(options, { uid: true }); assert.equal(query.source, undefined); assert.equal(query.bodyParts, undefined);
      const uids = range.split(',').map(Number); assert.ok(uids.length <= 250);
      calls.push({ action: 'fetch', path: this.folder.path, uids, query });
      this.fetching = true;
      try {
        for (const message of state.beforeFetchRows ?? []) yield structuredClone(message);
        for (const uid of uids) {
          await state.onFetch?.(uid, this);
          if (this.folder.messages.has(uid)) yield structuredClone(this.folder.messages.get(uid));
        }
        for (const message of state.afterFetchRows ?? []) yield structuredClone(message);
      } finally { delete this.fetching; }
    }
    async fetchOne(uid, query, options) {
      this.command(); assert.deepEqual(options, { uid: true, binary: false }); assert.equal(query.source, undefined);
      const notificationHeader = query.bodyParts?.length === 1 && query.bodyParts[0].key === 'header';
      calls.push({ action: notificationHeader ? 'notification_header' : query.bodyParts ? 'body' : 'one', path: this.folder.path, uid: Number(uid), query });
      await state.onFetchOne?.(Number(uid), query, this);
      const original = this.folder.messages.get(Number(uid));
      if (!original) return false;
      const message = structuredClone(original);
      if (notificationHeader) {
        assert.equal(this.mailbox.readOnly, true);
        assert.deepEqual(query.bodyParts, [{ key: 'header', start: 0, maxLength: 32768 }]);
        assert.equal(query.bodyStructure, true);
        message.headers = Buffer.from(original.notificationHeaders ?? 'From: Sender <sender@example.test>\r\nSubject: Message 1\r\n\r\n').subarray(0, 32768);
        if (state.notificationHeaderMap) { message.bodyParts = new Map([['header', message.headers]]); delete message.headers; }
        return message;
      }
      if (query.bodyParts) {
        assert.equal(this.mailbox.readOnly, true);
        const [mime, body] = query.bodyParts;
        assert.deepEqual([mime.start, mime.maxLength, body.start], [0, 16384, 0]);
        assert.ok([BODY_SOURCE_LIMIT, PROCESSING_SOURCE_LIMIT].includes(body.maxLength));
        message.bodyParts = new Map([[body.key, Buffer.from(original.body).subarray(0, body.maxLength)]]);
        const headers = Buffer.from(original.mime ?? 'Content-Type: text/plain\r\n\r\n').subarray(0, mime.maxLength);
        if (body.key === 'text') message.headers = headers; else message.bodyParts.set(mime.key, headers);
      }
      return message;
    }
    async messageFlagsAdd(range, flags, options) {
      this.command(); assert.equal(this.mailbox.readOnly, false); assert.deepEqual(options, { uid: true }); assert.deepEqual(flags, ['\\Seen']);
      const uids = range.split(',').map(Number);
      calls.push({ action: 'seen', path: this.folder.path, uids });
      for (const uid of uids) this.folder.messages.get(uid)?.flags.add('\\Seen');
      return true;
    }
    async messageFlagsRemove(range, flags, options) {
      this.command(); assert.equal(this.mailbox.readOnly, false); assert.deepEqual(options, { uid: true, useLabels: true });
      assert.deepEqual(flags, ['\\Inbox']); calls.push({ action: 'archive_label', uid: Number(range), path: this.folder.path });
      const original = this.folder.messages.get(Number(range));
      // Gmail can ignore removing the selected Inbox's own omitted label.
      // Tests must exercise All Mail rather than model that no-op as success.
      if (!state.archiveNoop && this.folder.path.toUpperCase() !== 'INBOX') for (const folder of state.folders) for (const message of folder.messages.values()) {
        if (original.emailId ? message.emailId !== original.emailId : mailFingerprint(message) !== mailFingerprint(original)) continue;
        message.labels.delete('\\Inbox');
        if (folder.path.toUpperCase() === 'INBOX') folder.messages.delete(message.uid);
      }
      await state.onArchiveApplied?.(Number(range), this);
      return true;
    }
    async messageMove(range, path, options) {
      this.command(); assert.equal(this.mailbox.readOnly, false); assert.deepEqual(options, { uid: true });
      assert.ok(this.capabilities.has('MOVE'));
      const source = this.folder, target = state.folders.find(folder => folder.path === path), uid = Number(range), targetUid = target.uidNext++;
      const message = source.messages.get(uid); assert.ok(message);
      const copied = { ...structuredClone(message), uid: targetUid };
      if (state.changedMove) copied.envelope.subject = 'Changed target';
      target.messages.set(targetUid, copied); source.messages.delete(uid);
      calls.push({ action: 'move', path: source.path, target: path, uid });
      await state.onMoveApplied?.(uid, this);
      return state.noMapping ? { path: source.path, destination: path } :
        { path: source.path, destination: path, uidValidity: target.uidValidity, uidMap: new Map([[uid, targetUid]]) };
    }
    async messageDelete() { assert.fail('Never delete or expunge'); }
    async messageCopy() { assert.fail('Never emulate MOVE'); }
    async mailboxClose() { assert.fail('Never CLOSE/EXPUNGE'); }
  }
  const reader = createMailProcessingReader({ connectionOptions: async () => ({ auth: { user: 'a', pass: 'private-secret' }, secure: false,
    logger: true, tls: { rejectUnauthorized: false } }), createClient: options => new Client(options), ...options });
  return { reader, state, clients, calls };
}

test('discovers actual selectable roles, localized SPECIAL-USE and Gmail aggregate views without any FETCH', async () => {
  const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX' }, { path: 'INBOX' },
    { path: 'Verzonden', specialUse: '\\Sent' }, { path: 'Drafts' }, { path: 'Junk', flags: new Set(['\\Junk']) },
    { path: 'Archive' }, { path: 'Custom' }, { path: '[Gmail]/All Mail', specialUse: '\\All' },
    { path: 'Starred', specialUse: '\\Flagged' }, { path: 'Hidden', flags: new Set(['\\Noselect']) }] });
  const result = await h.reader.folders(account);
  assert.equal(result.gmail, true);
  assert.deepEqual(result.folders.map(folder => [folder.path, folder.role]), [['INBOX', 'inbox'], ['Verzonden', 'sent'], ['Drafts', 'drafts'],
    ['Junk', 'junk'], ['Archive', 'archive'], ['Custom', 'other'], ['[Gmail]/All Mail', 'archive'], ['Starred', 'other']]);
  assert.equal(result.folders.find(folder => folder.path === '[Gmail]/All Mail').gmailAll, true);
  assert.equal(result.folders.find(folder => folder.path === 'Starred').aggregate, true);
  assert.deepEqual(h.calls, [{ action: 'list' }]);
});

test('UID checkpoints freeze arrivals and fetch each old message header once across bounded pages', async () => {
  const h = harness({ folders: [{ path: 'INBOX', messages: Array.from({ length: 600 }, (_, index) => mail(index + 1)) }] });
  const first = await h.reader.scan(account, { path: 'INBOX', limit: 100 });
  assert.equal(first.afterUid, 100); assert.equal(first.highWatermark, 600); assert.equal(first.done, false);
  h.state.folders[0].messages.set(601, mail(601)); h.state.folders[0].uidNext++;
  const seen = [...first.messages];
  let page = first;
  while (!page.done) {
    page = await h.reader.scan(account, { path: 'INBOX', uidValidity: page.uidValidity, afterUid: page.afterUid,
      highWatermark: page.highWatermark, limit: 100 }); seen.push(...page.messages);
  }
  assert.equal(page.afterUid, 600); assert.equal(seen.length, 600);
  assert.deepEqual(h.calls.filter(call => call.action === 'fetch').flatMap(call => call.uids), Array.from({ length: 600 }, (_, index) => index + 1));
  assert.equal(h.calls.some(call => call.action === 'body'), false);
  const incremental = await h.reader.scan(account, { path: 'INBOX', uidValidity: '1', afterUid: 600 });
  assert.deepEqual(incremental.messages.map(message => message.reference.uid), [601]);
  assert.equal(incremental.messages[0].receivedAt, '2026-09-01T10:00:00.000Z');
  assert.equal(incremental.messages[0].date, '2026-08-30T10:00:00.000Z');
  assert.ok(h.clients.every(client => client.closed && client.options.secure && client.options.tls.rejectUnauthorized && !client.options.logger));
});

test('sparse UID history yields bounded progress, and empty folders never SEARCH reversed ranges', async () => {
  const h = harness({ folders: [{ path: 'INBOX', uidNext: 1000000, messages: [] }] });
  const page = await h.reader.scan(account, { path: 'INBOX' });
  assert.equal(page.afterUid, 65536); assert.equal(page.done, false); assert.deepEqual(page.messages, []);
  assert.equal(h.calls.filter(call => call.action === 'search').length, 16);
  const empty = harness({ folders: [{ path: 'INBOX' }] });
  const result = await empty.reader.scan(account, { path: 'INBOX' });
  assert.equal(result.done, true); assert.equal(result.highWatermark, 0);
  assert.equal(empty.calls.some(call => call.action === 'search'), false);
});

test('numeric UID range compiles to UID SEARCH range rather than a sequence number search', () => {
  const compiled = searchCompiler({ capabilities: new Set(), enabled: new Set() }, { uid: '101:4096', deleted: false });
  assert.ok(compiled.some(item => item.value === 'UID'));
  assert.ok(compiled.some(item => item.type === 'SEQUENCE' && item.value === '101:4096'));
});

test('UIDVALIDITY changes, invalid continuations and out of range SEARCH results fail without mutation', async () => {
  const h = harness();
  await assert.rejects(h.reader.scan(account, { path: 'INBOX', afterUid: 1 }), { code: 'invalid_request' });
  await assert.rejects(h.reader.scan(account, { path: 'INBOX', uidValidity: '2' }), { code: 'stale_message' });
  await assert.rejects(h.reader.scan(account, { path: 'INBOX', uidValidity: '1', highWatermark: 5 }), { code: 'stale_message' });
  h.state.searchResult = [999];
  await assert.rejects(h.reader.scan(account, { path: 'INBOX' }), { code: 'mailbox_error' });
  assert.equal(h.calls.some(call => ['fetch', 'move', 'seen'].includes(call.action)), false);
});

test('Gmail labels preserve Sent retention in Inbox and derive all-mail roles without trusting header authentication claims', async () => {
  const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [mail(1, { labels: new Set(['\\Inbox', '\\Sent']) })] },
    { path: 'All', specialUse: '\\All', messages: [mail(2, { labels: new Set(['\\Inbox']) }), mail(3),
      mail(4, { labels: new Set(['\\Draft']) })] }] });
  assert.equal((await h.reader.scan(account, { path: 'INBOX' })).messages[0].role, 'sent');
  const result = await h.reader.scan(account, { path: 'All' });
  assert.deepEqual(result.messages.map(message => message.role), ['inbox', 'archive', 'drafts']);
  assert.ok(result.messages.every(message => message.authenticated === undefined));
});

test('readBatch shares one connection, completes metadata FETCH before bounded MIME/body reads and reports disappeared messages', async () => {
  const first = mail(1), second = mail(2), third = mail(3);
  const h = harness({ folders: [{ path: 'INBOX', messages: [first, second] }] });
  const result = await h.reader.readBatch(account, [reference(first), reference(second), reference(third)]);
  assert.equal(h.clients.length, 1); assert.equal(h.calls.filter(call => call.action === 'fetch').length, 1);
  assert.deepEqual(result.messages.map(message => message.body), ['Message body', 'Message body']);
  assert.deepEqual(result.errors, [{ reference: reference(third), code: 'stale_message' }]);
  assert.ok(result.messages.every(message => !message.truncated && !message.bodyUnavailable));
  assert.equal(h.calls.some(call => ['move', 'seen'].includes(call.action)), false);
});

test('scan and body batches ignore unrelated FETCH and incomplete notifications before complete rows', async () => {
  for (const operation of ['scan', 'readBatch']) {
    const h = harness({ beforeFetchRows: [{ uid: 99, flags: new Set(['\\Deleted']) }, { uid: 1, flags: new Set(['\\Seen']) }] });
    const result = operation === 'scan' ? await h.reader.scan(account, { path: 'INBOX' }) :
      await h.reader.readBatch(account, [reference(mail(1))]);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].reference.uid, 1);
    if (operation === 'readBatch') { assert.equal(result.messages[0].body, 'Message body'); assert.deepEqual(result.errors, []); }
    assert.equal(h.calls.some(call => ['seen', 'move'].includes(call.action)), false);
  }
});

test('consistent full duplicate FETCH responses are accepted once without broadening a mark-read batch', async () => {
  for (const operation of ['scan', 'readBatch', 'markRead']) {
    const h = harness({ beforeFetchRows: [mail(99)], afterFetchRows: [mail(1)] });
    const result = operation === 'scan' ? await h.reader.scan(account, { path: 'INBOX' }) :
      await h.reader[operation](account, [reference(mail(1))], { verify });
    if (operation === 'markRead') {
      assert.deepEqual(result.results.map(value => value.status), ['applied']);
      assert.deepEqual(h.calls.filter(call => call.action === 'seen').map(call => call.uids), [[1]]);
    } else assert.equal(result.messages.length, 1);
  }
});

test('conflicting immutable FETCH data fails before marking any message as read', async () => {
  for (const operation of ['scan', 'readBatch', 'markRead']) {
    const changed = mail(1); changed.envelope.subject = 'Conflicting message identity';
    const h = harness({ afterFetchRows: [changed] });
    await assert.rejects(operation === 'scan' ? h.reader.scan(account, { path: 'INBOX' }) :
      h.reader[operation](account, [reference(mail(1))], { verify }), { code: 'stale_message' });
    assert.equal(h.calls.some(call => ['seen', 'move'].includes(call.action)), false);
  }
});

test('later partial flags preserve the full identity but prevent marking a now-deleted message read', async () => {
  const h = harness({ afterFetchRows: [{ uid: 1, flags: new Set(['\\Deleted']) }, { uid: 99, flags: new Set(['\\Seen']) }] });
  const result = await h.reader.markRead(account, [reference(mail(1))], { verify });
  assert.deepEqual(result.results.map(value => value.status), ['changed']);
  assert.equal(h.calls.some(call => call.action === 'seen'), false);
});

test('safe text extraction skips attached/encrypted parts and propagates truncated bodies', async () => {
  const attached = mail(1, { bodyStructure: { part: '1', type: 'text/plain', disposition: 'attachment' } });
  const encrypted = mail(2, { body: '-----BEGIN PGP MESSAGE-----' });
  const long = mail(3, { body: 'a'.repeat(9000), bodyStructure: { part: '1', type: 'text/plain', size: 9000 } });
  const h = harness({ folders: [{ path: 'INBOX', messages: [attached, encrypted, long] }] });
  const result = await h.reader.scan(account, { path: 'INBOX', includeBodies: true });
  assert.equal(result.messages[0].bodyUnavailable, true); assert.equal(result.messages[1].bodyUnavailable, true);
  assert.equal(result.messages[2].body.length, 8000); assert.equal(result.messages[2].truncated, true);
  assert.deepEqual(h.calls.filter(call => call.action === 'body').map(call => call.uid), [2, 3]);
});

test('processing expands an encoded prefix once to recover an invoice and date without mailbox effects', async () => {
  const body = `<style>${'x'.repeat(BODY_SOURCE_LIMIT + 1000)}</style><p>Invoice. Payment due 2026-12-31.</p>`;
  const message = mail(1, { body, mime: 'Content-Type: text/html\r\n\r\n', bodyStructure: { part: '1', type: 'text/html', size: Buffer.byteLength(body) } });
  for (const operation of ['read', 'readBatch', 'scan']) {
    const h = harness({ folders: [{ path: 'INBOX', messages: [message] }] });
    const result = operation === 'read' ? await h.reader.read(account, reference(message)) : operation === 'scan' ?
      (await h.reader.scan(account, { path: 'INBOX', includeBodies: true })).messages[0] :
      (await h.reader.readBatch(account, [reference(message)])).messages[0];
    assert.equal(result.body, 'Invoice. Payment due 2026-12-31.');
    assert.equal(result.truncated, false); assert.equal(result.bodyUnavailable, false);
    assert.deepEqual(result.contentReasons, []); assert.equal(result.extractionVersion, CONTENT_EXTRACTION_VERSION);
    assert.deepEqual(h.calls.filter(call => call.action === 'body').map(call => call.query.bodyParts[1].maxLength), [BODY_SOURCE_LIMIT, PROCESSING_SOURCE_LIMIT]);
    assert.ok(h.calls.filter(call => call.action === 'open').every(call => call.readOnly));
    assert.equal(h.calls.some(call => ['seen', 'move', 'archive_label'].includes(call.action)), false);
    assert.equal(h.state.folders[0].messages.get(1).flags.has('\\Seen'), false);
  }
});

test('source expansion is bounded and does not claim content after 256 KiB is complete', async () => {
  const body = `<p>Promotion.</p><style>${'x'.repeat(PROCESSING_SOURCE_LIMIT)}</style><p>Invoice. Valid until 2028-01-01.</p>`;
  const message = mail(1, { body, mime: 'Content-Type: text/html\r\n\r\n', bodyStructure: { part: '1', type: 'text/html', size: Buffer.byteLength(body) } });
  const h = harness({ folders: [{ path: 'INBOX', messages: [message] }] });
  const result = await h.reader.read(account, reference(message));
  assert.equal(result.body, 'Promotion.'); assert.equal(result.truncated, true);
  assert.ok(result.contentReasons.includes('encoded_byte_limit'));
  assert.ok(result.contentReasons.every(reason => ['encoded_byte_limit', 'decoded_byte_limit'].includes(reason)));
  assert.deepEqual(h.calls.filter(call => call.action === 'body').map(call => call.query.bodyParts[1].maxLength), [BODY_SOURCE_LIMIT, PROCESSING_SOURCE_LIMIT]);
});

test('processing never expands final text, unsafe MIME or encrypted content and explains absent parts', async () => {
  const long = mail(1, { body: 'a'.repeat(100000), bodyStructure: { part: '1', type: 'text/plain', size: 100000 } });
  const unsafe = mail(2, { body: 'a'.repeat(100000), mime: 'Content-Type: text/plain; name=private.txt\r\n\r\n',
    bodyStructure: { part: '1', type: 'text/plain', size: 100000 } });
  const encrypted = mail(3, { body: '-----BEGIN PGP MESSAGE-----' + 'a'.repeat(100000),
    bodyStructure: { part: '1', type: 'text/plain', size: 100000 } });
  const encryptedPart = mail(4, { bodyStructure: { type: 'multipart/mixed', childNodes: [{ type: 'multipart/encrypted' }] } });
  const attached = mail(5, { bodyStructure: { part: '1', type: 'text/plain', disposition: 'attachment' } });
  const unavailable = mail(6, { bodyStructure: null });
  const h = harness({ folders: [{ path: 'INBOX', messages: [long, unsafe, encrypted, encryptedPart, attached, unavailable] }] });
  const result = await h.reader.scan(account, { path: 'INBOX', includeBodies: true });
  assert.equal(result.messages[0].body.length, 8000); assert.ok(result.messages[0].contentReasons.includes('decoded_text_limit'));
  assert.ok(result.messages[1].contentReasons.includes('invalid_mime')); assert.ok(result.messages[2].contentReasons.includes('encrypted_content'));
  assert.deepEqual(result.messages[3].contentReasons, ['encrypted_content']);
  assert.deepEqual(result.messages[4].contentReasons, ['unsupported_content']);
  assert.deepEqual(result.messages[5].contentReasons, ['unavailable_part']);
  assert.deepEqual(h.calls.filter(call => call.action === 'body').map(call => [call.uid, call.query.bodyParts[1].maxLength]),
    [[1, BODY_SOURCE_LIMIT], [2, BODY_SOURCE_LIMIT], [3, BODY_SOURCE_LIMIT]]);
});

test('identity or UIDVALIDITY changes during the expanded read discard the earlier excerpt', async () => {
  for (const change of ['fingerprint', 'validity', 'absent']) {
    const body = `<style>${'x'.repeat(BODY_SOURCE_LIMIT + 1000)}</style><p>Invoice.</p>`;
    const message = mail(1, { body, mime: 'Content-Type: text/html\r\n\r\n', bodyStructure: { part: '1', type: 'text/html', size: body.length } });
    const h = harness({ folders: [{ path: 'INBOX', messages: [message] }], onFetchOne: async (uid, query, client) => {
      if (query.bodyParts?.[1].maxLength !== PROCESSING_SOURCE_LIMIT) return;
      if (change === 'fingerprint') client.folder.messages.get(uid).envelope.subject = 'Changed message';
      else if (change === 'validity') client.mailbox.uidValidity = 2n;
      else client.folder.messages.delete(uid);
    } });
    const result = await h.reader.readBatch(account, [reference(message)]);
    assert.deepEqual(result.messages, []); assert.equal(result.errors[0].code, 'stale_message');
    assert.equal(h.calls.some(call => ['seen', 'move', 'archive_label'].includes(call.action)), false);
  }
});

test('expanded fetch transport failures report a retryable read error without accepting an old prefix', async () => {
  const body = `<style>${'x'.repeat(BODY_SOURCE_LIMIT + 1000)}</style><p>Invoice.</p>`;
  const message = mail(1, { body, mime: 'Content-Type: text/html\r\n\r\n', bodyStructure: { part: '1', type: 'text/html', size: body.length } });
  const h = harness({ folders: [{ path: 'INBOX', messages: [message, mail(2)] }], onFetchOne: async (uid, query) => {
    if (query.bodyParts?.[1].maxLength === PROCESSING_SOURCE_LIMIT) throw new Error('private provider failure');
  } });
  const result = await h.reader.readBatch(account, [reference(message), reference(mail(2))]);
  assert.deepEqual(result.messages.map(value => value.reference.uid), [2]);
  assert.deepEqual(result.errors, [{ reference: reference(message), code: 'mailbox_error' }]);
  assert.equal(JSON.stringify(result).includes('private provider failure'), false);
  assert.equal(h.calls.some(call => ['seen', 'move', 'archive_label'].includes(call.action)), false);
});

test('cancellation during expansion discards both prefixes and closes the read-only session', async () => {
  const controller = new AbortController(), body = `<style>${'x'.repeat(BODY_SOURCE_LIMIT + 1000)}</style><p>Invoice.</p>`;
  const message = mail(1, { body, mime: 'Content-Type: text/html\r\n\r\n', bodyStructure: { part: '1', type: 'text/html', size: body.length } });
  const h = harness({ folders: [{ path: 'INBOX', messages: [message] }], onFetchOne: async (uid, query) => {
    if (query.bodyParts?.[1].maxLength === PROCESSING_SOURCE_LIMIT) controller.abort();
  } });
  await assert.rejects(h.reader.read(account, reference(message), { signal: controller.signal }), { code: 'cancelled' });
  assert.ok(h.clients.every(client => client.closed));
  assert.equal(h.calls.some(call => ['seen', 'move', 'archive_label'].includes(call.action)), false);
});

test('batch mark read revalidates each fingerprint and sends one STORE only for matching unread UIDs', async () => {
  const messages = [mail(1), mail(2, { flags: new Set(['\\Seen']) }), mail(3), mail(4)];
  const h = harness({ folders: [{ path: 'INBOX', messages: messages.slice(0, 3) }] });
  const references = messages.map(message => reference(message));
  h.state.folders[0].messages.get(3).envelope.subject = 'Changed envelope';
  const result = await h.reader.markRead(account, references, { verify });
  assert.deepEqual(result.results.map(result => [result.reference.uid, result.status]).sort((a, b) => a[0] - b[0]),
    [[1, 'applied'], [2, 'already_read'], [3, 'changed'], [4, 'absent']]);
  assert.deepEqual(h.calls.filter(call => call.action === 'seen'), [{ action: 'seen', path: 'INBOX', uids: [1] }]);
});

test('mutation account verification is mandatory and rechecked immediately before writing', async () => {
  const message = mail(1), h = harness();
  await assert.rejects(h.reader.markRead(account, [reference(message)]), { code: 'invalid_request' });
  await assert.rejects(h.reader.move(account, reference(message), 'trash'), { code: 'invalid_request' });
  let count = 0;
  await assert.rejects(h.reader.markRead(account, [reference(message)], { verify: async () => ++count < 2 }), { code: 'stale_message' });
  assert.equal(h.calls.some(call => call.action === 'seen'), false);
});

test('MOVE uses verified special destination and verifies COPYUID mapping after releasing source lock', async () => {
  const h = harness(), source = reference(mail(1));
  const result = await h.reader.move(account, source, 'trash', { verify });
  assert.equal(result.status, 'applied'); assert.equal(result.targetPath, 'Trash');
  assert.deepEqual(result.reference, { ...source, path: 'Trash' });
  assert.equal(h.state.folders[0].messages.has(1), false);
  assert.deepEqual(h.calls.filter(call => call.action === 'move'), [{ action: 'move', path: 'INBOX', target: 'Trash', uid: 1 }]);
  assert.equal((await h.reader.move(account, source, 'trash', { verify })).status, 'absent');
  assert.equal(h.calls.filter(call => call.action === 'move').length, 1, 'Missing source never causes a blind second move');
});

test('missing or changed COPYUID destination never fabricates a new reference or treats successful MOVE as retryable', async () => {
  for (const options of [{ noMapping: true }, { changedMove: true }]) {
    const h = harness(options), result = await h.reader.move(account, reference(mail(1)), 'archive', { verify });
    assert.equal(result.status, 'applied'); assert.equal(result.reference, null);
    assert.equal(h.calls.filter(call => call.action === 'move').length, 1);
  }
});

test('lost MOVE acknowledgement stops the batch and an absent source never proves success or causes a second move', async () => {
  const messages = [mail(1), mail(2)], persisted = [];
  const h = harness({ folders: [{ path: 'INBOX', messages }, { path: 'Trash', specialUse: '\\Trash' }],
    onMoveApplied: async () => { throw new Error('private lost acknowledgement'); } });
  await assert.rejects(h.reader.moveBatch(account, messages.map(message => ({ reference: reference(message), action: 'trash' })), {
    verify, onResult: async entry => persisted.push(entry)
  }), error => error.code === 'mailbox_error' && !error.message.includes('private'));
  assert.deepEqual(persisted, []);
  assert.equal(h.state.folders[0].messages.has(1), false); assert.equal(h.state.folders[0].messages.has(2), true);
  assert.equal((await h.reader.move(account, reference(messages[0]), 'trash', { verify })).status, 'absent');
  assert.deepEqual(h.calls.filter(call => call.action === 'move').map(call => call.uid), [1]);
});

test('destination read failure after an acknowledged MOVE preserves applied status with an unresolved destination', async () => {
  const h = harness({ onFetchOne: async (uid, query, client) => {
    if (client.folder.path === 'Trash') throw new Error('private destination timeout');
  } });
  const result = await h.reader.move(account, reference(mail(1)), 'trash', { verify });
  assert.equal(result.status, 'applied'); assert.equal(result.reference, null); assert.equal(result.targetPath, 'Trash');
  assert.deepEqual(h.calls.filter(call => call.action === 'move').map(call => call.uid), [1]);
});

test('stale UIDVALIDITY, changed fingerprint, absent message and read-only mailbox never move', async () => {
  for (const [config, ref, expected] of [
    [{}, reference(mail(1), 'INBOX', '9'), 'changed'],
    [{}, { ...reference(mail(1)), fingerprint: '0'.repeat(64) }, 'changed'],
    [{}, reference(mail(99)), 'absent'],
    [{ folders: [{ path: 'INBOX', readOnly: true, messages: [mail(1)] }, { path: 'Trash', specialUse: '\\Trash' }] }, reference(mail(1)), 'changed']
  ]) {
    const h = harness(config);
    assert.equal((await h.reader.move(account, ref, 'trash', { verify })).status, expected);
    assert.equal(h.calls.some(call => call.action === 'move'), false);
  }
});

test('no MOVE capability, ambiguous destinations and misleading folder names never trigger COPY/DELETE fallback', async () => {
  for (const config of [{ capabilities: [] },
    { folders: [{ path: 'INBOX', messages: [mail(1)] }, { path: 'Trash' }] },
    { folders: [{ path: 'INBOX', messages: [mail(1)] }, { path: 'Trash', specialUse: '\\Trash' }, { path: 'Bin', specialUse: '\\Trash' }] },
    { folders: [{ path: 'INBOX', messages: [mail(1)] }, { path: 'Trash', specialUse: '\\Sent' }] }]) {
    const h = harness(config);
    assert.equal((await h.reader.move(account, reference(mail(1)), 'trash', { verify })).status, 'target_unavailable');
    assert.equal(h.calls.some(call => call.action === 'move'), false);
  }
});

test('configured archive is allowed only for an ordinary selectable folder and never overrides Trash', async () => {
  const h = harness({ folders: [{ path: 'INBOX', messages: [mail(1)] }, { path: 'Saved mail' }, { path: 'Trash', specialUse: '\\Trash' }] });
  assert.equal((await h.reader.move({ ...account, archivePath: 'Trash' }, reference(mail(1)), 'archive', { verify })).status, 'target_unavailable');
  const result = await h.reader.move({ ...account, archivePath: 'Saved mail' }, reference(mail(1)), 'archive', { verify });
  assert.equal(result.status, 'applied'); assert.equal(result.targetPath, 'Saved mail');
});

test('Gmail archive only removes Inbox label, needs no MOVE, and supports stable All Mail references', async () => {
  const message = mail(1, { labels: new Set(['\\Inbox']) });
  const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX' }, { path: 'All', specialUse: '\\All', messages: [message] }] });
  const ref = reference(message, 'All');
  const result = await h.reader.move(account, ref, 'archive', { verify });
  assert.equal(result.status, 'applied'); assert.deepEqual(result.reference, ref);
  assert.equal((await h.reader.move(account, ref, 'archive', { verify })).status, 'already_target');
  assert.equal(h.calls.filter(call => call.action === 'archive_label').length, 1);
  assert.equal(h.calls.some(call => call.action === 'move'), false);
});

test('Gmail Inbox archive resolves its All Mail UID using exact Gmail message identity and fingerprint', async () => {
  const message = mail(1, { emailId: '17899912345678901', labels: new Set(['\\Inbox']) });
  const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [message] },
    { path: 'All', specialUse: '\\All', uidValidity: 2n, messages: [{ ...structuredClone(message), uid: 95 }] }] });
  const result = await h.reader.move(account, reference(message), 'archive', { verify });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.reference, { ...reference(message), path: 'All', uidValidity: '2', uid: 95 });
  assert.deepEqual(h.calls.filter(call => call.action === 'email_search').map(call => call.path), ['All', 'INBOX']);
  assert.equal(result.gmailEmailId, undefined);
});

test('Gmail archive treats exact selected Inbox membership as authoritative when its label is omitted', async () => {
  const message = mail(1, { emailId: '17899912345678901', labels: new Set() });
  const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [message] },
    { path: 'All', specialUse: '\\All', uidValidity: 2n, messages: [{ ...structuredClone(message), uid: 95, labels: new Set(['\\Inbox']) }] }] });
  const result = await h.reader.move(account, reference(message), 'archive', { verify });
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.reference, { ...reference(message), path: 'All', uidValidity: '2', uid: 95 });
  assert.equal(h.state.folders[0].messages.has(1), false);
  assert.deepEqual(h.calls.filter(call => call.action === 'archive_label').map(call => [call.path, call.uid]), [['All', 95]]);
  assert.equal(h.calls.filter(call => call.action === 'one' && call.path === 'INBOX').length, 2);
  assert.equal(h.calls.findLast(call => call.action === 'one').query.labels, true);
  assert.equal(h.calls.some(call => call.action === 'move'), false);
});

test('Gmail archive never checkpoints a no-op STORE while the verified message remains in Inbox', async () => {
  for (const labels of [new Set(), new Set(['\\Inbox'])]) {
    const message = mail(1, { emailId: '17899912345678901', labels });
    const h = harness({ archiveNoop: true, capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [message] },
      { path: 'All', specialUse: '\\All', messages: [{ ...structuredClone(message), uid: 95, labels: new Set(['\\Inbox']) }] }] });
    const persisted = [];
    await assert.rejects(h.reader.moveBatch(account, [{ reference: reference(message), action: 'archive' }], {
      verify, onResult: async entry => persisted.push(entry)
    }), { code: 'mailbox_error' });
    assert.deepEqual(persisted, []);
    assert.equal(h.calls.filter(call => call.action === 'archive_label').length, 1);
    assert.equal(h.state.folders[0].messages.has(1), true);
  }
});

test('Gmail archive verifies All Mail labels after STORE and preserves Sent and Draft membership', async () => {
  for (const protection of ['\\Sent', '\\Draft']) {
    const message = mail(1, { labels: new Set(['\\Inbox', protection]) });
    const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX' }, { path: 'All', specialUse: '\\All', messages: [message] }] });
    const ref = reference(message, 'All');
    assert.equal((await h.reader.move(account, ref, 'archive', { verify })).status, 'applied');
    assert.deepEqual([...h.state.folders[1].messages.get(1).labels], [protection]);
    assert.equal(h.calls.filter(call => call.action === 'one').length, 3);
  }
  const message = mail(1, { labels: new Set(['\\Inbox']) });
  const h = harness({ archiveNoop: true, capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX' },
    { path: 'All', specialUse: '\\All', messages: [message] }] });
  await assert.rejects(h.reader.move(account, reference(message, 'All'), 'archive', { verify }), { code: 'mailbox_error' });
});

test('Gmail archive does not turn post-STORE transport loss or UIDVALIDITY change into a successful checkpoint', async () => {
  for (const failure of ['lost_ack', 'validity']) {
    const message = mail(1, { emailId: '17899912345678901', labels: new Set() }), persisted = [];
    const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [message] },
      { path: 'All', specialUse: '\\All', messages: [{ ...structuredClone(message), uid: 95, labels: new Set(['\\Inbox']) }] }],
      onArchiveApplied: async (uid, client) => {
        if (failure === 'lost_ack') throw new Error('private lost acknowledgement');
        client.mailbox.uidValidity = 2n;
      } });
    await assert.rejects(h.reader.moveBatch(account, [{ reference: reference(message), action: 'archive' }], {
      verify, onResult: async entry => persisted.push(entry)
    }), { code: 'mailbox_error' });
    assert.deepEqual(persisted, []);
    assert.equal((await h.reader.move(account, reference(message), 'archive', { verify })).status, 'absent');
    assert.equal(h.calls.filter(call => call.action === 'archive_label').length, 1);
  }
});

test('Gmail archive retains uncertainty when All Mail reports Inbox membership after STORE', async () => {
  const message = mail(1, { emailId: '17899912345678901', labels: new Set() });
  const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [message] },
    { path: 'All', specialUse: '\\All', messages: [{ ...structuredClone(message), uid: 95 }] }],
    onFetchOne: async (uid, query, client) => {
      if (client.folder.path === 'All') client.folder.messages.get(uid).labels.add('\\Inbox');
    } });
  await assert.rejects(h.reader.move(account, reference(message), 'archive', { verify }), { code: 'mailbox_error' });
  assert.equal(h.state.folders[0].messages.has(1), false);
  assert.equal(h.calls.filter(call => call.action === 'archive_label').length, 1);
});

test('Gmail archive rejects missing, ambiguous, changed or unsafe All Mail aliases before mutation', async () => {
  for (const fault of ['missing_id', 'missing_alias', 'ambiguous_alias', 'fingerprint', 'email_id', 'labels', 'trash', 'read_only', 'validity']) {
    const message = mail(1, { emailId: '17899912345678901', labels: new Set() });
    const alias = { ...structuredClone(message), uid: 95, labels: new Set(['\\Inbox']) };
    const all = { path: 'All', specialUse: '\\All', messages: [alias] };
    const config = { capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [message] }, all] };
    if (fault === 'missing_id') delete message.emailId;
    if (fault === 'missing_alias') all.messages = [];
    if (fault === 'ambiguous_alias') all.messages.push({ ...structuredClone(alias), uid: 96 });
    if (fault === 'fingerprint') alias.envelope.subject = 'Different message';
    if (fault === 'email_id') { alias.emailId = '987654321'; config.emailSearchResult = [95]; }
    if (fault === 'labels') delete alias.labels;
    if (fault === 'trash') alias.labels.add('\\Trash');
    if (fault === 'read_only') all.readOnly = true;
    if (fault === 'validity') config.onFetchOne = async (uid, query, client) => { if (client.folder.path === 'All') client.mailbox.uidValidity = 2n; };
    const h = harness(config);
    assert.equal((await h.reader.move(account, reference(message), 'archive', { verify })).status, 'changed', fault);
    assert.equal(h.calls.some(call => ['archive_label', 'move'].includes(call.action)), false, fault);
    assert.equal(h.state.folders[0].messages.has(1), true, fault);
  }
});

test('Gmail archive through an All Mail alias preserves Sent, Draft and custom-folder membership', async () => {
  for (const [path, specialUse, protection] of [['Sent', '\\Sent', '\\Sent'], ['Drafts', '\\Drafts', '\\Draft'], ['Project', undefined, 'Project']]) {
    const message = mail(1, { emailId: '17899912345678901', labels: new Set(['\\Inbox', protection, 'Keep me']) });
    const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path, specialUse, messages: [message] },
      { path: 'INBOX', messages: [{ ...structuredClone(message), uid: 2 }] },
      { path: 'All', specialUse: '\\All', messages: [{ ...structuredClone(message), uid: 95 }] }] });
    const result = await h.reader.move(account, reference(message, path), 'archive', { verify });
    assert.equal(result.status, 'applied'); assert.equal(result.reference.path, 'All'); assert.equal(result.reference.uid, 95);
    assert.deepEqual(h.calls.filter(call => call.action === 'archive_label').map(call => [call.path, call.uid]), [['All', 95]]);
    assert.deepEqual([...h.state.folders[0].messages.get(1).labels], [protection, 'Keep me']);
    assert.deepEqual([...h.state.folders[2].messages.get(95).labels], [protection, 'Keep me']);
    assert.equal(h.state.folders[1].messages.size, 0);
    assert.equal(h.calls.some(call => call.action === 'move'), false);
  }
});

test('Gmail archive cannot accept absent All Mail Inbox label over a still-present exact Inbox member', async () => {
  const message = mail(1, { emailId: '17899912345678901', labels: new Set() });
  const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [message] },
    { path: 'All', specialUse: '\\All', messages: [{ ...structuredClone(message), uid: 95 }] }] });
  await assert.rejects(h.reader.move(account, reference(message), 'archive', { verify }), { code: 'mailbox_error' });
  assert.equal(h.calls.some(call => call.action === 'archive_label'), false);
  assert.deepEqual(h.calls.filter(call => call.action === 'open').map(call => [call.path, call.readOnly]),
    [['INBOX', false], ['All', false], ['INBOX', true]]);
});

test('Gmail archive verifies fresh Inbox UIDVALIDITY and detects the same message re-added under another UID', async () => {
  for (const fault of ['source_validity', 'readded_identity', 'retention_label']) {
    const message = mail(1, { emailId: '17899912345678901', labels: new Set() });
    const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [message] },
      { path: 'All', specialUse: '\\All', messages: [{ ...structuredClone(message), uid: 95, labels: new Set(['\\Inbox', '\\Sent']) }] }],
      onArchiveApplied: async (uid, client) => {
        if (fault === 'source_validity') h.state.folders[0].uidValidity = 2n;
        if (fault === 'readded_identity') h.state.folders[0].messages.set(2, { ...structuredClone(message), uid: 2 });
        if (fault === 'retention_label') client.folder.messages.get(uid).labels.delete('\\Sent');
      } });
    const persisted = [];
    await assert.rejects(h.reader.moveBatch(account, [{ reference: reference(message), action: 'archive' }], {
      verify, onResult: async entry => persisted.push(entry)
    }), { code: 'mailbox_error' });
    assert.deepEqual(persisted, [], fault);
    assert.equal(h.calls.filter(call => call.action === 'archive_label').length, 1, fault);
    assert.equal(h.state.folders[0].messages.has(1), false, fault);
  }
});

test('Gmail alias archive checks account revision and target UIDVALIDITY after awaiting authorization', async () => {
  for (const fault of ['revision', 'validity', 'read_only']) {
    const message = mail(1, { emailId: '17899912345678901', labels: new Set() });
    let targetClient;
    const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [message] },
      { path: 'All', specialUse: '\\All', messages: [{ ...structuredClone(message), uid: 95, labels: new Set(['\\Inbox']) }] }],
      onFetchOne: async (uid, query, client) => { if (client.folder.path === 'All') targetClient = client; } });
    await assert.rejects(h.reader.move(account, reference(message), 'archive', { verify: async () => {
      if (!targetClient) return true;
      if (fault === 'revision') return false;
      if (fault === 'validity') targetClient.mailbox.uidValidity = 2n;
      if (fault === 'read_only') targetClient.mailbox.readOnly = true;
      return true;
    } }), { code: 'stale_message' });
    assert.equal(h.calls.some(call => call.action === 'archive_label'), false, fault);
  }
});

test('single-UID verification consumes full FETCH stream without trusting unsolicited rows', async () => {
  const message = mail(1), h = harness({ beforeSingleRows: [mail(99), { uid: 1, flags: new Set() }],
    afterSingleRows: [{ uid: 99, flags: new Set(['\\Deleted']) }] });
  assert.equal((await h.reader.read(account, reference(message))).body, 'Message body');
  assert.equal((await h.reader.move(account, reference(message), 'trash', { verify })).status, 'applied');
  assert.deepEqual(h.calls.filter(call => call.action === 'move').map(call => call.uid), [1]);
});

test('single-UID verification distinguishes absence from partial-only rows and refuses conflicting immutable data', async () => {
  const missing = harness({ folders: [{ path: 'INBOX' }, { path: 'Trash', specialUse: '\\Trash' }], beforeSingleRows: [mail(99)] });
  assert.equal((await missing.reader.move(account, reference(mail(1)), 'trash', { verify })).status, 'absent');
  const partial = harness({ folders: [{ path: 'INBOX' }, { path: 'Trash', specialUse: '\\Trash' }], beforeSingleRows: [{ uid: 1, flags: new Set() }] });
  assert.equal((await partial.reader.move(account, reference(mail(1)), 'trash', { verify })).status, 'changed');
  const deleted = harness({ afterSingleRows: [{ uid: 1, flags: new Set(['\\Deleted']) }] });
  assert.equal((await deleted.reader.move(account, reference(mail(1)), 'trash', { verify })).status, 'changed');
  const conflict = harness({ afterSingleRows: [mail(1, { envelope: { ...mail(1).envelope, subject: 'Other identity' } })] });
  await assert.rejects(conflict.reader.move(account, reference(mail(1)), 'trash', { verify }), { code: 'stale_message' });
  for (const h of [missing, partial, deleted, conflict]) assert.equal(h.calls.some(call => call.action === 'move'), false);
});

test('single-UID body expansion keeps fetched parts through later flags-only rows and rejects deletion', async () => {
  for (const deleted of [false, true]) {
    const body = `<style>${'x'.repeat(BODY_SOURCE_LIMIT + 1000)}</style><p>Invoice. Due 2027-01-01.</p>`;
    const message = mail(1, { body, mime: 'Content-Type: text/html\r\n\r\n', bodyStructure: { part: '1', type: 'text/html', size: body.length } });
    let expanded = false;
    const h = harness({ folders: [{ path: 'INBOX', messages: [message] }],
      onFetchOne: async (uid, query) => { expanded = query.bodyParts?.[1].maxLength === PROCESSING_SOURCE_LIMIT; },
      afterSingleRows: () => expanded ? [{ uid: 1, flags: new Set([deleted ? '\\Deleted' : '\\Seen']) }] : [] });
    if (deleted) await assert.rejects(h.reader.read(account, reference(message)), { code: 'stale_message' });
    else {
      const result = await h.reader.read(account, reference(message));
      assert.equal(result.body, 'Invoice. Due 2027-01-01.');
      assert.equal(result.truncated, false); assert.deepEqual(result.contentReasons, []);
    }
    assert.deepEqual(h.calls.filter(call => call.action === 'body').map(call => call.query.bodyParts[1].maxLength), [BODY_SOURCE_LIMIT, PROCESSING_SOURCE_LIMIT]);
    assert.equal(h.calls.some(call => ['seen', 'archive_label', 'move'].includes(call.action)), false);
  }
});

test('junk rescue moves only a verified Junk message to protocol INBOX and never rescues Trash or other folders', async () => {
  const h = harness({ folders: [{ path: 'INBOX' }, { path: 'Spam', specialUse: '\\Junk', messages: [mail(1)] },
    { path: 'Trash', specialUse: '\\Trash', messages: [mail(2)] }, { path: 'Custom', messages: [mail(3)] }] });
  assert.equal((await h.reader.move(account, reference(mail(2), 'Trash'), 'rescue', { verify })).status, 'changed');
  assert.equal((await h.reader.move(account, reference(mail(3), 'Custom'), 'rescue', { verify })).status, 'changed');
  const result = await h.reader.move(account, reference(mail(1), 'Spam'), 'rescue', { verify });
  assert.equal(result.status, 'applied'); assert.equal(result.targetPath, 'INBOX');
  assert.deepEqual(h.calls.filter(call => call.action === 'move'), [{ action: 'move', path: 'Spam', target: 'INBOX', uid: 1 }]);
});

test('cancellation between revalidation and mutation closes session without a write', async () => {
  const controller = new AbortController(), h = harness();
  let calls = 0;
  await assert.rejects(h.reader.move(account, reference(mail(1)), 'trash', { signal: controller.signal,
    verify: async () => { if (++calls === 3) controller.abort(); } }), { code: 'cancelled' });
  assert.equal(h.calls.filter(call => call.action === 'one').length, 1);
  assert.equal(h.calls.some(call => call.action === 'move'), false); assert.ok(h.clients.every(client => client.closed));
});

test('moveBatch reuses one session and persists each outcome before issuing the next mutation', async () => {
  const messages = [mail(1), mail(2)], h = harness({ folders: [{ path: 'INBOX', messages }, { path: 'Trash', specialUse: '\\Trash' }] });
  const persisted = [];
  const result = await h.reader.moveBatch(account, messages.map(message => ({ reference: reference(message), action: 'trash' })), {
    verify, onResult: async entry => {
      persisted.push(entry.reference.uid);
      assert.equal(h.calls.filter(call => call.action === 'move').length, persisted.length);
    }
  });
  assert.equal(h.clients.length, 1); assert.equal(h.calls.filter(call => call.action === 'list').length, 1);
  assert.deepEqual(persisted, [1, 2]);
  assert.ok(result.results.every(entry => entry.result.status === 'applied' && entry.result.reference.path === 'Trash'));
});

test('moveBatch stops after a failed result journal callback instead of proceeding with unrecorded actions', async () => {
  const messages = [mail(1), mail(2)], h = harness({ folders: [{ path: 'INBOX', messages }, { path: 'Trash', specialUse: '\\Trash' }] });
  await assert.rejects(h.reader.moveBatch(account, messages.map(message => ({ reference: reference(message), action: 'trash' })), {
    verify, onResult: async () => { throw new Error('private journal error'); }
  }), { code: 'mailbox_error' });
  assert.deepEqual(h.calls.filter(call => call.action === 'move').map(call => call.uid), [1]);
  assert.ok(h.state.folders[0].messages.has(2));
});

test('missing Gmail labels do not silently downgrade Sent retention or claim an archive succeeded', async () => {
  const message = mail(1, { labels: undefined });
  const h = harness({ capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [message] }, { path: 'All', specialUse: '\\All' }] });
  await assert.rejects(h.reader.scan(account, { path: 'INBOX' }), { code: 'mailbox_error' });
  assert.equal((await h.reader.move(account, reference(message), 'archive', { verify })).status, 'changed');
  assert.equal(h.calls.some(call => call.action === 'archive_label'), false);
});

test('provider errors and account revision failures return sanitized errors without secrets', async () => {
  const h = harness({ onConnect: async () => { throw new Error('private-secret provider response'); } });
  await assert.rejects(h.reader.folders(account), error => error.code === 'mailbox_error' && !error.message.includes('private-secret'));
  const revision = harness();
  await assert.rejects(revision.reader.move(account, reference(mail(1)), 'trash', {
    verify: async () => { throw new MailHarborError('stale_message', 'private-secret revision'); }
  }), error => error.code === 'stale_message' && !error.message.includes('private-secret'));
  assert.equal(revision.calls.length, 0);
});

test('notification baseline uses UIDNEXT without fetching or marking historical messages', async () => {
  for (const uidNext of [1, 51, 0x100000000]) {
    const h = harness({ folders: [{ path: 'INBOX', uidValidity: 777n, uidNext, messages: [] }] });
    let verifications = 0;
    assert.deepEqual(await h.reader.checkpoint(account, { verify: () => { verifications++; return true; } }),
      { path: 'INBOX', uidValidity: '777', afterUid: uidNext - 1 });
    assert.equal(verifications, 2);
    assert.deepEqual(h.calls, [{ action: 'open', path: 'INBOX', readOnly: true }]);
    assert.ok(h.clients.every(client => client.closed && !client.locked));
  }
});

test('notification baseline rejects invalid UIDNEXT and checks account identity around the read-only lock', async () => {
  for (const uidNext of [0, -1, 1.5, NaN, 0x100000001]) {
    const h = harness({ folders: [{ path: 'INBOX', uidNext }] });
    await assert.rejects(h.reader.checkpoint(account), { code: 'mailbox_error' });
    assert.equal(h.calls.some(call => ['search', 'fetch', 'body', 'seen', 'move'].includes(call.action)), false);
  }
  for (const failAt of [1, 2]) {
    const h = harness(); let checks = 0;
    await assert.rejects(h.reader.checkpoint(account, { verify: () => ++checks !== failAt }), { code: 'stale_message' });
    assert.ok(h.clients.every(client => client.closed && !client.locked));
    assert.equal(h.calls.length, failAt === 1 ? 0 : 1);
  }
});

test('notification capture reads bounded ordered headers and current body without changing Seen', async () => {
  const rawHeaders = 'Received: from relay.example.test by mail.example.test\r\nReceived-SPF: pass; receiver=relay.example.test\r\nFrom: Sender <sender@example.test>\r\nSubject: Message 1\r\n\r\n';
  for (const notificationHeaderMap of [false, true]) {
    const message = mail(1, { notificationHeaders: rawHeaders });
    const h = harness({ folders: [{ path: 'INBOX', messages: [message] }], notificationHeaderMap,
      beforeSingleRows: [mail(99), { uid: 1, flags: new Set() }], afterSingleRows: [{ uid: 1, flags: new Set() }] });
    let checks = 0;
    const result = await h.reader.readNotification(account, reference(message), { verify: () => { checks++; return true; } });
    assert.equal(result.headers, rawHeaders); assert.equal(result.body, 'Message body');
    assert.equal(result.bodyUnavailable, false); assert.equal(result.truncated, false); assert.equal(result.unread, true);
    assert.deepEqual(result.reference, reference(message)); assert.equal(result.receivedAt, '2026-09-01T10:00:00.000Z');
    assert.deepEqual(h.calls.filter(call => ['notification_header', 'body'].includes(call.action)).map(call => call.action), ['notification_header', 'body']);
    assert.ok(h.calls.filter(call => call.action === 'open').every(call => call.readOnly === true));
    assert.equal(h.calls.some(call => ['seen', 'move', 'archive_label'].includes(call.action)), false);
    assert.equal(h.state.folders[0].messages.get(1).flags.has('\\Seen'), false);
    assert.equal(checks, 2); assert.ok(h.clients.every(client => client.closed && !client.locked));
  }
});

test('notification header input is bounded independently from body limits', async () => {
  const message = mail(1, { notificationHeaders: 'X-Fill: ' + 'x'.repeat(50000) });
  const h = harness({ folders: [{ path: 'INBOX', messages: [message] }] });
  const result = await h.reader.readNotification(account, reference(message));
  assert.equal(Buffer.byteLength(result.headers), 32768); assert.equal(result.body, 'Message body');
  assert.equal(h.calls.find(call => call.action === 'notification_header').query.bodyParts[0].maxLength, 32768);
});

test('notification capture rejects changed message identity, UIDVALIDITY and account revision without releasing a body', async () => {
  const message = mail(1);
  const changed = harness({ folders: [{ path: 'INBOX', messages: [mail(1, { envelope: { ...message.envelope, subject: 'Replacement' } })] }] });
  await assert.rejects(changed.reader.readNotification(account, reference(message)), { code: 'stale_message' });
  assert.equal(changed.calls.some(call => call.action === 'body'), false);
  const replacedMailbox = harness({ folders: [{ path: 'INBOX', uidValidity: 2n, messages: [message] }] });
  await assert.rejects(replacedMailbox.reader.readNotification(account, reference(message)), { code: 'stale_message' });
  assert.equal(replacedMailbox.calls.some(call => call.action === 'notification_header'), false);
  for (const failAt of [1, 2]) {
    const h = harness(); let checks = 0;
    await assert.rejects(h.reader.readNotification(account, reference(message), { verify: () => ++checks !== failAt }), { code: 'stale_message' });
    assert.equal(h.calls.some(call => ['seen', 'move', 'archive_label'].includes(call.action)), false);
    assert.ok(h.clients.every(client => client.closed && !client.locked));
  }
});

test('notification capture rejects conflicting full responses and deletion during body capture', async () => {
  for (const fault of ['conflicting', 'deleted']) {
    const message = mail(1), other = mail(1, { envelope: { ...message.envelope, subject: 'Different message' } });
    const h = harness({ afterSingleRows: fault === 'conflicting' ? [other] : [{ uid: 1, flags: new Set(['\\Deleted']) }] });
    await assert.rejects(h.reader.readNotification(account, reference(message)), { code: 'stale_message' });
    assert.equal(h.calls.some(call => ['seen', 'move', 'archive_label'].includes(call.action)), false);
  }
});

test('notification baseline and capture recheck mailbox identity after awaited authorization', async () => {
  for (const operation of ['checkpoint', 'readNotification']) {
    const h = harness(); let checks = 0;
    const options = { verify: async () => {
      if (++checks === 2) { await Promise.resolve(); h.clients.at(-1).mailbox.uidValidity = 2n; }
      return true;
    } };
    const run = operation === 'checkpoint' ? h.reader.checkpoint(account, options) : h.reader.readNotification(account, reference(mail(1)), options);
    await assert.rejects(run, { code: 'stale_message' });
    assert.equal(h.calls.some(call => ['seen', 'move', 'archive_label'].includes(call.action)), false);
    assert.ok(h.clients.every(client => client.closed && !client.locked));
  }
});
