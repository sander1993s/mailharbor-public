import { createHash, randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { decodeBody } from './body.mjs';
import { MailHarborError, errorMessages } from './validation.mjs';

const BATCH_SIZE = 40;
const HEADER_CHUNK = 250;
const BODY_BYTES = 64 * 1024;
const MIME_BYTES = 16 * 1024;
const SESSION_TIMEOUT = 120_000;
const DAY = 86_400_000;
const SEARCH_WINDOWS_DAYS = [7, 30, 90, 365, 3650];
// Date SEARCH ignores time zones; RFC numeric zone syntax can exceed a single day.
const SEARCH_DATE_MARGIN = 5 * DAY;
const DIAGNOSTIC_COMMANDS = new Set(['AUTHENTICATE', 'LOGIN', 'CAPABILITY', 'ID', 'NAMESPACE', 'ENABLE', 'LIST', 'LSUB', 'STATUS',
  'SELECT', 'EXAMINE', 'SEARCH', 'UID SEARCH', 'FETCH', 'UID FETCH', 'STORE', 'UID STORE', 'MOVE', 'UID MOVE',
  'COPY', 'UID COPY', 'EXPUNGE', 'UID EXPUNGE', 'CLOSE', 'NOOP', 'IDLE', 'LOGOUT', 'STARTTLS', 'COMPRESS']);
const DIAGNOSTIC_RESPONSES = new Set(['ALERT', 'AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'CONTACTADMIN', 'EXPIRED', 'PRIVACYREQUIRED',
  'UNAVAILABLE', 'SERVERBUG', 'CLIENTBUG', 'CANNOT', 'NOPERM', 'NONEXISTENT', 'ALREADYEXISTS', 'INUSE', 'LIMIT', 'OVERQUOTA',
  'TRYCREATE', 'READ-ONLY', 'READ-WRITE', 'MODIFIED', 'EXPUNGEISSUED', 'PARSE', 'TOOBIG', 'BADCHARSET', 'UNKNOWN-CTE', 'CLOSED']);
const DIAGNOSTIC_REASONS = new Set(['authentication_failed', 'throttled', 'timeout', 'connection_closed', 'connection_reset',
  'connection_refused', 'dns_error', 'tls_error', 'protocol_error', 'server_rejected', 'unknown']);
const DIAGNOSTIC_STATUSES = new Set(['NO', 'BAD', 'BYE']);
const DIAGNOSTIC_TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'STARTTLS_INJECTION']);

/** Only fixed diagnostics cross the mailbox boundary; raw IMAP error objects never do. */
export function safeMailboxDiagnostic(value) {
  if (!value || typeof value !== 'object' || !DIAGNOSTIC_REASONS.has(value.reason)) return null;
  const result = { command: DIAGNOSTIC_COMMANDS.has(value.command) ? value.command : null, reason: value.reason,
    status: DIAGNOSTIC_STATUSES.has(value.status) ? value.status : null,
    responseCode: DIAGNOSTIC_RESPONSES.has(value.responseCode) ? value.responseCode : null };
  if (value.reason === 'tls_error' && DIAGNOSTIC_TLS_CODES.has(value.transportCode)) result.transportCode = value.transportCode;
  return result;
}

function mailboxDiagnostic(error, command = null) {
  // exec rejects before ImapFlow's STORE/MOVE handlers enhance the parsed response
  // and swallow it as false. Extract only the first fixed protocol response atom.
  const response = error?.response;
  const atom = error?.serverResponseCode ?? (response && typeof response === 'object' ? response.attributes?.[0]?.section?.[0]?.value : null);
  const responseCode = typeof atom === 'string' && DIAGNOSTIC_RESPONSES.has(atom.toUpperCase()) ? atom.toUpperCase() : null;
  const status = DIAGNOSTIC_STATUSES.has(error?.responseStatus) ? error.responseStatus :
    DIAGNOSTIC_STATUSES.has(response?.command) ? response.command : null;
  const code = error?.code;
  let reason = status ? 'server_rejected' : 'unknown';
  if (error?.authenticationFailed === true || ['AUTHENTICATIONFAILED', 'oauth_invalid_grant'].includes(code) ||
      ['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED'].includes(responseCode)) reason = 'authentication_failed';
  else if (code === 'ETHROTTLE') reason = 'throttled';
  else if (['ETIMEOUT', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'LockTimeout', 'mailbox_timeout'].includes(code)) reason = 'timeout';
  else if (['NoConnection', 'EConnectionClosed', 'ClosedAfterConnectTLS', 'ClosedAfterConnectText', 'StateLogout'].includes(code) || status === 'BYE') reason = 'connection_closed';
  else if (code === 'ECONNRESET' || code === 'EPIPE') reason = 'connection_reset';
  else if (code === 'ECONNREFUSED') reason = 'connection_refused';
  else if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) reason = 'dns_error';
  else if (DIAGNOSTIC_TLS_CODES.has(code)) reason = 'tls_error';
  else if (['InvalidResponse', 'ParserError', 'UnexpectedTag', 'ResponseProcessingFailed'].includes(code)) reason = 'protocol_error';
  return safeMailboxDiagnostic({ command, reason, status, responseCode, transportCode: code });
}
const query = Object.freeze({ uid: true, envelope: true, flags: true, internalDate: true, size: true });
const messages = Object.freeze({
  ...errorMessages,
  mailbox_login_required: 'Sign in to this mailbox again.',
  mailbox_error: 'The mailbox could not complete the request. No automatic retry was made.',
  mailbox_timeout: 'The mailbox scan exceeded its time limit. No automatic retry was made.',
  archive_unavailable: 'This mailbox has no verified safe archive destination.',
  delete_unavailable: 'This message cannot be moved safely to Trash.',
  attachment_too_large: 'This attachment exceeds the 100 MiB download limit.',
  attachment_unavailable: 'This attachment is no longer available.',
  stale_message: 'This message changed or left the unread inbox. Create a new briefing.',
  cancelled: 'The job was cancelled.',
  invalid_request: 'The request does not match the MailHarbor format or limits.'
});

function fail(code) { throw new MailHarborError(code, messages[code]); }
function sanitized(error, diagnostic) {
  const code = error instanceof MailHarborError && Object.hasOwn(messages, error.code) ? error.code :
    error?.authenticationFailed || error?.code === 'AUTHENTICATIONFAILED' ? 'mailbox_login_required' : 'mailbox_error';
  const result = new MailHarborError(code, messages[code]);
  if (['mailbox_error', 'mailbox_timeout', 'mailbox_login_required'].includes(code) && diagnostic) result.mailboxDiagnostic = safeMailboxDiagnostic(diagnostic);
  return result;
}
function abortCheck(signal) { if (signal?.aborted) fail('cancelled'); }
function clean(value, max = 500) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, max);
}
function has(values, wanted) { return [...(values ?? [])].some(value => String(value).toLowerCase() === wanted.toLowerCase()); }
function dateValue(value) {
  if (value == null || value === '') return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}
function timestamp(message) { return dateValue(message.envelope?.date) || dateValue(message.internalDate); }
function validUid(uid) { return Number.isSafeInteger(uid) && uid > 0 && uid <= 0xffffffff; }
function unread(message) { return message && validUid(message.uid) && message.flags instanceof Set && !has(message.flags, '\\Seen') && !has(message.flags, '\\Deleted'); }
function fingerprint(message) {
  // UIDVALIDITY and UID are checked separately. Do not depend on mutable labels/flags.
  const envelope = message.envelope ?? {};
  const addresses = values => (values ?? []).map(value => [String(value.name ?? ''), String(value.address ?? '')]);
  return createHash('sha256').update(JSON.stringify({
    messageId: envelope.messageId ?? '', date: dateValue(envelope.date), internalDate: dateValue(message.internalDate),
    subject: envelope.subject ?? '', from: addresses(envelope.from), sender: addresses(envelope.sender),
    to: addresses(envelope.to), cc: addresses(envelope.cc), inReplyTo: envelope.inReplyTo ?? '', size: message.size ?? null
  })).digest('hex');
}
function mailboxValidity(client) {
  if (String(client.mailbox?.path ?? '').toUpperCase() !== 'INBOX' || client.mailbox?.uidValidity == null) fail('mailbox_error');
  return String(client.mailbox.uidValidity);
}
function selectable(folder) {
  return typeof folder.path === 'string' && folder.path.length > 0 && folder.path.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/u.test(folder.path) && !has(folder.flags, '\\Noselect');
}
function archiveTarget(client, folders, account) {
  const available = folders.filter(selectable);
  if (client.capabilities?.has('X-GM-EXT-1')) {
    const all = available.find(folder => folder.specialUse === '\\All');
    return all ? { path: all.path, gmail: true } : null;
  }
  // ImapFlow otherwise emulates MOVE with COPY/DELETE/EXPUNGE. Never allow that fallback.
  if (!client.capabilities?.has('MOVE')) return null;
  const allowed = folder => String(folder.path).toUpperCase() !== 'INBOX' &&
    !['\\Trash', '\\Junk', '\\Drafts', '\\Sent'].includes(folder.specialUse);
  const explicit = account.archivePath && available.find(folder => folder.path === account.archivePath && allowed(folder));
  const special = available.find(folder => folder.specialUse === '\\Archive' && allowed(folder));
  const target = account.archivePath ? explicit : special;
  return target ? { path: target.path, gmail: false } : null;
}
function preferredPart(structure) {
  const plain = [], html = [];
  const named = parameters => Object.keys(parameters ?? {}).some(key => /^(?:name|filename)(?:\*.*)?$/iu.test(key));
  function visit(node, depth = 0) {
    if (!node || depth > 30) return;
    const type = String(node.type ?? '').trim().toLowerCase();
    const disposition = String(node.disposition ?? '').trim().toLowerCase();
    // Do not descend into attached messages, filename-bearing parts, or encryption containers.
    if (!['', 'inline'].includes(disposition) || named(node.dispositionParameters) || named(node.parameters) ||
      type === 'multipart/encrypted' || type.startsWith('message/') || type.startsWith('application/')) return;
    if (type === 'text/plain') plain.push(node);
    else if (type === 'text/html') html.push(node);
    else if (type.startsWith('multipart/')) for (const child of node.childNodes ?? []) visit(child, depth + 1);
  }
  visit(structure);
  const selected = plain[0] ?? html[0];
  if (!selected || !/^(?:\d+\.)*\d+$/u.test(String(selected.part || '1'))) return null;
  return { ...selected, part: String(selected.part || '1') };
}
const DEFAULT_POOL_IDLE_MS = 30_000;
const POOL_PROBE_IDLE_MS = 5_000;
const POOL_MAX_AGE_MS = 240_000;
const POOL_MAX_PER_KEY = 2;

/** Shared secure IMAP sessions; close() never expunges a selected mailbox. */
export function createMailboxSession({ connectionOptions, createClient, sessionTimeoutMs = SESSION_TIMEOUT, poolIdleMs }) {
  if (typeof connectionOptions !== 'function') throw new TypeError('connectionOptions is required');
  if (!Number.isInteger(sessionTimeoutMs) || sessionTimeoutMs < 1 || sessionTimeoutMs > 600_000) throw new TypeError('Invalid session timeout');
  const effectiveIdleMs = poolIdleMs ?? (createClient ? 0 : DEFAULT_POOL_IDLE_MS);
  if (!Number.isInteger(effectiveIdleMs) || effectiveIdleMs < 0 || effectiveIdleMs > 300_000) throw new TypeError('Invalid pool idle timeout');
  const clientFactory = createClient ?? (options => new ImapFlow(options));
  const active = new WeakSet();
  const idlePool = new Map();
  let poolClosed = false;

  function poolKey(account, options) {
    const authSecret = String(options?.auth?.accessToken ?? options?.auth?.pass ?? '');
    return createHash('sha256').update(JSON.stringify([
      account?.id ?? '', account?.revision ?? 0, options?.host ?? '', options?.port ?? 993,
      options?.auth?.user ?? '', authSecret
    ])).digest('hex');
  }

  function removeIdle(conn) {
    if (conn.idleTimer) { clearTimeout(conn.idleTimer); conn.idleTimer = null; }
    const list = idlePool.get(conn.key);
    if (list) {
      const idx = list.indexOf(conn);
      if (idx !== -1) list.splice(idx, 1);
      if (!list.length) idlePool.delete(conn.key);
    }
  }

  function destroyConn(conn) {
    if (!conn || conn.destroyed) return;
    conn.destroyed = true;
    conn.broken = true;
    removeIdle(conn);
    active.delete(conn.client);
    // close() never sends CLOSE, EXPUNGE or any mailbox mutation.
    try { conn.client?.close(); } catch { /* Do not reveal library/server errors. */ }
  }

  function buildConn(options, key, accountId) {
    const client = clientFactory({
      ...options, secure: true, logger: false, emitLogs: false, logRaw: false, disableAutoIdle: true,
      tls: { ...options.tls, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000
    });
    const conn = { client, key, accountId, createdAt: Date.now(), returnedAt: 0, broken: false, destroyed: false, probing: false, idleTimer: null, ctx: null };
    if (typeof client.exec === 'function') {
      const execute = client.exec;
      client.exec = async function (command, ...args) {
        const ctx = conn.ctx;
        const sequence = ctx ? ++ctx.commandSequence : 0;
        const knownCommand = DIAGNOSTIC_COMMANDS.has(command) ? command : null;
        if (ctx) { ctx.currentCommand = knownCommand; ctx.diagnostic = null; }
        try { return await execute.call(this, command, ...args); }
        catch (error) {
          if (ctx && !ctx.stopped && sequence === ctx.commandSequence) ctx.diagnostic = mailboxDiagnostic(error, knownCommand);
          throw error;
        } finally { if (ctx && sequence === ctx.commandSequence) ctx.currentCommand = null; }
      };
    }
    if (typeof client.on === 'function') {
      // Keep this handler attached until the object is collected, including late socket errors after close().
      client.on('error', error => {
        conn.broken = true;
        if (conn.probing) return;
        const ctx = conn.ctx;
        if (ctx) {
          if (!ctx.stopped) ctx.diagnostic = mailboxDiagnostic(error, ctx.currentCommand);
          ctx.stop(error?.authenticationFailed ? 'mailbox_login_required' : 'mailbox_error');
        } else {
          destroyConn(conn);
        }
      });
      client.on('close', () => {
        conn.broken = true;
        if (!conn.ctx && !conn.probing) removeIdle(conn);
      });
    }
    return conn;
  }

  async function checkoutIdle(key, accountId, signal) {
    if (effectiveIdleMs <= 0 || poolClosed) return null;
    if (accountId) {
      for (const [otherKey, entries] of [...idlePool.entries()]) {
        if (otherKey !== key && entries.some(entry => entry.accountId === accountId)) {
          for (const entry of [...entries]) if (entry.accountId === accountId) destroyConn(entry);
        }
      }
    }
    const entries = idlePool.get(key);
    while (entries?.length) {
      const conn = entries.pop();
      if (!entries.length) idlePool.delete(key);
      if (conn.idleTimer) { clearTimeout(conn.idleTimer); conn.idleTimer = null; }
      const now = Date.now();
      if (conn.broken || conn.destroyed || conn.client.usable === false || conn.client.closed ||
          now - conn.createdAt >= POOL_MAX_AGE_MS) {
        destroyConn(conn);
        continue;
      }
      if (now - conn.returnedAt >= POOL_PROBE_IDLE_MS && typeof conn.client.noop === 'function') {
        conn.probing = true;
        try {
          await conn.client.noop();
          abortCheck(signal);
        } catch (error) {
          conn.probing = false;
          destroyConn(conn);
          if (error instanceof MailHarborError && error.code === 'cancelled') throw error;
          continue;
        }
        conn.probing = false;
        if (conn.broken || conn.destroyed || conn.client.usable === false || conn.client.closed) {
          destroyConn(conn);
          continue;
        }
      }
      return conn;
    }
    return null;
  }

  async function session(account, signal, operation) {
    abortCheck(signal);
    let conn = null, timer, completed = false;
    let rejectStop;
    const stopPromise = new Promise((_, reject) => { rejectStop = reject; });
    const ctx = {
      stopped: false,
      diagnostic: null,
      currentCommand: null,
      commandSequence: 0,
      stop(code) {
        if (ctx.stopped) return;
        if (code === 'mailbox_timeout') ctx.diagnostic = mailboxDiagnostic({ code }, ctx.currentCommand);
        ctx.stopped = true;
        if (conn) { conn.ctx = null; destroyConn(conn); }
        rejectStop(new MailHarborError(code, messages[code]));
      }
    };
    const onAbort = () => ctx.stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => ctx.stop('mailbox_timeout'), sessionTimeoutMs);
    timer.unref?.();
    const work = async () => {
      const options = await connectionOptions(account);
      abortCheck(signal);
      if (ctx.stopped) fail('mailbox_error');
      const key = poolKey(account, options);
      const reused = await checkoutIdle(key, account?.id, signal);
      abortCheck(signal);
      if (ctx.stopped) { if (reused) destroyConn(reused); fail('mailbox_error'); }
      conn = reused ?? buildConn(options, key, account?.id);
      conn.ctx = ctx;
      active.add(conn.client);
      if (!reused) {
        await conn.client.connect();
        abortCheck(signal);
        if (ctx.stopped) fail('mailbox_error');
      }
      const value = await operation(conn.client);
      completed = true;
      return value;
    };
    try { return await Promise.race([work(), stopPromise]); }
    catch (error) { throw sanitized(error, ctx.diagnostic ?? mailboxDiagnostic(error, ctx.currentCommand)); }
    finally {
      ctx.stopped = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (conn) {
        conn.ctx = null;
        active.delete(conn.client);
        const canPool = completed && !conn.broken && !conn.destroyed && !poolClosed &&
          effectiveIdleMs > 0 && conn.client.usable !== false && !conn.client.closed &&
          !conn.client.currentLock && !conn.client.locks?.length &&
          Date.now() - conn.createdAt < POOL_MAX_AGE_MS;
        if (canPool) {
          conn.returnedAt = Date.now();
          let list = idlePool.get(conn.key);
          if (!list) { list = []; idlePool.set(conn.key, list); }
          while (list.length >= POOL_MAX_PER_KEY) destroyConn(list.shift());
          conn.idleTimer = setTimeout(() => destroyConn(conn), effectiveIdleMs);
          conn.idleTimer.unref?.();
          list.push(conn);
        } else {
          destroyConn(conn);
        }
      }
    }
  }

  function close() {
    poolClosed = true;
    for (const entries of [...idlePool.values()]) {
      for (const entry of [...entries]) destroyConn(entry);
    }
    idlePool.clear();
  }

  return { session, active, close };
}

export { clean as cleanMailText, has as hasMailFlag, fingerprint as mailFingerprint,
  timestamp as mailTimestamp, preferredPart as preferredMailPart, selectable as selectableMailbox };

/** Private, persistless mailbox access. All public errors exclude provider response text. */
export function createMailboxService({ connectionOptions, createClient, now = () => Date.now(), sessionTimeoutMs = SESSION_TIMEOUT, poolIdleMs }) {
  const { session, active, close } = createMailboxSession({ connectionOptions, createClient, sessionTimeoutMs, poolIdleMs });

  async function inbox(client, readOnly, operation) {
    const lock = await client.getMailboxLock('INBOX', { readOnly });
    try { return await operation(mailboxValidity(client)); }
    finally { lock.release(); }
  }

  async function test(account, { signal } = {}) {
    return session(account, signal, async client => {
      const folders = await client.list();
      const target = archiveTarget(client, folders, account);
      await inbox(client, true, async () => {});
      return { archivePath: target?.path ?? null,
        folders: folders.filter(selectable).slice(0, 500).map(folder => ({ path: folder.path, specialUse: clean(folder.specialUse, 80) })) };
    });
  }

  async function scan(accounts, { signal, onProgress = () => {} } = {}) {
    const candidates = [];
    const started = now();
    const createdAt = new Date(started).toISOString();
    const midnight = Math.floor(started / DAY) * DAY;
    let totalUnread = 0, inboxCount = 0, checked = 0, read = 0;
    const report = phase => onProgress({ phase, checked, totalUnread, inboxCount, read, total: Math.min(BATCH_SIZE, candidates.length) });
    for (const account of accounts) {
      await session(account, signal, client => inbox(client, true, async uidValidity => {
        inboxCount++;
        report('headers');
        const found = await client.search({ seen: false, deleted: false }, { uid: true });
        abortCheck(signal);
        if (!Array.isArray(found)) fail('mailbox_error');
        if (found.some(uid => !validUid(uid))) fail('mailbox_error');
        const initial = new Set(found), fetched = new Set();
        totalUnread += initial.size;
        report('headers');
        async function headers(uids) {
          for (let offset = 0; offset < uids.length; offset += HEADER_CHUNK) {
            abortCheck(signal);
            const chunk = uids.slice(offset, offset + HEADER_CHUNK);
            const requested = new Set(chunk), received = new Set();
            // No further IMAP command may run inside this iterator.
            for await (const message of client.fetch(chunk.join(','), query, { uid: true })) {
              abortCheck(signal);
              if (!requested.has(message.uid) || received.has(message.uid)) continue;
              received.add(message.uid);
              checked++;
              if (!unread(message) || !message.envelope) continue;
              candidates.push({ accountId: account.id, uid: message.uid, uidValidity, fingerprint: fingerprint(message), time: timestamp(message) });
              candidates.sort((a, b) => b.time - a.time || String(a.accountId).localeCompare(String(b.accountId)) || b.uid - a.uid);
              if (candidates.length > BATCH_SIZE + 1) candidates.pop();
            }
            // A UID missing from this FETCH has left the snapshot; do not refetch it in wider windows.
            for (const uid of chunk) fetched.add(uid);
            report('headers');
          }
        }

        // Small inboxes need only one header FETCH. Large ones use indexed date searches
        // before downloading envelopes; original unread UIDs remain the snapshot boundary.
        if (initial.size > HEADER_CHUNK) {
          for (const days of SEARCH_WINDOWS_DAYS) {
            abortCheck(signal);
            const cutoff = midnight - days * DAY;
            const date = new Date(cutoff);
            report('headers');
            // Keep the original unread snapshot even if a flag changes during a window SEARCH.
            const recent = await client.search({ or: [{ sentSince: date }, { since: date }] }, { uid: true });
            abortCheck(signal);
            // If the server cannot execute a date search, retain the complete-header fallback.
            if (!Array.isArray(recent)) break;
            if (recent.some(uid => !validUid(uid))) fail('mailbox_error');
            const next = [...new Set(recent)].filter(uid => initial.has(uid) && !fetched.has(uid));
            await headers(next);
            if (fetched.size === initial.size) break;
            // Under standard Date/INTERNALDATE semantics, excluded messages are older
            // than this bound. Strict comparison also preserves timestamp tie handling.
            // WITHIN-capable servers use YOUNGER for since; normal clock synchronization
            // between this process and the mailbox server is assumed.
            // Arbitrarily malformed headers can disagree with a provider's SEARCH parser;
            // that pre-existing parser ambiguity cannot be proved away without all headers.
            if (candidates.length >= BATCH_SIZE && candidates[BATCH_SIZE - 1].time > cutoff + SEARCH_DATE_MARGIN) return;
          }
        }
        await headers([...initial].filter(uid => !fetched.has(uid)));
        report('headers');
      }));
    }
    const selected = candidates.slice(0, BATCH_SIZE), output = new Map(), references = new Map();
    const unavailable = () => ({ body: '', truncated: false, bodyUnavailable: true });
    for (const account of accounts) {
      const accountMessages = selected.filter(candidate => candidate.accountId === account.id);
      if (!accountMessages.length) continue;
      await session(account, signal, client => inbox(client, true, async uidValidity => {
        if (accountMessages.some(candidate => candidate.uidValidity !== uidValidity)) fail('stale_message');
        const expected = new Map(accountMessages.map(candidate => [candidate.uid, candidate]));
        const metadata = new Map();
        report('bodies');
        // Fetch all selected metadata together. Finish the iterator before requesting any body.
        for await (const message of client.fetch([...expected.keys()].join(','), { ...query, bodyStructure: true }, { uid: true })) {
          abortCheck(signal);
          const candidate = expected.get(message?.uid);
          if (!candidate || metadata.has(message.uid) || !unread(message) || fingerprint(message) !== candidate.fingerprint) continue;
          metadata.set(message.uid, { candidate, message, part: preferredPart(message.bodyStructure) });
        }
        abortCheck(signal);
        if (mailboxValidity(client) !== uidValidity) fail('stale_message');
        const publish = (candidate, message, body) => {
          const id = randomUUID();
          const value = {
            id, account: clean(account.email || account.label || account.id),
            author: clean((message.envelope?.from ?? []).map(value => value.name ? `${value.name} <${value.address ?? ''}>` : value.address ?? '').join(', ')),
            subject: clean(message.envelope?.subject), date: candidate.time ? new Date(candidate.time).toISOString() : '',
            // Briefings have a separate strict wire schema from durable processing diagnostics.
            body: body.body, truncated: body.truncated, bodyUnavailable: body.bodyUnavailable
          };
          output.set(candidate, value);
          references.set(id, { accountId: account.id, uid: candidate.uid, uidValidity, fingerprint: candidate.fingerprint });
          read++;
          report('bodies');
        };
        const groups = new Map();
        for (const entry of metadata.values()) {
          if (!entry.part) { publish(entry.candidate, entry.message, unavailable()); continue; }
          // A single-part root uses TEXT/HEADER; multipart nodes use numeric part/MIME.
          const section = entry.part.part === '1' && !entry.message.bodyStructure?.childNodes ? 'text' : entry.part.part;
          if (!groups.has(section)) groups.set(section, new Map());
          groups.get(section).set(entry.candidate.uid, entry);
        }
        for (const [section, entries] of groups) {
          abortCheck(signal);
          const mimeSection = section === 'text' ? 'header' : `${section}.mime`;
          const bodies = new Map();
          // Only messages choosing this exact section enter this FETCH, so another
          // message's attachment cannot be fetched just because it has the same part number.
          for await (const message of client.fetch([...entries.keys()].join(','), { ...query, bodyParts: [
            { key: mimeSection, start: 0, maxLength: MIME_BYTES },
            { key: section, start: 0, maxLength: BODY_BYTES }
          ] }, { uid: true, binary: false })) {
            abortCheck(signal);
            const entry = entries.get(message?.uid);
            if (!entry || bodies.has(message.uid) || !unread(message) || fingerprint(message) !== entry.candidate.fingerprint) continue;
            const parts = message.bodyParts instanceof Map ? message.bodyParts : new Map();
            bodies.set(message.uid, { ...entry, message,
              raw: has(message.binaryParts, section) ? undefined : parts.get(section),
              mime: section === 'text' ? message.headers : parts.get(mimeSection) });
          }
          abortCheck(signal);
          if (mailboxValidity(client) !== uidValidity) fail('stale_message');
          // Decode locally after the iterator closes; network work never nests inside it.
          for (const entry of bodies.values()) {
            abortCheck(signal);
            const body = await decodeBody({ raw: entry.raw, mime: entry.mime, part: entry.part });
            abortCheck(signal);
            publish(entry.candidate, entry.message, body);
          }
        }
      }));
    }
    return { messages: selected.flatMap(candidate => output.has(candidate) ? [output.get(candidate)] : []), references,
      totalUnread, inboxCount, truncated: totalUnread > output.size, createdAt };
  }

  async function apply(accounts, references, ids, action, { signal } = {}) {
    if (!(references instanceof Map) || !Array.isArray(ids) || ids.length > BATCH_SIZE ||
      new Set(ids).size !== ids.length || !['archive', 'mark_read'].includes(action)) fail('invalid_request');
    const applied = [], failed = [];
    for (const id of ids) {
      try {
        abortCheck(signal);
        const reference = references.get(id);
        const account = reference && accounts.find(account => account.id === reference.accountId);
        if (!account || !validUid(reference.uid)) fail('stale_message');
        await session(account, signal, async client => {
          const target = action === 'archive' ? archiveTarget(client, await client.list(), account) : null;
          if (action === 'archive' && !target) fail('archive_unavailable');
          return inbox(client, false, async uidValidity => {
            if (client.mailbox.readOnly || uidValidity !== reference.uidValidity) fail('stale_message');
            const message = await client.fetchOne(String(reference.uid), { ...query, labels: client.capabilities?.has('X-GM-EXT-1') === true }, { uid: true });
            if (!unread(message) || message.uid !== reference.uid || fingerprint(message) !== reference.fingerprint) fail('stale_message');
            abortCheck(signal);
            if (!active.has(client)) fail('mailbox_error');
            if (client.capabilities?.has('X-GM-EXT-1') && !has(message.labels, '\\Inbox')) fail('stale_message');
            let result;
            if (action === 'mark_read') result = await client.messageFlagsAdd(String(reference.uid), ['\\Seen'], { uid: true });
            else if (target.gmail) {
              result = await client.messageFlagsRemove(String(reference.uid), ['\\Inbox'], { uid: true, useLabels: true });
            } else {
              // Check again immediately before calling a library method that has a destructive fallback.
              if (!client.capabilities?.has('MOVE')) fail('archive_unavailable');
              result = await client.messageMove(String(reference.uid), target.path, { uid: true });
            }
            if (!result) fail('mailbox_error');
          });
        });
        references.delete(id);
        applied.push(id);
      } catch (error) {
        const safe = sanitized(error);
        failed.push({ id, code: safe.code });
        if (safe.code === 'cancelled') {
          for (const remaining of ids.slice(applied.length + failed.length)) failed.push({ id: remaining, code: 'cancelled' });
          break;
        }
      }
    }
    return { applied, failed };
  }

  return { test, scan, apply, close };
}
