import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foldMailBlockquotes,
  autoSizeMailFrame,
  plainMailBody,
  createRichMailView
} from '../web/mail-content.mjs';

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeNode {
  constructor() {
    this.parentNode = null;
    this.parentElement = null;
    this.childNodes = [];
  }
}

class FakeTextNode extends FakeNode {
  constructor(text = '') {
    super();
    this.nodeType = 3;
    this.nodeValue = String(text);
  }
  get textContent() {
    return this.nodeValue;
  }
  set textContent(val) {
    this.nodeValue = String(val);
  }
}

function* getDescendants(node) {
  for (const child of node.childNodes) {
    if (child.nodeType === 1) {
      yield child;
      yield* getDescendants(child);
    }
  }
}

function matchesSelector(el, selector) {
  if (!el || el.nodeType !== 1) return false;
  const parts = selector.split(',').map(s => s.trim());
  for (const part of parts) {
    if (matchSingle(el, part)) return true;
  }
  return false;
}

function matchSingle(el, sel) {
  if (sel === '*') return true;
  const attrMatch = sel.match(/^([a-zA-Z0-9_-]*)\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/);
  if (attrMatch) {
    const [, tag, attr, val] = attrMatch;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    if (!el.hasAttribute(attr)) return false;
    if (val !== undefined && el.getAttribute(attr) !== val) return false;
    return true;
  }
  const classMatch = sel.match(/^([a-zA-Z0-9_-]*)\.([a-zA-Z0-9_-]+)$/);
  if (classMatch) {
    const [, tag, cls] = classMatch;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    const classes = (el.className || '').split(/\s+/).filter(Boolean);
    return classes.includes(cls);
  }
  return el.tagName === sel.toUpperCase();
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super();
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.className = '';
    this.style = {};
    this.attributes = new Map();
    this._listeners = new Map();
    this.ownerDocument = null;
    this._open = false;
  }

  get children() {
    return this.childNodes.filter(n => n.nodeType === 1);
  }

  get href() { return this.getAttribute('href') ?? ''; }
  set href(value) { this.setAttribute('href', String(value)); }

  get textContent() {
    let res = '';
    for (const child of this.childNodes) {
      res += child.textContent;
    }
    return res;
  }

  set textContent(val) {
    this.replaceChildren();
    if (val !== undefined && val !== null && val !== '') {
      this.appendChild(new FakeTextNode(val));
    }
  }

  get open() {
    return Boolean(this._open);
  }

  set open(val) {
    const prev = Boolean(this._open);
    this._open = Boolean(val);
    if (this._open) {
      this.attributes.set('open', '');
    } else {
      this.attributes.delete('open');
    }
    if (prev !== this._open) {
      this.dispatchEvent(new FakeEvent('toggle', { bubbles: false }));
    }
  }

  get scrollHeight() {
    if (this._customScrollHeight !== undefined) return this._customScrollHeight;
    let h = 200;
    for (const d of getDescendants(this)) {
      if (d.tagName === 'DETAILS') {
        h += d.open ? 300 : 40;
      }
    }
    return h;
  }

  set scrollHeight(v) {
    this._customScrollHeight = v;
  }

  get offsetHeight() {
    return this.scrollHeight;
  }

  getBoundingClientRect() {
    return {
      height: this.scrollHeight,
      width: 800,
      top: 0,
      bottom: this.scrollHeight,
      left: 0,
      right: 800
    };
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
      child.parentElement = null;
    }
    return child;
  }

  insertBefore(newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    const idx = this.childNodes.indexOf(refNode);
    newNode.parentNode = this;
    newNode.parentElement = this;
    if (idx !== -1) {
      this.childNodes.splice(idx, 0, newNode);
    } else {
      this.childNodes.push(newNode);
    }
    return newNode;
  }

  replaceChild(newChild, oldChild) {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx !== -1) {
      if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
      this.childNodes.splice(idx, 1, newChild);
      oldChild.parentNode = null;
      oldChild.parentElement = null;
      newChild.parentNode = this;
      newChild.parentElement = this;
    }
    return oldChild;
  }

  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeTextNode(n) : n;
      this.appendChild(node);
    }
  }

  prepend(...nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const node = typeof n === 'string' ? new FakeTextNode(n) : n;
      this.insertBefore(node, this.childNodes[0] || null);
    }
  }

  replaceChildren(...nodes) {
    while (this.childNodes.length) {
      this.removeChild(this.childNodes[0]);
    }
    this.append(...nodes);
  }

  replaceWith(...nodes) {
    if (!this.parentNode) return;
    const p = this.parentNode;
    const idx = p.childNodes.indexOf(this);
    if (idx !== -1) {
      p.removeChild(this);
      let insertIdx = idx;
      for (const n of nodes) {
        const node = typeof n === 'string' ? new FakeTextNode(n) : n;
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = p;
        node.parentElement = p;
        p.childNodes.splice(insertIdx++, 0, node);
      }
    }
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  after(...nodes) {
    if (!this.parentNode) return;
    const p = this.parentNode;
    const idx = p.childNodes.indexOf(this);
    let ref = p.childNodes[idx + 1] || null;
    for (const n of nodes) {
      const node = typeof n === 'string' ? new FakeTextNode(n) : n;
      p.insertBefore(node, ref);
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  contains(node) {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.nodeType === 1 && matchesSelector(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    for (const desc of getDescendants(this)) {
      if (matchesSelector(desc, selector)) return desc;
    }
    return null;
  }

  querySelectorAll(selector) {
    const result = [];
    for (const desc of getDescendants(this)) {
      if (matchesSelector(desc, selector)) result.push(desc);
    }
    return result;
  }

  getElementsByTagName(tag) {
    const upper = tag.toUpperCase();
    return Array.from(getDescendants(this)).filter(el => upper === '*' || el.tagName === upper);
  }

  addEventListener(type, listener, options) {
    const useCapture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push({ listener, useCapture });
  }

  removeEventListener(type, listener, options) {
    const useCapture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const list = this._listeners.get(type);
    if (!list) return;
    this._listeners.set(type, list.filter(l => l.listener !== listener || l.useCapture !== useCapture));
  }

  dispatchEvent(event) {
    event.target = this;
    const path = [];
    let cur = this;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentNode;
    }
    // Capture phase: root down to parent
    for (let i = 0; i < path.length - 1; i++) {
      const node = path[i];
      event.currentTarget = node;
      const list = (node._listeners?.get(event.type) || []).slice();
      for (const reg of list) {
        if (reg.useCapture) reg.listener.call(node, event);
      }
    }
    // Target phase
    event.currentTarget = this;
    const targetList = (this._listeners?.get(event.type) || []).slice();
    for (const reg of targetList) {
      reg.listener.call(this, event);
    }
    // Bubble phase
    if (event.bubbles) {
      for (let i = path.length - 2; i >= 0; i--) {
        const node = path[i];
        event.currentTarget = node;
        const list = (node._listeners?.get(event.type) || []).slice();
        for (const reg of list) {
          if (!reg.useCapture) reg.listener.call(node, event);
        }
      }
    }
    return !event.defaultPrevented;
  }
}

class FakeIframe extends FakeElement {
  constructor() {
    super('IFRAME');
    this.contentDocument = new FakeDocument();
    this.contentDocument.defaultView = globalThis.window;
  }

  get srcdoc() {
    return this._srcdoc;
  }

  set srcdoc(val) {
    this._srcdoc = val;
    const doc = new FakeDocument();
    doc.defaultView = globalThis.window;
    parseHtmlInto(doc.body, val, doc);
    this.contentDocument = doc;
    this.dispatchEvent(new FakeEvent('load'));
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super('DOCUMENT');
    this.ownerDocument = null;
    this.head = new FakeElement('HEAD');
    this.head.ownerDocument = this;
    this.body = new FakeElement('BODY');
    this.body.ownerDocument = this;
    this.documentElement = new FakeElement('HTML');
    this.documentElement.ownerDocument = this;
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.readyState = 'complete';
  }

  createElement(tag) {
    const lower = tag.toLowerCase();
    const el = lower === 'iframe' ? new FakeIframe() : new FakeElement(tag);
    el.ownerDocument = this;
    return el;
  }

  createElementNS(ns, tag) {
    const el = new FakeElement(tag);
    el.ownerDocument = this;
    return el;
  }
}

function parseHtmlInto(container, html, doc) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const source = bodyMatch ? bodyMatch[1] : html;

  let pos = 0;
  function parseNodes(parent, stopTag = null) {
    while (pos < source.length) {
      if (source.startsWith('</', pos)) {
        const closeMatch = source.slice(pos).match(/^<\/([a-zA-Z0-9-]+)>/i);
        if (closeMatch) {
          const closing = closeMatch[1].toUpperCase();
          if (stopTag && closing === stopTag) {
            pos += closeMatch[0].length;
            return;
          }
          pos += closeMatch[0].length;
          continue;
        }
      }
      if (source[pos] === '<' && !source.startsWith('<!--', pos) && !source.startsWith('</', pos)) {
        const tagMatch = source.slice(pos).match(/^<([a-zA-Z0-9-]+)([^>]*)>/i);
        if (tagMatch) {
          pos += tagMatch[0].length;
          const tagName = tagMatch[1].toUpperCase();
          const attrStr = tagMatch[2];
          const el = doc.createElement(tagName);
          const attrRegex = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
          let am;
          while ((am = attrRegex.exec(attrStr)) !== null) {
            const attrName = am[1].toLowerCase();
            const attrVal = am[2] !== undefined ? am[2] : '';
            if (attrName === 'class') {
              el.className = attrVal;
            } else if (attrName === 'id') {
              el.setAttribute('id', attrVal);
              el.id = attrVal;
            } else {
              el.setAttribute(attrName, attrVal);
            }
          }
          parent.appendChild(el);
          const voidTags = new Set(['IMG', 'BR', 'HR', 'INPUT', 'META', 'LINK']);
          if (!voidTags.has(tagName) && !attrStr.endsWith('/')) {
            parseNodes(el, tagName);
          }
          continue;
        }
      }
      const nextTag = source.indexOf('<', pos);
      const text = nextTag === -1 ? source.slice(pos) : source.slice(pos, nextTag);
      if (text.length > 0) {
        parent.appendChild(new FakeTextNode(text));
        pos += text.length;
      }
    }
  }
  parseNodes(container);
}

function setupGlobalDOM() {
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  const doc = new FakeDocument();
  globalThis.document = doc;
  globalThis.window = {
    addEventListener: (type, listener, options) => doc.addEventListener(type, listener, options),
    removeEventListener: (type, listener, options) => doc.removeEventListener(type, listener, options)
  };
  return () => {
    globalThis.document = prevDocument;
    globalThis.window = prevWindow;
  };
}

test('inaccessible frame document does not break setup, load or cleanup', t => {
  const restoreGlobals = setupGlobalDOM();
  t.after(restoreGlobals);
  const frame = document.createElement('iframe');
  Object.defineProperty(frame, 'contentDocument', {get() { throw new Error('inaccessible frame'); }});
  let cleanup;
  assert.doesNotThrow(() => { cleanup = autoSizeMailFrame(frame); });
  assert.doesNotThrow(() => frame.dispatchEvent(new FakeEvent('load')));
  assert.doesNotThrow(() => cleanup());
});

test('mixed plain prose/quotedgroups/nestedquotes/alltextpreserved/safeURLs/literalHTML', t => {
  const restoreGlobals = setupGlobalDOM();
  t.after(() => {
    restoreGlobals();
  });

  const rawText =
    'Hello Alice,\n' +
    'Here is the status report.\n\n' +
    '> Previous update:\n' +
    '>> Nested discussion item\n' +
    '> Back to quote level 1 with https://example.com/quote-ref\n\n' +
    'Please review https://example.org/review?doc=1&rev=2.\n' +
    'Also note literal HTML: <b>alert</b> & <script>doBad()</script>.\n\n' +
    '> Second quote block\n' +
    '> Another line\n\n' +
    'Best regards,\n' +
    'Bob';

  const container = plainMailBody(rawText);

  // Flow container
  assert.equal(container.tagName, 'DIV', 'plain text with quotes must return a valid flow container (div)');
  assert.equal(container.className, 'rich-mail-text');

  // Quoted groups
  const detailsList = container.querySelectorAll('details.mail-quoted-text');
  assert.equal(detailsList.length, 2, 'must produce exactly 2 quote details groups');

  // Group 1
  const d1 = detailsList[0];
  assert.equal(d1.open, false, 'details must be closed by default');
  const sum1 = d1.querySelector('summary');
  assert.ok(sum1, 'summary element must exist');
  assert.equal(sum1.textContent, 'Show quoted text');
  const pre1 = d1.querySelector('pre');
  assert.ok(pre1, 'pre quote element must exist');
  assert.ok(pre1.textContent.includes('> Previous update:\n'));
  assert.ok(pre1.textContent.includes('>> Nested discussion item\n'), 'nested >> quotes stay together in same quote block');
  assert.ok(pre1.textContent.includes('> Back to quote level 1 with https://example.com/quote-ref'));
  // URL inside quote is linkified
  const linkInQuote = pre1.querySelector('a');
  assert.ok(linkInQuote, 'URL inside quote should be linkified');
  assert.equal(linkInQuote.href, 'https://example.com/quote-ref');
  assert.equal(linkInQuote.target, '_blank');
  assert.equal(linkInQuote.rel, 'noopener noreferrer');

  // Group 2
  const d2 = detailsList[1];
  assert.equal(d2.open, false);
  const pre2 = d2.querySelector('pre');
  assert.ok(pre2.textContent.includes('> Second quote block\n> Another line'));

  // Safe URLs in ordinary prose
  const mainLink = container.querySelector('a[href="https://example.org/review?doc=1&rev=2"]');
  assert.ok(mainLink, 'safe URL in prose must be linkified');
  assert.equal(mainLink.target, '_blank');
  assert.equal(mainLink.rel, 'noopener noreferrer');

  // Literal HTML rendering
  assert.equal(container.querySelector('b'), null, 'HTML <b> must not be parsed as element');
  assert.equal(container.querySelector('script'), null, 'HTML <script> must not be parsed as element');
  assert.ok(container.textContent.includes('<b>alert</b>'), 'literal HTML text must be preserved');
  assert.ok(container.textContent.includes('<script>doBad()</script>'), 'literal script tag text must be preserved');

  // All text preserved: all pre text concatenated matches original rawText
  const allPreText = Array.from(container.querySelectorAll('pre')).map(p => p.textContent).join('');
  assert.equal(allPreText, rawText, 'all original text, newlines, and punctuation must be strictly preserved');
});

test('noquote existingpre', t => {
  const restoreGlobals = setupGlobalDOM();
  t.after(() => {
    restoreGlobals();
  });

  const rawText =
    'This is a plain message.\n' +
    'There are no quotes at all in this message.\n' +
    'Check https://example.com/welcome for more info.';

  const body = plainMailBody(rawText);

  // When no quotes exist, must return a pre element directly to minimize regressions
  assert.equal(body.tagName, 'PRE', 'must return a pre element when there are no quotes');
  assert.equal(body.className, 'rich-mail-text');
  assert.equal(body.querySelectorAll('details').length, 0, 'no details element should exist');

  // Text and linkification preserved
  assert.equal(body.textContent, rawText, 'entire text preserved');
  const link = body.querySelector('a');
  assert.ok(link);
  assert.equal(link.href, 'https://example.com/welcome');
});

test('iframe top-level wrapping exactly once nested quote no doublewrapper, accessible summary and preserved original nodes', t => {
  const doc = new FakeDocument();

  // Setup HTML with top-level blockquote having nested blockquote, plus another top-level quote, plus prose
  const p1 = doc.createElement('p');
  p1.textContent = 'Prose paragraph';
  doc.body.appendChild(p1);

  const bq1 = doc.createElement('blockquote');
  bq1.id = 'bq-outer';
  const pOuter = doc.createElement('p');
  pOuter.textContent = 'Outer quote';
  bq1.appendChild(pOuter);

  const bqNested = doc.createElement('blockquote');
  bqNested.id = 'bq-nested';
  const pNested = doc.createElement('p');
  pNested.textContent = 'Nested quote';
  bqNested.appendChild(pNested);
  bq1.appendChild(bqNested);
  doc.body.appendChild(bq1);

  const p2 = doc.createElement('p');
  p2.textContent = 'Middle prose';
  doc.body.appendChild(p2);

  const bq2 = doc.createElement('blockquote');
  bq2.id = 'bq-second';
  const link = doc.createElement('a');
  link.href = 'https://example.com';
  link.textContent = 'Quote link';
  bq2.appendChild(link);
  doc.body.appendChild(bq2);

  const divSender = doc.createElement('div');
  divSender.textContent = 'Sender footer';
  doc.body.appendChild(divSender);

  foldMailBlockquotes(doc);

  // Exactly two top-level details wrappers
  const detailsList = doc.querySelectorAll('details.mail-quoted-text');
  assert.equal(detailsList.length, 2, 'should create exactly 2 details wrappers for the 2 top-level blockquotes');

  // Details 1 wraps bq1
  const d1 = detailsList[0];
  assert.equal(d1.parentElement, doc.body, 'first details should be child of body');
  assert.equal(d1.open, false, 'details is closed by default');
  const sum1 = d1.querySelector('summary');
  assert.ok(sum1, 'accessible summary must be present');
  assert.equal(sum1.textContent, 'Show quoted text');
  // Original node preserved
  assert.equal(d1.childNodes[1], bq1, 'original bq1 node is preserved and reparented inside details');
  assert.equal(bq1.parentElement, d1);

  // Nested blockquote is NOT wrapped in a details (no doublewrapper)
  assert.equal(bqNested.parentElement, bq1, 'nested blockquote remains child of bq1');
  assert.equal(bqNested.closest('details'), d1, 'closest details of nested blockquote is outer details');
  assert.notEqual(bqNested.parentElement.tagName, 'DETAILS', 'nested blockquote must not be wrapped directly in details');

  // Details 2 wraps bq2
  const d2 = detailsList[1];
  assert.equal(d2.parentElement, doc.body);
  assert.equal(d2.childNodes[1], bq2, 'original bq2 node is preserved');
  assert.equal(bq2.querySelector('a'), link, 'nested link in bq2 is preserved');

  // Non-blockquote nodes are NOT wrapped
  assert.equal(p1.parentElement, doc.body, 'p1 remains child of body');
  assert.equal(p2.parentElement, doc.body, 'p2 remains child of body');
  assert.equal(divSender.parentElement, doc.body, 'sender div remains child of body');

  // Idempotent repeated load handling
  foldMailBlockquotes(doc);
  const detailsListAfter = doc.querySelectorAll('details.mail-quoted-text');
  assert.equal(detailsListAfter.length, 2, 'repeated foldMailBlockquotes should be idempotent and not add wrappers');

  // Bounded at at most 100 wrappers
  const pathDoc = new FakeDocument();
  for (let i = 0; i < 150; i++) {
    const b = pathDoc.createElement('blockquote');
    pathDoc.body.appendChild(b);
  }
  foldMailBlockquotes(pathDoc);
  assert.equal(pathDoc.querySelectorAll('details.mail-quoted-text').length, 100, 'must bound wrappers to at most 100');
});

test('fake toggle measurement increases/decreases and detached/reset cleanup no later updates', t => {
  const restoreGlobals = setupGlobalDOM();
  t.after(() => {
    restoreGlobals();
  });

  const frame = document.createElement('iframe');
  const doc = new FakeDocument();
  frame.contentDocument = doc;

  const bq = doc.createElement('blockquote');
  bq.textContent = 'Quoted text line 1\nQuoted text line 2';
  doc.body.appendChild(bq);

  const cleanup = autoSizeMailFrame(frame);

  const details = doc.querySelector('details.mail-quoted-text');
  assert.ok(details, 'details element should be created');
  assert.equal(details.open, false, 'details should be closed initially');

  const initialHeight = parseInt(frame.style.height, 10);
  assert.ok(Number.isFinite(initialHeight) && initialHeight > 0, 'initial height should be measured');

  // Toggle open
  details.open = true;
  const openHeight = parseInt(frame.style.height, 10);
  assert.ok(openHeight > initialHeight, `height should increase on toggle open (${openHeight} > ${initialHeight})`);

  // Toggle closed
  details.open = false;
  const closedHeight = parseInt(frame.style.height, 10);
  assert.ok(closedHeight < openHeight, `height should decrease on toggle close (${closedHeight} < ${openHeight})`);
  assert.equal(closedHeight, initialHeight, 'height should return to initial height when closed');

  // Cleanup/detach
  cleanup();
  const heightAfterCleanup = frame.style.height;

  // Toggle again after cleanup
  details.open = true;
  assert.equal(frame.style.height, heightAfterCleanup, 'height should not update after cleanup');
});

test('unchanged rich render/frame preserves expanded details state', async t => {
  const restoreGlobals = setupGlobalDOM();
  let view = null;

  // Test cleanup must reset active views BEFORE restoring global document/window (Node t.after order registration)
  t.after(() => {
    view?.reset();
  });
  t.after(() => {
    restoreGlobals();
  });

  const container = document.createElement('div');
  const api = async (url, opts) => {
    if (url === '/api/mail/content') {
      return {
        content: {
          id: 'msg-100',
          html: '<blockquote>First message quote</blockquote>'
        }
      };
    }
  };

  view = createRichMailView({ api });
  view.render(container, { id: 'msg-100' });

  // Wait for async load()
  await new Promise(r => setTimeout(r, 10));

  const frame1 = container.querySelector('iframe');
  assert.ok(frame1, 'iframe should be rendered');
  const details1 = frame1.contentDocument.querySelector('details.mail-quoted-text');
  assert.ok(details1, 'details element should be in iframe document');
  assert.equal(details1.open, false, 'details starts closed');

  // User expands details
  details1.open = true;
  assert.equal(details1.open, true, 'details is now open');

  // Re-render same message with same id and content
  view.render(container, { id: 'msg-100' });

  const frame2 = container.querySelector('iframe');
  assert.equal(frame2, frame1, 'same iframe instance must be preserved on unchanged re-render');
  const details2 = frame2.contentDocument.querySelector('details.mail-quoted-text');
  assert.equal(details2, details1, 'same details node instance preserved');
  assert.equal(details2.open, true, 'expanded details open state preserved across unchanged re-render');
});
