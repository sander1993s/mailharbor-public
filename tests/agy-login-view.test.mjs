import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createAgyLoginView } from '../web/agy-login.mjs';

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
  removeAttribute(name) { this.attributes.delete(name); if (name === 'href') delete this.href; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  dispatch(name) { return this.events.get(name)?.({ preventDefault() {}, target: this }); }
  nodes() { return this.children.flatMap(child => [child, ...child.nodes()]); }
}
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=one';
const waiting = () => ({ state: 'awaiting_code', url: AUTH_URL, expiresAt: new Date(Date.now() + 600000).toISOString() });

function setup(t, { api, initial = { state: 'idle' }, maxPolls = 400 } = {}) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = new Element('document'); document.root = true; document.visibilityState = 'visible'; document.createElement = tag => new Element(tag);
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  const root = new Element('section'); document.append(root);
  const calls = []; let model = initial, connected = 0;
  const view = createAgyLoginView({ root, maxPolls, pollInterval: 1500, onConnected: () => { connected++; }, api: async (path, options) => {
    calls.push({ path, ...options });
    if (api) return api(path, options);
    if (options.method === 'POST') model = path.endsWith('/code') ? { state: 'verifying' } : waiting();
    if (options.method === 'DELETE') model = { state: 'cancelled' };
    return structuredClone(model);
  } });
  t.after(() => { view.reset(); if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document; });
  const nodes = () => root.nodes();
  return { view, root, calls, document, nodes,
    button: title => nodes().find(node => node.tagName === 'button' && node.textContent === title),
    code: () => nodes().find(node => node.tagName === 'input'),
    link: () => nodes().find(node => node.tagName === 'a'),
    form: () => nodes().find(node => node.tagName === 'form'),
    connected: () => connected,
    replaceModel(value) { model = value; },
    async show() { view.show(); await nextTurn(); }
  };
}

test('opening Settings only reads sign-in state; a user click starts Google login', async t => {
  const h = setup(t); assert.equal(h.calls.length, 0); await h.show();
  assert.deepEqual(h.calls.map(({ path, method }) => ({ path, method })), [{ path: '/api/agy/login', method: 'GET' }]);
  assert.doesNotMatch(h.root.textContent, /AI sign-in verified/);
  h.button('Reconnect AI').dispatch('click'); await nextTurn();
  assert.deepEqual(h.calls.at(-1).body, {}); assert.equal(h.calls.at(-1).method, 'POST');
  assert.equal(h.link().href, AUTH_URL); assert.equal(h.link().target, '_blank'); assert.equal(h.link().rel, 'noopener noreferrer');
  assert.equal(h.form().parentNode.hidden, false); assert.equal(h.code().type, 'password'); assert.equal(h.code().autocomplete, 'off');
  assert.equal(h.connected(), 0);
});

test('authorization code clears immediately on submit and only verified completion refreshes the app', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish; const h = setup(t, { api: (path, options) => {
    if (path.endsWith('/code')) return new Promise(resolve => { finish = resolve; });
    return options.method === 'GET' ? waiting() : { state: 'idle' };
  } });
  await h.show(); h.code().value = '  FAKE_AUTHORIZATION_CODE  '; h.form().dispatch('submit');
  assert.equal(h.code().value, ''); assert.deepEqual(h.calls.at(-1).body, { code: 'FAKE_AUTHORIZATION_CODE' });
  assert.equal(h.connected(), 0); finish({ state: 'connected' }); await nextTurn();
  assert.equal(h.connected(), 1); assert.match(h.root.textContent, /AI sign-in verified/);
  assert.equal(h.link().href, undefined); assert.equal(h.form().parentNode.hidden, true);
  t.mock.timers.tick(600000); await nextTurn(); assert.equal(h.calls.length, 2);
  h.button('Refresh AI sign-in status').dispatch('click'); await nextTurn(); assert.equal(h.connected(), 1);
  assert.doesNotMatch(h.root.textContent, /FAKE_AUTHORIZATION_CODE/);
});

test('cancel sends DELETE without a body and retry starts a new user-requested flow', async t => {
  const h = setup(t, { initial: waiting() }); await h.show(); h.code().value = 'FAKE_CODE';
  h.button('Cancel sign-in').dispatch('click'); assert.equal(h.code().value, ''); await nextTurn();
  assert.equal(h.calls.at(-1).method, 'DELETE'); assert.equal('body' in h.calls.at(-1), false);
  assert.match(h.root.textContent, /AI sign-in cancelled/); assert.equal(h.link().href, undefined);
  h.button('Retry AI sign-in').dispatch('click'); await nextTurn(); assert.equal(h.calls.at(-1).method, 'POST');
  assert.equal(h.form().parentNode.hidden, false);
});

test('polling is bounded, stops while hidden, and passively resumes after reopening Settings', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(t, { initial: waiting(), maxPolls: 2 }); await h.show();
  t.mock.timers.tick(1500); await nextTurn(); t.mock.timers.tick(1500); await nextTurn();
  assert.equal(h.calls.length, 3); assert.match(h.root.textContent, /Automatic status checks paused/);
  t.mock.timers.tick(90000); await nextTurn(); assert.equal(h.calls.length, 3);
  h.code().value = 'FAKE_CODE'; h.view.hide(); assert.equal(h.code().value, ''); assert.equal(h.link().href, undefined);
  t.mock.timers.tick(90000); await nextTurn(); assert.equal(h.calls.length, 3);
  await h.show(); assert.equal(h.calls.length, 4); assert.equal(h.link().href, AUTH_URL);
  h.code().value = 'ANOTHER_CODE'; h.document.visibilityState = 'hidden'; h.document.dispatch('visibilitychange');
  assert.equal(h.code().value, ''); t.mock.timers.tick(90000); await nextTurn(); assert.equal(h.calls.length, 4);
  h.document.visibilityState = 'visible'; h.document.dispatch('visibilitychange'); await nextTurn(); assert.equal(h.calls.length, 5);
  assert.equal(h.calls.every(call => call.method === 'GET'), true);
});

test('reset and hide abort requests and ignore late success or authorization URLs', async t => {
  const pending = []; const h = setup(t, { api: (path, options) => new Promise(resolve => pending.push({ options, resolve })) });
  await h.show(); h.view.hide(); assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve(waiting()); await nextTurn(); assert.equal(h.link().href, undefined);
  await h.show(); h.view.reset(); assert.equal(pending[1].options.signal.aborted, true);
  pending[1].resolve({ state: 'connected' }); await nextTurn(); assert.equal(h.connected(), 0);
  assert.doesNotMatch(h.root.textContent, /AI sign-in verified/);
  h.button('Reconnect AI').dispatch('click'); h.form().dispatch('submit'); assert.equal(h.calls.length, 2);
  await h.show(); assert.equal(h.calls.length, 3); pending[2].resolve({ state: 'idle' }); await nextTurn();
  assert.equal(h.button('Reconnect AI').disabled, false);
});

test('only expected Google authorization links can be opened and errors cannot reflect secrets', async t => {
  const h = setup(t); await h.show();
  for (const url of ['javascript:alert(1)', 'https://accounts.google.com.attacker.test/o/oauth2/auth', 'https://accounts.google.com/o/oauth2/auth#secret']) {
    h.replaceModel({ state: 'awaiting_code', url }); h.button('Refresh AI sign-in status').dispatch('click'); await nextTurn();
    assert.equal(h.link().href, undefined); assert.equal(h.form().parentNode.hidden, true);
  }
  h.replaceModel({ state: 'failed', error: { code: 'unknown', message: '<img onerror=alert(1)> FAKE_SECRET' } });
  h.button('Refresh AI sign-in status').dispatch('click'); await nextTurn();
  assert.doesNotMatch(h.root.textContent, /FAKE_SECRET|onerror/); assert.equal(h.nodes().some(node => node.tagName === 'img'), false);
  h.replaceModel({ state: 'failed', error: { code: 'quota_exhausted', message: 'FAKE_SECRET' } });
  h.button('Refresh AI sign-in status').dispatch('click'); await nextTurn(); assert.match(h.root.textContent, /does not reset the provider quota/);
});

test('expired provider URLs are hidden and do not cause unbounded polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup(t, { initial: { ...waiting(), expiresAt: new Date(Date.now() - 1000).toISOString() } }); await h.show();
  assert.equal(h.link().href, undefined); assert.equal(h.form().parentNode.hidden, true);
  t.mock.timers.tick(90000); await nextTurn(); assert.equal(h.calls.length, 1);
  assert.match(h.root.textContent, /Refresh the sign-in status/);
});
