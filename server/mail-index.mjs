import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, chmod } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';

/** Indexed metadata, encrypted per record. No bodies, credentials or attachments belong here. */
export async function createMailIndex(directory) {
  if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
  const master = directory ? await readFile(path.join(directory, 'accounts.key')) : randomBytes(32);
  if (master.length !== 32) throw new Error('Invalid mail index key');
  const key = createHmac('sha256', master).update('MailHarbor index v1').digest();
  const filename = directory ? path.join(directory, 'mail-index.sqlite') : ':memory:';
  const db = new DatabaseSync(filename);
  if (directory && process.platform !== 'win32') await chmod(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL DEFAULT '', due REAL, owner TEXT NOT NULL DEFAULT '', data BLOB NOT NULL, PRIMARY KEY(kind,key));
    CREATE INDEX IF NOT EXISTS documents_work ON documents(kind,state,due,key);
    CREATE TABLE IF NOT EXISTS labels(key TEXT NOT NULL, label TEXT NOT NULL, owner TEXT NOT NULL, stamp REAL NOT NULL, PRIMARY KEY(key,label));
    CREATE INDEX IF NOT EXISTS labels_lookup ON labels(label,owner,stamp);
    CREATE TABLE IF NOT EXISTS processing_leases(name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS processing_reasons(key TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(key,reason));
    PRAGMA user_version=1;`);
  const columns = new Set(db.prepare('PRAGMA table_info(documents)').all().map(row => row.name));
  for (const [name, type] of [['analysis', "TEXT NOT NULL DEFAULT ''"], ['category', "TEXT NOT NULL DEFAULT ''"], ['age', 'REAL']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS processing_work ON documents(kind,state,owner,due,age,key); CREATE INDEX IF NOT EXISTS processing_category ON documents(kind,category,key);');
  let failed = false;
  const tagListeners = new Set();
  const token = text => createHmac('sha256', key).update(text).digest('hex');
  const encode = (kind, id, value) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${kind}:${id}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  };
  const decode = row => {
    if (!row) return null;
    try {
    const data = Buffer.from(row.data), decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${row.kind}:${row.key}`)); decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]));
    } catch (error) { failed = true; throw error; }
  };
  const upsert = db.prepare('INSERT INTO documents(kind,key,state,due,owner,data) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET state=excluded.state,due=excluded.due,owner=excluded.owner,data=excluded.data');
  const updateMetadata = db.prepare('UPDATE documents SET state=?,due=?,owner=?,analysis=?,category=?,age=? WHERE kind=? AND key=?');
  const deleteReasons = db.prepare('DELETE FROM processing_reasons WHERE key=?');
  const insertReason = db.prepare('INSERT OR IGNORE INTO processing_reasons(key,reason) VALUES(?,?)');
  const get = (kind, id) => decode(db.prepare('SELECT * FROM documents WHERE kind=? AND key=?').get(kind, id));
  let inTransaction = false;
  function transaction(work) {
    if (inTransaction) return work();
    db.exec('BEGIN IMMEDIATE'); inTransaction = true;
    try { const result = work(); if (result?.then) throw new Error('Transactions must be synchronous'); db.exec('COMMIT'); return result; }
    catch (error) { if (error?.code?.startsWith('ERR_SQLITE')) failed = true; try { db.exec('ROLLBACK'); } catch { failed = true; } throw error; }
    finally { inTransaction = false; }
  }
  function metadata(kind, id, { state = '', due = null, owner = '', analysis = '', category = '', age = null, reasons = [] } = {}) {
    updateMetadata.run(state, Number.isFinite(due) ? due : null, owner, analysis, category, Number.isFinite(age) ? age : null, kind, id);
    if (kind === 'messages') {
      deleteReasons.run(id);
      for (const reason of reasons) insertReason.run(id, reason);
    }
  }
  function put(kind, id, value, options = {}) {
    if (failed) throw new Error('Mail index requires recovery');
    const { state = '', due = null, owner = '' } = options;
    try { transaction(() => {
      upsert.run(kind, id, state, Number.isFinite(due) ? due : null, owner, encode(kind, id, value));
      if (kind === 'messages') metadata(kind, id, options);
    }); } catch (error) { failed = true; throw error; }
  }
  return {
    token, get, put, transaction, healthy: () => !failed,
    onTagChange(listener) { tagListeners.add(listener); return () => tagListeners.delete(listener); },
    claimLease(name, holder, now, duration = 300000) {
      if (failed) throw new Error('Mail index requires recovery');
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM processing_leases WHERE name=?').get(name);
        if (existing && existing.holder !== holder && existing.expires > now) return false;
        db.prepare('INSERT INTO processing_leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires=excluded.expires').run(name, holder, now + duration);
        return true;
      });
    },
    releaseLease(name, holder) { db.prepare('DELETE FROM processing_leases WHERE name=? AND holder=?').run(name, holder); },
    remove(kind, id) { db.prepare('DELETE FROM documents WHERE kind=? AND key=?').run(kind, id); },
    list(kind, { state, before, after = '', limit = 100, category, owner, order = 'key' } = {}) {
      const where = ['kind=?', 'key>?'], args = [kind, after];
      if (state !== undefined) { where.push('state=?'); args.push(state); }
      if (before !== undefined) { where.push('due IS NOT NULL AND due<=?'); args.push(before); }
      if (category !== undefined) { where.push('category=?'); args.push(category); }
      if (owner !== undefined) { where.push('owner=?'); args.push(owner); }
      const ordering = order === 'due' ? 'due,age,key' : order === 'newest' ? 'age DESC,due,key' : 'key';
      return db.prepare(`SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY ${ordering} LIMIT ?`).all(...args, limit).map(row => ({ key: row.key, value: decode(row) }));
    },
    processingSummary() {
      const result = { analysis: {}, categories: {}, reasons: {}, earliestDue: null };
      for (const row of db.prepare("SELECT analysis,count(*) n FROM documents WHERE kind='messages' GROUP BY analysis").all()) result.analysis[row.analysis] = row.n;
      for (const row of db.prepare("SELECT category,count(*) n FROM documents WHERE kind='messages' GROUP BY category").all()) result.categories[row.category] = row.n;
      for (const row of db.prepare('SELECT reason,count(*) n FROM processing_reasons GROUP BY reason').all()) result.reasons[row.reason] = row.n;
      result.earliestDue = db.prepare("SELECT min(due) due FROM documents WHERE kind='messages' AND state IN ('pending','ready','review')").get().due;
      return result;
    },
    count(kind, state) { return Number(db.prepare(`SELECT count(*) AS n FROM documents WHERE kind=?${state === undefined ? '' : ' AND state=?'}`).get(...(state === undefined ? [kind] : [kind, state])).n); },
    putTag(id, value) {
      transaction(() => {
        put('tags', id, value);
        db.prepare('DELETE FROM labels WHERE key=?').run(id);
        const add = db.prepare('INSERT INTO labels(key,label,owner,stamp) VALUES(?,?,?,?)');
        for (const label of value.tags) add.run(id, token(`label:${label}`), token(`owner:${value.accountId}:${value.email}`), Date.parse(value.message.date) || 0);
        put('meta', 'tagVersion', { value: (get('meta', 'tagVersion')?.value ?? 0) + 1 });
        for (const listener of tagListeners) listener(id, value);
      });
    },
    tagCount(owners, label) {
      if (!owners.length) return 0;
      return Number(db.prepare(`SELECT count(DISTINCT key) AS n FROM labels WHERE label=? AND owner IN (${owners.map(() => '?').join(',')})`).get(token(`label:${label}`), ...owners.map(owner => token(`owner:${owner}`))).n);
    },
    tagEntries(owners, label) {
      if (!owners.length) return [];
      const args = owners.map(owner => token(`owner:${owner}`));
      if (label) args.push(token(`label:${label}`));
      return db.prepare(`SELECT DISTINCT d.* FROM documents d JOIN labels l ON d.kind='tags' AND d.key=l.key WHERE l.owner IN (${owners.map(() => '?').join(',')})${label ? ' AND l.label=?' : ''} ORDER BY l.stamp DESC,d.key`).all(...args).map(row => ({ key: row.key, value: decode(row) }));
    },
    close() { db.close(); key.fill(0); }
  };
}
