import { createHash } from 'node:crypto';
import { MailHarborError, errorMessages } from './validation.mjs';
import { parseMailDate } from './mail-policy.mjs';

const fail = () => { throw new MailHarborError('invalid_request', errorMessages.invalid_request); };
function safeText(value, maximum, { required = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || (required && !value.trim())) fail();
  // Calendar content is inert text. Never emit URL, ATTENDEE, ORGANIZER, ATTACH or VALARM properties.
  return value.replace(/\b(?:https?|ftp|file|data|javascript|mailto|tel):[^\s]*/giu, '[link omitted]')
    .replace(/\\/gu, '\\\\').replace(/\r\n|\r|\n/gu, '\\n').replace(/;/gu, '\\;').replace(/,/gu, '\\,');
}
function fold(line) {
  const pieces = [];
  let current = '', bytes = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 75) { pieces.push(current); current = ' '; bytes = 1; }
    current += character; bytes += size;
  }
  pieces.push(current); return pieces.join('\r\n');
}
const utc = timestamp => new Date(timestamp).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
const dateOnly = timestamp => new Date(timestamp).toISOString().slice(0, 10).replace(/-/gu, '');

/** Explicit download only. All-day end dates are inclusive input and exclusive in ICS. */
export function generateAppointmentIcs({ id, title, start, end, location = '', description = '' } = {}, { now = Date.now() } = {}) {
  if (typeof id !== 'string' || !id || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) fail();
  if (typeof location !== 'string' || typeof description !== 'string') fail();
  const from = parseMailDate(start), to = parseMailDate(end);
  const current = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!from || !to || !Number.isFinite(current) || from.dateOnly !== to.dateOnly ||
    (from.dateOnly ? to.timestamp < from.timestamp : to.timestamp <= from.timestamp)) fail();
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MailHarbor//Appointments//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${createHash('sha256').update(id).digest('hex')}@mailharbor.invalid`, `DTSTAMP:${utc(current)}`];
  if (from.dateOnly) lines.push(`DTSTART;VALUE=DATE:${dateOnly(from.timestamp)}`, `DTEND;VALUE=DATE:${dateOnly(to.timestamp + 86400000)}`);
  else lines.push(`DTSTART:${utc(from.timestamp)}`, `DTEND:${utc(to.timestamp)}`);
  lines.push(`SUMMARY:${safeText(title, 300, { required: true })}`);
  if (location) lines.push(`LOCATION:${safeText(location, 500)}`);
  if (description) lines.push(`DESCRIPTION:${safeText(description, 2000)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
