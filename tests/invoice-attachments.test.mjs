import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createInvoiceAttachments, invoiceParts, MAX_INVOICE_BYTES } from '../server/invoice-attachments.mjs';
import { mailFingerprint } from '../server/mailboxes.mjs';

const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
const structure = { type: 'multipart/mixed', childNodes: [
  { part: '1', type: 'text/plain', size: 50 },
  { part: '2', type: 'application/pdf', size: pdf.length, disposition: 'attachment', dispositionParameters: { filename: 'invoice.pdf' } },
  { part: '3', type: 'application/xml', size: 5, dispositionParameters: { filename: 'invoice.xml' } },
  { part: '4', type: 'message/rfc822', childNodes: [{ part: '4.1', type: 'application/pdf' }] },
  { part: '5', type: 'multipart/encrypted', childNodes: [{ part: '5.1', type: 'application/pdf' }] }
] };
function harness({ alterAfter = false, oversized = false } = {}) {
  const account = { id: 'fixture' }, calls = [];
  let fetches = 0;
  const message = { uid: 5, size: 200, envelope: { subject: 'Invoice', messageId: '<invoice@example.test>' }, internalDate: new Date('2026-09-01'), flags: new Set(), bodyStructure: structure };
  const reference = { accountId: account.id, path: 'INBOX', uid: 5, uidValidity: '10', fingerprint: mailFingerprint(message) };
  class Client extends EventEmitter {
    async connect() {}
    close() { calls.push('close'); }
    async getMailboxLock(path, options) { assert.equal(options.readOnly, true); this.mailbox = { path, uidValidity: 10n }; return { release() {} }; }
    async fetchOne(uid, query, options) {
      assert.equal(uid, '5'); assert.equal(options.uid, true); assert.equal(options.binary, false);
      calls.push('verify'); fetches++;
      return structuredClone(alterAfter && fetches > 1 ? { ...message, size: 999 } : message);
    }
    async download(uid, part, options) {
      assert.equal(uid, '5'); assert.equal(options.uid, true); assert.equal(options.maxBytes, MAX_INVOICE_BYTES + 1);
      calls.push(`download:${part}`);
      return { content: Readable.from([oversized ? Buffer.alloc(MAX_INVOICE_BYTES + 1) : part === '2' ? pdf : Buffer.from('<x/>')]) };
    }
  }
  const reader = createInvoiceAttachments({ connectionOptions: async () => ({ auth: {} }), createClient: () => new Client() });
  return { reader, account, reference, calls };
}

test('invoice discovery admits bounded PDF/XML parts and skips messages and encrypted containers', () => {
  assert.deepEqual(invoiceParts(structure).map(part => part.part), ['2', '3']);
  assert.deepEqual(invoiceParts({ ...structure, childNodes: [{ part: '../../escape', type: 'application/pdf' }] }), []);
  assert.equal(invoiceParts({ type: 'multipart/mixed', childNodes: Array.from({ length: 50 }, (_, i) => ({ type: 'application/pdf', part: String(i + 1) })) }).length, 20);
});
test('original attachment bytes are read without mail writes and verified before and after download', async () => {
  const h = harness();
  const result = await h.reader.read(h.account, h.reference);
  assert.deepEqual(result.documents[0].bytes, pdf);
  assert.equal(result.documents.length, 2);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(h.calls, ['verify', 'download:2', 'download:3', 'verify', 'close']);
});
test('stale references or changed messages never publish downloaded attachments', async () => {
  const first = harness();
  await assert.rejects(first.reader.read(first.account, { ...first.reference, fingerprint: 'a'.repeat(64) }), { code: 'stale_message' });
  assert.equal(first.calls.some(call => call.startsWith('download:')), false);
  const moved = harness({ alterAfter: true });
  await assert.rejects(moved.reader.read(moved.account, moved.reference), { code: 'stale_message' });
});
test('oversized decoded documents are skipped instead of publishing partial originals', async () => {
  const h = harness({ oversized: true });
  const result = await h.reader.read(h.account, h.reference);
  assert.equal(result.documents.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every(value => value.reason === 'document_too_large'));
});
