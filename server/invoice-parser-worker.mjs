import { parentPort, workerData } from 'node:worker_threads';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const MAX_TEXT = 200000;
const scalar = value => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 500) :
  value && !Array.isArray(value) && Object.hasOwn(value, '#text') ? scalar(value['#text']) : '';
function party(value) {
  const node = value?.Party;
  if (!node || Array.isArray(node)) return {};
  return { name: scalar(node.PartyLegalEntity?.RegistrationName || node.PartyName?.Name),
    vat: scalar(node.PartyTaxScheme?.CompanyID) };
}

function decodeXml(bytes) {
  // Determine the transport encoding before parsing the declaration. Decode only
  // a view of the worker copy; the original attachment remains unchanged.
  let encoding = 'utf-8', bom = 0;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) ||
      (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)) throw new Error('Unsupported XML encoding');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bom = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; bom = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; bom = 2; }
  else if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) encoding = 'utf-16le';
  else if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) encoding = 'utf-16be';
  const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bom));
  if (text.startsWith('\uFEFF') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text)) throw new Error('Invalid XML characters');
  const rawDeclaration = /^<\?xml(?:[\x20\t\r\n]|\?>)/iu.test(text) ? /^<\?xml[\s\S]*?\?>/u.exec(text)?.[0] : null;
  let declared;
  if (rawDeclaration !== null) {
    // Attribute order and quoted values are part of the XML declaration syntax.
    const declaration = typeof rawDeclaration === 'string' && /^<\?xml[\x20\t\r\n]+version[\x20\t\r\n]*=[\x20\t\r\n]*(['"])(1\.[01])\1(?:[\x20\t\r\n]+encoding[\x20\t\r\n]*=[\x20\t\r\n]*(['"])([A-Za-z][A-Za-z0-9._-]*)\3)?(?:[\x20\t\r\n]+standalone[\x20\t\r\n]*=[\x20\t\r\n]*(['"])(yes|no)\5)?[\x20\t\r\n]*\?>$/u.exec(rawDeclaration);
    if (!declaration) throw new Error('Invalid XML declaration');
    declared = declaration[4]?.toLowerCase();
  }
  if (declared && !['utf-8', 'utf-16', 'utf-16le', 'utf-16be'].includes(declared)) throw new Error('Unsupported XML encoding');
  if (declared && declared !== encoding && !(declared === 'utf-16' && bom === 2)) throw new Error('Conflicting XML encoding');
  // Without a BOM, UTF-16 must explicitly identify its byte order. Never guess
  // the byte order of an undeclared document or a generic UTF-16 declaration.
  if (encoding !== 'utf-8' && !bom && declared !== encoding) throw new Error('Ambiguous XML encoding');
  return text;
}

async function parse() {
  const bytes = workerData.bytes;
  if (workerData.mimeType === 'application/xml') {
    const text = decodeXml(bytes);
    if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(text) || XMLValidator.validate(text) !== true) throw new Error('Invalid XML');
    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false,
      parseTagValue: false, parseAttributeValue: false, trimValues: true });
    const document = parser.parse(text), type = document.Invoice ? 'invoice' : document.CreditNote ? 'credit_note' : null;
    const node = document.Invoice || document.CreditNote;
    if (!type || !node || Array.isArray(node)) return { text: '', facts: {}, reason: 'unsupported_invoice_xml' };
    const facts = { documentType: type, invoiceNumber: scalar(node.ID), invoiceDate: scalar(node.IssueDate),
      total: scalar(node.LegalMonetaryTotal?.TaxInclusiveAmount || node.LegalMonetaryTotal?.PayableAmount),
      customer: party(node.AccountingCustomerParty), supplier: party(node.AccountingSupplierParty) };
    return { text: '', facts, reason: null };
  }
  if (!Buffer.from(bytes.subarray(0, 8)).toString('ascii').startsWith('%PDF-') ||
      !/%%EOF\s*$/u.test(Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString('latin1').trim())) {
    return { text: '', facts: {}, reason: 'incomplete_or_invalid_pdf' };
  }
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdf.getDocument({ data: bytes, isEvalSupported: false, useWasm: false, useSystemFonts: false,
    disableFontFace: true, stopAtErrors: true, maxImageSize: 1, verbosity: 0 });
  const document = await task.promise;
  try {
    if (document.numPages > 40) return { text: '', facts: {}, reason: 'document_page_limit' };
    let text = '';
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index), content = await page.getTextContent();
      text += content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n';
      page.cleanup();
      if (text.length > MAX_TEXT) return { text: '', facts: {}, reason: 'document_text_limit' };
    }
    return { text, facts: {}, reason: text.trim() ? null : 'document_needs_ocr' };
  } finally { await task.destroy(); }
}
try { parentPort.postMessage(await parse()); }
catch { parentPort.postMessage({ text: '', facts: {}, reason: 'document_parse_failed' }); }
