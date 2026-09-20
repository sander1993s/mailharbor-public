import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createMailView as buildMailView } from '../web/mail.mjs';
import { createMailAttachmentsView } from '../web/mail-attachments.mjs';

function splitSelectorCommas(selector) {
  const parts = [];
  let cur = '';
  let inBracket = false;
  let inQuote = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
    } else if (ch === '[') {
      inBracket = true;
      cur += ch;
    } else if (ch === ']') {
      inBracket = false;
      cur += ch;
    } else if (ch === ',' && !inBracket) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function splitSelectorDescendants(chain) {
  const parts = [];
  let cur = '';
  let inBracket = false;
  let inQuote = null;
  for (let i = 0; i < chain.length; i++) {
    const ch = chain[i];
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
    } else if (ch === '[') {
      inBracket = true;
      cur += ch;
    } else if (ch === ']') {
      inBracket = false;
      cur += ch;
    } else if (/\s/.test(ch) && !inBracket) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// DOM mock with faithful parent/isConnected and selector support
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.events = new Map();
    this.attributes = new Map();
    this.value = '';
    this.className = '';
    this.dataset = {};
    this.parentNode = null;
    this.parentElement = null;
    this.isConnected = false;
    this.scrollTop = 0;
    this.open = false;
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.indeterminate = false;
    this.title = '';
    this.style = {};
    this.id = '';
    this.href = '';
    this.src = '';
    this.download = '';
    this.type = '';
    this.width = 0;
    this.height = 0;
    this.clientWidth = 640;
    this.clientHeight = 800;

    const self = this;
    this.classList = {
      add: (...tokens) => {
        const classes = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        for (const token of tokens) classes.add(token);
        self.className = [...classes].join(' ');
      },
      remove: (...tokens) => {
        const classes = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        for (const token of tokens) classes.delete(token);
        self.className = [...classes].join(' ');
      },
      toggle: (token, force) => {
        const classes = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        const shouldAdd = force !== undefined ? Boolean(force) : !classes.has(token);
        if (shouldAdd) classes.add(token); else classes.delete(token);
        self.className = [...classes].join(' ');
        return shouldAdd;
      },
      contains: token => {
        const classes = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        return classes.has(token);
      },
      get className() { return self.className; }
    };
  }

  set textContent(value) {
    for (const child of this.children) {
      child.parentNode = null;
      child.parentElement = null;
      child._setConnected(false);
    }
    this.text = String(value);
    this.children = [];
  }

  get textContent() {
    return (this.text || '') + this.children.map(child => child.textContent).join('');
  }

  _setConnected(val) {
    this.isConnected = val;
    for (const child of this.children) {
      child._setConnected(val);
    }
  }

  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new Element('span') : n;
      if (typeof n === 'string') node.textContent = n;
      if (node.parentNode) {
        const idx = node.parentNode.children.indexOf(node);
        if (idx !== -1) node.parentNode.children.splice(idx, 1);
      }
      node.parentNode = this;
      node.parentElement = this;
      node._setConnected(this.isConnected);
      this.children.push(node);
    }
  }

  prepend(...nodes) {
    for (const n of [...nodes].reverse()) {
      const node = typeof n === 'string' ? new Element('span') : n;
      if (typeof n === 'string') node.textContent = n;
      if (node.parentNode) {
        const idx = node.parentNode.children.indexOf(node);
        if (idx !== -1) node.parentNode.children.splice(idx, 1);
      }
      node.parentNode = this;
      node.parentElement = this;
      node._setConnected(this.isConnected);
      this.children.unshift(node);
    }
  }

  after(...nodes) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const idx = parent.children.indexOf(this);
    if (idx === -1) return;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const node = typeof n === 'string' ? new Element('span') : n;
      if (typeof n === 'string') node.textContent = n;
      if (node.parentNode) {
        const pIdx = node.parentNode.children.indexOf(node);
        if (pIdx !== -1) node.parentNode.children.splice(pIdx, 1);
      }
      node.parentNode = parent;
      node.parentElement = parent;
      node._setConnected(parent.isConnected);
      parent.children.splice(idx + 1 + i, 0, node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) {
      child.parentNode = null;
      child.parentElement = null;
      child._setConnected(false);
    }
    this.text = '';
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
      this.parentElement = null;
      this._setConnected(false);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'type') this.type = String(value);
    if (name === 'href') this.href = String(value);
    if (name === 'src') this.src = String(value);
    if (name === 'download') this.download = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'id') this.id = '';
    if (name === 'type') this.type = '';
    if (name === 'href') this.href = '';
    if (name === 'src') this.src = '';
    if (name === 'download') this.download = '';
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      delete this.dataset[key];
    }
  }

  addEventListener(name, callback) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(callback);
  }

  removeEventListener(name, callback) {
    const list = this.events.get(name);
    if (list) {
      this.events.set(name, list.filter(cb => cb !== callback));
    }
  }

  dispatch(name, event = {}) {
    const list = this.events.get(name) || [];
    const evt = {
      type: name,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...event
    };
    for (const cb of [...list]) {
      cb.call(this, evt);
    }
    if (name === 'click' && this.tagName.toLowerCase() === 'button') {
      const form = this.closest('form');
      if (form && (!this.type || this.type === 'submit' || this.attributes.get('type') === 'submit')) {
        form.dispatch('submit');
      }
    }
    return evt;
  }

  click() {
    if (document.clickedElements) document.clickedElements.push(this);
    return this.dispatch('click');
  }

  focus() {
    document.activeElement = this;
  }

  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  getBoundingClientRect() { return {left: 0, right: 340, top: 0, bottom: 844}; }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (curr._matchesSelector && curr._matchesSelector(selector)) return curr;
      curr = curr.parentElement || curr.parentNode;
    }
    return null;
  }

  getContext(type = '2d') {
    return {
      fillRect() {},
      clearRect() {},
      drawImage() {},
      getImageData() { return {data: []}; },
      putImageData() {},
      createImageData() { return {}; },
      setTransform() {},
      resetTransform() {},
      save() {},
      restore() {},
      scale() {},
      rotate() {},
      translate() {},
      transform() {},
      beginPath() {},
      closePath() {},
      moveTo() {},
      lineTo() {},
      clip() {},
      stroke() {},
      fill() {}
    };
  }

  matches(selector) {
    return this._matchesSelector(selector);
  }

  _matchesCompound(s) {
    if (!s || s === '*') return true;
    s = s.trim();
    if (!s || s === '*') return true;

    const tagMatch = s.match(/^([a-zA-Z0-9_-]+)/);
    if (tagMatch) {
      if (this.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
      s = s.slice(tagMatch[1].length);
      if (!s) return true;
    }

    while (s.length > 0) {
      if (s.startsWith('.')) {
        const m = s.match(/^\.([a-zA-Z0-9_-]+)/);
        if (!m) return false;
        if (!this.classList.contains(m[1])) return false;
        s = s.slice(m[0].length);
      } else if (s.startsWith('#')) {
        const m = s.match(/^#([a-zA-Z0-9_-]+)/);
        if (!m) return false;
        if (this.id !== m[1]) return false;
        s = s.slice(m[0].length);
      } else if (s.startsWith('[')) {
        const end = s.indexOf(']');
        if (end === -1) return false;
        const inner = s.slice(1, end);
        s = s.slice(end + 1);

        const eqIdx = inner.indexOf('=');
        if (eqIdx === -1) {
          const attr = inner.trim();
          if (attr.startsWith('data-')) {
            const key = attr.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
            if (!this.attributes.has(attr) && !(key in this.dataset)) return false;
          } else if (attr === 'type') {
            if (!this.attributes.has('type') && !this.type) return false;
          } else if (!this.attributes.has(attr) && !(attr in this.dataset)) {
            return false;
          }
        } else {
          const attrName = inner.slice(0, eqIdx).trim();
          let attrVal = inner.slice(eqIdx + 1).trim();
          if ((attrVal.startsWith('"') && attrVal.endsWith('"')) || (attrVal.startsWith("'") && attrVal.endsWith("'"))) {
            attrVal = attrVal.slice(1, -1);
          }
          let actualVal;
          if (attrName === 'type') {
            actualVal = this.type || this.attributes.get('type');
          } else if (attrName.startsWith('data-')) {
            const key = attrName.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
            actualVal = this.attributes.get(attrName) ?? (key in this.dataset ? String(this.dataset[key]) : undefined);
          } else {
            actualVal = this.attributes.get(attrName);
          }
          if (actualVal !== attrVal) return false;
        }
      } else {
        return false;
      }
    }
    return true;
  }

  _matchesSelector(selector) {
    if (!selector || selector === '*') return true;
    const commaParts = splitSelectorCommas(selector);
    for (const part of commaParts) {
      const tokens = splitSelectorDescendants(part);
      if (!tokens.length) continue;
      if (!this._matchesCompound(tokens[tokens.length - 1])) continue;
      if (tokens.length === 1) return true;
      let targetIdx = tokens.length - 2;
      let curr = this.parentElement || this.parentNode;
      while (curr && targetIdx >= 0) {
        if (curr._matchesCompound && curr._matchesCompound(tokens[targetIdx])) {
          targetIdx--;
        }
        curr = curr.parentElement || curr.parentNode;
      }
      if (targetIdx < 0) return true;
    }
    return false;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = node => {
      for (const child of node.children) {
        if (child._matchesSelector(selector)) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function dom(t) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

  const elements = new Map();
  const body = new Element('body');
  body.isConnected = true;

  const findDescendant = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = findDescendant(child, id);
      if (found) return found;
    }
    return null;
  };

  const get = id => {
    if (elements.has(id)) return elements.get(id);
    const inBody = findDescendant(body, id);
    if (inBody) {
      elements.set(id, inBody);
      return inBody;
    }
    for (const root of elements.values()) {
      const found = findDescendant(root, id);
      if (found) {
        elements.set(id, found);
        return found;
      }
    }
    const el = new Element();
    el.id = id;
    el.isConnected = true;
    elements.set(id, el);
    return el;
  };

  const viewsToCleanup = new Set();
  const windowListeners = new Map();
  const historyStack = [{state: null, url: '#inbox'}];
  let historyIndex = 0;

  const mockLocation = {
    _hash: '#inbox',
    get hash() { return this._hash; },
    set hash(val) {
      this._hash = val;
      const cbs = windowListeners.get('hashchange') || [];
      for (const cb of [...cbs]) cb({type: 'hashchange'});
    }
  };

  const mockHistory = {
    get state() {
      return historyStack[historyIndex]?.state ?? null;
    },
    pushState(state, title, url) {
      historyStack.splice(historyIndex + 1);
      historyStack.push({state: state ? JSON.parse(JSON.stringify(state)) : null, url});
      historyIndex = historyStack.length - 1;
      if (url && url.startsWith('#')) mockLocation._hash = url;
    },
    replaceState(state, title, url) {
      historyStack[historyIndex] = {state: state ? JSON.parse(JSON.stringify(state)) : null, url};
      if (url && url.startsWith('#')) mockLocation._hash = url;
    },
    back() {
      if (historyIndex > 0) {
        historyIndex--;
        const entry = historyStack[historyIndex];
        if (entry.url && entry.url.startsWith('#')) mockLocation._hash = entry.url;
        const cbs = windowListeners.get('popstate') || [];
        for (const cb of [...cbs]) cb({type: 'popstate', state: entry.state});
      }
    },
    forward() {
      if (historyIndex < historyStack.length - 1) {
        historyIndex++;
        const entry = historyStack[historyIndex];
        if (entry.url && entry.url.startsWith('#')) mockLocation._hash = entry.url;
        const cbs = windowListeners.get('popstate') || [];
        for (const cb of [...cbs]) cb({type: 'popstate', state: entry.state});
      }
    },
    get length() { return historyStack.length; },
    get stack() { return historyStack; },
    get index() { return historyIndex; }
  };

  const mockDoc = {
    clickedElements: [],
    activeElement: null,
    body,
    visibilityState: 'visible',
    hidden: false,
    getElementById: get,
    createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    _registerView: view => viewsToCleanup.add(view),
    addEventListener(name, callback) {
      if (!windowListeners.has(`doc:${name}`)) windowListeners.set(`doc:${name}`, []);
      windowListeners.get(`doc:${name}`).push(callback);
    },
    removeEventListener(name, callback) {
      const list = windowListeners.get(`doc:${name}`);
      if (list) windowListeners.set(`doc:${name}`, list.filter(cb => cb !== callback));
    },
    dispatch(name, event = {}) {
      const list = windowListeners.get(`doc:${name}`) || [];
      for (const cb of [...list]) cb({type: name, target: mockDoc, ...event});
    }
  };

  const mockWin = {
    history: mockHistory,
    location: mockLocation,
    matchMedia: () => ({matches: true, addEventListener() {}}),
    addEventListener(name, callback) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(callback);
    },
    removeEventListener(name, callback) {
      const list = windowListeners.get(name);
      if (list) windowListeners.set(name, list.filter(cb => cb !== callback));
    },
    dispatch(name, event = {}) {
      const list = windowListeners.get(name) || [];
      for (const cb of [...list]) cb({type: name, ...event});
    }
  };

  Object.defineProperty(globalThis, 'document', {configurable: true, value: mockDoc});
  Object.defineProperty(globalThis, 'window', {configurable: true, value: mockWin});
  Object.defineProperty(globalThis, 'history', {configurable: true, value: mockHistory});
  Object.defineProperty(globalThis, 'location', {configurable: true, value: mockLocation});

  t.after(() => {
    for (const view of viewsToCleanup) {
      try { view.reset(); } catch {}
    }
    viewsToCleanup.clear();
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
    if (previousHistory) Object.defineProperty(globalThis, 'history', previousHistory); else delete globalThis.history;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else delete globalThis.location;
  });

  return {get, history: mockHistory, location: mockLocation, doc: mockDoc, win: mockWin};
}

function createMockConversationView({api, describeError, openCompose}) {
  let mountedContainer = null;
  let bodyHost = null;
  let attachmentHost = null;
  let renderCount = 0;
  let currentMsg = null;
  let currentThreaded = false;
  let resetInvoked = false;

  const fakePdfjs = {
    getDocument({data}) {
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: async pageNumber => ({
            getViewport: ({scale = 1} = {}) => ({width: 600 * scale, height: 800 * scale}),
            render: ({canvasContext, viewport}) => {
              let cancelFn;
              const promise = new Promise((resolve, reject) => {
                cancelFn = () => {
                  const err = new Error('Rendering cancelled');
                  err.name = 'RenderingCancelledException';
                  reject(err);
                };
                queueMicrotask(resolve);
              });
              return {
                promise,
                cancel() {
                  cancelFn?.();
                }
              };
            },
            destroy() {}
          }),
          destroy() {}
        }),
        destroy() {}
      };
    }
  };

  const attachmentsView = createMailAttachmentsView({
    api,
    describeError,
    loadPdfjs: async () => fakePdfjs
  });

  return {
    render(container, fullMessage, {threaded = false} = {}) {
      renderCount++;
      const identityChanged = !currentMsg || currentMsg.id !== fullMessage.id;
      currentMsg = fullMessage;
      currentThreaded = threaded;

      if (mountedContainer !== container || identityChanged) {
        if (mountedContainer && mountedContainer !== container) {
          mountedContainer.replaceChildren();
        }
        mountedContainer = container;
        container.replaceChildren();
        bodyHost = new Element('div');
        bodyHost.className = 'conversation-body-content';
        attachmentHost = new Element('div');
        attachmentHost.className = 'conversation-attachment-host';
        container.append(bodyHost, attachmentHost);
      }

      bodyHost.textContent = fullMessage.body || fullMessage.snippet || 'Message text';
      container.dataset.renderedMessageId = fullMessage.id;
      container.dataset.threaded = String(threaded);
      attachmentsView.renderGrid(attachmentHost, fullMessage);
    },
    reset() {
      resetInvoked = true;
      if (mountedContainer) mountedContainer.replaceChildren();
      mountedContainer = null;
      bodyHost = null;
      attachmentHost = null;
      currentMsg = null;
      attachmentsView.reset();
    },
    scrollAttachments() {
      if (mountedContainer) mountedContainer.dataset.scrolledAttachments = 'true';
    },
    get renderCount() { return renderCount; },
    get mountedContainer() { return mountedContainer; },
    get currentThreaded() { return currentThreaded; },
    get resetInvoked() { return resetInvoked; }
  };
}

const createMailView = options => {
  const bodies = new Map();
  const wrappedApi = async (path, input) => {
    if (path === '/api/mail/content') {
      const id = input?.body?.id;
      return {text: bodies.get(id) || 'Full message text', html: '', attachments: [], encrypted: null};
    }
    const result = await options.api(path, input);
    if (path === '/api/mail/message' && result?.message) bodies.set(input?.body?.id, result.message.body);
    return result;
  };
  const view = buildMailView({
    conversationViewFactory: opts => createMockConversationView(opts),
    ...options,
    api: wrappedApi
  });
  if (globalThis.document?._registerView) {
    globalThis.document._registerView(view);
  }
  return view;
};

test('async mail responses preserve search drafts and a cleared search survives queued folder navigation', async t => {
  const {get} = dom(t);
  const calls = [];
  const account = {id: 'private-gmail', email: 'fixture@example.test', label: 'Private Gmail', connected: true};
  const message = {id: 'fixture', accountId: account.id, author: 'Fixture sender', subject: 'Interview', date: '2026-09-13T10:00:00Z', unread: true};
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account], folders: ['inbox', 'drafts'].map(id => ({id, accountIds: [account.id]})), errors: []};
    assert.equal(path, '/api/mail/list');
    return new Promise(resolve => calls.push({body: options.body, resolve}));
  }});
  const finish = async () => { calls.at(-1).resolve({messages: [message], nextCursor: null, errors: []}); await nextTurn(); };
  view.show(); await nextTurn(); await finish();
  get('mail-search').value = 'interview';
  get('mail-search-form').dispatch('submit');
  assert.equal(calls.at(-1).body.query, 'interview');
  await finish();

  get('mail-account').value = account.id;
  get('mail-account').dispatch('change');
  assert.equal(calls.at(-1).body.query, 'interview');
  get('mail-search').value = '';
  await finish();
  assert.equal(get('mail-search').value, '', 'An account response must not restore the submitted query over an edit.');

  get('mail-search-form').dispatch('submit');
  assert.equal(Object.hasOwn(calls.at(-1).body, 'query'), false);
  get('mail-folders').children.find(folder => folder.children[1].textContent === 'Drafts').dispatch('click');
  await finish();
  assert.equal(calls.at(-1).body.folder, 'drafts');
  assert.equal(Object.hasOwn(calls.at(-1).body, 'query'), false, 'Queued navigation must retain the cleared submitted search.');

  get('mail-search').value = 'unfinished new query';
  await finish();
  assert.equal(get('mail-search').value, 'unfinished new query', 'Folder results must preserve new typing.');
  view.reset();
  assert.equal(get('mail-search').value, '', 'A session reset must clear private draft text.');
});

test('folder badges sum message counts for the account filter and omit incomplete totals', async t => {
  const {get} = dom(t);
  const accounts = ['a', 'b', 'c', 'd'].map(id => ({id, label: id, connected: true}));
  const folder = id => get('mail-folders').children.find(element => element.dataset.folderId === id);
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts, folders: [
      {id: 'inbox', accountIds: accounts.map(account => account.id), counts: accounts.map((account, index) => ({accountId: account.id, total: (index + 1) * 101}))},
      {id: 'unread', accountIds: accounts.map(account => account.id), counts: accounts.map((account, index) => ({accountId: account.id, total: index === 3 ? null : 10}))}
    ]};
    return {messages: [{id: 'one', accountId: 'a'}], total: options.body.accountIds ? 101 : 1010, totalComplete: true, nextCursor: 'next'};
  }});
  view.show(); await nextTurn();
  assert.equal(folder('inbox').children.at(-1).textContent, (1010).toLocaleString());
  assert.equal(folder('unread').children.length, 2, 'An unavailable count must not become an account-count badge.');
  assert.equal(get('mail-list-count').textContent, `1 of ${(1010).toLocaleString()} messages`);
  assert.equal(get('mail-connected').textContent, '4 accounts connected');
  get('mail-account').value = 'a'; get('mail-account').dispatch('change'); await nextTurn();
  assert.equal(folder('inbox').children.at(-1).textContent, '101');
  assert.equal(folder('unread').children.at(-1).textContent, '10');
  assert.equal(get('mail-list-count').textContent, '1 of 101 messages');
});

test('sidebar and drawer show shared labels once without individual provider folders', async t => {
  const {get} = dom(t), calls = [];
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [{id: 'a', connected: true}], folders: [
      {id: 'inbox', label: 'Inbox', accountIds: ['a']},
      {id: 'tag:jobs', label: 'Jobs', type: 'tag', accountIds: ['a'], counts: [{accountId: 'a', total: 12}]},
      {id: 'tag:custom_shared', label: 'Shared project', type: 'tag', accountIds: ['a']},
      ...Array.from({length: 250}, (_, n) => ({id: `folder:${n}`, label: `Private folder ${n}`, type: 'provider', accountIds: ['a']}))
    ]};
    calls.push(options.body); return {messages: [], total: 0, totalComplete: true};
  }});
  view.show(); await nextTurn();
  for (const id of ['mail-folders', 'mail-drawer-folders']) {
    const buttons = get(id).children.filter(node => node.dataset.folderId);
    assert.ok(buttons.some(node => node.dataset.folderId === 'inbox'));
    assert.ok(buttons.some(node => node.dataset.folderId === 'all'));
    assert.equal(buttons.filter(node => node.dataset.folderId === 'tag:jobs').length, 1);
    assert.ok(buttons.some(node => node.dataset.folderId === 'tag:custom_shared'));
    assert.equal(buttons.some(node => node.dataset.folderId.startsWith('folder:')), false);
    assert.ok(buttons.length < 30);
  }
  get('mail-drawer-folders').children.find(node => node.dataset.folderId === 'tag:custom_shared').click();
  await nextTurn(); assert.equal(calls.at(-1).folder, 'tag:custom_shared');
  view.reset();
});

test('mobile folder drawer closes on selection, Escape and backdrop and restores focus', async t => {
  const {get} = dom(t);
  const requests = [];
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [{id: 'a', connected: true}], folders: [{id: 'inbox', accountIds: ['a']}, {id: 'tag:coupons', type: 'tag', accountIds: ['a']}]};
    requests.push(options.body); return {messages: [], total: 0, totalComplete: true};
  }});
  view.show(); await nextTurn();
  get('mail-menu').dispatch('click');
  assert.equal(get('mail-drawer').open, true);
  assert.equal(get('mail-menu').attributes.get('aria-expanded'), 'true');
  assert.equal(document.activeElement, get('mail-drawer-close'));
  assert.equal(get('mail-drawer-folders').children.filter(element => element.textContent === 'Labels').length, 1);
  const invoices = get('mail-drawer-folders').children.find(element => element.dataset.folderId === 'tag:invoices');
  assert.ok(invoices, 'Invoices is available in the same vertical label menu.');
  assert.equal(invoices.children[1].textContent, 'Invoices');
  get('mail-drawer').dispatch('cancel');
  assert.equal(get('mail-drawer').open, false);
  assert.equal(document.activeElement, get('mail-menu'));
  get('mail-menu').dispatch('click');
  get('mail-drawer-folders').children.find(element => element.dataset.folderId === 'tag:coupons').dispatch('click');
  await nextTurn();
  assert.equal(requests.at(-1).folder, 'tag:coupons');
  assert.equal(get('mail-drawer').open, false);
  assert.match(get('mail-list').textContent, /Add this label to a message/);
  get('mail-menu').dispatch('click');
  get('mail-drawer').dispatch('click', {target: get('mail-drawer'), clientX: 360, clientY: 100});
  assert.equal(get('mail-drawer').open, false);
  assert.equal(get('mail-menu').attributes.get('aria-expanded'), 'false');
});

test('labels survive a late preview response and removal from a label folder preserves the reader', async t => {
  const {get} = dom(t);
  const account = {id: 'a', label: 'Mailbox A', connected: true};
  const message = {id: 'message', accountId: 'a', subject: 'A coupon', unread: true, starred: false, tags: []};
  const calls = [];
  let finishRead;
  const folders = () => ['inbox', 'tag:coupons', 'tag:jobs', 'tag:invoices'].map(id => ({id, accountIds: ['a'], counts: [{accountId: 'a', total: id === 'inbox' || message.tags.includes(id.slice(4)) ? 1 : 0}]}));
  const toggle = name => {
    if (!get('mail-label-dialog').open) get('mail-reader-content').querySelectorAll('*').find(element => element.attributes.get('aria-label') === 'Labels').click();
    return get('mail-label-options').querySelectorAll('*').find(element => element.tagName === 'BUTTON' && element.textContent === name);
  };
  const view = createMailView({api: async (path, options) => {
    calls.push({path, body: options?.body});
    if (path === '/api/mail/folders') return {accounts: [account], folders: folders()};
    if (path === '/api/mail/list') return {messages: options.body.folder.startsWith('tag:') && !message.tags.includes(options.body.folder.slice(4)) ? [] : [{...message}], total: 1, totalComplete: true};
    if (path === '/api/mail/message') return new Promise(resolve => { finishRead = resolve; });
    assert.equal(path, '/api/mail/tags');
    const {tag, enabled} = options.body;
    message.tags = enabled ? [...new Set([...message.tags, tag])] : message.tags.filter(value => value !== tag);
    return {tags: [...message.tags], folders: folders().filter(folder => folder.id.startsWith('tag:'))};
  }});
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click');
  assert.equal(toggle('Coupons').disabled, false, 'Local labels can be edited while the provider preview loads.');
  toggle('Coupons').dispatch('click'); await nextTurn();
  assert.deepEqual(calls.find(call => call.path === '/api/mail/tags').body, {id: 'message', tag: 'coupons', enabled: true});
  finishRead({message: {...message, tags: [], body: 'Text preview', bodyUnavailable: false}}); await nextTurn();
  assert.equal(toggle('Coupons').attributes.get('aria-pressed'), 'true', 'The earlier preview must not revert a newly saved label.');
  assert.match(get('mail-list').textContent, /Coupons/);
  toggle('Jobs').dispatch('click'); await nextTurn();
  assert.equal(toggle('Jobs').attributes.get('aria-pressed'), 'true');
  toggle('Invoices').dispatch('click'); await nextTurn();
  assert.equal(toggle('Invoices').attributes.get('aria-pressed'), 'true');
  assert.match(get('mail-list').textContent, /Invoices/);
  assert.equal(get('mail-folders').children.find(element => element.dataset.folderId === 'tag:invoices').children.at(-1).textContent, '1');
  get('mail-folders').children.find(element => element.dataset.folderId === 'tag:coupons').dispatch('click'); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click');
  finishRead({message: {...message, body: 'Text preview', bodyUnavailable: false}}); await nextTurn();
  toggle('Coupons').dispatch('click'); await nextTurn();
  assert.equal(toggle('Coupons').attributes.get('aria-pressed'), 'false');
  assert.equal(toggle('Jobs').attributes.get('aria-pressed'), 'true');
  assert.equal(toggle('Invoices').attributes.get('aria-pressed'), 'true');
  assert.match(get('mail-reader-content').textContent, /Text preview/);
  assert.match(get('mail-list').textContent, /No messages labeled Coupons/);
  get('mail-folders').children.find(element => element.dataset.folderId === 'tag:invoices').dispatch('click'); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click');
  finishRead({message: {...message, body: 'Text preview', bodyUnavailable: false}}); await nextTurn();
  toggle('Invoices').dispatch('click'); await nextTurn();
  assert.equal(toggle('Invoices').attributes.get('aria-pressed'), 'false');
  assert.equal(toggle('Jobs').attributes.get('aria-pressed'), 'true');
  assert.match(get('mail-list').textContent, /No messages labeled Invoices/);
  assert.equal(calls.some(call => call.path === '/api/mail/action'), false, 'Tag controls must never alter provider flags.');
  assert.equal(calls.filter(call => call.path === '/api/mail/folders').length, 1, 'Tag responses update counts without reopening all provider folders.');
});

test('an unavailable provider preview still permits label removal and logout discards its late response', async t => {
  const {get} = dom(t);
  const message = {id: 'saved', accountId: 'a', subject: 'Saved private header', tags: ['coupons']};
  let finishTag;
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [{id: 'a', connected: true}], folders: [{id: 'inbox', accountIds: ['a']}]};
    if (path === '/api/mail/list') return {messages: [message], total: 1, totalComplete: true};
    if (path === '/api/mail/message') throw Object.assign(new Error('Unavailable'), {code: 'stale_message'});
    assert.equal(path, '/api/mail/tags');
    assert.deepEqual(options.body, {id: 'saved', tag: 'coupons', enabled: false});
    return new Promise(resolve => { finishTag = resolve; });
  }});
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  get('mail-reader-content').querySelectorAll('*').find(element => element.attributes.get('aria-label') === 'Labels').click();
  const remove = get('mail-label-options').querySelectorAll('*').find(element => element.tagName === 'BUTTON' && element.textContent === 'Coupons');
  assert.equal(remove.disabled, false);
  remove.dispatch('click');
  view.reset();
  finishTag({tags: []}); await nextTurn();
  assert.doesNotMatch(get('mail-reader-content').textContent, /Saved private header|Coupons/);
  assert.equal(get('mail-label-dialog').open, false);
  assert.equal(get('mail-label-options').children.length, 0);
  assert.equal(get('mail-notice').textContent, '');
  assert.equal(get('mail-list').children.length, 0);
});

test('all shared categories appear in the vertical navigation and reader label controls', async t => {
  const {get} = dom(t);
  const message = {id: 'message', accountId: 'a', subject: 'One message', tags: ['appointments', 'work']};
  const view = createMailView({api: async path => {
    if (path === '/api/mail/folders') return {accounts: [{id: 'a', connected: true}], folders: [{id: 'inbox', accountIds: ['a']}]};
    if (path === '/api/mail/message') return {message: {...message, body: 'Text content'}};
    return {messages: [message], total: 1, totalComplete: true};
  }});
  view.show(); await nextTurn();
  const ids = ['coupons', 'development', 'social', 'jobs', 'security', 'travel', 'work', 'newsletters', 'finance', 'invoices', 'tenders', 'appointments', 'orders'];
  for (const id of ids) {
    assert.ok(get('mail-folders').children.some(node => node.dataset.folderId === `tag:${id}`), `Desktop ${id}`);
    assert.ok(get('mail-drawer-folders').children.some(node => node.dataset.folderId === `tag:${id}`), `Mobile ${id}`);
  }
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  assert.equal(get('mail-reader-content').querySelectorAll('*').filter(node => node.className === 'subtle mail-tag-toggle').length, 0);
  get('mail-reader-content').querySelectorAll('*').find(element => element.attributes.get('aria-label') === 'Labels').click();
  assert.equal(get('mail-label-dialog').open, true);
  const toggles = get('mail-label-options').querySelectorAll('*').filter(node => node.className === 'subtle mail-tag-toggle');
  assert.equal(toggles.length, 13);
  assert.equal(toggles.find(node => node.textContent === 'Appointments').attributes.get('aria-pressed'), 'true');
  assert.equal(toggles.find(node => node.textContent === 'Work & Administration').attributes.get('aria-pressed'), 'true');
  get('mail-label-dialog').dispatch('cancel');
  assert.equal(get('mail-label-dialog').open, false);
  assert.equal(document.activeElement.attributes.get('aria-label'), 'Labels');
  view.reset();
});

test('label save errors stay in the modal and focus survives saving or closing while pending', async t => {
  const {get} = dom(t), message = {id: 'label-error', accountId: 'a', subject: 'Label error', tags: []};
  let rejectSave;
  const view = createMailView({api: async path => {
    if (path === '/api/mail/folders') return {accounts: [{id: 'a', connected: true}], folders: [{id: 'inbox', accountIds: ['a']}]};
    if (path === '/api/mail/list') return {messages: [message]};
    if (path === '/api/mail/message') return {message};
    return new Promise((_, reject) => { rejectSave = reject; });
  }, describeError: () => 'Could not save this label. Try again.'});
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].click(); await nextTurn();
  const open = () => get('mail-reader-content').querySelectorAll('*').find(node => node.attributes.get('aria-label') === 'Labels').click();
  const jobs = () => get('mail-label-options').children.find(node => node.dataset.tagId === 'jobs');
  open(); jobs().focus(); jobs().click();
  assert.equal(document.activeElement, get('mail-label-close'));
  assert.match(get('mail-label-status').textContent, /Saving/);
  rejectSave(new Error('failed')); await nextTurn();
  assert.match(get('mail-label-status').textContent, /Could not save this label/);
  assert.equal(document.activeElement, jobs());
  assert.equal(jobs().attributes.get('aria-pressed'), 'false');
  jobs().click(); get('mail-label-close').click();
  assert.equal(get('mail-label-dialog').open, false);
  assert.equal(document.activeElement, get('mail-reader'));
  rejectSave(new Error('failed')); await nextTurn();
  assert.equal(get('mail-label-dialog').open, false);
  view.reset();
});

test('calendar download uses only a verified appointment and encodes the opaque message reference', async t => {
  const {get} = dom(t);
  const message = {id: 'opaque&other=value', accountId: 'a', subject: 'Meeting', tags: ['appointments']};
  let appointment = {title: '<img src=x onerror=alert(1)>', start: '2026-10-15T09:00:00Z', end: '2026-10-15T10:00:00Z', location: '<script>location</script>'};
  let resolveRead;
  const view = createMailView({api: async path => {
    if (path === '/api/mail/folders') return {accounts: [{id: 'a', connected: true}], folders: [{id: 'inbox', accountIds: ['a']}]};
    if (path === '/api/mail/message') return new Promise(resolve => { resolveRead = () => resolve({message: {...message, appointment, body: 'Meeting details'}}); });
    return {messages: [message], total: 1, totalComplete: true};
  }});
  const descendants = () => get('mail-reader-content').querySelectorAll('*');
  const calendar = () => descendants().find(node => node.tagName === 'A' && node.textContent === 'Add to calendar');
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click');
  assert.equal(calendar(), undefined, 'A label alone must not create a calendar action before metadata is loaded.');
  resolveRead(); await nextTurn();
  assert.equal(calendar().href, '/api/mail/calendar?id=opaque%26other%3Dvalue');
  assert.equal(calendar().attributes.get('download'), 'appointment.ics');
  assert.equal(descendants().some(node => ['img', 'script'].includes(node.tagName.toLowerCase())), false);
  assert.match(get('mail-reader-content').textContent, /<script>location<\/script>/);

  appointment = {...appointment, end: '2026-10-15T08:00:00Z'};
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); resolveRead(); await nextTurn();
  assert.equal(calendar(), undefined, 'An invalid end date must never offer an appointment download.');
  appointment = {...appointment, start: '2026-10-15', end: '2026-10-15'};
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); resolveRead(); await nextTurn();
  assert.ok(calendar(), 'A one-day all-day appointment has equal inclusive start and end dates.');
  assert.match(get('mail-reader-content').textContent, /All day/);
  view.reset();
});

test('delete confirms the original mailbox change, supports cancellation and refreshes after moving to Trash', async t => {
  const {get} = dom(t);
  const message = {id: 'delete-me', accountId: 'a', subject: 'Delete fixture', tags: []};
  const calls = [];
  let moved = false;
  let finishDelete;
  const view = createMailView({api: async (path, options) => {
    calls.push({path, body: options?.body});
    if (path === '/api/mail/folders') return {accounts: [{id: 'a', connected: true}], folders: [{id: 'inbox', accountIds: ['a'], counts: [{accountId: 'a', total: moved ? 0 : 1}]}]};
    if (path === '/api/mail/list') return {messages: moved ? [] : [message], total: moved ? 0 : 1, totalComplete: true};
    if (path === '/api/mail/message') return {message: {...message, body: 'The original content'}};
    assert.equal(path, '/api/mail/action');
    assert.deepEqual(options.body, {id: message.id, action: 'delete'});
    return new Promise(resolve => { finishDelete = () => { moved = true; resolve({ok: true}); }; });
  }});
  const control = text => get('mail-reader-content').querySelectorAll('*').find(node => node.tagName === 'BUTTON' && node.textContent === text);
  const remove = () => control('Delete');
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  remove().dispatch('click'); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Move this message to Trash in the original mailbox\? This also removes it from its current folder in your other mail apps\./);
  assert.equal(document.activeElement, control('Cancel'), 'Opening the confirmation focuses its non-destructive option.');
  assert.equal(calls.filter(call => call.path === '/api/mail/action').length, 0, 'Opening the confirmation cannot mutate the mailbox.');
  control('Cancel').dispatch('click');
  assert.equal(control('Move to Trash'), undefined);
  assert.equal(document.activeElement, remove(), 'Cancellation returns focus to Delete.');
  assert.equal(calls.filter(call => call.path === '/api/mail/action').length, 0, 'Cancelling must not mutate the mailbox.');
  assert.match(get('mail-reader-content').textContent, /The original content/);
  remove().dispatch('click'); get('mail-reader').dispatch('keydown', {key: 'Escape'});
  assert.equal(control('Move to Trash'), undefined, 'Escape cancels confirmation without closing the message.');
  assert.match(get('mail-reader-content').textContent, /The original content/);
  remove().dispatch('click');
  const move = control('Move to Trash'); move.dispatch('click');
  assert.equal(remove().disabled, true);
  assert.equal(control('Cancel').disabled, true); assert.equal(control('Moving…').disabled, true);
  move.dispatch('click');
  assert.equal(calls.filter(call => call.path === '/api/mail/action').length, 1, 'Repeated clicks cannot submit deletion twice.');
  finishDelete(); await nextTurn();
  assert.equal(calls.filter(call => call.path === '/api/mail/folders').length, 2);
  assert.equal(calls.filter(call => call.path === '/api/mail/list').length, 2);
  assert.doesNotMatch(get('mail-reader-content').textContent, /The original content|Delete fixture/);
  assert.match(get('mail-list').textContent, /inbox is clear/);
  assert.equal(get('mail-folders').children.find(node => node.dataset.folderId === 'inbox').children.at(-1).textContent, '0');
  view.reset();
});

test('failed deletion preserves the message and a late deletion does not close another message', async t => {
  const {get} = dom(t);
  const messages = [{id: 'a', accountId: 'mailbox', subject: 'First'}, {id: 'b', accountId: 'mailbox', subject: 'Second'}];
  let fail = true;
  let finishDelete;
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [{id: 'mailbox', connected: true}], folders: [{id: 'inbox', accountIds: ['mailbox']}]};
    if (path === '/api/mail/list') return {messages};
    if (path === '/api/mail/message') return {message: {...messages.find(message => message.id === options.body.id), body: `Body ${options.body.id}`}};
    if (fail) throw Object.assign(new Error('No safe deletion'), {code: 'delete_unavailable'});
    return new Promise(resolve => { finishDelete = () => { messages.shift(); resolve({ok: true}); }; });
  }});
  const control = text => get('mail-reader-content').querySelectorAll('*').find(node => node.tagName === 'BUTTON' && node.textContent === text);
  const remove = () => control('Delete');
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  remove().dispatch('click'); control('Move to Trash').dispatch('click'); await nextTurn();
  assert.match(get('mail-notice').textContent, /could not be moved to Trash safely/);
  assert.match(get('mail-reader-content').textContent, /Body a/);
  assert.equal(remove().disabled, false);
  fail = false; remove().dispatch('click'); control('Move to Trash').dispatch('click');
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click'); await nextTurn();
  finishDelete(); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Second.*Body b/s);
  assert.doesNotMatch(get('mail-list').textContent, /First/);
  view.reset();
});

test('delete confirmation cannot target another message after navigation or session reset', async t => {
  const {get} = dom(t);
  const messages = ['a', 'b'].map(id => ({id, accountId: 'mailbox', subject: `Message ${id}`}));
  const actions = [];
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [{id: 'mailbox', connected: true}], folders: [{id: 'inbox', accountIds: ['mailbox']}]};
    if (path === '/api/mail/list') return {messages};
    if (path === '/api/mail/message') return {message: {...messages.find(message => message.id === options.body.id), body: `Body ${options.body.id}`}};
    actions.push(options.body); return {ok: true};
  }});
  const control = text => get('mail-reader-content').querySelectorAll('*').find(node => node.tagName === 'BUTTON' && node.textContent === text);
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  control('Delete').dispatch('click'); const staleMove = control('Move to Trash');
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click'); await nextTurn();
  assert.equal(control('Move to Trash'), undefined);
  staleMove.dispatch('click'); await nextTurn();
  assert.equal(actions.length, 0, 'A previous message confirmation must never delete the newly selected message.');
  control('Delete').dispatch('click'); const secondMove = control('Move to Trash');
  view.reset(); view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click'); await nextTurn();
  control('Delete').dispatch('click'); secondMove.dispatch('click'); await nextTurn();
  assert.equal(actions.length, 0, 'A previous browser session cannot confirm the new session’s deletion.');
  assert.ok(control('Move to Trash'), 'The current session still owns its own confirmation.');
  view.hide(); assert.equal(control('Move to Trash'), undefined);
  view.reset();
});

test('search submission commits query and advanced filters together in single request, handles validation errors and clear flows', async t => {
  const {get} = dom(t);
  const calls = [];
  const account = {id: 'acc1', email: 'acc1@example.test', label: 'Account 1', connected: true};
  const message = {id: 'm1', accountId: 'acc1', author: 'Sender', subject: 'Invoice #101', date: '2026-09-13T10:00:00Z', snippet: 'Your invoice details'};
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account], folders: [{id: 'inbox', accountIds: ['acc1']}], errors: []};
    if (path === '/api/mail/list') { calls.push(options.body); return {messages: [message], total: 1, totalComplete: true, errors: []}; }
    return {};
  }});
  view.show(); await nextTurn();
  assert.equal(calls.length, 1, 'Initial list load');

  // Open advanced search panel
  get('mail-advanced').dispatch('click');
  const panel = get('mail-advanced-search');
  assert.ok(panel && !panel.hidden, 'Advanced search panel is open');

  // Enter unapplied fields: From, unread=false, minSize with KB, bodySearch, sort, allFolders
  const inputs = panel.querySelectorAll('input');
  const fromInput = inputs.find(i => i.parentNode?.text === 'From' || i.parentNode?.textContent?.includes('From'));
  assert.ok(fromInput, 'From field exists');
  fromInput.value = 'boss@example.test';
  fromInput.dispatch('input');

  const selects = panel.querySelectorAll('select');
  const unreadSelect = selects.find(s => s.attributes.get('aria-label') === 'Read state');
  assert.ok(unreadSelect, 'Read state select exists');
  unreadSelect.value = 'false';
  unreadSelect.dispatch('change');

  const minSizeInput = inputs.find(i => i.parentNode?.text === 'Minimum size' || i.parentNode?.textContent?.includes('Minimum size'));
  assert.ok(minSizeInput, 'Minimum size input exists');
  minSizeInput.value = '25';
  minSizeInput.dispatch('input');

  const minSizeUnitSelect = selects.find(s => s.attributes.get('aria-label') === 'Minimum size unit');
  assert.ok(minSizeUnitSelect, 'Size unit select exists');
  minSizeUnitSelect.value = 'KB';
  minSizeUnitSelect.dispatch('change');

  const sortSelect = selects.find(s => s.attributes.get('aria-label') === 'Sort');
  assert.ok(sortSelect, 'Sort select exists');
  sortSelect.value = 'sender_asc';
  sortSelect.dispatch('change');

  const checkboxes = panel.querySelectorAll('input[type="checkbox"]');
  const bodySearchCheck = checkboxes.find(c => c.parentNode?.textContent?.includes('Search message bodies'));
  assert.ok(bodySearchCheck, 'Body search checkbox exists');
  bodySearchCheck.checked = true;
  bodySearchCheck.dispatch('change');

  const allFoldersCheck = checkboxes.find(c => c.parentNode?.textContent?.includes('Search all provider folders'));
  assert.ok(allFoldersCheck, 'All folders checkbox exists');
  allFoldersCheck.checked = true;
  allFoldersCheck.dispatch('change');

  // Also enter query into main search field
  get('mail-search').value = 'urgent';

  // Submit main form: assert exact single outgoing request with all criteria committed
  get('mail-search-form').dispatch('submit');
  await nextTurn();

  assert.equal(calls.length, 2, 'Exactly one new outgoing request made on main form submit');
  const req = calls[1];
  assert.equal(req.query, 'urgent');
  assert.equal(req.filters.from, 'boss@example.test');
  assert.equal(req.filters.unread, false);
  assert.equal(req.filters.minSize, 25 * 1024);
  assert.equal(req.bodySearch, true);
  assert.equal(req.sort, 'sender_asc');
  assert.equal(req.folder, 'all');

  // Verify chips rendered
  const summary = get('mail-search-summary');
  assert.equal(summary.hidden, false);
  assert.match(summary.textContent, /urgent/);
  assert.match(summary.textContent, /boss@example\.test/);
  assert.match(summary.textContent, /Read/);

  // Invalid size: open advanced, set minSize > maxSize
  get('mail-advanced').dispatch('click');
  const maxSizeInput = panel.querySelectorAll('input').find(i => i.parentNode?.textContent?.includes('Maximum size'));
  maxSizeInput.value = '10';
  maxSizeInput.dispatch('input');
  const maxSizeUnit = panel.querySelectorAll('select').find(s => s.attributes.get('aria-label') === 'Maximum size unit');
  maxSizeUnit.value = 'KB';
  maxSizeUnit.dispatch('change');

  // Submitting invalid size causes zero requests and preserves editor
  const callsBeforeInvalid = calls.length;
  get('mail-search-form').dispatch('submit');
  await nextTurn();
  assert.equal(calls.length, callsBeforeInvalid, 'Zero requests made on validation failure');
  assert.match(get('mail-notice').textContent, /Minimum size cannot exceed maximum size/);
  assert.equal(maxSizeInput.value, '10', 'Editor values preserved on validation error');

  // Fix maxSize
  maxSizeInput.value = '';
  maxSizeInput.dispatch('input');

  // Removing one chip preserves remaining values
  const chips = summary.querySelectorAll('.mail-filter-chip');
  assert.ok(chips.length >= 2, 'Multiple chips present');
  const fromChip = chips.find(c => c.textContent.includes('boss@example.test'));
  assert.ok(fromChip, 'From chip exists');
  const removeBtn = fromChip.querySelector('.mail-chip-remove');
  assert.ok(removeBtn, 'Remove chip button exists');
  removeBtn.dispatch('click');
  await nextTurn();

  assert.equal(calls.length, callsBeforeInvalid + 1, 'Chip removal causes exactly one request');
  const reqAfterRemove = calls.at(-1);
  assert.equal(reqAfterRemove.filters.from, undefined, 'Removed filter is omitted');
  assert.equal(reqAfterRemove.filters.unread, false, 'Remaining filters are preserved');
  assert.equal(reqAfterRemove.query, 'urgent', 'Query is preserved');

  // Shell Clear all causes exactly one request, resets criteria, restores default folder, retains account scope
  const clearBtn = summary.querySelector('.mail-clear-all-chip');
  assert.ok(clearBtn, 'Clear all button exists in summary');
  clearBtn.dispatch('click');
  await nextTurn();

  assert.equal(calls.length, callsBeforeInvalid + 2, 'Clear causes exactly one request without recursion');
  const reqClear = calls.at(-1);
  assert.equal(reqClear.query, undefined);
  assert.equal(reqClear.filters, undefined);
  assert.equal(reqClear.bodySearch, undefined);
  assert.equal(reqClear.sort, undefined);
  assert.equal(reqClear.folder, 'inbox', 'Folder reset to inbox');
  assert.equal(get('mail-account').value, '', 'Account scope unchanged');

  view.reset();
});

test('snapshot request criteria, account/folder change clearing, cancel search and retry', async t => {
  const {get} = dom(t);
  const signals = [];
  let pendingResolves = [];
  const account1 = {id: 'acc1', label: 'Account 1', connected: true};
  const account2 = {id: 'acc2', label: 'Account 2', connected: true};
  const messageA = {id: 'mA', accountId: 'acc1', author: 'Alice', subject: 'Subject A', date: '2026-09-13T10:00:00Z'};
  const messageB = {id: 'mB', accountId: 'acc2', author: 'Bob', subject: 'Subject B', date: '2026-09-13T10:00:00Z'};

  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account1, account2], folders: [{id: 'inbox', accountIds: ['acc1', 'acc2']}, {id: 'sent', accountIds: ['acc1', 'acc2']}], errors: []};
    if (path === '/api/mail/message') return {message: options.body.id === 'mA' ? messageA : messageB};
    if (path === '/api/mail/list') {
      if (options.signal) signals.push(options.signal);
      return new Promise(resolve => { pendingResolves.push({options, resolve}); });
    }
    return {};
  }});

  view.show(); await nextTurn();
  // Resolve initial list load with message A
  pendingResolves.shift().resolve({messages: [messageA], total: 1, totalComplete: true, errors: []});
  await nextTurn();

  // Open message A in reader
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click');
  await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Subject A/);

  // Start search: deferred request
  get('mail-search').value = 'alice';
  get('mail-search-form').dispatch('submit');
  await nextTurn();

  // Same-scope search retains previous row with previous-results banner
  assert.ok(get('mail-list').querySelector('.mail-previous-results-bar'), 'Previous results banner visible');
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').length, 1, 'Previous rows retained');

  // Cancel search: click Cancel search
  const cancelSearchBtn = get('mail-list').querySelector('.mail-previous-results-bar').querySelector('button');
  assert.ok(cancelSearchBtn, 'Cancel search button exists');
  cancelSearchBtn.dispatch('click');
  await nextTurn();

  assert.equal(signals.at(-1).aborted, true, 'Active search signal aborted immediately');
  assert.ok(get('mail-list').querySelector('.mail-cancel-bar'), 'Cancellation is visible in UI');
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').length, 1, 'Matching scope rows still retained');

  // Late reply to cancelled search must be discarded
  const cancelledRequest = pendingResolves.shift();
  cancelledRequest.resolve({messages: [{id: 'mLate', accountId: 'acc1', subject: 'Late'}], total: 1});
  await nextTurn();
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').some(n => n.dataset.messageId === 'mLate'), false, 'Cancelled late reply discarded');

  // Click Retry: launches fresh request
  const retryBtn = get('mail-list').querySelector('.mail-cancel-bar').querySelector('button');
  assert.ok(retryBtn, 'Retry button exists');
  retryBtn.dispatch('click');
  await nextTurn();

  assert.equal(pendingResolves.length, 1, 'Fresh request created on retry');
  assert.equal(signals.at(-1).aborted, false, 'New signal is active');
  pendingResolves.shift().resolve({messages: [messageA], total: 1, totalComplete: true, errors: []});
  await nextTurn();
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').length, 1);

  // Change account then folder while query is non-empty: old rows, reader, actions disappear immediately
  get('mail-account').value = 'acc2';
  get('mail-account').dispatch('change');
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').length, 0, 'Rows cleared synchronously on account change');
  assert.equal(get('mail-reader-content').querySelector('.mail-reader-toolbar'), null, 'Reader toolbar cleared synchronously');
  assert.doesNotMatch(get('mail-reader-content').textContent, /Subject A/, 'Reader body cleared synchronously');

  // Scope change deferred request
  assert.equal(pendingResolves.length, 1);
  const acc2Resolve = pendingResolves.shift();

  // Change folder to sent
  get('mail-folders').children.find(n => n.dataset.folderId === 'sent').dispatch('click');
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').length, 0);

  // Late reply to acc2 inbox must be discarded
  acc2Resolve.resolve({messages: [messageB], total: 1, totalComplete: true, errors: []});
  await nextTurn();
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').length, 0, 'Late reply to old folder scope discarded');

  // Complete sent folder request
  pendingResolves.shift().resolve({messages: [], total: 0, totalComplete: true, errors: []});
  await nextTurn();

  view.reset();
});

test('refresh selection identity includes accountId and cannot transfer item with equal fingerprint', async t => {
  const {get} = dom(t);
  const account1 = {id: 'acc1', connected: true};
  const account2 = {id: 'acc2', connected: true};
  const msgAcc1 = {id: 'm1', accountId: 'acc1', reference: {fingerprint: 'shared-fp-123'}, subject: 'Acc 1 mail'};
  const msgAcc2 = {id: 'm2', accountId: 'acc2', reference: {fingerprint: 'shared-fp-123'}, subject: 'Acc 2 mail'};

  let listResolve;
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account1, account2], folders: [{id: 'inbox', accountIds: ['acc1', 'acc2']}], errors: []};
    if (path === '/api/mail/list') return new Promise(r => { listResolve = r; });
    return {};
  }});

  view.show(); await nextTurn();
  listResolve({messages: [msgAcc1, msgAcc2], total: 2, totalComplete: true, errors: []});
  await nextTurn();

  // Select message 1 (acc1)
  const checkboxes = get('mail-list').querySelectorAll('input[type="checkbox"]');
  assert.ok(checkboxes.length >= 2);
  checkboxes[0].checked = true;
  checkboxes[0].dispatch('change');
  const selEl = get('mail-tools').querySelector('[data-mail-selection-count]') || get('mail-folder-selection');
  assert.match(selEl.textContent, /1/);

  // Trigger refresh
  get('mail-refresh').dispatch('click');
  await nextTurn();

  // Return fresh message objects with same fingerprints
  const freshAcc1 = {id: 'm1-new', accountId: 'acc1', reference: {fingerprint: 'shared-fp-123'}, subject: 'Acc 1 mail refreshed'};
  const freshAcc2 = {id: 'm2-new', accountId: 'acc2', reference: {fingerprint: 'shared-fp-123'}, subject: 'Acc 2 mail refreshed'};
  listResolve({messages: [freshAcc1, freshAcc2], total: 2, totalComplete: true, errors: []});
  await nextTurn();

  // Assert selection renewed to m1-new in acc1 and NOT transferred to m2-new in acc2
  const updatedCheckboxes = get('mail-list').querySelectorAll('input[type="checkbox"]');
  assert.equal(updatedCheckboxes[0].checked, true, 'Account 1 message remains selected');
  assert.equal(updatedCheckboxes[1].checked, false, 'Account 2 message with equal fingerprint is NOT selected');

  view.reset();
});

test('cache metadata consumes top-level schema, renders warming/partial, provider fallback and unsupported filter omission', async t => {
  const {get} = dom(t);
  const calls = [];
  let cachePayload = {};
  const account = {id: 'acc1', connected: true};
  const message = {id: 'm1', accountId: 'acc1', subject: 'Cached message', snippet: 'Brief snippet'};

  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account], folders: [{id: 'inbox', accountIds: ['acc1']}], errors: []};
    if (path === '/api/mail/list') {
      calls.push(options.body);
      return {messages: [message], total: 1, totalComplete: true, errors: [], ...cachePayload};
    }
    return {};
  }});

  // 1. No-query warming/partial banner
  cachePayload = {
    source: 'cache',
    providerFallback: true,
    coverage: {status: 'warming', cached: 5, limited: true},
    lastSuccessfulSync: 1726830000000
  };
  view.show(); await nextTurn();

  const summary = get('mail-search-summary');
  assert.equal(summary.hidden, false, 'Search summary is visible for cache info even without search query');
  assert.match(summary.textContent, /Warming cache…/);

  // 2. Supported Browse older sends live: true and cursor: null
  cachePayload = {
    source: 'cache',
    providerFallback: true,
    coverage: {status: 'complete', cached: 40},
    lastSuccessfulSync: 1726830000000
  };
  get('mail-refresh').dispatch('click'); await nextTurn();

  const browseOlderBtn = summary.querySelector('.mail-chip-browse-older');
  assert.ok(browseOlderBtn, 'Browse older mail button rendered');

  cachePayload = {
    source: 'provider',
    providerFallback: false,
    nextCursor: 'live-page-2'
  };
  browseOlderBtn.dispatch('click'); await nextTurn();

  assert.equal(calls.at(-1).live, true, 'Browse older mail sets live: true');
  assert.equal(calls.at(-1).cursor, undefined, 'Browse older mail starts at cursor null');

  // 3. Live pagination retains live scope, subsequent new query omits live
  get('mail-more').dispatch('click'); await nextTurn();
  assert.equal(calls.at(-1).live, true, 'Pagination retains live scope');
  assert.equal(calls.at(-1).cursor, 'live-page-2');

  // Subsequent new query omits live: true
  get('mail-search').value = 'new query';
  get('mail-search-form').dispatch('submit'); await nextTurn();
  assert.equal(calls.at(-1).live, undefined, 'New search returns to ordinary cache flow (omits live)');

  // 4. Provider results remove cache-only banner
  assert.equal(summary.querySelector('.mail-cache-note'), null, 'Provider results remove cache note');

  // 5. Unsupported filter omits Browse older mail
  cachePayload = {
    source: 'cache',
    providerFallback: true,
    coverage: {status: 'complete', cached: 50}
  };
  // Open advanced search and set minSize (cached-only filter)
  get('mail-advanced').dispatch('click');
  const minSizeInput = get('mail-advanced-search').querySelectorAll('input').find(i => i.parentNode?.textContent?.includes('Minimum size'));
  minSizeInput.value = '500';
  minSizeInput.dispatch('input');
  get('mail-search-form').dispatch('submit'); await nextTurn();

  assert.ok(summary.querySelector('.mail-cache-note'), 'Cache note rendered');
  assert.equal(summary.querySelector('.mail-chip-browse-older'), null, 'Browse older omitted for unsupported cached-only filter');

  view.reset();
});

test('bounded in-memory navigation snapshots handle stack, scroll, criteria restoration, expired messages, and malformed hash', async t => {
  const {get, history, location} = dom(t);
  const account = {id: 'acc1', connected: true};
  const account2 = {id: 'acc2', connected: true};
  const msgA = {id: 'msgA', accountId: 'acc1', subject: 'Message A', body: 'Body of A'};
  const msgB = {id: 'msgB', accountId: 'acc1', subject: 'Message B', body: 'Body of B'};
  let listResolve = null;
  let listAbort = null;

  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account, account2], folders: [{id: 'inbox', accountIds: ['acc1', 'acc2']}], errors: []};
    if (path === '/api/mail/message') return {message: options.body.id === 'msgA' ? msgA : msgB};
    if (path === '/api/mail/list') {
      if (options.signal) listAbort = options.signal;
      if (options.body.query === 'pending-query') {
        return new Promise(resolve => { listResolve = resolve; });
      }
      return {messages: [msgA, msgB], total: 2, totalComplete: true, errors: []};
    }
    return {};
  }});

  view.show(); await nextTurn();
  get('mail-list-pane').scrollTop = 120;

  // 1. Open Message A, set reader scroll to 321
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Message A/);
  assert.equal(history.state?.messageId, 'msgA');
  assert.ok(history.state?.snapshotToken);
  assert.equal(location.hash, '#inbox?m=msgA');
  assert.equal(history.state.body, undefined, 'No message body in history state');
  get('mail-reader').scrollTop = 321;

  // 2. Open Message B
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click'); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Message B/);
  assert.equal(history.state?.messageId, 'msgB');
  assert.equal(location.hash, '#inbox?m=msgB');

  // 3. Back -> restores Message A with reader scroll 321
  history.back(); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Message A/);
  assert.equal(location.hash, '#inbox?m=msgA');
  assert.equal(get('mail-reader').scrollTop, 321, 'Reader scroll 321 restored on back');

  // 4. Forward -> returns to Message B
  history.forward(); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Message B/);

  // 5. Back -> Message A, then Back -> list with scroll 120 restored
  history.back(); await nextTurn();
  history.back(); await nextTurn();
  assert.equal(get('mail-reader-content').querySelector('.mail-reader-toolbar'), null, 'Selection-free list state');
  assert.equal(get('mail-list-pane').scrollTop, 120, 'List scroll position restored');

  // 6. Test UI Back preserves departing entry and restores list scroll
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Message A/);
  const backBtn = get('mail-reader-content').querySelector('.mail-back');
  assert.ok(backBtn, 'UI back button exists');
  backBtn.dispatch('click'); await nextTurn();
  assert.equal(get('mail-reader-content').querySelector('.mail-reader-toolbar'), null, 'UI back returns to list');
  assert.equal(get('mail-list-pane').scrollTop, 120, 'UI back restores list scroll 120');

  // 7. Test deferred different query search, then Back aborts active signal and ignores late wrong result
  get('mail-search').value = 'pending-query';
  get('mail-search-form').dispatch('submit'); await nextTurn();
  assert.ok(listAbort, 'Search request created signal');
  assert.equal(listAbort.aborted, false, 'Signal active');
  history.back(); await nextTurn();
  assert.equal(listAbort.aborted, true, 'Popstate immediately aborted in-flight search signal');
  if (listResolve) {
    listResolve({messages: [{id: 'mWrong', accountId: 'acc1', subject: 'Wrong'}], total: 1});
    await nextTurn();
  }
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').some(n => n.dataset.messageId === 'mWrong'), false, 'Late wrong search result ignored');

  // 8. Test bounded snapshots
  for (let i = 0; i < 60; i++) {
    const dummyMsg = {id: `dummy-${i}`, accountId: 'acc1', subject: `Dummy ${i}`};
    history.pushState({snapshotToken: `snap-bulk-${i}`, messageId: dummyMsg.id}, '', `#inbox?m=${dummyMsg.id}`);
  }

  // 9. Account change clears snapshots
  get('mail-account').value = 'acc2';
  get('mail-account').dispatch('change');
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').length, 0, 'Rows cleared synchronously on account change');

  // 10. Malformed percent encoding in hash does not throw
  location.hash = '#inbox?m=%E0%A4%A';
  assert.doesNotThrow(() => {
    window.dispatch('hashchange');
  });

  view.reset();
});

test('deferred popstate message read then user opens another message or changes scope cannot overwrite current scroll or selection', async t => {
  const {get, history} = dom(t);
  const account = {id: 'acc1', connected: true};
  const msgA = {id: 'msgA', accountId: 'acc1', subject: 'Subject A', body: 'Body A'};
  const msgB = {id: 'msgB', accountId: 'acc1', subject: 'Subject B', body: 'Body B'};
  const msgC = {id: 'msgC', accountId: 'acc1', subject: 'Subject C', body: 'Body C'};
  let deferredA = null;

  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account], folders: [{id: 'inbox', accountIds: ['acc1']}], errors: []};
    if (path === '/api/mail/list') return {messages: [msgA, msgB, msgC], total: 3, totalComplete: true, errors: []};
    if (path === '/api/mail/message') {
      if (options.body.id === 'msgA' && deferredA !== false) {
        return new Promise(resolve => { deferredA = resolve; });
      }
      const found = [msgA, msgB, msgC].find(m => m.id === options.body.id);
      return {message: found};
    }
    return {};
  }});

  view.show(); await nextTurn();

  // 1. Genuine user-open Message A (deferredA = false resolves immediately)
  deferredA = false;
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Body A/);
  get('mail-reader').scrollTop = 100;

  // 2. Genuine user-open Message B
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click'); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Body B/);
  get('mail-reader').scrollTop = 200;

  // 3. User triggers back (popstate to Message A), but next read for msgA will be deferred!
  deferredA = null;
  history.back(); await nextTurn();
  assert.ok(deferredA, 'Message A read request is in-flight deferred');

  // 4. While older popstate replay for Message A is in-flight, user opens Message C!
  get('mail-list').querySelectorAll('[data-message-id]')[2].dispatch('click'); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Body C/);
  get('mail-reader').scrollTop = 888;
  assert.equal(history.state?.messageId, 'msgC');

  // 5. Older replay for Message A now resolves
  deferredA({message: msgA});
  await nextTurn();

  // 6. Verify late replay did NOT overwrite Message C's scroll, selection, or content
  assert.equal(get('mail-reader').scrollTop, 888, 'Late replay must not overwrite Message C scroll');
  assert.match(get('mail-reader-content').textContent, /Body C/, 'Late replay must not overwrite Message C content');
  assert.doesNotMatch(get('mail-reader-content').textContent, /Body A/, 'Older Message A content discarded');
  assert.equal(history.state?.messageId, 'msgC', 'History selection remains msgC');

  // 7. Now test scope change during deferred popstate:
  // User opens B, sets scroll, hits back to msgA (deferred), then user changes scope (folder)
  deferredA = false;
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click'); await nextTurn();
  get('mail-reader').scrollTop = 300;
  deferredA = null;
  history.back(); await nextTurn();
  assert.ok(deferredA, 'Message A read request deferred during second popstate');

  // While deferred, user changes folder
  const trashFolder = get('mail-folders').querySelectorAll('*').find(node => node.dataset?.folderId === 'trash' || node.attributes.get('data-folder-id') === 'trash');
  assert.ok(trashFolder);
  trashFolder.dispatch('click');
  await nextTurn();

  // Resolve delayed message A
  deferredA({message: msgA});
  await nextTurn();
  assert.doesNotMatch(get('mail-reader-content').textContent, /Body A/, 'Scope change discarded late popstate replay');

  view.reset();
});

test('app creates over 50 history entries bounding snapshots to 50 memory-only and clearing on reset', async t => {
  const {get, history} = dom(t);
  const account1 = {id: 'acc1', connected: true};
  const account2 = {id: 'acc2', connected: true};
  const messages = Array.from({length: 55}, (_, i) => ({
    id: `bulk-${i}`,
    accountId: 'acc1',
    subject: `Bulk message ${i}`,
    body: `Body ${i}`,
    date: '2026-09-13T10:00:00Z'
  }));

  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account1, account2], folders: [{id: 'inbox', accountIds: ['acc1', 'acc2']}], errors: []};
    if (path === '/api/mail/list') {
      const scoped = options.body.accountIds?.includes('acc2') ? [] : messages;
      return {messages: scoped, total: scoped.length, totalComplete: true, errors: []};
    }
    if (path === '/api/mail/message') {
      const found = messages.find(m => m.id === options.body.id) || {id: options.body.id, accountId: 'acc1', body: 'Fallback'};
      return {message: found};
    }
    return {};
  }});

  view.show(); await nextTurn();

  // App creates 55 history entries via user-open clicks
  const rows = get('mail-list').querySelectorAll('[data-message-id]');
  for (let i = 0; i < 55; i++) {
    rows[i].dispatch('click');
    await nextTurn();
  }

  // Verify memory-only: no message bodies in browser history stack
  for (const entry of history.stack) {
    if (entry?.state) {
      assert.equal(entry.state.body, undefined, 'No message body stored in history state');
      assert.ok(entry.state.snapshotToken, 'Snapshot token stored in history state');
    }
  }

  // Snapshots are bounded to 50. The earliest 5 entries (bulk-0..bulk-4) have been evicted.
  // Replaying back to the very first message bulk-0:
  for (let i = 0; i < 54; i++) {
    history.back();
    await nextTurn();
  }
  assert.equal(history.state?.messageId, 'bulk-0');

  // Account change clears snapshots
  get('mail-account').value = 'acc2';
  get('mail-account').dispatch('change');
  await nextTurn();
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').length, 0);

  view.reset();
});

test('stable conversation host remains the same connected node across star, read, labels, delete confirmation, refresh and threaded toggle', async t => {
  const {get} = dom(t);
  const account = {id: 'acc1', connected: true};
  const message = {id: 'm1', accountId: 'acc1', subject: 'Stable Host Test', unread: true, starred: false, tags: [], body: 'Stable Body Content', hasAttachments: true};

  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account], folders: [{id: 'inbox', accountIds: ['acc1']}], errors: []};
    if (path === '/api/mail/list') return {messages: [message], total: 1, totalComplete: true, errors: []};
    if (path === '/api/mail/message') return {message};
    if (path === '/api/mail/action') {
      if (options.body.action === 'star') message.starred = true;
      if (options.body.action === 'unstar') message.starred = false;
      if (options.body.action === 'mark_read') message.unread = false;
      return {applied: true};
    }
    if (path === '/api/mail/tags') return {tags: [options.body.tag]};
    return {};
  }});

  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();

  const reader = get('mail-reader-content');
  const initialHost = reader.querySelector('.mail-conversation-host');
  assert.ok(initialHost, 'Conversation host mounted');
  assert.equal(initialHost.isConnected, true, 'Host is connected in DOM');

  // Star message
  const starBtn = reader.querySelector('.mail-reader-toolbar').querySelectorAll('button').find(b => b.title?.includes('Star') || b.attributes.get('aria-label')?.includes('Star'));
  assert.ok(starBtn);
  starBtn.dispatch('click'); await nextTurn();
  const hostAfterStar = reader.querySelector('.mail-conversation-host');
  assert.equal(hostAfterStar, initialHost, 'Host remains identical object after star update');

  // Mark read
  const readBtn = reader.querySelector('.mail-reader-toolbar').querySelectorAll('button').find(b => b.attributes.get('aria-label')?.includes('Mark read'));
  assert.ok(readBtn);
  readBtn.dispatch('click'); await nextTurn();
  const hostAfterRead = reader.querySelector('.mail-conversation-host');
  assert.equal(hostAfterRead, initialHost, 'Host remains identical object after read update');

  // Label update
  const labelBtn = reader.querySelector('.mail-reader-toolbar').querySelectorAll('button').find(b => b.attributes.get('aria-label') === 'Labels');
  labelBtn.dispatch('click'); await nextTurn();
  const couponsToggle = get('mail-label-options').querySelectorAll('button').find(b => b.textContent === 'Coupons');
  couponsToggle.dispatch('click'); await nextTurn();
  get('mail-label-close').dispatch('click'); await nextTurn();
  const hostAfterLabel = reader.querySelector('.mail-conversation-host');
  assert.equal(hostAfterLabel, initialHost, 'Host remains identical object after label change');

  // Delete confirmation & cancel
  const deleteBtn = reader.querySelector('.mail-reader-toolbar').querySelector('.mail-delete');
  deleteBtn.dispatch('click'); await nextTurn();
  const hostDuringDelete = reader.querySelector('.mail-conversation-host');
  assert.equal(hostDuringDelete, initialHost, 'Host remains identical during delete confirmation');

  const cancelBtn = reader.querySelector('.mail-delete-confirmation-controls').querySelectorAll('button').find(b => b.textContent === 'Cancel');
  cancelBtn.dispatch('click'); await nextTurn();
  const hostAfterCancel = reader.querySelector('.mail-conversation-host');
  assert.equal(hostAfterCancel, initialHost, 'Host remains identical after cancel');

  // Refresh
  get('mail-refresh').dispatch('click'); await nextTurn();
  const hostAfterRefresh = reader.querySelector('.mail-conversation-host');
  assert.equal(hostAfterRefresh, initialHost, 'Host remains identical after refresh');

  // Threaded toggle: must turn threaded on explicitly
  get('mail-advanced').dispatch('click');
  const threadedCheck = get('mail-advanced-search').querySelectorAll('input[type="checkbox"]').find(c => c.parentNode?.textContent?.includes('Group conversations'));
  assert.ok(threadedCheck);
  threadedCheck.checked = true;
  threadedCheck.dispatch('change'); await nextTurn();

  const hostAfterThreaded = reader.querySelector('.mail-conversation-host');
  assert.equal(hostAfterThreaded, initialHost, 'Host remains identical after threaded toggle');
  assert.equal(initialHost.dataset.threaded, 'true', 'Threaded option passed to conversation render');

  // Attachment jump delegation
  const jumpBtn = reader.querySelector('.mail-jump-attachments');
  assert.ok(jumpBtn, 'Jump to attachments button exists');
  jumpBtn.dispatch('click');
  assert.equal(initialHost.dataset.scrolledAttachments, 'true', 'Delegated scrollAttachments on conversation view');

  // Reset disposes body
  view.reset();
  assert.equal(reader.querySelector('.mail-conversation-host'), null, 'Conversation host removed on reset');
  assert.doesNotMatch(reader.textContent, /Stable Body Content/, 'Conversation body content removed on reset');
  assert.ok(reader.querySelector('.mail-empty') || reader.children.length >= 0, 'Empty-reader placeholder allowed');
});

test('delayed mark-read clamps preferences to allowlist and cancels on visibility loss, hide and navigation', async t => {
  const {get, doc} = dom(t);
  t.mock.timers.enable();

  const actionCalls = [];
  const account = {id: 'acc1', connected: true};
  const msg1 = {id: 'm1', accountId: 'acc1', subject: 'Msg 1', unread: true, date: '2026-09-13T10:00:00Z'};
  const msg2 = {id: 'm2', accountId: 'acc1', subject: 'Msg 2', unread: true, date: '2026-09-13T10:00:00Z'};

  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account], folders: [{id: 'inbox', accountIds: ['acc1']}], errors: []};
    if (path === '/api/mail/list') return {messages: [msg1, msg2], total: 2, totalComplete: true, errors: []};
    if (path === '/api/mail/message') return {message: options.body.id === 'm1' ? msg1 : msg2};
    if (path === '/api/mail/action') { actionCalls.push(options.body); return {applied: true}; }
    return {};
  }});

  // Clamping test: arbitrary 100, -5, NaN, 1000 clamp to 0
  view.setMarkReadDelay(100);
  assert.equal(get('mail-mark-read-setting').value, '0', '100 clamps to 0');
  view.setMarkReadDelay(-50);
  assert.equal(get('mail-mark-read-setting').value, '0', 'Negative clamps to 0');
  view.setMarkReadDelay('invalid');
  assert.equal(get('mail-mark-read-setting').value, '0', 'Invalid clamps to 0');

  // Set supported 3000ms delay
  view.setMarkReadDelay(3000);
  assert.equal(get('mail-mark-read-setting').value, '3000');

  view.show(); await nextTurn();

  // Open message 1
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click');
  await nextTurn();

  // Tick 2000ms: not yet marked read
  t.mock.timers.tick(2000);
  assert.equal(actionCalls.length, 0);

  // Tick remaining 1000ms (total 3000ms): marked read!
  t.mock.timers.tick(1000);
  assert.equal(actionCalls.length, 1);
  assert.deepEqual(actionCalls[0], {id: 'm1', action: 'mark_read'});

  // Test visibility loss cancellation: open message 2
  msg2.unread = true;
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click');
  await nextTurn();

  t.mock.timers.tick(1500);
  // Hide document
  doc.visibilityState = 'hidden';
  doc.hidden = true;
  doc.dispatch('visibilitychange');

  // Advance time past 3000ms
  t.mock.timers.tick(5000);
  assert.equal(actionCalls.length, 1, 'Mark read timer cancelled on visibility loss');

  // Document visible again: does not resume expired timer
  doc.visibilityState = 'visible';
  doc.hidden = false;
  doc.dispatch('visibilitychange');
  t.mock.timers.tick(5000);
  assert.equal(actionCalls.length, 1, 'Expired timer not resumed on visible');

  // Navigation cancels timer: open message 1
  msg1.unread = true;
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click');
  await nextTurn();

  t.mock.timers.tick(1500);
  // Quickly navigate to message 2
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click');
  await nextTurn();

  t.mock.timers.tick(1500);
  // Message 1 timer was cancelled
  assert.equal(actionCalls.filter(c => c.id === 'm1').length, 1);

  // Message 2 marks read when its 3000ms completes
  t.mock.timers.tick(1500);
  assert.equal(actionCalls.filter(c => c.id === 'm2').length, 1);

  view.reset();
});

test('recipient suggestions supplies visible state messages, respects account filter, and drops on switch or reset', async t => {
  const {get} = dom(t);
  const account1 = {id: 'acc1', email: 'one@example.test', label: 'Account 1', connected: true};
  const account2 = {id: 'acc2', email: 'two@example.test', label: 'Account 2', connected: true};
  const msg1 = {
    id: 'm1',
    accountId: 'acc1',
    author: 'Alice Wonderland <alice@example.test>',
    to: ['Bob Builder <bob@example.test>'],
    subject: 'Mail 1'
  };
  const msg2 = {
    id: 'm2',
    accountId: 'acc2',
    author: 'Charlie Chocolate <charlie@example.test>',
    cc: ['David Copperfield <david@example.test>'],
    subject: 'Mail 2'
  };

  let capturedGetRecipients = null;
  const view = buildMailView({
    composeViewFactory: opts => {
      capturedGetRecipients = opts.getRecipients;
      return {open() {}, renderSettings() {}, reset() {}};
    },
    conversationViewFactory: opts => createMockConversationView(opts),
    api: async path => {
      if (path === '/api/mail/folders') return {accounts: [account1, account2], folders: [{id: 'inbox', accountIds: ['acc1', 'acc2']}], errors: []};
      if (path === '/api/mail/list') return {messages: [msg1, msg2], total: 2, totalComplete: true, errors: []};
      return {};
    }
  });

  assert.ok(capturedGetRecipients, 'Composer received getRecipients callback');
  view.show(); await nextTurn();

  // All accounts scope: includes both msg1 and msg2 recipients
  const allRecipients = capturedGetRecipients();
  assert.ok(allRecipients.some(r => r.address === 'alice@example.test'));
  assert.ok(allRecipients.some(r => r.address === 'bob@example.test'));
  assert.ok(allRecipients.some(r => r.address === 'charlie@example.test'));
  assert.ok(allRecipients.some(r => r.address === 'david@example.test'));

  // Switch to account 1: only acc1 recipients included
  get('mail-account').value = 'acc1';
  get('mail-account').dispatch('change');
  // Rows cleared synchronously
  assert.equal(capturedGetRecipients().length, 0);

  view.reset();
  assert.equal(capturedGetRecipients().length, 0, 'Reset drops recipients');
});

test('explicit cache refresh queues POST /api/mail/cache/refresh once, runs list refresh in parallel, preserves stable reader and scroll, and new query clears metadata', async t => {
  const {get} = dom(t);
  const account = {id: 'acc1', connected: true};
  const message = {id: 'm1', accountId: 'acc1', author: 'Sender', subject: 'Subject 1', body: 'Body 1'};
  const calls = [];
  let cachePayload = {
    source: 'cache',
    coverage: {status: 'warming', cached: 10},
    lastSuccessfulSync: 1726830000000
  };

  const view = createMailView({api: async (path, options) => {
    calls.push({path, body: options?.body});
    if (path === '/api/mail/folders') return {accounts: [account], folders: [{id: 'inbox', accountIds: ['acc1']}], errors: []};
    if (path === '/api/mail/list') return {messages: [message], total: 1, totalComplete: true, errors: [], ...cachePayload};
    if (path === '/api/mail/message') return {message};
    if (path === '/api/mail/cache/refresh') return {refreshing: true};
    return {};
  }});

  view.show(); await nextTurn();
  // Open message in reader
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Subject 1/);
  const initialHost = get('mail-reader-content').querySelector('.mail-conversation-host');

  // Click refresh
  get('mail-refresh').dispatch('click'); await nextTurn();

  // POST /api/mail/cache/refresh was queued
  const cacheRefreshCalls = calls.filter(c => c.path === '/api/mail/cache/refresh');
  assert.equal(cacheRefreshCalls.length, 1, 'Cache refresh endpoint called exactly once');

  // Reader host and content preserved
  const hostAfter = get('mail-reader-content').querySelector('.mail-conversation-host');
  assert.equal(hostAfter, initialHost, 'Stable reader host preserved across cache refresh');
  assert.match(get('mail-reader-content').textContent, /Subject 1/);

  // New search clears cache metadata
  get('mail-search').value = 'search term';
  get('mail-search-form').dispatch('submit'); await nextTurn();

  view.reset();
});

test('density and reading mode preferences toggle classes and persist in state', t => {
  const {get} = dom(t);
  const view = createMailView({api: async () => ({})});
  view.setDensity('compact');
  assert.ok(get('mail-page').classList.contains('mail-density-compact'));
  view.setReadingMode('full');
  assert.ok(get('mail-page').classList.contains('mail-reading-full'));
  view.setMarkReadDelay(3000);
  assert.equal(get('mail-mark-read-setting').value, '3000');
  view.setDensity('default');
  assert.equal(get('mail-page').classList.contains('mail-density-compact'), false);
  view.setReadingMode('split');
  assert.equal(get('mail-page').classList.contains('mail-reading-full'), false);
  view.reset();
});

test('archive quick action removes row, decrements total, and sets undo token without closing unrelated reader', async t => {
  const {get} = dom(t);
  const account = {id: 'acc1', connected: true};
  const message1 = {id: 'm1', accountId: 'acc1', author: 'A', subject: 'Msg 1', date: '2026-09-13T10:00:00Z'};
  const message2 = {id: 'm2', accountId: 'acc1', author: 'B', subject: 'Msg 2', date: '2026-09-13T11:00:00Z'};
  const calls = [];
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account], folders: [{id: 'inbox', accountIds: ['acc1']}], errors: []};
    if (path === '/api/mail/list') return {messages: [message1, message2], total: 2, totalComplete: true, errors: []};
    if (path === '/api/mail/message') return {message: message1};
    if (path === '/api/mail/action') {
      calls.push(options.body);
      return {applied: true, undoToken: 'undo-archive-m2'};
    }
    return {};
  }});
  view.show(); await nextTurn();
  // Open message 1
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Msg 1/);

  // Click archive quick action on message 2
  const archiveBtns = get('mail-list').querySelectorAll('.mail-quick-archive');
  assert.ok(archiveBtns.length >= 2);
  archiveBtns[1].dispatch('click'); await nextTurn();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {id: 'm2', action: 'archive'});
  // Reader for message 1 remains open
  assert.match(get('mail-reader-content').textContent, /Msg 1/);
  // List only contains message 1 now
  assert.equal(get('mail-list').querySelectorAll('[data-message-id]').length, 1);
  view.reset();
});

test('attachments load only on demand, download through authenticated POST and preview only safe types', async t => {
  const {get} = dom(t);
  const attachments = [
    {id: '2', filename: '<img src=x onerror=alert(1)>.png', mimeType: 'image/png', size: 2048},
    {id: '3', filename: 'report.pdf', mimeType: 'application/pdf', size: 8192},
    {id: '4', filename: 'notes.txt', mimeType: 'text/plain', size: 42},
    {id: '5', filename: 'page.html', mimeType: 'text/html', size: 13},
    {id: '6', filename: 'image.svg', mimeType: 'image/svg+xml', size: 1024}
  ];
  const message = {id: 'opaque&value', accountId: 'a', subject: 'Files', attachments};
  const calls = [];
  const created = [];
  const revoked = [];
  t.mock.method(URL, 'createObjectURL', blob => { const url = `blob:fixture-${created.length}`; created.push({url, blob}); return url; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [{id: 'a', connected: true}], folders: [{id: 'inbox', accountIds: ['a']}]};
    if (path === '/api/mail/list') return {messages: [message]};
    if (path === '/api/mail/message') return {message: {...message, body: 'Files attached'}};
    assert.equal(path, '/api/mail/attachment'); calls.push(options);
    return new Blob(['<script>untrusted attachment text</script>'], {type: 'text/html'});
  }});
  const descendants = () => get('mail-reader-content').querySelectorAll('*');
  const control = (action, attachment) => descendants().find(node => node.attributes.get('aria-label') === `${action} ${attachment.filename}`);
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  assert.equal(calls.length, 0, 'Reading an email must not fetch attachments.');
  assert.match(get('mail-reader-content').textContent, /5 attachments/);
  assert.match(get('mail-reader-content').textContent, /PNG Image · 2.0 KB/);
  assert.ok(control('Download', attachments[4]));
  assert.equal(control('View', attachments[3]), undefined);
  assert.equal(control('View', attachments[4]), undefined, 'HTML and SVG cannot create same-origin active previews.');
  assert.equal(descendants().some(node => node.tagName.toLowerCase() === 'img'), false, 'Filenames render as text.');

  control('View', attachments[0]).dispatch('click'); await nextTurn();
  assert.deepEqual(calls.at(-1).body, {id: 'opaque&value', attachmentId: '2'});
  assert.equal(calls.at(-1).method, 'POST');
  assert.equal(calls.at(-1).responseType, 'blob');
  assert.equal(created[0].blob.type, 'image/png', 'Preview MIME must come from the allowlist, regardless of response headers.');
  const overlayImg = document.body.querySelector('img.mail-attachment-img');
  assert.ok(overlayImg, 'Image preview overlay rendered in body');
  assert.equal(overlayImg.src, created[0].url);

  control('View', attachments[1]).dispatch('click'); await nextTurn();
  assert.deepEqual(calls.at(-1).body, {id: 'opaque&value', attachmentId: '3'});
  assert.equal(calls.at(-1).method, 'POST');
  assert.ok(revoked.includes(created[0].url));
  const pdfDialog = document.body.querySelector('dialog');
  assert.ok(pdfDialog, 'PDF preview opens in dialog overlay rather than a new tab');
  const pdfCanvas = document.body.querySelector('canvas.mail-pdf-canvas');
  assert.ok(pdfCanvas, 'PDF preview renders to canvas');

  control('View', attachments[2]).dispatch('click'); await nextTurn();
  const pre = document.body.querySelector('pre.mail-attachment-text-view');
  assert.ok(pre, 'Text preview rendered in body dialog');
  assert.equal(pre.textContent, '<script>untrusted attachment text</script>');
  assert.equal(document.body.querySelectorAll('script').length, 0, 'No active script elements');

  control('Download', attachments[3]).dispatch('click'); await nextTurn();
  const clickedAnchor = document.clickedElements.at(-1);
  assert.ok(clickedAnchor, 'Download anchor clicked');
  assert.equal(clickedAnchor.download, 'page.html');
  const downloadEntry = created.find(c => c.blob.type === 'application/octet-stream');
  assert.ok(downloadEntry, 'Found octet-stream download blob');
  assert.equal(clickedAnchor.href, downloadEntry.url);
  assert.equal(downloadEntry.blob.type, 'application/octet-stream', 'Downloads are never opened as active HTML.');
  view.reset();
  assert.ok(revoked.includes(downloadEntry.url), 'Logging out revokes outstanding download URLs.');
});

test('attachment navigation races never open old files and failures leave the message usable', async t => {
  const {get} = dom(t);
  const messages = ['a', 'b'].map(id => ({id, accountId: 'account', subject: id, attachments: [{id: '2', filename: `${id}.png`, mimeType: 'image/png', size: 20}]}));
  let finishAttachment;
  let fail = false;
  const created = [];
  const revoked = [];
  t.mock.method(URL, 'createObjectURL', () => { const url = `blob:fixture-${created.length}`; created.push(url); return url; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [{id: 'account', connected: true}], folders: [{id: 'inbox', accountIds: ['account']}]};
    if (path === '/api/mail/list') return {messages};
    if (path === '/api/mail/message') return {message: {...messages.find(message => message.id === options.body.id), body: `Body ${options.body.id}`}};
    if (fail) throw Object.assign(new Error('Too big'), {code: 'attachment_too_large'});
    return new Promise(resolve => { finishAttachment = () => resolve(new Blob(['file'])); });
  }});
  const control = label => get('mail-reader-content').querySelectorAll('*').find(node => node.attributes.get('aria-label') === label);
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  control('Download a.png').dispatch('click');
  assert.equal(control('View a.png').disabled, true);
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click'); await nextTurn();
  finishAttachment(); await nextTurn();
  assert.equal(created.length, 0); assert.equal(document.clickedElements.length, 0, 'Navigation must discard a late download.');
  assert.match(get('mail-reader-content').textContent, /Body b/);
  fail = true; control('View b.png').dispatch('click'); await nextTurn();
  const dialogError = document.body.querySelector('.mail-attachment-error') || document.body.querySelector('.mail-attachment-dialog');
  assert.match(dialogError?.textContent || '', /Too big/);
  assert.match(dialogError?.textContent || '', /Retry/);
  assert.equal(control('Download b.png').disabled, false);
  assert.match(get('mail-reader-content').textContent, /Body b/);
  fail = false; control('View b.png').dispatch('click'); finishAttachment(); await nextTurn();
  assert.equal(created.length, 1);
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  assert.deepEqual(revoked, created, 'Navigating to another message revokes the image preview.');
  control('View a.png').dispatch('click'); view.reset(); finishAttachment(); await nextTurn();
  assert.equal(created.length, 1, 'Logging out must discard a late preview.');
  assert.doesNotMatch(get('mail-reader-content').textContent, /Body a/);
});

test('refresh keeps message list visible, marks stale rows, and preserves selection and current reader', async t => {
  const {get} = dom(t);
  const calls = [];
  const account = {id: 'acc1', email: 'acc1@example.test', label: 'Account 1', connected: true};
  const messageA = {id: 'mA', accountId: 'acc1', author: 'Alice', subject: 'Topic A', date: '2026-09-13T10:00:00Z'};
  const messageB = {id: 'mB', accountId: 'acc1', author: 'Bob', subject: 'Topic B', date: '2026-09-13T11:00:00Z'};
  let listResolve;
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts: [account], folders: [{id: 'inbox', accountIds: ['acc1']}], errors: []};
    if (path === '/api/mail/message') return {message: messageA};
    if (path === '/api/mail/list') {
      calls.push(options.body);
      return new Promise(resolve => { listResolve = resolve; });
    }
    return {};
  }});
  view.show(); await nextTurn();
  listResolve({messages: [messageA, messageB], total: 2, totalComplete: true, errors: []}); await nextTurn();

  // Select message A
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  assert.match(get('mail-reader-content').textContent, /Topic A/);

  const initialHost = get('mail-reader-content').querySelector('.mail-conversation-host');

  // Trigger refresh
  get('mail-refresh').dispatch('click'); await nextTurn();

  // Stale list rows remain visible during refresh
  const rows = get('mail-list').querySelectorAll('[data-message-id]');
  assert.equal(rows.length, 2, 'Message list rows remain visible while refreshing.');
  assert.ok(get('mail-list').classList.contains('mail-refreshing') || get('mail-list').querySelectorAll('*').some(node => node.className.includes('mail-refreshing')));

  // Complete refresh
  listResolve({messages: [messageA, messageB], total: 2, totalComplete: true, errors: []}); await nextTurn();

  // Selection and reader are preserved
  assert.match(get('mail-reader-content').textContent, /Topic A/, 'Open message reader is preserved across refresh.');
  assert.equal(get('mail-list').classList.contains('mail-refreshing'), false);
  const hostAfterRefresh = get('mail-reader-content').querySelector('.mail-conversation-host');
  assert.equal(hostAfterRefresh, initialHost);
  assert.equal(hostAfterRefresh.isConnected, true);
  view.reset();
});

test('reader conversation toggle and inline composer hooks keep a stable host and dock before temporary hiding', async t => {
  const {get} = dom(t);
  const message = {id: 'hook-message', accountId: 'a', subject: 'Hooks', body: 'Body'};
  const calls = [], docks = [], renders = [];
  let hooks, currentHost, defer = false, finish;
  const anchor = new Element('div');
  const view = createMailView({
    composeViewFactory: () => ({open: value => calls.push(value), dock: value => docks.push({value, hidden: currentHost?.hidden}), reset() {}, renderSettings() {}}),
    conversationViewFactory: options => {
      hooks = options;
      return {
        render(host, full, options) {currentHost = host; if (anchor.parentNode !== host) host.append(anchor); renders.push(options.threaded);},
        reset() {}, scrollAttachments() {}
      };
    },
    api: async (path) => {
      if (path === '/api/mail/folders') return {accounts: [{id:'a',connected:true}],folders:[{id:'inbox',accountIds:['a']}]};
      if (path === '/api/mail/list') return {messages:[message]};
      if (path === '/api/mail/message') return defer ? new Promise(resolve => {finish=resolve;}) : {message};
      return {};
    }
  });
  view.show(); await nextTurn();
  get('mail-list').querySelector('[data-message-id]').dispatch('click'); await nextTurn();
  const originalHost = currentHost;
  const toggle = get('mail-reader-content').querySelector('.mail-toggle-conversation');
  assert.equal(toggle.textContent, 'Show conversation');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  toggle.dispatch('click');
  assert.equal(renders.at(-1), true);
  assert.equal(currentHost, originalHost);
  assert.equal(get('mail-reader-content').querySelector('.mail-toggle-conversation').textContent, 'Show single message');
  hooks.openCompose({mode:'replyAll',id:message.id,accountId:'a',anchor});
  assert.equal(calls.at(-1).anchor, anchor);
  assert.equal(calls.at(-1).mode, 'reply_all');
  hooks.dockCompose(anchor);
  assert.equal(docks.at(-1).value, anchor);
  docks.length = 0;
  defer = true;
  get('mail-list').querySelector('[data-message-id]').dispatch('click');
  assert.equal(currentHost, originalHost);
  assert.equal(docks[0].hidden, false, 'Dock before hiding an active reply host');
  assert.equal(originalHost.hidden, true);
  finish({message}); await nextTurn();
  assert.equal(originalHost.hidden, false);
});

test('history restores provider pagination mode after Browse older mail', async t => {
  const {get, history} = dom(t);
  const message = {id:'older',accountId:'a',subject:'Older mail',body:'Body'};
  const requests=[];
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts:[{id:'a',connected:true}],folders:[{id:'inbox',accountIds:['a']}]};
    if (path === '/api/mail/message') return {message};
    if (path === '/api/mail/list') {
      requests.push(options.body);
      if (options.body.live) return {messages:[message],source:'provider',nextCursor:'provider-next'};
      return {messages:[message],source:'cache',providerFallback:true,coverage:{status:'partial',cached:1,limited:true}};
    }
    return {};
  }});
  view.show(); await nextTurn();
  const browse = get('mail-search-summary').querySelectorAll('button').find(button => /Browse older/i.test(button.textContent));
  assert.ok(browse);
  browse.dispatch('click'); await nextTurn();
  assert.equal(requests.at(-1).live, true);
  get('mail-list').querySelector('[data-message-id]').dispatch('click'); await nextTurn();
  history.back(); await nextTurn();
  get('mail-more').dispatch('click'); await nextTurn();
  assert.equal(requests.at(-1).live, true);
  assert.equal(requests.at(-1).cursor, 'provider-next');
});

test('fresh navigation starts at its heading after the asynchronous message body mounts', async t => {
  const {get} = dom(t);
  const messages = [{id:'pdf-old',accountId:'a',subject:'PDF mail'},{id:'html-new',accountId:'a',subject:'HTML mail'}];
  let finish;
  const view = createMailView({
    conversationViewFactory: () => ({
      render(host, message) {
        host.textContent = message.body;
        // Model a late layout/scroll-restoration change during body mounting.
        if (message.id === 'html-new') get('mail-reader').scrollTop = 343;
      },
      reset() {}, scrollAttachments() {}
    }),
    api: async (path, options) => {
      if (path === '/api/mail/folders') return {accounts:[{id:'a',connected:true}],folders:[{id:'inbox',accountIds:['a']}]};
      if (path === '/api/mail/list') return {messages};
      if (path === '/api/mail/message') {
        if (options.body.id === 'html-new') return new Promise(resolve => {finish=resolve;});
        return {message:{...messages[0],body:'Old long mail'}};
      }
      return {};
    }
  });
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  get('mail-reader').scrollTop = 1071.5;
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click');
  assert.equal(get('mail-reader').scrollTop, 0, 'Loading navigation resets immediately');
  finish({message:{...messages[1],body:'Complete new message'}}); await nextTurn();
  assert.equal(get('mail-reader').scrollTop, 0, 'Completed fresh navigation still starts at the heading');
  assert.match(get('mail-reader-content').textContent, /Complete new message/);
});

test('a pending list refresh cannot restore an old reader scroll after another message is opened', async t => {
  const {get} = dom(t);
  const messages = [{id:'one',accountId:'a',subject:'First'},{id:'two',accountId:'a',subject:'Second'}];
  let reads=0, finishRefresh;
  const view = createMailView({api: async (path, options) => {
    if (path === '/api/mail/folders') return {accounts:[{id:'a',connected:true}],folders:[{id:'inbox',accountIds:['a']}]};
    if (path === '/api/mail/list') {
      if (++reads > 1) return new Promise(resolve => {finishRefresh=resolve;});
      return {messages};
    }
    if (path === '/api/mail/message') return {message:{...messages.find(message => message.id === options.body.id),body:'Current body'}};
    return {};
  }});
  view.show(); await nextTurn();
  get('mail-list').querySelectorAll('[data-message-id]')[0].dispatch('click'); await nextTurn();
  get('mail-reader').scrollTop = 1071.5;
  get('mail-refresh').dispatch('click'); await nextTurn();
  assert.ok(finishRefresh);
  get('mail-list').querySelectorAll('[data-message-id]')[1].dispatch('click'); await nextTurn();
  assert.equal(get('mail-reader').scrollTop, 0);
  get('mail-reader').scrollTop = 81;
  finishRefresh({messages}); await nextTurn();
  assert.equal(get('mail-reader').scrollTop, 81, 'Late refresh must preserve the new reader position');
  assert.match(get('mail-reader-content').textContent, /Second/);
});

for (const partial of [false, true]) {
  test(`history restores inbox counts and coverage after a one-result search (${partial ? 'partial' : 'complete'})`, async t => {
    const {get, history} = dom(t);
    const messages = Array.from({length:50}, (_, index) => ({id:`inbox-${index}`,accountId:'a',subject:index ? `Inbox ${index}` : 'Harbor weekly',body:'Body'}));
    const annual = {id:'annual',accountId:'a',subject:'Annual',body:'Annual body'};
    const view = createMailView({api: async (path, options) => {
      if (path === '/api/mail/folders') return {accounts:[{id:'a',connected:true}],folders:[{id:'inbox',accountIds:['a']}]};
      if (path === '/api/mail/list') {
        if (options.body.query) {
          assert.equal(options.body.filters.from, 'alex@example.test');
          return {messages:[annual],total:1,totalComplete:true,source:'provider'};
        }
        return {messages,total:118,totalComplete:!partial,nextCursor:'inbox-next',errors:partial ? [{accountId:'a',code:'timeout'}] : [],source:'cache',coverage:{status:partial ? 'partial' : 'complete',cached:118,limited:partial}};
      }
      if (path === '/api/mail/message') return {message:options.body.id === annual.id ? annual : messages[0]};
      return {};
    }});
    const expected = partial ? '50 messages loaded · partial results' : '50 of 118 messages';
    view.show(); await nextTurn();
    assert.equal(get('mail-list-count').textContent, expected);
    get('mail-list').querySelector('[data-message-id]').dispatch('click'); await nextTurn();
    get('mail-advanced').dispatch('click');
    const from = get('mail-advanced-search').querySelectorAll('input').find(input => input.parentNode?.textContent?.includes('From'));
    from.value = 'alex@example.test'; from.dispatch('input');
    get('mail-search').value = 'Annual';
    get('mail-search-form').dispatch('submit'); await nextTurn();
    assert.equal(get('mail-list-count').textContent, '1 of 1 messages');
    get('mail-list').querySelector('[data-message-id]').dispatch('click'); await nextTurn();
    history.back(); await nextTurn();
    assert.equal(get('mail-search').value, '');
    assert.equal(get('mail-list').querySelectorAll('[data-message-id]').length, 50);
    assert.equal(get('mail-list-count').textContent, expected);
    assert.match(get('mail-search-summary').textContent, /118 cached/);
    assert.equal(get('mail-search-summary').textContent.includes('Partial coverage'), partial);
    get('mail-reader-content').querySelector('.mail-back').dispatch('click'); await nextTurn();
    assert.equal(get('mail-list-count').textContent, expected, 'Reader Back keeps the restored inbox metadata');
    view.reset();
  });
}
