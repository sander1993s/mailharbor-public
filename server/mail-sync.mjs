import { sanitizeMailHtml } from './mail-content.mjs';
import { safeError } from './validation.mjs';

const MAX_CONCURRENT = 2;
const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_PREFETCH_LIMIT = 50;

/**
 * Independent mail synchronizer.
 * Runs in background while no browser open.
 * Concurrency: at most 2 accounts concurrently, 1 per account.
 * Stages:
 *   1. Publish first newest 50 headers immediately.
 *   2. Fill remaining headers up to X with date ordering and membership reconciliation.
 *   3. Bounded body prefetch with HTML sanitization before admission.
 */
export function createMailSync({
  accounts = [],
  cache,
  reader,
  renderContent,
  now = () => Date.now(),
  autoSchedule = true,
  intervalMs = DEFAULT_INTERVAL_MS,
  changed = () => {}
} = {}) {
  let accountsSource = accounts;
  const accountsMap = new Map();

  const activeSyncs = new Map(); // accountId -> Promise
  const abortControllers = new Map(); // accountId -> AbortController
  const queue = []; // array of { accountId, priority, resolve, reject, promise }
  const backoffMap = new Map(); // accountId -> { failures, nextAttemptTime }
  const lastSuccessMap = new Map(); // accountId -> timestamp
  const lastAttemptMap = new Map(); // accountId -> timestamp
  const lastErrorMap = new Map(); // accountId -> error
  const coverageMap = new Map(); // accountId -> coverage
  const bodyFailureMap = new Map(); // `${accountId}:${uid}` -> { failures, nextAttempt }
  const notificationStates = new Map(); // accountId -> state
  const notificationErrors = new Map(); // accountId -> { accountId, code }

  let isClosed = false;
  let timer = null;

  function resolveAccounts() {
    if (accountsSource && typeof accountsSource.list === 'function') {
      try {
        const list = accountsSource.list();
        if (Array.isArray(list)) {
          const result = [];
          for (const entry of list) {
            if (!entry) continue;
            const isConnected = entry.connected !== undefined ? entry.connected === true : true;
            if (!isConnected) continue;
            if (typeof accountsSource.get === 'function' && entry.id) {
              const full = accountsSource.get(entry.id);
              if (full) {
                if (full.connected === false) continue;
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
    if (Array.isArray(accountsSource)) {
      return accountsSource.filter(entry => entry && entry.connected !== false);
    }
    return Array.from(accountsMap.values());
  }

  function getLiveAccount(accountId) {
    if (accountsSource && typeof accountsSource.get === 'function') {
      try {
        const live = accountsSource.get(accountId);
        if (live && live.connected !== false) return live;
        return null;
      } catch {}
    }
    syncAccountsMap();
    return accountsMap.get(accountId) ?? null;
  }

  function failureKey(accountId, ref) {
    const p = ref?.path ? (String(ref.path).toUpperCase() === 'INBOX' ? 'INBOX' : String(ref.path)) : 'INBOX';
    return `${accountId}:${p}:${ref?.uidValidity ?? ''}:${ref?.uid}:${ref?.fingerprint ?? ''}`;
  }

  function syncAccountsMap() {
    const list = resolveAccounts();
    const newMap = new Map();
    for (const a of list) {
      if (!a?.id) continue;
      newMap.set(a.id, structuredClone(a));
      const old = accountsMap.get(a.id);
      if (old && (old.revision !== a.revision || old.email !== a.email)) {
        // Revision replacement: abort in-flight work for old account revision
        abortControllers.get(a.id)?.abort();
        notificationStates.delete(a.id);
        notificationErrors.delete(a.id);
        lastSuccessMap.delete(a.id);
        lastErrorMap.delete(a.id);
        coverageMap.delete(a.id);
        backoffMap.delete(a.id);
        for (const [k] of bodyFailureMap) {
          if (k.startsWith(`${a.id}:`)) bodyFailureMap.delete(k);
        }
      }
    }
    // Cancel accounts that were removed
    for (const [id] of accountsMap) {
      if (!newMap.has(id)) {
        abortControllers.get(id)?.abort();
        // Do NOT delete from activeSyncs immediately to avoid exceeding concurrency!
        backoffMap.delete(id);
        notificationStates.delete(id);
        notificationErrors.delete(id);
        lastSuccessMap.delete(id);
        lastErrorMap.delete(id);
        coverageMap.delete(id);
        for (const [k] of bodyFailureMap) {
          if (k.startsWith(`${id}:`)) bodyFailureMap.delete(k);
        }
      }
    }
    accountsMap.clear();
    for (const [id, val] of newMap) accountsMap.set(id, val);
  }

  syncAccountsMap();

  // Preserve last successful timestamp from persisted cache on restart
  try {
    const statusObj = cache?.status ? cache.status() : null;
    if (statusObj?.accounts && Array.isArray(statusObj.accounts)) {
      for (const acc of statusObj.accounts) {
        if (acc.lastRefresh && Number.isFinite(acc.lastRefresh)) {
          lastSuccessMap.set(acc.accountId, acc.lastRefresh);
        }
      }
    }
  } catch {}

  function updateAccounts(newAccounts) {
    if (Array.isArray(newAccounts)) {
      accountsSource = newAccounts;
    } else if (newAccounts && (typeof newAccounts.list === 'function' || typeof newAccounts.get === 'function')) {
      accountsSource = newAccounts;
    }
    syncAccountsMap();
  }

  async function performAccountSync(account, priority = false, signal) {
    if (signal?.aborted || isClosed) return;
    syncAccountsMap();
    const currentAccount = getLiveAccount(account.id);
    if (!currentAccount || currentAccount.revision !== account.revision || currentAccount.email !== account.email) return;

    // If cache is blocked by active mutation, do NOT perform provider work
    if (cache.isMutating?.(account)) {
      return;
    }

    const ticket = cache.beginSnapshot(account, 'INBOX');
    if (!ticket) {
      // Snapshot could not begin (e.g. active mutation or cache failure)
      return;
    }

    lastAttemptMap.set(account.id, now());

    // Stage 1: Fetch newest 50 headers
    const first50 = await reader.list([account], {
      folder: 'inbox',
      limit: 50,
      sort: 'date_desc',
      includeAttachments: true,
      includeStatus: true,
      signal
    });

    if (signal?.aborted || isClosed) return;
    if (first50.errors && first50.errors.length > 0) {
      const code = first50.errors[0].code || 'mailbox_error';
      const err = new Error(code);
      err.code = code;
      throw err;
    }

    const uidValidity = first50.messages[0]?.reference?.uidValidity ??
      first50.nextCursor?.accounts?.[0]?.folders?.[0]?.uidValidity ??
      null;

    // Handle empty inbox safely
    if (first50.messages.length === 0) {
      const liveEmpty = getLiveAccount(account.id);
      if (!liveEmpty || liveEmpty.revision !== account.revision || liveEmpty.email !== account.email || !cache.isTicketCurrent(ticket)) {
        return;
      }
      const okEmpty = cache.commitHeaders(ticket, {
        messages: [],
        uidValidity,
        total: 0,
        complete: true,
        checkpoint: 'first50'
      });
      if (!okEmpty) return;

      const liveEmptyAfter = getLiveAccount(account.id);
      if (!liveEmptyAfter || liveEmptyAfter.revision !== account.revision || liveEmptyAfter.email !== account.email || !cache.isTicketCurrent(ticket)) {
        return;
      }

      if (first50.states && first50.states.length > 0) {
        const state = first50.states.find(s => s.accountId === account.id) ?? first50.states[0];
        if (state && state.accountId === account.id) {
          notificationStates.set(account.id, state);
          notificationErrors.delete(account.id);
        }
      }

      lastSuccessMap.set(account.id, now());
      lastErrorMap.delete(account.id);
      backoffMap.delete(account.id);
      coverageMap.set(account.id, {
        status: 'complete',
        phase: 'complete',
        count: 0,
        total: 0
      });

      try {
        changed(account.id, {
          phase: 'complete',
          count: 0,
          total: 0,
          revision: account.revision,
          success: true,
          notificationSnapshot: notificationSnapshot()
        });
      } catch {}

      try {
        if (typeof reader.folders === 'function' && typeof cache.putFolders === 'function') {
          const folderRes = await reader.folders([account], { signal });
          const liveFolders = getLiveAccount(account.id);
          if (liveFolders && liveFolders.revision === account.revision && liveFolders.email === account.email && cache.isTicketCurrent(ticket)) {
            if (folderRes && Array.isArray(folderRes.folders) && !folderRes.errors?.some(e => e && e.accountId === account.id)) {
              cache.putFolders(ticket, folderRes);
            }
          }
        }
      } catch {}
      return;
    }

    const liveFirst50 = getLiveAccount(account.id);
    if (!liveFirst50 || liveFirst50.revision !== account.revision || liveFirst50.email !== account.email || !cache.isTicketCurrent(ticket)) {
      return;
    }

    const okFirst50 = cache.commitHeaders(ticket, {
      messages: first50.messages,
      uidValidity,
      total: first50.total,
      nextCursor: first50.nextCursor,
      complete: first50.messages.length >= (first50.total ?? 0),
      checkpoint: 'first50'
    });
    if (!okFirst50) return;

    const liveFirst50After = getLiveAccount(account.id);
    if (!liveFirst50After || liveFirst50After.revision !== account.revision || liveFirst50After.email !== account.email || !cache.isTicketCurrent(ticket)) {
      return;
    }

    if (first50.states && first50.states.length > 0) {
      const state = first50.states.find(s => s.accountId === account.id) ?? first50.states[0];
      if (state && state.accountId === account.id) {
        notificationStates.set(account.id, state);
        notificationErrors.delete(account.id);
      }
    }

    coverageMap.set(account.id, {
      status: 'warming',
      phase: 'first50',
      count: first50.messages.length,
      total: first50.total
    });

    try {
      changed(account.id, {
        phase: 'first50',
        count: first50.messages.length,
        total: first50.total,
        revision: account.revision,
        success: true,
        notificationSnapshot: notificationSnapshot()
      });
    } catch {}

    try {
      if (typeof reader.folders === 'function' && typeof cache.putFolders === 'function') {
        const folderRes = await reader.folders([account], { signal });
        const liveFolders = getLiveAccount(account.id);
        if (liveFolders && liveFolders.revision === account.revision && liveFolders.email === account.email && cache.isTicketCurrent(ticket)) {
          if (folderRes && Array.isArray(folderRes.folders) && !folderRes.errors?.some(e => e && e.accountId === account.id)) {
            cache.putFolders(ticket, folderRes);
          }
        }
      }
    } catch {}

    // Stage 2: Fill remaining headers up to X (maxHeadersPerAccount)
    const statusObj = cache.status ? cache.status([account]) : null;
    const maxHeaders = statusObj?.maxHeadersPerAccount ?? 500;
    const allHeaders = [...first50.messages];
    let cursor = first50.nextCursor;

    while (allHeaders.length < maxHeaders && cursor && !signal?.aborted && !isClosed) {
      const liveCheck = getLiveAccount(account.id);
      if (!liveCheck || liveCheck.revision !== account.revision || liveCheck.email !== account.email || !cache.isTicketCurrent(ticket)) {
        return;
      }
      const batchLimit = Math.min(100, maxHeaders - allHeaders.length);
      const nextPage = await reader.list([account], {
        folder: 'inbox',
        limit: batchLimit,
        sort: 'date_desc',
        includeAttachments: true,
        cursor,
        signal
      });

      if (signal?.aborted || isClosed) return;
      if (nextPage.errors && nextPage.errors.length > 0) {
        const code = nextPage.errors[0].code || 'mailbox_error';
        const err = new Error(code);
        err.code = code;
        throw err;
      }
      if (!nextPage.messages || nextPage.messages.length === 0) break;
      allHeaders.push(...nextPage.messages);
      cursor = nextPage.nextCursor;
    }

    if (signal?.aborted || isClosed) return;
    const liveFull = getLiveAccount(account.id);
    if (!liveFull || liveFull.revision !== account.revision || liveFull.email !== account.email || !cache.isTicketCurrent(ticket)) {
      return;
    }

    const okFull = cache.commitHeaders(ticket, {
      messages: allHeaders,
      uidValidity,
      total: first50.total,
      nextCursor: cursor,
      complete: true,
      checkpoint: 'headers'
    });
    if (!okFull) return;

    lastSuccessMap.set(account.id, now());
    lastErrorMap.delete(account.id);
    backoffMap.delete(account.id);

    coverageMap.set(account.id, {
      status: 'complete',
      phase: 'headers',
      count: allHeaders.length,
      total: first50.total
    });

    try {
      changed(account.id, {
        phase: 'headers',
        count: allHeaders.length,
        total: first50.total,
        revision: account.revision,
        success: true,
        notificationSnapshot: notificationSnapshot()
      });
    } catch {}

    // Stage 3: Bounded body prefetch
    // Prune bodyFailureMap to current bounded header identities
    const currentHeaderKeys = new Set(allHeaders.map(m => failureKey(account.id, m.reference)));
    for (const [k] of bodyFailureMap) {
      if (k.startsWith(`${account.id}:`) && !currentHeaderKeys.has(k)) {
        bodyFailureMap.delete(k);
      }
    }

    const cacheStatus = cache.status ? cache.status() : null;
    const maxDecoded = cacheStatus?.maxMessageBodyBytes ?? 2 * 1024 * 1024;
    const maxEncoded = Math.min(10 * 1024 * 1024, maxDecoded * 4);

    const toPrefetch = [];
    const currentTime = now();
    for (const msg of allHeaders) {
      if (toPrefetch.length >= DEFAULT_PREFETCH_LIMIT) break;
      if (msg.reference && !cache.hasBody(account, msg.reference)) {
        const failKey = failureKey(account.id, msg.reference);
        const failRecord = bodyFailureMap.get(failKey);
        if (failRecord && currentTime < failRecord.nextAttempt) continue;
        toPrefetch.push(msg.reference);
      }
    }

    if (toPrefetch.length > 0 && !signal?.aborted && !isClosed) {
      async function handleContentAdmission(ref, rawContent) {
        if (!rawContent || !rawContent.complete || rawContent.unsupportedEncrypted) return;
        const liveAdmission = getLiveAccount(account.id);
        if (!liveAdmission || liveAdmission.revision !== account.revision || liveAdmission.email !== account.email || !cache.isTicketCurrent(ticket)) {
          return;
        }
        let rendered;
        if (typeof renderContent === 'function') {
          rendered = await renderContent(rawContent);
        } else {
          rendered = {
            ...rawContent,
            html: rawContent.html ? sanitizeMailHtml(rawContent.html, rawContent.attachments) : '',
            sanitized: true
          };
        }
        const liveAdmissionAfter = getLiveAccount(account.id);
        if (!liveAdmissionAfter || liveAdmissionAfter.revision !== account.revision || liveAdmissionAfter.email !== account.email || !cache.isTicketCurrent(ticket)) {
          return;
        }
        if (rendered && rendered.sanitized === true && cache.isTicketCurrent(ticket)) {
          const putOk = cache.putBody(ticket, ref, rendered);
          if (!putOk) {
            const failKey = failureKey(account.id, ref);
            const cur = bodyFailureMap.get(failKey)?.failures ?? 0;
            bodyFailureMap.set(failKey, { failures: cur + 1, nextAttempt: now() + 300000 });
          }
        }
      }

      if (typeof reader.contentBatch === 'function') {
        try {
          const batchResults = await reader.contentBatch(account, toPrefetch, {
            maxEncodedBytes: maxEncoded,
            maxDecodedBytes: maxDecoded,
            includeAttachments: true,
            signal,
            onContent: async ({ reference, content, error }) => {
              if (signal?.aborted || isClosed) return;
              if (content) await handleContentAdmission(reference, content);
              else if (error) {
                const failKey = failureKey(account.id, reference);
                const cur = bodyFailureMap.get(failKey)?.failures ?? 0;
                bodyFailureMap.set(failKey, { failures: cur + 1, nextAttempt: now() + 300000 });
              }
            }
          });

          if (Array.isArray(batchResults)) {
            for (const item of batchResults) {
              if (signal?.aborted || isClosed) break;
              if (item.content) {
                await handleContentAdmission(item.reference, item.content);
              }
            }
          }
        } catch {
          // Batch fetch errors do not fail the header cycle
        }
      } else if (typeof reader.content === 'function') {
        for (const ref of toPrefetch) {
          if (signal?.aborted || isClosed) break;
          try {
            const rawContent = await reader.content(account, ref, {
              maxEncodedBytes: maxEncoded,
              maxDecodedBytes: maxDecoded,
              includeAttachments: true,
              signal
            });
            await handleContentAdmission(ref, rawContent);
          } catch {
            const failKey = failureKey(account.id, ref);
            const cur = bodyFailureMap.get(failKey)?.failures ?? 0;
            bodyFailureMap.set(failKey, { failures: cur + 1, nextAttempt: now() + 300000 });
          }
        }
      }
    }

    // Final verification before recording success
    if (signal?.aborted || isClosed) return;
    const liveFinal = getLiveAccount(account.id);
    if (!liveFinal || liveFinal.revision !== account.revision || liveFinal.email !== account.email || !cache.isTicketCurrent(ticket)) {
      return;
    }

    lastSuccessMap.set(account.id, now());
    lastErrorMap.delete(account.id);
    backoffMap.delete(account.id);
    coverageMap.set(account.id, {
      status: 'complete',
      phase: 'complete',
      count: allHeaders.length,
      total: first50.total
    });

    try {
      changed(account.id, {
        phase: 'complete',
        count: allHeaders.length,
        total: first50.total,
        revision: account.revision,
        success: true,
        notificationSnapshot: notificationSnapshot()
      });
    } catch {}
  }

  function processQueue() {
    if (isClosed) return;
    while (activeSyncs.size < MAX_CONCURRENT && queue.length > 0) {
      const nextIndex = queue.findIndex(item => !activeSyncs.has(item.accountId));
      if (nextIndex < 0) break;
      const [item] = queue.splice(nextIndex, 1);
      syncAccountsMap();
      const account = accountsMap.get(item.accountId);
      if (!account) {
        item.resolve();
        continue;
      }

      const controller = new AbortController();
      abortControllers.set(item.accountId, controller);

      const promise = (async () => {
        try {
          await performAccountSync(account, item.priority, controller.signal);
          item.resolve();
        } catch (error) {
          const currentLive = getLiveAccount(account.id);
          const isCurrentJob = currentLive && currentLive.revision === account.revision && currentLive.email === account.email;
          const sanitized = safeError(error);
          if (isCurrentJob) {
            lastErrorMap.set(account.id, sanitized);
            notificationErrors.set(account.id, { accountId: account.id, code: sanitized.code });
            const currentFailures = (backoffMap.get(account.id)?.failures ?? 0) + 1;
            const delay = Math.min(300000, 10000 * Math.pow(2, currentFailures - 1)) + Math.random() * 2000;
            backoffMap.set(account.id, { failures: currentFailures, nextAttemptTime: now() + delay });
            try {
              changed(account.id, {
                phase: 'error',
                error: sanitized,
                revision: account.revision,
                success: false,
                notificationSnapshot: notificationSnapshot()
              });
            } catch {}
          }
          item.reject(sanitized);
        } finally {
          activeSyncs.delete(item.accountId);
          abortControllers.delete(item.accountId);
          processQueue();
        }
      })();

      activeSyncs.set(item.accountId, promise);
    }
  }

  function refresh(accountIds = null, { priority = false } = {}) {
    if (isClosed) {
      const err = new Error('cancelled');
      err.code = 'cancelled';
      return Promise.reject(err);
    }
    syncAccountsMap();
    const targetIds = accountIds
      ? accountIds.filter(id => accountsMap.has(id))
      : Array.from(accountsMap.keys());

    const promises = targetIds.map(accountId => {
      // Coalescing: check if already active
      if (activeSyncs.has(accountId)) {
        return activeSyncs.get(accountId);
      }

      // Coalescing: check if already in queue
      const existingQueue = queue.find(item => item.accountId === accountId);
      if (existingQueue) {
        if (priority && !existingQueue.priority) {
          existingQueue.priority = true;
          queue.sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
        }
        return existingQueue.promise;
      }

      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });

      const entry = { accountId, priority: Boolean(priority), resolve, reject, promise };
      if (priority) {
        const firstNonPriority = queue.findIndex(q => !q.priority);
        if (firstNonPriority >= 0) queue.splice(firstNonPriority, 0, entry);
        else queue.push(entry);
      } else {
        queue.push(entry);
      }
      return promise;
    });

    processQueue();
    return Promise.allSettled(promises);
  }

  function checkSchedule() {
    if (isClosed) return;
    syncAccountsMap();
    const currentTime = now();
    for (const [id] of accountsMap) {
      if (activeSyncs.has(id) || queue.some(q => q.accountId === id)) continue;

      const backoff = backoffMap.get(id);
      if (backoff && currentTime < backoff.nextAttemptTime) continue;

      const lastSuccess = lastSuccessMap.get(id);
      if (lastSuccess && currentTime - lastSuccess < intervalMs) continue;

      // Due for refresh
      refresh([id], { priority: false });
    }
  }

  if (autoSchedule) {
    // Initial cycle auto-start without waiting
    queueMicrotask(() => {
      if (!isClosed) checkSchedule();
    });
    timer = setInterval(checkSchedule, Math.min(10000, intervalMs));
    timer.unref?.();
  }

  function status() {
    syncAccountsMap();
    return {
      active: Array.from(activeSyncs.keys()),
      pending: queue.map(q => q.accountId),
      concurrency: activeSyncs.size,
      accounts: Array.from(accountsMap.values()).map(acc => ({
        accountId: acc.id,
        lastSuccessfulUpdate: lastSuccessMap.get(acc.id) ?? null,
        lastAttemptedUpdate: lastAttemptMap.get(acc.id) ?? null,
        error: lastErrorMap.get(acc.id) ?? null,
        coverage: coverageMap.get(acc.id) ?? null,
        backoff: backoffMap.get(acc.id) ? {
          failures: backoffMap.get(acc.id).failures,
          nextAttemptTime: backoffMap.get(acc.id).nextAttemptTime
        } : null
      }))
    };
  }

  async function close() {
    isClosed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const controller of abortControllers.values()) {
      controller.abort();
    }
    while (queue.length > 0) {
      const item = queue.shift();
      const err = new Error('cancelled');
      err.code = 'cancelled';
      item.reject(err);
    }
    while (activeSyncs.size > 0) {
      await Promise.allSettled(Array.from(activeSyncs.values()));
    }
    activeSyncs.clear();
    abortControllers.clear();
  }

  function notificationSnapshot() {
    syncAccountsMap();
    const states = Array.from(notificationStates.values())
      .filter(st => accountsMap.has(st.accountId))
      .map(st => structuredClone(st))
      .sort((a, b) => a.accountId.localeCompare(b.accountId) || (a.folderId || '').localeCompare(b.folderId || ''));
    const errors = Array.from(notificationErrors.values())
      .filter(err => accountsMap.has(err.accountId))
      .map(err => structuredClone(err))
      .sort((a, b) => a.accountId.localeCompare(b.accountId));
    return { states, errors };
  }

  return {
    refresh,
    status,
    notificationSnapshot,
    updateAccounts,
    close
  };
}
