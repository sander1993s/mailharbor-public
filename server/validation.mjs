export const MODEL = 'gemini-3.8-flash-high';
export const VERSION = '0.8.7';
export const MAX_REQUEST_BYTES = 512 * 1024;

// Only these fixed values may cross the API/persistence boundary. Provider text,
// JSON paths, field values and raw replies are deliberately never diagnostics.
export const ERROR_DIAGNOSTICS = Object.freeze({
  stream_json_invalid: 'stream_protocol', stream_event_invalid: 'stream_protocol',
  stream_duplicate_init: 'stream_protocol', stream_after_result: 'stream_protocol',
  stream_tool_attempt: 'stream_protocol', stream_result_invalid: 'stream_protocol',
  stream_permission_event: 'stream_protocol', stream_tool_event: 'stream_protocol',
  stream_tool_step: 'stream_protocol', stream_tool_metadata: 'stream_protocol',
  stream_tool_calls: 'stream_protocol', stream_tool_metadata_invalid: 'stream_protocol',
  stream_output_limit: 'stream_protocol', stream_line_limit: 'stream_protocol',
  stream_event_limit: 'stream_protocol', stream_result_missing: 'stream_protocol',
  response_json_invalid: 'json_parsing', response_json_empty: 'json_parsing',
  response_fence_invalid: 'json_parsing', response_fenced_json_invalid: 'json_parsing',
  response_shape_invalid: 'response_schema',
  response_id_mismatch: 'identity_mismatch', response_labels_invalid: 'response_schema',
  response_confidence_invalid: 'response_schema', response_date_invalid: 'response_schema',
  response_date_label_mismatch: 'response_schema', response_appointment_invalid: 'response_schema',
  response_text_invalid: 'response_schema', cli_timeout: 'timeout',
  cli_start_failed: 'configuration', profile_invalid: 'configuration',
  cli_pipe_failed: 'transport', cli_stderr_limit: 'transport', provider_failure: 'transport',
  provider_quota: 'provider_limits', provider_rate_limit: 'provider_limits', provider_auth: 'authentication'
});

export class MailHarborError extends Error {
  constructor(code, message, reason) {
    super(message); this.name = 'MailHarborError'; this.code = code;
    if (typeof reason === 'string' && Object.hasOwn(ERROR_DIAGNOSTICS, reason)) {
      this.diagnostic = { stage: ERROR_DIAGNOSTICS[reason], reason };
    }
  }
}

export const errorMessages = Object.freeze({
  unauthorized: 'A valid pairing token is required.',
  invalid_request: 'The request does not match the MailHarbor format or limits.',
  busy: 'The queue is full. Try again after existing jobs finish.',
  login_required: 'Your AI connection needs a fresh sign-in. Open Settings → AI connection to reconnect.',
  login_failed: 'AI sign-in could not be verified. Try reconnecting again. If it keeps failing, check the homeserver’s Agy installation and unlocked sign-in keyring.',
  login_expired: 'This sign-in attempt expired. Start reconnecting again to get a new Google sign-in link.',
  login_unavailable: 'Browser sign-in requires a Linux homeserver with Python 3 at /usr/bin/python3 and an unlocked Agy sign-in keyring. Check the server setup or use scripts/login.mjs.',
  quota_exhausted: 'Agy reported a quota or request-rate limit. Processing will wait until the displayed retry time; the cooldown persists across restart.',
  timeout: 'The classification timed out. No automatic retry was made.',
  invalid_model_output: 'The model did not return a complete, safe classification. No mailbox action was authorized.',
  provider_error: 'Agy could not complete the classification. No automatic retry was made.',
  configuration_error: 'The dedicated Agy profile or runtime configuration is not ready.',
  cancelled: 'The job was cancelled.',
  not_found: 'The job or endpoint was not found.',
  mailbox_login_required: 'The mailbox sign-in did not succeed or has expired. Reconnect this account.',
  mailbox_error: 'The mailbox could not be reached. Check its connection and try again.',
  mailbox_timeout: 'The mailbox scan exceeded its time limit. No automatic retry was made.',
  archive_unavailable: 'A safe archive destination is not available for this mailbox. Use Thunderbird to archive this message.',
  delete_unavailable: 'This message cannot be moved safely to Trash. It may already be in Trash, or this mailbox has no unique Trash folder or native move support.',
  attachment_too_large: 'The attachment or combined download exceeds the 100 MiB limit.',
  message_too_large: 'This message exceeds the 160 MiB full-message download limit.',
  move_unavailable: 'The mailbox cannot safely move this message to the selected folder.',
  folder_unavailable: 'This folder is unavailable or cannot be changed.',
  label_unavailable: 'This mailbox cannot apply that provider label.',
  content_too_large: 'The message exceeds the 160 MiB source or 8 MiB rendered-body limit.',
  content_unavailable: 'The full message could not be read. Refresh mail and try again.',
  preview_unavailable: 'Office text previews support DOCX, XLSX and PPTX files up to 25 MiB.',
  encrypted_mail_key_required: 'Choose the private key for this encrypted message.',
  encrypted_mail_failed: 'The message could not be decrypted with this key, passphrase and certificate.',
  encrypted_mail_unsupported: 'This encrypted format is not supported. Download the original to open it in your mail client.',
  smtp_not_configured: 'Set up outgoing mail for this account under Accounts.',
  smtp_login_required: 'Outgoing mail authentication failed. Check its credentials or reconnect the account for sending permission.',
  smtp_error: 'The outgoing mail server could not complete the request.',
  send_uncertain: 'The server may have accepted this message. Check Sent and the original mailbox before sending it again.',
  send_partial: 'Some recipients were rejected. Check the delivery result before retrying.',
  send_history_full: 'The send history has reached its safety limit. Existing delivery records have been preserved.',
  draft_unavailable: 'This draft is unavailable or cannot be safely replaced.',
  draft_partial: 'The new draft was saved, but the older copy could not be removed. Refresh Drafts before editing again.',
  sent_copy_failed: 'The message was sent, but its Sent copy could not be saved. Do not resend it.',
  draft_cleanup_failed: 'The message was sent, but its old draft could not be removed. Do not resend it.',
  notification_unavailable: 'Notifications are unavailable on this browser or push service.',
  telegram_not_configured: 'Configure and verify a Telegram bot and private chat before enabling inquiry notifications.',
  telegram_configuration_error: 'Telegram configuration or notification text is invalid.',
  telegram_authentication_failed: 'Telegram rejected the bot credentials.',
  telegram_forbidden: 'The bot cannot access the configured private chat.',
  telegram_rate_limited: 'Telegram requested a delivery delay.',
  telegram_rejected: 'Telegram rejected the notification request.',
  telegram_unavailable: 'Telegram did not provide a valid acknowledgement.',
  telegram_cancelled: 'Telegram delivery was cancelled before submission.',
  attachment_unavailable: 'This attachment is no longer available. Refresh the message and try again.',
  stale_message: 'This message, account, or mail view changed or expired. Refresh mail or create a new briefing before trying again.',
  tag_limit: 'The saved label index has reached its 10,000-message limit. Remove labels from older messages before adding more.',
  invoice_limit: 'The invoice index has reached its storage limit. Existing invoice records have been preserved.',
  invoice_timeout: 'The invoice scan reached its 15-minute limit. Check its progress and retry from Invoice filing.',
  drive_not_configured: 'Set up Google Drive registration in Accounts → Invoice filing.',
  drive_login_required: 'Connect your private Google Drive in Accounts → Invoice filing.',
  drive_wrong_account: 'Choose your private Google account, personal@example.com, for invoice filing.',
  drive_error: 'Google Drive could not complete this request. Retry from Invoice filing; duplicate uploads are checked.',
  drive_duplicate_ambiguous: 'More than one matching Drive item was found. Review the destination before retrying.',
  oauth_not_configured: 'Configure the Google or Microsoft application registration before connecting this account.',
  oauth_token_transport: 'MailHarbor could not reach the provider to exchange the sign-in code. Try connecting again.',
  oauth_token_response: 'The provider did not return the credentials needed to connect this mailbox. Check the application registration and try again.',
  oauth_invalid_client: 'The provider rejected the application credentials. Check the configured client ID and client secret.',
  oauth_unauthorized_client: 'The application is not authorized for this sign-in flow or account type. Check its provider registration.',
  oauth_invalid_scope: 'The provider rejected the requested mail permissions. Check the application permissions.',
  oauth_invalid_grant: 'The provider rejected the sign-in code or refresh token. Start connecting the account again.',
  oauth_imap_authentication_failed: 'Provider sign-in succeeded, but IMAP authentication was rejected. Check that you selected the correct mailbox and that IMAP access is enabled.',
  oauth_imap_connection_failed: 'Provider sign-in succeeded, but MailHarbor could not verify the IMAP connection. Try connecting again.'
});

export function safeError(error) {
  const code = Object.hasOwn(errorMessages, error?.code) ? error.code : 'provider_error';
  const result = { code, message: errorMessages[code] };
  const reason = error?.diagnostic?.reason;
  if (typeof reason === 'string' && Object.hasOwn(ERROR_DIAGNOSTICS, reason)) {
    result.diagnostic = { stage: ERROR_DIAGNOSTICS[reason], reason };
  }
  // Deadlines are generated by the shared local quota controller. Validate even
  // internal inputs so error messages cannot smuggle arbitrary strings to clients.
  if (code === 'quota_exhausted') {
    const retryAt = error?.retryAt;
    if (typeof retryAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(retryAt) &&
        Number.isFinite(Date.parse(retryAt)) && new Date(retryAt).toISOString() === retryAt) result.retryAt = retryAt;
    if (Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 0 && error.retryAfterMs <= 7 * 86400000) result.retryAfterMs = error.retryAfterMs;
  }
  return result;
}

function fail(code) { throw new MailHarborError(code, errorMessages[code]); }
function record(value, keys, required = keys, code = 'invalid_request') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
}
function text(value, max, code, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(code);
}

export function validateRequest(value) {
  record(value, ['language', 'messages'], ['messages']);
  const language = value.language ?? 'en';
  if (typeof language !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)) fail('invalid_request');
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 40) fail('invalid_request');
  const seen = new Set();
  const messages = value.messages.map(message => {
    record(message, ['id', 'account', 'author', 'subject', 'date', 'body', 'truncated', 'bodyUnavailable']);
    for (const [key, max] of Object.entries({ id: 100, account: 500, author: 500, subject: 500, date: 80, body: 8000 })) {
      text(message[key], max, 'invalid_request', key !== 'id');
    }
    if (seen.has(message.id) || typeof message.truncated !== 'boolean' || typeof message.bodyUnavailable !== 'boolean') fail('invalid_request');
    seen.add(message.id);
    return { ...message };
  });
  return { language, messages };
}

function plainText(value, max) {
  text(value, max, 'invalid_model_output');
  // Results are display-only plain text. Reject markup, links, and code fences.
  if (/<\/?[A-Za-z!][^>]*>|(?:https?|ftp|file|data|javascript):|\bwww\.|```/iu.test(value)) fail('invalid_model_output');
}

export function validateResult(value, request) {
  record(value, ['briefing', 'items'], undefined, 'invalid_model_output');
  plainText(value.briefing, 12000);
  if (!Array.isArray(value.items) || value.items.length !== request.messages.length) fail('invalid_model_output');
  const sources = new Map(request.messages.map(message => [message.id, message]));
  const seen = new Set();
  for (const item of value.items) {
    record(item, ['id', 'summary', 'priority', 'category', 'recommendation', 'reason'], undefined, 'invalid_model_output');
    if (typeof item.id !== 'string' || !sources.has(item.id) || seen.has(item.id)) fail('invalid_model_output');
    seen.add(item.id);
    plainText(item.summary, 1200);
    plainText(item.reason, 500);
    if (!['high', 'normal', 'low'].includes(item.priority) ||
        !['action', 'waiting', 'invoice', 'newsletter', 'notification', 'other'].includes(item.category) ||
        !['keep', 'archive'].includes(item.recommendation)) fail('invalid_model_output');
    const source = sources.get(item.id);
    if ((source.truncated || source.bodyUnavailable) && item.recommendation !== 'keep') fail('invalid_model_output');
  }
  return { briefing: value.briefing, items: value.items.map(item => ({ ...item })) };
}
