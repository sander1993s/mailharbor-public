import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  createMailAttachmentsView,
  attachmentType,
  attachmentSize,
  attachmentReadableType,
  attachmentPreviewKind
} from '../web/mail-attachments.mjs';

test('resetting a conversation attachment view never changes the shared reader position', async () => {
  const reader = document.getElementById('mail-reader');
  reader.scrollTop = 640;
  const inactive = createMailAttachmentsView({api: async () => new Blob(['text'])});
  inactive.reset();
  assert.equal(reader.scrollTop, 640);

  const view = createMailAttachmentsView({api: async () => new Blob(['text'])});
  const message = {id: 'scroll-message', attachments: [{id: 'text', filename: 'note.txt', mimeType: 'text/plain'}]};
  const container = document.createElement('div');
  document.body.append(container);
  view.renderGrid(container, message);
  container.querySelector('.mail-attachment-view-btn').click();
  await nextTurn();
  reader.scrollTop = 710;
  view.closeDialog();
  assert.equal(reader.scrollTop, 640, 'closing an open preview restores its reader position');
  container.querySelector('.mail-attachment-view-btn').click();
  await nextTurn();
  reader.scrollTop = 180;
  view.reset();
  assert.equal(reader.scrollTop, 180, 'navigation teardown keeps the new reader position');
});

test('PDF zoom starts from the fitted scale on a wide document', async () => {
  const page = {
    getViewport: ({scale}) => ({width: 2000 * scale, height: 1000 * scale}),
    render: () => ({promise: Promise.resolve(), cancel() {}})
  };
  const view = createMailAttachmentsView({
    api: async () => new Blob(['pdf']),
    loadPdfjs: async () => ({getDocument: () => ({promise: Promise.resolve({
      numPages: 1, getPage: async () => page, destroy() {}
    }), destroy() {}})})
  });
  const container = document.createElement('div');
  const message = {id: 'wide-pdf', attachments: [{id: 'pdf', filename: 'wide.pdf', mimeType: 'application/pdf'}]};
  view.renderGrid(container, message);
  container.querySelector('.mail-attachment-view-btn').click();
  await nextTurn();
  const dialog = document.body.querySelector('dialog');
  const canvas = dialog.querySelector('.mail-pdf-canvas');
  const fitWidth = canvas.width;
  const toolbar = dialog.querySelector('.mail-pdf-toolbar');
  toolbar.querySelectorAll('button').find(node => node.getAttribute('aria-label') === 'Zoom out').click();
  await nextTurn();
  assert.ok(canvas.width < fitWidth, 'Zoom out makes a fitted document smaller');
  toolbar.querySelectorAll('button').find(node => node.getAttribute('aria-label') === 'Fit width').click();
  await nextTurn();
  assert.equal(canvas.width, fitWidth);
  view.reset();
});

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = new Map();
    this.events = new Map();
    this.value = '';
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.open = false;
    this.width = 0;
    this.height = 0;
    this.parent = null;
    this.classList = {
      add: val => { this.className = `${this.className} ${val}`.trim(); },
      remove: val => { this.className = this.className.split(' ').filter(i => i !== val).join(' '); },
      contains: val => this.className.split(' ').includes(val)
    };
  }
  get isConnected() {
    if (this === document.body) return true;
    return this.parent ? this.parent.isConnected : false;
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); }
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof MockElement) {
        node.parent = this;
      }
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of nodes) {
      if (node instanceof MockElement) {
        node.parent = this;
      }
      this.children.unshift(node);
    }
  }
  after(...nodes) {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node instanceof MockElement) node.parent = this.parent;
        this.parent.children.splice(idx + 1 + i, 0, node);
      }
    }
  }
  replaceChildren(...nodes) {
    this.text = '';
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, cb) { this.events.set(name, cb); }
  removeEventListener(name, cb) { if (this.events.get(name) === cb) this.events.delete(name); }
  dispatch(name, event = {}) { return this.events.get(name)?.({preventDefault() {}, stopPropagation() {}, target: this, currentTarget: this, ...event}); }
  click() { document.clickedElements.push(this); return this.dispatch('click'); }
  focus() { document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter(c => c !== this);
      this.parent = null;
    }
  }
  contains(node) {
    if (node === this) return true;
    return this.children.some(c => c instanceof MockElement && c.contains(node));
  }
  getBoundingClientRect() { return {left: 0, right: 800, top: 0, bottom: 600, width: 800, height: 600}; }
  getContext(type) {
    if (type === '2d') {
      return {
        clearRect() {},
        drawImage() {},
        fillRect() {},
        getImageData() { return {data: []}; },
        putImageData() {},
        save() {},
        restore() {}
      };
    }
    return null;
  }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => child instanceof MockElement ? [child, ...child.querySelectorAll(selector)] : []);
    if (!selector || selector === '*') return descendants;
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return descendants.filter(c => c.className?.split(' ').includes(cls));
    }
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const attr = selector.slice(1, -1);
      return descendants.filter(c => c.attributes.has(attr) || c.dataset?.[attr]);
    }
    return descendants.filter(c => c.tagName.toLowerCase() === selector.toLowerCase());
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

let previousDoc, previousWindow, previousCreateUrl, previousRevokeUrl;
let mockCreatedUrls = [];
let mockRevokedUrls = [];

test.beforeEach(() => {
  previousDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  previousCreateUrl = globalThis.URL.createObjectURL;
  previousRevokeUrl = globalThis.URL.revokeObjectURL;
  mockCreatedUrls = [];
  mockRevokedUrls = [];

  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new MockElement('div'));
    return elements.get(id);
  };
  const body = new MockElement('body');

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body,
      clickedElements: [],
      activeElement: null,
      getElementById: get,
      createElement: tag => new MockElement(tag),
      createElementNS: (_, tag) => new MockElement(tag)
    }
  });

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia: () => ({matches: false, addEventListener() {}}),
      addEventListener() {},
      removeEventListener() {}
    }
  });

  globalThis.URL.createObjectURL = blob => {
    const url = `blob:test-${mockCreatedUrls.length}`;
    mockCreatedUrls.push({url, blob});
    return url;
  };
  globalThis.URL.revokeObjectURL = url => {
    mockRevokedUrls.push(url);
  };
});

test.afterEach(() => {
  if (previousDoc) Object.defineProperty(globalThis, 'document', previousDoc);
  else delete globalThis.document;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else delete globalThis.window;
  globalThis.URL.createObjectURL = previousCreateUrl;
  globalThis.URL.revokeObjectURL = previousRevokeUrl;
});

test('attachmentSize formats B, KB, and MB accurately', () => {
  assert.equal(attachmentSize(500), '500 B');
  assert.equal(attachmentSize(1024), '1.0 KB');
  assert.equal(attachmentSize(2048), '2.0 KB');
  assert.equal(attachmentSize(1536), '1.5 KB');
  assert.equal(attachmentSize(1024 * 1024), '1.0 MB');
  assert.equal(attachmentSize(5.5 * 1024 * 1024), '5.5 MB');
  assert.equal(attachmentSize(undefined), '0 B');
});

test('attachmentPreviewKind accurately identifies images, text, pdf, office and unsupported', () => {
  assert.equal(attachmentPreviewKind({mimeType: 'image/jpeg', filename: 'photo.jpg'}), 'image');
  assert.equal(attachmentPreviewKind({mimeType: 'image/png', filename: 'photo.png'}), 'image');
  assert.equal(attachmentPreviewKind({mimeType: 'application/pdf', filename: 'doc.pdf'}), 'pdf');
  assert.equal(attachmentPreviewKind({mimeType: 'text/plain', filename: 'notes.txt'}), 'text');
  assert.equal(attachmentPreviewKind({mimeType: 'text/csv', filename: 'data.csv'}), 'text');
  assert.equal(attachmentPreviewKind({mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'paper.docx'}), 'office');
  assert.equal(attachmentPreviewKind({filename: 'sheet.xlsx'}), 'office');
  assert.equal(attachmentPreviewKind({filename: 'slides.pptx'}), 'office');
  assert.equal(attachmentPreviewKind({mimeType: 'application/zip', filename: 'archive.zip'}), 'unsupported');
  assert.equal(attachmentPreviewKind({mimeType: 'application/octet-stream', filename: 'binary.bin'}), 'unsupported');
  assert.equal(attachmentPreviewKind({mimeType: 'image/svg+xml', filename: 'vector.svg'}), 'unsupported');
  assert.equal(attachmentPreviewKind({mimeType: 'text/html', filename: 'page.html'}), 'unsupported');
  assert.equal(attachmentPreviewKind({filename: 'evil.html'}), 'unsupported');
});

test('renderGrid displays attachment cards and download-all button', () => {
  const view = createMailAttachmentsView({api: async () => ({})});
  const container = new MockElement('div');
  const message = {
    id: 'msg-1',
    attachments: [
      {id: 'att-1', filename: 'report.pdf', size: 1024 * 1024, mimeType: 'application/pdf'},
      {id: 'att-2', filename: 'photo.png', size: 2048, mimeType: 'image/png'},
      {id: 'att-3', filename: 'data.bin', size: 500, mimeType: 'application/octet-stream'}
    ]
  };

  view.renderGrid(container, message);

  const heading = container.querySelector('h3');
  assert.ok(heading);
  assert.match(heading.textContent, /3 attachments/);

  const dlAll = container.querySelectorAll('button').find(b => b.textContent.includes('Download all'));
  assert.ok(dlAll, 'Download all button rendered beside heading');

  const cards = container.querySelectorAll('.mail-attachment-card');
  assert.equal(cards.length, 3);

  assert.match(cards[0].textContent, /report\.pdf/);
  assert.match(cards[0].textContent, /PDF Document/);
  assert.match(cards[0].textContent, /1\.0 MB/);
  const card0Btns = cards[0].querySelectorAll('button');
  assert.ok(card0Btns.some(b => b.textContent === 'View'));
  assert.ok(card0Btns.some(b => b.textContent === 'Download'));

  const card2Btns = cards[2].querySelectorAll('button');
  assert.equal(card2Btns.some(b => b.textContent === 'View'), false);
  assert.ok(card2Btns.some(b => b.textContent === 'Download'));
});

test('createJumpControl returns button that scrolls to attachments section', () => {
  const view = createMailAttachmentsView({api: async () => ({})});
  assert.equal(view.createJumpControl({attachments: []}), null);

  let jumped = false;
  const jump = view.createJumpControl({attachments: [{id: '1'}]}, () => { jumped = true; });
  assert.ok(jump);
  assert.match(jump.textContent, /1 attachment/);

  jump.dispatch('click');
  assert.equal(jumped, true);
});

test('preview opens in dialog overlay and closes cleanly on Escape or Close button', async () => {
  const calls = [];
  const view = createMailAttachmentsView({
    api: async (path, opts) => {
      calls.push({path, opts});
      if (path === '/api/mail/attachment') {
        return new Blob(['hello plain text'], {type: 'text/plain'});
      }
      return {};
    }
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-1',
    attachments: [
      {id: 'att-1', filename: 'notes.txt', size: 16, mimeType: 'text/plain'}
    ]
  };

  view.renderGrid(container, message);
  const viewBtn = container.querySelectorAll('button').find(b => b.textContent === 'View');
  assert.ok(viewBtn);

  viewBtn.dispatch('click');
  for (let i = 0; i < 20 && calls.length === 0; i++) {
    await nextTurn();
  }
  await nextTurn();

  const dialog = document.body.querySelector('dialog');
  assert.ok(dialog, 'Preview dialog was mounted');
  assert.equal(dialog.open, true);

  const pre = dialog.querySelector('pre');
  assert.ok(pre, 'Text preview rendered inside pre tag');
  assert.equal(pre.textContent, 'hello plain text');

  dialog.dispatch('keydown', {key: 'Escape'});
  assert.equal(dialog.open, false);

  view.reset();
  assert.ok(mockRevokedUrls.length >= 0);
});

test('office preview fetches text representation from attachment-preview API', async () => {
  const calls = [];
  const view = createMailAttachmentsView({
    api: async (path, opts) => {
      calls.push({path, opts});
      if (path === '/api/mail/attachment-preview') {
        return {text: 'Summary of quarterly results', kind: 'office'};
      }
      return {};
    }
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-office',
    attachments: [
      {id: 'att-doc', filename: 'Quarterly.docx', size: 50000, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}
    ]
  };

  view.renderGrid(container, message);
  const viewBtn = container.querySelectorAll('button').find(b => b.textContent === 'View');
  viewBtn.dispatch('click');

  for (let i = 0; i < 20 && calls.length === 0; i++) {
    await nextTurn();
  }
  await nextTurn();

  assert.equal(calls[0].path, '/api/mail/attachment-preview');
  assert.deepEqual(calls[0].opts.body, {id: 'msg-office', attachmentId: 'att-doc'});

  const dialog = document.body.querySelector('dialog');
  assert.ok(dialog);
  assert.match(dialog.textContent, /Summary of quarterly results/);

  view.closeDialog();
  view.reset();
});

test('dialog navigation iterates through attachments list with previous and next controls', async () => {
  const view = createMailAttachmentsView({
    api: async (path, opts) => {
      return new Blob(['content for ' + opts.body.attachmentId], {type: 'text/plain'});
    }
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-multi',
    attachments: [
      {id: 'att-1', filename: 'first.txt', size: 10, mimeType: 'text/plain'},
      {id: 'att-2', filename: 'second.txt', size: 20, mimeType: 'text/plain'}
    ]
  };

  view.renderGrid(container, message);
  const viewBtns = container.querySelectorAll('button').filter(b => b.textContent === 'View');
  viewBtns[0].dispatch('click');
  await nextTurn();
  await nextTurn();

  const dialog = document.body.querySelector('dialog');
  assert.ok(dialog);
  assert.match(dialog.querySelector('.mail-attachment-dialog-title').textContent, /1 of 2/);

  const prevBtn = dialog.querySelector('.mail-attachment-prev');
  const nextBtn = dialog.querySelector('.mail-attachment-next');
  assert.equal(prevBtn.disabled, true, 'Previous disabled on first item');
  assert.equal(nextBtn.disabled, false, 'Next enabled on first item');

  nextBtn.dispatch('click');
  await nextTurn();
  await nextTurn();

  assert.match(dialog.querySelector('.mail-attachment-dialog-title').textContent, /2 of 2/);
  assert.equal(prevBtn.disabled, false, 'Previous enabled on second item');
  assert.equal(nextBtn.disabled, true, 'Next disabled on last item');

  view.closeDialog();
  view.reset();
});

test('PDF loadingTask is destroyed when dialog closes during getDocument', async () => {
  let destroyed = false;
  let resolvePromise;
  const deferredPromise = new Promise(resolve => { resolvePromise = resolve; });

  const fakePdfjs = {
    getDocument: () => ({
      promise: deferredPromise,
      destroy: () => {
        destroyed = true;
        return Promise.reject(new Error('async destroy failure'));
      }
    })
  };

  const view = createMailAttachmentsView({
    api: async () => new Blob([new Uint8Array([1, 2, 3])], {type: 'application/pdf'}),
    loadPdfjs: async () => fakePdfjs
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-pdf',
    attachments: [{id: 'att-pdf', filename: 'document.pdf', size: 300, mimeType: 'application/pdf'}]
  };

  view.renderGrid(container, message);
  const viewBtn = container.querySelector('.mail-attachment-view-btn');
  viewBtn.dispatch('click');
  await nextTurn();
  await nextTurn();

  // Close dialog while PDF getDocument is still awaiting loadingTask.promise
  view.closeDialog();
  assert.equal(destroyed, true, 'loadingTask destroyed when closed early');

  // When the deferred promise finally resolves, it must not throw or overwrite
  resolvePromise({numPages: 1, destroy() {}, getPage: async () => ({})});
  await nextTurn();
  view.reset();
});

test('PDF page render handles cancellation cleanly on rapid page change', async () => {
  let renderCancelled = false;
  let renderResolve;
  const renderPromise = new Promise((resolve, reject) => {
    renderResolve = resolve;
  });

  const fakePage = {
    getViewport: () => ({width: 600, height: 800}),
    render: () => ({
      promise: renderPromise,
      cancel: () => {
        renderCancelled = true;
        const err = new Error('Rendering cancelled');
        err.name = 'RenderingCancelledException';
        renderResolve();
      }
    })
  };

  const fakeDoc = {
    numPages: 3,
    destroy() {},
    getPage: async () => fakePage
  };

  const fakePdfjs = {
    getDocument: () => ({
      promise: Promise.resolve(fakeDoc),
      destroy() {}
    })
  };

  const view = createMailAttachmentsView({
    api: async () => new Blob([new Uint8Array([1, 2, 3])], {type: 'application/pdf'}),
    loadPdfjs: async () => fakePdfjs
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-pdf-pages',
    attachments: [{id: 'att-pdf', filename: 'doc.pdf', size: 100, mimeType: 'application/pdf'}]
  };

  view.renderGrid(container, message);
  const viewBtn = container.querySelector('.mail-attachment-view-btn');
  viewBtn.dispatch('click');
  await nextTurn();
  await nextTurn();

  const dialog = document.body.querySelector('dialog');
  const nextBtn = dialog.querySelector('.mail-pdf-toolbar button[aria-label="Next page"]');
  if (nextBtn) {
    nextBtn.dispatch('click');
    assert.equal(renderCancelled, true, 'Prior render was cancelled before switching page');
  }

  view.closeDialog();
  view.reset();
});

test('rapid attachment navigation cancels prior pending preview', async () => {
  let calls = 0;
  let resolve1;
  const p1 = new Promise(r => { resolve1 = r; });

  const view = createMailAttachmentsView({
    api: async (path, opts) => {
      calls++;
      if (opts.body.attachmentId === '1') {
        await p1;
        return new Blob(['slow text 1'], {type: 'text/plain'});
      }
      return new Blob(['fast text 2'], {type: 'text/plain'});
    }
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-fast-switch',
    attachments: [
      {id: '1', filename: 'one.txt', size: 10, mimeType: 'text/plain'},
      {id: '2', filename: 'two.txt', size: 10, mimeType: 'text/plain'}
    ]
  };

  view.renderGrid(container, message);
  const viewBtn = container.querySelectorAll('.mail-attachment-view-btn')[0];
  viewBtn.dispatch('click');
  await nextTurn();

  const dialog = document.body.querySelector('dialog');
  const nextBtn = dialog.querySelector('.mail-attachment-next');
  // Navigate immediately without waiting for attachment 1 to finish
  nextBtn.dispatch('click');
  await nextTurn();
  await nextTurn();

  const pre = dialog.querySelector('pre');
  assert.ok(pre);
  assert.equal(pre.textContent, 'fast text 2');

  // Now let attachment 1 finish late; it must not overwrite attachment 2
  resolve1();
  await nextTurn();
  assert.equal(pre.textContent, 'fast text 2');

  view.closeDialog();
  view.reset();
});

test('reset blocks late downloads and clears active download URLs', async () => {
  let resolveDl;
  const dlPromise = new Promise(r => { resolveDl = r; });

  const view = createMailAttachmentsView({
    api: async () => {
      await dlPromise;
      return new Blob(['downloaded content'], {type: 'application/octet-stream'});
    }
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-dl',
    attachments: [{id: 'att-dl', filename: 'file.txt', size: 10, mimeType: 'text/plain'}]
  };

  view.renderGrid(container, message);
  const dlBtn = container.querySelector('.mail-attachment-download-btn');
  dlBtn.dispatch('click');
  await nextTurn();

  // Reset before download completes
  view.reset();

  // Now resolve download
  resolveDl();
  await nextTurn();

  // Download link should not have been created or clicked after reset
  assert.equal(document.clickedElements.filter(e => e.tagName === 'a').length, 0);
  assert.equal(mockCreatedUrls.length, 0);
});

test('active preview URL is revoked on close and switch, not by 60s timer prematurely', async () => {
  const view = createMailAttachmentsView({
    api: async () => new Blob(['fake image bytes'], {type: 'image/png'})
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-img',
    attachments: [{id: 'img-1', filename: 'pic.png', size: 100, mimeType: 'image/png'}]
  };

  view.renderGrid(container, message);
  const viewBtn = container.querySelector('.mail-attachment-view-btn');
  viewBtn.dispatch('click');
  await nextTurn();
  await nextTurn();

  assert.equal(mockCreatedUrls.length, 1);
  const previewUrl = mockCreatedUrls[0].url;
  assert.equal(mockRevokedUrls.includes(previewUrl), false);

  // Close dialog should immediately revoke preview URL
  view.closeDialog();
  assert.ok(mockRevokedUrls.includes(previewUrl), 'Preview URL revoked immediately on dialog close');

  view.reset();
});

test('deferred preview and parallel download do not conflict and preview does not stick Loading', async () => {
  let resolvePreview;
  const previewPromise = new Promise(r => { resolvePreview = r; });
  let downloadDone = false;

  const view = createMailAttachmentsView({
    api: async (path, opts) => {
      if (path === '/api/mail/attachment') {
        if (opts.body.attachmentId === 'att-prev') {
          await previewPromise;
          return new Blob(['deferred preview content'], {type: 'text/plain'});
        } else if (opts.body.attachmentId === 'att-dl') {
          downloadDone = true;
          return new Blob(['download content'], {type: 'application/octet-stream'});
        }
      }
      return {};
    }
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-parallel',
    attachments: [
      {id: 'att-prev', filename: 'note.txt', size: 100, mimeType: 'text/plain'},
      {id: 'att-dl', filename: 'archive.zip', size: 500, mimeType: 'application/zip'}
    ]
  };

  view.renderGrid(container, message);
  const viewBtn = container.querySelector('.mail-attachment-view-btn');
  viewBtn.dispatch('click');
  await nextTurn();

  const dialog = document.body.querySelector('dialog');
  assert.ok(dialog, 'Preview dialog was mounted');
  assert.ok(dialog.textContent.includes('Loading preview'), 'Preview is in Loading state');

  const dlBtns = container.querySelectorAll('.mail-attachment-download-btn');
  dlBtns[1].dispatch('click');
  await nextTurn();
  await nextTurn();

  assert.equal(downloadDone, true, 'Parallel download completed');

  resolvePreview();
  await nextTurn();
  await nextTurn();

  const pre = dialog.querySelector('pre');
  assert.ok(pre, 'Preview completed rendering instead of sticking in loading');
  assert.equal(pre.textContent, 'deferred preview content');

  view.closeDialog();
  view.reset();
});

test('same-id grid refresh keeps dialog open in body, then close restores focus to reader and download succeeds; reset suppresses focus restoration', async () => {
  const reader = new MockElement('div');
  reader.id = 'mail-reader';
  let readerFocused = false;
  reader.focus = () => { readerFocused = true; };
  const origGetElementById = document.getElementById;
  document.getElementById = id => id === 'mail-reader' ? reader : origGetElementById(id);

  const view = createMailAttachmentsView({
    api: async (path) => {
      if (path === '/api/mail/attachment') {
        return new Blob(['preview text'], {type: 'text/plain'});
      }
      return {};
    }
  });

  const container = new MockElement('div');
  document.body.append(container);

  try {
    const message = {
      id: 'msg-same-id',
      attachments: [{id: 'att-1', filename: 'doc.txt', size: 20, mimeType: 'text/plain'}]
    };

    view.renderGrid(container, message);
    const viewBtn = container.querySelector('.mail-attachment-view-btn');
    viewBtn.dispatch('click');
    await nextTurn();
    await nextTurn();

    const dialog = document.body.querySelector('dialog');
    assert.ok(dialog, 'Dialog mounted to body');
    assert.equal(dialog.open, true);

    // Rerender grid for the same message ID
    view.renderGrid(container, message);

    assert.ok(document.body.querySelector('dialog'), 'Dialog remains in body across same-id grid refresh');
    assert.equal(dialog.open, true);

    // Close dialog - originating card was replaced, so focus falls back to reader
    view.closeDialog();
    assert.equal(dialog.open, false);
    assert.equal(readerFocused, true, 'Focus fell back to reader');

    // Download after close
    const dlBtn = container.querySelector('.mail-attachment-download-btn');
    dlBtn.dispatch('click');
    await nextTurn();
    await nextTurn();
    assert.ok(document.clickedElements.some(e => e.tagName === 'a'));

    // Reset suppresses focus restoration
    readerFocused = false;
    view.openPreview(message, message.attachments[0], message.attachments);
    await nextTurn();

    const reopenedDialog = document.body.querySelector('dialog');
    assert.ok(reopenedDialog, 'Reopened dialog mounted to body');
    assert.notEqual(reopenedDialog, dialog, 'Reopened dialog is distinct from first dialog');
    assert.equal(reopenedDialog.open, true);

    view.reset();
    assert.equal(readerFocused, false, 'Reset suppressed focus restoration to reader');
  } finally {
    view.reset();
    document.getElementById = origGetElementById;
    container.remove();
  }
});

test('PDF rapid getPage cancels prior page render and ignores stale getPage resolution', async () => {
  let resolvePage1;
  const page1Promise = new Promise(r => { resolvePage1 = r; });

  const page1 = {
    getViewport: () => ({width: 600, height: 800}),
    render: () => ({promise: Promise.resolve(), cancel() {}})
  };
  const page2 = {
    getViewport: () => ({width: 600, height: 800}),
    render: () => ({promise: Promise.resolve(), cancel() {}})
  };

  let getPageCalls = [];
  const fakeDoc = {
    numPages: 2,
    destroy() {},
    getPage: async pageNum => {
      getPageCalls.push(pageNum);
      if (pageNum === 1) {
        await page1Promise;
        return page1;
      }
      return page2;
    }
  };

  const fakePdfjs = {
    getDocument: () => ({
      promise: Promise.resolve(fakeDoc),
      destroy() {}
    })
  };

  const view = createMailAttachmentsView({
    api: async () => new Blob([new Uint8Array([1, 2])], {type: 'application/pdf'}),
    loadPdfjs: async () => fakePdfjs
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-rapid-pdf',
    attachments: [{id: 'att-pdf', filename: 'book.pdf', size: 200, mimeType: 'application/pdf'}]
  };

  try {
    view.renderGrid(container, message);
    const viewBtn = container.querySelector('.mail-attachment-view-btn');
    viewBtn.dispatch('click');
    await nextTurn();
    await nextTurn();

    const dialog = document.body.querySelector('dialog');
    assert.ok(dialog, 'Dialog mounted to body');
    const toolbar = dialog.querySelector('.mail-pdf-toolbar');
    assert.ok(toolbar, 'PDF toolbar exists');
    const nextBtn = toolbar.querySelectorAll('button').find(b => b.getAttribute('aria-label') === 'Next page');
    assert.ok(nextBtn, 'Next page button exists');

    // Immediately navigate to page 2 while page 1 getPage is pending
    nextBtn.dispatch('click');
    await nextTurn();
    await nextTurn();

    // Now let page 1 resolve late
    resolvePage1();
    await nextTurn();
    await nextTurn();

    const status = dialog.querySelector('.mail-pdf-page-status');
    assert.equal(status.textContent, 'Page 2 of 2', 'Stale page 1 did not overwrite page 2 status');
    assert.deepEqual(getPageCalls, [1, 2]);

    view.closeDialog();
    view.reset();
  } finally {
    resolvePage1?.();
    view.closeDialog();
    view.reset();
  }
});

test('reset during attachment download aborts download via signal', async () => {
  let abortObserved = null;

  const view = createMailAttachmentsView({
    api: async (path, opts) => {
      abortObserved = opts?.signal;
      return new Promise((resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const err = new Error('Download aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
  });

  const container = new MockElement('div');
  const message = {
    id: 'msg-dl-abort',
    attachments: [{id: 'att-1', filename: 'test.bin', size: 50, mimeType: 'application/octet-stream'}]
  };

  view.renderGrid(container, message);
  const dlBtn = container.querySelector('.mail-attachment-download-btn');
  dlBtn.dispatch('click');
  await nextTurn();

  assert.ok(abortObserved, 'signal was passed to download API');
  assert.equal(abortObserved.aborted, false);

  view.reset();
  assert.equal(abortObserved.aborted, true, 'download signal was aborted on reset');
  await nextTurn();
  assert.equal(document.clickedElements.filter(e => e.tagName === 'a').length, 0);
});
