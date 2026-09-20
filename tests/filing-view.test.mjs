import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createFilingView } from '../web/filing.mjs';

class Element {
  constructor(tag = 'div') { this.dataset = {}; this.tagName = tag; this.children = []; this.events = new Map(); this.attributes = new Map(); this.className = ''; this.value = ''; this.classList = { add: value => { this.className += ` ${value}`; } }; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ''; this.children = nodes; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, callback) { this.events.set(name, callback); }
  dispatch(name, event = {}) { return this.events.get(name)?.({ preventDefault() {}, ...event }); }
  focus() {}
  select() {}
}
function dom(t) {
  const previous = ['document', 'window', 'navigator', 'setTimeout', 'clearTimeout'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const root = new Element(), timers = new Map(), navigations = [], cleanup = []; let timerId = 0;
  const document = { hidden: false, createElement: tag => new Element(tag), events: new Map(), addEventListener(name, callback) { this.events.set(name, callback); } };
  const replacements = { document, window: { location: { assign: url => navigations.push(url) } }, navigator: { clipboard: { writeText: async () => {} } }, setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) };
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const callback of cleanup) callback(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const all = () => { const walk = element => [element, ...element.children.flatMap(walk)]; return walk(root); };
  return { root, timers, navigations, cleanup, all, button: text => all().find(element => element.tagName === 'button' && element.textContent === text), input: label => all().find(element => element.tagName === 'label' && element.children[0]?.textContent === label)?.children[1] };
}
const driveStatus = () => ({ configured: true, connected: true, email: 'private@example.test', expectedEmail: 'private@example.test', clientId: 'saved.apps.googleusercontent.com', callback: 'https://mail.example.test/oauth/drive/callback' });
const invoiceStatus = () => ({ enabled: false, intervalMinutes: 20, running: false, job: null, lastRun: null, counts: { filed: 2, duplicates: 1, needsReview: 1, waitingDrive: 0, notInvoices: 95 }, recent: [] });

test('filing refresh preserves registration drafts and safely renders invoice paths and OAuth failures', async t => {
  const ui = dom(t), invoices = invoiceStatus(), drive = driveStatus();
  drive.oauthFailure = { code: 'drive_wrong_account' };
  invoices.recent = [{ id: 'invoice', status: 'filed', filename: '<img src=x onerror=alert(1)>.pdf', subject: 'Example invoice', account: 'Business mailbox', entity: 'example_company', invoiceDate: '2026-08-12', year: 2026, quarter: 3, reasons: ['invoice_date_used'], file: { fileId: 'safe-file-id', webViewLink: 'https://attacker.invalid', folderPath: 'Invoices/Example Company/2026/Q3' } }];
  const view = createFilingView({ root: ui.root, api: async path => path === '/api/drive' ? drive : invoices });
  ui.cleanup.push(() => view.reset());
  view.show(); await nextTurn();
  const client = ui.input('Google client ID'), secret = ui.input('Google client secret');
  client.value = 'unfinished-new-client'; client.dispatch('input'); secret.value = 'PRIVATE_DRAFT_SECRET';
  await view.refresh();
  assert.equal(client.value, 'unfinished-new-client'); assert.equal(secret.value, 'PRIVATE_DRAFT_SECRET');
  assert.match(ui.root.textContent, /Invoices\/Example Company\/2026\/Q3/); assert.match(ui.root.textContent, /2026-08-12/);
  assert.match(ui.root.textContent, /Choose the private Google account/);
  assert.equal(ui.all().some(element => element.tagName === 'img'), false);
  const fileLink = ui.all().find(element => element.tagName === 'a' && element.textContent === 'Open invoice in Drive');
  assert.equal(fileLink.href, 'https://drive.google.com/file/d/safe-file-id/view');
  assert.equal(ui.timers.size, 1);
  view.hide(); assert.equal(ui.timers.size, 0, 'A hidden card without its own running job must not keep polling.');
});

test('a session reset clears secrets and discards delayed private filing responses', async t => {
  const ui = dom(t), resolvers = [];
  const view = createFilingView({ root: ui.root, api: async path => new Promise(resolve => resolvers.push({ path, resolve })) });
  const refresh = view.refresh(); await nextTurn();
  ui.input('Google client secret').value = 'PRIVATE_SECRET'; view.reset();
  for (const item of resolvers) item.resolve(item.path === '/api/drive' ? driveStatus() : { ...invoiceStatus(), recent: [{ status: 'needs_review', filename: 'PRIVATE_INVOICE_FILENAME.pdf', subject: 'PRIVATE_SUBJECT' }] });
  await refresh;
  assert.equal(ui.input('Google client secret').value, ''); assert.equal(ui.input('Google client ID').value, '');
  assert.doesNotMatch(ui.root.textContent, /PRIVATE_|private@example.test/);
  assert.equal(ui.timers.size, 0);
});

test('starting a 1,000-email scan keeps only that job polling when hidden and announces completion once', async t => {
  const ui = dom(t), calls = [], notices = []; let invoices = invoiceStatus();
  const job = { id: 'own-job', status: 'running', phase: 'scanning', scanned: 0, processed: 0, filed: 0, needsReview: 0, errors: [] };
  const view = createFilingView({ root: ui.root, notify: (...values) => notices.push(values), api: async (path, options) => {
    calls.push({ path, body: options?.body });
    if (path === '/api/drive') return driveStatus();
    if (path === '/api/invoices/scan') { invoices = { ...invoices, running: true, job }; return { job }; }
    assert.equal(path, '/api/invoices'); return invoices;
  } });
  ui.cleanup.push(() => view.reset());
  view.show(); await nextTurn();
  await ui.button('Scan latest 1,000 emails').dispatch('click');
  assert.deepEqual(calls.find(call => call.path === '/api/invoices/scan').body, { limit: 1000 });
  view.hide(); assert.equal(ui.timers.size, 1);
  invoices = { ...invoices, running: true, job: { ...job, id: 'another-devices-job' }, lastRun: { ...job, status: 'completed', phase: 'complete', scanned: 1000, processed: 1000, filed: 3, needsReview: 2, scanComplete: true } };
  await view.refresh(); assert.equal(ui.timers.size, 0); assert.equal(notices.length, 1);
  assert.match(notices[0][0], /3 filed, 2 need review/);
  await view.refresh(); assert.equal(notices.length, 1);
});

test('Drive connect rejects an unexpected authorization host and saves registration without keeping its secret', async t => {
  const ui = dom(t), calls = []; let drive = driveStatus();
  const view = createFilingView({ root: ui.root, describeError: error => error.message, api: async (path, options) => {
    calls.push({ path, body: options?.body });
    if (path === '/api/drive') return drive;
    if (path === '/api/invoices') return invoiceStatus();
    if (path === '/api/drive/connect') return { url: 'https://attacker.invalid/oauth' };
    assert.equal(path, '/api/drive/configure'); drive = { ...drive, clientId: options.body.clientId }; return drive;
  } });
  ui.cleanup.push(() => view.reset());
  view.show(); await nextTurn();
  await ui.button('Reconnect private Google Drive').dispatch('click');
  assert.equal(ui.navigations.length, 0); assert.match(ui.root.textContent, /valid sign-in link/);
  ui.input('Google client ID').value = 'replacement.apps.googleusercontent.com'; ui.input('Google client ID').dispatch('input');
  ui.input('Google client secret').value = 'PRIVATE_NEW_SECRET';
  const form = ui.all().find(element => element.tagName === 'form'); form.dispatch('submit'); await nextTurn();
  assert.deepEqual(calls.find(call => call.path === '/api/drive/configure').body, { clientId: 'replacement.apps.googleusercontent.com', clientSecret: 'PRIVATE_NEW_SECRET', expectedEmail: 'private@example.test' });
  assert.equal(ui.input('Google client secret').value, '');
});


test('businesses can be configured from an initially empty filing view', async t => {
  const ui = dom(t), calls = []; let invoices = { ...invoiceStatus(), entities: [] };
  const view = createFilingView({ root: ui.root, api: async (path, options) => {
    if (path === '/api/drive') return driveStatus();
    if (path === '/api/invoices/settings') { calls.push(options.body); invoices = { ...invoices, entities: options.body.entities }; return invoices; }
    return invoices;
  } });
  ui.cleanup.push(() => view.reset()); view.show(); await nextTurn();
  ui.button('Add business').dispatch('click');
  ui.input('Business name').value = 'Example Studio'; ui.input('Customer VAT (optional)').value = 'BE0000000000';
  await ui.button('Save businesses').dispatch('click');
  assert.equal(calls.length, 1); assert.equal(calls[0].entities.length, 1);
  assert.equal(calls[0].entities[0].label, 'Example Studio'); assert.equal(calls[0].entities[0].vat, 'BE0000000000');
  assert.match(calls[0].entities[0].id, /^business_[a-f0-9]+$/);
});
