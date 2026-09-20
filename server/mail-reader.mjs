import { MAX_ACCOUNTS } from './providers.mjs';
import { createHash } from 'node:crypto';
import mailsplit from '@zone-eu/mailsplit';
import FlowedDecoder from '@zone-eu/mailsplit/lib/flowed-decoder.js';
import libmime from 'libmime';
import libbase64 from 'libbase64';
import libqp from 'libqp';
import { getDecoder } from 'imapflow/lib/tools.js';
import { LimitedPassthrough } from 'imapflow/lib/limited-passthrough.js';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decodeBody } from './body.mjs';
import { MailHarborError, errorMessages } from './validation.mjs';
import { invoiceParts } from './invoice-attachments.mjs';
import { MAX_ATTACHMENT_BYTES, attachmentParts, attachmentPart, attachmentBytes, validAttachmentId } from './mail-attachments.mjs';
import { createMailProcessingReader } from './mail-processing-reader.mjs';
import { createMailboxSession, cleanMailText as clean, hasMailFlag as has, mailFingerprint as fingerprint,
  mailTimestamp as timestamp, preferredMailPart as preferredPart, selectableMailbox as selectable } from './mailboxes.mjs';

const HEADER_QUERY = Object.freeze({ uid: true, envelope: true, flags: true, internalDate: true, size: true, headers: ['References'], labels: true });
const HEADER_CHUNK = 250;
const DAY = 86_400_000;
const DATE_MARGIN = 5 * DAY;
const WINDOWS = [7, 30, 90, 365, 3650];
const DEFINITIONS = [
  ['inbox', 'Inbox', '\\Inbox', ['inbox']],
  ['unread', 'Unread', '', []],
  ['starred', 'Starred', '\\Flagged', []],
  ['sent', 'Sent', '\\Sent', ['sent', 'sent items', 'sent messages', 'inbox.sent']],
  ['drafts', 'Drafts', '\\Drafts', ['drafts', 'draft', 'inbox.drafts']],
  ['archive', 'Archive', '\\Archive', ['archive', 'archives', 'inbox.archive']],
  ['junk', 'Junk', '\\Junk', ['junk', 'spam', 'junk email', 'junk e-mail', 'inbox.junk']],
  ['trash', 'Trash', '\\Trash', ['trash', 'deleted items', 'deleted messages', 'inbox.trash']],
  ['all', 'All mail', '', []]
];
const VALID_FOLDERS = new Set(DEFINITIONS.map(([id]) => id));
const fail = code => { throw new MailHarborError(code, errorMessages[code]); };
const abortCheck = signal => { if (signal?.aborted) fail('cancelled'); };
const validUid = uid => Number.isSafeInteger(uid) && uid > 0 && uid <= 0xffffffff;
const validMessage = message => message && validUid(message.uid) && message.flags instanceof Set && message.envelope && !has(message.flags, '\\Deleted');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const folderFlag = (folder, flag) => String(folder.specialUse ?? '').toLowerCase() === flag.toLowerCase() || has(folder.flags, flag);
const pathEqual = (a, b) => a === b || (String(a).toUpperCase() === 'INBOX' && String(b).toUpperCase() === 'INBOX');
const compare = (a, b) => b.time - a.time || a.accountId.localeCompare(b.accountId) || a.path.localeCompare(b.path) || b.uid - a.uid;
const addresses = values => clean((values ?? []).map(value => value.name ? `${value.name} <${value.address ?? ''}>` : value.address ?? '').join(', '));
const folderId = (account, path) => `folder:${hash([account.id, path.toUpperCase() === 'INBOX' ? 'INBOX' : path])}`;
const customId = value => typeof value === 'string' && /^folder:[a-f0-9]{64}$/u.test(value);
const messageIds = value => (String(value ?? '').match(/<[^<>\s\x00-\x1f\x7f]{1,998}>/gu) ?? []).slice(0, 100);
const safeLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  value === value.trim() && !/[\x00-\x1f\x7f\\\[\]]/u.test(value);
const keywordLabel = value => safeLabel(value) && !/[\s(){}%*"\]]/u.test(value);
const addressList = values => (Array.isArray(values) ? values.flatMap(item => item?.value ?? item ?? []) : values?.value ?? values ?? []).slice(0, 200)
  .map(item => ({ name: clean(item.name ?? '', 500), address: clean(item.address ?? '', 500) }));

const hasFilename = parameters => Object.keys(parameters ?? {}).some(key => /^(?:name|filename)(?:\*.*)?$/iu.test(key));

function findContentParts(structure) {
  const plainParts = [];
  const htmlParts = [];
  const inlineParts = [];
  const inlinePartIds = new Set();
  const segments = [];
  let encrypted = null;
  const seen = new WeakSet();
  let visited = 0;
  let truncated = false;

  const normalize = val => String(val ?? '').trim().toLowerCase();
  const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif']);

  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object') return;
    if (depth > 25 || visited >= 500 || seen.has(node)) {
      truncated = true;
      return;
    }
    visited++;
    seen.add(node);

    const type = normalize(node.type);
    const disposition = normalize(node.disposition);
    const isAttachment = disposition === 'attachment' || hasFilename(node.parameters) || hasFilename(node.dispositionParameters);

    // Encrypted detection: do not classify named attached encrypted file as whole encrypted mail
    if (!isAttachment && (type === 'multipart/encrypted' || /^application\/(?:x-)?(?:pkcs7-mime|pgp-encrypted)$/u.test(type))) {
      const protocol = normalize(node.parameters?.protocol || '');
      const smimeType = normalize(node.parameters?.['smime-type'] || '');
      // Signed S/MIME is NOT encrypted!
      if (type === 'application/pkcs7-mime' && (smimeType === 'signed-data' || smimeType === 'certs-only')) {
        // fall through
      } else {
        const isOpenPgp = protocol.includes('pgp') || type.includes('pgp');
        encrypted = { type: isOpenPgp ? 'openpgp' : 'smime', decrypted: false };
        return;
      }
    }

    // Skip nested attached messages
    if (type.startsWith('message/')) {
      return;
    }

    // Raster CID inline parts detection
    if (node.id && inlineParts.length < 100) {
      const normType = RASTER_TYPES.has(type) ? (type === 'image/jpg' ? 'image/jpeg' : type) : null;
      if (normType) {
        const cid = String(node.id).trim().replace(/^<|>$/g, '').trim().slice(0, 200);
        const partId = String(node.part ?? '');
        if (cid && validAttachmentId(partId) && !inlinePartIds.has(partId)) {
          inlinePartIds.add(partId);
          const encoding = normalize(node.encoding);
          const encodedSize = Number.isSafeInteger(node.size) && node.size >= 0 ? node.size : null;
          const size = encodedSize === null ? null : encoding === 'base64' ? Math.floor(encodedSize * 3 / 4) : encodedSize;
          inlineParts.push({ id: partId, contentId: cid, mimeType: normType, size });
        }
      }
    }

    // Skip attachments when selecting body parts
    if (isAttachment) {
      return;
    }

    if (type === 'multipart/alternative') {
      const altPlainList = [];
      const altHtmlList = [];
      for (const child of node.childNodes ?? []) {
        if (truncated) break;
        const cType = normalize(child?.type);
        const cDisp = normalize(child?.disposition);
        const cAttach = cDisp === 'attachment' || hasFilename(child?.parameters) || hasFilename(child?.dispositionParameters);
        if (cAttach || cType.startsWith('message/')) continue;

        if (cType === 'text/plain') {
          if (depth + 1 > 25 || visited >= 500 || (child && seen.has(child))) {
            truncated = true;
          } else {
            visited++;
            if (child && typeof child === 'object') seen.add(child);
            altPlainList.push(child);
          }
        } else if (cType === 'text/html') {
          if (depth + 1 > 25 || visited >= 500 || (child && seen.has(child))) {
            truncated = true;
          } else {
            visited++;
            if (child && typeof child === 'object') seen.add(child);
            altHtmlList.push(child);
          }
        } else if (cType.startsWith('multipart/')) {
          const subPlain = [];
          const subHtml = [];
          function walkAltBranch(subNode, subDepth) {
            if (!subNode || typeof subNode !== 'object') return;
            if (subDepth > 25 || visited >= 500 || seen.has(subNode)) {
              truncated = true;
              return;
            }
            visited++;
            seen.add(subNode);
            const sType = normalize(subNode.type);
            const sDisp = normalize(subNode.disposition);
            const sAttach = sDisp === 'attachment' || hasFilename(subNode.parameters) || hasFilename(subNode.dispositionParameters);
            if (sAttach || sType.startsWith('message/')) return;
            if (subNode.id && inlineParts.length < 100) {
              const normT = RASTER_TYPES.has(sType) ? (sType === 'image/jpg' ? 'image/jpeg' : sType) : null;
              if (normT) {
                const cid = String(subNode.id).trim().replace(/^<|>$/g, '').trim().slice(0, 200);
                const partId = String(subNode.part ?? '');
                if (cid && validAttachmentId(partId) && !inlinePartIds.has(partId)) {
                  inlinePartIds.add(partId);
                  const encoding = normalize(subNode.encoding);
                  const encodedSize = Number.isSafeInteger(subNode.size) && subNode.size >= 0 ? subNode.size : null;
                  const size = encodedSize === null ? null : encoding === 'base64' ? Math.floor(encodedSize * 3 / 4) : encodedSize;
                  inlineParts.push({ id: partId, contentId: cid, mimeType: normT, size });
                }
              }
            }
            if (sType === 'text/plain') subPlain.push(subNode);
            else if (sType === 'text/html') subHtml.push(subNode);
            else if (sType.startsWith('multipart/')) {
              for (const sc of subNode.childNodes ?? []) walkAltBranch(sc, subDepth + 1);
            }
          }
          walkAltBranch(child, depth + 1);
          if (subPlain.length > 0) altPlainList.push(...subPlain);
          if (subHtml.length > 0) altHtmlList.push(...subHtml);
        }
      }
      for (const p of altPlainList) plainParts.push(p);
      for (const h of altHtmlList) htmlParts.push(h);
      if (altPlainList.length > 0 || altHtmlList.length > 0) {
        segments.push({
          kind: 'alternative',
          plain: altPlainList.length === 1 ? altPlainList[0] : null,
          plainParts: altPlainList,
          html: altHtmlList.length === 1 ? altHtmlList[0] : null,
          htmlParts: altHtmlList
        });
      }
      return;
    }

    if (type === 'text/plain') {
      plainParts.push(node);
      segments.push({ kind: 'plain', part: node });
    } else if (type === 'text/html') {
      htmlParts.push(node);
      segments.push({ kind: 'html', part: node });
    } else if (type.startsWith('multipart/')) {
      for (const child of node.childNodes ?? []) {
        walk(child, depth + 1);
      }
    }
  }

  walk(structure, 0);
  return {
    plainParts,
    htmlParts,
    inlineParts,
    plain: plainParts[0] ?? null,
    html: htmlParts[0] ?? null,
    encrypted,
    truncated,
    segments
  };
}

async function decodeSinglePart(rawMime, rawBody, part, maxDecodedBytes) {
  if (maxDecodedBytes < 0) fail('content_too_large');
  if (!Buffer.isBuffer(rawBody)) fail('content_unavailable');
  if (!Buffer.isBuffer(rawMime) || rawMime.length >= 16384) fail('content_unavailable');

  const mimeText = rawMime.toString('latin1');
  if (!/\r?\n\r?\n/u.test(mimeText) && !['\r\n', '\n'].includes(mimeText)) {
    fail('content_unavailable');
  }

  const headers = new mailsplit.Headers(rawMime);
  for (const name of ['Content-Type', 'Content-Disposition', 'Content-Transfer-Encoding']) {
    if (headers.get(name).length > 1) fail('content_unavailable');
  }

  const contentType = libmime.parseHeaderValue(headers.getFirst('Content-Type'));
  const disposition = libmime.parseHeaderValue(headers.getFirst('Content-Disposition'));
  const transfer = libmime.parseHeaderValue(headers.getFirst('Content-Transfer-Encoding'));

  const normalize = val => String(val ?? '').trim().toLowerCase();
  const type = normalize(part?.type || 'text/plain');
  if (contentType.value && normalize(contentType.value) !== type) fail('content_unavailable');
  if (normalize(disposition.value) === 'attachment') fail('content_unavailable');
  if (hasFilename(contentType.params) || hasFilename(disposition.params)) fail('content_unavailable');

  const encoding = normalize(transfer.value).replace(/\([^)]*\)/gu, '').trim() || normalize(part?.encoding) || '7bit';
  if (!['7bit', '8bit', 'binary', 'base64', 'quoted-printable'].includes(encoding) ||
      (part?.encoding && normalize(part.encoding) !== encoding)) {
    fail('content_unavailable');
  }

  const charsetKey = val => normalize(val).replace(/[^a-z0-9]/gu, '');
  const charset = normalize(contentType.params?.charset || part?.parameters?.charset || 'utf-8');
  if (contentType.params?.charset && part?.parameters?.charset &&
      charsetKey(contentType.params.charset) !== charsetKey(part.parameters.charset)) {
    fail('content_unavailable');
  }
  if (/^(?:jis|iso-?2022-?jp|euc-?jp)/iu.test(charset) && !['jis', 'iso2022jp', 'eucjp'].includes(charsetKey(charset))) {
    fail('content_unavailable');
  }

  if (encoding === 'base64') {
    const encoded = rawBody.toString('latin1');
    if (/[^A-Za-z0-9+/=\r\n\t ]/u.test(encoded)) fail('content_unavailable');
    const compact = encoded.replace(/\s/gu, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 !== 0) fail('content_unavailable');
  }

  if (rawBody.length === 0) return '';

  const stages = [Readable.from([rawBody])], limits = [];
  const limit = () => {
    const stream = new LimitedPassthrough({ maxBytes: maxDecodedBytes + 1 });
    limits.push(stream);
    stages.push(stream);
  };

  if (encoding === 'base64') stages.push(new libbase64.Decoder());
  else if (encoding === 'quoted-printable') stages.push(new libqp.Decoder());

  limit();

  if (type === 'text/plain' && normalize(contentType.params?.format || part?.parameters?.format) === 'flowed') {
    stages.push(new FlowedDecoder({ delSp: normalize(contentType.params?.delsp || part?.parameters?.delsp) === 'yes' }));
    limit();
  }

  if (!['ascii', 'usascii', 'utf8'].includes(charsetKey(charset))) {
    const decoder = getDecoder(charset, maxDecodedBytes + 1);
    limits.push(decoder);
    stages.push(decoder);
  }

  limit();

  const chunks = [];
  stages.push(new Writable({
    write(chunk, enc, done) {
      chunks.push(Buffer.from(chunk));
      done();
    }
  }));

  try {
    await pipeline(stages);
  } catch {
    fail('content_unavailable');
  }

  if (limits.some(s => s.limited)) {
    fail('content_too_large');
  }

  const totalDecodedBuf = Buffer.concat(chunks);
  if (totalDecodedBuf.length > maxDecodedBytes) {
    fail('content_too_large');
  }

  let result = totalDecodedBuf.toString('utf8');
  result = result.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  return result;
}

function validateFilters(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(key =>
    !['from', 'to', 'subject', 'body', 'since', 'before', 'unread', 'starred', 'hasAttachment', 'minSize', 'maxSize'].includes(key))) fail('invalid_request');
  for (const [key, value] of Object.entries(filters)) {
    if (['unread', 'starred', 'hasAttachment'].includes(key)) { if (typeof value !== 'boolean') fail('invalid_request'); }
    else if (['minSize', 'maxSize'].includes(key)) { if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail('invalid_request'); }
    else if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/u.test(value)) fail('invalid_request');
    else if (['since', 'before'].includes(key) && (!/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) fail('invalid_request');
  }
  if (filters.minSize != null && filters.maxSize != null && filters.minSize > filters.maxSize) fail('invalid_request');
  if (filters.since && filters.before && filters.since >= filters.before) fail('invalid_request');
}

function validateAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length > MAX_ACCOUNTS || accounts.some(account => !account || typeof account.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(account.id)) || new Set(accounts.map(account => account.id)).size !== accounts.length) fail('invalid_request');
}

async function forAccounts(accounts, operation) {
  let next = 0;
  // At most four account sessions, independent of how many accounts a caller supplies.
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, accounts.length) }, async () => {
    while (next < accounts.length) await operation(accounts[next++]);
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

function resolveFolders(client, raw, account) {
  if (!Array.isArray(raw) || raw.length > 1000) fail('mailbox_error');
  const available = raw.filter(selectable).filter((folder, index, all) => all.findIndex(other => pathEqual(other.path, folder.path)) === index);
  const result = {};
  for (const [id, , special, fallback] of DEFINITIONS) {
    const flagged = special ? available.filter(folder => folderFlag(folder, special)) : [];
    // SPECIAL-USE wins over names. Never reinterpret a different special-use folder by its name.
    result[id] = flagged.length ? flagged : available.filter(folder => !folder.specialUse &&
      !DEFINITIONS.some(([, , flag]) => flag && folderFlag(folder, flag)) && fallback.includes(folder.path.toLowerCase()));
  }
  // INBOX has protocol-defined semantics even when LIST advertises additional flags.
  result.inbox = available.filter(folder => folder.path.toUpperCase() === 'INBOX');
  result.unread = result.inbox;
  const all = available.filter(folder => folderFlag(folder, '\\All'));
  const gmail = client.capabilities?.has('X-GM-EXT-1') === true;
  if (gmail && all.length) result.archive = all.map(folder => ({ ...folder, gmailArchive: true }));
  else if (account.archivePath) {
    const explicit = available.find(folder => folder.path === account.archivePath && !result.inbox.includes(folder) &&
      !['junk', 'trash', 'drafts', 'sent'].some(kind => result[kind].includes(folder)));
    if (explicit) result.archive = [explicit];
  }
  // Gmail All Mail is one physical view of its label copies. Other providers use all
  // ordinary selectable folders; exclude special aggregate views to avoid duplicates.
  result.starred = gmail && all.length ? [all[0]] : available.filter(folder =>
    !result.junk.includes(folder) && !result.trash.includes(folder) && !folderFlag(folder, '\\All') && !folderFlag(folder, '\\Flagged'));
  result.all = gmail && all.length ? [all[0], ...result.junk, ...result.trash] : available.filter(folder =>
    !folderFlag(folder, '\\All') && !folderFlag(folder, '\\Flagged'));
  for (const target of available) result[folderId(account, target.path)] = [target];
  result.provider = available.filter(target => !DEFINITIONS.some(([id]) => !['all', 'unread', 'starred'].includes(id) &&
    result[id].some(item => pathEqual(item.path, target.path))) && !folderFlag(target, '\\All') && !folderFlag(target, '\\Flagged'));
  return result;
}

function validity(client, path) {
  if (!pathEqual(client.mailbox?.path, path) || client.mailbox?.uidValidity == null) fail('mailbox_error');
  return String(client.mailbox.uidValidity);
}

function metadata(account, path, uidValidity, message) {
  const reference = { accountId: account.id, path, uidValidity, uid: message.uid, fingerprint: fingerprint(message) };
  const time = timestamp(message);
  const unfolded = Buffer.isBuffer(message.headers) ? message.headers.toString('utf8').replace(/\r?\n[ \t]+/gu, ' ') : '';
  const references = messageIds(message.envelope.references ?? unfolded.match(/^references:[ \t]*(.*)$/imu)?.[1]);
  const messageId = messageIds(message.envelope.messageId)[0] ?? '';
  const inReplyTo = messageIds(message.envelope.inReplyTo)[0] ?? '';
  return {
    id: hash(reference), accountId: account.id, account: clean(account.label || account.email || account.id), folderPath: path,
    subject: clean(message.envelope.subject), author: addresses(message.envelope.from), to: addresses(message.envelope.to),
    cc: addresses(message.envelope.cc), replyTo: addresses(message.envelope.replyTo), messageId, inReplyTo, references,
    threadId: hash([account.id, references[0] || inReplyTo || messageId || hash(reference)]),
    size: Number.isSafeInteger(message.size) && message.size >= 0 ? message.size : null,
    ...(message.bodyStructure ? { hasAttachments: attachmentParts(message.bodyStructure).length > 0, attachments: attachmentParts(message.bodyStructure) } : {}),
    providerLabels: [...(message.labels ?? message.flags ?? [])].filter(safeLabel).map(value => clean(value, 200)),
    date: time ? new Date(time).toISOString() : '', unread: !has(message.flags, '\\Seen'), starred: has(message.flags, '\\Flagged'), reference
  };
}

function referenceCheck(account, reference) {
  if (!reference || reference.accountId !== account.id || !validUid(reference.uid) ||
    typeof reference.uidValidity !== 'string' || !/^\d{1,20}$/u.test(reference.uidValidity) ||
    typeof reference.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.fingerprint) ||
    !selectable({ path: reference.path })) fail('stale_message');
}

/** On-demand header index. Cursors remain private to the authenticated server. */
export function createMailReader({ connectionOptions, createClient, now = () => Date.now(), sessionTimeoutMs } = {}) {
  const { session, active } = createMailboxSession({ connectionOptions, createClient, sessionTimeoutMs });
  const gmailArchiveReader = createMailProcessingReader({ connectionOptions, createClient, sessionTimeoutMs });

  async function locked(client, path, readOnly, operation) {
    const lock = await client.getMailboxLock(path, { readOnly });
    try { return await operation(validity(client, path)); }
    finally { lock.release(); }
  }

  async function folders(accounts, { signal } = {}) {
    validateAccounts(accounts);
    const output = DEFINITIONS.map(([id, label]) => ({ id, label, type: 'standard', accountIds: [], counts: [] })), errors = [];
    await forAccounts(accounts, async account => {
      abortCheck(signal);
      let mapped, countFailed = false;
      const statuses = new Map();
      const key = path => String(path).toUpperCase() === 'INBOX' ? 'INBOX' : path;
      try {
        await session(account, signal, async client => {
          const raw = await client.list();
          abortCheck(signal);
          if (!active.has(client)) fail('mailbox_error');
          mapped = resolveFolders(client, raw, account);
          const requested = new Map();
          // STATUS gives inexpensive provider counts without opening or fetching mail.
          // One request serves Inbox and Unread; unrelated folders and filtered views
          // (Starred and Gmail Archive) must not be mistaken for whole-mailbox totals.
          for (const definition of output) {
            if (['starred', 'all'].includes(definition.id)) continue;
            for (const target of mapped[definition.id] ?? []) {
              if (target.gmailArchive) continue;
              const identity = key(target.path);
              if (!requested.has(identity)) requested.set(identity, { path: target.path, query: { messages: true } });
              if (definition.id === 'unread') requested.get(identity).query.unseen = true;
            }
          }
          for (const target of mapped.provider) {
            const identity = key(target.path);
            if (!requested.has(identity)) requested.set(identity, { path: target.path, query: { messages: true } });
          }
          for (const [identity, request] of requested) {
            abortCheck(signal);
            if (!active.has(client)) fail('mailbox_error');
            let status;
            try { status = await client.status(request.path, request.query); }
            catch (error) {
              abortCheck(signal);
              if (!active.has(client)) fail('mailbox_error');
              if (error?.authenticationFailed || error?.code === 'AUTHENTICATIONFAILED') fail('mailbox_login_required');
              countFailed = true;
              continue;
            }
            abortCheck(signal);
            if (!active.has(client)) fail('mailbox_error');
            const count = field => Number.isSafeInteger(status?.[field]) && status[field] >= 0 && status[field] <= 0xffffffff ? status[field] : null;
            const messages = count('messages'), unseen = request.query.unseen ? count('unseen') : null;
            statuses.set(identity, { messages, unseen });
            if (messages === null || (request.query.unseen && unseen === null)) countFailed = true;
          }
        });
        if (countFailed) errors.push({ accountId: account.id, code: 'mailbox_error' });
      } catch (error) {
        if (error.code === 'cancelled') throw error;
        errors.push({ accountId: account.id, code: error.code });
      }
      // Keep successful discovery and any completed counts even if a later STATUS
      // fails or times out. Unknown totals are null, never zero or account counts.
      for (const definition of output) if (mapped?.[definition.id]?.length) {
        const targets = mapped[definition.id], field = definition.id === 'unread' ? 'unseen' : 'messages';
        const values = targets.map(target => statuses.get(key(target.path))?.[field]);
        const total = !['starred', 'all'].includes(definition.id) && !targets.some(target => target.gmailArchive) &&
          values.every(value => Number.isSafeInteger(value)) ? values.reduce((sum, value) => sum + value, 0) : null;
        definition.accountIds.push(account.id);
        definition.counts.push({ accountId: account.id, total });
      }
      for (const target of mapped?.provider ?? []) output.push({ id: folderId(account, target.path), label: clean(target.name || target.path, 200),
        type: 'provider', accountIds: [account.id], counts: [{ accountId: account.id, total: statuses.get(key(target.path))?.messages ?? null }] });
    });
    for (const folder of output) {
      folder.accountIds.sort();
      folder.counts.sort((a, b) => a.accountId.localeCompare(b.accountId));
    }
    errors.sort((a, b) => a.accountId.localeCompare(b.accountId));
    return { folders: output.sort((a, b) => a.type === b.type ? (a.type === 'provider' ? a.label.localeCompare(b.label) || a.id.localeCompare(b.id) : 0) : a.type === 'standard' ? -1 : 1), errors };
  }

  async function list(accounts, { folder = 'inbox', query = '', cursor = null, limit = 50, signal, includeAttachments = false,
    filters = {}, sort = 'date_desc', bodySearch = false, scopedReferences, includeStatus = false } = {}) {
    validateAccounts(accounts);
    if ((!VALID_FOLDERS.has(folder) && !customId(folder)) || typeof query !== 'string' || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query) ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 || typeof includeAttachments !== 'boolean' || typeof bodySearch !== 'boolean' || typeof includeStatus !== 'boolean' ||
      !['date_desc', 'date_asc', 'subject_asc', 'sender_asc'].includes(sort)) fail('invalid_request');
    validateFilters(filters);
    let scoped;
    if (scopedReferences !== undefined) {
      if (!Array.isArray(scopedReferences) || scopedReferences.length > 250000) fail('invalid_request');
      scoped = new Set(scopedReferences.map(reference => {
        const account = accounts.find(value => value.id === reference?.accountId);
        if (!account) fail('invalid_request');
        referenceCheck(account, reference);
        return `${account.id}:${reference.fingerprint}`;
      }));
    }
    if ((folder === 'unread' && filters.unread === false) || (folder === 'starred' && filters.starred === false)) fail('invalid_request');
    query = query.trim();
    const scope = hash({ folder, query, filters: Object.entries(filters).sort(), sort, bodySearch, scoped: scoped ? [...scoped].sort() : null,
      accounts: accounts.map(account => [account.id, account.email, account.updatedAt, account.archivePath]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) });
    if (cursor && (cursor.version !== 1 || cursor.scope !== scope || !Array.isArray(cursor.accounts) || !cursor.after)) fail('stale_message');
    const candidates = [], snapshots = [], errors = [], states = [];
    let total = 0;
    const midnight = Math.floor(now() / DAY) * DAY;
    const ordering = (a, b) => (sort === 'date_asc' ? a.time - b.time : sort === 'subject_asc' || sort === 'sender_asc' ?
      a.sortKey.localeCompare(b.sortKey) : 0) || compare(a, b);
    const offer = (into, entry) => {
      if (cursor && ordering(entry, cursor.after) <= 0) return;
      into.push(entry); into.sort(ordering);
      if (into.length > limit + 1) into.pop();
    };
    await forAccounts(accounts, async account => {
      abortCheck(signal);
      const previous = cursor?.accounts.find(item => item.accountId === account.id);
      if (cursor && !previous) {
        errors.push(cursor.errors?.find(item => item.accountId === account.id) ?? { accountId: account.id, code: 'mailbox_error' });
        return;
      }
      try {
        const result = await session(account, signal, async client => {
          const mapped = resolveFolders(client, await client.list(), account);
          if (includeStatus && !cursor) {
            for (const inboxFolder of mapped.inbox ?? []) {
              abortCheck(signal);
              const status = await client.status(inboxFolder.path, { uidNext: true, uidValidity: true, unseen: true, messages: true });
              abortCheck(signal);
              if (!active.has(client) || !validUid(status?.uidNext) || !/^\d{1,20}$/u.test(String(status?.uidValidity ?? '')) ||
                !Number.isSafeInteger(status?.unseen) || status.unseen < 0 || status.unseen > 0xffffffff ||
                !Number.isSafeInteger(status?.messages) || status.messages < 0 || status.messages > 0xffffffff) fail('mailbox_error');
              states.push({ accountId: account.id, folderId: folderId(account, inboxFolder.path), uidValidity: String(status.uidValidity),
                uidNext: status.uidNext, unseen: status.unseen, messages: status.messages });
            }
          }
          const selected = previous ? previous.folders.map(item => {
            const resolved = mapped[folder]?.find(value => pathEqual(value.path, item.path));
            if (!resolved) fail('stale_message');
            return resolved;
          }) : mapped[folder] ?? [];
          if (scoped) selected.sort((a, b) => a.path.localeCompare(b.path));
          const accountCandidates = [], accountFolders = [];
          const scopedSeen = new Set();
          let accountTotal = 0;
          for (const target of selected) {
            abortCheck(signal);
            await locked(client, target.path, true, async uidValidity => {
              const old = previous?.folders.find(value => pathEqual(value.path, target.path));
              if (old && old.uidValidity !== uidValidity) fail('stale_message');
              const criteria = { deleted: false,
                ...(folder === 'unread' ? { seen: false } : {}), ...(folder === 'starred' ? { flagged: true } : {}),
                ...(target.gmailArchive ? { gmailRaw: '-in:inbox' } : {}),
                ...(query ? (bodySearch ? { text: query } : { or: [{ subject: query }, { from: query }, { to: query }] }) : {}),
                ...Object.fromEntries(['from', 'to', 'subject', 'body'].filter(key => filters[key]).map(key => [key, filters[key]])),
                ...(filters.since ? { since: new Date(filters.since) } : {}), ...(filters.before ? { before: new Date(filters.before) } : {}),
                ...(filters.unread != null ? { seen: !filters.unread } : {}), ...(filters.starred != null ? { flagged: filters.starred } : {}),
                ...(filters.minSize > 0 ? { larger: filters.minSize - 1 } : {}), ...(filters.maxSize != null ? { smaller: filters.maxSize + 1 } : {}) };
              const found = await client.search(criteria, { uid: true });
              abortCheck(signal);
              if (!Array.isArray(found) || found.some(uid => !validUid(uid))) fail('mailbox_error');
              // UID bounds freeze arrivals for pagination; ordering always uses dates.
              const initial = new Set(found.filter(uid => !old || uid <= old.maxUid)), fetched = new Set();
              if (filters.hasAttachment == null && !scoped) accountTotal += initial.size;
              let maxUid = old?.maxUid ?? 0;
              for (const uid of initial) maxUid = Math.max(maxUid, uid);
              accountFolders.push({ path: target.path, uidValidity, maxUid });
              const folderCandidates = [];
              async function headers(uids) {
                for (let offset = 0; offset < uids.length; offset += HEADER_CHUNK) {
                  abortCheck(signal);
                  const chunk = uids.slice(offset, offset + HEADER_CHUNK), requested = new Set(chunk), received = new Set();
                  for await (const message of client.fetch(chunk.join(','), { ...HEADER_QUERY,
                    ...(includeAttachments || filters.hasAttachment != null ? { bodyStructure: true } : {}), labels: true }, { uid: true })) {
                    abortCheck(signal);
                    if (!requested.has(message?.uid) || received.has(message.uid)) continue;
                    received.add(message.uid);
                    if (!validMessage(message) || (folder === 'unread' && has(message.flags, '\\Seen')) ||
                      (folder === 'starred' && !has(message.flags, '\\Flagged')) || (target.gmailArchive && has(message.labels, '\\Inbox'))) continue;
                    const value = metadata(account, target.path, uidValidity, message);
                    if (scoped && !scoped.has(`${account.id}:${value.reference.fingerprint}`)) continue;
                    if (scoped && scopedSeen.has(value.reference.fingerprint)) continue;
                    if (filters.hasAttachment != null) {
                      if (value.hasAttachments !== filters.hasAttachment) continue;
                    }
                    if (filters.hasAttachment != null || scoped) accountTotal++;
                    if (scoped) scopedSeen.add(value.reference.fingerprint);
                    if (includeAttachments) value.invoiceDocuments = invoiceParts(message.bodyStructure).map(({ filename, mimeType }) => ({ filename, mimeType }));
                    offer(folderCandidates, { time: timestamp(message), sortKey: sort === 'subject_asc' ? value.subject.toLowerCase() :
                      sort === 'sender_asc' ? value.author.toLowerCase() : '', accountId: account.id, path: target.path, uid: message.uid, value });
                  }
                  for (const uid of chunk) fetched.add(uid);
                  if (validity(client, target.path) !== uidValidity) fail('stale_message');
                }
              }
              let complete = false;
              if (initial.size > HEADER_CHUNK && sort === 'date_desc' && filters.hasAttachment == null && !scoped) {
                for (const days of WINDOWS) {
                  abortCheck(signal);
                  const cutoff = midnight - days * DAY, date = new Date(cutoff);
                  const recent = await client.search({ or: [{ sentSince: date }, { since: date }] }, { uid: true });
                  abortCheck(signal);
                  if (!Array.isArray(recent)) break;
                  if (recent.some(uid => !validUid(uid))) fail('mailbox_error');
                  await headers([...new Set(recent)].filter(uid => initial.has(uid) && !fetched.has(uid)));
                  // Both Date and INTERNALDATE outside the window are older than this
                  // strict bound, including numeric Date time zones spanning days.
                  if (fetched.size === initial.size || (folderCandidates.length > limit && folderCandidates[limit].time > cutoff + DATE_MARGIN)) {
                    complete = true; break;
                  }
                }
              }
              if (!complete) await headers([...initial].filter(uid => !fetched.has(uid)).sort((a, b) => a - b));
              if (validity(client, target.path) !== uidValidity) fail('stale_message');
              for (const entry of folderCandidates) offer(accountCandidates, entry);
            });
          }
          return { candidates: accountCandidates, total: accountTotal, snapshot: { accountId: account.id, folders: accountFolders } };
        });
        total += result.total;
        snapshots.push(result.snapshot);
        for (const entry of result.candidates) offer(candidates, entry);
      } catch (error) {
        if (error.code === 'cancelled') throw error;
        errors.push({ accountId: account.id, code: error.code });
      }
    });
    errors.sort((a, b) => a.accountId.localeCompare(b.accountId));
    if (includeStatus) {
      states.sort((a, b) => a.accountId.localeCompare(b.accountId) || a.folderId.localeCompare(b.folderId));
    }
    const selected = candidates.slice(0, limit), last = selected.at(-1);
    return { messages: selected.map(item => item.value), errors, total, totalComplete: errors.length === 0,
      nextCursor: candidates.length > limit ? { version: 1, scope, accounts: snapshots, errors,
        after: { time: last.time, sortKey: last.sortKey, accountId: last.accountId, path: last.path, uid: last.uid } } : null,
      ...(includeStatus ? { states } : {}) };
  }

  async function verified(client, account, reference, query, signal) {
    const message = await client.fetchOne(String(reference.uid), query, { uid: true, binary: false });
    abortCheck(signal);
    if (!active.has(client)) fail('mailbox_error');
    if (validity(client, reference.path) !== reference.uidValidity || !validMessage(message) ||
      message.uid !== reference.uid || fingerprint(message) !== reference.fingerprint) fail('stale_message');
    return message;
  }

  async function read(account, reference, { signal } = {}) {
    referenceCheck(account, reference);
    return session(account, signal, client => locked(client, reference.path, true, async uidValidity => {
      if (uidValidity !== reference.uidValidity) fail('stale_message');
      let message = await verified(client, account, reference, { ...HEADER_QUERY, bodyStructure: true }, signal);
      const details = metadata(account, reference.path, uidValidity, message);
      const attachments = attachmentParts(message.bodyStructure);
      const part = preferredPart(message.bodyStructure);
      let body = { body: '', truncated: false, bodyUnavailable: true };
      if (part) {
        const section = part.part === '1' && !message.bodyStructure?.childNodes ? 'text' : part.part;
        const mimeSection = section === 'text' ? 'header' : `${section}.mime`;
        // HEADER.FIELDS and root HEADER share ImapFlow's message.headers slot.
        // Fetch only the complete bounded MIME header for a root body; retain the
        // References metadata already collected above regardless of response order.
        message = await verified(client, account, reference, { ...HEADER_QUERY, ...(section === 'text' ? { headers: false } : {}), bodyParts: [
          { key: mimeSection, start: 0, maxLength: 16384 }, { key: section, start: 0, maxLength: 65536 }
        ] }, signal);
        const parts = message.bodyParts instanceof Map ? message.bodyParts : new Map();
        body = await decodeBody({ raw: has(message.binaryParts, section) ? undefined : parts.get(section),
          mime: section === 'text' ? message.headers : parts.get(mimeSection), part });
        abortCheck(signal);
        if (!active.has(client)) fail('mailbox_error');
        if (validity(client, reference.path) !== uidValidity) fail('stale_message');
      }
      return { ...details, ...metadata(account, reference.path, uidValidity, message), references: details.references,
        threadId: details.threadId, ...body, attachments };
    }));
  }

  async function fetchSingleContent(client, account, reference, uidValidity, { signal, maxEncodedBytes, maxDecodedBytes, includeAttachments }) {
    const message = await verified(client, account, reference, { ...HEADER_QUERY, bodyStructure: true }, signal);
    const details = metadata(account, reference.path, uidValidity, message);
    const attachments = includeAttachments ? attachmentParts(message.bodyStructure) : [];

    const { plainParts, htmlParts, inlineParts, encrypted, truncated, segments } = findContentParts(message.bodyStructure);

    // If truncation/cycle omitted body, fail content_unavailable; never return complete after silently dropping body
    if (truncated && plainParts.length === 0 && htmlParts.length === 0) {
      fail('content_unavailable');
    }

    if (plainParts.length + htmlParts.length > 50) {
      fail('content_too_large');
    }

    // Initial reference revalidation check before body work
    abortCheck(signal);
    if (validity(client, reference.path) !== uidValidity) fail('stale_message');

    // Headers string: safe bounded text
    const unfolded = Buffer.isBuffer(message.headers) ? message.headers.toString('utf8').replace(/\r?\n[ \t]+/gu, ' ') : '';
    const headers = (unfolded || (Buffer.isBuffer(message.headers) ? message.headers.toString('utf8') : '')).slice(0, 32768);

    if (encrypted) {
      // Re-verify message identity and preserve Seen
      abortCheck(signal);
      if (validity(client, reference.path) !== uidValidity) fail('stale_message');
      await verified(client, account, reference, HEADER_QUERY, signal);

      return {
        ...details,
        text: '',
        html: '',
        headers,
        from: addressList(message.envelope.from),
        to: addressList(message.envelope.to),
        cc: addressList(message.envelope.cc),
        bcc: addressList(message.envelope.bcc),
        replyTo: addressList(message.envelope.replyTo),
        subject: clean(message.envelope.subject),
        messageId: messageIds(message.envelope.messageId)[0] ?? '',
        attachments,
        inlineParts,
        encrypted: { type: encrypted.type, decrypted: false },
        unsupportedEncrypted: true,
        sanitized: false,
        complete: false
      };
    }

    if (plainParts.length === 0 && htmlParts.length === 0) {
      // Re-verify message identity and preserve Seen
      abortCheck(signal);
      if (validity(client, reference.path) !== uidValidity) fail('stale_message');
      await verified(client, account, reference, HEADER_QUERY, signal);

      return {
        ...details,
        text: '',
        html: '',
        headers,
        from: addressList(message.envelope.from),
        to: addressList(message.envelope.to),
        cc: addressList(message.envelope.cc),
        bcc: addressList(message.envelope.bcc),
        replyTo: addressList(message.envelope.replyTo),
        subject: clean(message.envelope.subject),
        messageId: messageIds(message.envelope.messageId)[0] ?? '',
        attachments,
        inlineParts,
        encrypted: null,
        sanitized: false,
        complete: true
      };
    }

    // Check declared encoded sizes across all parts
    let declaredTotalEncoded = 0;
    for (const p of [...plainParts, ...htmlParts]) {
      if (Number.isSafeInteger(p.size) && p.size >= 0) {
        declaredTotalEncoded += p.size;
      }
    }
    if (declaredTotalEncoded > maxEncodedBytes) {
      fail('content_too_large');
    }

    const isRootStructure = !message.bodyStructure?.childNodes || message.bodyStructure.childNodes.length === 0;
    const bodyPartsToFetch = [];
    const partFetchInfos = [];
    let rootMimeRequested = false;

    for (const p of plainParts) {
      const isRoot = isRootStructure && p === message.bodyStructure;
      let sec, mimeSec;
      if (isRoot) {
        sec = 'text';
        mimeSec = 'header';
        rootMimeRequested = true;
      } else {
        const partId = String(p?.part ?? '');
        if (!validAttachmentId(partId)) fail('content_unavailable');
        sec = partId;
        mimeSec = `${sec}.mime`;
      }
      const hasDeclared = Number.isSafeInteger(p.size) && p.size >= 0;
      // Fetch declaredsize + 1 bounded (maxLength zero never emitted); unknown size max + 1
      const requestedLength = hasDeclared
        ? Math.min(maxEncodedBytes + 1, Math.max(1, p.size + 1))
        : (maxEncodedBytes + 1);
      bodyPartsToFetch.push({ key: mimeSec, start: 0, maxLength: 16384 });
      bodyPartsToFetch.push({ key: sec, start: 0, maxLength: requestedLength });
      partFetchInfos.push({ type: 'plain', sec, mimeSec, part: p, requestedLength, declaredSize: hasDeclared ? p.size : null });
    }

    for (const p of htmlParts) {
      const isRoot = isRootStructure && p === message.bodyStructure;
      let sec, mimeSec;
      if (isRoot) {
        sec = 'text';
        mimeSec = 'header';
        rootMimeRequested = true;
      } else {
        const partId = String(p?.part ?? '');
        if (!validAttachmentId(partId)) fail('content_unavailable');
        sec = partId;
        mimeSec = `${sec}.mime`;
      }
      const hasDeclared = Number.isSafeInteger(p.size) && p.size >= 0;
      const requestedLength = hasDeclared
        ? Math.min(maxEncodedBytes + 1, Math.max(1, p.size + 1))
        : (maxEncodedBytes + 1);
      bodyPartsToFetch.push({ key: mimeSec, start: 0, maxLength: 16384 });
      bodyPartsToFetch.push({ key: sec, start: 0, maxLength: requestedLength });
      partFetchInfos.push({ type: 'html', sec, mimeSec, part: p, requestedLength, declaredSize: hasDeclared ? p.size : null });
    }

    const allSizesKnown = partFetchInfos.every(info => info.declaredSize !== null);

    if (partFetchInfos.length <= 1 || allSizesKnown) {
      const query = {
        ...HEADER_QUERY,
        ...(rootMimeRequested ? { headers: false } : {}),
        bodyParts: bodyPartsToFetch
      };

      const fetched = await verified(client, account, reference, query, signal);
      const parts = fetched.bodyParts instanceof Map ? fetched.bodyParts : new Map();
      for (const info of partFetchInfos) {
        if (has(fetched.binaryParts, info.sec)) fail('content_unavailable');
        info.rawBody = parts.get(info.sec);
        info.rawMime = info.sec === 'text' ? fetched.headers : parts.get(info.mimeSec);
      }
    } else {
      let remainingBudget = maxEncodedBytes;
      for (const info of partFetchInfos) {
        abortCheck(signal);
        if (remainingBudget < 0) fail('content_too_large');
        const reqLen = info.declaredSize !== null
          ? Math.min(remainingBudget + 1, Math.max(1, info.declaredSize + 1))
          : (remainingBudget + 1);
        const query = {
          ...HEADER_QUERY,
          ...(info.sec === 'text' ? { headers: false } : {}),
          bodyParts: [
            { key: info.mimeSec, start: 0, maxLength: 16384 },
            { key: info.sec, start: 0, maxLength: reqLen }
          ]
        };
        const fetched = await verified(client, account, reference, query, signal);
        const parts = fetched.bodyParts instanceof Map ? fetched.bodyParts : new Map();
        if (has(fetched.binaryParts, info.sec)) fail('content_unavailable');
        const rawBody = parts.get(info.sec);
        const rawMime = info.sec === 'text' ? fetched.headers : parts.get(info.mimeSec);
        if (!Buffer.isBuffer(rawBody)) fail('content_unavailable');
        if (info.declaredSize !== null) {
          if (rawBody.length !== info.declaredSize) fail('content_unavailable');
        } else {
          if (rawBody.length > remainingBudget) fail('content_too_large');
        }
        remainingBudget -= rawBody.length;
        if (remainingBudget < 0) fail('content_too_large');
        info.rawBody = rawBody;
        info.rawMime = rawMime;
      }
    }

    let totalReceivedEncoded = 0;
    let cumulativeDecodedBytes = 0;
    const decodedMap = new Map();
    const decodedPlainList = [];
    const decodedHtmlList = [];

    for (const info of partFetchInfos) {
      const rawBody = info.rawBody;
      const rawMime = info.rawMime;

      // Missing buffers are errors, never complete empty text; true declared zero part is valid.
      if (!Buffer.isBuffer(rawBody)) {
        fail('content_unavailable');
      }

      if (info.declaredSize !== null) {
        // Require actual raw.length === declared. This proves provider did not lie about declared shorter length.
        if (rawBody.length !== info.declaredSize) {
          fail('content_unavailable');
        }
      } else {
        if (rawBody.length > maxEncodedBytes) fail('content_too_large');
      }

      totalReceivedEncoded += rawBody.length;
      if (totalReceivedEncoded > maxEncodedBytes) fail('content_too_large');

      const remainingDecoded = maxDecodedBytes - cumulativeDecodedBytes;
      if (remainingDecoded < 0) fail('content_too_large');
      const decoded = await decodeSinglePart(rawMime, rawBody, info.part, remainingDecoded);
      const partDecodedBytes = Buffer.byteLength(decoded);
      cumulativeDecodedBytes += partDecodedBytes;
      if (cumulativeDecodedBytes > maxDecodedBytes) fail('content_too_large');

      decodedMap.set(info.part, decoded);
      if (info.type === 'plain') decodedPlainList.push(decoded);
      else decodedHtmlList.push(decoded);
    }

    const hasPlainSegment = segments.some(s => s.kind === 'plain' || (s.kind === 'alternative' && (s.plain || s.plainParts?.length) && !s.html && !s.htmlParts?.length));
    const hasHtmlSegment = segments.some(s => s.kind === 'html' || (s.kind === 'alternative' && (s.html || s.htmlParts?.length)));
    const hasMixedSiblings = segments.length > 1 && hasPlainSegment && hasHtmlSegment;

    let decodedText = '';
    let decodedHtml = '';

    if (hasMixedSiblings) {
      // Escape plain into HTML when mixed sibling bodies exist, preserving ordered content safely
      const escapeHtml = str => String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      const textSegments = [];
      const htmlSegments = [];

      for (const s of segments) {
        if (s.kind === 'plain') {
          const t = decodedMap.get(s.part) ?? '';
          textSegments.push(t);
          htmlSegments.push(`<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(t)}</pre>`);
        } else if (s.kind === 'html') {
          const h = decodedMap.get(s.part) ?? '';
          htmlSegments.push(h);
        } else if (s.kind === 'alternative') {
          const plainText = s.plain ? (decodedMap.get(s.plain) ?? '') : (s.plainParts ?? []).map(p => decodedMap.get(p) ?? '').join('\n\n');
          const htmlText = s.html ? (decodedMap.get(s.html) ?? '') : (s.htmlParts ?? []).map(p => decodedMap.get(p) ?? '').join('\n');
          if (plainText) textSegments.push(plainText);
          if (htmlText) {
            htmlSegments.push(htmlText);
          } else if (plainText) {
            htmlSegments.push(`<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(plainText)}</pre>`);
          }
        }
      }

      decodedText = textSegments.join('\n\n');
      decodedHtml = htmlSegments.join('\n');
    } else {
      decodedText = decodedPlainList.join('\n\n');
      decodedHtml = decodedHtmlList.join('\n');
    }

    if (Buffer.byteLength(decodedText) + Buffer.byteLength(decodedHtml) > maxDecodedBytes) {
      fail('content_too_large');
    }

    // Inline PGP detection
    if (/-----BEGIN PGP MESSAGE-----/iu.test(decodedText)) {
      abortCheck(signal);
      if (validity(client, reference.path) !== uidValidity) fail('stale_message');
      await verified(client, account, reference, HEADER_QUERY, signal);

      return {
        ...details,
        text: '',
        html: '',
        headers,
        from: addressList(message.envelope.from),
        to: addressList(message.envelope.to),
        cc: addressList(message.envelope.cc),
        bcc: addressList(message.envelope.bcc),
        replyTo: addressList(message.envelope.replyTo),
        subject: clean(message.envelope.subject),
        messageId: messageIds(message.envelope.messageId)[0] ?? '',
        attachments,
        inlineParts,
        encrypted: { type: 'openpgp', decrypted: false },
        unsupportedEncrypted: true,
        sanitized: false,
        complete: false
      };
    }

    abortCheck(signal);
    if (validity(client, reference.path) !== uidValidity) fail('stale_message');
    await verified(client, account, reference, HEADER_QUERY, signal);

    return {
      ...details,
      text: decodedText,
      html: decodedHtml,
      headers,
      from: addressList(message.envelope.from),
      to: addressList(message.envelope.to),
      cc: addressList(message.envelope.cc),
      bcc: addressList(message.envelope.bcc),
      replyTo: addressList(message.envelope.replyTo),
      subject: clean(message.envelope.subject),
      messageId: messageIds(message.envelope.messageId)[0] ?? '',
      attachments,
      inlineParts,
      encrypted: null,
      sanitized: false,
      complete: true
    };
  }

  async function content(account, reference, options = {}) {
    referenceCheck(account, reference);
    const maxEncodedBytes = options.maxEncodedBytes ?? 4 * 1024 * 1024;
    const maxDecodedBytes = options.maxDecodedBytes ?? 2 * 1024 * 1024;
    const includeAttachments = options.includeAttachments ?? true;
    if (!Number.isSafeInteger(maxEncodedBytes) || maxEncodedBytes < 1 || maxEncodedBytes > 160 * 1024 * 1024) fail('invalid_request');
    if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1 || maxDecodedBytes > 8 * 1024 * 1024) fail('invalid_request');

    return session(account, options.signal, client => locked(client, reference.path, true, async uidValidity => {
      if (uidValidity !== reference.uidValidity) fail('stale_message');
      return fetchSingleContent(client, account, reference, uidValidity, {
        signal: options.signal,
        maxEncodedBytes,
        maxDecodedBytes,
        includeAttachments
      });
    }));
  }

  async function contentBatch(account, references, options = {}) {
    if (!Array.isArray(references) || references.length === 0) return [];
    if (references.length > 50) fail('invalid_request');
    for (const ref of references) referenceCheck(account, ref);
    const maxEncodedBytes = options.maxEncodedBytes ?? 4 * 1024 * 1024;
    const maxDecodedBytes = options.maxDecodedBytes ?? 2 * 1024 * 1024;
    const includeAttachments = options.includeAttachments ?? true;
    if (!Number.isSafeInteger(maxEncodedBytes) || maxEncodedBytes < 1 || maxEncodedBytes > 160 * 1024 * 1024) fail('invalid_request');
    if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1 || maxDecodedBytes > 8 * 1024 * 1024) fail('invalid_request');

    const byPath = new Map();
    for (const ref of references) {
      if (!byPath.has(ref.path)) byPath.set(ref.path, []);
      byPath.get(ref.path).push(ref);
    }

    const results = [];
    await session(account, options.signal, async client => {
      for (const [path, refs] of byPath) {
        abortCheck(options.signal);
        await locked(client, path, true, async uidValidity => {
          for (const ref of refs) {
            abortCheck(options.signal);
            if (uidValidity !== ref.uidValidity) {
              const resItem = { reference: ref, error: 'stale_message' };
              results.push(resItem);
              if (typeof options.onContent === 'function') {
                await options.onContent(resItem);
              }
              continue;
            }
            try {
              const item = await fetchSingleContent(client, account, ref, uidValidity, {
                signal: options.signal,
                maxEncodedBytes,
                maxDecodedBytes,
                includeAttachments
              });
              const resItem = { reference: ref, content: item };
              results.push(resItem);
              if (typeof options.onContent === 'function') {
                await options.onContent(resItem);
              }
            } catch (err) {
              const resItem = { reference: ref, error: err?.code || 'mailbox_error' };
              results.push(resItem);
              if (typeof options.onContent === 'function') {
                await options.onContent(resItem);
              }
            }
          }
        });
      }
    });
    return results;
  }

  async function attachment(account, reference, attachmentId, { signal, maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
    if (!validAttachmentId(attachmentId)) fail('invalid_request');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ATTACHMENT_BYTES) fail('invalid_request');
    referenceCheck(account, reference);
    return session(account, signal, client => locked(client, reference.path, true, async uidValidity => {
      if (uidValidity !== reference.uidValidity) fail('stale_message');
      const message = await verified(client, account, reference, { ...HEADER_QUERY, bodyStructure: true }, signal);
      const part = attachmentPart(message.bodyStructure, attachmentId);
      if (!part) fail('attachment_unavailable');
      if ((Number.isSafeInteger(part.metadata?.size) && part.metadata.size > maxBytes) ||
          (part.encoding === 'base64' && Number.isSafeInteger(part.encodedSize) && Math.floor(part.encodedSize * 3 / 4) > maxBytes)) {
        fail('attachment_too_large');
      }
      const bytes = await attachmentBytes(part, async (start, maxLength) => {
        const fetched = await verified(client, account, reference, { ...HEADER_QUERY,
          bodyParts: [{ key: part.section, start, maxLength }] }, signal);
        if (has(fetched.binaryParts, part.section)) fail('attachment_unavailable');
        return fetched.bodyParts instanceof Map ? fetched.bodyParts.get(part.section) : undefined;
      }, { maxBytes });
      if (bytes.length > maxBytes) fail('attachment_too_large');
      // Never serve bytes collected after the referenced message/mailbox changed.
      await verified(client, account, reference, HEADER_QUERY, signal);
      return { filename: part.metadata.filename, mimeType: part.metadata.mimeType, bytes };
    }));
  }

  async function source(account, reference, { signal, maxBytes = 100 * 1024 * 1024 } = {}) {
    referenceCheck(account, reference);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 160 * 1024 * 1024) fail('invalid_request');
    return session(account, signal, client => locked(client, reference.path, true, async uidValidity => {
      if (uidValidity !== reference.uidValidity) fail('stale_message');
      const first = await verified(client, account, reference, HEADER_QUERY, signal);
      if (!Number.isSafeInteger(first.size) || first.size < 0) fail('mailbox_error');
      if (first.size > maxBytes) fail('message_too_large');
      const chunks = [];
      let length = 0;
      // Providers can report an RFC822.SIZE that differs from the downloadable
      // source. Read through an explicit EOF instead of truncating or failing at
      // that estimate, with a one-byte probe to enforce the actual byte limit.
      while (true) {
        const maxLength = Math.min(65536, maxBytes - length + 1);
        const result = await verified(client, account, reference, { ...HEADER_QUERY, source: { start: length, maxLength } }, signal);
        if (!Buffer.isBuffer(result.source) || result.source.length > maxLength) fail('mailbox_error');
        if (result.source.length === 0) {
          if (length === 0 && first.size > 0) fail('mailbox_error');
          break;
        }
        if (length + result.source.length > maxBytes) fail('message_too_large');
        chunks.push(result.source); length += result.source.length;
      }
      await verified(client, account, reference, HEADER_QUERY, signal);
      return Buffer.concat(chunks, length);
    }));
  }

  function destination(mapped, id) {
    const targets = mapped[id];
    if (!Array.isArray(targets) || targets.length !== 1 || ['all', 'unread', 'starred'].includes(id)) fail('mailbox_error');
    return targets[0];
  }

  function safeTrash(mapped, reference) {
    if (mapped.trash.length !== 1) fail('delete_unavailable');
    const trash = mapped.trash[0];
    if (pathEqual(trash.path, 'INBOX') || ['\\Sent', '\\Drafts', '\\Archive', '\\Junk', '\\All'].some(flag => folderFlag(trash, flag)) ||
      (reference && !pathEqual(trash.path, reference.path))) fail('delete_unavailable');
    return trash;
  }

  async function deleteExact(client, account, reference, signal) {
    if (!client.capabilities?.has('UIDPLUS') || client.mailbox.readOnly) fail('delete_unavailable');
    await verified(client, account, reference, HEADER_QUERY, signal);
    if (!client.capabilities?.has('UIDPLUS')) fail('delete_unavailable');
    // Never call ImapFlow's fallback EXPUNGE. Check STORE acknowledgement before
    // issuing an exact UID EXPUNGE, which leaves concurrent Deleted mail intact.
    if (!await client.messageFlagsAdd(String(reference.uid), ['\\Deleted'], { uid: true })) fail('mailbox_error');
    abortCheck(signal);
    if (!active.has(client) || validity(client, reference.path) !== reference.uidValidity) fail('mailbox_error');
    const response = await client.exec('UID EXPUNGE', [{ type: 'SEQUENCE', value: String(reference.uid) }]);
    response.next();
    return { applied: true };
  }

  async function apply(account, reference, action, { signal, destinationId } = {}) {
    if (!['mark_read', 'mark_unread', 'star', 'unstar', 'delete', 'archive', 'move', 'restore', 'spam', 'not_spam', 'delete_permanent'].includes(action) ||
      (action === 'move' && !VALID_FOLDERS.has(destinationId) && !customId(destinationId))) fail('invalid_request');
    referenceCheck(account, reference);
    const outcome = await session(account, signal, async client => {
      let target, mapped;
      if (['delete', 'archive', 'move', 'restore', 'spam', 'not_spam', 'delete_permanent'].includes(action)) {
        mapped = resolveFolders(client, await client.list(), account);
        abortCheck(signal);
        if (!active.has(client)) fail('mailbox_error');
        if (action === 'delete_permanent') safeTrash(mapped, reference);
        else if (action === 'delete') target = safeTrash(mapped);
        else {
          const id = action === 'move' ? destinationId : action === 'archive' ? 'archive' : action === 'spam' ? 'junk' : 'inbox';
          if (action === 'archive' && mapped.archive.length !== 1) fail('archive_unavailable');
          target = destination(mapped, id);
          if (action === 'archive' && (pathEqual(target.path, 'INBOX') || ['junk', 'trash', 'sent', 'drafts'].some(kind =>
            mapped[kind].some(item => pathEqual(item.path, target.path))))) fail('archive_unavailable');
        }
        if (target && pathEqual(target.path, reference.path) && !target.gmailArchive) fail(action === 'delete' ? 'delete_unavailable' : 'invalid_request');
      }
      // Gmail can omit the selected Inbox's own label and ignore removing it
      // there. Reuse the production archive path, which resolves the exact All
      // Mail alias and confirms both its labels and fresh Inbox absence.
      if (target?.gmailArchive && action === 'archive') return { gmailArchive: true };
      return locked(client, reference.path, false, async uidValidity => {
        if (uidValidity !== reference.uidValidity) fail('stale_message');
        if (client.mailbox.readOnly) fail(action === 'delete' ? 'delete_unavailable' : 'stale_message');
        if (action === 'delete_permanent') return deleteExact(client, account, reference, signal);
        const message = await verified(client, account, reference, { ...HEADER_QUERY, ...(target?.gmailArchive ? { labels: true } : {}) }, signal);
        abortCheck(signal);
        if (!active.has(client)) fail('mailbox_error');
        if (target) {
          // ImapFlow emulates MOVE with COPY/DELETE/EXPUNGE without this capability.
          // Require native MOVE so unrelated messages marked Deleted cannot be lost.
          if (!client.capabilities?.has('MOVE')) fail(action === 'archive' ? 'archive_unavailable' : 'delete_unavailable');
          const moved = await client.messageMove(String(reference.uid), target.path, { uid: true });
          if (!moved) fail('mailbox_error');
          const movedUid = moved.uidMap instanceof Map ? moved.uidMap.get(reference.uid) : undefined;
          if (validUid(movedUid) && /^\d{1,20}$/u.test(String(moved.uidValidity ?? ''))) {
            const movedReference = { ...reference, uid: movedUid, uidValidity: String(moved.uidValidity), path: target.path };
            return { applied: true, reference: movedReference, destinationId: folderId(account, target.path), destinationPath: target.path,
              undo: { reference: movedReference, destinationId: folderId(account, reference.path) } };
          }
          return { applied: true };
        }
        const flag = ['mark_read', 'mark_unread'].includes(action) ? '\\Seen' : '\\Flagged';
        const method = ['mark_read', 'star'].includes(action) ? 'messageFlagsAdd' : 'messageFlagsRemove';
        if (!await client[method](String(reference.uid), [flag], { uid: true })) fail('mailbox_error');
        return { applied: true };
      });
    });
    if (!outcome.gmailArchive) return outcome;
    const archived = await gmailArchiveReader.move(account, reference, 'archive', { signal, verify: async () => abortCheck(signal) });
    if (!['applied', 'already_target'].includes(archived.status)) fail(archived.status === 'target_unavailable' ? 'archive_unavailable' : 'stale_message');
    return { applied: true, ...(archived.reference ? { reference: archived.reference, destinationPath: archived.reference.path,
      destinationId: folderId(account, archived.reference.path), ...(pathEqual(reference.path, 'INBOX') ? {
        undo: { reference: archived.reference, destinationId: folderId(account, reference.path) }
      } : {}) } : {}) };
  }

  async function emptyTrash(account, { signal, confirm, limit = 100 } = {}) {
    if (confirm !== true || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_request');
    validateAccounts([account]);
    return session(account, signal, async client => {
      const target = safeTrash(resolveFolders(client, await client.list(), account));
      if (!client.capabilities?.has('UIDPLUS')) fail('delete_unavailable');
      const snapshot = await locked(client, target.path, true, async uidValidity => {
        const uids = await client.search({ deleted: false }, { uid: true });
        if (!Array.isArray(uids) || uids.some(uid => !validUid(uid))) fail('mailbox_error');
        const chosen = [...new Set(uids)].sort((a, b) => a - b).slice(0, limit), references = [], received = new Set();
        if (chosen.length) for await (const message of client.fetch(chosen.join(','), HEADER_QUERY, { uid: true })) {
          abortCheck(signal);
          if (chosen.includes(message?.uid) && !received.has(message.uid) && validMessage(message)) {
            received.add(message.uid); references.push(metadata(account, target.path, uidValidity, message).reference);
          }
        }
        if (validity(client, target.path) !== uidValidity) fail('stale_message');
        return { references, uidValidity, total: uids.length };
      });
      return locked(client, target.path, false, async uidValidity => {
        if (uidValidity !== snapshot.uidValidity) fail('stale_message');
        const errors = [];
        let deleted = 0;
        for (const reference of snapshot.references) {
          try { await deleteExact(client, account, reference, signal); deleted++; }
          catch (error) {
            if (error.code === 'cancelled') throw error;
            errors.push({ uid: reference.uid, code: error.code || 'mailbox_error' });
            if (error.code !== 'stale_message') break;
          }
        }
        const remainingUids = await client.search({ deleted: false }, { uid: true });
        if (!Array.isArray(remainingUids) || remainingUids.some(uid => !validUid(uid))) fail('mailbox_error');
        const remaining = remainingUids.length;
        return { deleted, remaining, partial: errors.length > 0 || remaining > 0, errors };
      });
    });
  }

  async function manageFolder(account, request, { signal } = {}) {
    validateAccounts([account]);
    if (!request || !['create', 'rename'].includes(request.action) || typeof request.name !== 'string' || !request.name.trim() ||
      request.name !== request.name.trim() || request.name.length > 100 || /[\x00-\x1f\x7f\\/*%]/u.test(request.name) ||
      ['.', '..'].includes(request.name)) fail('invalid_request');
    return session(account, signal, async client => {
      const raw = await client.list(), mapped = resolveFolders(client, raw, account);
      const original = request.action === 'rename' ? destination(mapped, request.folderId) : null;
      if (original && (!customId(request.folderId) || original.specialUse ||
        DEFINITIONS.some(([, , flag]) => flag && folderFlag(original, flag)) || !mapped.provider.some(item => item.path === original.path))) fail('invalid_request');
      const parent = request.parentId ? destination(mapped, request.parentId) : null;
      const delimiter = parent?.delimiter ?? original?.delimiter ?? raw.find(item => item.delimiter)?.delimiter ?? '/';
      if (typeof delimiter !== 'string' || delimiter.length !== 1 || request.name.includes(delimiter)) fail('invalid_request');
      const originalParent = original?.path.includes(delimiter) ? original.path.slice(0, original.path.lastIndexOf(delimiter)) : '';
      const prefix = parent?.path ?? originalParent;
      const path = prefix ? `${prefix}${delimiter}${request.name}` : request.name;
      if (!selectable({ path }) || raw.some(item => pathEqual(item.path, path)) || pathEqual(path, 'INBOX')) fail('invalid_request');
      abortCheck(signal);
      if (!active.has(client)) fail('mailbox_error');
      const result = original ? await client.mailboxRename(original.path, path) : await client.mailboxCreate(path);
      if (!result) fail('mailbox_error');
      const actualPath = result.newPath || result.path || path;
      return { applied: true, folder: { id: folderId(account, actualPath), label: clean(request.name, 200), type: 'provider', accountIds: [account.id], counts: [] } };
    });
  }

  async function providerLabels(account, { signal } = {}) {
    validateAccounts([account]);
    return session(account, signal, async client => {
      const mapped = resolveFolders(client, await client.list(), account);
      if (client.capabilities?.has('X-GM-EXT-1')) return { supported: true, kind: 'gmail', labels: mapped.provider.map(folder => folder.path).filter(safeLabel), allowCreate: true };
      const labels = new Set();
      let allowCreate = false;
      for (const folder of mapped.all) await locked(client, folder.path, true, async () => {
        for (const label of client.mailbox.permanentFlags ?? []) if (keywordLabel(label)) labels.add(label);
        allowCreate ||= has(client.mailbox.permanentFlags, '\\*');
      });
      return { supported: allowCreate || labels.size > 0, kind: 'keywords', labels: [...labels].sort(), allowCreate };
    });
  }

  async function setProviderLabel(account, reference, { label, enabled } = {}, { signal } = {}) {
    referenceCheck(account, reference);
    if (!safeLabel(label) || typeof enabled !== 'boolean') fail('invalid_request');
    return session(account, signal, client => locked(client, reference.path, false, async uidValidity => {
      if (uidValidity !== reference.uidValidity || client.mailbox.readOnly) fail('stale_message');
      await verified(client, account, reference, HEADER_QUERY, signal);
      const gmail = client.capabilities?.has('X-GM-EXT-1') === true;
      if (!gmail && (!keywordLabel(label) || (!has(client.mailbox.permanentFlags, '\\*') && !has(client.mailbox.permanentFlags, label)))) fail('invalid_request');
      const method = enabled ? 'messageFlagsAdd' : 'messageFlagsRemove';
      if (!await client[method](String(reference.uid), [label], { uid: true, ...(gmail ? { useLabels: true } : {}) })) fail('mailbox_error');
      return { applied: true };
    }));
  }

  async function changes(accounts, { signal } = {}) {
    validateAccounts(accounts);
    const states = [], errors = [];
    await forAccounts(accounts, async account => {
      try {
        await session(account, signal, async client => {
          const mapped = resolveFolders(client, await client.list(), account);
          for (const folder of mapped.inbox) {
            abortCheck(signal);
            const status = await client.status(folder.path, { uidNext: true, uidValidity: true, unseen: true, messages: true });
            abortCheck(signal);
            if (!active.has(client) || !validUid(status?.uidNext) || !/^\d{1,20}$/u.test(String(status?.uidValidity ?? '')) ||
              !Number.isSafeInteger(status?.unseen) || status.unseen < 0 || !Number.isSafeInteger(status?.messages) || status.messages < 0) fail('mailbox_error');
            states.push({ accountId: account.id, folderId: folderId(account, folder.path), uidValidity: String(status.uidValidity),
              uidNext: status.uidNext, unseen: status.unseen, messages: status.messages });
          }
        });
      } catch (error) { if (error.code === 'cancelled') throw error; errors.push({ accountId: account.id, code: error.code }); }
    });
    states.sort((a, b) => a.accountId.localeCompare(b.accountId) || a.folderId.localeCompare(b.folderId));
    errors.sort((a, b) => a.accountId.localeCompare(b.accountId));
    return { signature: hash(states), states, errors };
  }

  return { folders, list, read, content, contentBatch, attachment, source, apply, emptyTrash, manageFolder, providerLabels, setProviderLabel, changes };
}
