import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobs } from '../server/jobs.mjs';
import { createServer, closeServer } from '../server/app.mjs';
import { MailHarborError, MODEL, VERSION, safeError } from '../server/validation.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const token = 'test-only-pairing-token-abcdefghijklmnopqrstuvwxyz';
const input = () => ({ messages: [{ id: 'opaque-message', account: 'Test', author: 'Sender', subject: 'Subject',
  date: '2026-09-09', body: 'PRIVATE_TEST_BODY', truncated: false, bodyUnavailable: false }] });
const result = request => ({ briefing: 'One message to review.', items: request.messages.map(message => ({ id: message.id,
  summary: 'Review this message.', priority: 'normal', category: 'other', recommendation: 'keep', reason: 'Needs review.' })) });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const classifierInput = (count = 1) => ({ messages: Array.from({ length: count }, (_, index) => ({ id: index.toString(16).padStart(64, '0'),
  subject: 'Subject', author: 'Sender', to: 'private@example.test', date: '2026-09-13T12:00:00Z', folderKind: 'inbox', body: 'PRIVATE_CLASSIFIER_BODY', complete: true })) });
const classifierResult = request => ({ items: request.messages.map(message => ({ id: message.id, labels: ['jobs'], confidence: 0.99,
  junk: 'legitimate', junkConfidence: 0.99, dates: { couponExpiry: null, tenderDeadline: null, appointmentStart: null, appointmentEnd: null },
  dateConfidence: 0.99, appointment: null })) });
async function completed(jobs, id, owner) {
  for (let i = 0; i < 100; i++) {
    const value = jobs.get(id, owner);
    if (!['queued', 'running'].includes(value.status)) return value;
    await pause(5);
  }
  throw new Error('Job did not finish');
}

test('job owners cannot inspect or cancel one another; snapshots are detached and omit input', async t => {
  const jobs = createJobs({}, async request => result(request));
  t.after(() => jobs.close());
  const job = await jobs.submit(input(), 'owner-phone');
  assert.throws(() => jobs.get(job.id), error => error.code === 'not_found');
  assert.throws(() => jobs.get(job.id, 'other-owner'), error => error.code === 'not_found');
  assert.throws(() => jobs.cancel(job.id, 'other-owner'), error => error.code === 'not_found');
  const ready = await completed(jobs, job.id, 'owner-phone');
  assert.equal(ready.status, 'completed');
  assert.ok(!JSON.stringify(ready).includes('PRIVATE_TEST_BODY'));
  ready.result.items[0].summary = 'Changed outside the manager';
  assert.equal(jobs.get(job.id, 'owner-phone').result.items[0].summary, 'Review this message.');
  assert.deepEqual(jobs.cancel(job.id, 'owner-phone'), { id: job.id, status: 'cancelled' });
  assert.deepEqual(jobs.get(job.id, 'owner-phone'), { id: job.id, status: 'cancelled' });
  const status = await jobs.status();
  assert.equal(status.model, MODEL);
  assert.equal(status.version, VERSION);
  assert.equal(status.ready, false); // No real profile is configured in these tests.
});

test('direct submissions enforce message validation and the UTF-8 batch byte cap', async t => {
  let runs = 0;
  const jobs = createJobs({}, async request => { runs++; return result(request); });
  t.after(() => jobs.close());
  await assert.rejects(jobs.submit({ ...input(), extra: true }), error => error.code === 'invalid_request');
  const large = { messages: Array.from({ length: 40 }, (_, i) => ({ ...input().messages[0], id: String(i), body: '界'.repeat(8000) })) };
  await assert.rejects(jobs.submit(large, 'owner'), error => error.code === 'invalid_request');
  assert.equal(runs, 0);
});

test('owners share one worker and the queue cap; closing cancels work and rejects submissions', async t => {
  let active = 0, peak = 0, runs = 0;
  const jobs = createJobs({}, (request, config, signal) => new Promise((resolve, reject) => {
    active++; runs++; peak = Math.max(peak, active);
    signal.addEventListener('abort', () => { active--; reject(signal.reason); }, { once: true });
  }));
  t.after(() => jobs.close());
  const first = await jobs.submit(input());
  await pause(0); // The shared worker rechecks the durable cooldown before starting.
  assert.equal(runs, 1);
  const queued = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => jobs.submit(input(), `owner-${i}`)));
  assert.equal(queued.filter(value => value.status === 'fulfilled').length, 5);
  assert.ok(queued.filter(value => value.status === 'rejected').every(value => value.reason.code === 'busy'));
  assert.equal(peak, 1);
  assert.throws(() => jobs.cancel(first.id, 'owner-0'), error => error.code === 'not_found');
  await jobs.close();
  await jobs.close();
  assert.equal(active, 0);
  assert.equal(runs, 1);
  await assert.rejects(jobs.submit(input()), error => error.code === 'busy');
});

test('expiry removes owner-scoped jobs and cancels an active worker', async t => {
  let aborted = false;
  const jobs = createJobs({ retentionMs: 20 }, (request, config, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }));
  t.after(() => jobs.close());
  const job = await jobs.submit(input(), 'owner');
  await pause(40);
  assert.throws(() => jobs.get(job.id, 'owner'), error => error.code === 'not_found');
  assert.equal(aborted, true);
});

test('web hook verifies tokens, shares jobs with the legacy API, and closes once', async t => {
  let webJobs, verify, webClosed = 0, runs = 0, active = 0, peak = 0;
  const server = createServer({ pairingToken: token }, (request, config, signal) => new Promise((resolve, reject) => {
    runs++; active++; peak = Math.max(peak, active);
    signal.addEventListener('abort', () => { active--; reject(signal.reason); }, { once: true });
  }), {
    createWeb({ jobs, verifyToken }) {
      webJobs = jobs; verify = verifyToken;
      return {
        async handle(request, response) {
          if (request.url === '/web/throws') throw new Error('PRIVATE_DIAGNOSTICS');
          if (request.url !== '/web/submit') return false;
          if (!await verifyToken(request.headers['x-test-token'])) throw new MailHarborError('unauthorized');
          const job = await jobs.submit(input(), 'web-owner');
          response.writeHead(202, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(job));
          return true;
        },
        async close() { webClosed++; }
      };
    }
  });
  t.after(() => closeServer(server));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await verify(token), true);
  for (const invalid of [null, {}, 'wrong', token + '\n', 'x'.repeat(129)]) assert.equal(await verify(invalid), false);
  const denied = await fetch(origin + '/web/submit', { method: 'POST' });
  assert.equal(denied.status, 401);
  assert.equal(runs, 0);
  const web = await (await fetch(origin + '/web/submit', { method: 'POST', headers: { 'X-Test-Token': token } })).json();
  assert.equal(webJobs.get(web.id, 'web-owner').status, 'running');
  const legacy = await fetch(origin + '/v1/jobs', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input()) });
  assert.equal(legacy.status, 202);
  assert.equal(webJobs.get((await legacy.json()).id).status, 'queued');
  assert.equal((await fetch(origin + `/v1/jobs/${web.id}`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  const failed = await fetch(origin + '/web/throws');
  assert.equal(failed.status, 500);
  assert.ok(!(await failed.text()).includes('PRIVATE_DIAGNOSTICS'));
  assert.equal(runs, 1);
  assert.equal(peak, 1);
  await closeServer(server);
  await closeServer(server);
  assert.equal(active, 0);
  assert.equal(webClosed, 1);
});

test('classification and briefing jobs share one worker and route through their respective injected runners', async t => {
  const started = [], finish = new Map();
  let active = 0, peak = 0;
  const runnerFor = (kind, build) => (request, config, signal) => new Promise((resolve, reject) => {
    started.push(kind); active++; peak = Math.max(peak, active);
    assert.equal(config.model, MODEL);
    let settled = false;
    const done = (error) => { if (settled) return; settled = true; active--; error ? reject(error) : resolve(build(request)); };
    finish.set(kind, done);
    signal.addEventListener('abort', () => done(signal.reason), { once: true });
  });
  const jobs = createJobs({}, runnerFor('briefing', result), { classificationRunner: runnerFor('classification', classifierResult) });
  t.after(() => jobs.close());
  const classify = await jobs.submit(classifierInput(), 'processor', 'classification');
  const brief = await jobs.submit(input(), 'phone');
  assert.deepEqual(started, ['classification']);
  assert.equal(jobs.get(brief.id, 'phone').status, 'queued');
  assert.throws(() => jobs.release(classify.id, 'processor'), error => error.code === 'busy');
  assert.throws(() => jobs.release(classify.id, 'phone'), error => error.code === 'not_found');
  finish.get('classification')();
  const classified = await completed(jobs, classify.id, 'processor');
  assert.equal(classified.status, 'completed');
  assert.deepEqual(classified.result.items[0].labels, ['jobs']);
  assert.ok(!JSON.stringify(classified).includes('PRIVATE_CLASSIFIER_BODY'));
  assert.deepEqual(started, ['classification', 'briefing']);
  finish.get('briefing')();
  assert.equal((await completed(jobs, brief.id, 'phone')).result.briefing, 'One message to review.');
  assert.equal(peak, 1);
});

test('classification jobs independently validate injected runner results before exposing completion', async t => {
  for (const invalidKind of ['duplicate', 'substituted', 'briefing-shape']) {
    const jobs = createJobs({}, async () => { throw new Error('Wrong runner'); }, { classificationRunner: async request => {
      if (invalidKind === 'briefing-shape') return { briefing: 'Not a classification.', items: [] };
      const response = classifierResult(request);
      response.items[1].id = invalidKind === 'duplicate' ? response.items[0].id : 'f'.repeat(64);
      return response;
    } });
    t.after(() => jobs.close());
    const job = await jobs.submit(classifierInput(2), 'processor', 'classification');
    const finished = await completed(jobs, job.id, 'processor');
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error.code, 'invalid_model_output');
    assert.equal(finished.result, undefined);
  }
});

test('releasing terminal processing jobs avoids the 100-job cap during a long mailbox run', async t => {
  let runs = 0;
  const jobs = createJobs({}, async request => result(request), { classificationRunner: async request => { runs++; return classifierResult(request); } });
  t.after(() => jobs.close());
  let firstId;
  for (let index = 0; index < 105; index++) {
    const job = await jobs.submit(classifierInput(), 'processor', 'classification');
    firstId ??= job.id;
    assert.equal((await completed(jobs, job.id, 'processor')).status, 'completed');
    jobs.release(job.id, 'processor');
  }
  assert.equal(runs, 105);
  assert.throws(() => jobs.get(firstId, 'processor'), error => error.code === 'not_found');
});

test('cancelling an active classification releases the shared worker for the queued briefing', async t => {
  let classificationAborted = false, briefingRuns = 0;
  const jobs = createJobs({}, async request => { briefingRuns++; return result(request); }, { classificationRunner: (request, config, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { classificationAborted = true; reject(signal.reason); }, { once: true });
  }) });
  t.after(() => jobs.close());
  const classification = await jobs.submit(classifierInput(), 'processor', 'classification');
  const briefing = await jobs.submit(input(), 'phone');
  jobs.cancel(classification.id, 'processor');
  assert.equal((await completed(jobs, briefing.id, 'phone')).status, 'completed');
  assert.equal(classificationAborted, true);
  assert.equal(briefingRuns, 1);
  assert.equal(jobs.get(classification.id, 'processor').status, 'cancelled');
  jobs.release(classification.id, 'processor');
});

test('classification quota failures halt queued work of both kinds and reject later submissions without additional runners', async t => {
  let rejectClassifier, classifications = 0, briefings = 0;
  const jobs = createJobs({}, async request => { briefings++; return result(request); }, { classificationRunner: () => new Promise((resolve, reject) => {
    classifications++; rejectClassifier = reject;
  }) });
  t.after(() => jobs.close());
  const active = await jobs.submit(classifierInput(), 'processor', 'classification');
  const waitingBriefing = await jobs.submit(input(), 'phone');
  const waitingClassification = await jobs.submit(classifierInput(), 'processor', 'classification');
  const quota = new MailHarborError('quota_exhausted'); quota.cooldownMs = 7 * 86400000; rejectClassifier(quota);
  const activeError = (await completed(jobs, active.id, 'processor')).error;
  assert.equal(activeError.code, 'quota_exhausted');
  assert.ok(Date.parse(activeError.retryAt) > Date.now() + 6 * 86400000);
  assert.ok(activeError.retryAfterMs > 6 * 86400000);
  for (const [id, owner] of [[waitingBriefing.id, 'phone'], [waitingClassification.id, 'processor']]) {
    const blocked = (await completed(jobs, id, owner)).error;
    assert.equal(blocked.code, 'quota_exhausted');
    assert.equal(blocked.retryAt, activeError.retryAt);
  }
  assert.equal((await jobs.status()).retryAt, activeError.retryAt);
  await assert.rejects(jobs.submit(input(), 'phone'), error => error.code === 'quota_exhausted' && error.retryAt === activeError.retryAt);
  await assert.rejects(jobs.submit(classifierInput(), 'processor', 'classification'), error => error.code === 'quota_exhausted');
  assert.equal(classifications, 1);
  assert.equal(briefings, 0);
});

test('a short request throttle blocks all queued jobs until its persisted retry instead of five hours', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-short-throttle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { cooldownFile: path.join(directory, 'cooldown.json') };
  let rejectActive, runs = 0;
  const jobs = createJobs(config, () => new Promise((resolve, reject) => { runs++; rejectActive = reject; }));
  t.after(() => jobs.close());
  const active = await jobs.submit(input());
  const queued = await jobs.submit(input());
  rejectActive(Object.assign(new MailHarborError('quota_exhausted', undefined, 'provider_rate_limit'), { cooldownMs: 90000 }));
  const failure = (await completed(jobs, active.id)).error;
  assert.equal(failure.code, 'quota_exhausted');
  assert.deepEqual(failure.diagnostic, { stage: 'provider_limits', reason: 'provider_rate_limit' });
  assert.ok(failure.retryAfterMs > 80000 && failure.retryAfterMs <= 90000);
  assert.equal((await completed(jobs, queued.id)).error.retryAt, failure.retryAt);
  await assert.rejects(jobs.submit(input()), error => error.retryAt === failure.retryAt);
  await jobs.close();
  const restarted = createJobs(config, async request => { runs++; return result(request); });
  t.after(() => restarted.close());
  await assert.rejects(restarted.submit(input()), error => error.retryAt === failure.retryAt && error.retryAfterMs <= 90000);
  assert.equal(runs, 1);
});

test('safe errors keep only enumerated diagnostics and validated quota timing', () => {
  const error = Object.assign(new MailHarborError('invalid_model_output', 'PRIVATE_RAW_REPLY'), {
    diagnostic: { reason: 'response_date_invalid', stage: 'PRIVATE_STAGE', raw: 'PRIVATE_BODY' },
    retryAt: 'PRIVATE_TOKEN', retryAfterMs: Infinity, arbitrary: 'PRIVATE_CREDENTIALS'
  });
  assert.deepEqual(safeError(error).diagnostic, { stage: 'response_schema', reason: 'response_date_invalid' });
  assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_/u);
  assert.equal(safeError({ code: 'invalid_model_output', diagnostic: { reason: 'PRIVATE_UNKNOWN_REASON' } }).diagnostic, undefined);
  for (const retryAt of ['2026-02-31T00:00:00.000Z', 'PRIVATE_TOKEN', '2026-01-01']) {
    assert.equal(safeError({ code: 'quota_exhausted', retryAt, retryAfterMs: NaN }).retryAt, undefined);
  }
});

test('jobs preserve safe diagnostics, detached metrics and classifier versions', async t => {
  const jobs = createJobs({}, undefined, { classificationRunner: async (_, config) => {
    config.onMetrics({ startupMs: 123, responseMs: 456, raw: 'PRIVATE_OUTPUT', arbitrary: 'PRIVATE_TOKEN' });
    config.onMetrics({ startupMs: NaN, responseMs: -1, private: 'PRIVATE_BODY' });
    throw new MailHarborError('invalid_model_output', 'PRIVATE_RAW_OUTPUT', 'response_date_invalid');
  } });
  t.after(() => jobs.close());
  const submitted = await jobs.submit(classifierInput(3), 'processor', 'classification');
  const failed = await completed(jobs, submitted.id, 'processor');
  assert.deepEqual(failed.error.diagnostic, { stage: 'response_schema', reason: 'response_date_invalid' });
  assert.equal(failed.metrics.batchSize, 3);
  assert.equal(failed.metrics.classifierVersion, 3);
  assert.equal(failed.metrics.schemaVersion, 2);
  assert.equal(failed.metrics.startupMs, 123); assert.equal(failed.metrics.responseMs, 456);
  assert.ok(failed.metrics.latencyMs >= 0); assert.ok(failed.metrics.queueWaitMs >= 0);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_/u);
  failed.error.diagnostic.reason = 'outside_mutation'; failed.metrics.batchSize = 999;
  assert.equal(jobs.get(submitted.id, 'processor').error.diagnostic.reason, 'response_date_invalid');
  assert.equal(jobs.get(submitted.id, 'processor').metrics.batchSize, 3);
});

test('weekly quota deadline survives a jobs restart and every blocked response carries its actual deadline', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-jobs-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { cooldownFile: path.join(root, 'cooldown.json') };
  let runs = 0;
  const first = createJobs(config, async () => {
    runs++;
    throw Object.assign(new MailHarborError('quota_exhausted'), { cooldownMs: 7 * 86400000 });
  });
  t.after(() => first.close());
  const submitted = await first.submit(input());
  const failed = await completed(first, submitted.id);
  const state = JSON.parse(await readFile(config.cooldownFile, 'utf8'));
  assert.equal(failed.error.retryAt, new Date(state.blockedUntil).toISOString());
  await first.close();
  const restarted = createJobs(config, async request => { runs++; return result(request); });
  t.after(() => restarted.close());
  await assert.rejects(restarted.submit(input()), error => error.retryAt === failed.error.retryAt && error.retryAfterMs > 6 * 86400000);
  assert.equal((await restarted.status()).retryAt, failed.error.retryAt);
  assert.equal(runs, 1);
});

test('configuration failures stop queued jobs and require configuration recovery before more provider requests', async t => {
  let rejectActive, runs = 0;
  const jobs = createJobs({}, () => new Promise((resolve, reject) => { runs++; rejectActive = reject; }));
  t.after(() => jobs.close());
  const active = await jobs.submit(input());
  const queued = await jobs.submit(input());
  rejectActive(new MailHarborError('configuration_error', 'PRIVATE_PROFILE_PATH', 'profile_invalid'));
  for (const job of [active, queued]) {
    const failed = await completed(jobs, job.id);
    assert.equal(failed.error.code, 'configuration_error');
    assert.equal(failed.error.diagnostic.reason, 'profile_invalid');
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_/u);
  }
  await assert.rejects(jobs.submit(input()), error => error.code === 'configuration_error');
  assert.equal(runs, 1);
});

test('a failed durable quota write blocks all further provider calls without promising an unpersisted retry', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-jobs-failed-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let rejectActive, runs = 0;
  const jobs = createJobs({ cooldownFile: path.join(root, 'missing-directory', 'cooldown.json') }, () =>
    new Promise((resolve, reject) => { runs++; rejectActive = reject; }));
  t.after(() => jobs.close());
  const active = await jobs.submit(input());
  const queued = await jobs.submit(input());
  rejectActive(new MailHarborError('quota_exhausted'));
  for (const job of [active, queued]) {
    const failed = await completed(jobs, job.id);
    assert.equal(failed.error.code, 'configuration_error');
    assert.equal(failed.error.retryAt, undefined);
  }
  await assert.rejects(jobs.submit(input()), error => error.code === 'configuration_error');
  assert.equal(runs, 1);
});

const notificationInput = id => ({ language: 'nl-BE', messages: [{ id, author: 'Alice', subject: 'Quote', to: 'info@example.test', date: '2026-09-20',
  body: 'Could you send me a quote for a website?', truncated: false, bodyUnavailable: false, source: 'direct' }] });
const notificationResult = request => ({ items: request.messages.map(message => ({ id: message.id, intent: 'inquiry', confidence: 0.99,
  evidence: 'Could you send me a quote', summary: 'De klant vraagt een offerte.', requestedAction: null, explicitDeadline: null, priority: 'normal' })) });

test('notification jobs precede queued history without preemption and yield after two runs', async t => {
  const started = [], finish = new Map(); let active = 0, peak = 0;
  const run = build => (request, config, signal) => new Promise((resolve, reject) => {
    const id = request.messages[0].id; started.push(id); active++; peak = Math.max(peak, active);
    assert.equal(config.model, MODEL);
    let done = false;
    const settle = error => { if (done) return; done = true; active--; error ? reject(error) : resolve(build(request)); };
    finish.set(id, settle); signal.addEventListener('abort', () => settle(signal.reason), { once: true });
  });
  const jobs = createJobs({}, undefined, { classificationRunner: run(classifierResult), notificationSummaryRunner: run(notificationResult) });
  t.after(() => jobs.close());
  const c0 = classifierInput(); c0.messages[0].id = 'a'.repeat(64);
  const c1 = classifierInput(); c1.messages[0].id = 'b'.repeat(64);
  const first = await jobs.submit(c0, 'processor', 'classification');
  const historical = await jobs.submit(c1, 'processor', 'classification');
  const notifications = [];
  for (const id of ['n0', 'n1', 'n2']) notifications.push(await jobs.submit(notificationInput(id), 'notifier', 'notification-summary'));
  assert.deepEqual(started, ['a'.repeat(64)]);
  finish.get('a'.repeat(64))(); await completed(jobs, first.id, 'processor');
  assert.equal(started.at(-1), 'n0');
  finish.get('n0')(); await completed(jobs, notifications[0].id, 'notifier');
  assert.equal(started.at(-1), 'n1');
  finish.get('n1')(); await completed(jobs, notifications[1].id, 'notifier');
  assert.equal(started.at(-1), 'b'.repeat(64));
  finish.get('b'.repeat(64))(); await completed(jobs, historical.id, 'processor');
  assert.equal(started.at(-1), 'n2');
  finish.get('n2')(); const ready = await completed(jobs, notifications[2].id, 'notifier');
  assert.equal(ready.status, 'completed'); assert.equal(peak, 1);
  assert.doesNotMatch(JSON.stringify(ready), /Could you send me a quote for a website/u);
});

test('notification results are independently validated and unknown job kinds rejected', async t => {
  const jobs = createJobs({}, undefined, { notificationSummaryRunner: async request => {
    const result = notificationResult(request); result.items[0].evidence = 'invented request'; return result;
  } });
  t.after(() => jobs.close());
  const job = await jobs.submit(notificationInput('n0'), 'notifier', 'notification-summary');
  const done = await completed(jobs, job.id, 'notifier');
  assert.equal(done.status, 'failed'); assert.equal(done.error.code, 'invalid_model_output');
  await assert.rejects(jobs.submit(input(), 'owner', 'unsupported'), error => error.code === 'invalid_request');
});

test('notification provider failures pause the shared queue and never invoke other runners', async t => {
  let rejectActive, notificationRuns = 0, classificationRuns = 0;
  const jobs = createJobs({}, undefined, {
    notificationSummaryRunner: () => new Promise((resolve, reject) => { notificationRuns++; rejectActive = reject; }),
    classificationRunner: async request => { classificationRuns++; return classifierResult(request); }
  });
  t.after(() => jobs.close());
  const active = await jobs.submit(notificationInput('n0'), 'notifier', 'notification-summary');
  const queued = await jobs.submit(classifierInput(), 'processor', 'classification');
  rejectActive(new MailHarborError('login_required'));
  assert.equal((await completed(jobs, active.id, 'notifier')).error.code, 'login_required');
  assert.equal((await completed(jobs, queued.id, 'processor')).error.code, 'login_required');
  await assert.rejects(jobs.submit(notificationInput('n1'), 'notifier', 'notification-summary'), error => error.code === 'login_required');
  assert.equal(notificationRuns, 1); assert.equal(classificationRuns, 0);
});

test('queued notification state is checked immediately before Agy starts, after older work finishes', async t => {
  let finish, notificationRuns = 0, current = true, checks = 0;
  const jobs = createJobs({}, undefined, {
    classificationRunner: request => new Promise(resolve => { finish = () => resolve(classifierResult(request)); }),
    notificationSummaryRunner: async request => { notificationRuns++; return notificationResult(request); }
  });
  t.after(() => jobs.close());
  const older = await jobs.submit(classifierInput(), 'processor', 'classification');
  const queued = await jobs.submit(notificationInput('n0'), 'notifier', 'notification-summary', { beforeRun() { checks++; return current; } });
  assert.equal(checks, 0); current = false; finish();
  await completed(jobs, older.id, 'processor');
  const failed = await completed(jobs, queued.id, 'notifier');
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'stale_message');
  assert.equal(checks, 1); assert.equal(notificationRuns, 0);
  const thrown = await jobs.submit(notificationInput('n1'), 'notifier', 'notification-summary', { beforeRun() { throw new MailHarborError('cancelled', 'PRIVATE_REASON'); } });
  const cancelled = await completed(jobs, thrown.id, 'notifier');
  assert.equal(cancelled.error.code, 'cancelled'); assert.doesNotMatch(JSON.stringify(cancelled), /PRIVATE_REASON/u);
  assert.equal(notificationRuns, 0);
  await assert.rejects(jobs.submit(notificationInput('n2'), 'notifier', 'notification-summary', { beforeRun: true }), error => error.code === 'invalid_request');
});
