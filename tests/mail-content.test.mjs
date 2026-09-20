import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync, unzipSync, strToU8} from 'fflate';
import {createMailContent, sanitizeMailHtml, previewOffice, officeArchiveEntries, zipAttachments, sourceHeaders, safeFilename} from '../server/mail-content.mjs';
import {MAX_ATTACHMENT_BYTES} from '../server/mail-attachments.mjs';
import {isolatedMailDocument, isOfficeAttachment, autoSizeMailFrame, plainMailBody, createRichMailView} from '../web/mail-content.mjs';

test('rich HTML strips active content, external images, CSS, unsafe navigation, forms and unsafe inline images', () => {
  const html = sanitizeMailHtml('<script>alert(1)</script><style>@import url(https://evil)</style><form action=https://evil><input><p onmouseover=evil style="background:url(https://evil)">Hello</p></form><a href="javascript:evil()">Link</a><iframe src=https://evil></iframe><img src="https://evil/pixel"><img src="data:image/svg+xml;base64,AA"><svg><script>evil</script></svg><img src="cid:photo"><img src="cid:vector">', [
    {contentId: 'photo', contentType: 'image/png', content: Buffer.from('image')},
    {contentId: 'vector', contentType: 'image/svg+xml', content: Buffer.from('<svg/>')}
  ]);
  assert.match(html, /data:image\/png;base64,aW1hZ2U=/u);
  assert.match(html, /Hello/u);
  for (const unsafe of ['script','style','https:','javascript:','onmouseover','iframe','<form','<input','<svg','image/svg','href=']) assert.ok(!html.includes(unsafe), unsafe);
  const srcdoc = isolatedMailDocument(html);
  assert.match(srcdoc, /default-src 'none'/u); assert.match(srcdoc, /form-action 'none'/u);
  assert.match(srcdoc, /script-src 'none'/u); assert.match(srcdoc, /style-src 'self'/u);
});

test('message links preserve safe web and mail destinations with opener and referrer isolation', () => {
  const html = sanitizeMailHtml('<a href="https://example.test/confirm?token=a%2Bb&amp;next=%2Finbox" target="_top" onclick="evil()" ping="https://tracker.test">Confirm</a><a href="http://example.test/path">Web</a><a href="mailto:friend@example.test?subject=Hello%20there">Reply</a>');
  assert.match(html, /href="https:\/\/example.test\/confirm\?token=a%2Bb&amp;next=%2Finbox" target="_blank" rel="noopener noreferrer"/u);
  assert.match(html, /href="http:\/\/example.test\/path"/u);
  assert.match(html, /href="mailto:friend@example.test\?subject=Hello%20there"/u);
  assert.equal((html.match(/target="_blank"/gu) ?? []).length, 3);
  assert.doesNotMatch(html, /onclick|ping=|_top/u);
  for (const href of ['javascript:alert(1)', 'java&#x09;script:alert(1)', 'data:text/html,evil', 'file:///etc/passwd', 'blob:https://example.test/id', '//example.test/path', '/api/mail/action', 'https://', 'https:\\evil.test']) {
    assert.equal(sanitizeMailHtml(`<a href="${href}">Unsafe</a>`), '<a>Unsafe</a>', href);
  }
});

class ContentElement {
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
      if (node instanceof ContentElement) node.parent = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of nodes) {
      if (node instanceof ContentElement) node.parent = this;
      this.children.unshift(node);
    }
  }
  after(...nodes) {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node instanceof ContentElement) node.parent = this.parent;
        this.parent.children.splice(idx + 1 + i, 0, node);
      }
    }
  }
  replaceWith(...nodes) {
    if (!this.parent) return;
    const idx = this.parent.children.indexOf(this);
    if (idx >= 0) {
      for (const node of nodes) {
        if (node instanceof ContentElement) node.parent = this.parent;
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
  contains(node) { return node === this || this.children.some(child => child instanceof ContentElement && child.contains(node)); }
  getBoundingClientRect() { return {height: this.height ?? 0}; }
  descendants() { return this.children.flatMap(child => child instanceof ContentElement ? [child, ...child.descendants()] : []); }
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

function contentDom(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = new ContentElement('document');
  document.createElement = tag => new ContentElement(tag);
  document.createElementNS = (_, tag) => new ContentElement(tag);
  Object.defineProperty(globalThis, 'document', {configurable: true, value: document});
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  return document;
}

test('plain-text URLs are clickable while markup and script-like text remain literal', t => {
  contentDom(t);
  const text = '<script>evil()</script> Read https://example.test/a?q=one&next=two. Email mailto:friend@example.test; javascript:alert(1)';
  const body = plainMailBody(text);
  assert.equal(body.textContent, text);
  const links = body.children.filter(child => child.tagName === 'a');
  assert.equal(links.length, 2);
  assert.equal(links[0].href, 'https://example.test/a?q=one&next=two');
  assert.equal(links[1].href, 'mailto:friend@example.test');
  assert.ok(links.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer'));
  assert.ok(body.children.every(child => ['a', 'span'].includes(child.tagName)));
});

test('the frame follows growing and shrinking body height and disconnects on navigation', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const observations = [];
  class Observer {
    constructor(callback) { this.callback = callback; observations.push(this); }
    observe(body) { this.body = body; }
    disconnect() { this.disconnected = true; }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {configurable: true, value: Observer});
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous); else delete globalThis.ResizeObserver; });
  const frame = new ContentElement('iframe'), body = new ContentElement('body');
  body.height = 900; body.scrollHeight = 900; frame.contentDocument = {body};
  const cleanup = autoSizeMailFrame(frame);
  frame.fire('load');
  assert.equal(frame.style.height, '901px');
  assert.equal(observations[0].body, body);
  body.height = 1500; body.scrollHeight = 1500; body.fire('load');
  assert.equal(frame.style.height, '1501px', 'An inline image must enlarge the parent reader instead of creating an inner scrollbar.');
  body.height = 300; body.scrollHeight = 300; observations[0].callback();
  assert.equal(frame.style.height, '301px', 'A wider pane must shrink the iframe as text reflows.');
  const replacement = new ContentElement('body'); replacement.height = 700;
  frame.contentDocument = {body: replacement}; frame.fire('load');
  assert.equal(observations[0].disconnected, true);
  assert.equal(body.events.size, 0);
  assert.equal(frame.style.height, '701px');
  cleanup();
  assert.equal(observations[1].disconnected, true);
  replacement.height = 4000; observations[1].callback();
  assert.equal(frame.style.height, '701px', 'A stale resize must not touch a previous message.');
  assert.equal(frame.events.size, 0); assert.equal(replacement.events.size, 0);
});

test('full content keeps a readable fallback while loading and exposes compact options with a script-free frame', async t => {
  const document = contentDom(t), host = new ContentElement();
  let finish;
  const view = createRichMailView({api: () => new Promise(resolve => { finish = resolve; })});
  view.render(host, {id: 'one', body: 'Readable preview https://example.test', attachments: [{id: '2', filename: 'file.txt'}]});
  assert.match(host.textContent, /Readable preview/);
  finish({html: sanitizeMailHtml('<p>Full body <a href="https://example.test">Open</a></p>'), text: 'Full body'});
  await new Promise(resolve => setImmediate(resolve));
  const frame = host.descendants().find(node => node.tagName === 'iframe');
  const sandbox = frame.attributes.get('sandbox').split(' ');
  assert.ok(sandbox.includes('allow-same-origin'));
  assert.ok(sandbox.includes('allow-popups') && sandbox.includes('allow-popups-to-escape-sandbox'));
  assert.equal(sandbox.includes('allow-scripts'), false);
  assert.equal(frame.attributes.get('scrolling'), 'no');
  assert.match(frame.srcdoc, /script-src 'none'/u);
  assert.doesNotMatch(host.textContent, /Readable preview|Attachments: up to|Quick text preview/);
  const options = host.descendants().find(node => node.tagName === 'details');
  assert.ok(options.descendants().some(node => node.textContent === 'Download all attachments (.zip)'));
  options.open = true; options.fire('keydown', {key: 'Escape'}); assert.equal(options.open, false);
  view.reset(); assert.equal(frame.events.size, 0); assert.equal(document.events.size, 0);
});

test('richMail frame persistence across re-renders and parent reparenting', async t => {
  contentDom(t);
  const host = new ContentElement();
  const view = createRichMailView({
    api: async () => ({
      html: '<p>Persistent body</p>',
      text: 'Persistent body'
    })
  });

  view.render(host, {id: 'msg-persist'});
  await new Promise(resolve => setImmediate(resolve));

  const frame1 = host.descendants().find(node => node.tagName === 'iframe');
  assert.ok(frame1, 'Iframe rendered on initial load');

  // Second render with the same ID must retain the exact same iframe instance
  view.render(host, {id: 'msg-persist'});
  const frame2 = host.descendants().find(node => node.tagName === 'iframe');
  assert.equal(frame1, frame2, 'Frame instance must be preserved across identical renders');

  // Reparenting to a new container must keep the same frame
  const newHost = new ContentElement();
  view.render(newHost, {id: 'msg-persist'});
  const frame3 = newHost.descendants().find(node => node.tagName === 'iframe');
  assert.equal(frame1, frame3, 'Frame instance must be preserved during container reparenting');

  view.reset();
});

test('complete MIME reading retains text beyond briefing truncation, addresses, exact source and headers', async () => {
  const text = `Beginning ${'long body '.repeat(1500)} end.`;
  const source = Buffer.from(`From: Sender <sender@example.com>\r\nTo: Reader <reader@example.com>\r\nCc: cc@example.com\r\nReply-To: reply@example.com\r\nSubject: Complete message\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`);
  const calls = [];
  const content = createMailContent({reader: {
    content: async (account, reference, options) => {
      calls.push(options);
      return {
        text,
        html: '',
        headers: sourceHeaders(source).toString('utf8'),
        from: [{ name: 'Sender', address: 'sender@example.com' }],
        to: [{ name: 'Reader', address: 'reader@example.com' }],
        cc: [{ name: '', address: 'cc@example.com' }],
        bcc: [],
        replyTo: [{ name: '', address: 'reply@example.com' }],
        subject: 'Complete message',
        messageId: '',
        attachments: [],
        inlineParts: [],
        encrypted: null,
        complete: true
      };
    },
    source: async () => source
  }});
  const read = await content.read({id: 'account'}, {uid: 2});
  assert.equal(read.text, text); assert.ok(read.text.length > 8000);
  assert.equal(read.cc[0].address, 'cc@example.com'); assert.equal(read.replyTo[0].address, 'reply@example.com');
  assert.equal(read.encrypted, null);
  assert.deepEqual((await content.source({}, {})).bytes, source);
  assert.deepEqual((await content.headers({}, {})).bytes, sourceHeaders(source));
  assert.equal(calls[0].maxEncodedBytes, 16 * 1024 * 1024);
  assert.equal(calls[0].maxDecodedBytes, 8 * 1024 * 1024);
});

test('download limits are 100 MiB; ZIP downloads sanitize path traversal and preserve colliding filenames', () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 100 * 1024 * 1024);
  const result = zipAttachments([{filename:'../../invoice.pdf', bytes:Buffer.from('one')}, {filename:'INVOICE.pdf',bytes:Buffer.from('two')}, {filename:'CON.txt',bytes:Buffer.from('three')}, {filename:'__proto__',bytes:Buffer.from('four')}]);
  const files = unzipSync(result.bytes);
  assert.equal(Buffer.from(files['invoice.pdf']).toString(), 'one'); assert.equal(Buffer.from(files['INVOICE (2).pdf']).toString(), 'two');
  assert.equal(Buffer.from(files['_CON.txt']).toString(), 'three'); assert.equal(Buffer.from(files['___proto__']).toString(), 'four');
  assert.equal(result.mimeType, 'application/zip'); assert.equal(safeFilename('..\\a\r\n.pdf'), 'a.pdf');
});

test('ZIP download fetches only server-selected attachments and observes cancellation', async () => {
  const calls = [], reader = {attachment: async (account, reference, id) => { calls.push(id); return {filename: `${id}.txt`, bytes:Buffer.from(id)}; }};
  const content = createMailContent({reader});
  const result = await content.zip({}, {}, [{id:'2'},{id:'3'}]);
  assert.deepEqual(calls, ['2','3']); assert.deepEqual(Object.keys(unzipSync(result.bytes)), ['2.txt','3.txt']);
  await assert.rejects(content.zip({}, {}, [{id:'../../etc/passwd'}]), {code:'invalid_request'});
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await assert.rejects(content.zip({}, {}, [{id:'2'}], {signal:abort.signal}), /cancelled/u);
});

test('Office previews extract DOCX/PPTX text and resolve XLSX shared strings without executing content', () => {
  const docx = Buffer.from(zipSync({'word/document.xml':strToU8('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Hello &amp; goodbye</w:t></w:r></w:p></w:body></w:document>')}));
  assert.match(previewOffice({filename:'test.docx',bytes:docx}).text, /Hello & goodbye/u);
  const xlsx = Buffer.from(zipSync({'xl/sharedStrings.xml':strToU8('<sst><si><t>Invoice</t></si></sst>'), 'xl/worksheets/sheet1.xml':strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>')}));
  assert.match(previewOffice({filename:'test.xlsx',bytes:xlsx}).text, /A1: Invoice\tB1: 42/u);
  const pptx = Buffer.from(zipSync({'ppt/slides/slide1.xml':strToU8('<p:sld xmlns:p="urn:p"><a:p xmlns:a="urn:a"><a:r><a:t>Slide text</a:t></a:r></a:p></p:sld>')}));
  assert.match(previewOffice({filename:'test.pptx',bytes:pptx}).text, /Slide text/u);
  assert.equal(isOfficeAttachment({filename:'SALES.XLSX'}), true);
});

test('Office preview rejects ZIP bombs, mismatched sizes, path traversal, malformed ZIP and XML entities', () => {
  const bomb = Buffer.from(zipSync({'word/document.xml':strToU8('a'.repeat(2 * 1024 * 1024))}));
  assert.throws(() => officeArchiveEntries(bomb), {code:'preview_unavailable'});
  const lie = Buffer.from(zipSync({'word/document.xml':strToU8('<p>' + 'a'.repeat(4000) + '</p>')}));
  const central = lie.indexOf(Buffer.from([0x50,0x4b,0x01,0x02])); lie.writeUInt32LE(10, central + 24);
  assert.throws(() => previewOffice({filename:'test.docx',bytes:lie}), {code:'preview_unavailable'});
  assert.throws(() => officeArchiveEntries(Buffer.from(zipSync({'../evil':strToU8('test')}))), {code:'preview_unavailable'});
  assert.throws(() => officeArchiveEntries(Buffer.alloc(30)), {code:'preview_unavailable'});
  const xxe = Buffer.from(zipSync({'word/document.xml':strToU8('<!DOCTYPE document [<!ENTITY secret SYSTEM "file:///secret">]><document>&secret;</document>')}));
  assert.throws(() => previewOffice({filename:'test.docx',bytes:xxe}), {code:'preview_unavailable'});
});

test('PGP/MIME detection asks for a key and does not send ciphertext into an HTML renderer', async () => {
  const raw = Buffer.from('From: person@example.com\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc"\r\n\r\n--enc\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--enc\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="encrypted.asc"\r\n\r\n-----BEGIN PGP MESSAGE-----\r\ninvalid\r\n-----END PGP MESSAGE-----\r\n--enc--');
  const content = createMailContent({reader:{
    content: async () => ({
      text: '',
      html: '',
      headers: '',
      from: [{ name: '', address: 'person@example.com' }],
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: '',
      messageId: '',
      attachments: [],
      inlineParts: [],
      encrypted: { type: 'openpgp', decrypted: false },
      complete: true
    }),
    source: async () => raw
  }});
  assert.deepEqual((await content.read({}, {})).encrypted, {type:'openpgp',decrypted:false,signatureVerified:false});
  await assert.rejects(content.read({}, {}, {privateKey:'bad'}), {code:'encrypted_mail_failed'});
});

test('sanitizeMailHtml preserves vetted presentation CSS and safe table attributes while blocking active/unsafe content', () => {
  const input = '<table width="600" cellpadding="8" cellspacing="0" border="1" align="center" style="width: 100%; max-width: 600px; border: 1px solid #cccccc; background-color: #ffffff;">' +
    '<tr><th align="left" style="font-family: Arial, sans-serif; font-size: 16px; color: #184a46; padding: 12px;">Header</th></tr>' +
    '<tr><td colspan="2" style="font-size: 14px; line-height: 1.5; color: rgb(38, 56, 52); margin: 8px 0; position: fixed; background-image: url(https://evil.test/bg.png);">Content</td></tr>' +
    '</table>';
  const sanitized = sanitizeMailHtml(input);
  assert.match(sanitized, /width="600"/u);
  assert.match(sanitized, /cellpadding="8"/u);
  assert.match(sanitized, /cellspacing="0"/u);
  assert.match(sanitized, /border="1"/u);
  assert.match(sanitized, /align="center"/u);
  assert.match(sanitized, /colspan="2"/u);
  assert.match(sanitized, /font-family:\s*Arial,\s*sans-serif/u);
  assert.match(sanitized, /font-size:\s*16px/u);
  assert.match(sanitized, /color:\s*#184a46/u);
  assert.match(sanitized, /border:\s*1px solid #cccccc/u);
  assert.match(sanitized, /background-color:\s*#ffffff/u);
  // Unsafe CSS rules (position overlays, url() backgrounds) must be stripped
  assert.doesNotMatch(sanitized, /position:\s*fixed/u);
  assert.doesNotMatch(sanitized, /url\(/u);
  assert.doesNotMatch(sanitized, /background-image/u);
});

test('sanitizer regression: bounds huge numeric CSS dimensions and table attributes', () => {
  const input = '<table width="9999999" height="8888888" cellpadding="5000" cellspacing="9999" border="500">' +
    '<tr><td colspan="500" rowspan="500" style="font-size: 50000px; margin: 99999px; padding: 88888px; width: 999999px; height: 999999px;">Text</td></tr>' +
    '</table>';
  const sanitized = sanitizeMailHtml(input);
  assert.doesNotMatch(sanitized, /width="9999999"/u);
  assert.doesNotMatch(sanitized, /height="8888888"/u);
  assert.doesNotMatch(sanitized, /cellpadding="5000"/u);
  assert.doesNotMatch(sanitized, /cellspacing="9999"/u);
  assert.doesNotMatch(sanitized, /border="500"/u);
  assert.doesNotMatch(sanitized, /colspan="500"/u);
  assert.doesNotMatch(sanitized, /rowspan="500"/u);
  assert.doesNotMatch(sanitized, /font-size:\s*50000px/u);
  assert.doesNotMatch(sanitized, /margin:\s*99999px/u);
  assert.doesNotMatch(sanitized, /padding:\s*88888px/u);
  assert.doesNotMatch(sanitized, /width:\s*999999px/u);
});

test('sanitizer regression: rejects CSS escaped obfuscation, position, expression and behaviors', () => {
  const input = '<p style="background: \\75\\72\\6c(https://evil); font-size: exp/* */ression(alert(1)); position: fixed; behavior: url(evil.htc); -moz-binding: url(xss);">Obfuscated</p>';
  const sanitized = sanitizeMailHtml(input);
  assert.doesNotMatch(sanitized, /\\75\\72\\6c/u);
  assert.doesNotMatch(sanitized, /expression/u);
  assert.doesNotMatch(sanitized, /position/u);
  assert.doesNotMatch(sanitized, /behavior/u);
  assert.doesNotMatch(sanitized, /-moz-binding/u);
});

test('sanitizer regression: accepts only vetted raster CID attachments and distinguishes missing CID from remote', () => {
  const attachments = [
    {contentId: 'valid-png', contentType: 'image/png', content: Buffer.from('png-bytes')},
    {contentId: 'bad-svg', contentType: 'image/svg+xml', content: Buffer.from('<svg></svg>')},
    {contentId: 'bad-html', contentType: 'text/html', content: Buffer.from('<script></script>')}
  ];
  const input = '<img src="cid:valid-png" alt="Valid"><img src="cid:bad-svg" alt="SVG"><img src="cid:bad-html" alt="HTML"><img src="cid:nonexistent" alt="Missing"><img src="https://remote.test/img.png" alt="Remote">';
  const sanitized = sanitizeMailHtml(input, attachments);

  assert.match(sanitized, /data:image\/png;base64,cG5nLWJ5dGVz/u);
  assert.doesNotMatch(sanitized, /image\/svg\+xml/u);
  assert.doesNotMatch(sanitized, /text\/html/u);
  assert.match(sanitized, /<img\b(?=[^>]*\balt="SVG")(?=[^>]*\bdata-blocked-image="missing")[^>]*>/u);
  assert.match(sanitized, /<img\b(?=[^>]*\balt="Missing")(?=[^>]*\bdata-blocked-image="missing")[^>]*>/u);
  assert.match(sanitized, /<img\b(?=[^>]*\balt="Remote")(?=[^>]*\bdata-blocked-image="true")[^>]*>/u);
});

test('blocked remote images receive data-blocked-image attribute and keep alt text', () => {
  const input = '<img src="https://tracker.example.test/beacon.png" alt="Company Logo" width="200" height="50">';
  const sanitized = sanitizeMailHtml(input);
  assert.match(sanitized, /data-blocked-image="true"/u);
  assert.match(sanitized, /alt="Company Logo"/u);
  assert.match(sanitized, /width="200"/u);
  assert.match(sanitized, /height="50"/u);
  assert.doesNotMatch(sanitized, /tracker\.example\.test/u);
});

test('isolatedMailDocument includes style-src unsafe-inline for vetted CSS while maintaining script-src none', () => {
  const doc = isolatedMailDocument('<p style="color: red;">Styled text</p>');
  assert.match(doc, /style-src 'self' 'unsafe-inline'/u);
  assert.match(doc, /script-src 'none'/u);
  assert.match(doc, /default-src 'none'/u);
  assert.match(doc, /form-action 'none'/u);
});

test('createRichMailView reset aborts pending content request via signal while preserving frame persistence across re-renders', async t => {
  contentDom(t);
  const host = new ContentElement();
  let signalObserved = null;
  const view = createRichMailView({
    api: async (path, opts) => {
      if (path === '/api/mail/content') {
        signalObserved = opts?.signal;
        return new Promise((resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return {};
    }
  });

  view.render(host, {id: 'msg-pending'});
  assert.ok(signalObserved, 'signal was passed to api call');
  assert.equal(signalObserved.aborted, false);

  view.reset();
  assert.equal(signalObserved.aborted, true, 'signal was aborted on reset');
});
