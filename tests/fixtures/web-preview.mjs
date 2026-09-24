// Local synthetic UI acceptance fixture. Never connects to mail providers or an AI service.
import { createServer, closeServer } from '../../server/app.mjs';
import { createWebFactory } from '../../server/web-app.mjs';
import { ACCOUNT_PRESETS } from './accounts.mjs';
import { MAIL_FOLDERS } from '../../server/mail-api.mjs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { MailHarborError, VERSION } from '../../server/validation.mjs';
import { sanitizeMailHtml } from '../../server/mail-content.mjs';
import { createComposeRecovery, sanitizeComposeHtml, recoveryDigest } from '../../server/compose-recovery.mjs';

const port = Number(process.env.MAILHARBOR_PREVIEW_PORT || 18765);
const origin = `http://127.0.0.1:${port}`;
const token = 'synthetic-preview-pairing-token-only';
const previewAgyLogin = process.env.MAILHARBOR_PREVIEW_AGY_LOGIN === '1';
let fixtureAgyConnected = !previewAgyLogin, fixtureAgyAttempt = null;
// Session-owned synthetic states only. No subprocess, provider request, or real credentials.
const fixtureAgyLogin = {
  status(owner) {
    if (!fixtureAgyAttempt || fixtureAgyAttempt.owner !== owner) return { state: 'idle' };
    const { owner: ignored, ...value } = fixtureAgyAttempt;
    return structuredClone(value);
  },
  start(owner) {
    if (!owner) throw new MailHarborError('unauthorized');
    if (fixtureAgyAttempt?.state === 'awaiting_code') {
      if (fixtureAgyAttempt.owner !== owner) throw new MailHarborError('busy');
      return this.status(owner);
    }
    fixtureAgyAttempt = {
      owner, state: 'awaiting_code', expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      url: 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=synthetic-preview.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Flocalhost%2Fsynthetic-preview&state=synthetic-preview-only'
    };
    return this.status(owner);
  },
  submitCode(owner, code) {
    if (!fixtureAgyAttempt || fixtureAgyAttempt.owner !== owner) throw new MailHarborError('not_found');
    if (fixtureAgyAttempt.state !== 'awaiting_code' || typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~+/=\-]{7,2047}$/.test(code)) throw new MailHarborError('invalid_request');
    fixtureAgyConnected = true;
    fixtureAgyAttempt = { owner, state: 'connected' };
    return this.status(owner);
  },
  cancel(owner) {
    if (!fixtureAgyAttempt || fixtureAgyAttempt.owner !== owner) throw new MailHarborError('not_found');
    fixtureAgyAttempt = { owner, state: 'cancelled' };
    return this.status(owner);
  },
  close() { fixtureAgyAttempt = null; }
};

let stored = {
  schema: 1,
  providers: {},
  accounts: ACCOUNT_PRESETS.map(account => ({
    ...account,
    revision: 'fixture-v1',
    connected: true,
    connectedAt: '2026-09-13',
    auth: { type: 'password', password: 'fixture-only' }
  }))
};

let updateChain = Promise.resolve();
const store = {
  read: () => structuredClone(stored),
  async update(fn) {
    const run = async () => {
      const next = structuredClone(stored);
      const value = await fn(next);
      stored = next;
      return value;
    };
    const nextPromise = updateChain.then(run, run);
    updateChain = nextPromise.catch(() => {});
    return nextPromise;
  }
};

const escapeHtml = str => String(str ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const cleanHeader = str => String(str ?? '').replace(/[\r\n\u0000-\u001f\u007f]/gu, '').slice(0, 998);

// Small local files exercise actual browser image/PDF decoding without external assets.
function fixturePng() {
  const chunk = (name, bytes) => {
    const payload = Buffer.concat([Buffer.from(name), bytes]);
    let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const header = Buffer.alloc(4), checksum = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, payload, checksum]);
  };
  const width = 320, height = 180;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    const color = x > 35 && x < 285 && y > 35 && y < 145 ? [24, 74, 70] : [234, 240, 228];
    pixels.set(color, offset);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function fixturePdf() {
  const content = 'BT /F1 20 Tf 45 160 Td (MailHarbor attachment preview) Tj 0 -35 Td /F1 12 Tf (Fictional PDF - no real mailbox data.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function fixtureThreePagePdf() {
  const content1 = 'BT /F1 16 Tf 50 200 Td (Page 1 of 3 - Document Introduction) Tj ET';
  const content2 = 'BT /F1 16 Tf 50 200 Td (Page 2 of 3 - Detailed Information) Tj ET';
  const content3 = 'BT /F1 16 Tf 50 200 Td (Page 3 of 3 - Summary and Sign-off) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 240] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 240] /Resources << /Font << /F1 6 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 240] /Resources << /Font << /F1 6 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content1)} >>\nstream\n${content1}\nendstream`,
    `<< /Length ${Buffer.byteLength(content2)} >>\nstream\n${content2}\nendstream`,
    `<< /Length ${Buffer.byteLength(content3)} >>\nstream\n${content3}\nendstream`
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const fixtureAttachments = [
  {id: '2', filename: 'Harbor postcard.png', mimeType: 'image/png', bytes: fixturePng()},
  {id: '3', filename: 'Meeting notes.txt', mimeType: 'text/plain', bytes: Buffer.from('Fictional meeting notes\n\nReview the schedule for next week.\n<script>This must remain harmless text.</script>\n')},
  {id: '4', filename: 'Delivery summary.pdf', mimeType: 'application/pdf', bytes: fixturePdf()},
  {id: '5', filename: 'Email export.html', mimeType: 'text/html', bytes: Buffer.from('<!doctype html><title>Fictional mail export</title><p>Download-only fixture.</p>')},
  {id: '6', filename: 'Project overview.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Buffer.from(zipSync({
    '[Content_Types].xml': Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/document.xml': Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fictional project overview for MailHarbor.</w:t></w:r></w:p></w:body></w:document>')
  }))},
  {id: '7', filename: 'Annual report.pdf', mimeType: 'application/pdf', bytes: fixtureThreePagePdf()},
  {id: '8', filename: 'Invoice breakdown.pdf', mimeType: 'application/pdf', bytes: fixturePdf()}
].map(attachment => ({...attachment, size: attachment.bytes.length}));

const subjects = ['Your order is on its way', 'Interview availability next week', 'September invoice', 'Weekend offers inside', 'Project notes and next steps', 'Dinner on Friday?', '<img src=x onerror=alert(1)> remains harmless text'];

const base = Array.from({ length: 124 }, (_, index) => {
  const account = ACCOUNT_PRESETS[index % 4];
  return {
    id: `fixture-${index}`,
    accountId: account.id,
    account: account.label,
    folderPath: 'INBOX',
    subject: subjects[index % subjects.length],
    author: index % 2 ? 'Alex Morgan <alex@example.test>' : 'Harbor Shop <orders@example.test>',
    to: 'You <you@example.test>',
    cc: 'Team <team@example.test>',
    replyTo: 'Alex <alex@example.test>',
    messageId: `<fixture-${index}@example.test>`,
    inReplyTo: index >= 4 && index % 4 === 0 ? `<fixture-${index - 4}@example.test>` : '',
    references: index >= 4 && index % 4 === 0 ? [`<fixture-${index - 4}@example.test>`] : [],
    threadId: index % 4 === 0 ? 'fixture-thread-0' : `fixture-thread-${index}`,
    size: 12000 + index * 500,
    hasAttachments: true,
    date: new Date(Date.UTC(2026, 8, 13, 12) - index * 1800000).toISOString(),
    unread: index % 3 !== 0,
    starred: index % 7 === 0,
    reference: {
      accountId: account.id,
      path: 'INBOX',
      uid: index + 1,
      uidValidity: '1',
      fingerprint: createHash('sha256').update(`fictional-${index}`).digest('hex')
    }
  };
});

// Sample 0: 'Service notice (no attachments)' - plain-only body, no attachments
base[0].subject = 'Service notice (no attachments)';
base[0].hasAttachments = false;
base[0].snippet = 'Official service notice regarding operational maintenance. Plain text only.';
base[0].customAttachments = [];

// Sample 1: 'Annual financial report 2026' - one actual three-page PDF
base[1].subject = 'Annual financial report 2026';
base[1].hasAttachments = true;
base[1].snippet = 'Please find attached the 3-page Annual Financial Report for 2026.';
base[1].customAttachments = [fixtureAttachments.find(a => a.filename === 'Annual report.pdf')];

// Sample 2: 'Delivery summary and invoice breakdown' - two PDFs
base[2].subject = 'Delivery summary and invoice breakdown';
base[2].hasAttachments = true;
base[2].snippet = 'Two PDF documents are attached for review: Delivery summary and Invoice breakdown.';
base[2].customAttachments = [
  fixtureAttachments.find(a => a.filename === 'Delivery summary.pdf'),
  fixtureAttachments.find(a => a.filename === 'Invoice breakdown.pdf')
];

// Sample 3: 'Harbor weekly update' - safe styled HTML, no attachments (part of header graph thread with 7, 11, 15)
base[3].subject = 'Harbor weekly update';
base[3].hasAttachments = false;
base[3].snippet = 'Harbor weekly update with project highlights, system status, and roadmap details.';
base[3].customAttachments = [];
base[3].folderPath = 'INBOX';
base[3].reference.path = 'INBOX';
base[3].messageId = '<harbor-thread-1@example.test>';
base[3].inReplyTo = '';
base[3].references = [];
base[3].threadId = 'fixture-thread-harbor';
base[3].author = 'Alex Morgan <alex@example.test>';
base[3].to = 'You <you@example.test>';
base[3].date = '2026-09-13T09:00:00.000Z';

// Thread index 7: Sent reply
base[7].subject = 'Re: Harbor weekly update';
base[7].hasAttachments = false;
base[7].snippet = 'Sent reply: Reviewed the weekly highlights and milestones.';
base[7].customAttachments = [];
base[7].folderPath = 'Sent';
base[7].reference.path = 'Sent';
base[7].messageId = '<harbor-thread-2@example.test>';
base[7].inReplyTo = '<harbor-thread-1@example.test>';
base[7].references = ['<harbor-thread-1@example.test>'];
base[7].threadId = 'fixture-thread-harbor';
base[7].author = 'You <you@example.test>';
base[7].to = 'Alex Morgan <alex@example.test>';
base[7].date = '2026-09-13T09:30:00.000Z';

// Thread index 11: INBOX follow-up
base[11].subject = 'Re: Harbor weekly update';
base[11].hasAttachments = false;
base[11].snippet = 'Follow-up on the roadmap and sprint scheduling.';
base[11].customAttachments = [];
base[11].folderPath = 'INBOX';
base[11].reference.path = 'INBOX';
base[11].messageId = '<harbor-thread-3@example.test>';
base[11].inReplyTo = '<harbor-thread-2@example.test>';
base[11].references = ['<harbor-thread-1@example.test>', '<harbor-thread-2@example.test>'];
base[11].threadId = 'fixture-thread-harbor';
base[11].author = 'Alex Morgan <alex@example.test>';
base[11].to = 'You <you@example.test>';
base[11].date = '2026-09-13T10:00:00.000Z';

// Thread index 15: Sent confirmation
base[15].subject = 'Re: Harbor weekly update';
base[15].hasAttachments = false;
base[15].snippet = 'Sent confirmation: All schedule items are finalized.';
base[15].customAttachments = [];
base[15].folderPath = 'Sent';
base[15].reference.path = 'Sent';
base[15].messageId = '<harbor-thread-4@example.test>';
base[15].inReplyTo = '<harbor-thread-3@example.test>';
base[15].references = ['<harbor-thread-1@example.test>', '<harbor-thread-2@example.test>', '<harbor-thread-3@example.test>'];
base[15].threadId = 'fixture-thread-harbor';
base[15].author = 'You <you@example.test>';
base[15].to = 'Alex Morgan <alex@example.test>';
base[15].date = '2026-09-13T10:30:00.000Z';

const providerFolderId = (accountId, path) => `folder:${createHash('sha256').update(JSON.stringify([accountId, path])).digest('hex')}`;
const folderPaths = { inbox: 'INBOX', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', junk: 'Spam', trash: 'Trash' };
const customFolders = ACCOUNT_PRESETS.map(account => ({ accountId: account.id, path: 'Projects' }));
let fixtureRevision = 0, fixtureUid = 30000;

for (const [index, path] of [[120, 'Drafts'], [121, 'Drafts'], [122, 'Archive'], [123, 'Trash']]) {
  base[index].folderPath = path;
  base[index].reference.path = path;
}

const inFolder = (message, folder) => folder === 'all' ? !['Trash', 'Spam'].includes(message.folderPath) :
  folder === 'starred' ? message.starred && !['Trash', 'Spam'].includes(message.folderPath) : folder === 'unread' ? message.folderPath === 'INBOX' && message.unread :
  folder.startsWith('folder:') ? providerFolderId(message.accountId, message.folderPath) === folder : message.folderPath === folderPaths[folder];

const getMessageAttachments = message => (
  message.customAttachments !== undefined
    ? message.customAttachments
    : (message.hasAttachments ? fixtureAttachments : [])
);

const getMessageAttachmentsMetadata = message =>
  getMessageAttachments(message).map(att => ({
    id: String(att.id),
    filename: att.filename,
    mimeType: att.mimeType,
    size: att.size ?? att.bytes?.length ?? 0
  }));

const fixtureMessage = (account, reference) => {
  if (!reference || !account || reference.accountId !== account.id) throw new MailHarborError('stale_message');
  const message = base.find(m =>
    m.accountId === account.id &&
    m.reference.path === reference.path &&
    m.reference.uid === reference.uid &&
    String(m.reference.uidValidity) === String(reference.uidValidity) &&
    m.reference.fingerprint === reference.fingerprint
  );
  if (!message) throw new MailHarborError('stale_message');
  return message;
};

const messageToHeader = message => {
  const atts = getMessageAttachmentsMetadata(message);
  return {
    id: message.id,
    accountId: message.accountId,
    account: message.account,
    folderPath: message.folderPath,
    subject: message.subject,
    author: message.author,
    to: message.to,
    cc: message.cc || '',
    replyTo: message.replyTo || '',
    messageId: message.messageId,
    inReplyTo: message.inReplyTo || '',
    references: Array.isArray(message.references) ? [...message.references] : [],
    threadId: message.threadId,
    size: message.size,
    hasAttachments: atts.length > 0,
    attachments: atts,
    date: message.date,
    unread: Boolean(message.unread),
    starred: Boolean(message.starred),
    snippet: String(message.snippet || 'Review the schedule for next week.').slice(0, 160),
    reference: structuredClone(message.reference)
  };
};

const reader = {
  async folders(accounts) {
    return {
      folders: [...MAIL_FOLDERS, { id: 'all', label: 'All mail' }].map(folder => ({
        ...folder,
        accountIds: accounts.map(value => value.id),
        counts: accounts.map(account => ({ accountId: account.id, total: base.filter(message => message.accountId === account.id && inFolder(message, folder.id)).length }))
      })).concat(accounts.flatMap(account =>
        [...Object.values(folderPaths), ...customFolders.filter(folder => folder.accountId === account.id).map(folder => folder.path)].map(path => ({
          id: providerFolderId(account.id, path),
          label: path,
          type: 'provider',
          path,
          specialUse: Object.entries(folderPaths).find(([, value]) => value === path)?.[0] || null,
          accountIds: [account.id],
          counts: [{ accountId: account.id, total: base.filter(message => message.accountId === account.id && message.folderPath === path).length }]
        })))),
      errors: []
    };
  },
  async list(accounts, { folder, query, cursor, limit, filters = {}, sort = 'date_desc', bodySearch = false }) {
    let values = base.filter(message => accounts.some(account => account.id === message.accountId) && inFolder(message, folder));
    if (query) values = values.filter(message => `${message.subject} ${message.author} ${message.to} ${bodySearch ? 'fictional schedule test mailbox' : ''}`.toLowerCase().includes(query.toLowerCase()));
    for (const [key, filter] of Object.entries(filters)) values = values.filter(message => {
      if (key === 'from') return message.author.toLowerCase().includes(filter.toLowerCase());
      if (['to', 'subject'].includes(key)) return message[key].toLowerCase().includes(filter.toLowerCase());
      if (key === 'body') return 'fictional schedule test mailbox'.includes(filter.toLowerCase());
      if (key === 'since') return message.date >= filter;
      if (key === 'before') return message.date < filter;
      if (['unread', 'starred'].includes(key)) return message[key] === filter;
      if (key === 'hasAttachment') return (getMessageAttachments(message).length > 0) === filter;
      if (key === 'minSize') return message.size >= filter;
      if (key === 'maxSize') return message.size <= filter;
      return true;
    });
    values.sort((a, b) => sort === 'date_asc' ? a.date.localeCompare(b.date) : sort === 'subject_asc' ? a.subject.localeCompare(b.subject) : sort === 'sender_asc' ? a.author.localeCompare(b.author) : b.date.localeCompare(a.date));
    const offset = cursor?.offset ?? 0;
    const page = values.slice(offset, offset + limit).map(messageToHeader);
    return { messages: structuredClone(page), nextCursor: values.length > offset + limit ? { offset: offset + limit } : null, errors: [], total: values.length, totalComplete: true };
  },
  async read(account, reference) {
    const message = fixtureMessage(account, reference);
    const header = messageToHeader(message);
    return {
      ...header,
      body: message.id === 'fixture-0' ?
        'Dear customer,\n\nThis is an official service notice regarding your MailHarbor account. All systems are operational.\nThere are no attachments included in this notice.\n\nBest regards,\nMailHarbor Operations' :
        'Hi there,\n\nThis is a fictional email for testing MailHarbor. No real mailbox was read.\n\nHere are the details for next week. Please review the schedule and let me know what works for you.\n\n<script>alert("This stays plain text")</script>\n\nBest,\nAlex',
      truncated: reference.uid % 5 === 0,
      bodyUnavailable: false
    };
  },
  async attachment(account, reference, attachmentId) {
    if (attachmentId === 'harbor-raster-part') {
      const bytes = fixturePng();
      return { id: 'harbor-raster-part', filename: 'harbor-preview-raster.png', mimeType: 'image/png', bytes, size: bytes.length };
    }
    const message = fixtureMessage(account, reference);
    const attachments = getMessageAttachments(message);
    const attachment = attachments.find(item => String(item.id) === String(attachmentId));
    if (!attachment) throw new MailHarborError('attachment_unavailable');
    return { id: String(attachment.id), filename: attachment.filename, mimeType: attachment.mimeType, bytes: attachment.bytes, size: attachment.size };
  },
  async source(account, reference) {
    const message = fixtureMessage(account, reference);
    const cleanSubj = cleanHeader(message.subject);
    return Buffer.from(`From: alex@example.test\r\nTo: ${account.email}\r\nSubject: ${cleanSubj}\r\nMessage-ID: ${message.messageId}\r\nDate: ${message.date}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${fixtureBody}`);
  },
  async content(account, reference, options = {}) {
    return fixtureContent.read(account, reference, options);
  },
  async apply(account, reference, action, options = {}) {
    const message = fixtureMessage(account, reference);
    if (action === 'delete_permanent') { base.splice(base.indexOf(message), 1); fixtureRevision++; return { applied: true }; }
    if (['delete', 'archive', 'spam', 'not_spam', 'restore', 'move'].includes(action)) {
      const previousPath = message.folderPath;
      const path = action === 'move' ? [...Object.values(folderPaths), ...customFolders.filter(folder => folder.accountId === account.id).map(folder => folder.path)].find(p => providerFolderId(account.id, p) === options.destinationId) :
        ({ delete: 'Trash', archive: 'Archive', spam: 'Spam', not_spam: 'INBOX', restore: 'INBOX' })[action];
      if (!path || path === previousPath) throw new MailHarborError('move_unavailable');
      message.id = `fixture-moved-${++fixtureUid}`;
      message.folderPath = path;
      message.reference = {
        ...message.reference,
        path,
        uid: fixtureUid,
        fingerprint: createHash('sha256').update(`fictional-${fixtureUid}`).digest('hex')
      };
      fixtureRevision++;
      return { applied: true, reference: structuredClone(message.reference), undo: { reference: structuredClone(message.reference), destinationId: providerFolderId(account.id, previousPath) } };
    }
    if (action === 'mark_read') message.unread = false;
    if (action === 'mark_unread') message.unread = true;
    if (action === 'star') message.starred = true;
    if (action === 'unstar') message.starred = false;
    fixtureRevision++; return { applied: true };
  },
  async emptyTrash(account) { const values = base.filter(message => message.accountId === account.id && message.folderPath === 'Trash'); for (const value of values) base.splice(base.indexOf(value), 1); fixtureRevision++; return { deleted: values.length, remaining: 0, partial: false, errors: [] }; },
  async manageFolder(account, input) {
    if (input.action === 'rename') {
      const folder = customFolders.find(folder => folder.accountId === account.id && providerFolderId(account.id, folder.path) === input.folderId);
      if (!folder) throw new MailHarborError('folder_unavailable');
      const previous = folder.path; folder.path = input.name;
      for (const message of base.filter(message => message.accountId === account.id && message.folderPath === previous)) { message.folderPath = input.name; message.reference.path = input.name; }
    } else customFolders.push({ accountId: account.id, path: input.name });
    fixtureRevision++; return { applied: true, folder: { id: providerFolderId(account.id, input.name), label: input.name, type: 'provider', accountIds: [account.id] } };
  },
  async providerLabels() { return { supported: true, kind: 'keywords', labels: ['Projects', 'Followup'], allowCreate: true }; },
  async setProviderLabel(account, reference) { fixtureMessage(account, reference); return { applied: true }; },
  async changes() { return { states: [], errors: [] }; }
};

const fixtureBody = 'Hi there,\n\nThis is a complete fictional message. MailHarbor now shows the full message with an isolated HTML view, original headers, source export and attachment bundles.\n\nBest,\nAlex';
const fixtureLongHtml = Array.from({length: 10}, (_, index) => `<p style="line-height: 1.5; margin: 0 0 12px 0;"><strong>Project note ${index + 1}.</strong> This fictional update keeps the message long enough to check that the reader scrolls naturally. Review the schedule and leave the rest of the mailbox in place while reading.</p>`).join('');

const harborWeeklyUpdateHtmlRaw = `
  <div style="font-family: Arial, sans-serif; font-size: 14px; color: #1f2937; line-height: 1.6;">
    <h2 style="color: #102a43; font-size: 20px; margin-bottom: 12px;">Harbor Weekly Update</h2>
    <p>Welcome to this week's digest. Here is the operational summary across key teams.</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; width: 100%; border-color: #cbd5e1; margin: 16px 0;">
      <thead>
        <tr style="background-color: #f1f5f9;">
          <th align="left" style="padding: 8px; color: #0f172a;">Section</th>
          <th align="left" style="padding: 8px; color: #0f172a;">Details</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="padding: 8px; font-weight: bold; vertical-align: top;">Infrastructure</td>
          <td style="padding: 8px;">
            <table border="0" cellpadding="4" cellspacing="0" style="width: 100%;">
              <tr>
                <td style="color: #15803d; font-weight: 500;">Mail UI</td>
                <td>Refactored and tested</td>
              </tr>
              <tr>
                <td style="color: #0369a1; font-weight: 500;">Preview Fixture</td>
                <td>Synthetic localhost operational</td>
              </tr>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
    <p>Detailed tracking link: <a href="https://example.test/updates/2026/09/weekly-digest-long-url-path-with-parameters-for-testing-wrap-and-overflow?session=preview-session-token-abc123xyz789&source=newsletter-subscription-test-run" target="_blank" rel="noopener noreferrer">https://example.test/updates/2026/09/weekly-digest-long-url-path-with-parameters-for-testing-wrap-and-overflow?session=preview-session-token-abc123xyz789&source=newsletter-subscription-test-run</a></p>
    <p><img alt="Remote newsletter banner tracker" width="300" height="80" src="https://example.test/images/newsletter-remote-banner.png"></p>
    <p><img alt="Harbor raster preview" width="320" height="180" src="cid:harbor-preview-raster"></p>
    <script>alert("Never execute HTML script in fixture")</script>
    <p>End of weekly update. Remote images remain blocked.</p>
  </div>
`;

const fixtureContent = {
  async read(account, reference, options = {}) {
    const message = fixtureMessage(account, reference);
    const attachments = getMessageAttachmentsMetadata(message);

    if (message.id === 'fixture-0') {
      // Plain-only sample: html is null, no attachments, safe
      return {
        text: 'Dear customer,\n\nThis is an official service notice regarding your MailHarbor account. All systems are operational.\nThere are no attachments included in this notice.\n\nBest regards,\nMailHarbor Operations',
        html: null,
        safe: true,
        headers: `From: Operations <operations@example.test>\r\nTo: ${account.email}\r\nSubject: ${cleanHeader(message.subject)}\r\nMessage-ID: ${message.messageId}\r\nDate: ${message.date}\r\nContent-Type: text/plain; charset=utf-8`,
        subject: message.subject,
        from: [{ name: 'Operations', address: 'operations@example.test' }],
        to: [{ name: 'You', address: account.email }],
        cc: [],
        bcc: [],
        replyTo: [{ name: 'Operations', address: 'operations@example.test' }],
        attachments: [],
        inlineParts: [],
        complete: true,
        sanitized: true,
        rendererVersion: '2',
        encrypted: null,
        blockedImages: null,
        ...(options?.includeInlineImages ? { inlineImagesLoaded: true, inlineImagesStatus: 'complete' } : {})
      };
    }

    if (message.id === 'fixture-3') {
      // Safe styled HTML sample with nested table, long url, remote image placeholder, and CID raster preview
      const inlineAttachments = options?.includeInlineImages ?
        [{ contentId: 'harbor-preview-raster', contentType: 'image/png', content: fixturePng() }] : [];
      const sanitizedHtml = sanitizeMailHtml(harborWeeklyUpdateHtmlRaw, inlineAttachments);
      const hasBlocked = sanitizedHtml.includes('data-blocked-image="true"');
      const png = fixturePng();
      const inlineParts = [{
        id: 'harbor-raster-part',
        contentId: 'harbor-preview-raster',
        mimeType: 'image/png',
        size: png.length
      }];

      return {
        text: 'Harbor Weekly Update\n\nWelcome to this week\'s digest. Project highlights and system status are available.\n\nLink: https://example.test/updates/2026/09/weekly-digest-long-url-path-with-parameters-for-testing-wrap-and-overflow?session=preview-session-token-abc123xyz789&source=newsletter-subscription-test-run',
        html: sanitizedHtml,
        safe: true,
        headers: `From: Alex Morgan <alex@example.test>\r\nTo: ${account.email}\r\nSubject: ${cleanHeader(message.subject)}\r\nMessage-ID: ${message.messageId}\r\nDate: ${message.date}\r\nContent-Type: text/html; charset=utf-8`,
        subject: message.subject,
        from: [{ name: 'Alex Morgan', address: 'alex@example.test' }],
        to: [{ name: 'You', address: account.email }],
        cc: [{ name: 'Team', address: 'team@example.test' }],
        bcc: [],
        replyTo: [{ name: 'Alex Morgan', address: 'alex@example.test' }],
        attachments: [],
        inlineParts,
        complete: true,
        sanitized: true,
        rendererVersion: '2',
        encrypted: null,
        blockedImages: hasBlocked ? 'Remote images are blocked to protect your privacy.' : null,
        ...(options?.includeInlineImages ? { inlineImagesLoaded: true, inlineImagesStatus: 'complete' } : {})
      };
    }

    // Default sample for other fixture messages
    const rawHtml = `
      <div style="font-family: sans-serif; font-size: 14px; color: #111827; line-height: 1.5;">
        <h2 style="color: #1f2937; margin-bottom: 8px;">${escapeHtml(message.subject)}</h2>
        <p>This is a complete <strong>fictional message</strong> for MailHarbor UI testing.</p>
        <p><a href="${origin}/?mail-view-link-check=1" target="_blank" rel="noopener noreferrer">Open local message link check</a></p>
        <table border="1" cellpadding="4" cellspacing="0" style="border-collapse: collapse; width: 100%;">
          <tr><th>Topic</th><th>Status</th></tr>
          <tr><td>Mailbox improvements</td><td>Ready for review</td></tr>
        </table>
        ${fixtureLongHtml}
        <script>alert("script removed")</script>
      </div>
    `;
    const sanitizedHtml = sanitizeMailHtml(rawHtml, []);
    const hasBlocked = sanitizedHtml.includes('data-blocked-image="true"');

    return {
      text: fixtureBody,
      html: sanitizedHtml,
      safe: true,
      headers: `From: Alex <alex@example.test>\r\nTo: ${account.email}\r\nSubject: ${cleanHeader(message.subject)}\r\nMessage-ID: ${message.messageId}\r\nDate: ${message.date}`,
      subject: message.subject,
      from: [{ name: 'Alex', address: 'alex@example.test' }],
      to: [{ name: 'You', address: account.email }],
      cc: [{ name: 'Team', address: 'team@example.test' }],
      bcc: [],
      replyTo: [{ name: 'Alex', address: 'alex@example.test' }],
      attachments,
      inlineParts: [],
      complete: true,
      sanitized: true,
      rendererVersion: '2',
      encrypted: null,
      blockedImages: hasBlocked ? 'Remote images are blocked to protect your privacy.' : null,
      ...(options?.includeInlineImages ? { inlineImagesLoaded: true, inlineImagesStatus: 'complete' } : {})
    };
  },
  async source(account, reference) {
    const message = fixtureMessage(account, reference);
    const cleanSubj = cleanHeader(message.subject);
    return {
      bytes: Buffer.from(`From: alex@example.test\r\nTo: ${account.email}\r\nSubject: ${cleanSubj}\r\nMessage-ID: ${message.messageId}\r\nDate: ${message.date}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${fixtureBody}`),
      filename: 'message.eml',
      mimeType: 'message/rfc822'
    };
  },
  async headers(account, reference) {
    const res = await this.read(account, reference);
    return { bytes: Buffer.from(res.headers), filename: 'headers.txt', mimeType: 'text/plain; charset=utf-8' };
  },
  async zip(account, reference, attachments) {
    const message = fixtureMessage(account, reference);
    const all = getMessageAttachments(message);
    if (!all.length) throw new MailHarborError('invalid_request');
    const target = Array.isArray(attachments) && attachments.length > 0
      ? all.filter(item => attachments.some(a => String(a.id) === String(item.id)))
      : all;
    if (!target.length) throw new MailHarborError('invalid_request');
    return {
      bytes: Buffer.from(zipSync(Object.fromEntries(target.map(item => [item.filename, item.bytes])))),
      filename: 'attachments.zip',
      mimeType: 'application/zip'
    };
  },
  async preview(account, reference, id) {
    const message = fixtureMessage(account, reference);
    const attachments = getMessageAttachments(message);
    const attachment = attachments.find(item => String(item.id) === String(id));
    if (!attachment) throw new MailHarborError('attachment_unavailable');
    return {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      text: 'Fictional project overview\n\nAll mailbox features are ready for review.\nThis preview contains no real mail.',
      truncated: false,
      kind: 'office'
    };
  }
};

const accountsService = {
  get(id) {
    const acc = store.read().accounts.find(account => account.id === id);
    if (!acc || acc.connected === false) throw new MailHarborError('stale_message');
    return acc;
  },
  list() {
    return store.read().accounts;
  }
};
const recovery = createComposeRecovery({ accounts: accountsService, store });

const draftPayloads = new Map(), sentRequests = new Map();
const fixtureComposer = {
  recovery,
  settings() {
    return {
      accounts: ACCOUNT_PRESETS.map(account => ({
        accountId: account.id,
        label: account.label,
        email: account.email,
        provider: account.provider,
        host: account.provider === 'google' ? 'smtp.gmail.com' : account.provider === 'microsoft' ? 'smtp-mail.outlook.com' : account.host,
        port: 587,
        sentCopy: account.provider === 'imap',
        authType: 'password',
        needsReconnect: false
      }))
    };
  },
  async configure() { return this.settings(); },
  async verify() { return { verified: true }; },
  async context({ id, mode }) {
    const message = base.find(item => item.id === id);
    if (!message) throw new MailHarborError('stale_message');
    if (mode === 'edit') {
      return {
        accountId: message.accountId,
        draftId: id,
        to: 'recipient@example.test',
        cc: '',
        bcc: '',
        subject: message.subject,
        text: 'A fictional draft, ready to edit.',
        attachments: [],
        ...draftPayloads.get(id)
      };
    }
    const isReplyAll = mode === 'reply_all' || mode === 'replyAll';
    return {
      accountId: message.accountId,
      to: mode === 'forward' ? '' : 'alex@example.test',
      cc: isReplyAll ? 'team@example.test' : '',
      bcc: '',
      subject: `${mode === 'forward' ? 'Fwd' : 'Re'}: ${message.subject}`,
      text: `\n\n${fixtureBody}`,
      attachments: [],
      inReplyTo: mode === 'forward' ? '' : message.messageId,
      references: mode === 'forward' ? '' : message.messageId
    };
  },
  async save(input) {
    const account = accountsService.get(input.accountId);
    if (input.draftId) {
      const old = base.find(m => m.id === input.draftId);
      if (!old || old.accountId !== account.id) {
        throw new MailHarborError('stale_message');
      }
    }
    const composeId = input.composeId;
    const recoveryRevision = input.recoveryRevision;
    if (composeId && recoveryRevision === undefined) {
      throw new MailHarborError('invalid_request');
    }

    const canonicalAttachments = (input.attachments || []).map(a => ({
      filename: a.filename,
      mimeType: a.mimeType || a.contentType || 'application/octet-stream',
      content: typeof a.content === 'string' ? a.content : Buffer.isBuffer(a.content) ? a.content.toString('base64') : ''
    }));
    const canonicalContent = {
      accountId: account.id,
      to: input.to || '',
      cc: input.cc || '',
      bcc: input.bcc || '',
      subject: input.subject || '',
      text: input.text || '',
      ...(input.html !== undefined && input.html !== null ? { html: sanitizeComposeHtml(input.html) } : {}),
      attachments: canonicalAttachments,
      inReplyTo: input.inReplyTo || '',
      references: input.references || '',
      providerDraftId: input.draftId || null
    };

    if (composeId) {
      recovery.validateSend({
        composeId,
        recoveryRevision,
        input: canonicalContent
      });
    }

    const uid = ++fixtureUid;
    const draftId = `fixture-draft-${uid}`;

    let nextRevision;
    if (composeId) {
      const recResult = await recovery.save({
        composeId,
        revision: recoveryRevision,
        content: {
          ...canonicalContent,
          providerDraftId: draftId
        }
      });
      nextRevision = recResult.revision;
    }

    if (input.draftId) {
      const oldIndex = base.findIndex(m => m.id === input.draftId && m.accountId === account.id);
      if (oldIndex !== -1) {
        base.splice(oldIndex, 1);
      }
      draftPayloads.delete(input.draftId);
    }

    base.unshift({
      id: draftId,
      accountId: account.id,
      account: account.label,
      author: account.email,
      to: input.to || '',
      subject: input.subject || '',
      folderPath: 'Drafts',
      unread: false,
      starred: false,
      date: new Date().toISOString(),
      reference: {
        accountId: account.id,
        path: 'Drafts',
        uid,
        uidValidity: '1',
        fingerprint: createHash('sha256').update(draftId).digest('hex')
      },
      snippet: (input.text || '').slice(0, 160),
      customAttachments: []
    });
    draftPayloads.set(draftId, { ...input, draftId });
    fixtureRevision++;

    return {
      saved: true,
      draftId,
      ...(composeId ? { composeId, ...(nextRevision !== undefined ? { recoveryRevision: nextRevision } : {}) } : {})
    };
  },
  async send(input) {
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/u.test(input.requestId)) throw new MailHarborError('invalid_request');
    const account = accountsService.get(input.accountId);
    const payloadDigest = createHash('sha256').update(JSON.stringify({ ...input, requestId: undefined })).digest('hex');
    if (sentRequests.has(input.requestId)) {
      const saved = sentRequests.get(input.requestId);
      if (saved.accountId !== input.accountId || saved.digest !== payloadDigest) {
        throw new MailHarborError('invalid_request');
      }
      return { ...saved.result, replayed: true };
    }

    if (input.draftId) {
      const old = base.find(m => m.id === input.draftId);
      if (!old || old.accountId !== account.id) {
        throw new MailHarborError('stale_message');
      }
    }

    const composeId = input.composeId;
    const recoveryRevision = input.recoveryRevision;
    if (composeId && recoveryRevision === undefined) {
      throw new MailHarborError('invalid_request');
    }

    const canonicalAttachments = (input.attachments || []).map(a => ({
      filename: a.filename,
      mimeType: a.mimeType || a.contentType || 'application/octet-stream',
      content: typeof a.content === 'string' ? a.content : Buffer.isBuffer(a.content) ? a.content.toString('base64') : ''
    }));
    const canonicalContent = {
      accountId: account.id,
      to: input.to || '',
      cc: input.cc || '',
      bcc: input.bcc || '',
      subject: input.subject || '',
      text: input.text || '',
      ...(input.html !== undefined && input.html !== null ? { html: sanitizeComposeHtml(input.html) } : {}),
      attachments: canonicalAttachments,
      inReplyTo: input.inReplyTo || '',
      references: input.references || '',
      providerDraftId: input.draftId || null
    };

    const recDigest = composeId ? recoveryDigest(canonicalContent) : null;

    if (composeId) {
      recovery.validateSend({
        composeId,
        recoveryRevision,
        input: canonicalContent
      });

      await store.update(async data => {
        recovery.markSubmitted({
          composeId,
          requestId: input.requestId,
          accountId: account.id,
          recoveryRevision,
          digest: recDigest,
          data
        });
      });
    }

    if (input.draftId) {
      const oldIndex = base.findIndex(m => m.id === input.draftId && m.accountId === account.id);
      if (oldIndex !== -1) {
        base.splice(oldIndex, 1);
      }
      draftPayloads.delete(input.draftId);
    }

    const uid = ++fixtureUid;
    const sentId = `fixture-sent-${uid}`;
    base.unshift({
      id: sentId,
      accountId: account.id,
      account: account.label,
      author: account.email,
      to: input.to || '',
      subject: input.subject || '',
      folderPath: 'Sent',
      unread: false,
      starred: false,
      date: new Date().toISOString(),
      reference: {
        accountId: account.id,
        path: 'Sent',
        uid,
        uidValidity: '1',
        fingerprint: createHash('sha256').update(sentId).digest('hex')
      },
      snippet: (input.text || '').slice(0, 160),
      customAttachments: []
    });

    const result = { sent: true, status: 'sent', accepted: [input.to || 'recipient@example.test'], rejected: [] };
    sentRequests.set(input.requestId, { accountId: account.id, digest: payloadDigest, result });

    if (composeId) {
      await store.update(async data => {
        recovery.markComplete({
          composeId,
          requestId: input.requestId,
          accountId: account.id,
          result,
          data
        });
      });
    }

    fixtureRevision++;
    return result;
  },
  close() {}
};

// Injectable conversations service
const HARBOR_THREAD_ACCOUNT_ID = ACCOUNT_PRESETS[3].id;
const HARBOR_THREAD_MESSAGE_IDS = new Set([
  '<harbor-thread-1@example.test>',
  '<harbor-thread-2@example.test>',
  '<harbor-thread-3@example.test>',
  '<harbor-thread-4@example.test>'
]);

const getThreadMembers = accountId => {
  if (accountId !== HARBOR_THREAD_ACCOUNT_ID) return [];
  return base
    .filter(m => m.accountId === accountId && HARBOR_THREAD_MESSAGE_IDS.has(m.messageId))
    .sort((a, b) => a.date.localeCompare(b.date));
};

const fixtureConversations = {
  async load(account, reference, { cursor, signal } = {}) {
    if (signal?.aborted) throw signal.reason ?? new MailHarborError('cancelled');
    const seed = fixtureMessage(account, reference);
    const isThreadMember = account.id === HARBOR_THREAD_ACCOUNT_ID && HARBOR_THREAD_MESSAGE_IDS.has(seed.messageId);

    if (!isThreadMember) {
      return {
        messages: [messageToHeader(seed)],
        complete: true,
        nextCursor: null,
        errors: []
      };
    }

    if (cursor !== undefined && cursor !== null) {
      if (cursor !== 'fixture-next') {
        throw new MailHarborError('stale_message');
      }
      const allMembers = getThreadMembers(account.id);
      return {
        messages: allMembers.map(messageToHeader),
        complete: true,
        nextCursor: null,
        errors: []
      };
    }

    const allMembers = getThreadMembers(account.id);
    const first2 = allMembers.slice(0, 2);
    const includesSeed = first2.some(m => m.id === seed.id);
    const initialBatch = includesSeed ? first2 : [...first2, seed].sort((a, b) => a.date.localeCompare(b.date));

    return {
      messages: initialBatch.map(messageToHeader),
      complete: false,
      nextCursor: 'fixture-next',
      errors: []
    };
  },
  clear() {},
  destroy() {}
};

const fixtureNotifications = {
  updates: () => ({ revision: fixtureRevision, checkedAt: new Date().toISOString(), errors: [] }),
  settings: () => ({ publicKey: '', devices: 0, intervalSeconds: 60 }),
  async subscribe() { return { saved: true }; },
  async unsubscribe() { return { removed: true }; },
  async ingest() { return { ingested: true }; },
  close() {}
};

const fixtureDrive = {
  status: () => ({
    configured: false,
    connected: false,
    expectedEmail: 'preview@example.test',
    callback: origin + '/oauth/drive/callback',
    scope: 'https://www.googleapis.com/auth/drive.file openid email'
  }),
  async configure() { return { configured: true }; },
  async start() { return { url: origin + '/oauth/drive/callback?code=synthetic' }; },
  async finish() { return { connected: true }; },
  async disconnect() { return { disconnected: true }; },
  async close() {}
};

const fixtureInvoices = {
  status: () => ({
    enabled: false,
    running: false,
    intervalMinutes: 20,
    job: null,
    lastRun: null,
    counts: { filed: 2, duplicates: 0, notInvoices: 0, needsReview: 1, waitingDrive: 1 },
    recent: [
      { id: 'fixture-review', status: 'needs_review', filename: 'September invoice.pdf', subject: 'September invoice', account: 'Fixture mailbox', reasons: ['missing_customer_identity'], createdAt: '2026-09-13T10:00:00Z' },
      { id: 'fixture-ready', status: 'waiting_drive', filename: 'invoice-2026-091.pdf', subject: 'Your invoice', account: 'Fixture mailbox', entity: 'example_company', invoiceDate: '2026-09-01', quarter: 3, year: 2026, folderPath: 'Invoices/Example Company/2026/Q3', reasons: ['drive_login_required'] }
    ]
  }),
  async close() {}
};

const reviewItems = [
  { id: 'a'.repeat(64), account: 'Personal fixture', author: 'Alex Morgan <alex@example.test>', subject: 'Confirm the workshop date', date: '2026-09-13T10:00:00Z', category: 'review', reasons: ['appointment_date_uncertain'], complete: true, labels: ['appointments'], dates: { couponExpiry: null, tenderDeadline: null, appointmentStart: '2026-09-20', appointmentEnd: null } },
  { id: 'b'.repeat(64), account: 'Business fixture', author: 'Harbor Shop <offers@example.test>', subject: '<img src=x onerror=alert(1)> remains harmless text', date: '2026-09-12T10:00:00Z', category: 'review', reasons: ['classification_uncertain'], complete: true, labels: ['coupons'], dates: { couponExpiry: null, tenderDeadline: null, appointmentStart: null, appointmentEnd: null } },
  { id: 'c'.repeat(64), account: 'Personal fixture', author: 'News <news@example.test>', subject: 'A long newsletter with incomplete text', date: '2026-09-11T10:00:00Z', category: 'held', reasons: ['incomplete_message'], contentReasons: ['decoded_text_limit'], complete: false, labels: ['newsletters'], dates: {} },
  { id: 'd'.repeat(64), account: 'Business fixture', author: 'Service <service@example.test>', subject: 'A failed response awaiting recovery', date: '2026-09-10T10:00:00Z', category: 'failed', reasons: ['invalid_model_output'], complete: true, labels: [], dates: {} },
  { id: 'e'.repeat(64), account: 'Personal fixture', author: 'Shop <shop@example.test>', subject: 'An automatic body read retry', date: '2026-09-09T10:00:00Z', category: 'retry', reasons: ['content_recovery'], complete: false, labels: ['orders'], dates: {}, nextAttempt: '2026-09-18T10:00:00Z' }
];

let processingState = {
  enabled: false,
  running: false,
  workerState: 'blocked',
  providerConsent: true,
  tenderConfigured: true,
  phase: 'idle',
  pauseReason: 'invalid_model_output',
  retryAt: null,
  lastProgressAt: '2026-09-13T21:00:00Z',
  lastRun: { status: 'failed', finishedAt: '2026-09-13T21:00:00Z', errorCount: 30 }
};

const fixtureProcessing = {
  status() {
    return {
      ...processingState,
      counts: { discovered: 82755, analyzed: 400, pending: 82314, retrying: 126, technicalFailures: 41, automaticHolds: 42, needsReview: reviewItems.filter(item => item.category === 'review').length, markedRead: 34920, moved: 211, errors: 84 },
      reasonCounts: { incomplete_message: 85, date_uncertain: 37, invalid_model_output: 41, classification_uncertain: 19, invoice_review_required: 5 },
      recentErrors: [{ at: '2026-09-13T21:00:00Z', code: 'invalid_model_output', phase: 'analyzing', diagnostic: { stage: 'response_schema', reason: 'response_date_invalid' } }],
      accounts: [{ id: 'business-imap', label: 'Business fixture', discoveryComplete: true }, { id: 'personal', label: 'Personal fixture', discoveryComplete: false, reason: 'mailbox_timeout' }]
    };
  },
  async action(action) {
    processingState = { ...processingState, enabled: action === 'start', workerState: action === 'start' ? 'retrying' : 'paused', pauseReason: action === 'start' ? 'provider_cooldown' : null, retryAt: action === 'start' ? '2026-09-18T10:00:00Z' : null };
    if (action === 'preview') processingState.preview = { createdAt: new Date().toISOString(), counts: { archive: 4, trash: 2, markRead: 0, rescue: 0, review: 2 } };
    return this.status();
  },
  reviewList({ category = 'review', after = '' }) {
    const rows = reviewItems.filter(item => item.category === category && item.id > after);
    return { items: structuredClone(rows.slice(0, 50)), nextAfter: rows.length > 50 ? rows[49].id : null };
  },
  reviewMessage(id) {
    const item = reviewItems.find(value => value.id === id);
    if (!item) throw new MailHarborError('not_found');
    return { ...item, body: 'Hi,\n\nThis is fictional test mail. The workshop starts on September 20, 2026, and ends on September 21, 2026.\n\n<script>alert("Never execute message content")</script>\n\nBest,\nAlex', truncated: !item.complete, bodyUnavailable: false };
  },
  resolveReview(input) {
    const item = reviewItems.find(value => value.id === input.id);
    if (!item) throw new MailHarborError('not_found');
    if (input.action === 'confirm') { item.category = ''; item.labels = [...new Set([...item.labels, ...input.labels])]; item.dates = { ...item.dates, ...input.dates }; }
    else if (input.action === 'keep') { item.category = 'held'; item.reasons = ['owner_keep']; }
    else { item.category = 'retry'; item.reasons = ['content_recovery']; }
    return this.status();
  },
  appointment: () => null,
  async close() {}
};

const fixtureLabelSync = {
  status: () => ({ running: false, checkedAt: null, backfillComplete: true, pending: 0, synced: 124, protected: 0, skipped: 0, failed: 0, mode: 'gmail_labels_primary_folders', errors: [] }),
  request() { return this.status(); },
  async close() {}
};

// Block outbound OAuth/provider HTTP even if an untested settings button is clicked.
const noExternalFetch = async () => { throw new MailHarborError('provider_error', 'External services are disabled in this synthetic preview.'); };

const factory = createWebFactory({ origin, stateDir: '/unused-synthetic-store', mailCache: { enabled: false } }, {
  store,
  reader,
  composer: fixtureComposer,
  content: fixtureContent,
  conversations: fixtureConversations,
  mailCache: null,
  notifications: fixtureNotifications,
  drive: fixtureDrive,
  invoices: fixtureInvoices,
  processing: fixtureProcessing,
  labelSync: fixtureLabelSync,
  fetcher: noExternalFetch,
  mailboxes: {
    async test() { return { folders: [], archivePath: null }; },
    async scan() { return { messages: [], references: new Map(), totalUnread: 0, inboxCount: 4 }; },
    async apply(accounts, references, ids, action, options = {}) { return { applied: Array.isArray(ids) ? [...ids] : [] }; }
  }
});

const server = createServer({ pairingToken: token }, async () => { throw new Error('AI must never run in this fixture'); }, {
  agyLogin: fixtureAgyLogin,
  createWeb(context) {
    return factory({
      ...context,
      jobs: {
        ...context.jobs,
        status: async () => fixtureAgyConnected
          ? { ready: true, version: VERSION, detail: 'Synthetic UI preview' }
          : { ready: false, code: 'login_required', version: VERSION, detail: 'Synthetic preview: reconnect AI through Settings.' }
      }
    });
  }
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`Synthetic preview: ${origin}\nPairing token: ${token}\n`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await closeServer(server);
    process.exit(0);
  });
}
