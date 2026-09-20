import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createComposeView } from '../web/compose.mjs';

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.events = new Map();
    this.attributes = new Map();
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.contentEditable = 'false';
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this._html = String(value); this.text = String(value).replace(/<[^>]+>/g, ''); }
  get innerHTML() { return this._html !== undefined ? this._html : this.children.map(child => child.innerHTML || child.textContent).join(''); }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }
  append(...nodes) {
    for (const n of nodes) {
      if (n && typeof n === 'object') {
        n.parentElement?.removeChild(n);
        n.parentElement = this;
      }
    }
    this.children.push(...nodes);
  }
  removeChild(node) {
    const index = Array.prototype.indexOf.call(this.children, node);
    if (index < 0) throw new Error('Not a child');
    Array.prototype.splice.call(this.children, index, 1);
    node.parentElement = null;
    return node;
  }
  prepend(...nodes) {
    for (const n of nodes) { if (n && typeof n === 'object') n.parentElement = this; }
    this.children.unshift(...nodes);
  }
  replaceChildren(...nodes) {
    this.text = '';
    this._html = undefined;
    for (const n of nodes) { if (n && typeof n === 'object') n.parentElement = this; }
    this.children = [...nodes];
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(callback);
  }
  dispatch(name, event = {}) {
    const cbs = this.events.get(name) || [];
    const ev = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event };
    let res;
    for (const cb of cbs) {
      res = cb(ev);
    }
    return res;
  }
  focus() { document.activeElement = this; }
  click() { this.clicked = true; return this.dispatch('click'); }
  show() { this.open = true; this.modal = false; }
  showModal() { this.open = true; this.modal = true; }
  close() { this.open = false; }
  querySelectorAll(selector) {
    const all = (root = this) => [root, ...root.children.flatMap(child => all(child))];
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return all().filter(node => node.className?.split(/\s+/).includes(cls));
    }
    return all().filter(node => node.tagName === selector);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(other) {
    if (this === other) return true;
    return this.children.some(c => c === other || (c.contains && c.contains(other)));
  }
  remove() {
    this.hidden = true;
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) this.parentElement.children.splice(idx, 1);
    }
  }
}

function dom(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const body = new Element('body');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { body, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) }
  });
  const cleanupViews = [];
  t.after(() => {
    for (const view of cleanupViews) {
      view.reset();
    }
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  const all = (root = body) => [root, ...root.children.flatMap(child => all(child))];
  return {
    body,
    all,
    field: name => all().find(item => item.name === name),
    button: label => all().find(item => item.tagName === 'button' && (item.getAttribute('aria-label') || item.textContent) === label),
    find: predicate => all().find(predicate),
    cleanup: view => cleanupViews.push(view)
  };
}
const settings = { accounts: [{ accountId: 'fixture', label: 'Fixture', email: 'sender@example.test', host: 'smtp.example.test', port: 587, authType: 'password', sentCopy: true }] };

test('compose review shows recipients and requires a second explicit action before sending', async t => {
  const page = dom(t), calls = [];
  const view = createComposeView({ api: async (path, options) => {
    calls.push([path, options]);
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: options.body.composeId || 'rec-1', revision: (options.body.revision || 0) + 1 } : { drafts: [] };
    if (path === '/api/mail/compose/preferences/read') return { signature: '' };
    return { sent: true, status: 'sent' };
  } });
  await view.open({ accountId: 'fixture' });
  page.field('to').value = 'recipient@example.test';
  page.field('bcc').value = 'hidden@example.test';
  page.field('text').value = 'Draft body';
  page.field('text').dispatch('input');
  page.button('Send').dispatch('click');
  assert.match(page.body.textContent, /hidden@example.test/);
  assert.equal(calls.filter(call => call[0] === '/api/mail/send').length, 0);
  await page.button('Send message').dispatch('click');
  const send = calls.find(call => call[0] === '/api/mail/send')[1];
  assert.equal(send.body.accountId, 'fixture');
  assert.equal(send.body.bcc, 'hidden@example.test');
  assert.ok(send.body.requestId.length >= 20);
  assert.equal(page.button('Send message').disabled, true);
  assert.match(page.body.textContent, /Message sent/);
  view.reset();
  assert.doesNotMatch(page.body.textContent, /recipient@example.test|hidden@example.test|sender@example.test|Draft body/);
});

test('ambiguous send keeps content and disables all blind send and save attempts', async t => {
  const page = dom(t), calls = [];
  const view = createComposeView({ api: async (path, options) => {
    calls.push([path, options]);
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: options.body.composeId || 'rec-1', revision: 1 } : { drafts: [] };
    if (path === '/api/mail/compose/preferences/read') return { signature: '' };
    throw { code: 'send_uncertain' };
  } });
  await view.open();
  page.field('to').value = 'recipient@example.test';
  page.field('text').value = 'Keep this body';
  page.field('text').dispatch('input');
  page.button('Send').dispatch('click');
  await page.button('Send message').dispatch('click');
  assert.equal(page.field('text').value, 'Keep this body');
  assert.equal(page.button('Send message').disabled, true);
  assert.equal(page.button('Save draft').disabled, true);
  assert.match(page.body.textContent, /Check Sent/);
  await page.button('Send message').dispatch('click');
  await page.button('Save draft').dispatch('click');
  assert.equal(calls.filter(call => call[0] === '/api/mail/send').length, 1);
  assert.equal(calls.filter(call => ['/api/mail/send', '/api/mail/draft'].includes(call[0])).length, 1);
  view.reset();
});

test('save draft adopts replacement identity and session reset clears private content', async t => {
  const page = dom(t), drafts = [];
  const view = createComposeView({ api: async (path, options) => {
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: options.body.composeId || 'rec-1', revision: (options.body.revision || 0) + 1 } : { drafts: [] };
    if (path === '/api/mail/compose/preferences/read') return { signature: '' };
    if (path === '/api/mail/draft') { drafts.push(options.body); return { saved: true, draftId: 'saved-draft' }; }
    return {};
  } });
  await view.open();
  page.field('text').value = 'PRIVATE_DRAFT';
  page.field('text').dispatch('input');
  await page.button('Save draft').dispatch('click');
  page.field('text').value = 'PRIVATE_EDIT';
  page.field('text').dispatch('input');
  await page.button('Save draft').dispatch('click');
  assert.equal(drafts[1].draftId, 'saved-draft');
  view.reset();
  assert.equal(page.field('text').value, '');
  assert.equal(page.body.children[0].open, false);
});

test('closing unsaved content offers discard and prevents silently overwriting it', { timeout: 1000 }, async t => {
  const page = dom(t);
  let settingsCalls = 0;
  const view = createComposeView({ api: async (path, options) => {
    if (path === '/api/mail/smtp') settingsCalls++;
    if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: 'rec', revision: 1 } : { drafts: [] };
    if (path === '/api/mail/compose/preferences/read') return { signature: '' };
    return settings;
  } });
  page.cleanup(view);
  await view.open();
  page.field('text').value = 'Unsaved';
  page.field('text').dispatch('input');
  await view.open();
  assert.equal(settingsCalls, 1);
  assert.equal(page.field('text').value, 'Unsaved');
  view.close();
  assert.equal(page.body.children[0].open, true);
  assert.match(page.body.textContent, /Discard unsaved changes/);
  await page.button('Discard changes').dispatch('click');
  assert.equal(page.body.children[0].open, false);
  assert.equal(page.field('text').value, '');
});

test('late compose context cannot restore message contents after reset', async t => {
  const page = dom(t);
  let resolve;
  const view = createComposeView({ api: async (path, options) => {
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: 'rec', revision: 1 } : { drafts: [] };
    if (path === '/api/mail/compose/preferences/read') return { signature: '' };
    if (path === '/api/mail/compose/context') return new Promise(done => { resolve = done; });
    return {};
  } });
  const opening = view.open({ mode: 'reply', id: 'original' });
  await tick();
  view.reset();
  resolve({ accountId: 'fixture', to: 'recipient@example.test', text: 'PRIVATE_LATE' });
  await opening;
  assert.equal(page.field('text').value, '');
  assert.equal(page.body.children[0].open, false);
});

test('outgoing settings test verifies a saved connection without invoking send', async t => {
  const page = dom(t), paths = [];
  const view = createComposeView({ api: async path => { paths.push(path); return path === '/api/mail/smtp' ? settings : { verified: true }; } });
  await view.renderSettings([{accountId: 'fixture', container: page.body}]);
  await page.button('Test saved connection').dispatch('click');
  assert.deepEqual(paths, ['/api/mail/smtp', '/api/mail/smtp/test']);
  assert.match(page.body.textContent, /No email was sent/);
});

test('late outgoing settings cannot repopulate account identities after logout reset', async t => {
  const page = dom(t);
  let resolve;
  const view = createComposeView({ api: async () => new Promise(done => { resolve = done; }) });
  const rendering = view.renderSettings([{accountId: 'fixture', container: page.body}]);
  await tick();
  view.reset();
  resolve(settings);
  await rendering;
  assert.equal(page.body.textContent, '');
});

test('outgoing settings bind to existing account cards with one fetch and no repeated account identity', async t => {
  const page = dom(t), calls = [], first = new Element('div'), second = new Element('div');
  page.body.append(first, second);
  const view = createComposeView({ api: async (path, options) => {
    calls.push([path, options]);
    return options?.method ? {verified: true} : {accounts: [
      {...settings.accounts[0], accountId: 'second', label: 'Second account', email: 'second@example.test', host: 'smtp.second.example.test'},
      settings.accounts[0]
    ]};
  }});
  await view.renderSettings([{accountId: 'fixture', container: first}, {accountId: 'second', container: second}]);
  assert.equal(calls.length, 1);
  assert.equal(page.all(first).find(item => item.name === 'host').value, 'smtp.example.test');
  assert.equal(page.all(second).find(item => item.name === 'host').value, 'smtp.second.example.test');
  assert.doesNotMatch(page.body.textContent, /Fixture|Second account|sender@example\.test|second@example\.test|Outgoing mail/);
  await page.all(second).find(item => item.tagName === 'button' && item.textContent === 'Test saved connection').dispatch('click');
  assert.equal(calls[1][1].body.accountId, 'second');
  assert.equal(calls[1][0], '/api/mail/smtp/test');
});

test('saving card settings clears the password before the request and keeps the selected account', async t => {
  const page = dom(t), calls = [];
  let rejectSave;
  const view = createComposeView({ api: async (path, options) => {
    if (!options) return settings;
    calls.push([path, options]);
    return new Promise((_, reject) => { rejectSave = reject; });
  }});
  await view.renderSettings([{accountId: 'fixture', container: page.body}]);
  page.field('reuse').checked = false;
  page.field('reuse').dispatch('change');
  page.field('password').value = 'TEMPORARY_SMTP_PASSWORD';
  page.field('port').value = '465';
  const saving = page.button('Save outgoing settings').dispatch('click');
  assert.equal(page.field('password').value, '');
  assert.deepEqual(calls[0][1].body, {accountId: 'fixture', host: 'smtp.example.test', port: 465, security: 'tls', sentCopy: true, password: 'TEMPORARY_SMTP_PASSWORD', useMailboxPassword: false});
  rejectSave({code: 'smtp_error'});
  await saving;
  assert.equal(page.field('password').value, '');
  assert.equal(page.button('Save outgoing settings').disabled, false);
});

test('outgoing settings preserve custom and Bridge ports with their configured encryption mode', async t => {
  const page = dom(t), calls = [];
  for (const [port, security] of [[1025, 'starttls'], [1465, 'tls'], [465, 'starttls']]) {
    const account = { ...settings.accounts[0], host: port === 1025 ? '127.0.0.1' : 'smtp.example.test', port, security, sentCopy: false, customPassword: true };
    const view = createComposeView({ api: async (path, options) => {
      if (!options) return { accounts: [account] };
      calls.push([path, options]); return {};
    } });
    await view.renderSettings([{ accountId: 'fixture', container: page.body }]);
    const selector = page.field('port');
    assert.equal(selector.value, String(port));
    assert.equal(selector.children.find(option => option.value === String(port)).textContent, `${port} · ${security === 'tls' ? 'TLS' : 'STARTTLS'}`);
    await page.button('Save outgoing settings').dispatch('click');
    assert.deepEqual(calls.at(-1)[1].body, { accountId: 'fixture', host: account.host, port, security, sentCopy: false, password: '', useMailboxPassword: false });
    selector.value = '587';
    await page.button('Save outgoing settings').dispatch('click');
    assert.equal(calls.at(-1)[1].body.port, 587);
    assert.equal(calls.at(-1)[1].body.security, 'starttls');
    view.reset();
  }
});

test('new account mounts supersede pending settings and reset erases detached password inputs', async t => {
  const page = dom(t), responses = [], first = new Element('div'), second = new Element('div');
  page.body.append(first, second);
  const view = createComposeView({ api: async () => new Promise(resolve => responses.push(resolve)) });
  const oldRendering = view.renderSettings([{accountId: 'fixture', container: first}]);
  const rendering = view.renderSettings([{accountId: 'fixture', container: second}]);
  responses[1](settings);
  await rendering;
  const passwordInput = page.field('password');
  passwordInput.value = 'PRIVATE_PASSWORD';
  responses[0](settings);
  await oldRendering;
  assert.equal(first.textContent, '');
  assert.equal(page.all().filter(item => item.tagName === 'form').length, 1);
  view.reset();
  assert.equal(passwordInput.value, '');
  assert.equal(page.body.textContent, '');
});

test('no connected account mounts makes no outgoing settings request', async t => {
  dom(t);
  let called = false;
  const view = createComposeView({api: async () => { called = true; return settings; }});
  await view.renderSettings([]);
  assert.equal(called, false);
});

test('docked composer minimizes and expands without losing an unsaved message', async t => {
  const page = dom(t), view = createComposeView({ api: async (path, options) => {
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: 'rec', revision: 1 } : { drafts: [] };
    if (path === '/api/mail/compose/preferences/read') return { signature: '' };
    return {};
  } });
  await view.open();
  const dialog = page.find(item => item.tagName === 'dialog'), form = page.find(item => item.className === 'compose-form');
  assert.equal(dialog.modal, false);
  page.field('text').value = 'KEEP THIS DRAFT';
  page.field('text').dispatch('input');
  page.button('Minimize composer').dispatch('click');
  assert.equal(form.hidden, true);
  assert.match(dialog.className, /is-minimized/);
  assert.equal(page.field('text').value, 'KEEP THIS DRAFT');
  page.button('Restore composer').dispatch('click');
  assert.equal(form.hidden, false);
  assert.ok(document.activeElement === page.find(item => item.className === 'compose-editor-content') || document.activeElement === page.field('text'));
  page.button('Expand composer').dispatch('click');
  assert.match(dialog.className, /is-expanded/);
  page.button('Restore window size').dispatch('click');
  assert.doesNotMatch(dialog.className, /is-expanded/);
  page.button('Minimize composer').dispatch('click');
  page.button('Close composer').dispatch('click');
  assert.equal(form.hidden, false);
  assert.equal(dialog.open, true);
  assert.match(page.body.textContent, /Discard unsaved changes/);
  page.button('Keep writing').dispatch('click');
  assert.equal(page.field('text').value, 'KEEP THIS DRAFT');
  view.reset();
  assert.equal(dialog.open, false);
  assert.equal(dialog.className, 'compose-dialog');
  assert.equal(page.field('text').value, '');
});

test('Cc and Bcc reveal inline and existing recipients are visible when reopening a draft', async t => {
  const page = dom(t), view = createComposeView({ api: async (path, options) => {
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: 'rec', revision: 1 } : { drafts: [] };
    if (path === '/api/mail/compose/preferences/read') return { signature: '' };
    return { accountId: 'fixture', to: 'to@example.test', cc: 'copy@example.test', bcc: 'hidden@example.test', text: 'Draft' };
  } });
  await view.open();
  const ccRow = page.find(item => item.id === 'compose-cc-row'), bccRow = page.find(item => item.id === 'compose-bcc-row');
  assert.equal(ccRow.hidden, true);
  assert.equal(bccRow.hidden, true);
  page.button('Cc').dispatch('click');
  assert.equal(ccRow.hidden, false);
  assert.equal(page.button('Cc').hidden, true);
  assert.equal(document.activeElement, page.field('cc'));
  page.button('Bcc').dispatch('click');
  assert.equal(bccRow.hidden, false);
  assert.equal(document.activeElement, page.field('bcc'));
  view.reset();
  await view.open({ mode: 'edit', id: 'draft' });
  assert.equal(ccRow.hidden, false);
  assert.equal(bccRow.hidden, false);
  assert.equal(page.field('cc').value, 'copy@example.test');
  assert.equal(page.field('bcc').value, 'hidden@example.test');
  assert.ok(document.activeElement === page.find(item => item.className === 'compose-editor-content') || document.activeElement === page.field('text'));
  view.reset();
  assert.equal(ccRow.hidden, true);
  assert.equal(bccRow.hidden, true);
  assert.equal(page.button('Cc').hidden, false);
});

test('attachment toolbar opens the picker, renders removable chips and keeps the upload limit', async t => {
  const page = dom(t), drafts = [];
  const view = createComposeView({ api: async (path, options) => {
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: 'rec', revision: 1 } : { drafts: [] };
    if (path === '/api/mail/compose/preferences/read') return { signature: '' };
    if (path === '/api/mail/draft') { drafts.push(options.body); return { draftId: 'saved' }; }
    return {};
  } });
  await view.open();
  page.button('Attach files').dispatch('click');
  assert.equal(page.field('attachments').clicked, true);
  const bytes = new TextEncoder().encode('fixture attachment');
  page.field('attachments').files = [{ name: 'notes.txt', type: 'text/plain', size: bytes.length, arrayBuffer: async () => bytes.buffer }];
  await page.field('attachments').dispatch('change');
  assert.match(page.body.textContent, /notes.txt/);
  assert.ok(page.button('Remove notes.txt'));
  await page.button('Save draft').dispatch('click');
  assert.deepEqual(drafts[0].attachments.map(file => file.filename), ['notes.txt']);
  page.button('Remove notes.txt').dispatch('click');
  assert.equal(page.button('Remove notes.txt'), undefined);
  let readOversized = false;
  page.field('attachments').files = [{ name: 'too-large.bin', size: 25 * 1024 * 1024 + 1, arrayBuffer: async () => { readOversized = true; } }];
  await page.field('attachments').dispatch('change');
  assert.equal(readOversized, false);
  assert.match(page.body.textContent, /25 MiB or less/);
  assert.equal(page.button('Save draft').disabled, false);
  view.reset();
});

test('editing after Send returns to writing and still requires a fresh review before delivery', { timeout: 1000 }, async t => {
  const page = dom(t), calls = [];
  const view = createComposeView({ api: async (path, options) => {
    calls.push([path, options]);
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: 'rec', revision: 1 } : { drafts: [] };
    if (path === '/api/mail/compose/preferences/read') return { signature: '' };
    return { sent: true, status: 'sent' };
  } });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'first@example.test';
  page.field('text').value = 'Original';
  page.field('text').dispatch('input');
  page.button('Send').dispatch('click');
  page.field('to').value = 'changed@example.test';
  page.field('to').dispatch('input');
  await page.button('Send message').dispatch('click');
  assert.equal(calls.filter(c => c[0] === '/api/mail/send').length, 0);
  page.button('Send').dispatch('click');
  assert.match(page.find(item => item.className === 'compose-review-details').textContent, /changed@example.test/);
  await page.button('Send message').dispatch('click');
  const sendCalls = calls.filter(c => c[0] === '/api/mail/send');
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0][1].body.to, 'changed@example.test');
  assert.equal(sendCalls[0][1].body.text, 'Original');
  assert.equal(page.button('Attach files').disabled, true);
  view.reset();
});

test('Escape in the nonmodal composer preserves unsaved changes until discard is confirmed', { timeout: 1000 }, async t => {
  const page = dom(t), view = createComposeView({ api: async (path, options) => {
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: 'rec', revision: 1 } : { drafts: [] };
    if (path === '/api/mail/compose/preferences/read') return { signature: '' };
    return {};
  } });
  page.cleanup(view);
  await view.open();
  const dialog = page.find(item => item.tagName === 'dialog');
  page.field('text').value = 'Unsaved message';
  page.field('text').dispatch('input');
  let prevented = false, stopped = false;
  dialog.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(dialog.open, true);
  assert.equal(page.field('text').value, 'Unsaved message');
  assert.equal(document.activeElement, page.button('Keep writing'));
  await page.button('Discard changes').dispatch('click');
  assert.equal(dialog.open, false);
  assert.equal(page.field('text').value, '');
});

test('autosave debounce serializes saves and rapid edits during pending save trigger follow-up save', { timeout: 1000 }, async t => {
  const page = dom(t), saves = [];
  let resolveSave;
  const view = createComposeView({
    autosaveDebounceMs: 5,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery') {
        if (!options?.body) return { drafts: [] };
        saves.push(options.body);
        return new Promise(resolve => { resolveSave = () => resolve({ composeId: 'rec-auto', revision: saves.length }); });
      }
      return {};
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'recipient@example.test';
  page.field('text').value = 'Autosave 1';
  page.field('text').dispatch('input');

  await new Promise(r => setTimeout(r, 20));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].content.text, 'Autosave 1');

  page.field('text').value = 'Autosave 2';
  page.field('text').dispatch('input');

  resolveSave();
  await tick();
  await new Promise(r => setTimeout(r, 20));

  assert.equal(saves.length, 2);
  assert.equal(saves[1].content.text, 'Autosave 2');
  assert.equal(saves[1].composeId, 'rec-auto');
  assert.equal(saves[1].revision, 1);
  resolveSave();
  await tick();
  view.reset();
});

test('reset cancels all pending autosave timers and never saves after reset', { timeout: 1000 }, async t => {
  const page = dom(t);
  let savedCount = 0;
  const view = createComposeView({
    autosaveDebounceMs: 25,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery' && options?.body) {
        savedCount++;
        return { composeId: 'rec', revision: 1 };
      }
      return { drafts: [] };
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'recipient@example.test';
  page.field('text').value = 'Will be reset';
  page.field('text').dispatch('input');

  view.reset();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(savedCount, 0);
  view.reset();
});

test('invalid recipient address or CRLF injection prevents send review without losing input contents', async t => {
  const page = dom(t);
  const view = createComposeView({ api: async path => path === '/api/mail/smtp' ? settings : {} });
  await view.open();

  page.field('to').value = 'invalid-email-format';
  page.field('text').value = 'Body';
  page.button('Send').dispatch('click');
  assert.match(page.body.textContent, /Invalid recipient/);
  assert.equal(page.field('to').value, 'invalid-email-format');
  assert.equal(page.find(i => i.className === 'compose-review').hidden, true);

  page.field('to').value = 'user@example.test\r\nBcc: evil@example.test';
  page.button('Send').dispatch('click');
  assert.match(page.body.textContent, /line breaks|control characters/);
  assert.equal(page.field('to').value, 'user@example.test\r\nBcc: evil@example.test');

  page.field('to').value = 'user@example.test';
  page.button('Send').dispatch('click');
  assert.ok(page.button('Send message'));
  view.reset();
});

test('recipient suggestions from known identities complete recipient field', async t => {
  const page = dom(t);
  const view = createComposeView({
    api: async path => path === '/api/mail/smtp' ? settings : { drafts: [] },
    getRecipients: () => [{ name: 'Colleague Bob', address: 'bob@example.test' }]
  });
  await view.open();

  page.field('to').value = 'bob';
  page.field('to').dispatch('input');

  const suggestion = page.find(i => i.className?.includes('compose-suggestion-item'));
  assert.ok(suggestion);
  assert.match(suggestion.textContent, /bob@example\.test/);

  suggestion.dispatch('click');
  assert.match(page.field('to').value, /bob@example\.test/);
  assert.equal(page.field('to').hidden, true);
  assert.equal(document.activeElement, page.button('Edit To recipients'), 'Committed suggestion keeps keyboard focus on a visible control');
  assert.equal(document.activeElement.hidden, false);
  view.reset();
});

test('recipient chips accept quoted names with commas and allow removing individual chips', async t => {
  const page = dom(t);
  const view = createComposeView({ api: async path => path === '/api/mail/smtp' ? settings : { drafts: [] } });
  await view.open();

  page.field('to').value = '"Doe, Jane" <jane@example.test>, other@example.test';
  page.field('to').dispatch('blur');

  const chips = page.all().filter(i => i.className === 'compose-chip' || i.className === 'compose-chip is-invalid');
  assert.equal(chips.length, 2);
  assert.match(chips[0].textContent, /Doe, Jane/);
  assert.match(chips[1].textContent, /other@example\.test/);

  const removeOther = page.button('Remove other@example.test');
  assert.ok(removeOther);
  removeOther.dispatch('click');

  assert.equal(page.field('to').value, '"Doe, Jane" <jane@example.test>');
  view.reset();
});

test('rich text formatting updates editor and keeps plain text alternative synchronized', async t => {
  const page = dom(t), calls = [];
  const view = createComposeView({
    api: async (path, options) => {
      calls.push([path, options]);
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: 'rec', revision: 1 } : { drafts: [] };
      if (path === '/api/mail/compose/preferences/read') return { signature: '' };
      return { sent: true, status: 'sent' };
    }
  });
  await view.open();
  page.field('to').value = 'recipient@example.test';

  const editor = page.find(i => i.className === 'compose-editor-content');
  assert.ok(editor);
  editor.innerHTML = '<p>Formatted <b>bold</b> text</p>';
  editor.dispatch('input');

  assert.match(page.field('text').value, /Formatted bold text/);

  page.button('Send').dispatch('click');
  await page.button('Send message').dispatch('click');

  const sentPayload = calls.find(c => c[0] === '/api/mail/send')[1].body;
  assert.equal(sentPayload.text, 'Formatted bold text');
  assert.match(sentPayload.html, /<b>bold<\/b>/);
  view.reset();
});

test('signature insertion inserts account signature and switching accounts does not overwrite user text', async t => {
  const page = dom(t);
  const twoAccounts = {
    accounts: [
      { accountId: 'first', label: 'First', email: 'first@example.test', host: 'smtp.example.test', port: 587, authType: 'password', sentCopy: true },
      { accountId: 'second', label: 'Second', email: 'second@example.test', host: 'smtp.example.test', port: 587, authType: 'password', sentCopy: true }
    ]
  };
  const view = createComposeView({
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return twoAccounts;
      if (path === '/api/mail/compose/preferences/read') {
        return { signature: options.body.accountId === 'first' ? 'Sent from First Account' : 'Sent from Second Account' };
      }
      return { drafts: [] };
    }
  });
  await view.open();
  page.field('text').value = 'Original message content';
  page.field('text').dispatch('input');

  page.button('Insert signature').dispatch('click');
  await tick();
  assert.match(page.field('text').value, /Original message content/);
  assert.match(page.field('text').value, /Sent from First Account/);

  page.field('accountId').value = 'second';
  page.field('accountId').dispatch('change');
  await tick();

  assert.match(page.field('text').value, /Original message content/);
  assert.match(page.field('text').value, /Sent from First Account/);
  view.reset();
});

test('reopening a locked recovery keeps editor and send actions locked after reload', async t => {
  const page = dom(t);
  const view = createComposeView({
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery/read') {
        return {
          composeId: 'locked-rec',
          revision: 2,
          locked: true,
          content: {
            accountId: 'fixture',
            to: 'recipient@example.test',
            subject: 'Locked recovery',
            text: 'Content that was already submitted'
          }
        };
      }
      return {};
    }
  });
  await view.open({ composeId: 'locked-rec' });

  assert.equal(page.field('text').value, 'Content that was already submitted');
  assert.equal(page.field('text').disabled, true);
  assert.equal(page.button('Send').disabled, true);
  assert.equal(page.button('Save draft').disabled, true);
  assert.match(page.body.textContent, /submitted/);
  view.reset();
});

test('drop and paste attachment pipeline enforces limits and processes pasted raster images', async t => {
  const page = dom(t);
  const view = createComposeView({
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      return { drafts: [] };
    }
  });
  await view.open();

  let readOversized = false;
  const form = page.find(i => i.className === 'compose-form');
  form.dispatch('drop', {
    dataTransfer: {
      files: [{ name: 'huge.bin', size: 25 * 1024 * 1024 + 10, arrayBuffer: async () => { readOversized = true; } }]
    }
  });
  await tick();
  assert.equal(readOversized, false);
  assert.match(page.body.textContent, /25 MiB or less/);

  const imgBytes = new Uint8Array([137, 80, 78, 71]);
  const editor = page.find(i => i.className === 'compose-editor-content');
  editor.dispatch('paste', {
    clipboardData: {
      files: [{ name: 'screenshot.png', type: 'image/png', size: imgBytes.length, arrayBuffer: async () => imgBytes.buffer }],
      getData: () => ''
    }
  });
  await tick();
  assert.match(page.body.textContent, /screenshot\.png/);

  editor.dispatch('paste', {
    clipboardData: {
      files: [],
      getData: type => type === 'text/plain' ? 'Pasted text' : ''
    }
  });
  await tick();
  assert.equal(page.all().filter(i => i.className === 'compose-file-name').length, 1);
  view.reset();
});

// REQUIRED NEW RACE & RESILIENCE TESTS

test('ACK lost then retry sends identical composeId and snapshot to resolve revision', { timeout: 1000 }, async t => {
  const page = dom(t);
  const recoverySaves = [];
  let shouldFail = true;
  const view = createComposeView({
    autosaveDebounceMs: 5,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery') {
        if (!options?.body) return { drafts: [] };
        recoverySaves.push(structuredClone(options.body));
        if (shouldFail) {
          shouldFail = false;
          throw new Error('NETWORK_TIMEOUT');
        }
        return { saved: true, composeId: options.body.composeId, revision: 1, replayed: true };
      }
      return {};
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'recipient@example.test';
  page.field('text').value = 'First draft snapshot';
  page.field('text').dispatch('input');

  await new Promise(r => setTimeout(r, 20));
  assert.equal(recoverySaves.length, 1);
  const firstAttempt = recoverySaves[0];
  assert.ok(firstAttempt.composeId);
  assert.equal(firstAttempt.revision, 0);
  assert.equal(firstAttempt.content.text, 'First draft snapshot');

  const retryBtn = page.button('Retry save draft');
  assert.ok(retryBtn);
  await retryBtn.dispatch('click');
  await tick();

  assert.equal(recoverySaves.length, 2);
  const secondAttempt = recoverySaves[1];
  assert.equal(secondAttempt.composeId, firstAttempt.composeId);
  assert.equal(secondAttempt.revision, firstAttempt.revision);
  assert.deepEqual(secondAttempt.content, firstAttempt.content);
  assert.match(page.body.textContent, /Draft saved/);
  view.reset();
});

test('unknown ACK success followed by newer edits flushes retained snapshot then newer edits sequentially', { timeout: 1000 }, async t => {
  const page = dom(t);
  const recoverySaves = [];
  let shouldFail = true;
  const view = createComposeView({
    autosaveDebounceMs: 5,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery') {
        if (!options?.body) return { drafts: [] };
        recoverySaves.push(structuredClone(options.body));
        if (shouldFail) {
          shouldFail = false;
          throw new Error('NETWORK_TIMEOUT');
        }
        return { saved: true, composeId: options.body.composeId, revision: recoverySaves.length - 1, replayed: true };
      }
      return {};
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'recipient@example.test';
  page.field('text').value = 'First draft snapshot';
  page.field('text').dispatch('input');

  await new Promise(r => setTimeout(r, 20));
  assert.equal(recoverySaves.length, 1);
  const firstAttempt = recoverySaves[0];

  page.field('text').value = 'First draft snapshot plus newer edit';
  page.field('text').dispatch('input');

  const retryBtn = page.button('Retry save draft');
  assert.ok(retryBtn);
  await retryBtn.dispatch('click');
  await tick();

  assert.equal(recoverySaves.length, 3);
  const secondAttempt = recoverySaves[1];
  assert.equal(secondAttempt.composeId, firstAttempt.composeId);
  assert.equal(secondAttempt.revision, firstAttempt.revision);
  assert.deepEqual(secondAttempt.content, firstAttempt.content);

  const thirdAttempt = recoverySaves[2];
  assert.equal(thirdAttempt.composeId, firstAttempt.composeId);
  assert.equal(thirdAttempt.revision, 1);
  assert.equal(thirdAttempt.content.text, 'First draft snapshot plus newer edit');
  assert.match(page.body.textContent, /Draft saved/);
  view.reset();
});

test('pending save plus new edit flushes latest recovery revision before sending', { timeout: 1000 }, async t => {
  const page = dom(t);
  const recoverySaves = [];
  const sendCalls = [];
  let resolveFirstSave;
  const view = createComposeView({
    autosaveDebounceMs: 5,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery') {
        if (!options?.body) return { drafts: [] };
        recoverySaves.push(structuredClone(options.body));
        if (recoverySaves.length === 1) {
          return new Promise(r => { resolveFirstSave = () => r({ saved: true, composeId: 'rec-1', revision: 1 }); });
        }
        return { saved: true, composeId: 'rec-1', revision: 2 };
      }
      if (path === '/api/mail/send') {
        sendCalls.push(options.body);
        return { sent: true, status: 'sent' };
      }
      return {};
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'recipient@example.test';
  page.field('text').value = 'Edit 1';
  page.field('text').dispatch('input');

  await new Promise(r => setTimeout(r, 20));
  assert.equal(recoverySaves.length, 1);

  page.field('text').value = 'Edit 2 (latest)';
  page.field('text').dispatch('input');

  page.button('Send').dispatch('click');
  const sendPromise = page.button('Send message').dispatch('click');

  resolveFirstSave();
  await sendPromise;

  assert.equal(recoverySaves.length, 2);
  assert.equal(recoverySaves[1].content.text, 'Edit 2 (latest)');
  assert.equal(recoverySaves[1].revision, 1);

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].composeId, 'rec-1');
  assert.equal(sendCalls[0].recoveryRevision, 2);
  assert.equal(sendCalls[0].text, 'Edit 2 (latest)');
  view.reset();
});

test('immediate send before debounce awaits flush and sends with recovery identity', { timeout: 1000 }, async t => {
  const page = dom(t);
  const recoverySaves = [];
  const sendCalls = [];
  const view = createComposeView({
    autosaveDebounceMs: 750,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery') {
        if (!options?.body) return { drafts: [] };
        recoverySaves.push(structuredClone(options.body));
        return { saved: true, composeId: options.body.composeId || 'rec-imm', revision: 1 };
      }
      if (path === '/api/mail/send') {
        sendCalls.push(options.body);
        return { sent: true, status: 'sent' };
      }
      return {};
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'recipient@example.test';
  page.field('text').value = 'Immediate send text';
  page.field('text').dispatch('input');

  page.button('Send').dispatch('click');
  await page.button('Send message').dispatch('click');

  assert.equal(recoverySaves.length, 1);
  assert.equal(recoverySaves[0].content.text, 'Immediate send text');
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].composeId, recoverySaves[0].composeId);
  assert.equal(sendCalls[0].recoveryRevision, 1);
  assert.equal(sendCalls[0].text, 'Immediate send text');
  view.reset();
});

test('recovery flush disconnect blocks send safely and preserves input content', { timeout: 1000 }, async t => {
  const page = dom(t);
  const sendCalls = [];
  const view = createComposeView({
    autosaveDebounceMs: 750,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery' && options?.body) {
        throw new Error('NETWORK_DISCONNECTED');
      }
      if (path === '/api/mail/send') {
        sendCalls.push(options.body);
        return { sent: true };
      }
      return { drafts: [] };
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'recipient@example.test';
  page.field('text').value = 'Critical unsent text';
  page.field('text').dispatch('input');

  page.button('Send').dispatch('click');
  await page.button('Send message').dispatch('click');

  assert.equal(sendCalls.length, 0);
  assert.equal(page.field('text').value, 'Critical unsent text');
  assert.match(page.body.textContent, /Could not save draft before sending|Text preserved/);
  assert.equal(page.button('Send').disabled, false);
  view.reset();
});

test('stale restore and signature responses after reset never rehydrate into view', { timeout: 1000 }, async t => {
  const page = dom(t);
  let resolveRestore, resolveSig;
  const view = createComposeView({
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery/read') {
        return new Promise(r => { resolveRestore = r; });
      }
      if (path === '/api/mail/compose/preferences/read') {
        return new Promise(r => { resolveSig = r; });
      }
      return { drafts: [] };
    }
  });
  page.cleanup(view);
  const openPromise = view.open({ composeId: 'rec-slow' });
  await tick();
  view.reset();

  if (resolveRestore) resolveRestore({
    composeId: 'rec-slow',
    revision: 1,
    content: { accountId: 'fixture', to: 'leaked@example.test', text: 'PRIVATE_LEAK' }
  });
  if (resolveSig) resolveSig({ signature: 'PRIVATE_SIGNATURE' });
  await openPromise;

  assert.equal(page.field('text').value, '');
  assert.equal(page.field('to').value, '');
  assert.doesNotMatch(page.body.textContent, /PRIVATE_LEAK|PRIVATE_SIGNATURE|leaked@example\.test/);
  assert.equal(page.body.children[0].open, false);
});

test('restored draft preserves providerDraftId, inReplyTo, and references for context', { timeout: 1000 }, async t => {
  const page = dom(t);
  const sendCalls = [];
  const view = createComposeView({
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery/read') {
        return {
          composeId: 'rec-reply',
          revision: 2,
          content: {
            accountId: 'fixture',
            to: 'author@example.test',
            subject: 'Re: Previous discussion',
            text: 'My reply body',
            inReplyTo: '<parent-msg@example.test>',
            references: '<grandparent@example.test> <parent-msg@example.test>',
            providerDraftId: 'remote-draft-123'
          }
        };
      }
      if (path === '/api/mail/compose/recovery') {
        return { saved: true, composeId: 'rec-reply', revision: 3 };
      }
      if (path === '/api/mail/send') {
        sendCalls.push(options.body);
        return { sent: true, status: 'sent' };
      }
      return { drafts: [] };
    }
  });
  page.cleanup(view);
  await view.open({ composeId: 'rec-reply' });
  assert.equal(page.field('subject').value, 'Re: Previous discussion');

  page.button('Send').dispatch('click');
  await page.button('Send message').dispatch('click');

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].draftId, 'remote-draft-123');
  assert.equal(sendCalls[0].inReplyTo, '<parent-msg@example.test>');
  assert.equal(sendCalls[0].references, '<grandparent@example.test> <parent-msg@example.test>');
  view.reset();
});

test('explicit discard waits for in-flight save and deletes server recovery entry', { timeout: 1000 }, async t => {
  const page = dom(t);
  let resolveSave;
  const discarded = [];
  const view = createComposeView({
    autosaveDebounceMs: 5,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery' && options?.body) {
        return new Promise(r => { resolveSave = () => r({ saved: true, composeId: 'rec-to-discard', revision: 1 }); });
      }
      if (path === '/api/mail/compose/recovery/discard') {
        discarded.push(options.body);
        return { discarded: true };
      }
      return { drafts: [] };
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('text').value = 'Unsaved content to be discarded';
  page.field('text').dispatch('input');

  await new Promise(r => setTimeout(r, 20));
  view.close();
  assert.match(page.body.textContent, /Discard unsaved changes/);

  const discardBtn = page.button('Discard changes');
  const discardPromise = discardBtn.dispatch('click');

  resolveSave();
  await discardPromise;

  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].composeId, 'rec-to-discard');
  assert.equal(page.body.children[0].open, false);
  view.reset();
});

test('all drafts in recovery list are selectable and show subject, account, and updated time', async t => {
  const page = dom(t);
  const view = createComposeView({
    api: async path => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery') {
        return {
          drafts: [
            { composeId: 'd1', revision: 1, accountId: 'fixture', subject: 'Subject One', updatedAt: '2026-09-20T10:00:00Z' },
            { composeId: 'd2', revision: 1, accountId: 'fixture', subject: 'Subject Two', updatedAt: '2026-09-20T10:05:00Z' },
            { composeId: 'd3', revision: 1, accountId: 'fixture', subject: 'Subject Three', updatedAt: '2026-09-20T10:10:00Z' }
          ]
        };
      }
      return {};
    }
  });
  await view.open({ mode: 'new' });
  const banner = page.find(i => i.className === 'compose-recovery-banner');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /Subject One/);
  assert.match(banner.textContent, /Subject Two/);
  assert.match(banner.textContent, /Subject Three/);

  const restoreButtons = page.all().filter(i => i.tagName === 'button' && i.textContent === 'Restore');
  assert.equal(restoreButtons.length, 3);
  view.reset();
});

test('invalid clipboard-only HTML without plain text is blocked from editor', async t => {
  const page = dom(t);
  const view = createComposeView({ api: async () => settings });
  await view.open();

  const editor = page.find(i => i.className === 'compose-editor-content');
  editor.dispatch('paste', {
    clipboardData: {
      files: [],
      getData: type => type === 'text/html' ? '<div onclick="steal()">Dangerous HTML</div>' : ''
    }
  });
  await tick();

  assert.equal(editor.textContent, '');
  assert.equal(page.field('text').value, '');
  view.reset();
});

test('changing From account on local draft rebinds and saves to newly selected account', { timeout: 1000 }, async t => {
  const page = dom(t);
  const twoAccounts = {
    accounts: [
      { accountId: 'acct-1', label: 'First', email: 'first@example.test', host: 'smtp.example.test', port: 587, authType: 'password', sentCopy: true },
      { accountId: 'acct-2', label: 'Second', email: 'second@example.test', host: 'smtp.example.test', port: 587, authType: 'password', sentCopy: true }
    ]
  };
  const recoverySaves = [];
  const view = createComposeView({
    autosaveDebounceMs: 5,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return twoAccounts;
      if (path === '/api/mail/compose/recovery') {
        if (!options?.body) return { drafts: [] };
        recoverySaves.push(structuredClone(options.body));
        return { saved: true, composeId: 'rec-rebind', revision: recoverySaves.length };
      }
      if (path === '/api/mail/compose/preferences/read') return { signature: '' };
      return {};
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'recipient@example.test';
  page.field('text').value = 'Draft under first account';
  page.field('text').dispatch('input');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(recoverySaves.length, 1);
  assert.equal(recoverySaves[0].content.accountId, 'acct-1');

  page.field('accountId').value = 'acct-2';
  page.field('accountId').dispatch('change');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(recoverySaves.length, 2);
  assert.equal(recoverySaves[1].content.accountId, 'acct-2');
  assert.equal(page.field('text').value, 'Draft under first account');
  view.reset();
});

test('closing composer after draft is safely saved closes cleanly without warning', { timeout: 1000 }, async t => {
  const page = dom(t);
  const view = createComposeView({
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/draft') return { saved: true, draftId: 'saved-1' };
      if (path === '/api/mail/compose/recovery') return { saved: true, composeId: 'rec-1', revision: 1 };
      return { drafts: [] };
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('text').value = 'Will be saved';
  page.field('text').dispatch('input');

  await page.button('Save draft').dispatch('click');
  view.close();

  assert.equal(page.body.children[0].open, false);
  assert.equal(page.find(i => i.className === 'compose-discard').hidden, true);
  view.reset();
});

test('confirmed provider Save adopts returned draftId, composeId, and recoveryRevision', { timeout: 1000 }, async t => {
  const page = dom(t);
  const view = createComposeView({
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery') return { saved: true, composeId: 'rec-temp', revision: 1 };
      if (path === '/api/mail/draft') {
        return {
          saved: true,
          draftId: 'confirmed-draft-id',
          composeId: 'confirmed-compose-id',
          recoveryRevision: 4
        };
      }
      return { drafts: [] };
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('text').value = 'Body to save to provider';
  page.field('text').dispatch('input');

  await page.button('Save draft').dispatch('click');
  assert.match(page.body.textContent, /Draft saved/);

  page.field('accountId').value = 'other-account';
  page.field('accountId').dispatch('change');
  assert.match(page.body.textContent, /An existing draft must stay in its original account/);
  view.reset();
});

test('oversized drop rejects before reading and reset mid-reading cancels file additions', { timeout: 1000 }, async t => {
  const page = dom(t);
  let readHuge = false, readHang = false;
  let resolveHang;
  const view = createComposeView({ api: async () => settings });
  page.cleanup(view);
  await view.open();

  const form = page.find(i => i.className === 'compose-form');
  form.dispatch('drop', {
    dataTransfer: {
      files: [{ name: 'oversized.zip', size: 25 * 1024 * 1024 + 500, arrayBuffer: async () => { readHuge = true; } }]
    }
  });
  await tick();
  assert.equal(readHuge, false);
  assert.match(page.body.textContent, /25 MiB or less/);

  const slowFile = {
    name: 'slow.bin',
    size: 100,
    arrayBuffer: () => new Promise(r => { resolveHang = r; readHang = true; })
  };
  form.dispatch('drop', { dataTransfer: { files: [slowFile] } });
  await tick();
  assert.equal(readHang, true);

  view.reset();
  resolveHang(new ArrayBuffer(100));
  await tick();

  assert.equal(page.all().filter(i => i.className === 'compose-file-name').length, 0);
  view.reset();
});

test('oversized plain body (>200000 chars) preserves editor text, blocks save, send, and review, and recovers when reduced', { timeout: 1000 }, async t => {
  const page = dom(t);
  const recoverySaves = [];
  const draftSaves = [];
  const sendCalls = [];
  const view = createComposeView({
    autosaveDebounceMs: 5,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery') {
        if (!options?.body) return { drafts: [] };
        recoverySaves.push(structuredClone(options.body));
        return { saved: true, composeId: options.body.composeId || 'rec-oversized', revision: (options.body.revision || 0) + 1 };
      }
      if (path === '/api/mail/draft') {
        draftSaves.push(options.body);
        return { saved: true, draftId: 'draft-oversized' };
      }
      if (path === '/api/mail/send') {
        sendCalls.push(options.body);
        return { sent: true, status: 'sent' };
      }
      return {};
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'recipient@example.test';

  const hugePlain = 'A'.repeat(200001);
  page.field('text').value = hugePlain;
  page.field('text').dispatch('input');

  await new Promise(r => setTimeout(r, 20));

  // 1. Editor text unmodified
  assert.equal(page.field('text').value, hugePlain);
  assert.equal(page.field('text').value.length, 200001);

  // 2. Zero recovery/provider API writes
  assert.equal(recoverySaves.length, 0);
  assert.equal(draftSaves.length, 0);
  assert.equal(sendCalls.length, 0);

  // 3. No false saved status; clear error message shown
  assert.doesNotMatch(page.body.textContent, /Draft saved/);
  assert.match(page.body.textContent, /Message is too large to save\. Shorten it before saving or sending\./);

  // 4. Save draft blocked
  await page.button('Save draft').dispatch('click');
  assert.equal(draftSaves.length, 0);
  assert.equal(recoverySaves.length, 0);
  assert.doesNotMatch(page.body.textContent, /Draft saved/);

  // 5. Review blocked
  page.button('Send').dispatch('click');
  assert.equal(page.find(item => item.className === 'compose-review').hidden, true);
  assert.equal(sendCalls.length, 0);

  // 6. After reducing content autosave/send work normally
  const normalPlain = 'Reduced plain text';
  page.field('text').value = normalPlain;
  page.field('text').dispatch('input');

  await new Promise(r => setTimeout(r, 20));
  assert.equal(recoverySaves.length, 1);
  assert.equal(recoverySaves[0].content.text, normalPlain);
  assert.match(page.body.textContent, /Draft saved/);

  page.button('Send').dispatch('click');
  assert.equal(page.find(item => item.className === 'compose-review').hidden, false);
  await page.button('Send message').dispatch('click');
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].text, normalPlain);
  assert.match(page.body.textContent, /Message sent/);
  view.reset();
});

test('oversized rich HTML body (>400000 chars) preserves editor HTML, blocks save, send, and review, and recovers when reduced', { timeout: 1000 }, async t => {
  const page = dom(t);
  const recoverySaves = [];
  const draftSaves = [];
  const sendCalls = [];
  const view = createComposeView({
    autosaveDebounceMs: 5,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/recovery') {
        if (!options?.body) return { drafts: [] };
        recoverySaves.push(structuredClone(options.body));
        return { saved: true, composeId: options.body.composeId || 'rec-oversized-html', revision: (options.body.revision || 0) + 1 };
      }
      if (path === '/api/mail/draft') {
        draftSaves.push(options.body);
        return { saved: true, draftId: 'draft-oversized-html' };
      }
      if (path === '/api/mail/send') {
        sendCalls.push(options.body);
        return { sent: true, status: 'sent' };
      }
      return {};
    }
  });
  page.cleanup(view);
  await view.open();
  page.field('to').value = 'recipient@example.test';

  const editor = page.find(item => item.className === 'compose-editor-content');
  assert.ok(editor);

  // HTML > 400000 while plain text is well below 200000 limit
  const hugeHtml = '<p>' + '<b><em>X</em></b>'.repeat(25000) + '</p>';
  editor.innerHTML = hugeHtml;
  editor.dispatch('input');

  await new Promise(r => setTimeout(r, 20));

  // 1. Editor HTML unmodified
  assert.equal(editor.innerHTML, hugeHtml);

  // 2. Zero recovery/provider API writes
  assert.equal(recoverySaves.length, 0);
  assert.equal(draftSaves.length, 0);
  assert.equal(sendCalls.length, 0);

  // 3. No false saved status; clear error message shown
  assert.doesNotMatch(page.body.textContent, /Draft saved/);
  assert.match(page.body.textContent, /Message is too large to save\. Shorten it before saving or sending\./);

  // 4. Save draft blocked
  await page.button('Save draft').dispatch('click');
  assert.equal(draftSaves.length, 0);
  assert.equal(recoverySaves.length, 0);
  assert.doesNotMatch(page.body.textContent, /Draft saved/);

  // 5. Review blocked
  page.button('Send').dispatch('click');
  assert.equal(page.find(item => item.className === 'compose-review').hidden, true);
  assert.equal(sendCalls.length, 0);

  // 6. After reducing content autosave/send work normally
  editor.innerHTML = '<p>Normal <b>formatted</b> body</p>';
  editor.dispatch('input');

  await new Promise(r => setTimeout(r, 20));
  assert.equal(recoverySaves.length, 1);
  assert.match(page.body.textContent, /Draft saved/);

  page.button('Send').dispatch('click');
  assert.equal(page.find(item => item.className === 'compose-review').hidden, false);
  await page.button('Send message').dispatch('click');
  assert.equal(sendCalls.length, 1);
  assert.match(sendCalls[0].html, /<b>formatted<\/b>/);
  assert.match(page.body.textContent, /Message sent/);
  view.reset();
});

test('reply opens under provided anchor, new and forward remain docked in body', async t => {
  const page = dom(t);
  const anchor = new Element('div');
  page.body.append(anchor);

  const view = createComposeView({
    api: async (path) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/context') return { accountId: 'fixture', to: 'replyto@example.test', text: 'Original message text' };
      if (path === '/api/mail/compose/preferences/read') return { signature: '' };
      return {};
    }
  });
  page.cleanup(view);

  // 1. Reply with connected anchor moves into anchor and gains is-inline
  await view.open({ mode: 'reply', id: 'm1', accountId: 'fixture', anchor });
  const dialog = page.find(n => n.tagName === 'dialog');
  assert.ok(dialog);
  assert.equal(dialog.parentElement, anchor, 'dialog must be child of anchor');
  assert.equal(anchor.children[0], dialog);
  assert.match(dialog.className, /\bis-inline\b/);
  assert.equal(dialog.open, true);
  assert.equal(dialog.modal, false, 'must be nonmodal dialog');
  assert.equal(page.find(n => n.id === 'compose-title').textContent, 'Reply');

  // 2. New message with anchor ignores anchor and remains in document.body
  await view.open({ mode: 'new', anchor });
  assert.equal(dialog.parentElement, page.body, 'new message must be in document.body');
  assert.doesNotMatch(dialog.className, /\bis-inline\b/);

  // 3. Forward with anchor ignores anchor and remains in document.body
  await view.open({ mode: 'forward', id: 'm1', accountId: 'fixture', anchor });
  assert.equal(dialog.parentElement, page.body, 'forward must be in document.body');
  assert.doesNotMatch(dialog.className, /\bis-inline\b/);

  // 4. Reply with disconnected anchor remains in document.body
  const disconnected = new Element('div');
  await view.open({ mode: 'reply', id: 'm1', accountId: 'fixture', anchor: disconnected });
  assert.equal(dialog.parentElement, page.body, 'disconnected anchor must fall back to document.body');
  assert.doesNotMatch(dialog.className, /\bis-inline\b/);

  view.reset();
});

test('same editor and fields survive dock(anchor), navigation-style detach afterdock, and autosave continues with same ID/revision', async t => {
  const page = dom(t);
  const anchor = new Element('div');
  page.body.append(anchor);

  const recoverySaves = [];
  const view = createComposeView({
    autosaveDebounceMs: 5,
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/context') return { accountId: 'fixture', to: 'alice@example.test', text: 'Hi Alice' };
      if (path === '/api/mail/compose/preferences/read') return { signature: '' };
      if (path === '/api/mail/compose/recovery') {
        if (!options?.body) return { drafts: [] };
        recoverySaves.push(structuredClone(options.body));
        return { saved: true, composeId: options.body.composeId || 'comp-survive-1', revision: (options.body.revision || 0) + 1 };
      }
      return {};
    }
  });
  page.cleanup(view);

  await view.open({ mode: 'reply', id: 'm1', accountId: 'fixture', anchor });
  const dialog = page.find(n => n.tagName === 'dialog');
  assert.equal(dialog.parentElement, anchor);
  assert.match(dialog.className, /\bis-inline\b/);

  // Type in editor and verify initial autosave
  page.field('text').value = 'Drafting inline reply text';
  page.field('text').dispatch('input');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(recoverySaves.length, 1);
  const composeId = recoverySaves[0].composeId;
  assert.ok(typeof composeId === 'string' && composeId.length > 0);
  assert.equal(recoverySaves[0].revision, 0);
  assert.equal(recoverySaves[0].content.text, 'Drafting inline reply text');

  // Dock composer to document.body
  view.dock(anchor);
  assert.equal(dialog.parentElement, page.body, 'dialog must be moved to document.body');
  assert.doesNotMatch(dialog.className, /\bis-inline\b/, 'is-inline class must be removed');
  assert.equal(page.field('to').value, 'alice@example.test', 'recipients must survive dock');
  assert.equal(page.field('text').value, 'Drafting inline reply text', 'editor content must survive dock');

  // Navigation detach: anchor is removed from DOM, but dialog was already docked in body
  anchor.remove();
  assert.ok(page.body.contains(dialog), 'dialog must remain connected in document.body');

  // Continue typing after dock: autosave continues with same composeId and incremented revision
  page.field('text').value = 'Continued text after navigation dock';
  page.field('text').dispatch('input');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(recoverySaves.length, 2);
  assert.equal(recoverySaves[1].composeId, composeId, 'must preserve same composeId');
  assert.equal(recoverySaves[1].revision, 1, 'must continue with incremented revision');
  assert.equal(recoverySaves[1].content.text, 'Continued text after navigation dock');

  view.reset();
});

test('wrong-anchor dock is a no-op and preserves current inline state', async t => {
  const page = dom(t);
  const anchor1 = new Element('div');
  const anchor2 = new Element('div');
  page.body.append(anchor1, anchor2);

  const view = createComposeView({
    api: async (path) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/context') return { accountId: 'fixture', to: 'test@example.test', text: 'Text' };
      if (path === '/api/mail/compose/preferences/read') return { signature: '' };
      return {};
    }
  });
  page.cleanup(view);

  await view.open({ mode: 'reply', id: 'm1', accountId: 'fixture', anchor: anchor1 });
  const dialog = page.find(n => n.tagName === 'dialog');
  assert.equal(dialog.parentElement, anchor1);
  assert.match(dialog.className, /\bis-inline\b/);

  // Calling dock with wrong anchor is no-op
  view.dock(anchor2);
  assert.equal(dialog.parentElement, anchor1, 'dialog must remain inside anchor1');
  assert.match(dialog.className, /\bis-inline\b/);

  // Calling dock with correct anchor docks to body
  view.dock(anchor1);
  assert.equal(dialog.parentElement, page.body, 'dialog must now be in document.body');
  assert.doesNotMatch(dialog.className, /\bis-inline\b/);

  view.reset();
});

test('dirty and busy open guards preserve original anchor and content without reparenting or clearing', async t => {
  const page = dom(t);
  const anchor1 = new Element('div');
  const anchor2 = new Element('div');
  page.body.append(anchor1, anchor2);

  let resolveSlow;
  const view = createComposeView({
    api: async (path) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/context') return { accountId: 'fixture', to: 'original@example.test', text: 'Original content' };
      if (path === '/api/mail/compose/preferences/read') return { signature: '' };
      return {};
    }
  });
  page.cleanup(view);

  await view.open({ mode: 'reply', id: 'm1', accountId: 'fixture', anchor: anchor1 });
  const dialog = page.find(n => n.tagName === 'dialog');
  assert.equal(dialog.parentElement, anchor1);

  // Modify to make dirty
  page.field('text').value = 'Unsaved modifications';
  page.field('text').dispatch('input');

  // Attempt to open another reply under anchor2: guard triggers
  await view.open({ mode: 'reply', id: 'm2', accountId: 'fixture', anchor: anchor2 });

  assert.equal(dialog.parentElement, anchor1, 'must preserve original anchor location');
  assert.match(dialog.className, /\bis-inline\b/);
  assert.equal(page.field('text').value, 'Unsaved modifications', 'must preserve draft text');
  assert.match(page.body.textContent, /Save or close the current message before opening another/);

  view.reset();
});

test('minimize and expand explicitly dock composer first before resizing', async t => {
  const page = dom(t);
  const anchor = new Element('div');
  page.body.append(anchor);

  const view = createComposeView({
    api: async (path) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/context') return { accountId: 'fixture', to: 'user@example.test', text: 'Body' };
      if (path === '/api/mail/compose/preferences/read') return { signature: '' };
      return {};
    }
  });
  page.cleanup(view);

  await view.open({ mode: 'reply', id: 'm1', accountId: 'fixture', anchor });
  const dialog = page.find(n => n.tagName === 'dialog');
  assert.equal(dialog.parentElement, anchor);
  assert.match(dialog.className, /\bis-inline\b/);

  // Minimize docks to body and adds is-minimized
  page.button('Minimize composer').dispatch('click');
  assert.equal(dialog.parentElement, page.body, 'must dock to body on minimize');
  assert.doesNotMatch(dialog.className, /\bis-inline\b/, 'is-inline removed on minimize');
  assert.match(dialog.className, /\bis-minimized\b/);

  // Restore composer, re-open inline
  page.button('Restore composer').dispatch('click');
  await view.open({ mode: 'reply', id: 'm1', accountId: 'fixture', anchor });
  assert.equal(dialog.parentElement, anchor);
  assert.match(dialog.className, /\bis-inline\b/);

  // Expand docks to body and adds is-expanded
  page.button('Expand composer').dispatch('click');
  assert.equal(dialog.parentElement, page.body, 'must dock to body on expand');
  assert.doesNotMatch(dialog.className, /\bis-inline\b/, 'is-inline removed on expand');
  assert.match(dialog.className, /\bis-expanded\b/);

  view.reset();
});

test('close and reset leave no sensitive content in host subtree and restore docked body state', async t => {
  const page = dom(t);
  const anchor = new Element('div');
  page.body.append(anchor);

  const view = createComposeView({
    api: async (path) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/context') return { accountId: 'fixture', to: 'sensitive@example.test', text: 'Top Secret Body' };
      if (path === '/api/mail/compose/preferences/read') return { signature: '' };
      return {};
    }
  });
  page.cleanup(view);

  await view.open({ mode: 'reply', id: 'm1', accountId: 'fixture', anchor });
  const dialog = page.find(n => n.tagName === 'dialog');
  assert.equal(dialog.parentElement, anchor);
  assert.match(anchor.textContent, /Top Secret Body/);

  // Reset docks dialog to body, clears sensitive fields, closes dialog
  view.reset();
  assert.equal(dialog.parentElement, page.body, 'dialog must return to document.body on reset');
  assert.doesNotMatch(dialog.className, /\bis-inline\b/);
  assert.equal(dialog.open, false);
  assert.equal(anchor.children.length, 0, 'anchor must have no children left');
  assert.doesNotMatch(anchor.textContent, /Top Secret Body/);
  assert.equal(page.field('text').value, '');
});

test('inline composer preserves two-click review and uncertain-send locks', async t => {
  const page = dom(t);
  const anchor = new Element('div');
  page.body.append(anchor);
  const sendCalls = [];

  const view = createComposeView({
    api: async (path, options) => {
      if (path === '/api/mail/smtp') return settings;
      if (path === '/api/mail/compose/context') return { accountId: 'fixture', to: 'lead@example.test', text: 'Important project update' };
      if (path === '/api/mail/compose/preferences/read') return { signature: '' };
      if (path === '/api/mail/compose/recovery') return options?.body ? { saved: true, composeId: 'rec-lock', revision: 1 } : { drafts: [] };
      if (path === '/api/mail/send') {
        sendCalls.push(options.body);
        throw { code: 'send_uncertain' };
      }
      return {};
    }
  });
  page.cleanup(view);

  await view.open({ mode: 'reply', id: 'm1', accountId: 'fixture', anchor });
  const dialog = page.find(n => n.tagName === 'dialog');
  assert.equal(dialog.parentElement, anchor);

  // First click: review panel shown, no send yet
  page.button('Send').dispatch('click');
  assert.equal(sendCalls.length, 0);
  const reviewPanel = page.find(n => n.className === 'compose-review');
  assert.equal(reviewPanel.hidden, false);

  // Second click: send triggers uncertain error and locks composer
  await page.button('Send message').dispatch('click');
  assert.equal(sendCalls.length, 1);
  assert.match(page.body.textContent, /Delivery could not be confirmed/);
  assert.equal(page.button('Send message').disabled, true);
  assert.equal(page.button('Save draft').disabled, true);

  // Repetitive clicks blocked while locked
  await page.button('Send message').dispatch('click');
  assert.equal(sendCalls.length, 1, 'no further send attempts while locked');

  view.reset();
});

test('native reparenting needs no Array methods on parent children and unopened dock does not build a composer', async t => {
  const page = dom(t);
  const view = createComposeView({api: async path => {
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/context') return {accountId: 'fixture', to: 'a@example.test', text: 'Keep this reply'};
    return {};
  }});
  page.cleanup(view);
  view.dock();
  assert.equal(page.find(node => node.tagName === 'dialog'), undefined);
  const anchor = new Element('div');
  page.body.append(anchor);
  // Native HTMLCollection does not expose indexOf/splice. Mock DOM's append/removeChild
  // model browser reparenting without relying on these collection properties.
  page.body.children.indexOf = undefined;
  page.body.children.splice = undefined;
  anchor.children.indexOf = undefined;
  anchor.children.splice = undefined;
  await view.open({mode: 'reply', id: 'm', anchor});
  const dialog = page.find(node => node.tagName === 'dialog');
  const text = page.field('text');
  assert.equal(dialog.parentElement, anchor);
  view.dock(anchor);
  assert.equal(dialog.parentElement, page.body);
  assert.equal(page.field('text'), text);
  assert.equal(text.value, 'Keep this reply');
  assert.equal(anchor.children.length, 0);
});

test('explicit inline reply focuses without scrolling before bringing the composer into view', async t => {
  const page = dom(t), anchor = new Element('div');
  page.body.append(anchor);
  const view = createComposeView({api: async path => {
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/context') return {accountId:'fixture',to:'alex@example.test',text:'Reply'};
    return {};
  }});
  page.cleanup(view);
  await view.open();
  const dialog = page.find(node => node.tagName === 'dialog');
  const editor = page.find(node => node.className === 'compose-editor-content');
  const events = [];
  editor.focus = options => {
    events.push(['focus', options]);
    document.activeElement = editor;
    if (!options?.preventScroll) anchor.scrollTop = 732.5;
  };
  dialog.scrollIntoView = options => {
    events.push(['scroll', options]);
    anchor.scrollTop = 1300;
  };
  await view.open({mode:'reply',id:'long-pdf',anchor});
  assert.deepEqual(events, [['focus',{preventScroll:true}],['scroll',{behavior:'instant',block:'start'}]]);
  assert.equal(document.activeElement, editor);
  assert.equal(anchor.scrollTop, 1300);
  view.dock(anchor);
  assert.equal(events.length, 2, 'Docking preserves position without another explicit scroll');
});

test('committed recipients show chips once and Edit exposes the canonical addresses without duplicate chips', async t => {
  const page = dom(t), saves = [];
  const view = createComposeView({autosaveDebounceMs:5,api: async (path, options) => {
    if (path === '/api/mail/smtp') return settings;
    if (path === '/api/mail/compose/context') return {accountId:'fixture',to:'alex@example.test',cc:'copy@example.test',bcc:'private@example.test',text:'Reply'};
    if (path === '/api/mail/compose/recovery' && options?.body) {
      saves.push(options.body.content);
      return {composeId:options.body.composeId,revision:1};
    }
    return {};
  }});
  page.cleanup(view);
  await view.open({mode:'reply_all',id:'m'});
  for (const [name,label] of [['to','To'],['cc','Cc'],['bcc','Bcc']]) {
    const input = page.field(name), chips = input.parentElement.querySelector('.compose-chips');
    assert.equal(input.hidden, true, `${label} canonical input is hidden while chips show`);
    assert.equal(chips.hidden, false);
    assert.equal(page.button(`Edit ${label} recipients`).hidden, false);
    page.button(`Edit ${label} recipients`).dispatch('click');
    assert.equal(input.hidden, false);
    assert.equal(chips.hidden, true, 'Editing never duplicates the address in chips');
    input.dispatch('blur');
    assert.equal(input.hidden, true);
    assert.equal(chips.hidden, false);
  }
  page.button('Edit To recipients').dispatch('click');
  page.field('to').value += ', added@example.test';
  page.field('to').dispatch('input');
  page.field('to').dispatch('blur');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(saves.at(-1).to, 'alex@example.test, added@example.test');
  page.button('Remove alex@example.test').dispatch('click');
  page.button('Remove added@example.test').dispatch('click');
  assert.equal(page.field('to').value, '');
  assert.equal(page.field('to').hidden, false, 'Removing the final chip exposes the empty input');
  assert.equal(page.button('Edit To recipients').hidden, true);
});
