import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccountStore } from '../server/account-store.mjs';
import { createMailIndex } from '../server/mail-index.mjs';
import { createMailProcessing } from '../server/mail-processing.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = Date.parse('2026-09-17T12:00:00Z');

test('killing the processor after an external MOVE and before acknowledgement preserves the intent without a blind duplicate', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mailharbor-crash-'));
  const effectPath = path.join(directory, 'synthetic-provider.json'), childPath = path.join(directory, 'crash-worker.mjs');
  const account = { id: 'fixture', email: 'fixture@example.test', revision: 'one', connected: true, label: 'Synthetic account' };
  const reference = { accountId: account.id, path: 'INBOX', uid: 1, uidValidity: '1', fingerprint: hash('synthetic-message') };
  const key = hash([account.id, account.email, reference.fingerprint]);
  const message = { accountId: account.id, account: account.label, subject: 'Synthetic message', author: 'sender@example.test',
    to: account.email, folderPath: 'INBOX', role: 'inbox', date: '2026-01-01T12:00:00Z', receivedAt: '2026-01-01T12:00:00Z',
    unread: false, starred: false, reference };
  const classification = { id: key, labels: ['jobs'], confidence: 0.99, junk: 'legitimate', junkConfidence: 0.99,
    dates: { couponExpiry: null, tenderDeadline: null, appointmentStart: null, appointmentEnd: null }, dateConfidence: 0, appointment: null };
  const store = await createAccountStore(directory);
  let index = await createMailIndex(directory), processor, child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await processor?.close(); index?.close();
    await rm(directory, { recursive: true, force: true });
  });
  index.put('messages', key, { key, accountId: account.id, email: account.email, message, reference, receivedAt: message.receivedAt,
    discoveredAt: stamp, locations: [{ reference, role: 'inbox', read: true, handled: null }], classification, complete: true, nextAt: stamp, review: false },
    { state: 'ready', due: stamp });
  index.close(); index = null;
  await writeFile(effectPath, JSON.stringify({ applied: 0, sourcePresent: true }));
  // The fake provider owns independent durable state. Killing the child leaves
  // that effect applied while bypassing processor catches, finally and close.
  const source = `
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createAccountStore } from ${JSON.stringify(new URL('../server/account-store.mjs', import.meta.url).href)};
import { createMailIndex } from ${JSON.stringify(new URL('../server/mail-index.mjs', import.meta.url).href)};
import { createMailProcessing } from ${JSON.stringify(new URL('../server/mail-processing.mjs', import.meta.url).href)};
const account = ${JSON.stringify(account)}, directory = ${JSON.stringify(directory)}, effectPath = ${JSON.stringify(effectPath)};
const index = await createMailIndex(directory), store = await createAccountStore(directory);
const processor = createMailProcessing({ index, store, now: () => ${stamp}, autoSchedule: false,
  accounts: { list: () => [account], get: () => account },
  tags: { manualFor: () => [], automatic: async () => {}, observe: async () => {} },
  classify: async () => { throw new Error('Cached classification must be reused'); },
  reader: { folders: async () => ({ folders: [] }), move: async (_, reference, action, { verify }) => {
    verify();
    const state = JSON.parse(readFileSync(effectPath, 'utf8'));
    if (!state.sourcePresent) throw new Error('Unexpected repeated effect');
    state.applied++; state.sourcePresent = false;
    writeFileSync(effectPath, JSON.stringify(state));
    const descriptor = openSync(effectPath, 'r+'); fsyncSync(descriptor); closeSync(descriptor);
    process.stdout.write('effect-applied\\n');
    await new Promise(() => {});
  } }
});
await processor.configure({ providerConsent: true });
await processor.action('start'); await processor.drain();
throw new Error('The test must kill this process before acknowledgement');
`;
  await writeFile(childPath, source);
  child = spawn(process.execPath, [childPath], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value; });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Crash fixture did not reach its effect boundary: ${stderr}`)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Crash fixture exited before its effect boundary: ${stderr}`)); });
    child.stdout.setEncoding('utf8'); child.stdout.on('data', value => {
      output += value;
      if (output.includes('effect-applied\n')) { clearTimeout(timer); resolve(); }
    });
  });
  child.kill('SIGKILL'); await exited;
  assert.deepEqual(JSON.parse(await readFile(effectPath, 'utf8')), { applied: 1, sourcePresent: false });
  index = await createMailIndex(directory);
  const abandoned = index.get('messages', key);
  assert.equal(abandoned.locations[0].intent.action, 'trash');
  assert.equal(abandoned.locations[0].handled, null);
  assert.deepEqual(abandoned.classification, classification);
  let inspections = 0;
  processor = createMailProcessing({ index, store, now: () => stamp + 600000, autoSchedule: false,
    accounts: { list: () => [account], get: () => account },
    tags: { manualFor: () => [], automatic: async () => {}, observe: async () => {} },
    classify: async () => { assert.fail('Restart must reuse the durable classification'); },
    reader: { folders: async () => ({ folders: [] }), move: async (_, received, action, { verify }) => {
      verify(); inspections++;
      assert.deepEqual(received, reference); assert.equal(action, 'trash');
      const external = JSON.parse(await readFile(effectPath, 'utf8'));
      assert.equal(external.sourcePresent, false);
      return { status: 'absent' };
    } }
  });
  await processor.action('start'); await processor.drain();
  const recovered = index.get('messages', key);
  assert.equal(inspections, 1);
  assert.equal(recovered.locations[0].intent, null); assert.equal(recovered.locations[0].handled, 'absent');
  assert.equal(recovered.review, true, 'An absent source is uncertain, never evidence of a successful checkpoint');
  assert.equal(processor.status().counts.moved, 0);
  assert.deepEqual(recovered.classification, classification);
  assert.deepEqual(JSON.parse(await readFile(effectPath, 'utf8')), { applied: 1, sourcePresent: false });
});
