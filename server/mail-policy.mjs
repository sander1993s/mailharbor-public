import { MailHarborError, errorMessages } from './validation.mjs';

export const MAIL_CATEGORIES = Object.freeze([
  ['coupons', 'Promotions / Coupons'], ['development', 'Development / GitHub'], ['social', 'Social'],
  ['jobs', 'Jobs'], ['security', 'Security / Account Alerts'], ['travel', 'Travel & Events'],
  ['work', 'Work & Administration'], ['newsletters', 'Newsletters'], ['finance', 'Finance'],
  ['invoices', 'Invoices & Receipts'], ['tenders', 'Tenders'], ['appointments', 'Appointments'], ['orders', 'Orders']
].map(([id, label]) => Object.freeze({ id, label })));
export const CLASSIFICATION_CONFIDENCE = 0.9;
export const DATE_CONFIDENCE = 0.95;
export const JUNK_RESCUE_CONFIDENCE = 0.98;
export const MAIL_POLICY_TIME_ZONE = 'Europe/Brussels';
export const POLICY_VERSION = 1;
export const MAIL_CLASSIFICATION_SCHEMA = Object.freeze({
  version: 2,
  requiredWireFields: Object.freeze(['id', 'labels', 'confidence', 'junk', 'junkConfidence']),
  optionalWireFields: Object.freeze(['dates', 'dateConfidence', 'appointment']),
  dateFields: Object.freeze(['couponExpiry', 'tenderDeadline', 'appointmentStart', 'appointmentEnd']),
  junkValues: Object.freeze(['junk', 'legitimate', 'uncertain']),
  appointmentFields: Object.freeze(['title', 'location']),
  titleLimit: 300, locationLimit: 500, minYear: 1900, maxYear: 2199, futureYears: 20,
  dateSyntax: 'YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss[.SSS]Z or YYYY-MM-DDTHH:mm:ss[.SSS]+/-HH:mm',
  datePattern: /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/u
});
const ids = new Set(MAIL_CATEGORIES.map(category => category.id));
const dateNames = MAIL_CLASSIFICATION_SCHEMA.dateFields;
const day = 86400000;
const fail = (code = 'invalid_request', reason = 'response_shape_invalid') => { throw new MailHarborError(code, errorMessages[code], code === 'invalid_model_output' ? reason : undefined); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exact(value, keys, code = 'invalid_model_output') {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(code);
}
function probability(value) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail('invalid_model_output', 'response_confidence_invalid'); }
function shortText(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid_model_output', 'response_text_invalid');
  return value.trim();
}
function calendarParts(value) {
  const match = MAIL_CLASSIFICATION_SCHEMA.datePattern.exec(value);
  if (!match) return null;
  const [year, month, date] = match.slice(1, 4).map(Number);
  const hour = Number(match[4] ?? 0), minute = Number(match[5] ?? 0), second = Number(match[6] ?? 0);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  if (year < MAIL_CLASSIFICATION_SCHEMA.minYear || year > MAIL_CLASSIFICATION_SCHEMA.maxYear || month < 1 || month > 12 || date < 1 ||
    date > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
  if (match[8] && match[8] !== 'Z') {
    const offsetHour = Number(match[8].slice(1, 3)), offsetMinute = Number(match[8].slice(4));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  return { year, month, date, hour, minute, second, millisecond, dateOnly: !match[4] };
}

/** Strict calendar/offset validation; Date.parse alone accepts impossible dates. */
export function parseMailDate(value) {
  if (typeof value !== 'string' || value.length > 35) return null;
  const parts = calendarParts(value);
  if (!parts) return null;
  return { ...parts, timestamp: parts.dateOnly ? Date.UTC(parts.year, parts.month - 1, parts.date) : Date.parse(value) };
}

/** A timestamp precise to a minute with an explicit zone denotes :00 seconds.
 * Everything else remains untouched and must pass the strict calendar validator. */
export function normalizeMailDate(value) {
  return typeof value === 'string' ? value.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/u, '$1:00$2') : value;
}
const format = new Intl.DateTimeFormat('en-GB', {
  timeZone: MAIL_POLICY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
function localParts(timestamp) {
  const values = Object.fromEntries(format.formatToParts(timestamp).map(part => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), date: Number(values.day), hour: Number(values.hour),
    minute: Number(values.minute), second: Number(values.second), millisecond: ((timestamp % 1000) + 1000) % 1000 };
}
const rawTimestamp = parts => Date.UTC(parts.year, parts.month - 1, parts.date, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, parts.millisecond ?? 0);
function localTimestamp(parts) {
  const raw = rawTimestamp(parts), offsets = new Set();
  for (const delta of [-2 * day, 0, 2 * day]) {
    const sample = raw + delta;
    offsets.add(rawTimestamp(localParts(sample)) - sample);
  }
  const candidates = [...offsets].map(offset => raw - offset);
  const exactMatches = candidates.filter(value => rawTimestamp(localParts(value)) === raw);
  // Use the later occurrence during the autumn clock change; spring gaps move forward.
  if (exactMatches.length) return Math.max(...exactMatches);
  return candidates.filter(value => rawTimestamp(localParts(value)) >= raw)
    .sort((a, b) => rawTimestamp(localParts(a)) - rawTimestamp(localParts(b)))[0];
}
function instant(value, endOfDate = false) {
  const parsed = parseMailDate(value);
  if (!parsed) return null;
  if (!parsed.dateOnly) return parsed.timestamp;
  const adjusted = new Date(parsed.timestamp + (endOfDate ? day : 0));
  return localTimestamp({ year: adjusted.getUTCFullYear(), month: adjusted.getUTCMonth() + 1, date: adjusted.getUTCDate() });
}
function timeValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return instant(value);
}

/** Calendar arithmetic in the user's time zone, with month-end clamping. */
export function addMailCalendarMonths(value, months) {
  const timestamp = timeValue(value);
  if (!Number.isFinite(timestamp) || !Number.isInteger(months) || months < 0 || months > 1200) fail();
  const parts = localParts(timestamp);
  const next = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  parts.year = next.getUTCFullYear(); parts.month = next.getUTCMonth() + 1;
  parts.date = Math.min(parts.date, new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate());
  return new Date(localTimestamp(parts)).toISOString();
}
function addCalendarDays(timestamp, days) {
  const parts = localParts(timestamp);
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.date + days));
  return localTimestamp({ ...parts, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, date: next.getUTCDate() });
}

/** The model proposes data only: its response can never specify mailbox actions. */
export function validateMailClassification(value, expectedIds, { now = Date.now() } = {}) {
  exact(value, ['items']);
  const expected = Array.from(expectedIds ?? []);
  if (!expected.length || expected.length > 100 || new Set(expected).size !== expected.length ||
    expected.some(id => typeof id !== 'string' || !id || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id))) fail();
  if (!Array.isArray(value.items) || value.items.length !== expected.length) fail('invalid_model_output');
  const current = timeValue(now);
  if (!Number.isFinite(current)) fail();
  const maximumDate = new Date(current).getUTCFullYear() + MAIL_CLASSIFICATION_SCHEMA.futureYears;
  const wanted = new Set(expected), found = new Map();
  for (const item of value.items) {
    exact(item, [...MAIL_CLASSIFICATION_SCHEMA.requiredWireFields, ...MAIL_CLASSIFICATION_SCHEMA.optionalWireFields]);
    if (!wanted.has(item.id) || found.has(item.id)) fail('invalid_model_output', 'response_id_mismatch');
    if (!Array.isArray(item.labels) || item.labels.length > ids.size || new Set(item.labels).size !== item.labels.length ||
      item.labels.some(id => !ids.has(id))) fail('invalid_model_output', 'response_labels_invalid');
    probability(item.confidence); probability(item.junkConfidence); probability(item.dateConfidence);
    if (!MAIL_CLASSIFICATION_SCHEMA.junkValues.includes(item.junk)) fail('invalid_model_output', 'response_labels_invalid');
    exact(item.dates, dateNames);
    const dates = {};
    for (const key of dateNames) {
      const date = item.dates[key];
      const parsed = date === null ? null : parseMailDate(date);
      if (date !== null && (!parsed || parsed.year > maximumDate)) fail('invalid_model_output', 'response_date_invalid');
      dates[key] = date;
    }
    if ((dates.couponExpiry !== null && !item.labels.includes('coupons')) ||
      (dates.tenderDeadline !== null && !item.labels.includes('tenders')) ||
      ((dates.appointmentStart !== null || dates.appointmentEnd !== null || item.appointment !== null) && !item.labels.includes('appointments'))) fail('invalid_model_output', 'response_date_label_mismatch');
    if (dates.appointmentEnd !== null && dates.appointmentStart === null) fail('invalid_model_output', 'response_appointment_invalid');
    if (dates.appointmentStart !== null && dates.appointmentEnd !== null) {
      const start = parseMailDate(dates.appointmentStart), end = parseMailDate(dates.appointmentEnd);
      if (start.dateOnly !== end.dateOnly || instant(dates.appointmentEnd, true) <= instant(dates.appointmentStart)) fail('invalid_model_output', 'response_appointment_invalid');
    }
    let appointment = null;
    if (item.appointment !== null) {
      exact(item.appointment, MAIL_CLASSIFICATION_SCHEMA.appointmentFields);
      if (!dates.appointmentStart || !dates.appointmentEnd) fail('invalid_model_output', 'response_appointment_invalid');
      appointment = { title: shortText(item.appointment.title, MAIL_CLASSIFICATION_SCHEMA.titleLimit), location: item.appointment.location === '' ? '' : shortText(item.appointment.location, MAIL_CLASSIFICATION_SCHEMA.locationLimit) };
    }
    found.set(item.id, { id: item.id, labels: [...item.labels], confidence: item.confidence, junk: item.junk,
      junkConfidence: item.junkConfidence, dates, dateConfidence: item.dateConfidence, appointment });
  }
  return { items: expected.map(id => found.get(id)) };
}

export function shouldRescueJunk(classification, { complete = false } = {}) {
  return complete === true && classification?.junk === 'legitimate' &&
    Number.isFinite(classification.junkConfidence) && classification.junkConfidence >= JUNK_RESCUE_CONFIDENCE && classification.junkConfidence <= 1;
}

/** Nothing here mutates mail. Hold decisions are intentionally re-evaluable without AI. */
export function computeMailDisposition({ classification, receivedAt, folderKind = 'other', manualLabels = [], now = Date.now(),
  tenderGraceMonths = null, tenderGraceDays = null, invoiceProtected = false, complete = true } = {}) {
  if (!['inbox', 'sent', 'drafts', 'junk', 'trash', 'archive', 'other'].includes(folderKind) ||
    !Array.isArray(manualLabels) || manualLabels.some(id => !ids.has(id))) fail();
  const labels = [...new Set([...(classification?.labels ?? []), ...manualLabels])];
  if (labels.some(id => !ids.has(id))) fail();
  const hold = reason => ({ action: 'hold', dueAt: null, reason, labels });
  if (folderKind === 'trash') return hold('already_in_trash');
  if (invoiceProtected) return hold('invoice_review_required');
  const current = timeValue(now), received = timeValue(receivedAt);
  if (!Number.isFinite(current)) fail();
  if (!Number.isFinite(received) || received > current) return hold('unknown_message_date');
  if (complete !== true) return hold('incomplete_message');
  const age = (months, action, reason) => ({ deadline: Date.parse(addMailCalendarMonths(received, months)), action, reason });
  const finish = candidates => {
    const deadline = Math.max(...candidates.map(candidate => candidate.deadline));
    const action = candidates.some(candidate => candidate.action === 'archive') ? 'archive' : 'trash';
    const dueAt = new Date(deadline).toISOString();
    if (current < deadline) return { action: 'hold', dueAt, reason: 'retention_not_due', labels };
    if (folderKind === 'archive' && action === 'archive') return { action: 'hold', dueAt, reason: 'already_archived', labels };
    return { action, dueAt, reason: candidates.length > 1 ? 'overlapping_retention' : candidates[0].reason, labels };
  };
  // Draft expiry is the explicit folder rule, independent of its unfinished contents.
  if (folderKind === 'drafts') return finish([age(2, 'trash', 'draft_retention')]);
  if (!classification || !Number.isFinite(classification.confidence) || classification.confidence < CLASSIFICATION_CONFIDENCE ||
    classification.confidence > 1) return hold('classification_uncertain');
  if (folderKind === 'junk') return hold('junk_review_required');
  const candidates = [];
  if (folderKind === 'sent') candidates.push(age(84, 'archive', 'sent_retention'));
  if (!labels.length && !candidates.length) return hold('unclassified');
  const rules = { development: [1, 'trash'], jobs: [1, 'trash'], newsletters: [1, 'trash'], security: [1, 'archive'],
    travel: [24, 'archive'], work: [12, 'archive'], finance: [24, 'archive'], invoices: [84, 'archive'], orders: [84, 'archive'] };
  for (const label of labels) {
    if (rules[label]) { candidates.push(age(...rules[label], `${label}_retention`)); continue; }
    if (label === 'social') { candidates.push({ deadline: addCalendarDays(received, 7), action: 'trash', reason: 'social_retention' }); continue; }
    const dateName = label === 'coupons' ? 'couponExpiry' : label === 'tenders' ? 'tenderDeadline' : 'appointmentEnd';
    const date = classification.dates?.[dateName];
    if (label === 'tenders' && date === null) { candidates.push(age(6, 'archive', 'tender_fallback')); continue; }
    if (!date || !Number.isFinite(classification.dateConfidence) || classification.dateConfidence < DATE_CONFIDENCE || classification.dateConfidence > 1)
      return hold('date_uncertain');
    let deadline = instant(date, true);
    if (!Number.isFinite(deadline)) return hold('date_uncertain');
    if (label === 'tenders') {
      if (tenderGraceMonths === null && tenderGraceDays === null) return hold('tender_grace_unconfirmed');
      if ((tenderGraceMonths !== null && tenderGraceDays !== null) ||
        (tenderGraceMonths !== null && (!Number.isInteger(tenderGraceMonths) || tenderGraceMonths < 0 || tenderGraceMonths > 24)) ||
        (tenderGraceDays !== null && (!Number.isInteger(tenderGraceDays) || tenderGraceDays < 0 || tenderGraceDays > 366))) fail();
      deadline = tenderGraceMonths !== null ? Date.parse(addMailCalendarMonths(deadline, tenderGraceMonths)) : addCalendarDays(deadline, tenderGraceDays);
    }
    candidates.push({ deadline, action: label === 'coupons' ? 'trash' : 'archive', reason: `${label}_expired` });
  }
  return finish(candidates);
}
