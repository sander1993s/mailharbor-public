import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { MailHarborError } from './validation.mjs';

export const MAX_ACCOUNTS = 100;

const endpoint = (host, port = 993, security = 'tls') => ({ host, port, security });
const provider = (id, label, incoming, smtp, extra = {}) => ({ id, provider: id, label, authMethods: ['password'], incoming: endpoint(incoming), smtp: { ...endpoint(smtp, 465), sentCopy: true }, ...extra });

// Provider settings contain no accounts, credentials, or user identities.
export const MAIL_PROVIDERS = Object.freeze([
  provider('google', 'Gmail / Google Workspace', 'imap.gmail.com', 'smtp.gmail.com', { authMethods: ['oauth', 'password'], smtp: { ...endpoint('smtp.gmail.com', 465), sentCopy: false }, help: 'Use OAuth or an app password when your account permits it.', docs: 'https://developers.google.com/workspace/gmail/imap/imap-smtp' }),
  provider('microsoft', 'Outlook.com / Hotmail', 'outlook.office365.com', 'smtp-mail.outlook.com', { authMethods: ['oauth'], smtp: { ...endpoint('smtp-mail.outlook.com', 587, 'starttls'), sentCopy: false }, help: 'Use OAuth. Enable IMAP in Outlook settings.', docs: 'https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com' }),
  provider('microsoft365', 'Microsoft 365 / Exchange Online', 'outlook.office365.com', 'smtp.office365.com', { provider: 'microsoft', authMethods: ['oauth'], smtp: { ...endpoint('smtp.office365.com', 587, 'starttls'), sentCopy: false }, help: 'Use OAuth. Your administrator must permit IMAP and authenticated SMTP.', docs: 'https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth' }),
  provider('yahoo', 'Yahoo Mail', 'imap.mail.yahoo.com', 'smtp.mail.yahoo.com', { help: 'Generate an app password in Yahoo account security.', docs: 'https://help.yahoo.com/kb/SLN4075.html' }),
  provider('aol', 'AOL Mail', 'imap.aol.com', 'smtp.aol.com', { help: 'Generate an app password in AOL account security.', docs: 'https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail' }),
  provider('icloud', 'iCloud Mail', 'imap.mail.me.com', 'smtp.mail.me.com', { smtp: { ...endpoint('smtp.mail.me.com', 587, 'starttls'), sentCopy: true }, help: 'Use an Apple app-specific password. IMAP username can differ from your full SMTP email address.', docs: 'https://support.apple.com/en-us/102525' }),
  provider('fastmail', 'Fastmail', 'imap.fastmail.com', 'smtp.fastmail.com', { help: 'Use a Fastmail app password. Your plan must include IMAP access.', docs: 'https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports' }),
  provider('zoho', 'Zoho Mail', 'imap.zoho.com', 'smtp.zoho.com', { custom: true, help: 'Enable IMAP; use the servers shown in your Zoho account for your region and plan. Use an app password with two-factor authentication.', docs: 'https://www.zoho.com/mail/help/imap-access.html' }),
  provider('zoho-business', 'Zoho Mail business', 'imappro.zoho.com', 'smtppro.zoho.com', { provider: 'zoho', custom: true, help: 'Use the exact regional IMAP and SMTP servers shown in your paid organization account.', docs: 'https://www.zoho.com/mail/help/imap-access.html' }),
  provider('gmx', 'GMX.com', 'imap.gmx.com', 'mail.gmx.com', { help: 'Enable IMAP access. Use an app password if two-factor authentication is enabled.', docs: 'https://support.gmx.com/pop-imap/imap/server.html' }),
  provider('gmx-eu', 'GMX Germany / Europe', 'imap.gmx.net', 'mail.gmx.net', { provider: 'gmx', help: 'Enable IMAP access. Use an app password if two-factor authentication is enabled.', docs: 'https://hilfe.gmx.net/pop-imap/imap/imap-serverdaten.html' }),
  provider('mailcom', 'mail.com', 'imap.mail.com', 'smtp.mail.com', { help: 'An eligible Premium plan and enabled IMAP access are required.', docs: 'https://support.mail.com/premium/imap/index.html' }),
  provider('proton', 'Proton Mail Bridge', '127.0.0.1', '127.0.0.1', { incoming: endpoint('127.0.0.1', 1143, 'starttls'), smtp: { ...endpoint('127.0.0.1', 1025, 'starttls'), sentCopy: false }, custom: true, localBridge: true, help: 'Run Bridge on the MailHarbor server. Use Bridge credentials and its exported TLS certificate, and explicitly allow the local connection.', docs: 'https://proton.me/support/comprehensive-guide-to-bridge-settings' }),
  provider('imap', 'Other IMAP / SMTP', '', '', { custom: true, help: 'Enter the TLS or STARTTLS server settings supplied by your email provider.' })
].map(value => Object.freeze(value)));

const fail = () => { throw new MailHarborError('invalid_request'); };
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(); };
export const isLoopback = host => host === '127.0.0.1' || host === '::1';
export function providerPreset(id) { return MAIL_PROVIDERS.find(value => value.id === id) ?? fail(); }

export function validateEndpoint(value, localBridge = false) {
  if (!value || !text(value.host, 253) || value.host !== value.host.toLowerCase() || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !['tls', 'starttls'].includes(value.security)) fail();
  if (localBridge) { if (!isLoopback(value.host) || value.port < 1024) fail(); }
  else {
    // Literal IP endpoints and local-only names require the explicit Bridge flow.
    if (isIP(value.host) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/u.test(value.host) || /(?:^|\.)(?:localhost|local|internal|home|lan)$/u.test(value.host)) fail();
  }
  return { host: value.host, port: value.port, security: value.security };
}

export function accountDefinition(body) {
  object(body, ['provider', 'email', 'label', 'username', 'incoming', 'smtp', 'allowLocalBridge', 'tlsCertificate']);
  const preset = providerPreset(body.provider);
  if (!text(body.email, 254) || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u.test(body.email) || (body.label !== undefined && !text(body.label, 100)) || (body.username !== undefined && !text(body.username, 254))) fail();
  if (body.allowLocalBridge !== undefined && typeof body.allowLocalBridge !== 'boolean') fail();
  const localBridge = preset.localBridge === true;
  if (localBridge !== (body.allowLocalBridge === true) || (!localBridge && body.tlsCertificate !== undefined)) fail();
  let tlsCertificate;
  if (localBridge) {
    if (typeof body.tlsCertificate !== 'string' || body.tlsCertificate.length > 16384 || !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/u.test(body.tlsCertificate)) fail();
    try { tlsCertificate = new X509Certificate(body.tlsCertificate).toString(); } catch { fail(); }
  }
  if (body.incoming !== undefined) object(body.incoming, ['host', 'port', 'security']);
  if (body.smtp !== undefined) object(body.smtp, ['host', 'port', 'security', 'username', 'sentCopy']);
  const incoming = validateEndpoint({ ...preset.incoming, ...body.incoming }, localBridge);
  const smtp = { ...validateEndpoint({ ...preset.smtp, ...body.smtp }, localBridge), username: body.smtp?.username ?? body.email, sentCopy: body.smtp?.sentCopy ?? preset.smtp.sentCopy };
  if (!text(smtp.username, 254) || typeof smtp.sentCopy !== 'boolean') fail();
  if (!preset.custom && (JSON.stringify(incoming) !== JSON.stringify(preset.incoming) || smtp.host !== preset.smtp.host || smtp.port !== preset.smtp.port || smtp.security !== preset.smtp.security)) fail();
  return { preset: preset.id, provider: preset.provider, email: body.email, label: body.label ?? body.email, username: body.username ?? body.email, host: incoming.host, port: incoming.port, security: incoming.security, smtp, ...(localBridge ? { allowLocalBridge: true, tlsCertificate } : {}) };
}

export function incomingEndpoint(account) {
  const value = validateEndpoint({ host: account.host, port: account.port ?? 993, security: account.security ?? 'tls' }, account.allowLocalBridge === true && account.provider === 'proton');
  if (['google', 'microsoft'].includes(account.provider) && value.host !== providerPreset(account.provider).incoming.host) fail();
  return value;
}

export function smtpEndpoint(account) {
  const preset = MAIL_PROVIDERS.find(item => item.id === (account.preset || account.provider));
  const defaults = preset && preset.id !== 'imap' ? preset.smtp : { host: account.host, port: 587, security: 'starttls', sentCopy: true };
  const value = { ...defaults, ...account.smtp };
  if (['google', 'microsoft'].includes(account.provider) && value.host !== defaults.host) fail();
  if (account.smtp?.port && !account.smtp.security) value.security = value.port === 465 ? 'tls' : 'starttls';
  return { ...value, ...validateEndpoint(value, account.allowLocalBridge === true && account.provider === 'proton') };
}
