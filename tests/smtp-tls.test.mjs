import test from 'node:test';
import assert from 'node:assert/strict';
import { smtpTlsOptions } from '../server/smtp-tls.mjs';

test('SMTP uses standard certificate verification without account-specific trust overrides', () => {
  for (const provider of ['google', 'microsoft', 'imap']) {
    assert.deepEqual(smtpTlsOptions({ provider, id: 'arbitrary' }, 'smtp.example.test'), {
      rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'smtp.example.test'
    });
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
