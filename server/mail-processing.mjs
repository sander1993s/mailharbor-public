import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CLASSIFIER_VERSION, SCHEMA_VERSION, PROMPT_VERSION, classificationResult, validateClassificationRequest } from './mail-classifier.mjs';
import { MAIL_CATEGORIES, POLICY_VERSION, computeMailDisposition, shouldRescueJunk, validateMailClassification } from './mail-policy.mjs';
import { MailHarborError, safeError } from './validation.mjs';
import { safeMailboxDiagnostic } from './mailboxes.mjs';
import { CONTENT_EXTRACTION_VERSION } from './body.mjs';
import { PROCESSING_VERSION, MAX_ATTEMPTS, RETRY_DELAY, categoryOf, processingReasons, workMetadata } from './mail-processing-state.mjs';

const INTERVAL = 15 * 60 * 1000;
const BATCH_GROWTH_LATENCY = 90 * 1000;
const VERSIONS = Object.freeze({ processing: PROCESSING_VERSION, classifier: CLASSIFIER_VERSION, schema: SCHEMA_VERSION,
  prompt: PROMPT_VERSION, extractor: CONTENT_EXTRACTION_VERSION, policy: POLICY_VERSION, actions: 1 });
const RECORDED_CLASSIFICATION_FAILURE = Symbol('recorded_classification_failure');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CLASSIFICATION_RETRY_VERSION = hash({ classifier: CLASSIFIER_VERSION, schema: SCHEMA_VERSION, prompt: PROMPT_VERSION });
const POLICY_LABELS = new Set(MAIL_CATEGORIES.map(category => category.id));
const email = account => account.email.trim().normalize('NFC').toLowerCase();
const messageKey = (account, reference) => hash([account.id, email(account), reference.fingerprint]);
const locationKey = reference => hash([reference.path, reference.uidValidity, reference.uid]);
const gmailIdentity = location => location.gmail === true && typeof location.emailId === 'string' && /^\d{1,20}$/.test(location.emailId) ? location.emailId : null;
const matchingAliases = (record, location) => {
  const identity = gmailIdentity(location);
  return identity ? record.locations.filter(value => value.reference.accountId === location.reference.accountId && gmailIdentity(value) === identity) : [location];
};
const initial = () => ({ enabled: false, providerConsent: null, tenderGraceMonths: null, tenderGraceDays: null, mode: 'preview',
  batchSize: 12, timeoutStreak: 0, invalidSingleStreak: 0, retryAt: null, pauseReason: null, lastRun: null, counts: { markedRead: 0, moved: 0, trashed: 0, archived: 0, rescued: 0, errors: 0 }, preview: null });
const policyText = { coupons: ['Trash', 'When every offer has a confirmed expiry'], development: ['Trash', '1 month'], social: ['Trash', '1 week'], jobs: ['Trash', '1 month'], security: ['Archive', '1 month'], travel: ['Archive', '2 years'], work: ['Archive', '1 year'], newsletters: ['Trash', '1 month'], finance: ['Archive', '2 years'], invoices: ['Archive', '7 years'], tenders: ['Archive', 'After the deadline; 6 months if no deadline is established'], appointments: ['Archive', 'After the confirmed appointment end'], orders: ['Archive', '7 years'] };

export function createMailProcessing({ index, store, accounts, reader, tags, jobs, classify, enqueueInvoice, now = () => Date.now(), autoSchedule = true }) {
  let settings = { ...initial(), ...(index.get('meta', 'processingSettings') ?? {}) };
  let active = null, timer = null, closed = false, phase = 'idle', operationAccount = null, fault = null, ownerMutation = false, settingsEpoch = 0;
  let mailboxWriter = false, mailboxWriteDone = null;
  let resumedWork = null;
  const holder = randomUUID();
  let leaseRenewAt = 0;
  const ownLease = () => {
    if (now() < leaseRenewAt) return;
    if (index.claimLease && !index.claimLease('processing', holder, now())) throw new MailHarborError('busy');
    leaseRenewAt = now() + 60000;
  };
  ownLease();
  const leaseTimer = setInterval(() => {
    try { ownLease(); } catch { fault = 'busy'; settings.enabled = false; active?.controller.abort(new MailHarborError('busy')); }
  }, 60000); leaseTimer.unref?.();
  const save = () => index.put('meta', 'processingSettings', settings);
  const selected = () => accounts.list().filter(account => account.connected).map(account => accounts.get(account.id));
  const verify = account => {
    if (closed || active?.controller.signal.aborted) throw new MailHarborError('cancelled');
    if (fault || index.healthy?.() === false) throw new MailHarborError('configuration_error');
    ownLease();
    const current = accounts.get(account.id);
    if (current.revision !== account.revision || email(current) !== email(account)) throw new MailHarborError('stale_message');
  };
  const invoiceState = record => {
    const ledger = store.read().invoiceFiling, source = ledger?.sources?.[record.key];
    if (source?.recordIds?.some(id => ledger.records?.[id]?.status === 'needs_review')) return 'invoice_review_required';
    return index.get('invoiceQueue', record.key) || (source && (!source.complete || source.recordIds?.some(id => ledger.records?.[id]?.status === 'waiting_drive'))) ? 'invoice_waiting' : null;
  };
  const manualPolicyLabels = (account, reference) => (tags.manualFor?.(account, reference) ?? []).filter(label => POLICY_LABELS.has(label));
  const labelMovePending = key => Boolean(index.get('labelSync', key)?.intent);
  function availableMessages(options) {
    const found = new Map();
    for (;;) {
      const rows = index.list('messages', options);
      let deferred = false;
      index.transaction(() => {
        for (const row of rows) {
          if (labelMovePending(row.key)) {
            // Retain the original retention/retry dates in the record. Postpone
            // only its queue wake-up so an unresolved filing journal cannot
            // occupy every batch slot or spin the organizer indefinitely.
            const metadata = workMetadata(row.value, index.token);
            index.put('messages', row.key, row.value, { ...metadata, due: Math.max(metadata.due ?? 0, now() + INTERVAL) });
            deferred = true;
          } else found.set(row.key, row);
        }
      });
      if (found.size >= options.limit || !deferred) return [...found.values()].slice(0, options.limit);
    }
  }
  const put = record => {
    const owner = eligibleAccount(record);
    record.disconnected = !owner;
    record.blockers = processingReasons(record, { now: now(), settings, invoiceState: record.classification ? invoiceState(record) : null,
      manualLabels: record.classification && owner ? manualPolicyLabels(owner, record.reference) : [] });
    if (!owner) record.blockers.push('account_disconnected');
    record.processingVersion = PROCESSING_VERSION;
    index.put('messages', record.key, record, workMetadata(record, index.token));
  };
  const count = name => { settings.counts[name] = (settings.counts[name] ?? 0) + 1; };
  const progress = (value, account = null) => { phase = value; operationAccount = account?.id ?? null; settings.phaseStartedAt = now(); };
  const advanced = () => { settings.lastProgressAt = new Date(now()).toISOString(); };
  async function timed(stage, work) {
    const started = now();
    try { return await work(); } finally {
      settings.metrics ??= {}; settings.metrics.stages ??= {};
      const metric = settings.metrics.stages[stage] ?? { calls: 0, totalMs: 0 };
      metric.calls++; metric.lastMs = Math.max(0, now() - started); metric.totalMs += metric.lastMs;
      settings.metrics.stages[stage] = metric;
    }
  }
  function recordError(error, account = null) {
    const sanitized = safeError(error), code = sanitized.code, accountId = account?.id ?? operationAccount;
    count('errors'); settings.lastError = code;
    if (settings.lastRun) settings.lastRun.errorCount = (settings.lastRun.errorCount ?? 0) + 1;
    const mailboxDiagnostic = safeMailboxDiagnostic(error?.mailboxDiagnostic);
    const entry = { at: new Date(now()).toISOString(), code, phase, ...(sanitized.diagnostic ? { diagnostic: sanitized.diagnostic } : {}), ...(mailboxDiagnostic ? { mailboxDiagnostic } : {}),
      ...(typeof accountId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(accountId) ? { accountId } : {}) };
    settings.recentErrors = [...(settings.recentErrors ?? []), entry].slice(-50);
  }
  const signal = () => active.controller.signal;
  const eligibleAccount = record => { try { const account = accounts.get(record.accountId); return email(account) === record.email ? account : null; } catch { return null; } };
  function summary() {
    if (index.processingSummary) return index.processingSummary();
    const result = { analysis: {}, categories: {}, reasons: {}, earliestDue: null };
    let after = '';
    for (;;) {
      const rows = index.list('messages', { after, limit: 250 });
      for (const { value } of rows) {
        const metadata = workMetadata(value, index.token);
        result.analysis[metadata.analysis] = (result.analysis[metadata.analysis] ?? 0) + 1;
        result.categories[metadata.category] = (result.categories[metadata.category] ?? 0) + 1;
        for (const reason of metadata.reasons) result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
        if (metadata.due != null) result.earliestDue = Math.min(result.earliestDue ?? Infinity, metadata.due);
      }
      if (rows.length < 250) return result;
      after = rows.at(-1).key;
    }
  }
  function status() {
    const totals = summary();
    const waitingUntil = Date.parse(settings.retryAt ?? settings.scheduledAt);
    const stalled = settings.enabled && ((active && now() - (settings.phaseStartedAt ?? now()) > 5 * 60000) ||
      (autoSchedule && !active && !ownerMutation && !timer && totals.earliestDue != null && totals.earliestDue < now() - 5 * 60000 && !(waitingUntil > now())));
    const workerState = fault || index.healthy?.() === false ? 'blocked' : stalled ? 'stalled' : active ? 'running' :
      !settings.enabled ? settings.pauseReason ? 'blocked' : 'paused' : settings.retryAt && Date.parse(settings.retryAt) > now() ? 'retrying' : 'idle';
    const tender = settings.tenderGraceMonths !== null ? `${settings.tenderGraceMonths} months after the tender deadline; otherwise 6 months` : settings.tenderGraceDays !== null ? `${settings.tenderGraceDays} days after the tender deadline; otherwise 6 months` : 'Awaiting your tender deadline rule';
    return { enabled: settings.enabled, running: Boolean(active), phase, providerConsent: settings.providerConsent === true, tenderConfigured: settings.tenderGraceMonths !== null || settings.tenderGraceDays !== null,
      mode: settings.mode, batchSize: settings.batchSize, retryAt: settings.enabled ? settings.retryAt ?? settings.scheduledAt ?? null : null, pauseReason: fault ?? settings.pauseReason, lastRun: settings.lastRun,
      workerState, lastProgressAt: settings.lastProgressAt ?? null, migration: settings.migration ?? null,
      reasonCounts: totals.reasons, coverage: totals.analysis, metrics: settings.metrics ?? {}, accountBackoff: settings.accountBackoff ?? {},
      pilot: { maxActions: settings.maxActions ?? null, maxClassifications: settings.maxClassifications ?? null,
        actionAttempts: settings.pilotCounters?.actionAttempts ?? 0, classified: settings.pilotCounters?.classified ?? 0 },
      accounts: selected().map(account => {
        const checkpoints = index.list('folders', { limit: 4096 }).map(row => row.value).filter(value => value.accountId === account.id);
        const blocked = settings.accountBackoff?.[account.id];
        return { id: account.id, label: account.label, discoveryComplete: checkpoints.length > 0 && checkpoints.every(value => value.done) && !(blocked?.until > now()),
          reason: blocked?.until > now() ? blocked.code : null, retryAt: blocked?.until > now() ? new Date(blocked.until).toISOString() : null };
      }),
      recentErrors: settings.recentErrors ?? [],
      counts: { ...settings.counts, discovered: index.count('messages'), analyzed: totals.analysis.classified ?? 0, needsReview: totals.categories.review ?? 0,
        pending: (totals.analysis.pending ?? 0) + (totals.analysis.retrying ?? 0), retrying: totals.categories.retry ?? 0,
        technicalFailures: totals.categories.failed ?? 0, automaticHolds: totals.categories.held ?? 0 },
      preview: settings.preview, policies: [...MAIL_CATEGORIES.map(category => ({ ...category, action: policyText[category.id][0], retention: category.id === 'tenders' ? tender : policyText[category.id][1] })),
        { id: 'sent', label: 'Sent', action: 'Archive', retention: '7 years' }, { id: 'drafts', label: 'Drafts', action: 'Trash', retention: '2 months' }, { id: 'junk', label: 'Junk', action: 'Review', retention: 'Return mail Gemini confidently identifies as legitimate to Inbox' }] };
  }
  function schedule(wait = INTERVAL) {
    clearTimeout(timer);
    timer = null;
    if (!autoSchedule || closed || !settings.enabled || active || ownerMutation) return;
    settings.scheduledAt = new Date(now() + wait).toISOString(); save();
    timer = setTimeout(() => { timer = null; settings.scheduledAt = null; launch().catch(() => {}); }, wait); timer.unref?.();
  }
  function backoff(account, error) {
    if (!['mailbox_error', 'mailbox_timeout', 'mailbox_login_required'].includes(error?.code)) return;
    if (error.code === 'mailbox_error' && !['timeout', 'connection_closed', 'connection_reset', 'connection_refused',
      'dns_error', 'tls_error', 'throttled', 'authentication_failed'].includes(error.mailboxDiagnostic?.reason)) return;
    settings.accountBackoff ??= {};
    const previous = settings.accountBackoff[account.id], attempts = (previous?.revision === account.revision ? previous.attempts ?? 0 : 0) + 1;
    settings.accountBackoff[account.id] = { revision: account.revision, attempts, code: error.code,
      until: now() + Math.min(4 * 3600000, INTERVAL * 2 ** Math.min(4, attempts - 1)) + Math.floor(Math.random() * 30000) };
    return true;
  }
  const accountReady = account => !settings.accountBackoff?.[account.id] || settings.accountBackoff[account.id].revision !== account.revision || settings.accountBackoff[account.id].until <= now();
  const accountRecovered = account => {
    const previous = settings.accountBackoff?.[account.id];
    // Only real, verified mailbox success resets consecutive connection failures.
    // An in-flight success cannot revoke a newer cooldown that is still active.
    if (previous && (previous.revision !== account.revision || previous.until <= now())) delete settings.accountBackoff[account.id];
  };
  async function inventory(current, checkpoint = { position: 0, folders: [] }) {
    const { folders } = checkpoint;
    while (checkpoint.position < current.length) {
      if (ownerMutation) break;
      const account = current[checkpoint.position++];
      if (!accountReady(account)) continue;
      try {
        progress('discovering', account);
        const data = await timed('inventory', () => reader.folders(account, { signal: signal(), verify: () => verify(account) })); verify(account); accountRecovered(account);
        for (const folder of data.folders) folders.push({ account, folder: { ...folder, gmail: data.gmail === true } });
      } catch (error) { if (signal().aborted) throw error; recordError(error, account); backoff(account, error); }
    }
    return folders.sort((a, b) => Number(b.folder.role === 'inbox') - Number(a.folder.role === 'inbox'));
  }
  async function scanFolder(account, folder) {
    const id = hash([account.id, email(account), folder.path]), saved = index.get('folders', id);
    let cursor = saved ?? { afterUid: 0, uidValidity: null };
    // A one-time header refresh enriches metadata written by releases before
    // Gmail physical-message identity was stored. Cached classifications survive.
    if (folder.gmail && saved && saved.gmailIdentityVersion !== 1) cursor = { afterUid: 0, uidValidity: null };
    progress('discovering', account);
    let page;
    try { page = await timed('discovery', () => reader.scan(account, { path: folder.path, afterUid: cursor.afterUid, uidValidity: cursor.uidValidity,
      highWatermark: cursor.done ? null : cursor.highWatermark ?? null, limit: 100, signal: signal(), verify: () => verify(account) })); }
    catch (error) {
      if (error.code !== 'stale_message' || !cursor.uidValidity) throw error;
      cursor = { afterUid: 0, uidValidity: null };
      page = await reader.scan(account, { path: folder.path, limit: 100, signal: signal(), verify: () => verify(account) });
    }
    verify(account);
    accountRecovered(account);
    const records = new Map();
    let undiscoveredHeldUid = null;
    index.transaction(() => {
      for (const message of page.messages) {
        const key = messageKey(account, message.reference), existing = records.get(key) ?? index.get('messages', key);
        if (labelMovePending(key)) {
          if (!existing) undiscoveredHeldUid = Math.min(undiscoveredHeldUid ?? Infinity, message.reference.uid);
          continue;
        }
        const location = { reference: message.reference, role: message.role ?? folder.role, read: !message.unread, handled: null,
          gmail: folder.gmail === true, emailId: typeof message.emailId === 'string' ? message.emailId : null };
        const role = location.role;
        const record = existing ?? { key, accountId: account.id, email: email(account), discoveredAt: now(), message: null, reference: message.reference, receivedAt: message.receivedAt || message.date, locations: [], classification: null, complete: false, review: false, nextAt: now() };
        const position = record.locations.findIndex(value => locationKey(value.reference) === locationKey(message.reference));
        if (position < 0) { record.locations.push(location); record.nextAt = now(); }
        else if (record.locations[position].handled === 'absent') record.locations[position] = location;
        else Object.assign(record.locations[position], { gmail: location.gmail, emailId: location.emailId });
        // Prefer an actionable location over Gmail's All Mail copy.
        if (!record.message || ['inbox', 'sent', 'drafts', 'junk'].includes(role)) {
          record.reference = message.reference;
          record.message = Object.fromEntries(['accountId', 'account', 'folderPath', 'subject', 'author', 'to', 'date', 'unread', 'starred'].map(name => [name, message[name]]));
        }
        records.set(key, record);
      }
      for (const record of records.values()) put(record);
    });
    // Persist headers before flagging. A verified read batch or durable read retry
    // must exist before the UID checkpoint advances; cancellation keeps this page.
    await markLocations(account, [...records.values()]);
    verify(account);
    index.put('folders', id, { afterUid: undiscoveredHeldUid == null ? page.afterUid : Math.min(page.afterUid, undiscoveredHeldUid - 1), uidValidity: page.uidValidity, highWatermark: page.highWatermark,
      gmailIdentityVersion: folder.gmail ? 1 : null, accountId: account.id, lastScan: now(), done: page.done && undiscoveredHeldUid == null });
    advanced();
    // Retry undiscovered journal-held mail next pass without repeatedly scanning
    // this same page now or losing its header behind the discovery checkpoint.
    return page.done || undiscoveredHeldUid != null;
  }
  async function markLocations(account, records) {
    if (settings.mode !== 'apply') return;
    if (!accountReady(account)) return;
    const readBackoff = settings.readBackoff?.[account.id];
    if (readBackoff?.revision === account.revision && readBackoff.until > now()) return;
    const groups = new Map();
    for (const record of records) for (const location of record.locations) {
      if (labelMovePending(record.key)) continue;
      if (location.read || location.handled === 'absent' || location.readRetryAt > now()) continue;
      const id = hash([location.reference.path, location.reference.uidValidity]);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({ record, location });
    }
    for (const entries of groups.values()) for (let offset = 0; offset < entries.length; offset += 100) {
      if (ownerMutation) return;
      const batch = entries.slice(offset, offset + 100);
      progress('marking_read', account);
      let result;
      try { result = await timed('read_flags', () => reader.markRead(account, batch.map(value => value.location.reference), { signal: signal(), verify: () => verify(account) })); }
      catch (error) {
        if (signal().aborted || !['mailbox_error', 'mailbox_timeout', 'mailbox_login_required'].includes(error.code)) throw error;
        verify(account);
        index.transaction(() => {
          recordError(error, account);
          backoff(account, error);
          const until = Math.max(now() + INTERVAL, settings.accountBackoff?.[account.id]?.until ?? 0);
          settings.readBackoff ??= {};
          settings.readBackoff[account.id] = { revision: account.revision, until };
          for (const entry of batch) { entry.location.readRetryAt = until; put(entry.record); }
          save();
        });
        return;
      }
      verify(account);
      accountRecovered(account);
      index.transaction(() => {
        if (settings.readBackoff?.[account.id]) delete settings.readBackoff[account.id];
        for (const item of result.results) {
          const entry = batch.find(value => locationKey(value.location.reference) === locationKey(item.reference)); if (!entry) continue;
          if (['applied', 'already_read'].includes(item.status)) { entry.location.read = true; entry.location.readRetryAt = null; entry.record.message.unread = false; if (item.status === 'applied') count('markedRead'); }
          else { entry.location.handled = item.status; entry.record.review = item.status === 'changed'; }
          put(entry.record);
        }
        save();
        advanced();
      });
    }
  }
  async function markCachedLocations() {
    progress('discovering');
    let after = settings.markCursor ?? '';
    for (let page = 0; page < 20; page++) {
      if (ownerMutation) break;
      const rows = index.list('messages', { after, limit: 100 }), groups = new Map();
      for (const { value: record } of rows) {
        if (labelMovePending(record.key)) continue;
        if (!record.locations.some(location => !location.read && location.handled !== 'absent')) continue;
        const account = eligibleAccount(record);
        if (!account) continue;
        if (!groups.has(account.id)) groups.set(account.id, { account, records: [] });
        groups.get(account.id).records.push(record);
      }
      // Preview metadata may already be behind saved UID cursors. Mark that cached
      // backlog in batches as well, before provider latency can delay read flags.
      for (const { account, records } of groups.values()) await markLocations(account, records);
      if (rows.length < 100) { settings.markCursor = ''; break; }
      after = rows.at(-1).key;
      settings.markCursor = after;
    }
  }
  async function model(messages) {
    if (classify) return classify({ messages }, signal());
    const owner = 'mail-processing', job = await jobs.submit({ messages }, owner, 'classification');
    try {
      for (;;) {
        if (signal().aborted) throw signal().reason;
        const result = jobs.get(job.id, owner);
        if (['completed', 'failed', 'cancelled'].includes(result.status)) { settings.metrics ??= {}; settings.metrics.provider = result.metrics ?? null; }
        if (result.status === 'completed') return result.result;
        if (['failed', 'cancelled'].includes(result.status)) throw Object.assign(new MailHarborError(result.error?.code ?? 'cancelled'), result.error);
        await delay(250, undefined, { signal: signal() });
      }
    } finally { jobs.cancel(job.id, owner); jobs.release?.(job.id, owner); }
  }
  async function classifyPending() {
    if (ownerMutation) return false;
    let remaining = settings.maxClassifications == null ? settings.batchSize : Math.min(settings.batchSize, settings.maxClassifications - (settings.pilotCounters?.classified ?? 0));
    if (remaining <= 0) { settings.enabled = false; settings.pauseReason = 'pilot_complete'; return false; }
    const candidates = [], current = selected();
    const start = (settings.accountPosition ?? 0) % Math.max(1, current.length);
    for (let i = 0; i < current.length && candidates.length < remaining; i++) {
      const account = current[(start + i) % current.length];
      if (!accountReady(account)) continue;
      const perAccount = Math.max(1, Math.ceil(remaining / Math.max(1, current.length)));
      if ((settings.classificationBatches ?? 0) % 2 === 0) {
        const recovery = availableMessages({ state: 'pending', category: 'retry', before: now(), owner: index.token(`processing:${account.id}:${email(account)}`), order: 'due', limit: 1 });
        if (recovery.length && candidates.length < remaining && !candidates.some(record => record.key === recovery[0].key)) candidates.push(recovery[0].value);
      }
      const rows = availableMessages({ state: 'pending', before: now(), owner: index.token(`processing:${account.id}:${email(account)}`),
        order: (settings.classificationBatches ?? 0) % 4 === 3 ? 'newest' : 'due', limit: Math.min(perAccount, remaining - candidates.length) });
      for (const row of rows) if (candidates.length < remaining && !candidates.some(record => record.key === row.key)) candidates.push(row.value);
    }
    settings.accountPosition = start + 1;
    // Fill unused shares without letting an empty account permanently shrink
    // the actual batch. The first pass still gives every healthy account a turn.
    for (let i = 0; i < current.length && candidates.length < remaining; i++) {
      const account = current[(start + i) % current.length];
      if (!accountReady(account)) continue;
      const rows = availableMessages({ state: 'pending', before: now(), owner: index.token(`processing:${account.id}:${email(account)}`), order: 'due', limit: remaining });
      for (const row of rows) if (candidates.length < remaining && !candidates.some(record => record.key === row.key)) candidates.push(row.value);
    }
    if (!candidates.length) return false;
    const groups = new Map();
    for (const record of candidates) {
      const account = eligibleAccount(record);
      if (!account) { put(record); continue; }
      const id = hash([account.id, record.reference.path, record.reference.uidValidity]);
      if (!groups.has(id)) groups.set(id, { account, records: [] }); groups.get(id).records.push(record);
    }
    const inputs = [], ready = new Map();
    for (const { account, records } of groups.values()) {
      await markLocations(account, records);
      if (!accountReady(account)) continue;
      progress('reading', account);
      let result;
      try {
        result = await timed('body_reads', () => reader.readBatch ? reader.readBatch(account, records.map(record => record.reference), { signal: signal(), verify: () => verify(account) }) :
          Promise.all(records.map(record => reader.read(account, record.reference, { signal: signal(), verify: () => verify(account) }))).then(messages => ({ messages, errors: [] })));
      } catch (error) {
        if (!signal().aborted && error.code === 'mailbox_login_required') {
          verify(account); recordError(error, account); backoff(account, error); save();
          continue;
        }
        if (signal().aborted || !['mailbox_error', 'mailbox_timeout'].includes(error.code)) throw error;
        result = { messages: [], errors: records.map(record => ({ reference: record.reference, code: error.code, mailboxDiagnostic: error.mailboxDiagnostic })) };
      }
      verify(account);
      const authentication = result.errors?.find(error => error.code === 'mailbox_login_required');
      // A failed read session is one connection failure, even when every
      // message in its batch gets an individual durable read retry.
      if (result.errors?.length) result.errors.some(error => backoff(account, error));
      else accountRecovered(account);
      if (authentication) { recordError(authentication, account); save(); }
      for (const message of result.messages) {
        const record = records.find(record => record.reference.fingerprint === message.reference.fingerprint); if (!record) continue;
        if (record.readError) record.review = false;
        record.readError = null; record.readRetryAt = null;
        record.retryAt = null;
        record.complete = message.bodyUnavailable === false && message.truncated !== true && message.body.length <= 8000;
        record.contentReasons = message.contentReasons ?? (record.complete ? [] : ['legacy_incomplete']);
        record.extractionVersion = message.extractionVersion ?? CONTENT_EXTRACTION_VERSION;
        if (record.refreshRequested) {
          record.contentRecoveryAttempts = (record.contentRecoveryAttempts ?? 0) + 1;
          if (!record.complete && record.classification) {
            record.refreshRequested = false; record.retryAt = null; record.nextAt = now(); put(record); continue;
          }
        }
        const source = { ...record.message, ...message };
        inputs.push({ id: record.key, subject: source.subject || '', author: source.author || '', to: source.to || '', date: source.date || '', folderKind: record.locations.find(location => locationKey(location.reference) === locationKey(record.reference))?.role || 'other', body: String(message.body || '').slice(0, 8000), complete: record.complete });
        ready.set(record.key, { record, account });
      }
      for (const error of result.errors ?? []) {
        if (error.code === 'mailbox_login_required') continue;
        const record = records.find(record => record.reference.fingerprint === error.reference.fingerprint);
        if (record) {
          record.readAttempts = (record.readAttempts ?? 0) + 1;
          record.readError = error.code;
          record.retryAt = null;
          record.contentReasons = ['fetch_failure'];
          const retry = ['mailbox_error', 'mailbox_timeout'].includes(error.code) && record.readAttempts < 3;
          record.readRetryAt = retry ? now() + INTERVAL : null;
          record.review = !retry; record.nextAt = record.readRetryAt;
          put(record); recordError(error, account);
        }
      }
    }
    if (!inputs.length) return true;
    // Finish the selected classification unit before handing over the writer.
    // Yielding after body reads would repeatedly discard that preparation when
    // label polling is faster than IMAP, without ever reaching the provider.
    progress('classifying');
    const request = validateClassificationRequest({ messages: inputs });
    const started = now();
    let result;
    try {
      result = classificationResult(await model(request.messages), request);
      if (!result?.items || result.items.length !== inputs.length) throw new MailHarborError('invalid_model_output');
    } catch (error) {
      if (signal().aborted || !['invalid_model_output', 'timeout', 'provider_error'].includes(error?.code)) throw error;
      for (const value of ready.values()) verify(value.account);
      const single = inputs.length === 1 ? ready.get(inputs[0].id) : null;
      index.transaction(() => {
        recordError(error, single?.account);
        if (single) {
          single.record.classificationError = error.code;
          single.record.classificationFailedAt = now();
          single.record.classificationAttempts = (single.record.classificationAttempts ?? 0) + 1;
          single.record.classificationErrorVersion = CLASSIFIER_VERSION;
          single.record.classificationRetryVersion = CLASSIFICATION_RETRY_VERSION;
          single.record.classificationDiagnostic = safeError(error).diagnostic ?? null;
          single.record.retryAt = single.record.classificationAttempts < MAX_ATTEMPTS ? now() + RETRY_DELAY * 2 ** (single.record.classificationAttempts - 1) : null;
          single.record.review = true; single.record.nextAt = single.record.retryAt;
          settings.invalidSingleStreak = (settings.invalidSingleStreak ?? 0) + 1;
        } else {
          // No part of an invalid batch is accepted. Retry a smaller bounded batch
          // until a malformed individual reply can be isolated without guessing.
          settings.batchSize = Math.max(1, Math.floor(Math.min(settings.batchSize, inputs.length) / 2));
        }
        settings.fastSuccesses = 0;
        for (const value of ready.values()) put(value.record);
        save();
      });
      if (single && settings.invalidSingleStreak >= 3) {
        settings.breakerFailures = (settings.breakerFailures ?? 0) + 1;
        settings.probeKey = single.record.key;
        single.record.retryAt = now() + Math.min(4 * 3600000, RETRY_DELAY * 2 ** Math.min(4, settings.breakerFailures - 1));
        if (single.record.classificationAttempts < MAX_ATTEMPTS) { single.record.nextAt = single.record.retryAt; put(single.record); }
        const paused = new MailHarborError(error.code);
        paused[RECORDED_CLASSIFICATION_FAILURE] = true;
        throw paused;
      }
      if (error.code === 'timeout') { if (single) settings.batchSize = Math.max(1, Math.floor(settings.batchSize / 2)); settings.timeoutStreak++; save();
        const paused = new MailHarborError('timeout'); paused[RECORDED_CLASSIFICATION_FAILURE] = true; throw paused; }
      return true;
    }
    // Persist validated classification before applying labels or IMAP actions.
    index.transaction(() => {
      settings.timeoutStreak = 0;
      settings.invalidSingleStreak = 0;
      settings.probeKey = null; settings.breakerFailures = 0; settings.retryAt = null; settings.pauseReason = null;
      const elapsed = Math.max(0, now() - started);
      settings.metrics ??= {}; settings.metrics.lastBatch = { messages: inputs.length, latencyMs: elapsed, at: new Date(now()).toISOString() };
      settings.classificationBatches = (settings.classificationBatches ?? 0) + 1;
      // CLI startup is a substantial fixed cost. A valid 60–90 second batch
      // still has headroom under the provider timeout and must be able to grow.
      settings.fastSuccesses = elapsed < BATCH_GROWTH_LATENCY && inputs.length === settings.batchSize ? (settings.fastSuccesses ?? 0) + 1 : 0;
      if (settings.fastSuccesses >= 3) { settings.batchSize = Math.min(12, settings.batchSize + (settings.batchSize < 3 ? 1 : 3)); settings.fastSuccesses = 0; }
      for (const item of result.items) {
        const value = ready.get(item.id); if (!value) throw new MailHarborError('invalid_model_output');
        verify(value.account);
        const old = value.record.classification;
        // Improved reads cannot silently remove a previously protective category.
        if (old) item.labels = [...new Set([...old.labels, ...item.labels])];
        value.record.classification = item; value.record.classifiedAt = now(); value.record.classifierVersion = CLASSIFIER_VERSION; value.record.nextAt = now();
        value.record.schemaVersion = SCHEMA_VERSION; value.record.promptVersion = PROMPT_VERSION; value.record.policyVersion = POLICY_VERSION;
        value.record.classificationError = null; value.record.retryAt = null; value.record.refreshRequested = false;
        value.record.classificationAttempts = 0;
        if (!old) count('analyzed');
        settings.lastRun.classified = (settings.lastRun.classified ?? 0) + 1;
        if (settings.maxClassifications != null) { settings.pilotCounters ??= {}; settings.pilotCounters.classified = (settings.pilotCounters.classified ?? 0) + 1; }
        put(value.record);
      }
      advanced();
      save();
    });
    return true;
  }
  function invoiceProtected(record) {
    if (index.get('invoiceQueue', record.key)) return true;
    const ledger = store.read().invoiceFiling;
    const source = ledger?.sources?.[record.key];
    return !!source && (!source.complete || source.recordIds?.some(id => ['needs_review', 'waiting_drive'].includes(ledger.records?.[id]?.status)));
  }
  async function prepareHandling(account, record) {
    if (record.ownerDecision?.action === 'keep' || record.refreshRequested || record.classificationError) {
      record.review = false; record.nextAt = null; put(record);
      return { account, record, nextAt: null, review: false, actions: [], pending: 0 };
    }
    if (settings.mode === 'apply') {
      await tags.automatic({ account, message: record.message, reference: record.reference, labels: record.classification.labels, verify: () => verify(account) });
      record.tagRefreshPending = false;
      if (record.classification.labels.includes('invoices')) await enqueueInvoice?.({ account, message: record.message, reference: record.reference });
    }
    const manualLabels = manualPolicyLabels(account, record.reference);
    const context = { account, record, nextAt: null, review: false, actions: [], pending: 0 };
    if (settings.mode === 'apply' && record.locations.some(location => !location.read && location.handled !== 'absent')) {
      // Classification and labels can proceed during a provider flag failure,
      // but a message is not moved until its requested read flag is verified.
      context.review = record.review = true;
      context.nextAt = record.nextAt = now() + INTERVAL;
      put(record);
      return context;
    }
    const groups = new Map();
    for (const location of record.locations) {
      if (location.handled && !['target_unavailable', 'changed'].includes(location.handled)) continue;
      const identity = gmailIdentity(location), key = identity ? hash([location.reference.accountId, identity]) : locationKey(location.reference);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(location);
    }
    for (const aliases of groups.values()) {
      const options = aliases.map(location => {
        const decision = computeMailDisposition({ classification: record.classification, receivedAt: record.receivedAt, folderKind: location.role, manualLabels, now: now(), tenderGraceMonths: settings.tenderGraceMonths, tenderGraceDays: settings.tenderGraceDays, invoiceProtected: invoiceProtected(record), complete: record.complete });
        const action = location.role === 'junk' ? (shouldRescueJunk(record.classification, { complete: record.complete }) ? 'rescue' : 'hold') : decision.action;
        return { location, decision, action };
      });
      const inTrash = options.find(value => value.decision.reason === 'already_in_trash');
      const rescue = options.find(value => value.action === 'rescue');
      const blockers = options.filter(value => value.action === 'hold' && value.decision.reason !== 'already_archived');
      // Aliases cannot weaken the same physical message's longest retention.
      // Unknown holds win; otherwise wait for the latest known role deadline.
      const blocking = blockers.find(value => value.decision.dueAt == null) ?? blockers.sort((left, right) => Date.parse(right.decision.dueAt) - Date.parse(left.decision.dueAt))[0];
      const intended = options.some(value => value.action === 'archive') ? 'archive' : options.some(value => value.action === 'trash') ? 'trash' : 'hold';
      const actionable = options.filter(value => value.action === intended);
      const chosen = inTrash ?? rescue ?? blocking ?? actionable.find(value => value.location.reference.path.toUpperCase() === 'INBOX') ?? actionable[0] ?? options[0];
      const { location, decision, action } = chosen;
      // Incomplete or uncertain junk stays in Junk; retention does not silently remove it.
      const due = decision.dueAt == null ? null : Date.parse(decision.dueAt);
      if (action === 'hold') {
        if (Number.isFinite(due) && due > now()) context.nextAt = Math.min(context.nextAt ?? Infinity, due);
        else if (!['already_archived', 'already_in_trash', 'trash_excluded'].includes(decision.reason)) {
          context.review = true; context.nextAt = Math.min(context.nextAt ?? Infinity, now() + 86400000);
        }
        continue;
      }
      if (settings.mode === 'preview') {
        const counts = settings.preview.counts; counts[action] = (counts[action] ?? 0) + 1;
        continue;
      }
      context.actions.push({ context, location, action, aliases });
      if (action === 'rescue') break;
    }
    if (settings.mode === 'preview') {
      settings.preview.sampleSize = (settings.preview.sampleSize ?? 0) + 1;
      settings.preview.labels ??= {};
      for (const label of record.classification.labels) settings.preview.labels[label] = (settings.preview.labels[label] ?? 0) + 1;
      settings.preview.counts.markRead += record.locations.filter(location => !location.read).length;
      if (context.review) settings.preview.counts.review++;
      return context;
    }
    context.pending = context.actions.length;
    record.review = context.review; record.nextAt = context.pending ? now() : context.nextAt;
    if (!context.pending) record.lastHandledAt = now();
    put(record);
    return context;
  }
  async function checkpointMove(entry, result) {
    const { context, location, action } = entry, { account, record } = context;
    if (!result || !['applied', 'already_target', 'absent', 'changed', 'target_unavailable'].includes(result.status)) throw new MailHarborError('mailbox_error');
    if (['applied', 'already_target'].includes(result.status)) {
      for (const alias of matchingAliases(record, location)) { alias.handled = action; alias.intent = null; }
      settings.lastRun.actions = (settings.lastRun.actions ?? 0) + 1;
      if (result.status === 'applied') { count('moved'); count({ trash: 'trashed', archive: 'archived', rescue: 'rescued' }[action]); }
      if (result.reference) {
        record.reference = result.reference; record.message.folderPath = result.reference.path;
        record.tagRefreshPending = true;
        // Rescued messages retain their cached classification for normal Inbox retention.
        if (action === 'rescue') {
          if (!record.locations.some(value => locationKey(value.reference) === locationKey(result.reference) && value.role === 'inbox')) {
            record.locations.push({ reference: result.reference, role: entry.aliases?.some(value => value.role === 'sent') ? 'sent' : 'inbox', read: true, handled: null,
              gmail: location.gmail === true, emailId: location.emailId ?? null });
          }
          context.nextAt = Math.min(context.nextAt ?? Infinity, now() + INTERVAL);
        }
      }
    } else {
      // An absent source after an interrupted MOVE is uncertain, never proof of success.
      location.handled = result.status; location.intent = null; context.review = true;
      if (result.status === 'target_unavailable') context.nextAt = Math.min(context.nextAt ?? Infinity, now() + INTERVAL);
      if (result.status === 'absent' && entry.aliases?.some(alias => alias !== location && (!alias.handled || ['target_unavailable', 'changed'].includes(alias.handled)))) {
        context.nextAt = Math.min(context.nextAt ?? Infinity, now() + INTERVAL);
      }
    }
    context.pending--;
    record.review = context.review;
    record.nextAt = context.pending || record.tagRefreshPending ? now() : context.nextAt;
    if (!context.pending) record.lastHandledAt = now();
    // Commit each server result before another IMAP operation or a tag-store write.
    index.transaction(() => { put(record); save(); });
    advanced();
    if (action === 'rescue' && result.reference && record.classification.labels.includes('invoices')) {
      await enqueueInvoice?.({ account, message: record.message, reference: result.reference });
    }
    if (record.tagRefreshPending) {
      await tags.observe([account], [{ ...record.message, reference: record.reference }], { verify: () => verify(account) });
      record.tagRefreshPending = false;
      record.nextAt = context.pending ? now() : context.nextAt;
      put(record);
    }
  }
  async function moveEntries(account, entries) {
    for (let offset = 0; offset < entries.length; offset += 40) {
      if (ownerMutation) return;
      const batch = entries.slice(offset, offset + 40), expected = new Map(batch.map(entry => [locationKey(entry.location.reference), entry]));
      if (settings.maxActions != null && (settings.pilotCounters?.actionAttempts ?? 0) + batch.length > settings.maxActions) {
        const available = Math.max(0, settings.maxActions - (settings.pilotCounters?.actionAttempts ?? 0));
        if (available) await moveEntries(account, batch.slice(0, available));
        settings.enabled = false; settings.pauseReason = 'pilot_complete'; return;
      }
      verify(account); progress('applying', account);
      // Both not-yet-issued and uncertain in-flight actions survive a failure. On
      // resumption the transport verifies source UIDVALIDITY and fingerprint again.
      index.transaction(() => {
        settings.lastRun.actionAttempts = (settings.lastRun.actionAttempts ?? 0) + batch.length;
        if (settings.maxActions != null) { settings.pilotCounters ??= {}; settings.pilotCounters.actionAttempts = (settings.pilotCounters.actionAttempts ?? 0) + batch.length; }
        for (const entry of batch) {
          for (const alias of entry.aliases ?? [entry.location]) alias.intent = { action: entry.action, at: now() };
          put(entry.context.record);
        }
        save();
      });
      if (reader.moveBatch) {
        const completed = new Set();
        await reader.moveBatch(account, batch.map(entry => ({ reference: entry.location.reference, action: entry.action })), {
          signal: signal(), verify: () => verify(account), onResult: async outcome => {
            const key = locationKey(outcome.reference), entry = expected.get(key);
            if (!entry || completed.has(key) || outcome.action !== entry.action) throw new MailHarborError('mailbox_error');
            await checkpointMove(entry, outcome.result); entry.finished = true; completed.add(key);
          }
        });
        if (completed.size !== batch.length) throw new MailHarborError('mailbox_error');
      } else {
        for (const entry of batch) {
          const result = await reader.move(account, entry.location.reference, entry.action, { signal: signal(), verify: () => verify(account) });
          await checkpointMove(entry, result);
          entry.finished = true;
        }
      }
    }
  }
  async function handleDue(limit = 100) {
    if (ownerMutation) return 0;
    progress('retention');
    const rows = [...availableMessages({ state: 'ready', before: now(), order: 'due', limit }), ...availableMessages({ state: 'review', before: now(), order: 'due', limit })];
    const groups = new Map();
    for (const { value: record } of rows) {
      const account = eligibleAccount(record);
      if (!account) { put(record); continue; }
      if (!record.classification) continue;
      if (!accountReady(account)) { record.nextAt = settings.accountBackoff[account.id].until; put(record); continue; }
      if (!groups.has(account.id)) groups.set(account.id, { account, records: [] });
      groups.get(account.id).records.push(record);
    }
    for (const { account, records } of groups.values()) {
      await markLocations(account, records);
      if (!accountReady(account)) {
        for (const record of records) { record.nextAt = settings.accountBackoff[account.id].until; put(record); }
        continue;
      }
      progress('retention', account);
      const entries = [];
      for (const record of records) {
        const context = await prepareHandling(account, record);
        entries.push(...context.actions);
      }
      if (entries.length) {
        try { await timed('moves', () => moveEntries(account, entries)); if (entries.some(entry => entry.finished)) accountRecovered(account); }
        catch (error) {
          if (signal().aborted || !['mailbox_error', 'mailbox_timeout', 'mailbox_login_required'].includes(error.code)) throw error;
          verify(account);
          backoff(account, error);
          // One failed/uncertain move must not starve every pending classification.
          // Keep its intent and revalidate the source on the next bounded retry.
          const deferred = new Map(entries.filter(entry => !entry.finished).map(entry => [entry.context.record.key, entry.context.record]));
          index.transaction(() => {
            recordError(error, account);
            for (const record of deferred.values()) { record.review = true; record.nextAt = Math.max(now() + INTERVAL, settings.accountBackoff?.[account.id]?.until ?? 0); put(record); }
            save();
          });
        }
      }
    }
    return rows.length;
  }
  async function discoverFolders(folders, budget = 20, complete = new Set()) {
    let pages = 0;
    while (!signal().aborted && !ownerMutation && complete.size < folders.length && pages < budget) {
      pages++;
      let position = (settings.folderPosition ?? 0) % folders.length;
      while (complete.has(position)) position = (position + 1) % folders.length;
      settings.folderPosition = position + 1;
      const { account, folder } = folders[position];
      if (!accountReady(account)) { complete.add(position); continue; }
      try { if (await scanFolder(account, folder)) complete.add(position); }
      catch (error) { if (signal().aborted) throw error; complete.add(position); recordError(error, account); backoff(account, error); }
      save();
      await delay(20, undefined, { signal: signal() });
    }
    return pages;
  }
  async function run() {
    const initialErrors = settings.counts.errors;
    let work = null;
    settings.lastRun = { startedAt: new Date(now()).toISOString(), finishedAt: null, status: 'running', errorCount: 0 }; save();
    try {
      if (settings.probeKey) {
        progress('classifying');
        const probe = { id: hash('MailHarbor recovery probe'), subject: 'Synthetic job alert', author: 'fixture@example.test', to: 'fixture@example.test',
          date: '2026-01-01T12:00:00Z', folderKind: 'inbox', complete: true, body: 'A fictional software developer vacancy notification. No invoice, order, meeting or promotion is included.' };
        try { classificationResult(await model([probe]), { messages: [probe] }); }
        catch (error) { settings.breakerFailures = (settings.breakerFailures ?? 0) + 1; throw error; }
        settings.probeKey = null; settings.invalidSingleStreak = 0; settings.batchSize = 1; save();
      }
      if (settings.mode === 'preview') {
        const folders = await inventory(selected());
        if (!index.count('messages', 'pending') && !index.count('messages', 'ready')) {
          for (const { account, folder } of folders) { if (ownerMutation) break; await scanFolder(account, folder); if (index.count('messages', 'pending')) break; }
        }
        await classifyPending(); await handleDue(40);
        settings.lastRun.status = settings.counts.errors > initialErrors ? 'partial' : 'completed'; return;
      }
      let current = selected();
      const signature = hash(current.map(account => [account.id, email(account), account.revision]));
      work = resumedWork?.signature === signature ? resumedWork : { signature, stage: 'inventory',
        inventory: { position: 0, folders: [] }, folders: [], discovered: new Set(), initialPages: 20, discoverAt: null, handled: 0 };
      resumedWork = null;
      while (!signal().aborted && settings.enabled && !ownerMutation) {
        // A category writer drains one bounded stage. Resume at the next stage
        // afterwards instead of repeating inventory and discovery on every poll.
        if (work.stage === 'inventory') {
          work.folders = await inventory(current, work.inventory);
          if (work.inventory.position >= current.length) work.stage = 'cached';
        } else if (work.stage === 'cached') {
          await markCachedLocations(); work.stage = 'initialDiscovery';
        } else if (work.stage === 'initialDiscovery') {
          work.initialPages -= await discoverFolders(work.folders, work.initialPages, work.discovered);
          if (!work.initialPages || work.discovered.size >= work.folders.length) {
            work.discoverAt = now() + INTERVAL; work.stage = 'retention';
          }
        } else if (work.stage === 'discovery') {
          if (now() >= work.discoverAt) {
            current = selected(); work.signature = hash(current.map(account => [account.id, email(account), account.revision]));
            work.inventory = { position: 0, folders: [] }; work.discovered.clear();
            work.initialPages = 2; work.stage = 'inventory';
          } else {
            await discoverFolders(work.folders, 2, work.discovered); work.stage = 'retention';
          }
        } else if (work.stage === 'retention') {
          work.handled = await handleDue(); work.stage = 'classification';
        } else {
          const pending = await classifyPending(); work.stage = 'discovery';
          if (!pending && !work.handled && work.discovered.size >= work.folders.length) break;
        }
        save();
        await delay(20, undefined, { signal: signal() });
      }
      if (settings.enabled && !ownerMutation) await handleDue();
      settings.lastRun.status = settings.counts.errors > initialErrors ? 'partial' : 'completed';
      if (settings.pauseReason !== 'pilot_complete') settings.pauseReason = null;
      settings.retryAt = null;
    } catch (error) {
      const code = safeError(error).code;
      settings.lastRun.status = signal().aborted ? 'paused' : 'failed';
      if (!signal().aborted) {
        if (!error?.[RECORDED_CLASSIFICATION_FAILURE]) recordError(error);
        settings.pauseReason = code;
        if (code === 'timeout' && !error?.[RECORDED_CLASSIFICATION_FAILURE]) { settings.batchSize = Math.max(1, Math.floor(settings.batchSize / 2)); settings.timeoutStreak++; }
        const providerRetry = Date.parse(error.retryAt);
        settings.retryAt = new Date(Number.isFinite(providerRetry) && providerRetry > now() ? providerRetry : now() +
          (code === 'quota_exhausted' ? error.retryAfterMs ?? 5 * 3600000 : settings.probeKey ? Math.min(4 * 3600000, RETRY_DELAY * 2 ** Math.min(4, (settings.breakerFailures ?? 1) - 1)) : code === 'timeout' ? 60000 : INTERVAL)).toISOString();
        if (['login_required', 'configuration_error'].includes(code)) { settings.enabled = false; settings.retryAt = null; }
        if (index.healthy?.() === false) { fault = 'storage_error'; settings.enabled = false; settings.retryAt = null; }
      }
    } finally {
      resumedWork = ownerMutation && settings.enabled && !signal().aborted && settings.lastRun.status !== 'failed' ? work : null;
      settings.lastRun.finishedAt = new Date(now()).toISOString(); phase = 'idle'; save();
    }
  }
  async function launch() {
    if (closed || active || ownerMutation || !settings.enabled || settings.providerConsent !== true) return;
    if (settings.retryAt && Date.parse(settings.retryAt) > now()) { schedule(Date.parse(settings.retryAt) - now()); return; }
    ownLease();
    const context = { controller: new AbortController(), promise: null }; active = context;
    context.promise = run().finally(() => {
      active = null;
      if (settings.mode === 'preview') { settings.enabled = false; save(); }
      const retryAt = Date.parse(settings.retryAt);
      schedule(Number.isFinite(retryAt) ? Math.max(1000, retryAt - now()) : INTERVAL);
    });
    return context.promise;
  }
  // Additive migration: old successful results and move journals remain intact.
  // Each page and its cursor commit together so a killed migration is resumable.
  const migrationKey = hash(VERSIONS);
  if (settings.reliabilityVersion !== PROCESSING_VERSION || hash(settings.versions ?? {}) !== migrationKey) {
    if (settings.migration?.key !== migrationKey) settings.migration = { version: PROCESSING_VERSION, key: migrationKey, after: '', requeuedFailures: 0, contentRecoveries: 0, successfulPreserved: 0 };
    const policyChanged = settings.versions?.policy !== POLICY_VERSION;
    for (;;) {
      const rows = index.list('messages', { after: settings.migration.after ?? '', limit: 250 });
      index.transaction(() => {
        for (const { value: record } of rows) {
          if (record.migrationKey === migrationKey) continue;
          if (record.classification) settings.migration.successfulPreserved++;
          // Older Gmail archive checks trusted a missing Inbox label even when
          // the exact message still occupied INBOX. Requeue only that saved
          // source checkpoint; the reader must revalidate identity and policy
          // before any effect. Other destinations, intents and owner decisions
          // remain untouched, and this action fix never renews AI retry budgets.
          if (record.archiveRecheckVersion !== VERSIONS.actions) {
            const source = record.locations.find(location => location.gmail === true && location.handled === 'archive' &&
              location.reference.path.toUpperCase() === 'INBOX' && locationKey(location.reference) === locationKey(record.reference) &&
              location.reference.accountId === record.reference.accountId && location.reference.fingerprint === record.reference.fingerprint);
            if (source && !record.ownerDecision && !record.locations.some(location => location.intent)) {
              for (const alias of matchingAliases(record, source)) if (alias.handled === 'archive') alias.handled = null;
              record.nextAt = now();
              settings.migration.archiveRechecks = (settings.migration.archiveRechecks ?? 0) + 1;
            }
            record.archiveRecheckVersion = VERSIONS.actions;
          }
          if (!record.ownerDecision) {
            if (record.classificationError) {
              // Persist the applicable retry version when scheduling recovery, not
              // only after its next failure. Unrelated migrations cannot reset it.
              record.classificationRetryVersion ??= hash({
                classifier: record.classificationErrorVersion ?? settings.versions?.classifier ?? null,
                schema: record.schemaVersion ?? settings.versions?.schema ?? null,
                prompt: record.promptVersion ?? settings.versions?.prompt ?? null
              });
              if (record.classificationRetryVersion !== CLASSIFICATION_RETRY_VERSION) {
                record.classificationAttempts = 0; record.retryAt = now(); record.nextAt = now();
                record.classificationRetryVersion = CLASSIFICATION_RETRY_VERSION;
                record.refreshRequested = Boolean(record.classification);
                settings.migration.requeuedFailures++;
              }
            }
            if (record.classification && !record.complete && record.extractionVersion !== CONTENT_EXTRACTION_VERSION &&
                record.contentRecoveryVersion !== CONTENT_EXTRACTION_VERSION && record.locations.some(location => !location.handled)) {
              record.refreshRequested = true; record.retryAt = now(); record.nextAt = now();
              record.readError = null; record.readAttempts = 0; record.readRetryAt = null;
              record.contentRecoveryVersion = CONTENT_EXTRACTION_VERSION;
              settings.migration.contentRecoveries++;
            }
            if (policyChanged && record.classification && !record.refreshRequested) record.nextAt = now();
          }
          record.migrationKey = migrationKey; record.policyVersion = POLICY_VERSION;
          put(record);
        }
        if (rows.length) settings.migration.after = rows.at(-1).key;
        if (rows.length < 250) {
          settings.reliabilityVersion = PROCESSING_VERSION; settings.versions = { ...VERSIONS }; settings.migration.completedAt = new Date(now()).toISOString();
          settings.invalidSingleStreak = 0;
          if (!settings.enabled) settings.retryAt = null;
        }
        save();
      });
      if (rows.length < 250) break;
    }
  }
  if (settings.lastRun?.status === 'running') {
    settings.lastRun.status = 'interrupted'; settings.lastRun.finishedAt = new Date(now()).toISOString();
    settings.recoveredAt = new Date(now()).toISOString(); save();
  }
  function reviewRecord(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new MailHarborError('invalid_request');
    const record = index.get('messages', id), account = record && eligibleAccount(record);
    if (!record || !account) throw new MailHarborError('not_found');
    if (labelMovePending(id)) throw new MailHarborError('busy');
    return { record, account };
  }
  async function reviewMessage(id) {
    const { record, account } = reviewRecord(id);
    const controller = new AbortController();
    const result = reader.read ? await reader.read(account, record.reference, { signal: controller.signal, verify: () => verify(account) }) :
      (await reader.readBatch(account, [record.reference], { signal: controller.signal, verify: () => verify(account) })).messages[0];
    verify(account);
    if (!result || result.reference.fingerprint !== record.reference.fingerprint) throw new MailHarborError('stale_message');
    return { subject: record.message?.subject ?? '', author: record.message?.author ?? '', account: account.label,
      date: record.message?.date ?? '', body: String(result.body ?? '').slice(0, 8000), truncated: result.truncated === true,
      bodyUnavailable: result.bodyUnavailable !== false, contentReasons: result.contentReasons ?? [] };
  }
  async function withMailboxWrite(work) {
    if (typeof work !== 'function') throw new MailHarborError('invalid_request');
    if (closed) throw new MailHarborError('cancelled');
    if (ownerMutation) throw new MailHarborError('busy');
    if (fault || index.healthy?.() === false) throw new MailHarborError('configuration_error');
    ownLease();
    ownerMutation = true;
    clearTimeout(timer); timer = null;
    let finished;
    mailboxWriteDone = new Promise(resolve => { finished = resolve; });
    try {
      // Finish and persist the selected classification unit or IMAP batch. The
      // run loop yields before starting another batch; do not cancel its job.
      await active?.promise;
      if (closed) throw new MailHarborError('cancelled');
      if (fault || index.healthy?.() === false) throw new MailHarborError('configuration_error');
      ownLease();
      mailboxWriter = true;
      return await work();
    } finally {
      mailboxWriter = false; ownerMutation = false;
      mailboxWriteDone = null; finished();
      // Read the live settings: a user Pause, quota backoff or pilot limit that
      // arrived while draining must not be undone by an earlier snapshot.
      if (!closed && settings.enabled && settings.providerConsent === true && !fault && index.healthy?.() !== false) {
        const retryAt = Date.parse(settings.retryAt);
        schedule(Number.isFinite(retryAt) ? Math.max(1000, retryAt - now()) : 1000);
      }
    }
  }
  const validCategoryReference = (account, reference) => reference && reference.accountId === account?.id &&
    Number.isSafeInteger(reference.uid) && reference.uid > 0 && reference.uid <= 0xffffffff &&
    typeof reference.uidValidity === 'string' && /^\d{1,20}$/u.test(reference.uidValidity) &&
    typeof reference.path === 'string' && reference.path.length > 0 && reference.path.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(reference.path) &&
    typeof reference.fingerprint === 'string' && /^[a-f0-9]{64}$/u.test(reference.fingerprint);
  const sameCategoryReference = (left, right) => left?.accountId === right.accountId &&
    left.fingerprint === right.fingerprint && locationKey(left) === locationKey(right);
  const categoryDeferred = (record, key) => (ownerMutation && !mailboxWriter) ||
    Boolean(record?.locations.some(location => location.intent)) || invoiceProtected(record ?? { key });
  function categoryMoveDeferred(account, sourceReference) {
    if (ownerMutation && !mailboxWriter) return true;
    if (!validCategoryReference(account, sourceReference)) throw new MailHarborError('stale_message');
    verify(account);
    const key = messageKey(account, sourceReference);
    return categoryDeferred(index.get('messages', key), key);
  }
  function categoryRelocationSource(account, sourceReference) {
    if (!mailboxWriter || active) throw new MailHarborError('busy');
    if (!validCategoryReference(account, sourceReference)) throw new MailHarborError('stale_message');
    verify(account);
    const key = messageKey(account, sourceReference), record = index.get('messages', key);
    if (categoryDeferred(record, key)) throw new MailHarborError('busy');
    // Manually labelled mail may not have been discovered by the organizer.
    if (!record) return { record: null, location: null };
    const locations = record.locations.filter(location => sameCategoryReference(location.reference, sourceReference));
    if (locations.length !== 1) throw new MailHarborError('stale_message');
    const location = locations[0];
    if (location.gmail === true || !['inbox', 'other'].includes(location.role) || location.handled || record.ownerDecision?.action === 'keep') throw new MailHarborError('stale_message');
    return { record, location };
  }
  function canRelocateCategory(account, sourceReference) {
    try { categoryRelocationSource(account, sourceReference); return true; }
    catch (error) {
      if (['busy', 'stale_message'].includes(error.code)) return false;
      throw error;
    }
  }
  function relocateCategory(account, sourceReference, targetReference) {
    return index.transaction(() => {
      const { record, location } = categoryRelocationSource(account, sourceReference);
      if (!validCategoryReference(account, targetReference) || sourceReference.fingerprint !== targetReference.fingerprint) throw new MailHarborError('stale_message');
      if (!record || sameCategoryReference(sourceReference, targetReference)) return { updated: false };
      if (record.locations.some(other => other !== location && other.reference.accountId === targetReference.accountId &&
          locationKey(other.reference) === locationKey(targetReference))) throw new MailHarborError('stale_message');
      location.reference = structuredClone(targetReference);
      location.role = 'other';
      if (sameCategoryReference(record.reference, sourceReference)) {
        record.reference = structuredClone(targetReference);
        record.message = { ...record.message, folderPath: targetReference.path };
      }
      // Keep classification, read state, dates, owner decisions and the original
      // retention deadline. Filing is not a new classification or retention act.
      put(record);
      return { updated: true };
    });
  }
  schedule(1000);
  return {
    status,
    withMailboxWrite,
    categoryMoveDeferred,
    canRelocateCategory,
    relocateCategory,
    reviewMessage,
    reviewList({ category = 'review', after = '' } = {}) {
      if (!['review', 'held', 'failed', 'retry'].includes(category) || (after !== '' && !/^[a-f0-9]{64}$/.test(after))) throw new MailHarborError('invalid_request');
      const rows = index.list('messages', { category, after, limit: 51 });
      return { items: rows.slice(0, 50).filter(row => categoryOf(row.value) === category && eligibleAccount(row.value)).map(({ key, value: record }) => ({
        id: key, account: record.message?.account ?? eligibleAccount(record).label, subject: record.message?.subject ?? '', author: record.message?.author ?? '',
        date: record.message?.date ?? '', category, reasons: record.blockers ?? [], contentReasons: record.contentReasons ?? [], complete: record.complete === true,
        labels: record.classification?.labels ?? [], dates: record.classification?.dates ?? {}, nextAttempt: record.retryAt == null ? null : new Date(record.retryAt).toISOString()
      })), nextAfter: rows.length > 50 ? rows[49].key : null };
    },
    async resolveReview(input) {
      if (!input || Object.keys(input).some(key => !['id', 'action', 'labels', 'dates'].includes(key)) || !['retry', 'keep', 'confirm'].includes(input.action)) throw new MailHarborError('invalid_request');
      // Drain the single writer before changing an owner decision; stale contexts
      // cannot overwrite it or issue a move after the owner chooses Keep.
      if (ownerMutation) throw new MailHarborError('busy');
      reviewRecord(input.id);
      const resume = settings.enabled, epoch = settingsEpoch;
      ownLease();
      ownerMutation = true; settings.enabled = false; clearTimeout(timer);
      try {
        if (active) { active.controller.abort(new MailHarborError('cancelled')); await active.promise; }
        const { record, account } = reviewRecord(input.id); verify(account);
        if (input.action === 'keep') {
          record.ownerDecision = { action: 'keep', at: now() }; record.review = false; record.refreshRequested = false; record.retryAt = null; record.nextAt = null;
        } else if (input.action === 'retry') {
          record.ownerDecision = null; record.classificationError = null; record.readError = null; record.readRetryAt = null;
          record.classificationAttempts = 0; record.readAttempts = 0; record.retryAt = now(); record.nextAt = now();
          record.refreshRequested = Boolean(record.classification);
        } else {
          if (!record.complete || !record.classification || !Array.isArray(input.labels) || input.labels.length > MAIL_CATEGORIES.length || input.labels.some(label => !MAIL_CATEGORIES.some(value => value.id === label))) throw new MailHarborError('invalid_request');
          const live = await reviewMessage(input.id);
          if (live.truncated || live.bodyUnavailable) throw new MailHarborError('stale_message');
          const updated = structuredClone(record.classification);
          updated.labels = [...new Set([...updated.labels, ...input.labels])]; updated.confidence = 1;
          if (input.dates !== undefined) {
            if (!input.dates || Array.isArray(input.dates) || Object.keys(input.dates).some(key => !Object.hasOwn(updated.dates, key))) throw new MailHarborError('invalid_request');
            updated.dates = { ...updated.dates, ...input.dates };
            if (Object.entries(updated.dates).every(([name, date]) => date === null || Object.hasOwn(input.dates, name))) updated.dateConfidence = 1;
          }
          try { validateMailClassification({ items: [updated] }, [record.key], { now: now() }); } catch { throw new MailHarborError('invalid_request'); }
          record.classification = updated; record.ownerDecision = { action: 'confirm', at: now() };
          record.classificationError = null; record.refreshRequested = false; record.retryAt = null; record.review = false; record.nextAt = now();
        }
        index.transaction(() => { put(record); save(); });
      } finally {
        ownerMutation = false;
        if (resume && epoch === settingsEpoch && settings.providerConsent === true && !fault) { settings.enabled = true; save(); schedule(1000); }
      }
      return status();
    },
    appointment(account, reference) {
      const record = index.get('messages', messageKey(account, reference)), value = record?.classification;
      if (!value?.labels.includes('appointments') || value.confidence < .9 || value.dateConfidence < .95 || !record.complete || !value.dates.appointmentStart || !value.dates.appointmentEnd) return null;
      return { start: value.dates.appointmentStart, end: value.dates.appointmentEnd, title: value.appointment?.title || record.message.subject, location: value.appointment?.location || '' };
    },
    async configure(input) {
      ownLease();
      if (active || ownerMutation) throw new MailHarborError('busy');
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['providerConsent', 'tenderGraceMonths', 'tenderGraceDays', 'maxActions', 'maxClassifications'].includes(key)) ||
        (input.maxActions != null && (!Number.isInteger(input.maxActions) || input.maxActions < 0 || input.maxActions > 1000)) ||
        (input.maxClassifications != null && (!Number.isInteger(input.maxClassifications) || input.maxClassifications < 1 || input.maxClassifications > 1000)) ||
        (input.providerConsent !== undefined && typeof input.providerConsent !== 'boolean') ||
        (input.tenderGraceMonths !== undefined && ![null, 2].includes(input.tenderGraceMonths)) ||
        (input.tenderGraceDays !== undefined && ![null, 0, 2].includes(input.tenderGraceDays)) ||
        (input.tenderGraceMonths != null && input.tenderGraceDays != null)) throw new MailHarborError('invalid_request');
      const updated = { ...settings, ...input, consentUpdatedAt: now() };
      if (Object.hasOwn(input, 'maxActions') || Object.hasOwn(input, 'maxClassifications')) updated.pilotCounters = { actionAttempts: 0, classified: 0 };
      settingsEpoch++;
      if (input.tenderGraceMonths != null) updated.tenderGraceDays = null;
      if (input.tenderGraceDays != null) updated.tenderGraceMonths = null;
      if (input.providerConsent === false) updated.enabled = false;
      const policyChanged = updated.tenderGraceMonths !== settings.tenderGraceMonths || updated.tenderGraceDays !== settings.tenderGraceDays;
      index.transaction(() => {
        if (policyChanged) for (const state of ['ready', 'review']) {
          let after = '';
          for (;;) {
            const page = index.list('messages', { state, after, limit: 250 });
            for (const { value: record } of page) if (record.classification) { record.nextAt = now(); put(record); }
            if (page.length < 250) break;
            after = page.at(-1).key;
          }
        }
        index.put('meta', 'processingSettings', updated);
      });
      settings = updated;
      if (!settings.enabled) clearTimeout(timer);
      return status();
    },
    async action(action) {
      ownLease();
      if (!['start', 'pause', 'preview'].includes(action)) throw new MailHarborError('invalid_request');
      if (action === 'pause') {
        settingsEpoch++;
        settings.enabled = false; resumedWork = null; clearTimeout(timer); active?.controller.abort(new MailHarborError('cancelled')); await active?.promise; settings.retryAt = null; settings.pauseReason = null; save(); return status();
      }
      if (active || ownerMutation) throw new MailHarborError('busy');
      settingsEpoch++;
      if (settings.providerConsent !== true) throw new MailHarborError('configuration_error');
      if (fault || index.healthy?.() === false) throw new MailHarborError('configuration_error');
      settings.enabled = true; settings.mode = action === 'preview' ? 'preview' : 'apply';
      if (settings.pauseReason !== 'quota_exhausted') settings.retryAt = null;
      if (action === 'preview') settings.preview = { sampleSize: 0, labels: {}, counts: { archive: 0, trash: 0, markRead: 0, rescue: 0, review: 0 } };
      settings.pauseReason = null; save(); launch().catch(() => {}); return status();
    },
    async drain() { await active?.promise; },
    async close() { closed = true; clearTimeout(timer); clearInterval(leaseTimer); active?.controller.abort(new MailHarborError('cancelled')); try { await active?.promise; await mailboxWriteDone; } finally { index.releaseLease?.('processing', holder); } }
  };
}
