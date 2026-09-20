import { createHash } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { MailHarborError } from './validation.mjs';

export const MAX_RECOVERY_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_RECOVERY_REQUEST_BYTES = 36 * 1024 * 1024;
export const MAX_RECOVERY_HTML_BYTES = 400000;
export const MAX_RECOVERY_TEXT_BYTES = 200000;
export const MAX_SIGNATURE_BYTES = 10000;
export const MAX_STORE_RECOVERIES = 50;
export const MAX_STORE_RECOVERY_BYTES = 50 * 1024 * 1024;
export const RECOVERY_EXPIRY_MS = 14 * 86400000;

const fail = code => { throw new MailHarborError(code); };
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value) && !RESERVED_KEYS.has(value);
const header = (value, max = 998) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const text = (value, max = 200000) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const object = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key) || RESERVED_KEYS.has(key))) fail('invalid_request');
};

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

export function sanitizeComposeHtml(html) {
  if (html === undefined || html === null) return '';
  if (typeof html !== 'string' || html.length > MAX_RECOVERY_HTML_BYTES) fail('invalid_request');
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 'strike', 's', 'blockquote', 'ul', 'ol', 'li', 'a'],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      '*': ['dir', 'lang']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'svg', 'math'],
    transformTags: {
      a: (tagName, attribs) => {
        const href = String(attribs.href ?? '').trim();
        if (!/^(?:https?:\/\/|mailto:)/iu.test(href) || /[\u0000-\u0020\u007f]/u.test(href)) return { tagName, attribs: {} };
        try { new URL(href); } catch { return { tagName, attribs: {} }; }
        return { tagName, attribs: { href, target: '_blank', rel: 'noopener noreferrer' } };
      }
    }
  });
}

function validateAttachments(values = []) {
  if (!Array.isArray(values) || values.length > 50) fail('invalid_request');
  let total = 0;
  return values.map(value => {
    object(value, ['filename', 'mimeType', 'content']);
    if (!header(value.filename, 200) || !value.filename || /[\\/]/u.test(value.filename) ||
        !header(value.mimeType, 127) || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(value.mimeType) ||
        typeof value.content !== 'string' || value.content.length > Math.ceil(MAX_RECOVERY_ATTACHMENT_BYTES / 3) * 4 ||
        value.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.content)) fail('invalid_request');
    const buf = Buffer.from(value.content, 'base64');
    if (buf.toString('base64') !== value.content) fail('invalid_request');
    total += buf.length;
    if (total > MAX_RECOVERY_ATTACHMENT_BYTES) fail('attachment_too_large');
    return { filename: value.filename, mimeType: value.mimeType, content: value.content };
  });
}

function validateRecoveryContent(content) {
  object(content, ['accountId', 'to', 'cc', 'bcc', 'subject', 'text', 'html', 'attachments', 'inReplyTo', 'references', 'providerDraftId', 'draftId']);
  if (!id(content.accountId)) fail('invalid_request');
  for (const field of ['to', 'cc', 'bcc']) {
    if (content[field] !== undefined && !header(content[field], 10000)) fail('invalid_request');
  }
  if (content.subject !== undefined && !header(content.subject, 998)) fail('invalid_request');
  if (content.text !== undefined && !text(content.text, MAX_RECOVERY_TEXT_BYTES)) fail('invalid_request');
  let html;
  if (content.html !== undefined && content.html !== null) {
    html = sanitizeComposeHtml(content.html);
  }
  const attachments = validateAttachments(content.attachments || []);
  if (content.inReplyTo !== undefined && content.inReplyTo !== null && !header(content.inReplyTo, 4096)) fail('invalid_request');
  if (content.references !== undefined && content.references !== null && !header(content.references, 4096)) fail('invalid_request');
  const providerDraftId = content.providerDraftId !== undefined ? content.providerDraftId : content.draftId;
  if (providerDraftId !== undefined && providerDraftId !== null && !id(providerDraftId)) fail('invalid_request');

  return {
    accountId: content.accountId,
    to: content.to || '',
    cc: content.cc || '',
    bcc: content.bcc || '',
    subject: content.subject || '',
    text: content.text || '',
    ...(html !== undefined ? { html } : {}),
    attachments,
    inReplyTo: content.inReplyTo || '',
    references: content.references || '',
    providerDraftId: providerDraftId || null
  };
}

export function recoveryDigest(content) {
  return createHash('sha256').update(JSON.stringify({
    accountId: content.accountId,
    to: content.to || '',
    cc: content.cc || '',
    bcc: content.bcc || '',
    subject: content.subject || '',
    text: content.text || '',
    html: content.html || '',
    attachments: (content.attachments || []).map(a => ({
      filename: a.filename,
      mimeType: a.mimeType || a.contentType,
      content: typeof a.content === 'string' ? a.content : Buffer.isBuffer(a.content) ? a.content.toString('base64') : ''
    })),
    inReplyTo: content.inReplyTo || '',
    references: content.references || '',
    providerDraftId: content.providerDraftId || content.draftId || null
  })).digest('hex');
}

function recoverySize(rec) {
  return Buffer.byteLength(JSON.stringify(rec));
}

export function createComposeRecovery({ accounts, store, now = Date.now }) {
  if (!accounts || typeof accounts.get !== 'function') throw new TypeError('accounts is required');
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') throw new TypeError('store is required');

  function checkAccount(accountId, expectedRevision) {
    if (!id(accountId)) fail('invalid_request');
    const storeData = store.read();
    const account = getAccountFromStore(storeData, accounts, accountId);
    if (!account || (expectedRevision !== undefined && account.revision !== expectedRevision)) fail('stale_message');
    return account;
  }

  async function list() {
    const storeData = store.read();
    const recoveries = storeData.composeRecoveries || {};
    const drafts = [];
    for (const [composeId, rec] of Object.entries(recoveries)) {
      if (!Object.hasOwn(recoveries, composeId)) continue;
      try {
        const account = getAccountFromStore(storeData, accounts, rec.accountId);
        if (!account || account.revision !== rec.accountRevision) continue;
        const attachments = (rec.content?.attachments || []).map(a => {
          const buf = Buffer.from(a.content || '', 'base64');
          return {
            filename: a.filename,
            mimeType: a.mimeType,
            size: buf.length
          };
        });
        drafts.push({
          composeId,
          revision: rec.revision,
          accountId: rec.accountId,
          subject: rec.content?.subject || '',
          to: rec.content?.to || '',
          attachmentCount: attachments.length,
          attachments,
          hasHtml: Boolean(rec.content?.html),
          updatedAt: rec.updatedAt,
          createdAt: rec.createdAt,
          locked: Boolean(rec.locked),
          providerDraftId: rec.content?.providerDraftId || null
        });
      } catch {
        // Exclude drafts for inaccessible accounts
      }
    }
    drafts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return { drafts };
  }

  async function read(input) {
    object(input, ['composeId']);
    const composeId = input.composeId;
    if (!id(composeId)) fail('invalid_request');
    const storeData = store.read();
    const recoveries = storeData.composeRecoveries || {};
    if (!Object.hasOwn(recoveries, composeId)) fail('invalid_request');
    const existing = recoveries[composeId];
    if (!existing) fail('invalid_request');
    const account = getAccountFromStore(storeData, accounts, existing.accountId);
    if (!account || account.revision !== existing.accountRevision) fail('stale_message');
    return {
      composeId,
      revision: existing.revision,
      accountId: existing.accountId,
      locked: Boolean(existing.locked),
      state: existing.state,
      content: structuredClone(existing.content),
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      sendOutcome: existing.sendOutcome ?? null
    };
  }

  async function save(input) {
    object(input, ['composeId', 'revision', 'content']);
    const { composeId, revision, content } = input;
    if (!id(composeId)) fail('invalid_request');
    if (!Number.isSafeInteger(revision) || revision < 0) fail('invalid_request');
    const validated = validateRecoveryContent(content);
    const targetAccountId = validated.accountId;
    const requestedAccount = checkAccount(targetAccountId);
    const requestedRevision = requestedAccount.revision;
    const digest = recoveryDigest(validated);

    return store.update(async data => {
      data.composeRecoveries ??= {};
      const currentTime = now();

      // Expire old unlocked entries, protecting submitted/uncertain/draft_uncertain/requestId records
      for (const [key, rec] of Object.entries(data.composeRecoveries)) {
        if (!Object.hasOwn(data.composeRecoveries, key)) continue;
        if (!rec.locked && rec.state !== 'submitted' && rec.state !== 'uncertain' && rec.state !== 'draft_uncertain' && !rec.requestId) {
          const updated = new Date(rec.updatedAt || rec.createdAt || 0).getTime();
          if (currentTime - updated > RECOVERY_EXPIRY_MS) {
            delete data.composeRecoveries[key];
          }
        }
      }

      // Recheck account revision inside queued store.update
      const currentAccount = getAccountFromStore(data, accounts, targetAccountId);
      if (!currentAccount || currentAccount.revision !== requestedRevision) fail('stale_message');

      const existing = Object.hasOwn(data.composeRecoveries, composeId) ? data.composeRecoveries[composeId] : undefined;

      if (!existing) {
        if (revision !== 0) fail('stale_message');
        const keys = Object.keys(data.composeRecoveries).filter(k => Object.hasOwn(data.composeRecoveries, k));
        if (keys.length >= MAX_STORE_RECOVERIES) fail('busy');

        let totalBytes = 0;
        for (const [k, rec] of Object.entries(data.composeRecoveries)) {
          if (Object.hasOwn(data.composeRecoveries, k)) totalBytes += recoverySize(rec);
        }
        const newRecord = {
          composeId,
          revision: 1,
          accountId: currentAccount.id,
          accountRevision: currentAccount.revision,
          digest,
          content: validated,
          locked: false,
          state: 'draft',
          createdAt: new Date(currentTime).toISOString(),
          updatedAt: new Date(currentTime).toISOString()
        };
        if (totalBytes + recoverySize(newRecord) > MAX_STORE_RECOVERY_BYTES) fail('busy');

        data.composeRecoveries[composeId] = newRecord;
        return { saved: true, composeId, revision: 1, updatedAt: newRecord.updatedAt };
      }

      if (existing.locked) fail('stale_message');

      // Check account switching vs same account
      if (existing.accountId !== currentAccount.id) {
        if (existing.content?.providerDraftId || validated.providerDraftId) {
          fail('invalid_request');
        }
        const oldAccount = getAccountFromStore(data, accounts, existing.accountId);
        if (!oldAccount || oldAccount.revision !== existing.accountRevision) {
          fail('stale_message');
        }
        if (revision !== existing.revision) fail('stale_message');
      } else {
        if (existing.accountRevision !== currentAccount.revision) fail('stale_message');

        // Idempotent replay handling
        if (existing.digest === digest) {
          if (revision === existing.revision || revision === existing.revision - 1) {
            return { saved: true, composeId, revision: existing.revision, updatedAt: existing.updatedAt, replayed: true };
          }
        }

        // Optimistic revision check
        if (revision !== existing.revision) fail('stale_message');
      }

      let totalBytes = 0;
      for (const [k, rec] of Object.entries(data.composeRecoveries)) {
        if (k !== composeId && Object.hasOwn(data.composeRecoveries, k)) totalBytes += recoverySize(rec);
      }
      const updatedRecord = {
        ...existing,
        revision: existing.revision + 1,
        accountId: currentAccount.id,
        accountRevision: currentAccount.revision,
        digest,
        content: validated,
        updatedAt: new Date(currentTime).toISOString()
      };
      if (totalBytes + recoverySize(updatedRecord) > MAX_STORE_RECOVERY_BYTES) fail('busy');

      data.composeRecoveries[composeId] = updatedRecord;
      return { saved: true, composeId, revision: updatedRecord.revision, updatedAt: updatedRecord.updatedAt };
    });
  }

  async function discard(input) {
    object(input, ['composeId', 'revision']);
    const { composeId, revision } = input;
    if (!id(composeId)) fail('invalid_request');
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) fail('invalid_request');
    return store.update(async data => {
      data.composeRecoveries ??= {};
      if (!Object.hasOwn(data.composeRecoveries, composeId)) fail('invalid_request');
      const existing = data.composeRecoveries[composeId];
      if (!existing) fail('invalid_request');
      const currentAccount = getAccountFromStore(data, accounts, existing.accountId);
      if (!currentAccount || currentAccount.revision !== existing.accountRevision) fail('stale_message');
      if (revision !== undefined && existing.revision !== revision) fail('stale_message');
      if (existing.state === 'saving' || existing.state === 'submitted') {
        fail('busy');
      }
      delete data.composeRecoveries[composeId];
      return { discarded: true, composeId };
    });
  }

  async function preferences(input) {
    object(input, ['accountId']);
    const { accountId } = input;
    if (!id(accountId)) fail('invalid_request');
    const account = checkAccount(accountId);
    const storeData = store.read();
    const prefs = storeData.composePreferences || {};
    const stored = Object.hasOwn(prefs, accountId) ? prefs[accountId] : undefined;
    const signature = (stored && stored.accountRevision === account.revision) ? stored.signature : '';
    return { signature, accountRevision: account.revision };
  }

  async function configurePreferences(input) {
    object(input, ['accountId', 'signature']);
    const { accountId, signature } = input;
    if (!id(accountId)) fail('invalid_request');
    if (typeof signature !== 'string') fail('invalid_request');
    if (signature.length > MAX_SIGNATURE_BYTES) fail('invalid_request');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(signature)) fail('invalid_request');
    const account = checkAccount(accountId);
    return store.update(async data => {
      const currentAccount = getAccountFromStore(data, accounts, accountId);
      if (!currentAccount || currentAccount.revision !== account.revision) fail('stale_message');
      data.composePreferences ??= {};
      data.composePreferences[accountId] = { signature, accountRevision: currentAccount.revision };
      return { configured: true, accountId, signature, accountRevision: currentAccount.revision };
    });
  }

  // Preflight validation hook used before MIME building (optional, not authoritative)
  function validateSend({ composeId, recoveryRevision, revision, input }) {
    if (!composeId) return;
    if (!id(composeId)) fail('invalid_request');
    const storeData = store.read();
    const recoveries = storeData.composeRecoveries || {};
    if (!Object.hasOwn(recoveries, composeId)) fail('invalid_request');
    const existing = recoveries[composeId];
    if (!existing) fail('invalid_request');
    const rev = recoveryRevision !== undefined ? recoveryRevision : revision;
    if (rev === undefined || !Number.isSafeInteger(rev) || rev < 0) fail('invalid_request');
    if (existing.revision !== rev) fail('stale_message');
    if (existing.locked) fail('send_uncertain');
    if (existing.accountId !== input.accountId) fail('invalid_request');

    const account = getAccountFromStore(storeData, accounts, existing.accountId);
    if (!account || account.revision !== existing.accountRevision) fail('stale_message');

    const attachments = (input.attachments || []).map(a => ({
      filename: a.filename,
      mimeType: a.mimeType || a.contentType,
      content: typeof a.content === 'string' ? a.content : Buffer.isBuffer(a.content) ? a.content.toString('base64') : ''
    }));
    const inputDigest = recoveryDigest({
      accountId: input.accountId,
      to: input.to || '',
      cc: input.cc || '',
      bcc: input.bcc || '',
      subject: input.subject || '',
      text: input.text || '',
      html: input.html ? sanitizeComposeHtml(input.html) : '',
      attachments,
      inReplyTo: input.inReplyTo || '',
      references: input.references || '',
      providerDraftId: input.providerDraftId || input.draftId || null
    });
    if (existing.digest !== inputDigest) fail('invalid_request');
  }

  // Authoritative reservation inside store.update
  function markSubmitted({ composeId, requestId, accountId, recoveryRevision, revision, digest, data }) {
    if (!composeId) return;
    if (!id(composeId)) fail('invalid_request');
    data.composeRecoveries ??= {};
    if (!Object.hasOwn(data.composeRecoveries, composeId)) fail('invalid_request');
    const existing = data.composeRecoveries[composeId];
    if (!existing) fail('invalid_request');
    if (existing.accountId !== accountId) fail('invalid_request');

    const currentAccount = getAccountFromStore(data, accounts, accountId);
    if (!currentAccount || currentAccount.revision !== existing.accountRevision) fail('stale_message');

    const rev = recoveryRevision !== undefined ? recoveryRevision : revision;
    if (rev === undefined || !Number.isSafeInteger(rev) || rev < 0) fail('invalid_request');
    if (existing.revision !== rev) fail('stale_message');

    if (digest && existing.digest !== digest) fail('invalid_request');

    if (existing.locked || (existing.requestId && existing.requestId !== requestId)) {
      fail('send_uncertain');
    }

    existing.locked = true;
    existing.state = 'submitted';
    existing.requestId = requestId;
    existing.updatedAt = new Date(now()).toISOString();
  }

  function markComplete({ composeId, requestId, accountId, result, data }) {
    if (!composeId || !data.composeRecoveries) return;
    if (!Object.hasOwn(data.composeRecoveries, composeId)) return;
    const existing = data.composeRecoveries[composeId];
    if (!existing) return;
    if (existing.requestId !== requestId) return;
    if (accountId && existing.accountId !== accountId) return;

    if (!result?.rejected?.length) {
      delete data.composeRecoveries[composeId];
    } else {
      existing.locked = true;
      existing.state = 'partial';
      existing.sendOutcome = result;
      existing.updatedAt = new Date(now()).toISOString();
    }
  }

  function markFailed({ composeId, requestId, accountId, code, definitelyRejected, data }) {
    if (!composeId || !data.composeRecoveries) return;
    if (!Object.hasOwn(data.composeRecoveries, composeId)) return;
    const existing = data.composeRecoveries[composeId];
    if (!existing) return;
    if (existing.requestId !== requestId) return;
    if (accountId && existing.accountId !== accountId) return;

    if (definitelyRejected) {
      existing.locked = false;
      existing.state = 'draft';
      existing.requestId = null;
    } else {
      existing.locked = true;
      existing.state = 'uncertain';
      existing.error = code;
    }
    existing.updatedAt = new Date(now()).toISOString();
  }

  return {
    list,
    read,
    save,
    discard,
    preferences,
    configurePreferences,
    validateSend,
    markSubmitted,
    markComplete,
    markFailed
  };
}
