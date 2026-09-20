import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, closeServer } from './app.mjs';
import { MODEL } from './profile.mjs';
import { VERSION } from './validation.mjs';
import { createWebFactory } from './web-app.mjs';

const configFile = process.env.MAILHARBOR_CONFIG || path.join(os.homedir(), '.config', 'mailharbor', 'config.json');
try {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  if (config.model !== MODEL) throw new Error(`Model must be ${MODEL}.`);
  if (config.host && config.host !== '127.0.0.1') throw new Error('MailHarbor must bind to loopback. Use Tailscale Serve for remote access.');
  const port = config.port ?? 8765;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid listen port.');
  const server = createServer(config, undefined, config.web ? { createWeb: createWebFactory({ ...config.web, stateDir: config.web.stateDir ?? path.join(path.dirname(configFile), 'web') }) } : {});
  server.listen(port, '127.0.0.1', () => process.stdout.write(`MailHarbor ${VERSION} listening on 127.0.0.1:${port}\n`));
  server.on('error', error => { process.stderr.write(`MailHarbor service error: ${error.code || 'startup_error'}\n`); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await closeServer(server); process.exit(0); });
} catch (error) {
  process.stderr.write(`MailHarbor could not start: ${error.message}\n`);
  process.exitCode = 1;
}
