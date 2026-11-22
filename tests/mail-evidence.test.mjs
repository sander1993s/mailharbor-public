import test from 'node:test';
import assert from 'node:assert/strict';
import { compactMailEvidence, EVIDENCE_VERSION } from '../server/mail-evidence.mjs';

const mail = (body, complete = true) => ({ body, complete, subject: 'Untrusted subject', author: 'sender@example.test' });
const filler = length => 'A long general discussion without special keywords. '.repeat(Math.ceil(length / 51)).slice(0, length);
const checkBound = (result, maxCharacters) => {
  assert.ok(result.body.length <= maxCharacters, `${result.body.length} exceeds ${maxCharacters}`);
  assert.equal(result.inputCharacters, result.body.length);
  assert.equal(result.version, EVIDENCE_VERSION);
};

test('short complete messages lose whitespace only and preserve all substantive evidence', () => {
  const body = '  Hello,\r\n\r\n\r\nYour\t invoice is paid.  \n   Thank you!  ';
  const source = mail(body);
  const result = compactMailEvidence(source);
  assert.equal(result.body, 'Hello,\n\nYour invoice is paid.\nThank you!');
  assert.equal(result.body.replace(/\s/gu, ''), body.replace(/\s/gu, ''));
  assert.equal(result.complete, true);
  assert.equal(result.omitted, false);
  assert.equal(result.sourceCharacters, body.length);
  assert.equal(source.body, body);
  checkBound(result, 2000);
});

test('compaction never upgrades an originally incomplete message', () => {
  for (const body of ['', 'Receipt for the order.', filler(7000)]) {
    const result = compactMailEvidence(mail(body, false));
    assert.equal(result.complete, false);
    assert.equal(result.omitted, body.length > 2000);
  }
});

test('an invoice and explicit payment deadline buried after newsletter text survive', () => {
  const invoice = 'Invoice INV-491: €143.20 payment due date 2026-10-24. Your order has been paid.';
  const body = `Hello subscriber, here is our weekly news.\n\n${filler(6100)}\n\n${invoice}\n\n${filler(800)}`;
  const result = compactMailEvidence(mail(body));
  assert.ok(result.body.startsWith('Hello subscriber,'));
  assert.ok(result.body.includes(invoice));
  assert.ok(result.body.includes('[…]'));
  assert.equal(result.complete, false);
  assert.equal(result.omitted, true);
  checkBound(result, 2000);
});

test('quoted replies containing invoices stay eligible even after a signature', () => {
  const quoted = '> Original message: Factuur 82 is betaald op 12/10/2026. Bewaar dit betalingsbewijs.';
  const body = `Thanks!\nBest regards,\nSome Person\n\n${filler(4900)}\nOn Monday someone wrote:\n${quoted}\n${filler(1300)}`;
  const result = compactMailEvidence(mail(body));
  assert.ok(result.body.includes(quoted));
  assert.equal(result.complete, false);
  checkBound(result, 2000);
});

test('Dutch and French deadlines, appointments and orders retain their source text in source order', () => {
  const dutch = 'Uw bestelling is bevestigd. Afspraak op 15 oktober 2026 van 14:00 tot 15:00.';
  const french = 'Votre facture est jointe. Rendez-vous le 16 octobre 2026 de 09:00 à 10:00. Échéance: 2026-10-20.';
  const tender = "Appel d’offres: date limite 2026-11-10. Offerte indienen uiterlijk 2026-11-10.";
  const body = `${filler(2400)}\n${dutch}\n${filler(1200)}\n${french}\n${filler(1300)}\n${tender}\n${filler(400)}`;
  const result = compactMailEvidence(mail(body));
  for (const text of [dutch, french, tender]) assert.ok(result.body.includes(text), text);
  assert.ok(result.body.indexOf(dutch) < result.body.indexOf(french));
  assert.ok(result.body.indexOf(french) < result.body.indexOf(tender));
  assert.equal(result.complete, false);
  checkBound(result, 2000);
});

test('unrecognized content and repeated footer omissions are always marked incomplete', () => {
  const repeated = ('An ordinary human sentence.\n\nRegards, Example Person\nhttps://example.test/track/1234567890\n\n').repeat(65);
  for (const body of [filler(7000), repeated]) {
    const result = compactMailEvidence(mail(body));
    assert.equal(result.complete, false);
    assert.equal(result.omitted, true);
    assert.ok(result.body.includes('[…]'));
    assert.ok(result.body.length < body.length / 2);
    checkBound(result, 2000);
  }
});

test('whitespace reduction alone can fit a long body without claiming omission', () => {
  const body = ' Hello' + ' '.repeat(4000) + 'world.\n\n\n';
  assert.deepEqual(compactMailEvidence(mail(body)), { body: 'Hello world.', complete: true,
    omitted: false, sourceCharacters: body.length, inputCharacters: 12, version: EVIDENCE_VERSION });
});

test('bounds include gap markers and excerpts never split Unicode surrogate pairs', () => {
  const body = `${'😀🧪'.repeat(850)}\nInvoice 😀 for €50 due 2026-10-23.\n${'😀🧪'.repeat(850)}`;
  for (const maxCharacters of [0, 1, 2, 3, 4, 7, 23, 24, 25, 64, 127, 500, 1000, 2000, 7999, 8000]) {
    const result = compactMailEvidence(mail(body), { maxCharacters });
    checkBound(result, maxCharacters);
    assert.equal(result.body.isWellFormed(), true);
    assert.equal(result.complete, body.length <= maxCharacters);
    assert.equal(result.omitted, body.length > maxCharacters);
  }
});

test('unknown content omitted next to recognized evidence cannot become complete', () => {
  const body = `Invoice reminder.\n${'Unrecognized potentially important context. '.repeat(130)}\nPayment €10 is due on 2026-11-01.`;
  const result = compactMailEvidence(mail(body));
  assert.ok(result.body.includes('Payment €10 is due on 2026-11-01.'));
  assert.equal(result.complete, false);
  assert.equal(result.omitted, true);
});

test('accented French deadline words retain context even without a numeric date', () => {
  const evidence = 'Échéance demain à midi. Cette proposition reste ouverte jusque-là.';
  const body = `${filler(5900)}\n${evidence}\n${filler(600)}`;
  const result = compactMailEvidence(mail(body));
  assert.ok(result.body.includes(evidence));
  assert.equal(result.complete, false);
  assert.equal(result.omitted, true);
});

test('dense adversarial keyword repetition cannot defeat the character cap', () => {
  const body = 'Invoice order payment appointment €12 expires 2026-10-31. '.repeat(130);
  for (const maxCharacters of [24, 150, 500, 1000, 2000]) {
    const result = compactMailEvidence(mail(body), { maxCharacters });
    checkBound(result, maxCharacters);
    assert.equal(result.complete, false);
    assert.equal(result.omitted, true);
  }
});

test('selection is deterministic and all non-marker characters come from ordered source passages', () => {
  const body = `${filler(1800)}\nInvoice 99 due 2026-12-01.\n${filler(2100)}\nAppointment 2026-12-04 09:00 to 10:00.\n${filler(1400)}`;
  const first = compactMailEvidence(mail(body));
  assert.deepEqual(first, compactMailEvidence(mail(body)));
  let cursor = 0;
  for (const passage of first.body.split('[…]').map(value => value.trim()).filter(Boolean)) {
    const found = body.indexOf(passage, cursor);
    assert.ok(found >= cursor, passage);
    cursor = found + passage.length;
  }
});

test('invalid output budgets fail explicitly', () => {
  for (const maxCharacters of [-1, 1.5, NaN, Infinity, '2000', null]) {
    assert.throws(() => compactMailEvidence(mail('hello'), { maxCharacters }), RangeError);
  }
});
