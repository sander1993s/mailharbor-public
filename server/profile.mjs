import { readFile, lstat, realpath, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

export const MODEL = 'gemini-3.8-flash-high';
export const DENIED_ACTIONS = ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'unsandboxed(*)', 'mcp(*)'];
export const SAFE_SETTINGS = {
  enableTelemetry: false, useG1Credits: false, enableTerminalSandbox: true,
  toolPermission: 'request-review', allowNonWorkspaceAccess: false,
  permissions: { allow: [], ask: [], deny: DENIED_ACTIONS },
};
export const SAFE_SHARED = { userSettings: {
  permissionPreset: 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW',
  artifactReviewMode: 'ARTIFACT_REVIEW_MODE_ALWAYS', remoteControlEnabled: false,
  enableTerminalSandbox: true, secureModeEnabled: true, agentEnvironment: 'LOCAL',
  sandboxAllowNetwork: false, enableAdc: false,
  allowAgentAccessNonWorkspaceFiles: false, allowAgentAccessGitignoreFiles: false,
} };

function fail(message) { throw Object.assign(new Error(message), { code: 'configuration_error' }); }
async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function ordinary(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Agy profile requires ordinary files.');
  if (process.platform !== 'win32' && (stat.mode & 0o022)) fail('Agy profile files must not be writable by other users.');
  return stat;
}

async function json(filename) {
  await ordinary(filename);
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function rejectCustomization(dir) {
  for (const name of ['GEMINI.md', 'AGENTS.md', '.agents', '.agent', '_agents', '_agent', 'plugins', 'skills', 'agents', 'hooks']) {
    try {
      const item = await lstat(path.join(dir, name));
      if (item.isDirectory() && (await readdir(path.join(dir, name))).length === 0) continue;
      fail('Unexpected Agy customization in the MailHarbor profile. Use a clean dedicated profile.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function validateProfile(config) {
  try {
    if (config.model && config.model !== MODEL) fail('MailHarbor requires the configured Gemini Flash model.');
    for (const key of ['profileHome', 'workRoot', 'agyPath']) {
      if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) fail(`${key} must be an absolute path.`);
    }
    const profileHome = await realpath(config.profileHome);
    if (path.resolve(config.profileHome) !== profileHome) fail('Profile path must not traverse symlinks.');
    const cliRoot = path.join(profileHome, '.gemini', 'antigravity-cli');
    const marker = await json(path.join(profileHome, '.mailharbor-profile.json'));
    if (marker.version !== 1 || !/^[a-f0-9]{64}$/.test(marker.agySha256)) fail('Initialize the MailHarbor Agy profile first.');
    const settings = await json(path.join(cliRoot, 'settings.json'));
    // Agy 1.1.27's Linux serializer removes false/default options and empty lists
    // on startup. These are the observed zero-value round trips of our setup.
    // Telemetry and sandbox MUST remain explicit. The runner additionally checks
    // the live permission mode before supplying any email on stdin.
    const defaultsOmittedByAgy = { useG1Credits: false, toolPermission: 'request-review', allowNonWorkspaceAccess: false };
    for (const [key, value] of Object.entries(SAFE_SETTINGS)) {
      if (key === 'permissions') continue;
      const effective = Object.hasOwn(settings, key) ? settings[key] : defaultsOmittedByAgy[key];
      if (effective !== value) fail(`Unsafe Agy setting: ${key}.`);
    }
    const allowedSettingKeys = new Set(Object.keys(SAFE_SETTINGS));
    if (Object.keys(settings).some(k => !allowedSettingKeys.has(k))) fail('Unexpected Agy settings; review profile changes before proceeding.');
    const permissions = settings.permissions;
    const allow = permissions && Object.hasOwn(permissions, 'allow') ? permissions.allow : [];
    const ask = permissions && Object.hasOwn(permissions, 'ask') ? permissions.ask : [];
    if (!permissions || !Array.isArray(allow) || allow.length ||
        !Array.isArray(ask) || ask.length ||
        !Array.isArray(permissions.deny) || permissions.deny.length !== DENIED_ACTIONS.length ||
        DENIED_ACTIONS.some(action => !permissions.deny.includes(action))) fail('Agy tool permissions must deny all tool access.');
    const shared = await json(path.join(profileHome, '.gemini', 'config', 'config.json'));
    if (Object.keys(shared).some(k => k !== 'userSettings')) fail('Unexpected shared Agy configuration.');
    for (const [key, value] of Object.entries(SAFE_SHARED.userSettings)) {
      if (shared.userSettings?.[key] !== value) fail(`Unsafe shared Agy setting: ${key}.`);
    }
    const knownShared = new Set([...Object.keys(SAFE_SHARED.userSettings), 'remoteControlHostname']);
    if (Object.keys(shared.userSettings).some(k => !knownShared.has(k))) fail('Unexpected shared Agy settings; review them first.');
    const mcp = await json(path.join(profileHome, '.gemini', 'config', 'mcp_config.json'));
    if (Object.keys(mcp).length !== 0) fail('MailHarbor does not permit Agy MCP connections.');
    for (const dir of [profileHome, path.join(profileHome, '.gemini'), cliRoot, path.join(profileHome, '.gemini', 'config')]) await rejectCustomization(dir);
    await ordinary(config.agyPath);
    const binaryHash = await sha256(config.agyPath);
    if (binaryHash !== marker.agySha256) fail('Agy changed since profile initialization. Review the upgrade and refresh its pin.');
    await mkdir(config.workRoot, { recursive: true, mode: 0o700 });
    const cwdRoot = await realpath(config.workRoot);
    if (path.resolve(config.workRoot) !== cwdRoot) fail('Worker root must not traverse symlinks.');
    for (let parent = cwdRoot; ; parent = path.dirname(parent)) {
      for (const name of ['AGENTS.md', 'GEMINI.md', '.git', '.agents', '.agent', '_agents', '_agent']) {
        try { await lstat(path.join(parent, name)); fail('Worker root has an inherited agent or repository context.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (path.dirname(parent) === parent) break;
    }
    const env = {
      HOME: profileHome, XDG_CONFIG_HOME: path.join(profileHome, '.config'),
      XDG_DATA_HOME: path.join(profileHome, '.local', 'share'),
      XDG_CACHE_HOME: path.join(profileHome, '.cache'),
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    };
    // Pass the current user's Secret Service address, never tokens or API keys.
    for (const key of ['USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return { env, cwdRoot, agyPath: config.agyPath };
  } catch (error) {
    if (error.code === 'configuration_error') throw error;
    fail('Agy profile is missing or invalid. Run MailHarbor profile setup.');
  }
}
