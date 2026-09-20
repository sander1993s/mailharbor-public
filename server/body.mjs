import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mailsplit from '@zone-eu/mailsplit';
import FlowedDecoder from '@zone-eu/mailsplit/lib/flowed-decoder.js';
import libmime from 'libmime';
import libbase64 from 'libbase64';
import libqp from 'libqp';
import { getDecoder } from 'imapflow/lib/tools.js';
import { LimitedPassthrough } from 'imapflow/lib/limited-passthrough.js';
import { convert } from 'html-to-text';

export const BODY_SOURCE_LIMIT = 65536;
export const PROCESSING_SOURCE_LIMIT = 262144;
export const CONTENT_EXTRACTION_VERSION = '2';
export const CONTENT_REASONS = Object.freeze(['unavailable_part', 'fetch_failure', 'encoded_byte_limit', 'decoded_byte_limit',
  'decoded_text_limit', 'encrypted_content', 'unsupported_content', 'invalid_mime', 'invalid_encoding', 'empty_content']);
const MIME_LIMIT = 16384;
const TEXT_LIMIT = 8000;
const normalize = value => String(value ?? '').trim().toLowerCase();
const charsetKey = value => normalize(value).replace(/[^a-z0-9]/gu, '');
const hasFilename = parameters => Object.keys(parameters ?? {}).some(key => /^(?:name|filename)(?:\*.*)?$/iu.test(key));
const encryptedType = type => type === 'multipart/encrypted' || /^application\/(?:x-)?(?:pkcs7-mime|pgp-encrypted)$/u.test(type);

/** Decode only an already selected, bounded inline body prefix. Never fetches or logs data. */
export async function decodeBody({ raw, mime, part, sourceByteLimit = BODY_SOURCE_LIMIT } = {}) {
  // Only the processing reader opts into the second bounded fetch. Browsing stays at 64 KiB.
  const byteLimit = sourceByteLimit === PROCESSING_SOURCE_LIMIT ? PROCESSING_SOURCE_LIMIT : BODY_SOURCE_LIMIT;
  let truncated = Buffer.isBuffer(raw) && (raw.length >= byteLimit || Number(part?.size ?? 0) > raw.length);
  const reasons = new Set(truncated ? ['encoded_byte_limit'] : []);
  const result = body => ({ body, truncated, bodyUnavailable: !body, contentReasons: [...reasons], extractionVersion: CONTENT_EXTRACTION_VERSION });
  const unavailable = reason => { reasons.add(reason); return result(''); };
  if (!Buffer.isBuffer(raw)) return unavailable('unavailable_part');
  if (raw.length > byteLimit) return unavailable('encoded_byte_limit');
  if (!Buffer.isBuffer(mime) || mime.length >= MIME_LIMIT) return unavailable('invalid_mime');
  try {
    const type = normalize(part?.type);
    if (encryptedType(type)) return unavailable('encrypted_content');
    if (!['text/plain', 'text/html'].includes(type) || !['', 'inline'].includes(normalize(part?.disposition)) ||
        hasFilename(part?.parameters) || hasFilename(part?.dispositionParameters)) return unavailable('unsupported_content');
    // A bounded prefix without the terminating empty line cannot rule out later attachment headers.
    const headerText = mime.toString('latin1');
    if (!/\r?\n\r?\n/u.test(headerText) && !['\r\n', '\n'].includes(headerText)) return unavailable('invalid_mime');
    const headers = new mailsplit.Headers(mime);
    for (const name of ['Content-Type', 'Content-Disposition', 'Content-Transfer-Encoding']) {
      if (headers.get(name).length > 1) return unavailable('invalid_mime');
    }
    const contentType = libmime.parseHeaderValue(headers.getFirst('Content-Type'));
    const disposition = libmime.parseHeaderValue(headers.getFirst('Content-Disposition'));
    const transfer = libmime.parseHeaderValue(headers.getFirst('Content-Transfer-Encoding'));
    if (encryptedType(normalize(contentType.value))) return unavailable('encrypted_content');
    if ((contentType.value && normalize(contentType.value) !== type) ||
        !['', 'inline'].includes(normalize(disposition.value)) || hasFilename(contentType.params) || hasFilename(disposition.params)) return unavailable('invalid_mime');
    const encoding = normalize(transfer.value).replace(/\([^)]*\)/gu, '').trim() || normalize(part.encoding) || '7bit';
    if (!['7bit', '8bit', 'binary', 'base64', 'quoted-printable'].includes(encoding) ||
        (part.encoding && normalize(part.encoding) !== encoding)) return unavailable('invalid_encoding');
    const charset = normalize(contentType.params.charset || part.parameters?.charset || 'utf-8');
    if (contentType.params.charset && part.parameters?.charset && charsetKey(contentType.params.charset) !== charsetKey(part.parameters.charset)) return unavailable('invalid_encoding');
    // getDecoder deliberately accepts broad Japanese prefixes; reject unknown names before that path.
    if (/^(?:jis|iso-?2022-?jp|euc-?jp)/iu.test(charset) && !['jis', 'iso2022jp', 'eucjp'].includes(charsetKey(charset))) return unavailable('invalid_encoding');
    if (encoding === 'base64') {
      const encoded = raw.toString('latin1');
      if (/[^A-Za-z0-9+/=\r\n\t ]/u.test(encoded)) return unavailable('invalid_encoding');
      const compact = encoded.replace(/\s/gu, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || (!truncated && compact.length % 4 === 1)) return unavailable('invalid_encoding');
    }
    const stages = [Readable.from([raw])], limits = [];
    const limit = () => { const stream = new LimitedPassthrough({ maxBytes: byteLimit }); limits.push(stream); stages.push(stream); };
    if (encoding === 'base64') stages.push(new libbase64.Decoder());
    else if (encoding === 'quoted-printable') stages.push(new libqp.Decoder());
    // Bound transfer output and any whole-buffer flowed/charset decoder input.
    limit();
    if (type === 'text/plain' && normalize(contentType.params.format || part.parameters?.format) === 'flowed') {
      stages.push(new FlowedDecoder({ delSp: normalize(contentType.params.delsp || part.parameters?.delsp) === 'yes' }));
      limit();
    }
    if (!['ascii', 'usascii', 'utf8'].includes(charsetKey(charset))) {
      const decoder = getDecoder(charset, byteLimit);
      limits.push(decoder);
      stages.push(decoder);
    }
    limit();
    const chunks = [];
    stages.push(new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }));
    await pipeline(stages);
    if (limits.some(stream => stream.limited)) { truncated = true; reasons.add('decoded_byte_limit'); }
    let body = Buffer.concat(chunks).toString('utf8');
    const marker = '[MailHarbor content limit]';
    if (type === 'text/html') body = convert(body, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' },
        { selector: 'script', format: 'skip' }, { selector: 'style', format: 'skip' }, { selector: 'noscript', format: 'skip' }
      ],
      limits: { maxInputLength: byteLimit, maxDepth: 30, maxChildNodes: 5000, ellipsis: marker }
    });
    body = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
    if (/-----BEGIN PGP MESSAGE-----/iu.test(body)) return unavailable('encrypted_content');
    if (body.length > TEXT_LIMIT || body.includes(marker)) { truncated = true; reasons.add('decoded_text_limit'); }
    body = body.replaceAll(marker, '').slice(0, TEXT_LIMIT);
    if (!body) reasons.add('empty_content');
    return result(body);
  } catch {
    return unavailable('invalid_encoding');
  }
}
