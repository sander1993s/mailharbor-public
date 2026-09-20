import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_CATEGORIES, parseMailDate, addMailCalendarMonths, validateMailClassification, computeMailDisposition, shouldRescueJunk } from '../server/mail-policy.mjs';

const now = '2026-09-13T12:00:00.000Z';
const sample = (labels = ['jobs'], overrides = {}) => ({ id: 'mail-1', labels, confidence: 0.99, junk: 'legitimate', junkConfidence: 0.99,
  dates: { couponExpiry: null, tenderDeadline: null, appointmentStart: null, appointmentEnd: null }, dateConfidence: 0.99, appointment: null, ...overrides });
const run = (labels, options = {}) => computeMailDisposition({ classification: sample(labels), receivedAt: '2026-01-01T12:00:00.000Z', now, folderKind: 'inbox', ...options });
const invalidOutput = operation => assert.throws(operation, error => error.code === 'invalid_model_output');

test('all thirteen category IDs are stable and unique', () => {
  assert.deepEqual(MAIL_CATEGORIES.map(item => item.id), ['coupons', 'development', 'social', 'jobs', 'security', 'travel', 'work', 'newsletters', 'finance', 'invoices', 'tenders', 'appointments', 'orders']);
  assert.ok(Object.isFrozen(MAIL_CATEGORIES));
});

test('classification response must cover each requested message exactly once, without executable actions or unknown fields', () => {
  const first = sample(), second = sample(['work'], { id: 'mail-2' });
  const result = validateMailClassification({ items: [second, first] }, ['mail-1', 'mail-2'], { now });
  assert.deepEqual(result.items.map(item => item.id), ['mail-1', 'mail-2']);
  result.items[0].labels.push('invoices');
  assert.deepEqual(first.labels, ['jobs']);
  for (const value of [{ items: [first] }, { items: [first, first] }, { items: [first, { ...second, id: 'other' }] },
    { items: [first, { ...second, action: 'delete' }] }, { items: [first, second], command: 'delete' }]) {
    invalidOutput(() => validateMailClassification(value, ['mail-1', 'mail-2'], { now }));
  }
});

test('classification rejects invented categories, duplicate labels, unsafe confidence, partial date objects, and implausible dates', () => {
  for (const item of [sample(['made-up']), sample(['jobs', 'jobs']), sample(['jobs'], { confidence: NaN }), sample(['jobs'], { confidence: 1.1 }),
    sample(['jobs'], { junk: 'safe' }), sample(['jobs'], { junkConfidence: -1 }), sample(['jobs'], { dates: {} }),
    sample(['coupons'], { dates: { ...sample().dates, couponExpiry: '2026-02-31' } }),
    sample(['coupons'], { dates: { ...sample().dates, couponExpiry: '2090-01-01' } }),
    sample(['jobs'], { dates: { ...sample().dates, couponExpiry: '2026-01-01' } }),
    sample(['appointments'], { appointment: { title: 'Meeting\r\nATTACH:file:secret', location: '' } })]) {
    invalidOutput(() => validateMailClassification({ items: [item] }, ['mail-1'], { now }));
  }
});

test('explicit dates require a valid calendar and timezone; leap days and offsets are supported', () => {
  for (const invalid of ['2026-02-29', '2026-04-31T00:00:00Z', '2026-09-13T25:00:00Z', '2026-09-13T12:00:00',
    '2026-09-13T12:00:00+14:01', '2026-09-13T12:00:00+02:99', '2026-09-13T12:00:60Z', 'September 13, 2026', '2026-9-13']) assert.equal(parseMailDate(invalid), null);
  assert.equal(parseMailDate('2024-02-29').dateOnly, true);
  assert.equal(parseMailDate('2026-09-13T14:00:00+02:00').timestamp, Date.parse(now));
});

test('calendar month and year boundaries clamp month ends instead of overflowing', () => {
  assert.equal(addMailCalendarMonths('2026-01-31T10:15:00Z', 1), '2026-02-28T10:15:00.000Z');
  assert.equal(addMailCalendarMonths('2024-02-29T10:15:00Z', 12), '2025-02-28T10:15:00.000Z');
  assert.equal(addMailCalendarMonths('2024-02-29T10:15:00Z', 84), '2031-02-28T10:15:00.000Z');
});

test('calendar retention preserves Brussels wall-clock time and delays DST gaps and ambiguous times safely', () => {
  assert.equal(addMailCalendarMonths('2026-02-28T10:00:00Z', 2), '2026-04-28T09:00:00.000Z');
  assert.equal(addMailCalendarMonths('2026-01-29T01:30:00Z', 2), '2026-03-29T01:30:00.000Z');
  assert.equal(addMailCalendarMonths('2026-08-25T00:30:00Z', 2), '2026-10-25T01:30:00.000Z');
});

test('each relative category has its required disposition and calendar retention period', () => {
  const expected = { development: [1, 'trash'], social: [0, 'trash'], jobs: [1, 'trash'], security: [1, 'archive'], travel: [24, 'archive'],
    work: [12, 'archive'], newsletters: [1, 'trash'], finance: [24, 'archive'], invoices: [84, 'archive'], orders: [84, 'archive'] };
  for (const [label, [months, action]] of Object.entries(expected)) {
    const receivedAt = '2018-01-01T12:00:00.000Z';
    const result = run([label], { receivedAt });
    assert.equal(result.action, action, label);
    assert.equal(result.dueAt, months ? addMailCalendarMonths(receivedAt, months) : '2018-01-08T12:00:00.000Z', label);
  }
});

test('retention triggers at the precise boundary and never a millisecond earlier', () => {
  const options = { receivedAt: '2026-08-13T12:00:00.000Z' };
  assert.equal(run(['jobs'], { ...options, now: '2026-09-13T11:59:59.999Z' }).action, 'hold');
  assert.equal(run(['jobs'], options).action, 'trash');
});

test('overlapping categories protect the longest duration and archive beats deletion', () => {
  const before = run(['jobs', 'invoices']);
  assert.equal(before.action, 'hold');
  assert.equal(before.dueAt, '2033-01-01T12:00:00.000Z');
  assert.equal(run(['jobs', 'invoices'], { now: '2033-01-01T12:00:00Z' }).action, 'archive');
  assert.equal(run(['jobs', 'security']).action, 'archive');
  assert.equal(run(['jobs'], { manualLabels: ['invoices'] }).dueAt, before.dueAt);
  assert.equal(run(['jobs', 'coupons']).reason, 'date_uncertain');
  assert.equal(run(['jobs'], { invoiceProtected: true }).reason, 'invoice_review_required');
});

test('coupon expiration waits through its full advertised date and requires confident dates', () => {
  const classification = sample(['coupons'], { dates: { ...sample().dates, couponExpiry: '2026-09-13' } });
  assert.equal(run([], { classification, now: '2026-09-13T21:59:59.999Z' }).action, 'hold');
  assert.equal(run([], { classification, now: '2026-09-13T22:00:00Z' }).action, 'trash');
  assert.equal(run([], { classification: { ...classification, dateConfidence: 0.949 } }).reason, 'date_uncertain');
  assert.equal(run(['coupons']).reason, 'date_uncertain');
});

test('known tender deadline requires a confirmed grace policy, while missing deadline uses six calendar months', () => {
  const classification = sample(['tenders'], { dates: { ...sample().dates, tenderDeadline: '2026-01-31' } });
  assert.equal(run([], { classification }).reason, 'tender_grace_unconfirmed');
  assert.equal(run([], { classification, tenderGraceMonths: 2 }).dueAt, '2026-03-31T22:00:00.000Z');
  assert.equal(run([], { classification, tenderGraceDays: 2 }).dueAt, '2026-02-02T23:00:00.000Z');
  assert.equal(run([], { classification, tenderGraceDays: 0 }).dueAt, '2026-01-31T23:00:00.000Z');
  assert.equal(run(['tenders']).dueAt, '2026-07-01T11:00:00.000Z');
  assert.equal(run(['tenders']).action, 'archive');
  assert.throws(() => run([], { classification, tenderGraceMonths: 2, tenderGraceDays: 2 }), error => error.code === 'invalid_request');
});

test('appointment dates must form a coherent interval; an unknown end never authorizes archive', () => {
  const appointment = sample(['appointments'], { dates: { ...sample().dates, appointmentStart: '2026-09-13T12:00:00Z', appointmentEnd: '2026-09-13T13:00:00Z' }, appointment: { title: 'Review', location: '' } });
  assert.equal(run([], { classification: appointment }).action, 'hold');
  assert.equal(run([], { classification: appointment, now: '2026-09-13T13:00:00Z' }).action, 'archive');
  assert.equal(run(['appointments']).reason, 'date_uncertain');
  for (const dates of [{ appointmentStart: null, appointmentEnd: '2026-09-13' },
    { appointmentStart: '2026-09-13T12:00:00Z', appointmentEnd: '2026-09-13T11:00:00Z' },
    { appointmentStart: '2026-09-13', appointmentEnd: '2026-09-13T13:00:00Z' }]) {
    invalidOutput(() => validateMailClassification({ items: [{ ...appointment, dates: { ...sample().dates, ...dates } }] }, ['mail-1'], { now }));
  }
});

test('sent mail receives a seven-year archive floor and drafts have a two-month folder rule', () => {
  assert.equal(run(['jobs'], { folderKind: 'sent' }).dueAt, '2033-01-01T12:00:00.000Z');
  assert.equal(run(['jobs'], { folderKind: 'sent', now: '2033-01-01T12:00:00Z' }).action, 'archive');
  assert.equal(run([], { folderKind: 'sent' }).dueAt, '2033-01-01T12:00:00.000Z');
  assert.equal(run(['invoices'], { folderKind: 'drafts' }).action, 'trash');
  assert.equal(run(['invoices'], { folderKind: 'drafts', invoiceProtected: true }).action, 'hold');
  assert.equal(run(['jobs'], { folderKind: 'drafts', complete: false }).reason, 'incomplete_message');
});

test('missing, future, incomplete and uncertain classifications cannot authorize retention actions', () => {
  for (const options of [{ receivedAt: null }, { receivedAt: 'invalid' }, { receivedAt: '2030-01-01T00:00:00Z' }, { complete: false },
    { classification: null }, { classification: sample(['jobs'], { confidence: 0.89 }) }]) assert.equal(run(['jobs'], options).action, 'hold');
  assert.equal(run([]).reason, 'unclassified');
  assert.equal(run(['jobs'], { folderKind: 'junk' }).reason, 'junk_review_required');
  assert.equal(run(['jobs'], { folderKind: 'trash' }).reason, 'already_in_trash');
  assert.equal(run(['security'], { folderKind: 'archive' }).reason, 'already_archived');
  assert.equal(run(['jobs'], { folderKind: 'archive' }).action, 'trash');
});

test('junk rescue accepts legitimate first-time senders but still requires complete content and very high confidence', () => {
  const classification = sample();
  assert.equal(shouldRescueJunk(classification), false);
  assert.equal(shouldRescueJunk(classification, { complete: true }), true);
  assert.equal(shouldRescueJunk(classification, { complete: true, knownSender: false, authenticated: false }), true);
  assert.equal(shouldRescueJunk(classification, { complete: true, authenticated: true }), true);
  assert.equal(shouldRescueJunk(classification, { complete: true, knownSender: true }), true);
  assert.equal(shouldRescueJunk({ ...classification, junkConfidence: 0.98 }, { complete: true }), true);
  assert.equal(shouldRescueJunk({ ...classification, junkConfidence: 0.979 }, { complete: true, knownSender: true }), false);
  assert.equal(shouldRescueJunk({ ...classification, junk: 'junk' }, { complete: true }), false);
  assert.equal(shouldRescueJunk({ ...classification, junk: 'uncertain' }, { complete: true, authenticated: true }), false);
  assert.equal(shouldRescueJunk({ ...classification, junkConfidence: Infinity }, { complete: true, authenticated: true }), false);
  assert.equal(shouldRescueJunk(classification, { complete: false, authenticated: true }), false);
});
