import { createHash } from 'node:crypto';
import { decodeBody, BODY_SOURCE_LIMIT, PROCESSING_SOURCE_LIMIT, CONTENT_EXTRACTION_VERSION } from './body.mjs';
import { MailHarborError, errorMessages } from './validation.mjs';
import { createMailboxSession, cleanMailText as clean, hasMailFlag as has, mailFingerprint as fingerprint,
  mailTimestamp as timestamp, preferredMailPart as preferredPart, selectableMailbox as selectable } from './mailboxes.mjs';

const HEADERS = Object.freeze({ uid: true, envelope: true, flags: true, internalDate: true, size: true });
const MAX_BATCH = 250;
const UID_WINDOW = 4096;
const MAX_WINDOWS = 16;
const ROLES = [
  ['sent', '\\Sent', ['sent', 'sent items', 'sent messages', 'inbox.sent']],
  ['drafts', '\\Drafts', ['drafts', 'draft', 'inbox.drafts']],
  ['junk', '\\Junk', ['junk', 'spam', 'junk email', 'junk e-mail', 'inbox.junk']],
  ['trash', '\\Trash', ['trash', 'deleted items', 'deleted messages', 'inbox.trash']],
  ['archive', '\\Archive', ['archive', 'archives', 'inbox.archive']]
];
const fail = code => { throw new MailHarborError(code, errorMessages[code] ?? 'The mailbox request could not be completed.'); };
const abortCheck = signal => { if (signal?.aborted) fail('cancelled'); };
const validUid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const validPosition = value => value === 0 || validUid(value);
const validValidity = value => typeof value === 'string' && /^\d{1,20}$/u.test(value);
const equalPath = (left, right) => left === right || (String(left).toUpperCase() === 'INBOX' && String(right).toUpperCase() === 'INBOX');
const flag = (folder, value) => String(folder.specialUse ?? '').toLowerCase() === value.toLowerCase() || has(folder.flags, value);
const validMail = mail => mail && validUid(mail.uid) && mail.flags instanceof Set && mail.envelope && !has(mail.flags, '\\Deleted');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => { const date = value == null || value === '' ? NaN : new Date(value).getTime(); return Number.isFinite(date) ? new Date(date).toISOString() : ''; };
const addresses = values => clean((values ?? []).map(value => value.name ? `${value.name} <${value.address ?? ''}>` : value.address ?? '').join(', '));

function collectExpectedHeaders(requested, { gmail = false, bodyStructure = false } = {}) {
  const messages = new Map(), headers = new Map(), identities = new Map();
  const fullHeaders = message => message.envelope && typeof message.envelope === 'object' && !Array.isArray(message.envelope) &&
    message.flags instanceof Set && message.internalDate != null && Number.isSafeInteger(message.size) && message.size >= 0;
  return {
    add(message) {
      if (!requested.has(message?.uid)) return;
      const previous = messages.get(message.uid) ?? headers.get(message.uid);
      if (fullHeaders(message)) {
        const identity = fingerprint(message), old = identities.get(message.uid);
        if (old && old !== identity) fail('stale_message');
        identities.set(message.uid, identity);
        headers.set(message.uid, { ...message });
        if ((!gmail || message.labels instanceof Set) && (!bodyStructure || Object.hasOwn(message, 'bodyStructure'))) {
          messages.set(message.uid, { ...message }); return;
        }
      }
      // ImapFlow streams unsolicited FETCH notifications with requested results.
      // A partial notification must neither mask a later full row nor discard a
      // previously received envelope. New mutable flags still supersede old flags.
      if (previous) {
        if (message.flags instanceof Set) previous.flags = new Set(message.flags);
        if (message.labels instanceof Set) previous.labels = new Set(message.labels);
      }
    },
    get(uid) { return messages.get(uid) ?? headers.get(uid); }
  };
}

function checkAccount(account) {
  if (!account || typeof account.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(account.id)) fail('invalid_request');
}

function checkReference(account, reference) {
  if (!reference || reference.accountId !== account.id || !validUid(reference.uid) || !validValidity(reference.uidValidity) ||
    typeof reference.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.fingerprint) || !selectable({ path: reference.path })) fail('stale_message');
}

function discovery(client, raw, account) {
  if (!Array.isArray(raw) || raw.length > 1000) fail('mailbox_error');
  const gmail = client.capabilities?.has('X-GM-EXT-1') === true;
  const available = raw.filter(selectable).filter((folder, index, all) => all.findIndex(other => equalPath(other.path, folder.path)) === index);
  const folders = available.map(folder => {
    const special = ROLES.find(([, value]) => flag(folder, value));
    const fallback = !folder.specialUse && !flag(folder, '\\All') && !flag(folder, '\\Flagged') &&
      ROLES.find(([, , names]) => names.includes(folder.path.toLowerCase()));
    const gmailAll = gmail && flag(folder, '\\All');
    let role = folder.path.toUpperCase() === 'INBOX' ? 'inbox' : special?.[0] ?? fallback?.[0] ?? (gmailAll ? 'archive' : 'other');
    if (account.archivePath === folder.path && !['inbox', 'sent', 'drafts', 'junk', 'trash'].includes(role)) role = 'archive';
    return { path: folder.path, role, gmailAll, aggregate: flag(folder, '\\Flagged') || (!gmail && flag(folder, '\\All')),
      specialUse: special?.[1] ?? (flag(folder, '\\All') ? '\\All' : '') };
  });
  return { folders, gmail };
}

function roleFor(folder, message) {
  // Sent/Drafts apply even if the Gmail message also has an Inbox label.
  if (['trash', 'junk'].includes(folder.role)) return folder.role;
  for (const [role, value] of [['trash', '\\Trash'], ['junk', '\\Junk'], ['drafts', '\\Draft'], ['drafts', '\\Drafts'], ['sent', '\\Sent']]) {
    if (has(message.labels, value)) return role;
  }
  if (!folder.gmailAll) return folder.role;
  return has(message.labels, '\\Inbox') ? 'inbox' : 'archive';
}

function metadata(account, folder, uidValidity, message) {
  const reference = { accountId: account.id, path: folder.path, uidValidity, uid: message.uid, fingerprint: fingerprint(message) };
  const receivedAt = iso(message.internalDate), time = timestamp(message);
  return { id: hash(reference), accountId: account.id, account: clean(account.label || account.email || account.id),
    folderPath: folder.path, role: roleFor(folder, message), subject: clean(message.envelope.subject),
    author: addresses(message.envelope.from), to: addresses(message.envelope.to), cc: addresses(message.envelope.cc),
    messageId: clean(message.envelope.messageId, 1000), emailId: clean(message.emailId, 200),
    date: time ? new Date(time).toISOString() : '', internalDate: receivedAt, receivedAt,
    unread: !has(message.flags, '\\Seen'), starred: has(message.flags, '\\Flagged'),
    flags: [...message.flags].slice(0, 100).map(value => clean(value, 100)),
    labels: [...(message.labels ?? [])].slice(0, 100).map(value => clean(value, 1024)),
    size: Number.isSafeInteger(message.size) && message.size >= 0 ? message.size : null,
    contentSignature: reference.fingerprint, reference };
}

/** Bounded all-folder transport. The caller persists checkpoints and classification results. */
export function createMailProcessingReader({ connectionOptions, createClient, sessionTimeoutMs } = {}) {
  const { session, active } = createMailboxSession({ connectionOptions, createClient, sessionTimeoutMs });

  function live(client, signal) {
    abortCheck(signal);
    if (!active.has(client)) fail('mailbox_error');
  }

  async function verifyNow(verify, client, signal) {
    abortCheck(signal);
    if (await verify?.() === false) fail('stale_message');
    live(client, signal);
  }

  function validity(client, path) {
    const value = String(client.mailbox?.uidValidity ?? '');
    if (!equalPath(client.mailbox?.path, path) || !validValidity(value)) fail('mailbox_error');
    return value;
  }

  async function locked(client, path, readOnly, operation) {
    const lock = await client.getMailboxLock(path, { readOnly });
    try { return await operation(validity(client, path)); }
    finally { lock.release(); }
  }

  async function mapped(client, account, signal) {
    const result = discovery(client, await client.list(), account);
    live(client, signal);
    return result;
  }

  function findFolder(folders, path) {
    const folder = folders.find(value => equalPath(value.path, path));
    if (!folder) fail('stale_message');
    return folder;
  }

  async function folders(account, { signal, verify } = {}) {
    checkAccount(account);
    return session(account, signal, async client => {
      await verifyNow(verify, client, signal);
      return mapped(client, account, signal);
    });
  }

  async function verifiedOne(client, reference, query, signal) {
    // FETCH streams may include unsolicited rows before the requested UID.
    // ImapFlow.fetchOne returns the first row, so collect the exact UID instead.
    const received = collectExpectedHeaders(new Set([reference.uid]), { gmail: query.labels === true, bodyStructure: query.bodyStructure === true });
    let observed = false;
    for await (const message of client.fetch(String(reference.uid), query, { uid: true, binary: false })) {
      live(client, signal);
      if (message?.uid === reference.uid) observed = true;
      received.add(message);
    }
    live(client, signal);
    if (validity(client, reference.path) !== reference.uidValidity) return { status: 'changed' };
    const message = received.get(reference.uid);
    if (!message) return { status: observed ? 'changed' : 'absent' };
    if (!validMail(message) || message.uid !== reference.uid || fingerprint(message) !== reference.fingerprint ||
        (query.labels === true && !(message.labels instanceof Set))) return { status: 'changed' };
    return { status: 'verified', message };
  }

  async function bodyFor(client, folder, reference, message, signal) {
    const part = preferredPart(message.bodyStructure);
    if (!part) {
      const pending = [message.bodyStructure];
      let encrypted = false, inspected = 0;
      while (pending.length && inspected++ < 1000) {
        const node = pending.shift(), type = String(node?.type ?? '').trim().toLowerCase();
        if (type === 'multipart/encrypted' || /^application\/(?:x-)?(?:pkcs7-mime|pgp-encrypted)$/u.test(type)) encrypted = true;
        if (Array.isArray(node?.childNodes)) pending.push(...node.childNodes.slice(0, 1000 - inspected - pending.length));
      }
      return { body: '', truncated: false, bodyUnavailable: true, extractionVersion: CONTENT_EXTRACTION_VERSION,
        contentReasons: [encrypted ? 'encrypted_content' : message.bodyStructure ? 'unsupported_content' : 'unavailable_part'] };
    }
    const section = part.part === '1' && !message.bodyStructure?.childNodes ? 'text' : part.part;
    const mimeSection = section === 'text' ? 'header' : `${section}.mime`;
    const readPrefix = async sourceByteLimit => {
      const result = await verifiedOne(client, reference, { ...HEADERS, bodyParts: [
        { key: mimeSection, start: 0, maxLength: 16384 }, { key: section, start: 0, maxLength: sourceByteLimit }
      ] }, signal);
      if (result.status !== 'verified') fail('stale_message');
      const current = result.message, parts = current.bodyParts instanceof Map ? current.bodyParts : new Map();
      const value = await decodeBody({ raw: has(current.binaryParts, section) ? undefined : parts.get(section),
        mime: section === 'text' ? current.headers : parts.get(mimeSection), part, sourceByteLimit });
      live(client, signal);
      if (validity(client, folder.path) !== reference.uidValidity) fail('stale_message');
      return value;
    };
    let body = await readPrefix(BODY_SOURCE_LIMIT);
    // Long HTML/encoding overhead can hide short useful text. Expand once locally only
    // when the source limit is the cause; the AI still receives at most 8,000 characters.
    if (body.contentReasons.includes('encoded_byte_limit') &&
        (!body.bodyUnavailable || body.contentReasons.includes('empty_content')) &&
        body.contentReasons.every(reason => ['encoded_byte_limit', 'decoded_byte_limit', 'empty_content'].includes(reason))) {
      body = await readPrefix(PROCESSING_SOURCE_LIMIT);
    }
    return body;
  }

  async function scan(account, { path, afterUid = 0, uidValidity = null, highWatermark = null, limit = 100,
    includeBodies = false, signal, verify } = {}) {
    checkAccount(account);
    if (!selectable({ path }) || !validPosition(afterUid) || (uidValidity !== null && !validValidity(uidValidity)) ||
      (afterUid > 0 && uidValidity === null) || (highWatermark !== null && !validPosition(highWatermark)) ||
      !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH || typeof includeBodies !== 'boolean') fail('invalid_request');
    return session(account, signal, async client => {
      await verifyNow(verify, client, signal);
      const { folders, gmail } = await mapped(client, account, signal), folder = findFolder(folders, path);
      return locked(client, folder.path, true, async currentValidity => {
        if (uidValidity !== null && currentValidity !== uidValidity) fail('stale_message');
        const uidNext = Number(client.mailbox.uidNext);
        if (!Number.isSafeInteger(uidNext) || uidNext < 1 || uidNext > 0x100000000) fail('mailbox_error');
        const ceiling = highWatermark ?? uidNext - 1;
        if (ceiling >= uidNext || afterUid > ceiling) fail('stale_message');
        const messages = [];
        let position = afterUid, windows = 0, examined = 0;
        while (position < ceiling && messages.length < limit && windows++ < MAX_WINDOWS) {
          live(client, signal);
          const end = Math.min(ceiling, position + UID_WINDOW);
          // Numeric upper bounds avoid IMAP's surprising reversed n:* range behavior.
          const found = await client.search({ uid: `${position + 1}:${end}`, deleted: false }, { uid: true });
          live(client, signal);
          if (!Array.isArray(found) || found.length > UID_WINDOW || found.some(uid => !validUid(uid) || uid <= position || uid > end)) fail('mailbox_error');
          const sorted = [...new Set(found)].sort((left, right) => left - right);
          const selected = sorted.slice(0, limit - messages.length), requested = new Set(selected);
          const received = collectExpectedHeaders(requested, { gmail, bodyStructure: includeBodies });
          if (selected.length) {
            for await (const message of client.fetch(selected.join(','), { ...HEADERS, ...(gmail ? { labels: true } : {}),
              ...(includeBodies ? { bodyStructure: true } : {}) }, { uid: true })) {
              live(client, signal);
              received.add(message);
            }
            live(client, signal);
            if (validity(client, folder.path) !== currentValidity) fail('stale_message');
            for (const uid of selected) {
              const message = received.get(uid);
              if (!validMail(message)) continue;
              if (gmail && !(message.labels instanceof Set)) fail('mailbox_error');
              const value = metadata(account, folder, currentValidity, message);
              if (includeBodies) Object.assign(value, await bodyFor(client, folder, value.reference, message, signal));
              messages.push(value);
            }
          }
          examined += selected.length;
          position = selected.length < sorted.length ? selected.at(-1) : end;
        }
        await verifyNow(verify, client, signal);
        return { messages, uidValidity: currentValidity, highWatermark: ceiling, afterUid: position, done: position >= ceiling,
          total: Number.isSafeInteger(client.mailbox.exists) && client.mailbox.exists >= 0 ? client.mailbox.exists : null,
          role: folder.role, examined };
      });
    });
  }

  async function read(account, reference, { signal, verify } = {}) {
    checkAccount(account); checkReference(account, reference);
    return session(account, signal, async client => {
      await verifyNow(verify, client, signal);
      const { folders, gmail } = await mapped(client, account, signal), folder = findFolder(folders, reference.path);
      return locked(client, folder.path, true, async uidValidity => {
        if (uidValidity !== reference.uidValidity) fail('stale_message');
        const result = await verifiedOne(client, reference, { ...HEADERS, bodyStructure: true, ...(gmail ? { labels: true } : {}) }, signal);
        if (result.status !== 'verified') fail('stale_message');
        if (gmail && !(result.message.labels instanceof Set)) fail('mailbox_error');
        const body = await bodyFor(client, folder, reference, result.message, signal);
        await verifyNow(verify, client, signal);
        return { ...metadata(account, folder, uidValidity, result.message), ...body };
      });
    });
  }

  // Arrival monitoring needs a baseline without enumerating historical mail.
  async function checkpoint(account, { path = 'INBOX', signal, verify } = {}) {
    checkAccount(account);
    if (!selectable({ path })) fail('invalid_request');
    return session(account, signal, async client => {
      await verifyNow(verify, client, signal);
      return locked(client, path, true, async uidValidity => {
        const uidNext = Number(client.mailbox.uidNext);
        if (!Number.isSafeInteger(uidNext) || uidNext < 1 || uidNext > 0x100000000) fail('mailbox_error');
        await verifyNow(verify, client, signal);
        if (validity(client, path) !== uidValidity) fail('stale_message');
        return { path, uidValidity, afterUid: uidNext - 1 };
      });
    });
  }

  // Capture trusted ingress headers with the same identity checks as body reads.
  // BODY.PEEK through a read-only lock preserves Seen and bounds header input.
  async function readNotification(account, reference, { signal, verify } = {}) {
    checkAccount(account); checkReference(account, reference);
    return session(account, signal, async client => {
      await verifyNow(verify, client, signal);
      const { folders, gmail } = await mapped(client, account, signal), folder = findFolder(folders, reference.path);
      return locked(client, folder.path, true, async uidValidity => {
        if (uidValidity !== reference.uidValidity) fail('stale_message');
        const checked = await verifiedOne(client, reference, { ...HEADERS, bodyStructure: true,
          ...(gmail ? { labels: true } : {}), bodyParts: [{ key: 'header', start: 0, maxLength: 32768 }] }, signal);
        if (checked.status !== 'verified') fail('stale_message');
        const raw = checked.message.headers ?? checked.message.bodyParts?.get?.('header');
        const headers = Buffer.isBuffer(raw) ? raw.toString('utf8').slice(0, 32768) : '';
        const body = await bodyFor(client, folder, reference, checked.message, signal);
        await verifyNow(verify, client, signal);
        if (validity(client, folder.path) !== uidValidity) fail('stale_message');
        return { ...metadata(account, folder, uidValidity, checked.message), ...body, headers };
      });
    });
  }

  async function readBatch(account, references, { signal, verify } = {}) {
    checkAccount(account);
    if (!Array.isArray(references) || references.length > 40) fail('invalid_request');
    for (const reference of references) {
      checkReference(account, reference);
      if (!equalPath(reference.path, references[0].path) || reference.uidValidity !== references[0].uidValidity) fail('invalid_request');
    }
    if (new Set(references.map(reference => reference.uid)).size !== references.length) fail('invalid_request');
    if (!references.length) return { messages: [], errors: [] };
    return session(account, signal, async client => {
      await verifyNow(verify, client, signal);
      const { folders, gmail } = await mapped(client, account, signal), folder = findFolder(folders, references[0].path);
      return locked(client, folder.path, true, async uidValidity => {
        if (uidValidity !== references[0].uidValidity) fail('stale_message');
        const expected = new Map(references.map(reference => [reference.uid, reference]));
        const fetched = collectExpectedHeaders(expected, { gmail, bodyStructure: true });
        for await (const message of client.fetch([...expected.keys()].join(','), { ...HEADERS, bodyStructure: true,
          ...(gmail ? { labels: true } : {}) }, { uid: true })) {
          live(client, signal);
          fetched.add(message);
        }
        live(client, signal);
        if (validity(client, folder.path) !== uidValidity) fail('stale_message');
        const messages = [], errors = [];
        for (const reference of references) {
          const message = fetched.get(reference.uid);
          if (!validMail(message) || fingerprint(message) !== reference.fingerprint || (gmail && !(message.labels instanceof Set))) {
            errors.push({ reference, code: 'stale_message' }); continue;
          }
          try {
            const body = await bodyFor(client, folder, reference, message, signal);
            messages.push({ ...metadata(account, folder, uidValidity, message), ...body });
          } catch (error) {
            live(client, signal);
            errors.push({ reference, code: error?.code === 'stale_message' ? 'stale_message' : 'mailbox_error' });
          }
        }
        await verifyNow(verify, client, signal);
        return { messages, errors };
      });
    });
  }

  async function markRead(account, references, { signal, verify } = {}) {
    checkAccount(account);
    if (!Array.isArray(references) || references.length > MAX_BATCH || typeof verify !== 'function') fail('invalid_request');
    const groups = new Map(), identities = new Set();
    for (const reference of references) {
      checkReference(account, reference);
      const identity = JSON.stringify([reference.path, reference.uidValidity, reference.uid]);
      if (identities.has(identity)) fail('invalid_request');
      identities.add(identity);
      const key = JSON.stringify([reference.path, reference.uidValidity]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(reference);
    }
    if (!references.length) return { results: [] };
    return session(account, signal, async client => {
      await verifyNow(verify, client, signal);
      const { folders } = await mapped(client, account, signal), results = [];
      for (const group of groups.values()) {
        const folder = folders.find(value => equalPath(value.path, group[0].path));
        if (!folder) { results.push(...group.map(reference => ({ reference, status: 'absent' }))); continue; }
        await locked(client, folder.path, false, async uidValidity => {
          if (client.mailbox.readOnly || uidValidity !== group[0].uidValidity) {
            results.push(...group.map(reference => ({ reference, status: 'changed' }))); return;
          }
          const requested = new Map(group.map(reference => [reference.uid, reference]));
          const fetched = collectExpectedHeaders(requested);
          for await (const message of client.fetch([...requested.keys()].join(','), HEADERS, { uid: true })) {
            live(client, signal);
            fetched.add(message);
          }
          live(client, signal);
          if (validity(client, folder.path) !== uidValidity) fail('stale_message');
          const pending = [];
          for (const reference of group) {
            const message = fetched.get(reference.uid);
            if (!message) results.push({ reference, status: 'absent' });
            else if (!validMail(message) || fingerprint(message) !== reference.fingerprint) results.push({ reference, status: 'changed' });
            else if (has(message.flags, '\\Seen')) results.push({ reference, status: 'already_read' });
            else pending.push(reference);
          }
          if (pending.length) {
            await verifyNow(verify, client, signal);
            if (validity(client, folder.path) !== uidValidity || client.mailbox.readOnly) fail('stale_message');
            if (!await client.messageFlagsAdd(pending.map(reference => reference.uid).join(','), ['\\Seen'], { uid: true })) fail('mailbox_error');
            live(client, signal);
            results.push(...pending.map(reference => ({ reference, status: 'applied' })));
          }
        });
      }
      return { results };
    });
  }

  function targetFor(client, folders, account, action) {
    if (action === 'rescue') return folders.find(folder => folder.role === 'inbox') ?? null;
    if (action === 'trash') {
      const targets = folders.filter(folder => folder.specialUse === '\\Trash' && folder.role === 'trash');
      return targets.length === 1 ? targets[0] : null;
    }
    if (client.capabilities?.has('X-GM-EXT-1')) {
      const targets = folders.filter(folder => folder.gmailAll);
      return targets.length === 1 ? targets[0] : null;
    }
    const allowed = folder => !['inbox', 'sent', 'drafts', 'junk', 'trash'].includes(folder.role) && !folder.aggregate;
    const targets = account.archivePath ? folders.filter(folder => folder.path === account.archivePath && allowed(folder)) :
      folders.filter(folder => folder.specialUse === '\\Archive' && allowed(folder));
    return targets.length === 1 ? targets[0] : null;
  }

  async function archiveGmail(client, source, target, reference, sourceMessage, { signal, verify }) {
    const emailId = String(sourceMessage.emailId ?? ''), sameFolder = equalPath(source.path, target.path);
    if (!sameFolder && !/^\d{1,20}$/u.test(emailId)) return { status: 'changed' };
    await verifyNow(verify, client, signal);
    const outcome = await locked(client, target.path, false, async uidValidity => {
      if (client.mailbox.readOnly || (sameFolder && uidValidity !== reference.uidValidity)) return { status: 'changed' };
      let candidate = reference;
      if (!sameFolder) {
        const found = await client.search({ emailId }, { uid: true });
        live(client, signal);
        if (!Array.isArray(found) || found.length !== 1 || !validUid(found[0])) return { status: 'changed' };
        candidate = { ...reference, path: target.path, uidValidity, uid: found[0] };
      }
      const checked = await verifiedOne(client, candidate, { ...HEADERS, labels: true }, signal);
      if (checked.status !== 'verified' || checked.message.emailId !== (sameFolder ? sourceMessage.emailId : emailId) ||
          ['trash', 'junk'].includes(roleFor(target, checked.message))) return { status: 'changed' };
      const common = { reference: candidate, targetPath: target.path };
      if (!has(checked.message.labels, '\\Inbox')) return { status: 'already_target', ...common };
      await verifyNow(verify, client, signal);
      if (validity(client, target.path) !== uidValidity || client.mailbox.readOnly) fail('stale_message');
      // The selected Inbox can omit its own label and ignore removing it there.
      // The verified All Mail alias exposes membership while preserving Sent,
      // Draft and custom labels: only the explicit Inbox label is removed.
      if (!await client.messageFlagsRemove(String(candidate.uid), ['\\Inbox'], { uid: true, useLabels: true })) fail('mailbox_error');
      live(client, signal);
      const after = await verifiedOne(client, candidate, { ...HEADERS, labels: true }, signal);
      if (after.status !== 'verified' || after.message.emailId !== checked.message.emailId ||
          has(after.message.labels, '\\Inbox') || ['trash', 'junk'].includes(roleFor(target, after.message)) ||
          ['\\Sent', '\\Draft', '\\Drafts'].some(label => has(checked.message.labels, label) && !has(after.message.labels, label))) fail('mailbox_error');
      return { status: 'applied', ...common };
    });
    if (!['applied', 'already_target'].includes(outcome.status)) return outcome;
    if (source.role === 'inbox') {
      // Selecting Inbox after All Mail gives a fresh view. Missing the original
      // UID alone is insufficient if another client re-added the same message.
      await verifyNow(verify, client, signal);
      await locked(client, source.path, true, async uidValidity => {
        if (uidValidity !== reference.uidValidity) fail('mailbox_error');
        const after = await verifiedOne(client, reference, { ...HEADERS, labels: true }, signal);
        if (after.status !== 'absent') fail('mailbox_error');
        const found = await client.search({ emailId }, { uid: true });
        live(client, signal);
        if (validity(client, source.path) !== reference.uidValidity || !Array.isArray(found) || found.length !== 0) fail('mailbox_error');
      });
    }
    await verifyNow(verify, client, signal);
    return outcome;
  }

  async function moveInSession(client, account, reference, action, { signal, verify }, { folders, gmail }) {
      await verifyNow(verify, client, signal);
      const source = folders.find(folder => equalPath(folder.path, reference.path));
      if (!source) return { status: 'absent' };
      const target = targetFor(client, folders, account, action);
      const outcome = await locked(client, source.path, false, async uidValidity => {
        if (client.mailbox.readOnly || uidValidity !== reference.uidValidity) return { status: 'changed' };
        const checked = await verifiedOne(client, reference, { ...HEADERS, ...(gmail ? { labels: true } : {}) }, signal);
        if (checked.status !== 'verified') return { status: checked.status };
        if (gmail && !(checked.message.labels instanceof Set)) return { status: 'changed' };
        if (!target) return { status: 'target_unavailable' };
        const common = { targetPath: target.path };
        const sourceRole = roleFor(source, checked.message);
        if (action === 'rescue' && sourceRole !== 'junk' && sourceRole !== 'inbox') return { status: 'changed' };
        if (sourceRole === 'trash') return action === 'trash' ? { status: 'already_target', reference, ...common } : { status: 'changed' };
        if (sourceRole === 'junk' && action === 'archive') return { status: 'changed' };
        if (gmail && action === 'archive') return { gmailArchive: checked.message };
        if (equalPath(source.path, target.path)) {
          return { status: 'already_target', reference, ...common };
        }
        if (!client.capabilities?.has('MOVE')) return { status: 'target_unavailable' };
        await verifyNow(verify, client, signal);
        if (validity(client, source.path) !== uidValidity || client.mailbox.readOnly) fail('stale_message');
        // ImapFlow emulates absent MOVE using COPY/DELETE/EXPUNGE. Recheck immediately before invoking it.
        if (!client.capabilities?.has('MOVE')) return { status: 'target_unavailable' };
        const moved = await client.messageMove(String(reference.uid), target.path, { uid: true });
        live(client, signal);
        if (!moved) fail('mailbox_error');
        const targetUid = moved.uidMap instanceof Map ? Number(moved.uidMap.get(reference.uid)) : NaN;
        const targetValidity = String(moved.uidValidity ?? '');
        const targetReference = validUid(targetUid) && validValidity(targetValidity) &&
          (!moved.destination || equalPath(moved.destination, target.path)) && (!moved.path || equalPath(moved.path, source.path)) ?
          { ...reference, path: target.path, uid: targetUid, uidValidity: targetValidity } : null;
        return { status: 'applied', reference: null, ...common, targetReference };
      });
      if (outcome.gmailArchive) return archiveGmail(client, source, target, reference, outcome.gmailArchive, { signal, verify });
      if (outcome.targetReference) {
        const candidate = outcome.targetReference;
        delete outcome.targetReference;
        // A COPYUID mapping is only a hint until target UIDVALIDITY and fingerprint agree.
        try {
          await locked(client, candidate.path, true, async currentValidity => {
            if (currentValidity !== candidate.uidValidity) return;
            const target = await verifiedOne(client, candidate, HEADERS, signal);
            if (target.status === 'verified') outcome.reference = candidate;
          });
        } catch (error) {
          abortCheck(signal);
          // The move succeeded; failure to resolve its destination must never trigger a blind replay.
          if (!active.has(client)) throw error;
        }
      }
      return outcome;
  }

  async function move(account, reference, action, { signal, verify } = {}) {
    checkAccount(account); checkReference(account, reference);
    if (!['archive', 'trash', 'rescue'].includes(action) || typeof verify !== 'function') fail('invalid_request');
    return session(account, signal, async client => {
      await verifyNow(verify, client, signal);
      const discovered = await mapped(client, account, signal);
      return moveInSession(client, account, reference, action, { signal, verify }, discovered);
    });
  }

  async function moveBatch(account, items, { signal, verify, onResult = async () => {} } = {}) {
    checkAccount(account);
    if (!Array.isArray(items) || items.length > 40 || typeof verify !== 'function' || typeof onResult !== 'function') fail('invalid_request');
    for (const item of items) {
      checkReference(account, item?.reference);
      if (!['archive', 'trash', 'rescue'].includes(item.action)) fail('invalid_request');
    }
    if (new Set(items.map(item => JSON.stringify([item.reference.path, item.reference.uidValidity, item.reference.uid]))).size !== items.length) fail('invalid_request');
    if (!items.length) return { results: [] };
    return session(account, signal, async client => {
      await verifyNow(verify, client, signal);
      const discovered = await mapped(client, account, signal), results = [];
      for (const item of items) {
        const result = await moveInSession(client, account, item.reference, item.action, { signal, verify }, discovered);
        const entry = { reference: item.reference, action: item.action, result };
        // The coordinator can persist each outcome before the next mutation. A later
        // timeout must leave the in-flight action uncertain rather than blindly replay it.
        await onResult(entry);
        results.push(entry);
      }
      return { results };
    });
  }

  return { folders, scan, read, readBatch, checkpoint, readNotification, markRead, move, moveBatch };
}
