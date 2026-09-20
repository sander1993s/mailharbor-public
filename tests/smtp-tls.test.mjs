import test from 'node:test';
import assert from 'node:assert/strict';
import * as tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { smtpTlsOptions, imapTlsOptions } from '../server/smtp-tls.mjs';

test('SMTP uses standard certificate verification without account-specific trust overrides', () => {
  for (const provider of ['google', 'microsoft', 'imap']) {
    assert.deepEqual(smtpTlsOptions({ provider, id: 'arbitrary' }, 'smtp.example.test'), {
      rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'smtp.example.test'
    });
  }
});

test('runtime SMTP certificates preserve default trust and apply only to the saved outgoing host', () => {
  const certificate = tls.rootCertificates[0];
  const account = { provider: 'imap', host: 'mail.example.test', smtp: { host: 'mail.example.test', tlsCaCertificates: [certificate] } };
  const defaults = tls.getCACertificates ? tls.getCACertificates('default') : tls.rootCertificates;
  const before = [...defaults];
  const options = smtpTlsOptions(account, account.smtp.host);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.minVersion, 'TLSv1.2');
  assert.equal(options.servername, account.smtp.host);
  assert.equal(options.checkServerIdentity, undefined);
  assert.equal(options.allowPartialTrustChain, false);
  assert.deepEqual(options.ca.slice(0, before.length), before);
  assert.equal(options.ca.at(-1), new X509Certificate(certificate).toString());
  assert.equal(smtpTlsOptions(account, 'other.example.test').ca, undefined);
  assert.equal(imapTlsOptions(account, account.host).ca, undefined, 'The SMTP chain must not affect IMAP, even on the same hostname.');
  assert.deepEqual(defaults, before, 'The global CA list must remain unchanged.');
  assert.equal(smtpTlsOptions({ ...account, smtp: { tlsCaCertificates: [certificate] } }, account.host).ca, undefined);
});

test('runtime SMTP certificate configuration rejects malformed, oversized and unbounded values', () => {
  for (const certificates of [null, 'certificate', [123], ['invalid certificate'], ['x'.repeat(16385)], Array(9).fill(tls.rootCertificates[0]),
    [tls.rootCertificates[0] + '\nunexpected text after certificate']]) {
    assert.throws(() => smtpTlsOptions({ smtp: { host: 'smtp.example.test', tlsCaCertificates: certificates } }, 'smtp.example.test'), { code: 'smtp_not_configured' });
  }
});

test('a Bridge certificate can be trusted only for an explicitly allowed loopback connection', () => {
  const account = { provider: 'proton', allowLocalBridge: true, tlsCertificate: 'TEST_CA' };
  const options = smtpTlsOptions(account, '127.0.0.1');
  assert.equal(options.ca, 'TEST_CA');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.checkServerIdentity, undefined);
  for (const [value, host] of [[account, 'smtp.example.test'], [{ ...account, allowLocalBridge: false }, '127.0.0.1'], [{ ...account, provider: 'imap' }, '127.0.0.1']]) {
    assert.equal(smtpTlsOptions(value, host).ca, undefined);
  }
});
