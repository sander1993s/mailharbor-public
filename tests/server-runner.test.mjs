import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgyRunner } from '../server/runner.mjs';
import { createServer, closeServer } from '../server/app.mjs';
import { safeError } from '../server/validation.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const sample = id => ({ id, account: 'Private', author: 'Sender', subject: 'Subject', date: '', body: 'EMAIL_SECRET_SENTINEL', truncated: false, bodyUnavailable: false });
const input = () => ({ language: 'en', messages: [sample('opaque-a')] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness(t, scenario, { extraEvent, responseTemplate, providerError } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-runner-test-'));
  const report = path.join(root, 'report.json');
  const audit = { starts: 0, stdinBytes: 0 };
  const runner = createAgyRunner({
    validateProfile: async () => ({ env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_REPORT: report,
      ...(extraEvent ? { FAKE_EXTRA_EVENT: JSON.stringify(extraEvent) } : {}),
      ...(providerError !== undefined ? { FAKE_PROVIDER_ERROR: providerError } : {}),
      ...(responseTemplate !== undefined ? { FAKE_RESPONSE_TEMPLATE: responseTemplate } : {}) }, cwdRoot: root, agyPath: process.execPath }),
    spawnProcess: (executable, args, options) => {
      assert.equal(options.shell, false);
      assert.ok(args.includes('--sandbox'));
      assert.ok(args.includes('--remote-control=false'));
      assert.ok(args.includes('gemini-3.8-flash-high'));
      assert.ok(!args.join(' ').includes('EMAIL_SECRET_SENTINEL'));
      audit.starts++;
      const child = spawn(executable, [fixture, ...args], options);
      const end = child.stdin.end.bind(child.stdin);
      child.stdin.end = (...endArgs) => {
        if (typeof endArgs[0] === 'string' || Buffer.isBuffer(endArgs[0])) audit.stdinBytes += Buffer.byteLength(endArgs[0]);
        return end(...endArgs);
      };
      return child;
    }
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { runner, root, report, audit };
}

test('fake CLI round trip uses stdin only and removes scratch/log directory', async t => {
  const { runner, root, report } = await harness(t, 'success');
  const measurements = [];
  const output = await runner(input(), { timeoutMs: 3000, onMetrics: value => measurements.push(value) }, new AbortController().signal);
  assert.equal(output.items[0].id, 'opaque-a');
  const audit = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(audit.stdinEvent, 'user'); assert.equal(audit.containsBody, true);
  assert.ok(!audit.argv.join(' ').includes('EMAIL_SECRET_SENTINEL'));
  assert.deepEqual(await readdir(root), ['report.json']);
  assert.equal(measurements.length, 1);
  assert.deepEqual(Object.keys(measurements[0]).sort(), ['responseMs', 'startupMs']);
  for (const value of Object.values(measurements[0])) assert.ok(Number.isSafeInteger(value) && value >= 0 && value < 3000);
});

for (const [scenario, code] of [
  ['wrong_model', 'configuration_error'], ['tool', 'invalid_model_output'],
  ['malformed', 'invalid_model_output'], ['oversized', 'invalid_model_output'],
  ['duplicate_result', 'invalid_model_output'], ['link', 'invalid_model_output'],
  ['quota', 'quota_exhausted'], ['login', 'login_required'], ['duplicate_ids', 'invalid_model_output'],
  ['authentication_required', 'login_required'], ['auth_required', 'login_required'],
  ['keyring_locked', 'login_required'], ['secret_service_locked', 'login_required'],
  ['credential_access_failure', 'login_required'], ['credential_read_failure', 'login_required'],
  ['unsafe_archive', 'invalid_model_output']
]) test(`fake CLI ${scenario} is rejected`, async t => {
  const { runner, report } = await harness(t, scenario);
  const value = input();
  if (scenario === 'duplicate_ids') value.messages.push(sample('opaque-b'));
  if (scenario === 'unsafe_archive') value.messages[0].truncated = true;
  await assert.rejects(runner(value, { timeoutMs: 3000 }, new AbortController().signal), error => error.code === code);
  if (scenario === 'wrong_model') await assert.rejects(readFile(report), error => error.code === 'ENOENT');
});

test('timeout before init sends no email', async t => {
  const { runner, report } = await harness(t, 'stall_init');
  await assert.rejects(runner(input(), { timeoutMs: 100 }, new AbortController().signal), error => error.code === 'timeout');
  await assert.rejects(readFile(report), error => error.code === 'ENOENT');
});

for (const scenario of ['startup_auth', 'startup_auth_stderr']) test(`${scenario} before init reports login_required without a prompt`, async t => {
  const { runner, report, audit } = await harness(t, scenario);
  await assert.rejects(runner(input(), { timeoutMs: 3000 }, new AbortController().signal), error => error.code === 'login_required');
  assert.equal(audit.stdinBytes, 0);
  await assert.rejects(readFile(report), error => error.code === 'ENOENT');
});

test('actual startup-auth protocol pauses API queue with no prompt or second process', async t => {
  const { runner, audit } = await harness(t, 'startup_auth');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const token = 'fixture-only-token-abcdefghijklmnopqrstuvwxyz';
  const server = createServer({ pairingToken: token }, async (...args) => { await gate; return runner(...args); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, options = {}) => {
    const response = await fetch(base + url, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    return { status: response.status, body: await response.json() };
  };
  const first = await call('/v1/jobs', { method: 'POST', body: JSON.stringify(input()) });
  const queued = await call('/v1/jobs', { method: 'POST', body: JSON.stringify(input()) });
  assert.equal(first.status, 202); assert.equal(queued.status, 202);
  release();
  for (const job of [first, queued]) {
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await call(`/v1/jobs/${job.body.id}`);
      if (state.body.status === 'failed') break;
      await delay(10);
    }
    assert.equal(state.body.status, 'failed');
    assert.equal(state.body.error.code, 'login_required');
  }
  const denied = await call('/v1/jobs', { method: 'POST', body: JSON.stringify(input()) });
  assert.equal(denied.status, 503); assert.equal(denied.body.error.code, 'login_required');
  assert.equal(audit.starts, 1); assert.equal(audit.stdinBytes, 0);
});

test('cancellation kills the fake CLI and its child process tree', async t => {
  const { runner, report } = await harness(t, 'stall');
  const controller = new AbortController();
  const running = runner(input(), { timeoutMs: 5000 }, controller.signal);
  // Attach the rejection handler before cancellation to avoid unhandled rejections.
  const rejected = assert.rejects(running, error => error.code === 'cancelled');
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { state = JSON.parse(await readFile(report, 'utf8')); if (state.childPid) break; } catch {}
    await delay(10);
  }
  assert.ok(state?.childPid);
  controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
  await rejected;
  for (const pid of [state.parentPid, state.childPid]) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

for (const [scenario, stage, reason] of [
  ['malformed', 'stream_protocol', 'stream_json_invalid'],
  ['tool', 'stream_protocol', 'stream_tool_step'],
  ['oversized', 'stream_protocol', 'stream_line_limit'],
  ['duplicate_result', 'stream_protocol', 'stream_after_result'],
  ['duplicate_init', 'stream_protocol', 'stream_duplicate_init'],
  ['bad_event', 'stream_protocol', 'stream_event_invalid'],
  ['missing_result', 'stream_protocol', 'stream_result_missing'],
  ['invalid_json_response', 'json_parsing', 'response_json_invalid'],
  ['link', 'response_schema', 'response_shape_invalid'],
  ['quota', 'provider_limits', 'provider_quota']
]) test(`fake CLI ${scenario} exposes a fixed safe failure diagnostic`, async t => {
  const { runner, root } = await harness(t, scenario);
  await assert.rejects(runner(input(), { timeoutMs: 3000 }, new AbortController().signal), error => {
    assert.deepEqual(safeError(error).diagnostic, { stage, reason });
    assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_|EMAIL_SECRET|RESOURCE_EXHAUSTED|read_file/u);
    if (scenario === 'quota') assert.equal(error.cooldownMs, 7 * 86400000);
    return true;
  });
  assert.deepEqual(await readdir(root), ['report.json']);
});

for (const [name, extraEvent] of [
  ['empty arrays and objects', { event: 'step_update', step_update: { step_type: 'message', tool_info: {}, tool_name: '' }, tool_calls: [], function_call: {}, message: { tool_calls: [] } }],
  ['null optional fields', { event: 'step_update', step_update: { step_type: 'message', tool_info: null, tool_name: null }, tool_calls: null, function_call: null, message: { tool_calls: null } }]
]) test(`non-tool stream accepts ${name}`, async t => {
  const { runner } = await harness(t, 'success', { extraEvent });
  const output = await runner(input(), { timeoutMs: 3000 });
  assert.equal(output.items[0].id, 'opaque-a');
});

for (const [name, providerError, cooldownMs, reason = 'provider_quota'] of [
  ['unknown quota deadline', 'RESOURCE_EXHAUSTED quota exceeded', 5 * 3600000],
  ['weekly default', 'weekly quota exhausted', 7 * 86400000],
  ['weekly beats rate fallback', '429 weekly quota rate limit', 7 * 86400000],
  ['request rate default', 'rate limit exceeded', 60000, 'provider_rate_limit'],
  ['HTTP throttling default', 'HTTP 429 too many requests', 60000, 'provider_rate_limit'],
  ['explicit seconds', 'quota exceeded; retry in 90 seconds', 90000],
  ['compound duration', 'quota exceeded; retry after 1h 30m 5s', 5405000],
  ['joined compound duration', 'quota exceeded; retry in 1 hour and 30 minutes', 5400000],
  ['compact joined duration', 'quota exceeded; retry in1hour and30minutes', 5400000],
  ['comma joined duration', 'quota exceeded; retry in 1 hour, 30 minutes', 5400000],
  ['decimal duration', 'quota exceeded; retry in 1.5 minutes', 90000],
  ['precise seconds below minimum', 'quota exceeded; retry in44.069938944s', 60000],
  ['precise seconds round up', 'quota exceeded; retry in 90.069938944s', 90070],
  ['minimum delay', 'quota exceeded; retry after 200ms', 60000],
  ['weekly explicit reset', 'weekly quota exhausted; resets in 2 hours', 7200000],
  ['maximum delay', 'quota exceeded; retry after 30 days', 7 * 86400000],
  ['HTTP retry header', 'HTTP 429; Retry-After: 120', 120000, 'provider_rate_limit'],
  ['protobuf retry info', 'RESOURCE_EXHAUSTED {"retryDelay":"90.5s"}', 90500],
  ['precise protobuf retry info', 'RESOURCE_EXHAUSTED {"retryDelay":"90.069938944s"}', 90070],
  ['longest retry hint', 'quota exceeded; retry in 90 seconds; resets in 2 hours', 7200000],
  ['negative duration', 'quota exceeded; retry in -90 seconds', 5 * 3600000],
  ['zero duration', 'quota exceeded; retry after 0 seconds', 5 * 3600000],
  ['nonfinite duration', 'quota exceeded; retry in Infinity hours', 5 * 3600000],
  ['exponential duration', 'quota exceeded; retry after 1e3 seconds', 5 * 3600000],
  ['ambiguous range', 'quota exceeded; retry in 1-2 hours', 5 * 3600000],
  ['ambiguous alternative', 'quota exceeded; retry in 1 hour or 2 hours', 5 * 3600000],
  ['malformed later unit', 'quota exceeded; retry in 1h 30unknown', 5 * 3600000],
  ['malformed joined unit', 'quota exceeded; retry in 1 hour and 30monkeys', 5 * 3600000],
  ['missing later unit', 'quota exceeded; retry in 1 hour and 30', 5 * 3600000],
  ['missing later component', 'quota exceeded; retry in 1 hour and', 5 * 3600000],
  ['too many components', 'quota exceeded; retry in 1h 2m 3s 4ms 5s 6m 7h', 5 * 3600000],
  ['unlabeled duration', 'quota exceeded; job ran for 90 seconds', 5 * 3600000],
  ['invalid calendar date', 'quota exceeded; resets at 2099-02-30T00:00:00Z', 5 * 3600000],
  ['expired reset', 'quota exceeded; resets at 2000-01-01T00:00:00Z', 5 * 3600000],
  ['distant reset cap', 'quota exceeded; resets at 2099-01-01T00:00:00Z', 7 * 86400000]
]) test(`provider limit scheduling handles ${name} without exposing raw text`, async t => {
  const { runner } = await harness(t, 'success', { providerError: `${providerError}; PRIVATE_PROVIDER_SECRET` });
  await assert.rejects(runner(input(), { timeoutMs: 3000 }), error => {
    assert.equal(error.code, 'quota_exhausted');
    assert.equal(error.cooldownMs, cooldownMs);
    assert.deepEqual(safeError(error).diagnostic, { stage: 'provider_limits', reason });
    assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_PROVIDER_SECRET|retryDelay|RESOURCE_EXHAUSTED/u);
    return true;
  });
});

test('future UTC reset is converted into a bounded remaining delay', async t => {
  const reset = Date.now() + 120000;
  const { runner } = await harness(t, 'success', { providerError: `weekly quota exhausted; resets at ${new Date(reset).toISOString()}` });
  await assert.rejects(runner(input(), { timeoutMs: 3000 }), error => {
    assert.ok(error.cooldownMs >= reset - Date.now());
    assert.ok(error.cooldownMs <= 120000);
    assert.ok(error.cooldownMs >= 60000);
    return true;
  });
});

for (const [name, extraEvent, reason] of [
  ['tool event with empty metadata', { event: 'tool_call', tool_calls: [] }, 'stream_tool_event'],
  ['permission event with empty metadata', { event: 'permission_request', function_call: {} }, 'stream_permission_event'],
  ['tool step with empty metadata', { event: 'step_update', step_update: { step_type: 'tool', tool_info: {} } }, 'stream_tool_step'],
  ['nonempty tool info', { event: 'step_update', step_update: { step_type: 'message', tool_info: { name: 'PRIVATE_TOOL_SECRET' } } }, 'stream_tool_metadata'],
  ['nonempty tool name', { event: 'step_update', step_update: { step_type: 'message', tool_name: 'PRIVATE_TOOL_SECRET' } }, 'stream_tool_metadata'],
  ['nonempty top-level calls', { event: 'message', tool_calls: [{ name: 'PRIVATE_TOOL_SECRET' }] }, 'stream_tool_calls'],
  ['nonempty message calls', { event: 'message', message: { tool_calls: [{}] } }, 'stream_tool_calls'],
  ['nonempty function call', { event: 'message', function_call: { arguments: '{}' } }, 'stream_tool_calls'],
  ['wrong calls container', { event: 'message', tool_calls: {} }, 'stream_tool_metadata_invalid'],
  ['wrong nested calls container', { event: 'message', message: { tool_calls: '' } }, 'stream_tool_metadata_invalid'],
  ['wrong function container', { event: 'message', function_call: [] }, 'stream_tool_metadata_invalid'],
  ['wrong tool info container', { event: 'step_update', step_update: { tool_info: [] } }, 'stream_tool_metadata_invalid'],
  ['false calls', { event: 'message', tool_calls: false }, 'stream_tool_metadata_invalid'],
  ['zero function call', { event: 'message', function_call: 0 }, 'stream_tool_metadata_invalid'],
  ['false tool name', { event: 'step_update', step_update: { tool_name: false } }, 'stream_tool_metadata_invalid'],
  ['malformed step type', { event: 'step_update', step_update: { step_type: {} } }, 'stream_tool_metadata_invalid']
]) test(`stream still rejects ${name}`, async t => {
  const { runner } = await harness(t, 'success', { extraEvent });
  await assert.rejects(runner(input(), { timeoutMs: 3000 }), error => {
    assert.equal(error.code, 'invalid_model_output');
    assert.deepEqual(safeError(error).diagnostic, { stage: 'stream_protocol', reason });
    assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_TOOL_SECRET|arguments/u);
    return true;
  });
});

for (const [name, responseTemplate] of [
  ['json fence', '```json\n{{RESPONSE}}\n```'],
  ['bare fence', '```\n{{RESPONSE}}\n```'],
  ['CRLF fence', '```json\r\n{{RESPONSE}}\r\n```'],
  ['outer whitespace', ' \r\n```json\n{{RESPONSE}}\n```\r\n ']
]) test(`whole-response ${name} preserves validated output`, async t => {
  const { runner } = await harness(t, 'success', { responseTemplate });
  const result = await runner(input(), { timeoutMs: 3000 });
  assert.equal(result.items[0].id, 'opaque-a');
  assert.equal(result.items[0].recommendation, 'keep');
});

for (const [name, responseTemplate, reason] of [
  ['empty response', ' \r\n ', 'response_json_empty'],
  ['preamble', 'PRIVATE_RESPONSE_SECRET\n```json\n{{RESPONSE}}\n```', 'response_json_invalid'],
  ['suffix', '```json\n{{RESPONSE}}\n```\nPRIVATE_RESPONSE_SECRET', 'response_fence_invalid'],
  ['another language', '```javascript\n{{RESPONSE}}\n```', 'response_fence_invalid'],
  ['uppercase language', '```JSON\n{{RESPONSE}}\n```', 'response_fence_invalid'],
  ['multiple fences', '```json\n{{RESPONSE}}\n```\n```json\n{}\n```', 'response_fence_invalid'],
  ['inline fence', '```json {{RESPONSE}}```', 'response_fence_invalid'],
  ['unclosed fence', '```json\n{{RESPONSE}}', 'response_fence_invalid'],
  ['invalid fenced JSON', '```json\nPRIVATE_RESPONSE_SECRET {\n```', 'response_fenced_json_invalid']
]) test(`JSON transport rejects ${name} with a fixed diagnostic`, async t => {
  const { runner } = await harness(t, 'success', { responseTemplate });
  await assert.rejects(runner(input(), { timeoutMs: 3000 }), error => {
    assert.equal(error.code, 'invalid_model_output');
    assert.deepEqual(safeError(error).diagnostic, { stage: 'json_parsing', reason });
    assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_RESPONSE_SECRET|EMAIL_SECRET/u);
    return true;
  });
});

for (const scenario of ['unknown_field', 'link', 'duplicate_ids', 'unsafe_archive']) test(`fenced ${scenario} still fails full result validation`, async t => {
  const { runner } = await harness(t, scenario, { responseTemplate: '```json\n{{RESPONSE}}\n```' });
  const request = input();
  if (scenario === 'duplicate_ids') request.messages.push(sample('opaque-b'));
  if (scenario === 'unsafe_archive') request.messages[0].truncated = true;
  await assert.rejects(runner(request, { timeoutMs: 3000 }), error => {
    assert.equal(error.code, 'invalid_model_output');
    assert.equal(error.diagnostic.stage, 'response_schema');
    assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_RESPONSE_SECRET|EMAIL_SECRET|https:/u);
    return true;
  });
});
