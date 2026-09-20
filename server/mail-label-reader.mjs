import { createMailboxSession, mailFingerprint, hasMailFlag, selectableMailbox } from './mailboxes.mjs';
import { MailHarborError, errorMessages } from './validation.mjs';

const HEADERS = Object.freeze({ uid: true, envelope: true, flags: true, internalDate: true, size: true });
const SAFE_ERRORS = new Set(['invalid_request', 'stale_message', 'cancelled', 'mailbox_error', 'mailbox_timeout', 'mailbox_login_required', 'move_unavailable', 'label_unavailable', 'folder_unavailable']);
const PROTECTED = ['\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive', '\\All', '\\Flagged'];
const PROTECTED_NAMES = new Set(['sent', 'sent items', 'sent messages', 'draft', 'drafts', 'trash', 'deleted items', 'deleted messages', 'junk', 'junk email', 'junk e-mail', 'spam', 'archive', 'archives']);
const uid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const validityValue = value => typeof value === 'string' && /^\d{1,20}$/u.test(value);
const samePath = (a, b) => a === b || (String(a).toUpperCase() === 'INBOX' && String(b).toUpperCase() === 'INBOX');
const fail = code => { throw new MailHarborError(code, errorMessages[code]); };
const cleanReference = value => ({ accountId: value.accountId, path: value.path, uidValidity: value.uidValidity, uid: value.uid, fingerprint: value.fingerprint });
const messageId = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f\x7f]/u.test(value);
const remoteLabel = value => typeof value === 'string' && value.length <= 512 && value.startsWith('MailHarbor/') &&
  value.split('/').length <= 8 && value.split('/').every(part => part.trim() === part && part.length > 0 && !['.', '..'].includes(part) && !/[\x00-\x1f\x7f\\*%]/u.test(part));
const fullHeader = value => value && uid(value.uid) && value.envelope && typeof value.envelope === 'object' && !Array.isArray(value.envelope) &&
  value.flags instanceof Set && value.internalDate != null && Number.isSafeInteger(value.size) && value.size >= 0;

function referenceCheck(account, reference) {
  if (!reference || reference.accountId !== account.id || !selectableMailbox({ path: reference.path }) ||
      !uid(reference.uid) || !validityValue(reference.uidValidity) || !/^[a-f0-9]{64}$/u.test(reference.fingerprint ?? '')) fail('stale_message');
}

function protectedFolder(folder, account) {
  if (samePath(folder.path, 'INBOX')) return false;
  if (PROTECTED.some(flag => String(folder.specialUse ?? '').toLowerCase() === flag.toLowerCase() || hasMailFlag(folder.flags, flag))) return true;
  if (account.archivePath && samePath(account.archivePath, folder.path)) return true;
  const name = folder.path.toLowerCase();
  return !folder.specialUse && (PROTECTED_NAMES.has(name) || name.startsWith('inbox.') && PROTECTED_NAMES.has(name.slice(6)));
}

/** Applies owned labels, or one explicitly chosen primary folder, without COPY/EXPUNGE fallbacks. */
export function createMailLabelReader({ connectionOptions, createClient, sessionTimeoutMs } = {}) {
  const { session, active } = createMailboxSession({ connectionOptions, createClient, sessionTimeoutMs });

  async function sync(account, entries, { signal, verify, beforeMove, onResult = async () => {} } = {}) {
    if (!account || typeof account.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(account.id) || !Array.isArray(entries) || entries.length > 25 ||
        typeof verify !== 'function' || typeof onResult !== 'function' || beforeMove !== undefined && typeof beforeMove !== 'function') fail('invalid_request');
    const keys = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || !entry.key || entry.key.length > 512 || keys.has(entry.key)) fail('invalid_request');
      keys.add(entry.key); referenceCheck(account, entry.reference);
      for (const labels of [entry.labels, entry.managedLabels]) if (!Array.isArray(labels) || labels.length > 100 || labels.some(label => !remoteLabel(label)) || new Set(labels).size !== labels.length) fail('invalid_request');
      if (entry.primaryLabel !== null && !remoteLabel(entry.primaryLabel)) fail('invalid_request');
      if (entry.primaryLabel && !entry.labels.includes(entry.primaryLabel)) fail('invalid_request');
      if (entry.intent) {
        referenceCheck(account, entry.intent.source);
        if (JSON.stringify(cleanReference(entry.intent.source)) !== JSON.stringify(cleanReference(entry.reference)) ||
            !selectableMailbox({ path: entry.intent.destinationPath }) || !messageId(entry.intent.messageId)) fail('invalid_request');
      }
    }
    if (!entries.length) return { results: [] };
    return session(account, signal, async client => {
      let currentEntry, reconcilingMove = false;
      const live = () => { if (signal?.aborted) fail('cancelled'); if (!active.has(client)) fail('mailbox_error'); };
      const checkpoint = async (entryCheck = !reconcilingMove) => { live(); if (await verify(entryCheck ? currentEntry : undefined) === false) fail('stale_message'); live(); };
      const currentValidity = path => {
        const value = String(client.mailbox?.uidValidity ?? '');
        if (!samePath(client.mailbox?.path, path) || !validityValue(value)) fail('stale_message');
        return value;
      };
      const lock = async (path, readOnly, operation) => {
        await checkpoint();
        const held = await client.getMailboxLock(path, { readOnly });
        try { await checkpoint(); return await operation(currentValidity(path)); }
        finally { held.release(); }
      };
      const list = async () => {
        const value = await client.list(); await checkpoint();
        if (!Array.isArray(value) || value.length > 2000) fail('mailbox_error');
        return value;
      };
      await checkpoint();
      let folders = await list();
      const gmail = client.capabilities?.has('X-GM-EXT-1') === true;
      const delimiter = gmail ? '/' : folders.find(folder => typeof folder.delimiter === 'string' && folder.delimiter.length === 1)?.delimiter ?? '/';
      const subscribed = new Set();
      const findFolder = path => folders.find(folder => samePath(folder.path, path));
      const ownedPath = path => typeof path === 'string' && path.startsWith(`MailHarbor${delimiter}`) &&
        remoteLabel(path.split(delimiter).join('/'));
      const destination = label => {
        if (!remoteLabel(label) || delimiter !== '/' && label.split('/').some(part => part.includes(delimiter))) fail('label_unavailable');
        return label.split('/').join(delimiter);
      };
      const ensureFolder = async path => {
        if (!ownedPath(path)) fail('folder_unavailable');
        const parts = path.split(delimiter);
        for (let count = 1; count <= parts.length; count++) {
          const parent = parts.slice(0, count).join(delimiter);
          if (!findFolder(parent)) {
            await checkpoint();
            const created = await client.mailboxCreate(parent); await checkpoint();
            // ALREADYEXISTS is supported by ImapFlow; fresh LIST proves creation and handles races.
            folders = await list();
            if (!created || !findFolder(parent)) fail('folder_unavailable');
          }
          if (count === parts.length && !selectableMailbox(findFolder(parent))) fail('folder_unavailable');
          if (!subscribed.has(parent)) {
            await checkpoint();
            const result = await client.mailboxSubscribe(parent); await checkpoint();
            if (!result) fail('folder_unavailable');
            subscribed.add(parent);
          }
        }
      };
      // Fetch exact UIDs; unsolicited partial FETCH rows must never substitute a different message.
      const fetchExact = async (reference, labels = false, matchingOnly = false) => {
        await checkpoint();
        if (currentValidity(reference.path) !== reference.uidValidity) fail('stale_message');
        let found = null, observed = false, mismatch = false, rows = 0;
        for await (const value of client.fetch(String(reference.uid), { ...HEADERS, ...(labels ? { labels: true } : {}) }, { uid: true, binary: false })) {
          live(); if (++rows > 1000) fail('mailbox_error');
          if (value?.uid !== reference.uid) continue;
          observed = true;
          if (fullHeader(value)) {
            if (mailFingerprint(value) !== reference.fingerprint) {
              if (!matchingOnly) fail('stale_message');
              mismatch = true; continue;
            }
            found = { ...value, flags: new Set(value.flags), ...(value.labels instanceof Set ? { labels: new Set(value.labels) } : {}) };
          } else if (found) {
            if (value.flags instanceof Set) found.flags = new Set(value.flags);
            if (value.labels instanceof Set) found.labels = new Set(value.labels);
          }
        }
        await checkpoint();
        if (currentValidity(reference.path) !== reference.uidValidity) fail('stale_message');
        if (mismatch) return null;
        if (!found && !observed) return null;
        if (!found || hasMailFlag(found.flags, '\\Deleted') || labels && !(found.labels instanceof Set)) fail('stale_message');
        return found;
      };
      const sourceStatus = async (reference, labels = false, readOnly = true) => lock(reference.path, readOnly, async value => {
        if (value !== reference.uidValidity) fail('stale_message');
        return fetchExact(reference, labels);
      });
      const findIdentity = async (path, source, id, emailId = null) => lock(path, true, async uidValidity => {
        if (!messageId(id) && !emailId) fail('stale_message');
        const criteria = emailId ? { emailId } : { header: { 'Message-ID': id } };
        const candidates = await client.search(criteria, { uid: true }); await checkpoint();
        if (currentValidity(path) !== uidValidity || !Array.isArray(candidates) || candidates.length > 64 || candidates.some(value => !uid(value)) ||
            new Set(candidates).size !== candidates.length) fail('stale_message');
        const matches = [];
        for (const candidate of candidates) {
          const reference = { ...cleanReference(source), path, uidValidity, uid: candidate };
          // SEARCH can return substring matches, so filter by the complete fingerprint too.
          const value = await fetchExact(reference, gmail, true);
          if (value && (emailId ? String(value.emailId ?? '') === String(emailId) : value.envelope.messageId === id)) matches.push(reference);
        }
        if (matches.length > 1) fail('stale_message');
        return matches[0] ?? null;
      });
      const result = (reference, kind, labels, moved = false, status = 'synced') => ({ status, reference: cleanReference(reference), managedLabels: [...labels], kind, moved });
      const persist = async (callback, ...args) => {
        try { await callback(...args); }
        catch { const error = new MailHarborError('mailbox_error', errorMessages.mailbox_error); error.persistenceFailed = true; throw error; }
        live();
      };

      const gmailLabels = async entry => {
        let reference = cleanReference(entry.reference);
        const original = await sourceStatus(reference, true);
        if (!original) fail('stale_message');
        const all = folders.filter(folder => selectableMailbox(folder) && (folder.specialUse === '\\All' || hasMailFlag(folder.flags, '\\All')));
        if (all.length === 1 && !samePath(all[0].path, reference.path)) {
          const id = original.envelope.messageId, emailId = /^\d{1,20}$/u.test(String(original.emailId ?? '')) ? String(original.emailId) : null;
          const alias = await findIdentity(all[0].path, reference, id, emailId);
          if (alias) reference = alias;
          else if (ownedPath(reference.path)) fail('stale_message');
        } else if (ownedPath(reference.path)) fail('label_unavailable');
        for (const label of entry.labels) await ensureFolder(label);
        return lock(reference.path, false, async value => {
          if (value !== reference.uidValidity || client.mailbox.readOnly) fail('stale_message');
          let fresh = await fetchExact(reference, true);
          if (!fresh) fail('stale_message');
          const add = entry.labels.filter(label => !fresh.labels.has(label));
          const remove = entry.managedLabels.filter(label => !entry.labels.includes(label) && fresh.labels.has(label));
          for (const [method, labels] of [['messageFlagsAdd', add], ['messageFlagsRemove', remove]]) {
            if (!labels.length) continue;
            fresh = await fetchExact(reference, true);
            if (!fresh || client.mailbox.readOnly || !client.capabilities?.has('X-GM-EXT-1')) fail('stale_message');
            const changed = await client[method](String(reference.uid), labels, { uid: true, useLabels: true }); await checkpoint();
            if (!changed) fail('mailbox_error');
            const after = await fetchExact(reference, true);
            if (!after || labels.some(label => after.labels.has(label) !== (method === 'messageFlagsAdd')) ||
                after.flags.size !== fresh.flags.size || [...fresh.flags].some(flag => !after.flags.has(flag)) ||
                [...fresh.labels].some(label => !(method === 'messageFlagsRemove' && labels.includes(label)) && !after.labels.has(label))) fail('mailbox_error');
          }
          fresh = await fetchExact(reference, true);
          if (!fresh || entry.labels.some(label => !fresh.labels.has(label)) ||
              entry.managedLabels.some(label => !entry.labels.includes(label) && fresh.labels.has(label))) fail('mailbox_error');
          return result(reference, 'labels', entry.labels);
        });
      };

      const movePrimary = async entry => {
        const source = cleanReference(entry.intent?.source ?? entry.reference), folder = findFolder(source.path);
        if (!folder || !selectableMailbox(folder)) fail('stale_message');
        if (entry.intent && !ownedPath(entry.intent.destinationPath)) fail('invalid_request');
        const original = await sourceStatus(source);
        if (!original) {
          if (!entry.intent) fail('stale_message');
          reconcilingMove = true;
          const recovered = await findIdentity(entry.intent.destinationPath, source, entry.intent.messageId);
          if (!recovered || await sourceStatus(source)) fail('stale_message');
          return { ...result(recovered, 'folders', [], true),
            needsSync: Boolean(entry.primaryLabel && !samePath(recovered.path, destination(entry.primaryLabel))) };
        }
        if (protectedFolder(folder, account)) return result(source, 'folders', [], false, 'protected');
        // The prior command did not remove this exact source. A newer category
        // choice cancels its old intent; acknowledge the unchanged location so
        // the caller can clear the journal and queue the current choice.
        if (entry.intent && (!entry.primaryLabel || !samePath(entry.intent.destinationPath, destination(entry.primaryLabel)))) {
          return { ...result(source, 'folders', []),
            needsSync: Boolean(entry.primaryLabel && !samePath(source.path, destination(entry.primaryLabel))) };
        }
        if (!entry.primaryLabel && !entry.intent) return result(source, 'folders', []);
        const path = entry.intent?.destinationPath ?? destination(entry.primaryLabel);
        if (samePath(source.path, path)) return result(source, 'folders', []);
        if (!client.capabilities?.has('MOVE') || !client.capabilities?.has('UIDPLUS')) fail('move_unavailable');
        const id = original.envelope.messageId;
        if (!messageId(id) || entry.intent && id !== entry.intent.messageId || typeof beforeMove !== 'function') fail('move_unavailable');
        await ensureFolder(path);
        if (protectedFolder(findFolder(path), account)) fail('move_unavailable');
        let mapping;
        await lock(source.path, false, async value => {
          if (value !== source.uidValidity || client.mailbox.readOnly) fail('stale_message');
          const fresh = await fetchExact(source);
          if (!fresh || fresh.envelope.messageId !== id) fail('stale_message');
          await persist(beforeMove, entry, { source, destinationPath: path, messageId: id });
          // Persisting can yield to a reconnect, cancellation or another local action.
          if (!await fetchExact(source) || client.mailbox.readOnly) fail('stale_message');
          if (!client.capabilities?.has('MOVE') || !client.capabilities?.has('UIDPLUS')) fail('move_unavailable');
          mapping = await client.messageMove(String(source.uid), path, { uid: true });
          // A completed physical move must be acknowledged even if the desired
          // category changed while the server processed MOVE. Recheck the account
          // and exact identities while reconciling the durable intent.
          reconcilingMove = true;
          await checkpoint();
          if (!mapping) fail('mailbox_error');
        });
        if (await sourceStatus(source)) fail('mailbox_error');
        let target = null;
        const mappedUid = mapping.uidMap instanceof Map ? Number(mapping.uidMap.get(source.uid)) : NaN;
        const mappedValidity = String(mapping.uidValidity ?? '');
        if (uid(mappedUid) && validityValue(mappedValidity)) {
          if (mapping.destination && !samePath(mapping.destination, path) || mapping.path && !samePath(mapping.path, source.path)) fail('stale_message');
          target = { ...source, path, uid: mappedUid, uidValidity: mappedValidity };
          if (!await sourceStatus(target)) fail('stale_message');
        } else target = await findIdentity(path, source, id);
        if (!target || await sourceStatus(source)) fail('stale_message');
        return result(target, 'folders', [], true);
      };

      const results = [];
      for (const entry of entries) {
        currentEntry = entry; reconcilingMove = false;
        await checkpoint();
        let outcome;
        try { outcome = gmail ? await gmailLabels(entry) : await movePrimary(entry); }
        catch (error) {
          live();
          if (error.persistenceFailed) throw error;
          const code = error instanceof MailHarborError && SAFE_ERRORS.has(error.code) ? error.code :
            error?.authenticationFailed ? 'mailbox_login_required' : 'mailbox_error';
          if (['cancelled', 'mailbox_timeout', 'mailbox_login_required'].includes(code)) fail(code);
          results.push({ key: entry.key, error: { code } });
          continue;
        }
        await checkpoint(false);
        // Completion can legitimately advance this entry's generation/reference.
        // The next item's checkpoint revalidates its own generation.
        await persist(onResult, entry, outcome);
        results.push({ key: entry.key, ...outcome });
      }
      return { results };
    });
  }
  return { sync };
}
