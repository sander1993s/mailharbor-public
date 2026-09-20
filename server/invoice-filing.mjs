import { createHash, randomBytes } from 'node:crypto';
import { MAX_ACCOUNTS } from './providers.mjs';
import { MailHarborError } from './validation.mjs';
import { extractInvoiceDocument } from './invoice-parser.mjs';
import { MAX_INVOICE_BYTES } from './invoice-attachments.mjs';
import { invoiceDigest, invoiceSettings, planInvoice, safeInvoiceFilename } from './invoices.mjs';

const INTERVAL = 20 * 60 * 1000;
const JOB_DEADLINE = 15 * 60 * 1000;
const CAPACITY = 10000;
const TERMINAL = new Set(['filed', 'duplicate', 'not_invoice']);
const STATES = new Set([...TERMINAL, 'needs_review', 'waiting_drive']);
const DRIVE_ERRORS = new Set(['drive_not_configured', 'drive_login_required', 'drive_wrong_account', 'drive_error', 'drive_duplicate_ambiguous']);
const REASONS = new Set([
  'document_missing', 'document_too_large', 'document_unavailable', 'unsupported_document', 'unsupported_invoice_xml',
  'document_parse_failed', 'document_parse_timeout', 'document_needs_ocr', 'document_page_limit', 'document_text_limit', 'incomplete_or_invalid_pdf',
  'proforma_document', 'order_confirmation_document', 'payment_request_document', 'no_invoice_evidence',
  'insufficient_invoice_evidence', 'missing_invoice_number', 'ambiguous_invoice_number', 'missing_invoice_date', 'invalid_invoice_date', 'ambiguous_invoice_date',
  'missing_customer_identity', 'unknown_customer_vat', 'ambiguous_customer_identity', 'customer_identity_conflict', 'ambiguous_customer_context',
  'business_configuration_changed', 'customer_vat_match', 'invoice_date_used', 'customer_name_match', 'filing_pending', 'already_filed', ...DRIVE_ERRORS
]);
const FAILURES = new Set(['cancelled', 'busy', 'stale_message', 'mailbox_error', 'mailbox_timeout', 'mailbox_login_required', 'invoice_limit', 'invoice_timeout', 'tag_limit', 'configuration_error']);
const TRANSIENT = new Set(['business_configuration_changed', 'document_unavailable', 'document_parse_failed', 'document_parse_timeout']);
const retryable = record => record?.status === 'waiting_drive' || (record?.status === 'needs_review' && record.reasons.some(reason => TRANSIENT.has(reason)));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new MailHarborError(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const clean = (value, limit = 500) => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, limit) : '';
const normalizedEmail = value => clean(value, 320).trim().normalize('NFC').toLowerCase();
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
const reasonCodes = values => [...new Set((Array.isArray(values) ? values : []).filter(code => REASONS.has(code)))].slice(0, 12);
const candidate = message => /\b(?:invoice|invoices|(?:(?:voorschot|eind|aanbetalings|verkoop|inkoop|maand|jaar|credit)[\s-]?)?(?:factuur|facturen|faktuur)|creditnota|credit\s*note)\b/iu.test(message.subject || '');
const fileCandidate = name => /(?:invoice|factuur|faktuur|creditnota|credit[_\s-]*note)/iu.test(name || '');
function stateOf(data) {
  if (data.invoiceFiling === undefined) return { schema: 1, settings: { enabled: false }, records: {}, sources: {}, lastRun: null };
  const state = data.invoiceFiling;
  if (!object(state) || state.schema !== 1 || !object(state.settings) || typeof state.settings.enabled !== 'boolean' ||
    !object(state.records) || !object(state.sources) || Object.keys(state.records).length > CAPACITY || Object.keys(state.sources).length > CAPACITY) fail('configuration_error');
  return state;
}
function sourceFor(account, message) {
  const reference = message?.reference;
  if (!object(message) || message.accountId !== account.id || !object(reference) || reference.accountId !== account.id ||
    !Number.isSafeInteger(reference.uid) || reference.uid < 1 || reference.uid > 0xffffffff ||
    typeof reference.uidValidity !== 'string' || !/^\d{1,20}$/u.test(reference.uidValidity) ||
    typeof reference.path !== 'string' || !reference.path || reference.path.length > 1024 || /[\u0000-\u001f\u007f]/u.test(reference.path) ||
    typeof reference.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.fingerprint)) fail('mailbox_error');
  const email = normalizedEmail(account.email);
  if (!validId(account.id) || !email) fail('configuration_error');
  return {
    id: hash(JSON.stringify([account.id, email, reference.fingerprint])), accountId: account.id, email,
    reference: { accountId: account.id, path: reference.path, uid: reference.uid, uidValidity: reference.uidValidity, fingerprint: reference.fingerprint },
    message: { accountId: account.id, account: clean(account.label || account.email || account.id), folderPath: reference.path,
      subject: clean(message.subject), author: clean(message.author), to: clean(message.to), date: clean(message.date, 80), unread: message.unread === true, starred: message.starred === true }
  };
}
function publicFile(value) {
  if (!value || !validId(value.fileId)) return null;
  return { fileId: value.fileId, webViewLink: `https://drive.google.com/file/d/${value.fileId}/view`, folderPath: clean(value.folderPath, 200), deduplicated: value.deduplicated === true };
}
function publicRecord(record) {
  return {
    id: record.id, status: record.status, accountId: record.accountId, account: clean(record.account), subject: clean(record.subject),
    filename: clean(record.filename, 180), entity: validId(record.entity) ? record.entity : null,
    invoiceDate: record.invoiceDate ?? null, year: record.year ?? null, quarter: record.quarter ?? null,
    reasons: reasonCodes(record.reasons), updatedAt: record.updatedAt, file: publicFile(record.file)
  };
}
function publicJob(job) {
  if (!job) return null;
  return Object.fromEntries(['id', 'status', 'phase', 'startedAt', 'finishedAt', 'limit', 'scanned', 'processed', 'filed', 'duplicates', 'needsReview', 'waitingDrive', 'notInvoices', 'scanComplete', 'errors']
    .map(key => [key, structuredClone(job[key])]));
}

/** Sequential, restart-safe invoice filing. Original attachment bytes exist only during one document operation. */
export function createInvoiceFiling({ store, accounts, reader, attachments, drive, tags, index, extract = extractInvoiceDocument, now = () => Date.now() }) {
  if (!store?.read || !store?.update || !accounts?.list || !accounts?.get || !reader?.list || !attachments?.read || !drive?.fileInvoice || !tags?.set || typeof extract !== 'function') fail('configuration_error');
  if (index !== undefined && ['get', 'put', 'list', 'remove', 'count'].some(method => typeof index?.[method] !== 'function')) fail('configuration_error');
  stateOf(store.read());
  let closed = false, active = null, lastRun = null, timer = null;
  const configurationWrites = new Set();
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail('configuration_error');
    return new Date(value).toISOString();
  };
  function check(context, account, data) {
    if (closed || context?.controller.signal.aborted) throw context?.controller.signal.reason ?? new MailHarborError('cancelled');
    if (!account) return;
    let current;
    try { current = accounts.get(account.id); } catch { fail('stale_message'); }
    if (current.revision !== account.revision || normalizedEmail(current.email) !== normalizedEmail(account.email)) fail('stale_message');
    if (data) {
      const saved = data.accounts.find(value => value.id === account.id);
      if (!saved || saved.revision !== account.revision || normalizedEmail(saved.email) !== normalizedEmail(account.email)) fail('stale_message');
    }
  }
  function checkAll(context, data) { check(context); for (const account of context.accounts) check(context, account, data); }
  function enqueue({ account, message, reference } = {}) {
    if (closed) fail('busy');
    if (!index) fail('configuration_error');
    if (!account || !accounts.list().some(value => value.id === account.id && value.connected)) fail('mailbox_login_required');
    check(null, account);
    const source = sourceFor(account, { ...message, reference });
    const state = stateOf(store.read()), known = state.sources[source.id];
    if (known?.complete && !known.recordIds.some(id => retryable(state.records[id]))) {
      // An earlier Inbox scan may already have filed this message before whole-mailbox discovery reaches it.
      if (index.get('invoiceQueue', source.id)) index.remove('invoiceQueue', source.id);
      return { queued: false, alreadyProcessed: true };
    }
    const queued = { ...source, revision: account.revision };
    const previous = index.get('invoiceQueue', source.id);
    if (JSON.stringify(previous) !== JSON.stringify(queued)) {
      check(null, account);
      index.put('invoiceQueue', source.id, queued);
    }
    return { queued: true, alreadyProcessed: false };
  }
  function error(context, code, accountId) {
    const safe = FAILURES.has(code) || DRIVE_ERRORS.has(code) ? code : 'mailbox_error';
    if (context.job.errors.length < 20 && !context.job.errors.some(value => value.code === safe && value.accountId === accountId)) context.job.errors.push({ ...(accountId ? { accountId } : {}), code: safe });
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (closed || active || !stateOf(store.read()).settings.enabled) return;
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      try { start(); } catch { schedule(); }
    }, INTERVAL);
    timer.unref?.();
  }
  async function persist(context, account, change) {
    check(context, account);
    await store.update(data => {
      check(context, account, data);
      const state = stateOf(data);
      change(state); data.invoiceFiling = state;
    });
  }
  async function saveRecord(context, account, source, value) {
    if (!STATES.has(value.status)) fail('configuration_error');
    const id = hash(JSON.stringify([source.id, value.sha256 || value.discriminator || 'missing']));
    const record = {
      id, sourceId: source.id, accountId: account.id, account: source.message.account, subject: source.message.subject,
      kind: value.kind === 'source' || (!value.sha256 && !value.filename) ? 'source' : 'document',
      filename: value.filename ? safeInvoiceFilename(value.filename) : '', sha256: value.sha256 || null,
      status: value.status, entity: value.entity || null, invoiceDate: value.invoiceDate || null, year: value.year || null, quarter: value.quarter || null,
      reasons: reasonCodes(value.reasons), file: publicFile(value.file), updatedAt: time()
    };
    await persist(context, account, state => {
      if ((!state.sources[source.id] && Object.keys(state.sources).length >= CAPACITY) || (!state.records[id] && Object.keys(state.records).length >= CAPACITY)) fail('invoice_limit');
      const previous = state.sources[source.id];
      state.sources[source.id] = { ...source, complete: false, recordIds: [...new Set([...(previous?.recordIds || []), id])], updatedAt: record.updatedAt };
      state.records[id] = record;
    });
    return record;
  }
  async function tag(context, account, source) {
    if (context.tagged.has(source.id)) return;
    check(context, account);
    await tags.set({ account, message: source.message, reference: source.reference, tag: 'invoices', enabled: true, verify: data => check(context, account, data) });
    check(context, account); context.tagged.add(source.id);
  }
  function count(context, status) {
    const key = { filed: 'filed', duplicate: 'duplicates', needs_review: 'needsReview', waiting_drive: 'waitingDrive', not_invoice: 'notInvoices' }[status];
    context.job[key]++;
  }
  async function review(context, account, source, values, shouldTag = true) {
    if (shouldTag) await tag(context, account, source);
    const record = await saveRecord(context, account, source, { ...values, status: 'needs_review' });
    count(context, record.status);
  }
  async function scan(context) {
    const messages = [], seenCursors = new Set(), seenSources = new Set();
    let cursor = null, expectedTotal = null, lastDate = null;
    while (messages.length < context.job.limit && context.accounts.length) {
      checkAll(context);
      let page, failure;
      const size = Math.min(100, context.job.limit - messages.length);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await reader.list(context.accounts, { folder: 'inbox', cursor: structuredClone(cursor), limit: size, includeAttachments: true, signal: context.controller.signal });
          checkAll(context);
          if (!Array.isArray(result?.messages) || result.messages.length > size || !Array.isArray(result.errors ?? []) ||
            !Number.isSafeInteger(result.total) || result.total < 0 || (expectedTotal !== null && result.total !== expectedTotal)) fail('mailbox_error');
          if (result.errors?.length || result.totalComplete !== true) {
            failure = result.errors?.length ? result.errors : [{ code: 'mailbox_error' }];
            continue;
          }
          if (result.total < messages.length + result.messages.length ||
            (!result.nextCursor && messages.length + result.messages.length !== Math.min(context.job.limit, result.total)) ||
            (result.nextCursor && (result.messages.length !== size || messages.length + result.messages.length >= result.total))) fail('mailbox_error');
          const pageSources = new Set(); let pageDate = lastDate;
          for (const message of result.messages) {
            const account = context.accounts.find(value => value.id === message.accountId);
            if (!account) fail('mailbox_error');
            const source = sourceFor(account, message);
            if (seenSources.has(source.id) || pageSources.has(source.id)) fail('mailbox_error');
            pageSources.add(source.id);
            const date = Date.parse(message.date);
            if (Number.isFinite(date)) {
              if (pageDate !== null && date > pageDate) fail('mailbox_error');
              pageDate = date;
            }
          }
          page = result; break;
        } catch (caught) {
          checkAll(context);
          failure = [{ code: caught.code }];
        }
      }
      if (!page) {
        for (const item of failure || [{ code: 'mailbox_error' }]) error(context, item.code, context.accounts.some(account => account.id === item.accountId) ? item.accountId : undefined);
        fail('mailbox_error');
      }
      expectedTotal = page.total;
      for (const message of page.messages) {
        const account = context.accounts.find(value => value.id === message.accountId);
        seenSources.add(sourceFor(account, message).id);
        if (Number.isFinite(Date.parse(message.date))) lastDate = Date.parse(message.date);
      }
      messages.push(...page.messages); context.job.scanned = messages.length;
      if (!page.nextCursor) break;
      const serialized = JSON.stringify(page.nextCursor);
      if (seenCursors.has(serialized) || !page.messages.length) fail('mailbox_error');
      seenCursors.add(serialized); cursor = page.nextCursor;
    }
    checkAll(context); context.job.scanComplete = true;
    return messages;
  }
  async function processDocument(context, account, source, document, recognizedHint) {
    check(context, account);
    const mimeType = document.mimeType === 'text/xml' ? 'application/xml' : document.mimeType;
    let filename = safeInvoiceFilename(document.filename || (mimeType === 'application/xml' ? 'invoice.xml' : 'invoice.pdf'));
    const extension = mimeType === 'application/xml' ? '.xml' : '.pdf';
    if (!filename.toLowerCase().endsWith(extension)) filename = safeInvoiceFilename(`${filename}${extension}`);
    if (!['application/pdf', 'application/xml'].includes(mimeType) || !(document.bytes instanceof Uint8Array) || !document.bytes.byteLength || document.bytes.byteLength > MAX_INVOICE_BYTES) {
      await review(context, account, source, { filename, discriminator: `unavailable:${filename}`, reasons: [document.bytes?.byteLength > MAX_INVOICE_BYTES ? 'document_too_large' : 'unsupported_document'] }, recognizedHint);
      return;
    }
    const bytes = Buffer.from(document.bytes), sha256 = invoiceDigest(bytes);
    const state = stateOf(store.read());
    const id = hash(JSON.stringify([source.id, sha256])), existing = state.records[id];
    if (existing && !retryable(existing)) { count(context, existing.status === 'filed' ? 'duplicate' : existing.status); return; }
    const duplicate = Object.values(state.records).find(value => value.sha256 === sha256 && TERMINAL.has(value.status) && (value.status === 'not_invoice' || value.file));
    if (duplicate) {
      if (duplicate.status === 'not_invoice') {
        await saveRecord(context, account, source, { ...duplicate, filename, sha256 }); count(context, 'not_invoice'); return;
      }
      await tag(context, account, source);
      await saveRecord(context, account, source, { ...duplicate, filename, sha256, status: 'duplicate', reasons: ['already_filed'], file: { ...duplicate.file, deduplicated: true } });
      count(context, 'duplicate'); return;
    }
    let parsed;
    try { parsed = await extract({ filename, mimeType, bytes: new Uint8Array(bytes) }, { signal: context.controller.signal }); }
    catch { check(context, account); parsed = { reason: 'document_parse_failed' }; }
    check(context, account);
    if (parsed?.reason) {
      await review(context, account, source, { filename, sha256, reasons: [REASONS.has(parsed.reason) ? parsed.reason : 'document_parse_failed'] }, recognizedHint || fileCandidate(filename));
      return;
    }
    let plan;
    try { plan = planInvoice({ text: parsed?.text || '', facts: parsed?.facts || {}, filename, bytes, config: context.invoiceConfig }); }
    catch { await review(context, account, source, { filename, sha256, reasons: ['document_parse_failed'] }, recognizedHint); return; }
    if (plan.status === 'not_invoice') {
      await saveRecord(context, account, source, { ...plan, status: 'not_invoice' }); count(context, 'not_invoice'); return;
    }
    await tag(context, account, source);
    if (plan.status !== 'ready') { await review(context, account, source, { ...plan, status: 'needs_review' }); return; }
    // Persist an unresolved entry before the external effect. Drive allocates retry-safe IDs independently.
    await saveRecord(context, account, source, { ...plan, status: 'waiting_drive', reasons: ['filing_pending'] });
    check(context, account);
    try {
      const uploaded = await drive.fileInvoice({ bytes, mimeType, filename: plan.filename, entityLabel: plan.folderSegments[1], year: plan.year, quarter: plan.quarter, sha256 }, { signal: context.controller.signal });
      check(context, account);
      if (!validId(uploaded?.fileId) || uploaded.sha256 !== sha256) fail('drive_error');
      const status = uploaded.deduplicated === true ? 'duplicate' : 'filed';
      await saveRecord(context, account, source, { ...plan, status, file: { fileId: uploaded.fileId, folderPath: plan.folderSegments.join('/'), deduplicated: uploaded.deduplicated === true } });
      count(context, status);
    } catch (caught) {
      check(context, account);
      if (caught.code === 'invoice_limit') throw caught;
      const code = DRIVE_ERRORS.has(caught.code) ? caught.code : 'drive_error';
      await saveRecord(context, account, source, { ...plan, status: 'waiting_drive', reasons: [code] });
      count(context, 'waiting_drive'); error(context, code, account.id);
    }
  }
  async function processSource(context, account, source, descriptors, classifiedInvoice = false) {
    check(context, account);
    const previous = stateOf(store.read());
    const known = previous.sources[source.id];
    const retry = known?.recordIds.some(id => retryable(previous.records[id]));
    if (known?.complete && !retry) {
      for (const id of known.recordIds) if (previous.records[id]?.status === 'filed' || previous.records[id]?.status === 'duplicate') count(context, 'duplicate');
      if (tags.observe) { await tags.observe([account], [{ ...source.message, reference: source.reference }], { verify: data => check(context, account, data) }); check(context, account); }
      return;
    }
    context.job.processed++;
    const hinted = classifiedInvoice || candidate(source.message);
    if (!descriptors?.length && !retry) {
      if (hinted) await review(context, account, source, { discriminator: 'missing', reasons: ['document_missing'] });
    } else {
      let downloaded;
      try { downloaded = await attachments.read(account, source.reference, { signal: context.controller.signal }); check(context, account); }
      catch (caught) {
        check(context, account);
        error(context, caught.code, account.id);
        await review(context, account, source, { discriminator: 'missing', reasons: ['document_unavailable'] }, hinted || retry);
        return;
      }
      if (!Array.isArray(downloaded?.documents) || !Array.isArray(downloaded.skipped ?? []) || downloaded.documents.length > 20 || (downloaded.skipped?.length || 0) > 20) fail('mailbox_error');
      for (const skipped of downloaded.skipped || []) await review(context, account, source, { filename: skipped.filename || 'invoice.pdf', discriminator: `skipped:${clean(skipped.filename, 240)}`, reasons: [skipped.reason === 'document_too_large' ? skipped.reason : 'document_unavailable'] }, hinted || fileCandidate(skipped.filename));
      for (const document of downloaded.documents) await processDocument(context, account, source, document, hinted);
      if (!downloaded.documents.length && !downloaded.skipped?.length) await review(context, account, source, { discriminator: 'missing', reasons: ['document_missing'] }, hinted || retry);
      // A successfully inspected source resolves its old missing-download placeholder.
      // Per-document review and waiting records remain until that same document succeeds.
      if (downloaded.documents.length || downloaded.skipped?.length) await persist(context, account, state => {
        const saved = state.sources[source.id];
        if (!saved) return;
        saved.recordIds = saved.recordIds.filter(id => {
          const record = state.records[id];
          if (record?.kind === 'source' && record.status === 'needs_review' && record.reasons.some(reason => ['document_missing', 'document_unavailable'].includes(reason))) {
            delete state.records[id]; return false;
          }
          return true;
        });
      });
    }
    if (stateOf(store.read()).sources[source.id]) await persist(context, account, state => { const saved = state.sources[source.id]; if (saved) { saved.complete = true; saved.updatedAt = time(); } });
  }
  async function run(context) {
    try {
      const messages = await scan(context), queue = new Map();
      for (const message of messages) {
        const account = context.accounts.find(value => value.id === message.accountId);
        if (!account) fail('mailbox_error');
        const descriptors = Array.isArray(message.invoiceDocuments) ? message.invoiceDocuments.filter(value => ['application/pdf', 'application/xml', 'text/xml'].includes(value.mimeType)) : [];
        const source = sourceFor(account, message);
        if (descriptors.length || candidate(message)) queue.set(source.id, { account, source, descriptors });
      }
      const saved = stateOf(store.read());
      for (const source of Object.values(saved.sources)) {
        if (queue.has(source.id) || !source.recordIds.some(id => retryable(saved.records[id]))) continue;
        const account = context.accounts.find(value => value.id === source.accountId && normalizedEmail(value.email) === source.email);
        if (account) queue.set(source.id, { account, source: sourceFor(account, { ...source.message, reference: source.reference }), descriptors: [] });
      }
      if (index) {
        // Read a bounded number of durable whole-mailbox candidates per run. Keys remain stable across moves.
        let after = '', queued = 0;
        while (queued < context.job.limit) {
          checkAll(context);
          const page = index.list('invoiceQueue', { after, limit: Math.min(100, context.job.limit - queued) });
          if (!page.length) break;
          for (const item of page) {
            if (typeof item?.key !== 'string' || item.key <= after || !object(item.value)) fail('configuration_error');
            after = item.key;
            const value = item.value;
            const account = context.accounts.find(account => account.id === value.accountId && normalizedEmail(account.email) === value.email);
            if (!account || account.revision !== value.revision) continue;
            const source = sourceFor(account, { ...value.message, reference: value.reference });
            if (source.id !== item.key) fail('configuration_error');
            const existing = queue.get(source.id);
            // A current Inbox observation takes precedence over a queued folder reference that may have moved.
            queue.set(source.id, { account, source: existing?.source || source, descriptors: existing?.descriptors?.length ? existing.descriptors : [{}], classifiedInvoice: true, queued: value });
            queued++;
          }
        }
      }
      context.job.phase = 'processing';
      for (const { account, source, descriptors, classifiedInvoice, queued } of queue.values()) {
        await processSource(context, account, source, descriptors, classifiedInvoice);
        if (queued) {
          check(context, account);
          const saved = stateOf(store.read()), durable = saved.sources[source.id];
          // Transient reviews and waiting-Drive entries are retried from the original ledger after handoff.
          const recorded = durable?.recordIds?.length && durable.recordIds.every(id => STATES.has(saved.records[id]?.status));
          if (recorded && JSON.stringify(index.get('invoiceQueue', source.id)) === JSON.stringify(queued)) index.remove('invoiceQueue', source.id);
        }
      }
      checkAll(context); context.job.status = 'completed';
    } catch (caught) {
      context.job.status = closed || (context.controller.signal.aborted && context.controller.signal.reason?.code !== 'invoice_timeout') ? 'cancelled' : 'failed';
      error(context, caught.code);
    } finally {
      clearTimeout(context.deadline);
      context.job.phase = 'complete'; context.job.finishedAt = time(); lastRun = publicJob(context.job);
      if (!closed && !context.controller.signal.aborted) {
        try {
          await store.update(data => {
            checkAll(context, data);
            const state = stateOf(data); state.lastRun = publicJob(context.job); data.invoiceFiling = state;
          });
        } catch { /* A disconnected account or closing app cannot write a late job snapshot. */ }
      }
    }
  }
  function start(input = {}) {
    if (closed || active || configurationWrites.size) fail('busy');
    if (!object(input) || Object.keys(input).some(key => key !== 'limit')) fail('invalid_request');
    const limit = input.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('invalid_request');
    clearTimeout(timer); timer = null;
    const selected = accounts.list().filter(account => account.connected).map(account => accounts.get(account.id)).sort((a, b) => a.id.localeCompare(b.id));
    if (selected.length > MAX_ACCOUNTS) fail('configuration_error');
    const job = { id: randomBytes(16).toString('hex'), status: 'running', phase: 'scanning', startedAt: time(), finishedAt: null, limit,
      scanned: 0, processed: 0, filed: 0, duplicates: 0, needsReview: 0, waitingDrive: 0, notInvoices: 0, scanComplete: false, errors: [] };
    const context = { job, invoiceConfig: invoiceSettings({ entities: stateOf(store.read()).settings.entities ?? [] }), accounts: selected, controller: new AbortController(), tagged: new Set(), promise: null };
    context.deadline = setTimeout(() => context.controller.abort(new MailHarborError('invoice_timeout')), JOB_DEADLINE);
    context.deadline.unref?.();
    active = context;
    context.promise = Promise.resolve().then(() => run(context)).finally(() => { if (active === context) active = null; schedule(); });
    return { job: publicJob(job) };
  }
  function status() {
    const state = stateOf(store.read()), records = Object.values(state.records);
    const counts = { filed: 0, duplicates: 0, needsReview: 0, waitingDrive: 0, notInvoices: 0 };
    for (const record of records) {
      const key = { filed: 'filed', duplicate: 'duplicates', needs_review: 'needsReview', waiting_drive: 'waitingDrive', not_invoice: 'notInvoices' }[record.status];
      if (key) counts[key]++;
    }
    if (index) counts.queued = index.count('invoiceQueue');
    return { enabled: state.settings.enabled, entities: invoiceSettings({ entities: state.settings.entities ?? [] }).entities, intervalMinutes: 20, running: Boolean(active), job: active ? publicJob(active.job) : null,
      lastRun: publicJob(lastRun || state.lastRun), counts, recent: records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 50).map(publicRecord) };
  }
  schedule();
  return {
    status, start, enqueue,
    async configure(input) {
      if (closed) fail('busy');
      if (!object(input) || !Object.keys(input).length || Object.keys(input).some(key => !['enabled', 'entities'].includes(key)) || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) fail('invalid_request');
      if (input.entities !== undefined && active) fail('busy');
      let entities;
      try { if (input.entities !== undefined) entities = invoiceSettings({ entities: input.entities }).entities; }
      catch { fail('invalid_request'); }
      const operation = store.update(data => {
        check(); const state = stateOf(data);
        if (input.enabled !== undefined) state.settings.enabled = input.enabled;
        if (entities !== undefined && JSON.stringify(state.settings.entities ?? []) !== JSON.stringify(entities)) {
          state.settings.entities = entities;
          for (const record of Object.values(state.records)) {
            if (record.status === 'needs_review' && record.reasons?.some(reason => ['missing_customer_identity', 'unknown_customer_vat', 'customer_identity_conflict', 'ambiguous_customer_identity'].includes(reason))) record.reasons = ['business_configuration_changed'];
          }
        }
        data.invoiceFiling = state;
      });
      configurationWrites.add(operation);
      try { await operation; schedule(); return status(); }
      finally { configurationWrites.delete(operation); }
    },
    async close() {
      closed = true; clearTimeout(timer); timer = null;
      active?.controller.abort(new MailHarborError('cancelled'));
      await Promise.allSettled([active?.promise, ...configurationWrites]);
    }
  };
}
