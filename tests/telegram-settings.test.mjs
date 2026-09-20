import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createTelegramSettings } from '../web/telegram-settings.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = new Map(); this.attributes = new Map(); this.value = ''; this.disabled = false; }
  get isConnected() { return this.root === true || this.parentNode?.isConnected === true; }
  set textContent(value) { this.text = String(value); this.replaceChildren(); }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { throw new Error('Untrusted content must use textContent'); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  removeEventListener(name, callback) { if (this.events.get(name) === callback) this.events.delete(name); }
  dispatch(name) { return this.events.get(name)?.({ preventDefault() {}, target: this }); }
  nodes() { return this.children.flatMap(child => [child, ...child.nodes()]); }
}

function setup(t, { api, initial = {}, hidden = false, describeError } = {}) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
  const document = new Element('document'); document.root = true; document.visibilityState = 'visible'; document.createElement = tag => new Element(tag);
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets = []; }
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: Observer });
  const page = new Element('section'), host = new Element('div'); page.hidden = hidden; document.append(page); page.append(host);
  let model = { enabled: false, configured: true, verified: true, accountId: 'business-imap', language: 'nl-BE', chatIdMasked: '•••123', destinationLabel: 'Owner', threshold: 0.9, generation: 'one', counts: { pending: 2, eligible: 1, skipped: 5, held: 1, sent: 3 }, lastScanAt: null, lastDeliveryAt: null, error: null, review: [], busy: false, ...initial };
  const calls = [];
  const settings = createTelegramSettings({ pollInterval: 30000, describeError, api: async (path, options) => {
    calls.push({ path, ...options });
    if (api) return api(path, options);
    if (options.method === 'GET') return structuredClone(model);
    if (path === '/api/mail/telegram') {
      if (options.body.token || options.body.chatId) { model.configured = true; model.verified = true; }
      if (options.body.language) model.language = options.body.language;
      if (options.body.accountId) model.accountId = options.body.accountId;
      if ('formTrust' in options.body) model.formTrust = options.body.formTrust;
      if ('enabled' in options.body) model.enabled = options.body.enabled;
    }
    if (path.endsWith('/test')) model.verified = true;
    return { ok: true };
  } });
  settings.render(host);
  t.after(() => {
    settings.reset();
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
    if (oldObserver) Object.defineProperty(globalThis, 'MutationObserver', oldObserver); else delete globalThis.MutationObserver;
  });
  const nodes = () => host.nodes(), panel = () => nodes().find(node => node.tagName === 'details');
  return { settings, page, host, calls, document, nodes, panel,
    field: label => nodes().find(node => node.getAttribute('aria-label') === label),
    button: label => nodes().find(node => node.tagName === 'button' && node.textContent === label),
    form: () => nodes().find(node => node.tagName === 'form'),
    mutate: node => { for (const observer of observers) if (observer.targets.includes(node)) observer.callback(); },
    async open() { panel().open = true; panel().dispatch('toggle'); await nextTurn(); },
    replaceModel(next) { model = { ...model, ...next }; }
  };
}

test('Telegram status polls only while its section, enclosing Settings and document are visible', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = setup(t, { hidden: true });
  assert.equal(view.calls.length, 0);
  await view.open(); assert.equal(view.calls.length, 0);
  view.page.hidden = false; view.mutate(view.page); await nextTurn();
  assert.equal(view.calls.length, 1); assert.equal(view.calls[0].method, 'GET');
  t.mock.timers.tick(30000); await nextTurn(); assert.equal(view.calls.length, 2);
  view.page.hidden = true; view.mutate(view.page);
  t.mock.timers.tick(90000); await nextTurn(); assert.equal(view.calls.length, 2);
  view.page.hidden = false; view.mutate(view.page); await nextTurn(); assert.equal(view.calls.length, 3);
  view.document.visibilityState = 'hidden'; view.document.dispatch('visibilitychange');
  t.mock.timers.tick(90000); await nextTurn(); assert.equal(view.calls.length, 3);
  view.document.visibilityState = 'visible'; view.document.dispatch('visibilitychange'); await nextTurn(); assert.equal(view.calls.length, 4);
  view.panel().open = false; view.panel().dispatch('toggle');
  t.mock.timers.tick(90000); await nextTurn(); assert.equal(view.calls.length, 4);
  assert.equal(view.calls.every(call => call.method === 'GET'), true, 'Opening or polling never sends messages');
});

test('saving omits blank credentials, keeps secrets write-only and never sends a test implicitly', async t => {
  const view = setup(t); await view.open();
  view.field('Summary language').value = 'en'; view.field('Summary language').dispatch('change');
  view.form().dispatch('submit'); await nextTurn();
  assert.deepEqual(view.calls.find(call => call.method === 'POST').body, { language: 'en' });
  view.field('New bot token').value = '12345:FAKE_TOKEN_ONLY'; view.field('New bot token').dispatch('input');
  view.field('New private chat ID').value = '123456'; view.field('New private chat ID').dispatch('input');
  assert.equal(view.button('Send a Telegram test').disabled, true);
  view.form().dispatch('submit'); await nextTurn();
  assert.deepEqual(view.calls.filter(call => call.method === 'POST')[1].body, { language: 'en', token: '12345:FAKE_TOKEN_ONLY', chatId: '123456' });
  assert.equal(view.field('New bot token').value, ''); assert.equal(view.field('New private chat ID').value, '');
  assert.doesNotMatch(view.host.textContent, /FAKE_TOKEN_ONLY|123456/);
  assert.equal(view.field('New bot token').type, 'password');
  assert.equal(view.button('Enable inquiry notifications').disabled, false, 'Saved destinations were verified by the server');
  assert.equal(view.calls.some(call => call.path.endsWith('/test')), false);
  view.button('Send a Telegram test').dispatch('click'); await nextTurn();
  assert.deepEqual(view.calls.find(call => call.path.endsWith('/test')).body, {});
  assert.match(view.host.textContent, /Test message sent/);
  assert.equal(view.button('Enable inquiry notifications').disabled, false);
  view.button('Enable inquiry notifications').dispatch('click'); await nextTurn();
  assert.deepEqual(view.calls.filter(call => call.method === 'POST').at(-1).body, { enabled: true });
  view.button('Pause inquiry notifications').dispatch('click'); await nextTurn();
  assert.deepEqual(view.calls.filter(call => call.method === 'POST').at(-1).body, { enabled: false });
});

test('closing and resetting abort requests, clears credentials and rejects detached or late actions', async t => {
  const pending = [];
  const view = setup(t, { api: (path, options) => new Promise(resolve => pending.push({ resolve, options })) });
  await view.open(); assert.equal(pending.length, 1);
  view.field('New bot token').value = 'FAKE_SECRET'; view.field('New private chat ID').value = '123456';
  const oldPanel = view.panel(); oldPanel.open = false; oldPanel.dispatch('toggle');
  assert.equal(pending[0].options.signal.aborted, true);
  assert.equal(view.field('New bot token').value, ''); assert.equal(view.field('New private chat ID').value, '');
  pending[0].resolve({ enabled: true, configured: true, destinationLabel: 'LATE_PRIVATE_DESTINATION' }); await nextTurn();
  assert.doesNotMatch(view.host.textContent, /LATE_PRIVATE_DESTINATION/);
  await view.open(); const oldForm = view.form(), oldTest = view.button('Send a Telegram test');
  view.settings.reset(); view.settings.render(view.host);
  pending[1].resolve({ enabled: true, configured: true, destinationLabel: 'RESET_PRIVATE_DESTINATION' }); await nextTurn();
  assert.doesNotMatch(view.host.textContent, /RESET_PRIVATE_DESTINATION/);
  oldForm.dispatch('submit'); oldTest.dispatch('click'); oldPanel.open = true; oldPanel.dispatch('toggle');
  assert.equal(view.calls.length, 2, 'Detached settings cannot submit or reload a new session');
});

test('review metadata is rendered as text and stale destinations cannot be reassigned by retry', async t => {
  const view = setup(t, { initial: { error: { code: 'telegram_rate_limited', retryAt: '2026-09-20T12:00:00Z' }, recovery: 'uidvalidity_changed', review: [
    { id: 'retry-me', subject: '<img onerror=send()>', author: 'Visitor <visitor@example.test>', reason: 'summary_failed', receivedAt: '2026-09-20T10:00:00Z' },
    { id: 'keep-held', subject: 'Old destination', author: 'Other visitor', reason: 'destination_changed', receivedAt: null }
  ] } });
  await view.open();
  assert.match(view.host.textContent, /<img onerror=send\(\)>/);
  assert.equal(view.nodes().some(node => node.tagName === 'img'), false);
  assert.match(view.host.textContent, /Next retry:|Recovery needs review/);
  const buttons = view.nodes().filter(node => node.tagName === 'button' && node.textContent === 'Reevaluate');
  assert.equal(buttons[0].disabled, false); assert.equal(buttons[1].disabled, true);
  buttons[1].dispatch('click'); assert.equal(view.calls.length, 1);
  buttons[0].dispatch('click'); await nextTurn();
  assert.deepEqual(view.calls.find(call => call.path.endsWith('/retry')).body, { id: 'retry-me' });
  assert.equal(view.calls.some(call => call.path.endsWith('/test')), false);
});

test('polling preserves edited language and rerendering preserves controls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = setup(t); await view.open();
  const language = view.field('Summary language'); language.value = 'en'; language.dispatch('change');
  view.settings.render(view.host);
  t.mock.timers.tick(30000); await nextTurn();
  assert.equal(view.field('Summary language'), language); assert.equal(language.value, 'en');
  assert.equal(view.calls.length, 2);
});

test('the user can select a connected mailbox and explicitly configure form trust', async t => {
  const view = setup(t, { initial: { availableAccounts: [
    { id: 'business-imap', label: 'Business' }, { id: 'custom-account', label: 'Another mailbox' }
  ] } });
  await view.open();
  const account = view.field('Notification mailbox'); account.value = 'custom-account'; account.dispatch('change');
  assert.equal(view.button('Send a Telegram test').disabled, true);
  view.form().dispatch('submit'); await nextTurn();
  assert.equal(view.calls.find(call => call.method === 'POST').body.accountId, 'custom-account');
  assert.equal(view.field('Notification mailbox').value, 'custom-account');
  const enableTrust = view.field('Verify a configured website form'); enableTrust.checked = true; enableTrust.dispatch('change');
  const inputs = { 'Exact form subject': 'Contact request', 'Form sender email': 'form@example.test',
    'SPF envelope domain': 'forms.example.test', 'Receiving mail server': 'imap.example.test',
    'Trusted relay hosts (comma separated)': 'relay.example.test, relay2.example.test' };
  for (const [label, value] of Object.entries(inputs)) { view.field(label).value = value; view.field(label).dispatch('input'); }
  view.form().dispatch('submit'); await nextTurn();
  const saved = view.calls.filter(call => call.method === 'POST').at(-1).body.formTrust;
  assert.deepEqual(saved.trustedRelayHosts, ['relay.example.test', 'relay2.example.test']);
  assert.equal(saved.sender, 'form@example.test');
  enableTrust.checked = false; enableTrust.dispatch('change'); view.form().dispatch('submit'); await nextTurn();
  assert.equal(view.calls.filter(call => call.method === 'POST').at(-1).body.formTrust, null);
});
