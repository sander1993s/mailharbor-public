import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const scenario = process.env.LOGIN_SCENARIO;
if (process.env.LOGIN_MODE === 'probe') {
  if (scenario === 'orphan') {
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    descendant.once('message', () => {
      writeFileSync(process.env.LOGIN_REPORT, String(descendant.pid));
      process.stdout.write(`${JSON.stringify({ event: 'init', init: { model: 'gemini-3.8-flash-high', permission_mode: 'request-review', cwd: process.cwd() } })}\n`, () => process.exit(0));
    });
  }
  else if (scenario === 'probe_hang') setInterval(() => {}, 1000);
  else if (process.env.LOGIN_PROBE === '1' && scenario !== 'already_connected' || scenario === 'not_persisted') {
    if (scenario === 'auth_stderr') process.stderr.write('Authentication required PRIVATE_RAW_PROVIDER_DETAIL\n');
    process.stdout.write(`${JSON.stringify({ event: 'result', result: { status: 'ERROR', error: scenario === 'auth_stderr' ? 'startup failed' : 'Authentication required PRIVATE_RAW_PROVIDER_DETAIL' } })}\n`);
    process.exit(2);
  } else {
    process.stdout.write(`${JSON.stringify({ event: 'init', init: { model: scenario === 'wrong_model' ? 'unexpected' : 'gemini-3.8-flash-high',
      permission_mode: 'request-review', cwd: path.resolve(process.cwd()) } })}\n`);
    process.stdin.resume();
  }
} else {
  const url = 'https://accounts.google.com/o/oauth2/auth?client_id=synthetic-test&response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Fcallback&state=synthetic';
  if (scenario === 'huge') process.stdout.write('x'.repeat(300000));
  else {
    process.stdout.write(`\u001b[32mOpen the following URL in your local browser to authenticate:\u001b[0m\r\n${scenario === 'bad_url' ? url.replace('accounts.google.com', 'evil.example') : url}\r\n`);
    setTimeout(() => process.stdout.write('Enter the authorization code:'), 10);
  }
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', text => {
    pending += text;
    if (!/[\r\n]/.test(pending)) return;
    if (scenario === 'reject') process.stdout.write('failed to exchange authorization code for token: PRIVATE_SECRET\n');
    else if (scenario !== 'hang_after_code') process.stdout.write('Authentication successful!\n');
  });
}
