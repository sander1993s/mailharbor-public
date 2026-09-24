import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/agy-login-pty.py', import.meta.url));

for (const ignoreTerm of [false, true]) test(`Linux login terminal relays one code without echo and reaps child (ignore TERM: ${ignoreTerm})`,
  { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
    const childSource = [
      'import os, signal, sys, time',
      `signal.signal(signal.SIGTERM, signal.SIG_IGN if ${ignoreTerm ? 'True' : 'False'} else signal.SIG_DFL)`,
      'assert os.isatty(0) and os.isatty(1)',
      'print("READY:" + str(os.getpid()), flush=True)',
      'code = input()',
      'print("ACCEPTED:" + str(len(code)), flush=True)',
      'time.sleep(300)'
    ].join('\n');
    const child = spawn('/usr/bin/python3', [helper, '/usr/bin/python3', '-u', '-c', childSource], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { output += value; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value; });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    t.after(async () => { child.kill('SIGTERM'); await done; });
    const until = async check => {
      const deadline = Date.now() + 5000;
      while (!check()) { if (Date.now() > deadline) assert.fail(`Terminal did not respond: ${stderr}`); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    await until(() => /READY:(\d+)/.test(output));
    const pid = Number(/READY:(\d+)/.exec(output)[1]);
    child.stdin.write('synthetic-authorization-code\r');
    await until(() => output.includes('ACCEPTED:28'));
    assert.doesNotMatch(output, /synthetic-authorization-code/);
    child.stdin.end();
    await done;
    assert.equal(stderr, '');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
