import { MAX_ACCOUNTS } from './providers.mjs';
import { sanitizeMailHtml, safeFilename } from './mail-content.mjs';
import { MailHarborError, errorMessages, safeError } from './validation.mjs';
import { convert } from 'html-to-text';

export const DEFAULT_MAX_HEADERS_PER_ACCOUNT = 500;
export const DEFAULT_MAX_BODY_BYTES = 512 * 1024 * 1024; // 512 MiB
export const DEFAULT_MAX_MESSAGE_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB
export const DEFAULT_RENDERER_VERSION = '2';

export async function createMailCacheReader({
  reader,
  cache,
  sync,
  accounts = [],
  renderContent,
  store,
  beforeMutation,
  enabled = false,
  now = Date.now
} = {}) {
  let isEnabled = Boolean(enabled);

  // Initialize cached header cap from store if valid integer in 100..5000
  try {
    const storedCap = store?.read?.()?.mailCacheSettings?.maxHeadersPerAccount;
    if (Number.isSafeInteger(storedCap) && storedCap >= 100 && storedCap <= 5000) {
      cache?.updateSettings?.({ maxHeadersPerAccount: storedCap });
    }
  } catch {}

  function safeErrorCode(code) {
    if (typeof code === 'string' && Object.hasOwn(errorMessages, code)) {
      return code;
    }
    return 'mailbox_error';
  }

  function getFullAccount(accountId) {
    if (!accountId) return null;
    if (accounts && typeof accounts.get === 'function') {
      try {
        const full = accounts.get(accountId);
        if (full && full.connected !== false) return full;
        return null;
      } catch {
        return null;
      }
    }
    if (accounts && typeof accounts.list === 'function') {
      try {
        const list = accounts.list();
        if (Array.isArray(list)) {
          const found = list.find(a => a?.id === accountId && a.connected !== false);
          return found ?? null;
        }
      } catch {
        return null;
      }
    }
    if (Array.isArray(accounts)) {
      const found = accounts.find(a => a?.id === accountId && a.connected !== false);
      return found ?? null;
    }
    return null;
  }

  function resolveAccounts() {
    if (accounts && typeof accounts.list === 'function') {
      try {
        const list = accounts.list();
        if (Array.isArray(list)) {
          const result = [];
          for (const entry of list) {
            if (!entry || entry.connected === false || !entry.id) continue;
            if (typeof accounts.get === 'function') {
              const full = accounts.get(entry.id);
              if (full && full.connected !== false) {
                result.push(full);
              }
            } else {
              result.push(entry);
            }
          }
          return result;
        }
      } catch {}
    }
    if (Array.isArray(accounts)) {
      return accounts.filter(a => a && a.connected !== false);
    }
    return [];
  }

  function matchesFullAccount(callerAcc, fullAcc) {
    if (!callerAcc || !fullAcc || fullAcc.connected === false) return false;
    if (callerAcc.id !== fullAcc.id) return false;
    if (callerAcc.email !== undefined && callerAcc.email !== fullAcc.email) return false;
    if (callerAcc.revision !== undefined && callerAcc.revision !== fullAcc.revision) return false;
    const callerHost = callerAcc.host ?? callerAcc.imap?.host;
    const fullHost = fullAcc.host ?? fullAcc.imap?.host;
    if (callerHost !== undefined && fullHost !== undefined && callerHost !== fullHost) return false;
    if (callerAcc.provider !== undefined && fullAcc.provider !== undefined && callerAcc.provider !== fullAcc.provider) return false;
    return true;
  }

  function isSameFullAccount(a, b) {
    if (!a || !b || a.connected === false || b.connected === false) return false;
    if (a.id !== b.id) return false;
    if (a.email !== b.email) return false;
    if (a.revision !== b.revision) return false;
    const hostA = a.host ?? a.imap?.host;
    const hostB = b.host ?? b.imap?.host;
    if (hostA !== hostB) return false;
    if (a.provider !== b.provider) return false;
    return true;
  }

  function computeRevision(accountsList, cacheStatus, syncStatus) {
    const parts = (accountsList || []).map(acc => {
      const cacheAcc = cacheStatus?.accounts?.find(a => a.accountId === acc.id);
      const syncAcc = syncStatus?.accounts?.find(a => a.accountId === acc.id);
      const gen = cacheAcc?.generation ?? 0;
      const hc = cacheAcc?.headerCount ?? 0;
      const bc = cacheAcc?.bodyCount ?? 0;
      const chk = cacheAcc?.checkpoint ?? '';
      const cov = cacheAcc?.coverageStatus ?? syncAcc?.coverage?.status ?? '';
      const lr = cacheAcc?.lastRefresh ?? syncAcc?.lastSuccessfulUpdate ?? 0;
      return `${acc.id}:${acc.revision || '1'}:g${gen}:h${hc}:b${bc}:c${chk}:${cov}:r${lr}`;
    });
    return parts.join('|');
  }

  function validateListOptions(accountsList, options = {}) {
    if (!Array.isArray(accountsList) || accountsList.length > MAX_ACCOUNTS ||
        accountsList.some(account => !account || typeof account.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(account.id)) ||
        new Set(accountsList.map(account => account.id)).size !== accountsList.length) {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
        throw new MailHarborError('invalid_request', errorMessages.invalid_request);
      }
    }
    if (options.folder !== undefined && typeof options.folder !== 'string') {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }
    if (options.query !== undefined && typeof options.query !== 'string') {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }
    if (options.filters !== undefined && (typeof options.filters !== 'object' || options.filters === null || Array.isArray(options.filters))) {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }
    if (options.scopedReferences !== undefined && !Array.isArray(options.scopedReferences)) {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }
    if (options.sort !== undefined && typeof options.sort !== 'string') {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }
    if (options.cursor !== undefined && options.cursor !== null) {
      if (typeof options.cursor !== 'object' || Array.isArray(options.cursor) ||
          (options.cursor.kind !== 'cache' && options.cursor.kind !== 'provider') ||
          options.cursor.cursor === undefined) {
        throw new MailHarborError('invalid_request', errorMessages.invalid_request);
      }
    }
  }

  function isCacheEligible(options) {
    if (options.live === true) return false;
    if (options.folder !== undefined && String(options.folder).toLowerCase() !== 'inbox') return false;
    if (options.query !== undefined && options.query !== '') return false;
    if (options.filters !== undefined && Object.keys(options.filters).length > 0) return false;
    if (options.bodySearch) return false;
    if (options.scopedReferences !== undefined) return false;
    if (options.sort !== undefined && options.sort !== 'date_desc') return false;
    const filterKeys = ['seen', 'unseen', 'flagged', 'unflagged', 'since', 'before', 'sentSince', 'larger', 'smaller', 'from', 'to', 'subject', 'body', 'text'];
    for (const k of filterKeys) {
      if (options[k] !== undefined) return false;
    }
    if (options.cursor && options.cursor.kind === 'provider') return false;
    return true;
  }

  function formatAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];
    return attachments.slice(0, 100).map(a => ({
      id: a.id != null ? String(a.id) : undefined,
      filename: safeFilename(a.filename, 'attachment'),
      mimeType: typeof a.mimeType === 'string' ? a.mimeType : (typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream'),
      size: Number.isSafeInteger(a.size) && a.size >= 0 ? a.size : null
    }));
  }

  function normalizeProviderListResult(accountsList, providerRes) {
    const syncStatus = sync?.status ? sync.status() : null;
    const cacheStatus = cache?.status ? cache.status(accountsList) : null;

    const activeSet = new Set(syncStatus?.active || []);
    const pendingSet = new Set(syncStatus?.pending || []);
    const refreshing = accountsList.some(a => activeSet.has(a.id) || pendingSet.has(a.id));

    const hasErrors = (providerRes.errors && providerRes.errors.length > 0);
    const errorIds = new Set((providerRes.errors || []).map(e => e.accountId));
    const requestedIds = accountsList.map(a => a.id);
    const coveredIds = requestedIds.filter(id => !errorIds.has(id));
    const missingIds = requestedIds.filter(id => errorIds.has(id));

    const isComplete = Boolean(providerRes.totalComplete) && !hasErrors;

    const coverage = {
      status: isComplete ? 'complete' : 'partial',
      cached: 0,
      limited: false,
      accountIds: coveredIds,
      missingAccountIds: missingIds
    };

    let lastSuccessfulSync = null;
    for (const id of coveredIds) {
      const syncAcc = syncStatus?.accounts?.find(a => a.accountId === id);
      const cacheAcc = cacheStatus?.accounts?.find(a => a.accountId === id);
      const ts = syncAcc?.lastSuccessfulUpdate ?? cacheAcc?.lastRefresh ?? null;
      if (ts !== null && Number.isFinite(ts)) {
        if (lastSuccessfulSync === null || ts < lastSuccessfulSync) {
          lastSuccessfulSync = ts;
        }
      }
    }

    const revision = computeRevision(accountsList, cacheStatus, syncStatus);

    const safeErrors = (providerRes.errors || []).map(e => ({
      accountId: e.accountId,
      code: safeErrorCode(e.code)
    }));

    const nextCursor = providerRes.nextCursor ? { kind: 'provider', cursor: providerRes.nextCursor } : null;

    const normalizedMessages = (providerRes.messages || []).map(m => {
      let snippet = typeof m.snippet === 'string' ? m.snippet : (m.body ? convert(m.body, { wordwrap: false }) : '');
      snippet = snippet.replace(/\s+/g, ' ').trim().slice(0, 160);

      return {
        ...m,
        snippet,
        attachments: formatAttachments(m.attachments)
      };
    });

    return {
      messages: normalizedMessages,
      total: providerRes.total ?? null,
      totalComplete: Boolean(providerRes.totalComplete),
      nextCursor,
      source: 'provider',
      providerFallback: false,
      coverage,
      lastSuccessfulSync,
      refreshing,
      revision,
      requiresRefresh: false,
      errors: safeErrors
    };
  }

  function normalizeCacheListResult(fullAccounts, cacheRes) {
    const cacheStatus = cache?.status ? cache.status(fullAccounts) : null;
    const syncStatus = sync?.status ? sync.status() : null;

    const activeSet = new Set(syncStatus?.active || []);
    const pendingSet = new Set(syncStatus?.pending || []);
    const refreshing = fullAccounts.some(a => activeSet.has(a.id) || pendingSet.has(a.id));

    const cacheErrorAccountIds = new Set((cacheRes.errors || []).map(e => e.accountId));
    const missingAccountIds = [];
    const coveredAccountIds = [];

    for (const acc of fullAccounts) {
      const cacheAcc = cacheStatus?.accounts?.find(a => a.accountId === acc.id);
      if (cacheErrorAccountIds.has(acc.id) || cacheAcc?.dirty || !cacheAcc) {
        missingAccountIds.push(acc.id);
      } else {
        coveredAccountIds.push(acc.id);
      }
    }

    let retainedHeaderCount = 0;
    for (const id of coveredAccountIds) {
      const cacheAcc = cacheStatus?.accounts?.find(a => a.accountId === id);
      retainedHeaderCount += (cacheAcc?.headerCount ?? 0);
    }

    const totalProvider = cacheRes.total ?? retainedHeaderCount;
    const maxHeaders = cacheStatus?.maxHeadersPerAccount ?? DEFAULT_MAX_HEADERS_PER_ACCOUNT;

    const isWarming = cacheRes.coverage?.status === 'warming' ||
      coveredAccountIds.some(id => {
        const acc = cacheStatus?.accounts?.find(a => a.accountId === id);
        return !acc?.reconciled || acc?.coverageStatus === 'warming' || acc?.checkpoint === 'first50';
      });

    const reachedRetentionCap = coveredAccountIds.some(id => {
      const acc = cacheStatus?.accounts?.find(a => a.accountId === id);
      return (acc?.headerCount ?? 0) >= maxHeaders;
    });

    let isLimited = false;
    if (isWarming) {
      isLimited = (totalProvider > retainedHeaderCount) && reachedRetentionCap;
    } else {
      isLimited = totalProvider > retainedHeaderCount;
    }

    let coverageStatus = 'complete';
    if (missingAccountIds.length > 0) {
      coverageStatus = coveredAccountIds.length === 0 ? 'warming' : 'partial';
    } else if (isWarming) {
      coverageStatus = 'warming';
    } else if (isLimited) {
      coverageStatus = 'partial';
    } else if (cacheRes.coverage?.status === 'partial') {
      coverageStatus = 'partial';
    }

    const coverage = {
      status: coverageStatus,
      cached: retainedHeaderCount,
      limited: Boolean(isLimited),
      accountIds: coveredAccountIds,
      missingAccountIds
    };

    let lastSuccessfulSync = null;
    for (const id of coveredAccountIds) {
      const syncAcc = syncStatus?.accounts?.find(a => a.accountId === id);
      const cacheAcc = cacheStatus?.accounts?.find(a => a.accountId === id);
      const ts = syncAcc?.lastSuccessfulUpdate ?? cacheAcc?.lastRefresh ?? null;
      if (ts !== null && Number.isFinite(ts)) {
        if (lastSuccessfulSync === null || ts < lastSuccessfulSync) {
          lastSuccessfulSync = ts;
        }
      }
    }

    const revision = computeRevision(fullAccounts, cacheStatus, syncStatus);

    const normalizedMessages = (cacheRes.messages || []).map(m => {
      let snippet = '';
      const mAcc = fullAccounts.find(a => a.id === m.accountId);
      const cachedBody = (mAcc && cache?.getBody) ? cache.getBody(mAcc, m.reference) : null;
      if (cachedBody?.text && cachedBody.text.trim().length > 0) {
        snippet = cachedBody.text;
      } else if (cachedBody?.html && cachedBody.html.trim().length > 0) {
        snippet = convert(cachedBody.html, { wordwrap: false });
      } else if (typeof m.snippet === 'string') {
        snippet = m.snippet;
      }
      snippet = snippet.replace(/\s+/g, ' ').trim().slice(0, 160);

      return {
        ...m,
        snippet,
        attachments: formatAttachments(m.attachments)
      };
    });

    const nextCursor = cacheRes.nextCursor ? { kind: 'cache', cursor: cacheRes.nextCursor } : null;

    const safeErrors = (cacheRes.errors || []).map(e => ({
      accountId: e.accountId,
      code: e.code === 'unreconciled' ? 'mailbox_error' : safeErrorCode(e.code)
    }));

    const totalComplete = Boolean(cacheRes.totalComplete) && missingAccountIds.length === 0;

    return {
      messages: normalizedMessages,
      total: cacheRes.total,
      totalComplete,
      nextCursor,
      source: 'cache',
      providerFallback: Boolean(cacheRes.providerFallback),
      coverage,
      lastSuccessfulSync,
      refreshing,
      revision,
      requiresRefresh: Boolean(cacheRes.requiresRefresh),
      errors: safeErrors
    };
  }

  function createStaleCacheResult(accountsList) {
    const syncStatus = sync?.status ? sync.status() : null;
    const cacheStatus = cache?.status ? cache.status(accountsList) : null;

    const activeSet = new Set(syncStatus?.active || []);
    const pendingSet = new Set(syncStatus?.pending || []);
    const refreshing = (accountsList || []).some(a => activeSet.has(a.id) || pendingSet.has(a.id));

    const coveredAccountIds = [];
    const missingAccountIds = [];
    for (const acc of accountsList || []) {
      const full = getFullAccount(acc?.id);
      const cacheAcc = cacheStatus?.accounts?.find(a => a.accountId === acc?.id);
      if (!full || !matchesFullAccount(acc, full) || cacheAcc?.dirty || !cacheAcc) {
        missingAccountIds.push(acc.id);
      } else {
        coveredAccountIds.push(acc.id);
      }
    }

    let lastSuccessfulSync = null;
    for (const id of coveredAccountIds) {
      const syncAcc = syncStatus?.accounts?.find(a => a.accountId === id);
      const cacheAcc = cacheStatus?.accounts?.find(a => a.accountId === id);
      const ts = syncAcc?.lastSuccessfulUpdate ?? cacheAcc?.lastRefresh ?? null;
      if (ts !== null && Number.isFinite(ts)) {
        if (lastSuccessfulSync === null || ts < lastSuccessfulSync) {
          lastSuccessfulSync = ts;
        }
      }
    }

    const revision = computeRevision(accountsList, cacheStatus, syncStatus);

    return {
      messages: [],
      total: null,
      totalComplete: false,
      nextCursor: null,
      source: 'cache',
      providerFallback: true,
      coverage: {
        status: coveredAccountIds.length === 0 ? 'warming' : 'partial',
        cached: 0,
        limited: true,
        accountIds: coveredAccountIds,
        missingAccountIds
      },
      lastSuccessfulSync,
      refreshing,
      revision,
      requiresRefresh: true,
      errors: missingAccountIds.map(id => ({ accountId: id, code: 'mailbox_error' }))
    };
  }

  async function cachedList(accountsList, options = {}) {
    validateListOptions(accountsList, options);

    const isCacheCursor = options.cursor && typeof options.cursor === 'object' && options.cursor.kind === 'cache';
    const eligible = isEnabled && isCacheEligible(options);

    if (!eligible) {
      if (isCacheCursor) {
        throw new MailHarborError('invalid_request', errorMessages.invalid_request);
      }
      const unwrappedCursor = options.cursor?.kind === 'provider' ? options.cursor.cursor : null;
      const { live, cursor, ...rest } = options;
      const providerRes = await reader.list(accountsList, { ...rest, ...(unwrappedCursor ? { cursor: unwrappedCursor } : {}) });
      return normalizeProviderListResult(accountsList, providerRes);
    }

    // Verify all accounts match current full connected account
    const fullAccounts = [];
    let hasStaleAccount = false;
    for (const acc of accountsList) {
      const full = getFullAccount(acc?.id);
      if (!full || !matchesFullAccount(acc, full)) {
        hasStaleAccount = true;
        break;
      }
      fullAccounts.push(full);
    }

    if (hasStaleAccount) {
      if (isCacheCursor) {
        return createStaleCacheResult(accountsList);
      }
      const unwrappedCursor = options.cursor?.kind === 'provider' ? options.cursor.cursor : null;
      const { live, cursor, ...rest } = options;
      const providerRes = await reader.list(accountsList, { ...rest, ...(unwrappedCursor ? { cursor: unwrappedCursor } : {}) });
      return normalizeProviderListResult(accountsList, providerRes);
    }

    if (!cache || (cache.healthy && !cache.healthy()) || !cache.list) {
      if (isCacheCursor) {
        return createStaleCacheResult(accountsList);
      }
      const unwrappedCursor = options.cursor?.kind === 'provider' ? options.cursor.cursor : null;
      const { live, cursor, ...rest } = options;
      const providerRes = await reader.list(accountsList, { ...rest, ...(unwrappedCursor ? { cursor: unwrappedCursor } : {}) });
      return normalizeProviderListResult(accountsList, providerRes);
    }

    const cacheCursor = options.cursor?.kind === 'cache' ? options.cursor.cursor : options.cursor;
    const limit = options.limit ?? 50;
    const cacheRes = cache.list(fullAccounts, { folder: 'inbox', limit, cursor: cacheCursor });

    if (!cacheRes) {
      if (isCacheCursor) {
        return createStaleCacheResult(accountsList);
      }
      const unwrappedCursor = options.cursor?.kind === 'provider' ? options.cursor.cursor : null;
      const { live, cursor, ...rest } = options;
      const providerRes = await reader.list(accountsList, { ...rest, ...(unwrappedCursor ? { cursor: unwrappedCursor } : {}) });
      return normalizeProviderListResult(accountsList, providerRes);
    }

    return normalizeCacheListResult(fullAccounts, cacheRes);
  }

  async function cachedFolders(accountsList, options = {}) {
    if (!isEnabled) {
      return reader.folders(accountsList, options);
    }

    const fullAccounts = [];
    for (const acc of accountsList || []) {
      const full = getFullAccount(acc?.id);
      if (!full || !matchesFullAccount(acc, full)) {
        return reader.folders(accountsList, options);
      }
      fullAccounts.push(full);
    }

    const cached = cache?.getFolders ? cache.getFolders(fullAccounts) : null;
    if (cached) {
      return { ...cached, source: 'cache' };
    }

    const tickets = fullAccounts.map(acc => ({
      account: acc,
      ticket: cache?.beginSnapshot ? cache.beginSnapshot(acc, 'INBOX') : null
    }));

    const providerFolders = await reader.folders(accountsList, options);

    for (const item of tickets) {
      if (item.ticket && cache?.isTicketCurrent?.(item.ticket)) {
        const fresh = getFullAccount(item.account.id);
        if (fresh && isSameFullAccount(fresh, item.account)) {
          cache?.putFolders?.(item.ticket, providerFolders);
        }
      }
    }

    return { ...providerFolders, source: 'provider' };
  }

  async function cachedRead(account, reference, options = {}) {
    if (!isEnabled) {
      return reader.read(account, reference, options);
    }

    const fullAccount = getFullAccount(account?.id);
    if (!fullAccount || !matchesFullAccount(account, fullAccount)) {
      return reader.read(account, reference, options);
    }

    const cachedBody = cache?.getBody ? cache.getBody(fullAccount, reference) : null;
    if (cachedBody) {
      const header = cache?.getHeader ? cache.getHeader(fullAccount, reference) : null;
      let bodyText = '';
      if (typeof cachedBody.text === 'string' && cachedBody.text.trim().length > 0) {
        bodyText = cachedBody.text;
      } else if (typeof cachedBody.html === 'string' && cachedBody.html.trim().length > 0) {
        bodyText = convert(cachedBody.html, { wordwrap: false }).trim();
      } else if (typeof cachedBody.body === 'string' && cachedBody.body.trim().length > 0) {
        bodyText = cachedBody.body;
      } else if (typeof cachedBody.text === 'string') {
        bodyText = cachedBody.text;
      } else if (typeof cachedBody.body === 'string') {
        bodyText = cachedBody.body;
      }

      return {
        ...(header || {}),
        reference,
        body: bodyText,
        truncated: false,
        bodyUnavailable: false,
        attachments: cachedBody.attachments ?? header?.attachments ?? [],
        source: 'cache'
      };
    }

    const providerRes = await reader.read(account, reference, options);
    return { ...providerRes, source: 'provider' };
  }

  async function cachedContent(account, reference, options = {}) {
    const bypass = Boolean(
      options.privateKey ||
      options.key ||
      options.passphrase ||
      options.certificate ||
      options.decrypted ||
      options.includeInlineImages ||
      options.inlineImages ||
      options.embeddedImages ||
      options.source
    );

    if (!isEnabled || bypass) {
      const providerRes = await reader.content(account, reference, options);
      return { ...providerRes, source: 'provider' };
    }

    const fullAccount = getFullAccount(account?.id);
    if (!fullAccount || !matchesFullAccount(account, fullAccount)) {
      const providerRes = await reader.content(account, reference, options);
      return { ...providerRes, source: 'provider' };
    }

    const cachedBody = cache?.getBody ? cache.getBody(fullAccount, reference) : null;
    if (cachedBody) {
      return { ...cachedBody, source: 'cache' };
    }

    const ticket = cache?.beginSnapshot ? cache.beginSnapshot(fullAccount, reference?.path || 'INBOX') : null;

    const contentOptions = {
      maxDecodedBytes: 8 * 1024 * 1024,
      maxEncodedBytes: 32 * 1024 * 1024,
      ...options
    };

    const rawContent = await reader.content(account, reference, contentOptions);

    let finalContent = rawContent;
    if (rawContent && rawContent.complete === true && !rawContent.unsupportedEncrypted && !rawContent.encrypted && !rawContent.decrypted) {
      let rendered;
      if (typeof renderContent === 'function') {
        rendered = await renderContent(rawContent);
      } else {
        rendered = {
          ...rawContent,
          html: rawContent.html ? sanitizeMailHtml(rawContent.html, rawContent.attachments) : (rawContent.html ?? ''),
          sanitized: true
        };
      }
      finalContent = rendered;

      if (ticket && cache?.isTicketCurrent?.(ticket)) {
        const freshAccount = getFullAccount(account.id);
        if (freshAccount && isSameFullAccount(freshAccount, fullAccount)) {
          const textLen = Buffer.byteLength(rendered.text || '', 'utf8');
          const htmlLen = Buffer.byteLength(rendered.html || '', 'utf8');
          const bodySize = textLen + htmlLen;

          if (bodySize <= DEFAULT_MAX_MESSAGE_BODY_BYTES && rendered.sanitized === true) {
            const safeAttachments = (rendered.attachments || []).map(a => ({
              id: a.id,
              filename: safeFilename(a.filename, 'attachment'),
              mimeType: a.mimeType || a.contentType,
              size: a.size,
              contentId: a.contentId ?? null
            }));

            const recordToAdmit = {
              ...rendered,
              attachments: safeAttachments
            };

            try {
              cache.putBody(ticket, reference, recordToAdmit);
            } catch {}
          }
        }
      }
    }

    return { ...finalContent, source: 'provider' };
  }

  const mutationCounts = new Map(); // accountId -> count
  const mutationTokens = new Map(); // accountId -> array of tokens

  async function withMutation(account, change, asyncWork) {
    if (typeof change === 'function' && asyncWork === undefined) {
      asyncWork = change;
      change = { reason: 'mutation' };
    }
    if (!account || typeof account.id !== 'string') {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }
    if (typeof asyncWork !== 'function') {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }

    const safeChange = (change && typeof change === 'object') ? {
      reason: String(change.reason || 'mutation'),
      ...(change.references ? { references: change.references } : {}),
      ...(change.paths ? { paths: change.paths } : {})
    } : { reason: 'mutation' };

    const fullAccount = getFullAccount(account.id);
    const isCallerValid = fullAccount && matchesFullAccount(account, fullAccount);

    // The arrival outbox captures new business mail before any provider move.
    // This hook also covers reader.apply's closure, not only adapter.withMutation.
    if (isCallerValid) await beforeMutation?.(fullAccount, change ?? { reason: 'mutation' });

    let token = null;
    if (isCallerValid) {
      try {
        if (cache?.beginMutation) {
          token = cache.beginMutation(fullAccount, safeChange);
        }
      } catch {}
    }

    const currentCount = (mutationCounts.get(account.id) ?? 0) + 1;
    mutationCounts.set(account.id, currentCount);
    let tokens = mutationTokens.get(account.id);
    if (!tokens) {
      tokens = [];
      mutationTokens.set(account.id, tokens);
    }
    if (token) {
      tokens.push(token);
    }

    try {
      return await asyncWork();
    } finally {
      if (token) {
        try {
          if (cache?.endMutation) {
            cache.endMutation(token);
          }
        } catch {}
        const curTokens = mutationTokens.get(account.id);
        if (curTokens) {
          const idx = curTokens.indexOf(token);
          if (idx >= 0) curTokens.splice(idx, 1);
        }
      }

      const remaining = (mutationCounts.get(account.id) ?? 1) - 1;
      if (remaining <= 0) {
        mutationCounts.delete(account.id);
        mutationTokens.delete(account.id);

        const freshAccount = getFullAccount(account.id);
        const sameIdentity = isCallerValid && freshAccount && isSameFullAccount(freshAccount, fullAccount);

        if (sameIdentity && isEnabled) {
          try {
            if (sync?.refresh) {
              sync.refresh([account.id], { priority: true }).catch(() => {});
            }
          } catch {}
        }
      } else {
        mutationCounts.set(account.id, remaining);
      }
    }
  }

  async function wrappedApply(account, reference, action, options) {
    return withMutation(
      account,
      { reason: 'apply', references: [reference], action },
      () => reader.apply(account, reference, action, options)
    );
  }

  async function wrappedEmptyTrash(account, ...args) {
    return withMutation(
      account,
      { reason: 'emptyTrash' },
      () => reader.emptyTrash(account, ...args)
    );
  }

  async function wrappedManageFolder(account, ...args) {
    return withMutation(
      account,
      { reason: 'manageFolder' },
      () => reader.manageFolder(account, ...args)
    );
  }

  async function wrappedSetProviderLabel(account, reference, ...args) {
    return withMutation(
      account,
      { reason: 'setProviderLabel', references: [reference] },
      () => reader.setProviderLabel(account, reference, ...args)
    );
  }

  const decoratedReader = new Proxy(reader, {
    get(target, prop, receiver) {
      if (prop === 'list') return cachedList;
      if (prop === 'folders') return cachedFolders;
      if (prop === 'read') return cachedRead;
      if (prop === 'content') return cachedContent;
      if (prop === 'apply') return wrappedApply;
      if (prop === 'emptyTrash') return wrappedEmptyTrash;
      if (prop === 'manageFolder') return wrappedManageFolder;
      if (prop === 'setProviderLabel') return wrappedSetProviderLabel;
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return val.bind(target);
      }
      return val;
    }
  });

  function status() {
    const connectedAccounts = resolveAccounts();
    const cacheStatus = cache?.status ? cache.status(connectedAccounts) : null;
    const isHealthy = cache ? (cache.healthy ? cache.healthy() : (cacheStatus?.healthy !== false)) : false;
    const syncStatus = sync?.status ? sync.status() : null;

    const activeSet = new Set(syncStatus?.active || []);
    const pendingSet = new Set(syncStatus?.pending || []);
    const refreshing = connectedAccounts.some(a => activeSet.has(a.id) || pendingSet.has(a.id));

    const accountsStatus = connectedAccounts.map(acc => {
      const syncAcc = syncStatus?.accounts?.find(a => a.accountId === acc.id);
      const cacheAcc = cacheStatus?.accounts?.find(a => a.accountId === acc.id);

      const lastSuccessfulSync = syncAcc?.lastSuccessfulUpdate ?? cacheAcc?.lastRefresh ?? null;
      const lastAttemptedSync = syncAcc?.lastAttemptedUpdate ?? null;

      let err = null;
      if (syncAcc?.error) {
        err = typeof syncAcc.error === 'string' ? syncAcc.error : safeError(syncAcc.error);
      }

      return {
        accountId: acc.id,
        lastSuccessfulSync,
        lastAttemptedSync,
        error: err,
        headerCount: cacheAcc?.headerCount ?? 0,
        bodyCount: cacheAcc?.bodyCount ?? 0,
        bodyBytes: cacheAcc?.bodyBytes ?? 0,
        coverage: syncAcc?.coverage ?? (cacheAcc ? { status: cacheAcc.reconciled ? 'complete' : (cacheAcc.coverageStatus || 'warming') } : null)
      };
    });

    const rev = computeRevision(connectedAccounts, cacheStatus, syncStatus);

    const result = {
      enabled: isEnabled,
      healthy: isHealthy,
      headerCount: cacheStatus?.headerCount ?? 0,
      bodyCount: cacheStatus?.bodyCount ?? 0,
      bodyBytes: cacheStatus?.bodyBytes ?? 0,
      maxHeadersPerAccount: cacheStatus?.maxHeadersPerAccount ?? DEFAULT_MAX_HEADERS_PER_ACCOUNT,
      maxBodyBytes: cacheStatus?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      maxMessageBodyBytes: cacheStatus?.maxMessageBodyBytes ?? DEFAULT_MAX_MESSAGE_BODY_BYTES,
      rendererVersion: cacheStatus?.rendererVersion ?? DEFAULT_RENDERER_VERSION,
      refreshing,
      revision: rev,
      accounts: accountsStatus
    };

    if (!isHealthy) {
      result.error = 'cache_unavailable';
    }

    return result;
  }

  async function configure(options) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }
    const keys = Object.keys(options);
    if (keys.length !== 1 || keys[0] !== 'maxHeadersPerAccount') {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }
    const maxHeadersPerAccount = options.maxHeadersPerAccount;
    if (!Number.isSafeInteger(maxHeadersPerAccount) || maxHeadersPerAccount < 100 || maxHeadersPerAccount > 5000) {
      throw new MailHarborError('invalid_request', errorMessages.invalid_request);
    }

    if (store?.update) {
      await store.update(current => {
        const doc = current ?? {};
        doc.mailCacheSettings = {
          ...(doc.mailCacheSettings || {}),
          maxHeadersPerAccount
        };
        return doc;
      });
    }

    cache?.updateSettings?.({ maxHeadersPerAccount });

    if (isEnabled && sync?.refresh) {
      sync.refresh(null, { priority: true }).catch(() => {});
    }

    return status();
  }

  async function clear() {
    cache?.clear?.();
    if (isEnabled && sync?.refresh) {
      sync.refresh(null, { priority: true }).catch(() => {});
    }
    return status();
  }

  async function refresh(accountIds = null, options = {}) {
    if (sync?.refresh) {
      sync.refresh(accountIds, options).catch(() => {});
    }
    return status();
  }

  return {
    reader: decoratedReader,
    withMutation,
    status,
    refresh,
    clear,
    configure
  };
}
