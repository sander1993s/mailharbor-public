import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw new Error('Install the user service on Linux.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const node = process.execPath;
if (![root, home, node].every(value => /^[a-zA-Z0-9_./-]+$/.test(value))) throw new Error('Installation paths contain unsupported systemd characters.');
const config = path.join(home, '.config', 'mailharbor', 'config.json');
await readFile(config);
const unitDir = path.join(home, '.config', 'systemd', 'user');
await mkdir(unitDir, { recursive: true });
const unitFile = path.join(unitDir, 'mailharbor.service');
const unit = `[Unit]
Description=MailHarbor private Thunderbird briefing service
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${node} ${root}/server/main.mjs
Environment=MAILHARBOR_CONFIG=${config}
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%U/bus
Environment=XDG_RUNTIME_DIR=/run/user/%U
Restart=on-failure
RestartSec=5
TimeoutStopSec=10
KillMode=control-group
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
try {
  await lstat(unitFile);
  if ((await readFile(unitFile, 'utf8')) !== unit) throw new Error('Existing mailharbor.service differs. Review it before updating.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await writeFile(unitFile, unit, { flag: 'wx', mode: 0o600 });
}
process.stdout.write(`Service prepared: ${unitFile}\nStart with: systemctl --user daemon-reload && systemctl --user enable --now mailharbor.service\n`);
