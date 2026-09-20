import { createHash } from 'node:crypto';
import { MailHarborError, safeError } from './validation.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => a && b && ['accountId', 'path', 'uidValidity', 'uid', 'fingerprint'].every(key => a[key] === b[key]);
const email = account => account.email.trim().normalize('NFC').toLowerCase();
const PRIORITY = ['invoices', 'finance', 'security', 'orders', 'appointments', 'tenders', 'work', 'travel', 'jobs', 'development', 'coupons', 'newsletters', 'social'];
const fail = code => { throw new MailHarborError(code); };

export function categoryNames(definitions) {
  const names = definitions.map(tag => ({ ...tag, name: tag.label.normalize('NFC').replace(/[\\/:*%?"<>|\u0000-\u001f\u007f]/gu, '–').trim().slice(0, 80) || 'Label' }));
  return new Map(names.map(tag => [tag.id, `MailHarbor/${tag.name}${names.some(other => other.id !== tag.id && other.name.toLowerCase() === tag.name.toLowerCase()) ? ` (${tag.id.slice(-8)})` : ''}`]));
}

export function primaryCategory(value, definitions) {
  const allowed = new Set(definitions.map(tag => tag.id));
  const effective = (value.tags ?? []).filter(id => allowed.has(id));
  const manual = effective.filter(id => value.manual?.includes(id));
  const choices = manual.length ? manual : effective;
  return [...choices].sort((a, b) => {
    const rank = id => id.startsWith('custom_') ? -1 : PRIORITY.indexOf(id) < 0 ? 100 : PRIORITY.indexOf(id);
    return rank(a) - rank(b) || a.localeCompare(b);
  })[0] ?? null;
}

/** Durable forward synchronization. Original messages are never copied. */
export function createMailLabelSync({ index, accounts, tags, processing, reader, now = Date.now, autoSchedule = true, intervalMs = 10000, changed = () => {} }) {
  let closed = false, pending = null, timer = null, scanAfter = '', scanComplete = false, definitionsHash = '', checkedAt = null;
  const controller = new AbortController();
  const save = (key, value) => index.put('labelSync', key, value, { state: value.state, due: value.retryAt ?? null, owner: value.accountId });
  function desired(value) {
    const definitions = tags.definitions(), names = categoryNames(definitions);
    const labels = value.deleted ? [] : (value.tags ?? []).filter(id => names.has(id)).map(id => names.get(id)).sort();
    const primary = value.deleted ? null : names.get(primaryCategory(value, definitions)) ?? null;
    return { labels, primaryLabel: primary, desiredHash: hash([value.accountId, value.email, labels, primary, Boolean(value.deleted)]) };
  }
  function queue(key, value) {
    const next = desired(value), old = index.get('labelSync', key);
    if (old?.desiredHash === next.desiredHash && (old.state === 'synced' || same(old.reference, value.reference))) return;
    save(key, { ...old, ...next, accountId: value.accountId, email: value.email, reference: old?.intent?.source ?? value.reference,
      message: { messageId: value.message?.messageId ?? '' }, generation: (old?.generation ?? 0) + 1,
      managedLabels: old?.managedLabels ?? [], attempts: 0, error: null,
      state: !old?.intent && (value.deleted || !next.labels.length && !old?.managedLabels?.length) ? 'skipped' : 'pending', retryAt: now() });
  }
  const unsubscribe = index.onTagChange?.(queue);
  function scan() {
    const nextHash = hash(tags.definitions());
    if (nextHash !== definitionsHash) { definitionsHash = nextHash; scanAfter = ''; scanComplete = false; }
    if (scanComplete) return;
    const entries = index.list('tags', { after: scanAfter, limit: 500 });
    index.transaction(() => { for (const { key, value } of entries) queue(key, value); });
    scanAfter = entries.at(-1)?.key ?? scanAfter;
    scanComplete = entries.length < 500;
  }
  function currentAccount(job) {
    const account = accounts.get(job.accountId);
    if (email(account) !== job.email) fail('stale_message');
    return account;
  }
  function eligible(job) {
    const record = index.get('messages', job.key);
    if (record?.locations?.some(location => location.intent)) return false;
    return true;
  }
  function status() {
    const states = Object.fromEntries(['pending', 'synced', 'protected', 'skipped', 'error', 'needs_review'].map(state => [state, index.count('labelSync', state)]));
    return { running: Boolean(pending), checkedAt, backfillComplete: scanComplete, pending: states.pending + states.error,
      synced: states.synced, protected: states.protected, skipped: states.skipped, failed: states.needs_review,
      mode: 'gmail_labels_primary_folders', errors: index.list('labelSync', { state: 'needs_review', limit: 4 }).map(({ value }) => ({ accountId: value.accountId, code: value.error || 'mailbox_error' })) };
  }
  function schedule(delay = intervalMs) {
    clearTimeout(timer);
    if (autoSchedule && !closed) { timer = setTimeout(() => { void poll().catch(() => {}); }, delay); timer.unref?.(); }
  }
  async function poll() {
    if (closed) return status();
    if (pending) return pending;
    pending = (async () => {
      scan();
      const due = [...index.list('labelSync', { state: 'pending', before: now(), order: 'due', limit: 100 }), ...index.list('labelSync', { state: 'error', before: now(), order: 'due', limit: 25 })];
      // Organizer MOVE journals and invoice filing must finish before category
      // moves. Check those holds without interrupting the organizer; recheck
      // inside the writer below before issuing any provider mutation.
      const rows = due.filter(({ key, value }) => {
        const job = { ...value, key };
        try {
          const account = currentAccount(job);
          if (!eligible(job) || (account.provider !== 'google' && processing.categoryMoveDeferred?.(account, job.reference))) {
            save(key, { ...value, retryAt: now() + 30000 }); return false;
          }
          return true;
        } catch (error) {
          if (['busy', 'cancelled'].includes(error?.code)) save(key, { ...value, retryAt: now() + 30000 });
          else failure(job, error);
          return false;
        }
      });
      if (!rows.length) return;
      await processing.withMailboxWrite(async () => {
        const groups = new Map();
        for (const { key } of rows) {
          const saved = index.get('labelSync', key), job = { ...saved, key };
          if (!saved || !['pending', 'error'].includes(saved.state) || saved.retryAt > now()) continue;
          if (!eligible(job)) {
            // Organizer recovery can remain paused indefinitely. Let other due
            // messages advance instead of selecting these same keys every poll.
            save(key, { ...saved, retryAt: now() + 30000 }); continue;
          }
          try {
            const account = currentAccount(job);
            if (account.provider !== 'google' && processing.categoryMoveDeferred?.(account, job.reference)) {
              save(key, { ...saved, retryAt: now() + 30000 }); continue;
            }
            if (account.provider !== 'google' && !job.intent && !processing.canRelocateCategory(account, job.reference)) {
              save(key, { ...saved, state: 'protected', error: null }); continue;
            }
          } catch (error) { failure(job, error); continue; }
          const group = groups.get(job.accountId) ?? [];
          if (group.length < 25) { group.push(job); groups.set(job.accountId, group); }
        }
        for (const jobs of groups.values()) {
          if (closed) return;
          let account;
          try { account = currentAccount(jobs[0]); }
          catch (error) { for (const job of jobs) failure(job, error); continue; }
          if (account.provider === 'google') index.transaction(() => {
            // A STORE can succeed before its reply is lost or a newer tag edit
            // revokes this generation. Remember all possibly applied owned names.
            for (const job of jobs) {
              const latest = index.get('labelSync', job.key);
              if (latest?.generation !== job.generation) continue;
              const managedLabels = [...new Set([...latest.managedLabels, ...job.labels])];
              save(job.key, { ...latest, managedLabels }); job.managedLabels = managedLabels;
            }
          });
          const verify = async entry => {
            if (closed || controller.signal.aborted) fail('cancelled');
            const current = currentAccount(jobs[0]);
            if (current.revision !== account.revision) fail('stale_message');
            if (entry) {
              const job = jobs.find(job => job.key === entry.key), latest = index.get('labelSync', entry.key);
              if (!job || latest?.generation !== job.generation || !eligible(job)) fail('stale_message');
              if (account.provider !== 'google' && !processing.canRelocateCategory(account, entry.reference)) fail('stale_message');
            }
          };
          try {
            const result = await reader.sync(account, jobs, { signal: controller.signal, verify,
              beforeMove: async (entry, intent) => {
                await verify(entry);
                const value = index.get('labelSync', entry.key);
                save(entry.key, { ...value, intent });
              },
              onResult: async (entry, result) => {
                const current = currentAccount(entry);
                if (current.revision !== account.revision || closed) fail('stale_message');
                index.transaction(() => {
                  const latest = index.get('labelSync', entry.key), value = index.get('tags', entry.key);
                  if (!latest || !value || value.email !== entry.email) fail('stale_message');
                  if (result.moved) processing.relocateCategory(account, entry.intent?.source ?? entry.reference, result.reference);
                  if (result.reference && same(value.reference, entry.reference)) {
                    index.putTag(entry.key, { ...value, reference: result.reference,
                      message: { ...value.message, folderPath: result.reference.path }, updatedAt: now() });
                  }
                  const after = index.get('labelSync', entry.key), wanted = desired(index.get('tags', entry.key));
                  const retiredReferences = (latest.retiredReferences ?? []).filter(item => item.retiredAt > now() - 15 * 60000);
                  if (result.moved) retiredReferences.push({ reference: entry.intent?.source ?? entry.reference, retiredAt: now() });
                  save(entry.key, { ...after, managedLabels: result.managedLabels ?? after.managedLabels,
                    retiredReferences,
                    reference: index.get('tags', entry.key).reference, intent: null, attempts: 0, error: null,
                    appliedHash: entry.desiredHash,
                    state: wanted.desiredHash === entry.desiredHash && !result.needsSync ? result.status : 'pending', retryAt: now() });
                });
                changed(account.id);
              }
            });
            for (const item of result.results ?? []) if (item.error) failure(jobs.find(job => job.key === item.key), item.error);
          } catch (error) { for (const job of jobs) failure(job, error); }
        }
      });
      checkedAt = new Date(now()).toISOString();
    })().finally(() => { pending = null; schedule(); });
    await pending;
    return status();
  }
  function failure(job, error) {
    if (!job || closed) return;
    const latest = index.get('labelSync', job.key);
    if (!latest || latest.generation !== job.generation || ['synced', 'protected', 'skipped'].includes(latest.state)) return;
    const code = safeError(error).code, attempts = (latest.attempts ?? 0) + 1;
    save(job.key, { ...latest, attempts, error: code, state: attempts >= 3 ? 'needs_review' : 'error', retryAt: now() + 30000 * attempts });
  }
  schedule(5000);
  return {
    status, poll,
    request() {
      scanAfter = ''; scanComplete = false;
      for (const { key, value } of index.list('labelSync', { state: 'needs_review', limit: 100 })) save(key, { ...value, state: 'pending', attempts: 0, retryAt: now(), error: null });
      void poll().catch(() => {}); return status();
    },
    async close() { closed = true; clearTimeout(timer); unsubscribe?.(); controller.abort(new MailHarborError('cancelled')); await pending?.catch(() => {}); }
  };
}
