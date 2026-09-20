import test from 'node:test';
import assert from 'node:assert/strict';
import { assessInquiry as assessWithOptions, eligibleInquiry, inquiryText } from '../server/mail-inquiry-policy.mjs';

const formTrust = { subject: 'Nieuw verzoek via Example Software Solutions', sender: 'notify@web3forms.com', envelopeDomain: 'app.web3forms.com', mailboxHost: 'imap.example.com', trustedRelayHosts: ['relay.example.com'], relayAlias: 'transport.example.com', relayAddress: '192.0.2.20' };
const assessInquiry = (message, options = {}) => assessWithOptions(message, { formTrust, ...options });
const delivery = 'Received: from relay.example.com (relay.example.com [192.0.2.4]) by imap.example.com with ESMTP; Sun, 20 Sep 2026 16:58:35 +0200';
const ingress = 'Received: from mail.amazonses.com (mail.amazonses.com [192.0.2.5]) by relay.example.com with ESMTP; Sun, 20 Sep 2026 16:58:34 +0200';
const spf = 'Received-SPF: pass (envelope verified) receiver=relay.example.com; envelope-from="mail@app.web3forms.com"; client-ip=192.0.2.5;';
const formFields = ['From: Notifications <notify@web3forms.com>', 'Subject: Nieuw verzoek via Example Software Solutions', 'Auto-Submitted: auto-generated'];
const form = () => ({ id: 'form1', author: 'Notifications <notify@web3forms.com>', subject: 'Nieuw verzoek via Example Software Solutions',
  body: 'name: Alice\nemail: alice@example.test\nneed: Kunnen jullie een offerte voor een nieuwe website bezorgen?',
  headers: [delivery, spf, ingress, ...formFields].join('\r\n'), truncated: false, bodyUnavailable: false });
const direct = () => ({ id: 'direct1', author: 'Alice <alice@example.test>', subject: 'Offerte', body: 'Kunnen jullie een offerte voor een nieuwe website bezorgen?',
  headers: 'From: Alice <alice@example.test>\r\nSubject: Offerte\r\n\r\n', truncated: false, bodyUnavailable: false });
const classification = message => ({ id: message.id, intent: 'inquiry', confidence: 0.97, evidence: 'Kunnen jullie een offerte',
  summary: 'De klant vraagt een offerte.', requestedAction: 'Een offerte bezorgen.', explicitDeadline: null, priority: 'normal' });

test('a provider-authenticated Web3Forms channel bypasses its automated-mail marker but still needs content classification', () => {
  const message = form();
  const preflight = assessInquiry(message);
  assert.deepEqual(preflight, { action: 'classify', source: 'website_form', reason: 'verified_form_channel', contactName: 'Alice', contactEmail: 'alice@example.test' });
  assert.equal(eligibleInquiry(message, preflight, { ...classification(message), intent: 'form_submission' }).decision, 'eligible');
  assert.equal(eligibleInquiry(message, preflight, { ...classification(message), intent: 'spam' }).decision, 'skipped');
});

test('a configured LMTP, alias and loopback route keeps SPF above the external trust boundary', () => {
  const local = 'Received: from imap.example.com by imap.example.com with LMTP; Sun, 20 Sep 2026 16:58:35 +0200';
  const edge = 'Received: from transport.example.com ([192.0.2.20]:46174 helo=relay.example.com) by imap.example.com with esmtps (envelope-from <fixture-#@app.web3forms.com>) for info@example.test; Sun, 20 Sep 2026 16:58:35 +0200';
  const loopback = 'Received: from relay.example.com (localhost.localdomain [127.0.0.1]) by relay.example.com (ZXCS) with ESMTP; Sun, 20 Sep 2026 16:58:35 +0200';
  const authentication = spf.replace('mail@app.web3forms.com', 'fixture-#@app.web3forms.com');
  const headers = [local, edge, loopback, authentication, ingress, ...formFields].join('\r\n');
  const message = { ...form(), headers, body: 'website  : \r\nname  : Fixture Person\r\ncompany  : Fixture Company\r\nemail  : fixture@example.test\r\nphone  : +32000000000\r\nneed  : Kunnen jullie een offerte voor een website bezorgen?\r\nconsent  : on' };
  assert.equal(assessInquiry(message).action, 'classify');
  assert.equal(assessInquiry(message).contactName, 'Fixture Person');
  for (const forged of [headers.replace('192.0.2.20', '2001:db8::bad'),
    headers.replace('from relay.example.com', 'from attacker.test'),
    headers.replace('localhost.localdomain [127.0.0.1]', 'external.test [192.0.2.99]'),
    [local, edge, loopback, ingress, authentication, ...formFields].join('\r\n')]) {
    assert.equal(assessInquiry({ ...message, headers: forged }).action, 'hold');
  }
});

test('visible sender, subject and sender-added SPF can never authenticate a form', () => {
  for (const headers of [formFields.join('\n'), [spf, ...formFields].join('\n'),
    [delivery, ingress, spf, ...formFields].join('\n'),
    [delivery.replace('relay.example.com', 'attacker.test'), spf, ingress, ...formFields].join('\n'),
    [delivery, spf.replace('app.web3forms.com', 'attacker.test'), ingress, ...formFields].join('\n'),
    [delivery, spf, spf, ingress, ...formFields].join('\n'),
    [delivery, spf, ingress, ...formFields, 'From: attacker@example.test'].join('\n')]) {
    const message = { ...form(), headers };
    const preflight = assessInquiry(message);
    assert.equal(preflight.action, 'hold');
    assert.equal(eligibleInquiry(message, preflight, { ...classification(message), intent: 'form_submission' }).decision, 'held');
  }
  assert.equal(assessInquiry(form(), { formTrust: { ...formTrust, trustedRelayHosts: [] } }).action, 'hold');
});

test('explicit routing tests do not generate customer notifications', () => {
  for (const marker of ['MH-FORM-ROUTING-20260920-A7C4', 'This is a routing test', 'Testinzending']) {
    const message = form(); message.body += '\n' + marker;
    assert.deepEqual(assessInquiry(message), { action: 'skip', reason: 'routing_test', source: 'website_form' });
  }
});

test('lists, automated receipts, bounces and no-reply notices are excluded while a customer invoice question is classified', () => {
  for (const headers of ['List-ID: news.example.test', 'List-Unsubscribe: <https://example.test/unsubscribe>', 'Precedence: bulk',
    'Auto-Submitted: auto-replied', 'Return-Path: <>', 'Content-Type: multipart/report; report-type=delivery-status']) {
    assert.equal(assessInquiry({ ...direct(), headers }).action, 'skip');
  }
  assert.equal(assessInquiry({ ...direct(), author: 'Service <no-reply@example.test>' }).action, 'skip');
  const message = { ...direct(), subject: 'Vraag over mijn factuur', body: 'Kan je de omschrijving op mijn factuur verduidelijken?' };
  assert.equal(assessInquiry(message).action, 'classify');
  assert.equal(assessInquiry({ ...message, headers: 'Auto-Submitted: no' }).action, 'classify');
});

test('current text and exact evidence gate direct inquiries and substantive follow-ups', () => {
  const message = direct(), preflight = assessInquiry(message), result = classification(message);
  assert.equal(eligibleInquiry(message, preflight, result).decision, 'eligible');
  for (const altered of [{ confidence: 0.89 }, { confidence: Infinity }, { evidence: 'invented evidence' }, { intent: 'uncertain' },
    { intent: 'form_submission' }, { id: 'other' }, { summary: '' }]) {
    assert.equal(eligibleInquiry(message, preflight, { ...result, ...altered }).decision, 'held');
  }
  assert.equal(eligibleInquiry({ ...message, truncated: true }, preflight, result).decision, 'held');
  assert.equal(eligibleInquiry(message, preflight, result, { threshold: 0.5 }).decision, 'held');
  const reply = { ...message, body: 'Bedankt!\n\nOn Sunday, Alice wrote:\nKunnen jullie een offerte voor een nieuwe website bezorgen?' };
  assert.equal(inquiryText(reply.body), 'Bedankt!');
  assert.equal(eligibleInquiry(reply, assessInquiry(reply), result).decision, 'held');
  for (const boundary of ['> Quoted request', 'Op zondag schreef Alice:', '-----Original Message-----', 'From: Alice\nSent: Sunday']) {
    assert.equal(inquiryText('Nieuwe vraag\n' + boundary + '\nold body'), 'Nieuwe vraag');
  }
});

test('unavailable, empty, malformed and oversized inputs are held', () => {
  for (const change of [{ body: '' }, { bodyUnavailable: true }, { headers: 'broken header' }, { headers: 'X-Fill: ' + 'a'.repeat(32768) }, { body: '\u0000bad' }]) {
    assert.equal(assessInquiry({ ...direct(), ...change }).action, 'hold');
  }
  assert.equal(assessInquiry({ ...form(), body: 'name: Alice\nemail: alice@example.test' }).reason, 'form_fields_incomplete');
});

test('absent and blank headers cannot bypass automated-mail screening', () => {
  for (const headers of [undefined, null, '', ' \r\n\t', '\r\nFrom: Alice <alice@example.test>']) {
    const message = { ...direct(), headers };
    assert.deepEqual(assessInquiry(message), { action: 'hold', reason: 'headers_invalid', source: 'direct' });
    assert.equal(eligibleInquiry(message, assessInquiry(message), classification(message)).decision, 'held');
  }
  assert.equal(assessInquiry({ ...direct(), headers: '', body: 'MH-FORM-ROUTING-20260920-A7C4' }).action, 'skip');
});

test('new installations trust no form route while direct inquiries remain available', () => {
  assert.equal(assessWithOptions(form()).reason, 'form_provenance_unverified');
  assert.equal(assessWithOptions(direct()).reason, 'direct_candidate');
  for (const change of [{ trustedRelayHosts: [] }, { relayAddress: '' }, { envelopeDomain: 'bad domain' },
    { sender: 'Person <sender@example.test>' }, { mailboxHost: '' }]) {
    assert.equal(assessWithOptions(form(), { formTrust: { ...formTrust, ...change } }).action, 'hold');
  }
});

test('a user-configured form provider requires its own sender, envelope and transport chain', () => {
  const configured = { ...formTrust, subject: 'Contact request', sender: 'forms@example.test', envelopeDomain: 'forms.example.test' };
  const value = form();
  for (const key of ['author', 'subject', 'headers']) value[key] = value[key]
    .replaceAll(formTrust.subject, configured.subject).replaceAll(formTrust.sender, configured.sender)
    .replaceAll(formTrust.envelopeDomain, configured.envelopeDomain);
  assert.equal(assessWithOptions(value, { formTrust: configured }).reason, 'verified_form_channel');
  assert.equal(assessWithOptions({ ...value, headers: value.headers.replace('envelope-from="mail@forms.example.test"', 'envelope-from="mail@attacker.test"') },
    { formTrust: configured }).reason, 'form_provenance_unverified');
});
