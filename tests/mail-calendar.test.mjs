import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAppointmentIcs } from '../server/mail-calendar.mjs';

const event = { id: 'private-message-key', title: 'Consultation', start: '2026-09-14T10:00:00+02:00', end: '2026-09-14T11:00:00+02:00', location: 'Brussels' };
const generate = (overrides = {}) => generateAppointmentIcs({ ...event, ...overrides }, { now: '2026-09-13T12:00:00Z' });
const unfold = value => value.replace(/\r\n /gu, '');

test('calendar download converts explicit time zones to UTC and creates a stable opaque UID', () => {
  const result = generate();
  assert.ok(result.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(result.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n'));
  assert.match(result, /DTSTART:20260914T080000Z\r\nDTEND:20260914T090000Z/u);
  assert.match(result, /DTSTAMP:20260913T120000Z/u);
  assert.equal(result.match(/UID:[^\r]+/u)[0], generate({ title: 'Updated title' }).match(/UID:[^\r]+/u)[0]);
  assert.ok(!result.includes(event.id));
  assert.ok(!result.includes('METHOD:'));
});

test('all-day input uses inclusive final dates and emits an exclusive end date across year boundaries', () => {
  const result = generate({ start: '2026-12-31', end: '2026-12-31' });
  assert.match(result, /DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101/u);
});

test('untrusted appointment text cannot inject calendar properties, invitations, attachments or alarms', () => {
  const result = generate({ title: 'Meeting\r\nATTENDEE:attacker@example.test',
    location: 'Somewhere; room 2, door \\ A',
    description: 'Details\r\nBEGIN:VALARM\r\nACTION:EMAIL\r\nATTACH:https://example.test/payload\r\nEND:VALARM' });
  const logical = unfold(result);
  assert.match(logical, /SUMMARY:Meeting\\nATTENDEE:attacker@example.test\r\n/u);
  assert.match(logical, /LOCATION:Somewhere\\; room 2\\, door \\\\ A\r\n/u);
  assert.ok(!/^ATTENDEE:|^ATTACH:|^BEGIN:VALARM|^ACTION:/mu.test(result));
  assert.ok(!logical.includes('https://'));
  assert.match(logical, /\[link omitted\]/u);
});

test('UTF-8 calendar lines fold at 75 bytes without corrupting Unicode or creating extra properties', () => {
  const title = 'Réunion 🗓️ '.repeat(20);
  const result = generate({ title });
  for (const line of result.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.ok(unfold(result).includes(`SUMMARY:${title}\r\n`));
  assert.equal(result.includes('\ufffd'), false);
});

test('calendar downloads reject missing, reversed, impossible, ambiguous and mixed date formats', () => {
  for (const overrides of [{ end: null }, { end: event.start }, { end: '2026-09-14T09:00:00+02:00' },
    { start: '2026-02-30', end: '2026-03-01' }, { start: '2026-09-14T10:00:00', end: '2026-09-14T11:00:00' },
    { start: '2026-09-14', end: event.end }, { start: '2026-09-15', end: '2026-09-14' },
    { title: 'bad\u0000title' }, { title: '' }, { location: null }, { id: 'unsafe\r\nkey' }]) {
    assert.throws(() => generate(overrides), error => error.code === 'invalid_request');
  }
});
