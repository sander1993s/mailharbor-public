import { Worker } from 'node:worker_threads';
import { MAX_INVOICE_BYTES } from './invoice-attachments.mjs';

/** Parse hostile invoice documents in a disposable worker with time and heap limits. */
export function extractInvoiceDocument({ bytes, mimeType }, { signal, timeoutMs = 15000 } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_INVOICE_BYTES ||
      !['application/pdf', 'application/xml'].includes(mimeType)) return Promise.resolve({ text: '', facts: {}, reason: 'unsupported_document' });
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./invoice-parser-worker.mjs', import.meta.url), {
      workerData: { bytes: new Uint8Array(bytes), mimeType },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true, stderr: true
    });
    // Library diagnostics can include document data; drain and discard them.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {}).then(() => error ? reject(error) : resolve(value));
    };
    const abort = () => finish(null, signal.reason);
    const timer = setTimeout(() => finish({ text: '', facts: {}, reason: 'document_parse_timeout' }), timeoutMs);
    timer.unref?.(); signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', value => finish(value));
    worker.once('error', () => finish({ text: '', facts: {}, reason: 'document_parse_failed' }));
    worker.once('exit', () => finish({ text: '', facts: {}, reason: 'document_parse_failed' }));
  });
}
