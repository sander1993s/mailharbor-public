import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCooldown } from '../server/cooldown.mjs';

test('a short provider retry survives restart and becomes eligible at its saved deadline', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-cooldown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { cooldownFile: path.join(directory, 'quota.json') };
  let clock = Date.UTC(2026, 8, 20, 12);
  const first = createCooldown(config, { now: () => clock });
  await first.pause(90000);
  assert.equal((await first.status()).retryAfterMs, 90000);
  const saved = JSON.parse(await readFile(config.cooldownFile, 'utf8'));
  assert.equal(saved.blockedUntil, clock + 90000);
  clock += 30000;
  const restarted = createCooldown(config, { now: () => clock });
  assert.equal((await restarted.status()).retryAfterMs, 60000);
  assert.equal(await restarted.blocked(), true);
  clock = saved.blockedUntil;
  assert.deepEqual(await restarted.status(), { blocked: false, retryAt: null, retryAfterMs: 0 });
});

test('short throttles cannot shorten an existing weekly hold', async () => {
  let clock = Date.UTC(2026, 8, 20, 12);
  const cooldown = createCooldown({}, { now: () => clock });
  await cooldown.pause(7 * 86400000);
  const deadline = (await cooldown.status()).retryAt;
  clock += 120000;
  await cooldown.pause(60000);
  assert.equal((await cooldown.status()).retryAt, deadline);
});

test('retry durations retain conservative defaults and bounded minimum/maximum delays', async () => {
  for (const [duration, expected] of [
    [undefined, 5 * 3600000], [NaN, 5 * 3600000], [Infinity, 5 * 3600000],
    [0, 5 * 3600000], [-1, 5 * 3600000], ['60000', 5 * 3600000],
    [500, 60000], [90000.5, 90001], [30 * 86400000, 7 * 86400000]
  ]) {
    const cooldown = createCooldown({}, { now: () => Date.UTC(2026, 8, 20, 12) });
    await cooldown.pause(duration);
    assert.equal((await cooldown.status()).retryAfterMs, expected, String(duration));
  }
});
