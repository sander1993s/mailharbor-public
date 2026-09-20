import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';
import { MailHarborError } from './validation.mjs';

const clone = value => structuredClone(value);

/** Secrets remain on the server, encrypted at rest with a separately permissioned key. */
export async function createAccountStore(directory) {
  if (!path.isAbsolute(directory)) throw new MailHarborError('configuration_error');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const keyPath = path.join(directory, 'accounts.key');
  const dataPath = path.join(directory, 'accounts.enc');
  try { await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = await readFile(keyPath);
  if (key.length !== 32) throw new MailHarborError('configuration_error');
  if (process.platform !== 'win32') await chmod(keyPath, 0o600);
  let data = { schema: 1, accounts: [], providers: {} };
  try {
    const encrypted = JSON.parse(await readFile(dataPath, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
    decipher.setAAD(Buffer.from('MailHarbor accounts v1'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8'));
    if (data.schema !== 1 || !Array.isArray(data.accounts) || !data.providers) throw new Error('invalid store');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new MailHarborError('configuration_error');
  }
  let pending = Promise.resolve();
  return {
    read() { return clone(data); },
    async update(change) {
      const operation = pending.then(async () => {
        const next = clone(data);
        const result = await change(next);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from('MailHarbor accounts v1'));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
        const temporary = path.join(directory, `accounts.${randomBytes(8).toString('hex')}.tmp`);
        await writeFile(temporary, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, dataPath);
        data = next;
        return result;
      });
      pending = operation.catch(() => {});
      return operation;
    }
  };
}
