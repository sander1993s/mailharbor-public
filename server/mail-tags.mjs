import { MAX_ACCOUNTS } from './providers.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { MailHarborError } from './validation.mjs';
import { MAIL_CATEGORIES } from './mail-policy.mjs';

export const MAIL_TAGS = MAIL_CATEGORIES;

const TAGS = new Set(MAIL_TAGS.map(tag => tag.id));
const customId = id => typeof id === 'string' && /^custom_[a-f0-9]{32}$/u.test(id);
const definitions = store => [...MAIL_TAGS, ...(store.read().customMailLabels ?? [])];
const validTag = (store, id) => definitions(store).some(tag => tag.id === id);
const MAX_ENTRIES = 10000;
const NO_CHANGE = Symbol('mail-tags-no-change');
const fail = code => { throw new MailHarborError(code); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const text = (value, maximum = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, maximum) : '';
const email = value => {
  if (typeof value !== 'string') fail('invalid_request');
  const normalized = value.trim().normalize('NFC').toLowerCase();
  if (normalized.length > 320 || !/^[^\s@]+@[^\s@]+$/u.test(normalized) || /[\u0000-\u001f\u007f]/u.test(normalized)) fail('invalid_request');
  return normalized;
};
function accountIdentity(account) {
  if (!record(account) || !identifier(account.id)) fail('invalid_request');
  return { accountId: account.id, email: email(account.email) };
}
function referenceFor(account, reference) {
  if (!record(reference) || reference.accountId !== account.id ||
    !Number.isSafeInteger(reference.uid) || reference.uid < 1 || reference.uid > 0xffffffff ||
    typeof reference.uidValidity !== 'string' || !/^\d{1,20}$/u.test(reference.uidValidity) ||
    typeof reference.path !== 'string' || !reference.path.length || reference.path.length > 1024 || /[\u0000-\u001f\u007f]/u.test(reference.path) ||
    typeof reference.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.fingerprint)) fail('invalid_request');
  return { accountId: account.id, path: reference.path, uid: reference.uid, uidValidity: reference.uidValidity, fingerprint: reference.fingerprint };
}
const keyFor = (identity, fingerprint) => createHash('sha256').update(JSON.stringify([identity.accountId, identity.email, fingerprint])).digest('hex');
function snapshot(account, message, reference) {
  const identity = accountIdentity(account);
  const location = referenceFor(account, reference);
  if (!record(message) || message.accountId !== account.id) fail('invalid_request');
  return {
    ...identity,
    key: keyFor(identity, location.fingerprint),
    message: {
      accountId: account.id, account: text(account.label || account.email || account.id), folderPath: location.path,
      subject: text(message.subject), author: text(message.author), to: text(message.to), date: text(message.date, 80),
      unread: message.unread === true, starred: message.starred === true,
      ...Object.fromEntries(['cc', 'replyTo', 'messageId', 'inReplyTo', 'threadId'].filter(field => typeof message[field] === 'string').map(field => [field, text(message[field], field === 'threadId' ? 128 : 1000)])),
      ...(Array.isArray(message.references) ? { references: message.references.filter(value => typeof value === 'string').slice(0, 100).map(value => text(value, 1000)) } : {}),
      ...(Number.isSafeInteger(message.size) && message.size >= 0 && message.size <= 0xffffffff ? { size: message.size } : {}),
      ...(typeof message.hasAttachments === 'boolean' ? { hasAttachments: message.hasAttachments } : {}),
      ...(Array.isArray(message.providerLabels) ? { providerLabels: message.providerLabels.filter(value => typeof value === 'string').slice(0, 100).map(value => text(value, 200)) } : {})
    },
    reference: location
  };
}
function index(data) {
  if (data.mailTags === undefined) return { schema: 1, version: 0, entries: {} };
  const value = data.mailTags;
  if (!record(value) || value.schema !== 1 || !Number.isSafeInteger(value.version) || value.version < 0 ||
    !record(value.entries) || Object.keys(value.entries).length > MAX_ENTRIES) fail('configuration_error');
  return value;
}
function sameAccount(data, identity) {
  return data.accounts.some(account => account.id === identity.accountId && typeof account.email === 'string' &&
    account.email.trim().normalize('NFC').toLowerCase() === identity.email);
}
function sameSnapshot(entry, observation) {
  return JSON.stringify(entry.message) === JSON.stringify(observation.message) && JSON.stringify(entry.reference) === JSON.stringify(observation.reference);
}
function accountsFor(accounts) {
  if (!Array.isArray(accounts) || accounts.length > MAX_ACCOUNTS) fail('invalid_request');
  const result = new Map();
  for (const account of accounts) {
    const identity = accountIdentity(account);
    if (result.has(identity.accountId)) fail('invalid_request');
    result.set(identity.accountId, { account, identity });
  }
  return result;
}
const availableTags = data => new Set([...TAGS, ...(data.customMailLabels ?? []).map(tag => tag.id)]);
const tagValues = (entry, available) => [...new Set((entry?.tags ?? []).filter(id => (available ?? TAGS).has(id)))];

/** Persistent, local labels. Only tagged headers and private IMAP references enter the encrypted account store. */
export function createMailTags({ store, index: durable, now = () => Date.now() }) {
  const service = durable ? createDurableTags({ store, durable, now }) : createLegacyTags({ store, now });
  return Object.assign(service, {
    definitions: () => structuredClone(definitions(store)),
    async manage(input) {
      if (!record(input) || Object.keys(input).some(key => !['action', 'id', 'label'].includes(key)) ||
          !['create', 'rename', 'delete'].includes(input.action) ||
          (input.action !== 'create' && !customId(input.id)) ||
          (input.action !== 'delete' && (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 || /[\u0000-\u001f\u007f]/u.test(input.label)))) fail('invalid_request');
      let result;
      await store.update(data => {
        const labels = data.customMailLabels ??= [];
        if (input.action !== 'delete' && definitions({ read: () => data }).some(tag => tag.id !== input.id &&
          tag.label.toLowerCase() === input.label.trim().toLowerCase())) fail('invalid_request');
        if (input.action === 'create') {
          if (labels.length >= 100 || definitions({ read: () => data }).some(tag => tag.label.toLowerCase() === input.label.trim().toLowerCase())) fail('invalid_request');
          result = { id: `custom_${randomBytes(16).toString('hex')}`, label: input.label.trim() }; labels.push(result);
        } else {
          const index = labels.findIndex(tag => tag.id === input.id);
          if (index < 0) fail('not_found');
          if (input.action === 'delete') {
            labels.splice(index, 1); result = { id: input.id, deleted: true };
            for (const [key, entry] of Object.entries(data.mailTags?.entries ?? {})) {
              entry.tags = entry.tags.filter(id => id !== input.id);
              if (!entry.tags.length) delete data.mailTags.entries[key];
            }
          }
          else { labels[index].label = input.label.trim(); result = labels[index]; }
        }
        const current = index(data);
        if (current.version === Number.MAX_SAFE_INTEGER) fail('configuration_error');
        data.mailTags = { ...current, version: current.version + 1 };
      });
      if (durable) {
        durable.transaction(() => {
          if (input.action === 'delete') {
            let after = '';
            for (;;) {
              const entries = durable.list('tags', { after, limit: 100 });
              for (const { key, value } of entries) if (['tags', 'manual', 'automatic', 'excluded'].some(field => value[field]?.includes(input.id))) {
                const updated = { ...value };
                for (const field of ['tags', 'manual', 'automatic', 'excluded']) updated[field] = (value[field] ?? []).filter(id => id !== input.id);
                durable.putTag(key, updated);
              }
              if (entries.length < 100) break;
              after = entries.at(-1).key;
            }
          }
          durable.put('meta', 'tagVersion', { value: (durable.get('meta', 'tagVersion')?.value ?? 0) + 1 });
        });
      }
      return { label: structuredClone(result), labels: structuredClone(definitions(store)) };
    }
  });
}

function createLegacyTags({ store, now = () => Date.now() }) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' || typeof now !== 'function') fail('configuration_error');
  index(store.read());
  let pending = Promise.resolve();
  const enqueue = operation => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const timestamp = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail('configuration_error');
    return value;
  };
  function save(data, current, entries) {
    if (current.version === Number.MAX_SAFE_INTEGER) fail('configuration_error');
    data.mailTags = { schema: 1, version: current.version + 1, entries };
  }
  const version = () => index(store.read()).version;
  return {
    version,
    tagsFor(account, reference) {
      const identity = accountIdentity(account);
      const location = referenceFor(account, reference);
      const data = store.read();
      if (!sameAccount(data, identity)) return [];
      return tagValues(index(data).entries[keyFor(identity, location.fingerprint)], availableTags(data));
    },
    tagsForMany(accounts, messages) {
      const selected = accountsFor(accounts);
      if (!Array.isArray(messages) || messages.length > 10000) fail('invalid_request');
      const data = store.read(), current = index(data);
      return messages.map(message => {
        const value = selected.get(message?.accountId);
        if (!value) fail('invalid_request');
        const location = referenceFor(value.account, message.reference);
        return sameAccount(data, value.identity) ? tagValues(current.entries[keyFor(value.identity, location.fingerprint)], availableTags(data)) : [];
      });
    },
    async set({ account, message, reference, tag, enabled, verify } = {}) {
      if (!validTag(store, tag) || typeof enabled !== 'boolean' || (verify !== undefined && typeof verify !== 'function')) fail('invalid_request');
      const observation = snapshot(account, message, reference);
      return enqueue(async () => {
        let result;
        try {
          await store.update(async data => {
            if (verify) await verify(data);
            if (!availableTags(data).has(tag)) fail('invalid_request');
            if (!sameAccount(data, observation)) fail('stale_message');
            const current = index(data), existing = current.entries[observation.key];
            const tags = new Set(tagValues(existing, availableTags(data)));
            if (enabled) tags.add(tag); else tags.delete(tag);
            const selected = definitions(store).filter(value => tags.has(value.id)).map(value => value.id);
            result = { tags: selected, version: current.version };
            if (!existing && !selected.length) throw NO_CHANGE;
            if (existing && JSON.stringify(tagValues(existing, availableTags(data))) === JSON.stringify(selected) && sameSnapshot(existing, observation)) throw NO_CHANGE;
            if (!existing && Object.keys(current.entries).length >= MAX_ENTRIES) fail('tag_limit');
            if (!selected.length) delete current.entries[observation.key];
            else current.entries[observation.key] = {
              accountId: observation.accountId, email: observation.email, tags: selected,
              message: observation.message, reference: observation.reference, updatedAt: timestamp()
            };
            save(data, current, current.entries);
            result.version = data.mailTags.version;
          });
        } catch (error) { if (error !== NO_CHANGE) throw error; }
        // The transaction owns its arrays; callers cannot mutate the persisted index through the result.
        return structuredClone(result);
      });
    },
    async observe(accounts, messages, { verify } = {}) {
      const selected = accountsFor(accounts);
      if (!Array.isArray(messages) || messages.length > 10000 || (verify !== undefined && typeof verify !== 'function')) fail('invalid_request');
      const observations = new Map();
      for (const message of messages) {
        const account = selected.get(message?.accountId)?.account;
        if (!account) fail('invalid_request');
        const value = snapshot(account, message, message.reference);
        observations.set(value.key, value);
      }
      return enqueue(async () => {
        const changedObservations = data => {
          const current = index(data);
          return [...observations.values()].filter(value => sameAccount(data, value) && current.entries[value.key] && !sameSnapshot(current.entries[value.key], value));
        };
        // Check after earlier tag operations commit. Ordinary inbox browsing writes nothing.
        const before = store.read();
        if (!changedObservations(before).length) return { changed: false, version: index(before).version };
        let result;
        try {
          await store.update(async data => {
            if (verify) await verify(data);
            const updates = changedObservations(data), current = index(data);
            result = { changed: false, version: current.version };
            if (!updates.length) throw NO_CHANGE;
            for (const observation of updates) {
              const existing = current.entries[observation.key];
              current.entries[observation.key] = { ...existing, message: observation.message, reference: observation.reference, updatedAt: timestamp() };
            }
            save(data, current, current.entries);
            result = { changed: true, version: data.mailTags.version };
          });
        } catch (error) { if (error !== NO_CHANGE) throw error; }
        return result;
      });
    },
    async forget(account, reference) {
      const identity = accountIdentity(account), location = referenceFor(account, reference);
      const key = keyFor(identity, location.fingerprint);
      return enqueue(async () => {
        if (!sameAccount(store.read(), identity) || !index(store.read()).entries[key]) return;
        try {
          await store.update(data => {
            if (!sameAccount(data, identity)) throw NO_CHANGE;
            const current = index(data);
            if (!current.entries[key]) throw NO_CHANGE;
            delete current.entries[key];
            save(data, current, current.entries);
          });
        } catch (error) { if (error !== NO_CHANGE) throw error; }
      });
    },
    entries(accounts, { tag, query = '' } = {}) {
      const selected = accountsFor(accounts);
      if ((tag !== undefined && !validTag(store, tag)) || typeof query !== 'string' || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query)) fail('invalid_request');
      const data = store.read(), current = index(data), search = query.trim().toLowerCase();
      return Object.entries(current.entries).filter(([, entry]) => {
        const identity = selected.get(entry.accountId)?.identity;
        return identity && identity.email === entry.email && sameAccount(data, identity) &&
          tagValues(entry, availableTags(data)).length && (!tag || tagValues(entry, availableTags(data)).includes(tag)) && (!search || [entry.message.subject, entry.message.author, entry.message.to].some(value => value.toLowerCase().includes(search)));
      }).map(([key, entry]) => ({
        message: { id: `tag-${key}`, ...structuredClone(entry.message), tags: tagValues(entry, availableTags(data)) },
        reference: structuredClone(entry.reference)
      })).sort((a, b) => {
        const first = Date.parse(a.message.date) || 0, second = Date.parse(b.message.date) || 0;
        return second - first || a.message.id.localeCompare(b.message.id);
      });
    }
  };
}

/** SQLite keeps full mailbox labels indexed; manual choices override later automatic labels. */
function createDurableTags({ store, durable, now }) {
  if (!durable.get('meta', 'tagsMigrated')) durable.transaction(() => {
    for (const [key, entry] of Object.entries(index(store.read()).entries)) {
      if (!durable.get('tags', key)) durable.putTag(key, { ...entry, manual: entry.tags, automatic: [], excluded: [] });
    }
    durable.put('meta', 'tagsMigrated', { done: true });
  });
  let pending = Promise.resolve();
  const enqueue = work => { const result = pending.then(work); pending = result.catch(() => {}); return result; };
  const version = () => durable.get('meta', 'tagVersion')?.value ?? 0;
  const readEntry = (account, reference) => {
    const identity = accountIdentity(account), location = referenceFor(account, reference);
    return sameAccount(store.read(), identity) ? durable.get('tags', keyFor(identity, location.fingerprint)) : null;
  };
  const retiredObservation = observation => {
    const retired = durable.get('labelSync', observation.key)?.retiredReferences;
    return Array.isArray(retired) && retired.some(value => Number.isFinite(value.retiredAt) && value.retiredAt >= now() - 15 * 60 * 1000 &&
      value.reference && ['accountId', 'path', 'uid', 'uidValidity', 'fingerprint'].every(key => value.reference[key] === observation.reference[key]));
  };
  const merged = value => definitions(store).filter(tag => (value.manual.includes(tag.id) || value.automatic.includes(tag.id)) && !value.excluded.includes(tag.id)).map(tag => tag.id);
  async function update(observation, verify, change, { automatic = false } = {}) {
    return enqueue(async () => {
      const data = store.read(); if (verify) await verify(data);
      if (!sameAccount(store.read(), observation)) fail('stale_message');
      const old = durable.get('tags', observation.key);
      // A cached organizer result may arrive after an explicit provider deletion.
      // Keep its labels suppressed until the owner explicitly labels this mail again.
      if (automatic && old?.deleted) return { tags: [], version: version() };
      // A browser handle or classifier can still refer to the pre-MOVE UID.
      // Apply its label choice at the confirmed current location.
      const observed = old && retiredObservation(observation) ? { ...observation, reference: old.reference, message: old.message } : observation;
      const next = { ...(old ?? { manual: [], automatic: [], excluded: [] }), ...observed, updatedAt: now() };
      change(next); next.tags = merged(next);
      if (old && sameSnapshot(old, observed) && ['manual', 'automatic', 'excluded'].every(name => JSON.stringify(old[name]) === JSON.stringify(next[name]))) return { tags: [...old.tags], version: version() };
      durable.putTag(observation.key, next);
      return { tags: [...next.tags], version: version() };
    });
  }
  return {
    version,
    tagsFor: (account, reference) => tagValues(readEntry(account, reference), availableTags(store.read())),
    tagsForMany: (accounts, messages) => messages.map(message => tagValues(readEntry(accounts.find(account => account.id === message.accountId), message.reference), availableTags(store.read()))),
    manualFor: (account, reference) => (readEntry(account, reference)?.manual ?? []).filter(id => availableTags(store.read()).has(id)),
    async set({ account, message, reference, tag, enabled, verify }) {
      if (!validTag(store, tag) || typeof enabled !== 'boolean') fail('invalid_request');
      return update(snapshot(account, message, reference), verify, next => {
        if (!validTag(store, tag)) fail('invalid_request');
        delete next.deleted;
        next.manual = [...new Set(enabled ? [...next.manual, tag] : next.manual.filter(value => value !== tag))];
        next.excluded = enabled ? next.excluded.filter(value => value !== tag) : [...new Set([...next.excluded, tag])];
      });
    },
    async automatic({ account, message, reference, labels, verify }) {
      if (!Array.isArray(labels) || labels.some(label => !TAGS.has(label))) fail('invalid_request');
      return update(snapshot(account, message, reference), verify, next => { next.automatic = [...new Set(labels)]; }, { automatic: true });
    },
    async observe(accounts, messages, { verify } = {}) {
      return enqueue(async () => {
        const data = store.read(); if (verify) await verify(data);
        let changed = false;
        durable.transaction(() => {
          for (const message of messages) {
            const account = accounts.find(value => value.id === message.accountId);
            const observation = snapshot(account, message, message.reference), entry = durable.get('tags', observation.key);
            if (entry && sameAccount(data, observation) && !retiredObservation(observation) && !sameSnapshot(entry, observation)) {
              durable.putTag(observation.key, { ...entry, ...observation, updatedAt: now() }); changed = true;
            }
          }
        });
        return { changed, version: version() };
      });
    },
    async forget(account, reference) {
      const identity = accountIdentity(account), location = referenceFor(account, reference);
      return enqueue(() => {
        if (!sameAccount(store.read(), identity)) return;
        const key = keyFor(identity, location.fingerprint), entry = durable.get('tags', key);
        // Even currently unlabelled messages need a tombstone: an in-flight
        // classification can otherwise create their labels after the delete.
        if (!entry?.deleted) durable.putTag(key, { ...entry, ...identity, reference: location,
          message: entry?.message ?? snapshot(account, { accountId: account.id }, reference).message,
          manual: [], automatic: [], excluded: [], tags: [], deleted: true, updatedAt: now() });
      });
    },
    count(accounts, { tag }) {
      if (!validTag(store, tag)) fail('invalid_request');
      const data = store.read();
      return durable.tagCount(accounts.map(accountIdentity).filter(identity => sameAccount(data, identity)).map(identity => `${identity.accountId}:${identity.email}`), tag);
    },
    entries(accounts, { tag, query = '' } = {}) {
      if ((tag !== undefined && !validTag(store, tag)) || typeof query !== 'string' || query.length > 200) fail('invalid_request');
      const data = store.read(), search = query.toLowerCase().trim();
      const owners = [...accountsFor(accounts).values()].map(value => value.identity).filter(identity => sameAccount(data, identity)).map(identity => `${identity.accountId}:${identity.email}`);
      return durable.tagEntries(owners, tag).filter(({ value }) => !search || [value.message.subject, value.message.author, value.message.to].some(text => text.toLowerCase().includes(search)))
        .map(({ key, value }) => ({ message: { id: `tag-${key}`, ...value.message, tags: tagValues(value, availableTags(data)) }, reference: value.reference }))
        .filter(entry => entry.message.tags.length > 0);
    }
  };
}
