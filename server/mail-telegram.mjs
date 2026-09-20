import { randomBytes } from 'node:crypto';
import { MailHarborError } from './validation.mjs';
import { assessInquiry, eligibleInquiry, inquiryText, normalizeFormTrust, INQUIRY_POLICY_VERSION } from './mail-inquiry-policy.mjs';
import { createTelegramSender, formatInquiryNotification } from './telegram.mjs';

const POLICY = INQUIRY_POLICY_VERSION;
const DAY = 86400000;
const STATES = ['capture', 'pending', 'summarizing', 'ready', 'sending', 'retry', 'sent', 'skipped', 'held'];
const clean = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, max);
const fail = (code = 'invalid_request') => { throw new MailHarborError(code); };
const safeCode = error => /^[a-z_]{1,64}$/u.test(error?.code ?? '') ? error.code : 'notification_unavailable';
const initial = () => ({ enabled: false, accountId: '', formTrust: null, language: 'en', threshold: .9, generation: 0, verified: false });
const sameAccount = (a, b) => a && b && a.id === b.id && a.email === b.email && a.host === b.host && a.revision === b.revision;
const metadata = (m, a) => ({ author: clean(m.author), subject: clean(m.subject), to: clean(m.to), date: clean(m.date, 80),
  receivedAt: clean(m.receivedAt || m.internalDate || m.date, 80), account: clean(a.label || a.email || a.id) });

/** Durable arrival/classification/delivery worker. Only its narrow transport can send. */
export function createMailTelegram({ store, state, accounts, reader, jobs, origin,
  sender = createTelegramSender(), now = Date.now, autoSchedule = true, intervalMs = 60000,
  jobPollMs = 100, summarize } = {}) {
  const holder = randomBytes(18).toString('hex');
  const controller = new AbortController();
  const taskOwner = `mail-telegram-${holder}`;
  let closed = false, configuring = false, configuringAccountId = null, settingsChain = Promise.resolve(), scanChain = Promise.resolve();
  let workPromise = null, scanPromise = null, activeJob = null, timer = null, leaseTimer = null;
  const active = new Set();
  const settings = () => ({ ...initial(), ...(store.read().mailTelegram ?? {}) });
  const ownerKey = a => state.token(`owner:${a.id}:${a.email.toLowerCase()}:${a.host}`);
  const cursorKey = a => state.token(`cursor:${ownerKey(a)}:INBOX`);
  const itemKey = (a, ref) => state.token(`message:${ownerKey(a)}:${ref.fingerprint}`);
  const trustKey = s => state.token(`form-trust:${JSON.stringify(s.formTrust ?? null)}`);
  const destination = s => state.token(`destination:${s.botId}:${s.chatId}`);
  const errorState = (error, retryAt = null) => ({ code: safeCode(error), ...(retryAt ? { retryAt } : {}) });
  const meta = () => state.get('meta', 'status') ?? {};
  const saveMeta = change => state.put('meta', 'status', { ...meta(), ...change });
  function lease() {
    if (closed || !state.healthy()) fail('notification_unavailable');
    if (!state.claimLease('telegram', holder, now(), 300000)) fail('busy');
  }
  function account(config = settings()) {
    if (!config.accountId) fail('mailbox_login_required');
    const a = accounts.get(config.accountId);
    if (!a || a.id !== config.accountId || a.connected === false || typeof a.email !== 'string' || !a.email || !a.host) fail('mailbox_login_required');
    return a;
  }
  function current(a, s, { enabled = true } = {}) {
    if (closed || controller.signal.aborted) fail('cancelled');
    const config = settings(), live = account(config);
    if (!sameAccount(a, live) || config.generation !== s.generation || (enabled && !config.enabled) ||
        config.chatId !== s.chatId || config.botId !== s.botId || configuring) fail('stale_message');
    lease();
    return true;
  }
  function put(value) {
    lease();
    state.put('candidates', value.key, value, { state: value.state, due: value.nextAt ?? null, owner: value.owner });
    return value;
  }
  function update(key, change) {
    const value = state.get('candidates', key);
    if (!value) return null;
    return put({ ...value, ...(typeof change === 'function' ? change(value) : change), updatedAt: now() });
  }
  function rowEligible(row, a, s) {
    return row.owner === ownerKey(a) && row.revision === a.revision && row.destination === destination(s) && row.formTrustKey === trustKey(s);
  }
  function tracked(promise) {
    active.add(promise); promise.finally(() => active.delete(promise)).catch(() => {}); return promise;
  }
  function scanLock(work) {
    const next = scanChain.then(work);
    scanChain = next.catch(() => {});
    return tracked(next);
  }
  async function baseline(a, s, enabling = false) {
    lease();
    const key = cursorKey(a), saved = state.get('cursors', key);
    if (saved?.revision === a.revision) return saved;
    const point = await reader.checkpoint(a, { signal: controller.signal,
      verify: () => enabling ? !closed && sameAccount(a, account(s)) : current(a, s) });
    if (enabling) { if (closed || !sameAccount(a, account(s))) fail('stale_message'); lease(); }
    else current(a, s);
    // A credential/archive setting revision must not strand the arrival cursor.
    // Retain its position; scanPage reconciles a changed mailbox identity below.
    const value = saved ? { ...saved, revision: a.revision } : { ...point, enabledAt: now(), revision: a.revision };
    state.put('cursors', key, value);
    if (saved) saveMeta({ recovery: { code: 'account_revision_changed', at: now() } });
    return value;
  }
  function enqueue(a, s, m, enabledAt) {
    const key = itemKey(a, m.reference);
    // Restoring an old message into Inbox must not turn it into a new lead.
    const received = Date.parse(m.receivedAt || m.internalDate || '');
    if (Number.isFinite(received) && received < enabledAt - 2000) { state.put('seen', key, { at: now() }); return; }
    if (state.get('seen', key)) return;
    const old = state.get('candidates', key);
    if (old) return;
    put({ key, owner: ownerKey(a), accountId: a.id, revision: a.revision, reference: m.reference,
      destination: destination(s), formTrustKey: trustKey(s), generation: s.generation, policy: POLICY,
      message: metadata(m, a), state: 'capture', createdAt: now(), updatedAt: now(), nextAt: now(),
      attempts: 0, sendAttempts: 0, decision: null });
  }
  async function capture(key, a, s) {
    let row = state.get('candidates', key);
    if (!row || row.state !== 'capture') return;
    if (!rowEligible(row, a, s)) { update(key, { state: 'held', reason: 'account_or_destination_changed', nextAt: null }); return; }
    try {
      current(a, s);
      const m = await reader.readNotification(a, row.reference, { signal: controller.signal, verify: () => current(a, s) });
      current(a, s);
      const input = { id: key, ...metadata(m, a), body: String(m.body ?? '').slice(0, 8000), headers: String(m.headers ?? '').slice(0, 32768),
        truncated: m.truncated === true, bodyUnavailable: m.bodyUnavailable === true };
      const preflight = assessInquiry(input, { formTrust: s.formTrust });
      if (preflight.action !== 'classify') {
        update(key, { message: metadata(m, a), preflight, state: preflight.action === 'skip' ? 'skipped' : 'held',
          decision: preflight.action === 'skip' ? 'skipped' : 'held', reason: preflight.reason, input: null, nextAt: null });
      } else {
        input.body = inquiryText(input.body);
        update(key, { message: metadata(m, a), input, preflight, state: 'pending', attempts: 0, nextAt: now() });
      }
    } catch (error) {
      if (closed || !settings().enabled || configuring) throw error;
      const attempts = (state.get('candidates', key)?.attempts ?? 0) + 1;
      update(key, { attempts, state: attempts >= 3 ? 'held' : 'capture', reason: safeCode(error),
        nextAt: attempts >= 3 ? null : now() + Math.min(15 * 60000, attempts * 60000) });
    }
  }
  async function scanPage(a, s) {
    const saved = await baseline(a, s);
    if (saved.revision !== a.revision) {
      saveMeta({ error: { code: 'stale_message' } }); return false;
    }
    try {
      const page = await reader.scan(a, { path: 'INBOX', uidValidity: saved.uidValidity, afterUid: saved.afterUid,
        limit: 100, signal: controller.signal, verify: () => current(a, s) });
      current(a, s);
      state.transaction(() => {
        for (const m of page.messages) enqueue(a, s, m, saved.enabledAt);
        state.put('cursors', cursorKey(a), { ...saved, uidValidity: page.uidValidity, afterUid: page.afterUid });
        saveMeta({ lastScanAt: now(), error: null });
      });
      return !page.done;
    } catch (error) {
      if (error.code === 'stale_message') {
        current(a, s);
        const point = await reader.checkpoint(a, { signal: controller.signal, verify: () => current(a, s) });
        current(a, s);
        if (point.uidValidity !== saved.uidValidity || point.afterUid < saved.afterUid) {
          // Inspect at most 1,000 recent UIDs. Unknown recent identities require
          // review: a reset cannot prove these are new arrivals rather than copies.
          let position = Math.max(0, point.afterUid - 1000);
          const recent = [], since = Math.max(saved.enabledAt, (meta().lastScanAt ?? saved.enabledAt) - 300000);
          for (let page = 0; page < 10 && position < point.afterUid; page++) {
            const found = await reader.scan(a, { path: 'INBOX', uidValidity: point.uidValidity, afterUid: position,
              highWatermark: point.afterUid, limit: 100, signal: controller.signal, verify: () => current(a, s) });
            current(a, s);
            recent.push(...found.messages.filter(m => Date.parse(m.receivedAt || m.internalDate || '') >= since));
            if (found.afterUid <= position) fail('notification_unavailable');
            position = found.afterUid;
            if (found.done) break;
          }
          state.transaction(() => {
            for (const m of recent) {
              const key = itemKey(a, m.reference);
              if (state.get('candidates', key) || state.get('seen', key)) continue;
              enqueue(a, s, m, saved.enabledAt);
              update(key, { state: 'held', decision: 'held', reason: 'mailbox_identity_reset', nextAt: null });
            }
            state.put('cursors', cursorKey(a), { ...point, enabledAt: saved.enabledAt, revision: a.revision, reconciledAt: now() });
            saveMeta({ lastScanAt: now(), recovery: { code: 'mailbox_identity_reset', at: now(), inspected: recent.length,
              bounded: point.afterUid > 1000 } });
          });
          return false;
        }
      }
      throw error;
    }
  }
  async function scanNow() {
    return scanLock(async () => {
      const s = settings();
      if (!s.enabled || !s.verified || closed || configuring) return;
      const a = account();
      lease();
      // A bounded cycle keeps provider work fair; durable cursors drain later pages.
      for (let page = 0; page < 10; page++) if (!await scanPage(a, s)) break;
      for (const { key } of state.list('candidates', { state: 'capture', before: now(), owner: ownerKey(a), limit: 100 })) {
        current(a, s); await capture(key, a, s);
      }
    });
  }
  async function runSummary(request, a, s) {
    current(a, s);
    if (summarize) return summarize(request, controller.signal);
    const submitted = await jobs.submit(request, taskOwner, 'notification-summary', { beforeRun: () => current(a, s) });
    activeJob = submitted.id;
    try {
      while (!closed && !controller.signal.aborted) {
        const result = jobs.get(submitted.id, taskOwner);
        if (result.status === 'completed') return result.result;
        if (result.status === 'failed') throw Object.assign(new Error('Summary unavailable'), result.error);
        if (result.status === 'cancelled') fail('cancelled');
        await new Promise(resolve => setTimeout(resolve, jobPollMs));
      }
      fail('cancelled');
    } finally {
      try { if (closed) jobs.cancel(submitted.id, taskOwner); jobs.release(submitted.id, taskOwner); } catch {}
      activeJob = null;
    }
  }
  async function classify(row, a, s) {
    if (!row.input) { update(row.key, { state: 'capture', nextAt: now() }); return; }
    current(a, s);
    update(row.key, { state: 'summarizing', nextAt: now() });
    try {
      const request = { language: s.language, messages: [{ id: row.key, author: row.input.author, subject: row.input.subject,
        to: row.input.to, date: row.input.date, body: row.input.body, truncated: row.input.truncated,
        bodyUnavailable: row.input.bodyUnavailable, source: row.preflight.source }] };
      const result = (await runSummary(request, a, s)).items[0];
      current(a, s);
      const eligibility = eligibleInquiry(row.input, row.preflight, result, { threshold: s.threshold });
      const next = { result, policy: POLICY, decision: eligibility.decision, reason: eligibility.reason,
        state: eligibility.decision === 'eligible' ? 'ready' : eligibility.decision, input: null, nextAt: null, attempts: 0 };
      if (eligibility.decision === 'eligible') {
        next.text = formatInquiryNotification({ ...row.message, ...row.preflight }, result,
          { origin, source: row.preflight.source, reference: row.key.slice(0, 10), language: s.language });
        next.nextAt = now();
      }
      update(row.key, next);
    } catch (error) {
      if (closed) return;
      const latest = settings();
      const attempts = row.attempts + 1, code = safeCode(error);
      const paused = ['busy', 'quota_exhausted', 'login_required', 'configuration_error'].includes(code);
      const parsedRetry = typeof error.retryAt === 'string' ? Date.parse(error.retryAt) : error.retryAt;
      const retryAt = Number.isFinite(parsedRetry) ? parsedRetry : now() + (paused ? 15 * 60000 : Math.min(15 * 60000, attempts * 60000));
      let staleIdentity = false;
      try { staleIdentity = !sameAccount(a, account()) || !rowEligible(row, a, latest); } catch { staleIdentity = true; }
      update(row.key, { state: staleIdentity ? 'held' : (!paused && code !== 'stale_message' && attempts >= 3 ? 'held' : 'pending'),
        attempts: paused ? row.attempts : attempts, reason: code,
        nextAt: staleIdentity || (!paused && code !== 'stale_message' && attempts >= 3) ? null : retryAt });
      if (latest.enabled && !configuring) saveMeta({ error: errorState(error, retryAt) });
    }
  }
  async function deliver(row, a, s) {
    if (row.decision !== 'eligible' || row.policy !== POLICY || !row.text || !rowEligible(row, a, s)) {
      update(row.key, { state: 'held', reason: 'eligibility_recheck_required', nextAt: null }); return;
    }
    current(a, s);
    update(row.key, { state: 'sending', sendAttempts: row.sendAttempts + 1, nextAt: now() });
    try {
      current(a, s);
      const ack = await sender.send({ token: s.token, chatId: s.chatId, text: row.text, signal: controller.signal,
        beforeSend: () => current(a, s) });
      // Persist a received acknowledgement even if pause occurred during HTTP.
      if (!state.healthy()) fail('notification_unavailable');
      const saved = state.get('candidates', row.key);
      state.put('candidates', row.key, { ...saved, state: 'sent', messageId: ack.messageId, sentAt: now(), updatedAt: now(), nextAt: null },
        { state: 'sent', owner: row.owner });
      saveMeta({ lastDeliveryAt: now(), error: null });
    } catch (error) {
      if (closed) return; // 'sending' recovers as uncertain on next start.
      const attempts = row.sendAttempts + 1, code = safeCode(error);
      const blocked = /unauthorized|authentication_failed|forbidden|invalid_chat|invalid_token|configuration|rejected/u.test(code);
      const retryAt = now() + Math.max(Number(error.retryAfterMs) || 0, Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7)));
      update(row.key, { state: blocked || attempts >= 8 ? 'held' : 'retry', reason: code,
        uncertain: error.uncertain === true, nextAt: blocked || attempts >= 8 ? null : retryAt });
      saveMeta({ error: errorState(error, blocked ? null : retryAt) });
    }
  }
  function recover() {
    lease();
    for (const name of ['summarizing', 'sending']) {
      for (const { key, value } of state.list('candidates', { state: name, limit: 1000 })) {
        update(key, { state: name === 'sending' ? 'retry' : 'pending', uncertain: name === 'sending' || value.uncertain,
          reason: name === 'sending' ? 'delivery_uncertain' : 'interrupted', nextAt: now() + (name === 'sending' ? 60000 : 0) });
      }
    }
  }
  function prune() {
    lease();
    const previous = meta().prunedThrough ?? '';
    const rows = state.list('candidates', { after: previous, limit: 100 });
    for (const { key, value: row } of rows) {
      if (row.input && row.createdAt < now() - 7 * DAY) update(key, { input: null, state: 'held', reason: 'content_expired', nextAt: null });
      if (['sent', 'skipped', 'held'].includes(row.state) && row.updatedAt < now() - 7 * DAY && (row.result || row.text)) update(key, { result: null, text: null });
      if (['sent', 'skipped', 'held'].includes(row.state) && row.createdAt < now() - 90 * DAY) {
        state.transaction(() => { state.put('seen', key, { at: now() }); state.remove('candidates', key); });
      }
    }
    saveMeta({ prunedThrough: rows.length === 100 ? rows.at(-1).key : '' });
  }
  async function work() {
    if (closed || configuring) return;
    const s = settings(); if (!s.enabled || !s.verified) return;
    lease(); const a = account(); prune();
    for (let count = 0; count < 10; count++) {
      current(a, s);
      const ready = ['ready', 'retry', 'pending'].flatMap(name => state.list('candidates', { state: name, before: now(), limit: 1 }));
      const row = ready[0]?.value;
      if (!row) break;
      if (!rowEligible(row, a, s)) { update(row.key, { state: 'held', reason: 'account_or_destination_changed', nextAt: null }); continue; }
      if (row.state === 'pending') await classify(row, a, s);
      else await deliver(row, a, s);
    }
  }
  function kick() {
    if (closed || configuring || !settings().enabled) return;
    if (!scanPromise) {
      scanPromise = scanNow().catch(error => { if (!closed) { try { saveMeta({ error: errorState(error) }); } catch {} } })
        .finally(() => { scanPromise = null; startWork(); });
    }
    startWork();
  }
  function startWork() {
    if (!workPromise && !closed && !configuring && settings().enabled) {
      workPromise = tracked(work()).catch(error => { if (!closed) { try { saveMeta({ error: errorState(error) }); } catch {} } })
        .finally(() => { workPromise = null; });
    }
  }
  function publicStatus() {
    const s = settings(), m = meta();
    const counts = Object.fromEntries(STATES.map(name => [name, state.count('candidates', name)]));
    const review = state.list('candidates', { state: 'held', limit: 30 }).map(({ key, value }) =>
      ({ id: key, ...value.message, reason: clean(value.reason, 80) }));
    return { enabled: s.enabled, configured: !!s.token && !!s.chatId, verified: s.verified,
      accountId: s.accountId, formTrust: s.formTrust,
      availableAccounts: (accounts.list?.() ?? []).filter(a => a.connected !== false).map(a => ({ id: a.id, label: a.label || a.email, email: a.email })),
      language: s.language, threshold: s.threshold, generation: s.generation,
      chatIdMasked: s.chatId ? `…${String(s.chatId).slice(-4)}` : '', destinationLabel: clean(s.destinationLabel),
      counts: { pending: counts.capture + counts.pending + counts.summarizing + counts.ready + counts.retry + counts.sending,
        eligible: counts.ready + counts.retry + counts.sending, skipped: counts.skipped, held: counts.held, sent: counts.sent },
      lastScanAt: m.lastScanAt ?? null, lastDeliveryAt: m.lastDeliveryAt ?? null,
      error: m.error ?? null, recovery: m.recovery ?? null, review, busy: !!workPromise || !!scanPromise || configuring };
  }
  async function configureNow(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['enabled', 'language', 'token', 'chatId', 'accountId', 'formTrust'].includes(k))) fail();
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail();
    if (input.language !== undefined && !['nl-BE', 'nl', 'en'].includes(input.language)) fail();
    if (input.token !== undefined && (typeof input.token !== 'string' || !/^\d{5,20}:[A-Za-z0-9_-]{20,120}$/u.test(input.token))) fail();
    if (input.chatId !== undefined && (typeof input.chatId !== 'string' || !/^[1-9]\d{0,18}$/u.test(input.chatId))) fail();
    if (input.accountId !== undefined && (typeof input.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(input.accountId))) fail();
    if (input.accountId !== undefined) account({ accountId: input.accountId });
    if (input.formTrust !== undefined) {
      try { input = { ...input, formTrust: normalizeFormTrust(input.formTrust) }; } catch { fail(); }
    }
    lease(); configuring = true;
    try {
      const old = settings(), next = { ...old, ...input, generation: old.generation + 1 };
      configuringAccountId = next.accountId;
      if (input.token !== undefined || input.chatId !== undefined) {
        if (!next.token || !next.chatId) fail('telegram_not_configured');
        const verified = await sender.verify({ token: next.token, chatId: next.chatId, signal: controller.signal });
        next.verified = true; next.botId = verified.botId; next.chatId = String(verified.chatId ?? next.chatId);
        next.destinationLabel = clean(verified.label || 'Private Telegram chat');
      }
      if (next.enabled) {
        if (!next.verified || !next.token || !next.chatId) fail('telegram_not_configured');
        const a = account(next); await scanLock(() => baseline(a, next, true));
      }
      if (closed) fail('cancelled');
      await store.update(data => { data.mailTelegram = next; });
      // Destination/account changes never redirect old pending summaries.
      saveMeta({ error: null });
      return publicStatus();
    } finally { configuring = false; configuringAccountId = null; if (autoSchedule) queueMicrotask(kick); }
  }
  async function beforeMutation(a, change = {}) {
    const s = settings();
    if ((a.id !== s.accountId && a.id !== configuringAccountId) || !['move', 'moveBatch', 'label_sync', 'apply', 'briefing_apply'].includes(change.reason)) return;
    if (['mark_read', 'mark_unread', 'star', 'unstar'].includes(change.action)) return;
    const changedInbox = (change.references ?? []).filter(ref => ref.accountId === a.id && String(ref.path).toUpperCase() === 'INBOX');
    if (!changedInbox.length) return;
    if (configuring) fail('busy');
    if (!s.enabled) return;
    if (closed) fail('cancelled');
    return scanLock(async () => {
      current(a, s);
      const saved = await baseline(a, s);
      if (saved.revision !== a.revision) fail('stale_message');
      const refs = changedInbox.filter(ref => ref.uidValidity === saved.uidValidity);
      // Scan before mutation, so references are captured without relying on UI tokens.
      let remaining = false;
      for (let i = 0; i < 10; i++) { remaining = await scanPage(a, s); if (!remaining) break; }
      if (remaining) fail('notification_unavailable');
      for (const ref of refs) {
        if (ref.uid > saved.afterUid && !state.get('candidates', itemKey(a, ref)) && !state.get('seen', itemKey(a, ref))) fail('notification_unavailable');
        const candidate = state.get('candidates', itemKey(a, ref));
        if (candidate?.state === 'held' && !candidate.decision) fail('notification_unavailable');
      }
      for (const ref of refs) {
        const key = itemKey(a, ref), value = state.get('candidates', key);
        if (!value || value.state !== 'capture') continue;
        await capture(key, a, s);
        // A move must not outrun the bounded payload capture. Classification failure later is harmless here.
        if (!['pending', 'skipped', 'held', 'ready', 'sent'].includes(state.get('candidates', key)?.state) ||
            (state.get('candidates', key)?.state === 'held' && !state.get('candidates', key)?.decision)) fail('notification_unavailable');
      }
    });
  }
  try { recover(); } catch (error) { if (error.code !== 'busy') throw error; }
  if (autoSchedule) {
    timer = setInterval(kick, intervalMs); timer.unref?.();
    leaseTimer = setInterval(() => { if (!closed && (settings().enabled || active.size)) { try { lease(); } catch {} } }, 30000); leaseTimer.unref?.();
    queueMicrotask(kick);
  }
  return {
    settings: publicStatus,
    configure(input) { const p = settingsChain.then(() => configureNow(input)); settingsChain = p.catch(() => {}); return tracked(p); },
    async test(input = {}) {
      if (!input || Object.keys(input).length) fail();
      const s = settings(); if (!s.verified) fail('telegram_not_configured');
      const a = account(); current(a, s, { enabled: false });
      const ack = await tracked(sender.send({ token: s.token, chatId: s.chatId,
        text: 'MailHarbor — testbericht. Meldingen voor websiteaanvragen en directe zakelijke vragen zijn verbonden.', signal: controller.signal,
        beforeSend: () => current(a, s, { enabled: false }) }));
      return { sent: true, messageId: ack.messageId };
    },
    async retry(input = {}) {
      if (!input || Object.keys(input).some(k => k !== 'id') || !/^[a-f0-9]{64}$/u.test(input.id ?? '')) fail();
      lease(); const a = account(), s = settings(), row = state.get('candidates', input.id);
      if (!row || row.state !== 'held' || !rowEligible(row, a, s)) fail('stale_message');
      update(row.key, { state: row.input ? 'pending' : 'capture', attempts: 0, reason: null, nextAt: now() });
      if (autoSchedule) kick(); return publicStatus();
    },
    scan: scanNow,
    work() {
      if (!workPromise) workPromise = tracked(work()).finally(() => { workPromise = null; });
      return workPromise;
    },
    beforeMutation, kick,
    async close() {
      if (closed) return;
      closed = true; clearInterval(timer); clearInterval(leaseTimer); controller.abort();
      if (activeJob) { try { jobs.cancel(activeJob, taskOwner); } catch {} }
      await Promise.allSettled([...active, settingsChain, scanChain, workPromise, scanPromise].filter(Boolean));
      state.releaseLease('telegram', holder); state.close();
    }
  };
}
