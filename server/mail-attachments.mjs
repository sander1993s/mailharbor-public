import libmime from 'libmime';
import libbase64 from 'libbase64';
import libqp from 'libqp';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MailHarborError } from './validation.mjs';

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_SOURCE_BYTES = MAX_ATTACHMENT_BYTES * 3 + 65536;
export const ATTACHMENT_CHUNK_BYTES = 65536;
export const validAttachmentId = value => typeof value === 'string' && value.length <= 200 &&
  !/[\u0000-\u001f\u007f]/u.test(value) && /^[1-9]\d*(?:\.[1-9]\d*){0,19}$/u.test(value);
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const named = parameters => Object.keys(parameters ?? {}).some(key => /^(?:name|filename)(?:\*.*)?$/iu.test(key));
const extensions = { 'message/rfc822': 'eml', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/html': 'html',
  'text/calendar': 'ics', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'application/zip': 'zip' };

function filename(value, fallback) {
  let text = typeof value === 'string' ? value.slice(0, 4096) : '';
  try { text = libmime.decodeWords(text); } catch { /* Keep readable provider metadata if decoding fails. */ }
  text = text.toWellFormed().normalize('NFC').split(/[\\/]/u).at(-1)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>:"|?*]/gu, '')
    .replace(/^[.\s]+|[.\s]+$/gu, '');
  text = Array.from(text).slice(0, 200).join('');
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu.test(text)) text = `_${text}`;
  return text || fallback;
}

/** Safe attachment metadata only; never traverse inside attached messages. */
function attachmentEntries(structure) {
  const result = [], ids = new Set(), seen = new WeakSet();
  let visited = 0;
  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 20 || visited >= 500 || result.length >= 100 || seen.has(node)) return;
    visited++;
    seen.add(node);
    const rawType = normalize(node.type);
    if (!rawType) return;
    const mimeType = rawType.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(rawType) ? rawType : 'application/octet-stream';
    const hasName = named(node.parameters) || named(node.dispositionParameters);
    const isAttachment = hasName || normalize(node.disposition) === 'attachment';
    const multipart = mimeType.startsWith('multipart/');
    // The root multipart has no downloadable MIME section of its own.
    if (multipart && (!isAttachment || depth === 0)) {
      if (Array.isArray(node.childNodes)) for (const child of node.childNodes) {
        if (visited >= 500 || result.length >= 100) break;
        walk(child, depth + 1);
      }
      return;
    }
    if (!isAttachment && ['text/plain', 'text/html'].includes(mimeType)) return;
    const id = String(node.part ?? (depth === 0 ? '1' : ''));
    if (!validAttachmentId(id) || ids.has(id)) return;
    ids.add(id);
    const encoding = normalize(node.encoding);
    const encodedSize = Number.isSafeInteger(node.size) && node.size >= 0 ? node.size : null;
    // BODYSTRUCTURE sizes are transfer-encoded. Base64 gives an approximate decoded
    // size; quoted-printable and unknown encodings cannot be estimated reliably.
    const size = encodedSize === null ? null : encoding === 'base64' ? Math.floor(encodedSize * 3 / 4) :
      ['', '7bit', '8bit', 'binary'].includes(encoding) ? encodedSize : null;
    const fallback = `attachment-${id}.${extensions[mimeType] ?? 'bin'}`;
    result.push({ metadata: { id, filename: filename(node.dispositionParameters?.filename ?? node.parameters?.name, fallback), mimeType, size },
      encoding: encoding || '7bit', section: depth === 0 && !multipart ? 'text' : id, encodedSize });
  }
  walk(structure, 0);
  return result;
}

export const attachmentParts = structure => attachmentEntries(structure).map(entry => entry.metadata);
export const attachmentPart = (structure, id) => attachmentEntries(structure).find(entry => entry.metadata.id === id);

/** Decode only MIME transfer encoding: downloaded file bytes must keep their
 * original charset and format=flowed content. Require a complete bounded part. */
export async function attachmentBytes(part, fetchChunk, {maxBytes = MAX_ATTACHMENT_BYTES} = {}) {
  if (!['7bit', '8bit', 'binary', 'base64', 'quoted-printable'].includes(part.encoding)) throw new MailHarborError('attachment_unavailable');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new MailHarborError('invalid_request');
  if (maxBytes > MAX_ATTACHMENT_BYTES) throw new MailHarborError('attachment_too_large');

  const maxEncodedBytes = maxBytes * 3 + 65536;
  if (part.encodedSize !== null) {
    if (part.encodedSize > maxEncodedBytes) throw new MailHarborError('attachment_too_large');
    if (['', '7bit', '8bit', 'binary'].includes(part.encoding) && part.encodedSize > maxBytes) {
      throw new MailHarborError('attachment_too_large');
    }
  }

  const chunks = [];
  let decoded = 0, encoded = 0, complete = false, base64Length = 0, padding = 0;
  async function* source() {
    while (true) {
      const requested = Math.min(ATTACHMENT_CHUNK_BYTES, maxEncodedBytes - encoded + 1);
      const raw = await fetchChunk(encoded, requested);
      if (!Buffer.isBuffer(raw) || raw.length > requested) throw new MailHarborError('attachment_unavailable');
      encoded += raw.length;
      if (encoded > maxEncodedBytes) throw new MailHarborError('attachment_too_large');
      if (part.encodedSize !== null && encoded > part.encodedSize) throw new MailHarborError('attachment_unavailable');
      // A short response before the BODYSTRUCTURE size is incomplete, never a file.
      if (raw.length < requested) {
        if (part.encodedSize !== null && encoded !== part.encodedSize) throw new MailHarborError('attachment_unavailable');
        complete = true;
      }
      if (part.encoding === 'base64') {
        const compact = raw.toString('latin1').replace(/[\r\n\t ]/gu, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || (padding && /[^=]/u.test(compact))) throw new MailHarborError('attachment_unavailable');
        base64Length += compact.length;
        padding += compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
        if (padding > 2 || (complete && base64Length % 4 !== 0)) throw new MailHarborError('attachment_unavailable');
      }
      if (raw.length) yield raw;
      if (complete) return;
    }
  }
  const stages = [Readable.from(source())];
  if (part.encoding === 'base64') stages.push(new libbase64.Decoder());
  if (part.encoding === 'quoted-printable') stages.push(new libqp.Decoder());
  stages.push(new Writable({ write(chunk, encoding, done) {
    decoded += chunk.length;
    if (decoded > maxBytes) return done(new MailHarborError('attachment_too_large'));
    chunks.push(Buffer.from(chunk));
    done();
  } }));
  try { await pipeline(stages); }
  catch (error) {
    if (error instanceof MailHarborError) throw error;
    throw new MailHarborError('attachment_unavailable');
  }
  if (!complete) throw new MailHarborError('attachment_unavailable');
  return Buffer.concat(chunks, decoded);
}
