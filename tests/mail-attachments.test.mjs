import test from 'node:test';
import assert from 'node:assert/strict';
import fetchCommand from '../node_modules/imapflow/dist/esm/commands/fetch.js';
import { attachmentParts, attachmentPart, attachmentBytes, validAttachmentId, ATTACHMENT_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_SOURCE_BYTES } from '../server/mail-attachments.mjs';

test('attachment metadata includes named, attached and inline non-body parts while keeping alternative bodies private', () => {
  const result = attachmentParts({ type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'multipart/alternative', childNodes: [{ part: '1.1', type: 'text/plain' }, { part: '1.2', type: 'text/html' }] },
    { part: '2', type: 'text/plain', disposition: 'attachment', size: 40 },
    { part: '3', type: 'text/html', parameters: { name: 'page.html' }, encoding: 'quoted-printable', size: 30 },
    { part: '4', type: 'image/png', disposition: 'inline', size: 48, encoding: 'base64' },
    { part: '5', type: 'message/rfc822', childNodes: [{ part: '5.1', type: 'application/pdf' }] },
    { part: '6', type: 'application/octet-stream', size: -1 },
    { part: '7', type: 'text/calendar', size: 900 },
    { part: '8', type: 'application/pdf', encoding: 'unknown', size: 100 }
  ] });
  assert.deepEqual(result.map(value => value.id), ['2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(result.map(value => value.size), [40, null, 36, null, null, 900, null]);
  assert.equal(result[0].filename, 'attachment-2.txt');
  assert.equal(result[3].filename, 'attachment-5.eml');
  assert.equal(result[2].mimeType, 'image/png');
});

test('attachment filenames and MIME types are sanitized without trusting provider metadata', () => {
  const result = attachmentParts({ type: 'multipart/mixed', childNodes: [
    { part: '1', type: 'application/pdf', dispositionParameters: { filename: '..\\folder/evil\r\n\0\u202ef:ile?.pdf' } },
    { part: '2', type: 'application/pdf', parameters: { name: '=?UTF-8?B?ZmFjdHVyYS3DqS5wZGY=?=' } },
    { part: '3', type: 'application/pdf', parameters: { name: '...' } },
    { part: '4', type: 'image/png\r\nInjected: true', parameters: { name: 'CON.png' } },
    { part: '5', type: 'application/pdf', parameters: { name: `${'a'.repeat(198)}😀😀\ud800.pdf` } },
    { part: '6', type: 'text/plain', parameters: { 'name*': 'unknown-encoding' } }
  ] });
  assert.deepEqual(result.map(value => value.filename), ['evilfile.pdf', 'factura-é.pdf', 'attachment-3.pdf', '_CON.png', `${'a'.repeat(198)}😀😀`, 'attachment-6.txt']);
  assert.equal(result[3].mimeType, 'application/octet-stream');
  assert.ok(result.every(value => !/[\r\n\u202e\\/]/u.test(value.filename)));
});

test('attachment traversal is bounded for broad, deep and cyclic MIME structures and rejects duplicate or invalid IDs', () => {
  const many = { type: 'multipart/mixed', childNodes: Array.from({ length: 1000 }, (_, index) => ({ part: String(index + 1), type: 'application/pdf' })) };
  assert.equal(attachmentParts(many).length, 100);
  let deep = { part: '1', type: 'application/pdf' };
  for (let index = 0; index < 22; index++) deep = { type: 'multipart/mixed', childNodes: [deep] };
  assert.deepEqual(attachmentParts(deep), []);
  const cycle = { type: 'multipart/mixed' };
  cycle.childNodes = [cycle, { part: '1', type: 'image/png' }, { part: '1', type: 'application/pdf' }, { part: '1.mime', type: 'image/png' }];
  assert.deepEqual(attachmentParts(cycle).map(value => value.id), ['1']);
  for (const id of ['1.mime', '0', '1.0', '1..2', '01', '1\n', '1\r\n', '1'.repeat(201), Array(22).fill('1').join('.')]) assert.equal(validAttachmentId(id), false);
  assert.equal(validAttachmentId('1.2.3'), true);
});

test('transfer-only attachment downloads preserve binary bytes, inline charset/flowed text and complete attached EML with UID BODY.PEEK', async () => {
  const original = Buffer.from([0, 255, 254, 3, 4, 5, 12, 13, 98, 102, 101, 241]);
  const eml = Buffer.from('Subject: attached message\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\nCaf\xe9\r\n', 'latin1');
  for (const fixture of [
    { bytes: original, encoded: Buffer.from(original.toString('base64')), node: { type: 'application/pdf', encoding: 'base64' } },
    { bytes: original, encoded: Buffer.from(original.toString('base64')), nested: true, node: { type: 'application/pdf', encoding: 'base64' } },
    { bytes: Buffer.from('caf\xe9 \r\nflowed line \r\nnext\r\n', 'latin1'), encoded: Buffer.from('caf=E9 =0D=0Aflowed line =0D=0Anext=0D=0A'), nested: true,
      node: { type: 'text/plain', disposition: 'inline', encoding: 'quoted-printable', parameters: { name: 'original.txt', charset: 'iso-8859-1', format: 'flowed', delsp: 'yes' } } },
    { bytes: eml, encoded: eml, node: { type: 'message/rfc822', encoding: '8bit', childNodes: [{ type: 'text/plain' }] } }
  ]) {
    const compiled = [];
    const node = { ...fixture.node, size: fixture.encoded.length, ...(fixture.nested ? { part: '2' } : {}) };
    const structure = fixture.nested ? { type: 'multipart/mixed', childNodes: [node] } : node;
    const part = attachmentPart(structure, fixture.nested ? '2' : '1');
    const downloaded = await attachmentBytes(part, async (start, maxLength) => {
      const compilerClient = { state: 1, states: { SELECTED: 1 }, mailbox: {}, capabilities: new Map(), enabled: new Set(),
        exec: async (command, attributes) => { compiled.push({ command, attributes }); return { next() {} }; } };
      await fetchCommand(compilerClient, '17', { uid: true, bodyParts: [{ key: part.section, start, maxLength }] }, { uid: true, binary: false });
      return fixture.encoded.subarray(start, start + maxLength);
    });
    assert.deepEqual(downloaded, fixture.bytes);
    assert.ok(compiled.every(value => value.command === 'UID FETCH'));
    const bodyAttributes = compiled.flatMap(value => value.attributes[1]).filter(value => value.section);
    assert.ok(bodyAttributes.length > 0);
    assert.ok(bodyAttributes.every(value => value.value === 'BODY.PEEK'));
    assert.deepEqual(bodyAttributes.map(value => value.section[0].value), [fixture.nested ? '2' : 'TEXT']);
  }
});

test('transfer decoding preserves files across chunk boundaries and probes for completion at exact chunk sizes', async () => {
  for (const [encoding, original, source] of [
    ['base64', Buffer.alloc(90000, 241), Buffer.from(Buffer.alloc(90000, 241).toString('base64'))],
    ['quoted-printable', Buffer.alloc(30000, 241), Buffer.from('=F1'.repeat(30000))],
    ['binary', Buffer.alloc(ATTACHMENT_CHUNK_BYTES, 251), Buffer.alloc(ATTACHMENT_CHUNK_BYTES, 251)]
  ]) {
    const calls = [];
    const result = await attachmentBytes({ encoding, encodedSize: source.length }, async (start, size) => {
      calls.push(start); return source.subarray(start, start + size);
    });
    assert.deepEqual(result, original);
    assert.deepEqual(calls, [0, ATTACHMENT_CHUNK_BYTES]);
  }
});

test('attachment limits bound decoded output and encoded wire bytes even when base64 consists only of whitespace', async () => {
  await assert.rejects(attachmentBytes({ encoding: 'binary', encodedSize: MAX_ATTACHMENT_BYTES + 1 }, async (start, size) =>
    Buffer.alloc(Math.min(size, MAX_ATTACHMENT_BYTES + 1 - start))), { code: 'attachment_too_large' });
  let wireBytes = 0;
  await assert.rejects(attachmentBytes({ encoding: 'base64', encodedSize: null }, async (start, size) => {
    wireBytes += size; return Buffer.alloc(size, 32);
  }), { code: 'attachment_too_large' });
  assert.equal(wireBytes, MAX_ATTACHMENT_SOURCE_BYTES + 1);
  await assert.rejects(attachmentBytes({ encoding: 'binary', encodedSize: MAX_ATTACHMENT_SOURCE_BYTES + 1 }, () => assert.fail('Oversize known part must not fetch')), { code: 'attachment_too_large' });
});

test('download failures, short provider responses, unsupported encoding and malformed base64 never return partial files', async () => {
  for (const [part, source] of [
    [{ encoding: 'binary', encodedSize: 20 }, Buffer.alloc(10)],
    [{ encoding: 'binary', encodedSize: 0 }, Buffer.alloc(1)],
    [{ encoding: 'binary', encodedSize: null }, undefined],
    [{ encoding: 'x-unknown', encodedSize: 0 }, Buffer.alloc(0)],
    ...['a', '====', 'a===', 'AA==AAAA', 'AA?='].map(value => [{ encoding: 'base64', encodedSize: value.length }, Buffer.from(value)])
  ]) await assert.rejects(attachmentBytes(part, async () => source), { code: 'attachment_unavailable' });
  let fetches = 0;
  await assert.rejects(attachmentBytes({ encoding: 'binary', encodedSize: null }, async () => {
    if (fetches++) throw new Error('private provider error');
    return Buffer.alloc(ATTACHMENT_CHUNK_BYTES);
  }), { code: 'attachment_unavailable' });
});

test('attachmentBytes bounds: invalid maxBytes, tiny limits with base64/quoted-printable/chunking, and unreliable metadata rejection', async () => {
  let fetched = false;
  const fetchNever = async () => { fetched = true; return Buffer.alloc(10); };

  await assert.rejects(attachmentBytes({ encoding: 'binary' }, fetchNever, { maxBytes: 0 }), { code: 'invalid_request' });
  await assert.rejects(attachmentBytes({ encoding: 'binary' }, fetchNever, { maxBytes: NaN }), { code: 'invalid_request' });
  await assert.rejects(attachmentBytes({ encoding: 'binary' }, fetchNever, { maxBytes: -1 }), { code: 'invalid_request' });
  await assert.rejects(attachmentBytes({ encoding: 'binary' }, fetchNever, { maxBytes: MAX_ATTACHMENT_BYTES + 1 }), { code: 'attachment_too_large' });
  assert.equal(fetched, false, 'Invalid maxBytes must never trigger fetch');

  // Reliable metadata rejection with custom maxBytes
  await assert.rejects(
    attachmentBytes({ encoding: 'binary', encodedSize: 101 }, fetchNever, { maxBytes: 100 }),
    { code: 'attachment_too_large' }
  );
  assert.equal(fetched, false, 'Reliable encodedSize > maxBytes must not fetch');

  // Tiny limit with base64
  const b64Data = Buffer.from('hello world this is a test');
  const b64Encoded = Buffer.from(b64Data.toString('base64'));
  const b64Result = await attachmentBytes(
    { encoding: 'base64', encodedSize: b64Encoded.length },
    async (start, size) => b64Encoded.subarray(start, start + size),
    { maxBytes: 50 }
  );
  assert.deepEqual(b64Result, b64Data);

  // Tiny limit with quoted-printable
  const qpEncoded = Buffer.from('hello=20world=20test');
  const qpExpected = Buffer.from('hello world test');
  const qpResult = await attachmentBytes(
    { encoding: 'quoted-printable', encodedSize: qpEncoded.length },
    async (start, size) => qpEncoded.subarray(start, start + size),
    { maxBytes: 50 }
  );
  assert.deepEqual(qpResult, qpExpected);

  // Decoded overflow beyond tiny maxBytes rejects without continuing arbitrarily
  let chunkCalls = 0;
  const oversizeB64 = Buffer.from(Buffer.alloc(200, 'A').toString('base64'));
  await assert.rejects(
    attachmentBytes(
      { encoding: 'base64', encodedSize: null },
      async (start, size) => {
        chunkCalls++;
        return oversizeB64.subarray(start, start + size);
      },
      { maxBytes: 10 }
    ),
    { code: 'attachment_too_large' }
  );
  assert.ok(chunkCalls <= 2, 'Decoded overflow must abort pipeline promptly');

  // Unreliable encoded metadata: metadata claims 10 bytes, but stream produces more
  await assert.rejects(
    attachmentBytes(
      { encoding: 'binary', encodedSize: 10 },
      async (start, size) => Buffer.alloc(size),
      { maxBytes: 5 }
    ),
    { code: 'attachment_too_large' }
  );
});
