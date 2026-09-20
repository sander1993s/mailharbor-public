import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMailboxService, createMailboxSession, safeMailboxDiagnostic } from '../server/mailboxes.mjs';
import { validateRequest, MailHarborError } from '../server/validation.mjs';
import { searchCompiler } from '../node_modules/imapflow/dist/esm/search-compiler.js';
import fetchCommand from '../node_modules/imapflow/dist/esm/commands/fetch.js';
import storeCommand from '../node_modules/imapflow/dist/esm/commands/store.js';

const TEST_NOW = Date.parse('2026-09-09T12:00:00Z');
const DAY = 86_400_000;

function mail(uid, overrides = {}) {
  return {
    uid, size: 100, internalDate: new Date(Date.UTC(2020, 0, 1) + uid * 1000), flags: new Set(),
    envelope: { date: new Date(Date.UTC(2020, 0, 1) + uid * 1000), messageId: `<${uid}@example.test>`,
      from: [{ name: 'Sender', address: 'sender@example.test' }], subject: `Message ${uid}` },
    bodyStructure: { type: 'text/plain', part: '1', size: 12 }, body: 'Message body', labels: new Set(['\\Inbox']), ...overrides
  };
}

function partFor(message, section) {
  if (section === 'text') return message.bodyStructure;
  let found;
  const visit = node => { if (node?.part === section) found = node; for (const child of node?.childNodes ?? []) visit(child); };
  visit(message.bodyStructure);
  return found;
}

function mimeFor(message, part) {
  if (message.mime) return Buffer.from(message.mime);
  const meta = message.meta ?? {};
  let type = meta.contentType ?? part.type;
  for (const [key, value] of Object.entries({ ...part.parameters, ...(meta.charset ? { charset: meta.charset } : {}) })) type += `; ${key}="${value}"`;
  const disposition = meta.disposition ?? part.disposition ?? 'inline';
  const filename = meta.filename ?? part.dispositionParameters?.filename;
  return Buffer.from(`Content-Type: ${type}\r\nContent-Transfer-Encoding: ${meta.encoding ?? part.encoding ?? '7bit'}\r\nContent-Disposition: ${disposition}${filename ? `; filename="${filename}"` : ''}\r\n\r\n`);
}

function harness(input = {}, serviceOptions = {}) {
  const accounts = Object.keys(input).map(id => ({ id, email: `${id}@example.test` }));
  const states = Object.fromEntries(accounts.map(account => [account.id, {
    messages: new Map((input[account.id].messages ?? [mail(1)]).map(message => [message.uid, message])),
    folders: [{ path: 'INBOX', flags: new Set() }, { path: 'Archive', specialUse: '\\Archive', flags: new Set() }],
    capabilities: ['MOVE'], uidValidity: 1n, ...input[account.id]
  }]));
  // Convert the fixture array after spreading configuration above.
  for (const state of Object.values(states)) state.messages = new Map(Array.isArray(state.messages) ? state.messages.map(message => [message.uid, message]) : state.messages);
  const clients = [], calls = [];
  class Client extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.state = states[options.auth.user];
      this.capabilities = new Map(this.state.capabilities.map(name => [name, true]));
      this.fetching = false; this.closed = false;
      clients.push(this);
    }
    async connect() {
      await this.state.onConnect?.(this);
      if (this.state.connectError) throw this.state.connectError;
    }
    close() { this.closed = true; calls.push(['close', this.options.auth.user]); }
    command() { assert.equal(this.fetching, false, 'No IMAP command may run within fetch iterator'); }
    async list() { this.command(); return this.state.folders; }
    async getMailboxLock(path, options) {
      this.command(); assert.equal(path, 'INBOX');
      this.mailbox = { path, uidValidity: this.state.uidValidity, readOnly: options.readOnly };
      calls.push(['open', this.options.auth.user, options.readOnly]);
      return { release() {} };
    }
    async search(query, options) {
      this.command(); assert.deepEqual(options, { uid: true });
      if (query.or) assert.deepEqual(Object.keys(query), ['or']);
      else assert.deepEqual(query, { seen: false, deleted: false });
      calls.push(['search', this.options.auth.user, query]);
      if (query.or && this.state.rejectWindowSearch) return false;
      this.state.beforeSearch?.(query, this);
      const day = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ''; };
      const result = [...this.state.messages.values()].filter(message => query.or || (!message.flags.has('\\Seen') && !message.flags.has('\\Deleted')))
        .filter(message => !query.or || query.or.some(part => part.sentSince ?
          (message.sentCalendarDate ?? day(message.envelope?.date)) >= day(part.sentSince) :
          (message.internalCalendarDate ?? day(message.internalDate)) >= day(part.since)))
        .map(message => message.uid);
      return this.state.onSearch?.(query, result, this) ?? result;
    }
    async *fetch(range, query, options) {
      this.command(); assert.equal(this.mailbox.readOnly, true); assert.equal(options.uid, true);
      assert.equal(query.source, undefined);
      const uids = range.split(',').map(Number); assert.ok(uids.length <= 250);
      const phase = query.bodyParts ? 'bodies' : query.bodyStructure ? 'metadata' : 'headers';
      calls.push([phase, this.options.auth.user, uids.length, uids]);
      if (phase !== 'headers') assert.ok(uids.length <= 40);
      if (phase === 'bodies') {
        assert.equal(options.binary, false);
        assert.equal(query.bodyParts.length, 2);
        assert.equal(query.bodyParts[0].start, 0); assert.equal(query.bodyParts[0].maxLength, 16384);
        assert.equal(query.bodyParts[1].start, 0); assert.equal(query.bodyParts[1].maxLength, 65536);
      }
      this.fetching = true;
      try {
        for (const uid of uids) {
          if (phase === 'headers') this.state.beforeHeader?.(this, uid);
          if (phase === 'metadata') this.state.beforeMetadata?.(this, uid);
          if (phase === 'bodies') this.state.beforeBody?.(this, uid);
          const original = this.state.messages.get(uid);
          if (!original) continue;
          const message = { ...original, flags: new Set(original.flags), envelope: structuredClone(original.envelope), bodyStructure: structuredClone(original.bodyStructure) };
          if (phase === 'bodies') {
            const [mimeQuery, bodyQuery] = query.bodyParts;
            const section = bodyQuery.key;
            const part = partFor(message, section);
            assert.ok(part, 'Only a real selected MIME section may be requested');
            assert.equal(mimeQuery.key, section === 'text' ? 'header' : `${section}.mime`);
            const raw = Buffer.from(message.partBodies?.[section] ?? message.rawBody ?? message.body);
            const mime = mimeFor(message, part).subarray(0, mimeQuery.maxLength);
            message.bodyParts = new Map([[section, raw.subarray(0, bodyQuery.maxLength)]]);
            if (section === 'text') message.headers = mime; else message.bodyParts.set(mimeQuery.key, mime);
            calls.push(['body', this.options.auth.user, uid, section === 'text' ? '1' : section]);
          }
          yield message;
          if (this.state.duplicateFetch && phase !== 'headers') yield message;
        }
      }
      finally { this.fetching = false; }
    }
    async fetchOne(uid, query, options) {
      this.command(); assert.equal(options.uid, true); assert.equal(query.source, undefined);
      this.state.onFetchOne?.(this, Number(uid), query);
      return this.state.messages.get(Number(uid)) || false;
    }
    async download() { assert.fail('Per-message downloads must be replaced by bounded grouped FETCHes'); }
    async messageFlagsAdd(uid, flags, options) {
      this.command(); assert.equal(this.mailbox.readOnly, false); assert.deepEqual(flags, ['\\Seen']); assert.deepEqual(options, { uid: true });
      calls.push(['mark_read', this.options.auth.user, Number(uid)]);
      this.state.messages.get(Number(uid)).flags.add('\\Seen'); return true;
    }
    async messageFlagsRemove(uid, flags, options) {
      this.command(); assert.equal(this.mailbox.readOnly, false); assert.deepEqual(flags, ['\\Inbox']);
      assert.deepEqual(options, { uid: true, useLabels: true });
      calls.push(['labels', this.options.auth.user, Number(uid)]);
      this.state.messages.delete(Number(uid)); return true;
    }
    async messageMove(uid, path, options) {
      this.command(); assert.equal(this.mailbox.readOnly, false); assert.equal(options.uid, true);
      assert.ok(this.capabilities.has('MOVE')); calls.push(['move', this.options.auth.user, Number(uid), path]);
      if (this.state.moveFails) return false;
      this.state.messages.delete(Number(uid)); return { destination: path, uidMap: new Map([[Number(uid), 999]]) };
    }
    async messageDelete() { assert.fail('Permanent deletion or EXPUNGE must never be called'); }
    async mailboxClose() { assert.fail('CLOSE may expunge messages and must never be called'); }
  }
  const service = createMailboxService({ connectionOptions: async account => ({
    host: 'imap.example.test', auth: { user: account.id, pass: 'fixture-secret' }, logger: true, logRaw: true,
    tls: { rejectUnauthorized: false }, secure: false
  }), createClient: options => new Client(options), now: () => TEST_NOW, ...serviceOptions });
  return { service, accounts, states, clients, calls };
}

test('large inbox scan examines every unread header and downloads only the globally newest 40', async () => {
  const old = Array.from({ length: 46010 }, (_, i) => mail(i + 1));
  // The largest UID is not necessarily the most recent message.
  old[0] = mail(1, { envelope: { ...old[0].envelope, date: new Date('2026-09-09T12:00:00Z') } });
  const h = harness({ private: { messages: old }, business: { messages: [mail(1, {
    envelope: { date: 'invalid', subject: 'Fresh', messageId: '<fresh@example.test>' }, internalDate: new Date('2026-09-09T13:00:00Z')
  })] } });
  const progress = [];
  const result = await h.service.scan(h.accounts, { onProgress: item => progress.push(item) });
  assert.equal(result.messages.length, 40); assert.equal(result.references.size, 40);
  assert.equal(result.totalUnread, 46011); assert.equal(result.inboxCount, 2); assert.equal(result.truncated, true);
  assert.equal(result.messages[0].account, 'business@example.test'); assert.equal(result.messages[1].subject, 'Message 1');
  assert.equal(result.messages[0].date, '2026-09-09T13:00:00.000Z');
  assert.equal(h.calls.filter(call => call[0] === 'body').length, 40);
  assert.equal(h.calls.filter(call => call[0] === 'headers').reduce((sum, call) => sum + call[2], 0), 46011);
  assert.ok(h.calls.filter(call => call[0] === 'open').every(call => call[2] === true));
  assert.equal([...h.states.private.messages.values()].filter(message => message.flags.has('\\Seen')).length, 0);
  assert.equal(progress.at(-1).read, 40); assert.equal(progress.at(-1).checked, 46011);
  assert.ok(result.messages.every(message => /^[a-f0-9-]{36}$/u.test(message.id)));
  assert.doesNotThrow(() => validateRequest({ messages: result.messages }));
  assert.ok(h.clients.every(client => client.closed && client.options.secure && client.options.logger === false && client.options.logRaw === false && client.options.tls.rejectUnauthorized));
});

test('30k old messages need only recent envelope fetches, with sparse old UIDs, date fallback and snapshot deduplication', async () => {
  const messages = Array.from({ length: 30500 }, (_, index) => mail(index + 1));
  for (let index = 0; index < 50; index++) messages[index].envelope.date = new Date(TEST_NOW - index * 60000);
  messages[1].envelope.date = undefined;
  messages[1].internalDate = new Date(TEST_NOW + 60000);
  const h = harness({ a: { messages,
    beforeSearch: (query, client) => { if (query.or) client.state.messages.get(1).flags.add('\\Seen'); },
    beforeHeader: (client, uid) => { if (uid === 1) client.state.messages.get(1).flags.delete('\\Seen'); },
    onSearch: (query, result, client) => {
      if (!query.or) client.state.messages.set(999999, mail(999999, { envelope: { date: new Date(TEST_NOW + DAY) } }));
      return query.or ? [...result, ...result.slice(0, 2)] : result;
    }
  }, b: { messages: [mail(1, { envelope: {}, internalDate: new Date(TEST_NOW + 120000) })] } });
  const progress = [];
  const scan = await h.service.scan(h.accounts, { onProgress: value => progress.push(value) });
  assert.equal(scan.totalUnread, 30501); assert.equal(scan.inboxCount, 2); assert.equal(scan.messages.length, 40);
  assert.deepEqual([...scan.references.values()].slice(0, 3).map(value => [value.accountId, value.uid]), [['a', 2], ['a', 1], ['a', 3]]);
  // references are inserted by account; output is sorted globally, so the other account's newer message leads.
  assert.equal(scan.messages[0].account, 'b@example.test');
  assert.equal(scan.messages[1].date, new Date(TEST_NOW + 60000).toISOString());
  assert.ok([...scan.references.values()].every(value => value.uid !== 999999));
  assert.equal(new Set([...scan.references.values()].map(value => `${value.accountId}:${value.uid}`)).size, 40);
  const headerCalls = h.calls.filter(call => call[0] === 'headers');
  assert.equal(headerCalls.length, 2); assert.equal(headerCalls.reduce((sum, call) => sum + call[2], 0), 51);
  assert.equal(h.calls.filter(call => call[0] === 'body').length, 40);
  assert.equal(h.calls.filter(call => call[0] === 'search' && call[2].or).length, 1);
  assert.ok(progress.some(value => value.checked === 0 && value.totalUnread === 30500));
  assert.equal(progress.at(-1).checked, 51);
});

test('five-day zone bound widens for an excluded Date with a -9959 offset instead of stopping too early', async () => {
  const messages = Array.from({ length: 300 }, (_, index) => mail(index + 1));
  for (let index = 0; index < 40; index++) {
    messages[index].envelope.date = new Date('2026-09-04T12:00:00Z');
    messages[index].sentCalendarDate = '2026-09-04';
  }
  messages[299].envelope.date = 'Tue, 01 Sep 2026 23:59:00 -9959';
  messages[299].sentCalendarDate = '2026-09-01';
  const h = harness({ a: { messages } });
  const scan = await h.service.scan(h.accounts);
  const first = scan.references.get(scan.messages[0].id);
  assert.equal(first.uid, 300);
  assert.equal(scan.messages[0].date, '2026-09-06T03:58:00.000Z');
  assert.equal(h.calls.filter(call => call[0] === 'search' && call[2].or).length, 2);
  assert.equal(h.calls.filter(call => call[0] === 'headers').reduce((sum, call) => sum + call[2], 0), 41);
  assert.equal(new Set([...scan.references.values()].map(value => value.uid)).size, 40);
});

test('all-old inbox exhausts date windows then fetches the complete remaining snapshot', async () => {
  const messages = Array.from({ length: 300 }, (_, index) => mail(index + 1, {
    envelope: { date: new Date(Date.UTC(2000, 0, 1) + index * 1000) }, internalDate: new Date('2000-01-01T00:00:00Z')
  }));
  const h = harness({ a: { messages } }); const scan = await h.service.scan(h.accounts);
  assert.equal(h.calls.filter(call => call[0] === 'search' && call[2].or).length, 5);
  assert.equal(h.calls.filter(call => call[0] === 'headers').reduce((sum, call) => sum + call[2], 0), 300);
  assert.equal(scan.references.get(scan.messages[0].id).uid, 300);
  assert.equal(scan.messages.length, 40);
});

test('an unsupported date search falls back to all original unread headers without hiding mail', async () => {
  const h = harness({ a: { messages: Array.from({ length: 300 }, (_, index) => mail(index + 1)), rejectWindowSearch: true } });
  const scan = await h.service.scan(h.accounts);
  assert.equal(h.calls.filter(call => call[0] === 'search' && call[2].or).length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'headers').reduce((sum, call) => sum + call[2], 0), 300);
  assert.equal(scan.totalUnread, 300); assert.equal(scan.messages.length, 40);
});

test('few unread messages scan completely without window queries or padding to forty', async () => {
  const h = harness({ a: { messages: Array.from({ length: 8 }, (_, index) => mail(index + 1)) } });
  const scan = await h.service.scan(h.accounts);
  assert.equal(scan.messages.length, 8); assert.equal(scan.truncated, false);
  assert.equal(h.calls.filter(call => call[0] === 'search').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'body').length, 8);
});

test('cancellation during a window search stops before header or body reads', async () => {
  const aborter = new AbortController();
  const h = harness({ a: { messages: Array.from({ length: 300 }, (_, index) => mail(index + 1)),
    onSearch: query => { if (query.or) aborter.abort(); } } });
  await assert.rejects(h.service.scan(h.accounts, { signal: aborter.signal }), { code: 'cancelled' });
  assert.equal(h.calls.filter(call => ['headers', 'body', 'mark_read', 'move'].includes(call[0])).length, 0);
  assert.ok(h.clients.every(client => client.closed));
});

test('the session deadline reports a distinct timeout and closes the client', async () => {
  const h = harness({ a: { onConnect: () => new Promise(resolve => setTimeout(resolve, 60)) } }, { sessionTimeoutMs: 15 });
  await assert.rejects(h.service.scan(h.accounts), { code: 'mailbox_timeout' });
  assert.ok(h.clients.every(client => client.closed));
  assert.equal(h.calls.filter(call => ['headers', 'body', 'mark_read', 'move'].includes(call[0])).length, 0);
});

test('pinned ImapFlow compiles both standard and WITHIN window searches using the public API', () => {
  const date = new Date('2026-09-02T00:00:00Z');
  const compile = capabilities => searchCompiler({ capabilities: new Map(capabilities.map(value => [value, true])),
    enabled: new Set(), mailbox: { flags: new Set(), permanentFlags: new Set() } }, { or: [{ sentSince: date }, { since: date }] });
  const normal = JSON.stringify(compile([]));
  assert.match(normal, /SENTSINCE/u); assert.match(normal, /"SINCE"/u); assert.doesNotMatch(normal, /YOUNGER/u);
  const within = JSON.stringify(compile(['WITHIN']));
  assert.match(within, /SENTSINCE/u); assert.match(within, /YOUNGER/u); assert.doesNotMatch(within, /"SINCE"/u);
});

test('bodies prefer inline plain text and exclude filename-bearing parts, attached messages, and encrypted containers', async () => {
  const structure = { type: 'multipart/mixed', childNodes: [
    { type: 'text/plain', part: '1', disposition: 'attachment' },
    { type: 'text/plain', part: '2', parameters: { name: 'secret.txt' } },
    { type: 'message/rfc822', part: '3', childNodes: [{ type: 'text/plain', part: '3.1' }] },
    { type: 'multipart/alternative', childNodes: [{ type: 'text/html', part: '4.1' }, { type: 'text/plain', part: '4.2' }] }
  ] };
  const h = harness({ a: { messages: [mail(1, { bodyStructure: structure }), mail(2, {
    bodyStructure: { type: 'multipart/encrypted', childNodes: [{ type: 'text/plain', part: '2' }] }
  }), mail(3, { bodyStructure: { type: 'application/pkcs7-mime' } })] } });
  const result = await h.service.scan(h.accounts);
  assert.deepEqual(h.calls.filter(call => call[0] === 'body').map(call => call[3]), ['4.2']);
  assert.equal(result.messages.filter(message => message.bodyUnavailable).length, 2);
});

test('HTML bodies are converted without links, scripts, images or remote fetches and capped at 8000 characters', async () => {
  const h = harness({ a: { messages: [mail(1, { body: '<p>Hello <a href="https://example.test">friend</a></p><script>secret()</script><img src="https://example.test/image">',
    bodyStructure: { type: 'text/html', part: '1' }, meta: { contentType: 'text/html' } }),
  mail(2, { body: 'x'.repeat(9000) }), mail(3, { body: 'x'.repeat(70000) })] } });
  const result = await h.service.scan(h.accounts);
  assert.equal(result.messages[2].body, 'Hello friend');
  assert.equal(result.messages[1].body.length, 8000); assert.equal(result.messages[1].truncated, true);
  assert.equal(result.messages[0].body.length, 8000); assert.equal(result.messages[0].truncated, true);
  assert.doesNotThrow(() => validateRequest({ messages: result.messages }));
});

test('briefing messages expose only their strict wire fields and keep the original source cap', async () => {
  const body = `<style>${'x'.repeat(70000)}</style><p>Hidden beyond the briefing source cap.</p>`;
  const h = harness({ a: { messages: [mail(1, { body, bodyStructure: { type: 'text/html', part: '1', size: body.length },
    meta: { contentType: 'text/html' } }), mail(2)] } });
  const result = await h.service.scan(h.accounts);
  const expected = ['id', 'account', 'author', 'subject', 'date', 'body', 'truncated', 'bodyUnavailable'].sort();
  for (const message of result.messages) {
    assert.deepEqual(Object.keys(message).sort(), expected);
    assert.equal(Object.hasOwn(message, 'contentReasons'), false);
    assert.equal(Object.hasOwn(message, 'extractionVersion'), false);
  }
  const limited = result.messages.find(message => message.subject === 'Message 1');
  assert.equal(limited.truncated, true);
  assert.equal(limited.body.includes('Hidden beyond'), false);
  assert.equal(h.calls.filter(call => call[0] === 'body').length, 2);
  assert.doesNotThrow(() => validateRequest({ messages: result.messages }));
});

test('inline ASCII-armored encrypted PGP is unavailable even with a text/plain body and an introductory note', async () => {
  const encrypted = 'Please decrypt this message in your mail client.\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nVersion: fixture\r\n\r\naGVsbG8tZW5jcnlwdGVkLWZpeHR1cmU=\r\n-----END PGP MESSAGE-----';
  const h = harness({ a: { messages: [mail(1, { body: encrypted }), mail(2, { body: 'A normal plaintext message.' })] } });
  const scan = await h.service.scan(h.accounts);
  const protectedMessage = scan.messages.find(message => message.subject === 'Message 1');
  assert.equal(protectedMessage.bodyUnavailable, true);
  assert.equal(protectedMessage.body, '');
  assert.equal(protectedMessage.truncated, false);
  assert.equal(scan.messages.find(message => message.subject === 'Message 2').bodyUnavailable, false);
  assert.ok(!JSON.stringify(validateRequest({ messages: scan.messages })).includes('PGP MESSAGE'));
});

for (const change of ['uidValidity', 'read', 'deleted', 'missing', 'fingerprint']) {
  test(`actions reject ${change} changes before writing`, async () => {
    const h = harness({ a: {} }); const scan = await h.service.scan(h.accounts); const id = scan.messages[0].id;
    const state = h.states.a;
    if (change === 'uidValidity') state.uidValidity = 2n;
    if (change === 'read') state.messages.get(1).flags.add('\\Seen');
    if (change === 'deleted') state.messages.get(1).flags.add('\\Deleted');
    if (change === 'missing') state.messages.delete(1);
    if (change === 'fingerprint') state.messages.get(1).envelope.subject = 'Changed';
    const result = await h.service.apply(h.accounts, scan.references, [id], 'mark_read');
    assert.deepEqual(result, { applied: [], failed: [{ id, code: 'stale_message' }] });
    assert.equal(h.calls.filter(call => ['move', 'labels', 'mark_read'].includes(call[0])).length, 0);
  });
}

test('mark-read succeeds once for the specific UID and consumes its opaque reference', async () => {
  const h = harness({ a: { messages: [mail(1), mail(2)] } }); const scan = await h.service.scan(h.accounts);
  const id = scan.messages[0].id;
  assert.deepEqual(await h.service.apply(h.accounts, scan.references, [id], 'mark_read'), { applied: [id], failed: [] });
  assert.equal(h.states.a.messages.get(2).flags.has('\\Seen'), true);
  assert.equal(h.states.a.messages.get(1).flags.has('\\Seen'), false);
  assert.equal(scan.references.has(id), false);
  assert.deepEqual(await h.service.apply(h.accounts, scan.references, [id], 'mark_read'), { applied: [], failed: [{ id, code: 'stale_message' }] });
});

test('Gmail archive removes only Inbox label after checking capability, All Mail and message Inbox label', async () => {
  const gmail = { capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', flags: new Set() }, { path: '[Gmail]/All Mail', specialUse: '\\All', flags: new Set() }] };
  const h = harness({ a: gmail });
  assert.equal((await h.service.test(h.accounts[0])).archivePath, '[Gmail]/All Mail');
  const scan = await h.service.scan(h.accounts); const id = scan.messages[0].id;
  assert.deepEqual(await h.service.apply(h.accounts, scan.references, [id], 'archive'), { applied: [id], failed: [] });
  assert.equal(h.calls.filter(call => call[0] === 'labels').length, 1);
  assert.equal(h.calls.filter(call => ['move', 'mark_read'].includes(call[0])).length, 0);
  const missing = harness({ a: { ...gmail, messages: [mail(1, { labels: new Set() })] } });
  const another = await missing.service.scan(missing.accounts); const nextId = another.messages[0].id;
  assert.deepEqual((await missing.service.apply(missing.accounts, another.references, [nextId], 'archive')).failed, [{ id: nextId, code: 'stale_message' }]);
});

test('archive uses native MOVE only and refuses absent or unsafe destinations without fallback', async () => {
  for (const config of [{ capabilities: [] }, { folders: [{ path: 'INBOX', specialUse: '\\Archive' }] },
    { folders: [{ path: 'Trash', specialUse: '\\Trash' }] }, { capabilities: ['X-GM-EXT-1'] }]) {
    const h = harness({ a: config }); const scan = await h.service.scan(h.accounts); const id = scan.messages[0].id;
    assert.equal((await h.service.test(h.accounts[0])).archivePath, null);
    assert.deepEqual((await h.service.apply(h.accounts, scan.references, [id], 'archive')).failed, [{ id, code: 'archive_unavailable' }]);
    assert.equal(h.calls.filter(call => ['move', 'labels'].includes(call[0])).length, 0);
  }
  const h = harness({ a: {} }); const scan = await h.service.scan(h.accounts); const id = scan.messages[0].id;
  assert.deepEqual(await h.service.apply(h.accounts, scan.references, [id], 'archive'), { applied: [id], failed: [] });
  assert.equal(h.calls.find(call => call[0] === 'move')[3], 'Archive');
});

test('failed archive retains its reference and reports failure; later ids are independently processed', async () => {
  const h = harness({ a: { moveFails: true }, b: {} }); const scan = await h.service.scan(h.accounts);
  const ids = scan.messages.map(message => message.id);
  const result = await h.service.apply(h.accounts, scan.references, ids, 'archive');
  assert.equal(result.applied.length, 1); assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].code, 'mailbox_error'); assert.equal(scan.references.has(result.failed[0].id), true);
});

test('provider errors never include server response, account credentials or OAuth data', async () => {
  const h = harness({ a: { connectError: Object.assign(new Error('server response fixture-secret'), { authenticationFailed: true, oauthError: 'private' }) } });
  await assert.rejects(h.service.test(h.accounts[0]), error => error.code === 'mailbox_login_required' && !String(error).includes('secret') && !('oauthError' in error));
  assert.ok(h.clients.every(client => client.closed));
});

test('abort closes the connection, returns cancelled and does not write mail', async () => {
  const aborter = new AbortController();
  const h = harness({ a: { onConnect: () => aborter.abort() } });
  await assert.rejects(h.service.scan(h.accounts, { signal: aborter.signal }), { code: 'cancelled' });
  assert.ok(h.clients.every(client => client.closed));
  assert.equal(h.calls.filter(call => ['move', 'labels', 'mark_read'].includes(call[0])).length, 0);
});

test('a connection error while revalidating an action prevents a subsequent write', async () => {
  const h = harness({ a: {} }); const scan = await h.service.scan(h.accounts); const id = scan.messages[0].id;
  h.states.a.onFetchOne = client => client.emit('error', new Error('private provider response'));
  assert.deepEqual(await h.service.apply(h.accounts, scan.references, [id], 'mark_read'), { applied: [], failed: [{ id, code: 'mailbox_error' }] });
  assert.equal(h.calls.filter(call => call[0] === 'mark_read').length, 0);
  assert.ok(h.clients.every(client => client.closed));
});

test('scan skips a message that becomes read between its header and body fetch', async () => {
  const h = harness({ a: { beforeMetadata: client => client.state.messages.get(1).flags.add('\\Seen') } });
  const scan = await h.service.scan(h.accounts);
  assert.equal(scan.messages.length, 0); assert.equal(scan.references.size, 0);
  assert.equal(h.calls.filter(call => call[0] === 'body').length, 0);
  assert.equal(scan.truncated, true);
});

test('unknown character sets and a MIME disposition conflict yield unavailable bodies', async () => {
  const h = harness({ a: { messages: [mail(1, { meta: { charset: 'unknown-charset' } }),
    mail(2, { meta: { disposition: 'attachment', filename: 'private.txt' } })] } });
  const scan = await h.service.scan(h.accounts);
  assert.ok(scan.messages.every(message => message.bodyUnavailable && message.body === ''));
});

test('an explicit archive destination must exist and cannot have a destructive special use', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX' }, { path: 'My Archive' }, { path: 'Trash', specialUse: '\\Trash' }] } });
  h.accounts[0].archivePath = 'My Archive';
  assert.equal((await h.service.test(h.accounts[0])).archivePath, 'My Archive');
  h.accounts[0].archivePath = 'Missing';
  assert.equal((await h.service.test(h.accounts[0])).archivePath, null);
  h.accounts[0].archivePath = 'Trash';
  assert.equal((await h.service.test(h.accounts[0])).archivePath, null);
});

test('empty unread inbox returns an empty batch without body downloads', async () => {
  const h = harness({ a: { messages: [mail(1, { flags: new Set(['\\Seen']) })] } });
  const scan = await h.service.scan(h.accounts);
  assert.equal(scan.messages.length, 0); assert.equal(scan.totalUnread, 0); assert.equal(scan.inboxCount, 1);
  assert.equal(scan.truncated, false); assert.equal(h.calls.filter(call => call[0] === 'body').length, 0);
});

test('forty simple messages use one metadata batch and one bounded body batch with no per-message downloads', async () => {
  const h = harness({ a: { messages: Array.from({ length: 40 }, (_, index) => mail(index + 1)), duplicateFetch: true,
    onFetchOne: () => assert.fail('A scan may not fetch individual messages') } });
  const scan = await h.service.scan(h.accounts);
  assert.equal(scan.messages.length, 40); assert.equal(scan.references.size, 40);
  assert.deepEqual(h.calls.filter(call => ['metadata', 'bodies'].includes(call[0])).map(call => [call[0], call[2]]), [['metadata', 40], ['bodies', 40]]);
  assert.equal(scan.references.get(scan.messages[0].id).uid, 40);
  assert.ok(scan.messages.every(message => message.body === 'Message body' && !message.bodyUnavailable && !message.truncated));
});

test('body groups separate single-part TEXT from numeric MIME parts and never request sibling attachments', async () => {
  const h = harness({ a: { messages: [mail(1), mail(2, {
    bodyStructure: { type: 'multipart/mixed', childNodes: [
      { type: 'text/plain', part: '1', disposition: 'attachment', dispositionParameters: { filename: 'private.txt' } },
      { type: 'text/plain', part: '2' }
    ] }, partBodies: { 1: 'PRIVATE_ATTACHMENT', 2: 'Visible second part' }
  }), mail(3, {
    bodyStructure: { type: 'multipart/mixed', childNodes: [
      { type: 'text/plain', part: '1' },
      { type: 'text/plain', part: '2', disposition: 'attachment' }
    ] }, partBodies: { 1: 'Visible first part', 2: 'PRIVATE_ATTACHMENT' }
  })] } });
  const scan = await h.service.scan(h.accounts);
  assert.equal(h.calls.filter(call => call[0] === 'metadata').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'bodies').length, 3);
  assert.deepEqual(h.calls.filter(call => call[0] === 'body').map(call => [call[2], call[3]]).sort((a,b) => a[0]-b[0]), [[1, '1'], [2, '2'], [3, '1']]);
  assert.deepEqual(scan.messages.map(message => message.body), ['Visible first part', 'Visible second part', 'Message body']);
  assert.ok(!JSON.stringify(scan.messages).includes('PRIVATE_ATTACHMENT'));
});

test('filename parameters and unknown dispositions are excluded before any body prefix is requested', async () => {
  const structures = [
    { type: 'text/plain', part: '1', dispositionParameters: { filename: '' } },
    { type: 'text/plain', part: '1', parameters: { 'name*': "utf-8''private.txt" } },
    { type: 'text/plain', part: '1', dispositionParameters: { 'filename*0*': "utf-8''private" } },
    { type: 'text/plain', part: '1', disposition: 'form-data' },
    { type: 'multipart/mixed', parameters: { name: '' }, childNodes: [{ type: 'text/plain', part: '1' }] },
    { type: 'multipart/mixed', disposition: 'unknown', childNodes: [{ type: 'text/plain', part: '1' }] }
  ];
  const h = harness({ a: { messages: structures.map((bodyStructure, index) => mail(index + 1, { bodyStructure, body: 'PRIVATE_ATTACHMENT' })) } });
  const scan = await h.service.scan(h.accounts);
  assert.equal(h.calls.filter(call => call[0] === 'bodies').length, 0);
  assert.equal(scan.messages.length, structures.length);
  assert.ok(scan.messages.every(message => message.bodyUnavailable && message.body === ''));
});

test('grouped body responses recheck unread flags and fingerprints after selected metadata was fetched', async () => {
  const h = harness({ a: { messages: [mail(1), mail(2), mail(3)], beforeBody(client, uid) {
    if (uid === 1) client.state.messages.get(uid).flags.add('\\Seen');
    if (uid === 2) client.state.messages.get(uid).envelope.subject = 'CHANGED_PRIVATE_SUBJECT';
    if (uid === 3) client.state.messages.delete(uid);
  } } });
  const scan = await h.service.scan(h.accounts);
  assert.deepEqual(scan.messages, []); assert.equal(scan.references.size, 0);
  assert.equal(scan.totalUnread, 3); assert.equal(scan.truncated, true);
  assert.equal(h.calls.filter(call => call[0] === 'bodies').length, 1);
});

test('UIDVALIDITY changes during a body batch fail before publishing any result', async () => {
  const h = harness({ a: { beforeBody(client) { client.mailbox.uidValidity = 2n; } } });
  await assert.rejects(h.service.scan(h.accounts), { code: 'stale_message' });
  assert.ok(h.clients.every(client => client.closed));
});

test('cancellation during metadata or a grouped body fetch closes the session without later groups or writes', async () => {
  for (const hook of ['beforeMetadata', 'beforeBody']) {
    const aborter = new AbortController();
    const h = harness({ a: { messages: [mail(1), mail(2)], [hook]: () => aborter.abort() } });
    await assert.rejects(h.service.scan(h.accounts, { signal: aborter.signal }), { code: 'cancelled' });
    assert.ok(h.clients.every(client => client.closed));
    assert.equal(h.calls.filter(call => ['move', 'labels', 'mark_read'].includes(call[0])).length, 0);
    assert.equal(h.calls.filter(call => call[0] === 'bodies').length, hook === 'beforeMetadata' ? 0 : 1);
  }
});

test('bounded prefixes are marked truncated and oversized MIME headers fail closed', async () => {
  const h = harness({ a: { messages: [mail(1, { body: 'x'.repeat(70000), bodyStructure: { type: 'text/plain', part: '1', size: 70000 } }),
    mail(2, { mime: `X-Long: ${'x'.repeat(17000)}\r\nContent-Type: text/plain\r\n\r\n` })] } });
  const scan = await h.service.scan(h.accounts);
  const prefix = scan.messages.find(message => message.subject === 'Message 1');
  assert.equal(prefix.truncated, true); assert.equal(prefix.body.length, 8000);
  const incompleteMime = scan.messages.find(message => message.subject === 'Message 2');
  assert.equal(incompleteMime.bodyUnavailable, true); assert.equal(incompleteMime.body, '');
});

test('pinned FETCH encodes grouped MIME and body bounds as BODY.PEEK partials', async () => {
  let captured;
  const client = { state: 1, states: { SELECTED: 1 }, mailbox: {}, capabilities: new Map(), enabled: new Set(),
    exec: async (command, attributes) => { captured = { command, attributes }; return { next() {} }; } };
  await fetchCommand(client, '2,7,19', { uid: true, flags: true, bodyParts: [
    { key: '1.2.mime', start: 0, maxLength: 16384 }, { key: '1.2', start: 0, maxLength: 65536 }
  ] }, { uid: true, binary: false });
  assert.equal(captured.command, 'UID FETCH');
  const items = captured.attributes[1].filter(value => value.value === 'BODY.PEEK');
  assert.deepEqual(items.map(value => [value.section[0].value, value.partial]), [['1.2.MIME', [0, 16384]], ['1.2', [0, 65536]]]);
  assert.equal(items.length, 2);
});

function diagnosticSession(execute, options = {}) {
  const clients = [];
  const transport = createMailboxSession({ connectionOptions: async () => ({}), ...options,
    createClient: () => {
      const client = new EventEmitter(); clients.push(client);
      Object.assign(client, { state: 1, states: { SELECTED: 1 }, mailbox: { permanentFlags: new Set(['\\Seen']) },
        capabilities: new Set(), enabled: new Set(), log: { warn() {} }, exec: execute,
        connect: async () => {}, close() { this.closed = true; } });
      return client;
    } });
  return { ...transport, clients };
}

test('STORE false preserves only fixed diagnostics captured before ImapFlow swallows the rejection', async () => {
  const privateText = 'private@example.test UID 123 token-and-folder-secret';
  const raw = Object.assign(new Error(privateText), { responseStatus: 'NO', executedCommand: privateText, responseText: privateText,
    response: { tag: '1', command: 'NO', attributes: [{ type: 'ATOM', section: [{ type: 'ATOM', value: 'NOPERM' }] }, { type: 'TEXT', value: privateText }] } });
  const h = diagnosticSession(async () => { throw raw; });
  await assert.rejects(h.session({}, null, async client => {
    assert.equal(await storeCommand(client, '123', ['\\Seen'], { uid: true }), false);
    throw new MailHarborError('mailbox_error');
  }), error => {
    assert.equal(error.code, 'mailbox_error');
    assert.deepEqual(error.mailboxDiagnostic, { command: 'UID STORE', reason: 'server_rejected', status: 'NO', responseCode: 'NOPERM' });
    assert.equal(typeof raw.response, 'string', 'Pinned ImapFlow enhanced and swallowed the original error');
    assert.equal(JSON.stringify(error).includes(privateText), false);
    assert.equal(error.cause, undefined); assert.equal(error.response, undefined); assert.equal(error.executedCommand, undefined);
    return true;
  });
  assert.ok(h.clients.every(client => client.closed));
});

test('diagnostic allowlists reject arbitrary command, code and response strings', async () => {
  const secret = 'secret token@example.test';
  const h = diagnosticSession(async () => { throw Object.assign(new Error(secret), { code: secret, responseStatus: secret,
    serverResponseCode: secret, mailboxDiagnostic: { command: secret, reason: 'timeout', status: secret } }); });
  await assert.rejects(h.session({}, null, client => client.exec(secret, [secret])), error => {
    assert.deepEqual(error.mailboxDiagnostic, { command: null, reason: 'unknown', status: null, responseCode: null });
    assert.equal(JSON.stringify(error).includes(secret), false); return true;
  });
  assert.equal(safeMailboxDiagnostic({ reason: secret }), null);
  assert.deepEqual(safeMailboxDiagnostic({ command: secret, reason: 'timeout', status: secret, responseCode: secret, responseText: secret }),
    { command: null, reason: 'timeout', status: null, responseCode: null });
});

test('socket failures preserve a fixed reason and the in-flight command without server text', async () => {
  const h = diagnosticSession(function () {
    this.emit('error', Object.assign(new Error('private server reason'), { code: 'ECONNRESET', reason: 'private BYE response' }));
    return Promise.reject(new Error('late command rejection'));
  });
  await assert.rejects(h.session({}, null, client => client.exec('UID FETCH', ['private UID'])), error => {
    assert.deepEqual(error.mailboxDiagnostic, { command: 'UID FETCH', reason: 'connection_reset', status: null, responseCode: null });
    assert.equal(JSON.stringify(error).includes('private'), false); return true;
  });
});

test('TLS diagnostics preserve only fixed transport codes without certificate or hostname details', async () => {
  for (const transportCode of ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    const h = diagnosticSession(async () => { throw Object.assign(new Error('private certificate hostname'), {
      code: transportCode, cert: { subject: { CN: 'private certificate hostname' } }, host: 'private certificate hostname'
    }); });
    await assert.rejects(h.session({}, null, client => client.exec('UID FETCH')), error => {
      assert.deepEqual(error.mailboxDiagnostic, { command: 'UID FETCH', reason: 'tls_error', status: null, responseCode: null, transportCode });
      assert.equal(JSON.stringify(error).includes('private'), false); return true;
    });
  }
  const base = { command: null, reason: 'tls_error', status: null, responseCode: null };
  assert.deepEqual(safeMailboxDiagnostic({ ...base, transportCode: 'private certificate hostname' }), base);
  assert.deepEqual(safeMailboxDiagnostic({ ...base, transportCode: 'CERT_HAS_EXPIRED\nprivate token' }), base);
  assert.deepEqual(safeMailboxDiagnostic({ ...base, reason: 'unknown', transportCode: 'CERT_HAS_EXPIRED' }), { ...base, reason: 'unknown' });
});

test('diagnostics stay isolated between concurrent sessions and clear after a recovered command', async () => {
  const h = diagnosticSession(async command => {
    if (command === 'UID STORE') throw Object.assign(new Error('private'), { code: 'ETHROTTLE', responseStatus: 'BAD' });
    return true;
  });
  const [first, second] = await Promise.allSettled([
    h.session({}, null, client => client.exec('UID STORE')),
    h.session({}, null, async client => { await client.exec('UID STORE').catch(() => {}); await client.exec('NOOP'); throw new Error('private application failure'); })
  ]);
  assert.equal(first.status, 'rejected'); assert.equal(second.status, 'rejected');
  assert.deepEqual(first.reason.mailboxDiagnostic, { command: 'UID STORE', reason: 'throttled', status: 'BAD', responseCode: null });
  assert.deepEqual(second.reason.mailboxDiagnostic, { command: null, reason: 'unknown', status: null, responseCode: null });
});

test('session deadlines identify timeout at the pending command while cancellation has no transport diagnostic', async () => {
  const h = diagnosticSession(() => new Promise(() => {}), { sessionTimeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(h.session({}, null, client => client.exec('UID MOVE')), error => {
      assert.equal(error.code, 'mailbox_timeout');
      assert.deepEqual(error.mailboxDiagnostic, { command: 'UID MOVE', reason: 'timeout', status: null, responseCode: null }); return true;
    });
  } finally { clearTimeout(keepAlive); }
  const aborter = new AbortController(); aborter.abort();
  await assert.rejects(h.session({}, aborter.signal, async () => {}), error => error.code === 'cancelled' && error.mailboxDiagnostic === undefined);
});
