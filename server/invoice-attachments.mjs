import { createMailboxSession, hasMailFlag, mailFingerprint } from './mailboxes.mjs';
import { MailHarborError } from './validation.mjs';

export const MAX_INVOICE_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const fail = code => { throw new MailHarborError(code); };
const check = signal => { if (signal?.aborted) throw signal.reason ?? new MailHarborError('cancelled'); };
const validUid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;

/** Identify possible invoice documents without reading or executing their contents. */
export function invoiceParts(structure) {
  const result = [];
  let visited = 0;
  function walk(node, depth) {
    if (!node || depth > 20 || ++visited > 500 || result.length >= 20) return;
    const mimeType = String(node.type ?? '').toLowerCase();
    if (mimeType === 'multipart/encrypted' || mimeType.startsWith('message/') || /pkcs7|pgp-encrypted/.test(mimeType)) return;
    if (mimeType.startsWith('multipart/')) {
      for (const child of node.childNodes ?? []) walk(child, depth + 1);
      return;
    }
    const filename = String(node.dispositionParameters?.filename ?? node.parameters?.name ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 240);
    const isPdf = mimeType === 'application/pdf' || (mimeType === 'application/octet-stream' && /\.pdf$/iu.test(filename));
    const isXml = ['application/xml', 'text/xml', 'application/ubl+xml'].includes(mimeType) || (mimeType === 'application/octet-stream' && /\.xml$/iu.test(filename));
    const part = String(node.part ?? (depth === 0 ? '1' : ''));
    if ((!isPdf && !isXml) || !/^\d+(?:\.\d+)*$/u.test(part)) return;
    result.push({ part, filename: filename || (isPdf ? 'invoice.pdf' : 'invoice.xml'),
      mimeType: isPdf ? 'application/pdf' : 'application/xml', encodedSize: Number.isSafeInteger(node.size) ? node.size : null });
  }
  walk(structure, 0);
  return result;
}

/** Bounded original PDF/XML downloads. Read-only selection and PEEK preserve mail flags. */
export function createInvoiceAttachments({ connectionOptions, createClient, sessionTimeoutMs } = {}) {
  const { session, active } = createMailboxSession({ connectionOptions, createClient, sessionTimeoutMs });
  return {
    async read(account, reference, { signal } = {}) {
      if (!reference || reference.accountId !== account.id || !validUid(reference.uid) ||
        typeof reference.path !== 'string' || !reference.path || reference.path.length > 1024 || /[\u0000-\u001f\u007f]/u.test(reference.path) ||
        typeof reference.uidValidity !== 'string' || !/^\d{1,20}$/u.test(reference.uidValidity) ||
        typeof reference.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.fingerprint)) fail('stale_message');
      return session(account, signal, async client => {
        const lock = await client.getMailboxLock(reference.path, { readOnly: true });
        const assertMailbox = () => {
          check(signal);
          if (!active.has(client) || client.mailbox?.path !== reference.path || String(client.mailbox?.uidValidity) !== reference.uidValidity) fail('stale_message');
        };
        const verify = async structure => {
          assertMailbox();
          const message = await client.fetchOne(String(reference.uid), { uid: true, envelope: true, flags: true, internalDate: true, size: true,
            ...(structure ? { bodyStructure: true } : {}) }, { uid: true, binary: false });
          assertMailbox();
          if (!message || message.uid !== reference.uid || !(message.flags instanceof Set) || hasMailFlag(message.flags, '\\Deleted') ||
            mailFingerprint(message) !== reference.fingerprint) fail('stale_message');
          return message;
        };
        try {
          const message = await verify(true), parts = invoiceParts(message.bodyStructure), documents = [], skipped = [];
          let total = 0;
          for (const part of parts) {
            assertMailbox();
            if (part.encodedSize !== null && part.encodedSize > MAX_INVOICE_BYTES * 1.5) { skipped.push({ filename: part.filename, reason: 'document_too_large' }); continue; }
            const download = await client.download(String(reference.uid), part.part, { uid: true, maxBytes: MAX_INVOICE_BYTES + 1, chunkSize: 65536 });
            if (!download?.content) { skipped.push({ filename: part.filename, reason: 'document_unavailable' }); continue; }
            const chunks = []; let size = 0;
            try {
              for await (const chunk of download.content) {
                check(signal);
                size += chunk.length;
                if (size > MAX_INVOICE_BYTES || total + size > MAX_MESSAGE_BYTES) { download.content.destroy(); break; }
                chunks.push(Buffer.from(chunk));
              }
            } finally { download.content.destroy(); }
            assertMailbox();
            if (size > MAX_INVOICE_BYTES || total + size > MAX_MESSAGE_BYTES) {
              skipped.push({ filename: part.filename, reason: 'document_too_large' });
              continue;
            }
            if (!size) { skipped.push({ filename: part.filename, reason: 'document_unavailable' }); continue; }
            total += size;
            documents.push({ filename: part.filename, mimeType: part.mimeType, bytes: Buffer.concat(chunks, size) });
          }
          await verify(false);
          return { documents, skipped };
        } finally { lock.release(); }
      });
    }
  };
}
