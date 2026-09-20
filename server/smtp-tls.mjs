import { isIP } from 'node:net';
import { isLoopback } from './providers.mjs';

/** Never disable certificate verification, including for a local mail bridge. */
export function smtpTlsOptions(account, host) {
  return { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(!isIP(host) ? { servername: host } : {}),
    ...(account.provider === 'proton' && account.allowLocalBridge === true && isLoopback(host) && account.tlsCertificate ? { ca: account.tlsCertificate } : {}) };
}
