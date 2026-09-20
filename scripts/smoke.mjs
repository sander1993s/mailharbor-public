import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Explicitly invoked test: this sends only the fixed synthetic email below to Google via Agy.
const configFile = process.env.MAILHARBOR_CONFIG || path.join(os.homedir(), '.config', 'mailharbor', 'config.json');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const token = (await readFile(config.tokenFile, 'utf8')).trim();
const base = `http://127.0.0.1:${config.port ?? 8765}`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
let serviceUp = false;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const status = await fetch(base + '/v1/status', { headers, redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (status.ok) { serviceUp = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!serviceUp) { console.error('MailHarbor service did not become reachable.'); process.exit(1); }
const input = { language: 'en', messages: [{ id: 'mailharbor-synthetic-1', account: 'Demo mailbox',
  author: 'Demo sender', subject: 'Meeting time confirmation', date: '2026-09-08T10:00:00Z',
  body: 'This is a synthetic test email. Please confirm whether Thursday at 14:00 works for our project meeting.',
  truncated: false, bodyUnavailable: false }] };
const response = await fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify(input), redirect: 'error' });
const job = await response.json();
if (response.status !== 202) { console.log(JSON.stringify(job)); process.exitCode = 1; }
else {
  console.log('Synthetic briefing requested. No real mailbox was read.');
  const deadline = Date.now() + 140000;
  process.exitCode = 1;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const state = await (await fetch(`${base}/v1/jobs/${job.id}`, { headers, redirect: 'error' })).json();
    if (['completed', 'failed', 'cancelled'].includes(state.status)) {
      console.log(JSON.stringify(state));
      process.exitCode = state.status === 'completed' ? 0 : 1;
      break;
    }
  }
  await fetch(`${base}/v1/jobs/${job.id}`, { method: 'DELETE', headers, redirect: 'error' });
}
