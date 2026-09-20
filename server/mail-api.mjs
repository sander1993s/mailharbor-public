import { MAX_ACCOUNTS } from './providers.mjs';
import { randomBytes } from 'node:crypto';
import { MailHarborError, safeError } from './validation.mjs';
import { MAIL_TAGS } from './mail-tags.mjs';
import { generateAppointmentIcs } from './mail-calendar.mjs';
import { validAttachmentId, MAX_ATTACHMENT_BYTES } from './mail-attachments.mjs';

export const MAIL_FOLDERS = Object.freeze([
  ['inbox', 'Inbox'], ['unread', 'Unread'], ['starred', 'Starred'], ['sent', 'Sent'],
  ['drafts', 'Drafts'], ['archive', 'Archive'], ['junk', 'Spam'], ['trash', 'Trash']
].map(([id, label]) => Object.freeze({ id, label })));
const FOLDERS = new Set([...MAIL_FOLDERS.map(value => value.id), 'all']);
const ACTIONS = new Set(['mark_read', 'mark_unread', 'star', 'unstar', 'delete', 'archive', 'move', 'restore', 'spam', 'not_spam', 'delete_permanent']);
const MOVES = new Set(['delete', 'archive', 'move', 'restore', 'spam', 'not_spam', 'delete_permanent']);
const providerFolder = value => typeof value === 'string' && /^folder:[a-f0-9]{64}$/u.test(value);
const fail = code => { throw new MailHarborError(code); };
const token = () => randomBytes(24).toString('base64url');
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const validUid = uid => Number.isSafeInteger(uid) && uid > 0 && uid <= 0xffffffff;
const BASE_MESSAGE_KEYS = [
  'id', 'accountId', 'account', 'folderPath', 'subject', 'author', 'to', 'date',
  'unread', 'starred', 'cc', 'replyTo', 'messageId', 'inReplyTo', 'references',
  'threadId', 'size', 'hasAttachments', 'providerLabels'
];
function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const result = [];
  for (const item of list) {
    if (result.length >= 100) break;
    if (!item || typeof item !== 'object' || !validAttachmentId(item.id)) continue;
    const filename = typeof item.filename === 'string'
      ? item.filename.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 500)
      : '';
    const mimeType = typeof item.mimeType === 'string'
      ? item.mimeType.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 200)
      : '';
    const size = Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null;
    result.push({ id: item.id, filename, mimeType, size });
  }
  return result;
}
function publicMessage(value) {
  if (!value || typeof value !== 'object') return {};
  const msg = {};
  for (const key of BASE_MESSAGE_KEYS) {
    if (value[key] !== undefined) msg[key] = value[key];
  }
  if (typeof value.snippet === 'string') {
    msg.snippet = value.snippet.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 500);
  }
  if (Array.isArray(value.attachments)) {
    msg.attachments = sanitizeAttachments(value.attachments);
  }
  return msg;
}
function extractListMetadata(data, scope) {
  const meta = {};
  const src = data?.source ?? data?.cache?.source;
  if (src === 'cache' || src === 'provider') meta.source = src;

  const pf = data?.providerFallback ?? data?.cache?.providerFallback;
  if (typeof pf === 'boolean') meta.providerFallback = pf;

  const rawCoverage = data?.coverage ?? data?.cache?.coverage;
  if (rawCoverage && typeof rawCoverage === 'object' && !Array.isArray(rawCoverage)) {
    const status = rawCoverage.status;
    if (['warming', 'partial', 'complete'].includes(status)) {
      const cached = Number.isSafeInteger(rawCoverage.cached) && rawCoverage.cached >= 0 ? rawCoverage.cached : 0;
      const limited = rawCoverage.limited === true;
      const rawAccounts = Array.isArray(rawCoverage.accountIds) ? rawCoverage.accountIds : [];
      const accountIds = [...new Set(rawAccounts.filter(id => typeof id === 'string' && scope.includes(id)))];
      const rawMissing = Array.isArray(rawCoverage.missingAccountIds) ? rawCoverage.missingAccountIds : [];
      const missingAccountIds = [...new Set(rawMissing.filter(id => typeof id === 'string' && scope.includes(id)))];
      meta.coverage = { status, cached, limited, accountIds, missingAccountIds };
    }
  }

  const sync = data?.lastSuccessfulSync !== undefined ? data.lastSuccessfulSync : data?.cache?.lastSuccessfulSync;
  if (sync === null) {
    meta.lastSuccessfulSync = null;
  } else if (Number.isSafeInteger(sync) && sync >= 0 && sync <= 8640000000000000) {
    meta.lastSuccessfulSync = sync;
  }

  const refreshing = data?.refreshing ?? data?.cache?.refreshing;
  if (typeof refreshing === 'boolean') meta.refreshing = refreshing;

  const rev = data?.revision ?? data?.cache?.revision;
  if (typeof rev === 'string' && rev.length > 0 && rev.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(rev)) {
    meta.revision = rev;
  }

  return meta;
}
const errors = values => (values ?? []).map(value => ({ accountId: value.accountId, code: safeError({ code: value.code }).code }));
function object(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('invalid_request');
}

/** Owner-scoped, short-lived browsing references. No mail bodies or cursors persist to disk. */
export function createMailApi({ accounts, reader, tags, processing, conversations, now = () => Date.now(), retentionMs = 900000 }) {
  const records = new Map(), pages = new Map(), conversationCursors = new Map(), operations = new Set(), writes = new Set(), undos = new Map();
  let closed = false;
  let deletionVersion = 0;
  const retention = Math.min(900000, Math.max(1000, retentionMs));
  const tagDefinitions = () => tags?.definitions?.() ?? MAIL_TAGS;
  const tagForFolder = folder => tagDefinitions().find(tag => `tag:${tag.id}` === folder);
  const writeKey = (account, reference) => JSON.stringify([account.id, (account.email ?? '').trim().toLowerCase(), reference.fingerprint]);
  const withTags = (message, account, reference) => ({ ...publicMessage(message), tags: tags?.tagsFor(account, reference) ?? [] });
  function tagFolders(current) {
    return tagDefinitions().map(tag => ({ id: `tag:${tag.id}`, label: tag.label, type: 'tag',
      accountIds: current.map(account => account.id),
      counts: current.map(account => ({ accountId: account.id, total: tags?.count?.([account], { tag: tag.id }) ?? tags?.entries([account], { tag: tag.id }).length ?? 0 })) }));
  }
  function expire() {
    for (const [id, value] of records) if (value.expires <= now()) records.delete(id);
    for (const [id, value] of pages) if (value.expires <= now()) pages.delete(id);
    for (const [id, value] of conversationCursors) if (value.expires <= now()) conversationCursors.delete(id);
    for (const [id, value] of undos) if (value.expires <= now()) undos.delete(id);
  }
  function boundedSet(map, key, value, maximum) {
    map.delete(key); map.set(key, value);
    while (map.size > maximum) map.delete(map.keys().next().value);
  }
  function selected(ids) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ACCOUNTS || new Set(ids).size !== ids.length || ids.some(id => !validId(id)))) fail('invalid_request');
    return (ids ?? accounts.list().filter(value => value.connected).map(value => value.id)).map(id => accounts.get(id)).sort((a, b) => a.id.localeCompare(b.id));
  }
  const versions = values => values.map(value => [value.id, value.revision]);
  function unchanged(revisions) {
    for (const [id, revision] of revisions) {
      let current;
      try { current = accounts.get(id); } catch { fail('stale_message'); }
      if (current.revision !== revision) fail('stale_message');
    }
  }
  function remember(message, current, labels) {
    if (!validId(message.id) || !message.reference || message.reference.accountId !== message.accountId) fail('mailbox_error');
    const account = current.find(value => value.id === message.accountId);
    if (!account) fail('mailbox_error');
    const decorated = labels ? { ...publicMessage(message), tags: labels } : withTags(message, account, message.reference);
    boundedSet(records, message.id, {
      message: decorated, reference: structuredClone(message.reference),
      revision: account.revision, expires: now() + retention
    }, 5000);
    return decorated;
  }
  function record(id) {
    if (closed) fail('busy');
    if (!validId(id)) fail('invalid_request');
    expire();
    const value = records.get(id);
    if (!value) fail('stale_message');
    unchanged([[value.reference.accountId, value.revision]]);
    return value;
  }
  async function run(current, work, externalSignal) {
    if (externalSignal?.aborted) fail('cancelled');
    if (closed || operations.size >= 4) fail('busy');
    const controller = new AbortController();
    const entry = { controller, accountIds: current.map(value => value.id), promise: null };
    const revisions = versions(current);
    operations.add(entry);
    const timer = setTimeout(() => controller.abort(new MailHarborError('mailbox_timeout')), 180000);
    timer.unref?.();

    let onExternalAbort = null;
    let onControllerAbort = null;
    let externalAbortPromise = null;

    if (externalSignal) {
      externalAbortPromise = new Promise((_, reject) => {
        onExternalAbort = () => {
          if (!controller.signal.aborted) {
            controller.abort(new MailHarborError('cancelled'));
          }
        };
        onControllerAbort = () => reject(controller.signal.reason);
        if (controller.signal.aborted) {
          onControllerAbort();
        } else {
          controller.signal.addEventListener('abort', onControllerAbort, { once: true });
        }
        if (externalSignal.aborted) {
          onExternalAbort();
        } else {
          externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
      });
    }

    const workPromise = (async () => {
      let value;
      try { value = await work(controller.signal); }
      catch (error) {
        // IMAP teardown reports cancellation; preserve the API's disconnect or deadline reason.
        throw controller.signal.aborted ? controller.signal.reason : error;
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (closed) fail('busy');
      unchanged(revisions);
      return value;
    })();

    workPromise.catch(() => {});
    const activePromise = externalAbortPromise ? Promise.race([workPromise, externalAbortPromise]) : workPromise;
    activePromise.catch(() => {});
    entry.promise = activePromise;

    try { return await entry.promise; }
    finally {
      clearTimeout(timer);
      operations.delete(entry);
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      if (onControllerAbort) {
        controller.signal.removeEventListener('abort', onControllerAbort);
      }
    }
  }
  return {
    expire,
    resolve(id) { const value = record(id); return { account: accounts.get(value.reference.accountId), reference: structuredClone(value.reference) }; },
    invalidateMessage(id) {
      const value = records.get(id); if (!value) return;
      deletionVersion++; records.delete(id); pages.clear(); conversationCursors.clear();
      try { conversations?.clear?.(); } catch {}
      for (const [alias, saved] of records) if (saved.reference.accountId === value.reference.accountId && saved.reference.fingerprint === value.reference.fingerprint) records.delete(alias);
    },
    async withMessage(input, work, { signal } = {}) {
      object(input, ['id']);
      if (signal?.aborted) fail('cancelled');
      const value = record(input.id), account = accounts.get(value.reference.accountId), version = deletionVersion;
      const result = await run([account], opSignal => work(account, structuredClone(value.reference), opSignal), signal);
      if (version !== deletionVersion) fail('stale_message');
      return result;
    },
    async folders() {
      if (closed) fail('busy');
      const current = selected();
      const data = current.length ? await run(current, signal => reader.folders(current, { signal })) : { folders: [], errors: [] };
      return {
        folders: [...MAIL_FOLDERS.map(folder => {
          const value = data.folders.find(value => value.id === folder.id);
          const accountIds = value?.accountIds ?? [];
          return { ...folder, accountIds, counts: accountIds.map(accountId => ({ accountId,
            total: Number.isSafeInteger(value?.counts?.find(count => count.accountId === accountId)?.total) && value.counts.find(count => count.accountId === accountId).total >= 0
              ? value.counts.find(count => count.accountId === accountId).total : null })) };
        }), ...data.folders.filter(folder => folder.id === 'all' || providerFolder(folder.id)).map(folder => ({
          id: folder.id, label: folder.label, type: folder.id === 'all' ? 'standard' : 'provider', accountIds: folder.accountIds,
          counts: folder.counts ?? [], specialUse: folder.specialUse ?? null, path: folder.path ?? null
        })), ...tagFolders(current)],
        errors: errors(data.errors),
        accounts: accounts.list().map(({ id, email, label, connected }) => ({ id, email, label, connected }))
      };
    },
    async list(input, { signal } = {}) {
      if (closed) fail('busy');
      object(input, ['folder', 'accountIds', 'query', 'cursor', 'filters', 'sort', 'bodySearch', 'live']);
      const tag = tagForFolder(input.folder);
      if ((!FOLDERS.has(input.folder) && !tag && !providerFolder(input.folder)) || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 200 || /[\u0000-\u001f\u007f]/u.test(input.query)))) fail('invalid_request');
      if (input.sort !== undefined && !['date_desc', 'date_asc', 'subject_asc', 'sender_asc'].includes(input.sort)) fail('invalid_request');
      if (input.bodySearch !== undefined && typeof input.bodySearch !== 'boolean') fail('invalid_request');
      if (input.live !== undefined && typeof input.live !== 'boolean') fail('invalid_request');
      const live = input.live === true;
      const filters = input.filters ?? {};
      object(filters, ['from', 'to', 'subject', 'body', 'since', 'before', 'unread', 'starred', 'hasAttachment', 'minSize', 'maxSize']);
      for (const [key, value] of Object.entries(filters)) {
        if (['unread', 'starred', 'hasAttachment'].includes(key)) { if (typeof value !== 'boolean') fail('invalid_request'); }
        else if (['minSize', 'maxSize'].includes(key)) { if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail('invalid_request'); }
        else if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/u.test(value)) fail('invalid_request');
        else if (['since', 'before'].includes(key) && (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) fail('invalid_request');
      }
      if ((filters.minSize != null && filters.maxSize != null && filters.minSize > filters.maxSize) ||
        (filters.since && filters.before && filters.since >= filters.before)) fail('invalid_request');
      const view = JSON.stringify([input.sort ?? 'date_desc', input.bodySearch ?? false, live, Object.fromEntries(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)))]);
      if (input.cursor !== undefined && input.cursor !== null && (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(input.cursor))) fail('invalid_request');
      if (signal?.aborted) fail('cancelled');
      expire();
      const current = selected(input.accountIds), scope = current.map(value => value.id);
      const version = deletionVersion;
      const query = (input.query ?? '').trim();
      let state = null;
      if (input.cursor) {
        const page = pages.get(input.cursor);
        if (!page || page.folder !== input.folder || page.query !== query || page.view !== view || JSON.stringify(page.accountIds) !== JSON.stringify(scope)) fail('stale_message');
        unchanged(page.revisions);
        state = structuredClone(page.state);
      }
      if (!current.length) return { folder: input.folder, messages: [], nextCursor: null, errors: [], total: 0, totalComplete: true };
      let data;
      if (tag) {
        const labelVersion = tags?.version() ?? 0, advanced = Object.keys(filters).length > 0 || input.bodySearch;
        if (state && (state.kind !== (advanced ? 'tag-search' : 'tag') || state.version !== labelVersion ||
          (!advanced && (!Number.isSafeInteger(state.offset) || state.offset < 0)))) fail('stale_message');
        const entries = tags?.entries(current, { tag: tag.id, query: advanced ? '' : query }) ?? [];
        if (advanced) {
          data = await run(current, async opSignal => {
            const result = entries.length ? await reader.list(current, { folder: 'all', query, filters, bodySearch: input.bodySearch ?? false,
              sort: input.sort ?? 'date_desc', cursor: state?.reader ?? null, limit: 50, scopedReferences: entries.map(entry => entry.reference), signal: opSignal, live, includeAttachments: true }) :
              { messages: [], total: 0, totalComplete: true, errors: [], nextCursor: null };
            if (labelVersion !== tags?.version()) fail('stale_message');
            const known = new Map(entries.map(entry => [writeKey(current.find(account => account.id === entry.reference.accountId), entry.reference), entry]));
            const matched = result.messages.map(message => {
              const account = current.find(value => value.id === message.accountId), saved = account && known.get(writeKey(account, message.reference));
              if (!saved) fail('mailbox_error');
              return { ...message, id: saved.message.id };
            });
            if (opSignal.aborted) throw opSignal.reason;
            const observed = await tags?.observe(current, matched, { verify: () => {
              if (opSignal.aborted) throw opSignal.reason;
              if (version !== deletionVersion || labelVersion !== tags.version()) fail('stale_message');
              unchanged(versions(current));
            } });
            if (observed?.changed === false && labelVersion !== tags?.version()) fail('stale_message');
            if (version !== deletionVersion) fail('stale_message');
            return { ...result, messages: matched, nextCursor: result.nextCursor ? { kind: 'tag-search', version: tags?.version() ?? 0, reader: result.nextCursor } : null };
          }, signal);
        } else {
          if (input.sort && input.sort !== 'date_desc') entries.sort((a, b) => (input.sort === 'date_asc' ? (Date.parse(a.message.date) || 0) - (Date.parse(b.message.date) || 0) :
            String(a.message[input.sort === 'subject_asc' ? 'subject' : 'author'] ?? '').toLowerCase().localeCompare(String(b.message[input.sort === 'subject_asc' ? 'subject' : 'author'] ?? '').toLowerCase())) || a.message.id.localeCompare(b.message.id));
          const offset = state?.offset ?? 0;
          data = { messages: entries.slice(offset, offset + 50).map(entry => ({ ...entry.message, reference: entry.reference })),
            nextCursor: offset + 50 < entries.length ? { kind: 'tag', version: labelVersion, offset: offset + 50 } : null,
            errors: [], total: entries.length, totalComplete: true };
        }
      } else {
        data = await run(current, async opSignal => {
          const result = await reader.list(current, { folder: input.folder, query, cursor: state, limit: 50, signal: opSignal, filters, sort: input.sort ?? 'date_desc', bodySearch: input.bodySearch ?? false, live, includeAttachments: true });
          if (opSignal.aborted) throw opSignal.reason;
          await tags?.observe(current, result.messages, { verify: () => {
            if (opSignal.aborted) throw opSignal.reason;
            if (version !== deletionVersion) fail('stale_message');
            unchanged(versions(current));
          } });
          return result;
        }, signal);
      }
      if (version !== deletionVersion) fail('stale_message');
      const labels = tags?.tagsForMany(current, data.messages);
      const messages = data.messages.map((value, index) => remember(value, current, labels?.[index]));
      let nextCursor = null;
      if (data.nextCursor) {
        nextCursor = token();
        boundedSet(pages, nextCursor, {
          state: structuredClone(data.nextCursor), folder: input.folder, query, view, accountIds: scope,
          revisions: versions(current), expires: now() + retention
        }, 100);
      }
      const metadata = extractListMetadata(data, scope);
      return { folder: input.folder, messages, nextCursor, errors: errors(data.errors),
        total: Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : null,
        totalComplete: data.totalComplete === true,
        ...metadata };
    },
    async read(input, { signal } = {}) {
      object(input, ['id']);
      if (signal?.aborted) fail('cancelled');
      const value = record(input.id), account = accounts.get(value.reference.accountId);
      const version = deletionVersion;
      const data = await run([account], async opSignal => {
        const result = await reader.read(account, value.reference, { signal: opSignal });
        if (version !== deletionVersion) fail('stale_message');
        if (opSignal.aborted) throw opSignal.reason;
        await tags?.observe([account], [{ ...value.message, ...result, reference: result.reference ?? value.reference }], { verify: () => {
          if (opSignal.aborted) throw opSignal.reason;
          if (version !== deletionVersion) fail('stale_message');
          unchanged([[account.id, account.revision]]);
        } });
        return result;
      }, signal);
      if (version !== deletionVersion) fail('stale_message');
      const message = { ...value.message, ...publicMessage(data), id: input.id };
      // Readers may return only body/flags; preserve metadata which was already validated at listing.
      for (const key of Object.keys(message)) if (message[key] === undefined) message[key] = value.message[key];
      message.tags = tags?.tagsFor(account, value.reference) ?? [];
      const attachments = sanitizeAttachments(data.attachments);
      records.set(input.id, { ...value, message: { ...message, attachments }, expires: now() + retention });
      return { message: { ...message, body: typeof data.body === 'string' ? data.body : '', truncated: data.truncated === true, bodyUnavailable: data.bodyUnavailable !== false,
        attachments,
        ...(processing?.appointment(account, value.reference) ? { appointment: processing.appointment(account, value.reference) } : {}) } };
    },
    async conversation(input, { signal } = {}) {
      if (!conversations || typeof conversations.load !== 'function') fail('mailbox_error');
      if (closed) fail('busy');
      object(input, ['id', 'cursor']);
      if (input.cursor !== undefined && input.cursor !== null && (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(input.cursor))) fail('invalid_request');
      if (signal?.aborted) fail('cancelled');
      const value = record(input.id);
      const account = accounts.get(value.reference.accountId);
      const version = deletionVersion;
      expire();
      let privateBackendCursor = null;
      if (input.cursor) {
        const entry = conversationCursors.get(input.cursor);
        if (!entry || entry.id !== input.id || entry.accountId !== account.id ||
            entry.revision !== account.revision || entry.deletionVersion !== version) fail('stale_message');
        const ref = entry.reference;
        if (!ref || ref.accountId !== value.reference.accountId || ref.path !== value.reference.path ||
            ref.uid !== value.reference.uid || String(ref.uidValidity) !== String(value.reference.uidValidity) ||
            ref.fingerprint !== value.reference.fingerprint) fail('stale_message');
        conversationCursors.delete(input.cursor);
        privateBackendCursor = entry.backendCursor;
      }

      const data = await run([account], async opSignal => {
        const result = await conversations.load(account, value.reference, { cursor: privateBackendCursor, signal: opSignal });
        if (version !== deletionVersion) fail('stale_message');
        if (!result || typeof result !== 'object') fail('mailbox_error');
        if (typeof result.complete !== 'boolean') fail('mailbox_error');

        if (result.nextCursor !== undefined && result.nextCursor !== null) {
          if (result.complete === true) fail('mailbox_error');
          if (typeof result.nextCursor !== 'string' || result.nextCursor.length < 1 || result.nextCursor.length > 500) {
            fail('mailbox_error');
          }
        }

        if (result.errors !== undefined && result.errors !== null) {
          if (!Array.isArray(result.errors) || result.errors.length > 1000) fail('mailbox_error');
          for (const err of result.errors) {
            if (!err || typeof err !== 'object') fail('mailbox_error');
            if (err.accountId !== undefined && err.accountId !== null && err.accountId !== account.id) {
              fail('mailbox_error');
            }
          }
        }

        if (!Array.isArray(result.messages) || result.messages.length > 500) fail('mailbox_error');
        const seenIds = new Set();
        const seenRefs = new Set();
        let selectedRepresented = false;
        for (const msg of result.messages) {
          if (!msg || typeof msg !== 'object') fail('mailbox_error');
          if (!validId(msg.id) || msg.accountId !== account.id) fail('mailbox_error');
          if (seenIds.has(msg.id)) fail('mailbox_error');
          seenIds.add(msg.id);

          const ref = msg.reference;
          if (!ref || typeof ref !== 'object') fail('mailbox_error');
          if (ref.accountId !== account.id ||
              !validUid(ref.uid) ||
              typeof ref.uidValidity !== 'string' || !/^\d{1,20}$/u.test(ref.uidValidity) ||
              typeof ref.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.fingerprint) ||
              typeof ref.path !== 'string' || !ref.path.length || ref.path.length > 1024 || /[\u0000-\u001f\u007f]/u.test(ref.path)) {
            fail('mailbox_error');
          }

          const refKey = `${ref.accountId}:${ref.path}:${ref.uid}:${ref.uidValidity}:${ref.fingerprint}`;
          if (seenRefs.has(refKey)) fail('mailbox_error');
          seenRefs.add(refKey);

          const existing = records.get(msg.id);
          if (existing) {
            if (existing.reference.accountId !== ref.accountId ||
                existing.reference.path !== ref.path ||
                existing.reference.uid !== ref.uid ||
                String(existing.reference.uidValidity) !== String(ref.uidValidity) ||
                existing.reference.fingerprint !== ref.fingerprint) {
              fail('mailbox_error');
            }
          }

          if (ref.accountId === value.reference.accountId &&
              ref.path === value.reference.path &&
              ref.uid === value.reference.uid &&
              String(ref.uidValidity) === String(value.reference.uidValidity) &&
              ref.fingerprint === value.reference.fingerprint) {
            selectedRepresented = true;
          }
        }
        if (!selectedRepresented) fail('mailbox_error');

        if (opSignal.aborted) throw opSignal.reason;
        await tags?.observe?.([account], result.messages, { verify: () => {
          if (opSignal.aborted) throw opSignal.reason;
          if (version !== deletionVersion) fail('stale_message');
          unchanged([[account.id, account.revision]]);
        } });

        const normalizedErrors = (result.errors ?? []).map(err => ({
          accountId: account.id,
          code: safeError({ code: err.code }).code
        }));

        return { ...result, errors: normalizedErrors };
      }, signal);

      if (version !== deletionVersion) fail('stale_message');
      const labels = tags?.tagsForMany?.([account], data.messages);
      const messages = data.messages.map((msg, index) => remember(msg, [account], labels?.[index]));

      let nextCursor = null;
      if (typeof data.nextCursor === 'string' && data.nextCursor.length > 0 && data.nextCursor.length <= 500) {
        nextCursor = token();
        boundedSet(conversationCursors, nextCursor, {
          backendCursor: data.nextCursor,
          id: input.id,
          accountId: account.id,
          revision: account.revision,
          deletionVersion: version,
          reference: structuredClone(value.reference),
          expires: now() + retention
        }, 100);
      }

      return {
        messages,
        complete: data.complete === true,
        nextCursor,
        errors: data.errors
      };
    },
    async attachment(input) {
      object(input, ['id', 'attachmentId']);
      if (!validAttachmentId(input.attachmentId)) fail('invalid_request');
      const value = record(input.id), account = accounts.get(value.reference.accountId), version = deletionVersion;
      const result = await run([account], signal => reader.attachment(account, value.reference, input.attachmentId, { signal }));
      if (version !== deletionVersion) fail('stale_message');
      if (!Buffer.isBuffer(result?.bytes) || typeof result.filename !== 'string') fail('attachment_unavailable');
      if (result.bytes.length > MAX_ATTACHMENT_BYTES) fail('attachment_too_large');
      return result;
    },
    calendar(input) {
      object(input, ['id']);
      const value = record(input.id), account = accounts.get(value.reference.accountId);
      const appointment = processing?.appointment(account, value.reference);
      if (!appointment) fail('not_found');
      return generateAppointmentIcs({ id: writeKey(account, value.reference), ...appointment });
    },
    async apply(input) {
      object(input, ['id', 'action', 'destinationId', 'confirm']);
      if (!ACTIONS.has(input.action)) fail('invalid_request');
      if (input.action === 'delete_permanent' && input.confirm !== true) fail('invalid_request');
      if (input.action === 'move' && !providerFolder(input.destinationId) && !['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash'].includes(input.destinationId)) fail('invalid_request');
      if (input.destinationId !== undefined && input.action !== 'move') fail('invalid_request');
      const value = record(input.id), account = accounts.get(value.reference.accountId);
      const key = writeKey(account, value.reference);
      if (writes.has(key)) fail('busy');
      writes.add(key);
      try {
        return await run([account], async signal => {
          const result = await reader.apply(account, value.reference, input.action, { signal, destinationId: input.destinationId });
          if (result?.applied !== true) fail('mailbox_error');
          if (MOVES.has(input.action)) {
            // Invalidate aliases and pending browse results as soon as the provider
            // confirms the move, even if later local cleanup fails.
            const invalidate = () => {
              deletionVersion++;
              for (const [id, saved] of records) if (saved.reference.accountId === account.id && writeKey(account, saved.reference) === key) records.delete(id);
              for (const [id, page] of pages) if (page.accountIds.includes(account.id)) pages.delete(id);
              for (const [id, conv] of conversationCursors) if (conv.accountId === account.id) conversationCursors.delete(id);
              try { conversations?.clear?.(); } catch {}
            };
            invalidate();
            // A tag list may have observed the old index while cleanup awaited its
            // transaction. Clear those aliases and late reads after cleanup too.
            try {
              if (['delete', 'delete_permanent', 'spam'].includes(input.action)) await tags?.forget(account, value.reference);
              else if (result.reference) await tags?.observe([account], [{ ...value.message, folderPath: result.reference.path, reference: result.reference }]);
            }
            finally { invalidate(); }
            let undoToken;
            if (result.undo?.reference && providerFolder(result.undo.destinationId)) {
              undoToken = token(); boundedSet(undos, undoToken, { accountId: account.id, revision: account.revision, ...result.undo, message: value.message, tags: value.message.tags ?? [], expires: now() + retention }, 100);
            }
            return { applied: true, ...(undoToken ? { undoToken } : {}) };
          }
          if (signal.aborted) throw signal.reason;
          if (input.action === 'mark_read') value.message.unread = false;
          if (input.action === 'mark_unread') value.message.unread = true;
          if (input.action === 'star') value.message.starred = true;
          if (input.action === 'unstar') value.message.starred = false;
          await tags?.observe([account], [{ ...value.message, reference: value.reference }], { verify: () => {
            if (signal.aborted) throw signal.reason;
            unchanged([[account.id, account.revision]]);
          } });
          return { applied: true };
        });
      } finally { writes.delete(key); }
    },
    async setTag(input) {
      object(input, ['id', 'tag', 'enabled']);
      if (!tagDefinitions().some(tag => tag.id === input.tag) || typeof input.enabled !== 'boolean' || !tags) fail('invalid_request');
      const value = record(input.id), account = accounts.get(value.reference.accountId);
      const key = writeKey(account, value.reference);
      if (writes.has(key)) fail('busy');
      writes.add(key);
      try {
        const result = await run([account], signal => tags.set({ account, message: value.message, reference: value.reference,
          tag: input.tag, enabled: input.enabled, verify: () => {
            if (signal.aborted) throw signal.reason;
            unchanged([[account.id, account.revision]]);
          } }));
        // Label copies can have different provider UIDs, so derive tags at read/list time.
        value.message.tags = result.tags;
        return { tags: result.tags, folders: tagFolders(selected()) };
      } finally { writes.delete(key); }
    },
    async bulk(input) {
      object(input, ['ids', 'action', 'destinationId', 'confirm', 'tag', 'enabled']);
      if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 50 || new Set(input.ids).size !== input.ids.length) fail('invalid_request');
      if (!ACTIONS.has(input.action) && input.action !== 'tag') fail('invalid_request');
      if (input.action === 'delete_permanent' && input.confirm !== true) fail('invalid_request');
      if (input.action === 'tag' && (typeof input.enabled !== 'boolean' || !tagDefinitions().some(tag => tag.id === input.tag))) fail('invalid_request');
      input.ids.forEach(record);
      const applied = [], failed = [], undoTokens = [];
      for (const id of input.ids) {
        try {
          const value = input.action === 'tag' ? await this.setTag({ id, tag: input.tag, enabled: input.enabled }) :
            await this.apply({ id, action: input.action, ...(input.destinationId ? { destinationId: input.destinationId } : {}), ...(input.confirm !== undefined ? { confirm: input.confirm } : {}) });
          applied.push(id); if (value.undoToken) undoTokens.push(value.undoToken);
        } catch (error) { failed.push({ id, ...safeError(error) }); }
      }
      return { applied, failed, undoTokens };
    },
    async undo(input) {
      object(input, ['token']); expire();
      if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(input.token)) fail('invalid_request');
      const value = undos.get(input.token); if (!value) fail('stale_message');
      unchanged([[value.accountId, value.revision]]);
      const account = accounts.get(value.accountId), key = writeKey(account, value.reference);
      if (writes.has(key)) fail('busy'); writes.add(key);
      try {
        return await run([account], async signal => {
          const result = await reader.apply(account, value.reference, 'move', { signal, destinationId: value.destinationId });
          if (result?.applied !== true) fail('mailbox_error');
          undos.delete(input.token); deletionVersion++; records.clear(); pages.clear(); conversationCursors.clear();
          try { conversations?.clear?.(); } catch {}
          if (result.reference) for (const tag of value.tags.filter(id => tagDefinitions().some(tag => tag.id === id))) {
            await tags?.set({ account, message: value.message, reference: result.reference, tag, enabled: true, verify: () => {
              if (signal.aborted) throw signal.reason;
              unchanged([[account.id, account.revision]]);
            } });
          }
          return { applied: true };
        });
      } finally { writes.delete(key); }
    },
    async emptyTrash(input) {
      object(input, ['accountId', 'confirm']);
      if (input.confirm !== true || !validId(input.accountId)) fail('invalid_request');
      const account = accounts.get(input.accountId);
      const result = await run([account], signal => reader.emptyTrash(account, { signal, confirm: true }));
      this.invalidateAccount(account.id); deletionVersion++; conversationCursors.clear();
      try { conversations?.clear?.(); } catch {}
      if (!Number.isSafeInteger(result?.deleted) || result.deleted < 0 || !Number.isSafeInteger(result?.remaining) || result.remaining < 0) fail('mailbox_error');
      return { deleted: result.deleted, remaining: result.remaining, partial: result.partial === true,
        errors: (Array.isArray(result.errors) ? result.errors : []).slice(0, 100).map(error => ({ code: safeError(error).code })) };
    },
    async manageFolder(input) {
      object(input, ['accountId', 'action', 'folderId', 'name', 'parentId']);
      if (!validId(input.accountId)) fail('invalid_request');
      const account = accounts.get(input.accountId), { accountId, ...operation } = input;
      const result = await run([account], signal => reader.manageFolder(account, operation, { signal }));
      this.invalidateAccount(account.id); return result;
    },
    async manageLabel(input) { if (!tags?.manage) fail('invalid_request'); const result = await tags.manage(input); pages.clear(); return result; },
    async providerLabels(input) {
      object(input, ['id']); const value = record(input.id), account = accounts.get(value.reference.accountId);
      return run([account], signal => reader.providerLabels(account, { signal }));
    },
    async setProviderLabel(input) {
      object(input, ['id', 'label', 'enabled']); const value = record(input.id), account = accounts.get(value.reference.accountId);
      if (typeof input.label !== 'string' || typeof input.enabled !== 'boolean') fail('invalid_request');
      const key = writeKey(account, value.reference); if (writes.has(key)) fail('busy'); writes.add(key);
      try { return await run([account], async signal => {
        const result = await reader.setProviderLabel(account, value.reference, { label: input.label, enabled: input.enabled }, { signal });
        if (result?.applied !== true) fail('mailbox_error');
        pages.clear(); return { applied: true };
      }); }
      finally { writes.delete(key); }
    },
    async changes() { const current = selected(); return current.length ? run(current, signal => reader.changes(current, { signal })) : { accounts: [], errors: [] }; },
    invalidateAccount(id) {
      for (const [key, value] of records) if (value.reference.accountId === id) records.delete(key);
      for (const [key, value] of pages) if (value.accountIds.includes(id)) pages.delete(key);
      for (const [key, value] of conversationCursors) if (value.accountId === id) conversationCursors.delete(key);
      for (const [key, value] of undos) if (value.accountId === id) undos.delete(key);
      try { conversations?.clear?.(); } catch {}
      for (const operation of operations) if (operation.accountIds.includes(id)) operation.controller.abort(new MailHarborError('stale_message'));
    },
    async close() {
      closed = true;
      for (const operation of operations) operation.controller.abort(new MailHarborError('cancelled'));
      await Promise.allSettled([...operations].map(value => value.promise));
      records.clear(); pages.clear(); conversationCursors.clear(); writes.clear(); undos.clear();
      try {
        if (typeof conversations?.destroy === 'function') conversations.destroy();
        else if (typeof conversations?.clear === 'function') conversations.clear();
      } catch {}
    }
  };
}
