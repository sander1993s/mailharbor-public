import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SAFE_SETTINGS, SAFE_SHARED, validateProfile, MODEL } from '../server/profile.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-profile-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { profileHome: path.join(root, 'profile'), workRoot: path.join(root, 'work'), agyPath: path.join(root, 'fake-binary'), model: MODEL };
  const cli = path.join(config.profileHome, '.gemini', 'antigravity-cli');
  const shared = path.join(config.profileHome, '.gemini', 'config');
  await mkdir(cli, { recursive: true }); await mkdir(shared, { recursive: true });
  const json = (file, object) => writeFile(file, JSON.stringify(object), { mode: 0o600 });
  await writeFile(config.agyPath, 'not-an-executable', { mode: 0o700 });
  await json(path.join(config.profileHome, '.mailharbor-profile.json'), { version: 1, agySha256: createHash('sha256').update('not-an-executable').digest('hex') });
  await json(path.join(cli, 'settings.json'), SAFE_SETTINGS);
  await json(path.join(shared, 'config.json'), SAFE_SHARED);
  await json(path.join(shared, 'mcp_config.json'), {});
  return { config, root, cli, shared, json };
}

test('profile strips unrelated credentials from child environment and denies all tools', async t => {
  const { config } = await fixture(t);
  const key = 'MAILHARBOR_TEST_UNRELATED_SECRET'; process.env[key] = 'must-not-pass';
  t.after(() => delete process.env[key]);
  const result = await validateProfile(config);
  assert.equal(result.env[key], undefined);
  assert.equal(result.env.HOME, config.profileHome);
  assert.equal(result.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
});

test('profile fails closed on changed tool permissions, MCP, and binary', async t => {
  const { config, cli, shared, json } = await fixture(t);
  const unsafe = structuredClone(SAFE_SETTINGS); unsafe.permissions.allow.push('command(*)');
  await json(path.join(cli, 'settings.json'), unsafe);
  await assert.rejects(validateProfile(config), { code: 'configuration_error' });
  await json(path.join(cli, 'settings.json'), SAFE_SETTINGS);
  await json(path.join(shared, 'mcp_config.json'), { mcpServers: { unexpected: {} } });
  await assert.rejects(validateProfile(config), { code: 'configuration_error' });
  await json(path.join(shared, 'mcp_config.json'), {});
  await writeFile(config.agyPath, 'changed');
  await assert.rejects(validateProfile(config), { code: 'configuration_error' });
});

test('profile refuses inherited repository context and credit overages', async t => {
  const { config, root, cli, json } = await fixture(t);
  await mkdir(path.join(root, '.git'));
  await assert.rejects(validateProfile(config), { code: 'configuration_error' });
  await rm(path.join(root, '.git'), { recursive: true });
  const settings = JSON.parse(await readFile(path.join(cli, 'settings.json'))); settings.useG1Credits = true;
  await json(path.join(cli, 'settings.json'), settings);
  await assert.rejects(validateProfile(config), { code: 'configuration_error' });
});

test('Agy Linux zero-value serialization preserves effective restrictions but not telemetry omission', async t => {
  const { config, cli, json } = await fixture(t);
  const roundTripped = { enableTelemetry: false, enableTerminalSandbox: true, permissions: { deny: SAFE_SETTINGS.permissions.deny } };
  await json(path.join(cli, 'settings.json'), roundTripped);
  await validateProfile(config);
  for (const invalid of [null, false, 0, '']) {
    await json(path.join(cli, 'settings.json'), { ...roundTripped, permissions: { ...roundTripped.permissions, allow: invalid } });
    await assert.rejects(validateProfile(config), { code: 'configuration_error' });
  }
  delete roundTripped.enableTelemetry;
  await json(path.join(cli, 'settings.json'), roundTripped);
  await assert.rejects(validateProfile(config), { code: 'configuration_error' });
});
