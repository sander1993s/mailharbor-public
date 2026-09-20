import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { createAccountStore } from '../server/account-store.mjs';
import { createMailTags, MAIL_TAGS } from '../server/mail-tags.mjs';
import { MailHarborError } from '../server/validation.mjs';
import { createMailIndex } from '../server/mail-index.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const accounts = [
  { id: 'first', email: 'first@example.test', label: 'First mailbox', revision: 'one', auth: { password: 'PRIVATE_PASSWORD' } },
  { id: 'second', email: 'second@example.test', label: 'Second mailbox', revision: 'two', auth: { refreshToken: 'PRIVATE_REFRESH' } }
];
const initial = () => ({ schema: 1, accounts: structuredClone(accounts), providers: { google: { clientSecret: 'PRIVATE_CLIENT_SECRET' } } });
const ref = (account = accounts[0], identity = 'logical-email', overrides = {}) => ({ accountId: account.id, path: 'INBOX', uid: 42, uidValidity: '123', fingerprint: hash(identity), ...overrides });
const mail = (account = accounts[0], reference = ref(account), overrides = {}) => ({
  id: 'transient-browser-reference', accountId: account.id, account: account.label, folderPath: reference.path,
  subject: 'PRIVATE_SUBJECT Interview coupon', author: 'PRIVATE_AUTHOR <sender@example.test>', to: 'PRIVATE_RECIPIENT <recipient@example.test>',
  date: '2026-09-13T12:00:00.000Z', unread: true, starred: false, reference,
  body: 'PRIVATE_BODY_MUST_NEVER_PERSIST', auth: { password: 'UNEXPECTED_MESSAGE_SECRET' }, ...overrides
});
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function memoryStore() {
  let data = initial(), pending = Promise.resolve(), commits = 0, active = false;
  return {
    read: () => structuredClone(data), commits: () => commits, active: () => active,
    update(change) {
      const next = pending.then(async () => {
        const copy = structuredClone(data); active = true;
        try { const result = await change(copy); data = copy; commits++; return result; }
        finally { active = false; }
      });
      pending = next.catch(() => {}); return next;
    }
  };
}
const set = (tags, tag, { account = accounts[0], reference = ref(account), message = mail(account, reference), enabled = true, ...extra } = {}) =>
  tags.set({ account, message, reference, tag, enabled, ...extra });

test('late observations cannot rewind a confirmed folder move, while fresh UIDs and unrelated mail still update', async t => {
  const store = memoryStore(), index = await createMailIndex(); t.after(() => index.close());
  let clock = 2000000;
  const tags = createMailTags({store,index,now:() => clock});
  const source = ref(), destination = {...source,path:'MailHarbor/Jobs',uid:80}, unrelated = ref(accounts[1],'other-mail');
  await set(tags,'jobs'); await set(tags,'jobs',{account:accounts[1],reference:unrelated});
  const held = gate(), entered = gate();
  const oldObservation = tags.observe(accounts,[mail()],{verify:async () => {entered.resolve();await held.promise;}});
  await entered.promise;
  const movedRow = index.list('tags').find(({value}) => value.accountId === accounts[0].id);
  index.transaction(() => {
    index.put('labelSync',movedRow.key,{retiredReferences:[{reference:source,retiredAt:clock}]});
    index.putTag(movedRow.key,{...movedRow.value,reference:destination,message:{...movedRow.value.message,folderPath:destination.path}});
  });
  const version = tags.version(); held.resolve();
  assert.deepEqual(await oldObservation,{changed:false,version});
  assert.deepEqual(tags.entries([accounts[0]],{tag:'jobs'})[0].reference,destination);
  assert.equal(tags.entries([accounts[0]],{tag:'jobs'})[0].message.folderPath,destination.path);
  const current = {...source,uid:99};
  const updated = await tags.observe(accounts,[mail(accounts[0],current,{subject:'Fresh UID'}),mail(accounts[1],unrelated,{unread:false})]);
  assert.equal(updated.changed,true);
  assert.deepEqual(tags.entries([accounts[0]],{tag:'jobs'})[0].reference,current);
  assert.equal(tags.entries([accounts[1]],{tag:'jobs'})[0].message.unread,false);
  clock += 15 * 60 * 1000 + 1;
  assert.equal((await tags.observe(accounts,[mail(accounts[0],source,{subject:'Expired protection'})])).changed,true);
  assert.deepEqual(tags.entries([accounts[0]],{tag:'jobs'})[0].reference,source);
});

test('tag choices through retired handles preserve the confirmed location and Gmail aliases remain observable', async t => {
  const store = memoryStore(), index = await createMailIndex(); t.after(() => index.close());
  const now = 2000000, tags = createMailTags({store,index,now:() => now});
  const source = ref(), destination = {...source,path:'MailHarbor/Jobs',uid:80};
  await set(tags,'jobs'); const row = index.list('tags')[0];
  index.put('labelSync',row.key,{retiredReferences:[{reference:source,retiredAt:now}]});
  index.putTag(row.key,{...row.value,reference:destination,message:{...row.value.message,folderPath:destination.path}});
  await set(tags,'coupons');
  await tags.automatic({account:accounts[0],message:mail(),reference:source,labels:['finance']});
  const entry = tags.entries([accounts[0]])[0];
  assert.deepEqual(entry.reference,destination); assert.equal(entry.message.folderPath,destination.path);
  assert.deepEqual(new Set(entry.message.tags),new Set(['jobs','coupons','finance']));
  const gmailAlias = {...source,path:'[Gmail]/All Mail',uid:123};
  assert.equal((await tags.observe(accounts,[mail(accounts[0],gmailAlias)])).changed,true);
  assert.deepEqual(tags.entries([accounts[0]])[0].reference,gmailAlias);
});

for (const durable of [false, true]) test(`custom labels create, rename, delete and never resurrect stale IDs (${durable ? 'SQLite' : 'legacy'})`, async t => {
  const store = memoryStore(), index = durable ? await createMailIndex() : undefined;
  t.after(() => index?.close());
  const tags = createMailTags({ store, index }), initialVersion = tags.version();
  const created = await tags.manage({ action: 'create', label: 'Project receipts' });
  assert.match(created.label.id, /^custom_[a-f0-9]{32}$/u); assert.ok(tags.version() > initialVersion);
  const id = created.label.id;
  await set(tags, id); await set(tags, 'jobs');
  assert.ok(tags.tagsFor(accounts[0], ref()).includes(id)); assert.equal(tags.entries(accounts, { tag: id }).length, 1);
  const beforeRename = tags.version();
  const renamed = await tags.manage({ action: 'rename', id, label: 'Tax receipts' });
  assert.equal(renamed.label.id, id); assert.ok(tags.version() > beforeRename);
  await assert.rejects(tags.manage({ action: 'rename', id, label: 'Jobs' }), { code: 'invalid_request' });
  await assert.rejects(tags.manage({ action: 'create', label: 'TAX RECEIPTS' }), { code: 'invalid_request' });
  await assert.rejects(tags.manage({ action: 'delete', id: 'jobs' }), { code: 'invalid_request' });
  const beforeDelete = tags.version(); await tags.manage({ action: 'delete', id });
  assert.ok(tags.version() > beforeDelete); assert.deepEqual(tags.tagsFor(accounts[0], ref()), ['jobs']);
  assert.deepEqual(tags.tagsForMany([accounts[0]], [mail()]), [['jobs']]);
  assert.equal(JSON.stringify(tags.entries(accounts)).includes(id), false);
  assert.equal(JSON.stringify(store.read().mailTags).includes(id), false);
  if (index) assert.equal(JSON.stringify(index.list('tags')).includes(id), false);
  const reopened = createMailTags({ store, index }); assert.deepEqual(reopened.tagsFor(accounts[0], ref()), ['jobs']);
  await assert.rejects(set(reopened, id), { code: 'invalid_request' });
});

test('a custom label deleted while a queued write verifies cannot be recreated by that stale write', async () => {
  const store = memoryStore(), tags = createMailTags({ store });
  const id = (await tags.manage({ action: 'create', label: 'Temporary' })).label.id;
  const hold = gate(), entered = gate();
  const first = set(tags, 'jobs', { verify: async () => { entered.resolve(); await hold.promise; } });
  await entered.promise;
  const deletion = tags.manage({ action: 'delete', id });
  const late = assert.rejects(set(tags, id), { code: 'invalid_request' });
  hold.resolve(); await Promise.all([first, deletion, late]);
  assert.deepEqual(tags.tagsFor(accounts[0], ref()), ['jobs']);
});

test('label snapshots retain bounded thread, recipient and attachment metadata without persisting content', async () => {
  const store = memoryStore(), tags = createMailTags({ store });
  const message = mail(accounts[0], ref(), { threadId: 't'.repeat(64), cc: 'copy@example.test', replyTo: 'reply@example.test',
    messageId: '<message@example.test>', inReplyTo: '<parent@example.test>', references: ['<root@example.test>'],
    size: 1000, hasAttachments: true, providerLabels: ['Receipts'], html: 'PRIVATE_HTML_MUST_NOT_PERSIST' });
  await set(tags, 'jobs', { message });
  const saved = tags.entries(accounts, { tag: 'jobs' })[0].message;
  assert.equal(saved.threadId, message.threadId); assert.equal(saved.cc, message.cc); assert.equal(saved.hasAttachments, true);
  assert.deepEqual(saved.references, message.references); assert.deepEqual(saved.providerLabels, ['Receipts']);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_BODY|PRIVATE_HTML/);
});

test('tagged headers persist through an encrypted store reopen; bodies and unexpected fields never persist', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-tags-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('mailharbor-tags-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createAccountStore(directory);
  await store.update(data => Object.assign(data, initial()));
  const tags = createMailTags({ store, now: () => 1000 });
  assert.deepEqual(MAIL_TAGS.map(tag => tag.id), ['coupons', 'development', 'social', 'jobs', 'security', 'travel', 'work', 'newsletters', 'finance', 'invoices', 'tenders', 'appointments', 'orders']);
  await set(tags, 'coupons'); await set(tags, 'jobs'); await set(tags, 'invoices');
  const state = store.read(), entry = Object.values(state.mailTags.entries)[0];
  assert.deepEqual(Object.keys(entry.message).sort(), ['accountId', 'account', 'folderPath', 'subject', 'author', 'to', 'date', 'unread', 'starred'].sort());
  assert.deepEqual(Object.keys(entry.reference).sort(), ['accountId', 'path', 'uid', 'uidValidity', 'fingerprint'].sort());
  assert.equal(entry.updatedAt, 1000);
  assert.equal(JSON.stringify(state.mailTags).includes('PRIVATE_BODY'), false);
  assert.equal(JSON.stringify(state.mailTags).includes('UNEXPECTED_MESSAGE_SECRET'), false);
  assert.equal(JSON.stringify(state.mailTags).includes('transient-browser-reference'), false);
  assert.deepEqual(state.accounts, initial().accounts); assert.deepEqual(state.providers, initial().providers);
  const ciphertext = await readFile(path.join(directory, 'accounts.enc'), 'utf8');
  for (const secret of ['PRIVATE_SUBJECT', 'PRIVATE_AUTHOR', 'PRIVATE_RECIPIENT', 'PRIVATE_BODY', 'PRIVATE_PASSWORD', ref().fingerprint]) assert.equal(ciphertext.includes(secret), false);
  const reopened = createMailTags({ store: await createAccountStore(directory) });
  assert.equal(reopened.version(), tags.version());
  assert.deepEqual(reopened.tagsFor(accounts[0], ref()), ['coupons', 'jobs', 'invoices']);
  assert.deepEqual(reopened.entries(accounts, { tag: 'coupons' }), tags.entries(accounts, { tag: 'coupons' }));
  assert.deepEqual(reopened.entries(accounts, { tag: 'invoices' }), tags.entries(accounts, { tag: 'invoices' }));
  await set(reopened, 'invoices', { enabled: false });
  const afterRemoval = createMailTags({ store: await createAccountStore(directory) });
  assert.equal(afterRemoval.entries(accounts, { tag: 'invoices' }).length, 0);
  assert.deepEqual(afterRemoval.tagsFor(accounts[0], ref()), ['coupons', 'jobs']);
});

test('labels span accounts, support both labels and removal, and isolate reused account identities', async () => {
  const store = memoryStore(), tags = createMailTags({ store });
  await set(tags, 'coupons'); await set(tags, 'jobs');
  await set(tags, 'jobs', { account: accounts[1] });
  assert.equal(tags.entries(accounts, { tag: 'jobs' }).length, 2);
  assert.equal(tags.entries(accounts, { tag: 'coupons' }).length, 1);
  assert.deepEqual(tags.tagsFor(accounts[1], ref(accounts[1])), ['jobs']);
  assert.equal(tags.entries(accounts, { tag: 'jobs', query: 'SENDER@example.test' }).length, 2);
  assert.equal(tags.entries(accounts, { tag: 'jobs', query: 'recipient@example.test' }).length, 2);
  assert.equal(tags.entries(accounts, { tag: 'jobs', query: 'unknown query' }).length, 0);
  const firstId = tags.entries([accounts[0]], { tag: 'jobs' })[0].message.id;
  await store.update(data => { data.accounts[0].revision = 'reconnected'; data.accounts[0].email = ' FIRST@EXAMPLE.TEST '; });
  const reconnected = { ...accounts[0], email: ' FIRST@EXAMPLE.TEST ', revision: 'reconnected' };
  assert.deepEqual(tags.tagsFor(reconnected, ref(reconnected, 'logical-email', { uid: 100, uidValidity: '456', path: 'Archive' })), ['coupons', 'jobs']);
  assert.equal(tags.entries([reconnected], { tag: 'jobs' })[0].message.id, firstId);
  await set(tags, 'coupons', { account: reconnected, enabled: false });
  assert.deepEqual(tags.tagsFor(reconnected, ref(reconnected)), ['jobs']);

  const replacement = { ...accounts[0], email: 'different@example.test' };
  await store.update(data => { data.accounts[0] = replacement; });
  assert.deepEqual(tags.tagsFor(accounts[0], ref()), []);
  assert.deepEqual(tags.tagsFor(replacement, ref(replacement)), []);
  assert.equal(tags.entries([accounts[0]], { tag: 'jobs' }).length, 0);
  assert.equal(tags.entries([replacement], { tag: 'jobs' }).length, 0);
  await set(tags, 'coupons', { account: replacement });
  assert.deepEqual(tags.tagsFor(replacement, ref(replacement)), ['coupons']);
  assert.notEqual(tags.entries([replacement], { tag: 'coupons' })[0].message.id, firstId);
  await store.update(data => { data.accounts[0] = structuredClone(accounts[0]); });
  assert.deepEqual(tags.tagsFor(accounts[0], ref()), ['jobs']);
  await set(tags, 'jobs', { enabled: false });
  assert.deepEqual(tags.tagsFor(accounts[0], ref()), []);
  assert.equal(tags.entries(accounts, { tag: 'jobs' }).length, 1);
});

test('observations update tagged moves and label copies, deduplicate logical messages, and skip unchanged writes', async () => {
  const store = memoryStore(), tags = createMailTags({ store, now: () => 2000 });
  await tags.observe(accounts, [mail()]);
  assert.equal(store.commits(), 0); assert.equal(tags.version(), 0);
  await set(tags, 'coupons');
  const before = tags.version(), commits = store.commits();
  await tags.observe(accounts, [mail(accounts[0], ref(), { id: 'different-transient-id', body: 'DIFFERENT_BODY' })]);
  assert.equal(tags.version(), before); assert.equal(store.commits(), commits);
  const moved = ref(accounts[0], 'logical-email', { path: 'Archive', uid: 77, uidValidity: '456' });
  const labelCopy = ref(accounts[0], 'logical-email', { path: '[Gmail]/All Mail', uid: 80, uidValidity: '789' });
  const observed = await tags.observe(accounts, [mail(accounts[0], moved), mail(accounts[0], labelCopy, { folderPath: 'wrong stale path', unread: false, starred: true }), mail(accounts[1], ref(accounts[1], 'untagged-other'))]);
  assert.equal(observed.changed, true); assert.equal(observed.version, before + 1);
  const entries = tags.entries(accounts, { tag: 'coupons' });
  assert.equal(entries.length, 1); assert.deepEqual(entries[0].reference, labelCopy);
  assert.equal(entries[0].message.folderPath, labelCopy.path);
  assert.equal(entries[0].message.unread, false); assert.equal(entries[0].message.starred, true);
  assert.deepEqual(tags.tagsFor(accounts[0], moved), ['coupons']);
  const result = await set(tags, 'coupons', { reference: labelCopy, message: mail(accounts[0], labelCopy, { unread: false, starred: true }) });
  assert.equal(result.version, observed.version);
  entries[0].message.subject = 'mutation outside store'; entries[0].reference.path = 'mutated';
  assert.equal(tags.entries(accounts, { tag: 'coupons' })[0].reference.path, labelCopy.path);
});

test('concurrent labels, observations, and unrelated account writes preserve all state; verify runs inside serialization', async () => {
  const store = memoryStore(), tags = createMailTags({ store }), blocked = gate();
  let verified = false;
  const first = set(tags, 'coupons', { verify: async data => {
    assert.equal(store.active(), true); assert.equal(data.accounts[0].id, accounts[0].id); verified = true; await blocked.promise;
  } });
  await nextTurn(); assert.equal(verified, true);
  const second = set(tags, 'jobs');
  const moved = ref(accounts[0], 'logical-email', { path: 'Archive', uid: 90 });
  const observation = tags.observe(accounts, [mail(accounts[0], moved)], { verify: () => assert.equal(store.active(), true) });
  const accountWrite = store.update(data => { data.providers.google.clientSecret = 'NEW_PROVIDER_SECRET'; data.accounts[1].auth.refreshToken = 'NEW_REFRESH'; });
  blocked.resolve(); await Promise.all([first, second, observation, accountWrite]);
  assert.deepEqual(tags.tagsFor(accounts[0], moved), ['coupons', 'jobs']);
  assert.deepEqual(tags.entries(accounts, { tag: 'jobs' })[0].reference, moved);
  assert.equal(store.read().providers.google.clientSecret, 'NEW_PROVIDER_SECRET');
  assert.equal(store.read().accounts[1].auth.refreshToken, 'NEW_REFRESH');
  assert.equal(tags.version(), 3);
});

test('failed verification rolls back labels and observation metadata without losing subsequent operations', async () => {
  const store = memoryStore(), tags = createMailTags({ store });
  await assert.rejects(set(tags, 'coupons', { verify: () => { throw new MailHarborError('stale_message'); } }), error => error.code === 'stale_message');
  assert.equal(tags.version(), 0); assert.equal(store.commits(), 0);
  await set(tags, 'coupons');
  const before = store.read(), moved = ref(accounts[0], 'logical-email', { path: 'Archive', uid: 91 });
  await assert.rejects(tags.observe(accounts, [mail(accounts[0], moved)], { verify: () => { throw new MailHarborError('cancelled'); } }), error => error.code === 'cancelled');
  assert.deepEqual(store.read(), before);
  await set(tags, 'jobs'); assert.deepEqual(tags.tagsFor(accounts[0], ref()), ['coupons', 'jobs']);
  await store.update(data => { data.accounts = data.accounts.filter(account => account.id !== accounts[0].id); });
  await assert.rejects(set(tags, 'jobs'), error => error.code === 'stale_message');
  assert.equal(tags.entries(accounts, { tag: 'coupons' }).length, 0);
  const commits = store.commits();
  await tags.observe(accounts, [mail(accounts[0], moved)]);
  assert.equal(store.commits(), commits, 'A late observation cannot update disconnected account metadata.');
});

test('capacity rejects an extra logical message, retains existing entries, and permits removal to free space', async () => {
  const store = memoryStore(), tags = createMailTags({ store });
  await set(tags, 'coupons');
  await store.update(data => {
    const sample = Object.values(data.mailTags.entries)[0];
    for (let number = 1; number < 10000; number++) {
      const fingerprint = hash(`capacity-${number}`);
      const key = hash(JSON.stringify([sample.accountId, sample.email, fingerprint]));
      data.mailTags.entries[key] = { ...structuredClone(sample), reference: { ...sample.reference, fingerprint } };
    }
  });
  const newReference = ref(accounts[0], 'one-too-many');
  await assert.rejects(set(tags, 'jobs', { reference: newReference }), error => error.code === 'tag_limit');
  assert.equal(Object.keys(store.read().mailTags.entries).length, 10000);
  assert.deepEqual(tags.tagsFor(accounts[0], ref()), ['coupons']);
  await set(tags, 'coupons', { enabled: false });
  assert.equal(Object.keys(store.read().mailTags.entries).length, 9999);
  await set(tags, 'jobs', { reference: newReference });
  assert.equal(Object.keys(store.read().mailTags.entries).length, 10000);
  assert.deepEqual(tags.tagsFor(accounts[0], newReference), ['jobs']);
});

test('stored headers are bounded and tag, account, and reference inputs are validated', async () => {
  const store = memoryStore(), tags = createMailTags({ store });
  const message = mail(accounts[0], ref(), { subject: `\u0000${'s'.repeat(900)}`, author: 'a'.repeat(900), to: 't'.repeat(900), date: 'd'.repeat(900) });
  await set(tags, 'coupons', { message });
  const result = tags.entries(accounts, { tag: 'coupons' })[0].message;
  assert.equal(result.subject.length, 500); assert.equal(result.subject.includes('\u0000'), false);
  assert.equal(result.author.length, 500); assert.equal(result.to.length, 500); assert.equal(result.date.length, 80);
  await assert.rejects(set(tags, 'unknown'), error => error.code === 'invalid_request');
  await assert.rejects(set(tags, 'jobs', { enabled: 'true' }), error => error.code === 'invalid_request');
  await assert.rejects(set(tags, 'jobs', { reference: { ...ref(), accountId: accounts[1].id } }), error => error.code === 'invalid_request');
  await assert.rejects(set(tags, 'jobs', { reference: { ...ref(), uid: 0 } }), error => error.code === 'invalid_request');
  await assert.rejects(set(tags, 'jobs', { reference: { ...ref(), path: 'INBOX\r\nInjected' } }), error => error.code === 'invalid_request');
  assert.throws(() => tags.entries(accounts, { query: 'a'.repeat(201) }), error => error.code === 'invalid_request');
  assert.throws(() => tags.entries(accounts, { tag: 'unknown' }), error => error.code === 'invalid_request');
});

test('batch tag lookup uses one store snapshot and returned label arrays cannot mutate persisted state', async () => {
  const store = memoryStore();
  let reads = 0;
  const tags = createMailTags({ store: { ...store, read() { reads++; return store.read(); } } });
  const added = await set(tags, 'coupons');
  await set(tags, 'jobs', { account: accounts[1] });
  added.tags.push('jobs');
  assert.deepEqual(tags.tagsFor(accounts[0], ref()), ['coupons']);
  const messages = [mail(accounts[1]), mail(), mail(accounts[0], ref(accounts[0], 'untagged'))];
  const before = reads;
  const result = tags.tagsForMany(accounts, messages);
  assert.equal(reads, before + 1);
  assert.deepEqual(result, [['jobs'], ['coupons'], []]);
  result[0].push('coupons');
  assert.deepEqual(tags.tagsFor(accounts[1], ref(accounts[1])), ['jobs']);
  await store.update(data => { data.accounts[1].email = 'replacement@example.test'; });
  assert.deepEqual(tags.tagsForMany(accounts, messages), [[], ['coupons'], []]);
});

test('forget removes every label for a moved message, persists deletion and preserves other accounts and fingerprints', async () => {
  const store = memoryStore(), tags = createMailTags({ store });
  await set(tags, 'jobs'); await set(tags, 'coupons');
  await set(tags, 'jobs', { account: accounts[1] });
  const unrelated = ref(accounts[0], 'unrelated-message', { uid: 99 });
  await set(tags, 'jobs', { reference: unrelated });
  const alias = ref(accounts[0], 'logical-email', { path: '[Gmail]/All Mail', uid: 77, uidValidity: '456' });
  await tags.observe(accounts, [mail(accounts[0], alias)]);
  const version = tags.version();
  await tags.forget(accounts[0], ref());
  assert.equal(tags.version(), version + 1);
  assert.deepEqual(tags.tagsFor(accounts[0], ref()), []);
  assert.deepEqual(tags.tagsFor(accounts[0], alias), []);
  assert.deepEqual(tags.tagsFor(accounts[0], unrelated), ['jobs']);
  assert.deepEqual(tags.tagsFor(accounts[1], ref(accounts[1])), ['jobs']);
  assert.equal(tags.entries(accounts, { tag: 'coupons' }).length, 0);
  assert.equal(tags.entries(accounts, { tag: 'jobs' }).length, 2);
  const reopened = createMailTags({ store });
  assert.deepEqual(reopened.tagsFor(accounts[0], alias), []);
  await reopened.forget(accounts[0], ref());
  assert.equal(reopened.version(), version + 1, 'Repeated deletion is a no-op.');
});

test('forget cannot delete labels belonging to a replacement identity or disconnected account', async () => {
  const store = memoryStore(), tags = createMailTags({ store });
  await set(tags, 'jobs');
  const replacement = { ...accounts[0], email: 'replacement@example.test', revision: 'new' };
  await store.update(data => { data.accounts[0] = replacement; });
  await set(tags, 'coupons', { account: replacement });
  const version = tags.version();
  await tags.forget(accounts[0], ref());
  assert.equal(tags.version(), version);
  assert.deepEqual(tags.tagsFor(replacement, ref(replacement)), ['coupons']);
  await tags.forget(replacement, ref(replacement));
  assert.equal(tags.version(), version + 1);
  await store.update(data => { data.accounts[0] = structuredClone(accounts[0]); });
  assert.deepEqual(tags.tagsFor(accounts[0], ref()), ['jobs']);
  await assert.rejects(tags.forget(accounts[0], ref(accounts[1])), { code: 'invalid_request' });
  await store.update(data => { data.accounts = data.accounts.filter(account => account.id !== accounts[0].id); });
  await tags.forget(accounts[0], ref());
  assert.equal(tags.version(), version + 1);
});
