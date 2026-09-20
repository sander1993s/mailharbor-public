import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBody, CONTENT_EXTRACTION_VERSION, CONTENT_REASONS, BODY_SOURCE_LIMIT, PROCESSING_SOURCE_LIMIT } from '../server/body.mjs';

const headers = (type = 'text/plain; charset=utf-8', extra = '') => Buffer.from(`Content-Type: ${type}\r\n${extra}\r\n`);
const plain = { type: 'text/plain', part: '1' };
const decoded = (body, truncated = false) => ({ body, truncated, bodyUnavailable: false,
  contentReasons: truncated ? ['encoded_byte_limit'] : [], extractionVersion: CONTENT_EXTRACTION_VERSION });
const run = (raw, options = {}) => decodeBody({ raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw), mime: headers(), part: plain, ...options });

test('plain, base64 and quoted-printable MIME decode with their pinned real codecs', async () => {
  assert.deepEqual(await run('Hello café.'), decoded('Hello café.'));
  assert.deepEqual(await run(Buffer.from('Hello café.').toString('base64'), { mime: headers(undefined, 'Content-Transfer-Encoding: base64\r\n'), part: { ...plain, encoding: 'BASE64' } }), decoded('Hello café.'));
  assert.deepEqual(await run('Hello caf=C3=A9.\r\nA soft=\r\n break.', { mime: headers(undefined, 'Content-Transfer-Encoding: quoted-printable\r\n') }), decoded('Hello café.\r\nA soft break.'));
});

test('known Western and Japanese charsets become UTF-8; unknown charsets fail closed', async () => {
  assert.deepEqual(await run(Buffer.from([0x63, 0x61, 0x66, 0xe9]), { mime: headers('text/plain; charset=iso-8859-1') }), decoded('café'));
  assert.deepEqual(await run(Buffer.from([0x80]), { mime: headers('text/plain; charset=windows-1252') }), decoded('€'));
  assert.deepEqual(await run(Buffer.from('\x1b$B$3$s$K$A$O\x1b(B', 'latin1'), { mime: headers('text/plain; charset=iso-2022-jp') }), decoded('こんにちは'));
  for (const charset of ['made-up-charset', 'jis-unknown', '" jis-unknown "']) assert.equal((await run('hello', { mime: headers(`text/plain; charset=${charset}`) })).bodyUnavailable, true);
});

test('format=flowed honors space-stuffing and delsp', async () => {
  assert.deepEqual(await run('Hello \r\nworld\r\n From a sender', { mime: headers('text/plain; charset=utf-8; format=flowed') }), decoded('Hello world\nFrom a sender'));
  assert.deepEqual(await run('inter \r\nnational', { mime: headers('text/plain; charset=utf-8; format=flowed; delsp=yes') }), decoded('international'));
});

test('HTML extraction ignores link destinations and active content; inline PGP is unavailable', async () => {
  const value = await run('<p>Hello <b>there</b> <a href="https://secret.invalid/token">friend</a>.</p><script>hidden()</script><style>hidden</style><img src="secret">', { mime: headers('text/html; charset=utf-8'), part: { type: 'text/html' } });
  assert.deepEqual(value, decoded('Hello there friend.'));
  for (const raw of ['-----BEGIN PGP MESSAGE-----\nCiphertext\n-----END PGP MESSAGE-----', '<p>-----BEGIN PGP MESSAGE-----</p>']) {
    const html = raw.startsWith('<');
    assert.equal((await run(raw, { mime: headers(html ? 'text/html' : 'text/plain'), part: { type: html ? 'text/html' : 'text/plain' } })).bodyUnavailable, true);
  }
});

test('attachments, encrypted types, contradictory or duplicate MIME metadata fail closed', async () => {
  const cases = [
    { part: { ...plain, disposition: 'attachment' } },
    { part: { ...plain, dispositionParameters: { filename: '' } } },
    { part: { ...plain, parameters: { name: 'attached.txt' } } },
    { part: { type: 'multipart/encrypted' } },
    { mime: headers('application/pgp-encrypted') },
    { mime: headers('text/html') },
    { mime: headers('text/plain; name="attached.txt"') },
    { mime: headers('text/plain', 'Content-Disposition: attachment\r\n') },
    { mime: headers('text/plain', "Content-Disposition: inline; filename*=utf-8''attached.txt\r\n") },
    { mime: headers('text/plain', 'Content-Type: application/octet-stream\r\n') },
    { mime: headers('text/plain', 'Content-Transfer-Encoding: rot13\r\n') },
    { mime: headers('text/plain', 'Content-Transfer-Encoding: base64\r\n'), part: { ...plain, encoding: '7bit' } },
    { mime: headers('text/plain; charset=windows-1252'), part: { ...plain, parameters: { charset: 'utf-8' } } }
  ];
  for (const options of cases) assert.equal((await run('PRIVATE_ATTACHMENT', options)).bodyUnavailable, true);
});

test('missing, truncated, oversized or unterminated MIME headers never authorize decoding', async () => {
  for (const mime of [undefined, 'Content-Type: text/plain\r\n\r\n', Buffer.from('Content-Type: text/plain\r\n'), Buffer.alloc(16384), Buffer.alloc(16385)]) {
    assert.equal((await run('PRIVATE_BODY', { mime })).bodyUnavailable, true);
  }
  assert.deepEqual(await run('hello', { mime: Buffer.from('\r\n') }), decoded('hello'));
});

test('raw-prefix and BODYSTRUCTURE size limits mark incomplete text; oversized raw data is unavailable', async () => {
  assert.deepEqual(await run('Hello', { part: { ...plain, size: 100 } }), decoded('Hello', true));
  assert.deepEqual(await run('Hello', { part: { ...plain, size: 5 } }), decoded('Hello'));
  const exact = await run(Buffer.alloc(65536, 0x61));
  assert.equal(exact.body.length, 8000); assert.equal(exact.truncated, true);
  assert.equal((await run(Buffer.alloc(65537, 0x61))).bodyUnavailable, true);
  assert.equal((await decodeBody({ raw: 'not a Buffer', mime: headers(), part: plain })).bodyUnavailable, true);
});

test('decoded charset expansion and final text have independent bounds', async () => {
  const expanded = await run(Buffer.alloc(32769, 0xe9), { mime: headers('text/plain; charset=iso-8859-1') });
  assert.equal(expanded.body, 'é'.repeat(8000)); assert.equal(expanded.truncated, true);
  const hiddenSuffix = await run(Buffer.concat([Buffer.from('<!--'), Buffer.alloc(33000, 0xe9), Buffer.from('--><p>BEYOND_BYTE_CAP</p>')]),
    { mime: headers('text/html; charset=iso-8859-1'), part: { type: 'text/html' } });
  assert.equal(hiddenSuffix.truncated, true); assert.ok(!hiddenSuffix.body.includes('BEYOND_BYTE_CAP'));
  const text = await run('z'.repeat(8001));
  assert.equal(text.body.length, 8000); assert.equal(text.truncated, true);
  const flowed = await run(Buffer.alloc(65536, 0x61), { mime: headers('text/plain; format=flowed; charset=iso-2022-jp') });
  assert.equal(flowed.body.length, 8000); assert.equal(flowed.truncated, true);
});

test('partial encoded prefixes remain bounded and marked incomplete; malformed base64 is unavailable', async () => {
  const mime = headers(undefined, 'Content-Transfer-Encoding: base64\r\n');
  const partial = await run('SGVsbG8gd', { mime, part: { ...plain, size: 100 } });
  assert.ok(partial.body.startsWith('Hello')); assert.equal(partial.truncated, true); assert.ok(partial.body.length <= 8000);
  const qp = await run('hello=', { mime: headers(undefined, 'Content-Transfer-Encoding: quoted-printable\r\n'), part: { ...plain, size: 100 } });
  assert.equal(qp.truncated, true); assert.ok(qp.body.length <= 8000);
  for (const raw of ['!', 'A', 'SGV=sbG8=']) assert.equal((await run(raw, { mime })).bodyUnavailable, true);
});

test('completeness reasons are bounded codes and distinguish source, decoded byte, text and unavailable content', async () => {
  const cases = [
    [await run('short', { part: { ...plain, size: 100 } }), ['encoded_byte_limit']],
    [await run('x'.repeat(8001)), ['decoded_text_limit']],
    [await run(Buffer.alloc(32769, 0xe9), { mime: headers('text/plain; charset=iso-8859-1') }), ['decoded_byte_limit', 'decoded_text_limit']],
    [await run('-----BEGIN PGP MESSAGE-----'), ['encrypted_content']],
    [await run('hello', { part: { ...plain, disposition: 'attachment' } }), ['unsupported_content']],
    [await run('hello', { mime: Buffer.from('Content-Type: text/plain\r\n') }), ['invalid_mime']],
    [await run('hello', { mime: headers('text/plain; charset=private-unsupported-charset') }), ['invalid_encoding']],
    [await decodeBody({}), ['unavailable_part']],
    [await run('   '), ['empty_content']]
  ];
  for (const [result, reasons] of cases) {
    assert.deepEqual(result.contentReasons, reasons);
    assert.equal(result.extractionVersion, CONTENT_EXTRACTION_VERSION);
    assert.ok(result.contentReasons.every(reason => CONTENT_REASONS.includes(reason)));
    assert.ok(!JSON.stringify(result.contentReasons).includes('private-unsupported-charset'));
  }
});

test('processing source allowance can recover complete short HTML without increasing final AI text limit', async () => {
  const source = `<style>${'x'.repeat(BODY_SOURCE_LIMIT + 1000)}</style><p>Invoice payable by 2026-12-31.</p>`;
  const options = { part: { type: 'text/html', size: Buffer.byteLength(source) }, mime: headers('text/html') };
  const first = await run(Buffer.from(source).subarray(0, BODY_SOURCE_LIMIT), options);
  assert.equal(first.truncated, true); assert.ok(first.contentReasons.includes('encoded_byte_limit'));
  const recovered = await run(source, { ...options, sourceByteLimit: PROCESSING_SOURCE_LIMIT });
  assert.deepEqual(recovered, decoded('Invoice payable by 2026-12-31.'));
  const stillLong = await run('x'.repeat(9000), { sourceByteLimit: PROCESSING_SOURCE_LIMIT });
  assert.equal(stillLong.body.length, 8000); assert.deepEqual(stillLong.contentReasons, ['decoded_text_limit']);
  for (const sourceByteLimit of [Infinity, 10000000, '262144', -1]) {
    const denied = await run(source, { ...options, sourceByteLimit });
    assert.equal(denied.bodyUnavailable, true); assert.equal(denied.truncated, true);
    assert.deepEqual(denied.contentReasons, ['encoded_byte_limit']);
  }
});

test('expansion remains incomplete at its exact byte ceiling and cannot decode attachments or encryption', async () => {
  const source = Buffer.from(`<style>${'x'.repeat(PROCESSING_SOURCE_LIMIT)}</style><p>Future invoice date</p>`);
  const options = { sourceByteLimit: PROCESSING_SOURCE_LIMIT, mime: headers('text/html'),
    part: { type: 'text/html', size: source.length } };
  const limited = await run(source.subarray(0, PROCESSING_SOURCE_LIMIT), options);
  assert.equal(limited.truncated, true); assert.equal(limited.bodyUnavailable, true);
  assert.ok(limited.contentReasons.includes('encoded_byte_limit')); assert.equal(limited.body.includes('Future invoice date'), false);
  const oversized = await run(source, options);
  assert.equal(oversized.bodyUnavailable, true); assert.equal(oversized.truncated, true);
  const attached = await run(source.subarray(0, PROCESSING_SOURCE_LIMIT), { ...options, part: { ...options.part, disposition: 'attachment' } });
  assert.equal(attached.body, ''); assert.ok(attached.contentReasons.includes('unsupported_content'));
  const encrypted = await run('-----BEGIN PGP MESSAGE-----', { sourceByteLimit: PROCESSING_SOURCE_LIMIT });
  assert.equal(encrypted.body, ''); assert.deepEqual(encrypted.contentReasons, ['encrypted_content']);
});
