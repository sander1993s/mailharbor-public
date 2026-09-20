import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, chmod } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';

export const DEFAULT_MAX_HEADERS_PER_ACCOUNT = 500;
export const DEFAULT_MAX_BODY_BYTES = 512 * 1024 * 1024; // 512 MiB
export const DEFAULT_MAX_MESSAGE_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB
export const DEFAULT_RENDERER_VERSION = '1';

const pathEqual = (a, b) => a === b || (String(a ?? '').toUpperCase() === 'INBOX' && String(b ?? '').toUpperCase() === 'INBOX');
const validUid = uid => Number.isSafeInteger(uid) && uid > 0 && uid <= 0xffffffff;

/**
 * Encrypted, bounded homeserver mail cache.
 * Key derived from accounts.key via HMAC domain 'MailHarbor cache v1'.
 * Encrypted with AES-256-GCM and bound via AAD.
 * Independent mail-cache.sqlite, no plaintext subjects, addresses, bodies, or folder paths.
 */
export async function createMailCache(directory, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let master;
  try {
    if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
    master = directory ? await readFile(path.join(directory, 'accounts.key')) : randomBytes(32);
    if (master.length !== 32) throw new Error('Invalid mail cache key');
  } catch (err) {
    return createUnavailableCache();
  }

  const key = createHmac('sha256', master).update('MailHarbor cache v1').digest();
  const filename = directory ? path.join(directory, 'mail-cache.sqlite') : ':memory:';

  let db;
  try {
    db = new DatabaseSync(filename);
    if (directory && process.platform !== 'win32') await chmod(filename, 0o600);

    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA wal_autocheckpoint=1000;
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS namespaces (
        account_id TEXT PRIMARY KEY,
        namespace_key TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        dirty INTEGER NOT NULL DEFAULT 0,
        reconciled INTEGER NOT NULL DEFAULT 0,
        active_mutations INTEGER NOT NULL DEFAULT 0,
        folder_uid_validity TEXT,
        provider_total INTEGER,
        checkpoint TEXT,
        coverage_status TEXT,
        next_cursor BLOB,
        folder_metadata BLOB,
        last_refresh INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS headers (
        account_key TEXT NOT NULL,
        message_key TEXT NOT NULL,
        folder_token TEXT NOT NULL,
        uid INTEGER NOT NULL,
        time INTEGER NOT NULL,
        unread INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        size INTEGER,
        generation INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (account_key, message_key)
      );
      CREATE INDEX IF NOT EXISTS idx_headers_lookup ON headers(account_key, folder_token, time DESC, uid DESC);
      CREATE INDEX IF NOT EXISTS idx_headers_time ON headers(account_key, time ASC);
      CREATE INDEX IF NOT EXISTS idx_headers_uid ON headers(account_key, folder_token, uid);
      CREATE TABLE IF NOT EXISTS bodies (
        account_key TEXT NOT NULL,
        message_key TEXT NOT NULL,
        uid INTEGER NOT NULL,
        uid_validity TEXT NOT NULL,
        size INTEGER NOT NULL,
        cached_at INTEGER NOT NULL,
        renderer_version TEXT NOT NULL,
        generation INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (account_key, message_key)
      );
      CREATE INDEX IF NOT EXISTS idx_bodies_eviction ON bodies(cached_at ASC);
      CREATE INDEX IF NOT EXISTS idx_bodies_account ON bodies(account_key);
      CREATE INDEX IF NOT EXISTS idx_bodies_uid ON bodies(account_key, uid);
    `);
  } catch (err) {
    try { db?.close(); } catch {}
    key.fill(0);
    return createUnavailableCache();
  }

  let failed = false;

  // Injected test caps allowed on init
  let initialMaxHeaders = DEFAULT_MAX_HEADERS_PER_ACCOUNT;
  if (options.maxHeadersPerAccount !== undefined) {
    const parsed = Number(options.maxHeadersPerAccount);
    if (Number.isSafeInteger(parsed) && parsed > 0) initialMaxHeaders = parsed;
  }

  let initialMaxBodyBytes = DEFAULT_MAX_BODY_BYTES;
  if (options.maxBodyBytes !== undefined) {
    const parsed = Number(options.maxBodyBytes);
    if (Number.isFinite(parsed) && parsed > 0) initialMaxBodyBytes = parsed;
  }

  let initialMaxMsgBody = DEFAULT_MAX_MESSAGE_BODY_BYTES;
  if (options.maxMessageBodyBytes !== undefined) {
    const parsed = Number(options.maxMessageBodyBytes);
    if (Number.isFinite(parsed) && parsed > 0) initialMaxMsgBody = parsed;
  }

  const settings = {
    maxHeadersPerAccount: initialMaxHeaders,
    maxBodyBytes: initialMaxBodyBytes,
    maxMessageBodyBytes: initialMaxMsgBody,
    rendererVersion: String(options.rendererVersion || DEFAULT_RENDERER_VERSION)
  };

  // Check clean shutdown marker
  try {
    const cleanShutdownRow = db.prepare("SELECT value FROM cache_meta WHERE key='clean_shutdown'").get();
    const wasCleanShutdown = cleanShutdownRow?.value === '1';

    if (!wasCleanShutdown) {
      db.prepare('UPDATE namespaces SET dirty = 1, reconciled = 0, active_mutations = 0').run();
    }
    db.prepare("INSERT INTO cache_meta(key, value) VALUES('clean_shutdown', '0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  } catch (err) {
    failed = true;
  }

  let inTransaction = false;
  function transaction(work) {
    if (failed) throw new Error('Mail cache is unavailable');
    if (inTransaction) return work();
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      failed = true;
      throw error;
    }
    inTransaction = true;
    try {
      const result = work();
      if (result?.then) throw new Error('Transactions must be synchronous');
      db.exec('COMMIT');
      return result;
    } catch (error) {
      failed = true;
      try { db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
      throw error;
    } finally {
      inTransaction = false;
    }
  }

  const token = text => createHmac('sha256', key).update(String(text)).digest('hex');

  function getNextGlobalGen() {
    try {
      const row = db.prepare("SELECT value FROM cache_meta WHERE key='gen_counter'").get();
      let current = row ? Number(row.value) : 0;
      if (!Number.isSafeInteger(current) || current < 0) current = 0;
      const next = current + 1;
      db.prepare("INSERT INTO cache_meta(key, value) VALUES('gen_counter', ?) ON CONFLICT(key) DO UPDATE SET value=?").run(String(next), String(next));
      return next;
    } catch {
      failed = true;
      return Date.now();
    }
  }

  function computeNamespaceKey(account) {
    const id = String(account?.id ?? '');
    const email = String(account?.email ?? '').trim().toLowerCase();
    const host = String(account?.host ?? account?.imap?.host ?? '').trim().toLowerCase();
    const provider = String(account?.provider ?? '').trim().toLowerCase();
    const revision = String(account?.revision ?? '');
    return token(JSON.stringify([id, email, host, provider, revision]));
  }

  function folderToken(accountKey, folderPath) {
    const norm = String(folderPath ?? '').toUpperCase() === 'INBOX' ? 'INBOX' : String(folderPath ?? '');
    return token(JSON.stringify(['folder', accountKey, norm]));
  }

  function messageKey(accountKey, folderPath, uidValidity, uid, fingerprint) {
    const norm = String(folderPath ?? '').toUpperCase() === 'INBOX' ? 'INBOX' : String(folderPath ?? '');
    return token(JSON.stringify(['msg', accountKey, norm, String(uidValidity ?? ''), Number(uid), String(fingerprint ?? '')]));
  }

  const encode = (kind, id, value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${kind}:${id}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  };

  const decode = (kind, id, data) => {
    if (!data) return null;
    try {
      const buf = Buffer.from(data);
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${kind}:${id}`));
      decipher.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
    } catch (error) {
      failed = true;
      throw error;
    }
  };

  function removeAccountData(namespaceKey) {
    db.prepare('DELETE FROM headers WHERE account_key = ?').run(namespaceKey);
    db.prepare('DELETE FROM bodies WHERE account_key = ?').run(namespaceKey);
  }

  // In-memory immutable snapshot store for list pagination
  const snapshotStore = new Map(); // snapshotId -> snapshot
  let totalSnapshotBytes = 0;
  const SNAPSHOT_TTL_MS = 15 * 60 * 1000; // 15 min TTL
  const MAX_SNAPSHOT_ENTRIES = 20;
  const MAX_SNAPSHOT_STORE_BYTES = 8 * 1024 * 1024; // 8 MiB

  function purgeExpiredSnapshots() {
    const currentTime = now();
    for (const [id, snap] of snapshotStore) {
      if (currentTime > snap.expiresAt) {
        totalSnapshotBytes -= snap.serializedBytes;
        snapshotStore.delete(id);
      }
    }
  }

  function evictOldestSnapshot() {
    const firstKey = snapshotStore.keys().next().value;
    if (firstKey) {
      const snap = snapshotStore.get(firstKey);
      totalSnapshotBytes -= snap.serializedBytes;
      snapshotStore.delete(firstKey);
    }
  }

  function invalidateSnapshots(predicate) {
    for (const [id, snap] of snapshotStore) {
      if (!predicate || predicate(snap)) {
        totalSnapshotBytes -= snap.serializedBytes;
        snapshotStore.delete(id);
      }
    }
  }

  // Active mutation tracking
  const activeMutations = new Map(); // token -> mutationRecord
  const activeMutationCounts = new Map(); // accountId -> count

  function isMutating(account) {
    if (!account?.id) return false;
    return (activeMutationCounts.get(account.id) ?? 0) > 0;
  }

  function beginMutation(account, change = {}) {
    if (failed || !account || !account.id) return null;
    try {
      return transaction(() => {
        const ns = namespace(account);
        if (!ns) return null;
        const nextGen = getNextGlobalGen();
        const currentCount = (activeMutationCounts.get(account.id) ?? 0) + 1;
        activeMutationCounts.set(account.id, currentCount);

        db.prepare('UPDATE namespaces SET generation = ?, dirty = 1, reconciled = 0, active_mutations = ?, updated_at = ? WHERE account_id = ?')
          .run(nextGen, currentCount, now(), account.id);

        const mutationToken = randomBytes(16).toString('hex');
        const record = {
          token: mutationToken, // Opaque in-process mutation ticket; not a credential.
          accountId: account.id,
          namespaceKey: ns.namespaceKey,
          generation: nextGen,
          change
        };
        activeMutations.set(mutationToken, record);
        invalidateSnapshots(s => s.accountIds.includes(account.id));
        return record;
      });
    } catch {
      failed = true;
      return null;
    }
  }

  function endMutation(mutationToken) {
    if (failed || !mutationToken || !mutationToken.token) return false;
    const record = activeMutations.get(mutationToken.token);
    if (!record) return false; // Idempotent: already ended or invalid
    activeMutations.delete(mutationToken.token);

    try {
      return transaction(() => {
        const current = db.prepare('SELECT namespace_key FROM namespaces WHERE account_id = ?').get(record.accountId);
        if (!current || current.namespace_key !== record.namespaceKey) {
          // Old account mutation ending after reconnect cannot dirty/decrement the new account namespace
          return false;
        }

        const currentCount = Math.max(0, (activeMutationCounts.get(record.accountId) ?? 1) - 1);
        if (currentCount === 0) activeMutationCounts.delete(record.accountId);
        else activeMutationCounts.set(record.accountId, currentCount);

        const finalGen = getNextGlobalGen();
        db.prepare('UPDATE namespaces SET generation = ?, dirty = 1, reconciled = 0, active_mutations = ?, updated_at = ? WHERE account_id = ?')
          .run(finalGen, currentCount, now(), record.accountId);
        invalidateSnapshots(s => s.accountIds.includes(record.accountId));
        return true;
      });
    } catch {
      failed = true;
      return false;
    }
  }

  function namespace(account) {
    if (failed || !account || !account.id) return null;
    try {
      const nsKey = computeNamespaceKey(account);
      const existing = db.prepare('SELECT * FROM namespaces WHERE account_id = ?').get(account.id);
      if (!existing) {
        const initialGen = getNextGlobalGen();
        db.prepare('INSERT INTO namespaces(account_id, namespace_key, generation, dirty, reconciled, active_mutations, updated_at) VALUES(?, ?, ?, 1, 0, 0, ?)')
          .run(account.id, nsKey, initialGen, now());
        return {
          accountId: account.id,
          namespaceKey: nsKey,
          generation: initialGen,
          dirty: true,
          reconciled: false,
          activeMutations: 0,
          providerTotal: null,
          coverageStatus: null,
          checkpoint: null
        };
      }
      if (existing.namespace_key !== nsKey) {
        // Identity / connection revision replacement: wipe older data and advance generation
        return transaction(() => {
          removeAccountData(existing.namespace_key);
          const nextGen = getNextGlobalGen();
          db.prepare('UPDATE namespaces SET namespace_key = ?, generation = ?, dirty = 1, reconciled = 0, active_mutations = 0, folder_uid_validity = null, provider_total = null, checkpoint = null, coverage_status = null, next_cursor = null, folder_metadata = null, updated_at = ? WHERE account_id = ?')
            .run(nsKey, nextGen, now(), account.id);
          for (const [t, rec] of activeMutations) {
            if (rec.accountId === account.id) activeMutations.delete(t);
          }
          activeMutationCounts.delete(account.id);
          invalidateSnapshots(s => s.accountIds.includes(account.id));
          return {
            accountId: account.id,
            namespaceKey: nsKey,
            generation: nextGen,
            dirty: true,
            reconciled: false,
            activeMutations: 0,
            providerTotal: null,
            coverageStatus: null,
            checkpoint: null
          };
        });
      }
      return {
        accountId: account.id,
        namespaceKey: existing.namespace_key,
        generation: existing.generation,
        dirty: existing.dirty === 1,
        reconciled: existing.reconciled === 1,
        activeMutations: existing.active_mutations,
        folderUidValidity: existing.folder_uid_validity,
        providerTotal: existing.provider_total != null ? Number(existing.provider_total) : null,
        checkpoint: existing.checkpoint,
        coverageStatus: existing.coverage_status,
        lastRefresh: existing.last_refresh
      };
    } catch {
      failed = true;
      return null;
    }
  }

  function beginSnapshot(account, pathName = 'INBOX') {
    if (failed || isMutating(account)) return null;
    const ns = namespace(account);
    if (!ns || ns.activeMutations > 0) return null;
    return {
      accountId: account.id,
      namespaceKey: ns.namespaceKey,
      generation: ns.generation,
      path: pathEqual(pathName, 'INBOX') ? 'INBOX' : pathName,
      createdAt: now()
    };
  }

  function isTicketCurrent(ticket) {
    if (failed || !ticket || isMutating({ id: ticket.accountId })) return false;
    try {
      const current = db.prepare('SELECT * FROM namespaces WHERE account_id = ?').get(ticket.accountId);
      if (!current) return false;
      return current.namespace_key === ticket.namespaceKey &&
             current.generation === ticket.generation &&
             current.active_mutations === 0;
    } catch {
      failed = true;
      return false;
    }
  }

  function trimHeaders(accountKey) {
    const countRow = db.prepare('SELECT count(*) AS n FROM headers WHERE account_key = ?').get(accountKey);
    const count = Number(countRow?.n ?? 0);
    if (count > settings.maxHeadersPerAccount) {
      const excess = count - settings.maxHeadersPerAccount;
      const oldest = db.prepare('SELECT message_key FROM headers WHERE account_key = ? ORDER BY time ASC, uid ASC LIMIT ?').all(accountKey, excess);
      const delHeader = db.prepare('DELETE FROM headers WHERE account_key = ? AND message_key = ?');
      const delBody = db.prepare('DELETE FROM bodies WHERE account_key = ? AND message_key = ?');
      for (const row of oldest) {
        delHeader.run(accountKey, row.message_key);
        delBody.run(accountKey, row.message_key);
      }
    }
  }

  function evictBodies(incomingBytes = 0) {
    let currentTotal = Number(db.prepare('SELECT coalesce(sum(size), 0) AS total FROM bodies').get()?.total ?? 0);
    while (currentTotal + incomingBytes > settings.maxBodyBytes) {
      const oldest = db.prepare('SELECT account_key, message_key, size FROM bodies ORDER BY cached_at ASC LIMIT 1').get();
      if (!oldest) break;
      db.prepare('DELETE FROM bodies WHERE account_key = ? AND message_key = ?').run(oldest.account_key, oldest.message_key);
      currentTotal -= Number(oldest.size);
    }
  }

  function commitHeaders(ticket, { messages = [], uidValidity, total, nextCursor, complete = false, folderMetadata, checkpoint } = {}) {
    if (failed || !ticket || isMutating({ id: ticket.accountId })) return false;

    // Validate reference identity, positive UID, accountId, path for every message
    for (const msg of messages) {
      const ref = msg?.reference;
      if (!ref) return false;
      if (ref.accountId !== ticket.accountId) return false;
      if (!pathEqual(ref.path, ticket.path)) return false;
      if (!validUid(ref.uid)) return false;
      if (typeof ref.fingerprint !== 'string' || !ref.fingerprint) return false;
      if (uidValidity && ref.uidValidity && String(ref.uidValidity) !== String(uidValidity)) return false;
    }

    // Precompute and validate ALL safe headers BEFORE transaction
    const precomputed = [];
    for (const msg of messages) {
      const ref = msg.reference;
      const msgUidVal = String(ref.uidValidity ?? uidValidity ?? '');
      const mKey = messageKey(ticket.namespaceKey, ticket.path, msgUidVal, ref.uid, ref.fingerprint);

      // Whitelist header fields so no private keys, raw source, or decrypted content persist
      const safeHeader = {
        id: typeof msg.id === 'string' ? msg.id : token(`hdr:${ticket.accountId}:${ref.uid}:${ref.fingerprint}`),
        accountId: ticket.accountId,
        account: typeof msg.account === 'string' ? msg.account.slice(0, 200) : '',
        folderPath: ticket.path,
        subject: typeof msg.subject === 'string' ? msg.subject.slice(0, 1000) : '',
        author: typeof msg.author === 'string' ? msg.author.slice(0, 1000) : '',
        to: typeof msg.to === 'string' ? msg.to.slice(0, 1000) : '',
        cc: typeof msg.cc === 'string' ? msg.cc.slice(0, 1000) : '',
        bcc: typeof msg.bcc === 'string' ? msg.bcc.slice(0, 1000) : '',
        replyTo: typeof msg.replyTo === 'string' ? msg.replyTo.slice(0, 1000) : '',
        messageId: typeof msg.messageId === 'string' ? msg.messageId.slice(0, 998) : '',
        inReplyTo: typeof msg.inReplyTo === 'string' ? msg.inReplyTo.slice(0, 998) : '',
        references: Array.isArray(msg.references) ? msg.references.slice(0, 100).map(r => String(r).slice(0, 998)) : [],
        threadId: typeof msg.threadId === 'string' ? msg.threadId.slice(0, 200) : '',
        date: msg.date ? new Date(msg.date).toISOString() : new Date(0).toISOString(),
        unread: Boolean(msg.unread),
        starred: Boolean(msg.starred),
        size: Number.isSafeInteger(msg.size) ? msg.size : null,
        hasAttachments: Boolean(msg.hasAttachments),
        attachments: Array.isArray(msg.attachments) ? msg.attachments.slice(0, 100).map(a => ({
          id: String(a.id ?? '').slice(0, 200),
          filename: String(a.filename ?? '').slice(0, 255),
          mimeType: String(a.mimeType ?? '').slice(0, 128),
          size: Number.isSafeInteger(a.size) && a.size >= 0 ? a.size : null
        })) : undefined,
        snippet: typeof msg.snippet === 'string' ? msg.snippet.slice(0, 500) : undefined,
        invoiceDocuments: Array.isArray(msg.invoiceDocuments) ? msg.invoiceDocuments.slice(0, 50) : undefined,
        providerLabels: Array.isArray(msg.providerLabels) ? msg.providerLabels.slice(0, 50) : undefined,
        reference: {
          accountId: ticket.accountId,
          path: ticket.path,
          uid: ref.uid,
          uidValidity: msgUidVal,
          fingerprint: String(ref.fingerprint)
        }
      };

      // Reject oversize headers (> 32 KiB) atomically: return false on any oversize entry, preserving previous snapshot/health
      const serializedHeader = JSON.stringify(safeHeader);
      if (Buffer.byteLength(serializedHeader, 'utf8') > 32768) {
        return false;
      }

      const time = msg.date ? (Date.parse(msg.date) || 0) : 0;
      const unread = msg.unread ? 1 : 0;
      const starred = msg.starred ? 1 : 0;
      const size = Number.isSafeInteger(msg.size) ? msg.size : null;

      precomputed.push({ mKey, safeHeader, uid: ref.uid, time, unread, starred, size });
    }

    try {
      return transaction(() => {
        const current = db.prepare('SELECT * FROM namespaces WHERE account_id = ?').get(ticket.accountId);
        if (!current || current.namespace_key !== ticket.namespaceKey ||
            current.generation !== ticket.generation || current.active_mutations > 0) {
          return false;
        }

        const fToken = folderToken(ticket.namespaceKey, ticket.path);

        // Invalidate folder if UIDVALIDITY changed
        if (current.folder_uid_validity && uidValidity && current.folder_uid_validity !== String(uidValidity)) {
          db.prepare('DELETE FROM headers WHERE account_key = ? AND folder_token = ?').run(ticket.namespaceKey, fToken);
          db.prepare('DELETE FROM bodies WHERE account_key = ? AND uid_validity != ?').run(ticket.namespaceKey, String(uidValidity));
        }

        // If starting fresh warming on new generation, remove any leftover older generation headers for this folder
        if (!complete && checkpoint === 'first50') {
          db.prepare('DELETE FROM headers WHERE account_key = ? AND folder_token = ? AND generation != ?')
            .run(ticket.namespaceKey, fToken, ticket.generation);
        }

        const upsertHeader = db.prepare(`
          INSERT INTO headers(account_key, message_key, folder_token, uid, time, unread, starred, size, generation, data)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_key, message_key) DO UPDATE SET
            time = excluded.time,
            unread = excluded.unread,
            starred = excluded.starred,
            size = excluded.size,
            generation = excluded.generation,
            data = excluded.data
        `);

        const incomingKeys = new Set();
        const effectiveUidVal = String(uidValidity ?? current.folder_uid_validity ?? '');
        const effectiveTotal = Number.isSafeInteger(total) ? total : (current.provider_total ?? messages.length);
        const encodedCursor = nextCursor ? encode('cursor', ticket.namespaceKey, nextCursor) : null;
        // Header commits lacking folderMetadata must preserve previous foldermetadata instead of nulling it
        const encodedMeta = folderMetadata !== undefined
          ? (folderMetadata ? encode('meta', ticket.namespaceKey, folderMetadata) : null)
          : current.folder_metadata;

        for (const item of precomputed) {
          incomingKeys.add(item.mKey);

          // Remove obsolete same-UID / different-fingerprint headers and bodies
          const obsoleteRows = db.prepare('SELECT message_key FROM headers WHERE account_key = ? AND folder_token = ? AND uid = ? AND message_key != ?')
            .all(ticket.namespaceKey, fToken, item.uid, item.mKey);
          for (const obs of obsoleteRows) {
            db.prepare('DELETE FROM headers WHERE account_key = ? AND message_key = ?').run(ticket.namespaceKey, obs.message_key);
            db.prepare('DELETE FROM bodies WHERE account_key = ? AND message_key = ?').run(ticket.namespaceKey, obs.message_key);
          }

          const encryptedData = encode('header', item.mKey, item.safeHeader);
          upsertHeader.run(ticket.namespaceKey, item.mKey, fToken, item.uid, item.time, item.unread, item.starred, item.size, ticket.generation, encryptedData);
        }

        if (!complete && checkpoint === 'first50') {
          // Replace currently served header window with only incoming verified first50 (delete other folder headers, retaining bodies)
          const existing = db.prepare('SELECT message_key FROM headers WHERE account_key = ? AND folder_token = ?').all(ticket.namespaceKey, fToken);
          const delHeader = db.prepare('DELETE FROM headers WHERE account_key = ? AND message_key = ?');
          for (const row of existing) {
            if (!incomingKeys.has(row.message_key)) {
              delHeader.run(ticket.namespaceKey, row.message_key);
            }
          }
          db.prepare('UPDATE namespaces SET dirty = 0, reconciled = 0, folder_uid_validity = ?, provider_total = ?, checkpoint = ?, coverage_status = ?, next_cursor = ?, folder_metadata = ?, updated_at = ? WHERE account_id = ?')
            .run(effectiveUidVal, effectiveTotal, checkpoint ?? 'first50', 'warming', encodedCursor, encodedMeta, now(), ticket.accountId);
        } else if (complete) {
          // Reconcile exact bounded membership for this folder
          const existing = db.prepare('SELECT message_key, uid FROM headers WHERE account_key = ? AND folder_token = ?').all(ticket.namespaceKey, fToken);
          const delHeader = db.prepare('DELETE FROM headers WHERE account_key = ? AND message_key = ?');
          for (const row of existing) {
            if (!incomingKeys.has(row.message_key)) {
              delHeader.run(ticket.namespaceKey, row.message_key);
            }
          }

          // Full commit reconstructs newest X and removes orphan bodies
          db.prepare('DELETE FROM bodies WHERE account_key = ? AND message_key NOT IN (SELECT message_key FROM headers WHERE account_key = ?)')
            .run(ticket.namespaceKey, ticket.namespaceKey);

          db.prepare('UPDATE namespaces SET dirty = 0, reconciled = 1, folder_uid_validity = ?, provider_total = ?, checkpoint = ?, coverage_status = ?, next_cursor = ?, folder_metadata = ?, last_refresh = ?, updated_at = ? WHERE account_id = ?')
            .run(effectiveUidVal, effectiveTotal, checkpoint ?? 'headers', 'complete', encodedCursor, encodedMeta, now(), now(), ticket.accountId);
        } else {
          // Partial coverage published during warming
          db.prepare('UPDATE namespaces SET folder_uid_validity = ?, provider_total = ?, checkpoint = ?, coverage_status = ?, next_cursor = ?, folder_metadata = ?, updated_at = ? WHERE account_id = ?')
            .run(effectiveUidVal, effectiveTotal, checkpoint ?? 'warming', 'warming', encodedCursor, encodedMeta, now(), ticket.accountId);
        }

        trimHeaders(ticket.namespaceKey);
        return true;
      });
    } catch {
      failed = true;
      return false;
    }
  }

  function putBody(ticket, reference, content) {
    if (failed || !ticket || !reference || !content || isMutating({ id: ticket.accountId })) return false;

    // Reject incomplete or truncated bodies
    if (content.complete !== true || content.truncated === true) return false;

    // Reject decrypted bodies and existing renderer shape content.encrypted?.decrypted
    if (content.decrypted === true || content.encrypted?.decrypted === true || (content.encrypted && content.encrypted.decrypted !== false)) {
      return false;
    }

    // Refuse HTML unless sanitized === true (reject if omitted or false)
    if (content.html && content.sanitized !== true) return false;

    // Renderer version check
    const version = content.rendererVersion || settings.rendererVersion;
    if (version !== settings.rendererVersion) return false;

    // Reference validation
    if (!validUid(reference.uid) || !reference.fingerprint || reference.accountId !== ticket.accountId) {
      return false;
    }
    const refUidVal = String(reference.uidValidity ?? '');

    // Never retain attachment bytes, raw source, or private keys
    const safeRecord = {
      text: typeof content.text === 'string' ? content.text : '',
      html: typeof content.html === 'string' ? content.html : '',
      headers: typeof content.headers === 'string' ? content.headers.slice(0, 32768) : '',
      from: content.from,
      to: content.to,
      cc: content.cc,
      bcc: content.bcc,
      replyTo: content.replyTo,
      subject: content.subject,
      messageId: content.messageId,
      attachments: (content.attachments || []).map(a => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        contentId: a.contentId ?? null
      })),
      inlineParts: Array.isArray(content.inlineParts) ? content.inlineParts.slice(0, 100).map(p => ({
        id: String(p.id ?? '').slice(0, 200),
        contentId: String(p.contentId ?? '').slice(0, 200),
        mimeType: String(p.mimeType ?? '').slice(0, 128),
        size: Number.isSafeInteger(p.size) && p.size >= 0 ? p.size : null
      })) : [],
      encrypted: content.encrypted ? { type: content.encrypted.type, decrypted: false } : null,
      complete: true,
      sanitized: Boolean(content.sanitized)
    };

    // Entire admitted JSON payload counted against budget
    const payloadBuffer = Buffer.from(JSON.stringify(safeRecord), 'utf8');
    const totalSize = payloadBuffer.byteLength;

    // Oversize incoming body > total budget or per-message limit must NOT be stored after evicting everything
    if (totalSize > settings.maxMessageBodyBytes || totalSize > settings.maxBodyBytes) return false;

    try {
      return transaction(() => {
        const current = db.prepare('SELECT * FROM namespaces WHERE account_id = ?').get(ticket.accountId);
        if (!current || current.namespace_key !== ticket.namespaceKey ||
            current.generation !== ticket.generation || current.active_mutations > 0) {
          return false;
        }

        // putBody cannot succeed for wrong currentuidvalidity
        if (current.folder_uid_validity && refUidVal && current.folder_uid_validity !== refUidVal) {
          return false;
        }

        const mKey = messageKey(ticket.namespaceKey, reference.path || ticket.path, refUidVal, reference.uid, reference.fingerprint);

        // Verify corresponding header exists in cache matching uid and fingerprint
        const headerExists = db.prepare('SELECT 1 FROM headers WHERE account_key = ? AND message_key = ?').get(ticket.namespaceKey, mKey);
        if (!headerExists) return false;

        // Transactionally delete replaced row before full budget eviction
        db.prepare('DELETE FROM bodies WHERE account_key = ? AND message_key = ?').run(ticket.namespaceKey, mKey);
        evictBodies(totalSize);

        const encryptedData = encode('body', mKey, safeRecord);
        db.prepare(`
          INSERT INTO bodies(account_key, message_key, uid, uid_validity, size, cached_at, renderer_version, generation, data)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(ticket.namespaceKey, mKey, reference.uid, refUidVal, totalSize, now(), settings.rendererVersion, ticket.generation, encryptedData);

        return true;
      });
    } catch {
      failed = true;
      return false;
    }
  }

  function getBody(account, reference) {
    if (failed || !account || !reference || isMutating(account)) return null;
    const ns = namespace(account);
    if (!ns || ns.dirty) return null;

    if (ns.folderUidValidity && reference.uidValidity && ns.folderUidValidity !== String(reference.uidValidity)) {
      return null;
    }

    try {
      const refUidVal = String(reference.uidValidity ?? ns.folderUidValidity ?? '');
      const mKey = messageKey(ns.namespaceKey, reference.path, refUidVal, reference.uid, reference.fingerprint);

      // Require matching current header row, so no removed mail's orphan body can be read
      const headerExists = db.prepare('SELECT 1 FROM headers WHERE account_key = ? AND message_key = ?').get(ns.namespaceKey, mKey);
      if (!headerExists) return null;

      const row = db.prepare('SELECT * FROM bodies WHERE account_key = ? AND message_key = ?').get(ns.namespaceKey, mKey);
      if (!row) return null;

      if (row.renderer_version !== settings.rendererVersion) {
        db.prepare('DELETE FROM bodies WHERE account_key = ? AND message_key = ?').run(ns.namespaceKey, mKey);
        return null;
      }

      if (row.uid_validity && refUidVal && row.uid_validity !== refUidVal) {
        return null;
      }

      return decode('body', mKey, row.data);
    } catch {
      failed = true;
      return null;
    }
  }

  function hasBody(account, reference) {
    if (failed || !account || !reference || isMutating(account)) return false;
    const ns = namespace(account);
    if (!ns || ns.dirty) return false;

    if (ns.folderUidValidity && reference.uidValidity && ns.folderUidValidity !== String(reference.uidValidity)) {
      return false;
    }

    try {
      const refUidVal = String(reference.uidValidity ?? ns.folderUidValidity ?? '');
      const mKey = messageKey(ns.namespaceKey, reference.path, refUidVal, reference.uid, reference.fingerprint);

      // Require matching current header row
      const headerExists = db.prepare('SELECT 1 FROM headers WHERE account_key = ? AND message_key = ?').get(ns.namespaceKey, mKey);
      if (!headerExists) return false;

      const row = db.prepare('SELECT renderer_version FROM bodies WHERE account_key = ? AND message_key = ?').get(ns.namespaceKey, mKey);
      if (!row) return false;
      if (row.renderer_version !== settings.rendererVersion) {
        db.prepare('DELETE FROM bodies WHERE account_key = ? AND message_key = ?').run(ns.namespaceKey, mKey);
        return false;
      }
      return true;
    } catch {
      failed = true;
      return false;
    }
  }

  function list(accounts, { folder = 'inbox', limit = 50, cursor = null, live = false } = {}) {
    if (failed) return null;
    if (live) return null;

    // Validate cursor before early null (even when no namespaces currently readable)
    if (cursor) {
      purgeExpiredSnapshots();
      const staleResult = {
        messages: [],
        nextCursor: null,
        total: null,
        totalComplete: false,
        requiresRefresh: true,
        providerFallback: true,
        coverage: { status: 'partial', cached: 0, limited: true },
        errors: []
      };

      if (!cursor || typeof cursor !== 'object' || !cursor.snapshotId) {
        return staleResult;
      }

      const snap = snapshotStore.get(cursor.snapshotId);
      if (!snap || now() > snap.expiresAt) {
        if (snap) {
          totalSnapshotBytes -= snap.serializedBytes;
          snapshotStore.delete(cursor.snapshotId);
        }
        return staleResult;
      }

      // Check requested folder exact match
      if (String(folder).toUpperCase() !== String(snap.folder).toUpperCase()) {
        return staleResult;
      }

      // Check requested accounts exact match
      const reqIds = Array.isArray(accounts) ? accounts.map(a => a.id).sort() : [];
      if (reqIds.length !== snap.requestedAccountIds.length ||
          reqIds.some((id, i) => id !== snap.requestedAccountIds[i])) {
        return staleResult;
      }

      // Check requested accounts against snapshot bounds
      if (Array.isArray(accounts)) {
        for (const b of snap.accountBounds) {
          const acc = accounts.find(a => a.id === b.accountId);
          if (!acc || isMutating(acc)) return staleResult;
          try {
            const current = db.prepare('SELECT namespace_key, generation, active_mutations FROM namespaces WHERE account_id = ?').get(b.accountId);
            if (!current || current.namespace_key !== b.namespaceKey || current.generation !== b.generation || current.active_mutations > 0) {
              return staleResult;
            }
          } catch {
            return staleResult;
          }
        }
      }

      const offset = Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 ? cursor.offset : 0;
      const pageMessages = snap.messages.slice(offset, offset + limit).map(m => structuredClone(m));
      const hasMore = (offset + limit) < snap.messages.length;
      const nextCursor = hasMore ? { snapshotId: snap.id, offset: offset + limit } : null;
      const providerFallback = (!hasMore && snap.totalProvider > snap.messages.length) ? true : undefined;

      return {
        messages: pageMessages,
        total: snap.effectiveTotal,
        totalComplete: snap.allComplete,
        nextCursor,
        providerFallback,
        coverage: {
          status: snap.coverageStatus,
          cached: pageMessages.length,
          total: snap.effectiveTotal
        },
        errors: snap.missingAccounts.map(id => ({ accountId: id, code: 'unreconciled' }))
      };
    }

    if (!Array.isArray(accounts) || accounts.length === 0) return null;
    if (String(folder).toLowerCase() !== 'inbox') return null;

    try {
      const usableNs = [];
      const missingAccounts = [];

      for (const account of accounts) {
        if (isMutating(account)) {
          missingAccounts.push(account.id);
          continue;
        }
        const ns = namespace(account);
        // Usable if reconciled or warming with committed headers in current generation
        if (!ns || ns.dirty || (!ns.reconciled && ns.coverageStatus !== 'warming' && ns.coverageStatus !== 'complete')) {
          missingAccounts.push(account.id);
        } else {
          usableNs.push(ns);
        }
      }

      if (usableNs.length === 0) {
        return null;
      }

      const folderClauses = [];
      const args = [];
      let totalProvider = 0;

      for (const ns of usableNs) {
        const fTok = folderToken(ns.namespaceKey, 'INBOX');
        folderClauses.push('(account_key = ? AND folder_token = ?)');
        args.push(ns.namespaceKey, fTok);
        if (ns.providerTotal != null) totalProvider += ns.providerTotal;
      }

      const whereBase = folderClauses.join(' OR ');
      const totalRow = db.prepare(`SELECT count(*) AS n FROM headers WHERE ${whereBase}`).get(...args);
      const totalCached = Number(totalRow?.n ?? 0);

      const stmt = db.prepare(`SELECT * FROM headers WHERE ${whereBase} ORDER BY time DESC, uid DESC`);
      const allDecoded = [];
      let approxBytes = 0;

      for (const row of stmt.iterate(...args)) {
        const decoded = decode('header', row.message_key, row.data);
        decoded.unread = row.unread === 1;
        decoded.starred = row.starred === 1;
        approxBytes += (row.data ? row.data.byteLength : 0) + 256;
        if (approxBytes > MAX_SNAPSHOT_STORE_BYTES) {
          return null; // Bounded iterator and incremental byte accounting to stop/fallback before unbounded buffers
        }
        allDecoded.push(decoded);
      }

      // Fixed date desc then accountId lexical/path lexical/UID desc
      allDecoded.sort((a, b) => {
        const timeA = a.date ? (Date.parse(a.date) || 0) : 0;
        const timeB = b.date ? (Date.parse(b.date) || 0) : 0;
        if (timeB !== timeA) return timeB - timeA;
        const acctCmp = String(a.accountId ?? '').localeCompare(String(b.accountId ?? ''));
        if (acctCmp !== 0) return acctCmp;
        const pathA = String(a.folderPath ?? '');
        const pathB = String(b.folderPath ?? '');
        const pathCmp = pathA.localeCompare(pathB);
        if (pathCmp !== 0) return pathCmp;
        const uidA = Number(a.reference?.uid ?? 0);
        const uidB = Number(b.reference?.uid ?? 0);
        return uidB - uidA;
      });

      const serialized = JSON.stringify(allDecoded);
      const serializedBytes = Buffer.byteLength(serialized, 'utf8');
      if (serializedBytes > MAX_SNAPSHOT_STORE_BYTES) {
        return null; // Oversize snapshot: fallback to provider
      }

      purgeExpiredSnapshots();
      while (snapshotStore.size >= MAX_SNAPSHOT_ENTRIES || (totalSnapshotBytes + serializedBytes > MAX_SNAPSHOT_STORE_BYTES && snapshotStore.size > 0)) {
        evictOldestSnapshot();
      }

      const effectiveTotal = Math.max(totalCached, totalProvider);
      const allComplete = missingAccounts.length === 0 && usableNs.every(n => n.reconciled && n.coverageStatus === 'complete');
      const coverageStatus = (missingAccounts.length > 0 || usableNs.some(n => n.coverageStatus === 'warming')) ? 'warming' : 'complete';

      const requestedAccountBounds = accounts.map(a => {
        const ns = usableNs.find(n => n.accountId === a.id);
        if (ns) return { accountId: a.id, namespaceKey: ns.namespaceKey, generation: ns.generation };
        const raw = db.prepare('SELECT namespace_key, generation FROM namespaces WHERE account_id = ?').get(a.id);
        return {
          accountId: a.id,
          namespaceKey: raw?.namespace_key ?? '',
          generation: raw?.generation ?? 0
        };
      });

      const snapId = randomBytes(16).toString('hex');
      const snapshot = {
        id: snapId,
        folder: 'INBOX',
        requestedAccountIds: accounts.map(a => a.id).sort(),
        accountBounds: requestedAccountBounds,
        accountIds: usableNs.map(n => n.accountId),
        messages: allDecoded,
        totalProvider,
        effectiveTotal,
        allComplete,
        coverageStatus,
        missingAccounts,
        serializedBytes,
        createdAt: now(),
        expiresAt: now() + SNAPSHOT_TTL_MS
      };
      snapshotStore.set(snapId, snapshot);
      totalSnapshotBytes += serializedBytes;

      const pageMessages = allDecoded.slice(0, limit).map(m => structuredClone(m));
      const hasMore = allDecoded.length > limit;
      const nextCursor = hasMore ? { snapshotId: snapId, offset: limit } : null;
      const providerFallback = (!hasMore && totalProvider > allDecoded.length) ? true : undefined;

      return {
        messages: pageMessages,
        total: effectiveTotal,
        totalComplete: allComplete,
        nextCursor,
        providerFallback,
        coverage: {
          status: coverageStatus,
          cached: pageMessages.length,
          total: effectiveTotal
        },
        errors: missingAccounts.map(id => ({ accountId: id, code: 'unreconciled' }))
      };
    } catch {
      failed = true;
      return null;
    }
  }

  function getHeader(account, reference) {
    if (failed || !account || !reference || isMutating(account)) return null;
    const ns = namespace(account);
    if (!ns || ns.dirty) return null;
    try {
      const refUidVal = String(reference.uidValidity ?? ns.folderUidValidity ?? '');
      const mKey = messageKey(ns.namespaceKey, reference.path, refUidVal, reference.uid, reference.fingerprint);
      const row = db.prepare('SELECT * FROM headers WHERE account_key = ? AND message_key = ?').get(ns.namespaceKey, mKey);
      if (!row) return null;
      const decoded = decode('header', mKey, row.data);
      decoded.unread = row.unread === 1;
      decoded.starred = row.starred === 1;
      return decoded;
    } catch {
      failed = true;
      return null;
    }
  }

  function putFolders(ticket, result) {
    if (failed || !ticket || isMutating({ id: ticket.accountId })) return false;
    if (!isTicketCurrent(ticket)) return false;
    if (!result || typeof result !== 'object' || !Array.isArray(result.folders)) return false;
    // Preserve previous metadata if there are failed account errors for this ticket
    if (Array.isArray(result.errors) && result.errors.some(e => e && e.accountId === ticket.accountId)) return false;

    // Filter by f.accountIds including ticket.accountId, bound 1000 provider folders
    const safeFolders = [];
    let providerCount = 0;
    for (const f of result.folders) {
      if (!f || !Array.isArray(f.accountIds) || !f.accountIds.includes(ticket.accountId)) continue;
      const isProvider = f.type === 'provider';
      if (isProvider) {
        if (providerCount >= 1000) continue;
        providerCount++;
      }
      const safeCounts = Array.isArray(f.counts)
        ? f.counts.filter(c => c && c.accountId === ticket.accountId).map(c => ({
            accountId: ticket.accountId,
            total: Number.isSafeInteger(c.total) && c.total >= 0 && c.total <= 0xffffffff ? c.total : null
          }))
        : [{ accountId: ticket.accountId, total: null }];

      safeFolders.push({
        id: String(f.id ?? '').slice(0, 200),
        label: String(f.label ?? '').slice(0, 200),
        type: isProvider ? 'provider' : 'standard',
        accountIds: [ticket.accountId],
        counts: safeCounts.length > 0 ? safeCounts : [{ accountId: ticket.accountId, total: null }]
      });
    }

    const metaPayload = { folders: safeFolders, updatedAt: now() };
    const serializedMeta = JSON.stringify(metaPayload);
    // Atomic reject oversize (> 1 MiB)
    if (Buffer.byteLength(serializedMeta, 'utf8') > 1024 * 1024) {
      return false;
    }

    try {
      return transaction(() => {
        const current = db.prepare('SELECT * FROM namespaces WHERE account_id = ?').get(ticket.accountId);
        if (!current || current.namespace_key !== ticket.namespaceKey ||
            current.generation !== ticket.generation || current.active_mutations > 0) {
          return false;
        }
        const encodedMeta = encode('meta', ticket.namespaceKey, metaPayload);
        db.prepare('UPDATE namespaces SET folder_metadata = ?, updated_at = ? WHERE account_id = ?')
          .run(encodedMeta, now(), ticket.accountId);
        return true;
      });
    } catch {
      failed = true;
      return false;
    }
  }

  function getFolders(accounts) {
    if (failed || !Array.isArray(accounts) || accounts.length === 0) return null;
    try {
      const availableMetas = new Map(); // accountId -> safeFolders
      const missingAccounts = [];

      for (const account of accounts) {
        if (!account?.id || isMutating(account)) {
          missingAccounts.push(account.id);
          continue;
        }
        const ns = namespace(account);
        if (!ns || ns.dirty || (!ns.reconciled && ns.coverageStatus !== 'warming' && ns.coverageStatus !== 'complete')) {
          missingAccounts.push(account.id);
          continue;
        }
        const row = db.prepare('SELECT folder_metadata FROM namespaces WHERE account_id = ?').get(account.id);
        if (!row?.folder_metadata) {
          missingAccounts.push(account.id);
          continue;
        }
        try {
          const decoded = decode('meta', ns.namespaceKey, row.folder_metadata);
          if (decoded && Array.isArray(decoded.folders)) {
            availableMetas.set(account.id, decoded.folders);
          } else {
            missingAccounts.push(account.id);
          }
        } catch {
          missingAccounts.push(account.id);
        }
      }

      // Return null if all cold
      if (availableMetas.size === 0) return null;

      const standardDefs = [
        ['inbox', 'Inbox'],
        ['unread', 'Unread'],
        ['starred', 'Starred'],
        ['sent', 'Sent'],
        ['drafts', 'Drafts'],
        ['archive', 'Archive'],
        ['junk', 'Junk'],
        ['trash', 'Trash'],
        ['all', 'All mail']
      ];

      const standardFolders = standardDefs.map(([id, label]) => {
        const entry = { id, label, type: 'standard', accountIds: [], counts: [] };
        for (const account of accounts) {
          if (availableMetas.has(account.id)) {
            const acctFolders = availableMetas.get(account.id);
            const found = acctFolders.find(f => f.id === id);
            if (found) {
              entry.accountIds.push(account.id);
              const countVal = found.counts?.find(c => c.accountId === account.id)?.total ?? null;
              const validTotal = Number.isSafeInteger(countVal) && countVal >= 0 && countVal <= 0xffffffff ? countVal : null;
              entry.counts.push({ accountId: account.id, total: validTotal });
            } else {
              entry.counts.push({ accountId: account.id, total: null });
            }
          } else {
            entry.counts.push({ accountId: account.id, total: null });
          }
        }
        entry.accountIds.sort();
        entry.counts.sort((a, b) => a.accountId.localeCompare(b.accountId));
        return entry;
      });

      const providerFolders = [];
      for (const [acctId, fList] of availableMetas) {
        for (const f of fList) {
          if (f.type === 'provider') {
            const countVal = f.counts?.find(c => c.accountId === acctId)?.total ?? null;
            const validTotal = Number.isSafeInteger(countVal) && countVal >= 0 && countVal <= 0xffffffff ? countVal : null;
            providerFolders.push({
              id: f.id,
              label: f.label,
              type: 'provider',
              accountIds: [acctId],
              counts: [{ accountId: acctId, total: validTotal }]
            });
          }
        }
      }

      providerFolders.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
      const mergedFolders = [...standardFolders, ...providerFolders];

      const errors = missingAccounts.map(id => ({ accountId: id, code: 'unreconciled' }));
      errors.sort((a, b) => a.accountId.localeCompare(b.accountId));

      return { folders: mergedFolders, errors };
    } catch {
      failed = true;
      return null;
    }
  }

  function invalidate(account, { references, paths, reason, pending = false } = {}) {
    try {
      return transaction(() => {
        const ns = namespace(account);
        if (!ns) throw new Error('Account namespace unavailable');
        const nextGen = getNextGlobalGen();
        const dirtyVal = 1;
        const reconciledVal = 0;

        db.prepare('UPDATE namespaces SET generation = ?, dirty = ?, reconciled = ?, updated_at = ? WHERE account_id = ?')
          .run(nextGen, dirtyVal, reconciledVal, now(), account.id);

        if (references && Array.isArray(references) && references.length > 0) {
          const delHeader = db.prepare('DELETE FROM headers WHERE account_key = ? AND message_key = ?');
          const delBody = db.prepare('DELETE FROM bodies WHERE account_key = ? AND message_key = ?');
          for (const ref of references) {
            const mKey = messageKey(ns.namespaceKey, ref.path, ref.uidValidity, ref.uid, ref.fingerprint);
            delHeader.run(ns.namespaceKey, mKey);
            delBody.run(ns.namespaceKey, mKey);
          }
        }

        if (paths && Array.isArray(paths) && paths.length > 0) {
          const delByFolder = db.prepare('DELETE FROM headers WHERE account_key = ? AND folder_token = ?');
          for (const p of paths) {
            const fTok = folderToken(ns.namespaceKey, p);
            delByFolder.run(ns.namespaceKey, fTok);
          }
        }

        invalidateSnapshots(s => s.accountIds.includes(account.id));

        return {
          ticket: {
            accountId: account.id,
            namespaceKey: ns.namespaceKey,
            generation: nextGen
          },
          generation: nextGen,
          marker: `gen:${nextGen}`
        };
      });
    } catch (error) {
      failed = true;
      throw error;
    }
  }

  function updateFlags(account, reference, { unread, starred, providerLabels } = {}) {
    if (failed || !account || !reference || isMutating(account)) return false;
    try {
      return transaction(() => {
        const ns = namespace(account);
        if (!ns) return false;
        const refUidVal = String(reference.uidValidity ?? ns.folderUidValidity ?? '');
        const mKey = messageKey(ns.namespaceKey, reference.path, refUidVal, reference.uid, reference.fingerprint);
        const row = db.prepare('SELECT * FROM headers WHERE account_key = ? AND message_key = ?').get(ns.namespaceKey, mKey);
        if (!row) return false;

        const updates = [];
        const args = [];
        let decoded = null;

        if (unread !== undefined) {
          updates.push('unread = ?');
          args.push(unread ? 1 : 0);
        }
        if (starred !== undefined) {
          updates.push('starred = ?');
          args.push(starred ? 1 : 0);
        }
        if (providerLabels !== undefined || unread !== undefined || starred !== undefined) {
          decoded = decode('header', mKey, row.data);
          if (unread !== undefined) decoded.unread = Boolean(unread);
          if (starred !== undefined) decoded.starred = Boolean(starred);
          if (providerLabels !== undefined) decoded.providerLabels = providerLabels;
          updates.push('data = ?');
          args.push(encode('header', mKey, decoded));
        }

        args.push(ns.namespaceKey, mKey);
        db.prepare(`UPDATE headers SET ${updates.join(', ')} WHERE account_key = ? AND message_key = ?`).run(...args);
        return true;
      });
    } catch {
      failed = true;
      return false;
    }
  }

  function status(filterAccounts = null) {
    if (failed) {
      return {
        healthy: false,
        headerCount: 0,
        bodyCount: 0,
        bodyBytes: 0,
        maxHeadersPerAccount: settings.maxHeadersPerAccount,
        maxBodyBytes: settings.maxBodyBytes,
        maxMessageBodyBytes: settings.maxMessageBodyBytes,
        rendererVersion: settings.rendererVersion,
        accounts: []
      };
    }
    try {
      const headerRow = db.prepare('SELECT count(*) AS n FROM headers').get();
      const bodyRow = db.prepare('SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes FROM bodies').get();
      const nsRows = db.prepare('SELECT * FROM namespaces').all();

      const accountsList = [];
      for (const ns of nsRows) {
        if (filterAccounts && !filterAccounts.some(a => a.id === ns.account_id)) continue;
        const acctHeaders = db.prepare('SELECT count(*) AS n FROM headers WHERE account_key = ?').get(ns.namespace_key)?.n ?? 0;
        const acctBodies = db.prepare('SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes FROM bodies WHERE account_key = ?').get(ns.namespace_key);
        accountsList.push({
          accountId: ns.account_id,
          namespaceKey: ns.namespace_key,
          generation: ns.generation,
          dirty: ns.dirty === 1,
          reconciled: ns.reconciled === 1,
          activeMutations: ns.active_mutations,
          folderUidValidity: ns.folder_uid_validity,
          headerCount: Number(acctHeaders),
          bodyCount: Number(acctBodies?.count ?? 0),
          bodyBytes: Number(acctBodies?.bytes ?? 0),
          lastRefresh: ns.last_refresh,
          coverageStatus: ns.coverage_status,
          folderMetadata: ns.folder_metadata ? decode('meta', ns.namespace_key, ns.folder_metadata) : null
        });
      }

      return {
        healthy: true,
        headerCount: Number(headerRow?.n ?? 0),
        bodyCount: Number(bodyRow?.count ?? 0),
        bodyBytes: Number(bodyRow?.bytes ?? 0),
        maxHeadersPerAccount: settings.maxHeadersPerAccount,
        maxBodyBytes: settings.maxBodyBytes,
        maxMessageBodyBytes: settings.maxMessageBodyBytes,
        rendererVersion: settings.rendererVersion,
        accounts: accountsList
      };
    } catch {
      return {
        healthy: false,
        headerCount: 0,
        bodyCount: 0,
        bodyBytes: 0,
        maxHeadersPerAccount: settings.maxHeadersPerAccount,
        maxBodyBytes: settings.maxBodyBytes,
        maxMessageBodyBytes: settings.maxMessageBodyBytes,
        rendererVersion: settings.rendererVersion,
        accounts: []
      };
    }
  }

  function clear() {
    try {
      transaction(() => {
        db.prepare('DELETE FROM bodies').run();
        db.prepare('DELETE FROM headers').run();
        db.prepare("DELETE FROM cache_meta WHERE key != 'gen_counter'").run();

        const activeAccountIds = Array.from(activeMutationCounts.keys()).filter(id => (activeMutationCounts.get(id) ?? 0) > 0);
        if (activeAccountIds.length === 0) {
          db.prepare('DELETE FROM namespaces').run();
        } else {
          const placeholders = activeAccountIds.map(() => '?').join(', ');
          db.prepare(`DELETE FROM namespaces WHERE account_id NOT IN (${placeholders})`).run(...activeAccountIds);

          for (const accountId of activeAccountIds) {
            const count = activeMutationCounts.get(accountId);
            const nextGen = getNextGlobalGen();
            const existing = db.prepare('SELECT namespace_key FROM namespaces WHERE account_id = ?').get(accountId);
            if (existing) {
              db.prepare('UPDATE namespaces SET generation = ?, dirty = 1, reconciled = 0, active_mutations = ?, folder_uid_validity = null, provider_total = null, checkpoint = null, coverage_status = null, next_cursor = null, folder_metadata = null, updated_at = ? WHERE account_id = ?')
                .run(nextGen, count, now(), accountId);
            } else {
              let nsKey = null;
              for (const rec of activeMutations.values()) {
                if (rec.accountId === accountId) {
                  nsKey = rec.namespaceKey;
                  break;
                }
              }
              if (nsKey) {
                db.prepare('INSERT INTO namespaces(account_id, namespace_key, generation, dirty, reconciled, active_mutations, updated_at) VALUES(?, ?, ?, 1, 0, ?, ?)')
                  .run(accountId, nsKey, nextGen, count, now());
              }
            }
          }
        }
        // Advance generation counter so older tickets cannot revive
        getNextGlobalGen();
      });

      const activeAccountIds = new Set(Array.from(activeMutationCounts.keys()).filter(id => (activeMutationCounts.get(id) ?? 0) > 0));
      for (const [t, rec] of activeMutations) {
        if (!activeAccountIds.has(rec.accountId)) {
          activeMutations.delete(t);
        }
      }
      for (const [id, cnt] of activeMutationCounts) {
        if (cnt <= 0) activeMutationCounts.delete(id);
      }
      invalidateSnapshots();
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
    } catch {
      failed = true;
    }
  }

  function removeAccount(id) {
    try {
      transaction(() => {
        const existing = db.prepare('SELECT namespace_key FROM namespaces WHERE account_id = ?').get(id);
        if (existing) {
          removeAccountData(existing.namespace_key);
          db.prepare('DELETE FROM namespaces WHERE account_id = ?').run(id);
        }
        getNextGlobalGen();
      });
      for (const [t, rec] of activeMutations) {
        if (rec.accountId === id) activeMutations.delete(t);
      }
      activeMutationCounts.delete(id);
      invalidateSnapshots(s => s.accountIds.includes(id));
    } catch {
      failed = true;
    }
  }

  function updateSettings(newSettings = {}) {
    if (newSettings.maxHeadersPerAccount !== undefined) {
      const val = Number(newSettings.maxHeadersPerAccount);
      if (Number.isSafeInteger(val) && !Number.isNaN(val) && val >= 100 && val <= 5000) {
        settings.maxHeadersPerAccount = val;
        try {
          const nsRows = db.prepare('SELECT namespace_key FROM namespaces').all();
          for (const ns of nsRows) trimHeaders(ns.namespace_key);
        } catch {
          failed = true;
        }
      }
    }
    if (newSettings.maxBodyBytes !== undefined) {
      const val = Number(newSettings.maxBodyBytes);
      if (Number.isFinite(val) && !Number.isNaN(val) && val > 0) {
        settings.maxBodyBytes = val;
        try { evictBodies(0); } catch { failed = true; }
      }
    }
    if (newSettings.maxMessageBodyBytes !== undefined) {
      const val = Number(newSettings.maxMessageBodyBytes);
      if (Number.isFinite(val) && !Number.isNaN(val) && val > 0) {
        settings.maxMessageBodyBytes = val;
      }
    }
    if (newSettings.rendererVersion !== undefined) {
      settings.rendererVersion = String(newSettings.rendererVersion);
    }
  }

  function close() {
    if (!failed) {
      try {
        const dirtyRow = db.prepare('SELECT count(*) AS n FROM namespaces WHERE dirty = 1 OR active_mutations > 0').get();
        const hasDirty = Number(dirtyRow?.n ?? 0) > 0 || activeMutations.size > 0;
        if (!hasDirty) {
          db.prepare("INSERT INTO cache_meta(key, value) VALUES('clean_shutdown', '1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
        } else {
          db.prepare("INSERT INTO cache_meta(key, value) VALUES('clean_shutdown', '0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
        }
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        // Best effort
      }
    }
    try { db.close(); } catch {}
    key.fill(0);
    snapshotStore.clear();
    totalSnapshotBytes = 0;
  }

  return {
    namespace,
    beginSnapshot,
    beginMutation,
    endMutation,
    isMutating,
    isTicketCurrent,
    commitHeaders,
    putBody,
    getBody,
    hasBody,
    getHeader,
    putFolders,
    getFolders,
    list,
    invalidate,
    updateFlags,
    status,
    clear,
    removeAccount,
    updateSettings,
    healthy: () => !failed,
    close
  };
}

function createUnavailableCache() {
  return {
    namespace: () => null,
    beginSnapshot: () => null,
    beginMutation: () => null,
    endMutation: () => false,
    isMutating: () => false,
    isTicketCurrent: () => false,
    commitHeaders: () => false,
    putBody: () => false,
    getBody: () => null,
    hasBody: () => false,
    getHeader: () => null,
    putFolders: () => false,
    getFolders: () => null,
    list: () => null,
    invalidate: () => { throw new Error('Mail cache is unavailable'); },
    updateFlags: () => false,
    status: () => ({
      healthy: false,
      headerCount: 0,
      bodyCount: 0,
      bodyBytes: 0,
      maxHeadersPerAccount: DEFAULT_MAX_HEADERS_PER_ACCOUNT,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      maxMessageBodyBytes: DEFAULT_MAX_MESSAGE_BODY_BYTES,
      rendererVersion: DEFAULT_RENDERER_VERSION,
      accounts: []
    }),
    clear: () => {},
    removeAccount: () => {},
    updateSettings: () => {},
    healthy: () => false,
    close: () => {}
  };
}
