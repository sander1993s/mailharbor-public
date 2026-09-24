import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { validateProfile as defaultValidateProfile, MODEL } from './profile.mjs';
import { MailHarborError, safeError } from './validation.mjs';

const ACTIVE = new Set(['starting', 'awaiting_code', 'verifying']);
const MAX_OUTPUT = 256 * 1024;
const fail = code => new MailHarborError(code);
const terminalHelper = fileURLToPath(new URL('../scripts/agy-login-pty.py', import.meta.url));

// This is the CLI's own OAuth URL, never a caller-provided navigation target.
export function authorizationUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 8192) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.port || url.username || url.password || url.hash ||
        !['/o/oauth2/auth', '/o/oauth2/v2/auth'].includes(url.pathname) || url.searchParams.get('response_type') !== 'code' ||
        !url.searchParams.get('client_id') || !url.searchParams.get('redirect_uri') ||
        ['code', 'access_token', 'refresh_token', 'id_token'].some(key => url.searchParams.has(key))) return null;
    return url.href;
  } catch { return null; }
}

/** Login only: no email, model prompt, shell, token extraction, or saved codes. */
export function createAgyLogin(config, { onConnected = async () => {}, validateProfile = defaultValidateProfile,
  spawnProcess = spawn, platform = process.platform, timeoutMs = 10 * 60 * 1000, probeTimeoutMs = 20000 } = {}) {
  let current = null, closed = false;

  function snapshot(owner) {
    if (!current || current.owner !== owner) return { state: 'idle' };
    return { state: current.state,
      ...(ACTIVE.has(current.state) ? { expiresAt: new Date(current.deadline).toISOString() } : {}),
      ...(current.state === 'awaiting_code' ? { url: current.url } : {}),
      ...(current.error ? { error: current.error } : {}) };
  }
  function live(run) { return !closed && current === run && ACTIVE.has(run.state); }
  function launch(run, executable, args, options, helper = false) {
    if (!live(run)) throw fail('cancelled');
    const child = spawnProcess(executable, args, { ...options, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const proc = { child, helper, ended: false };
    proc.done = new Promise(resolve => {
      child.once('close', () => { proc.ended = true; resolve(); });
      child.once('error', () => {});
    });
    child.stdin.on('error', () => {});
    run.proc = proc;
    return proc;
  }
  async function stop(proc) {
    if (!proc) return;
    if (proc.stopping) return proc.stopping;
    proc.stopping = (async () => {
      const group = !proc.helper && process.platform !== 'win32' && proc.child.pid;
      if (proc.ended && !group) return;
      const signal = value => {
        try {
          if (group) process.kill(-proc.child.pid, value);
          else proc.child.kill(value);
        } catch {}
      };
      // The PTY helper forwards termination and reaps the separate Agy group.
      if (!proc.ended) proc.child.stdin.end();
      signal('SIGTERM');
      const timer = setTimeout(() => signal('SIGKILL'), 4000);
      try {
        // A companion can redirect its stdio and outlive the CLI parent. Finish
        // group cleanup even when the parent has already emitted close.
        if (group) { await new Promise(resolve => setTimeout(resolve, 200)); signal('SIGKILL'); }
        await proc.done;
      } finally { clearTimeout(timer); }
    })();
    return proc.stopping;
  }
  async function end(run, state, error) {
    if (!ACTIVE.has(run.state)) return run.cleanup;
    run.state = state; run.url = null; run.error = error ? safeError(error) : null;
    clearTimeout(run.timer);
    run.cleanup = stop(run.proc);
    return run.cleanup;
  }

  async function probe(run, profile) {
    const scratch = await mkdtemp(path.join(profile.cwdRoot, 'login-check-'));
    let proc;
    try {
      proc = launch(run, profile.agyPath, ['--remote-control=false', '--log-file', path.join(scratch, 'agy.log'),
        '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', MODEL,
        '--new-project', '--add-dir', scratch, '--print-timeout', '30s', '--sandbox'], { cwd: scratch, env: profile.env });
      await new Promise((resolve, reject) => {
        let bytes = 0, pending = '', stderr = '', providerError = '', settled = false;
        const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
        const timer = setTimeout(() => finish(fail('login_failed')), probeTimeoutMs);
        proc.child.stdout.setEncoding('utf8');
        proc.child.stdout.on('data', text => {
          if (settled) return;
          bytes += Buffer.byteLength(text);
          if (bytes > MAX_OUTPUT) return finish(fail('login_failed'));
          pending += text;
          let index;
          while ((index = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, index); pending = pending.slice(index + 1);
            if (!line.trim()) continue;
            let event;
            try { event = JSON.parse(line); } catch { return finish(fail('login_failed')); }
            if (event?.event === 'init' && event.init?.model === MODEL && event.init?.permission_mode === 'request-review' &&
                typeof event.init.cwd === 'string' && path.resolve(event.init.cwd) === scratch) return finish();
            if (event?.event === 'result' && event.result?.status === 'ERROR') {
              providerError = String(event.result.error ?? '');
              // Close drains both pipes; some CLI versions put the auth reason
              // only on stderr and a generic startup failure in JSON.
              void stop(proc); return;
            }
            return finish(fail('login_failed'));
          }
        });
        proc.child.stderr.setEncoding('utf8');
        proc.child.stderr.on('data', text => {
          bytes += Buffer.byteLength(text);
          if (bytes > MAX_OUTPUT) finish(fail('login_failed'));
          else stderr += text;
        });
        proc.child.once('error', () => finish(fail('login_unavailable')));
        proc.child.once('close', () => finish(fail(/auth|log.?in|sign.?in|credential|keyring|secret.?service/i.test(`${providerError}\n${stderr}`) ? 'login_required' : 'login_failed')));
      });
      // Initialization proves persisted auth with a fresh process. Never supply
      // a user event: stdin remains empty, so no model request is submitted.
      if (!live(run)) throw fail('cancelled');
      await validateProfile(config);
    } finally {
      await stop(proc);
      if (run.proc === proc) run.proc = null;
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async function interactive(run, profile) {
    if (platform !== 'linux') throw fail('login_unavailable');
    const scratch = await mkdtemp(path.join(profile.cwdRoot, 'login-'));
    let proc;
    try {
      proc = launch(run, '/usr/bin/python3', [terminalHelper, profile.agyPath, '--remote-control=false',
        '--log-file', path.join(scratch, 'agy.log'), '--new-project', '--sandbox'], {
        cwd: scratch,
        // Select Agy's documented remote code flow instead of opening a browser
        // on the homeserver. No inherited credentials or extra environment.
        env: { ...profile.env, SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 22', TERM: 'xterm', NO_COLOR: '1' }
      }, true);
      await new Promise((resolve, reject) => {
        let bytes = 0, output = '', settled = false;
        const finish = error => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
        const receive = text => {
          if (settled || !live(run)) return;
          bytes += Buffer.byteLength(text);
          if (bytes > MAX_OUTPUT) return finish(fail('login_failed'));
          output = stripVTControlCharacters(output + text);
          // Both pieces must be present. Merely printing a URL never enables
          // sending user input into a general-purpose agent terminal.
          if (run.state === 'starting' && /(?:Enter|Paste) the authorization code(?: below)?:/i.test(output)) {
            for (const candidate of output.match(/https:\/\/[^\s<>"'\x00-\x1f]+/g) ?? []) {
              const url = authorizationUrl(candidate);
              if (url) { run.url = url; run.state = 'awaiting_code'; break; }
            }
          }
          if (run.state === 'verifying' && /(?:Authentication successful!|Successfully authenticated\.|OAuth: authenticated successfully)/.test(output)) return finish();
          if (/failed to (?:exchange authorization code|read authorization code)|authentication failed|error storing|failed to (?:save|store|persist).*?(?:credential|token)|keyring.*locked/i.test(output)) return finish(fail('login_failed'));
        };
        proc.child.stdout.setEncoding('utf8'); proc.child.stderr.setEncoding('utf8');
        proc.child.stdout.on('data', receive); proc.child.stderr.on('data', receive);
        proc.child.once('error', () => finish(fail('login_unavailable')));
        proc.child.once('close', () => finish(fail('login_failed')));
      });
    } finally {
      await stop(proc);
      if (run.proc === proc) run.proc = null;
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async function runLogin(run) {
    try {
      const profile = await validateProfile(config);
      try { await probe(run, profile); }
      catch (error) {
        if (!live(run)) return;
        if (error.code !== 'login_required') throw error;
        await interactive(run, profile);
        if (!live(run)) return;
        run.state = 'verifying'; run.url = null;
        await probe(run, await validateProfile(config));
      }
      if (!live(run)) return;
      await onConnected();
      if (live(run)) await end(run, 'connected');
    } catch (error) {
      if (live(run)) await end(run, 'failed', ['configuration_error', 'login_unavailable'].includes(error?.code) ? error : fail('login_failed'));
    }
  }

  return {
    status: snapshot,
    start(owner) {
      if (closed) throw fail('busy');
      if (typeof owner !== 'string' || !owner) throw fail('unauthorized');
      if (current && (ACTIVE.has(current.state) || !current.finished)) {
        if (current.owner !== owner) throw fail('busy');
        return snapshot(owner);
      }
      const run = { owner, state: 'starting', deadline: Date.now() + timeoutMs, proc: null, finished: false };
      current = run;
      run.timer = setTimeout(() => { void end(run, 'failed', fail('login_expired')); }, timeoutMs);
      run.timer.unref?.();
      run.task = runLogin(run).finally(() => { run.finished = true; });
      return snapshot(owner);
    },
    submitCode(owner, code) {
      const run = current;
      if (!run || run.owner !== owner) throw fail('not_found');
      if (typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~+/=\-]{7,2047}$/.test(code)) throw fail('invalid_request');
      if (!live(run) || run.state !== 'awaiting_code' || !run.proc || run.proc.ended || Date.now() >= run.deadline) throw fail('invalid_request');
      run.state = 'verifying'; run.url = null;
      // Exactly one code, no arbitrary keystrokes, slash commands, or newlines.
      run.proc.child.stdin.write(`${code}\r`, error => { if (error && live(run)) void end(run, 'failed', fail('login_failed')); });
      return snapshot(owner);
    },
    async cancel(owner) {
      const run = current;
      if (!run || run.owner !== owner) throw fail('not_found');
      await end(run, 'cancelled');
      await run.task;
      return snapshot(owner);
    },
    async close() {
      closed = true;
      if (current) { await end(current, 'cancelled'); await current.task; }
      current = null;
    }
  };
}
