import { mkdir, readFile, writeFile, lstat, readdir, copyFile, chmod, realpath } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { SAFE_SETTINGS, SAFE_SHARED, MODEL } from '../server/profile.mjs';

if (process.platform !== 'linux') throw new Error('Run setup on the Linux homeserver.');
const userHome = os.homedir();
const state = path.join(userHome, '.local', 'share', 'mailharbor');
const configDir = path.join(userHome, '.config', 'mailharbor');
const profileHome = path.join(state, 'agy-home');
const agyPath = await realpath(process.argv[2] || path.join(userHome, '.local', 'bin', 'agy'));
const workRoot = path.join('/tmp', `mailharbor-${process.getuid()}`);
const configPath = path.join(configDir, 'config.json');

async function exists(file) { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function newJson(file, data) { await writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function copyAssets(from, to) {
  if (!(await exists(from))) return;
  const stat = await lstat(from);
  if (stat.isSymbolicLink()) throw new Error('Refusing symlink in Agy runtime assets.');
  if (stat.isDirectory()) {
    await mkdir(to, { mode: 0o700 });
    for (const name of await readdir(from)) await copyAssets(path.join(from, name), path.join(to, name));
  } else if (stat.isFile()) {
    await copyFile(from, to);
    await chmod(to, stat.mode & 0o111 ? 0o700 : 0o600);
  } else throw new Error('Unsupported Agy runtime asset type.');
}

await mkdir(configDir, { recursive: true, mode: 0o700 });
await mkdir(state, { recursive: true, mode: 0o700 });
if (!(await exists(profileHome))) {
  await mkdir(path.join(profileHome, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(profileHome, '.gemini', 'config'), { recursive: true, mode: 0o700 });
  for (const name of ['builtin', 'bin']) await copyAssets(path.join(userHome, '.gemini', 'antigravity-cli', name), path.join(profileHome, '.gemini', 'antigravity-cli', name));
  await newJson(path.join(profileHome, '.gemini', 'antigravity-cli', 'settings.json'), SAFE_SETTINGS);
  await newJson(path.join(profileHome, '.gemini', 'config', 'config.json'), SAFE_SHARED);
  await newJson(path.join(profileHome, '.gemini', 'config', 'mcp_config.json'), {});
  await newJson(path.join(profileHome, '.mailharbor-profile.json'), {
    version: 1, agySha256: createHash('sha256').update(await readFile(agyPath)).digest('hex'), createdAt: new Date().toISOString(),
  });
  process.stdout.write('Created dedicated Agy profile. No credentials or existing settings were copied.\n');
}
if (!(await exists(configPath))) {
  const tokenFile = path.join(configDir, 'pairing-token');
  if (!(await exists(tokenFile))) await writeFile(tokenFile, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
  await newJson(configPath, { host: '127.0.0.1', port: 8765, model: MODEL, agyPath, profileHome, workRoot,
    tokenFile, cooldownFile: path.join(state, 'quota-cooldown.json'), timeoutMs: 120000 });
  process.stdout.write(`Created ${configPath}\nPairing token is stored privately in ${tokenFile}\n`);
}
process.stdout.write('Setup complete. Run scripts/login.mjs interactively to authorize the dedicated Agy profile.\n');
