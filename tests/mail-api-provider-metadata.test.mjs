import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailApi } from '../server/mail-api.mjs';
import { MailHarborError } from '../server/validation.mjs';

function createHarness(overrides = {}) {
  const savedAccounts = new Map([
    ['synth-1', { id: 'synth-1', email: 'user@synth.test', revision: 'rev-1', connected: true }]
  ]);

  const accounts = {
    list: () => [...savedAccounts.values()].map(a => ({ id: a.id, email: a.email, connected: a.connected })),
    get: id => {
      const acc = savedAccounts.get(id);
      if (!acc) throw new MailHarborError('mailbox_login_required');
      return structuredClone(acc);
    }
  };

  const readerCalls = [];
  const synthReference = { accountId: 'synth-1', path: 'INBOX', uid: 101, uidValidity: '12345', fingerprint: 'a'.repeat(64) };
  const synthMessage = {
    id: 'synth-1-msg-101',
    accountId: 'synth-1',
    folderPath: 'INBOX',
    subject: 'Test Subject',
    author: 'alice@example.com',
    to: 'user@synth.test',
    date: '2026-09-20T10:00:00.000Z',
    unread: true,
    starred: false,
    reference: synthReference,
    attachments: [
      { id: '2', filename: 'report.pdf', mimeType: 'application/pdf', size: 2048 }
    ]
  };

  const reader = {
    async folders(current) {
      return { folders: [{ id: 'INBOX', label: 'Inbox', accountIds: current.map(a => a.id) }], errors: [] };
    },
    async list(current, settings) {
      readerCalls.push({ current: current.map(a => a.id), settings: structuredClone(settings) });
      return {
        messages: [structuredClone(synthMessage)],
        total: 1,
        totalComplete: true,
        errors: [],
        nextCursor: null
      };
    },
    ...overrides.reader
  };

  let tagVersion = 1;
  const tags = overrides.tags !== undefined ? overrides.tags : {
    definitions: () => [{ id: 'important', label: 'Important' }],
    version: () => tagVersion,
    entries: (current, opts) => [
      { reference: structuredClone(synthReference), message: structuredClone(synthMessage) }
    ],
    observe: async () => ({ changed: false }),
    tagsFor: () => ['important'],
    tagsForMany: () => [['important']]
  };

  const mail = createMailApi({
    accounts,
    reader,
    tags,
    processing: overrides.processing,
    conversations: overrides.conversations
  });

  return { mail, reader, readerCalls, synthMessage, synthReference };
}

test('mail.list forwards includeAttachments: true on standard folder listing', async () => {
  const { mail, readerCalls } = createHarness();
  const res = await mail.list({ folder: 'inbox' });
  assert.equal(readerCalls.length, 1);
  const { settings } = readerCalls[0];
  assert.equal(settings.includeAttachments, true);
  assert.equal(settings.folder, 'inbox');
  assert.equal(settings.sort, 'date_desc');
  assert.equal(settings.bodySearch, false);
  assert.equal(res.messages.length, 1);
  assert.equal(res.messages[0].attachments.length, 1);
  assert.equal(res.messages[0].attachments[0].id, '2');
  assert.equal(res.messages[0].attachments[0].filename, 'report.pdf');
  assert.equal(res.messages[0].attachments[0].mimeType, 'application/pdf');
});

test('mail.list forwards includeAttachments: true and preserves filters.hasAttachment: false', async () => {
  const { mail, readerCalls } = createHarness();
  const res = await mail.list({ folder: 'inbox', filters: { hasAttachment: false } });
  assert.equal(readerCalls.length, 1);
  const { settings } = readerCalls[0];
  assert.equal(settings.includeAttachments, true);
  assert.equal(settings.filters.hasAttachment, false);
});

test('mail.list forwards includeAttachments: true in advanced tag search with filters', async () => {
  const { mail, readerCalls } = createHarness();
  const res = await mail.list({ folder: 'tag:important', filters: { hasAttachment: false } });
  assert.equal(readerCalls.length, 1);
  const { settings } = readerCalls[0];
  assert.equal(settings.includeAttachments, true);
  assert.equal(settings.folder, 'all');
  assert.equal(settings.filters.hasAttachment, false);
  assert.ok(Array.isArray(settings.scopedReferences));
  assert.equal(settings.scopedReferences.length, 1);
  assert.equal(settings.scopedReferences[0].uid, 101);
});

test('mail.list forwards includeAttachments: true in advanced tag search with bodySearch', async () => {
  const { mail, readerCalls } = createHarness();
  const res = await mail.list({ folder: 'tag:important', bodySearch: true });
  assert.equal(readerCalls.length, 1);
  const { settings } = readerCalls[0];
  assert.equal(settings.includeAttachments, true);
  assert.equal(settings.folder, 'all');
  assert.equal(settings.bodySearch, true);
});

test('mail.list basic tag search without advanced filters does not invoke reader.list', async () => {
  const { mail, readerCalls } = createHarness();
  const res = await mail.list({ folder: 'tag:important' });
  assert.equal(readerCalls.length, 0);
  assert.equal(res.messages.length, 1);
  assert.equal(res.messages[0].id, 'synth-1-msg-101');
});

test('mail.list sanitizes attachment metadata received from reader', async () => {
  const unsanitizedMessage = {
    id: 'synth-1-msg-101',
    accountId: 'synth-1',
    folderPath: 'INBOX',
    subject: 'Unsafe attachment metadata',
    author: 'attacker@example.com',
    date: '2026-09-20T10:00:00.000Z',
    reference: { accountId: 'synth-1', path: 'INBOX', uid: 101, uidValidity: '12345', fingerprint: 'a'.repeat(64) },
    attachments: [
      { id: '2', filename: 'clean.png', mimeType: 'image/png', size: 100 },
      { id: '3', filename: '../../../etc/passwd\u0000', mimeType: 'text/plain', size: 50 },
      { id: '4', filename: 'unknown.bin', mimeType: 'bad;mime/type', size: 200 },
      { id: '5', filename: 'file.txt', mimeType: 'text/plain' }
    ]
  };

  const { mail } = createHarness({
    reader: {
      async list() {
        return { messages: [unsanitizedMessage], total: 1, totalComplete: true, errors: [], nextCursor: null };
      }
    }
  });

  const res = await mail.list({ folder: 'inbox' });
  assert.equal(res.messages.length, 1);
  const atts = res.messages[0].attachments;
  assert.equal(atts.length, 4);
  assert.equal(atts[0].filename, 'clean.png');
  assert.equal(atts[0].mimeType, 'image/png');
  assert.equal(atts[1].filename, '../../../etc/passwd');
  assert.doesNotMatch(atts[1].filename, /\u0000/);
  assert.equal(atts[2].mimeType, 'bad;mime/type');
  assert.equal(atts[3].size, null);
});

test('mail.list rejects invalid filter types', async () => {
  const { mail } = createHarness();
  await assert.rejects(
    () => mail.list({ folder: 'inbox', filters: { hasAttachment: 'not-a-boolean' } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
  await assert.rejects(
    () => mail.list({ folder: 'inbox', filters: { minSize: -1 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
  await assert.rejects(
    () => mail.list({ folder: 'inbox', filters: { minSize: 100, maxSize: 50 } }),
    err => err instanceof MailHarborError && err.code === 'invalid_request'
  );
});
