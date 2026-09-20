import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';

const MAX_RECORD_BYTES = 256 * 1024;
const SCHEMA_VERSION = 1;
const KEY_CHECK = { purpose: 'MailHarbor notifications', version: SCHEMA_VERSION };
const failure = () => new Error('Notification store requires recovery');

function text(value, label, limit, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || value.length > limit || value.includes('\0')) {
    throw new TypeError(`Invalid notification ${label}`);
  }
  return value;
}

function number(value, label) {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new TypeError(`Invalid notification ${label}`);
  return value;
}

/** Bounded notification content is encrypted; callers must use opaque IDs/owners in metadata. */
export async function createNotificationStore(directory, { now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('Invalid notification clock');
  if (directory != null && (typeof directory !== 'string' || !path.isAbsolute(directory))) throw new TypeError('Invalid notification directory');
  const persistent = directory != null;
  if (persistent) await mkdir(directory, { recursive: true, mode: 0o700 });
  const master = persistent ? await readFile(path.join(directory, 'accounts.key')) : randomBytes(32);
  if (master.length !== 32) { master.fill(0); throw failure(); }
  const key = createHmac('sha256', master).update('MailHarbor notification encryption v1').digest();
  const lookupKey = createHmac('sha256', master).update('MailHarbor notification lookup v1').digest();
  master.fill(0);
  const filename = persistent ? path.join(directory, 'notification-state.sqlite') : ':memory:';
  let fresh = !persistent, db, failed = false, closed = false, transactionDepth = 0, savepointId = 0;
  const ensureHealthy = () => { if (failed || closed) throw failure(); };
  const encode = (kind, id, value) => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw new TypeError('Invalid notification record size');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([kind, id])));
    const encrypted = Buffer.concat([cipher.update(serialized), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  };
  const decode = (kind, id, encrypted) => {
    try {
      const bytes = Buffer.from(encrypted);
      if (bytes.length < 28 || bytes.length > MAX_RECORD_BYTES + 28) throw failure();
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(JSON.stringify([kind, id])));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    } catch { failed = true; throw failure(); }
  };
  const execute = work => {
    ensureHealthy();
    try { return work(); }
    catch (error) {
      // Lock contention is recoverable; integrity and I/O failures require intervention.
      if (error?.code?.startsWith('ERR_SQLITE') && ![5, 6].includes(error.errcode & 0xff)) {
        failed = true; throw failure();
      }
      throw error;
    }
  };
  try {
    if (persistent) {
      try { await writeFile(filename, '', { flag: 'wx', mode: 0o600 }); fresh = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (process.platform !== 'win32') {
        await chmod(directory, 0o700);
        await chmod(filename, 0o600);
      }
    }
    db = new DatabaseSync(filename);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
    if (fresh) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE documents(kind TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL DEFAULT '', due REAL, owner TEXT NOT NULL DEFAULT '', data BLOB NOT NULL, PRIMARY KEY(kind,key));
        CREATE INDEX documents_work ON documents(kind,state,due,key);
        CREATE INDEX documents_owner ON documents(kind,owner,key);
        CREATE TABLE processing_leases(name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires REAL NOT NULL);
        CREATE TABLE notification_identity(id INTEGER PRIMARY KEY CHECK(id=1), data BLOB NOT NULL);
        PRAGMA user_version=1;`);
      db.prepare('INSERT INTO notification_identity(id,data) VALUES(1,?)').run(encode('identity', '1', KEY_CHECK));
      db.exec('COMMIT');
    } else {
      if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) throw failure();
      const checks = db.prepare('PRAGMA quick_check').all();
      if (checks.length !== 1 || checks[0].quick_check !== 'ok') throw failure();
      const sentinel = db.prepare('SELECT data FROM notification_identity WHERE id=1').get();
      if (!sentinel || JSON.stringify(decode('identity', '1', sentinel.data)) !== JSON.stringify(KEY_CHECK)) throw failure();
    }
    if (persistent && process.platform !== 'win32') {
      for (const suffix of ['-wal', '-shm']) {
        try { await chmod(filename + suffix, 0o600); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    // Preparing these also validates required schema before the worker can start.
    const select = db.prepare('SELECT kind,key,data FROM documents WHERE kind=? AND key=?');
    const upsert = db.prepare('INSERT INTO documents(kind,key,state,due,owner,data) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET state=excluded.state,due=excluded.due,owner=excluded.owner,data=excluded.data');
    const remove = db.prepare('DELETE FROM documents WHERE kind=? AND key=?');
    const getLease = db.prepare('SELECT holder,expires FROM processing_leases WHERE name=?');
    const putLease = db.prepare('INSERT INTO processing_leases(name,holder,expires) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires=excluded.expires');
    const removeLease = db.prepare('DELETE FROM processing_leases WHERE name=? AND holder=?');

    function transaction(work) {
      ensureHealthy();
      if (typeof work !== 'function' || work.constructor?.name === 'AsyncFunction') throw new TypeError('Notification transactions must be synchronous');
      return execute(() => {
        const nested = transactionDepth > 0, savepoint = `notification_${++savepointId}`;
        db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
        transactionDepth++;
        try {
          const result = work();
          if (result && typeof result.then === 'function') {
            // A callback returning a promise may still run later. Block those writes too.
            failed = true;
            Promise.resolve(result).catch(() => {});
            throw new TypeError('Notification transactions must be synchronous');
          }
          ensureHealthy();
          db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
          return result;
        } catch (error) {
          try { db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK'); }
          catch { failed = true; }
          throw error;
        } finally { transactionDepth--; }
      });
    }

    return {
      token(value) {
        ensureHealthy(); text(value, 'token input', MAX_RECORD_BYTES, true);
        return createHmac('sha256', lookupKey).update(value).digest('hex');
      },
      get(kind, id) {
        text(kind, 'kind', 64); text(id, 'key', 512);
        return execute(() => { const row = select.get(kind, id); return row ? decode(row.kind, row.key, row.data) : null; });
      },
      put(kind, id, value, { state = '', due = null, owner = '' } = {}) {
        text(kind, 'kind', 64); text(id, 'key', 512); text(state, 'state', 64, true); text(owner, 'owner', 512, true);
        if (due !== null) number(due, 'due date');
        return execute(() => { const encrypted = encode(kind, id, value); upsert.run(kind, id, state, due, owner, encrypted); });
      },
      remove(kind, id) {
        text(kind, 'kind', 64); text(id, 'key', 512);
        return execute(() => { remove.run(kind, id); });
      },
      list(kind, { state, before, after = '', limit = 100, owner } = {}) {
        text(kind, 'kind', 64); text(after, 'cursor', 512, true);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid notification list limit');
        const where = ['kind=?', 'key>?'], args = [kind, after];
        if (state !== undefined) { text(state, 'state', 64, true); where.push('state=?'); args.push(state); }
        if (before !== undefined) { number(before, 'cutoff'); where.push('due IS NOT NULL AND due<=?'); args.push(before); }
        if (owner !== undefined) { text(owner, 'owner', 512, true); where.push('owner=?'); args.push(owner); }
        return execute(() => db.prepare(`SELECT kind,key,data FROM documents WHERE ${where.join(' AND ')} ORDER BY key LIMIT ?`).all(...args, limit)
          .map(row => ({ key: row.key, value: decode(row.kind, row.key, row.data) })));
      },
      count(kind, state) {
        text(kind, 'kind', 64);
        if (state !== undefined) text(state, 'state', 64, true);
        return execute(() => Number(db.prepare(`SELECT count(*) AS n FROM documents WHERE kind=?${state === undefined ? '' : ' AND state=?'}`)
          .get(...(state === undefined ? [kind] : [kind, state])).n));
      },
      transaction,
      claimLease(name, holder, timestamp = now(), duration = 300000) {
        text(name, 'lease name', 128); text(holder, 'lease holder', 512);
        number(timestamp, 'lease time'); number(duration, 'lease duration');
        if (duration <= 0 || duration > 24 * 60 * 60 * 1000) throw new TypeError('Invalid notification lease duration');
        const expires = number(timestamp + duration, 'lease expiry');
        return transaction(() => {
          const existing = getLease.get(name);
          if (existing && existing.holder !== holder && existing.expires > timestamp) return false;
          putLease.run(name, holder, expires);
          return true;
        });
      },
      releaseLease(name, holder) {
        text(name, 'lease name', 128); text(holder, 'lease holder', 512);
        return execute(() => { removeLease.run(name, holder); });
      },
      healthy: () => !failed && !closed,
      close() {
        if (closed) return;
        if (transactionDepth) throw new Error('Cannot close a notification transaction');
        closed = true;
        try { db.close(); } finally { key.fill(0); lookupKey.fill(0); }
      }
    };
  } catch (error) {
    try { db?.close(); } catch {}
    key.fill(0); lookupKey.fill(0);
    throw error;
  }
}
