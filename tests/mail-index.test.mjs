import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAccountStore } from '../server/account-store.mjs';
import { createMailIndex } from '../server/mail-index.mjs';
import { createMailTags } from '../server/mail-tags.mjs';

test('encrypted index persists atomically, never exposes headers, and isolates records by AAD', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mailharbor-index-'));
  let index; t.after(async () => { index?.close(); await rm(dir, { recursive: true, force: true }); });
  await createAccountStore(dir);
  index = await createMailIndex(dir);
  index.put('messages', 'a', { subject: 'PRIVATE_INDEX_SUBJECT', reference: 'PRIVATE_REFERENCE' }, { state: 'ready', due: 100 });
  assert.throws(() => index.transaction(() => { index.put('messages', 'b', { subject: 'rollback' }); throw new Error('rollback'); }));
  assert.equal(index.get('messages', 'b'), null);
  index.close();
  const bytes = await readFile(path.join(dir, 'mail-index.sqlite'));
  assert.equal(bytes.includes(Buffer.from('PRIVATE_INDEX_SUBJECT')), false);
  assert.equal(bytes.includes(Buffer.from('PRIVATE_REFERENCE')), false);
  index = await createMailIndex(dir);
  assert.equal(index.list('messages', { state: 'ready', before: 99 }).length, 0);
  assert.equal(index.list('messages', { state: 'ready', before: 100 })[0].value.subject, 'PRIVATE_INDEX_SUBJECT');
  const detached = index.get('messages', 'a'); detached.subject = 'changed';
  assert.equal(index.get('messages', 'a').subject, 'PRIVATE_INDEX_SUBJECT');
});

test('durable labels migrate old labels, preserve manual overrides, and exceed the old ten-thousand cap', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mailharbor-index-'));
  let index; t.after(async () => { index?.close(); await rm(dir, { recursive: true, force: true }); });
  const store = await createAccountStore(dir), account = { id: 'private', email: 'owner@example.test', label: 'Private', revision: '1' };
  await store.update(data => { data.accounts = [account]; });
  const reference = { accountId: account.id, path: 'INBOX', uid: 1, uidValidity: '1', fingerprint: 'a'.repeat(64) };
  const message = { accountId: account.id, subject: 'PRIVATE_SUBJECT', author: 'Sender <sender@example.test>', to: 'owner@example.test', date: '2026-01-01T10:00:00Z', unread: true, body: 'NEVER_STORE_BODY' };
  const legacy = createMailTags({ store }); await legacy.set({ account, message, reference, tag: 'jobs', enabled: true });
  index = await createMailIndex(dir);
  const tags = createMailTags({ store, index });
  assert.deepEqual(tags.tagsFor(account, reference), ['jobs']);
  await tags.automatic({ account, message, reference, labels: ['jobs', 'newsletters'] });
  await tags.set({ account, message, reference, tag: 'newsletters', enabled: false });
  await tags.automatic({ account, message, reference, labels: ['newsletters', 'finance'] });
  assert.deepEqual(tags.tagsFor(account, reference), ['jobs', 'finance']);
  const version = tags.version();
  await tags.automatic({ account, message, reference, labels: ['newsletters', 'finance'] });
  assert.equal(tags.version(), version);
  assert.equal(JSON.stringify(index.tagEntries([`${account.id}:${account.email}`])).includes('NEVER_STORE_BODY'), false);
  index.transaction(() => {
    for (let n = 2; n <= 10002; n++) {
      const key = createHash('sha256').update(String(n)).digest('hex');
      index.putTag(key, { accountId: account.id, email: account.email, tags: ['jobs'], message: { ...message, body: undefined }, reference: { ...reference, uid: n } });
    }
  });
  assert.equal(tags.count([account], { tag: 'jobs' }), 10002);
  assert.equal(tags.count([{ ...account, email: 'replacement@example.test' }], { tag: 'jobs' }), 0);
});

test('durable forget hides deleted labels, isolates identities, and blocks background resurrection until explicit retagging', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mailharbor-index-'));
  let index; t.after(async () => { index?.close(); await rm(dir, { recursive: true, force: true }); });
  const store = await createAccountStore(dir), account = { id: 'first', email: 'first@example.test', revision: '1' },
    other = { id: 'second', email: 'second@example.test', revision: '1' };
  await store.update(data => { data.accounts = [account, other]; });
  const reference = { accountId: account.id, path: 'INBOX', uid: 1, uidValidity: '1', fingerprint: 'a'.repeat(64) };
  const message = { accountId: account.id, subject: 'Fixture', author: 'Sender', to: account.email, date: '2026-09-13T12:00:00Z' };
  const legacy = createMailTags({ store });
  await legacy.set({ account, message, reference, tag: 'jobs', enabled: true });
  index = await createMailIndex(dir);
  let tags = createMailTags({ store, index });
  const otherReference = { ...reference, accountId: other.id }, otherMessage = { ...message, accountId: other.id, to: other.email };
  await tags.set({ account: other, message: otherMessage, reference: otherReference, tag: 'jobs', enabled: true });
  await tags.automatic({ account, message, reference, labels: ['finance'] });
  const alias = { ...reference, path: '[Gmail]/All Mail', uid: 88, uidValidity: '99' };
  await tags.observe([account], [{ ...message, reference: alias }]);
  const replacement = { ...account, email: 'replacement@example.test', revision: '2' };
  await store.update(data => { data.accounts[0] = replacement; });
  await tags.set({ account: replacement, message, reference, tag: 'coupons', enabled: true });
  const beforeStale = tags.version();
  await tags.forget(account, reference);
  assert.equal(tags.version(), beforeStale);
  assert.deepEqual(tags.tagsFor(replacement, reference), ['coupons']);
  await store.update(data => { data.accounts[0] = account; });
  assert.deepEqual(tags.tagsFor(account, reference), ['jobs', 'finance']);
  const version = tags.version();
  await tags.forget(account, reference);
  assert.equal(tags.version(), version + 1);
  assert.deepEqual(tags.tagsFor(account, alias), []);
  assert.deepEqual(tags.manualFor(account, reference), []);
  assert.equal(tags.count([account], { tag: 'jobs' }), 0);
  assert.equal(tags.count([account], { tag: 'finance' }), 0);
  assert.equal(tags.count([other], { tag: 'jobs' }), 1);
  assert.equal(tags.entries([account], { tag: 'jobs' }).length, 0);
  await Promise.all([tags.forget(account, alias),
    tags.automatic({ account, message, reference, labels: ['jobs', 'finance'] })]);
  assert.equal(tags.version(), version + 1);
  assert.deepEqual(tags.tagsFor(account, reference), [], 'A late automatic classification cannot recreate deleted labels.');
  await assert.rejects(tags.forget(account, otherReference), { code: 'invalid_request' });
  index.close(); index = await createMailIndex(dir);
  tags = createMailTags({ store, index });
  assert.equal(tags.version(), version + 1);
  assert.deepEqual(tags.tagsFor(account, reference), [], 'Legacy migration must not restore deleted labels on reopen.');
  await tags.automatic({ account, message, reference: alias, labels: ['jobs', 'finance'] });
  assert.equal(tags.version(), version + 1, 'A rescheduled organizer action after restart must respect deletion.');
  assert.equal(tags.entries([account]).length, 0);
  assert.deepEqual(tags.tagsFor(other, otherReference), ['jobs']);
  await store.update(data => { data.accounts[0] = replacement; });
  assert.deepEqual(tags.tagsFor(replacement, reference), ['coupons']);
  await store.update(data => { data.accounts[0] = account; });
  await tags.set({ account, message, reference: alias, tag: 'jobs', enabled: true });
  assert.deepEqual(tags.tagsFor(account, reference), ['jobs'], 'Explicit retagging allows the user to reuse the message.');
  await tags.automatic({ account, message, reference: alias, labels: ['finance'] });
  assert.deepEqual(tags.tagsFor(account, reference), ['jobs', 'finance']);
});

test('deleting an untagged message blocks its first in-flight automatic classification', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mailharbor-index-'));
  let index; t.after(async () => { index?.close(); await rm(dir, { recursive: true, force: true }); });
  const store = await createAccountStore(dir), account = { id: 'first', email: 'first@example.test', revision: '1' };
  await store.update(data => { data.accounts = [account]; });
  index = await createMailIndex(dir);
  const tags = createMailTags({ store, index });
  const reference = { accountId: account.id, path: 'INBOX', uid: 1, uidValidity: '1', fingerprint: 'a'.repeat(64) };
  const message = { accountId: account.id, subject: 'Late classification', author: 'Sender', to: account.email, date: '2026-09-13T12:00:00Z' };
  await Promise.all([tags.forget(account, reference), tags.automatic({ account, message, reference, labels: ['jobs'] })]);
  assert.deepEqual(tags.tagsFor(account, reference), []);
  assert.equal(tags.count([account], { tag: 'jobs' }), 0);
  assert.equal(tags.entries([account]).length, 0);
  await tags.observe([account], [{ ...message, reference: { ...reference, path: 'Trash', uid: 77 } }]);
  await tags.automatic({ account, message, reference, labels: ['jobs'] });
  assert.deepEqual(tags.tagsFor(account, reference), [], 'Observing the moved message must preserve its deletion marker.');
});

test('durable deletion markers roll back records, label counts and versions when their transaction fails', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mailharbor-index-'));
  let index; t.after(async () => { index?.close(); await rm(dir, { recursive: true, force: true }); });
  await createAccountStore(dir); index = await createMailIndex(dir);
  const entry = { accountId: 'first', email: 'first@example.test', tags: ['jobs', 'coupons'], message: { date: '2026-09-13T12:00:00Z' } };
  index.putTag('fixture-message', entry);
  const deleted = { ...entry, tags: [], manual: [], automatic: [], excluded: [], deleted: true };
  const version = index.get('meta', 'tagVersion').value;
  assert.throws(() => index.transaction(() => { index.putTag('fixture-message', deleted); throw new Error('rollback deletion'); }), /rollback deletion/);
  assert.deepEqual(index.get('tags', 'fixture-message'), entry);
  assert.equal(index.tagCount(['first:first@example.test'], 'jobs'), 1);
  assert.equal(index.tagCount(['first:first@example.test'], 'coupons'), 1);
  assert.equal(index.get('meta', 'tagVersion').value, version);
  index.putTag('fixture-message', deleted);
  assert.deepEqual(index.get('tags', 'fixture-message'), deleted);
  assert.equal(index.tagCount(['first:first@example.test'], 'jobs'), 0);
  assert.equal(index.get('meta', 'tagVersion').value, version + 1);
});
