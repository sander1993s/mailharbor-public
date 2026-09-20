import { createHash, randomUUID, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { simpleParser } from 'mailparser';
import { MailHarborError } from './validation.mjs';
import { createMailboxSession, mailFingerprint, hasMailFlag, selectableMailbox } from './mailboxes.mjs';
import { smtpTlsOptions } from './smtp-tls.mjs';
import { smtpEndpoint, validateEndpoint } from './providers.mjs';
import { createComposeRecovery, sanitizeComposeHtml, recoveryDigest } from './compose-recovery.mjs';

export const MAX_COMPOSE_REQUEST_BYTES = 36 * 1024 * 1024;
const MAX_ATTACHMENTS = 25 * 1024 * 1024;
const MAX_TEXT = 200000;
const QUERY = { uid: true, envelope: true, flags: true, internalDate: true, size: true };
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const fail = code => { throw new MailHarborError(code); };
const header = (value, max = 998) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key) || RESERVED_KEYS.has(key))) fail('invalid_request');
};
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value) && !RESERVED_KEYS.has(value);
const address = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/u.test(value);
const cleanHeader = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 998);

function getAccountFromStore(data, accounts, accountId) {
  if (Array.isArray(data?.accounts)) {
    return data.accounts.find(a => a?.id === accountId) || null;
  }
  try {
    return accounts?.get?.(accountId) || null;
  } catch {
    return null;
  }
}

function recipients(value = '') {
  if (!header(value, 10000)) fail('invalid_request');
  if (!value.trim()) return [];
  const parsed = addressparser(value, { flatten: true });
  if (!parsed.length || parsed.length > 100 || parsed.some(item => !address(item.address) || !header(item.name || '', 300))) fail('invalid_request');
  return parsed.map(item => ({ address: item.address, name: item.name || '' }));
}

function messageIds(value = '') {
  if (!header(value, 4096)) fail('invalid_request');
  if (!value.trim()) return '';
  const ids = value.trim().split(/\s+/u);
  if (ids.length > 30 || ids.some(item => !/^<[^\s<>@]{1,200}@[^\s<>@]{1,200}>$/u.test(item))) fail('invalid_request');
  return ids.join(' ');
}

function attachments(values = []) {
  if (!Array.isArray(values) || values.length > 50) fail('invalid_request');
  let total = 0;
  return values.map(value => {
    object(value, ['filename', 'mimeType', 'content']);
    if (!header(value.filename, 200) || !value.filename || /[\\/]/u.test(value.filename) ||
        !header(value.mimeType, 127) || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(value.mimeType) ||
        typeof value.content !== 'string' || value.content.length > Math.ceil(MAX_ATTACHMENTS / 3) * 4 ||
        value.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.content)) fail('invalid_request');
    const content = Buffer.from(value.content, 'base64');
    if (content.toString('base64') !== value.content) fail('invalid_request');
    total += content.length;
    if (total > MAX_ATTACHMENTS) fail('attachment_too_large');
    return { filename: value.filename, contentType: value.mimeType, content };
  });
}

function validate(input, sending) {
  object(input, ['accountId', 'draftId', 'to', 'cc', 'bcc', 'subject', 'text', 'html', 'attachments', 'inReplyTo', 'references', 'requestId', 'composeId', 'recoveryRevision']);
  const composeId = input.composeId;
  const recoveryRevision = input.recoveryRevision;
  if (!id(input.accountId) || (input.draftId !== undefined && !id(input.draftId)) || !header(input.subject ?? '') ||
      typeof input.text !== 'string' || input.text.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.text) ||
      ((sending || input.requestId !== undefined) && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/u.test(input.requestId) || RESERVED_KEYS.has(input.requestId))) ||
      (composeId !== undefined && !id(composeId)) ||
      (recoveryRevision !== undefined && (!Number.isSafeInteger(recoveryRevision) || recoveryRevision < 0)) ||
      (input.html !== undefined && (typeof input.html !== 'string' || input.html.length > 400000))) fail('invalid_request');
  if (composeId !== undefined && recoveryRevision === undefined) fail('invalid_request');
  const to = recipients(input.to), cc = recipients(input.cc), bcc = recipients(input.bcc);
  if (to.length + cc.length + bcc.length > 100 || (sending && to.length + cc.length + bcc.length === 0)) fail('invalid_request');
  const html = input.html !== undefined && input.html !== null ? sanitizeComposeHtml(input.html) : undefined;
  return {
    to,
    cc,
    bcc,
    subject: input.subject || '',
    text: input.text,
    ...(html !== undefined ? { html } : {}),
    attachments: attachments(input.attachments),
    inReplyTo: messageIds(input.inReplyTo),
    references: messageIds(input.references),
    ...(composeId !== undefined ? { composeId } : {}),
    ...(recoveryRevision !== undefined ? { recoveryRevision } : {})
  };
}

function target(folders, kind) {
  const available = folders.filter(selectableMailbox);
  const flag = kind === 'drafts' ? '\\Drafts' : '\\Sent';
  const special = available.filter(folder => folder.specialUse?.toLowerCase() === flag.toLowerCase() || hasMailFlag(folder.flags, flag));
  const names = kind === 'drafts' ? ['drafts', 'draft', 'inbox.drafts'] : ['sent', 'sent items', 'sent messages', 'inbox.sent'];
  const candidates = special.length ? special : available.filter(folder => !folder.specialUse && names.includes(folder.path.toLowerCase()));
  return candidates.length === 1 ? candidates[0].path : null;
}

function config(account) {
  try { return smtpEndpoint(account); } catch { fail('smtp_not_configured'); }
}

function sameAccount(accounts, account) {
  const current = accounts.get(account.id);
  if (current.revision !== account.revision) fail('stale_message');
  return current;
}

async function rawMessage(message, keepBcc) {
  const emailPayload = {
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    attachments: message.attachments,
    inReplyTo: message.inReplyTo,
    references: message.references,
    messageId: message.messageId,
    date: message.date,
    disableFileAccess: true,
    disableUrlAccess: true
  };
  const compiled = new MailComposer(emailPayload).compile();
  compiled.keepBcc = keepBcc;
  return compiled.build();
}

/** SMTP sends are durable single-attempt operations. Ambiguous outcomes are never retried. */
export function createMailComposer({ accounts, store, resolveMessage, invalidateMessage = () => {},
  createTransport = options => nodemailer.createTransport(options), createClient } = {}) {
  const { session, active } = createMailboxSession({ connectionOptions: value => accounts.connectionOptions(value), createClient });
  const savedDrafts = new Map(), controllers = new Set(), transports = new Set(), writes = new Set();
  const recovery = createComposeRecovery({ accounts, store });
  let closed = false;
  const check = () => { if (closed) fail('busy'); };

  async function imap(account, work) {
    check();
    if (controllers.size >= 4) fail('busy');
    const controller = new AbortController(); controllers.add(controller);
    try {
      const result = await session(account, controller.signal, async client => {
        try { return { value: await work(client) }; }
        catch (error) { if (error instanceof MailHarborError) return { error: error.code }; throw error; }
      });
      if (result.error) fail(result.error);
      return result.value;
    } finally { controllers.delete(controller); }
  }

  async function resolve(draftId) {
    if (!id(draftId)) fail('invalid_request');
    const storeData = store.read();
    const savedMap = storeData.savedDrafts;
    const saved = (savedMap && Object.hasOwn(savedMap, draftId) ? savedMap[draftId] : undefined) || savedDrafts.get(draftId);
    if (saved) {
      const account = accounts.get(saved.accountId);
      if (account.revision !== saved.revision) fail('stale_message');
      return { account, reference: saved.reference };
    }
    return resolveMessage(draftId);
  }

  async function verified(client, account, reference, extra = {}) {
    sameAccount(accounts, account);
    if (!reference || reference.accountId !== account.id || !Number.isSafeInteger(reference.uid) || reference.uid < 1 || reference.uid > 0xffffffff ||
        typeof reference.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.fingerprint) ||
        typeof reference.uidValidity !== 'string' || !/^\d{1,20}$/u.test(reference.uidValidity) || !selectableMailbox({ path: reference.path })) fail('stale_message');
    const value = await client.fetchOne(String(reference.uid), { ...QUERY, ...extra }, { uid: true, binary: false });
    if (!active.has(client) || closed) fail('cancelled');
    sameAccount(accounts, account);
    if (client.mailbox?.path !== reference.path || String(client.mailbox.uidValidity) !== reference.uidValidity || !value ||
        value.uid !== reference.uid || !(value.flags instanceof Set) || hasMailFlag(value.flags, '\\Deleted') ||
        mailFingerprint(value) !== reference.fingerprint) fail('stale_message');
    return value;
  }

  async function draftCheck(client, account, reference, folders) {
    const path = target(folders, 'drafts');
    if (!path || path !== reference.path || !client.capabilities?.has('UIDPLUS')) fail('draft_unavailable');
    const value = await verified(client, account, reference);
    if (!hasMailFlag(value.flags, '\\Draft')) fail('draft_unavailable');
    return value;
  }

  async function removeDraft(account, reference) {
    return imap(account, async client => {
      const folders = await client.list();
      const lock = await client.getMailboxLock(reference.path, { readOnly: false });
      try {
        await draftCheck(client, account, reference, folders);
        await deleteDraft(client, reference);
      } finally { lock.release(); }
    });
  }

  async function deleteDraft(client, reference) {
    if (!client.capabilities?.has('UIDPLUS')) fail('draft_cleanup_failed');
    const deleted = await client.messageDelete(String(reference.uid), { uid: true });
    if (!deleted || await client.fetchOne(String(reference.uid), { uid: true }, { uid: true })) fail('draft_cleanup_failed');
  }

  async function smtpOptions(account) {
    const value = config(account);
    if (account.provider === 'microsoft' && !account.auth.oauthScope?.split(/\s+/u).includes('https://outlook.office.com/SMTP.Send')) fail('smtp_login_required');
    const incoming = await accounts.connectionOptions(account);
    sameAccount(accounts, account); check();
    return { host: value.host, port: value.port, secure: value.security === 'tls', requireTLS: value.security === 'starttls',
      auth: account.auth.type === 'oauth' ? { type: 'OAuth2', user: value.username || account.email, accessToken: incoming.auth.accessToken } :
        { user: value.username || account.email, pass: account.auth.smtpPassword || value.password || incoming.auth.pass },
      logger: false, debug: false, pool: false, disableFileAccess: true, disableUrlAccess: true,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 45000,
      tls: smtpTlsOptions(account, value.host) };
  }

  const format = list => (list?.value ?? list ?? []).filter(item => address(item.address)).map(item => item.name ?
    `"${cleanHeader(item.name).replace(/["\\]/gu, '')}" <${item.address}>` : item.address).join(', ');
  const safeIds = value => { try { return messageIds(Array.isArray(value) ? value.join(' ') : value || ''); } catch { return ''; } };

  async function context(input) {
    check(); object(input, ['id', 'mode']);
    if (!['reply', 'reply_all', 'forward', 'edit'].includes(input.mode)) fail('invalid_request');
    const { account, reference } = await resolve(input.id);
    return imap(account, async client => {
      const folders = input.mode === 'edit' ? await client.list() : null;
      const lock = await client.getMailboxLock(reference.path, { readOnly: true });
      try {
        const message = input.mode === 'edit' ? await draftCheck(client, account, reference, folders) : await verified(client, account, reference);
        if (!Number.isSafeInteger(message.size) || message.size > MAX_COMPOSE_REQUEST_BYTES) fail('attachment_too_large');
        const fetched = await verified(client, account, reference, { source: { start: 0, maxLength: MAX_COMPOSE_REQUEST_BYTES + 1 } });
        if (!Buffer.isBuffer(fetched.source) || fetched.source.length > MAX_COMPOSE_REQUEST_BYTES || fetched.source.length !== message.size) fail('attachment_unavailable');
        const parsed = await simpleParser(fetched.source, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: MAX_COMPOSE_REQUEST_BYTES });
        await verified(client, account, reference);
        if ((parsed.text || '').length > MAX_TEXT) fail('message_too_large');
        const existing = input.mode === 'edit', forward = input.mode === 'forward';
        const self = account.email.toLowerCase();
        const replyTo = parsed.replyTo?.value?.length ? parsed.replyTo.value : parsed.from?.value || [];
        const withoutSelf = list => list.filter(item => item.address?.toLowerCase() !== self);
        const externalReplyTo = withoutSelf(replyTo);
        const replyRecipients = externalReplyTo.length ? externalReplyTo : withoutSelf(parsed.to?.value || []);
        const to = existing ? format(parsed.to) : forward ? '' : format(replyRecipients);
        const already = new Set(replyRecipients.map(item => item.address.toLowerCase())); already.add(self);
        const cc = existing ? format(parsed.cc) : input.mode === 'reply_all' ? format([...(parsed.to?.value || []), ...(parsed.cc?.value || [])].filter(item => {
          const key = item.address?.toLowerCase(); if (!key || already.has(key)) return false; already.add(key); return true;
        })) : '';
        const subject = cleanHeader(parsed.subject);
        const original = parsed.text || '';
        const text = existing ? original : forward ? `\n\n---------- Forwarded message ----------\nFrom: ${format(parsed.from)}\nDate: ${parsed.date?.toISOString?.() || ''}\nSubject: ${subject}\nTo: ${format(parsed.to)}\n\n${original}` :
          `\n\nOn ${parsed.date?.toISOString?.() || 'the original date'}, ${format(parsed.from)} wrote:\n${original.split('\n').map(line => `> ${line}`).join('\n')}`;
        if (text.length > MAX_TEXT) fail('message_too_large');
        const files = existing || forward ? (parsed.attachments || []).map(item => ({ filename: cleanHeader(item.filename || 'attachment').replace(/[\\/]/gu, '_').slice(0, 200),
          mimeType: item.contentType || 'application/octet-stream', content: item.content.toString('base64') })) : [];
        attachments(files);
        let html;
        if (existing && parsed.html) {
          html = sanitizeComposeHtml(parsed.html);
        }
        return { accountId: account.id, ...(existing ? { draftId: input.id } : {}), to, cc, bcc: existing ? format(parsed.bcc) : '',
          subject: existing ? subject : `${forward ? /^fwd?:/iu.test(subject) ? '' : 'Fwd: ' : /^re:/iu.test(subject) ? '' : 'Re: '}${subject}`.slice(0, 998),
          text, ...(html !== undefined ? { html } : {}), attachments: files, inReplyTo: forward ? '' : safeIds(existing ? parsed.inReplyTo : parsed.messageId),
          references: forward ? '' : safeIds(existing ? parsed.references : [...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []), parsed.messageId].filter(Boolean).slice(-30)) };
      } finally { lock.release(); }
    });
  }

  async function save(input) {
    check();
    const content = validate(input, false);
    const account = accounts.get(input.accountId);
    const composeId = content.composeId;
    const recoveryRevision = content.recoveryRevision;
    const key = input.draftId || (composeId ? `compose:${composeId}` : `new:${account.id}`);
    if (writes.size >= 4 || writes.has(key)) fail('busy');
    writes.add(key);

    let appended = false;
    let lockedRecovery = false;
    const providerSaveId = `save_${randomUUID()}`;

    // Compute canonical content digest for recovery validation (same canonical object as send/recovery)
    const recDigest = composeId ? recoveryDigest({
      accountId: input.accountId,
      to: input.to || '',
      cc: input.cc || '',
      bcc: input.bcc || '',
      subject: input.subject || '',
      text: input.text || '',
      html: input.html ? sanitizeComposeHtml(input.html) : '',
      attachments: (input.attachments || []).map(a => ({
        filename: a.filename,
        mimeType: a.mimeType || a.contentType,
        content: typeof a.content === 'string' ? a.content : Buffer.isBuffer(a.content) ? a.content.toString('base64') : ''
      })),
      inReplyTo: input.inReplyTo || '',
      references: input.references || '',
      providerDraftId: input.draftId || null
    }) : null;

    try {
      if (composeId) {
        await store.update(data => {
          data.composeRecoveries ??= {};
          if (!Object.hasOwn(data.composeRecoveries, composeId)) fail('invalid_request');
          const existing = data.composeRecoveries[composeId];
          if (!existing) fail('invalid_request');
          const currentAccount = getAccountFromStore(data, accounts, account.id);
          if (!currentAccount || currentAccount.revision !== account.revision) fail('stale_message');
          if (existing.accountId !== account.id || existing.accountRevision !== account.revision) fail('stale_message');
          if (existing.locked) fail('stale_message');
          if (existing.revision !== recoveryRevision) fail('stale_message');
          if (existing.digest !== recDigest) fail('invalid_request');
          existing.locked = true;
          existing.state = 'saving';
          existing.providerSaveId = providerSaveId;
          existing.updatedAt = new Date().toISOString();
          lockedRecovery = true;
        });
      }

      const previous = input.draftId ? await resolve(input.draftId) : null;
      if (previous && (previous.account.id !== account.id || previous.account.revision !== account.revision)) fail('stale_message');
      const messageId = `<${randomUUID()}@${account.email.split('@')[1]}>`;
      const raw = await rawMessage({ ...content, from: account.email, messageId, date: new Date() }, true);
      const result = await imap(account, async client => {
        const folders = await client.list(), path = target(folders, 'drafts');
        if (!path || !client.capabilities?.has('UIDPLUS')) fail('draft_unavailable');
        const lock = await client.getMailboxLock(path, { readOnly: false });
        try {
          if (previous) await draftCheck(client, account, previous.reference, folders);
          sameAccount(accounts, account);
          appended = true;
          const saved = await client.append(path, raw, ['\\Draft']);
          if (!saved) fail('draft_partial');
          if (!Number.isSafeInteger(saved.uid) || saved.uid < 1 || String(saved.uidValidity) !== String(client.mailbox.uidValidity)) fail('draft_partial');
          const message = await client.fetchOne(String(saved.uid), QUERY, { uid: true });
          if (!active.has(client) || !message || message.uid !== saved.uid || message.envelope?.messageId !== messageId || !hasMailFlag(message.flags, '\\Draft')) fail('draft_partial');
          const reference = { accountId: account.id, path, uid: saved.uid, uidValidity: String(saved.uidValidity), fingerprint: mailFingerprint(message) };
          const draftId = randomBytes(24).toString('base64url');
          let nextRevision;
          await store.update(data => {
            data.savedDrafts ??= {};
            data.savedDrafts[draftId] = { accountId: account.id, revision: account.revision, reference, updatedAt: new Date().toISOString() };
            // Prune savedDrafts while protecting draft references currently used by recovery
            const usedDraftIds = new Set();
            for (const rec of Object.values(data.composeRecoveries || {})) {
              if (rec.content?.providerDraftId) usedDraftIds.add(rec.content.providerDraftId);
            }
            usedDraftIds.add(draftId);
            const keys = Object.keys(data.savedDrafts).filter(k => Object.hasOwn(data.savedDrafts, k));
            if (keys.length > 500) {
              for (const k of keys) {
                if (Object.keys(data.savedDrafts).length <= 500) break;
                if (!usedDraftIds.has(k)) {
                  delete data.savedDrafts[k];
                }
              }
            }
            if (composeId && data.composeRecoveries && Object.hasOwn(data.composeRecoveries, composeId)) {
              const rec = data.composeRecoveries[composeId];
              if (rec.providerSaveId === providerSaveId &&
                  rec.state === 'saving' &&
                  rec.accountId === account.id &&
                  rec.accountRevision === account.revision &&
                  rec.revision === recoveryRevision) {
                rec.content.providerDraftId = draftId;
                rec.revision = rec.revision + 1;
                rec.digest = recoveryDigest(rec.content);
                rec.locked = false;
                rec.state = 'draft';
                rec.providerSaveId = null;
                rec.updatedAt = new Date().toISOString();
                nextRevision = rec.revision;
                lockedRecovery = false;
              }
            }
          });
          savedDrafts.set(draftId, { accountId: account.id, revision: account.revision, reference });
          while (savedDrafts.size > 500) savedDrafts.delete(savedDrafts.keys().next().value);
          let warning;
          if (previous) {
            try { await draftCheck(client, account, previous.reference, folders); await deleteDraft(client, previous.reference); }
            catch { warning = 'draft_cleanup_failed'; }
            if (!warning) {
              await store.update(data => {
                if (data.savedDrafts && Object.hasOwn(data.savedDrafts, input.draftId)) delete data.savedDrafts[input.draftId];
              });
              savedDrafts.delete(input.draftId);
              invalidateMessage(input.draftId);
            }
          }
          return {
            saved: true,
            draftId,
            ...(composeId ? { composeId, ...(nextRevision !== undefined ? { recoveryRevision: nextRevision } : {}) } : {}),
            ...(warning ? { warning } : {})
          };
        } finally { lock.release(); }
      });
      return result;
    } catch (error) {
      if (composeId && lockedRecovery) {
        if (appended) {
          try {
            await store.update(data => {
              if (data.composeRecoveries && Object.hasOwn(data.composeRecoveries, composeId)) {
                const rec = data.composeRecoveries[composeId];
                if (rec.providerSaveId === providerSaveId && rec.state === 'saving') {
                  rec.locked = true;
                  rec.state = 'draft_uncertain';
                  rec.updatedAt = new Date().toISOString();
                }
              }
            });
          } catch {}
          fail('draft_partial');
        } else {
          try {
            await store.update(data => {
              if (data.composeRecoveries && Object.hasOwn(data.composeRecoveries, composeId)) {
                const rec = data.composeRecoveries[composeId];
                if (rec.providerSaveId === providerSaveId && rec.state === 'saving') {
                  rec.locked = false;
                  rec.state = 'draft';
                  rec.providerSaveId = null;
                  rec.updatedAt = new Date().toISOString();
                }
              }
            });
          } catch {}
        }
      } else if (appended) {
        fail('draft_partial');
      }
      throw error;
    } finally {
      writes.delete(key);
    }
  }

  async function send(input) {
    check();
    const content = validate(input, true);
    const account = accounts.get(input.accountId);
    const composeId = content.composeId;
    const recoveryRevision = content.recoveryRevision;

    // Move ledger replay check before recovery validation.
    // Accepted sends delete recovery, so exact requestId replay then fails if recovery validation is first.
    const digest = createHash('sha256').update(JSON.stringify({ ...input, requestId: undefined })).digest('hex');
    const storeData = store.read();
    const sendRequestsMap = storeData.sendRequests;
    const saved = sendRequestsMap && Object.hasOwn(sendRequestsMap, input.requestId) ? sendRequestsMap[input.requestId] : undefined;
    const replay = value => {
      if (value.digest !== digest || value.accountId !== account.id) fail('invalid_request');
      if (value.result) return { ...value.result, replayed: true };
      fail(value.error || 'send_uncertain');
    };
    if (saved) return replay(saved);

    // Compute canonical content digest for recovery validation (same canonical object as save, no recovery metadata)
    const recDigest = composeId ? recoveryDigest({
      accountId: input.accountId,
      to: input.to || '',
      cc: input.cc || '',
      bcc: input.bcc || '',
      subject: input.subject || '',
      text: input.text || '',
      html: input.html ? sanitizeComposeHtml(input.html) : '',
      attachments: (input.attachments || []).map(a => ({
        filename: a.filename,
        mimeType: a.mimeType || a.contentType,
        content: typeof a.content === 'string' ? a.content : Buffer.isBuffer(a.content) ? a.content.toString('base64') : ''
      })),
      inReplyTo: input.inReplyTo || '',
      references: input.references || '',
      providerDraftId: input.draftId || null
    }) : null;

    // Optional preflight validation (cannot be authoritative)
    if (composeId) {
      recovery.validateSend({ composeId, recoveryRevision, input });
    }

    if (writes.size >= 4 || writes.has(input.draftId || input.requestId)) fail('busy');
    const key = input.draftId || input.requestId; writes.add(key);
    let transport, submitted = false, reserved = false;
    try {
      const previous = input.draftId ? await resolve(input.draftId) : null;
      if (previous) {
        if (previous.account.id !== account.id || previous.account.revision !== account.revision) fail('stale_message');
        await imap(account, async client => {
          const folders = await client.list();
          const lock = await client.getMailboxLock(previous.reference.path, { readOnly: true });
          try { await draftCheck(client, account, previous.reference, folders); } finally { lock.release(); }
        });
      }
      const options = await smtpOptions(account), configuration = config(account);
      const messageId = `<${randomUUID()}@${account.email.split('@')[1]}>`;
      const message = { ...content, from: account.email, messageId, date: new Date() };
      const raw = await rawMessage(message, false);
      const recipients = [...new Set([...content.to, ...content.cc, ...content.bcc].map(item => item.address.toLowerCase()))];
      let competing;

      // Atomic reservation within SAME store.update that reserves durable send ledger
      await store.update(data => {
        data.sendRequests ??= {};
        if (Object.hasOwn(data.sendRequests, input.requestId)) { competing = data.sendRequests[input.requestId]; return; }
        if (Object.keys(data.sendRequests).filter(k => Object.hasOwn(data.sendRequests, k)).length >= 10000) fail('send_history_full');
        const currentAccount = getAccountFromStore(data, accounts, account.id);
        if (!currentAccount || currentAccount.revision !== account.revision) fail('stale_message');
        check();

        if (composeId) {
          recovery.markSubmitted({
            composeId,
            requestId: input.requestId,
            accountId: account.id,
            recoveryRevision,
            digest: recDigest,
            data
          });
        }

        data.sendRequests[input.requestId] = {
          accountId: account.id,
          digest,
          messageId,
          createdAt: new Date().toISOString(),
          state: 'pending'
        };
        reserved = true;
      });

      if (competing) return replay(competing);

      transport = createTransport(options); transports.add(transport);
      sameAccount(accounts, account); check();
      submitted = true;
      const info = await transport.sendMail({ envelope: { from: account.email, to: recipients }, raw });
      const accepted = recipients.filter(item => (info.accepted || []).some(value => String(typeof value === 'string' ? value : value.address).toLowerCase() === item));
      const rejected = recipients.filter(item => !accepted.includes(item));
      if (!accepted.length) fail('send_uncertain');
      const result = { sent: true, status: rejected.length ? 'partial' : 'sent', messageId, accepted, rejected,
        ...(rejected.length ? { warning: 'send_partial' } : {}) };

      // Persist acceptance before secondary IMAP work
      await store.update(data => {
        data.sendRequests[input.requestId].state = 'sent';
        data.sendRequests[input.requestId].result = result;
        if (composeId) {
          recovery.markComplete({ composeId, requestId: input.requestId, accountId: account.id, result, data });
        }
      });

      const warnings = rejected.length ? ['send_partial'] : [];
      if (configuration.sentCopy) {
        try {
          const copy = await rawMessage(message, true);
          await imap(account, async client => {
            const path = target(await client.list(), 'sent'); if (!path) fail('sent_copy_failed');
            sameAccount(accounts, account); if (!await client.append(path, copy, ['\\Seen'])) fail('sent_copy_failed');
          });
        } catch { warnings.push('sent_copy_failed'); }
      }
      if (previous && !rejected.length) {
        try {
          await removeDraft(account, previous.reference);
          await store.update(data => {
            if (data.savedDrafts && Object.hasOwn(data.savedDrafts, input.draftId)) delete data.savedDrafts[input.draftId];
          });
          savedDrafts.delete(input.draftId);
          invalidateMessage(input.draftId);
        }
        catch { warnings.push('draft_cleanup_failed'); }
      }
      if (warnings.length) { result.warning = warnings[0]; result.warnings = warnings; }
      await store.update(data => { data.sendRequests[input.requestId].result = result; });
      return result;
    } catch (error) {
      if (!reserved) throw error;
      const sendReqs = store.read().sendRequests;
      const accepted = sendReqs && Object.hasOwn(sendReqs, input.requestId) ? sendReqs[input.requestId]?.result : undefined;
      if (accepted) return { ...accepted, warning: accepted.warning || 'sent_copy_failed' };
      const definitelyRejected = !submitted || error?.code === 'EAUTH' || error?.code === 'EENVELOPE' ||
        (Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode <= 599);
      const code = error?.code === 'EAUTH' ? 'smtp_login_required' : definitelyRejected ? 'smtp_error' : 'send_uncertain';
      try {
        await store.update(data => {
          if (data.sendRequests && Object.hasOwn(data.sendRequests, input.requestId)) {
            data.sendRequests[input.requestId].state = definitelyRejected ? 'rejected' : 'uncertain';
            data.sendRequests[input.requestId].error = code;
          }
          if (composeId) {
            recovery.markFailed({ composeId, requestId: input.requestId, accountId: account.id, code, definitelyRejected, data });
          }
        });
      }
      catch { fail('send_uncertain'); }
      fail(code);
    } finally {
      if (transport) { transports.delete(transport); try { transport.close(); } catch {} }
      writes.delete(key);
    }
  }

  function settings() {
    check();
    return { accounts: accounts.list().filter(item => item.connected).map(item => {
      const account = accounts.get(item.id), value = config(account);
      return { accountId: item.id, label: item.label, email: item.email, provider: item.provider, host: value.host, port: value.port,
        security: value.security, username: value.username || account.email, sentCopy: value.sentCopy, customPassword: Boolean(account.auth.smtpPassword || value.password), authType: account.auth.type,
        needsReconnect: account.provider === 'microsoft' && !account.auth.oauthScope?.split(/\s+/u).includes('https://outlook.office.com/SMTP.Send') };
    }) };
  }

  async function configure(input) {
    check(); object(input, ['accountId', 'host', 'port', 'security', 'username', 'sentCopy', 'password', 'useMailboxPassword']);
    const account = accounts.get(input.accountId), defaults = config(account);
    const endpoint = validateEndpoint({ host: input.host ?? defaults.host, port: input.port, security: input.security ?? (input.port === 465 ? 'tls' : 'starttls') }, account.provider === 'proton' && account.allowLocalBridge === true);
    if ((account.auth.type === 'oauth' && endpoint.host !== defaults.host) ||
        typeof input.sentCopy !== 'boolean' || (input.password !== undefined && !header(input.password, 4096)) ||
        (input.username !== undefined && (!input.username || !header(input.username, 254))) ||
        (input.useMailboxPassword !== undefined && typeof input.useMailboxPassword !== 'boolean') ||
        (account.auth.type === 'oauth' && input.password)) fail('invalid_request');
    await store.update(data => {
      const current = getAccountFromStore(data, accounts, account.id);
      if (!current || current.revision !== account.revision) fail('stale_message');
      current.smtp = { ...endpoint, username: input.username || defaults.username || account.email, sentCopy: input.sentCopy };
      if (input.useMailboxPassword) delete current.auth.smtpPassword;
      else if (input.password || defaults.password) current.auth.smtpPassword = input.password || defaults.password;
    });
    return settings();
  }

  async function verify(input) {
    check(); object(input, ['accountId']);
    if (transports.size >= 4) fail('busy');
    const options = await smtpOptions(accounts.get(input.accountId));
    let transport;
    try { transport = createTransport(options); transports.add(transport); await transport.verify(); return { verified: true }; }
    catch (error) { fail(error?.code === 'EAUTH' ? 'smtp_login_required' : 'smtp_error'); }
    finally { if (transport) { transports.delete(transport); try { transport.close(); } catch {} } }
  }

  return {
    context,
    save,
    send,
    settings,
    configure,
    verify,
    recovery,
    close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      for (const transport of transports) try { transport.close(); } catch {}
      savedDrafts.clear();
    }
  };
}
