import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMailContent,
  renderCompleteContent,
  MAIL_RENDERER_VERSION,
  sanitizeMailHtml,
  MAX_CONTENT_ENCODED_BYTES,
  MAX_CONTENT_DECODED_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  MAX_AGGREGATE_INLINE_BYTES
} from '../server/mail-content.mjs';
import { createRichMailView, isolatedMailDocument, plainMailBody } from '../web/mail-content.mjs';

class BridgeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.events = new Map();
    this.attributes = new Map();
    this.style = {};
    this.parent = null;
    this.className = '';
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  get parentElement() { return this.parent; }
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof BridgeElement) node.parent = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of nodes) {
      if (node instanceof BridgeElement) node.parent = this;
      this.children.unshift(node);
    }
  }
  after(...nodes) {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node instanceof BridgeElement) node.parent = this.parent;
        this.parent.children.splice(idx + 1 + i, 0, node);
      }
    }
  }
  replaceWith(...nodes) {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) {
      for (const node of nodes) {
        if (node instanceof BridgeElement) node.parent = this.parent;
      }
      this.parent.children.splice(idx, 1, ...nodes);
      this.parent = null;
    }
  }
  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter(c => c !== this);
      this.parent = null;
    }
  }
  replaceChildren(...nodes) {
    this.text = '';
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  removeEventListener(name, callback) { if (this.events.get(name) === callback) this.events.delete(name); }
  fire(name, event = {}) { this.events.get(name)?.({preventDefault() {}, ...event}); }
  focus() {}
  contains(node) { return node === this || this.children.some(child => child instanceof BridgeElement && child.contains(node)); }
  getBoundingClientRect() { return {height: this.height ?? 0}; }
  descendants() { return this.children.flatMap(child => child instanceof BridgeElement ? [child, ...child.descendants()] : []); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const descendants = this.descendants();
    if (!selector || selector === '*') return descendants;
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return descendants.filter(c => c.className?.split(' ').includes(cls));
    }
    return descendants.filter(c => c.tagName.toLowerCase() === selector.toLowerCase());
  }
}

function bridgeDom(t, cleanup) {
  const cleanups = [];
  if (cleanup) cleanups.push(cleanup);
  const previousDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = new BridgeElement('document');
  document.createElement = tag => new BridgeElement(tag);
  document.createElementNS = (_, tag) => new BridgeElement(tag);
  Object.defineProperty(globalThis, 'document', {configurable: true, value: document});
  t.after(() => {
    try {
      for (const item of cleanups) {
        if (typeof item === 'function') item();
        else if (item && typeof item.reset === 'function') item.reset();
      }
    } finally {
      if (previousDoc) Object.defineProperty(globalThis, 'document', previousDoc);
      else delete globalThis.document;
    }
  });
  const register = item => {
    if (item && !cleanups.includes(item)) {
      cleanups.push(item);
    }
    return item;
  };
  document.registerView = register;
  document.register = register;
  document.registerCleanup = register;
  return document;
}

test('normal reads complete text beyond 8000 chars, HTML and headers/CC preserved; assert provider source/attachment forbidden and content called with exact 8/16 limits/signal', async () => {
  const text = `Start of body ${'paragraph with detailed content '.repeat(500)} end of body.`;
  assert.ok(text.length > 8000);

  const calls = [];
  const fakeReader = {
    content: async (account, reference, options) => {
      calls.push({ account, reference, options });
      return {
        text,
        html: '<p>Safe rich content <a href="https://example.com/item">link</a></p>',
        headers: 'From: sender@example.com\r\nTo: recipient@example.com\r\nCc: team@example.com\r\nSubject: Bridge Test\r\n',
        from: [{ name: 'Sender', address: 'sender@example.com' }],
        to: [{ name: 'Recipient', address: 'recipient@example.com' }],
        cc: [{ name: 'Team', address: 'team@example.com' }],
        bcc: [],
        replyTo: [{ name: 'Help', address: 'help@example.com' }],
        subject: 'Bridge Test',
        messageId: '<msg-1@test>',
        attachments: [{ id: '1.2', filename: 'report.pdf', mimeType: 'application/pdf', size: 12345 }],
        inlineParts: [{ id: '1.3', contentId: 'chart@test', mimeType: 'image/png', size: 5432 }],
        encrypted: null,
        complete: true,
        _internalRef: 'must-be-stripped',
        accountCredentials: 'must-be-stripped'
      };
    },
    source: async () => assert.fail('provider source must not be called during normal read'),
    attachment: async () => assert.fail('provider attachment must not be called during normal read')
  };

  const mailContent = createMailContent({ reader: fakeReader });
  const controller = new AbortController();
  const result = await mailContent.read({ id: 'acc-1' }, { uid: 42 }, { signal: controller.signal });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.maxEncodedBytes, 16 * 1024 * 1024);
  assert.equal(calls[0].options.maxDecodedBytes, 8 * 1024 * 1024);
  assert.equal(calls[0].options.includeAttachments, true);
  assert.equal(calls[0].options.signal, controller.signal);

  assert.equal(result.text, text);
  assert.match(result.html, /Safe rich content/);
  assert.match(result.html, /href="https:\/\/example\.com\/item"/);
  assert.equal(result.cc[0].address, 'team@example.com');
  assert.equal(result.replyTo[0].address, 'help@example.com');
  assert.equal(result.subject, 'Bridge Test');
  assert.equal(result.sanitized, true);
  assert.equal(result.rendererVersion, '2');
  assert.equal(result.complete, true);
  assert.equal(result.encrypted, null);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].id, '1.2');
  assert.equal(result.attachments[0].filename, 'report.pdf');
  assert.equal(result.inlineParts.length, 1);
  assert.equal(result.inlineParts[0].contentId, 'chart@test');
  assert.equal(result._internalRef, undefined);
  assert.equal(result.accountCredentials, undefined);
});

test('complete false retained and no cache-worthy claim, never invokes source or raw-source fallback', async t => {
  const document = bridgeDom(t);
  const fakeReader = {
    content: async () => ({
      text: 'Partial text body',
      html: '<p>Partial text body</p>',
      headers: 'Subject: Partial\r\n',
      from: [{ name: '', address: 'sender@example.com' }],
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Partial',
      messageId: '',
      attachments: [],
      inlineParts: [],
      encrypted: null,
      complete: false
    }),
    source: async () => assert.fail('reader.source must not be called merely because complete: false')
  };

  const mailContent = createMailContent({ reader: fakeReader });
  const result = await mailContent.read({ id: 'acc' }, { uid: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.sanitized, true);
  assert.equal(result.rendererVersion, '2');

  const host = new BridgeElement();
  const view = createRichMailView({
    api: async () => result
  });
  document.registerView(view);

  view.render(host, { id: 'msg-incomplete', body: 'Fallback preview' });
  await new Promise(resolve => setImmediate(resolve));

  assert.match(host.textContent, /partial/i);
  assert.doesNotMatch(host.textContent, /complete/i);
  view.reset();
});

test('encrypted undecrypted content returns blank text/html and form metadata; explicit decryption/source paths unchanged', async () => {
  const fakeReader = {
    content: async () => ({
      text: 'CIPHERTEXT_SHOULD_NEVER_BE_RENDERED',
      html: '<p>CIPHERTEXT_SHOULD_NEVER_BE_RENDERED</p>',
      headers: 'Subject: Encrypted message\r\n',
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Encrypted message',
      messageId: '<enc-1>',
      attachments: [],
      inlineParts: [],
      encrypted: { type: 'openpgp', decrypted: false },
      complete: true
    }),
    source: async () => Buffer.from('From: alice@example.com\r\nSubject: Encrypted\r\n\r\nEncrypted data')
  };

  const mailContent = createMailContent({ reader: fakeReader });
  const normal = await mailContent.read({ id: 'acc' }, { uid: 1 });

  assert.equal(normal.text, '');
  assert.equal(normal.html, '');
  assert.deepEqual(normal.encrypted, { type: 'openpgp', decrypted: false, signatureVerified: false });
  assert.equal(normal.subject, 'Encrypted message');
  assert.doesNotMatch(JSON.stringify(normal), /CIPHERTEXT_SHOULD_NEVER_BE_RENDERED/);

  // Source path remains functional
  const src = await mailContent.source({ id: 'acc' }, { uid: 1 });
  assert.equal(src.mimeType, 'message/rfc822');
  assert.ok(Buffer.isBuffer(src.bytes));

  // Explicit decrypt path invokes decryptMail (fails safely with unsupported format for plain text source)
  await assert.rejects(
    mailContent.read({ id: 'acc' }, { uid: 1 }, { privateKey: 'invalid-key-pem' }),
    { code: 'encrypted_mail_unsupported' }
  );
});

test('renderer strips internal fields, scripts, remote images, dataIMG; retains CID descriptors and version 2; sanitization idempotence', () => {
  const input = {
    text: 'Hello world',
    html: '<script>alert(1)</script><p>Message text</p>' +
      '<img src="https://tracker.test/pixel.png" alt="Remote tracker">' +
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="Data Image">' +
      '<img src="cid:logo.png@123" alt="Company Logo">',
    headers: 'Subject: Test\r\n',
    from: [{ name: 'Test', address: 'test@example.com' }],
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Test',
    messageId: '<test-1>',
    attachments: [{ id: '1', filename: 'file.pdf', mimeType: 'application/pdf', size: 100 }],
    inlineParts: [{ id: '2', contentId: 'logo.png@123', mimeType: 'image/png', size: 200 }],
    encrypted: null,
    complete: true,
    _internalAccountRef: 'secret-account-id',
    _providerSession: 'secret-session'
  };

  const rendered = renderCompleteContent(input);

  assert.equal(rendered.rendererVersion, '2');
  assert.equal(rendered.sanitized, true);
  assert.equal(rendered._internalAccountRef, undefined);
  assert.equal(rendered._providerSession, undefined);

  assert.doesNotMatch(rendered.html, /<script|alert/);
  assert.match(rendered.html, /<p>Message text<\/p>/);
  assert.match(rendered.html, /data-blocked-image="true"/);
  assert.doesNotMatch(rendered.html, /tracker\.test/);
  assert.doesNotMatch(rendered.html, /data:image\/png;base64/);
  assert.match(rendered.html, /data-blocked-image="missing"/);
  assert.match(rendered.html, /alt="Company Logo"/);

  assert.equal(rendered.inlineParts.length, 1);
  assert.equal(rendered.inlineParts[0].contentId, 'logo.png@123');

  // Idempotence for cached sanitized payload
  const second = renderCompleteContent(rendered);
  assert.equal(second.html, rendered.html);
  assert.equal(second.text, rendered.text);
  assert.deepEqual(second.inlineParts, rendered.inlineParts);
  assert.equal(second.rendererVersion, '2');

  // Differing rendererVersion forces re-sanitization
  const oldVersionPayload = { ...rendered, rendererVersion: '1', html: '<p>Old</p><img src="data:image/png;base64,abc">' };
  const resanitized = renderCompleteContent(oldVersionPayload);
  assert.equal(resanitized.rendererVersion, '2');
  assert.doesNotMatch(resanitized.html, /data:image\/png;base64/);
});

test('explicit inline images: uses inlineReader despite cached reader, enforces 2/8/10 caps, skips SVG/remote/oversize', async () => {
  const cachedReader = {
    content: async () => ({
      text: 'Cached body',
      html: '<p>Cached sanitized body without images</p>',
      inlineParts: [{ id: '1.2', contentId: 'photo', mimeType: 'image/png', size: 1000 }],
      complete: true,
      sanitized: true,
      rendererVersion: '2'
    })
  };

  const attachmentCalls = [];
  const inlineReader = {
    content: async (account, reference, options) => ({
      text: 'Raw body',
      html: '<p>Body with <img src="cid:vetted-photo"> <img src="cid:oversize-part"> <img src="cid:svg-part"></p>',
      headers: 'Subject: Inline test\r\n',
      from: [{ name: '', address: 'sender@example.com' }],
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Inline test',
      messageId: '',
      attachments: [],
      inlineParts: [
        { id: '2.1', contentId: 'vetted-photo', mimeType: 'image/png', size: 1024 },
        { id: '2.2', contentId: 'oversize-part', mimeType: 'image/jpeg', size: 3 * 1024 * 1024 },
        { id: '2.3', contentId: 'svg-part', mimeType: 'image/svg+xml', size: 500 },
        { id: '2.4', contentId: 'unreferenced-part', mimeType: 'image/png', size: 500 }
      ],
      complete: true
    }),
    attachment: async (account, reference, id, options) => {
      attachmentCalls.push({ id, options });
      if (id === '2.1') {
        return { bytes: Buffer.from('png-binary-content'), mimeType: 'image/png' };
      }
      throw new Error('Unexpected attachment call');
    }
  };

  const mailContent = createMailContent({ reader: cachedReader, inlineReader });
  const controller = new AbortController();
  const result = await mailContent.read(
    { id: 'acc' },
    { uid: 1 },
    { includeInlineImages: true, signal: controller.signal }
  );

  assert.equal(result.inlineImagesLoaded, true);
  // Only vetted-photo was referenced and under 2MiB raster; oversize is skipped, svg is excluded, unreferenced is excluded
  assert.equal(attachmentCalls.length, 1);
  assert.equal(attachmentCalls[0].id, '2.1');
  assert.equal(attachmentCalls[0].options.maxBytes, 2 * 1024 * 1024);
  assert.equal(attachmentCalls[0].options.signal, controller.signal);

  // Vetted image is transformed to data URL in HTML
  assert.match(result.html, /data:image\/png;base64,/);
  // Safe partial status because oversize/svg were not loaded
  assert.equal(result.inlineImagesStatus, 'partial');
});

test('explicit inline images: deduplicates duplicate CIDs/part IDs and handles MIME mismatch safely', async () => {
  const attachmentCalls = [];
  const inlineReader = {
    content: async () => ({
      text: '',
      html: '<p><img src="cid:dup-cid"> <img src="cid:dup-cid"> <img src="cid:mismatch"></p>',
      from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: [
        { id: '3.1', contentId: 'dup-cid', mimeType: 'image/png', size: 500 },
        { id: '3.1', contentId: 'dup-cid', mimeType: 'image/png', size: 500 },
        { id: '3.2', contentId: 'mismatch', mimeType: 'image/png', size: 500 }
      ],
      complete: true
    }),
    attachment: async (account, reference, id, options) => {
      attachmentCalls.push(id);
      if (id === '3.1') {
        return { bytes: Buffer.from('dup-png'), mimeType: 'image/png' };
      }
      if (id === '3.2') {
        // Return mismatched MIME type
        return { bytes: Buffer.from('jpeg-data'), mimeType: 'image/jpeg' };
      }
      throw new Error('Unknown part');
    }
  };

  const mailContent = createMailContent({ reader: inlineReader });
  const result = await mailContent.read({}, {}, { includeInlineImages: true });

  assert.equal(result.inlineImagesLoaded, true);
  // Part 3.1 should be fetched only once despite duplicate reference and descriptor
  assert.equal(attachmentCalls.filter(id => id === '3.1').length, 1);
  assert.equal(attachmentCalls.filter(id => id === '3.2').length, 1);

  // Mismatch part 3.2 is not rendered as data URL, results in partial status
  assert.equal(result.inlineImagesStatus, 'partial');
});

test('browser rich mail view: no prefetch, button options, cancellation, same-frame identity, and full text replacement', async t => {
  const document = bridgeDom(t);
  const host = new BridgeElement();

  const apiCalls = [];
  let signalObserved = null;
  let deferredSignal = null;
  let resolveDeferred = null;
  const deferredPromise = new Promise(resolve => {
    resolveDeferred = resolve;
  });

  const initialContent = {
    text: 'Complete plain text body',
    html: '<p>HTML body with <img src="cid:raster-pic"></p>',
    complete: true,
    inlineParts: [{ id: '1.1', contentId: 'raster-pic', mimeType: 'image/png', size: 100 }],
    sanitized: true,
    rendererVersion: '2'
  };

  const view = createRichMailView({
    api: async (path, options) => {
      apiCalls.push({ path, body: options.body });
      signalObserved = options.signal;
      if (options.body?.id === 'msg-deferred') {
        deferredSignal = options.signal;
        return deferredPromise;
      }
      if (options.body?.includeInlineImages) {
        return {
          ...initialContent,
          html: '<p>HTML body with <img src="data:image/png;base64,aW1hZ2U="></p>',
          inlineImagesLoaded: true,
          inlineImagesStatus: 'complete'
        };
      }
      return initialContent;
    }
  });
  document.registerView(view);

  // Initial render: starts with fallback briefing body
  view.render(host, { id: 'msg-test', body: 'Briefing fallback text' });
  assert.match(host.textContent, /Briefing fallback text/);

  // API was called with { id: 'msg-test' } only (no prefetch of inline images)
  assert.equal(apiCalls.length, 1);
  assert.deepEqual(apiCalls[0].body, { id: 'msg-test' });

  // Await content delivery
  await new Promise(resolve => setImmediate(resolve));

  // The iframe is mounted
  const frame1 = host.descendants().find(node => node.tagName === 'iframe');
  assert.ok(frame1, 'Iframe should be mounted');
  assert.doesNotMatch(frame1.srcdoc, /data:image\/png;base64/);

  // Check options menu contains "Load embedded images"
  const options1 = host.descendants().find(node => node.tagName === 'details');
  assert.ok(options1, 'Options details menu exists');
  const loadImagesBtn = options1.descendants().find(node => node.textContent === 'Load embedded images');
  assert.ok(loadImagesBtn, 'Load embedded images button exists in options');

  // Trigger explicit inline images load
  loadImagesBtn.fire('click');
  assert.equal(apiCalls.length, 2);
  assert.deepEqual(apiCalls[1].body, { id: 'msg-test', includeInlineImages: true });

  await new Promise(resolve => setImmediate(resolve));

  // Same frame instance retained, srcdoc updated with loaded inline image
  const frame2 = host.descendants().find(node => node.tagName === 'iframe');
  assert.equal(frame1, frame2, 'Frame instance must be preserved after inline images load');
  assert.match(frame2.srcdoc, /data:image\/png;base64,aW1hZ2U=/);

  // In plain text mode, complete body replaces briefing fallback (query mounted options after draw)
  const currentOptions = host.descendants().find(node => node.tagName === 'details');
  assert.ok(currentOptions, 'Mounted options details exists after draw');
  const toggleBtn = currentOptions.descendants().find(node => node.textContent === 'View plain text');
  assert.ok(toggleBtn);
  toggleBtn.fire('click');

  assert.match(host.textContent, /Complete plain text body/);
  assert.doesNotMatch(host.textContent, /Briefing fallback text/);

  // Truly deferred request cancellation test: capture signal before reset, assert aborted, resolve afterward proving no old payload returned
  view.render(host, { id: 'msg-deferred', body: 'Fallback deferred' });
  assert.ok(deferredSignal, 'Deferred signal captured');
  assert.equal(deferredSignal.aborted, false);

  view.reset();
  assert.equal(deferredSignal.aborted, true, 'Deferred signal aborted on reset');

  resolveDeferred({ text: 'LATE TEXT SHOULD NOT APPEAR', html: '<p>LATE</p>', complete: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(host.textContent, /LATE TEXT SHOULD NOT APPEAR/);
});

test('inline download budget: 10 wrongMime 2MiB responses results in exactly 4 calls / 8MiB budget', async () => {
  const calls = [];
  const parts = Array.from({ length: 10 }, (_, i) => ({
    id: `1.${i + 1}`,
    contentId: `img-${i + 1}`,
    mimeType: 'image/png',
    size: 2 * 1024 * 1024
  }));
  const html = parts.map(p => `<img src="cid:${p.contentId}">`).join(' ');

  const fakeReader = {
    content: async () => ({
      text: '',
      html,
      from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: parts,
      complete: true
    }),
    attachment: async (account, reference, id, options) => {
      calls.push({ id, maxBytes: options.maxBytes });
      return { bytes: Buffer.alloc(2 * 1024 * 1024), mimeType: 'image/jpeg' };
    }
  };

  const mailContent = createMailContent({ reader: fakeReader });
  const result = await mailContent.read({}, {}, { includeInlineImages: true });

  assert.equal(calls.length, 4, 'Must make exactly 4 calls for 2MiB parts within 8MiB budget');
  assert.equal(result.inlineImagesStatus, 'unavailable');
  assert.equal(result.inlineImagesLoaded, true);
});

test('inline download budget: repeated attachment_too_large/unknown-size rejects charges maxBytes and stops after 4 calls', async () => {
  const calls = [];
  const parts = Array.from({ length: 10 }, (_, i) => ({
    id: `1.${i + 1}`,
    contentId: `img-${i + 1}`,
    mimeType: 'image/png'
  }));
  const html = parts.map(p => `<img src="cid:${p.contentId}">`).join(' ');

  const fakeReader = {
    content: async () => ({
      text: '',
      html,
      from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: parts,
      complete: true
    }),
    attachment: async (account, reference, id, options) => {
      calls.push({ id, maxBytes: options.maxBytes });
      const err = new Error('attachment too large');
      err.code = 'attachment_too_large';
      throw err;
    }
  };

  const mailContent = createMailContent({ reader: fakeReader });
  const result = await mailContent.read({}, {}, { includeInlineImages: true });

  assert.equal(calls.length, 4, 'Must conservatively charge maxBytes on reject and stop at 4 calls (8MiB)');
  assert.equal(calls[0].maxBytes, 2 * 1024 * 1024);
  assert.equal(result.inlineImagesStatus, 'unavailable');
});

test('inline download budget: 4 valid 2MiB reaches 8MiB budget then does not start fifth call', async () => {
  const calls = [];
  const parts = Array.from({ length: 6 }, (_, i) => ({
    id: `1.${i + 1}`,
    contentId: `img-${i + 1}`,
    mimeType: 'image/png',
    size: 2 * 1024 * 1024
  }));
  const html = parts.map(p => `<img src="cid:${p.contentId}">`).join(' ');

  const fakeReader = {
    content: async () => ({
      text: '',
      html,
      from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: parts,
      complete: true
    }),
    attachment: async (account, reference, id, options) => {
      calls.push({ id, maxBytes: options.maxBytes });
      return { bytes: Buffer.alloc(2 * 1024 * 1024), mimeType: 'image/png' };
    }
  };

  const mailContent = createMailContent({ reader: fakeReader });
  const result = await mailContent.read({}, {}, { includeInlineImages: true });

  assert.equal(calls.length, 4, 'Must make exactly 4 calls, reaching 8MiB cap without starting fifth');
  assert.equal(result.inlineImagesStatus, 'partial');
});

test('inline download budget: 10 tiny images allowed, 11th excluded; metadata > 2MiB skipped without fetch', async () => {
  const calls = [];
  const parts = Array.from({ length: 12 }, (_, i) => ({
    id: `1.${i + 1}`,
    contentId: `img-${i + 1}`,
    mimeType: 'image/png',
    size: i === 0 ? 3 * 1024 * 1024 : 100
  }));
  const html = parts.map(p => `<img src="cid:${p.contentId}">`).join(' ');

  const fakeReader = {
    content: async () => ({
      text: '',
      html,
      from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: parts,
      complete: true
    }),
    attachment: async (account, reference, id, options) => {
      calls.push({ id, maxBytes: options.maxBytes });
      return { bytes: Buffer.alloc(100), mimeType: 'image/png' };
    }
  };

  const mailContent = createMailContent({ reader: fakeReader });
  const result = await mailContent.read({}, {}, { includeInlineImages: true });

  assert.ok(!calls.some(c => c.id === '1.1'), 'Oversize metadata must skip without fetch');
  assert.ok(!calls.some(c => c.id === '1.12'), '11th distinct candidate part must be excluded');
  assert.equal(calls.length, 9);
  assert.equal(result.inlineImagesStatus, 'partial');
});

test('identity/auth/cancellation errors: stale_message, abort, and mailbox_login_required immediately propagate', async () => {
  const parts = [
    { id: '1.1', contentId: 'img-1', mimeType: 'image/png', size: 100 },
    { id: '1.2', contentId: 'img-2', mimeType: 'image/png', size: 100 }
  ];
  const html = '<img src="cid:img-1"> <img src="cid:img-2">';

  let calls = 0;
  const staleReader = {
    content: async () => ({
      text: '', html, from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: parts, complete: true
    }),
    attachment: async (account, reference, id) => {
      calls++;
      const err = new Error('stale message');
      err.code = 'stale_message';
      throw err;
    }
  };

  const contentStale = createMailContent({ reader: staleReader });
  await assert.rejects(
    contentStale.read({}, {}, { includeInlineImages: true }),
    { code: 'stale_message' }
  );
  assert.equal(calls, 1, 'stale_message must abort immediately and not fetch next part');

  // Signal abort during fetch rejects immediately
  const abortCtrl = new AbortController();
  const abortReader = {
    content: async () => ({
      text: '', html, from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: parts, complete: true
    }),
    attachment: async () => {
      abortCtrl.abort();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
  };
  const contentAbort = createMailContent({ reader: abortReader });
  await assert.rejects(
    contentAbort.read({}, {}, { includeInlineImages: true, signal: abortCtrl.signal }),
    /cancelled|aborted|AbortError/i
  );

  // Mailbox login required propagates immediately
  const authReader = {
    content: async () => ({
      text: '', html, from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: parts, complete: true
    }),
    attachment: async () => {
      const err = new Error('mailbox login required');
      err.code = 'mailbox_login_required';
      throw err;
    }
  };
  const contentAuth = createMailContent({ reader: authReader });
  await assert.rejects(
    contentAuth.read({}, {}, { includeInlineImages: true }),
    { code: 'mailbox_login_required' }
  );

  // Private provider error details do NOT leak in public response
  const privateLeakReader = {
    content: async () => ({
      text: '', html: '<img src="cid:img-1">', from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: [{ id: '1.1', contentId: 'img-1', mimeType: 'image/png', size: 100 }], complete: true
    }),
    attachment: async () => {
      throw new Error('PRIVATE_DATABASE_CREDENTIAL_LEAK');
    }
  };
  const contentPrivate = createMailContent({ reader: privateLeakReader });
  const safeRes = await contentPrivate.read({}, {}, { includeInlineImages: true });
  assert.equal(safeRes.inlineImagesStatus, 'unavailable');
  assert.doesNotMatch(JSON.stringify(safeRes), /PRIVATE_DATABASE_CREDENTIAL_LEAK/);
});

test('validation before download: non-boolean includeInlineImages rejects, overbudget content makes 0 attachment calls', async () => {
  let attachmentCalled = false;
  const fakeReader = {
    content: async () => ({
      text: 'a'.repeat(9 * 1024 * 1024),
      html: '<img src="cid:photo">',
      from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: [{ id: '1.1', contentId: 'photo', mimeType: 'image/png', size: 100 }],
      complete: true
    }),
    attachment: async () => {
      attachmentCalled = true;
      return { bytes: Buffer.alloc(100), mimeType: 'image/png' };
    }
  };

  const mailContent = createMailContent({ reader: fakeReader });

  // Non-boolean includeInlineImages must reject with invalid_request
  await assert.rejects(
    mailContent.read({}, {}, { includeInlineImages: 'true' }),
    { code: 'invalid_request' }
  );
  await assert.rejects(
    mailContent.read({}, {}, { includeInlineImages: 1 }),
    { code: 'invalid_request' }
  );
  await assert.rejects(
    mailContent.read({}, {}, { includeInlineImages: {} }),
    { code: 'invalid_request' }
  );

  // Overbudget decoded content must fail with content_too_large and make 0 attachment calls
  await assert.rejects(
    mailContent.read({}, {}, { includeInlineImages: true }),
    { code: 'content_too_large' }
  );
  assert.equal(attachmentCalled, false, 'Overbudget body must produce 0 attachment calls');

  // complete === true strict check and omission of invalid/missing IDs
  const rawWithBadIds = {
    text: 'Body',
    html: '',
    headers: 'Subject: X\r\n',
    from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '',
    attachments: [
      { id: '1.1', filename: 'ok.txt', mimeType: 'text/plain' },
      { id: 'invalid/id', filename: 'bad.txt' },
      { filename: 'no-id.txt' }
    ],
    inlineParts: [
      { id: '1.2', contentId: 'inline-ok', mimeType: 'image/png' },
      { contentId: 'no-id-inline', mimeType: 'image/png' }
    ],
    complete: 'truthy-string'
  };

  const rendered = renderCompleteContent(rawWithBadIds);
  assert.equal(rendered.complete, false, 'complete must require strict boolean true');
  assert.equal(rendered.attachments.length, 1, 'Invalid and missing attachment IDs must be safely omitted');
  assert.equal(rendered.attachments[0].id, '1.1');
  assert.equal(rendered.inlineParts.length, 1, 'Invalid and missing inline IDs must be safely omitted');
  assert.equal(rendered.inlineParts[0].id, '1.2');
});

test('referenced CIDs: only actual img src triggers fetch, not script, a href, or title attribute', async () => {
  const calls = [];
  const fakeReader = {
    content: async () => ({
      text: 'Text mentioning cid:in-plain-text',
      html: '<script>const x = "cid:in-script";</script>' +
        '<a href="cid:in-anchor">link</a>' +
        '<p title="cid:in-title">Paragraph</p>' +
        '<img src="cid:in-img">',
      from: [], to: [], cc: [], bcc: [], replyTo: [], subject: '', messageId: '', attachments: [],
      inlineParts: [
        { id: '1.1', contentId: 'in-plain-text', mimeType: 'image/png', size: 100 },
        { id: '1.2', contentId: 'in-script', mimeType: 'image/png', size: 100 },
        { id: '1.3', contentId: 'in-anchor', mimeType: 'image/png', size: 100 },
        { id: '1.4', contentId: 'in-title', mimeType: 'image/png', size: 100 },
        { id: '1.5', contentId: 'in-img', mimeType: 'image/png', size: 100 }
      ],
      complete: true
    }),
    attachment: async (account, reference, id) => {
      calls.push(id);
      return { bytes: Buffer.alloc(100), mimeType: 'image/png' };
    }
  };

  const mailContent = createMailContent({ reader: fakeReader });
  const result = await mailContent.read({}, {}, { includeInlineImages: true });

  assert.deepEqual(calls, ['1.5'], 'Only img src cid must be fetched; scripts/links/titles/text must be ignored');
  assert.equal(result.inlineImagesStatus, 'complete');
});

test('browser view: offers Retry embedded images on partial result and handles malformed response object', async t => {
  const document = bridgeDom(t);
  const host = new BridgeElement();

  let inlineFetchCount = 0;
  const view = createRichMailView({
    api: async (path, options) => {
      if (options.body?.includeInlineImages) {
        inlineFetchCount++;
        if (inlineFetchCount === 1) {
          // First attempt returns partial result
          return {
            text: 'Body text',
            html: '<p>HTML body</p>',
            complete: true,
            inlineParts: [{ id: '1.1', contentId: 'img-1', mimeType: 'image/png', size: 100 }],
            inlineImagesLoaded: true,
            inlineImagesStatus: 'partial'
          };
        }
        if (inlineFetchCount === 2) {
          // Second attempt returns malformed empty object {}
          return {};
        }
        // Third attempt returns complete
        return {
          text: 'Body text',
          html: '<p>HTML body with <img src="data:image/png;base64,AAAA"></p>',
          complete: true,
          inlineParts: [{ id: '1.1', contentId: 'img-1', mimeType: 'image/png', size: 100 }],
          inlineImagesLoaded: true,
          inlineImagesStatus: 'complete'
        };
      }
      return {
        text: 'Body text',
        html: '<p>HTML body</p>',
        complete: true,
        inlineParts: [{ id: '1.1', contentId: 'img-1', mimeType: 'image/png', size: 100 }],
        sanitized: true,
        rendererVersion: '2'
      };
    }
  });
  document.registerView(view);

  view.render(host, { id: 'msg-retry', body: 'Fallback' });
  await new Promise(resolve => setImmediate(resolve));

  const frameBefore = host.descendants().find(node => node.tagName === 'iframe');
  assert.ok(frameBefore);

  // Trigger first load of inline images -> resolves partial
  const options1 = host.descendants().find(node => node.tagName === 'details');
  const loadBtn = options1.descendants().find(node => node.textContent === 'Load embedded images');
  assert.ok(loadBtn);
  loadBtn.fire('click');
  await new Promise(resolve => setImmediate(resolve));

  // Offers Retry embedded images because status is partial
  const options2 = host.descendants().find(node => node.tagName === 'details');
  const retryBtn = options2.descendants().find(node => node.textContent === 'Retry embedded images') ||
                   host.descendants().find(node => node.textContent === 'Retry embedded images');
  assert.ok(retryBtn, 'Retry embedded images must be offered on partial result');

  // Trigger retry -> returns malformed {}
  retryBtn.fire('click');
  await new Promise(resolve => setImmediate(resolve));

  // Malformed {} must preserve existing body/frame and show retry error
  const frameAfterMalformed = host.descendants().find(node => node.tagName === 'iframe');
  assert.equal(frameBefore, frameAfterMalformed, 'Frame identity must be preserved on malformed response');
  assert.match(host.textContent, /could not be loaded|retry/i);

  // Retry again -> succeeds with complete
  const retryBtn2 = host.descendants().find(node => node.textContent === 'Retry embedded images');
  assert.ok(retryBtn2);
  retryBtn2.fire('click');
  await new Promise(resolve => setImmediate(resolve));

  const frameFinal = host.descendants().find(node => node.tagName === 'iframe');
  assert.equal(frameBefore, frameFinal, 'Frame identity preserved across retry success');
  assert.match(frameFinal.srcdoc, /data:image\/png;base64,AAAA/);
});
