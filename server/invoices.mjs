import { createHash } from 'node:crypto';

const MAX_TEXT = 256 * 1024;
const MAX_BYTES = 50 * 1024 * 1024;
const TYPES = new Set(['invoice', 'credit_note', 'proforma', 'order_confirmation', 'payment_request']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new TypeError('Invoice input does not match the supported format or limits.'); };
function bounded(value, maximum, optional = true) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > maximum) invalid();
  return value;
}
const plain = value => value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
const normalizeName = value => plain(value).toLowerCase().replace(/[\s.]+/gu, '');
function canonicalVat(value) {
  const compact = value.toUpperCase().replace(/[\s.\-]/gu, '');
  return /^(?:BE)?\d{10}$/u.test(compact) ? `BE${compact.replace(/^BE/u, '')}` : null;
}
function vatTokens(value, explicit = false) {
  const matches = [];
  const pattern = /\b(?:BE\s*[.\-]?\s*)?\d{4}[\s.\-]?\d{3}[\s.\-]?\d{3}\b/giu;
  const vatLabel = /\b(?:vat|btw|tva|ondernemingsnummer|enterprise\s*(?:number|no)|company\s*(?:registration|number))\b/iu.test(value);
  for (const match of value.matchAll(pattern)) {
    if (!explicit && !vatLabel && !/^BE/iu.test(match[0])) continue;
    const vat = canonicalVat(match[0]);
    if (vat) matches.push(vat);
  }
  return matches;
}

const MONTHS = new Map([
  ['jan', 1], ['januari', 1], ['january', 1], ['feb', 2], ['februari', 2], ['february', 2],
  ['mar', 3], ['mrt', 3], ['maart', 3], ['march', 3], ['apr', 4], ['april', 4], ['mei', 5], ['may', 5],
  ['jun', 6], ['juni', 6], ['june', 6], ['jul', 7], ['juli', 7], ['july', 7], ['aug', 8], ['augustus', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9], ['okt', 10], ['oct', 10], ['oktober', 10], ['october', 10],
  ['nov', 11], ['november', 11], ['dec', 12], ['december', 12]
]);

/** Strict calendar dates: ISO, Dutch day/month/year, or named Dutch/English months. No rollover or due-date inference. */
export function calendarQuarter(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const source = value.trim();
  let year, month, day;
  let parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(source);
  if (parts) [, year, month, day] = parts.map(Number);
  else {
    parts = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/u.exec(source);
    if (parts) { day = Number(parts[1]); month = Number(parts[3]); year = Number(parts[4]); }
    else {
      parts = /^(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})$/iu.exec(source);
      if (!parts) return null;
      day = Number(parts[1]); month = MONTHS.get(parts[2].toLowerCase()); year = Number(parts[3]);
    }
  }
  if (!Number.isInteger(year) || year < 1900 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day)) return null;
  const maximum = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maximum) return null;
  return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, year, quarter: Math.ceil(month / 3) };
}

/** Exact-byte digest. File names, email headers, and byte-array backing buffers do not affect deduplication. */
export function invoiceDigest(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) invalid();
  return createHash('sha256').update(bytes).digest('hex');
}

/** One safe file-name segment, suitable for original PDF/XML uploads and later Windows downloads. */
export function safeInvoiceFilename(value = '', { fallback = 'invoice.pdf' } = {}) {
  bounded(value, 1024, false); bounded(fallback, 180, false);
  const clean = input => plain(input.split(/[\\/]/u).at(-1)).replace(/[<>:"/\\|?*%]/gu, '_').replace(/\s+/gu, ' ').replace(/^[.\s]+|[.\s]+$/gu, '');
  let name = clean(value) || clean(fallback) || 'invoice.pdf';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `_${name}`;
  const extension = /\.[a-z0-9]{1,12}$/iu.exec(name)?.[0] || '';
  if (name.length > 180) name = `${name.slice(0, 180 - extension.length).replace(/[.\s]+$/gu, '')}${extension}`;
  return name;
}

export function invoiceSettings(config = {}) {
  if (!object(config)) invalid();
  const dateBasis = config.dateBasis ?? 'invoiceDate';
  if (!['invoiceDate', 'receivedDate'].includes(dateBasis)) invalid();
  const source = config.entities ?? [];
  if (!Array.isArray(source) || source.length > 20) invalid();
  const entities = source.map(entity => {
    if (!object(entity) || typeof entity.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(entity.id)) invalid();
    const label = bounded(entity.label, 80, false);
    if (!label.trim() || /[\p{Cc}\p{Cf}\\/]/u.test(label) || /^\.+$/u.test(label.trim())) invalid();
    const vat = entity.vat === undefined || entity.vat === null || entity.vat === '' ? null : canonicalVat(bounded(entity.vat, 40, false));
    if (entity.vat && !vat) invalid();
    const names = entity.names ?? [];
    if (!Array.isArray(names) || names.length > 8) invalid();
    return { id: entity.id, label: label.trim(), vat, names: names.map(name => normalizeName(bounded(name, 120, false))) };
  });
  if (new Set(entities.map(entity => entity.id)).size !== entities.length ||
    new Set(entities.map(entity => entity.vat).filter(Boolean)).size !== entities.filter(entity => entity.vat).length) invalid();
  return { dateBasis, entities };
}
function validateFacts(facts) {
  if (!object(facts)) invalid();
  if (facts.documentType !== undefined && !TYPES.has(facts.documentType)) invalid();
  for (const key of ['invoiceNumber', 'invoiceDate', 'receivedDate']) bounded(facts[key], key === 'invoiceNumber' ? 128 : 80);
  for (const role of ['customer', 'supplier']) {
    if (facts[role] === undefined) continue;
    if (!object(facts[role])) invalid();
    bounded(facts[role].name, 200); bounded(facts[role].vat, 100);
  }
  if (facts.total !== undefined && !(typeof facts.total === 'number' && Number.isFinite(facts.total)) &&
    !(typeof facts.total === 'string' && facts.total.length <= 80)) invalid();
}

const INVOICE_NUMBER = /^(?:invoice\s*(?:number|no\.?|nr\.?|#|№)|factuur\s*(?:nummer|nr\.?|no\.?|#|№)|faktuurnummer|credit\s*note\s*(?:number|no\.?|nr\.?|#)|creditnota\s*(?:nummer|nr\.?|#))\s*[:#]?\s*(.*)$/iu;
const INVOICE_DATE = /^(?:invoice\s*date|date\s*of\s*invoice|factuurdatum|faktuurdatum|datum\s*(?:van\s*(?:de\s*)?)?factuur|credit\s*note\s*date|creditnotadatum|datum\s*creditnota)\s*[:\-]?\s*(.*)$/iu;
const CUSTOMER_START = /^(?:bill(?:ed)?\s*to|invoice\s*to|sold\s*to|customer(?:\s*(?:details|information|address))?|client(?:\s*(?:details|address))?|klant(?:gegevens)?|factuuradres|facturatieadres|facturatiegegevens|gefactureerd\s*aan|factuur\s*aan|afnemer|aan)\s*[:\-]\s*(.*)$/iu;
const CUSTOMER_HEADING = /^(?:bill(?:ed)?\s*to|invoice\s*to|sold\s*to|customer|customer details|client|klant|klantgegevens|factuuradres|facturatieadres|facturatiegegevens|afnemer)$/iu;
const CUSTOMER_VAT = /^(?:(?:customer|client|klant|afnemer)\s*(?:vat|btw|tva)(?:[\s-]*(?:id|number|nummer|no\.?|nr\.?))?|(?:vat|btw|tva)(?:[\s-]*(?:id|number|nummer|no\.?|nr\.?))?\s*(?:customer|client|klant|afnemer))\s*[:\-]?\s*(.*)$/iu;
const SUPPLIER_START = /^(?:supplier|seller|vendor|from|verkoper|leverancier|uitgever|factuur\s*van|invoice\s*from)(?:\s*[:\-]\s*|$)/iu;
const SECTION_END = /^(?:invoice\s*(?:date|number|no|nr)|factuur(?:datum|nummer|\s*nr)|due\s*date|vervaldatum|payment|betaling|bank|iban|description|omschrijving|quantity|aantal|subtotal|subtotaal|total|totaal|amount|bedrag|order\s*(?:number|reference)|bestelnummer)\b/iu;
const dateToken = value => /^\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{1,2}\s+[a-z]+\.?\s+\d{4})(?=\s|$|[,;])/iu.exec(value)?.[1] ?? value.trim();

function documentEvidence(lines, facts) {
  let type = facts.documentType ?? null, excluded = null;
  for (const line of lines) {
    if (/^pro[\s-]?forma\b/iu.test(line)) excluded = 'proforma_document';
    if (/^(?:order\s*confirmation|orderbevestiging|bestelbevestiging)\b/iu.test(line)) excluded = 'order_confirmation_document';
    if (/^(?:payment\s*request|betalingsverzoek|betaalverzoek)\b/iu.test(line)) excluded = 'payment_request_document';
  }
  if (type === 'proforma') excluded = 'proforma_document';
  if (type === 'order_confirmation') excluded = 'order_confirmation_document';
  if (type === 'payment_request') excluded = 'payment_request_document';
  if (lines.some(line => /^(?:credit\s*note|creditnota|creditfactuur|credit\s*invoice)(?:\b|[:#])/iu.test(line))) type = 'credit_note';
  else if (!type && lines.some(line => /^(?:(?:tax|btw)\s+)?(?:invoice|factuur|faktuur)(?:\b|[:#])/iu.test(line) || INVOICE_NUMBER.test(line))) type = 'invoice';
  const numbers = facts.invoiceNumber?.trim() ? [plain(facts.invoiceNumber)] : [];
  const dates = facts.invoiceDate?.trim() ? [facts.invoiceDate.trim()] : [];
  for (let position = 0; position < lines.length; position++) {
    const number = INVOICE_NUMBER.exec(lines[position]);
    if (number) {
      const token = /^([\p{L}\p{N}][\p{L}\p{N}._/\-]{0,127})(?=\s|$)/u.exec(number[1].trim() || lines[position + 1] || '')?.[1];
      if (token) numbers.push(token);
    }
    const date = INVOICE_DATE.exec(lines[position]);
    if (date) dates.push(dateToken(date[1] || lines[position + 1] || ''));
  }
  // A generic document date is accepted only in the document header and never from email headers.
  if (!dates.length && ['invoice', 'credit_note'].includes(type)) {
    for (let position = 0; position < Math.min(24, lines.length); position++) {
      const date = /^(?:date|datum)\s*:\s*(.*)$/iu.exec(lines[position]);
      if (date) dates.push(dateToken(date[1] || lines[position + 1] || ''));
    }
  }
  const amount = typeof facts.total === 'number' || (typeof facts.total === 'string' && /\d/u.test(facts.total)) || lines.some(line => /^(?:grand\s*total|total(?:\s*(?:due|amount|incl\.?\s*vat))?|totaal(?:\s*(?:bedrag|te\s*betalen|incl\.?\s*btw))?|amount\s*(?:due|payable)|te\s*betalen)\s*[:€$£\d-]/iu.test(line));
  return { type: ['invoice', 'credit_note'].includes(type) ? type : null, excluded, numbers: [...new Set(numbers)], dates, amount };
}

function customerEvidence(lines, facts) {
  const vats = [], names = [];
  let customer = false, count = 0, ambiguousContext = false, unknownVat = false;
  const collectVat = (value, explicit = false) => {
    const tokens = vatTokens(value, explicit);
    vats.push(...tokens);
    if (!tokens.length && (explicit ? value.trim() : /\b(?:vat|btw|tva)(?:[\s-]*(?:number|nummer|no\.?|nr\.?|id))?\s*:\s*\S/iu.test(value))) unknownVat = true;
  };
  if (facts.customer) {
    if (facts.customer.vat?.trim()) collectVat(facts.customer.vat, true);
    if (facts.customer.name?.trim()) names.push(facts.customer.name);
  }
  for (let position = 0; position < lines.length; position++) {
    const line = lines[position];
    if (!line) { if (customer && count > 0) customer = false; continue; }
    if (/\b(?:supplier|seller|leverancier|verkoper)\s*:/iu.test(line) && /\b(?:customer|client|klant|bill\s*to)\s*:/iu.test(line)) {
      ambiguousContext = true; customer = false; continue;
    }
    const directVat = CUSTOMER_VAT.exec(line);
    if (directVat) { collectVat(directVat[1] || lines[position + 1] || '', true); continue; }
    const start = CUSTOMER_START.exec(line);
    if (start || CUSTOMER_HEADING.test(line)) {
      customer = true; count = 0;
      if (start?.[1]) { names.push(start[1]); collectVat(start[1]); }
      continue;
    }
    if (SUPPLIER_START.test(line) || SECTION_END.test(line) || INVOICE_NUMBER.test(line) || INVOICE_DATE.test(line)) { customer = false; continue; }
    if (customer && ++count <= 12) { names.push(line); collectVat(line); }
    else customer = false;
  }
  return { vats: [...new Set(vats)], names: [...new Set(names.map(normalizeName))], ambiguousContext, unknownVat };
}

function selectDate(values, prefix, reasons) {
  const dates = values.map(calendarQuarter);
  if (!values.length) { reasons.push(`missing_${prefix}_date`); return null; }
  if (dates.some(value => !value)) { reasons.push(`invalid_${prefix}_date`); return null; }
  const unique = [...new Set(dates.map(value => value.date))];
  if (unique.length !== 1) { reasons.push(`ambiguous_${prefix}_date`); return null; }
  return dates[0];
}
function receivedCalendar(value) {
  // An explicitly supplied received timestamp uses its stated calendar date, without timezone guessing.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value))) return value.slice(0, 10);
  return value;
}

/** Pure filing proposal. Only a ready result has destination folders; nothing is uploaded or classified by AI. */
export function planInvoice({ text = '', headers = {}, filename = '', facts = {}, bytes, config = {} } = {}) {
  bounded(text, MAX_TEXT, false); bounded(filename, 1024, false);
  if (!object(headers) || Object.keys(headers).length > 32) invalid();
  for (const value of Object.values(headers)) bounded(value, 4096, false);
  validateFacts(facts);
  const options = invoiceSettings(config);
  const rawLines = text.normalize('NFC').replace(/\r\n?/gu, '\n').split('\n').map(line => line.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim());
  const lines = rawLines.filter(Boolean);
  const evidence = documentEvidence(lines, facts);
  const result = {
    status: 'needs_review', entity: null, documentType: evidence.type, invoiceDate: null, routingDate: null,
    dateBasis: options.dateBasis, year: null, quarter: null, folderSegments: [], reasons: [],
    invoiceNumber: evidence.numbers.length === 1 ? evidence.numbers[0] : null,
    filename: safeInvoiceFilename(filename), sha256: bytes === undefined ? null : invoiceDigest(bytes)
  };
  if (evidence.excluded) return { ...result, status: 'not_invoice', documentType: null, reasons: [evidence.excluded] };
  if (!evidence.type && !evidence.numbers.length) return { ...result, status: 'not_invoice', reasons: ['no_invoice_evidence'] };
  if (!evidence.type) result.reasons.push('insufficient_invoice_evidence');
  if (!evidence.numbers.length) result.reasons.push('missing_invoice_number');
  if (evidence.numbers.length > 1) result.reasons.push('ambiguous_invoice_number');
  if (!evidence.dates.length && !evidence.amount) result.reasons.push('insufficient_invoice_evidence');

  const dateReasons = [], invoiceDate = selectDate(evidence.dates, 'invoice', dateReasons);
  result.invoiceDate = invoiceDate?.date ?? null;
  let routingDate = invoiceDate;
  if (options.dateBasis === 'invoiceDate') result.reasons.push(...dateReasons);
  else {
    const dates = [facts.receivedDate, headers.receivedDate].filter(value => value?.trim()).map(receivedCalendar);
    routingDate = selectDate(dates, 'received', result.reasons);
  }
  if (routingDate) Object.assign(result, { routingDate: routingDate.date, year: routingDate.year, quarter: routingDate.quarter });

  const customer = customerEvidence(rawLines, facts);
  const matched = options.entities.filter(entity => entity.vat && customer.vats.includes(entity.vat));
  const named = options.entities.filter(entity => entity.names.some(name => customer.names.includes(name)));
  if (customer.ambiguousContext) result.reasons.push('ambiguous_customer_context');
  if (customer.unknownVat) result.reasons.push(matched.length ? 'customer_identity_conflict' : 'unknown_customer_vat');
  if (matched.length > 1 || customer.vats.length > 1) result.reasons.push('ambiguous_customer_identity');
  else if (matched.length === 1) {
    if (named.some(entity => entity.id !== matched[0].id)) result.reasons.push('customer_identity_conflict');
    else result.entity = matched[0].id;
  } else if (customer.vats.length) result.reasons.push('unknown_customer_vat');
  else {
    const nameOnly = named.filter(entity => !entity.vat);
    if (nameOnly.length === 1 && named.length === 1) result.entity = nameOnly[0].id;
    else result.reasons.push(named.length > 1 ? 'ambiguous_customer_identity' : 'missing_customer_identity');
  }
  result.reasons = [...new Set(result.reasons)];
  if (!result.reasons.length && result.entity && routingDate) {
    const entity = options.entities.find(value => value.id === result.entity);
    result.status = 'ready';
    result.folderSegments = ['Invoices', entity.label, String(routingDate.year), `Q${routingDate.quarter}`];
    result.reasons = [customer.vats.length ? 'customer_vat_match' : 'customer_name_match', options.dateBasis === 'invoiceDate' ? 'invoice_date_used' : 'received_date_used'];
  }
  return result;
}
