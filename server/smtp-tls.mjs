import { isIP } from 'node:net';
import * as tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { isLoopback } from './providers.mjs';
import { MailHarborError } from './validation.mjs';

/** Never disable certificate verification, including for a local mail bridge. */
export function imapTlsOptions(account, host) {
  return { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(!isIP(host) ? { servername: host } : {}),
    ...(account.provider === 'proton' && account.allowLocalBridge === true && isLoopback(host) && account.tlsCertificate ? { ca: account.tlsCertificate } : {}) };
}

/** Optional deployment-managed chain certificates apply only to the saved SMTP host. */
export function smtpTlsOptions(account, host) {
  const options = imapTlsOptions(account, host);
  const certificates = account.smtp?.tlsCaCertificates;
  if (account.smtp?.host !== host || certificates === undefined) return options;
  const fail = () => { throw new MailHarborError('smtp_not_configured'); };
  if (!Array.isArray(certificates) || certificates.length > 8) fail();
  const additions = certificates.map(pem => {
    if (typeof pem !== 'string' || pem.length > 16384 || !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/u.test(pem)) fail();
    try { const certificate = new X509Certificate(pem); if (!certificate.ca) fail(); return certificate.toString(); }
    catch { fail(); }
  });
  if (additions.length) {
    const defaults = options.ca ? [options.ca] : tls.getCACertificates ? tls.getCACertificates('default') : tls.rootCertificates;
    options.ca = [...defaults, ...additions];
    options.allowPartialTrustChain = false;
  }
  return options;
}
