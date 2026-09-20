import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { validateProfile } from '../server/profile.mjs';

const file = process.env.MAILHARBOR_CONFIG || path.join(os.homedir(), '.config', 'mailharbor', 'config.json');
const config = JSON.parse(await readFile(file, 'utf8'));
const profile = await validateProfile(config);
const cwd = path.join(profile.cwdRoot, 'manual-login');
await mkdir(cwd, { recursive: true, mode: 0o700 });
// SSH_CONNECTION is needed only for the CLI's official manual remote OAuth flow.
const env = { ...profile.env };
for (const key of ['SSH_CONNECTION', 'SSH_TTY', 'TERM']) if (process.env[key]) env[key] = process.env[key];
process.stdout.write('Sign in to Google AI Ultra in Agy, then exit the CLI. MailHarbor never copies OAuth tokens.\n');
const child = spawn(profile.agyPath, ['--remote-control=false', '--new-project', '--sandbox'], { cwd, env, stdio: 'inherit', shell: false });
child.on('error', () => { process.stderr.write('Could not start Agy. Check its installation.\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
