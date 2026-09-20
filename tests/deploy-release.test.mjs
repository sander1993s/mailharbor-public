import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, mkdir, stat, rm, readdir, symlink, link} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createAccountStore} from '../server/account-store.mjs';
import {createMailIndex} from '../server/mail-index.mjs';
import {createNotificationStore} from '../server/notification-store.mjs';
import {VERSION} from '../server/validation.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const python = process.platform === 'win32' ? 'python' : 'python3';
const script = path.join(project, 'scripts', 'deploy-release.py');
const helper = path.join(project, 'scripts', 'verify-state-backup.mjs');
test('the API advertises the release version before deployment', async () => {
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  assert.equal(VERSION, manifest.version);
  const acceptance = await readFile(path.join(project, 'scripts', 'verify-unified-mail.py'), 'utf8');
  assert.equal(acceptance.match(/^VERSION = "([^"]+)"/m)?.[1], manifest.version);
  const lock = JSON.parse(await readFile(path.join(project, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, manifest.version); assert.equal(lock.packages[''].version, manifest.version);
  const worker = await readFile(path.join(project, 'web', 'sw.mjs'), 'utf8');
  assert.ok(worker.includes(`mailharbor-shell-v${manifest.version}'`));
  assert.ok(worker.includes("'/telegram-settings.mjs'"));
});
const pythonImport = "import importlib.util, pathlib, sys, json; s=importlib.util.spec_from_file_location('deployment',sys.argv[1]); d=importlib.util.module_from_spec(s); s.loader.exec_module(d); ";
function py(code, args = []) { return spawnSync(python, ['-B', '-c', pythonImport + code, script, ...args], {encoding: 'utf8', timeout: 30000, windowsHide: true}); }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-restore-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const state = path.join(root, 'state'), backup = path.join(root, 'backup'), restore = path.join(root, 'restore-check');
  const store = await createAccountStore(state);
  const account = {id: 'business-imap', email: 'fixture@example.test', revision: 'fixture', auth: {type: 'password', password: 'PRIVATE_RESTORE_SECRET'}};
  await store.update(data => { data.accounts.push(account); });
  const index = await createMailIndex(state);
  const fingerprint = 'a'.repeat(64), key = createHash('sha256').update(JSON.stringify([account.id, account.email, fingerprint])).digest('hex');
  const reference = {accountId: account.id, path: 'INBOX', uid: 1, uidValidity: '1', fingerprint};
  const classification = {id: key, labels: ['social'], confidence: .99, junk: 'legitimate', junkConfidence: 1, dates: {couponExpiry: null, tenderDeadline: null, appointmentStart: null, appointmentEnd: null}, dateConfidence: 1, appointment: null};
  index.put('messages', key, {key, accountId: account.id, email: account.email, reference, classification, complete: true,
    message: {subject: 'PRIVATE_RESTORE_SUBJECT', accountId: account.id, date: '2026-08-01T00:00:00Z'}, receivedAt: '2026-08-01T00:00:00Z',
    locations: [{reference, role: 'inbox', read: true, intent: {action: 'trash', at: 1}}], ownerDecision: {action: 'keep'}, review: true, nextAt: null}, {state: 'review'});
  index.put('meta', 'processingSettings', {enabled: false, providerConsent: true, tenderGraceMonths: 2, tenderGraceDays: null, mode: 'apply', counts: {markedRead: 7, moved: 2}, pauseReason: 'invalid_model_output'});
  index.close();
  return {root, state, backup, restore, key};
}
function backupState(state, backup) {
  const result = py('print(json.dumps(d.backup_state(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))))', [state, backup]);
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
function restoreState(backup, restore, staged = project, previous = project) {
  return py('d.NODE=pathlib.Path(sys.argv[2]); d.verify_state_backup(pathlib.Path(sys.argv[3]),pathlib.Path(sys.argv[4]),pathlib.Path(sys.argv[5]),pathlib.Path(sys.argv[6]),None)', [process.execPath, previous, staged, backup, restore]);
}

async function archiveFixture(t) {
  const value = await fixture(t), index = await createMailIndex(value.state);
  const original = index.get('messages', value.key);
  const reference = {...original.reference};
  const main = {...original, ownerDecision: null, archiveRecheckVersion: 0, reference,
    locations: [
      {reference, role: 'inbox', read: true, gmail: true, emailId: '12345', handled: 'archive'},
      {reference: {...reference, path: '[Gmail]/All Mail', uid: 2}, role: 'archive', read: true, gmail: true, emailId: '12345', handled: 'archive'},
      {reference: {...reference, path: '[Gmail]/All Mail', uid: 3}, role: 'archive', read: true, gmail: true, emailId: '67890', handled: 'archive'},
      {reference: {...reference, accountId: 'another-account', uid: 4}, role: 'inbox', read: true, gmail: true, emailId: '12345', handled: 'archive'},
      {reference: {...reference, path: 'Other', uid: 5}, role: 'other', read: true, gmail: false, emailId: '12345', handled: 'archive'},
      {reference: {...reference, path: '[Gmail]/Trash', uid: 6}, role: 'trash', read: true, gmail: true, emailId: '12345', handled: 'trash'}
    ]};
  index.put('messages', value.key, main, {state: 'done'});
  const protectedKeys = [];
  for (const [name, update] of [
    ['owner', record => { record.ownerDecision = {action: 'keep', at: 1}; }],
    ['intent', record => { record.locations[1].intent = {action: 'archive', at: 1}; }],
    ['already-rechecked', record => { record.archiveRecheckVersion = 1; }],
    ['different-reference', record => { record.reference.uid = 999; }],
    ['different-fingerprint', record => { record.reference.fingerprint = 'b'.repeat(64); }],
    ['non-gmail', record => { for (const location of record.locations) location.gmail = false; }]
  ]) {
    const record = structuredClone(main), key = createHash('sha256').update(name).digest('hex');
    // Separate the current reference from the location object before changing it.
    record.reference = {...record.reference}; record.key = key; record.classification.id = key; update(record);
    index.put('messages', key, record, {state: 'done'}); protectedKeys.push(key);
  }
  index.close(); return {...value, main, protectedKeys};
}

async function alteredStage(root, alteration) {
  const staged = path.join(root, 'altered-stage');
  await mkdir(path.join(staged, 'server'), {recursive: true}); await mkdir(path.join(staged, 'scripts'));
  for (const name of ['account-store.mjs', 'mail-index.mjs', 'notification-store.mjs']) await writeFile(path.join(staged, 'server', name), `export * from ${JSON.stringify(pathToFileURL(path.join(project, 'server', name)).href)};`);
  await writeFile(path.join(staged, 'scripts', 'verify-state-backup.mjs'), await readFile(helper));
  await writeFile(path.join(staged, 'server', 'mail-processing.mjs'), `import {createMailProcessing as actual} from ${JSON.stringify(pathToFileURL(path.join(project, 'server', 'mail-processing.mjs')).href)};
export function createMailProcessing(options) { const processor=actual(options); ${alteration}; return processor; }`);
  return staged;
}

test('protected backup includes committed SQLite WAL and key while leaving live state unchanged', async t => {
  const {state, backup} = await fixture(t);
  const database = new DatabaseSync(path.join(state, 'mail-index.sqlite'));
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE backup_fixture(value TEXT); INSERT INTO backup_fixture VALUES('committed-in-wal')");
  const keyBefore = await readFile(path.join(state, 'accounts.key')), accountsBefore = await readFile(path.join(state, 'accounts.enc'));
  let manifest;
  try { manifest = backupState(state, backup); } finally { database.close(); }
  assert.equal(manifest.messages, 1); assert.equal(manifest.documents, 2);
  const restored = new DatabaseSync(path.join(backup, 'mail-index.sqlite'), {readOnly: true});
  assert.equal(restored.prepare('SELECT value FROM backup_fixture').get().value, 'committed-in-wal'); restored.close();
  assert.deepEqual(await readFile(path.join(backup, 'accounts.key')), keyBefore);
  assert.deepEqual(await readFile(path.join(state, 'accounts.enc')), accountsBefore);
  if (process.platform !== 'win32') {
    assert.equal((await stat(backup)).mode & 0o777, 0o700);
    for (const name of Object.keys(manifest.files)) assert.equal((await stat(path.join(backup, name))).mode & 0o777, 0o600);
  }
});

test('isolated restore exercises additive migration and rollback reads without leaking email or keys', async t => {
  const {state, backup, restore} = await fixture(t);
  const manifest = backupState(state, backup);
  const result = restoreState(backup, restore);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.restoreVerified, true); assert.equal(report.rollbackReadVerified, true);
  assert.equal(report.classifications, 1); assert.equal(report.ownerDecisions, 1); assert.equal(report.pendingIntents, 1);
  assert.equal(report.permittedArchiveRechecks, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_RESTORE|fixture@example/);
  for (const [name, expected] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(path.join(backup, name))).digest('hex'), expected);
});

test('discarding a verified restore copy preserves the actual backup and live state', async t => {
  const {state, backup, restore} = await fixture(t), notifications = await createNotificationStore(state);
  notifications.put('cursors', 'fixture-account', {afterUid: 88}); notifications.close();
  const manifest = backupState(state, backup), manifestBefore = await readFile(path.join(backup, 'backup-manifest.json'));
  const stateBefore = await Promise.all(Object.keys(manifest.files).map(name => readFile(path.join(state, name))));
  const verified = restoreState(backup, restore);
  assert.equal(verified.status, 0, verified.stderr);
  const result = py('d.discard_verified_restore_copy(pathlib.Path(sys.argv[2]))', [restore]);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(restore), {code: 'ENOENT'});
  assert.deepEqual(await readFile(path.join(backup, 'backup-manifest.json')), manifestBefore);
  for (const [name, expected] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(path.join(backup, name))).digest('hex'), expected);
  assert.deepEqual(await Promise.all(Object.keys(manifest.files).map(name => readFile(path.join(state, name)))), stateBefore);
});

for (const shape of ['unmarked', 'altered-marker', 'unexpected-file', 'unexpected-directory', 'linked-directory', 'hard-linked-file', 'wrong-name']) {
  test(`restore copy cleanup refuses ${shape} without deleting any entries`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-discard-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const restore = path.join(root, shape === 'wrong-name' ? 'state' : 'restore-check');
    await mkdir(restore);
    for (const name of ['accounts.key', 'accounts.enc', 'mail-index.sqlite']) await writeFile(path.join(restore, name), 'synthetic restore fixture');
    await writeFile(path.join(restore, '.restore-check'), 'MailHarbor isolated restore verification\n');
    if (shape === 'unmarked') await rm(path.join(restore, '.restore-check'));
    if (shape === 'altered-marker') await writeFile(path.join(restore, '.restore-check'), 'different purpose\n');
    if (shape === 'unexpected-file') await writeFile(path.join(restore, 'unexpected.txt'), 'must remain');
    if (shape === 'unexpected-directory') await mkdir(path.join(restore, 'unexpected'));
    if (shape === 'linked-directory') {
      const outside = path.join(root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'protected.txt'), 'must remain');
      await rm(path.join(restore, 'accounts.enc'));
      await symlink(outside, path.join(restore, 'accounts.enc'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (shape === 'hard-linked-file') {
      const outside = path.join(root, 'protected.txt'); await writeFile(outside, 'must remain');
      await rm(path.join(restore, 'accounts.enc')); await link(outside, path.join(restore, 'accounts.enc'));
    }
    const before = (await readdir(restore)).sort(), keyBefore = await readFile(path.join(restore, 'accounts.key'));
    const result = py('d.discard_verified_restore_copy(pathlib.Path(sys.argv[2]))', [restore]);
    assert.notEqual(result.status, 0);
    assert.deepEqual((await readdir(restore)).sort(), before);
    assert.deepEqual(await readFile(path.join(restore, 'accounts.key')), keyBefore);
    if (shape === 'linked-directory') assert.equal(await readFile(path.join(root, 'outside', 'protected.txt'), 'utf8'), 'must remain');
    if (shape === 'hard-linked-file') assert.equal(await readFile(path.join(root, 'protected.txt'), 'utf8'), 'must remain');
  });
}

test('notification backup folds committed WAL into a private standalone snapshot and restores pending deliveries', async t => {
  const {state, backup, restore} = await fixture(t), notifications = await createNotificationStore(state);
  const owner = notifications.token('fixture-account'), id = notifications.token('fixture-notification');
  notifications.transaction(() => {
    notifications.put('cursors', owner, {uidValidity: '123', afterUid: 88});
    notifications.put('candidates', id, {body: 'PRIVATE_NOTIFICATION_BODY', summary: 'PRIVATE_NOTIFICATION_SUMMARY', state: 'ready', settingsGeneration: 7}, {state: 'ready', due: 123456, owner});
  });
  notifications.claimLease('worker', 'fixture-holder', 100, 1000);
  let manifest;
  try {
    assert.ok((await stat(path.join(state, 'notification-state.sqlite-wal'))).size > 0);
    manifest = backupState(state, backup);
    assert.deepEqual(notifications.get('cursors', owner), {uidValidity: '123', afterUid: 88});
  } finally { notifications.close(); }
  assert.equal(manifest.schema, 2); assert.equal(manifest.notificationsPresent, true);
  assert.equal(manifest.notificationDocuments, 2); assert.equal(manifest.notificationCandidates, 1);
  assert.ok(manifest.files['notification-state.sqlite']);
  const bytes = await readFile(path.join(backup, 'notification-state.sqlite'));
  assert.equal(bytes.includes(Buffer.from('PRIVATE_NOTIFICATION_')), false);
  const snapshot = new DatabaseSync(path.join(backup, 'notification-state.sqlite'), {readOnly: true});
  assert.equal(snapshot.prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); snapshot.close();
  await assert.rejects(stat(path.join(backup, 'notification-state.sqlite-wal')), {code: 'ENOENT'});
  const result = restoreState(backup, restore);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.notificationDocuments, 2); assert.match(report.notificationStateSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_NOTIFICATION|fixture-holder/);
  const restored = await createNotificationStore(restore);
  try {
    assert.equal(restored.get('candidates', id).summary, 'PRIVATE_NOTIFICATION_SUMMARY');
    assert.equal(restored.list('candidates', {state: 'ready', before: 123456, owner}).length, 1);
    assert.equal(restored.claimLease('worker', 'other-holder', 1000), false);
  } finally { restored.close(); }
});

test('notification restore fails closed for authenticated record damage or modified delivery metadata', async t => {
  for (const damage of ['ciphertext', 'delivery-state']) {
    const {root, state, backup, restore} = await fixture(t), notifications = await createNotificationStore(state);
    notifications.put('candidates', 'candidate', {body: 'PRIVATE_NOTIFICATION_BODY'}, {state: 'pending', due: 123}); notifications.close();
    if (damage === 'ciphertext') {
      const database = new DatabaseSync(path.join(state, 'notification-state.sqlite'));
      database.exec("UPDATE documents SET data=zeroblob(40)"); database.close();
    }
    backupState(state, backup);
    const staged = damage === 'delivery-state' ? await alteredStage(root, `const db=new (process.getBuiltinModule('node:sqlite').DatabaseSync)(${JSON.stringify(path.join(restore, 'notification-state.sqlite'))}); db.exec("UPDATE documents SET state='sent'"); db.close()`) : project;
    const result = restoreState(backup, restore, staged);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restore\/migration verification failed/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_NOTIFICATION/);
  }
});

test('backup refuses orphaned notification WAL and legacy backup manifests remain readable', async t => {
  const {state, backup, restore} = await fixture(t);
  await writeFile(path.join(state, 'notification-state.sqlite-wal'), 'orphaned');
  const rejected = py('d.backup_state(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))', [state, backup]);
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /SQLite sidecars remain/);
  await rm(path.join(state, 'notification-state.sqlite-wal'));
  const manifest = backupState(state, backup); manifest.schema = 1;
  delete manifest.notificationsPresent; delete manifest.notificationDocuments; delete manifest.notificationCandidates;
  await writeFile(path.join(backup, 'backup-manifest.json'), JSON.stringify(manifest));
  const result = restoreState(backup, restore);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).notificationStateSha256, null);
});

test('rollback to a release without notifications preserves the independent store using the staged verifier', async t => {
  const {root, state, backup, restore} = await fixture(t), notifications = await createNotificationStore(state);
  notifications.put('cursors', 'business', {afterUid: 123}); notifications.close();
  const previous = path.join(root, 'previous'); await mkdir(path.join(previous, 'server'), {recursive: true});
  for (const name of ['account-store.mjs', 'mail-index.mjs']) await writeFile(path.join(previous, 'server', name), `export * from ${JSON.stringify(pathToFileURL(path.join(project, 'server', name)).href)};`);
  backupState(state, backup);
  const result = restoreState(backup, restore, project, previous);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.previousNotificationReader, false); assert.equal(report.notificationDocuments, 1);
  assert.equal(report.restoreVerified, true); assert.equal(report.rollbackReadVerified, true);
});

test('archive repair projection allows only exact Gmail INBOX checkpoint and physical aliases while preserving protected records', async t => {
  const {state, backup, restore, key, main, protectedKeys} = await archiveFixture(t);
  backupState(state, backup);
  const result = restoreState(backup, restore);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.permittedArchiveRechecks, 1); assert.equal(report.rollbackReadVerified, true);
  assert.equal(report.classifications, 7); assert.equal(report.ownerDecisions, 1); assert.equal(report.pendingIntents, 1);
  const original = await createMailIndex(backup), restored = await createMailIndex(restore);
  try {
    const record = restored.get('messages', key);
    const expected = structuredClone(main.locations); expected[0].handled = null; expected[1].handled = null;
    assert.deepEqual(record.locations, expected);
    assert.deepEqual(record.classification, main.classification); assert.deepEqual(record.reference, main.reference);
    for (const protectedKey of protectedKeys) assert.deepEqual(restored.get('messages', protectedKey).locations, original.get('messages', protectedKey).locations);
  } finally { restored.close(); original.close(); }
});

for (const [name, alteration] of [
  ['a different physical alias', 'record.locations[2].handled=null'],
  ['a category', "record.classification.labels=['finance']"],
  ['the verified source reference', 'record.reference.uid=999'],
  ['the owner decision', "record.ownerDecision={action:'keep',at:2}"],
  ['an owner-protected checkpoint', 'record.locations[0].handled=null'],
  ['the required repair itself', "record.locations[0].handled='archive'; record.locations[1].handled='archive'"]
]) test(`archive repair verification rejects an extra mutation of ${name}`, async t => {
  const {root, state, backup, restore, key, protectedKeys} = await archiveFixture(t);
  backupState(state, backup);
  const target = name === 'an owner-protected checkpoint' ? protectedKeys[0] : key;
  const staged = await alteredStage(root, `const record=options.index.get('messages',${JSON.stringify(target)}); ${alteration}; options.index.put('messages',record.key,record)`);
  const result = restoreState(backup, restore, staged);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /restore\/migration verification failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_RESTORE/);
});

test('backup rejects an existing destination and restore rejects changed ciphertext', async t => {
  const {state, backup, restore} = await fixture(t);
  backupState(state, backup);
  assert.notEqual(py('d.backup_state(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))', [state, backup]).status, 0);
  await writeFile(path.join(backup, 'accounts.enc'), 'tampered');
  const result = restoreState(backup, restore);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /hash mismatch/);
});

test('restore verification blocks unsafe migrations that discard a saved classification', async t => {
  const {root, state, backup, restore, key} = await fixture(t);
  backupState(state, backup);
  const staged = path.join(root, 'bad-stage'); await mkdir(path.join(staged, 'server'), {recursive: true}); await mkdir(path.join(staged, 'scripts'));
  for (const name of ['account-store.mjs', 'mail-index.mjs']) await writeFile(path.join(staged, 'server', name), `export * from ${JSON.stringify(pathToFileURL(path.join(project, 'server', name)).href)};`);
  await writeFile(path.join(staged, 'scripts', 'verify-state-backup.mjs'), await readFile(helper));
  await writeFile(path.join(staged, 'server', 'mail-processing.mjs'), `export function createMailProcessing({index}) { const record=index.get('messages',${JSON.stringify(key)}); record.classification=null; index.put('messages',record.key,record); return {status:()=>({running:false}),close:async()=>{}}; }`);
  const result = restoreState(backup, restore, staged);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /restore\/migration verification failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_RESTORE/);
});

test('state verification refuses an unmarked live directory', async t => {
  const {state} = await fixture(t);
  const result = spawnSync(process.execPath, [helper, project, project, state], {encoding: 'utf8', timeout: 30000, windowsHide: true});
  assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_RESTORE/);
});

test('deployment health refuses an enabled worker even between runs', async t => {
  const {root} = await fixture(t), config = path.join(root, 'config.json');
  await writeFile(config, JSON.stringify({pairingToken: 'synthetic-test-token-only-abcdefghijklmnopqrstuvwxyz', web: {origin: 'https://mail.example.com:9443'}}));
  const code = `
from urllib.parse import urlsplit
d.CONFIG=pathlib.Path(sys.argv[2])
routes={'/api/session': {'csrf':'fixture'}, '/api/status': {'version':'0.6.6','ready':True}, '/api/accounts': {'accounts':[]}, '/api/briefings': {'briefings':[]}, '/api/invoices': {'running':False}, '/api/mail/processing/status': {'running':False,'enabled':True}, '/api/mail/telegram': {'busy':False,'enabled':True}}
class Response:
    headers={'Set-Cookie':'fixture=session'}
    def __init__(self, data): self.data=data
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self,*args): return json.dumps(self.data).encode()
class Opener:
    def open(self, request, **kwargs): return Response(routes.get(urlsplit(request.full_url).path,{}))
d.build_opener=lambda *args: Opener()
try:
    d.health(require_idle=True)
    raise AssertionError('Enabled processing passed deployment preflight')
except RuntimeError as error:
    assert 'enabled' in str(error)
routes['/api/mail/processing/status']['enabled']=False
assert d.health(require_idle=True)['enabledMailProcessing'] is False
routes['/api/status']['version']='0.8.5'
try:
    d.health(require_idle=True)
    raise AssertionError('Enabled notifications passed deployment preflight')
except RuntimeError as error:
    assert 'notifications are enabled' in str(error)
routes['/api/mail/telegram']['enabled']=False
routes['/api/mail/telegram']['busy']=True
try:
    d.health(require_idle=True)
    raise AssertionError('Active notifications passed deployment preflight')
except RuntimeError as error:
    assert 'inquiry processing is active' in str(error)
routes['/api/mail/telegram']['busy']=False
assert d.health(require_idle=True)['enabledInquiryNotifications'] is False
print('paused preflight verified')
`;
  const result = py(code, [config]); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /paused preflight verified/);
});
