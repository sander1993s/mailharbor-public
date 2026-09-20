import { createHash } from 'node:crypto';
import { MailHarborError } from './validation.mjs';

const MAX_TEXT = 3500;
const ERROR_TEXT = Object.freeze({
  telegram_configuration_error: 'Telegram configuration or notification text is invalid.',
  telegram_authentication_failed: 'Telegram rejected the bot credentials.',
  telegram_forbidden: 'The bot cannot access the configured private chat.',
  telegram_rate_limited: 'Telegram requested a delivery delay.',
  telegram_rejected: 'Telegram rejected the notification request.',
  telegram_unavailable: 'Telegram did not provide a valid acknowledgement.',
  telegram_cancelled: 'Telegram delivery was cancelled before submission.'
});
export const TELEGRAM_ERROR_CODES = Object.freeze(Object.keys(ERROR_TEXT));
function failure(code, uncertain = false, retryAfterMs) {
  return Object.assign(new MailHarborError(code, ERROR_TEXT[code]), { uncertain,
    ...(Number.isSafeInteger(retryAfterMs) ? { retryAfterMs } : {}) });
}
function credentials(token, chatId) {
  const chat = typeof chatId === 'number' && Number.isSafeInteger(chatId) ? String(chatId) : chatId;
  if (typeof token !== 'string' || !/^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,100}$/u.test(token) ||
      typeof chat !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(chat) || !Number.isSafeInteger(Number(chat)) || Number(chat) >= 2 ** 52) {
    throw failure('telegram_configuration_error');
  }
  return { token, chatId: chat };
}
async function boundedJson(response) {
  if (Number(response.headers?.get?.('content-length')) > 65536) throw failure('telegram_unavailable');
  const reader = response.body?.getReader?.();
  if (!reader) throw failure('telegram_unavailable');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) throw failure('telegram_unavailable');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { try { await reader.cancel(); } catch {} }
}

/** Outbound-only Bot API adapter. No update consumer, webhook or model access. */
export function createTelegramSender({ fetcher = fetch, now = Date.now } = {}) {
  const verified = new Map();
  const keyOf = ({ token, chatId }) => createHash('sha256').update(`${token}\0${chatId}`).digest('hex');
  async function request(method, token, payload, signal) {
    if (signal?.aborted) throw failure('telegram_cancelled');
    const sending = method === 'sendMessage';
    let submitted = false;
    try {
      const deadline = AbortSignal.timeout(15000);
      submitted = true;
      const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, deadline]) : deadline
      });
      let body;
      try { body = await boundedJson(response); }
      catch { throw failure('telegram_unavailable', sending); }
      if (response.status === 401 || body?.error_code === 401) throw failure('telegram_authentication_failed');
      if (response.status === 403 || body?.error_code === 403) throw failure('telegram_forbidden');
      if (response.status === 429 || body?.error_code === 429) {
        const seconds = body?.parameters?.retry_after;
        throw failure('telegram_rate_limited', false, Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds * 1000, 86400000) : 60000);
      }
      if (!response.ok || body?.ok !== true || !body.result || typeof body.result !== 'object') {
        if ((response.status >= 400 && response.status < 500) || (body?.error_code >= 400 && body.error_code < 500)) throw failure('telegram_rejected');
        throw failure('telegram_unavailable', sending);
      }
      return body.result;
    } catch (error) {
      if (TELEGRAM_ERROR_CODES.includes(error?.code)) throw error;
      // Fetch errors can contain the credential-bearing URL; never propagate them.
      throw failure('telegram_unavailable', sending && submitted);
    }
  }
  async function verify({ token, chatId, signal }) {
    const destination = credentials(token, chatId);
    const bot = await request('getMe', token, {}, signal);
    if (!Number.isSafeInteger(bot.id) || bot.id <= 0 || bot.is_bot !== true || String(bot.id) !== token.split(':')[0]) throw failure('telegram_configuration_error');
    const chat = await request('getChat', token, { chat_id: destination.chatId }, signal);
    if (chat.type !== 'private' || String(chat.id) !== destination.chatId) throw failure('telegram_configuration_error');
    const result = { botId: bot.id, chatId: destination.chatId, verifiedAt: new Date(now()).toISOString() };
    if (verified.size >= 8) verified.delete(verified.keys().next().value);
    verified.set(keyOf(destination), result);
    return { ...result };
  }
  return {
    verify,
    async send({ token, chatId, text, signal, beforeSend }) {
      const destination = credentials(token, chatId);
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || Buffer.byteLength(text) > MAX_TEXT * 4 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw failure('telegram_configuration_error');
      const identity = verified.get(keyOf(destination)) ?? await verify({ ...destination, signal });
      // Caller rechecks current enabled/account/destination state after any
      // read-only verification awaits. No async boundary precedes submission.
      if (beforeSend !== undefined) {
        if (typeof beforeSend !== 'function') throw failure('telegram_configuration_error');
        const checked = beforeSend();
        if (checked && typeof checked.then === 'function') {
          Promise.resolve(checked).catch(() => {});
          throw failure('telegram_cancelled');
        }
        if (checked === false) throw failure('telegram_cancelled');
      }
      const result = await request('sendMessage', token, { chat_id: destination.chatId, text,
        link_preview_options: { is_disabled: true } }, signal);
      if (!Number.isSafeInteger(result.message_id) || result.message_id <= 0 || result.chat?.type !== 'private' ||
          String(result.chat?.id) !== destination.chatId || (result.from && result.from.id !== identity.botId)) throw failure('telegram_unavailable', true);
      return { messageId: result.message_id, botId: identity.botId };
    }
  };
}

const clipped = (value, max) => {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/[<>`]/gu, '').replace(/\b(?:https?|ftp|file|data|javascript|tg):\S*|\bwww\.\S*/giu, '[link]').replace(/\s+/gu, ' ').trim();
  return text.length <= max ? text : text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
};

/** Only a server-configured origin becomes a link. Every email/model field is
 * displayed as bounded text, with no parse mode or keyboard destinations. */
export function formatInquiryNotification(message, result, { origin, source = 'direct', reference, language = 'nl-BE' } = {}) {
  const dutch = /^nl\b/iu.test(language);
  let link = '';
  if (origin) {
    try {
      const url = new URL(origin);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.origin.length > 250) throw new Error();
      link = url.origin + '/';
    } catch { throw failure('telegram_configuration_error'); }
  }
  const sourceLabel = source === 'website_form' ? (dutch ? 'Websiteformulier' : 'Website form') : (dutch ? 'Directe aanvraag' : 'Direct inquiry');
  const author = message.contactName ? `${message.contactName}${message.contactEmail ? ` (${message.contactEmail})` : ''}` : message.author;
  const lines = [`MailHarbor — ${dutch ? 'Nieuwe aanvraag' : 'New inquiry'}`, clipped(message.account || 'Mailbox', 120), '', sourceLabel,
    `${dutch ? 'Van' : 'From'}: ${clipped(author, 350)}`, `${dutch ? 'Onderwerp' : 'Subject'}: ${clipped(message.subject, 400)}`];
  const received = clipped(message.receivedAt ?? message.date, 80);
  if (received) lines.push(`${dutch ? 'Ontvangen' : 'Received'}: ${received}`);
  lines.push('', clipped(result.summary, 1200));
  if (result.requestedAction) lines.push('', `${dutch ? 'Gevraagde actie' : 'Requested action'}: ${clipped(result.requestedAction, 450)}`);
  if (result.explicitDeadline) lines.push(`${dutch ? 'Vermelde deadline' : 'Stated deadline'}: ${clipped(result.explicitDeadline, 300)}`);
  if (reference) lines.push(`${dutch ? 'Referentie' : 'Reference'}: ${clipped(reference, 80)}`);
  if (link) lines.push('', `MailHarbor: ${link}`);
  const text = lines.join('\n');
  if (text.length > MAX_TEXT) throw failure('telegram_configuration_error');
  return text;
}
