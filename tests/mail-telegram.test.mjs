import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNotificationStore } from '../server/notification-store.mjs';
import { createMailTelegram } from '../server/mail-telegram.mjs';

const formTrust = { subject: 'Nieuw verzoek via Example Software Solutions', sender: 'notify@web3forms.com', envelopeDomain: 'app.web3forms.com', mailboxHost: 'imap.example.com', trustedRelayHosts: ['relay.example.com'], relayAlias: 'transport.example.com', relayAddress: '192.0.2.20' };

const stamp = Date.parse('2026-09-20T16:00:00Z');
const account = { id: 'business-imap', email: 'business@example.com', host: 'imap.example.com', revision: 1 };
const token = '123456789:abcdefghijklmnopqrstuvwxyz123456789';
const body = 'Kunt u een offerte bezorgen voor een nieuwe website?';
const message = (uid, extra = {}) => ({ accountId: account.id, subject: 'Offerte gevraagd', author: 'Customer <customer@example.test>',
  to: account.email, date: new Date(stamp + 10000).toISOString(), receivedAt: new Date(stamp + 10000).toISOString(),
  body, headers: 'From: Customer <customer@example.test>\r\nSubject: Offerte gevraagd\r\n\r\n', truncated: false, bodyUnavailable: false,
  reference: { accountId: account.id, path: 'INBOX', uidValidity: '1', uid,
    fingerprint: createHash('sha256').update(`message:${uid}`).digest('hex') }, ...extra });
const result = m => ({ id: m.id, intent: 'inquiry', confidence: .98, evidence: body, summary: 'Een klant vraagt een offerte voor een nieuwe website.',
  requestedAction: 'Bezorg een offerte.', explicitDeadline: null, priority: 'normal' });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function harness(t, options = {}) {
  let time = stamp, data = {}, current = { ...account }, validity = '1', nextUid = 3;
  const rows = options.messages ?? [message(1), message(2)];
  const calls = { scans: [], reads: [], summaries: [], sends: [], checks: 0 };
  let state = await createNotificationStore(options.directory ?? null);
  const store = { read: () => structuredClone(data), update: async fn => { const draft = structuredClone(data); await fn(draft); data = draft; } };
  const reader = {
    checkpoint: async () => ({ path: 'INBOX', uidValidity: validity, afterUid: nextUid - 1 }),
    scan: async (_a, opts) => {
      await opts.verify(); calls.scans.push(opts.afterUid);
      if (opts.uidValidity !== validity) throw Object.assign(new Error(), { code: 'stale_message' });
      const selected = rows.filter(r => r.reference.uid > opts.afterUid).sort((a, b) => a.reference.uid - b.reference.uid).slice(0, opts.limit);
      const last = selected.at(-1)?.reference.uid ?? Math.max(opts.afterUid, nextUid - 1);
      return { messages: structuredClone(selected), uidValidity: validity, afterUid: last, done: last >= nextUid - 1 };
    },
    readNotification: async (_a, ref, opts) => {
      await opts.verify(); calls.reads.push(ref.uid);
      if (options.readError) throw Object.assign(new Error(), { code: 'mailbox_error' });
      const row = rows.find(r => r.reference.uid === ref.uid);
      if (!row) throw Object.assign(new Error(), { code: 'stale_message' });
      return structuredClone(row);
    }
  };
  const sender = {
    verify: async ({ chatId }) => { calls.checks++; return { botId: 123456789, chatId, label: 'Owner private chat' }; },
    send: async value => { calls.sends.push(value); return options.send ? options.send(value, calls.sends.length) : { messageId: calls.sends.length }; }
  };
  const createWorker = () => createMailTelegram({ store, state, accounts: { get: () => { if (!current) throw Object.assign(new Error(), { code: 'mailbox_login_required' }); return structuredClone(current); } },
    reader, sender, origin: 'https://mail.example.test', now: () => time, autoSchedule: false,
    summarize: async (request, signal) => { calls.summaries.push(request); return options.summarize ? options.summarize(request, signal) : { items: request.messages.map(result) }; } });
  let worker = createWorker();
  t.after(() => worker.close());
  return { get worker() { return worker; }, get state() { return state; }, store, rows, calls, reader, sender, options,
    async restart() { await worker.close(); state = await createNotificationStore(options.directory); worker = createWorker(); },
    advance(ms = 60000) { time += ms; },
    add(extra = {}) { const m = message(nextUid++, extra); rows.push(m); return m; },
    replaceAccount(value) { current = value; },
    resetUid(value) { validity = value; },
    async enable() { await worker.configure({ accountId: account.id, formTrust, language: 'nl-BE', token, chatId: '987654321', enabled: true }); },
    async process() { await worker.scan(); await worker.work(); }
  };
}

test('activation baselines history; a new inquiry sends once and a duplicate scan does not reclassify', async t => {
  const h = await harness(t); await h.enable(); await h.process();
  assert.equal(h.calls.sends.length, 0); assert.equal(h.calls.reads.length, 0);
  h.add(); await h.process();
  assert.equal(h.calls.sends.length, 1); assert.equal(h.calls.summaries.length, 1);
  assert.match(h.calls.sends[0].text, /Een klant vraagt/);
  await h.process(); assert.equal(h.calls.sends.length, 1);
  assert.equal(h.worker.settings().counts.sent, 1);
  assert.ok(!JSON.stringify(h.worker.settings()).includes(token));
});

test('verified website delivery identifies its customer, skips history and does not replay after restart', async t => {
  const website = { author: 'Notifications <notify@web3forms.com>', subject: 'Nieuw verzoek via Example Software Solutions',
    to: 'contact@business.example.com',
    body: `website  : \r\nname  : Fixture Person\r\ncompany  : Fixture Company\r\nemail  : fixture@example.test\r\nphone  : +32000000000\r\nneed  : ${body}\r\nconsent  : on`,
    headers: [
      'Received: from imap.example.com by imap.example.com with LMTP; Sun, 20 Sep 2026 18:00:10 +0200',
      'Received: from transport.example.com ([192.0.2.20]:46174 helo=relay.example.com) by imap.example.com with esmtps (envelope-from <fixture-#@app.web3forms.com>) for contact@business.example.com; Sun, 20 Sep 2026 18:00:09 +0200',
      'Received: from relay.example.com (localhost.localdomain [127.0.0.1]) by relay.example.com (ZXCS) with ESMTP; Sun, 20 Sep 2026 18:00:08 +0200',
      'Received-SPF: pass (app.web3forms.com: authorized envelope sender) receiver=relay.example.com; identity=mailfrom; envelope-from="fixture-#@app.web3forms.com"; helo=mail.amazonses.com; client-ip=192.0.2.35;',
      'Received: from mail.amazonses.com (mail.amazonses.com [192.0.2.35]) by relay.example.com with ESMTPS; Sun, 20 Sep 2026 18:00:07 +0200',
      'From: Notifications <notify@web3forms.com>', 'Subject: Nieuw verzoek via Example Software Solutions',
      'Auto-Submitted: auto-generated', '', ''
    ].join('\r\n') };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mail-telegram-form-'));
  await writeFile(path.join(directory, 'accounts.key'), randomBytes(32));
  const h = await harness(t, { directory, messages: [message(1, website), message(2)],
    summarize: async request => ({ items: request.messages.map(m => ({ ...result(m), intent: 'form_submission' })) }) });
  try {
    await h.enable(); await h.process();
    assert.equal(h.calls.summaries.length, 0); assert.equal(h.calls.sends.length, 0);
    h.add(website); await h.process();
    assert.equal(h.calls.summaries.length, 1); assert.equal(h.calls.summaries[0].messages[0].source, 'website_form');
    assert.equal(h.calls.sends.length, 1);
    assert.match(h.calls.sends[0].text, /Websiteformulier/u);
    assert.match(h.calls.sends[0].text, /Van: Fixture Person \(fixture@example.test\)/u);
    assert.doesNotMatch(h.calls.sends[0].text, /Van: Notifications/u);
    await h.process(); await h.restart(); await h.process();
    assert.equal(h.calls.summaries.length, 1); assert.equal(h.calls.sends.length, 1);
    assert.equal(h.worker.settings().counts.sent, 1);
  } finally { await h.worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('routine, low-confidence and incomplete candidates never send a generic fallback', async t => {
  const h = await harness(t, { summarize: async r => ({ items: r.messages.map(m => ({ ...result(m), intent: m.subject === 'Receipt' ? 'routine' : 'uncertain' })) }) });
  await h.enable(); h.add({ subject: 'Receipt' }); h.add({ subject: 'Unclear' }); h.add({ bodyUnavailable: true });
  await h.process();
  assert.equal(h.calls.sends.length, 0);
  assert.equal(h.worker.settings().counts.skipped, 1);
  assert.equal(h.worker.settings().counts.held, 2);
});

test('newsletter and explicit routing test skip before Agy; unread state is irrelevant', async t => {
  const h = await harness(t); await h.enable();
  h.add({ headers: 'List-ID: news.example.test\r\n\r\n' });
  h.add({ body: 'TEST MH-FORM-ROUTING-20260920-A7C4' });
  h.add({ unread: false }); await h.process();
  assert.equal(h.calls.summaries.length, 1); assert.equal(h.calls.sends.length, 1);
  assert.equal(h.worker.settings().counts.skipped, 2);
});

test('Telegram retries reuse saved summaries and honor the provider retry deadline', async t => {
  const h = await harness(t, { send: async (_v, n) => { if (n === 1) throw Object.assign(new Error(), { code: 'telegram_rate_limited', retryAfterMs: 120000 }); return { messageId: 8 }; } });
  await h.enable(); h.add(); await h.process();
  assert.equal(h.calls.sends.length, 1); assert.equal(h.calls.summaries.length, 1);
  await h.worker.work(); assert.equal(h.calls.sends.length, 1);
  h.advance(120001); await h.worker.work();
  assert.equal(h.calls.sends.length, 2); assert.equal(h.calls.summaries.length, 1);
  assert.equal(h.worker.settings().counts.sent, 1);
});

test('quota deadline is persisted; no repeated Agy calls or Telegram alert while blocked', async t => {
  const retryAt = new Date(stamp + DAY).toISOString();
  const h = await harness(t, { summarize: async () => { throw { code: 'quota_exhausted', retryAt }; } });
  await h.enable(); h.add(); await h.process();
  h.advance(60000); await h.worker.work();
  assert.equal(h.calls.summaries.length, 1); assert.equal(h.calls.sends.length, 0);
  assert.equal(h.worker.settings().error.retryAt, Date.parse(retryAt));
});
const DAY = 86400000;

test('pause during summary prevents delivery; resuming retains pending work', async t => {
  const gate = defer();
  const h = await harness(t, { summarize: async r => { await gate.promise; return { items: r.messages.map(result) }; } });
  await h.enable(); h.add(); await h.worker.scan();
  const working = h.worker.work(); await new Promise(r => setImmediate(r));
  await h.worker.configure({ enabled: false }); gate.resolve(); await working.catch(() => {});
  assert.equal(h.calls.sends.length, 0); assert.equal(h.worker.settings().counts.pending, 1);
  h.advance(60000); await h.worker.configure({ enabled: true }); await h.worker.work();
  assert.equal(h.calls.sends.length, 1);
});

test('account disconnect or a different destination holds stale queued work', async t => {
  const h = await harness(t); await h.enable(); h.add(); await h.worker.scan();
  await h.worker.configure({ chatId: '987654322' }); await h.worker.work();
  assert.equal(h.calls.sends.length, 0); assert.equal(h.calls.summaries.length, 0);
  assert.equal(h.worker.settings().counts.held, 1);
  h.replaceAccount(null); await assert.rejects(h.worker.scan());
  assert.equal(h.calls.sends.length, 0);
});

test('concurrent drains cannot send or classify a candidate twice', async t => {
  const h = await harness(t); await h.enable(); h.add(); await h.worker.scan();
  await Promise.all([h.worker.work(), h.worker.work(), h.worker.work()]);
  assert.equal(h.calls.summaries.length, 1); assert.equal(h.calls.sends.length, 1);
});

test('beforeMutation captures a new body before the provider moves it', async t => {
  const h = await harness(t); await h.enable(); const m = h.add();
  await h.worker.beforeMutation(account, { reason: 'move', references: [m.reference] });
  h.rows.splice(h.rows.indexOf(m), 1);
  await h.worker.work(); assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.reads.length, 1);
});

test('failed body capture defers a move, including after the discovery cursor advanced', async t => {
  const h = await harness(t, { readError: true }); await h.enable(); const m = h.add();
  for (let i = 0; i < 4; i++) await assert.rejects(h.worker.beforeMutation(account, { reason: 'move', references: [m.reference] }));
  assert.equal(h.calls.sends.length, 0);
});

test('UIDVALIDITY reset shows recovery and never replays the historical inbox', async t => {
  const h = await harness(t); await h.enable(); h.resetUid('2'); await h.process();
  assert.equal(h.calls.sends.length, 0);
  assert.equal(h.worker.settings().recovery.code, 'mailbox_identity_reset');
});

test('large arrival bursts drain beyond the UI cache window; all decisions persist', async t => {
  const h = await harness(t); await h.enable();
  for (let i = 0; i < 550; i++) h.add({ headers: 'List-ID: fixture.example.test\r\n\r\n' });
  for (let i = 0; i < 6; i++) await h.process();
  assert.equal(h.worker.settings().counts.skipped, 550);
  assert.equal(h.calls.summaries.length, 0); assert.equal(h.calls.sends.length, 0);
});

test('restoring old mail with a new UID does not notify', async t => {
  const h = await harness(t); await h.enable(); h.add({ receivedAt: new Date(stamp - DAY).toISOString() }); await h.process();
  assert.equal(h.calls.summaries.length, 0); assert.equal(h.calls.sends.length, 0);
});

test('configuration validates private delivery without sending; test action alone sends a test', async t => {
  const h = await harness(t); await h.worker.configure({ accountId: account.id, formTrust, language: 'nl-BE', token, chatId: '987654321' });
  assert.equal(h.calls.checks, 1); assert.equal(h.calls.sends.length, 0);
  await h.worker.test({}); assert.equal(h.calls.sends.length, 1);
  assert.match(h.calls.sends[0].text, /testbericht/);
  await assert.rejects(h.worker.configure({ enabled: true, accountId: 'private-gmail' }));
  await assert.rejects(h.worker.configure({ chatId: '-12345' }));
});

test('a completed acknowledgement is persisted even when disabled during HTTP', async t => {
  const gate = defer(); const h = await harness(t, { send: async () => { await gate.promise; return { messageId: 42 }; } });
  await h.enable(); h.add(); await h.worker.scan(); const working = h.worker.work();
  while (!h.calls.sends.length) await new Promise(r => setImmediate(r));
  await h.worker.configure({ enabled: false }); gate.resolve(); await working.catch(() => {});
  assert.equal(h.worker.settings().counts.sent, 1);
  await h.worker.configure({ enabled: true }); await h.worker.work(); assert.equal(h.calls.sends.length, 1);
});

test('account revision change resumes discovery while stale pending payloads remain held', async t => {
  const h = await harness(t); await h.enable(); h.add(); await h.worker.scan();
  h.replaceAccount({ ...account, revision: 2, archivePath: 'Archive' }); h.add(); await h.process();
  assert.equal(h.worker.settings().counts.held, 1);
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.worker.settings().recovery.code, 'account_revision_changed');
  h.add(); await h.process(); assert.equal(h.calls.sends.length, 2);
});

test('UID reset reconciles unknown recent identities to review and continues with new arrivals', async t => {
  const h = await harness(t);
  for (const m of h.rows) m.receivedAt = new Date(stamp - DAY).toISOString();
  await h.enable(); h.add(); await h.process();
  h.resetUid('2'); const recent = h.add();
  for (const m of h.rows) m.reference.uidValidity = '2';
  await h.process();
  assert.equal(h.calls.sends.length, 1); assert.equal(h.worker.settings().counts.held, 1);
  assert.equal(h.worker.settings().review[0].reason, 'mailbox_identity_reset');
  assert.ok(!h.calls.reads.includes(recent.reference.uid));
  h.add({ reference: { ...message(5).reference, uidValidity: '2' } }); await h.process();
  assert.equal(h.calls.sends.length, 2);
});

test('activation defers incoming moves while unrelated compose and read flags remain available', async t => {
  const h = await harness(t), gate = defer();
  h.sender.verify = async () => { await gate.promise; return { botId: 123456789, chatId: '987654321' }; };
  const enabling = h.enable(); await new Promise(r => setImmediate(r));
  const m = h.add();
  await assert.rejects(h.worker.beforeMutation(account, { reason: 'move', references: [m.reference] }), { code: 'busy' });
  await h.worker.beforeMutation(account, { reason: 'compose', references: [m.reference] });
  await h.worker.beforeMutation(account, { reason: 'apply', action: 'mark_read', references: [m.reference] });
  gate.resolve(); await enabling;
  await h.worker.close();
  await assert.rejects(h.worker.beforeMutation(account, { reason: 'move', references: [m.reference] }), { code: 'cancelled' });
});

test('held summaries and expired pending bodies are removed after seven days without egress', async t => {
  const h = await harness(t, { summarize: async r => ({ items: r.messages.map(m => ({ ...result(m), confidence: .5 })) }) });
  await h.enable(); h.add(); await h.process(); h.add(); await h.worker.scan();
  h.advance(8 * DAY); await h.worker.work();
  assert.equal(h.calls.summaries.length, 1); assert.equal(h.calls.sends.length, 0);
  for (const { value } of h.state.list('candidates')) {
    assert.ok(!value.input); assert.ok(!value.result); assert.ok(!value.text);
  }
});

test('durable restart preserves cursor, sent acknowledgements and uncertain retry state', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mail-telegram-restart-'));
  await writeFile(path.join(directory, 'accounts.key'), randomBytes(32));
  const h = await harness(t, { directory });
  try {
    await h.enable(); h.add(); await h.process(); await h.restart(); await h.process();
    assert.equal(h.calls.sends.length, 1); assert.equal(h.worker.settings().counts.sent, 1);
    h.add(); await h.worker.scan();
    const pending = h.state.list('candidates', { state: 'pending' })[0];
    const saved = { ...pending.value, state: 'sending', decision: 'eligible', input: null, text: 'Saved validated summary', sendAttempts: 1 };
    h.state.put('candidates', pending.key, saved, { state: 'sending', owner: saved.owner });
    await h.restart(); await h.worker.work(); assert.equal(h.calls.sends.length, 1);
    assert.equal(h.state.get('candidates', pending.key).uncertain, true);
    h.advance(60001); await h.worker.work(); assert.equal(h.calls.sends.length, 2);
    assert.equal(h.calls.summaries.length, 1); assert.equal(h.worker.settings().counts.sent, 2);
  } finally { await h.worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a selected arbitrary mailbox works without website-form configuration', async t => {
  const h = await harness(t), selected = { ...account, id: 'custom-mailbox-123', email: 'owner@example.test', label: 'My mailbox' };
  assert.equal(h.worker.settings().accountId, '');
  assert.equal(h.worker.settings().formTrust, null);
  await h.worker.configure({ token, chatId: '987654321' });
  await assert.rejects(h.worker.configure({ enabled: true }), { code: 'mailbox_login_required' });
  h.replaceAccount(selected);
  await h.worker.configure({ accountId: selected.id, enabled: true });
  h.add({ accountId: selected.id, reference: { ...message(3).reference, accountId: selected.id } });
  await h.process();
  assert.equal(h.calls.sends.length, 1);
  assert.match(h.calls.sends[0].text, /My mailbox/);
  assert.equal(h.worker.settings().accountId, selected.id);
});

test('switching the mailbox or trusted route never delivers earlier queued summaries', async t => {
  const h = await harness(t); await h.enable(); h.add(); await h.worker.scan();
  await h.worker.configure({ formTrust: { ...formTrust, subject: 'Another configured form' } });
  await h.worker.work();
  assert.equal(h.calls.sends.length, 0); assert.equal(h.worker.settings().counts.held, 1);
  h.add(); await h.worker.scan();
  const selected = { ...account, id: 'another-account', email: 'other@example.test' }; h.replaceAccount(selected);
  await h.worker.configure({ accountId: selected.id }); await h.worker.work();
  assert.equal(h.calls.sends.length, 0); assert.equal(h.worker.settings().counts.held, 2);
});
