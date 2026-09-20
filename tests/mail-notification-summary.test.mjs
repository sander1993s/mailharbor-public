import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationSummary, validateNotificationSummaryRequest, notificationSummaryResult, notificationSummaryPrompt } from '../server/mail-notification-summary.mjs';
import { MODEL } from '../server/validation.mjs';

const input = () => ({ language: 'nl-BE', messages: [{ id: 'opaque-inquiry', author: 'Alice', subject: 'Website quote', to: 'info@example.test',
  date: '2026-09-20', body: 'Could you send a quote for a website?', truncated: false, bodyUnavailable: false, source: 'direct' }] });
const output = request => ({ items: request.messages.map(message => ({ id: message.id, intent: 'inquiry', confidence: 0.99,
  evidence: 'Could you send a quote', summary: 'De klant vraagt een offerte voor een website.', requestedAction: 'Een offerte bezorgen.', explicitDeadline: null, priority: 'normal' })) });

test('summary adapter pins the model and sends only bounded current content', async () => {
  const request = input(); request.messages[0].body += '\n\nOn Sunday, Alice wrote:\nPRIVATE_QUOTED_HISTORY';
  let calls = 0;
  const run = createNotificationSummary({ run: async (data, config) => {
    calls++; assert.equal(config.model, MODEL); assert.doesNotMatch(JSON.stringify(data), /PRIVATE_QUOTED_HISTORY/u);
    return output(data);
  } });
  assert.equal((await run(request)).items[0].id, 'opaque-inquiry');
  await assert.rejects(run(request, { model: 'other-model' }), error => error.code === 'configuration_error');
  assert.equal(calls, 1);
});

test('summary requests reject extra data, arbitrary sources, duplicated identities and excessive content', () => {
  for (const alter of [request => { request.telegramToken = 'PRIVATE'; }, request => { request.messages[0].rawHeaders = 'PRIVATE'; },
    request => { request.messages[0].source = 'model_verified'; }, request => { request.messages[0].body = 'x'.repeat(8001); },
    request => { request.messages.push(request.messages[0]); }, request => { request.messages[0].bodyUnavailable = 'false'; }]) {
    const request = input(); alter(request);
    assert.throws(() => validateNotificationSummaryRequest(request), error => error.code === 'invalid_request');
  }
});

test('summary results require exact identities, exact current evidence and strict plain text fields', () => {
  const request = input();
  for (const change of [{ id: 'invented' }, { evidence: 'invented evidence' }, { evidence: 'Could' }, { summary: 'https://attacker.test' },
    { summary: '<b>Offer</b>' }, { summary: '**Offer**' }, { summary: 'ssh://attacker.test' }, { summary: 'mailto:attacker@example.test' },
    { requestedAction: '`shell`' }, { explicitDeadline: '' },
    { confidence: '0.99' }, { confidence: 1.1 }, { intent: 'verified' }, { priority: 'urgent' }, { tool: 'send' }]) {
    const result = output(request); Object.assign(result.items[0], change);
    assert.throws(() => notificationSummaryResult(result, request), error => error.code === 'invalid_model_output');
  }
  const result = output(request); result.items[0].explicitDeadline = 'Volgende vrijdag, zoals gevraagd.';
  assert.equal(notificationSummaryResult(result, request).items[0].requestedAction, 'Een offerte bezorgen.');
  request.messages[0].body = 'Thanks\n> Could you send a quote';
  assert.throws(() => notificationSummaryResult(output(request), request), error => error.code === 'invalid_model_output');
});

test('prompt treats source and email as data and requires no tools or fallback alerts', () => {
  const prompt = notificationSummaryPrompt(input());
  assert.match(prompt, /UNTRUSTED DATA/u); assert.match(prompt, /No tools/u);
  assert.match(prompt, /model cannot authenticate/u); assert.match(prompt, /never subject/u);
  assert.match(prompt, /Do not generate fallback or failure alerts/u);
});
