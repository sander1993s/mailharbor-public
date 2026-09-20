import { MailHarborError } from './validation.mjs';

export const MAX_DECRYPTED_BYTES = 100 * 1024 * 1024;
const fail = code => { throw new MailHarborError(code); };

/** Credentials live only in the current request. This module performs no I/O. */
export async function decryptMail({type, bytes, privateKey, passphrase = '', certificate = ''}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_DECRYPTED_BYTES ||
      typeof privateKey !== 'string' || !privateKey.trim() || privateKey.length > 256 * 1024 ||
      typeof passphrase !== 'string' || passphrase.length > 4096 ||
      typeof certificate !== 'string' || certificate.length > 256 * 1024) fail('invalid_request');
  if (!['openpgp', 'smime'].includes(type)) fail('encrypted_mail_unsupported');
  try {
    let result;
    if (type === 'openpgp') {
      const pgp = await import('openpgp');
      const config = {maxDecompressedMessageSize: MAX_DECRYPTED_BYTES};
      let key = await pgp.readPrivateKey({armoredKey: privateKey, config});
      if (!key.isDecrypted()) key = await pgp.decryptKey({privateKey: key, passphrase, config});
      const armored = bytes.subarray(0, 100).toString().includes('-----BEGIN PGP MESSAGE-----');
      const message = await pgp.readMessage(armored ? {armoredMessage: bytes.toString('utf8'), config} : {binaryMessage: bytes, config});
      const decrypted = await pgp.decrypt({message, decryptionKeys: key, format: 'binary', config});
      result = Buffer.from(decrypted.data);
      // Detached/embedded signatures are not authenticated without trusted public keys.
      for (const signature of decrypted.signatures ?? []) signature.verified?.catch(() => {});
    } else {
      if (!certificate.trim()) fail('encrypted_mail_key_required');
      const {default: forge} = await import('node-forge');
      const key = /ENCRYPTED/u.test(privateKey) ? forge.pki.decryptRsaPrivateKey(privateKey, passphrase) : forge.pki.privateKeyFromPem(privateKey);
      if (!key) fail('encrypted_mail_failed');
      const cert = forge.pki.certificateFromPem(certificate);
      const message = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(bytes.toString('binary')));
      if (message.type !== forge.pki.oids.envelopedData) fail('encrypted_mail_unsupported');
      const recipient = message.findRecipient(cert);
      if (!recipient) fail('encrypted_mail_failed');
      message.decrypt(recipient, key);
      result = Buffer.from(message.content.getBytes(), 'binary');
    }
    if (result.length > MAX_DECRYPTED_BYTES) fail('content_too_large');
    return result;
  } catch (error) {
    if (error instanceof MailHarborError) throw error;
    // Crypto-library errors may contain key material or attacker-controlled text.
    fail('encrypted_mail_failed');
  }
}
