// Local protocol fixture only. This file never contacts a provider.
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const scenario = process.env.FAKE_SCENARIO ?? 'success';
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const report = value => { if (process.env.FAKE_REPORT) writeFileSync(process.env.FAKE_REPORT, JSON.stringify(value)); };
const init = { event: 'init', init: { cwd: process.cwd(), model: scenario === 'wrong_model' ? 'other-model' : 'gemini-3.8-flash-high', permission_mode: 'request-review' } };
if (scenario === 'startup_auth' || scenario === 'startup_auth_stderr') {
  process.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\n");
  emit({ event: 'result', result: {
    conversation_id: '', status: 'ERROR', response: '',
    error: scenario === 'startup_auth' ? 'authentication failed or timed out' : 'startup failed',
    duration_seconds: 0, num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }
  } });
  setTimeout(() => process.exit(1), 30);
}
else if (scenario === 'stall_init') setInterval(() => {}, 1000);
else emit(init);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  if (!stdin.trim()) return;
  const event = JSON.parse(stdin);
  const prompt = event.message.content;
  const request = JSON.parse(prompt.slice(prompt.indexOf('\n{"language"') + 1));
  report({ argv: process.argv.slice(2), stdinEvent: event.event, messages: request.messages.length, containsBody: prompt.includes(request.messages[0].body) });
  if (scenario === 'stall') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', windowsHide: true });
    report({ childPid: child.pid, parentPid: process.pid });
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === 'tool') { emit({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'read_file' } }); setInterval(() => {}, 1000); return; }
  if (scenario === 'malformed') { process.stdout.write('not json\n'); return; }
  if (scenario === 'missing_result') return;
  if (scenario === 'duplicate_init') { emit(init); return; }
  if (scenario === 'bad_event') { emit({ event: 42, private: 'PRIVATE_STREAM_SECRET' }); return; }
  if (scenario === 'invalid_json_response') {
    emit({ event: 'result', result: { status: 'SUCCESS', response: 'PRIVATE_RESPONSE_SECRET{invalid json' } }); return;
  }
  if (scenario === 'oversized') { process.stdout.write('x'.repeat(300000)); return; }
  const providerErrors = {
    quota: 'RESOURCE_EXHAUSTED weekly quota', login: 'Unauthenticated: sign in required',
    authentication_required: 'Authentication required', auth_required: 'Auth required',
    keyring_locked: 'Keyring is locked', secret_service_locked: 'org.freedesktop.Secret.Error.IsLocked',
    credential_access_failure: 'Credential access failure', credential_read_failure: 'Failed to read credentials from the credential store'
  };
  if (Object.hasOwn(providerErrors, scenario)) {
    emit({ event: 'result', result: { status: 'ERROR', error: providerErrors[scenario] } }); return;
  }
  if (process.env.FAKE_PROVIDER_ERROR !== undefined) {
    emit({ event: 'result', result: { status: 'ERROR', error: process.env.FAKE_PROVIDER_ERROR } }); return;
  }
  const result = {
    briefing: 'One message needs review.',
    items: request.messages.map(message => ({ id: message.id, summary: 'A message.', priority: 'normal', category: 'other', recommendation: scenario === 'unsafe_archive' ? 'archive' : 'keep', reason: 'Review it.' }))
  };
  if (process.env.FAKE_EXTRA_EVENT) emit(JSON.parse(process.env.FAKE_EXTRA_EVENT));
  if (scenario === 'duplicate_ids' && result.items.length > 1) result.items[1].id = result.items[0].id;
  if (scenario === 'link') result.briefing = 'Open https://example.com/secret';
  if (scenario === 'unknown_field') result.private = 'PRIVATE_RESPONSE_SECRET';
  const response = process.env.FAKE_RESPONSE_TEMPLATE === undefined ? JSON.stringify(result) :
    process.env.FAKE_RESPONSE_TEMPLATE.replace('{{RESPONSE}}', JSON.stringify(result));
  const final = { event: 'result', result: { status: 'SUCCESS', response } };
  emit(final);
  if (scenario === 'duplicate_result') emit(final);
});
