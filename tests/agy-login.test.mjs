import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { authorizationUrl, createAgyLogin } from '../server/agy-login.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-agy-login.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) assert.fail('Login state did not settle'); await pause(10); }
}
async function setup(t, scenario = 'success', options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-login-test-'));
  let connections = 0, probes = 0, validations = 0;
  const calls = [], writes = [];
  const login = createAgyLogin({}, {
    platform: 'linux', timeoutMs: 5000, probeTimeoutMs: 2000,
    validateProfile: async () => { validations++; return { agyPath: process.execPath, cwdRoot: root, env: { HOME: root } }; },
    onConnected: async () => { connections++; },
    spawnProcess(executable, args, config) {
      const mode = args.includes('--input-format') ? 'probe' : 'interactive';
      if (mode === 'probe') probes++;
      calls.push({ executable, args, config, mode });
      assert.equal(config.shell, false);
      assert.equal(config.windowsHide, true);
      assert.ok(args.includes('--remote-control=false'));
      assert.ok(args.includes('--sandbox'));
      const child = spawn(process.execPath, [fixture], { ...config, env: { ...process.env,
        LOGIN_MODE: mode, LOGIN_PROBE: String(probes), LOGIN_SCENARIO: scenario, LOGIN_REPORT: path.join(root, 'descendant.pid') } });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (value, ...rest) => { writes.push({ mode, value: String(value) }); return write(value, ...rest); };
      return child;
    }, ...options
  });
  t.after(async () => { await login.close(); await rm(root, { recursive: true, force: true }); });
  return { login, root, calls, writes, connected: () => connections, validations: () => validations };
}

test('remote browser code flow verifies persisted auth with zero model input and cleans scratch', async t => {
  const h = await setup(t);
  assert.deepEqual(h.login.status('owner'), { state: 'idle' });
  assert.equal(h.calls.length, 0, 'GET is entirely passive');
  assert.equal(h.login.start('owner').state, 'starting');
  await until(() => h.login.status('owner').state === 'awaiting_code');
  const pending = h.login.status('owner');
  assert.equal(new URL(pending.url).hostname, 'accounts.google.com');
  assert.ok(Date.parse(pending.expiresAt) > Date.now());
  const interactive = h.calls.find(call => call.mode === 'interactive');
  assert.equal(interactive.executable, '/usr/bin/python3');
  assert.equal(interactive.config.env.HOME, h.root);
  assert.ok(interactive.config.env.SSH_CONNECTION);
  assert.equal(interactive.config.env.GOOGLE_API_KEY, undefined);
  assert.equal(h.login.submitCode('owner', '4/synthetic-code-only').state, 'verifying');
  assert.equal(h.login.status('owner').url, undefined);
  assert.throws(() => h.login.submitCode('owner', '4/synthetic-code-only'), { code: 'invalid_request' });
  await until(() => h.login.status('owner').state === 'connected');
  assert.equal(h.connected(), 1);
  assert.deepEqual(h.writes, [{ mode: 'interactive', value: '4/synthetic-code-only\r' }]);
  assert.equal(h.calls.filter(call => call.mode === 'probe').length, 2);
  assert.ok(h.validations() >= 3);
  assert.deepEqual(await readdir(h.root), []);
  assert.doesNotMatch(JSON.stringify(h.login.status('owner')), /synthetic-code|PRIVATE/);
});

test('already valid persisted credentials clear a stale pause without interactive login', async t => {
  const h = await setup(t, 'already_connected');
  h.login.start('owner');
  await until(() => h.login.status('owner').state === 'connected');
  assert.equal(h.connected(), 1);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.writes, []);
});

test('authentication failures reported only on stderr still offer browser sign-in', async t => {
  const h = await setup(t, 'auth_stderr');
  h.login.start('owner');
  await until(() => h.login.status('owner').state === 'awaiting_code');
  assert.equal(new URL(h.login.status('owner').url).hostname, 'accounts.google.com');
  assert.doesNotMatch(JSON.stringify(h.login.status('owner')), /PRIVATE_RAW_PROVIDER_DETAIL|startup failed/);
  await h.login.cancel('owner');
});

test('Linux credential probe kills detached-stdio companions even after the parent exits', { skip: process.platform !== 'linux' }, async t => {
  const h = await setup(t, 'orphan');
  h.login.start('owner');
  await until(() => h.login.status('owner').state === 'connected');
  const pid = Number(await readFile(path.join(h.root, 'descendant.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  // A killed orphan may briefly remain a zombie until PID 1 reaps it.
  let info;
  try { info = await readFile(`/proc/${pid}/stat`, 'utf8'); } catch (error) { assert.equal(error.code, 'ENOENT'); }
  if (info) assert.match(info, /^\d+ \([^)]*\) Z /);
});

test('only initiating browser sees or controls login; duplicate starts do not spawn again', async t => {
  const h = await setup(t);
  h.login.start('owner'); h.login.start('owner');
  assert.deepEqual(h.login.status('other'), { state: 'idle' });
  assert.throws(() => h.login.start('other'), { code: 'busy' });
  assert.throws(() => h.login.submitCode('other', '4/synthetic-code'), { code: 'not_found' });
  await assert.rejects(h.login.cancel('other'), { code: 'not_found' });
  await until(() => h.login.status('owner').state === 'awaiting_code');
  for (const code of ['/logout', '/command-prompt', 'abc\n/exit', 'abc\rdefgh', 'a'.repeat(2049), 'short', 'a b c d e', '\x1b[31mhello']) {
    assert.throws(() => h.login.submitCode('owner', code), { code: 'invalid_request' });
  }
  assert.equal(h.login.status('owner').state, 'awaiting_code');
  assert.deepEqual(h.writes, []);
  assert.equal((await h.login.cancel('owner')).state, 'cancelled');
  assert.equal(h.calls.length, 2);
  assert.equal(h.connected(), 0);
  assert.deepEqual(await readdir(h.root), []);
});

for (const scenario of ['not_persisted', 'reject', 'wrong_model']) test(`${scenario} cannot report connected or leak raw provider text`, async t => {
  const h = await setup(t, scenario);
  h.login.start('owner');
  await until(() => h.login.status('owner').state === 'awaiting_code');
  h.login.submitCode('owner', '4/synthetic-code');
  await until(() => h.login.status('owner').state === 'failed');
  assert.equal(h.connected(), 0);
  assert.equal(h.login.status('owner').error.code, 'login_failed');
  assert.doesNotMatch(JSON.stringify(h.login.status('owner')), /PRIVATE|synthetic-code/);
});

for (const scenario of ['bad_url', 'probe_hang', 'hang_after_code']) test(`${scenario} expires and is cancellable`, async t => {
  const h = await setup(t, scenario, { timeoutMs: 2000, probeTimeoutMs: 5000 });
  h.login.start('owner');
  if (scenario === 'hang_after_code') {
    await until(() => h.login.status('owner').state === 'awaiting_code');
    h.login.submitCode('owner', '4/synthetic-code');
  }
  await until(() => h.login.status('owner').state === 'failed');
  assert.equal(h.login.status('owner').error.code, 'login_expired');
  await h.login.close();
  assert.equal(h.connected(), 0);
  assert.deepEqual(await readdir(h.root), []);
});

test('bounded output and missing runtime fail safely; profile failures launch nothing', async t => {
  const huge = await setup(t, 'huge'); huge.login.start('owner');
  await until(() => huge.login.status('owner').state === 'failed');
  assert.equal(huge.login.status('owner').error.code, 'login_failed');
  const invalid = await setup(t, 'success', { validateProfile: async () => { throw Object.assign(new Error('PRIVATE_PATH'), { code: 'configuration_error' }); } });
  invalid.login.start('owner');
  await until(() => invalid.login.status('owner').state === 'failed');
  assert.equal(invalid.calls.length, 0);
  assert.equal(invalid.login.status('owner').error.code, 'configuration_error');
  const unavailable = await setup(t, 'success', { platform: 'win32' }); unavailable.login.start('owner');
  await until(() => unavailable.login.status('owner').state === 'failed');
  assert.equal(unavailable.login.status('owner').error.code, 'login_unavailable');
});

test('close during profile validation prevents a late process launch', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = await setup(t, 'success', { validateProfile: async () => { await blocked; return { agyPath: process.execPath, cwdRoot: h.root, env: {} }; } });
  h.login.start('owner');
  const closing = h.login.close(); release(); await closing;
  assert.equal(h.calls.length, 0);
  assert.equal(h.connected(), 0);
  assert.throws(() => h.login.start('owner'), { code: 'busy' });
});

test('OAuth links require the exact Google HTTPS authorization endpoint and no credentials', () => {
  const valid = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=test&redirect_uri=https%3A%2F%2Fantigravity.google%2Fcallback';
  const withUser = new URL(valid); withUser.username = 'synthetic-user';
  assert.equal(authorizationUrl(valid), valid);
  for (const bad of [valid.replace('https:', 'http:'), valid.replace('accounts.google.com', 'accounts.google.com.evil.example'),
    withUser.href, valid.replace('v2/auth', 'logout'), `${valid}&access_token=secret`, `${valid}#fragment`]) {
    assert.equal(authorizationUrl(bad), null);
  }
});
