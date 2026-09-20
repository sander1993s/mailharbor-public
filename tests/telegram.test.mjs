import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramSender, formatInquiryNotification } from '../server/telegram.mjs';

const token = '123456:synthetic_test_only_token_123456789';
const destination = { token, chatId: '987654' };
const json = (result, status = 200) => new Response(JSON.stringify({ ok: true, result }), { status, headers: { 'Content-Type': 'application/json' } });
const bot = { id: 123456, is_bot: true };
const chat = { id: 987654, type: 'private' };
function adapter(last, calls = []) {
  return createTelegramSender({ now: () => 1789900000000, fetcher: async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/getMe')) return json(bot);
    if (url.endsWith('/getChat')) return json(chat);
    return typeof last === 'function' ? last(url, options) : last;
  } });
}

test('read-only verification and outbound send use a fixed private destination and plain-text API', async () => {
  const calls = [], sender = adapter(json({ message_id: 42, chat, from: bot }), calls);
  assert.deepEqual(await sender.verify(destination), { botId: 123456, chatId: '987654', verifiedAt: new Date(1789900000000).toISOString() });
  assert.equal(calls.length, 2);
  assert.deepEqual(await sender.send({ ...destination, text: 'Een nieuwe aanvraag.' }), { messageId: 42, botId: 123456 });
  assert.equal(calls.length, 3);
  const sent = calls[2], payload = JSON.parse(sent.body);
  assert.equal(sent.url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(sent.redirect, 'error'); assert.equal(sent.method, 'POST'); assert.ok(sent.signal);
  assert.deepEqual(payload, { chat_id: '987654', text: 'Een nieuwe aanvraag.', link_preview_options: { is_disabled: true } });
});

test('sending verifies the destination first and rejects group chats or mismatched identities', async () => {
  for (const reply of [{ id: 987654, type: 'group' }, { id: 999, type: 'private' }]) {
    let sends = 0;
    const sender = createTelegramSender({ fetcher: async url => {
      if (url.endsWith('/getMe')) return json(bot);
      if (url.endsWith('/getChat')) return json(reply);
      sends++; return json({});
    } });
    await assert.rejects(sender.send({ ...destination, text: 'Test' }), error => error.code === 'telegram_configuration_error' && !error.uncertain);
    assert.equal(sends, 0);
  }
});

test('fresh account and destination checks run after verification immediately before send', async () => {
  const calls = [], sender = adapter(json({ message_id: 42, chat }), calls);
  const stale = Object.assign(new Error('Account changed'), { code: 'stale_message' });
  await assert.rejects(sender.send({ ...destination, text: 'Test', beforeSend() {
    assert.equal(calls.length, 2); throw stale;
  } }), error => error === stale);
  assert.equal(calls.length, 2);
  let checked = false;
  await sender.send({ ...destination, text: 'Test', beforeSend() { checked = true; assert.equal(calls.length, 2); } });
  assert.equal(checked, true); assert.equal(calls.length, 3);
});

test('credentials and content are bounded before any network call', async () => {
  let calls = 0;
  const sender = createTelegramSender({ fetcher: async () => { calls++; throw new Error(); } });
  for (const change of [{ token: 'bad' }, { chatId: '-100987654' }, { chatId: '@channel' }, { chatId: '1/other' },
    { text: 'x'.repeat(3501) }, { text: 'bad\u0000text' }, { text: '' }]) {
    await assert.rejects(sender.send({ ...destination, text: 'Test', ...change }), error => error.code === 'telegram_configuration_error');
  }
  assert.equal(calls, 0);
});

test('rate limits preserve safe retry timing and never leak Telegram descriptions or credentials', async () => {
  const sender = adapter(new Response(JSON.stringify({ ok: false, error_code: 429, description: `PRIVATE ${token}`, parameters: { retry_after: 23 } }), { status: 429 }));
  await assert.rejects(sender.send({ ...destination, text: 'Test' }), error => {
    assert.equal(error.code, 'telegram_rate_limited'); assert.equal(error.retryAfterMs, 23000); assert.equal(error.uncertain, false);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE|synthetic_test/u); return true;
  });
});

test('lost acknowledgements, malformed successes and wrong result destinations are uncertain', async () => {
  for (const last of [() => { throw new Error(`https://api.telegram.org/bot${token}/sendMessage`); }, new Response('not json'),
    json({ message_id: 0, chat }), json({ message_id: 10, chat: { id: 77, type: 'private' } }),
    new Response(JSON.stringify({ ok: false, description: 'PRIVATE' }), { status: 503 })]) {
    await assert.rejects(adapter(last).send({ ...destination, text: 'Test' }), error => {
      assert.equal(error.code, 'telegram_unavailable'); assert.equal(error.uncertain, true);
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE|synthetic_test/u); return true;
    });
  }
});

test('authentication errors and pre-aborted requests are safe definite failures', async () => {
  for (const status of [401, 403]) {
    const sender = adapter(new Response(JSON.stringify({ ok: false, error_code: status, description: 'PRIVATE' }), { status }));
    await assert.rejects(sender.send({ ...destination, text: 'Test' }), error => !error.uncertain && error.code === (status === 401 ? 'telegram_authentication_failed' : 'telegram_forbidden'));
  }
  let calls = 0;
  const sender = createTelegramSender({ fetcher: () => { calls++; } });
  await assert.rejects(sender.send({ ...destination, text: 'Test', signal: AbortSignal.abort() }), error => error.code === 'telegram_cancelled' && !error.uncertain);
  assert.equal(calls, 0);
});

test('rendered notification keeps trusted link and receipt time and limits untrusted display fields', () => {
  const text = formatInquiryNotification({ author: 'notify@web3forms.com', subject: 'Website\nhttps://evil.test', contactName: 'Alice', contactEmail: 'alice@example.test', date: '2026-09-20T14:58:35Z' },
    { summary: 'De klant vraagt een website.', requestedAction: 'Een offerte bezorgen.', explicitDeadline: null },
    { source: 'website_form', origin: 'https://mail.example.test/private?q=discard', reference: 'mh-42' });
  assert.match(text, /Websiteformulier/u); assert.match(text, /Alice \(alice@example.test\)/u);
  assert.match(text, /Ontvangen: 2026-09-20T14:58:35Z/u); assert.match(text, /MailHarbor: https:\/\/mail.example.test\/$/u);
  assert.doesNotMatch(text, /evil\.test|private\?q/u); assert.ok(text.length < 3500);
  assert.throws(() => formatInquiryNotification({}, { summary: 'Test' }, { origin: 'https://user:pass@example.test' }));
  const maximum = formatInquiryNotification({ author: 'a'.repeat(1000), subject: 'b'.repeat(1000), date: 'c'.repeat(1000) },
    { summary: 'd'.repeat(4000), requestedAction: 'e'.repeat(1000), explicitDeadline: 'f'.repeat(1000) },
    { reference: 'g'.repeat(1000), origin: 'https://mail.example.test' });
  assert.ok(maximum.length <= 3500);
});
