import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, closeServer } from '../server/app.mjs';
import { MailHarborError, MODEL, validateRequest, validateResult } from '../server/validation.mjs';

const token = 'test-only-pairing-token-abcdefghijklmnopqrstuvwxyz';
const sample = (id = 'opaque-a') => ({ id, account: 'Private', author: 'Sender', subject: 'Subject', date: '2026-09-08', body: 'SECRET_EMAIL_BODY', truncated: false, bodyUnavailable: false });
const request = () => ({ language: 'en', messages: [sample()] });
const result = input => ({ briefing: 'Review your message.', items: input.messages.map(message => ({ id: message.id, summary: 'Needs review.', priority: 'normal', category: 'other', recommendation: 'keep', reason: 'Unknown.' })) });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness(t, runner = async input => result(input), config = {}) {
  const server = createServer({ pairingToken: token, ...config }, runner);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (url, options = {}) => {
    const response = await fetch(base + url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}
const submit = (call, input = request()) => call('/v1/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
async function poll(call, id) {
  for (let count = 0; count < 100; count++) {
    const response = await call(`/v1/jobs/${id}`);
    if (!['running', 'queued'].includes(response.body.status)) return response;
    await pause(10);
  }
  throw new Error('Job did not finish');
}

test('authentication, no CORS, no-store, and no accidental public bind', async t => {
  let runs = 0;
  const call = await harness(t, async input => { runs++; return result(input); });
  const denied = await call('/v1/jobs', { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json', Origin: 'https://evil.invalid' }, body: JSON.stringify(request()) });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal(runs, 0);
  const server = createServer({ pairingToken: token }, async () => {});
  assert.throws(() => server.listen(0, '0.0.0.0'), error => error.code === 'configuration_error');
  await closeServer(server);
});

test('requests reject duplicate IDs, unknown fields, invalid flags and excessive caps', async t => {
  let runs = 0;
  const call = await harness(t, async input => { runs++; return result(input); });
  for (const input of [
    { ...request(), extra: true },
    { messages: [sample(), sample()] },
    { messages: [{ ...sample(), body: 'x'.repeat(8001) }] },
    { messages: [{ ...sample(), truncated: 'false' }] },
    { messages: Array.from({ length: 41 }, (_, index) => sample(String(index))) },
    { language: '../../file', messages: [sample()] }
  ]) assert.equal((await submit(call, input)).status, 400);
  const oversized = await call('/v1/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(512 * 1024 + 1) });
  assert.equal(oversized.status, 400);
  assert.equal(runs, 0);
});

test('jobs expose a validated result and never echo the source body', async t => {
  const call = await harness(t);
  const created = await submit(call);
  assert.equal(created.status, 202);
  assert.match(created.body.id, /^[A-Za-z0-9_-]{24}$/);
  const completed = await poll(call, created.body.id);
  assert.equal(completed.body.status, 'completed');
  assert.equal(completed.body.result.items[0].id, 'opaque-a');
  assert.ok(!JSON.stringify(completed).includes('SECRET_EMAIL_BODY'));
});

test('one worker, five queued jobs, cancellation, and retained result expiry', async t => {
  let active = 0;
  let peak = 0;
  const started = [];
  const call = await harness(t, (input, config, signal) => new Promise((resolve, reject) => {
    active++; peak = Math.max(peak, active); started.push(input.messages[0].id);
    signal.addEventListener('abort', () => { active--; reject(signal.reason); }, { once: true });
  }), { timeoutMs: 2000 });
  const first = await submit(call);
  const queued = [];
  for (let index = 0; index < 5; index++) queued.push(await submit(call, { messages: [sample(`next-${index}`)] }));
  assert.equal((await submit(call)).status, 429);
  assert.equal(started.length, 1);
  await call(`/v1/jobs/${queued[0].body.id}`, { method: 'DELETE' });
  await call(`/v1/jobs/${first.body.id}`, { method: 'DELETE' });
  await pause(30);
  assert.equal((await call(`/v1/jobs/${first.body.id}`)).body.status, 'cancelled');
  assert.equal(started[1], 'next-1');
  assert.equal(peak, 1);
});

test('expiry erases completed jobs', async t => {
  const call = await harness(t, async input => result(input), { retentionMs: 40 });
  const created = await submit(call);
  await poll(call, created.body.id);
  await pause(60);
  assert.equal((await call(`/v1/jobs/${created.body.id}`)).status, 404);
});

test('quota stops queued jobs and survives service restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-quota-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { cooldownFile: path.join(dir, 'cooldown.json') };
  let runs = 0;
  const call = await harness(t, async () => { runs++; throw new MailHarborError('quota_exhausted', 'provider private diagnostics'); }, config);
  const created = await submit(call);
  assert.equal((await poll(call, created.body.id)).body.error.code, 'quota_exhausted');
  assert.equal((await submit(call)).body.error.code, 'quota_exhausted');
  const state = JSON.parse(await readFile(config.cooldownFile, 'utf8'));
  assert.ok(state.blockedUntil > Date.now() + 4 * 3600000);
  const restarted = await harness(t, async input => { runs++; return result(input); }, config);
  assert.equal((await submit(restarted)).body.error.code, 'quota_exhausted');
  assert.equal(runs, 1);
});

test('timeout and login failures expose safe errors', async t => {
  const call = await harness(t, (input, config, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))), { timeoutMs: 20 });
  const created = await submit(call);
  assert.equal((await poll(call, created.body.id)).body.error.code, 'timeout');
  const login = await harness(t, async () => { throw new MailHarborError('login_required', 'token=secret'); });
  const loginJob = await submit(login);
  const failed = await poll(login, loginJob.body.id);
  assert.equal(failed.body.error.code, 'login_required');
  assert.ok(!JSON.stringify(failed).includes('token=secret'));
  assert.equal((await submit(login)).body.error.code, 'login_required');
});

test('login failure pauses queued jobs without starting another worker', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let runs = 0;
  const call = await harness(t, async () => {
    runs++;
    await gate;
    throw new MailHarborError('login_required', 'Authentication required');
  });
  const first = await submit(call);
  const queued = await submit(call, { messages: [sample('opaque-queued')] });
  assert.equal(queued.status, 202);
  release();
  for (const job of [first, queued]) {
    const failed = await poll(call, job.body.id);
    assert.equal(failed.body.status, 'failed');
    assert.equal(failed.body.error.code, 'login_required');
  }
  assert.equal((await submit(call)).body.error.code, 'login_required');
  assert.equal(runs, 1);
});

test('model output IDs and incomplete-message safety are enforced independently of runner', () => {
  assert.throws(() => createServer({ pairingToken: token, model: 'other' }), error => error.code === 'configuration_error');
  const input = validateRequest({ messages: [{ ...sample(), truncated: true }] });
  const output = result(input);
  output.items[0].recommendation = 'archive';
  assert.throws(() => validateResult(output, input), error => error.code === 'invalid_model_output');
  output.items[0].recommendation = 'keep'; output.items[0].id = 'injected-id';
  assert.throws(() => validateResult(output, input), error => error.code === 'invalid_model_output');
  assert.equal(MODEL, 'gemini-3.8-flash-high');
});
