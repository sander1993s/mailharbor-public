import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMailReader } from '../server/mail-reader.mjs';
import { MAX_ATTACHMENT_BYTES } from '../server/mail-attachments.mjs';
import { searchCompiler } from '../node_modules/imapflow/dist/esm/search-compiler.js';
import fetchCommand from '../node_modules/imapflow/dist/esm/commands/fetch.js';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const DAY = 86_400_000;
const mail = (uid, overrides = {}) => ({ uid, size: 20, internalDate: new Date('2020-01-01'), flags: new Set(),
  envelope: { date: new Date(NOW - uid * 60000), subject: `Message ${uid}`, from: [{ name: 'Sender', address: 'sender@example.test' }],
    to: [{ address: 'recipient@example.test' }], messageId: `<${uid}@example.test>` },
  labels: new Set(), bodyStructure: { part: '1', type: 'text/plain', size: 12 }, body: 'Message body', ...overrides });

function harness(config, options = {}) {
  const calls = [], clients = [];
  const accounts = Object.keys(config).map(id => ({ id, label: id.toUpperCase(), email: `${id}@example.test` }));
  const states = Object.fromEntries(Object.entries(config).map(([id, value]) => [id, { capabilities: [], ...value,
    folders: (value.folders ?? [{ path: 'INBOX', messages: [mail(1)] }]).map(folder => ({ flags: new Set(), uidValidity: 1n, ...folder,
      messages: new Map((folder.messages ?? []).map(message => [message.uid, message])) })) }]));
  const day = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ''; };
  function matches(message, criteria) {
    return Object.entries(criteria).every(([key, value]) => {
      if (key === 'or') return value.some(item => matches(message, item));
      if (key === 'deleted') return message.flags.has('\\Deleted') === value;
      if (key === 'seen') return message.flags.has('\\Seen') === value;
      if (key === 'flagged') return message.flags.has('\\Flagged') === value;
      if (key === 'emailId') return message.emailId === value;
      if (key === 'gmailRaw') { assert.equal(value, '-in:inbox'); return !message.labels.has('\\Inbox'); }
      if (key === 'sentSince') return (message.sentCalendarDate ?? day(message.envelope.date)) >= day(value);
      if (key === 'since') return day(message.internalDate) >= day(value);
      if (key === 'before') return day(message.internalDate) < day(value);
      if (key === 'body') return message.body.toLowerCase().includes(value.toLowerCase());
      if (key === 'text') return `${JSON.stringify(message.envelope)} ${message.body}`.toLowerCase().includes(value.toLowerCase());
      if (key === 'larger') return message.size > value;
      if (key === 'smaller') return message.size < value;
      if (key === 'subject') return message.envelope.subject.toLowerCase().includes(value.toLowerCase());
      if (key === 'from' || key === 'to') return JSON.stringify(message.envelope[key]).toLowerCase().includes(value.toLowerCase());
      assert.fail(`Unexpected search key ${key}`);
    });
  }
  class Client extends EventEmitter {
    constructor(options) { super(); this.options = options; this.state = states[options.auth.user];
      this.capabilities = new Set(this.state.capabilities); this.fetching = false; clients.push(this); }
    async connect() { if (this.state.error) throw this.state.error; await this.state.onConnect?.(this); }
    close() { this.closed = true; }
    command() { assert.equal(this.fetching, false, 'Do not issue commands inside a FETCH iterator'); }
    async list() { this.command(); return this.state.folders; }
    async status(path, query) {
      this.command(); assert.equal(this.statusPending, undefined, 'STATUS calls must remain sequential per account');
      this.statusPending = true;
      calls.push({ action: 'status', account: this.options.auth.user, path, query });
      try {
        await this.state.onStatus?.(path, query, this);
        const folder = this.state.folders.find(item => item.path === path);
        if (folder.statusError) throw folder.statusError;
        if (Object.hasOwn(folder, 'status')) return folder.status;
        const messages = [...folder.messages.values()];
        return { path, messages: messages.length, ...(query.unseen ? { unseen: messages.filter(message => !message.flags.has('\\Seen')).length } : {}),
          ...(query.uidNext ? { uidNext: Math.max(0, ...messages.map(message => message.uid)) + 1 } : {}),
          ...(query.uidValidity ? { uidValidity: folder.uidValidity } : {}) };
      } finally { delete this.statusPending; }
    }
    async getMailboxLock(path, options) {
      this.command(); this.folder = this.state.folders.find(item => item.path === path);
      if (!this.folder) throw new Error('private missing folder');
      this.mailbox = { path, uidValidity: this.folder.uidValidity, readOnly: options.readOnly, permanentFlags: this.folder.permanentFlags };
      calls.push({ action: 'open', account: this.options.auth.user, path, readOnly: options.readOnly });
      return { release() {} };
    }
    async search(criteria, options) {
      this.command(); assert.deepEqual(options, { uid: true });
      calls.push({ action: 'search', criteria }); this.state.onSearch?.(criteria, this);
      if (this.state.noDateSearch && criteria.or?.[0].sentSince) return false;
      return [...this.folder.messages.values()].filter(message => matches(message, criteria)).map(message => message.uid);
    }
    async *fetch(range, query, options) {
      this.command();
      const verification = options.binary === false;
      if (!verification) assert.equal(this.mailbox.readOnly, true);
      assert.deepEqual(options, verification ? { uid: true, binary: false } : { uid: true });
      assert.equal(query.source, undefined); assert.equal(query.bodyParts, undefined);
      const uids = range.split(',').map(Number); assert.ok(uids.length <= 250);
      calls.push({ action: verification ? 'verify-headers' : 'headers', uids, query }); this.fetching = true;
      try {
        for (const uid of uids) {
          this.state.onHeader?.(uid, this);
          if (verification) this.state.onVerified?.(uid, this);
          if (this.folder.messages.has(uid)) yield structuredClone(this.folder.messages.get(uid));
        }
      } finally { this.fetching = false; }
    }
    async fetchOne(uid, query, options) {
      this.command(); assert.equal(options.uid, true); assert.equal(options.binary, false);
      const attachmentQuery = query.bodyParts?.length === 1;
      calls.push({ action: attachmentQuery ? 'attachment-chunk' : query.bodyParts ? 'body' : 'metadata', uid: Number(uid), query, options });
      this.state.onFetchOne?.(Number(uid), query, this);
      if (attachmentQuery && query.bodyParts[0].start === 0) {
        calls.push({ action: 'download', uid: Number(uid), part: query.bodyParts[0].key });
        await this.state.onDownload?.(Number(uid), query.bodyParts[0].key, this);
      }
      const original = this.folder.messages.get(Number(uid));
      if (!original) return false;
      const message = structuredClone(original);
      if (original.headers) message.headers = Buffer.from(original.headers);
      if (query.source) {
        assert.equal(this.mailbox.readOnly, true);
        assert.ok(query.source.maxLength <= 65536);
        message.source = Buffer.from(original.source ?? '').subarray(query.source.start, query.source.start + query.source.maxLength);
        this.state.onSource?.(message, query.source, this);
      }
      if (attachmentQuery) {
        assert.equal(this.mailbox.readOnly, true);
        const requested = query.bodyParts[0];
        assert.equal(requested.maxLength, 65536);
        function find(node) {
          if (requested.key === 'text' || node.part === requested.key) return node;
          for (const child of node.childNodes ?? []) { const match = find(child); if (match) return match; }
        }
        if (!this.attachmentSource) {
          const decoded = Buffer.concat(this.state.downloadChunks ?? [Buffer.from('downloaded attachment')]);
          this.attachmentSource = this.state.encodedSource ?? (find(message.bodyStructure)?.encoding === 'base64' ? Buffer.from(decoded.toString('base64')) : decoded);
        }
        message.bodyParts = new Map(this.state.downloadMissing ? [] : [[requested.key,
          this.attachmentSource.subarray(requested.start, requested.start + requested.maxLength)]]);
      } else if (query.bodyParts) {
        assert.equal(this.mailbox.readOnly, true);
        assert.ok(query.bodyParts.length >= 2);
        message.bodyParts = new Map();
        for (let i = 0; i < query.bodyParts.length; i += 2) {
          const mimeQuery = query.bodyParts[i];
          const bodyQuery = query.bodyParts[i + 1] || mimeQuery;
          assert.equal(mimeQuery.start, 0);
          assert.equal(bodyQuery.start, 0);
          const partKey = bodyQuery.key === 'text' ? '1' : bodyQuery.key;
          const mime = Buffer.from(message.partMimes?.[bodyQuery.key] ?? message.partMimes?.[partKey] ?? message.mime ?? 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n').subarray(0, mimeQuery.maxLength || 16384);
          const bodyVal = message.partBodies?.[bodyQuery.key] ?? message.partBodies?.[partKey] ?? message.body ?? '';
          const bodyBuf = Buffer.from(bodyVal).subarray(0, bodyQuery.maxLength);
          if (!this.state.bodyMissing && !message.bodyMissing) {
            message.bodyParts.set(bodyQuery.key, bodyBuf);
          }
          if (!this.state.mimeMissing && !message.mimeMissing) {
            if (bodyQuery.key === 'text') message.headers = mime;
            else message.bodyParts.set(mimeQuery.key, mime);
          }
        }
        if (this.state.headerCollision && query.headers && query.bodyParts.some(p => p.key === 'text')) {
          message.headers = Buffer.from('References: <root@example.test>\r\n\r\n');
        }
      }
      return message;
    }
    async messageFlagsAdd(uid, flags, options) { return this.change(uid, flags, options, true); }
    async messageFlagsRemove(uid, flags, options) { return this.change(uid, flags, options, false); }
    change(uid, flags, options, add) {
      this.command(); assert.equal(this.mailbox.readOnly, false); assert.equal(options.uid, true);
      assert.equal(flags.length, 1);
      calls.push({ action: 'write', uid: Number(uid), flags, add });
      if (this.state.flagFailure) return false;
      const values = options.useLabels ? this.folder.messages.get(Number(uid)).labels : this.folder.messages.get(Number(uid)).flags;
      if (!this.state.gmailNoop) for (const flag of flags) values[add ? 'add' : 'delete'](flag);
      if (!add && options.useLabels && flags.includes('\\Inbox') && this.folder.specialUse === '\\All' && !this.state.gmailNoop && !this.state.keepInbox) {
        const sourceId = this.folder.messages.get(Number(uid)).emailId;
        const inbox = this.state.folders.find(folder => folder.path.toUpperCase() === 'INBOX');
        for (const message of inbox?.messages.values() ?? []) if (message.emailId === sourceId) inbox.messages.delete(message.uid);
      }
      this.state.onWrite?.(Number(uid), flags, this);
      return true;
    }
    async download() { assert.fail('Use bounded transfer-only BODY.PEEK reads; never transform original attachment text.'); }
    async messageDelete() { assert.fail('Never expunge mail'); }
    async messageCopy() { assert.fail('Never emulate MOVE'); }
    async messageMove(uid, destination, options) {
      this.command(); assert.equal(this.mailbox.readOnly, false); assert.deepEqual(options, { uid: true });
      assert.ok(this.capabilities.has('MOVE'));
      calls.push({ action: 'move', uid: Number(uid), destination });
      if (this.state.moveFailure) return false;
      const target = this.state.folders.find(folder => folder.path === destination);
      const message = this.folder.messages.get(Number(uid));
      const movedUid = this.state.moveUid ?? Number(uid);
      target.messages.set(movedUid, { ...message, uid: movedUid });
      this.folder.messages.delete(Number(uid));
      return { path: this.folder.path, destination, ...(this.state.moveUid ? { uidValidity: target.uidValidity, uidMap: new Map([[Number(uid), movedUid]]) } : {}) };
    }
    async exec(command, args) {
      this.command(); assert.equal(command, 'UID EXPUNGE'); assert.equal(this.mailbox.readOnly, false);
      assert.ok(this.capabilities.has('UIDPLUS')); assert.equal(args.length, 1); assert.equal(args[0].type, 'SEQUENCE');
      assert.match(args[0].value, /^\d+$/u);
      calls.push({ action: 'expunge', uid: Number(args[0].value), command });
      const message = this.folder.messages.get(Number(args[0].value));
      if (message?.flags.has('\\Deleted')) this.folder.messages.delete(message.uid);
      return { next() {} };
    }
    async mailboxCreate(path) {
      this.command(); calls.push({ action: 'create-folder', path });
      this.state.folders.push({ path, flags: new Set(), uidValidity: 1n, messages: new Map(), delimiter: '/' });
      return { path };
    }
    async mailboxRename(path, newPath) {
      this.command(); calls.push({ action: 'rename-folder', path, newPath });
      this.state.folders.find(folder => folder.path === path).path = newPath;
      return { path, newPath };
    }
    async mailboxClose() { assert.fail('Never CLOSE/EXPUNGE'); }
  }
  const reader = createMailReader({ connectionOptions: async account => ({ auth: { user: account.id, pass: 'fixture-private' },
    secure: false, logger: true, tls: { rejectUnauthorized: false } }), createClient: options => new Client(options), now: () => NOW, ...options });
  return { reader, accounts, states, calls, clients };
}

test('unified inbox includes read and unread mail, newest dates across accounts regardless of UID', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(100), mail(1, { flags: new Set(['\\Seen']) })] }] },
    b: { folders: [{ path: 'INBOX', messages: [mail(12, { envelope: { date: 'invalid', subject: 'Newest' }, internalDate: new Date(NOW + 1) })] }] } });
  const result = await h.reader.list(h.accounts, {});
  assert.deepEqual(result.messages.map(message => message.subject), ['Newest', 'Message 1', 'Message 100']);
  assert.deepEqual(result.messages.map(message => message.unread), [true, false, true]);
  assert.equal(result.total, 3); assert.equal(result.totalComplete, true);
  assert.equal(result.messages[1].account, 'A'); assert.equal(result.messages[1].to, 'recipient@example.test');
  assert.ok(result.messages.every(message => /^[a-f0-9]{64}$/u.test(message.id)));
  assert.deepEqual((await h.reader.list(h.accounts, {})).messages.map(value => value.id), result.messages.map(value => value.id));
  assert.equal(h.calls.filter(call => ['body', 'metadata', 'write'].includes(call.action)).length, 0);
  assert.ok(h.calls.filter(call => call.action === 'open').every(call => call.readOnly));
  assert.ok(h.clients.every(client => client.closed && client.options.secure && !client.options.logger && client.options.tls.rejectUnauthorized));
});

test('SPECIAL-USE resolves localized folders, known exact fallbacks and unavailable folders without creating them', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX' }, { path: 'Verzonden', specialUse: '\\Sent' }, { path: 'Sent' },
    { path: 'Drafts' }, { path: 'Archives' }, { path: 'Junk', flags: new Set(['\\Junk']) }, { path: 'Trash', flags: new Set(['\\Noselect']) },
    { path: 'Old Trash Backup' }] }, b: { folders: [{ path: 'INBOX' }, { path: 'Sent Items' }, { path: 'Deleted Items' }] } });
  const result = await h.reader.folders(h.accounts);
  assert.deepEqual(result.folders.filter(folder => folder.type === 'standard').map(folder => folder.id), ['inbox', 'unread', 'starred', 'sent', 'drafts', 'archive', 'junk', 'trash', 'all']);
  assert.deepEqual(result.folders.filter(folder => folder.type === 'provider').map(folder => folder.label), ['Old Trash Backup', 'Sent']);
  assert.deepEqual(result.folders.find(folder => folder.id === 'trash').accountIds, ['b']);
  await h.reader.list(h.accounts, { folder: 'sent' });
  assert.deepEqual(h.calls.filter(call => call.action === 'open').map(call => call.path), ['Verzonden', 'Sent Items']);
});

test('unread searches inbox only and starred searches ordinary folders excluding junk and trash', async () => {
  const starred = () => mail(1, { flags: new Set(['\\Flagged']) });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [starred(), mail(2, { flags: new Set(['\\Seen']) })] },
    { path: 'Archive', messages: [starred()] }, { path: 'Custom', messages: [starred()] },
    { path: 'Spam', messages: [starred()] }, { path: 'Trash', messages: [starred()] }] } });
  const unread = await h.reader.list(h.accounts, { folder: 'unread' });
  assert.equal(unread.messages.length, 1); assert.equal(unread.messages[0].folderPath, 'INBOX');
  assert.equal(unread.total, 1); assert.equal(unread.totalComplete, true);
  const result = await h.reader.list(h.accounts, { folder: 'starred' });
  assert.deepEqual(result.messages.map(message => message.folderPath), ['Archive', 'Custom', 'INBOX']);
  assert.ok(result.messages.every(message => message.starred));
  assert.equal(result.total, 3);
});

test('folder counts use one STATUS per discovered mailbox and share Inbox messages/unseen without fetching mail', async () => {
  const h = harness({ b: { folders: [{ path: 'INBOX', status: { path: 'INBOX', messages: 48231, unseen: 963 } },
    { path: 'INBOX' }, { path: 'Sent', messages: [mail(1), mail(2)] }, { path: 'Drafts' },
    { path: 'Archives', messages: [mail(1)] }, { path: 'Spam', messages: [mail(1)] }, { path: 'Trash' },
    { path: 'Other label', messages: [mail(1)] }] }, a: { folders: [{ path: 'INBOX', messages: [mail(1), mail(2, { flags: new Set(['\\Seen']) })] }] } });
  const result = await h.reader.folders(h.accounts);
  const counts = id => result.folders.find(folder => folder.id === id).counts;
  assert.deepEqual(counts('inbox'), [{ accountId: 'a', total: 2 }, { accountId: 'b', total: 48231 }]);
  assert.deepEqual(counts('unread'), [{ accountId: 'a', total: 1 }, { accountId: 'b', total: 963 }]);
  assert.deepEqual(counts('starred'), [{ accountId: 'a', total: null }, { accountId: 'b', total: null }]);
  for (const [id, total] of [['sent', 2], ['drafts', 0], ['archive', 1], ['junk', 1], ['trash', 0]]) {
    assert.deepEqual(counts(id), [{ accountId: 'b', total }]);
  }
  assert.deepEqual(result.errors, []);
  for (const folder of result.folders) assert.deepEqual(folder.counts.map(value => value.accountId), folder.accountIds);
  assert.equal(h.calls.length, 8); assert.ok(h.calls.every(call => call.action === 'status'));
  assert.deepEqual(h.calls.filter(call => call.path === 'INBOX').map(call => call.query), [{ messages: true, unseen: true }, { messages: true, unseen: true }]);
  assert.equal(h.calls.some(call => call.path === 'Other label'), true);
});

test('filtered Gmail Archive and Starred counts remain unknown without querying the unfiltered All Mail total', async () => {
  const h = harness({ a: { capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [mail(1)] },
    { path: '[Gmail]/All Mail', specialUse: '\\All', messages: [mail(1), mail(2)] },
    { path: 'Archive', messages: [mail(3)] }, { path: 'Custom', messages: [mail(4)] }] } });
  const result = await h.reader.folders(h.accounts);
  for (const id of ['archive', 'starred']) assert.deepEqual(result.folders.find(folder => folder.id === id).counts, [{ accountId: 'a', total: null }]);
  assert.deepEqual(h.calls.map(call => call.path), ['INBOX', 'Archive', 'Custom']);
  assert.deepEqual(result.errors, []);
});

test('count failures preserve mapped folders and healthy totals with unknown values and sanitized errors', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX', status: { path: 'INBOX', messages: 150, unseen: -1 } },
    { path: 'Sent', statusError: new Error('private provider response fixture-private') }, { path: 'Drafts', status: false },
    { path: 'Archive', messages: [mail(1)] }] }, b: { folders: [{ path: 'INBOX', messages: [mail(1)] }] } });
  const result = await h.reader.folders(h.accounts), folder = id => result.folders.find(value => value.id === id);
  assert.deepEqual(folder('inbox').counts, [{ accountId: 'a', total: 150 }, { accountId: 'b', total: 1 }]);
  assert.deepEqual(folder('unread').counts, [{ accountId: 'a', total: null }, { accountId: 'b', total: 1 }]);
  for (const id of ['sent', 'drafts']) {
    assert.deepEqual(folder(id).accountIds, ['a']);
    assert.deepEqual(folder(id).counts, [{ accountId: 'a', total: null }]);
  }
  assert.deepEqual(folder('archive').counts, [{ accountId: 'a', total: 1 }]);
  assert.deepEqual(result.errors, [{ accountId: 'a', code: 'mailbox_error' }]);
  assert.equal(JSON.stringify(result).includes('fixture-private'), false);
});

test('a STATUS timeout preserves folder discovery and completed counts', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1)] }, { path: 'Sent' }],
    onStatus: async path => { if (path === 'Sent') await new Promise(resolve => setTimeout(resolve, 30)); } } }, { sessionTimeoutMs: 10 });
  const result = await h.reader.folders(h.accounts);
  assert.deepEqual(result.folders.find(folder => folder.id === 'inbox').counts, [{ accountId: 'a', total: 1 }]);
  assert.deepEqual(result.folders.find(folder => folder.id === 'sent').counts, [{ accountId: 'a', total: null }]);
  assert.deepEqual(result.errors, [{ accountId: 'a', code: 'mailbox_timeout' }]);
  assert.ok(h.clients.every(client => client.closed));
});

test('Gmail archive excludes inbox and Gmail starred reads All Mail once instead of label copies', async () => {
  const h = harness({ a: { capabilities: ['X-GM-EXT-1'], folders: [
    { path: 'INBOX', messages: [mail(1, { flags: new Set(['\\Flagged']) })] },
    { path: '[Gmail]/All Mail', specialUse: '\\All', messages: [mail(8, { labels: new Set(['\\Inbox']), flags: new Set(['\\Flagged']) }), mail(9, { flags: new Set(['\\Flagged']) })] },
    { path: 'Category', messages: [mail(8, { flags: new Set(['\\Flagged']) })] }] } });
  const archive = await h.reader.list(h.accounts, { folder: 'archive' });
  assert.deepEqual(archive.messages.map(message => message.reference.uid), [9]);
  assert.equal(archive.total, 1);
  const starred = await h.reader.list(h.accounts, { folder: 'starred' });
  assert.equal(starred.messages.length, 2);
  assert.ok(starred.messages.every(message => message.folderPath === '[Gmail]/All Mail'));
  const compiled = JSON.stringify(searchCompiler({ capabilities: new Set(['X-GM-EXT-1']), enabled: new Set(), mailbox: {} },
    h.calls.find(call => call.criteria?.gmailRaw).criteria));
  assert.match(compiled, /X-GM-RAW/u); assert.match(compiled, /-in:inbox/u);
});

test('pagination uses dates with deterministic ties, freezes arrivals and binds folder, query and account scope', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(100), mail(2), mail(1)] }] },
    b: { folders: [{ path: 'INBOX', messages: [mail(3), mail(1)] }] } });
  const first = await h.reader.list(h.accounts, { limit: 2 });
  assert.equal(first.total, 5); assert.equal(first.totalComplete, true);
  assert.deepEqual(first.messages.map(message => [message.accountId, message.reference.uid]), [['a', 1], ['b', 1]]);
  h.states.a.folders[0].messages.set(101, mail(101, { envelope: { date: new Date(NOW + DAY), subject: 'New arrival' } }));
  const second = await h.reader.list([...h.accounts].reverse(), { limit: 2, cursor: first.nextCursor });
  const third = await h.reader.list(h.accounts, { limit: 2, cursor: second.nextCursor });
  assert.equal(second.total, 5); assert.equal(third.total, 5);
  assert.deepEqual([...second.messages, ...third.messages].map(message => message.reference.uid), [2, 3, 100]);
  assert.equal(third.nextCursor, null);
  for (const changes of [{ folder: 'sent' }, { query: 'different' }]) {
    await assert.rejects(h.reader.list(h.accounts, { ...changes, cursor: first.nextCursor }), { code: 'stale_message' });
  }
  await assert.rejects(h.reader.list(h.accounts.slice(0, 1), { cursor: first.nextCursor }), { code: 'stale_message' });
});

test('large inbox date windows fetch recent headers only without assuming large UIDs are new', async () => {
  const messages = Array.from({ length: 30000 }, (_, index) => mail(index + 1, {
    envelope: { date: new Date('2020-01-01'), subject: `Old ${index}` }
  }));
  for (let index = 0; index < 110; index++) messages[index] = mail(index + 1);
  const h = harness({ a: { folders: [{ path: 'INBOX', messages }] } });
  const first = await h.reader.list(h.accounts, { limit: 50 });
  assert.equal(first.total, 30000); assert.equal(first.totalComplete, true);
  assert.deepEqual(first.messages.map(message => message.reference.uid), Array.from({ length: 50 }, (_, index) => index + 1));
  assert.equal(h.calls.filter(call => call.action === 'headers').reduce((sum, call) => sum + call.uids.length, 0), 110);
  const second = await h.reader.list(h.accounts, { limit: 50, cursor: first.nextCursor });
  assert.deepEqual(second.messages.map(message => message.reference.uid), Array.from({ length: 50 }, (_, index) => index + 51));
  assert.equal(h.calls.filter(call => call.action === 'headers').reduce((sum, call) => sum + call.uids.length, 0), 220);
});

test('unsupported date search fetches the complete snapshot and search matches headers', async () => {
  const h = harness({ a: { noDateSearch: true, folders: [{ path: 'INBOX', messages: Array.from({ length: 300 }, (_, index) => mail(index + 1)) }] } });
  const result = await h.reader.list(h.accounts, { limit: 10 });
  assert.equal(result.messages[0].reference.uid, 1);
  assert.equal(h.calls.filter(call => call.action === 'headers').reduce((sum, call) => sum + call.uids.length, 0), 300);
  const searched = await h.reader.list(h.accounts, { query: 'Message 299' });
  assert.deepEqual(searched.messages.map(message => message.reference.uid), [299]);
  assert.equal(searched.total, 1); assert.equal(searched.totalComplete, true);
});

test('partial account errors stay sanitized and do not erase healthy results or pagination', async () => {
  const h = harness({ a: { error: Object.assign(new Error('provider response fixture-private'), { authenticationFailed: true }) },
    b: { folders: [{ path: 'INBOX', messages: [mail(1), mail(2)] }] } });
  const first = await h.reader.list(h.accounts, { limit: 1 });
  assert.equal(first.messages.length, 1); assert.equal(first.messages[0].accountId, 'b');
  assert.deepEqual(first.errors, [{ accountId: 'a', code: 'mailbox_login_required' }]);
  assert.equal(first.total, 2); assert.equal(first.totalComplete, false);
  assert.deepEqual((await h.reader.folders(h.accounts)).errors, first.errors);
  const second = await h.reader.list(h.accounts, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.messages[0].reference.uid, 2); assert.deepEqual(second.errors, first.errors);
  assert.equal(second.total, 2); assert.equal(second.totalComplete, false);
  assert.ok(!JSON.stringify(first).includes('fixture-private'));
});

test('slow provider sessions run independently and retain healthy results when another provider fails', async () => {
  let release;
  const reachedHealthy = new Promise(resolve => { release = resolve; });
  const h = harness({ a: { onConnect: async () => {
    await reachedHealthy;
    throw Object.assign(new Error('private authentication response'), { authenticationFailed: true });
  } }, b: { onConnect: () => release() } }, { sessionTimeoutMs: 500 });
  const result = await h.reader.list(h.accounts);
  assert.deepEqual(result.errors, [{ accountId: 'a', code: 'mailbox_login_required' }]);
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0].accountId, 'b');
  assert.ok(h.clients.every(client => client.closed));
  const tooMany = Array.from({ length: 101 }, (_, i) => ({ id: 'account-' + i }));
  await assert.rejects(h.reader.list(tooMany), { code: 'invalid_request' });
  await assert.rejects(h.reader.folders(tooMany), { code: 'invalid_request' });
});

test('UIDVALIDITY changes invalidate account pagination and old read/action references', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1), mail(2)] }] } });
  const first = await h.reader.list(h.accounts, { limit: 1 }), reference = first.messages[0].reference;
  h.states.a.folders[0].uidValidity = 2n;
  const next = await h.reader.list(h.accounts, { cursor: first.nextCursor });
  assert.deepEqual(next.messages, []); assert.deepEqual(next.errors, [{ accountId: 'a', code: 'stale_message' }]);
  assert.equal(next.total, 0); assert.equal(next.totalComplete, false);
  await assert.rejects(h.reader.read(h.accounts[0], reference), { code: 'stale_message' });
  await assert.rejects(h.reader.apply(h.accounts[0], reference, 'star'), { code: 'stale_message' });
  assert.equal(h.calls.filter(call => call.action === 'write').length, 0);
});

test('opening a message uses bounded inline MIME body reads without changing Seen or fetching attachments', async () => {
  const structure = { type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'text/plain', disposition: 'attachment' },
    { part: '2', type: 'text/plain', parameters: { name: 'private.txt' } },
    { part: '3', type: 'text/plain', size: 7 }
  ] };
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { bodyStructure: structure,
    partBodies: { 1: 'PRIVATE_ATTACHMENT', 2: 'PRIVATE_ATTACHMENT', 3: 'Visible' } })] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const result = await h.reader.read(h.accounts[0], entry.reference);
  assert.equal(result.body, 'Visible'); assert.equal(result.unread, true); assert.equal(result.bodyUnavailable, false);
  assert.deepEqual(h.calls.find(call => call.action === 'body').query.bodyParts.map(part => part.key), ['3.mime', '3']);
  assert.equal(h.calls.filter(call => call.action === 'write').length, 0);
  assert.equal(h.states.a.folders[0].messages.get(1).flags.has('\\Seen'), false);
  let captured;
  const client = { state: 1, states: { SELECTED: 1 }, mailbox: {}, capabilities: new Map(), enabled: new Set(),
    exec: async (command, attributes) => { captured = { command, attributes }; return { next() {} }; } };
  const bodyCall = h.calls.find(call => call.action === 'body');
  await fetchCommand(client, '1', bodyCall.query, bodyCall.options);
  assert.equal(captured.command, 'UID FETCH');
  const parts = captured.attributes[1].filter(item => item.value === 'BODY.PEEK');
  assert.deepEqual(parts.map(item => [item.section[0].value, item.partial]), [['HEADER.FIELDS', undefined], ['3.MIME', [0, 16384]], ['3', [0, 65536]]]);
});

test('read/ unread and star/unstar target only verified UID flags and retain stable message identity', async () => {
  const h = harness({ a: {} });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  for (const [action, flag, expected] of [['mark_read', '\\Seen', true], ['mark_unread', '\\Seen', false], ['star', '\\Flagged', true], ['unstar', '\\Flagged', false]]) {
    assert.deepEqual(await h.reader.apply(h.accounts[0], entry.reference, action), { applied: true });
    assert.equal(h.states.a.folders[0].messages.get(1).flags.has(flag), expected);
    assert.equal((await h.reader.list(h.accounts)).messages[0].id, entry.id);
  }
  await assert.rejects(h.reader.apply(h.accounts[0], entry.reference, 'unsupported'), { code: 'invalid_request' });
  await assert.rejects(h.reader.apply({ id: 'other' }, entry.reference, 'mark_read'), { code: 'stale_message' });
});

for (const change of ['fingerprint', 'deleted', 'missing', 'folder']) {
  test(`read and flag actions reject stale ${change} references before any write`, async () => {
    const h = harness({ a: {} });
    const entry = (await h.reader.list(h.accounts)).messages[0];
    const state = h.states.a.folders[0];
    if (change === 'fingerprint') state.messages.get(1).envelope.subject = 'Changed';
    if (change === 'deleted') state.messages.get(1).flags.add('\\Deleted');
    if (change === 'missing') state.messages.delete(1);
    if (change === 'folder') entry.reference.path = 'Absent';
    await assert.rejects(h.reader.read(h.accounts[0], entry.reference), error => ['stale_message', 'mailbox_error'].includes(error.code));
    await assert.rejects(h.reader.apply(h.accounts[0], entry.reference, 'mark_read'), error => ['stale_message', 'mailbox_error'].includes(error.code));
    assert.equal(h.calls.filter(call => call.action === 'write').length, 0);
  });
}

test('late socket errors and cancellation prevent writes after metadata revalidation', async () => {
  for (const mode of ['socket', 'cancel']) {
    const controller = new AbortController(), h = harness({ a: {} });
    const reference = (await h.reader.list(h.accounts)).messages[0].reference;
    h.states.a.onFetchOne = (uid, query, client) => mode === 'socket' ? client.emit('error', new Error('private details')) : controller.abort();
    await assert.rejects(h.reader.apply(h.accounts[0], reference, 'mark_read', { signal: controller.signal }),
      { code: mode === 'socket' ? 'mailbox_error' : 'cancelled' });
    assert.equal(h.calls.filter(call => call.action === 'write').length, 0);
    assert.ok(h.clients.every(client => client.closed));
  }
});

test('body revalidation rejects changed fingerprints and encrypted bodies remain unavailable', async () => {
  const h = harness({ a: {} });
  const reference = (await h.reader.list(h.accounts)).messages[0].reference;
  h.states.a.onFetchOne = (uid, query, client) => { if (query.bodyParts) client.folder.messages.get(uid).envelope.subject = 'Replaced'; };
  await assert.rejects(h.reader.read(h.accounts[0], reference), { code: 'stale_message' });
  const encrypted = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { bodyStructure: { type: 'multipart/encrypted' } })] }] } });
  const message = (await encrypted.reader.list(encrypted.accounts)).messages[0];
  const result = await encrypted.reader.read(encrypted.accounts[0], message.reference);
  assert.equal(result.bodyUnavailable, true); assert.equal(result.body, '');
  assert.equal(encrypted.calls.filter(call => call.action === 'body').length, 0);
});

test('delete moves exactly the verified provider UID into localized SPECIAL-USE Trash', async () => {
  const h = harness({ a: { capabilities: ['MOVE'], folders: [
    { path: 'INBOX', messages: [mail(1), mail(2), mail(3, { flags: new Set(['\\Deleted']) })] },
    { path: 'Prullenbak', specialUse: '\\Trash' }, { path: 'Trash' }
  ] } });
  const reference = (await h.reader.list(h.accounts)).messages[0].reference;
  assert.deepEqual(await h.reader.apply(h.accounts[0], reference, 'delete'), { applied: true });
  assert.deepEqual(h.calls.filter(call => call.action === 'move'), [{ action: 'move', uid: 1, destination: 'Prullenbak' }]);
  assert.deepEqual([...h.states.a.folders[0].messages.keys()], [2, 3]);
  assert.equal(h.states.a.folders[1].messages.get(1).uid, 1);
  assert.equal(h.states.a.folders[2].messages.size, 0);
  assert.equal(h.states.a.folders[0].messages.get(3).flags.has('\\Deleted'), true);
  assert.ok(h.clients.every(client => client.closed));
});

test('delete accepts an unambiguous exact Trash fallback and reports provider failure', async () => {
  for (const failure of [false, true]) {
    const h = harness({ a: { capabilities: ['MOVE'], moveFailure: failure,
      folders: [{ path: 'INBOX', messages: [mail(1)] }, { path: 'Deleted Items' }] } });
    const reference = (await h.reader.list(h.accounts)).messages[0].reference;
    if (failure) await assert.rejects(h.reader.apply(h.accounts[0], reference, 'delete'), { code: 'mailbox_error' });
    else assert.deepEqual(await h.reader.apply(h.accounts[0], reference, 'delete'), { applied: true });
    assert.equal(h.states.a.folders[0].messages.has(1), failure);
  }
});

test('delete refuses missing, ambiguous, conflicting or current Trash and providers lacking native MOVE', async () => {
  for (const scenario of [
    { folders: [] },
    { folders: [{ path: 'Trash' }, { path: 'Deleted Items' }] },
    { folders: [{ path: 'One', specialUse: '\\Trash' }, { path: 'Two', specialUse: '\\Trash' }] },
    { folders: [{ path: 'Trash', flags: new Set(['\\Noselect']) }] },
    { folders: [{ path: 'Trash', specialUse: '\\Sent' }] },
    { folders: [{ path: 'Trash', specialUse: '\\Trash', flags: new Set(['\\Junk']) }] },
    { folders: [{ path: 'Trash' }], capabilities: [] },
    { folders: [], inboxFlags: new Set(['\\Trash']) },
    { folders: [], source: 'Trash' }
  ]) {
    const source = scenario.source ?? 'INBOX';
    const h = harness({ a: { capabilities: scenario.capabilities ?? ['MOVE'], folders: [
      { path: source, messages: [mail(1)], flags: scenario.inboxFlags ?? new Set() }, ...scenario.folders
    ] } });
    const reference = (await h.reader.list(h.accounts, { folder: source === 'Trash' ? 'trash' : 'inbox' })).messages[0].reference;
    await assert.rejects(h.reader.apply(h.accounts[0], reference, 'delete'), { code: 'delete_unavailable' });
    assert.equal(h.calls.some(call => call.action === 'move' || call.action === 'write'), false);
  }
});

test('delete revalidates identity, UIDVALIDITY, connection and cancellation immediately before MOVE', async () => {
  for (const mode of ['fingerprint', 'validity', 'missing', 'deleted', 'socket', 'cancel', 'capability']) {
    const controller = new AbortController();
    const h = harness({ a: { capabilities: ['MOVE'], folders: [{ path: 'INBOX', messages: [mail(1)] }, { path: 'Trash' }] } });
    const reference = (await h.reader.list(h.accounts)).messages[0].reference;
    h.states.a.onFetchOne = (uid, query, client) => {
      if (mode === 'fingerprint') client.folder.messages.get(uid).envelope.subject = 'Replaced';
      if (mode === 'validity') client.mailbox.uidValidity = 2n;
      if (mode === 'missing') client.folder.messages.delete(uid);
      if (mode === 'deleted') client.folder.messages.get(uid).flags.add('\\Deleted');
      if (mode === 'socket') client.emit('error', new Error('private provider details'));
      if (mode === 'cancel') controller.abort();
      if (mode === 'capability') client.capabilities.delete('MOVE');
    };
    await assert.rejects(h.reader.apply(h.accounts[0], reference, 'delete', { signal: controller.signal }), {
      code: mode === 'socket' ? 'mailbox_error' : mode === 'cancel' ? 'cancelled' : mode === 'capability' ? 'delete_unavailable' : 'stale_message'
    });
    assert.equal(h.calls.some(call => call.action === 'move' || call.action === 'write'), false);
  }
});

const attachmentStructure = { type: 'multipart/mixed', childNodes: [
  { part: '1', type: 'text/plain' },
  { part: '2', type: 'application/pdf', encoding: 'base64', size: 28, dispositionParameters: { filename: '../invoice.pdf' } },
  { part: '3', type: 'message/rfc822', disposition: 'attachment', parameters: { name: 'forwarded.eml' }, childNodes: [{ part: '3.1', type: 'image/png' }] }
] };

test('reader exposes safe attachment metadata and downloads only a discovered part without marking read', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { bodyStructure: attachmentStructure })] }] } });
  const reference = (await h.reader.list(h.accounts)).messages[0].reference;
  const result = await h.reader.read(h.accounts[0], reference);
  assert.deepEqual(result.attachments, [
    { id: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 21 },
    { id: '3', filename: 'forwarded.eml', mimeType: 'message/rfc822', size: null }
  ]);
  assert.equal(h.calls.some(call => call.action === 'download'), false);
  const downloaded = await h.reader.attachment(h.accounts[0], reference, '2');
  assert.deepEqual(downloaded, { filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: Buffer.from('downloaded attachment') });
  assert.equal(h.calls.find(call => call.action === 'download').part, '2');
  assert.equal(h.states.a.folders[0].messages.get(1).flags.has('\\Seen'), false);
  assert.equal(h.calls.some(call => call.action === 'write' || call.action === 'move'), false);
  assert.ok(h.calls.filter(call => call.action === 'open').every(call => call.readOnly));
});

test('attachments reject arbitrary MIME sections, body parts, nested attached message parts and stale references', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { bodyStructure: attachmentStructure })] }] } });
  const reference = (await h.reader.list(h.accounts)).messages[0].reference;
  for (const part of ['', '2.mime', 'header', 'text', '2\r\nUID FETCH', '1\n', '1\r\n', '0', null]) {
    await assert.rejects(h.reader.attachment(h.accounts[0], reference, part), { code: 'invalid_request' });
  }
  for (const part of ['1', '99', '3.1']) await assert.rejects(h.reader.attachment(h.accounts[0], reference, part), { code: 'attachment_unavailable' });
  assert.equal(h.calls.some(call => call.action === 'download'), false);
  h.states.a.folders[0].uidValidity = 2n;
  await assert.rejects(h.reader.attachment(h.accounts[0], reference, '2'), { code: 'stale_message' });
  assert.equal(h.calls.some(call => call.action === 'download'), false);
});

test('top-level attachments use TEXT including message/rfc822 structures containing children', async () => {
  for (const structure of [{ type: 'application/pdf' }, { type: 'message/rfc822', childNodes: [{ type: 'text/plain' }] }]) {
    const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { bodyStructure: structure })] }] } });
    const reference = (await h.reader.list(h.accounts)).messages[0].reference;
    await h.reader.attachment(h.accounts[0], reference, '1');
    assert.equal(h.calls.find(call => call.action === 'download').part, 'text');
  }
});

test('attachment downloads reject oversized decoded output and missing streams without returning partial files', async () => {
  for (const mode of ['oversized', 'missing', 'empty']) {
    const h = harness({ a: { downloadMissing: mode === 'missing', downloadChunks: mode === 'oversized' ?
      [Buffer.alloc(MAX_ATTACHMENT_BYTES), Buffer.alloc(1)] : [Buffer.alloc(0)],
      folders: [{ path: 'INBOX', messages: [mail(1, { bodyStructure: mode !== 'missing' ? {
        ...attachmentStructure, childNodes: attachmentStructure.childNodes.map(part => part.part === '2' ? {
          ...part, size: mode === 'empty' ? 0 : Math.ceil((MAX_ATTACHMENT_BYTES + 1) / 3) * 4
        } : part)
      } : attachmentStructure })] }] } });
    const reference = (await h.reader.list(h.accounts)).messages[0].reference;
    if (mode === 'empty') assert.equal((await h.reader.attachment(h.accounts[0], reference, '2')).bytes.length, 0);
    else await assert.rejects(h.reader.attachment(h.accounts[0], reference, '2'), { code: mode === 'oversized' ? 'attachment_too_large' : 'attachment_unavailable' });
  }
});

test('attachment downloads revalidate the message and mailbox while collecting bytes', async () => {
  for (const mode of ['fingerprint', 'validity', 'deleted', 'cancel', 'socket']) {
    const controller = new AbortController();
    const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { bodyStructure: attachmentStructure })] }] } });
    const reference = (await h.reader.list(h.accounts)).messages[0].reference;
    h.states.a.onDownload = (uid, part, client) => {
      if (mode === 'fingerprint') client.folder.messages.get(uid).envelope.subject = 'Replaced';
      if (mode === 'validity') client.mailbox.uidValidity = 2n;
      if (mode === 'deleted') client.folder.messages.get(uid).flags.add('\\Deleted');
      if (mode === 'cancel') controller.abort();
      if (mode === 'socket') client.emit('error', new Error('private provider details'));
    };
    await assert.rejects(h.reader.attachment(h.accounts[0], reference, '2', { signal: controller.signal }), {
      code: mode === 'cancel' ? 'cancelled' : mode === 'socket' ? 'mailbox_error' : 'stale_message'
    });
    assert.ok(h.clients.every(client => client.closed));
  }
});

test('attachment downloads revalidate once more after the last body chunk', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { bodyStructure: attachmentStructure })] }] } });
  const reference = (await h.reader.list(h.accounts)).messages[0].reference;
  let metadataReads = 0;
  h.states.a.onFetchOne = (uid, query, client) => {
    if (!query.bodyParts && ++metadataReads === 2) client.folder.messages.get(uid).envelope.subject = 'Replaced after download';
  };
  await assert.rejects(h.reader.attachment(h.accounts[0], reference, '2'), { code: 'stale_message' });
  assert.equal(h.calls.filter(call => call.action === 'attachment-chunk').length, 1);
  assert.equal(metadataReads, 2);
});

test('custom folders have stable account-scoped opaque IDs and All mail avoids Gmail label duplicates', async () => {
  const h = harness({ a: { capabilities: ['X-GM-EXT-1'], folders: [
    { path: 'INBOX', messages: [mail(1)] }, { path: 'Projects', messages: [mail(1)] },
    { path: '[Gmail]/All Mail', specialUse: '\\All', messages: [mail(1), mail(2)] },
    { path: 'Spam', messages: [mail(3)] }, { path: 'Trash', messages: [mail(4)] }
  ] }, b: { folders: [{ path: 'INBOX' }, { path: 'Projects', messages: [mail(5)] }] } });
  const folders = (await h.reader.folders(h.accounts)).folders.filter(folder => folder.type === 'provider');
  assert.equal(folders.length, 2); assert.notEqual(folders[0].id, folders[1].id);
  assert.ok(folders.every(folder => /^folder:[a-f0-9]{64}$/u.test(folder.id)));
  assert.deepEqual((await h.reader.folders(h.accounts)).folders.filter(folder => folder.type === 'provider'), folders);
  const selected = folders.find(folder => folder.accountIds.includes('a'));
  const one = await h.reader.list(h.accounts, { folder: selected.id });
  assert.deepEqual(one.messages.map(item => item.accountId), ['a']); assert.equal(one.total, 1);
  h.calls.length = 0;
  const all = await h.reader.list(h.accounts.slice(0, 1), { folder: 'all' });
  assert.equal(all.total, 4);
  assert.deepEqual(h.calls.filter(call => call.action === 'open').map(call => call.path), ['[Gmail]/All Mail', 'Spam', 'Trash']);
});

test('advanced provider search combines body, dates, flags, addresses, subject and inclusive size bounds', async () => {
  const matching = mail(1, { size: 80, internalDate: new Date('2026-09-15'), flags: new Set(['\\Flagged']), body: 'private receipt term' });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [matching, mail(2)] }] } });
  const result = await h.reader.list(h.accounts, { filters: { from: 'sender', to: 'recipient', subject: 'Message', body: 'receipt',
    since: '2026-09-15', before: '2026-09-16', unread: true, starred: true, minSize: 80, maxSize: 80 } });
  assert.deepEqual(result.messages.map(item => item.reference.uid), [1]);
  const criteria = h.calls.find(call => call.action === 'search').criteria;
  assert.equal(criteria.larger, 79); assert.equal(criteria.smaller, 81);
  const compiled = searchCompiler({ capabilities: new Set(), enabled: new Set() }, criteria);
  assert.ok(compiled.some(item => item.value === 'BODY'));
  assert.ok(compiled.some(item => item.value === 'BEFORE'));
  assert.equal((await h.reader.list(h.accounts, { query: 'receipt', bodySearch: true })).total, 1);
  assert.equal((await h.reader.list(h.accounts, { query: 'receipt' })).total, 0);
  for (const filters of [{ before: '2026-02-30' }, { minSize: -1 }, { minSize: 8, maxSize: 2 }, { arbitrary: true }, { unread: 'yes' }]) {
    await assert.rejects(h.reader.list(h.accounts, { filters }), { code: 'invalid_request' });
  }
});

test('attachment filters fetch structure without bytes and count every matching message', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { bodyStructure: attachmentStructure }), mail(2)] }] } });
  const withFiles = await h.reader.list(h.accounts, { filters: { hasAttachment: true } });
  assert.equal(withFiles.total, 1); assert.equal(withFiles.messages[0].hasAttachments, true);
  const withoutFiles = await h.reader.list(h.accounts, { filters: { hasAttachment: false } });
  assert.equal(withoutFiles.total, 1); assert.equal(withoutFiles.messages[0].reference.uid, 2);
  assert.equal(h.calls.some(call => ['download', 'body', 'attachment-chunk'].includes(call.action)), false);
});

test('alternate sort orders scan the full candidate set and retain deterministic cursor boundaries', async () => {
  const messages = Array.from({ length: 300 }, (_, index) => mail(index + 1, {
    envelope: { date: new Date(NOW - index * DAY), subject: `Subject ${String(300 - index).padStart(3, '0')}`,
      from: [{ address: `${String(300 - index).padStart(3, '0')}@example.test` }], messageId: `<${index}@example.test>` }
  }));
  for (const sort of ['date_asc', 'subject_asc', 'sender_asc']) {
    const h = harness({ a: { folders: [{ path: 'INBOX', messages }] } });
    const first = await h.reader.list(h.accounts, { sort, limit: 2 });
    assert.deepEqual(first.messages.map(item => item.reference.uid), [300, 299]);
    assert.equal(h.calls.filter(call => call.action === 'headers').reduce((sum, call) => sum + call.uids.length, 0), 300);
    const next = await h.reader.list(h.accounts, { sort, limit: 2, cursor: first.nextCursor });
    assert.deepEqual(next.messages.map(item => item.reference.uid), [298, 297]);
    await assert.rejects(h.reader.list(h.accounts, { sort: 'date_desc', cursor: first.nextCursor }), { code: 'stale_message' });
    await assert.rejects(h.reader.list(h.accounts, { sort, filters: { unread: true }, cursor: first.nextCursor }), { code: 'stale_message' });
  }
});

test('thread metadata follows References and In-Reply-To with account scope, never subject alone', async () => {
  const messages = [mail(1), mail(2, { envelope: { subject: 'Re: Message 1', messageId: '<reply@test>', inReplyTo: '<1@example.test>',
    references: '<1@example.test>', cc: [{ address: 'copy@example.test' }], replyTo: [{ address: 'reply@example.test' }] } }),
    mail(3, { envelope: { subject: 'Message 1', messageId: '<other@test>' } })];
  const h = harness({ a: { folders: [{ path: 'INBOX', messages }] }, b: { folders: [{ path: 'INBOX', messages: [mail(1)] }] } });
  const result = await h.reader.list(h.accounts);
  const a = result.messages.filter(item => item.accountId === 'a'), b = result.messages.find(item => item.accountId === 'b');
  const root = a.find(item => item.reference.uid === 1), reply = a.find(item => item.reference.uid === 2), other = a.find(item => item.reference.uid === 3);
  assert.equal(root.threadId, reply.threadId); assert.notEqual(root.threadId, other.threadId); assert.notEqual(root.threadId, b.threadId);
  assert.equal(reply.cc, 'copy@example.test'); assert.equal(reply.replyTo, 'reply@example.test');
  assert.deepEqual(reply.references, ['<1@example.test>']); assert.equal(root.size, 20);
});

test('archive, move, restore and spam use native MOVE and return provider-confirmed references for undo', async () => {
  for (const [action, source, target] of [['archive', 'INBOX', 'Archive'], ['move', 'INBOX', 'Projects'],
    ['restore', 'Trash', 'INBOX'], ['spam', 'INBOX', 'Spam'], ['not_spam', 'Spam', 'INBOX']]) {
    const h = harness({ a: { capabilities: ['MOVE'], moveUid: 100, folders: ['INBOX', 'Archive', 'Projects', 'Trash', 'Spam'].map(path => ({
      path, uidValidity: path === target ? 12n : 1n, messages: path === source ? [mail(1)] : []
    })) } });
    const folders = await h.reader.folders(h.accounts);
    const targetId = folders.folders.find(folder => folder.label === target)?.id;
    const entry = (await h.reader.list(h.accounts, { folder: 'all' })).messages[0];
    const result = await h.reader.apply(h.accounts[0], entry.reference, action, { destinationId: targetId });
    assert.equal(result.applied, true); assert.equal(result.reference.path, target); assert.equal(result.reference.uid, 100);
    assert.equal(result.reference.uidValidity, '12'); assert.equal(result.reference.fingerprint, entry.reference.fingerprint);
    assert.deepEqual(result.undo.reference, result.reference); assert.match(result.undo.destinationId, /^folder:[a-f0-9]{64}$/u);
    assert.equal((await h.reader.read(h.accounts[0], result.reference)).subject, 'Message 1');
    await h.reader.apply(h.accounts[0], result.undo.reference, 'move', { destinationId: result.undo.destinationId });
    assert.equal(h.states.a.folders.find(folder => folder.path === source).messages.size, 1);
  }
});

test('Gmail Inbox archive resolves All Mail when the selected Inbox omits its own label', async () => {
  const source = mail(1, { emailId: '123456789', labels: new Set(['Work']) });
  const alias = { ...source, uid: 9, labels: new Set(['\\Inbox', '\\Sent', '\\Draft', 'Work']) };
  const h = harness({ a: { capabilities: ['X-GM-EXT-1'], folders: [{ path: 'INBOX', messages: [source] },
    { path: 'All Mail', specialUse: '\\All', messages: [alias] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const result = await h.reader.apply(h.accounts[0], entry.reference, 'archive');
  assert.equal(result.applied, true); assert.equal(result.reference.path, 'All Mail'); assert.equal(result.reference.uid, 9);
  assert.deepEqual(result.undo.reference, result.reference);
  assert.equal(h.states.a.folders[0].messages.size, 0);
  assert.deepEqual([...h.states.a.folders[1].messages.get(9).labels], ['\\Sent', '\\Draft', 'Work']);
  assert.deepEqual(h.calls.filter(call => call.action === 'write').map(call => call.uid), [9]);
  assert.equal(h.calls.filter(call => call.action === 'open').at(-1).path, 'INBOX');
  assert.equal(h.calls.some(call => call.action === 'move'), false);
});

test('Gmail archive rejects no-op STORE, fresh Inbox membership, and mismatched All Mail fingerprints', async () => {
  for (const mode of ['noop', 'inbox-remains', 'changed']) {
    const source = mail(1, { emailId: '123456789', labels: new Set(['Work']) });
    const alias = { ...source, uid: 9, labels: new Set(['\\Inbox', 'Work']), ...(mode === 'changed' ? { size: 21 } : {}) };
    const h = harness({ a: { capabilities: ['X-GM-EXT-1'], gmailNoop: mode === 'noop', keepInbox: mode === 'inbox-remains', folders: [
      { path: 'INBOX', messages: [source] }, { path: 'All Mail', specialUse: '\\All', messages: [alias] }
    ] } });
    const entry = (await h.reader.list(h.accounts)).messages[0];
    await assert.rejects(h.reader.apply(h.accounts[0], entry.reference, 'archive'), { code: mode === 'changed' ? 'stale_message' : 'mailbox_error' });
    assert.equal(h.calls.filter(call => call.action === 'write').length, mode === 'changed' ? 0 : 1);
    assert.equal(h.calls.some(call => call.action === 'move'), false);
  }
});

test('root body preview keeps MIME charset headers separate from References header fields', async () => {
  const source = mail(1, { headers: Buffer.from('References: <root@example.test>\r\n\r\n'),
    mime: 'Content-Type: text/plain; charset=windows-1252\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n',
    body: 'caf=E9', bodyStructure: { part: '1', type: 'text/plain', encoding: 'quoted-printable', size: 6 } });
  const h = harness({ a: { headerCollision: true, folders: [{ path: 'INBOX', messages: [source] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const read = await h.reader.read(h.accounts[0], entry.reference);
  assert.equal(read.body, 'café'); assert.equal(read.bodyUnavailable, false); assert.deepEqual(read.references, ['<root@example.test>']);
  const bodyCall = h.calls.find(call => call.action === 'body'); assert.equal(bodyCall.query.headers, false);
  let captured;
  const client = { state: 1, states: { SELECTED: 1 }, mailbox: {}, capabilities: new Map(), enabled: new Set(),
    exec: async (_command, attributes) => { captured = attributes; return { next() {} }; } };
  await fetchCommand(client, '1', bodyCall.query, bodyCall.options);
  assert.deepEqual(captured[1].filter(item => item.value === 'BODY.PEEK').map(item => item.section[0].value), ['HEADER', 'TEXT']);
});

test('permanent deletion requires verified Trash and UIDPLUS, expunges only the selected UID', async () => {
  const h = harness({ a: { capabilities: ['UIDPLUS'], folders: [{ path: 'INBOX', messages: [mail(3)] },
    { path: 'Trash', messages: [mail(1), mail(2, { flags: new Set(['\\Deleted']) })] }] } });
  const entry = (await h.reader.list(h.accounts, { folder: 'trash' })).messages[0];
  await h.reader.apply(h.accounts[0], entry.reference, 'delete_permanent');
  assert.deepEqual([...h.states.a.folders[1].messages.keys()], [2]);
  assert.deepEqual(h.calls.filter(call => call.action === 'expunge').map(call => [call.command, call.uid]), [['UID EXPUNGE', 1]]);
  const inbox = (await h.reader.list(h.accounts)).messages[0];
  await assert.rejects(h.reader.apply(h.accounts[0], inbox.reference, 'delete_permanent'), { code: 'delete_unavailable' });
  for (const configuration of [{ capabilities: [] }, { capabilities: ['UIDPLUS'], flagFailure: true }]) {
    const blocked = harness({ a: { ...configuration, folders: [{ path: 'Trash', messages: [mail(1)] }] } });
    const target = (await blocked.reader.list(blocked.accounts, { folder: 'trash' })).messages[0];
    await assert.rejects(blocked.reader.apply(blocked.accounts[0], target.reference, 'delete_permanent'),
      { code: configuration.flagFailure ? 'mailbox_error' : 'delete_unavailable' });
    assert.equal(blocked.calls.some(call => call.action === 'expunge'), false);
  }
});

test('empty Trash requires explicit confirmation and preserves unrelated Deleted mail and concurrent arrivals', async () => {
  const h = harness({ a: { capabilities: ['UIDPLUS'], folders: [{ path: 'Trash', messages: [mail(1), mail(2), mail(3), mail(8, { flags: new Set(['\\Deleted']) })] }],
    onWrite: (_uid, _flags, client) => client.folder.messages.set(9, mail(9)) } });
  await assert.rejects(h.reader.emptyTrash(h.accounts[0], {}), { code: 'invalid_request' });
  const result = await h.reader.emptyTrash(h.accounts[0], { confirm: true, limit: 2 });
  assert.deepEqual(result, { deleted: 2, remaining: 2, partial: true, errors: [] });
  assert.deepEqual([...h.states.a.folders[0].messages.keys()], [3, 8, 9]);
  assert.deepEqual(h.calls.filter(call => call.action === 'expunge').map(call => call.uid), [1, 2]);
});

test('folder create and rename resolve account-scoped IDs and reject special folders and unsafe names', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX' }, { path: 'Projects', delimiter: '/' }] }, b: { folders: [{ path: 'INBOX' }, { path: 'Projects', delimiter: '/' }] } });
  const folders = (await h.reader.folders(h.accounts)).folders;
  const parent = folders.find(folder => folder.label === 'Projects' && folder.accountIds.includes('a'));
  const child = await h.reader.manageFolder(h.accounts[0], { action: 'create', parentId: parent.id, name: 'Receipts' });
  assert.equal(h.states.a.folders.at(-1).path, 'Projects/Receipts');
  const renamed = await h.reader.manageFolder(h.accounts[0], { action: 'rename', folderId: child.folder.id, name: 'Invoices' });
  assert.notEqual(renamed.folder.id, child.folder.id); assert.equal(h.states.a.folders.at(-1).path, 'Projects/Invoices');
  await assert.rejects(h.reader.manageFolder(h.accounts[1], { action: 'rename', folderId: renamed.folder.id, name: 'Other' }), { code: 'mailbox_error' });
  await assert.rejects(h.reader.manageFolder(h.accounts[0], { action: 'rename', folderId: 'inbox', name: 'Other' }), { code: 'invalid_request' });
  for (const name of ['../Other', '\\Trash', 'Bad\r\nName', '*', '..', 'INBOX']) {
    await assert.rejects(h.reader.manageFolder(h.accounts[0], { action: 'create', name }), { code: 'invalid_request' });
  }
});

test('provider labels discover Gmail folders or IMAP keywords and reject system label writes', async () => {
  for (const gmail of [true, false]) {
    const h = harness({ a: { capabilities: gmail ? ['X-GM-EXT-1'] : [], folders: [
      { path: 'INBOX', permanentFlags: new Set(['\\Seen', '\\*', 'Work']), messages: [mail(1)] }, { path: 'Work' }
    ] } });
    const available = await h.reader.providerLabels(h.accounts[0]);
    assert.equal(available.supported, true); assert.equal(available.kind, gmail ? 'gmail' : 'keywords'); assert.ok(available.labels.includes('Work'));
    const entry = (await h.reader.list(h.accounts)).messages[0];
    const label = gmail ? 'Project receipts' : 'Receipts';
    await h.reader.setProviderLabel(h.accounts[0], entry.reference, { label, enabled: true });
    const values = gmail ? h.states.a.folders[0].messages.get(1).labels : h.states.a.folders[0].messages.get(1).flags;
    assert.ok(values.has(label));
    await h.reader.setProviderLabel(h.accounts[0], entry.reference, { label, enabled: false }); assert.equal(values.has(label), false);
    for (const bad of ['\\Deleted', '\\Trash', '[Gmail]/Trash', 'bad\r\nname']) {
      await assert.rejects(h.reader.setProviderLabel(h.accounts[0], entry.reference, { label: bad, enabled: true }), { code: 'invalid_request' });
    }
  }
});

test('mail change monitor uses only Inbox STATUS and reports independent account failures', async () => {
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1)] }, { path: 'Projects' }] }, b: { error: new Error('private') } });
  const before = await h.reader.changes(h.accounts);
  assert.deepEqual(before.errors, [{ accountId: 'b', code: 'mailbox_error' }]); assert.equal(before.states[0].uidNext, 2);
  assert.equal((await h.reader.changes(h.accounts)).signature, before.signature);
  h.states.a.folders[0].messages.set(2, mail(2));
  const after = await h.reader.changes(h.accounts); assert.notEqual(after.signature, before.signature);
  assert.ok(h.calls.every(call => call.action === 'status' && call.path === 'INBOX'));
});

test('full source reads bounded BODY.PEEK chunks, preserves original bytes and revalidates identity', async () => {
  const original = Buffer.concat([Buffer.from('Subject: Source\r\n\r\n'), Buffer.alloc(140000, 65)]);
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { source: original, size: original.length })] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const source = await h.reader.source(h.accounts[0], entry.reference);
  assert.deepEqual(source, original); assert.equal(h.states.a.folders[0].messages.get(1).flags.has('\\Seen'), false);
  const chunks = h.calls.filter(call => call.query?.source);
  assert.equal(chunks.length, 4); assert.deepEqual(chunks.map(call => call.query.source.start), [0, 65536, 131072, original.length]);
  let captured;
  const client = { state: 1, states: { SELECTED: 1 }, mailbox: {}, capabilities: new Map(), enabled: new Set(),
    exec: async (command, attributes) => { captured = { command, attributes }; return { next() {} }; } };
  await fetchCommand(client, '1', chunks[0].query, chunks[0].options);
  assert.equal(captured.command, 'UID FETCH');
  assert.ok(captured.attributes[1].some(item => item.value === 'BODY.PEEK' && item.section.length === 0 && item.partial[1] === 65536));
  h.states.a.onFetchOne = (uid, query, activeClient) => { if (query.source?.start > 0) activeClient.folder.messages.get(uid).envelope.subject = 'Changed'; };
  await assert.rejects(h.reader.source(h.accounts[0], entry.reference), { code: 'stale_message' });
});

test('full source uses actual EOF when the advertised message size is larger or smaller', async t => {
  const original = Buffer.concat([Buffer.from('Subject: Variable source size\r\n\r\n'), Buffer.alloc(140000, 65)]);
  for (const size of [original.length + 15234, 20, 0]) await t.test(`advertised size ${size}`, async () => {
    const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { source: original, size })] }] } });
    const entry = (await h.reader.list(h.accounts)).messages[0];
    assert.deepEqual(await h.reader.source(h.accounts[0], entry.reference), original);
    const chunks = h.calls.filter(call => call.query?.source);
    assert.deepEqual(chunks.map(call => call.query.source.start), [0, 65536, 131072, original.length]);
    assert.equal(h.states.a.folders[0].messages.get(1).flags.has('\\Seen'), false);
  });
});

test('full source enforces the limit on actual bytes and accepts an exact-limit source', async t => {
  const maxBytes = 70000;
  for (const size of [maxBytes, 20]) await t.test(`exact limit with advertised size ${size}`, async () => {
    const original = Buffer.alloc(maxBytes, 65);
    const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { source: original, size })] }] } });
    const entry = (await h.reader.list(h.accounts)).messages[0];
    assert.deepEqual(await h.reader.source(h.accounts[0], entry.reference, { maxBytes }), original);
    const chunks = h.calls.filter(call => call.query?.source);
    assert.deepEqual(chunks.map(call => [call.query.source.start, call.query.source.maxLength]), [[0, 65536], [65536, 4465], [maxBytes, 1]]);
  });
  await t.test('underreported source exceeds the actual byte limit', async () => {
    const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { source: Buffer.alloc(maxBytes + 1, 65), size: 20 })] }] } });
    const entry = (await h.reader.list(h.accounts)).messages[0];
    await assert.rejects(h.reader.source(h.accounts[0], entry.reference, { maxBytes }), { code: 'message_too_large' });
    const chunks = h.calls.filter(call => call.query?.source);
    assert.deepEqual(chunks.map(call => [call.query.source.start, call.query.source.maxLength]), [[0, 65536], [65536, 4465]]);
  });
  await t.test('advertised size exceeding the limit still rejects before source download', async () => {
    const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { source: Buffer.from('Small'), size: maxBytes + 1 })] }] } });
    const entry = (await h.reader.list(h.accounts)).messages[0];
    await assert.rejects(h.reader.source(h.accounts[0], entry.reference, { maxBytes }), { code: 'message_too_large' });
    assert.equal(h.calls.some(call => call.query?.source), false);
  });
});

test('full source continues after short chunks until an explicit empty buffer', async () => {
  const original = Buffer.from('Subject: Short chunks\r\n\r\nComplete body');
  const received = [];
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { source: original, size: 20 })] }],
    onSource(message, query) {
      message.source = message.source.subarray(0, 7);
      received.push({ start: query.start, length: message.source.length });
    } } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  assert.deepEqual(await h.reader.source(h.accounts[0], entry.reference), original);
  assert.deepEqual(received.map(chunk => chunk.start), [0, 7, 14, 21, 28, 35, original.length]);
  assert.equal(received.at(-1).length, 0);
  assert.equal(received.at(-2).length, original.length - 35);
});

test('full source distinguishes EOF from absent source buffers or an unexpectedly empty message', async t => {
  for (const offset of [0, 65536]) await t.test(`missing source buffer at offset ${offset}`, async () => {
    const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { source: Buffer.alloc(70000, 65), size: 20 })] }],
      onSource(message, query) { if (query.start === offset) delete message.source; } } });
    const entry = (await h.reader.list(h.accounts)).messages[0];
    await assert.rejects(h.reader.source(h.accounts[0], entry.reference), { code: 'mailbox_error' });
  });
  await t.test('nonempty advertised message cannot return an empty first chunk', async () => {
    const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { source: Buffer.alloc(0), size: 20 })] }] } });
    const entry = (await h.reader.list(h.accounts)).messages[0];
    await assert.rejects(h.reader.source(h.accounts[0], entry.reference), { code: 'mailbox_error' });
  });
  await t.test('an empty advertised and actual source is valid', async () => {
    const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { source: Buffer.alloc(0), size: 0 })] }] } });
    const entry = (await h.reader.list(h.accounts)).messages[0];
    assert.deepEqual(await h.reader.source(h.accounts[0], entry.reference), Buffer.alloc(0));
  });
});

test('full source revalidates message identity after the explicit EOF response', async t => {
  for (const changed of ['fingerprint', 'uidValidity']) await t.test(changed, async () => {
    let reachedEof = false, finalCheck = false;
    const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mail(1, { source: Buffer.from('Complete source'), size: 20 })] }],
      onSource(message) { if (message.source.length === 0) reachedEof = true; },
      onFetchOne(uid, query, client) {
        if (!reachedEof || query.source) return;
        finalCheck = true;
        if (changed === 'fingerprint') client.folder.messages.get(uid).envelope.subject = 'Changed after EOF';
        else client.mailbox.uidValidity = 2n;
      } } });
    const entry = (await h.reader.list(h.accounts)).messages[0];
    await assert.rejects(h.reader.source(h.accounts[0], entry.reference), { code: 'stale_message' });
    assert.equal(finalCheck, true);
  });
});

test('label-scoped search verifies fingerprints and deduplicates physical copies with stable cursors', async () => {
  const duplicate = mail(1);
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [duplicate, mail(2), mail(3)] },
    { path: 'Projects', messages: [{ ...duplicate, uid: 9 }] }] }, b: { folders: [{ path: 'INBOX', messages: [mail(1)] }] } });
  const originals = await h.reader.list(h.accounts, { folder: 'inbox' });
  const scopedReferences = originals.messages.filter(message => message.accountId === 'a' && message.reference.uid < 3).map(message => message.reference);
  const first = await h.reader.list(h.accounts, { folder: 'all', filters: { unread: true }, scopedReferences, limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.messages[0].reference.uid, 1); assert.equal(first.messages[0].accountId, 'a');
  const next = await h.reader.list(h.accounts, { folder: 'all', filters: { unread: true }, scopedReferences, limit: 1, cursor: first.nextCursor });
  assert.equal(next.messages[0].reference.uid, 2); assert.equal(next.nextCursor, null);
  await assert.rejects(h.reader.list(h.accounts, { folder: 'all', filters: { unread: true }, scopedReferences: scopedReferences.slice(0, 1), cursor: first.nextCursor }), { code: 'stale_message' });
});

test('content reader reads complete plain text and returns structured contract without marking seen', async () => {
  const plainMail = mail(1, {
    body: 'Hello, this is a complete plain message.',
    bodyStructure: { part: '1', type: 'text/plain', size: 40 }
  });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [plainMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];

  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.text, 'Hello, this is a complete plain message.');
  assert.equal(content.html, '');
  assert.equal(content.complete, true);
  assert.equal(content.sanitized, false);
  assert.equal(content.encrypted, null);
  assert.equal(content.subject, 'Message 1');
  assert.ok(Array.isArray(content.from));
  assert.equal(content.from[0].address, 'sender@example.test');
  assert.equal(h.states.a.folders[0].messages.get(1).flags.has('\\Seen'), false);
  assert.equal(h.calls.filter(call => call.action === 'source').length, 0);
});

test('content reader parses multipart/alternative with both plain and HTML bodies', async () => {
  const plainText = 'Plain body text';
  const htmlText = '<b>HTML bold text</b>';
  const multiMail = mail(2, {
    bodyStructure: {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', size: Buffer.byteLength(plainText) },
        { part: '2', type: 'text/html', size: Buffer.byteLength(htmlText) }
      ]
    },
    partBodies: {
      '1': plainText,
      '2': htmlText
    },
    partMimes: {
      '1': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n',
      '2': 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
    }
  });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [multiMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];

  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.text, 'Plain body text');
  assert.equal(content.html, '<b>HTML bold text</b>');
  assert.equal(content.complete, true);
  assert.equal(content.sanitized, false);
});

test('content reader excludes attachment bytes and nested message bodies while retaining attachment IDs', async () => {
  const topBodyText = 'Top body';
  const attachMail = mail(3, {
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: Buffer.byteLength(topBodyText) },
        {
          part: '2',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'invoice.pdf' },
          size: 5000
        },
        {
          part: '3',
          type: 'message/rfc822',
          disposition: 'attachment',
          size: 1200,
          childNodes: [
            { part: '3.1', type: 'text/plain', size: 20 }
          ]
        }
      ]
    },
    partBodies: {
      '1': topBodyText
    }
  });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [attachMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];

  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.text, 'Top body');
  assert.equal(content.complete, true);
  assert.equal(content.attachments.length, 2);
  assert.equal(content.attachments[0].filename, 'invoice.pdf');
  assert.equal(content.attachments[0].mimeType, 'application/pdf');
  assert.equal(h.calls.filter(call => call.action === 'download').length, 0);
});

test('content reader detects unsupported encrypted messages', async () => {
  const encMail = mail(4, {
    bodyStructure: {
      type: 'multipart/encrypted',
      parameters: { protocol: 'application/pgp-encrypted' },
      childNodes: [
        { part: '1', type: 'application/pgp-encrypted', size: 50 },
        { part: '2', type: 'application/octet-stream', size: 4000 }
      ]
    }
  });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [encMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];

  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.complete, false);
  assert.equal(content.unsupportedEncrypted, true);
  assert.equal(content.encrypted.type, 'openpgp');
  assert.equal(content.encrypted.decrypted, false);
});

test('content reader enforces encoded and decoded byte limits and catches early short fetch', async () => {
  const largeMail = mail(5, {
    bodyStructure: { part: '1', type: 'text/plain', size: 10000 },
    body: 'x'.repeat(10000)
  });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [largeMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];

  await assert.rejects(h.reader.content(h.accounts[0], entry.reference, { maxEncodedBytes: 500 }), { code: 'content_too_large' });
  await assert.rejects(h.reader.content(h.accounts[0], entry.reference, { maxDecodedBytes: 500 }), { code: 'content_too_large' });

  const shortMail = mail(6, {
    bodyStructure: { part: '1', type: 'text/plain', size: 10000 },
    partBodies: { '1': 'short' }
  });
  h.states.a.folders[0].messages.set(6, shortMail);
  const shortList = await h.reader.list(h.accounts);
  const shortEntry = shortList.messages.find(m => m.reference.uid === 6);
  await assert.rejects(h.reader.content(h.accounts[0], shortEntry.reference), { code: 'content_unavailable' });
});

test('contentBatch retrieves multiple references within a single session', async () => {
  const mailA = mail(10, { body: 'Message 10 text', bodyStructure: { part: '1', type: 'text/plain', size: 15 } });
  const mailB = mail(11, { body: 'Message 11 text', bodyStructure: { part: '1', type: 'text/plain', size: 15 } });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mailA, mailB] }] } });
  const entries = (await h.reader.list(h.accounts)).messages;
  const references = entries.map(m => m.reference);

  const results = await h.reader.contentBatch(h.accounts[0], references);
  assert.equal(results.length, 2);
  assert.equal(results[0].content.text, 'Message 10 text');
  assert.equal(results[1].content.text, 'Message 11 text');
  assert.equal(results[0].content.complete, true);
  assert.equal(results[1].content.complete, true);
});

test('content reader rejects missing MIME header or missing body buffer', async () => {
  const mailNoBody = mail(20, {
    bodyStructure: { part: '1', type: 'text/plain', size: 15 },
    bodyMissing: true
  });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mailNoBody] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  await assert.rejects(h.reader.content(h.accounts[0], entry.reference), { code: 'content_unavailable' });

  const mailNoMime = mail(21, {
    bodyStructure: { part: '1', type: 'text/plain', size: 15 },
    mimeMissing: true
  });
  h.states.a.folders[0].messages.set(21, mailNoMime);
  const list2 = await h.reader.list(h.accounts);
  const entry2 = list2.messages.find(m => m.reference.uid === 21);
  await assert.rejects(h.reader.content(h.accounts[0], entry2.reference), { code: 'content_unavailable' });
});

test('content reader rejects malformed base64 and invalid MIME headers', async () => {
  const mailBadB64 = mail(22, {
    bodyStructure: { part: '1', type: 'text/plain', size: 10, encoding: 'base64' },
    body: 'invalid===b64'
  });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mailBadB64] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  await assert.rejects(h.reader.content(h.accounts[0], entry.reference), { code: 'content_unavailable' });

  const mailDupHeader = mail(23, {
    bodyStructure: { part: '1', type: 'text/plain', size: 10 },
    mime: 'Content-Type: text/plain\r\nContent-Type: text/html\r\n\r\n'
  });
  h.states.a.folders[0].messages.set(23, mailDupHeader);
  const list2 = await h.reader.list(h.accounts);
  const entry2 = list2.messages.find(m => m.reference.uid === 23);
  await assert.rejects(h.reader.content(h.accounts[0], entry2.reference), { code: 'content_unavailable' });
});

test('content reader avoids root header collision by suppressing References query', async () => {
  const testMail = mail(24, {
    body: 'Hello from uncollided root body',
    bodyStructure: { part: '1', type: 'text/plain', size: 31 }
  });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [testMail] }] } });
  h.states.a.headerCollision = true;
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.text, 'Hello from uncollided root body');
  assert.equal(content.complete, true);
});

test('content reader preserves visible body order in multipart/mixed with multiple inline parts', async () => {
  const chunk1 = 'First chunk';
  const chunk2 = 'Second chunk';
  const mixedMail = mail(25, {
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: Buffer.byteLength(chunk1) },
        { part: '2', type: 'text/plain', size: Buffer.byteLength(chunk2) }
      ]
    },
    partBodies: {
      '1': chunk1,
      '2': chunk2
    },
    partMimes: {
      '1': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n',
      '2': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
    }
  });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mixedMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.text, 'First chunk\n\nSecond chunk');
  assert.equal(content.complete, true);
});

test('content reader decodes exact charset data and preserves read flag', async () => {
  const charsetMail = mail(26, {
    bodyStructure: {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain', size: 11, parameters: { format: 'flowed', delsp: 'yes' } },
        { part: '2', type: 'text/html', size: 21, parameters: { charset: 'utf-8' } }
      ]
    },
    partBodies: {
      '1': 'Flowed text',
      '2': '<p>Html paragraph</p>'
    },
    partMimes: {
      '1': 'Content-Type: text/plain; charset=utf-8; format=flowed; delsp=yes\r\nContent-Transfer-Encoding: 7bit\r\n\r\n',
      '2': 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
    }
  });
  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [charsetMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.text, 'Flowed text');
  assert.equal(content.html, '<p>Html paragraph</p>');
  assert.equal(h.states.a.folders[0].messages.get(26).flags.has('\\Seen'), false);
});

test('content reader includes inlineParts metadata for raster images without fetching bytes', async () => {
  const inlineImgMail = mail(27, {
    bodyStructure: {
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html', size: 24 },
        {
          part: '2',
          type: 'image/png',
          id: '<logo.png@mailharbor>',
          size: 4096,
          disposition: 'inline'
        },
        {
          part: '3',
          type: 'image/jpeg',
          id: 'banner@mailharbor',
          size: 8192
        }
      ]
    },
    partBodies: {
      '1': '<img src="cid:logo.png">'
    },
    partMimes: {
      '1': 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
    }
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [inlineImgMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const content = await h.reader.content(h.accounts[0], entry.reference);

  assert.equal(content.html, '<img src="cid:logo.png">');
  assert.ok(Array.isArray(content.inlineParts), 'inlineParts must be an array');
  assert.equal(content.inlineParts.length, 2);
  assert.deepEqual(content.inlineParts[0], {
    id: '2',
    contentId: 'logo.png@mailharbor',
    mimeType: 'image/png',
    size: 4096
  });
  assert.deepEqual(content.inlineParts[1], {
    id: '3',
    contentId: 'banner@mailharbor',
    mimeType: 'image/jpeg',
    size: 8192
  });
  // No byte downloads performed for inline raster images during reader.content
  assert.equal(h.calls.filter(call => call.action === 'download').length, 0);
});

test('content reader fails with content_unavailable when excessive MIME nesting causes traversal truncation', async () => {
  // Build a structure nested 30 levels deep (exceeding MAX_MIME_TRAVERSAL_DEPTH = 25)
  let root = { part: '1', type: 'text/plain', size: 12 };
  for (let i = 29; i >= 1; i--) {
    root = {
      type: 'multipart/mixed',
      childNodes: [root]
    };
  }

  const deepMail = mail(28, {
    bodyStructure: root,
    partBodies: { '1': 'Deep nested' }
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [deepMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  await assert.rejects(
    h.reader.content(h.accounts[0], entry.reference),
    { code: 'content_unavailable' }
  );
});

test('content reader does not classify named attached encrypted file as whole encrypted mail', async () => {
  const mailWithAttach = mail(29, {
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 12 },
        {
          part: '2',
          type: 'application/octet-stream',
          disposition: 'attachment',
          dispositionParameters: { filename: 'encrypted-backup.pgp' },
          size: 2048
        }
      ]
    },
    partBodies: {
      '1': 'Message body'
    },
    partMimes: {
      '1': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
    }
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mailWithAttach] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const content = await h.reader.content(h.accounts[0], entry.reference);

  assert.equal(content.complete, true);
  assert.equal(content.unsupportedEncrypted, undefined);
  assert.equal(content.text, 'Message body');
  assert.equal(content.attachments.length, 1);
  assert.equal(content.attachments[0].filename, 'encrypted-backup.pgp');
});

test('content reader rejects invalid base64 padding with content_unavailable', async () => {
  const b64Mail = mail(30, {
    bodyStructure: {
      part: '1',
      type: 'text/plain',
      encoding: 'base64',
      size: 7
    },
    partBodies: {
      // 7 characters cannot be valid base64 (compact.length % 4 !== 0)
      '1': 'abc1234'
    },
    partMimes: {
      '1': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'
    }
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [b64Mail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  await assert.rejects(
    h.reader.content(h.accounts[0], entry.reference),
    { code: 'content_unavailable' }
  );
});

test('content reader supports single text root BODYSTRUCTURE with part omitted', async () => {
  const rootTextMail = mail(31, {
    bodyStructure: {
      type: 'text/plain',
      size: 11
    },
    body: 'Hello World'
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [rootTextMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.text, 'Hello World');
  assert.equal(content.complete, true);
  assert.equal(content.sanitized, false);

  const readRes = await h.reader.read(h.accounts[0], entry.reference);
  assert.equal(readRes.body, 'Hello World');
});

test('content reader handles mixed plain+HTML sibling bodies in multipart/mixed', async () => {
  const mixedMail = mail(32, {
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        { part: '2', type: 'text/html', size: 16 }
      ]
    },
    partBodies: {
      '1': 'Plain note',
      '2': '<b>Bold HTML</b>'
    },
    partMimes: {
      '1': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n',
      '2': 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
    }
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [mixedMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.text, 'Plain note');
  assert.equal(content.html, '<pre style="white-space: pre-wrap; font-family: inherit;">Plain note</pre>\n<b>Bold HTML</b>');
  assert.equal(content.complete, true);
});

test('content reader handles nested alternative with PDF without duplicate content', async () => {
  const nestedMail = mail(33, {
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1',
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', size: 9 },
            { part: '1.2', type: 'text/html', size: 19 }
          ]
        },
        {
          part: '2',
          type: 'application/pdf',
          size: 500,
          disposition: 'attachment',
          dispositionParameters: { filename: 'doc.pdf' }
        }
      ]
    },
    partBodies: {
      '1.1': 'Alt plain',
      '1.2': '<div>Alt html</div>'
    },
    partMimes: {
      '1.1': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n',
      '1.2': 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
    }
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [nestedMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.text, 'Alt plain');
  assert.equal(content.html, '<div>Alt html</div>');
  assert.equal(content.attachments.length, 1);
  assert.equal(content.attachments[0].filename, 'doc.pdf');
  assert.equal(content.complete, true);
});

test('content reader bounds multiple unknown parts sequentially without requesting source', async () => {
  const multiUnknownMail = mail(34, {
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' }, // no declared size
        { part: '2', type: 'text/html' }   // no declared size
      ]
    },
    partBodies: {
      '1': 'Plain piece',
      '2': '<span>HTML piece</span>'
    },
    partMimes: {
      '1': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n',
      '2': 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
    }
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [multiUnknownMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  h.calls.length = 0;

  const content = await h.reader.content(h.accounts[0], entry.reference);
  assert.equal(content.text, 'Plain piece');
  assert.ok(content.html.includes('HTML piece'));
  assert.equal(content.complete, true);

  // Must not have requested source
  assert.equal(h.calls.some(c => c.query?.source !== undefined), false, 'Must not request message source for unknown body parts');
  // Multiple body fetches were made sequentially
  const bodyCalls = h.calls.filter(c => c.action === 'body');
  assert.equal(bodyCalls.length, 2, 'Must fetch unknown parts sequentially');
  // Each request's maxLength must be bounded by remaining budget + 1
  for (const c of bodyCalls) {
    for (const p of c.query.bodyParts) {
      if (p.key === '1' || p.key === '2') {
        assert.ok(p.maxLength <= 4 * 1024 * 1024 + 1);
      }
    }
  }
});

test('content reader rejects cumulative decoded size exceeding maxDecodedBytes', async () => {
  const expandingMail = mail(35, {
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 30 },
        { part: '2', type: 'text/plain', size: 30 }
      ]
    },
    partBodies: {
      '1': '123456789012345678901234567890',
      '2': 'abcdefghijklmnopqrstuvwxyz1234'
    },
    partMimes: {
      '1': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n',
      '2': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
    }
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [expandingMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];

  // Part 1 is 30 bytes, Part 2 is 30 bytes. If maxDecodedBytes is 50, cumulative decode must reject with content_too_large
  await assert.rejects(
    h.reader.content(h.accounts[0], entry.reference, { maxDecodedBytes: 50 }),
    { code: 'content_too_large' }
  );
});

test('content reader renders plain-only alternative in pre tag when sibling HTML exists', async () => {
  const plainAltMixedMail = mail(36, {
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1',
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', size: 10 }
          ]
        },
        {
          part: '2',
          type: 'text/html',
          size: 16
        }
      ]
    },
    partBodies: {
      '1.1': 'Plain note',
      '2': '<b>Bold HTML</b>'
    },
    partMimes: {
      '1.1': 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n',
      '2': 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n'
    }
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [plainAltMixedMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  const content = await h.reader.content(h.accounts[0], entry.reference);

  assert.equal(content.text, 'Plain note');
  assert.equal(content.html, '<pre style="white-space: pre-wrap; font-family: inherit;">Plain note</pre>\n<b>Bold HTML</b>');
  assert.equal(content.complete, true);
});

test('attachment validates maxBytes bounds before session and enforces metadata limit', async () => {
  const attachmentMail = mail(37, {
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        {
          part: '2',
          type: 'application/pdf',
          size: 3 * 1024 * 1024, // 3 MiB
          disposition: 'attachment',
          parameters: { filename: 'large.pdf' }
        }
      ]
    },
    partBodies: { '1': 'Hello' },
    partMimes: { '1': 'Content-Type: text/plain\r\n\r\n' }
  });

  const h = harness({ a: { folders: [{ path: 'INBOX', messages: [attachmentMail] }] } });
  const entry = (await h.reader.list(h.accounts)).messages[0];
  h.calls.length = 0;

  // Invalid maxBytes: must reject immediately without opening session or calling provider
  for (const bad of [0, -1, MAX_ATTACHMENT_BYTES + 1, 1.5, 'invalid', null]) {
    await assert.rejects(
      h.reader.attachment(h.accounts[0], entry.reference, '2', { maxBytes: bad }),
      { code: 'invalid_request' }
    );
  }
  assert.equal(h.calls.length, 0, 'Zero provider calls must occur for invalid maxBytes arguments');

  // Explicit maxBytes (2 MiB) smaller than declared metadata (3 MiB) fails with attachment_too_large
  await assert.rejects(
    h.reader.attachment(h.accounts[0], entry.reference, '2', { maxBytes: 2 * 1024 * 1024 }),
    { code: 'attachment_too_large' }
  );
});

test('live reader lists messages and folders across more than four configured accounts', async () => {
  const h = harness(Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(id => [id, {}])));
  const listed = await h.reader.list(h.accounts);
  assert.equal(listed.messages.length, 6);
  assert.deepEqual(listed.errors, []);
  const folders = await h.reader.folders(h.accounts);
  assert.equal(folders.folders.find(folder => folder.id === 'inbox').accountIds.length, 6);
});
