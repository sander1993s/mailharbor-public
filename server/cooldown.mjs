import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { MailHarborError } from './validation.mjs';

export function createCooldown(config, { now = Date.now } = {}) {
  const file = config.cooldownFile ?? (config.workRoot ? path.join(path.dirname(config.workRoot), 'quota-cooldown.json') : null);
  let until = 0;
  let broken = false;
  const ready = (async () => {
    if (!file) return; // Pure injected-runner tests may be entirely in memory.
    try {
      const contents = await readFile(file, 'utf8');
      if (contents.length > 2048) throw new Error('Invalid cooldown');
      const state = JSON.parse(contents);
      if (Object.keys(state).join(',') !== 'blockedUntil' || !Number.isSafeInteger(state.blockedUntil) || state.blockedUntil < 0 ||
          state.blockedUntil > 253402300799999) throw new Error('Invalid cooldown');
      until = state.blockedUntil;
    } catch (error) { if (error.code !== 'ENOENT') broken = true; }
  })();
  return {
    async blocked() { await ready; if (broken) throw new MailHarborError('configuration_error'); return until > now(); },
    async status() {
      await ready;
      if (broken) throw new MailHarborError('configuration_error');
      const remaining = Math.max(0, until - now());
      return { blocked: remaining > 0, retryAt: remaining > 0 ? new Date(until).toISOString() : null,
        retryAfterMs: Math.min(7 * 86400000, remaining) };
    },
    async pause(durationMs = 5 * 60 * 60 * 1000) {
      await ready;
      if (!Number.isFinite(durationMs) || durationMs <= 0) durationMs = 5 * 3600000;
      // The runner distinguishes short request throttles from exhausted quota.
      // Honor its bounded retry hint without erasing a longer existing hold.
      until = Math.max(until, now() + Math.min(7 * 86400000, Math.max(60000, Math.ceil(durationMs))));
      if (file) {
        try {
          const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
          await writeFile(temporary, JSON.stringify({ blockedUntil: until }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await rename(temporary, file);
        } catch { broken = true; throw new MailHarborError('configuration_error'); }
      }
    }
  };
}
