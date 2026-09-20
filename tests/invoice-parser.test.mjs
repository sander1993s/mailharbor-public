import { TEST_ENTITIES } from './fixtures/invoice-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInvoiceDocument } from '../server/invoice-parser.mjs';
import { planInvoice as unconfiguredPlanInvoice } from '../server/invoices.mjs';
const planInvoice = (input = {}) => unconfiguredPlanInvoice({ ...input, config: { entities: TEST_ENTITIES, ...input.config } });

function textPdf(lines) {
  const stream = `BT /F1 12 Tf 40 760 Td ${lines.map((line, index) => `${index ? '0 -18 Td ' : ''}(${line.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let data = '%PDF-1.4\n', offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(data);
}
test('local parser extracts PDF invoice text without rendering or remote resources', async () => {
  const bytes = textPdf(['Invoice number: INV-123', 'Invoice date: 2026-09-01', 'Bill to:', 'Example Software Solutions', 'VAT BE0000000000', 'Total 120.00 EUR']);
  const result = await extractInvoiceDocument({ bytes, mimeType: 'application/pdf' });
  assert.equal(result.reason, null);
  assert.match(result.text, /INV-123/); assert.match(result.text, /BE0000000000/);
  const plan = planInvoice({ text: result.text, facts: result.facts, bytes, filename: 'original.pdf' });
  assert.equal(plan.status, 'ready'); assert.equal(plan.entity, 'sole_trader');
  assert.equal(plan.invoiceNumber, 'INV-123'); assert.equal(plan.invoiceDate, '2026-09-01');
  assert.deepEqual(plan.folderSegments, ['Invoices', 'Example Studio', '2026', 'Q3']);
});
test('UBL parsing separates customer VAT from supplier VAT and uses issue date rather than due date', async () => {
  const xml = `<?xml version="1.0"?><Invoice xmlns:cbc="urn:cbc" xmlns:cac="urn:cac"><cbc:ID>I-1</cbc:ID><cbc:IssueDate>2026-03-31</cbc:IssueDate><cbc:DueDate>2026-04-30</cbc:DueDate><cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme><cbc:CompanyID>BE0000000000</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty><cac:AccountingCustomerParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Example Company</cbc:RegistrationName></cac:PartyLegalEntity><cac:PartyTaxScheme><cbc:CompanyID>BE0000000001</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingCustomerParty><cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="EUR">99.00</cbc:PayableAmount></cac:LegalMonetaryTotal></Invoice>`;
  const result = await extractInvoiceDocument({ bytes: Buffer.from(xml), mimeType: 'application/xml' });
  assert.equal(result.reason, null);
  assert.equal(result.facts.invoiceDate, '2026-03-31');
  assert.equal(result.facts.customer.vat, 'BE0000000001');
  assert.equal(result.facts.supplier.vat, 'BE0000000000');
});
test('entity declarations, broken PDFs, and documents without text stay for review', async () => {
  const hostile = await extractInvoiceDocument({ bytes: Buffer.from('<!DOCTYPE x [<!ENTITY file SYSTEM "file:///private">]><Invoice>&file;</Invoice>'), mimeType: 'application/xml' });
  assert.equal(hostile.reason, 'document_parse_failed');
  const partial = await extractInvoiceDocument({ bytes: Buffer.from('%PDF-1.4 missing end'), mimeType: 'application/pdf' });
  assert.equal(partial.reason, 'incomplete_or_invalid_pdf');
  const scanned = await extractInvoiceDocument({ bytes: textPdf([]), mimeType: 'application/pdf' });
  assert.equal(scanned.reason, 'document_needs_ocr');
});

function encodedXml(text, encoding, bom = false) {
  const body = Buffer.from(text, encoding === 'utf-8' ? 'utf8' : 'utf16le');
  if (encoding === 'utf-16be') body.swap16();
  const marker = encoding === 'utf-8' ? [0xef, 0xbb, 0xbf] : encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff];
  return bom ? Buffer.concat([Buffer.from(marker), body]) : body;
}

test('UTF-8 and both UTF-16 byte orders parse consistently while original attachment bytes remain intact', async () => {
  const body = '<Invoice><ID>INV-\u00c9123</ID><IssueDate>2026-09-01</IssueDate><AccountingCustomerParty><Party><PartyLegalEntity><RegistrationName>Example Company</RegistrationName></PartyLegalEntity><PartyTaxScheme><CompanyID>BE0000000001</CompanyID></PartyTaxScheme></Party></AccountingCustomerParty><LegalMonetaryTotal><PayableAmount>99.00</PayableAmount></LegalMonetaryTotal></Invoice>';
  for (const [encoding, bom, declaration] of [
    ['utf-8', false, 'UTF-8'], ['utf-8', true, 'UTF-8'],
    ['utf-16le', true, 'UTF-16'], ['utf-16be', true, 'UTF-16'],
    ['utf-16le', false, 'UTF-16LE'], ['utf-16be', false, 'UTF-16BE'],
    ['utf-16le', true, null], ['utf-16be', true, null]
  ]) {
    const bytes = encodedXml((declaration ? `<?xml version="1.0" encoding="${declaration}"?>` : '') + body, encoding, bom);
    const original = Buffer.from(bytes);
    const result = await extractInvoiceDocument({ bytes, mimeType: 'application/xml' });
    assert.equal(result.reason, null, `${encoding}/${bom}/${declaration}`);
    assert.equal(result.facts.invoiceNumber, 'INV-\u00c9123');
    assert.equal(result.facts.customer.vat, 'BE0000000001');
    const plan = planInvoice({ facts: result.facts, bytes, filename: 'original.xml' });
    assert.equal(plan.status, 'ready');
    assert.deepEqual(plan.folderSegments, ['Invoices', 'Example Company', '2026', 'Q3']);
    assert.deepEqual(bytes, original, 'Parsing must not transcode or mutate the original attachment');
  }
});

test('contradictory, unsupported, ambiguous and malformed XML encodings stay for review', async () => {
  const xml = encoding => `<?xml version="1.0" encoding="${encoding}"?><Invoice><ID>I-1</ID></Invoice>`;
  const validUtf16 = encodedXml(xml('UTF-16'), 'utf-16le', true);
  const cases = [
    encodedXml(xml('UTF-16BE'), 'utf-16le', true),
    encodedXml(xml('UTF-8'), 'utf-16be', true),
    encodedXml(xml('UTF-16'), 'utf-8', true),
    encodedXml(xml('UTF-16'), 'utf-16le'),
    encodedXml('<Invoice/>', 'utf-16be'),
    encodedXml(xml('ISO-8859-1'), 'utf-8'),
    Buffer.from([0xff, 0xfe, 0, 0, 0x3c, 0, 0, 0]),
    validUtf16.subarray(0, validUtf16.length - 1),
    Buffer.concat([Buffer.from('<Invoice>'), Buffer.from([0xc3, 0x28]), Buffer.from('</Invoice>')]),
    Buffer.from('<?xml version="1.0" encoding=UTF-8?><Invoice/>'),
    Buffer.from('<?xml version="1.0" encoding="UTF-8" encoding="UTF-16"?><Invoice/>'),
    Buffer.from('<?xml version="1.0"?><Invoice>\u0000</Invoice>'),
    encodedXml('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x [<!ENTITY file SYSTEM "file:///private">]><Invoice>&file;</Invoice>', 'utf-16be', true)
  ];
  for (const bytes of cases) {
    const result = await extractInvoiceDocument({ bytes, mimeType: 'application/xml' });
    assert.equal(result.reason, 'document_parse_failed'); assert.deepEqual(result.facts, {});
  }
});
