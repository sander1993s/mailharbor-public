import { createHash, randomBytes } from 'node:crypto';
import { MailHarborError, errorMessages, safeError } from './validation.mjs';

const HEADER_CHUNK = 250;
const HEADER_QUERY = Object.freeze({
  uid: true, envelope: true, flags: true, internalDate: true, size: true, headers: ['Message-ID', 'References', 'In-Reply-To'], labels: true
});

const ALLOWED_BUDGET_KEYS = new Set([
  'maxSearchesPerCall', 'maxFetchesPerCall', 'maxCandidatesPerFolder', 'maxTotalMessages', 'maxTotalTokens'
]);

const DEFAULT_BUDGET = Object.freeze({
  maxSearchesPerCall: 20, maxFetchesPerCall: 40, maxCandidatesPerFolder: 500, maxTotalMessages: 200, maxTotalTokens: 500
});

const BUDGET_LIMITS = Object.freeze({
  maxSearchesPerCall: 100, maxFetchesPerCall: 200, maxCandidatesPerFolder: 2000, maxTotalMessages: 500, maxTotalTokens: 1000
});

const fail = code => {
  const safeCode = Object.hasOwn(errorMessages, code) ? code : 'mailbox_error';
  throw new MailHarborError(safeCode, errorMessages[safeCode]);
};

const abortCheck = signal => { if (signal?.aborted) fail('cancelled'); };
const validUid = uid => Number.isSafeInteger(uid) && uid > 0 && uid <= 0xffffffff;
const clean = (val, max = 500) => String(val ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, max);
const has = (vals, wanted) => [...(vals ?? [])].some(v => String(v).toLowerCase() === String(wanted).toLowerCase());
const dateValue = val => (val == null || val === '' ? 0 : Number.isFinite(new Date(val).getTime()) ? new Date(val).getTime() : 0);
const timestamp = msg => dateValue(msg?.envelope?.date) || dateValue(msg?.internalDate);
const validMessage = msg => Boolean(msg && validUid(msg.uid) && msg.flags instanceof Set && msg.envelope && !has(msg.flags, '\\Deleted'));
const pathEqual = (a, b) => a === b || (String(a).toUpperCase() === 'INBOX' && String(b).toUpperCase() === 'INBOX');
const selectable = f => Boolean(f && typeof f.path === 'string' && f.path.length > 0 && f.path.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(f.path) && !has(f.flags, '\\Noselect'));
const sha256 = val => createHash('sha256').update(JSON.stringify(val)).digest('hex');

function formatAddresses(vals) {
  return clean((vals ?? []).map(v => {
    if (!v) return '';
    const n = clean(v.name ?? '', 200), a = clean(v.address ?? '', 200);
    return n ? `${n} <${a}>` : a;
  }).filter(Boolean).join(', '), 500);
}

function validateBudget(b) {
  if (b == null) return;
  if (typeof b !== 'object' || Array.isArray(b)) fail('invalid_request');
  for (const [k, v] of Object.entries(b)) {
    if (!ALLOWED_BUDGET_KEYS.has(k) || !Number.isSafeInteger(v) || v <= 0 || v > BUDGET_LIMITS[k]) fail('invalid_request');
  }
}

function referenceCheck(account, ref) {
  if (!ref || ref.accountId !== account.id || !validUid(ref.uid) || typeof ref.uidValidity !== 'string' ||
    !/^\d{1,20}$/u.test(ref.uidValidity) || typeof ref.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.fingerprint) ||
    !selectable({ path: ref.path })) fail('stale_message');
}

function validity(client, path) {
  if (!pathEqual(client.mailbox?.path, path) || client.mailbox?.uidValidity == null) fail('mailbox_error');
  return String(client.mailbox.uidValidity);
}

async function locked(client, path, readOnly, operation) {
  const lock = await client.getMailboxLock(path, { readOnly });
  try { return await operation(validity(client, path)); }
  finally { try { await lock.release(); } catch {} }
}

function extractTokens(val, max = 100) {
  if (!val) return { tokens: [], truncated: false, malformed: false };
  const str = Array.isArray(val) ? val.join(' ') : String(val);
  const trimmed = str.trim();
  if (!trimmed) return { tokens: [], truncated: false, malformed: false };
  const bounded = trimmed.length > 65536 ? trimmed.slice(0, 65536) : trimmed;
  const matches = bounded.match(/<[^<>\s\x00-\x1f\x7f]{1,998}>/gu) ?? [];
  return {
    tokens: matches.slice(0, max),
    truncated: trimmed.length > 65536 || matches.length > max,
    malformed: matches.length === 0 && trimmed.length > 0
  };
}

function extractRawHeader(rawText, headerName) {
  if (!rawText) return '';
  return rawText.match(new RegExp(`^${headerName}:[ \\t]*(.*)$`, 'imu'))?.[1]?.trim() ?? '';
}

function extractMetadata(account, path, uidValidity, msg, fingerprintFn) {
  const env = msg.envelope ?? {};
  const rawHeadersLen = Buffer.isBuffer(msg.headers) || msg.headers instanceof Uint8Array
    ? msg.headers.length
    : typeof msg.headers === 'string'
      ? msg.headers.length
      : 0;
  const headerTruncated = rawHeadersLen > 65536;
  const rawHeadersDecoded = Buffer.isBuffer(msg.headers) || msg.headers instanceof Uint8Array
    ? Buffer.from(msg.headers.subarray(0, 65536)).toString('utf8')
    : typeof msg.headers === 'string'
      ? msg.headers.slice(0, 65536)
      : '';
  const rawHeaders = rawHeadersDecoded.length > 65536 ? rawHeadersDecoded.slice(0, 65536) : rawHeadersDecoded;
  const unfolded = rawHeaders.replace(/\r?\n[ \t]+/gu, ' ');

  const rawMsgId = extractRawHeader(unfolded, 'message-id');
  const rawInReplyTo = extractRawHeader(unfolded, 'in-reply-to');
  const rawRefs = extractRawHeader(unfolded, 'references');

  const envMsgId = env.messageId != null ? (Array.isArray(env.messageId) ? env.messageId.join(' ') : String(env.messageId)) : '';
  const envInReplyTo = env.inReplyTo != null ? (Array.isArray(env.inReplyTo) ? env.inReplyTo.join(' ') : String(env.inReplyTo)) : '';
  const envRefs = env.references != null ? (Array.isArray(env.references) ? env.references.join(' ') : String(env.references)) : '';

  const msgIdSrc = envMsgId.trim().length > 0 ? envMsgId : rawMsgId;
  const inReplyToSrc = envInReplyTo.trim().length > 0 ? envInReplyTo : rawInReplyTo;
  const refsSrc = envRefs.trim().length > 0 ? envRefs : rawRefs;

  const msgIdP = extractTokens(msgIdSrc, 1);
  const inReplyToP = extractTokens(inReplyToSrc, 1);
  const refsP = extractTokens(refsSrc, 100);

  const edgesOmitted = Boolean(headerTruncated || msgIdP.truncated || inReplyToP.truncated || inReplyToP.malformed || refsP.truncated || refsP.malformed);
  const messageId = msgIdP.tokens[0] ?? '';
  const inReplyTo = inReplyToP.tokens[0] ?? '';
  const references = refsP.tokens;
  const time = timestamp(msg);

  const emailId = typeof msg.emailId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(msg.emailId) ? msg.emailId : null;

  const reference = {
    accountId: account.id, path, uidValidity: String(uidValidity), uid: msg.uid, fingerprint: fingerprintFn(msg)
  };

  return {
    item: {
      id: sha256(reference), accountId: account.id, account: clean(account.label || account.email || account.id),
      author: formatAddresses(env.from), to: formatAddresses(env.to), cc: formatAddresses(env.cc),
      replyTo: formatAddresses(env.replyTo), messageId, inReplyTo, references,
      date: time ? new Date(time).toISOString() : '', unread: !has(msg.flags, '\\Seen'), starred: has(msg.flags, '\\Flagged'),
      subject: clean(env.subject ?? '', 500), size: Number.isSafeInteger(msg.size) && msg.size >= 0 ? msg.size : null,
      folderPath: path, reference, _time: time, _emailId: emailId,
      _tokens: new Set([messageId, inReplyTo, ...references].filter(Boolean)), _isSeed: false
    },
    edgesOmitted
  };
}

class CursorCache {
  constructor(maxEntries, ttlMs, nowFn) { this.maxEntries = maxEntries; this.ttlMs = ttlMs; this.now = nowFn; this.map = new Map(); }
  get(id) {
    const entry = this.map.get(id);
    if (!entry) return null;
    if (this.now() - entry.createdAt > this.ttlMs) { this.map.delete(id); return null; }
    this.map.delete(id); this.map.set(id, entry); return entry;
  }
  set(id, data) {
    if (this.map.has(id)) this.map.delete(id);
    else if (this.map.size >= this.maxEntries) { const oldest = this.map.keys().next().value; if (oldest !== undefined) this.map.delete(oldest); }
    this.map.set(id, { ...data, createdAt: this.now() });
  }
  delete(id) { return this.map.delete(id); }
  clear() { this.map.clear(); }
}

export function createMailConversations({
  session, active, fingerprint, now = Date.now, maxCacheEntries = 200, cursorTtlMs = 300_000, defaultBudget = {}
} = {}) {
  if (typeof session !== 'function') throw new TypeError('session is required');
  if (!(active instanceof WeakSet)) throw new TypeError('active WeakSet is required');
  if (typeof fingerprint !== 'function') throw new TypeError('fingerprint is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isSafeInteger(maxCacheEntries) || maxCacheEntries < 1 || maxCacheEntries > 200) fail('invalid_request');
  if (!Number.isSafeInteger(cursorTtlMs) || cursorTtlMs < 1 || cursorTtlMs > 900_000) fail('invalid_request');
  validateBudget(defaultBudget);

  const cursorCache = new CursorCache(maxCacheEntries, cursorTtlMs, now);
  let generation = 0;
  let destroyed = false;

  async function load(account, reference, { signal, cursor = null, budget = {} } = {}) {
    if (destroyed) fail('mailbox_error');
    abortCheck(signal);
    if (!account || typeof account !== 'object' || typeof account.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(account.id)) fail('invalid_request');
    referenceCheck(account, reference);
    validateBudget(budget);
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 500)) fail('stale_message');

    const effectiveBudget = { ...DEFAULT_BUDGET, ...defaultBudget, ...budget };
    const callGen = generation;
    let previousState = null;

    if (cursor) {
      const entry = cursorCache.get(cursor);
      if (!entry || entry.accountId !== account.id) fail('stale_message');
      if ((account.email ?? '') !== entry.accountEmail) fail('stale_message');
      const currentRev = String(account.revision ?? account.updatedAt ?? '');
      if (entry.accountRevision !== currentRev) fail('stale_message');
      if (entry.reference.accountId !== reference.accountId || entry.reference.path !== reference.path ||
        entry.reference.uid !== reference.uid || entry.reference.uidValidity !== String(reference.uidValidity) ||
        entry.reference.fingerprint !== reference.fingerprint || entry.inUse) fail('stale_message');
      entry.inUse = true;
      cursorCache.delete(cursor);
      previousState = entry.state;
    }

    return session(account, signal, async client => {
      abortCheck(signal);
      if (!active.has(client)) fail('mailbox_error');
      const isGmail = Boolean(client.capabilities?.has('X-GM-EXT-1'));

      let seedItem, seedEdgesOmitted = false;
      await locked(client, reference.path, true, async uidValidity => {
        abortCheck(signal);
        if (!active.has(client)) fail('mailbox_error');
        if (uidValidity !== reference.uidValidity) fail('stale_message');
        const seedMsg = await client.fetchOne(String(reference.uid), HEADER_QUERY, { uid: true, binary: false });
        abortCheck(signal);
        if (!active.has(client)) fail('mailbox_error');
        if (validity(client, reference.path) !== reference.uidValidity) fail('stale_message');
        if (!validMessage(seedMsg) || seedMsg.uid !== reference.uid || fingerprint(seedMsg) !== reference.fingerprint) fail('stale_message');
        const ext = extractMetadata(account, reference.path, uidValidity, seedMsg, fingerprint);
        seedItem = ext.item;
        seedEdgesOmitted = ext.edgesOmitted;
        seedItem._isSeed = true;
      });

      let folders, graphTokens, graphTokenSet, discovered, searchedByFolder, pendingCandidates, folderRetries, terminalPartial;
      const failedFoldersThisCall = new Set(), errors = [];

      if (previousState) {
        folders = previousState.folders;
        graphTokens = [...previousState.graphTokens];
        graphTokenSet = new Set(graphTokens);
        discovered = new Map(previousState.discovered);
        searchedByFolder = new Map(previousState.searchedByFolder.map(([k, v]) => [k, new Set(v)]));
        pendingCandidates = new Map(previousState.pendingCandidates ?? []);
        folderRetries = new Map(previousState.folderRetries ?? []);
        terminalPartial = Boolean(previousState.terminalPartial) || seedEdgesOmitted;
        discovered.set(`${reference.path}:${reference.uid}`, seedItem);

        const knownCached = folders.filter(f => f.uidValidity != null);
        for (const kf of knownCached) {
          abortCheck(signal);
          if (!active.has(client)) fail('mailbox_error');
          await locked(client, kf.path, true, async curVal => {
            abortCheck(signal);
            if (!active.has(client)) fail('mailbox_error');
            if (curVal !== kf.uidValidity) fail('stale_message');
          });
        }
      } else {
        const raw = await client.list();
        abortCheck(signal);
        if (!active.has(client)) fail('mailbox_error');
        if (!Array.isArray(raw) || raw.length > 1000) fail('mailbox_error');
        const selectableFolders = raw.filter(selectable).filter((f, i, all) => all.findIndex(o => pathEqual(o.path, f.path)) === i);
        selectableFolders.sort((a, b) => (pathEqual(a.path, reference.path) ? -1 : pathEqual(b.path, reference.path) ? 1 : a.path.localeCompare(b.path)));
        folders = selectableFolders.map(f => ({ path: f.path, uidValidity: null }));
        const seedFolder = folders.find(f => pathEqual(f.path, reference.path));
        if (seedFolder) seedFolder.uidValidity = reference.uidValidity;

        discovered = new Map();
        discovered.set(`${reference.path}:${reference.uid}`, seedItem);
        graphTokens = [];
        graphTokenSet = new Set();
        let seedTokensOverflow = false;
        for (const tok of seedItem._tokens) {
          if (graphTokens.length < effectiveBudget.maxTotalTokens) {
            graphTokens.push(tok);
            graphTokenSet.add(tok);
          } else {
            seedTokensOverflow = true;
          }
        }
        searchedByFolder = new Map();
        for (const f of folders) searchedByFolder.set(f.path, new Set());
        pendingCandidates = new Map();
        folderRetries = new Map();
        terminalPartial = Boolean(seedEdgesOmitted || seedTokensOverflow);

        if (folders.length === 0 || !seedFolder) {
          terminalPartial = true;
          errors.push({ code: 'mailbox_error' });
        }
      }

      let searchesDone = 0, fetchesDone = 0, budgetExhausted = false;

      while (!budgetExhausted && !terminalPartial) {
        let progressInTurn = false;

        for (const target of folders) {
          if (budgetExhausted || terminalPartial) break;
          if (failedFoldersThisCall.has(target.path)) continue;

          const hasPending = pendingCandidates.has(target.path);
          let tokenToSearch = null;
          if (!hasPending) {
            const searched = searchedByFolder.get(target.path);
            tokenToSearch = graphTokens.find(t => !searched.has(t));
            if (!tokenToSearch) continue;
            if (searchesDone >= effectiveBudget.maxSearchesPerCall) { budgetExhausted = true; break; }
          } else if (fetchesDone >= effectiveBudget.maxFetchesPerCall) {
            budgetExhausted = true; break;
          }

          progressInTurn = true;
          try {
            await locked(client, target.path, true, async currentVal => {
              abortCheck(signal);
              if (!active.has(client)) fail('mailbox_error');
              if (target.uidValidity == null) target.uidValidity = currentVal;
              else if (target.uidValidity !== currentVal) fail('stale_message');

              if (!hasPending) {
                searchesDone++;
                const criteria = {
                  deleted: false,
                  or: [
                    { header: { 'Message-ID': tokenToSearch } },
                    { header: { References: tokenToSearch } },
                    { header: { 'In-Reply-To': tokenToSearch } }
                  ]
                };
                const foundUids = await client.search(criteria, { uid: true });
                abortCheck(signal);
                if (!active.has(client)) fail('mailbox_error');
                if (validity(client, target.path) !== target.uidValidity) fail('stale_message');
                if (!Array.isArray(foundUids) || foundUids.some(u => !validUid(u))) fail('mailbox_error');

                const uniqueFoundUids = [...new Set(foundUids)];
                const newUids = uniqueFoundUids.filter(uid => !discovered.has(`${target.path}:${uid}`));
                if (newUids.length === 0) {
                  searchedByFolder.get(target.path).add(tokenToSearch);
                  folderRetries.delete(target.path);
                  return;
                }
                let candidates = newUids;
                if (candidates.length > effectiveBudget.maxCandidatesPerFolder) {
                  terminalPartial = true;
                  candidates = candidates.slice(0, effectiveBudget.maxCandidatesPerFolder);
                }
                pendingCandidates.set(target.path, { msgId: tokenToSearch, uids: candidates });
              }

              if (fetchesDone >= effectiveBudget.maxFetchesPerCall) {
                budgetExhausted = true;
                return;
              }

              const pending = pendingCandidates.get(target.path);
              const chunk = pending.uids.slice(0, HEADER_CHUNK);
              fetchesDone++;

              const requestedUids = new Set(chunk);
              const seenUidsInChunk = new Set();
              const fetched = [];
              for await (const msg of client.fetch(chunk.join(','), HEADER_QUERY, { uid: true, binary: false })) {
                abortCheck(signal);
                if (!active.has(client)) fail('mailbox_error');
                if (!msg || !validUid(msg.uid)) continue;
                if (!requestedUids.has(msg.uid) || seenUidsInChunk.has(msg.uid)) continue;
                seenUidsInChunk.add(msg.uid);
                fetched.push(msg);
              }
              abortCheck(signal);
              if (!active.has(client)) fail('mailbox_error');
              if (validity(client, target.path) !== target.uidValidity) fail('stale_message');

              for (const msg of fetched) {
                if (!validMessage(msg)) continue;
                const ext = extractMetadata(account, target.path, target.uidValidity, msg, fingerprint);
                if (ext.edgesOmitted) terminalPartial = true;
                if (!ext.item._tokens.has(pending.msgId)) continue;

                const msgKey = `${target.path}:${msg.uid}`;
                if (!discovered.has(msgKey)) {
                  if (discovered.size >= effectiveBudget.maxTotalMessages) {
                    terminalPartial = true;
                    break;
                  }
                  discovered.set(msgKey, ext.item);
                }

                for (const t of ext.item._tokens) {
                  if (!graphTokenSet.has(t)) {
                    if (graphTokens.length < effectiveBudget.maxTotalTokens) {
                      graphTokens.push(t);
                      graphTokenSet.add(t);
                    } else {
                      terminalPartial = true;
                    }
                  }
                }
              }

              pending.uids = pending.uids.slice(chunk.length);
              if (pending.uids.length === 0) {
                searchedByFolder.get(target.path).add(pending.msgId);
                pendingCandidates.delete(target.path);
                folderRetries.delete(target.path);
              }
            });
          } catch (err) {
            if (err?.code === 'cancelled' || err?.code === 'stale_message') throw err;
            const safe = safeError(err);
            errors.push({ folderPath: target.path, code: safe.code });
            failedFoldersThisCall.add(target.path);
            const retries = (folderRetries.get(target.path) ?? 0) + 1;
            folderRetries.set(target.path, retries);
            if (retries >= 3) terminalPartial = true;
          }
        }

        if (!progressInTurn) break;
      }

      const hasPendingFetch = [...pendingCandidates.values()].some(p => p.uids.length > 0);
      const hasUnsearched = folders.some(f => {
        const searched = searchedByFolder.get(f.path) ?? new Set();
        return graphTokens.some(t => !searched.has(t));
      });

      abortCheck(signal);
      if (!active.has(client)) fail('mailbox_error');
      if (generation !== callGen || destroyed) fail('stale_message');

      let complete = false, nextCursor = null;

      if (terminalPartial) {
        complete = false;
        nextCursor = null;
        if (!errors.some(e => e.code === 'mailbox_error')) errors.push({ code: 'mailbox_error' });
      } else if (!hasPendingFetch && !hasUnsearched && errors.length === 0) {
        complete = true;
        nextCursor = null;
      } else {
        complete = false;
        if (generation === callGen && !destroyed) {
          nextCursor = randomBytes(24).toString('base64url');
          cursorCache.set(nextCursor, {
            accountId: account.id,
            accountEmail: account.email ?? '',
            accountRevision: String(account.revision ?? account.updatedAt ?? ''),
            reference: {
              accountId: reference.accountId,
              path: reference.path,
              uidValidity: String(reference.uidValidity),
              uid: reference.uid,
              fingerprint: reference.fingerprint
            },
            inUse: false,
            state: {
              folders,
              graphTokens,
              discovered: [...discovered.entries()],
              searchedByFolder: [...searchedByFolder.entries()].map(([k, v]) => [k, [...v]]),
              pendingCandidates: [...pendingCandidates.entries()],
              folderRetries: [...folderRetries.entries()],
              terminalPartial
            }
          });
        }
      }

      const allDiscovered = [...discovered.values()];
      let deduplicated = [];

      if (isGmail) {
        const byEmailId = new Map();
        const withoutEmailId = [];
        for (const item of allDiscovered) {
          if (typeof item._emailId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(item._emailId)) {
            if (!byEmailId.has(item._emailId)) byEmailId.set(item._emailId, []);
            byEmailId.get(item._emailId).push(item);
          } else withoutEmailId.push(item);
        }
        for (const copies of byEmailId.values()) {
          if (copies.length === 1) deduplicated.push(copies[0]);
          else {
            const preferred = copies.find(c => c._isSeed || (c.reference.path === reference.path && c.reference.uid === reference.uid));
            if (preferred) deduplicated.push(preferred);
            else {
              copies.sort((a, b) => a.folderPath.localeCompare(b.folderPath) || a.reference.uid - b.reference.uid);
              deduplicated.push(copies[0]);
            }
          }
        }
        for (const item of withoutEmailId) deduplicated.push(item);
      } else {
        deduplicated = allDiscovered;
      }

      deduplicated.sort((a, b) => (a._time - b._time) || a.folderPath.localeCompare(b.folderPath) || a.reference.uid - b.reference.uid);

      const messages = deduplicated.map(item => ({
        id: item.id, account: item.account, accountId: item.accountId, author: item.author, to: item.to, cc: item.cc,
        replyTo: item.replyTo, messageId: item.messageId, inReplyTo: item.inReplyTo, references: item.references,
        date: item.date, unread: item.unread, starred: item.starred,
        subject: item.subject, size: item.size,
        folderPath: item.folderPath, reference: item.reference
      }));

      const uniqueErrors = [];
      const seenErrorKeys = new Set();
      for (const err of errors) {
        const code = Object.hasOwn(errorMessages, err?.code) ? err.code : 'mailbox_error';
        const key = `${err.folderPath ?? ''}:${code}`;
        if (!seenErrorKeys.has(key)) {
          seenErrorKeys.add(key);
          uniqueErrors.push({ accountId: account.id, ...(err.folderPath ? { folderPath: err.folderPath } : {}), code });
        }
      }
      uniqueErrors.sort((a, b) => String(a.folderPath ?? '').localeCompare(String(b.folderPath ?? '')) || a.code.localeCompare(b.code));

      abortCheck(signal);
      if (!active.has(client)) fail('mailbox_error');
      if (generation !== callGen || destroyed) fail('stale_message');

      return { messages, complete, nextCursor, errors: uniqueErrors };
    });
  }

  function clear() { generation++; cursorCache.clear(); }
  function destroy() { destroyed = true; generation++; cursorCache.clear(); }

  return { load, clear, destroy };
}
