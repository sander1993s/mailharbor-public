import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { createNotificationStore } from '../server/notification-store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mailharbor-notifications-'));
  const master = randomBytes(32), stores = [];
  await writeFile(path.join(directory, 'accounts.key'), master, { mode: 0o600 });
  t.after(async () => {
    for (const store of stores) store.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, master, filename: path.join(directory, 'notification-state.sqlite'),
    async open(options) { const store = await createNotificationStore(directory, options); stores.push(store); return store; } };
}

test('encrypted notification records persist without plaintext in database or sidecars', async t => {
  const data = await fixture(t), store = await data.open();
  const entry = { body: 'PRIVATE_BODY_EXCERPT_notification_937', summary: 'PRIVATE_SUMMARY_notification_281', email: 'PRIVATE_EMAIL@example.test' };
  const id = store.token('message:PRIVATE_MESSAGE_ID'), owner = store.token('account:PRIVATE_ACCOUNT');
  store.transaction(() => {
    store.put('cursors', owner, { uid: 42, account: 'PRIVATE_ACCOUNT' });
    store.put('candidates', id, entry, { state: 'ready', due: 100, owner });
  });
  assert.deepEqual(store.get('candidates', id), entry);
  const detached = store.get('candidates', id); detached.body = 'changed';
  assert.equal(store.get('candidates', id).body, entry.body);
  for (const name of (await readdir(data.directory)).filter(name => name.startsWith('notification-state.sqlite'))) {
    const bytes = await readFile(path.join(data.directory, name));
    for (const value of [...Object.values(entry), 'PRIVATE_ACCOUNT', 'PRIVATE_MESSAGE_ID']) assert.equal(bytes.includes(Buffer.from(value)), false, `${name} contains plaintext`);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(data.directory, name))).mode & 0o777, 0o600);
  }
  store.close();
  const reopened = await data.open();
  assert.equal(reopened.token('message:PRIVATE_MESSAGE_ID'), id);
  assert.deepEqual(reopened.get('candidates', id), entry);
  assert.deepEqual(reopened.get('cursors', owner), { uid: 42, account: 'PRIVATE_ACCOUNT' });
  assert.equal(reopened.get('candidates', 'missing'), null);
});

test('cursor and candidate transaction rolls back every write and preserves subsequent progress', async t => {
  const store = await createNotificationStore(null); t.after(() => store.close());
  store.put('cursors', 'account', { uid: 1 });
  assert.throws(() => store.transaction(() => {
    store.put('candidates', 'first', { uid: 2 });
    store.put('candidates', 'second', { uid: 3 });
    store.put('cursors', 'account', { uid: 3 });
    throw new Error('simulated failure');
  }), /simulated failure/);
  assert.deepEqual(store.get('cursors', 'account'), { uid: 1 });
  assert.equal(store.count('candidates'), 0);
  assert.equal(store.healthy(), true);
  assert.equal(store.transaction(() => {
    store.put('candidates', 'first', { uid: 2 });
    store.put('cursors', 'account', { uid: 2 });
    return 'committed';
  }), 'committed');
  assert.equal(store.count('candidates'), 1);
  assert.deepEqual(store.get('cursors', 'account'), { uid: 2 });
});

test('nested transaction failure rolls back its own records even if the caller handles it', async t => {
  const store = await createNotificationStore(null); t.after(() => store.close());
  store.transaction(() => {
    store.put('cursors', 'account', { uid: 1 });
    assert.throws(() => store.transaction(() => {
      store.put('candidates', 'first', { uid: 2 });
      store.put('cursors', 'account', { uid: 2 });
      throw new Error('nested failure');
    }), /nested failure/);
    store.put('candidates', 'other', { uid: 3 });
  });
  assert.deepEqual(store.get('cursors', 'account'), { uid: 1 });
  assert.deepEqual(store.list('candidates'), [{ key: 'other', value: { uid: 3 } }]);
});

test('transactions reject async callbacks and roll back callbacks that return a promise', async t => {
  const data = await fixture(t), store = await data.open();
  let called = false;
  assert.throws(() => store.transaction(async () => { called = true; store.put('candidates', 'async', {}); }), /synchronous/);
  assert.equal(called, false);
  assert.equal(store.healthy(), true);
  assert.throws(() => store.transaction(() => {
    store.put('candidates', 'promise', {});
    return Promise.resolve().then(() => store.put('candidates', 'late', {}));
  }), /synchronous/);
  assert.equal(store.healthy(), false, 'a returned promise must not continue mutating after rollback');
  await new Promise(resolve => setImmediate(resolve));
  store.close();
  const reopened = await data.open();
  assert.equal(reopened.count('candidates'), 0);
});

test('leases contend across connections, renew only for the holder and expire durably', async t => {
  const data = await fixture(t), first = await data.open({ now: () => 1000 }), second = await data.open();
  assert.equal(first.claimLease('worker', 'first', undefined, 100), true);
  assert.equal(second.claimLease('worker', 'second', 1050, 100), false);
  assert.equal(first.claimLease('worker', 'first', 1050, 100), true);
  second.releaseLease('worker', 'second');
  assert.equal(second.claimLease('worker', 'second', 1149, 100), false);
  assert.equal(second.claimLease('worker', 'second', 1150, 100), true);
  first.releaseLease('worker', 'first');
  assert.equal(first.claimLease('worker', 'first', 1151, 100), false);
  second.releaseLease('worker', 'second');
  assert.equal(first.claimLease('worker', 'first', 1151, 100), true);
  first.close(); second.close();
  const reopened = await data.open();
  assert.equal(reopened.claimLease('worker', 'third', 1200, 100), false);
  assert.equal(reopened.claimLease('worker', 'third', 1251, 100), true);
});

test('list filters pending work with bounded stable pagination', async t => {
  const store = await createNotificationStore(null); t.after(() => store.close());
  store.put('candidates', 'a', { id: 'a' }, { state: 'ready', due: 99, owner: 'first' });
  store.put('candidates', 'b', { id: 'b' }, { state: 'ready', due: 100, owner: 'first' });
  store.put('candidates', 'c', { id: 'c' }, { state: 'ready', due: 101, owner: 'other' });
  store.put('candidates', 'd', { id: 'd' }, { state: 'held', due: null, owner: 'first' });
  assert.deepEqual(store.list('candidates', { state: 'ready', before: 100, owner: 'first', limit: 1 }), [{ key: 'a', value: { id: 'a' } }]);
  assert.deepEqual(store.list('candidates', { state: 'ready', before: 100, owner: 'first', after: 'a' }), [{ key: 'b', value: { id: 'b' } }]);
  assert.equal(store.count('candidates', 'held'), 1);
  assert.equal(store.count('candidates'), 4);
  store.remove('candidates', 'a');
  assert.equal(store.count('candidates', 'ready'), 2);
  for (const limit of [0, -1, 1001, Infinity, 1.2]) assert.throws(() => store.list('candidates', { limit }), /limit/);
  assert.throws(() => store.put('candidates', 'big', { body: 'x'.repeat(256 * 1024) }), /record size/);
  assert.throws(() => store.put('candidates', 'bad', {}, { due: NaN }), /due date/);
  assert.throws(() => store.claimLease('worker', 'first', 100, 0), /lease duration/);
  assert.equal(store.healthy(), true);
});

test('tampered encrypted data fails closed across every operation without replacing records', async t => {
  const data = await fixture(t), store = await data.open();
  store.put('candidates', 'first', { body: 'original body' });
  const raw = new DatabaseSync(data.filename);
  const original = raw.prepare("SELECT data FROM documents WHERE kind='candidates' AND key='first'").get().data;
  const corrupted = Buffer.from(original); corrupted[corrupted.length - 1] ^= 1;
  raw.prepare("UPDATE documents SET data=? WHERE kind='candidates' AND key='first'").run(corrupted);
  raw.close();
  assert.throws(() => store.get('candidates', 'first'), /requires recovery/);
  assert.equal(store.healthy(), false);
  for (const operation of [() => store.get('candidates', 'missing'), () => store.put('candidates', 'replacement', {}),
    () => store.remove('candidates', 'first'), () => store.list('candidates'), () => store.count('candidates'),
    () => store.claimLease('worker', 'first', 100), () => store.releaseLease('worker', 'first'),
    () => store.transaction(() => {}), () => store.token('test')]) assert.throws(operation, /requires recovery/);
  store.close();
  const reopened = await data.open();
  assert.throws(() => reopened.list('candidates'), /requires recovery/);
});

test('AAD prevents ciphertext substitution between record keys and kinds', async t => {
  for (const [kind, id] of [['cursors', 'first'], ['candidates', 'second']]) {
    const data = await fixture(t), store = await data.open();
    store.put('candidates', 'first', { body: 'original body' });
    store.put(kind, id, { uid: 10 });
    const raw = new DatabaseSync(data.filename);
    raw.prepare("UPDATE documents SET data=(SELECT data FROM documents WHERE kind='candidates' AND key='first') WHERE kind=? AND key=?").run(kind, id);
    raw.close();
    assert.throws(() => store.get(kind, id), /requires recovery/);
  }
});

test('key domains are separate and a replaced key, missing key or corrupt database is never initialized away', async t => {
  const data = await fixture(t), store = await data.open();
  const input = 'account:business';
  const indexKey = createHmac('sha256', data.master).update('MailHarbor index v1').digest();
  const indexToken = createHmac('sha256', indexKey).update(input).digest('hex');
  assert.notEqual(store.token(input), indexToken);
  store.put('cursors', 'business', { uid: 123 }); store.close();
  const before = await readFile(data.filename);
  await writeFile(path.join(data.directory, 'accounts.key'), randomBytes(32));
  await assert.rejects(data.open(), /requires recovery/);
  assert.deepEqual(await readFile(data.filename), before);
  await writeFile(path.join(data.directory, 'accounts.key'), data.master);
  const reopened = await data.open();
  assert.deepEqual(reopened.get('cursors', 'business'), { uid: 123 }); reopened.close();
  await writeFile(data.filename, 'corrupt notification database');
  await assert.rejects(data.open());
  assert.equal(await readFile(data.filename, 'utf8'), 'corrupt notification database');
  await rm(path.join(data.directory, 'accounts.key'));
  await assert.rejects(data.open(), { code: 'ENOENT' });
});
