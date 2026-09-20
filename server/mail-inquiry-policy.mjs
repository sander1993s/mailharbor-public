import { isIP } from 'node:net';

export const INQUIRY_POLICY_VERSION = 2;
const KNOWN_FORM_SENDERS = new Set(['notify@web3forms.com']);

/** No installation inherits another user's trusted delivery route. */
export function normalizeFormTrust(value) {
  if (value === null) return null;
  const keys = ['subject', 'sender', 'envelopeDomain', 'mailboxHost', 'trustedRelayHosts', 'relayAlias', 'relayAddress'];
  const hostname = value => typeof value === 'string' && value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) ||
      typeof value.subject !== 'string' || !value.subject.trim() || value.subject.length > 500 || /[\p{Cc}]/u.test(value.subject) ||
      typeof value.sender !== 'string' || value.sender.length > 320 || email(value.sender) !== value.sender.toLowerCase() ||
      !hostname(value.envelopeDomain) || !hostname(value.mailboxHost) || !Array.isArray(value.trustedRelayHosts) ||
      !value.trustedRelayHosts.length || value.trustedRelayHosts.length > 20 || value.trustedRelayHosts.some(host => !hostname(host)) ||
      (value.relayAlias && !hostname(value.relayAlias)) || (value.relayAddress && !isIP(value.relayAddress)) ||
      Boolean(value.relayAlias) !== Boolean(value.relayAddress)) throw new TypeError('Invalid website form trust configuration.');
  return { subject: value.subject.trim(), sender: value.sender.toLowerCase(), envelopeDomain: value.envelopeDomain.toLowerCase(),
    mailboxHost: value.mailboxHost.toLowerCase(), trustedRelayHosts: [...new Set(value.trustedRelayHosts.map(host => host.toLowerCase()))],
    relayAlias: value.relayAlias?.toLowerCase() || '', relayAddress: value.relayAddress?.toLowerCase() || '' };
}
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** Only newly authored text can supply eligibility evidence. Conservative quote
 * boundaries intentionally hold short replies whose meaning exists in history. */
export function inquiryText(body) {
  if (typeof body !== 'string') return '';
  const lines = body.replace(/\r\n?/gu, '\n').split('\n');
  const kept = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(?:>+|[-_]{2,}\s*(?:Original Message|Oorspronkelijk bericht|Forwarded message)|Begin forwarded message:|On .{1,300}wrote:|Op .{1,300}schreef.{0,100}:|Le .{1,300}écrit\s*:)/iu.test(line)) break;
    if (/^\s*(?:From|Van|De)\s*:/iu.test(line) && lines.slice(index + 1, index + 5).some(next => /^\s*(?:Sent|Verzonden|Date|Datum|To|Aan|Subject|Onderwerp)\s*:/iu.test(next))) break;
    kept.push(line);
  }
  return kept.join('\n').trim().slice(0, 8000);
}

function headersOf(message) {
  const raw = message.rawHeaders ?? message.headers ?? '';
  if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw) > 32768 || controls.test(raw)) return null;
  const fields = [];
  for (const line of raw.replace(/\r\n/gu, '\n').split('\n')) {
    if (!line) break;
    if (/^[ \t]/u.test(line)) {
      if (!fields.length) return null;
      fields.at(-1).value += ' ' + line.trim();
    } else {
      const match = /^([!-9;-~]+):[ \t]*(.*)$/u.exec(line);
      if (!match) return null;
      fields.push({ name: match[1].toLowerCase(), value: match[2] });
    }
  }
  return fields.length ? fields : null;
}
function one(fields, name) {
  const values = fields.filter(field => field.name === name);
  return values.length === 1 ? values[0].value : '';
}
function email(value) {
  const text = String(value ?? '').trim();
  const match = /^(?:[^<>]*<)?([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?:>)?$/iu.exec(text);
  return match?.[1].toLowerCase() ?? null;
}
function receiveBy(value) { return /\bby\s+([a-z0-9.-]+)(?=\s|;|$)/iu.exec(value)?.[1].toLowerCase(); }
function receiveFrom(value) { return /^from\s+([a-z0-9.-]+)(?=\s|$)/iu.exec(value)?.[1].toLowerCase(); }
function peerAddress(value) { return /\[([0-9a-f:.]+)\]/iu.exec(value)?.[1].toLowerCase(); }

/** Headers are ordered as received from the configured IMAP mailbox. Only SPF
 * inserted ABOVE the relay's external-ingress Received boundary is trusted.
 * Sender-added authentication headers below that boundary never authenticate. */
function authenticatedForm(fields, trust) {
  const { mailboxHost, trustedRelayHosts, relayAlias, relayAddress, envelopeDomain } = trust;
  const relays = new Set(trustedRelayHosts.filter(host => typeof host === 'string' && /^[a-z0-9.-]+$/iu.test(host)).map(host => host.toLowerCase()));
  const received = fields.map((field, index) => ({ ...field, index })).filter(field => field.name === 'received');
  let position = 0;
  // A configured route may prepend an LMTP delivery on the mailbox
  // machine. Only this exact local hop may precede the external mailbox receipt.
  while (position < 2 && receiveBy(received[position]?.value ?? '') === mailboxHost &&
      receiveFrom(received[position].value) === mailboxHost && /\bwith\s+LMTP\b/iu.test(received[position].value)) position++;
  const delivery = received[position++];
  if (!delivery || receiveBy(delivery.value) !== mailboxHost || !peerAddress(delivery.value)) return false;
  let relay = receiveFrom(delivery.value);
  if (relay === relayAlias) {
    const helo = /\bhelo=([a-z0-9.-]+)(?=[\s)]|$)/iu.exec(delivery.value)?.[1].toLowerCase();
    if (peerAddress(delivery.value) !== relayAddress || !relays.has(helo)) return false;
    relay = helo;
  } else {
    // A direct relay name also needs its peer name in the mailbox's trace,
    // rather than accepting a bare possibly attacker-chosen EHLO string.
    const peerName = /\(\s*([a-z0-9.-]+)\s+\[/iu.exec(delivery.value)?.[1].toLowerCase();
    if (!relays.has(relay) || peerName !== relay) return false;
  }
  // The relay's local filtering/reinjection hop is trusted only on loopback.
  while (position < received.length && receiveBy(received[position].value) === relay &&
      receiveFrom(received[position].value) === relay && ['127.0.0.1', '::1'].includes(peerAddress(received[position].value))) position++;
  const ingress = received[position];
  if (!ingress || receiveBy(ingress.value) !== relay) return false;
  const auth = fields.slice(0, ingress.index).filter(field => field.name === 'received-spf');
  if (auth.length !== 1) return false;
  const value = auth[0].value;
  const receiver = /\breceiver\s*=\s*"?([a-z0-9.-]+)"?(?=\s|;|$)/iu.exec(value)?.[1].toLowerCase();
  const envelope = /\benvelope-from\s*=\s*"?<?([^;\s">]+)>?"?(?=\s|;|$)/iu.exec(value)?.[1];
  return /^pass\b/iu.test(value) && receiver === relay && email(envelope)?.split('@')[1] === envelopeDomain;
}
function contact(body) {
  const name = /(?:^|\n)\s*(?:name|naam)\s*:\s*([^\n]{1,200})/iu.exec(body)?.[1].trim();
  const address = /(?:^|\n)\s*(?:email|e-mail)\s*:\s*([^\n]{1,320})/iu.exec(body)?.[1];
  const contactEmail = email(address);
  const hasNeed = /(?:^|\n)\s*(?:need|bericht|message|vraag)\s*:\s*\S/iu.test(body);
  return name && contactEmail && hasNeed ? { contactName: name, contactEmail } : null;
}

export function assessInquiry(message, { formTrust = null } = {}) {
  let trust;
  try { trust = normalizeFormTrust(formTrust); } catch { return { action: 'hold', reason: 'form_configuration_invalid', source: 'website_form' }; }
  const fields = headersOf(message);
  const body = inquiryText(message.body);
  const subject = String(message.subject ?? '').trim();
  const author = String(message.author ?? message.from ?? '');
  const formSender = address => KNOWN_FORM_SENDERS.has(address) || Boolean(trust && address === trust.sender);
  const purportedForm = formSender(email(author)) || Boolean(trust && subject === trust.subject) ||
    fields?.some(field => field.name === 'from' && formSender(email(field.value)));
  const source = purportedForm ? 'website_form' : 'direct';
  const outcome = (action, reason, extra = {}) => ({ action, reason, source, ...extra });
  if (/\bMH-FORM-ROUTING-[A-Z0-9-]+\b/iu.test(`${subject}\n${body}`) ||
      /\b(?:routing test|routeringstest|testinzending|test submission)\b/iu.test(`${subject}\n${body}`)) return outcome('skip', 'routing_test');
  if (!fields) return outcome('hold', 'headers_invalid');
  if (message.bodyUnavailable === true || !body || controls.test(body)) return outcome('hold', 'body_unavailable');
  if (purportedForm) {
    if (!trust || one(fields, 'subject') !== trust.subject || subject !== trust.subject ||
        email(one(fields, 'from')) !== trust.sender || !authenticatedForm(fields, trust)) return outcome('hold', 'form_provenance_unverified');
    const details = contact(body);
    if (!details) return outcome('hold', 'form_fields_incomplete');
    return outcome('classify', 'verified_form_channel', details);
  }
  if (fields.some(field => ['list-id', 'list-unsubscribe'].includes(field.name)) ||
      fields.some(field => field.name === 'precedence' && /\b(?:bulk|list|junk)\b/iu.test(field.value))) return outcome('skip', 'list_mail');
  if (fields.some(field => field.name === 'auto-submitted' && !/^no\s*$/iu.test(field.value)) ||
      fields.some(field => field.name === 'return-path' && /^<>\s*$/u.test(field.value)) ||
      fields.some(field => field.name === 'content-type' && /multipart\/report\b/iu.test(field.value)) ||
      /(?:^|[<\s])(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/iu.test(author)) return outcome('skip', 'automated_mail');
  return outcome('classify', 'direct_candidate');
}

export function eligibleInquiry(message, preflight, result, { threshold = 0.9 } = {}) {
  const held = reason => ({ decision: 'held', reason });
  if (preflight?.action === 'skip') return { decision: 'skipped', reason: preflight.reason };
  if (preflight?.action !== 'classify') return held(preflight?.reason ?? 'source_unverified');
  if (!result || result.id !== message.id) return held('classification_missing');
  if (['spam', 'routine'].includes(result.intent)) return { decision: 'skipped', reason: result.intent };
  if (!['inquiry', 'form_submission'].includes(result.intent)) return held('uncertain_intent');
  if (result.intent === 'form_submission' && preflight.source !== 'website_form') return held('form_provenance_unverified');
  if (!Number.isFinite(threshold) || threshold < 0.9 || threshold > 1 || !Number.isFinite(result.confidence) ||
      result.confidence < threshold || result.confidence > 1) return held('low_confidence');
  if (message.truncated || message.bodyUnavailable) return held('incomplete_content');
  if (typeof result.evidence !== 'string' || result.evidence.trim().length < 8 ||
      !inquiryText(message.body).includes(result.evidence)) return held('evidence_unverified');
  if (typeof result.summary !== 'string' || !result.summary.trim()) return held('summary_missing');
  return { decision: 'eligible', reason: preflight.source === 'website_form' ? 'verified_form_submission' : 'direct_inquiry' };
}
