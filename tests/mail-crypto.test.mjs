import test from 'node:test';
import assert from 'node:assert/strict';
import * as openpgp from 'openpgp';
import forge from 'node-forge';
import {decryptMail} from '../server/mail-crypto.mjs';
import {createMailContent} from '../server/mail-content.mjs';

test('OpenPGP decrypts only with a supplied matching key/passphrase and never keeps keys between requests', async () => {
  const generated = await openpgp.generateKey({type:'ecc',curve:'curve25519Legacy',userIDs:[{name:'Test',email:'test@example.com'}],passphrase:'test-secret',format:'armored'});
  const publicKey = await openpgp.readKey({armoredKey:generated.publicKey});
  const plaintext = 'Note: confidential\nFull confidential body';
  const ciphertext = await openpgp.encrypt({message:await openpgp.createMessage({text:plaintext}),encryptionKeys:publicKey});
  const options = {type:'openpgp',bytes:Buffer.from(ciphertext),privateKey:generated.privateKey,passphrase:'test-secret'};
  assert.equal((await decryptMail(options)).toString().replace(/\r\n/gu, '\n'), plaintext);
  await assert.rejects(decryptMail({...options,passphrase:'wrong'}), {code:'encrypted_mail_failed'});
  await assert.rejects(decryptMail({...options,privateKey:''}), {code:'invalid_request'});
  const raw = Buffer.from(`From: sender@example.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${ciphertext}`);
  let sourceCalls = 0, contentCalls = 0;
  // Decoded provider fixture: MIME detection is covered by mail-reader tests.
  const service = createMailContent({reader:{
    source:async () => { sourceCalls++; return raw; },
    content:async () => {
      contentCalls++;
      return {text:'',html:'',headers:'From: sender@example.com',from:[{address:'sender@example.com'}],
        attachments:[],inlineParts:[],complete:true,sanitized:false,
        encrypted:{type:'openpgp',decrypted:false,signatureVerified:false}};
    }
  }});
  const decrypted = await service.read({}, {}, {privateKey:generated.privateKey,passphrase:'test-secret'});
  assert.equal(decrypted.text, plaintext); assert.equal(decrypted.encrypted.decrypted, true);
  assert.equal(decrypted.encrypted.signatureVerified, false); assert.equal(decrypted.from[0].address, 'sender@example.com');
  assert.equal(sourceCalls, 1); assert.equal(contentCalls, 0);
  const fresh = await service.read({}, {});
  assert.equal(fresh.encrypted.type, 'openpgp'); assert.equal(fresh.encrypted.decrypted, false);
  assert.equal(sourceCalls, 1); assert.equal(contentCalls, 1);
  for (const secret of ['test-secret', generated.privateKey, plaintext]) assert.ok(!JSON.stringify(fresh).includes(secret));
});

test('S/MIME decrypts matching RSA recipient using a request-scoped PEM key and certificate', async () => {
  const pair = forge.pki.rsa.generateKeyPair({bits:2048,workers:0});
  const cert = forge.pki.createCertificate(); cert.publicKey = pair.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{name:'commonName',value:'Test'}]); cert.setIssuer([{name:'commonName',value:'Test'}]); cert.sign(pair.privateKey, forge.md.sha256.create());
  const message = forge.pkcs7.createEnvelopedData(); message.addRecipient(cert); message.content = forge.util.createBuffer('Secret S/MIME body', 'utf8'); message.encrypt();
  const bytes = Buffer.from(forge.asn1.toDer(message.toAsn1()).getBytes(), 'binary');
  const options = {type:'smime',bytes,privateKey:forge.pki.privateKeyToPem(pair.privateKey),certificate:forge.pki.certificateToPem(cert)};
  assert.equal((await decryptMail(options)).toString(), 'Secret S/MIME body');
  await assert.rejects(decryptMail({...options,certificate:''}), {code:'encrypted_mail_key_required'});
  await assert.rejects(decryptMail({...options,privateKey:'not a key'}), {code:'encrypted_mail_failed'});
  let sourceCalls = 0, contentCalls = 0;
  // Decoded provider fixture corresponding to the encrypted raw MIME below.
  const service = createMailContent({reader:{
    source:async () => { sourceCalls++; return Buffer.from(`Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"\r\nContent-Transfer-Encoding: base64\r\n\r\n${bytes.toString('base64')}`); },
    content:async () => {
      contentCalls++;
      return {text:'',html:'',headers:'Content-Type: application/pkcs7-mime; smime-type=enveloped-data',
        attachments:[],inlineParts:[],complete:true,sanitized:false,
        encrypted:{type:'smime',decrypted:false,signatureVerified:false}};
    }
  }});
  assert.equal((await service.read({}, {})).encrypted.type, 'smime');
  assert.equal(sourceCalls, 0); assert.equal(contentCalls, 1);
  assert.equal((await service.read({}, {}, options)).text, 'Secret S/MIME body');
  assert.equal(sourceCalls, 1); assert.equal(contentCalls, 1);
  const fresh = await service.read({}, {});
  assert.equal(fresh.encrypted.type, 'smime'); assert.equal(fresh.encrypted.decrypted, false);
  assert.equal(sourceCalls, 1); assert.equal(contentCalls, 2);
  for (const secret of [options.privateKey, 'Secret S/MIME body']) assert.ok(!JSON.stringify(fresh).includes(secret));
});
