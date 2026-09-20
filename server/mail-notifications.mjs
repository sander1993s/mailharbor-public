import webpush from 'web-push';
import { createHash, ECDH } from 'node:crypto';
import { MailHarborError, safeError } from './validation.mjs';

const fail = () => { throw new MailHarborError('invalid_request'); };
const key = value => createHash('sha256').update(value).digest('hex');
function subscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(name => !['endpoint', 'expirationTime', 'keys'].includes(name)) ||
    typeof value.endpoint !== 'string' || value.endpoint.length > 4096) fail();
  let url; try { url = new URL(value.endpoint); } catch { fail(); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'].some(allowed => host === allowed || host.endsWith(`.${allowed}`))) fail();
  if (!value.keys || typeof value.keys !== 'object' || Object.keys(value.keys).some(name => !['p256dh', 'auth'].includes(name)) ||
    !/^[A-Za-z0-9_-]{87}=?$/u.test(value.keys.p256dh ?? '') || !/^[A-Za-z0-9_-]{22}={0,2}$/u.test(value.keys.auth ?? '')) fail();
  try {
    const publicKey = Buffer.from(value.keys.p256dh, 'base64url'), secret = Buffer.from(value.keys.auth, 'base64url');
    if (publicKey.length !== 65 || publicKey[0] !== 4 || secret.length !== 16) fail();
    ECDH.convertKey(publicKey, 'prime256v1');
  } catch { fail(); }
  return { endpoint: url.href, expirationTime: null, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

/** A shared, lightweight mailbox watcher. Push payloads contain no message data. */
export function createMailNotifications({
  store,
  accounts,
  reader,
  origin,
  push = webpush,
  now = Date.now,
  intervalMs = 60000,
  pollEnabled = true
}) {
  let closed = false, pending = null, watchUntil = 0, revision = 0, checkedAt = null, errors = [];
  let queue = Promise.resolve();
  const controller = new AbortController();
  const snapshot = () => store.read().mailNotifications ?? { subscriptions: {}, states: [] };
  // A live predicate lets the provider watcher take over if the shared cache fails.
  const shouldPoll = () => {
    try { return (typeof pollEnabled === 'function' ? pollEnabled() : pollEnabled) === true; }
    catch { return false; }
  };

  function getConnectedAccounts() {
    try {
      const list = accounts.list() ?? [];
      const result = [];
      for (const item of list) {
        if (!item?.connected || !item?.id) continue;
        try {
          const acc = accounts.get(item.id);
          if (acc && acc.id && acc.email) {
            result.push({ ...acc, id: acc.id, email: acc.email, revision: acc.revision });
          }
        } catch {
          // getter may throw after disconnect
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  function getVerifiedAccounts(captured) {
    const current = getConnectedAccounts();
    return captured.filter(acc => {
      const live = current.find(c => c.id === acc.id);
      return live && live.email === acc.email && live.revision === acc.revision;
    });
  }

  async function processSnapshot(rawSnapshot, capturedAccounts) {
    if (closed) return;
    try {
      if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot) || rawSnapshot.__invalid) {
        fail();
      }
      const rawStates = rawSnapshot.states ?? [];
      const rawErrors = rawSnapshot.errors ?? [];
      if (!Array.isArray(rawStates) || rawStates.length > 10000) fail();
      if (!Array.isArray(rawErrors) || rawErrors.length > 1000) fail();

      const seenFolders = new Set();
      const validatedStates = rawStates.map(state => {
        if (!state || typeof state !== 'object' || Array.isArray(state)) fail();
        const captured = capturedAccounts.find(value => value.id === state.accountId);
        if (!captured) fail();
        if (typeof state.folderId !== 'string' || !/^folder:[a-f0-9]{64}$/u.test(state.folderId) ||
            state.uidValidity === null || state.uidValidity === undefined || typeof state.uidValidity === 'object' || typeof state.uidValidity === 'symbol' ||
            !/^\d{1,20}$/u.test(String(state.uidValidity)) ||
            !Number.isSafeInteger(state.uidNext) || state.uidNext < 1 ||
            !Number.isSafeInteger(state.unseen) || state.unseen < 0 ||
            !Number.isSafeInteger(state.messages) || state.messages < 0) {
          fail();
        }
        const stateKey = `${captured.id}:${state.folderId}`;
        if (seenFolders.has(stateKey)) fail();
        seenFolders.add(stateKey);
        return {
          accountId: captured.id,
          owner: captured.email,
          folderId: state.folderId,
          uidValidity: String(state.uidValidity),
          uidNext: state.uidNext,
          unseen: state.unseen,
          messages: state.messages
        };
      });

      const originatingAccounts = [];

      await store.update(async data => {
        if (closed) return;
        const currentlyConnected = getConnectedAccounts();
        const verifiedAtCommit = capturedAccounts.filter(captured => {
          const live = currentlyConnected.find(a => a.id === captured.id);
          return live && live.email === captured.email && live.revision === captured.revision;
        });

        const activeStates = validatedStates.filter(state =>
          verifiedAtCommit.some(acc => acc.id === state.accountId && acc.email === state.owner)
        );

        const previous = data.mailNotifications?.states ?? [];
        const retainedPrevious = previous.filter(value =>
          currentlyConnected.some(account => account.id === value.accountId && account.email === value.owner) &&
          !activeStates.some(state => state.accountId === value.accountId && state.folderId === value.folderId)
        );

        const merged = [...activeStates, ...retainedPrevious];

        for (const state of activeStates) {
          const before = previous.find(value =>
            value.accountId === state.accountId &&
            value.owner === state.owner &&
            value.folderId === state.folderId
          );
          if (before && before.uidValidity === state.uidValidity && Number(state.uidNext) > Number(before.uidNext)) {
            const originator = verifiedAtCommit.find(acc => acc.id === state.accountId && acc.email === state.owner);
            if (originator && !originatingAccounts.some(o => o.id === originator.id && o.revision === originator.revision)) {
              originatingAccounts.push({
                id: originator.id,
                email: originator.email,
                revision: originator.revision,
                folderId: state.folderId,
                uidValidity: state.uidValidity
              });
            }
          }
        }

        if (JSON.stringify(previous) !== JSON.stringify(merged)) {
          revision++;
          data.mailNotifications ??= { subscriptions: {} };
          data.mailNotifications.states = merged;
        }

        const publishedErrors = [];
        for (const err of rawErrors) {
          if (!err || typeof err !== 'object' || Array.isArray(err)) continue;
          const safe = safeError(err);
          if (err.accountId !== undefined && err.accountId !== null) {
            if (typeof err.accountId === 'string' && verifiedAtCommit.some(acc => acc.id === err.accountId)) {
              publishedErrors.push({ accountId: err.accountId, code: safe.code });
            }
          } else {
            publishedErrors.push({ code: safe.code });
          }
        }

        checkedAt = new Date(now()).toISOString();
        errors = publishedErrors;
      });

      const vapidKeys = snapshot().vapid;
      if (!originatingAccounts.length || !vapidKeys || closed) return;

      for (const [id, saved] of Object.entries(snapshot().subscriptions ?? {})) {
        if (closed) return;
        const activeOriginators = getVerifiedAccounts(originatingAccounts);
        if (!activeOriginators.length) return;
        try {
          const checked = subscription(saved);
          await push.sendNotification(
            checked,
            JSON.stringify({ title: 'New mail', body: 'Open MailHarbor to read your new mail.', url: '/#inbox' }),
            { vapidDetails: { subject: origin, ...vapidKeys }, TTL: 3600, timeout: 10000 }
          );
        } catch (error) {
          if ([404, 410].includes(error?.statusCode)) {
            await store.update(data => { delete data.mailNotifications?.subscriptions?.[id]; });
          } else {
            errors = [...errors, { code: 'notification_unavailable' }];
          }
        }
      }
    } catch {
      if (!closed) errors = [{ code: 'mailbox_error' }];
    }
  }

  function enqueueSnapshot(snapshotData, capturedAccounts) {
    const run = async () => {
      if (closed) return;
      try {
        await processSnapshot(snapshotData, capturedAccounts);
      } catch {
        if (!closed) errors = [{ code: 'mailbox_error' }];
      }
    };

    const nextPromise = queue.then(run, run);
    queue = nextPromise.catch(() => {});
    return nextPromise;
  }

  async function poll() {
    if (closed || !shouldPoll()) return;
    if (pending) return pending;
    pending = (async () => {
      try {
        if (closed || !shouldPoll()) return;
        const current = getConnectedAccounts();
        if (!current.length || typeof reader?.changes !== 'function') return;

        const readerPromise = reader.changes(current, { signal: controller.signal });
        let onAbort;
        const abortPromise = new Promise(resolve => {
          if (controller.signal.aborted) return resolve('aborted');
          onAbort = () => resolve('aborted');
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });

        let raceResult;
        try {
          raceResult = await Promise.race([
            readerPromise.then(res => ({ ok: true, res }), err => ({ ok: false, err })),
            abortPromise.then(() => ({ aborted: true }))
          ]);
        } finally {
          if (onAbort) controller.signal.removeEventListener('abort', onAbort);
          readerPromise.catch(() => {});
        }

        if (raceResult.aborted || closed || !shouldPoll()) return;
        if (!raceResult.ok) throw raceResult.err;

        await enqueueSnapshot(raceResult.res, current);
      } catch {
        if (!closed) errors = [{ code: 'mailbox_error' }];
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  function ingest(rawSnapshot) {
    if (closed) return Promise.resolve();
    const capturedAccounts = getConnectedAccounts();

    let copyFailed = false;
    let copiedSnapshot = null;

    if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) {
      copyFailed = true;
    } else {
      try {
        let copiedStates;
        if (rawSnapshot.states !== undefined) {
          if (!Array.isArray(rawSnapshot.states) || rawSnapshot.states.length > 10000) {
            copyFailed = true;
          } else {
            copiedStates = [];
            for (const st of rawSnapshot.states) {
              if (!st || typeof st !== 'object' || Array.isArray(st)) {
                copiedStates.push(st);
              } else {
                copiedStates.push({ ...st });
              }
            }
          }
        }

        let copiedErrors;
        if (rawSnapshot.errors !== undefined) {
          if (!Array.isArray(rawSnapshot.errors) || rawSnapshot.errors.length > 1000) {
            copyFailed = true;
          } else {
            copiedErrors = [];
            for (const err of rawSnapshot.errors) {
              if (!err || typeof err !== 'object' || Array.isArray(err)) {
                copiedErrors.push(err);
              } else {
                copiedErrors.push({ ...err });
              }
            }
          }
        }

        if (!copyFailed) {
          copiedSnapshot = { states: copiedStates, errors: copiedErrors };
        }
      } catch {
        copyFailed = true;
      }
    }

    const snapshotToQueue = copyFailed ? { __invalid: true } : copiedSnapshot;
    return enqueueSnapshot(snapshotToQueue, capturedAccounts);
  }

  const timer = pollEnabled ? setInterval(() => {
    if (watchUntil > now() || Object.keys(snapshot().subscriptions ?? {}).length) void poll();
  }, intervalMs) : null;
  if (timer) timer.unref?.();

  return {
    poll,
    ingest,
    updates() {
      watchUntil = now() + intervalMs * 3;
      if (!checkedAt && shouldPoll()) void poll();
      return { revision, checkedAt, errors };
    },
    async settings() {
      if (closed) fail();
      if (!snapshot().vapid) await store.update(data => { data.mailNotifications ??= { subscriptions: {}, states: [] }; data.mailNotifications.vapid ??= push.generateVAPIDKeys(); });
      return { publicKey: snapshot().vapid.publicKey, devices: Object.keys(snapshot().subscriptions ?? {}).length, intervalSeconds: intervalMs / 1000 };
    },
    async subscribe(input) {
      const value = subscription(input);
      await this.settings();
      await store.update(data => {
        const subscriptions = data.mailNotifications.subscriptions ??= {};
        if (!subscriptions[key(value.endpoint)] && Object.keys(subscriptions).length >= 16) fail();
        subscriptions[key(value.endpoint)] = value;
      });
      if (shouldPoll()) void poll();
      return { saved: true };
    },
    async unsubscribe(input) {
      if (closed || !input || Object.keys(input).some(name => name !== 'endpoint') || typeof input.endpoint !== 'string' || input.endpoint.length > 4096) fail();
      let endpoint; try { endpoint = new URL(input.endpoint).href; } catch { fail(); }
      await store.update(data => { delete data.mailNotifications?.subscriptions?.[key(endpoint)]; });
      return { removed: true };
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      controller.abort();
      await pending;
      await queue;
    }
  };
}
