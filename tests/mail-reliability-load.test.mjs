import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccountStore } from '../server/account-store.mjs';
import { createMailIndex } from '../server/mail-index.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mailharbor-reliability-'));
  const open = new Set();
  await createAccountStore(directory);
  t.after(async () => {
    for (const resource of open) resource.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, filename: path.join(directory, 'mail-index.sqlite'),
    async index() { const value = await createMailIndex(directory); open.add(value); return value; },
    sql() { const value = new DatabaseSync(path.join(directory, 'mail-index.sqlite')); open.add(value); return value; },
    close(value) { value.close(); open.delete(value); }
  };
}

test('100,000 encrypted metadata records support bounded owner scheduling and reconcilable summaries', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  let index = await f.index();
  const owners = Array.from({ length: 5 }, (_, n) => index.token(`fixture-owner:${n}`));
  const base = Date.parse('2026-09-17T00:00:00Z'), total = 100000;
  const analyses = ['pending', 'retrying', 'classified', 'classified', 'classified', 'failed', 'pending', 'classified'];
  const categories = ['', 'retry', '', 'held', 'review', 'failed', '', ''];
  const expected = owners.map(() => []), counts = { analysis: {}, categories: {} };
  const seedStarted = performance.now();
  index.transaction(() => {
    for (let n = 0; n < total; n++) {
      // Deliberately scramble keys and ages so a hash-order query cannot pass as oldest/newest scheduling.
      const key = index.token(`fixture-message:${n}`), owner = n % owners.length;
      const analysis = analyses[n % analyses.length], category = categories[n % categories.length];
      const due = base + Math.floor(n / 40) * 1000, age = base - ((n * 97) % total) * 1000;
      const state = analysis === 'pending' || analysis === 'retrying' ? 'pending' : analysis === 'failed' ? 'review' : 'ready';
      const reasons = category === 'held' ? ['date_uncertain', 'incomplete_message'] :
        category === 'review' ? ['classification_uncertain'] : category === 'failed' ? ['invalid_model_output'] : [];
      index.put('messages', key, { accountId: `fixture-${owner}`, uid: n + 1, subject: 'PRIVATE_LOAD_SUBJECT',
        author: 'PRIVATE_LOAD_SENDER', analysisState: analysis, category, receivedAt: new Date(age).toISOString() },
      { owner: owners[owner], state, due, age, analysis, category, reasons });
      counts.analysis[analysis] = (counts.analysis[analysis] ?? 0) + 1;
      counts.categories[category] = (counts.categories[category] ?? 0) + 1;
      if (state === 'pending') expected[owner].push({ key, due, age });
    }
  });
  const seedMs = performance.now() - seedStarted;
  assert.equal(index.count('messages'), total);
  const queryStarted = performance.now(), pageLimit = 12, before = base + 1250000;
  for (let owner = 0; owner < owners.length; owner++) {
    const due = expected[owner].filter(row => row.due <= before)
      .sort((a, b) => a.due - b.due || a.age - b.age || a.key.localeCompare(b.key)).slice(0, pageLimit);
    const newest = expected[owner].filter(row => row.due <= before)
      .sort((a, b) => b.age - a.age || a.due - b.due || a.key.localeCompare(b.key)).slice(0, pageLimit);
    for (const [order, selected] of [['due', due], ['newest', newest]]) {
      const rows = index.list('messages', { state: 'pending', owner: owners[owner], before, order, limit: pageLimit });
      assert.equal(rows.length, pageLimit);
      assert.deepEqual(rows.map(row => row.key), selected.map(row => row.key));
      assert.ok(rows.every(row => row.value.accountId === `fixture-${owner}`));
    }
  }
  const categoryPage = index.list('messages', { category: 'review', limit: 25 });
  assert.equal(categoryPage.length, 25); assert.ok(categoryPage.every(row => row.value.category === 'review'));
  assert.deepEqual(index.list('messages', { state: 'pending', before: base - 1, limit: pageLimit }), []);
  const summary = index.processingSummary(), queryMs = performance.now() - queryStarted;
  assert.deepEqual(summary.analysis, counts.analysis); assert.deepEqual(summary.categories, counts.categories);
  assert.equal(Object.values(summary.analysis).reduce((sum, value) => sum + value, 0), total);
  assert.equal(Object.values(summary.categories).reduce((sum, value) => sum + value, 0), total);
  assert.deepEqual(summary.reasons, { invalid_model_output: 12500, incomplete_message: 12500,
    classification_uncertain: 12500, date_uncertain: 12500 });
  assert.equal(summary.earliestDue, base);
  assert.equal(index.healthy(), true);
  // Closing checkpoints WAL into the database, so this inspects all durable encrypted records.
  f.close(index);
  const raw = await readFile(f.filename);
  for (const marker of ['PRIVATE_LOAD_SUBJECT', 'PRIVATE_LOAD_SENDER', 'fixture-0']) {
    assert.equal(raw.includes(Buffer.from(marker)), false);
  }
  index = await f.index();
  assert.deepEqual(index.processingSummary(), summary);
  assert.equal(index.count('messages'), total);
  t.diagnostic(`100,000-record SQLite fixture: seed ${Math.round(seedMs)} ms; bounded scheduling and summary checks ${Math.round(queryMs)} ms; database ${raw.length} bytes. This measures this machine, not a production memory or throughput guarantee.`);
});

test('independent index connections refuse duplicate leases and only the current holder may release or renew', async t => {
  const f = await fixture(t), first = await f.index(), second = await f.index();
  assert.equal(first.claimLease('processor', 'worker-one', 1000, 500), true);
  assert.equal(second.claimLease('processor', 'worker-two', 1100, 500), false);
  second.releaseLease('processor', 'worker-two');
  assert.equal(second.claimLease('processor', 'worker-two', 1200, 500), false);
  assert.equal(first.claimLease('processor', 'worker-one', 1400, 500), true);
  assert.equal(second.claimLease('processor', 'worker-two', 1500, 500), false);
  assert.equal(second.claimLease('processor', 'worker-two', 1900, 500), true);
  first.releaseLease('processor', 'worker-one');
  assert.equal(first.claimLease('processor', 'worker-one', 2000, 500), false);
  second.releaseLease('processor', 'worker-two');
  assert.equal(first.claimLease('processor', 'worker-one', 2000, 500), true);
  f.close(first);
  const restarted = await f.index();
  assert.equal(restarted.claimLease('processor', 'worker-three', 2100, 500), false);
  assert.equal(restarted.claimLease('processor', 'worker-three', 2500, 500), true);
});

test('authenticated record corruption fails closed and prevents later writes or processor claims', async t => {
  const f = await fixture(t), index = await f.index();
  index.put('messages', 'first', { subject: 'protected first' }, { analysis: 'classified', category: '' });
  index.put('messages', 'second', { subject: 'protected second' }, { analysis: 'pending', category: 'pending' });
  const sql = f.sql();
  // Ciphertext from a valid different record is invalid under this record's authenticated identity.
  sql.prepare("UPDATE documents SET data=(SELECT data FROM documents WHERE kind='messages' AND key='second') WHERE kind='messages' AND key='first'").run();
  assert.throws(() => index.get('messages', 'first'));
  assert.equal(index.healthy(), false);
  assert.throws(() => index.put('messages', 'third', { subject: 'must not persist' }), /requires recovery/u);
  assert.throws(() => index.claimLease('processor', 'worker', 1000, 500), /requires recovery/u);
  assert.equal(index.get('messages', 'third'), null);
});

test('SQLite write failure rolls back encrypted metadata and all indexed processing reasons atomically', async t => {
  const f = await fixture(t);
  let index = await f.index();
  const original = { subject: 'preserved classification', decision: 'keep' };
  index.put('messages', 'one', original, { state: 'ready', due: 100, analysis: 'classified', category: 'held', reasons: ['incomplete_message'] });
  const summary = index.processingSummary(), sql = f.sql();
  // A real SQLite statement failure occurs after the encrypted document and metadata have changed.
  // This is transaction fault injection, not a claim to simulate a full filesystem.
  sql.exec("CREATE TRIGGER reject_fixture_reason BEFORE INSERT ON processing_reasons WHEN NEW.reason='fixture_rejected' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;");
  assert.throws(() => index.put('messages', 'one', { subject: 'must roll back' },
    { state: 'pending', due: 200, analysis: 'pending', category: 'failed', reasons: ['fixture_rejected'] }));
  assert.equal(index.healthy(), false);
  assert.deepEqual(index.get('messages', 'one'), original);
  assert.deepEqual(index.processingSummary(), summary);
  assert.throws(() => index.put('messages', 'two', {}), /requires recovery/u);
  sql.exec('DROP TRIGGER reject_fixture_reason;');
  f.close(sql); f.close(index);
  index = await f.index();
  assert.equal(index.healthy(), true); assert.deepEqual(index.get('messages', 'one'), original);
  assert.deepEqual(index.processingSummary(), summary); assert.equal(index.get('messages', 'two'), null);
});
