import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { createAccountSetup } from '../web/account-setup.mjs';
import { MAIL_PROVIDERS, accountDefinition } from '../server/providers.mjs';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this._value = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  addEventListener(name, callback) { this.events[name] = callback; }
  set value(value) { this._value = String(value); }
  get value() { return this.tag === 'select' && !this.children.some(item => item.value === this._value) ? this.children[0]?.value ?? '' : this._value; }
  reset() { for (const child of this.all()) { if (['input', 'textarea', 'select'].includes(child.tag)) child.value = ''; child.checked = false; } }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}

function fixture(t) {
  const previous = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const root = new Element('div'), requests = [];
  let refreshed = 0;
  const setup = createAccountSetup({ root, api: async (route, options) => {
    requests.push({ route, ...options }); accountDefinition(options.body); return { id: 'new-account' };
  }, refresh: async () => { refreshed++; }, describeError: error => error.code });
  setup.update(structuredClone(MAIL_PROVIDERS));
  const field = name => root.all().find(node => node.name === name);
  const select = id => { field('provider').value = id; field('provider').events.change(); };
  return { root, requests, setup, field, select, refreshed: () => refreshed, submit: () => root.children[0].events.submit({ preventDefault() {} }) };
}

test('account form submits backend-compatible provider settings and keeps fixed server presets read-only', async t => {
  const ui = fixture(t);
  for (const preset of MAIL_PROVIDERS.filter(value => !value.custom)) {
    ui.select(preset.id); ui.field('email').value = `${preset.id}@example.test`;
    assert.equal(ui.field('incomingHost').readOnly, true);
    assert.equal(ui.field('smtpSecurity').disabled, true);
    await ui.submit();
    assert.equal(ui.requests.at(-1).route, '/api/accounts');
    assert.equal(ui.requests.at(-1).method, 'POST');
    assert.equal(ui.requests.at(-1).body.provider, preset.id);
    assert.equal(ui.requests.at(-1).body.smtp.host, preset.smtp.host);
  }
  assert.equal(ui.refreshed(), ui.requests.length);
});

test('account form handles custom endpoints and explicit local Bridge certificate settings', async t => {
  const ui = fixture(t);
  ui.select('imap');
  assert.equal(ui.field('incomingHost').readOnly, false);
  assert.equal(ui.field('incomingHost').required, true);
  ui.field('email').value = 'person@example.test'; ui.field('username').value = 'imap-user';
  ui.field('incomingHost').value = 'IMAP.example.test'; ui.field('incomingPort').value = '143'; ui.field('incomingSecurity').value = 'starttls';
  ui.field('smtpHost').value = 'SMTP.example.test'; ui.field('smtpPort').value = '587'; ui.field('smtpSecurity').value = 'starttls'; ui.field('smtpUsername').value = 'smtp-user';
  ui.setup.update(structuredClone(MAIL_PROVIDERS));
  assert.equal(ui.field('incomingPort').value, '143', 'Refreshing account status preserves in-progress setup.');
  await ui.submit();
  assert.equal(ui.requests.at(-1).body.incoming.host, 'imap.example.test');
  assert.equal(ui.requests.at(-1).body.smtp.username, 'smtp-user');
  ui.select('proton'); ui.field('email').value = 'bridge@example.test';
  ui.field('allowLocalBridge').checked = true;
  const certificate = ui.root.all().find(node => node.tag === 'textarea');
  assert.equal(certificate.required, true); certificate.value = tls.rootCertificates[0];
  await ui.submit();
  assert.equal(ui.requests.at(-1).body.allowLocalBridge, true);
  assert.equal(ui.requests.at(-1).body.smtp.port, 1025);
  assert.match(ui.requests.at(-1).body.tlsCertificate, /BEGIN CERTIFICATE/u);
  assert.equal(ui.refreshed(), 2);
});
