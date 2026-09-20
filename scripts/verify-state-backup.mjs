/** Offline restore/migration verification. Never open the live state directory. */
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const require = (condition, message) => { if (!condition) throw new Error(message); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const serialize = value => JSON.stringify(canonical(value));
const digest = value => createHash('sha256').update(serialize(value)).digest('hex');
const moduleAt = (project, name) => import(pathToFileURL(path.join(project, 'server', name)).href);
const exists = async filename => { try { return (await stat(filename)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

async function snapshotNotifications(project, directory, fallbackProject) {
  const filename = path.join(directory, 'notification-state.sqlite');
  if (!await exists(filename)) return {notificationDocuments: 0, notificationStateSha256: null};
  // A release predating notifications leaves this independent store untouched.
  // Verify its contents with the staged reader without claiming old feature support.
  const readerProject = await exists(path.join(project, 'server/notification-store.mjs')) ? project : fallbackProject;
  const {createNotificationStore} = await moduleAt(readerProject, 'notification-store.mjs');
  const notifications = await createNotificationStore(directory);
  let database;
  try {
    database = new DatabaseSync(filename, {readOnly: true});
    require(database.prepare('PRAGMA quick_check').all().every(row => Object.values(row)[0] === 'ok'), 'Notification restore failed integrity verification');
    const hash = createHash('sha256'); let notificationDocuments = 0;
    const kinds = database.prepare('SELECT DISTINCT kind FROM documents ORDER BY kind').all();
    for (const {kind} of kinds) {
      let after = '';
      for (;;) {
        const rows = database.prepare('SELECT kind,key,state,due,owner FROM documents WHERE kind=? AND key>? ORDER BY key LIMIT 250').all(kind, after);
        for (const row of rows) { hash.update(serialize({...row, value: notifications.get(row.kind, row.key)})); notificationDocuments++; }
        if (rows.length < 250) break;
        after = rows.at(-1).key;
      }
    }
    for (const row of database.prepare('SELECT name,holder,expires FROM processing_leases ORDER BY name').all()) hash.update(serialize({lease: row}));
    return {notificationDocuments, notificationStateSha256: hash.digest('hex')};
  } finally { database?.close(); notifications.close(); }
}

// This is a projection of the pre-migration snapshot only. Never normalize the
// migrated records: an extra cleared checkpoint must still fail verification.
function expectedArchiveRepair(record) {
  const locations = record.locations ?? [];
  if (record.archiveRecheckVersion === 1 || record.ownerDecision || locations.some(location => location.intent)) return null;
  const reference = record.reference;
  const source = locations.find(location => location.gmail === true && location.handled === 'archive' &&
    typeof location.reference?.path === 'string' && location.reference.path.toUpperCase() === 'INBOX' &&
    ['accountId', 'path', 'uidValidity', 'uid', 'fingerprint'].every(key => location.reference[key] === reference?.[key]));
  if (!source) return null;
  const identity = typeof source.emailId === 'string' && /^\d{1,20}$/.test(source.emailId) ? source.emailId : null;
  return locations.map(location => {
    const samePhysicalMessage = identity ? location.gmail === true && location.emailId === identity &&
      location.reference?.accountId === source.reference.accountId : location === source;
    return samePhysicalMessage && location.handled === 'archive' ? {...location, handled: null} : location;
  });
}

async function snapshot(project, directory, {migrate = false, projectArchiveRepair = false, notificationProject = project} = {}) {
  const [{createAccountStore}, {createMailIndex}] = await Promise.all([
    moduleAt(project, 'account-store.mjs'), moduleAt(project, 'mail-index.mjs')
  ]);
  const store = await createAccountStore(directory), index = await createMailIndex(directory);
  let processing;
  try {
    if (migrate) {
      const {createMailProcessing} = await moduleAt(project, 'mail-processing.mjs');
      const deny = () => { throw new Error('External effect attempted during offline restore verification'); };
      const accounts = {
        list: () => store.read().accounts.map(account => ({...account, connected: Boolean(account.auth)})),
        get: id => { const account = store.read().accounts.find(value => value.id === id); require(account, 'Restore refers to an unavailable account'); return account; }
      };
      processing = createMailProcessing({index, store, accounts, autoSchedule: false,
        reader: new Proxy({}, {get: () => deny}), jobs: new Proxy({}, {get: () => deny}), classify: deny, enqueueInvoice: deny,
        tags: {manualFor(account, reference) {
          if (!account) return [];
          const key = createHash('sha256').update(JSON.stringify([account.id, account.email.trim().normalize('NFC').toLowerCase(), reference.fingerprint])).digest('hex');
          return index.get('tags', key)?.manual ?? [];
        }}});
      require(processing.status().running === false, 'Offline verification started a worker');
    }
    const database = new DatabaseSync(path.join(directory, 'mail-index.sqlite'), {readOnly: true});
    const kindRows = database.prepare('SELECT kind,count(*) count FROM documents GROUP BY kind ORDER BY kind').all();
    require(database.prepare('PRAGMA quick_check').all().every(row => Object.values(row)[0] === 'ok'), 'Restored database failed integrity verification');
    database.close();
    const messageHash = createHash('sha256'), expectedHash = projectArchiveRepair ? createHash('sha256') : null, otherHash = createHash('sha256');
    let messages = 0, classifications = 0, ownerDecisions = 0, pendingIntents = 0;
    let permittedArchiveRechecks = 0;
    for (const {kind} of kindRows) {
      let after = '';
      for (;;) {
        const rows = index.list(kind, {after, limit: 250});
        for (const {key, value} of rows) {
          if (kind === 'messages') {
            messages++;
            if (value.classification) classifications++;
            if (value.ownerDecision) ownerDecisions++;
            pendingIntents += value.locations?.filter(location => location.intent).length ?? 0;
            // These fields authorize provider effects; migration must preserve them.
            const protectedFields = {key, classification: value.classification ?? null, complete: value.complete ?? null,
              locations: value.locations ?? [], ownerDecision: value.ownerDecision ?? null, reference: value.reference ?? null,
              accountId: value.accountId, email: value.email, receivedAt: value.receivedAt};
            messageHash.update(serialize(protectedFields));
            if (expectedHash) {
              const repairedLocations = expectedArchiveRepair(value);
              if (repairedLocations) permittedArchiveRechecks++;
              expectedHash.update(serialize(repairedLocations ? {...protectedFields, locations: repairedLocations} : protectedFields));
            }
          } else if (kind !== 'meta' || key !== 'processingSettings') otherHash.update(serialize({kind, key, value}));
        }
        if (rows.length < 250) break;
        after = rows.at(-1).key;
      }
    }
    const settings = index.get('meta', 'processingSettings') ?? {};
    const preferences = {enabled: settings.enabled === true, providerConsent: settings.providerConsent ?? null,
      tenderGraceMonths: settings.tenderGraceMonths ?? null, tenderGraceDays: settings.tenderGraceDays ?? null, mode: settings.mode ?? 'preview'};
    const notificationState = await snapshotNotifications(project, directory, notificationProject);
    return {...notificationState, messages, classifications, ownerDecisions, pendingIntents, messageProtectionSha256: messageHash.digest('hex'),
      otherStateSha256: otherHash.digest('hex'), accountStateSha256: digest(store.read()), ownerSettingsSha256: digest(preferences),
      ...(expectedHash ? {expectedMessageProtectionSha256: expectedHash.digest('hex'), permittedArchiveRechecks} : {})};
  } finally { await processing?.close(); index.close(); }
}

try {
  const [previous, staged, directory] = process.argv.slice(2);
  require(previous && staged && directory && process.argv.length === 5, 'Expected old project, staged project and isolated restore directory');
  for (const candidate of [previous, staged, directory]) require(path.resolve(candidate) === await realpath(candidate), 'Non-canonical restore path');
  require(path.basename(directory) === 'restore-check' && await readFile(path.join(directory, '.restore-check'), 'utf8') === 'MailHarbor isolated restore verification\n', 'Missing isolated restore marker');
  const {expectedMessageProtectionSha256, permittedArchiveRechecks, ...before} = await snapshot(previous, directory, {projectArchiveRepair: true, notificationProject: staged});
  const expected = {...before, messageProtectionSha256: expectedMessageProtectionSha256};
  const migrated = await snapshot(staged, directory, {migrate: true});
  require(serialize(expected) === serialize(migrated), 'Migration changed protected message state outside the permitted archive recheck');
  const rollback = await snapshot(previous, directory, {notificationProject: staged});
  require(serialize(migrated) === serialize(rollback), 'Previous release cannot read the migrated state without loss');
  const previousNotificationReader = await exists(path.join(previous, 'server/notification-store.mjs'));
  process.stdout.write(JSON.stringify({restoreVerified: true, rollbackReadVerified: true, previousNotificationReader, permittedArchiveRechecks, ...migrated}) + '\n');
} catch {
  // Stored records, key material and exception/provider text never enter output.
  process.stderr.write('Protected state restore/migration verification failed. Live state remains untouched.\n');
  process.exitCode = 1;
}
