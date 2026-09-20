import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createConversationView } from '../web/mail-conversation.mjs';

function toCamelCase(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.events = new Map();
    this.attributes = new Map();
    this.value = '';
    this.className = '';
    this.hidden = false;
    this.parentNode = null;
    this.type = '';
    this.scrollCalls = [];

    const self = this;
    this.dataset = new Proxy({}, {
      set: (target, prop, value) => {
        target[prop] = String(value);
        const attrName = 'data-' + String(prop).replace(/([A-Z])/g, '-$1').toLowerCase();
        self.attributes.set(attrName, String(value));
        return true;
      },
      get: (target, prop) => {
        if (prop in target) return target[prop];
        const attrName = 'data-' + String(prop).replace(/([A-Z])/g, '-$1').toLowerCase();
        return self.attributes.get(attrName);
      }
    });

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

  get id() {
    return this.attributes.get('id') || '';
  }

  set id(value) {
    if (value) this.attributes.set('id', String(value));
    else this.attributes.delete('id');
  }

  get textContent() {
    return (this.text || '') + this.children.map(child => child.textContent).join('');
  }

  set textContent(value) {
    this.text = String(value);
    for (const child of this.children) {
      child.parentNode = null;
    }
    this.children = [];
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    if (idx === -1 || idx >= this.parentNode.children.length - 1) return null;
    return this.parentNode.children[idx + 1];
  }

  get previousSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    if (idx <= 0) return null;
    return this.parentNode.children[idx - 1];
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      if (node.parentNode) {
        node.remove();
      }
      node.parentNode = this;
      this.children.push(node);
    }
  }

  insertBefore(newNode, refNode) {
    if (!newNode) return;
    if (newNode.parentNode) {
      newNode.remove();
    }
    newNode.parentNode = this;
    if (!refNode) {
      this.children.push(newNode);
      return;
    }
    const idx = this.children.indexOf(refNode);
    if (idx === -1) {
      this.children.push(newNode);
    } else {
      this.children.splice(idx, 0, newNode);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) {
      child.parentNode = null;
    }
    this.text = '';
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx, 1);
      }
      this.parentNode = null;
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[prop] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      delete this.dataset[prop];
    }
  }

  addEventListener(name, callback) {
    if (!this.events.has(name)) this.events.set(name, []);
    this.events.get(name).push(callback);
  }

  removeEventListener(name, callback) {
    const list = this.events.get(name);
    if (list) {
      const idx = list.indexOf(callback);
      if (idx !== -1) list.splice(idx, 1);
    }
  }

  dispatch(name, event = {}) {
    const list = this.events.get(name) || [];
    for (const cb of list) {
      cb({ preventDefault() {}, currentTarget: this, target: this, ...event });
    }
  }

  click() {
    return this.dispatch('click');
  }

  scrollIntoView(options) {
    this.scrollCalls.push(options);
  }

  contains(other) {
    if (this === other) return true;
    return this.children.some(c => c === other || (c.contains && c.contains(other)));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = node => {
      for (const child of node.children) {
        if (matches(child, selector)) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }
}

function matches(el, selector) {
  if (selector.startsWith('.')) {
    return el.classList.contains(selector.slice(1));
  }
  if (selector.startsWith('#')) {
    return el.id === selector.slice(1);
  }
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const attrExp = selector.slice(1, -1);
    if (attrExp.includes('=')) {
      const [k, v] = attrExp.split('=');
      const cleanVal = v.replace(/^['"]|['"]$/g, '');
      const camelProp = k.startsWith('data-') ? toCamelCase(k.slice(5)) : null;
      return (
        el.getAttribute(k) === cleanVal ||
        (camelProp && el.dataset[camelProp] === cleanVal) ||
        el.dataset[k] === cleanVal ||
        el.dataset[k.replace(/^data-/, '')] === cleanVal
      );
    }
    const camelProp = attrExp.startsWith('data-') ? toCamelCase(attrExp.slice(5)) : null;
    return (
      el.attributes.has(attrExp) ||
      (camelProp && el.dataset[camelProp] !== undefined) ||
      el.dataset[attrExp] !== undefined ||
      el.dataset[attrExp.replace(/^data-/, '')] !== undefined
    );
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function setupDom(t) {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: tag => new Element(tag),
      createElementNS: (_, tag) => new Element(tag),
      getElementById: () => null
    }
  });

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {}
    }
  });

  t.after(() => {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
  });
}

function createTrackingFactories() {
  let richCounter = 0;
  let attCounter = 0;
  const richInstances = [];
  const attInstances = [];

  const richViewFactory = () => {
    const id = ++richCounter;
    const instance = {
      id,
      renderedHosts: [],
      renderCalls: [],
      resetCalls: 0,
      render(container, value, options) {
        this.renderedHosts.push(container);
        this.renderCalls.push({ value, options });
        const text = document.createElement('div');
        text.className = 'rich-mail-rendered';
        text.textContent = `RichMail-${id}: ${value?.body || value?.snippet || ''}`;
        container.append(text);
      },
      reset() {
        this.resetCalls++;
      }
    };
    richInstances.push(instance);
    return instance;
  };

  const attachmentsViewFactory = () => {
    const id = ++attCounter;
    const instance = {
      id,
      renderedHosts: [],
      renderCalls: [],
      resetCalls: 0,
      renderGrid(container, message) {
        this.renderedHosts.push(container);
        this.renderCalls.push(message);
        const section = document.createElement('section');
        section.className = 'mail-attachments';
        section.id = 'mail-attachments-section';
        section.textContent = `Attachments-${id} for ${message.id}`;
        container.append(section);
      },
      reset() {
        this.resetCalls++;
      }
    };
    attInstances.push(instance);
    return instance;
  };

  return { richViewFactory, attachmentsViewFactory, richInstances, attInstances };
}

test('selected single mail without threadId loads conversation and displays full expanded entry', async t => {
  setupDom(t);
  const container = document.createElement('div');
  const apiCalls = [];
  const composeCalls = [];

  const { richViewFactory, attachmentsViewFactory, richInstances, attInstances } = createTrackingFactories();

  const selectedMsg = {
    id: 'msg-solo',
    accountId: 'acc1',
    author: 'Solo Sender <solo@example.test>',
    subject: 'Single email',
    snippet: 'This is a single message without threadId',
    date: '2026-09-20T10:00:00Z',
    body: 'Single email body'
  };

  const view = createConversationView({
    api: async (path, options) => {
      apiCalls.push({ path, options });
      if (path === '/api/mail/conversation') {
        return {
          messages: [{ ...selectedMsg }],
          complete: true,
          nextCursor: null,
          errors: []
        };
      }
      return {};
    },
    openCompose: args => composeCalls.push(args),
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  // Render with threaded: true even when provider threadId is absent
  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  // Verify /api/mail/conversation was called with { id: 'msg-solo' }
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].path, '/api/mail/conversation');
  assert.equal(apiCalls[0].options.body.id, 'msg-solo');
  assert.equal(apiCalls[0].options.timeout, 130000);

  // Verify single expanded entry
  const entries = container.querySelectorAll('.mail-conversation-entry');
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry.classList.contains('current'));
  assert.ok(entry.classList.contains('expanded'));
  assert.equal(entry.dataset.messageId, 'msg-solo');

  // Verify header aria-expanded is true
  const headerBtn = entry.querySelector('.mail-conversation-entry-header');
  assert.ok(headerBtn);
  assert.equal(headerBtn.getAttribute('aria-expanded'), 'true');
  assert.match(headerBtn.textContent, /Solo Sender/);

  // Verify rich content and attachments views were rendered
  assert.equal(richInstances.length, 1);
  assert.equal(richInstances[0].renderCalls.length, 1);
  assert.equal(attInstances.length, 1);
  assert.equal(attInstances[0].renderCalls.length, 1);

  // Verify scrollAttachments scrolls the selected entry's attachment section
  view.scrollAttachments();
  const attSection = entry.querySelector('.mail-attachments');
  assert.ok(attSection);
  assert.equal(attSection.scrollCalls.length, 1);
  assert.equal(attSection.scrollCalls[0].block, 'start');

  // Verify Reply, Reply all, Forward actions
  const replyBtn = entry.querySelector('.mail-conversation-actions').querySelectorAll('button')[0];
  assert.equal(replyBtn.textContent, 'Reply');
  replyBtn.click();
  assert.equal(composeCalls.length, 1);
  assert.equal(composeCalls[0].anchor, entry.querySelector('.mail-conversation-reply-host'));
  assert.deepEqual({...composeCalls[0], anchor: undefined}, { mode: 'reply', id: 'msg-solo', accountId: 'acc1', anchor: undefined });

  view.reset();
});

test('cumulative pagination with partial note and bounded-terminal notice', async t => {
  setupDom(t);
  const container = document.createElement('div');
  const apiCalls = [];

  const { richViewFactory, attachmentsViewFactory } = createTrackingFactories();

  const msg0 = { id: 'm0', accountId: 'acc1', author: 'User 0', date: '2026-09-20T08:00:00Z', snippet: 'Msg 0' };
  const msg1 = { id: 'm1', accountId: 'acc1', author: 'User 1', date: '2026-09-20T09:00:00Z', snippet: 'Msg 1' };
  const msgSelected = { id: 'm-selected', accountId: 'acc1', author: 'User 2', date: '2026-09-20T10:00:00Z', snippet: 'Msg Selected', body: 'Selected body' };

  const view = createConversationView({
    api: async (path, options) => {
      apiCalls.push({ path, options });
      if (path === '/api/mail/conversation') {
        if (!options.body.cursor) {
          // Initial response: partial with nextCursor
          return {
            messages: [msg1, msgSelected],
            complete: false,
            nextCursor: 'cur-step-2',
            errors: [{ message: 'Provider rate limited' }]
          };
        } else if (options.body.cursor === 'cur-step-2') {
          // Pagination response: cumulative messages, still complete: false, but cursor: null (terminal)
          return {
            messages: [msg0, msg1, msgSelected],
            complete: false,
            nextCursor: null,
            errors: [{ message: 'History limit reached' }]
          };
        }
      }
      return {};
    },
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, msgSelected, { threaded: true });
  await nextTurn();

  // Partial results note with count and error hint
  const partialNote = container.querySelector('.mail-conv-partial');
  assert.ok(partialNote, 'Partial note is rendered when complete: false');
  assert.match(partialNote.textContent, /2 messages loaded/);
  assert.match(partialNote.textContent, /Provider rate limited/);

  // "Load more conversation messages" button exists because nextCursor exists
  const moreBtn = container.querySelector('.mail-conv-more');
  assert.ok(moreBtn, 'Load more button is present when nextCursor exists');
  assert.equal(moreBtn.textContent, 'Load more conversation messages');

  // Click load more
  moreBtn.click();
  await nextTurn();

  assert.equal(apiCalls.length, 2);
  assert.equal(apiCalls[1].options.body.cursor, 'cur-step-2');

  // Second response has complete: false but nextCursor: null -> bounded-terminal notice
  const terminalNote = container.querySelector('.mail-conv-terminal');
  assert.ok(terminalNote, 'Bounded terminal notice is rendered when complete: false and cursor is null');
  assert.match(terminalNote.textContent, /End of available conversation history/);

  // Load more button should NOT be rendered anymore
  assert.equal(container.querySelector('.mail-conv-more'), null);

  // Verify chronological ordering in DOM: m0 before m1 before m-selected
  const renderedEntries = container.querySelectorAll('.mail-conversation-entry');
  assert.equal(renderedEntries.length, 3);
  assert.equal(renderedEntries[0].dataset.messageId, 'm0');
  assert.equal(renderedEntries[1].dataset.messageId, 'm1');
  assert.equal(renderedEntries[2].dataset.messageId, 'm-selected');

  view.reset();
});

test('duplicate and mixed account messages are filtered and never rendered', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const { richViewFactory, attachmentsViewFactory } = createTrackingFactories();

  const selectedMsg = { id: 'sel-1', accountId: 'account-primary', author: 'Primary User', date: '2026-09-20T10:00:00Z', body: 'Selected' };
  const foreignMsg = { id: 'foreign-1', accountId: 'account-other', author: 'Other Account User', date: '2026-09-20T09:00:00Z' };
  const dupMsg1 = { id: 'dup-1', accountId: 'account-primary', author: 'Primary User', date: '2026-09-20T09:30:00Z' };
  const dupMsg2 = { id: 'dup-1', accountId: 'account-primary', author: 'Primary User', date: '2026-09-20T09:30:00Z' };

  const view = createConversationView({
    api: async () => ({
      messages: [foreignMsg, dupMsg1, dupMsg2, selectedMsg],
      complete: true,
      nextCursor: null,
      errors: []
    }),
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  // foreignMsg should NOT be in DOM
  assert.equal(container.querySelector('[data-message-id="foreign-1"]'), null);

  // dupMsg should only be in DOM once
  const dupEntries = container.querySelectorAll('[data-message-id="dup-1"]');
  assert.equal(dupEntries.length, 1);

  // Total entries: dup-1 and sel-1
  const entries = container.querySelectorAll('.mail-conversation-entry');
  assert.equal(entries.length, 2);

  view.reset();
});

test('independent two expanded replies own distinct richView and attachmentsView hosts', async t => {
  setupDom(t);
  const container = document.createElement('div');
  const composeCalls = [];

  const { richViewFactory, attachmentsViewFactory, richInstances, attInstances } = createTrackingFactories();

  const selectedMsg = { id: 'sel', accountId: 'acc1', author: 'Selected', date: '2026-09-20T10:00:00Z', body: 'Selected body' };
  const reply1Header = { id: 'rep1', accountId: 'acc1', author: 'Reply 1 Author', date: '2026-09-20T11:00:00Z', snippet: 'Reply 1 snippet' };
  const reply2Header = { id: 'rep2', accountId: 'acc1', author: 'Reply 2 Author', date: '2026-09-20T12:00:00Z', snippet: 'Reply 2 snippet' };

  const fullBodies = {
    rep1: { id: 'rep1', accountId: 'acc1', body: 'Full body 1', attachments: [{ id: 'att-1', filename: 'file1.png' }] },
    rep2: { id: 'rep2', accountId: 'acc1', body: 'Full body 2', attachments: [{ id: 'att-2', filename: 'file2.pdf' }] }
  };

  const view = createConversationView({
    api: async (path, options) => {
      if (path === '/api/mail/conversation') {
        return { messages: [selectedMsg, reply1Header, reply2Header], complete: true, nextCursor: null, errors: [] };
      }
      if (path === '/api/mail/message') {
        return { message: fullBodies[options.body.id] };
      }
      return {};
    },
    openCompose: args => composeCalls.push(args),
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  // Initially, replies are collapsed
  const rep1Card = container.querySelector('[data-message-id="rep1"]');
  const rep2Card = container.querySelector('[data-message-id="rep2"]');
  assert.ok(rep1Card);
  assert.ok(rep2Card);
  assert.ok(rep1Card.classList.contains('collapsed'));
  assert.ok(rep2Card.classList.contains('collapsed'));

  // Expand reply 1
  rep1Card.querySelector('.mail-conversation-entry-header').click();
  await nextTurn();
  assert.ok(rep1Card.classList.contains('expanded'));
  assert.equal(rep1Card.querySelector('.mail-conversation-entry-header').getAttribute('aria-expanded'), 'true');

  // Expand reply 2
  rep2Card.querySelector('.mail-conversation-entry-header').click();
  await nextTurn();
  assert.ok(rep2Card.classList.contains('expanded'));
  assert.equal(rep2Card.querySelector('.mail-conversation-entry-header').getAttribute('aria-expanded'), 'true');

  // Assert 3 distinct rich view instances and 3 distinct attachment view instances
  assert.equal(richInstances.length, 3);
  assert.notEqual(richInstances[0], richInstances[1]);
  assert.notEqual(richInstances[1], richInstances[2]);

  assert.equal(attInstances.length, 3);
  assert.notEqual(attInstances[0], attInstances[1]);
  assert.notEqual(attInstances[1], attInstances[2]);

  // Assert their host DOM elements are distinct nodes
  const host0 = richInstances[0].renderedHosts[0];
  const host1 = richInstances[1].renderedHosts[0];
  const host2 = richInstances[2].renderedHosts[0];
  assert.notEqual(host0, host1);
  assert.notEqual(host1, host2);

  // Test independent action buttons on reply 1 and reply 2
  const rep1ReplyAllBtn = rep1Card.querySelector('.mail-conversation-actions').querySelectorAll('button')[1];
  assert.equal(rep1ReplyAllBtn.textContent, 'Reply all');
  rep1ReplyAllBtn.click();
  assert.equal(composeCalls.at(-1).anchor, rep1Card.querySelector('.mail-conversation-reply-host'));
  assert.deepEqual({...composeCalls.at(-1), anchor: undefined}, { mode: 'replyAll', id: 'rep1', accountId: 'acc1', anchor: undefined });

  const rep2ForwardBtn = rep2Card.querySelector('.mail-conversation-actions').querySelectorAll('button')[2];
  assert.equal(rep2ForwardBtn.textContent, 'Forward');
  rep2ForwardBtn.click();
  assert.deepEqual(composeCalls.at(-1), { mode: 'forward', id: 'rep2', accountId: 'acc1' });

  view.reset();
});

test('late entry and conversation completion after reset or account switch are discarded', async t => {
  setupDom(t);
  const container = document.createElement('div');

  let resolveConv;
  const convPromise = new Promise(r => resolveConv = r);
  let resolveEntry;
  const entryPromise = new Promise(r => resolveEntry = r);

  const { richViewFactory, attachmentsViewFactory } = createTrackingFactories();

  const msgAccountA = { id: 'msg-A', accountId: 'acc-A', author: 'User A', date: '2026-09-20T10:00:00Z', body: 'Body A' };
  const msgAccountB = { id: 'msg-B', accountId: 'acc-B', author: 'User B', date: '2026-09-20T10:00:00Z', body: 'Body B' };
  const replyAccountA = { id: 'rep-A', accountId: 'acc-A', author: 'Rep A', date: '2026-09-20T11:00:00Z' };

  const view = createConversationView({
    api: async (path, options) => {
      if (path === '/api/mail/conversation') {
        if (options.body.id === 'msg-A') return convPromise;
        return { messages: [msgAccountB], complete: true, nextCursor: null, errors: [] };
      }
      if (path === '/api/mail/message') {
        return entryPromise;
      }
      return {};
    },
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  // Start loading conversation for msgAccountA
  view.render(container, msgAccountA, { threaded: true });
  // Call reset while request is in flight
  view.reset();

  // Resolve delayed conversation response
  resolveConv({ messages: [msgAccountA, replyAccountA], complete: true, nextCursor: null, errors: [] });
  await nextTurn();

  // Verify container remains clean and no entries were added after reset
  assert.equal(container.children.length, 0);

  // Now test account switch while entry load is in flight
  const immediateConv = { messages: [msgAccountA, replyAccountA], complete: true, nextCursor: null, errors: [] };

  const view2 = createConversationView({
    api: async (path, options) => {
      if (path === '/api/mail/conversation') {
        if (options.body.id === 'msg-A') return immediateConv;
        return { messages: [msgAccountB], complete: true, nextCursor: null, errors: [] };
      }
      if (path === '/api/mail/message') {
        return entryPromise;
      }
      return {};
    },
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view2.reset(); } catch {}
  });

  view2.render(container, msgAccountA, { threaded: true });
  await nextTurn();

  // Expand rep-A to start in-flight entry fetch
  const repACard = container.querySelector('[data-message-id="rep-A"]');
  assert.ok(repACard);
  repACard.querySelector('.mail-conversation-entry-header').click();
  await nextTurn();

  // Switch to account B before rep-A resolves!
  view2.render(container, msgAccountB, { threaded: true });
  await nextTurn();

  // Now resolve late rep-A
  resolveEntry({ message: { id: 'rep-A', accountId: 'acc-A', body: 'Secret Account A Data' } });
  await nextTurn();

  // Container must only show msg-B and must NOT contain any 'rep-A' or 'Secret Account A Data'
  assert.equal(container.querySelector('[data-message-id="rep-A"]'), null);
  assert.equal(container.textContent.includes('Secret Account A Data'), false);

  view2.reset();
});

test('toggling threaded false disposes nonselected entries and preserves selected host', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const { richViewFactory, attachmentsViewFactory } = createTrackingFactories();

  const selectedMsg = { id: 'm-sel', accountId: 'acc1', author: 'Selected', date: '2026-09-20T10:00:00Z', body: 'Selected body' };
  const precedingMsg = { id: 'm-pre', accountId: 'acc1', author: 'Preceding', date: '2026-09-20T09:00:00Z', snippet: 'Pre' };
  const followingMsg = { id: 'm-fol', accountId: 'acc1', author: 'Following', date: '2026-09-20T11:00:00Z', snippet: 'Fol' };

  const view = createConversationView({
    api: async path => {
      if (path === '/api/mail/conversation') {
        return {
          messages: [precedingMsg, selectedMsg, followingMsg],
          complete: true,
          nextCursor: null,
          errors: []
        };
      }
      return {};
    },
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  // Start with threaded: true
  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  assert.equal(container.querySelectorAll('.mail-conversation-entry').length, 3);
  const selCard = container.querySelector('[data-message-id="m-sel"]');
  assert.ok(selCard);
  const selRichHost = selCard.querySelector('.mail-conversation-rich-host');
  const controls = container.querySelector('.mail-conversation-controls');
  assert.equal(controls.hidden, false);

  // Toggle threaded to false
  view.render(container, selectedMsg, { threaded: false });
  await nextTurn();

  // Nonselected entries must be disposed from DOM
  assert.equal(container.querySelectorAll('.mail-conversation-entry').length, 1);
  assert.equal(container.querySelector('[data-message-id="m-pre"]'), null);
  assert.equal(container.querySelector('[data-message-id="m-fol"]'), null);

  // Selected entry card and richHost are preserved
  const remainingCard = container.querySelector('.mail-conversation-entry');
  assert.equal(remainingCard, selCard);
  assert.equal(remainingCard.querySelector('.mail-conversation-rich-host'), selRichHost);

  // Controls are hidden
  assert.equal(controls.hidden, true);

  // Selected header is hidden in nonthreaded mode
  assert.equal(selCard.querySelector('.mail-conversation-entry-header').hidden, true);

  // Toggle threaded back to true -> reloads safely
  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  assert.equal(container.querySelectorAll('.mail-conversation-entry').length, 3);
  // Selected entry card is STILL the same DOM node
  assert.equal(container.querySelector('[data-message-id="m-sel"]'), selCard);
  assert.equal(controls.hidden, false);
  assert.equal(selCard.querySelector('.mail-conversation-entry-header').hidden, false);

  // Verify order: preceding before selected, following after selected
  const entriesAfter = container.querySelectorAll('.mail-conversation-entry');
  assert.equal(entriesAfter[0].dataset.messageId, 'm-pre');
  assert.equal(entriesAfter[1].dataset.messageId, 'm-sel');
  assert.equal(entriesAfter[2].dataset.messageId, 'm-fol');

  view.reset();
});

test('failure retry and user cancellation', async t => {
  setupDom(t);
  const container = document.createElement('div');
  const apiCalls = [];

  let failConversation = false;
  let failEntry = false;
  let delayConv = false;

  const { richViewFactory, attachmentsViewFactory } = createTrackingFactories();

  const selectedMsg = { id: 'sel', accountId: 'acc1', author: 'Selected', date: '2026-09-20T10:00:00Z', body: 'Body' };
  const replyMsg = { id: 'rep', accountId: 'acc1', author: 'Reply', date: '2026-09-20T11:00:00Z', snippet: 'Snippet' };

  const view = createConversationView({
    api: async (path, options) => {
      apiCalls.push({ path, options });
      if (path === '/api/mail/conversation') {
        if (delayConv) {
          return new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
          });
        }
        if (failConversation) {
          throw new Error('Network timeout on conversation');
        }
        return { messages: [selectedMsg, replyMsg], complete: true, nextCursor: null, errors: [] };
      }
      if (path === '/api/mail/message') {
        if (failEntry) {
          throw new Error('500 Internal Server Error');
        }
        return { message: { id: 'rep', accountId: 'acc1', body: 'Fetched reply body' } };
      }
      return {};
    },
    describeError: err => err.message,
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  // 1. In-flight conversation cancellation
  delayConv = true;
  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  const cancelBtn = container.querySelector('.mail-conv-cancel');
  assert.ok(cancelBtn, 'Cancel button is visible during in-flight conversation load');
  cancelBtn.click();
  await nextTurn();

  // Status must show cancelled and offer Retry button
  assert.match(container.querySelector('.mail-conversation-controls').textContent, /cancelled/i);
  const retryBtn1 = container.querySelector('.mail-conv-retry');
  assert.ok(retryBtn1, 'Retry button offered after cancellation');

  // 2. Click Retry, but simulate transient error
  delayConv = false;
  failConversation = true;
  retryBtn1.click();
  await nextTurn();

  const errorAlert = container.querySelector('[role="alert"]');
  assert.ok(errorAlert, 'Error alert rendered on transient failure');
  assert.match(errorAlert.textContent, /Network timeout/);
  const retryBtn2 = container.querySelector('.mail-conv-retry');
  assert.ok(retryBtn2, 'Retry button offered on transient error');

  // Retry succeeds
  failConversation = false;
  retryBtn2.click();
  await nextTurn();

  assert.equal(container.querySelectorAll('.mail-conversation-entry').length, 2);

  // 3. Entry fetch failure with Retry (no silent collapse!)
  const repCard = container.querySelector('[data-message-id="rep"]');
  assert.ok(repCard);
  failEntry = true;
  repCard.querySelector('.mail-conversation-entry-header').click();
  await nextTurn();

  // Must REMAIN expanded!
  assert.ok(repCard.classList.contains('expanded'));
  assert.equal(repCard.querySelector('.mail-conversation-entry-header').getAttribute('aria-expanded'), 'true');
  const entryError = repCard.querySelector('[role="alert"]');
  assert.ok(entryError);
  assert.match(entryError.textContent, /500 Internal Server Error/);
  const entryRetry = repCard.querySelector('.mail-conv-retry');
  assert.ok(entryRetry);
  assert.equal(entryRetry.textContent, 'Retry');

  // Retry entry fetch
  failEntry = false;
  entryRetry.click();
  await nextTurn();

  assert.match(repCard.textContent, /Fetched reply body/);

  view.reset();
});

test('repeated parent render preserves selected entry host and DOM nodes', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const { richViewFactory, attachmentsViewFactory, richInstances, attInstances } = createTrackingFactories();

  const selectedMsg = {
    id: 'm-stable',
    accountId: 'acc1',
    author: 'Author One',
    subject: 'Subject One',
    snippet: 'Initial snippet',
    date: '2026-09-20T10:00:00Z',
    body: 'Stable body',
    attachments: [{ id: 'att-1', filename: 'report.pdf', size: 1024 }]
  };

  const view = createConversationView({
    api: async () => ({
      messages: [selectedMsg],
      complete: true,
      nextCursor: null,
      errors: []
    }),
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  const initialEntry = container.querySelector('[data-message-id="m-stable"]');
  assert.ok(initialEntry);
  const initialRichHost = initialEntry.querySelector('.mail-conversation-rich-host');
  const initialAttHost = initialEntry.querySelector('.mail-conversation-attachments-host');

  assert.equal(richInstances.length, 1);
  assert.equal(attInstances.length, 1);
  assert.equal(richInstances[0].resetCalls, 0);
  assert.equal(attInstances[0].resetCalls, 0);

  // Repeated parent render with updated metadata (e.g. read/starred/tags/snippet changed)
  const updatedMsg = {
    ...selectedMsg,
    unread: false,
    starred: true,
    snippet: 'Updated snippet after read'
  };

  view.render(container, updatedMsg, { threaded: true });
  await nextTurn();

  const currentEntry = container.querySelector('[data-message-id="m-stable"]');
  const currentRichHost = currentEntry.querySelector('.mail-conversation-rich-host');
  const currentAttHost = currentEntry.querySelector('.mail-conversation-attachments-host');

  // Strict identity preservation: same DOM instances!
  assert.equal(currentEntry, initialEntry, 'Selected entry node must be preserved');
  assert.equal(currentRichHost, initialRichHost, 'Rich host node must be preserved');
  assert.equal(currentAttHost, initialAttHost, 'Attachments host node must be preserved');

  // Neither richView nor attachmentsView was reset or re-created
  assert.equal(richInstances.length, 1);
  assert.equal(attInstances.length, 1);
  assert.equal(richInstances[0].resetCalls, 0);
  assert.equal(attInstances[0].resetCalls, 0);

  // Metadata in header updated
  assert.match(currentEntry.querySelector('.mail-conversation-snippet').textContent, /Updated snippet after read/);

  view.reset();
  assert.equal(richInstances[0].resetCalls, 1);
  assert.equal(attInstances[0].resetCalls, 1);
});

test('no document or window globals retained after test teardown', () => {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let teardown;
  const mockT = { after: fn => { teardown = fn; } };
  setupDom(mockT);
  assert.ok(globalThis.document);
  assert.ok(globalThis.window);
  teardown();
  assert.equal(globalThis.document, undefined);
  assert.equal(globalThis.window, undefined);
  if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
  if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
});

test('concurrency: in-flight entry read survives pagination or conversation cancel without remaining loading, late removed entry cannot reappear', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const { richViewFactory, attachmentsViewFactory } = createTrackingFactories();

  let resolveEntry1;
  const entry1Promise = new Promise(r => { resolveEntry1 = r; });

  let resolveEntry2;
  const entry2Promise = new Promise(r => { resolveEntry2 = r; });

  const selectedMsg = { id: 'sel-concur', accountId: 'acc1', author: 'Selected Author', date: '2026-09-20T10:00:00Z', body: 'Selected body' };
  const rep1 = { id: 'rep-concur-1', accountId: 'acc1', author: 'Reply 1', date: '2026-09-20T11:00:00Z', snippet: 'Rep 1 snippet' };
  const rep2 = { id: 'rep-concur-2', accountId: 'acc1', author: 'Reply 2', date: '2026-09-20T12:00:00Z', snippet: 'Rep 2 snippet' };
  const rep3 = { id: 'rep-concur-3', accountId: 'acc1', author: 'Reply 3', date: '2026-09-20T13:00:00Z', snippet: 'Rep 3 snippet' };

  let convCallCount = 0;
  let delayConvPage = false;

  const view = createConversationView({
    api: async (path, options) => {
      if (path === '/api/mail/conversation') {
        convCallCount++;
        if (!options.body.cursor) {
          return {
            messages: [selectedMsg, rep1, rep2],
            complete: false,
            nextCursor: 'cursor-page-2',
            errors: []
          };
        }
        if (delayConvPage) {
          return new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
          });
        }
        return {
          messages: [selectedMsg, rep1, rep2, rep3],
          complete: false,
          nextCursor: 'cursor-page-3',
          errors: []
        };
      }
      if (path === '/api/mail/message') {
        if (options.body.id === 'rep-concur-1') return entry1Promise;
        if (options.body.id === 'rep-concur-2') return entry2Promise;
      }
      return {};
    },
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  // Verify rep1 is collapsed
  const rep1Card = container.querySelector('[data-message-id="rep-concur-1"]');
  assert.ok(rep1Card);

  // 1. Expand rep1 to start deferred entry fetch
  rep1Card.querySelector('.mail-conversation-entry-header').click();
  await nextTurn();

  // Verify rep1 shows loading state
  assert.ok(rep1Card.querySelector('.mail-conv-loading'));

  // 2. While rep1 is fetching, user clicks "Load more conversation messages" (pagination)
  const moreBtn = container.querySelector('.mail-conv-more');
  assert.ok(moreBtn);
  moreBtn.click();
  await nextTurn();

  // 3. Now resolve deferred rep1 body AFTER pagination has finished!
  resolveEntry1({
    message: {
      id: 'rep-concur-1',
      accountId: 'acc1',
      body: 'Body of reply 1 loaded successfully'
    }
  });
  await nextTurn();

  // Rep1 MUST NOT remain loading; body MUST be rendered!
  assert.equal(rep1Card.querySelector('.mail-conv-loading'), null, 'Loading indicator must be removed');
  assert.match(rep1Card.textContent, /Body of reply 1 loaded successfully/);

  // 4. Now test cancellation: expand rep2, set delayConvPage=true, click new Load more to start pending request before Cancel
  const rep2Card = container.querySelector('[data-message-id="rep-concur-2"]');
  assert.ok(rep2Card);

  // Start in-flight fetch for rep2
  rep2Card.querySelector('.mail-conversation-entry-header').click();
  await nextTurn();
  assert.ok(rep2Card.querySelector('.mail-conv-loading'));

  // Start pending conversation request via new Load more button
  delayConvPage = true;
  const moreBtn2 = container.querySelector('.mail-conv-more');
  assert.ok(moreBtn2, 'Load more button present for next page');
  moreBtn2.click();
  await nextTurn();

  // Assert request count
  assert.equal(convCallCount, 3, 'Exactly 3 conversation page requests made');

  const cancelBtn = container.querySelector('.mail-conv-cancel');
  assert.ok(cancelBtn, 'Cancel button present while conversation load is pending');
  cancelBtn.click();
  await nextTurn();

  // Now resolve deferred rep2 body AFTER conversation cancel!
  resolveEntry2({
    message: {
      id: 'rep-concur-2',
      accountId: 'acc1',
      body: 'Body of reply 2 after conv cancel'
    }
  });
  await nextTurn();

  // Rep2 MUST NOT remain loading; body MUST be rendered!
  assert.equal(rep2Card.querySelector('.mail-conv-loading'), null, 'Loading indicator must be removed from rep2');
  assert.match(rep2Card.textContent, /Body of reply 2 after conv cancel/);

  view.reset();

  // 5. Test collapsed and disposed entry late body completions
  let orphanResolver;
  let disposedResolver;
  const orphanHeader = { id: 'rep-orphan', accountId: 'acc1', author: 'Orphan', date: '2026-09-20T14:00:00Z' };
  const disposedHeader = { id: 'rep-disposed', accountId: 'acc1', author: 'Disposed', date: '2026-09-20T15:00:00Z' };

  const orphanView = createConversationView({
    api: async (path, options) => {
      if (path === '/api/mail/conversation') {
        return {
          messages: [selectedMsg, orphanHeader, disposedHeader],
          complete: true,
          nextCursor: null,
          errors: []
        };
      }
      if (path === '/api/mail/message') {
        if (options.body.id === 'rep-orphan') {
          return new Promise(r => { orphanResolver = r; });
        }
        if (options.body.id === 'rep-disposed') {
          return new Promise(r => { disposedResolver = r; });
        }
      }
      return {};
    },
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { orphanView.reset(); } catch {}
  });

  orphanView.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  // 5a. Collapse pending late completion test
  const orphanEl = container.querySelector('[data-message-id="rep-orphan"]');
  assert.ok(orphanEl);
  orphanEl.querySelector('.mail-conversation-entry-header').click();
  await nextTurn();

  // Now collapse (toggle off) orphan while read is in flight
  orphanEl.querySelector('.mail-conversation-entry-header').click();
  await nextTurn();

  // Now resolve late body
  orphanResolver({ message: { id: 'rep-orphan', accountId: 'acc1', body: 'Late ghost body' } });
  await nextTurn();

  // Late body must NOT be visible or re-opened!
  assert.ok(orphanEl.classList.contains('collapsed'));
  assert.equal(orphanEl.textContent.includes('Late ghost body'), false);

  // 5b. Actual disposed entry late body test via threaded: false
  const disposedEl = container.querySelector('[data-message-id="rep-disposed"]');
  assert.ok(disposedEl);
  disposedEl.querySelector('.mail-conversation-entry-header').click();
  await nextTurn();
  assert.ok(disposedEl.querySelector('.mail-conv-loading'));

  // Dispose nonselected entry by turning threaded off
  orphanView.render(container, selectedMsg, { threaded: false });
  await nextTurn();

  // Disposed entry must be removed from DOM
  assert.equal(container.querySelector('[data-message-id="rep-disposed"]'), null);

  // Resolve late body for disposed entry
  disposedResolver({ message: { id: 'rep-disposed', accountId: 'acc1', body: 'Disposed late ghost body' } });
  await nextTurn();

  // Disposed entry must NOT reappear in DOM and its body must not be visible
  assert.equal(container.querySelector('[data-message-id="rep-disposed"]'), null);
  assert.equal(container.textContent.includes('Disposed late ghost body'), false);

  orphanView.reset();
});

test('malformed response basics surface error and retry rather than false complete', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const { richViewFactory, attachmentsViewFactory } = createTrackingFactories();

  let responseToReturn = null;
  let callCount = 0;

  const selectedMsg = { id: 'sel-malformed', accountId: 'acc1', author: 'Author', date: '2026-09-20T10:00:00Z', body: 'Body' };

  const view = createConversationView({
    api: async () => {
      callCount++;
      return responseToReturn;
    },
    describeError: err => `CustomError: ${err.message}`,
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  // 1. Non-object response (null)
  responseToReturn = null;
  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  assert.equal(container.querySelector('.mail-conv-complete'), null);
  const errorAlert1 = container.querySelector('[role="alert"]');
  assert.ok(errorAlert1, 'Error alert rendered for null response');
  assert.match(errorAlert1.textContent, /CustomError/);
  const retryBtn1 = container.querySelector('.mail-conv-retry');
  assert.ok(retryBtn1, 'Retry button offered for malformed response');

  // 2. Response with missing messages array
  responseToReturn = { complete: true, nextCursor: null };
  retryBtn1.click();
  await nextTurn();

  assert.equal(container.querySelector('.mail-conv-complete'), null);
  const errorAlert2 = container.querySelector('[role="alert"]');
  assert.ok(errorAlert2, 'Error alert rendered for missing messages array');
  const retryBtn2 = container.querySelector('.mail-conv-retry');
  assert.ok(retryBtn2);

  // 3. Response with non-boolean complete
  responseToReturn = { messages: [selectedMsg], complete: 'yes', nextCursor: null };
  retryBtn2.click();
  await nextTurn();

  assert.equal(container.querySelector('.mail-conv-complete'), null);
  const errorAlert3 = container.querySelector('[role="alert"]');
  assert.ok(errorAlert3, 'Error alert rendered for non-boolean complete');
  const retryBtn3 = container.querySelector('.mail-conv-retry');
  assert.ok(retryBtn3);

  // 4. Response with invalid nextCursor (number)
  responseToReturn = { messages: [selectedMsg], complete: true, nextCursor: 12345 };
  retryBtn3.click();
  await nextTurn();

  assert.equal(container.querySelector('.mail-conv-complete'), null);
  const errorAlert4 = container.querySelector('[role="alert"]');
  assert.ok(errorAlert4, 'Error alert rendered for non-string cursor');
  const retryBtn4 = container.querySelector('.mail-conv-retry');
  assert.ok(retryBtn4);

  // 5. Valid response succeeds on retry
  responseToReturn = { messages: [selectedMsg], complete: true, nextCursor: null, errors: [] };
  retryBtn4.click();
  await nextTurn();

  assert.ok(container.querySelector('.mail-conv-complete'), 'Complete note rendered after valid response');
  assert.equal(container.querySelector('[role="alert"]'), null);

  view.reset();
});

test('duplicate and mixed account filtering produces partial results state rather than claiming complete', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const { richViewFactory, attachmentsViewFactory } = createTrackingFactories();

  const selectedMsg = { id: 'sel-mix', accountId: 'acc-main', author: 'Main User', date: '2026-09-20T10:00:00Z', body: 'Body' };
  const validReply = { id: 'rep-mix-1', accountId: 'acc-main', author: 'Valid User', date: '2026-09-20T11:00:00Z', snippet: 'Valid' };
  const foreignReply = { id: 'rep-foreign', accountId: 'acc-foreign', author: 'Foreign User', date: '2026-09-20T12:00:00Z', snippet: 'Foreign' };
  const duplicateReply = { id: 'rep-mix-1', accountId: 'acc-main', author: 'Valid User', date: '2026-09-20T11:00:00Z', snippet: 'Duplicate' };

  const view = createConversationView({
    api: async () => ({
      messages: [selectedMsg, validReply, foreignReply, duplicateReply],
      complete: true, // Backend claims complete, but has filtered/foreign messages!
      nextCursor: null,
      errors: []
    }),
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  // Foreign reply must NOT be in DOM
  assert.equal(container.querySelector('[data-message-id="rep-foreign"]'), null);

  // Duplicate reply must appear only once
  assert.equal(container.querySelectorAll('[data-message-id="rep-mix-1"]').length, 1);

  // View must NOT claim complete: true!
  assert.equal(container.querySelector('.mail-conv-complete'), null);

  // Partial results note must be displayed
  const partialNote = container.querySelector('.mail-conv-partial');
  assert.ok(partialNote, 'Partial note must be displayed when invalid/filtered messages are present');
  assert.match(partialNote.textContent, /2 messages loaded/);

  // Terminal bounded notice must be displayed since cursor is null
  const terminalNote = container.querySelector('.mail-conv-terminal');
  assert.ok(terminalNote, 'Terminal note must be displayed');

  view.reset();
});

test('selected entry header hidden in nonthreaded mode, visible and toggleable without dead control in threaded mode', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const { richViewFactory, attachmentsViewFactory } = createTrackingFactories();

  const selectedMsg = { id: 'sel-toggle', accountId: 'acc1', author: 'Toggle User', date: '2026-09-20T10:00:00Z', body: 'Toggle body' };

  const view = createConversationView({
    api: async () => ({
      messages: [selectedMsg],
      complete: true,
      nextCursor: null,
      errors: []
    }),
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  // 1. In non-threaded mode: selectedEntry.headerBtn must be hidden
  view.render(container, selectedMsg, { threaded: false });
  await nextTurn();

  const selCard = container.querySelector('[data-message-id="sel-toggle"]');
  assert.ok(selCard);
  const headerBtn = selCard.querySelector('.mail-conversation-entry-header');
  assert.ok(headerBtn);
  assert.equal(headerBtn.hidden, true, 'Header must be hidden in non-threaded mode to prevent duplication');

  // Controls must be hidden in non-threaded mode
  const controls = container.querySelector('.mail-conversation-controls');
  assert.equal(controls.hidden, true);

  // 2. In threaded mode: selectedEntry.headerBtn must be restored
  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  assert.equal(headerBtn.hidden, false, 'Header must be restored in threaded mode');
  assert.equal(controls.hidden, false);

  // 3. Selected header in threaded mode is toggleable (never a dead control!)
  assert.equal(headerBtn.getAttribute('aria-expanded'), 'true');
  assert.ok(selCard.classList.contains('expanded'));
  const bodyEl = selCard.querySelector('.mail-conversation-body');
  assert.equal(bodyEl.hidden, false);

  // Click header to collapse
  headerBtn.click();
  await nextTurn();

  assert.equal(headerBtn.getAttribute('aria-expanded'), 'false');
  assert.ok(selCard.classList.contains('collapsed'));
  assert.equal(bodyEl.hidden, true);

  // Click header again to expand
  headerBtn.click();
  await nextTurn();

  assert.equal(headerBtn.getAttribute('aria-expanded'), 'true');
  assert.ok(selCard.classList.contains('expanded'));
  assert.equal(bodyEl.hidden, false);

  view.reset();
});

test('parent render with unchanged body does not re-render rich view, only actual body change triggers rich render', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const { richViewFactory, attachmentsViewFactory, richInstances } = createTrackingFactories();

  const initialMsg = {
    id: 'sel-body-check',
    accountId: 'acc1',
    author: 'Body Author',
    snippet: 'Snippet 1',
    date: '2026-09-20T10:00:00Z',
    body: 'Stable body content',
    unread: true,
    starred: false
  };

  const view = createConversationView({
    api: async () => ({
      messages: [initialMsg],
      complete: true,
      nextCursor: null,
      errors: []
    }),
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, initialMsg, { threaded: true });
  await nextTurn();

  assert.equal(richInstances.length, 1);
  assert.equal(richInstances[0].renderCalls.length, 1);

  const selCard = container.querySelector('[data-message-id="sel-body-check"]');
  const richHost = selCard.querySelector('.mail-conversation-rich-host');
  const attHost = selCard.querySelector('.mail-conversation-attachments-host');

  // 1. Metadata update with same body: richView.render MUST NOT be called again
  const metaUpdateMsg = {
    ...initialMsg,
    unread: false,
    starred: true,
    snippet: 'Updated snippet'
  };

  view.render(container, metaUpdateMsg, { threaded: true });
  await nextTurn();

  // Assert renderCalls is STILL 1
  assert.equal(richInstances[0].renderCalls.length, 1, 'richView.render must not be called when body is unchanged');

  // Assert node identity and frame preservation
  const currentCard = container.querySelector('[data-message-id="sel-body-check"]');
  assert.equal(currentCard, selCard);
  assert.equal(currentCard.querySelector('.mail-conversation-rich-host'), richHost);
  assert.equal(currentCard.querySelector('.mail-conversation-attachments-host'), attHost);

  // 2. Actual body change: richView.render MUST be called
  const bodyUpdateMsg = {
    ...metaUpdateMsg,
    body: 'Updated new body text'
  };

  view.render(container, bodyUpdateMsg, { threaded: true });
  await nextTurn();

  assert.equal(richInstances[0].renderCalls.length, 2, 'richView.render must be called when body actually changes');
  assert.equal(currentCard, selCard, 'Card node identity preserved');
  assert.equal(currentCard.querySelector('.mail-conversation-rich-host'), richHost, 'Host node preserved');

  view.reset();
});

test('entry fetch supersession: re-expanded entry remains loading when superseded request resolves, resolves new body only', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const { richViewFactory, attachmentsViewFactory } = createTrackingFactories();

  let resolveOld;
  const oldPromise = new Promise(r => { resolveOld = r; });
  let resolveNew;
  const newPromise = new Promise(r => { resolveNew = r; });

  let messageApiCallCount = 0;

  const selectedMsg = { id: 'm-sel-super', accountId: 'acc1', author: 'Selected User', date: '2026-09-20T10:00:00Z', body: 'Selected body' };
  const replyHeader = { id: 'm-rep-super', accountId: 'acc1', author: 'Reply User', date: '2026-09-20T11:00:00Z', snippet: 'Reply snippet' };

  const view = createConversationView({
    api: async (path, options) => {
      if (path === '/api/mail/conversation') {
        return {
          messages: [selectedMsg, replyHeader],
          complete: true,
          nextCursor: null,
          errors: []
        };
      }
      if (path === '/api/mail/message') {
        messageApiCallCount++;
        if (messageApiCallCount === 1) {
          return oldPromise;
        }
        if (messageApiCallCount === 2) {
          return newPromise;
        }
      }
      return {};
    },
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  const repCard = container.querySelector('[data-message-id="m-rep-super"]');
  assert.ok(repCard);
  const headerBtn = repCard.querySelector('.mail-conversation-entry-header');

  // 1. Expand deferred old
  headerBtn.click();
  await nextTurn();
  assert.equal(messageApiCallCount, 1);
  assert.ok(repCard.querySelector('.mail-conv-loading'));

  // 2. Collapse
  headerBtn.click();
  await nextTurn();
  assert.ok(repCard.classList.contains('collapsed'));

  // 3. Re-expand deferred new
  headerBtn.click();
  await nextTurn();
  assert.equal(messageApiCallCount, 2);
  assert.ok(repCard.querySelector('.mail-conv-loading'));

  // 4. Resolve old: new still loading + exactly two api requests
  resolveOld({
    message: {
      id: 'm-rep-super',
      accountId: 'acc1',
      body: 'Old superseded message body'
    }
  });
  await nextTurn();

  assert.ok(repCard.querySelector('.mail-conv-loading'), 'New request must still be loading');
  assert.equal(messageApiCallCount, 2, 'Must have exactly two api requests');
  assert.equal(repCard.textContent.includes('Old superseded message body'), false);

  // 5. Resolve new displays new body only
  resolveNew({
    message: {
      id: 'm-rep-super',
      accountId: 'acc1',
      body: 'New active message body'
    }
  });
  await nextTurn();

  assert.equal(repCard.querySelector('.mail-conv-loading'), null, 'Loading indicator must be removed');
  assert.match(repCard.textContent, /New active message body/);
  assert.equal(repCard.textContent.includes('Old superseded message body'), false);

  // Cleanup all promises finally
  view.reset();
});

test('collapse selected then turn threads off: same host connected, body visible, and no extra fetch/render', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const { richViewFactory, attachmentsViewFactory, richInstances, attInstances } = createTrackingFactories();

  let apiCallsCount = 0;
  const selectedMsg = {
    id: 'm-sel-col-off',
    accountId: 'acc1',
    author: 'Author Collapse',
    date: '2026-09-20T10:00:00Z',
    body: 'Selected collapse body text'
  };

  const view = createConversationView({
    api: async path => {
      apiCallsCount++;
      if (path === '/api/mail/conversation') {
        return {
          messages: [selectedMsg],
          complete: true,
          nextCursor: null,
          errors: []
        };
      }
      return {};
    },
    richViewFactory,
    attachmentsViewFactory
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  // Initial render in threaded mode
  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  const selCard = container.querySelector('[data-message-id="m-sel-col-off"]');
  assert.ok(selCard);
  const headerBtn = selCard.querySelector('.mail-conversation-entry-header');
  const bodyEl = selCard.querySelector('.mail-conversation-body');
  const richHost = selCard.querySelector('.mail-conversation-rich-host');
  const attHost = selCard.querySelector('.mail-conversation-attachments-host');

  assert.equal(selCard.classList.contains('expanded'), true);
  assert.equal(bodyEl.hidden, false);

  const initialApiCalls = apiCallsCount;
  const initialRichRenderCalls = richInstances[0].renderCalls.length;
  const initialAttRenderCalls = attInstances[0].renderCalls.length;

  // 1. Collapse selected entry
  headerBtn.click();
  await nextTurn();

  assert.equal(selCard.classList.contains('collapsed'), true);
  assert.equal(bodyEl.hidden, true);
  assert.equal(headerBtn.getAttribute('aria-expanded'), 'false');

  // 2. Turn threads off
  view.render(container, selectedMsg, { threaded: false });
  await nextTurn();

  // Same host connected
  assert.equal(selCard.querySelector('.mail-conversation-rich-host'), richHost);
  assert.equal(selCard.querySelector('.mail-conversation-attachments-host'), attHost);
  assert.ok(container.contains(richHost));
  assert.ok(container.contains(attHost));

  // Body visible and expanded
  assert.equal(bodyEl.hidden, false, 'bodyEl hidden must be false');
  assert.equal(selCard.classList.contains('expanded'), true, 'card must have expanded class');
  assert.equal(selCard.classList.contains('current'), true, 'card must have current class');
  assert.equal(headerBtn.getAttribute('aria-expanded'), 'true', 'header aria-expanded must be true');
  assert.equal(headerBtn.hidden, true, 'headerBtn must be hidden in non-threaded mode');

  // No extra fetch/render
  assert.equal(apiCallsCount, initialApiCalls, 'no extra API fetch');
  assert.equal(richInstances[0].renderCalls.length, initialRichRenderCalls, 'no extra rich view render');
  assert.equal(attInstances[0].renderCalls.length, initialAttRenderCalls, 'no extra attachments view render');

  view.reset();
});

test('selected and expanded nonselected Reply/Reply all pass stable per-entry anchor and Forward has none', async t => {
  setupDom(t);
  const container = document.createElement('div');
  const composeCalls = [];

  const selectedMsg = {
    id: 'msg-sel',
    accountId: 'acc-1',
    author: 'Alice',
    date: '2026-09-20T10:00:00Z',
    body: 'Selected text'
  };
  const nonselectedMsg = {
    id: 'msg-non',
    accountId: 'acc-1',
    author: 'Bob',
    date: '2026-09-20T11:00:00Z',
    snippet: 'Bob snippet',
    body: 'Bob full text'
  };

  const view = createConversationView({
    ...createTrackingFactories(),
    api: async (path, options) => {
      if (path === '/api/mail/conversation') {
        return {
          messages: [selectedMsg, nonselectedMsg],
          complete: true,
          nextCursor: null,
          errors: []
        };
      }
      if (path === '/api/mail/message') {
        return { message: nonselectedMsg };
      }
      return {};
    },
    openCompose: opts => composeCalls.push(opts)
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  const selCard = container.querySelector('[data-message-id="msg-sel"]');
  assert.ok(selCard);
  const selActions = selCard.querySelector('.mail-conversation-actions');
  const selReplyHost = selCard.querySelector('.mail-conversation-reply-host');
  assert.ok(selReplyHost, 'selected entry must have replyHost');
  assert.equal(selActions.nextSibling, selReplyHost, 'replyHost must be sibling directly after actionsEl');

  const [selReplyBtn, selReplyAllBtn, selForwardBtn] = selActions.querySelectorAll('button');
  selReplyBtn.click();
  assert.deepEqual(composeCalls.at(-1), { mode: 'reply', id: 'msg-sel', accountId: 'acc-1', anchor: selReplyHost });

  selReplyAllBtn.click();
  assert.deepEqual(composeCalls.at(-1), { mode: 'replyAll', id: 'msg-sel', accountId: 'acc-1', anchor: selReplyHost });

  selForwardBtn.click();
  assert.deepEqual(composeCalls.at(-1), { mode: 'forward', id: 'msg-sel', accountId: 'acc-1' }, 'Forward must not have anchor');

  // Expand nonselected entry
  const nonCard = container.querySelector('[data-message-id="msg-non"]');
  assert.ok(nonCard);
  const nonHeaderBtn = nonCard.querySelector('.mail-conversation-entry-header');
  nonHeaderBtn.click();
  await nextTurn();

  const nonActions = nonCard.querySelector('.mail-conversation-actions');
  const nonReplyHost = nonCard.querySelector('.mail-conversation-reply-host');
  assert.ok(nonReplyHost, 'nonselected entry must have replyHost');
  assert.notEqual(nonReplyHost, selReplyHost, 'per-entry replyHost must be unique');
  assert.equal(nonActions.nextSibling, nonReplyHost, 'nonselected replyHost must be sibling after actionsEl');

  const [nonReplyBtn, nonReplyAllBtn, nonForwardBtn] = nonActions.querySelectorAll('button');
  nonReplyBtn.click();
  assert.deepEqual(composeCalls.at(-1), { mode: 'reply', id: 'msg-non', accountId: 'acc-1', anchor: nonReplyHost });

  nonReplyAllBtn.click();
  assert.deepEqual(composeCalls.at(-1), { mode: 'replyAll', id: 'msg-non', accountId: 'acc-1', anchor: nonReplyHost });

  nonForwardBtn.click();
  assert.deepEqual(composeCalls.at(-1), { mode: 'forward', id: 'msg-non', accountId: 'acc-1' }, 'Forward must not have anchor');

  view.reset();
});

test('collapse, reset, threaded-off, and removal invoke dock callback BEFORE parent becomes hidden or disconnected', async t => {
  setupDom(t);
  const container = document.createElement('div');
  const dockCalls = [];

  const selectedMsg = {
    id: 'm1',
    accountId: 'acc1',
    author: 'User One',
    date: '2026-09-20T10:00:00Z',
    body: 'Message 1 body'
  };
  const secondMsg = {
    id: 'm2',
    accountId: 'acc1',
    author: 'User Two',
    date: '2026-09-20T11:00:00Z',
    snippet: 'Message 2 snippet',
    body: 'Message 2 body'
  };
  let convMessages = [selectedMsg, secondMsg];
  let nextCursor = null;

  const view = createConversationView({
    ...createTrackingFactories(),
    api: async (path, options) => {
      if (path === '/api/mail/conversation') {
        return {
          messages: convMessages,
          complete: nextCursor === null,
          nextCursor,
          errors: []
        };
      }
      if (path === '/api/mail/message') {
        return { message: options.body.id === 'm3' ? {...thirdMsg, body: 'Third body'} : secondMsg };
      }
      return {};
    },
    dockCompose: anchor => {
      dockCalls.push({
        anchor,
        parent: anchor?.parentNode,
        isHiddenBefore: anchor?.parentNode?.hidden,
        inContainerBefore: container.contains(anchor)
      });
    }
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  const secondCard = container.querySelector('[data-message-id="m2"]');
  assert.ok(secondCard);
  const secondHeader = secondCard.querySelector('.mail-conversation-entry-header');

  // 1. Expand then collapse: verify dockCompose invoked BEFORE bodyEl is hidden
  secondHeader.click();
  await nextTurn();
  const secondReplyHost = secondCard.querySelector('.mail-conversation-reply-host');
  assert.ok(secondReplyHost);
  dockCalls.length = 0;

  secondHeader.click(); // collapse
  assert.equal(dockCalls.length, 1, 'must call dockCompose on collapse');
  assert.equal(dockCalls[0].anchor, secondReplyHost);
  assert.equal(dockCalls[0].isHiddenBefore, false, 'must call dockCompose BEFORE bodyEl becomes hidden');
  assert.equal(dockCalls[0].inContainerBefore, true, 'must be connected in container during dockCompose');

  // 2. Re-expand second entry, then switch threading off
  secondHeader.click();
  await nextTurn();
  dockCalls.length = 0;

  view.render(container, selectedMsg, { threaded: false });
  await nextTurn();

  const threadedOffCall = dockCalls.find(c => c.anchor === secondReplyHost);
  assert.ok(threadedOffCall, 'must dock nonselected entry when threads turned off');
  assert.equal(threadedOffCall.inContainerBefore, true, 'must call dock BEFORE nonselected entry is removed from DOM');

  // 3. Message removal in updateThreadOrder
  dockCalls.length = 0;
  const thirdMsg = {
    id: 'm3',
    accountId: 'acc1',
    author: 'User Three',
    date: '2026-09-20T12:00:00Z',
    snippet: 'Message 3 snippet'
  };
  convMessages = [selectedMsg, secondMsg, thirdMsg];
  nextCursor = 'page-2';
  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  const thirdCard = container.querySelector('[data-message-id="m3"]');
  assert.ok(thirdCard);
  thirdCard.querySelector('.mail-conversation-entry-header').click();
  await nextTurn();
  const thirdReplyHost = thirdCard.querySelector('.mail-conversation-reply-host');
  assert.ok(thirdReplyHost);
  dockCalls.length = 0;

  // Next conversation update removes m3
  convMessages = [selectedMsg, secondMsg];
  nextCursor = null;
  const loadMore = container.querySelectorAll('button').find(button => /Load more/i.test(button.textContent));
  assert.ok(loadMore);
  loadMore.click();
  await nextTurn();

  const removalCall = dockCalls.find(c => c.anchor === thirdReplyHost);
  assert.ok(removalCall, 'must call dockCompose when entry is removed from thread order');
  assert.equal(removalCall.inContainerBefore, true, 'must call dock BEFORE entry card is removed from DOM');

  // 4. Reset invokes dock callback before container is cleared
  dockCalls.length = 0;
  const selCard = container.querySelector('[data-message-id="m1"]');
  const selReplyHost = selCard.querySelector('.mail-conversation-reply-host');
  view.reset();

  const resetCall = dockCalls.find(c => c.anchor === selReplyHost);
  assert.ok(resetCall, 'must call dockCompose on reset');
  assert.equal(resetCall.inContainerBefore, true, 'must call dock BEFORE clearing container on reset');
});

test('metadata updates and actions refresh preserve same anchor without docking or recreation', async t => {
  setupDom(t);
  const container = document.createElement('div');
  const dockCalls = [];

  const selectedMsg = {
    id: 'msg-stable',
    accountId: 'acc1',
    author: 'Stable Author',
    date: '2026-09-20T10:00:00Z',
    snippet: 'Original snippet',
    body: 'Original body text'
  };

  const view = createConversationView({
    ...createTrackingFactories(),
    api: async () => ({ messages: [selectedMsg], complete: true, errors: [] }),
    dockCompose: anchor => dockCalls.push(anchor)
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  view.render(container, selectedMsg, { threaded: true });
  await nextTurn();

  const card = container.querySelector('[data-message-id="msg-stable"]');
  const initialActions = card.querySelector('.mail-conversation-actions');
  const initialReplyHost = card.querySelector('.mail-conversation-reply-host');
  assert.ok(initialReplyHost);

  // Update metadata
  const updatedMsg = {
    ...selectedMsg,
    snippet: 'Updated snippet',
    body: 'Updated body text'
  };
  view.render(container, updatedMsg, { threaded: true });
  await nextTurn();

  const currentReplyHost = card.querySelector('.mail-conversation-reply-host');
  assert.equal(currentReplyHost, initialReplyHost, 'replyHost must remain the exact same element instance');
  assert.equal(card.querySelector('.mail-conversation-actions'), initialActions, 'actionsEl remains same');
  assert.equal(initialActions.nextSibling, currentReplyHost, 'replyHost stays sibling after actions');
  assert.equal(dockCalls.length, 0, 'metadata update must not dock anchor');

  view.reset();
});

test('conversation view works seamlessly when dockCompose callback is absent', async t => {
  setupDom(t);
  const container = document.createElement('div');

  const selectedMsg = {
    id: 'msg-absent',
    accountId: 'acc1',
    author: 'No Dock Author',
    date: '2026-09-20T10:00:00Z',
    body: 'Body text'
  };
  const secondMsg = {
    id: 'msg-absent-2',
    accountId: 'acc1',
    author: 'Second Author',
    date: '2026-09-20T11:00:00Z',
    snippet: 'Second snippet',
    body: 'Second body'
  };

  const view = createConversationView({
    ...createTrackingFactories(),
    api: async (path) => {
      if (path === '/api/mail/conversation') return { messages: [selectedMsg, secondMsg], complete: true, nextCursor: null, errors: [] };
      if (path === '/api/mail/message') return { message: secondMsg };
      return {};
    }
    // dockCompose intentionally omitted
  });
  t.after(() => {
    try { view.reset(); } catch {}
  });

  assert.doesNotThrow(() => {
    view.render(container, selectedMsg, { threaded: true });
  });
  await nextTurn();

  const card2 = container.querySelector('[data-message-id="msg-absent-2"]');
  const header2 = card2.querySelector('.mail-conversation-entry-header');

  assert.doesNotThrow(() => {
    header2.click(); // expand
  });
  await nextTurn();

  assert.doesNotThrow(() => {
    header2.click(); // collapse
  });
  await nextTurn();

  assert.doesNotThrow(() => {
    view.render(container, selectedMsg, { threaded: false }); // threaded off
  });
  await nextTurn();

  assert.doesNotThrow(() => {
    view.reset();
  });
});
