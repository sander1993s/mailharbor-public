import { TEST_ENTITIES } from './fixtures/invoice-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { calendarQuarter, invoiceDigest, planInvoice as unconfiguredPlanInvoice, safeInvoiceFilename } from '../server/invoices.mjs';
const planInvoice = (input = {}) => unconfiguredPlanInvoice({ ...input, config: { entities: TEST_ENTITIES, ...input.config } });

const PRIMARY = 'BE0000000000';
const SECONDARY = 'BE0000000001';
function document({ vat = PRIMARY, customer = 'MailHarbor Contributors', date = '31/03/2026', number = 'INV-2026-014', heading = 'Invoice', supplierVat = 'BE0999999999', extra = '' } = {}) {
  return `Supplier: Vendor Services\nVAT: ${supplierVat}\n${heading}\nInvoice number: ${number}\n${date ? `Invoice date: ${date}\n` : ''}Due date: 15/04/2026\nBill to:\n${customer}\n${vat ? `VAT: ${vat}\n` : ''}Example street 1\n1000 Brussels\nSubtotal: EUR 100.00\nTotal: EUR 121.00\n${extra}`;
}
const plan = options => planInvoice({ text: document(options), filename: 'original.pdf' });

test('strict invoice dates route each quarter and year boundary without date rollover', () => {
  for (const [source, date, year, quarter] of [
    ['31/03/2026', '2026-03-31', 2026, 1], ['01/04/2026', '2026-04-01', 2026, 2],
    ['30-06-2026', '2026-06-30', 2026, 2], ['1-7-2026', '2026-07-01', 2026, 3],
    ['30.09.2026', '2026-09-30', 2026, 3], ['01.10.2026', '2026-10-01', 2026, 4],
    ['2026-12-31', '2026-12-31', 2026, 4], ['2027-01-01', '2027-01-01', 2027, 1],
    ['29/02/2024', '2024-02-29', 2024, 1], ['13 september 2026', '2026-09-13', 2026, 3],
    ['1 October 2026', '2026-10-01', 2026, 4], ['4 mei 2026', '2026-05-04', 2026, 2]
  ]) {
    assert.deepEqual(calendarQuarter(source), { date, year, quarter });
    const result = plan({ date: source });
    assert.equal(result.status, 'ready'); assert.equal(result.invoiceDate, date);
    assert.deepEqual(result.folderSegments, ['Invoices', 'Example Studio', String(year), `Q${quarter}`]);
  }
  for (const invalid of ['31/04/2026', '29/02/2025', '29/02/1900', '2026-13-01', '00/01/2026', '01/00/2026', '03/31/2026', '01/04/26', '2026-4-1', '2026-04-01T12:00:00Z', 'next Friday', '01/04-2026']) assert.equal(calendarQuarter(invalid), null);
  assert.deepEqual(calendarQuarter('29/02/2000'), { date: '2000-02-29', year: 2000, quarter: 1 });
});

test('customer VAT selects separate confirmed businesses and accepts common Belgian formatting', () => {
  for (const vat of [PRIMARY, 'BE0000000000', '0000000000', 'BE0000000000']) {
    const result = plan({ vat });
    assert.equal(result.status, 'ready'); assert.equal(result.entity, 'sole_trader');
    assert.deepEqual(result.folderSegments, ['Invoices', 'Example Studio', '2026', 'Q1']);
  }
  const donna = plan({ vat: SECONDARY, customer: 'Example Company', date: '01/04/2026' });
  assert.equal(donna.status, 'ready'); assert.equal(donna.entity, 'example_company');
  assert.deepEqual(donna.folderSegments, ['Invoices', 'Example Company', '2026', 'Q2']);
});

test('seller VAT and mailbox recipient alone never establish the invoice customer', () => {
  const sellerTrap = planInvoice({
    text: document({ supplierVat: PRIMARY, vat: 'BE0123456789', customer: 'Unrelated Customer' }),
    headers: { subject: 'Invoice for Example Studio', to: 'Exampler@example.test', from: 'supplier@example.test' }, filename: `${PRIMARY}-invoice.pdf`
  });
  assert.equal(sellerTrap.status, 'needs_review'); assert.equal(sellerTrap.entity, null);
  assert.ok(sellerTrap.reasons.includes('unknown_customer_vat')); assert.deepEqual(sellerTrap.folderSegments, []);
  const noCustomerVat = planInvoice({ text: document({ supplierVat: SECONDARY, vat: '', customer: 'Example Company' }), headers: { to: 'billing@example_company.example' } });
  assert.equal(noCustomerVat.status, 'needs_review'); assert.ok(noCustomerVat.reasons.includes('missing_customer_identity'));
  const unlabelled = planInvoice({ text: `Invoice\nInvoice number: I-1\nInvoice date: 2026-04-01\nVAT: ${PRIMARY}\nTotal: 121` });
  assert.equal(unlabelled.status, 'needs_review'); assert.equal(unlabelled.entity, null);
  const footer = planInvoice({ text: `Invoice\nInvoice number: I-1\nInvoice date: 2026-04-01\nBill to:\nUnrelated Customer\nExample street\n\nVendor footer\nVAT: ${PRIMARY}\nTotal: 121` });
  assert.equal(footer.status, 'needs_review'); assert.equal(footer.entity, null);
});

test('missing, conflicting, and ambiguous customer identities need review', () => {
  const both = plan({ vat: `${PRIMARY} / ${SECONDARY}`, customer: 'Invoice customer' });
  assert.equal(both.status, 'needs_review'); assert.ok(both.reasons.includes('ambiguous_customer_identity'));
  assert.equal(both.entity, null); assert.deepEqual(both.folderSegments, []);
  const conflict = plan({ vat: PRIMARY, customer: 'ExampleCompany' });
  assert.equal(conflict.status, 'needs_review'); assert.ok(conflict.reasons.includes('customer_identity_conflict'));
  const mixedColumns = planInvoice({ text: `Invoice\nInvoice number: I-1\nInvoice date: 2026-04-01\nSupplier: Vendor Customer: Example Company\nVAT: ${PRIMARY} VAT: ${SECONDARY}\nTotal: 121` });
  assert.equal(mixedColumns.status, 'needs_review'); assert.ok(mixedColumns.reasons.includes('ambiguous_customer_context'));
  const foreignConflict = planInvoice({ text: document(), facts: { customer: { vat: 'NL123456789B01' } } });
  assert.equal(foreignConflict.status, 'needs_review'); assert.ok(foreignConflict.reasons.includes('customer_identity_conflict'));
});

test('invoice date is used instead of due date or email date, and conflicting or missing dates need review', () => {
  const result = planInvoice({ text: document(), headers: { date: '2026-04-15', receivedDate: '2026-04-16T13:20:00Z' } });
  assert.equal(result.status, 'ready'); assert.equal(result.invoiceDate, '2026-03-31'); assert.equal(result.quarter, 1);
  const missing = plan({ date: '' });
  assert.equal(missing.status, 'needs_review'); assert.ok(missing.reasons.includes('missing_invoice_date')); assert.equal(missing.year, null);
  const invalid = plan({ date: '31/04/2026' });
  assert.equal(invalid.status, 'needs_review'); assert.ok(invalid.reasons.includes('invalid_invoice_date'));
  const ambiguous = plan({ extra: 'Invoice date: 2026-04-01' });
  assert.equal(ambiguous.status, 'needs_review'); assert.ok(ambiguous.reasons.includes('ambiguous_invoice_date'));
  const structuredConflict = planInvoice({ text: document(), facts: { invoiceDate: '2026-04-01' } });
  assert.equal(structuredConflict.status, 'needs_review'); assert.ok(structuredConflict.reasons.includes('ambiguous_invoice_date'));
  const repeated = plan({ extra: 'Factuurdatum: 2026-03-31' });
  assert.equal(repeated.status, 'ready');
});

test('Dutch invoices and English or Dutch credit notes require actual document evidence', () => {
  const dutch = planInvoice({ filename: 'factuur.xml', text: `FACTUUR\nFactuurnummer: F2026/001\nFactuurdatum: 13-09-2026\nVervaldatum: 01-10-2026\nKlantgegevens\nExample Company\nBTW-nummer: BE0000000001\nTotaal: € 100,00` });
  assert.equal(dutch.status, 'ready'); assert.equal(dutch.entity, 'example_company'); assert.equal(dutch.invoiceNumber, 'F2026/001'); assert.equal(dutch.quarter, 3);
  for (const [heading, numberLabel, dateLabel] of [['Credit note', 'Credit note number', 'Credit note date'], ['Creditnota', 'Creditnotanummer', 'Creditnotadatum']]) {
    const credit = planInvoice({ text: `${heading}\n${numberLabel}: C2026-001\n${dateLabel}: 01/10/2026\nCustomer VAT: ${PRIMARY}\nTotal: -121.00` });
    assert.equal(credit.status, 'ready'); assert.equal(credit.documentType, 'credit_note'); assert.equal(credit.quarter, 4);
  }
  const headerOnly = planInvoice({ text: 'Please see the attachment. Thank you.', headers: { subject: 'Invoice I-1 2026-04-01', to: PRIMARY }, filename: 'invoice.pdf' });
  assert.equal(headerOnly.status, 'not_invoice'); assert.deepEqual(headerOnly.reasons, ['no_invoice_evidence']);
  const missingNumber = planInvoice({ text: `Invoice\nInvoice date: 2026-04-01\nCustomer VAT: ${PRIMARY}\nTotal: 121` });
  assert.equal(missingNumber.status, 'needs_review'); assert.ok(missingNumber.reasons.includes('missing_invoice_number'));
});

test('proforma, order confirmations, and payment requests do not become invoices from embedded invoice references', () => {
  for (const [heading, reason] of [
    ['Proforma invoice INV-001', 'proforma_document'], ['Pro forma factuur', 'proforma_document'], ['Pro-forma invoice', 'proforma_document'],
    ['Order confirmation 123', 'order_confirmation_document'], ['Orderbevestiging', 'order_confirmation_document'], ['Bestelbevestiging #123', 'order_confirmation_document'],
    ['Payment request', 'payment_request_document'], ['Betalingsverzoek 123', 'payment_request_document'], ['Betaalverzoek', 'payment_request_document']
  ]) {
    const result = plan({ heading });
    assert.equal(result.status, 'not_invoice', heading); assert.deepEqual(result.reasons, [reason]); assert.deepEqual(result.folderSegments, []);
  }
  assert.equal(planInvoice({ text: `${'Supplier address line\n'.repeat(30)}${document({ heading: 'Proforma invoice' })}` }).status, 'not_invoice');
});

test('structured XML facts separate supplier and customer and cannot override conflicting document evidence', () => {
  const facts = { documentType: 'invoice', invoiceNumber: 'UBL-1', invoiceDate: '2026-04-01', total: 'EUR 121.00', supplier: { vat: PRIMARY, name: 'Supplier' }, customer: { vat: SECONDARY, name: 'Example Company' } };
  const result = planInvoice({ facts, filename: 'original.xml' });
  assert.equal(result.status, 'ready'); assert.equal(result.entity, 'example_company'); assert.equal(result.invoiceDate, '2026-04-01');
  const noCustomer = planInvoice({ facts: { ...facts, customer: {} } });
  assert.equal(noCustomer.status, 'needs_review'); assert.equal(noCustomer.entity, null);
  const proforma = planInvoice({ facts, text: 'Proforma invoice' });
  assert.equal(proforma.status, 'not_invoice');
  const before = structuredClone(facts); planInvoice({ facts }); assert.deepEqual(facts, before);
});

test('received-date filing is explicit and does not silently activate for invoices missing a date', () => {
  const text = document({ date: '' });
  const headers = { date: '2026-03-31', receivedDate: '2026-04-01T09:30:00+02:00' };
  assert.equal(planInvoice({ text, headers }).status, 'needs_review');
  const received = planInvoice({ text, headers, config: { dateBasis: 'receivedDate' } });
  assert.equal(received.status, 'ready'); assert.equal(received.invoiceDate, null); assert.equal(received.routingDate, '2026-04-01'); assert.equal(received.quarter, 2);
  assert.ok(received.reasons.includes('received_date_used'));
  const missing = planInvoice({ text: document(), headers: { date: '2026-04-01' }, config: { dateBasis: 'receivedDate' } });
  assert.equal(missing.status, 'needs_review'); assert.ok(missing.reasons.includes('missing_received_date'));
});

test('exact configured customer names only replace VAT matching when that entity has no VAT configured', () => {
  const config = { entities: [
    { id: 'sole_trader', label: 'Example Studio', vat: PRIMARY },
    { id: 'example_company', label: 'Example Company', names: ['ExampleCompany', 'Example Company'] }
  ] };
  const ready = planInvoice({ text: document({ vat: '', customer: 'Example Company' }), config });
  assert.equal(ready.status, 'ready'); assert.equal(ready.entity, 'example_company');
  assert.ok(ready.reasons.includes('customer_name_match'));
  const notExact = planInvoice({ text: document({ vat: '', customer: 'Example Company supplier team' }), config });
  assert.equal(notExact.status, 'needs_review');
  assert.equal(planInvoice({ text: document({ vat: '', customer: 'Example Company' }) }).status, 'needs_review');
});

test('deduplication hashes original bytes across filenames and byte-array views', () => {
  const bytes = Buffer.from('%PDF-1.7\noriginal invoice bytes\n');
  const expected = createHash('sha256').update(bytes).digest('hex');
  assert.equal(invoiceDigest(bytes), expected);
  const surrounding = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
  const view = new Uint8Array(surrounding.buffer, surrounding.byteOffset + 6, bytes.length);
  assert.equal(invoiceDigest(view), expected);
  const first = planInvoice({ text: document(), filename: 'invoice.pdf', bytes });
  const second = planInvoice({ text: document({ vat: SECONDARY, customer: 'Example Company' }), filename: 'renamed.pdf', bytes: view });
  assert.equal(first.sha256, second.sha256);
  assert.notEqual(invoiceDigest(Buffer.concat([bytes, Buffer.from('x')])), expected);
  assert.throws(() => invoiceDigest('not bytes'), TypeError);
});

test('safe filenames retain extensions and cannot traverse folders or contain Windows control names', () => {
  for (const [input, expected] of [
    ['../../invoice.pdf', 'invoice.pdf'], ['C:\\private\\invoice.xml', 'invoice.xml'], ['../..', 'invoice.pdf'],
    ['..\\CON.pdf', '_CON.pdf'], ['NUL.xml', '_NUL.xml'], ['a\u202Eb\u0000c.pdf', 'abc.pdf'],
    ['  Invoice: 2026/001?.pdf ', '001_.pdf'], ['%2e%2e%2finvoice.pdf', '_2e_2e_2finvoice.pdf'], ['factuur september.xml', 'factuur september.xml']
  ]) assert.equal(safeInvoiceFilename(input), expected);
  const long = safeInvoiceFilename(`${'a'.repeat(500)}.pdf`);
  assert.equal(long.length, 180); assert.ok(long.endsWith('.pdf'));
  for (const input of ['../../invoice.pdf', 'C:\\private\\invoice.xml', '../..', '\u202E../../CON.pdf']) {
    const name = safeInvoiceFilename(input); assert.doesNotMatch(name, /[\\/\p{Cc}\p{Cf}]/u); assert.notEqual(name, '..');
  }
});

test('bounded input and routing configuration reject unsupported values without leaking document text', () => {
  assert.throws(() => planInvoice({ text: 'x'.repeat(256 * 1024 + 1) }), TypeError);
  assert.throws(() => planInvoice({ filename: 'x'.repeat(1025) }), TypeError);
  assert.throws(() => planInvoice({ facts: { invoiceNumber: 'x'.repeat(129) } }), TypeError);
  assert.throws(() => planInvoice({ facts: { documentType: 'guess' } }), TypeError);
  assert.throws(() => planInvoice({ headers: { to: ['not a string'] } }), TypeError);
  assert.throws(() => planInvoice({ config: { dateBasis: 'dueDate' } }), TypeError);
  assert.throws(() => planInvoice({ config: { entities: [
    { id: 'sole_trader', label: '../escape', vat: PRIMARY }, { id: 'example_company', label: 'Example Company', vat: SECONDARY }
  ] } }), TypeError);
});

test('new installations have no invoice destinations until businesses are configured', () => {
  const result = unconfiguredPlanInvoice({ text: document() });
  assert.equal(result.status, 'needs_review'); assert.deepEqual(result.folderSegments, []); assert.equal(result.entity, null);
});

test('arbitrary configured businesses route without fixed entity identities', () => {
  const result = unconfiguredPlanInvoice({ text: document(), config: { entities: [{ id: 'business_3', label: 'Example New Business', vat: PRIMARY }] } });
  assert.equal(result.status, 'ready'); assert.equal(result.entity, 'business_3'); assert.equal(result.folderSegments[1], 'Example New Business');
});
