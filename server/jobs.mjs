import { randomBytes } from 'node:crypto';
import { validateProfile } from './profile.mjs';
import { runAgy } from './runner.mjs';
import { runMailClassifier, validateClassificationRequest, classificationResult, CLASSIFIER_VERSION, SCHEMA_VERSION } from './mail-classifier.mjs';
import { runNotificationSummary, validateNotificationSummaryRequest, notificationSummaryResult } from './mail-notification-summary.mjs';
import { createCooldown } from './cooldown.mjs';
import { MODEL, VERSION, MAX_REQUEST_BYTES, MailHarborError, errorMessages, safeError, validateRequest, validateResult } from './validation.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled']);

/** One bounded Agy queue shared by every HTTP interface. Owners are server-assigned. */
export function createJobs(config, runner = runAgy, { classificationRunner = runMailClassifier, notificationSummaryRunner = runNotificationSummary } = {}) {
  if (config.model !== undefined && config.model !== MODEL) throw new MailHarborError('configuration_error');
  const timeoutMs = Math.min(120000, Math.max(10, config.timeoutMs ?? 120000));
  const retentionMs = Math.min(900000, Math.max(10, config.retentionMs ?? 900000));
  if (!Number.isFinite(timeoutMs) || !Number.isFinite(retentionMs)) throw new MailHarborError('configuration_error');
  const cooldown = createCooldown(config);
  const jobs = new Map();
  let active = null;
  let closed = false;
  let closing = null;
  let pausedCode = null;
  let notificationStreak = 0;

  function assertOpen() { if (closed) throw new MailHarborError('busy'); }
  function snapshot(job) {
    return { id: job.id, status: job.status, ...(job.result ? { result: structuredClone(job.result) } : {}),
      ...(job.error ? { error: structuredClone(job.error) } : {}),
      ...(job.finished && job.status !== 'cancelled' ? { metrics: {
        batchSize: job.batchSize, latencyMs: job.started ? Math.max(0, job.finished - job.started) : 0,
        queueWaitMs: Math.max(0, (job.started ?? job.finished) - job.created),
        ...(job.timings ?? {}),
        ...(job.kind === 'classification' ? { classifierVersion: CLASSIFIER_VERSION, schemaVersion: SCHEMA_VERSION } : {})
      } } : {}) };
  }
  function abort(job) {
    if (terminal.has(job.status)) return;
    job.status = 'cancelled';
    job.input = null;
    job.controller.abort(new MailHarborError('cancelled'));
  }
  function expire() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (now - job.created >= retentionMs) { abort(job); jobs.delete(id); }
    }
  }
  function find(id, owner) {
    assertOpen();
    expire();
    const job = jobs.get(id);
    if (!job || job.owner !== owner) throw new MailHarborError('not_found');
    return job;
  }
  async function checkSubmission() {
    assertOpen();
    expire();
    if (pausedCode) throw new MailHarborError(pausedCode);
    const quota = await cooldown.status();
    if (quota.blocked) throw quotaError(quota);
    // All asynchronous checks finish before the final shared queue-limit check.
    assertOpen();
    if (pausedCode) throw new MailHarborError(pausedCode);
    if ([...jobs.values()].filter(job => job.status === 'queued').length >= 5 || jobs.size >= 100) throw new MailHarborError('busy');
  }
  function quotaError(quota) {
    return Object.assign(new MailHarborError('quota_exhausted', undefined, 'provider_quota'), {
      retryAt: quota.retryAt, retryAfterMs: quota.retryAfterMs
    });
  }
  async function pump() {
    if (active || closed || pausedCode) return;
    expire();
    const queued = [...jobs.values()].filter(candidate => candidate.status === 'queued');
    const background = queued.find(candidate => candidate.kind !== 'notification-summary');
    const notification = queued.find(candidate => candidate.kind === 'notification-summary');
    // Never preempt an active process. At most two notifications can pass an
    // older queued background job, so historical classification keeps advancing.
    const job = notification && (!background || notificationStreak < 2) ? notification : background;
    if (!job) return;
    notificationStreak = job.kind === 'notification-summary' ? notificationStreak + 1 : 0;
    active = job;
    job.status = 'running';
    job.started = Date.now();
    const input = job.input;
    const timer = setTimeout(() => job.controller.abort(new MailHarborError('timeout', undefined, 'cli_timeout')), timeoutMs);
    let quotaAlreadyBlocked = false;
    try {
      const quota = await cooldown.status();
      if (quota.blocked) { quotaAlreadyBlocked = true; throw quotaError(quota); }
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      const onMetrics = metrics => {
        const timings = {};
        for (const name of ['startupMs', 'responseMs']) {
          if (Number.isSafeInteger(metrics?.[name]) && metrics[name] >= 0 && metrics[name] <= 900000) timings[name] = metrics[name];
        }
        job.timings = { ...job.timings, ...timings };
      };
      const selectedRunner = job.kind === 'notification-summary' ? notificationSummaryRunner : job.kind === 'classification' ? classificationRunner : runner;
      if (job.beforeRun) {
        const checked = job.beforeRun();
        if (checked && typeof checked.then === 'function') {
          Promise.resolve(checked).catch(() => {});
          throw new MailHarborError('invalid_request');
        }
        if (checked === false) throw new MailHarborError('stale_message');
      }
      const result = await selectedRunner(input, { ...config, timeoutMs, model: MODEL, onMetrics }, job.controller.signal);
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      job.result = job.kind === 'notification-summary' ? notificationSummaryResult(result, input) : job.kind === 'classification' ? classificationResult(result, input) : validateResult(result, input);
      job.status = 'completed';
    } catch (error) {
      if (job.status !== 'cancelled') {
        job.error = safeError(job.controller.signal.aborted ? job.controller.signal.reason : error);
        if (['quota_exhausted', 'login_required', 'configuration_error'].includes(job.error.code)) {
          const failureCode = job.error.code;
          if (failureCode === 'quota_exhausted') {
            try {
              if (!quotaAlreadyBlocked) await cooldown.pause(error?.cooldownMs);
              const blocked = quotaError(await cooldown.status());
              if (job.error.diagnostic?.reason === 'provider_rate_limit') blocked.diagnostic = job.error.diagnostic;
              job.error = safeError(blocked);
            } catch { pausedCode = 'configuration_error'; job.error = safeError({ code: pausedCode }); }
          } else pausedCode = failureCode;
          for (const waiting of jobs.values()) if (waiting.status === 'queued') {
            waiting.input = null; waiting.status = 'failed'; waiting.finished = Date.now(); waiting.error = structuredClone(job.error);
          }
        }
        if (job.status === 'cancelled') job.error = undefined;
        else job.status = 'failed';
      }
    } finally {
      clearTimeout(timer); job.finished = Date.now(); job.input = null; active = null;
      if (!closed) queueMicrotask(pump);
    }
  }

  const expiryTimer = setInterval(expire, Math.min(1000, retentionMs));
  expiryTimer.unref();
  return {
    async submit(inputValue, owner = 'legacy', kind = 'briefing', options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'beforeRun') ||
          (options.beforeRun !== undefined && typeof options.beforeRun !== 'function')) throw new MailHarborError('invalid_request');
      await checkSubmission();
      if (!['briefing', 'classification', 'notification-summary'].includes(kind)) throw new MailHarborError('invalid_request');
      const input = kind === 'notification-summary' ? validateNotificationSummaryRequest(inputValue) : kind === 'classification' ? validateClassificationRequest(inputValue) : validateRequest(inputValue);
      if (Buffer.byteLength(JSON.stringify(input)) > MAX_REQUEST_BYTES) throw new MailHarborError('invalid_request');
      // Submitters can resume from the same await together; reserve synchronously.
      assertOpen();
      if (pausedCode) throw new MailHarborError(pausedCode);
      if ([...jobs.values()].filter(job => job.status === 'queued').length >= 5 || jobs.size >= 100) throw new MailHarborError('busy');
      const id = randomBytes(18).toString('base64url');
      jobs.set(id, { id, owner, kind, status: 'queued', input, beforeRun: options.beforeRun, batchSize: input.messages.length, created: Date.now(), controller: new AbortController() });
      queueMicrotask(pump);
      return { id, status: 'queued' };
    },
    get(id, owner = 'legacy') { return snapshot(find(id, owner)); },
    release(id, owner) {
      const job = find(id, owner);
      if (!terminal.has(job.status)) throw new MailHarborError('busy');
      jobs.delete(id);
    },
    cancel(id, owner = 'legacy') {
      const job = find(id, owner);
      // Erase completed results too, matching the legacy API's DELETE behavior.
      abort(job); job.result = undefined; job.error = undefined; job.status = 'cancelled';
      return { id: job.id, status: 'cancelled' };
    },
    async resumeAfterLogin() {
      assertOpen();
      await validateProfile(config);
      const quota = await cooldown.status();
      assertOpen();
      // A verified sign-in only releases authentication failures. Failed jobs
      // keep their outcome and require an explicit fresh submission.
      if (pausedCode === 'login_required') pausedCode = null;
      return { resumed: !pausedCode && !quota.blocked };
    },
    async status() {
      assertOpen();
      const quota = await cooldown.status();
      let ready = !pausedCode && !quota.blocked;
      let code = pausedCode ?? (quota.blocked ? 'quota_exhausted' : null);
      let detail = code ? errorMessages[code] : 'The local profile is ready. Google connectivity, sign-in, and available quota have not been checked.';
      try { await validateProfile(config); } catch { ready = false; code ??= 'configuration_error'; detail = errorMessages[code]; }
      return { version: VERSION, model: MODEL, ready, detail, code,
        ...(quota.blocked ? { retryAt: quota.retryAt, retryAfterMs: quota.retryAfterMs } : {}) };
    },
    close() {
      if (!closing) closing = (async () => {
        closed = true; clearInterval(expiryTimer);
        for (const job of jobs.values()) abort(job);
        jobs.clear();
        while (active) await new Promise(resolve => setTimeout(resolve, 10));
      })();
      return closing;
    }
  };
}
