import { randomBytes } from 'node:crypto';
import { validateProfile } from './profile.mjs';
import { runAgy } from './runner.mjs';
import { runMailClassifier, validateClassificationRequest, classificationResult, CLASSIFIER_VERSION, SCHEMA_VERSION } from './mail-classifier.mjs';
import { runNotificationSummary, validateNotificationSummaryRequest, notificationSummaryResult } from './mail-notification-summary.mjs';
import { createCooldown } from './cooldown.mjs';
import { MODEL, VERSION, MAX_REQUEST_BYTES, MailHarborError, errorMessages, safeError, validateRequest, validateResult } from './validation.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const metricBounds = { startupMs: 900000, responseMs: 900000, inputMessages: 40,
  inputCharacters: MAX_REQUEST_BYTES + 8192, promptCharacters: 8192, bodyCharacters: 40 * 8000, requestBytes: MAX_REQUEST_BYTES };

/** One bounded Agy/Gemini queue shared by every HTTP interface. Owners are server-assigned. */
export function createJobs(config, runner = runAgy, { classificationRunner = runMailClassifier, notificationSummaryRunner = runNotificationSummary, geminiProvider: optionsGeminiProvider = null } = {}) {
  if (config.model !== undefined && config.model !== MODEL) throw new MailHarborError('configuration_error');
  const timeoutMs = Math.min(120000, Math.max(10, config.timeoutMs ?? 120000));
  const retentionMs = Math.min(900000, Math.max(10, config.retentionMs ?? 900000));
  if (!Number.isFinite(timeoutMs) || !Number.isFinite(retentionMs)) throw new MailHarborError('configuration_error');
  const cooldown = createCooldown(config);
  const jobs = new Map();
  const activeJobs = new Set();
  let geminiProvider = optionsGeminiProvider ?? null;
  let closed = false;
  let closing = null;
  let pausedCode = null;
  let notificationStreak = 0;

  const usingGemini = () => Boolean(geminiProvider?.isActive?.());
  const maxActive = () => (usingGemini() ? 3 : 1);
  const maxQueued = () => (usingGemini() ? 12 : 5);
  function budgetError() {
    return new MailHarborError('quota_exhausted', 'The configured Gemini API spend cap has been reached. Raise the cap or reset the spend counter in Settings → AI connection.', 'provider_budget_reached');
  }

  function assertOpen() { if (closed) throw new MailHarborError('busy'); }
  function snapshot(job) {
    return { id: job.id, status: job.status, ...(job.result ? { result: structuredClone(job.result) } : {}),
      ...(job.error ? { error: structuredClone(job.error) } : {}),
      ...(job.finished && job.status !== 'cancelled' ? { metrics: {
        batchSize: job.batchSize, latencyMs: job.started ? Math.max(0, job.finished - job.started) : 0,
        queueWaitMs: Math.max(0, (job.started ?? job.finished) - job.created),
        ...(job.measurements ?? {}),
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
    if (usingGemini() && geminiProvider.isBudgetReached?.()) throw budgetError();
    const quota = await cooldown.status();
    if (quota.blocked) throw quotaError(quota);
    // All asynchronous checks finish before the final shared queue-limit check.
    assertOpen();
    if (pausedCode) throw new MailHarborError(pausedCode);
    if (usingGemini() && geminiProvider.isBudgetReached?.()) throw budgetError();
    if ([...jobs.values()].filter(job => job.status === 'queued').length >= maxQueued() || jobs.size >= 100) throw new MailHarborError('busy');
  }
  function quotaError(quota) {
    return Object.assign(new MailHarborError('quota_exhausted', undefined, 'provider_quota'), {
      retryAt: quota.retryAt, retryAfterMs: quota.retryAfterMs
    });
  }
  async function executeJob(job) {
    const input = job.input;
    const timer = setTimeout(() => job.controller.abort(new MailHarborError('timeout', undefined, 'cli_timeout')), timeoutMs);
    let quotaAlreadyBlocked = false;
    try {
      const directGemini = usingGemini();
      if (directGemini && geminiProvider.isBudgetReached?.()) {
        quotaAlreadyBlocked = true;
        throw budgetError();
      }
      const quota = await cooldown.status();
      if (quota.blocked) { quotaAlreadyBlocked = true; throw quotaError(quota); }
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      const onMetrics = metrics => {
        const measurements = {};
        for (const [name, maximum] of Object.entries(metricBounds)) {
          if (Number.isSafeInteger(metrics?.[name]) && metrics[name] >= (name === 'inputMessages' ? 1 : 0) && metrics[name] <= maximum) measurements[name] = metrics[name];
        }
        job.measurements = { ...job.measurements, ...measurements };
      };
      const selectedRunner = directGemini
        ? (job.kind === 'notification-summary' ? geminiProvider.notificationSummaryRunner : job.kind === 'classification' ? geminiProvider.classificationRunner : geminiProvider.briefingRunner)
        : (job.kind === 'notification-summary' ? notificationSummaryRunner : job.kind === 'classification' ? classificationRunner : runner);
      if (job.beforeRun) {
        const checked = job.beforeRun();
        if (checked && typeof checked.then === 'function') {
          Promise.resolve(checked).catch(() => {});
          throw new MailHarborError('invalid_request');
        }
        if (checked === false) throw new MailHarborError('stale_message');
      }
      const activeModel = directGemini ? geminiProvider.model() : MODEL;
      const result = await selectedRunner(input, { ...config, timeoutMs, model: activeModel, onMetrics }, job.controller.signal);
      if (job.controller.signal.aborted) throw job.controller.signal.reason;
      job.result = job.kind === 'notification-summary' ? notificationSummaryResult(result, input) : job.kind === 'classification' ? classificationResult(result, input) : validateResult(result, input);
      job.status = 'completed';
    } catch (error) {
      if (job.status !== 'cancelled') {
        const rawError = job.controller.signal.aborted ? job.controller.signal.reason : error;
        job.error = safeError(rawError);
        if (['quota_exhausted', 'login_required', 'configuration_error'].includes(job.error.code)) {
          const failureCode = job.error.code;
          const isBudgetCap = job.error.diagnostic?.reason === 'provider_budget_reached';
          if (failureCode === 'quota_exhausted') {
            if (!isBudgetCap) {
              try {
                if (!quotaAlreadyBlocked) await cooldown.pause(error?.cooldownMs);
                const blocked = quotaError(await cooldown.status());
                if (job.error.diagnostic?.reason === 'provider_rate_limit') blocked.diagnostic = job.error.diagnostic;
                job.error = safeError(blocked);
              } catch { pausedCode = 'configuration_error'; job.error = safeError({ code: pausedCode }); }
            }
          } else pausedCode = failureCode;
          for (const waiting of jobs.values()) if (waiting.status === 'queued') {
            waiting.input = null; waiting.status = 'failed'; waiting.finished = Date.now(); waiting.error = structuredClone(job.error);
          }
        }
        if (job.status === 'cancelled') job.error = undefined;
        else job.status = 'failed';
      }
    } finally {
      clearTimeout(timer); job.finished = Date.now(); job.input = null; activeJobs.delete(job);
      if (!closed) queueMicrotask(pump);
    }
  }
  function pump() {
    if (closed || pausedCode) return;
    expire();
    while (activeJobs.size < maxActive() && !closed && !pausedCode) {
      const queued = [...jobs.values()].filter(candidate => candidate.status === 'queued');
      if (!queued.length) return;
      const background = queued.find(candidate => candidate.kind !== 'notification-summary');
      const notification = queued.find(candidate => candidate.kind === 'notification-summary');
      // Never preempt an active process. At most two notifications can pass an
      // older queued background job, so historical classification keeps advancing.
      const job = notification && (!background || notificationStreak < 2) ? notification : background;
      if (!job) return;
      notificationStreak = job.kind === 'notification-summary' ? notificationStreak + 1 : 0;
      activeJobs.add(job);
      job.status = 'running';
      job.started = Date.now();
      void executeJob(job);
    }
  }

  const expiryTimer = setInterval(expire, Math.min(1000, retentionMs));
  expiryTimer.unref();
  return {
    setGeminiProvider(provider) {
      geminiProvider = provider ?? null;
    },
    isFastMode() {
      return usingGemini();
    },
    clearProviderPause() {
      assertOpen();
      if (pausedCode === 'login_required' || pausedCode === 'configuration_error') pausedCode = null;
    },
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
      if (usingGemini() && geminiProvider.isBudgetReached?.()) throw budgetError();
      if ([...jobs.values()].filter(job => job.status === 'queued').length >= maxQueued() || jobs.size >= 100) throw new MailHarborError('busy');
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
    retryAuthentication() {
      assertOpen();
      // An explicit owner retry permits a fresh sign-in check. The runner still
      // validates its profile before sending input; quota/configuration blocks
      // and already failed jobs are retained.
      if (pausedCode !== 'login_required') return false;
      pausedCode = null;
      return true;
    },
    async resumeAfterLogin() {
      assertOpen();
      if (!usingGemini()) await validateProfile(config);
      const quota = await cooldown.status();
      assertOpen();
      // Preserve the deployed login-resume interface when adding input metrics.
      // Failed jobs retain their outcome and require a fresh submission.
      if (pausedCode === 'login_required') pausedCode = null;
      const budgetBlocked = usingGemini() && Boolean(geminiProvider.isBudgetReached?.());
      return { resumed: !pausedCode && !quota.blocked && !budgetBlocked };
    },
    async status() {
      assertOpen();
      const quota = await cooldown.status();
      if (usingGemini()) {
        const budgetBlocked = Boolean(geminiProvider.isBudgetReached?.());
        const ready = !pausedCode && !quota.blocked && !budgetBlocked;
        const code = pausedCode ?? (budgetBlocked || quota.blocked ? 'quota_exhausted' : null);
        const detail = budgetBlocked
          ? 'The configured Gemini API spend cap has been reached. Raise the cap or reset the counter in Settings → AI connection.'
          : code
            ? errorMessages[code]
            : `Direct Gemini API ready (${geminiProvider.model()}).`;
        return { version: VERSION, model: geminiProvider.model(), provider: 'gemini-api', ready, detail, code,
          ...(quota.blocked ? { retryAt: quota.retryAt, retryAfterMs: quota.retryAfterMs } : {}) };
      }
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
        while (activeJobs.size > 0) await new Promise(resolve => setTimeout(resolve, 10));
      })();
      return closing;
    }
  };
}
