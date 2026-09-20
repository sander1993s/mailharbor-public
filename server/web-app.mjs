import { MAX_ACCOUNTS } from './providers.mjs';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAccountStore } from './account-store.mjs';
import { createAccounts } from './accounts.mjs';
import { createMailboxService, createMailboxSession, mailFingerprint } from './mailboxes.mjs';
import { createMailReader } from './mail-reader.mjs';
import { createMailApi } from './mail-api.mjs';
import { createMailComposer, MAX_COMPOSE_REQUEST_BYTES } from './mail-compose.mjs';
import { createMailContent, renderCompleteContent, MAIL_RENDERER_VERSION } from './mail-content.mjs';
import { createMailNotifications } from './mail-notifications.mjs';
import { createMailTags } from './mail-tags.mjs';
import { createMailIndex } from './mail-index.mjs';
import { createMailProcessingReader } from './mail-processing-reader.mjs';
import { createMailProcessing } from './mail-processing.mjs';
import { createMailLabelReader } from './mail-label-reader.mjs';
import { createMailLabelSync } from './mail-label-sync.mjs';
import { createDrive } from './drive.mjs';
import { createInvoiceAttachments } from './invoice-attachments.mjs';
import { createInvoiceFiling } from './invoice-filing.mjs';
import { createMailCache } from './mail-cache.mjs';
import { createMailCacheReader } from './mail-cache-reader.mjs';
import { createMailSync } from './mail-sync.mjs';
import { createMailConversations } from './mail-conversations.mjs';
import { createNotificationStore } from './notification-store.mjs';
import { createMailTelegram } from './mail-telegram.mjs';
import { MailHarborError, VERSION, safeError } from './validation.mjs';

const FINISHED = new Set(['completed', 'failed', 'cancelled']);
const digest = value => createHash('sha256').update(value).digest();
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b));
const fail = code => { throw new MailHarborError(code); };
const statusCodes = {
  unauthorized: 401, invalid_request: 400, busy: 429, not_found: 404, stale_message: 409, configuration_error: 503,
  mailbox_login_required: 422, mailbox_error: 502, mailbox_timeout: 504, oauth_not_configured: 422, archive_unavailable: 409,
  delete_unavailable: 409, attachment_too_large: 413, attachment_unavailable: 404,
  message_too_large: 413, content_too_large: 413, content_unavailable: 422, preview_unavailable: 422,
  move_unavailable: 409, folder_unavailable: 409, label_unavailable: 409,
  encrypted_mail_key_required: 422, encrypted_mail_failed: 422, encrypted_mail_unsupported: 422,
  smtp_not_configured: 422, smtp_login_required: 422, smtp_error: 502, send_uncertain: 409, send_partial: 409, send_history_full: 409,
  draft_unavailable: 409, draft_partial: 409, sent_copy_failed: 409, draft_cleanup_failed: 409,
  tag_limit: 409, invoice_limit: 409, invoice_timeout: 504, drive_not_configured: 422, drive_login_required: 422,
  drive_wrong_account: 422, drive_error: 502, drive_duplicate_ambiguous: 409,
  oauth_token_transport: 502, oauth_token_response: 502, oauth_invalid_client: 422, oauth_unauthorized_client: 422,
  oauth_invalid_scope: 422, oauth_invalid_grant: 422, oauth_imap_authentication_failed: 422, oauth_imap_connection_failed: 502,
  cancelled: 408, cache_unavailable: 503, telegram_not_configured: 422, telegram_configuration_error: 422,
  telegram_authentication_failed: 422, telegram_forbidden: 422, telegram_rate_limited: 429,
  telegram_rejected: 422, telegram_unavailable: 502, telegram_cancelled: 408
};

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/account-setup.mjs', ['account-setup.mjs', 'text/javascript; charset=utf-8']],
  ['/mail.mjs', ['mail.mjs', 'text/javascript; charset=utf-8']],
  ['/mail-tools.mjs', ['mail-tools.mjs', 'text/javascript; charset=utf-8']],
  ['/telegram-settings.mjs', ['telegram-settings.mjs', 'text/javascript; charset=utf-8']],
  ['/mail-tools.css', ['mail-tools.css', 'text/css; charset=utf-8']],
  ['/controls.mjs', ['controls.mjs', 'text/javascript; charset=utf-8']],
  ['/controls.css', ['controls.css', 'text/css; charset=utf-8']],
  ['/mail-content.mjs', ['mail-content.mjs', 'text/javascript; charset=utf-8']],
  ['/mail-content.css', ['mail-content.css', 'text/css; charset=utf-8']],
  ['/compose.mjs', ['compose.mjs', 'text/javascript; charset=utf-8']],
  ['/compose.css', ['compose.css', 'text/css; charset=utf-8']],
  ['/filing.mjs', ['filing.mjs', 'text/javascript; charset=utf-8']],
  ['/processing.mjs', ['processing.mjs', 'text/javascript; charset=utf-8']],
  ['/processing.css', ['processing.css', 'text/css; charset=utf-8']],
  ['/mail-attachments.mjs', ['mail-attachments.mjs', 'text/javascript; charset=utf-8']],
  ['/mail-attachments.css', ['mail-attachments.css', 'text/css; charset=utf-8']],
  ['/mail-conversation.mjs', ['mail-conversation.mjs', 'text/javascript; charset=utf-8']],
  ['/api-request.mjs', ['api-request.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.mjs', ['sw.mjs', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']]
]);

const vendorFiles = new Map([
  ['/vendor/pdfjs/pdf.mjs', ['../node_modules/pdfjs-dist/build/pdf.mjs', 'text/javascript; charset=utf-8']],
  ['/vendor/pdfjs/pdf.worker.mjs', ['../node_modules/pdfjs-dist/build/pdf.worker.mjs', 'text/javascript; charset=utf-8']]
]);

const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Resource-Policy': 'same-origin'
};

function json(response, status, value, headers = {}) {
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}

function binary(response, file) {
  const filename = String(file.filename || 'attachment').toWellFormed().replace(/[\\/\u0000-\u001f\u007f]/gu, '_').slice(0, 240);
  const fallback = filename.replace(/[^A-Za-z0-9._ -]/gu, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': file.bytes.length,
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'" });
  response.end(file.bytes);
}

async function body(request, maximum = 32768) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) fail('invalid_request');
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)))) fail('invalid_request');
  if (declared !== undefined && Number(declared) > maximum) { request.resume(); fail('message_too_large'); }
  const chunks = await new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { request.off('data', chunk); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const error = () => { cleanup(); reject(new MailHarborError('invalid_request')); };
    const aborted = error;
    const chunk = value => {
      size += value.length;
      if (size > maximum) {
        cleanup(); chunks.length = 0;
        request.once('error', () => {}); request.resume(); reject(new MailHarborError('message_too_large')); return;
      }
      chunks.push(value);
    };
    const end = () => { cleanup(); resolve(chunks); };
    request.on('data', chunk); request.once('end', end); request.once('error', error); request.once('aborted', aborted);
  });
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request');
    return value;
  } catch { fail('invalid_request'); }
}

function keys(value, allowed) { if (Object.keys(value).some(key => !allowed.includes(key))) fail('invalid_request'); }

function withRequestSignal(request, response, fn) {
  const controller = new AbortController();
  if (request.aborted || request.socket.destroyed || response.destroyed) {
    controller.abort(new MailHarborError('cancelled'));
  }
  const onAbort = () => {
    if (!response.writableEnded && !controller.signal.aborted) {
      controller.abort(new MailHarborError('cancelled'));
    }
  };
  request.on('aborted', onAbort);
  response.on('close', onAbort);
  return Promise.resolve()
    .then(() => fn(controller.signal))
    .finally(() => {
      request.off('aborted', onAbort);
      response.off('close', onAbort);
    });
}

/** The service is private to one owner; browser sessions share that owner's briefing history. */
export function createWebFactory(config, dependencies = {}) {
  const configured = new URL(config.origin);
  if (configured.origin !== config.origin || configured.pathname !== '/' || configured.username || configured.password || configured.search || configured.hash || (configured.protocol !== 'https:' && !(configured.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(configured.hostname)))) fail('configuration_error');
  const secure = configured.protocol === 'https:';
  const cookieName = secure ? '__Host-mailharbor' : 'mailharbor-local';
  if (config.allowedTailscaleLogins !== undefined && !Array.isArray(config.allowedTailscaleLogins)) fail('configuration_error');
  const allowTailnet = new Set(config.allowedTailscaleLogins ?? []);
  if ([...allowTailnet].some(item => typeof item !== 'string' || !item || /[\r\n]/.test(item))) fail('configuration_error');
  const owner = 'mailharbor-owner';

  return ({ jobs, verifyToken }) => {
    const sessions = new Map();
    const batches = new Map();
    const actions = new Set();
    const activeMutations = new Set();
    const loginAttempts = new Map();
    let closed = false;
    let mailboxes;
    let accounts;
    let mail;
    let reader;
    let drive;
    let invoices;
    let index;
    let processing;
    let composer, content, notifications, labelSync;
    let cache, sync, adapter, conversations, telegram;

    const accountForMutation = account => {
      const current = accounts.get(account?.id);
      if (current.revision !== account.revision || current.email !== account.email || current.host !== account.host) fail('stale_message');
      return current;
    };
    const ingestSnapshot = async snapshot => {
      try { await notifications?.ingest?.(snapshot); } catch {}
      telegram?.kick?.();
    };
    const updateSyncAccounts = async () => { await sync?.updateAccounts?.(); };

    function nestMutations(accountsList, change, work) {
      function nest(remaining) {
        const [first, ...rest] = remaining;
        if (!first) return work();
        return adapter.withMutation(first, change, () => nest(rest));
      }
      return nest(accountsList);
    }

    const ready = (async () => {
      const store = dependencies.store ?? await createAccountStore(config.stateDir);
      accounts = createAccounts({ store, publicOrigin: config.origin, testAccount: value => mailboxes.test(value), fetcher: dependencies.fetcher });
      mailboxes = dependencies.mailboxes ?? createMailboxService({ connectionOptions: value => accounts.connectionOptions(value) });
      const originalProvider = dependencies.reader ?? createMailReader({ connectionOptions: value => accounts.connectionOptions(value) });

      const mailCacheEnabled = config.mailCache?.enabled === true;
      if (dependencies.mailCache !== undefined) {
        cache = dependencies.mailCache;
      } else {
        try {
          cache = await (dependencies.createMailCache ?? createMailCache)(dependencies.store ? null : config.stateDir, { rendererVersion: MAIL_RENDERER_VERSION });
        } catch {
          cache = {
            healthy: () => false,
            clear: () => {},
            status: () => ({ healthy: false, error: 'cache_unavailable' })
          };
        }
      }

      const isCacheHealthy = () => {
        try { return cache ? (typeof cache.healthy === 'function' ? cache.healthy() : cache.status?.()?.healthy !== false) : false; }
        catch { return false; }
      };
      const syncEnabled = mailCacheEnabled && isCacheHealthy();

      notifications = dependencies.notifications ?? (dependencies.createMailNotifications ?? createMailNotifications)({ accounts, store, reader: originalProvider, origin: config.origin,
        pollEnabled: syncEnabled ? () => !isCacheHealthy() : true });

      if (dependencies.sync !== undefined) {
        sync = dependencies.sync;
      } else if (syncEnabled) {
        sync = (dependencies.createMailSync ?? createMailSync)({
          cache,
          accounts,
          reader: originalProvider,
          renderContent: renderCompleteContent,
          origin: config.origin,
          autoSchedule: true,
          changed: (_accountId, event) => {
            if (event?.notificationSnapshot) {
              void ingestSnapshot(event.notificationSnapshot);
            }
          }
        });
      } else {
        sync = null;
      }

      adapter = dependencies.adapter ?? await (dependencies.createMailCacheReader ?? createMailCacheReader)({
        reader: originalProvider,
        cache,
        sync,
        accounts,
        renderContent: renderCompleteContent,
        store,
        beforeMutation: (account, change) => telegram?.beforeMutation?.(account, change),
        enabled: mailCacheEnabled
      });

      const originalWithMutation = adapter.withMutation?.bind(adapter);
      if (originalWithMutation) {
        adapter.withMutation = (account, change, work) => {
          const current = accountForMutation(account);
          const promise = Promise.resolve().then(() => originalWithMutation(current, change, work));
          activeMutations.add(promise);
          promise.finally(() => activeMutations.delete(promise)).catch(() => {});
          return promise;
        };
      }

      reader = adapter.reader;

      index = dependencies.index ?? await createMailIndex(dependencies.store ? null : config.stateDir);
      const tags = createMailTags({ store, index });

      const rawProcessingReader = dependencies.processingReader ?? createMailProcessingReader({ connectionOptions: value => accounts.connectionOptions(value) });
      const notificationState = dependencies.telegram ? null : dependencies.notificationState ?? await createNotificationStore(dependencies.store ? null : config.stateDir);
      telegram = dependencies.telegram ?? createMailTelegram({ store, state: notificationState, accounts,
        reader: dependencies.notificationReader ?? rawProcessingReader, jobs, origin: config.origin,
        ...(dependencies.telegramSender ? { sender: dependencies.telegramSender } : {}), autoSchedule: !dependencies.store });
      const processingReader = new Proxy(rawProcessingReader, {
        get(target, prop, receiver) {
          if (prop === 'markRead') {
            return (account, reference, ...args) => adapter.withMutation(account, { reason: 'markRead', references: [reference] }, () => target.markRead(account, reference, ...args));
          }
          if (prop === 'move') {
            return (account, reference, action, ...args) => adapter.withMutation(account, { reason: 'move', references: [reference], action }, () => target.move(account, reference, action, ...args));
          }
          if (prop === 'moveBatch') {
            return (account, items, ...args) => adapter.withMutation(account, { reason: 'moveBatch', references: (items || []).map(i => i.reference) }, () => target.moveBatch(account, items, ...args));
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === 'function' ? val.bind(target) : val;
        }
      });

      processing = dependencies.processing ?? (dependencies.createMailProcessing ?? createMailProcessing)({
        index,
        store,
        accounts,
        reader: processingReader,
        tags,
        jobs,
        enqueueInvoice: input => invoices?.enqueue?.(input)
      });

      const conversationSession = dependencies.conversationSession ?? createMailboxSession({ connectionOptions: value => accounts.connectionOptions(value) });
      conversations = dependencies.conversations ?? createMailConversations({
        session: conversationSession.session,
        active: conversationSession.active,
        fingerprint: mailFingerprint
      });

      mail = createMailApi({
        accounts,
        reader,
        tags,
        processing,
        conversations,
        retentionMs: config.retentionMs
      });

      const rawLabelReader = dependencies.labelReader ?? createMailLabelReader({ connectionOptions: value => accounts.connectionOptions(value) });
      const labelReader = new Proxy(rawLabelReader, {
        get(target, prop, receiver) {
          if (prop === 'sync') {
            return (account, entries, ...args) => adapter.withMutation(account, { reason: 'label_sync', references: (entries || []).map(e => e.reference) }, () => target.sync(account, entries, ...args));
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === 'function' ? val.bind(target) : val;
        }
      });

      labelSync = dependencies.labelSync ?? (dependencies.createMailLabelSync ?? createMailLabelSync)({
        index,
        accounts,
        tags,
        processing,
        reader: labelReader,
        autoSchedule: !dependencies.store
      });

      composer = dependencies.composer ?? createMailComposer({
        accounts,
        store,
        resolveMessage: id => mail.resolve(id),
        invalidateMessage: id => mail.invalidateMessage(id)
      });

      content = dependencies.content ?? (dependencies.createMailContent ?? createMailContent)({
        reader,
        inlineReader: originalProvider
      });

      drive = dependencies.drive ?? createDrive({
        store,
        publicOrigin: config.origin,
        fetcher: dependencies.fetcher
      });

      const attachments = dependencies.attachments ?? createInvoiceAttachments({
        connectionOptions: value => accounts.connectionOptions(value)
      });

      invoices = dependencies.invoices ?? createInvoiceFiling({
        store,
        accounts,
        reader,
        attachments,
        drive,
        tags,
        index
      });
    })();
    ready.catch(() => {});
    const retention = Math.min(900000, Math.max(1000, config.retentionMs ?? 900000));
    if (!Number.isFinite(retention)) fail('configuration_error');

    function session(request) {
      const encoded = (request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
      const value = sessions.get(digest(encoded).toString('hex'));
      return value && value.expires > Date.now() ? value : null;
    }
    function sameOrigin(request) {
      if (request.headers.origin !== config.origin || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) fail('unauthorized');
    }
    function makeSession(response) {
      if (sessions.size >= 100) fail('busy');
      const raw = randomBytes(32).toString('base64url');
      const csrf = randomBytes(32).toString('base64url');
      sessions.set(digest(raw).toString('hex'), { csrf, expires: Date.now() + 7 * 86400000, oauthFailure: null, oauthAttempt: 0 });
      json(response, 200, { authenticated: true, csrf, version: VERSION }, { 'Set-Cookie': `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}` });
    }
    function revisions(current) { return new Map(current.map(value => [value.id, value.revision])); }
    function ensureUnchanged(batch) {
      for (const id of batch.accountIds) if (accounts.get(id).revision !== batch.revisions.get(id)) fail('stale_message');
    }
    function updateBatch(batch) {
      if (batch.jobId && !FINISHED.has(batch.status)) {
        try {
          const status = jobs.get(batch.jobId, owner);
          batch.status = status.status;
          batch.result = status.result;
          batch.error = status.error;
        } catch { batch.status = 'failed'; batch.error = safeError({ code: 'not_found' }); }
      }
      return batch;
    }
    function snapshot(batch, detailed = false) {
      updateBatch(batch);
      return { id: batch.id, status: batch.status, createdAt: new Date(batch.created).toISOString(), totalUnread: batch.totalUnread ?? 0, inboxCount: batch.inboxCount ?? batch.accountIds.length, count: batch.messages?.length ?? 0, progress: batch.progress ?? null, ...(batch.error ? { error: batch.error } : {}), ...(detailed ? { messages: batch.messages ?? [], ...(batch.result ? { result: batch.result } : {}) } : {}) };
    }
    function cancel(batch) {
      batch.controller.abort(new MailHarborError('cancelled'));
      if (batch.jobId) { try { jobs.cancel(batch.jobId, owner); } catch {} }
      batch.status = 'cancelled'; batch.messages = []; batch.references = new Map(); batch.result = undefined; batch.error = undefined;
    }
    function expire() {
      const now = Date.now();
      for (const [id, value] of sessions) if (value.expires <= now) sessions.delete(id);
      for (const [id, value] of batches) if (now - value.created >= retention) { cancel(value); batches.delete(id); }
      for (const [id, value] of loginAttempts) if (value.until <= now) loginAttempts.delete(id);
      mail?.expire();
    }
    const timer = setInterval(expire, 1000); timer.unref();

    async function scan(batch, selected, language) {
      const timeout = setTimeout(() => batch.controller.abort(new MailHarborError('timeout')), 300000);
      try {
        const result = await mailboxes.scan(selected, { signal: batch.controller.signal, onProgress: value => { batch.progress = value; } });
        if (batch.controller.signal.aborted || closed) throw batch.controller.signal.reason;
        ensureUnchanged(batch);
        batch.messages = result.messages; batch.references = result.references; batch.totalUnread = result.totalUnread; batch.inboxCount = result.inboxCount;
        if (!result.messages.length) {
          batch.status = 'completed'; batch.result = { briefing: 'There are no unread messages in the selected inboxes.', items: [] }; return;
        }
        const job = await jobs.submit({ language, messages: result.messages }, owner);
        batch.jobId = job.id;
        if (batch.controller.signal.aborted || closed) { jobs.cancel(job.id, owner); throw batch.controller.signal.reason; }
        batch.status = job.status;
      } catch (error) {
        if (batch.status !== 'cancelled') { batch.status = 'failed'; batch.error = safeError(batch.controller.signal.aborted ? batch.controller.signal.reason : error); }
      } finally { clearTimeout(timeout); }
    }

    return {
      async handle(request, response) {
        if (request.url?.startsWith('/v1/')) return false;
        try {
          if (closed) fail('busy');
          if (request.headers.host !== configured.host) fail('unauthorized');
          const url = new URL(request.url, config.origin);
          if (url.origin !== config.origin) fail('unauthorized');
          const onboardingQuery = url.pathname === '/' && ['?connected=1', '?connectionError=1', '?driveConnected=1', '?driveConnectionError=1'].includes(url.search);
          if (files.has(url.pathname) && ['GET', 'HEAD'].includes(request.method) && (!url.search || onboardingQuery)) {
            const [name, type] = files.get(url.pathname);
            let content;
            try { content = await readFile(fileURLToPath(new URL(`../web/${name}`, import.meta.url))); } catch { fail('not_found'); }
            response.writeHead(200, { ...securityHeaders, 'Content-Type': type, ...(url.pathname === '/sw.mjs' ? { 'Service-Worker-Allowed': '/' } : {}) });
            response.end(request.method === 'HEAD' ? undefined : content); return true;
          }
          if (vendorFiles.has(url.pathname) && ['GET', 'HEAD'].includes(request.method) && !url.search) {
            const [relPath, type] = vendorFiles.get(url.pathname);
            let content;
            try { content = await readFile(fileURLToPath(new URL(relPath, import.meta.url))); } catch { fail('not_found'); }
            response.writeHead(200, { ...securityHeaders, 'Content-Type': type });
            response.end(request.method === 'HEAD' ? undefined : content); return true;
          }
          await ready;
          if (closed) fail('busy');
          expire();
          if (url.pathname === '/api/session' && request.method === 'POST') {
            sameOrigin(request);
            const input = await body(request); keys(input, ['token', 'tailscale']);
            const remote = request.socket.remoteAddress;
            const key = remote;
            const attempts = loginAttempts.get(key) ?? { count: 0, until: Date.now() + 300000 };
            if (attempts.count >= 10) fail('busy');
            const tailnet = input.tailscale === true && secure && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && allowTailnet.has(request.headers['tailscale-user-login']);
            if (!tailnet && !(typeof input.token === 'string' && input.token.length <= 128 && await verifyToken(input.token))) { attempts.count++; loginAttempts.set(key, attempts); fail('unauthorized'); }
            loginAttempts.delete(key); makeSession(response); return true;
          }
          const current = session(request);
          if (!current) fail('unauthorized');
          if (!['GET', 'HEAD'].includes(request.method)) {
            sameOrigin(request);
            if (!equal(request.headers['x-mailharbor-csrf'], current.csrf)) fail('unauthorized');
          }
          if (url.pathname === '/api/session' && request.method === 'GET') { json(response, 200, { authenticated: true, csrf: current.csrf, version: VERSION }); return true; }
          if (url.pathname === '/api/session' && request.method === 'DELETE') {
            for (const [key, value] of sessions) if (value === current) sessions.delete(key);
            json(response, 200, { authenticated: false }, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}` }); return true;
          }
          if (url.pathname === '/api/status' && request.method === 'GET') { json(response, 200, await jobs.status()); return true; }
          if (url.pathname === '/api/accounts' && request.method === 'GET') { json(response, 200, { accounts: accounts.list(), providers: accounts.registrations(), catalog: accounts.catalog(), oauthFailure: current.oauthFailure }); return true; }
          if (url.pathname === '/api/accounts' && request.method === 'POST') { json(response, 201, await accounts.add(await body(request))); return true; }
          if (url.pathname === '/api/drive' && request.method === 'GET') { json(response, 200, { ...drive.status(), oauthFailure: current.driveFailure ?? null }); return true; }
          if (url.pathname === '/api/drive/configure' && request.method === 'POST') {
            const input = await body(request); keys(input, ['clientId', 'clientSecret']);
            json(response, 200, await drive.configure(input)); return true;
          }
          if (url.pathname === '/api/drive/connect' && request.method === 'POST') {
            keys(await body(request), []); current.driveFailure = null;
            json(response, 200, await drive.start(current.csrf)); return true;
          }
          if (url.pathname === '/api/drive/disconnect' && request.method === 'POST') {
            keys(await body(request), []); current.driveFailure = null;
            json(response, 200, await drive.disconnect()); return true;
          }
          if (url.pathname === '/oauth/drive/callback' && request.method === 'GET') {
            try {
              await drive.finish(url.searchParams, current.csrf); current.driveFailure = null;
              response.writeHead(303, { ...securityHeaders, Location: '/?driveConnected=1#accounts' });
            } catch (error) {
              current.driveFailure = safeError(error);
              response.writeHead(303, { ...securityHeaders, Location: '/?driveConnectionError=1#accounts' });
            }
            response.end(); return true;
          }
          if (url.pathname === '/api/invoices' && request.method === 'GET') { json(response, 200, invoices.status()); return true; }
          if (url.pathname === '/api/invoices/settings' && request.method === 'POST') {
            const input = await body(request); keys(input, ['enabled']);
            json(response, 200, await invoices.configure(input)); return true;
          }
          if (url.pathname === '/api/invoices/scan' && request.method === 'POST') {
            const input = await body(request); keys(input, ['limit']);
            json(response, 202, invoices.start(input)); return true;
          }
          if (url.pathname === '/api/mail/folders' && request.method === 'GET') { json(response, 200, await mail.folders()); return true; }
          if (url.pathname === '/api/mail/labels/sync' && request.method === 'GET') { json(response, 200, labelSync.status()); return true; }
          if (url.pathname === '/api/mail/labels/sync' && request.method === 'POST') {
            const input = await body(request); keys(input, ['action']);
            if (input.action !== 'sync') fail('invalid_request');
            json(response, 202, labelSync.request()); return true;
          }
          if (url.pathname === '/api/mail/updates' && request.method === 'GET') { json(response, 200, notifications.updates()); return true; }
          if (url.pathname === '/api/mail/notifications' && request.method === 'GET') { json(response, 200, await notifications.settings()); return true; }
          if (url.pathname === '/api/mail/notifications' && request.method === 'POST') { json(response, 200, await notifications.subscribe(await body(request))); return true; }
          if (url.pathname === '/api/mail/notifications' && request.method === 'DELETE') { json(response, 200, await notifications.unsubscribe(await body(request))); return true; }
          if (url.pathname === '/api/mail/telegram' && request.method === 'GET') { json(response, 200, telegram.settings()); return true; }
          if (url.pathname === '/api/mail/telegram' && request.method === 'POST') { json(response, 200, await telegram.configure(await body(request))); return true; }
          if (url.pathname === '/api/mail/telegram/test' && request.method === 'POST') { json(response, 200, await telegram.test(await body(request))); return true; }
          if (url.pathname === '/api/mail/telegram/retry' && request.method === 'POST') { json(response, 200, await telegram.retry(await body(request))); return true; }
          if (url.pathname === '/api/mail/smtp' && request.method === 'GET') { json(response, 200, await composer.settings()); return true; }
          if (url.pathname === '/api/mail/smtp' && request.method === 'POST') { json(response, 200, await composer.configure(await body(request))); return true; }
          if (url.pathname === '/api/mail/smtp/test' && request.method === 'POST') { json(response, 200, await composer.verify(await body(request))); return true; }
          if (url.pathname === '/api/mail/compose/context' && request.method === 'POST') { json(response, 200, await composer.context(await body(request))); return true; }
          if (url.pathname === '/api/mail/draft' && request.method === 'POST') {
            const input = await body(request, MAX_COMPOSE_REQUEST_BYTES);
            const account = accounts.get(input.accountId);
            const work = () => composer.save(input);
            json(response, 200, await adapter.withMutation(account, { reason: 'compose' }, work));
            return true;
          }
          if (url.pathname === '/api/mail/send' && request.method === 'POST') {
            const input = await body(request, MAX_COMPOSE_REQUEST_BYTES);
            const account = accounts.get(input.accountId);
            const work = () => composer.send(input);
            json(response, 200, await adapter.withMutation(account, { reason: 'compose' }, work));
            return true;
          }
          if (url.pathname === '/api/mail/compose/recovery' && request.method === 'GET') {
            json(response, 200, await composer.recovery.list());
            return true;
          }
          if (url.pathname === '/api/mail/compose/recovery' && request.method === 'POST') {
            const input = await body(request, MAX_COMPOSE_REQUEST_BYTES);
            keys(input, ['composeId', 'revision', 'content']);
            json(response, 200, await composer.recovery.save(input));
            return true;
          }
          if (url.pathname === '/api/mail/compose/recovery/read' && request.method === 'POST') {
            const input = await body(request);
            keys(input, ['composeId']);
            json(response, 200, await composer.recovery.read(input));
            return true;
          }
          if (url.pathname === '/api/mail/compose/recovery/discard' && request.method === 'POST') {
            const input = await body(request);
            keys(input, ['composeId', 'revision']);
            json(response, 200, await composer.recovery.discard(input));
            return true;
          }
          if (url.pathname === '/api/mail/compose/preferences/read' && request.method === 'POST') {
            const input = await body(request);
            keys(input, ['accountId']);
            json(response, 200, await composer.recovery.preferences(input));
            return true;
          }
          if (url.pathname === '/api/mail/compose/preferences' && request.method === 'POST') {
            const input = await body(request);
            keys(input, ['accountId', 'signature']);
            json(response, 200, await composer.recovery.configurePreferences(input));
            return true;
          }
          if (url.pathname === '/api/mail/cache' && request.method === 'GET') {
            json(response, 200, adapter.status());
            return true;
          }
          if (url.pathname === '/api/mail/cache' && request.method === 'POST') {
            const input = await body(request);
            keys(input, ['maxHeadersPerAccount']);
            json(response, 200, await adapter.configure(input));
            return true;
          }
          if (url.pathname === '/api/mail/cache/clear' && request.method === 'POST') {
            keys(await body(request), []);
            json(response, 200, await adapter.clear());
            return true;
          }
          if (url.pathname === '/api/mail/cache/refresh' && request.method === 'POST') {
            const input = await body(request);
            keys(input, ['accountIds']);
            const connectedIds = new Set(accounts.list().filter(account => account.connected).map(account => account.id));
            if (input.accountIds !== undefined && (!Array.isArray(input.accountIds) || !input.accountIds.length || input.accountIds.length > 100 || new Set(input.accountIds).size !== input.accountIds.length || input.accountIds.some(id => typeof id !== 'string' || !connectedIds.has(id)))) {
              fail('invalid_request');
            }
            json(response, 200, await adapter.refresh(input.accountIds ?? null));
            return true;
          }
          if (['/api/mail/content', '/api/mail/decrypt', '/api/mail/source', '/api/mail/headers', '/api/mail/attachments', '/api/mail/attachment-preview'].includes(url.pathname) && request.method === 'POST') {
            const input = await body(request, 256 * 1024);
            const route = url.pathname.split('/').at(-1);
            keys(input, route === 'decrypt' ? ['id', 'privateKey', 'passphrase', 'certificate'] : route === 'attachment-preview' ? ['id', 'attachmentId'] : route === 'content' ? ['id', 'includeInlineImages'] : ['id']);
            if (route === 'content' && input.includeInlineImages !== undefined && typeof input.includeInlineImages !== 'boolean') fail('invalid_request');
            const result = await withRequestSignal(request, response, signal => mail.withMessage({ id: input.id }, async (account, reference, opSignal) => {
              if (route === 'content' || route === 'decrypt') return content.read(account, reference, { signal: opSignal, ...(route === 'decrypt' ? { privateKey: input.privateKey, passphrase: input.passphrase, certificate: input.certificate } : {}), ...(route === 'content' && input.includeInlineImages !== undefined ? { includeInlineImages: input.includeInlineImages } : {}) });
              if (route === 'source' || route === 'headers') return content[route](account, reference, { signal: opSignal });
              if (route === 'attachment-preview') return content.preview(account, reference, input.attachmentId, { signal: opSignal });
              const message = await reader.read(account, reference, { signal: opSignal });
              return content.zip(account, reference, message.attachments ?? [], { signal: opSignal });
            }, { signal }));
            if (['source', 'headers', 'attachments'].includes(route)) binary(response, result);
            else json(response, 200, result);
            return true;
          }
          if (request.method === 'POST') {
            const operations = { '/api/mail/bulk': 'bulk', '/api/mail/undo': 'undo', '/api/mail/trash/empty': 'emptyTrash', '/api/mail/folders/manage': 'manageFolder', '/api/mail/labels/manage': 'manageLabel', '/api/mail/provider-labels': 'providerLabels', '/api/mail/provider-labels/apply': 'setProviderLabel' };
            if (operations[url.pathname]) { json(response, 200, await mail[operations[url.pathname]](await body(request))); return true; }
          }
          if (url.pathname === '/api/mail/processing/status' && request.method === 'GET') { json(response, 200, processing.status()); return true; }
          if (url.pathname === '/api/mail/processing/review' && request.method === 'GET') {
            if ([...url.searchParams.keys()].some(key => !['category', 'after'].includes(key)) ||
              ['category', 'after'].some(key => url.searchParams.getAll(key).length > 1)) fail('invalid_request');
            const category = url.searchParams.get('category') ?? 'review', after = url.searchParams.get('after') ?? undefined;
            if (!['review', 'held', 'failed', 'retry'].includes(category) || (after !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(after))) fail('invalid_request');
            json(response, 200, await processing.reviewList({ category, after })); return true;
          }
          if (url.pathname === '/api/mail/processing/review/message' && request.method === 'GET') {
            if ([...url.searchParams.keys()].some(key => key !== 'id') || url.searchParams.getAll('id').length !== 1 ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get('id') ?? '')) fail('invalid_request');
            json(response, 200, await processing.reviewMessage(url.searchParams.get('id'))); return true;
          }
          if (url.pathname === '/api/mail/processing/review' && request.method === 'POST') {
            const input = await body(request); keys(input, ['id', 'action', 'labels', 'dates']);
            if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) || !['retry', 'keep', 'confirm'].includes(input.action) ||
              (input.action !== 'confirm' && ('labels' in input || 'dates' in input))) fail('invalid_request');
            json(response, 200, await processing.resolveReview(input)); return true;
          }
          if (url.pathname === '/api/mail/processing/settings' && request.method === 'POST') { json(response, 200, await processing.configure(await body(request))); return true; }
          if (url.pathname === '/api/mail/processing' && request.method === 'POST') {
            const input = await body(request); keys(input, ['action']); json(response, 202, await processing.action(input.action)); return true;
          }
          if (url.pathname === '/api/mail/calendar' && request.method === 'GET') {
            if ([...url.searchParams.keys()].some(key => key !== 'id') || url.searchParams.getAll('id').length !== 1) fail('invalid_request');
            const calendar = mail.calendar({ id: url.searchParams.get('id') });
            response.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="appointment.ics"' }); response.end(calendar); return true;
          }
          if (url.pathname === '/api/mail/list' && request.method === 'POST') {
            const input = await body(request);
            const result = await withRequestSignal(request, response, signal => mail.list(input, { signal }));
            json(response, 200, result); return true;
          }
          if (url.pathname === '/api/mail/message' && request.method === 'POST') {
            const input = await body(request);
            const result = await withRequestSignal(request, response, signal => mail.read(input, { signal }));
            json(response, 200, result); return true;
          }
          if (url.pathname === '/api/mail/conversation' && request.method === 'POST') {
            const input = await body(request);
            const result = await withRequestSignal(request, response, signal => mail.conversation(input, { signal }));
            json(response, 200, result); return true;
          }
          if (url.pathname === '/api/mail/attachment' && request.method === 'POST') {
            const file = await mail.attachment(await body(request));
            const filename = file.filename.toWellFormed().replace(/[\\/\u0000-\u001f\u007f]/gu, '_').slice(0, 240) || 'attachment';
            const fallback = filename.replace(/[^A-Za-z0-9._ -]/gu, '_');
            const encoded = encodeURIComponent(filename).replace(/['()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
            response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/octet-stream',
              'Content-Length': file.bytes.length, 'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
              'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'" });
            response.end(file.bytes); return true;
          }
          if (url.pathname === '/api/mail/action' && request.method === 'POST') { json(response, 200, await mail.apply(await body(request))); return true; }
          if (url.pathname === '/api/mail/tags' && request.method === 'POST') { json(response, 200, await mail.setTag(await body(request))); return true; }
          if (url.pathname === '/api/providers' && request.method === 'POST') { await accounts.configureProvider(await body(request)); json(response, 200, { saved: true }); return true; }
          if (url.pathname === '/api/accounts/password' && request.method === 'POST') {
            const result = await accounts.connectPassword(await body(request));
            await updateSyncAccounts();
            json(response, 200, result); return true;
          }
          if (url.pathname === '/api/accounts/oauth' && request.method === 'POST') {
            const started = accounts.startOAuth(await body(request), current.csrf);
            current.oauthAttempt++; current.oauthFailure = null;
            json(response, 200, started); return true;
          }
          const oauth = /^\/oauth\/(google|microsoft)\/callback$/.exec(url.pathname);
          if (oauth && request.method === 'GET') {
            const attempt = current.oauthAttempt;
            try {
              await accounts.finishOAuth(oauth[1], url.searchParams, current.csrf);
              await updateSyncAccounts();
              if (current.oauthAttempt === attempt) current.oauthFailure = null;
              response.writeHead(303, { ...securityHeaders, Location: '/?connected=1#accounts' });
            } catch (error) {
              if (current.oauthAttempt === attempt) current.oauthFailure = { provider: oauth[1], ...safeError(error) };
              response.writeHead(303, { ...securityHeaders, Location: '/?connectionError=1#accounts' });
            }
            response.end(); return true;
          }
          const accountRoute = /^\/api\/accounts\/([a-z0-9-]+)(\/(?:test|archive))?$/.exec(url.pathname);
          if (accountRoute && request.method === 'POST' && accountRoute[2] === '/test') {
            json(response, 200, { connected: true, ...await mailboxes.test(accounts.get(accountRoute[1])) }); return true;
          }
          if (accountRoute && request.method === 'POST' && accountRoute[2] === '/archive') {
            const input = await body(request); keys(input, ['path']);
            const result = await accounts.setArchivePath(accountRoute[1], input.path);
            await updateSyncAccounts();
            json(response, 200, result); return true;
          }
          if (accountRoute && request.method === 'DELETE' && !accountRoute[2]) {
            const accountId = accountRoute[1];
            for (const value of batches.values()) if (value.accountIds.includes(accountId)) cancel(value);
            mail.invalidateAccount(accountId);
            await accounts.disconnect(accountId);
            await cache?.removeAccount?.(accountId);
            await updateSyncAccounts();
            await ingestSnapshot(sync?.notificationSnapshot?.() ?? { states: [], errors: [] });
            json(response, 200, { disconnected: true }); return true;
          }
          if (url.pathname === '/api/briefings' && request.method === 'GET') { json(response, 200, { briefings: [...batches.values()].sort((a,b) => b.created-a.created).map(value => snapshot(value)) }); return true; }
          if (url.pathname === '/api/briefings' && request.method === 'POST') {
            const input = await body(request); keys(input, ['accountIds', 'language']);
            if (!Array.isArray(input.accountIds) || !input.accountIds.length || input.accountIds.length > MAX_ACCOUNTS || new Set(input.accountIds).size !== input.accountIds.length || (input.language !== undefined && (typeof input.language !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(input.language)))) fail('invalid_request');
            if ([...batches.values()].some(value => !FINISHED.has(updateBatch(value).status)) || batches.size >= 12) fail('busy');
            const selected = input.accountIds.map(id => accounts.get(id));
            const batch = { id: randomBytes(18).toString('base64url'), created: Date.now(), status: 'scanning', accountIds: [...input.accountIds], revisions: revisions(selected), controller: new AbortController(), references: new Map(), messages: [], actionBusy: false };
            batches.set(batch.id, batch);
            batch.scanPromise = scan(batch, selected, input.language ?? 'en');
            json(response, 202, snapshot(batch)); return true;
          }
          const batchRoute = /^\/api\/briefings\/([A-Za-z0-9_-]{24})(\/actions)?$/.exec(url.pathname);
          if (batchRoute) {
            const batch = batches.get(batchRoute[1]); if (!batch) fail('not_found');
            if (request.method === 'GET' && !batchRoute[2]) { json(response, 200, snapshot(batch, true)); return true; }
            if (request.method === 'DELETE' && !batchRoute[2]) { if (batch.actionBusy) fail('busy'); cancel(batch); json(response, 200, snapshot(batch)); return true; }
            if (request.method === 'POST' && batchRoute[2]) {
              const input = await body(request); keys(input, ['action', 'ids']);
              if (!['archive', 'mark_read'].includes(input.action) || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 40 || new Set(input.ids).size !== input.ids.length || input.ids.some(id => typeof id !== 'string' || !batch.references.has(id))) fail('invalid_request');
              if (batch.actionBusy || updateBatch(batch).status !== 'completed') fail('busy');
              ensureUnchanged(batch);
              if (input.action === 'archive' && input.ids.some(id => batch.messages.find(value => value.id === id)?.bodyUnavailable || batch.messages.find(value => value.id === id)?.truncated)) fail('invalid_request');
              batch.actionBusy = true;
              let applying;
              try {
                const selectedAccounts = batch.accountIds.map(id => accounts.get(id));
                applying = nestMutations(selectedAccounts, { reason: 'briefing_apply', action: input.action,
                  references: input.ids.map(id => ({ ...batch.references.get(id), path: 'INBOX' })) },
                  () => mailboxes.apply(selectedAccounts, batch.references, input.ids, input.action, { signal: batch.controller.signal }));
                actions.add(applying);
                const result = await applying;
                for (const id of result.applied) batch.references.delete(id);
                batch.messages = batch.messages.filter(value => !result.applied.includes(value.id));
                if (batch.result) batch.result.items = batch.result.items.filter(value => !result.applied.includes(value.id));
                json(response, 200, result); return true;
              } finally { actions.delete(applying); batch.actionBusy = false; }
            }
          }
          fail('not_found');
        } catch (error) {
          if (!response.headersSent && !response.destroyed) { const safe = safeError(error); json(response, statusCodes[safe.code] ?? 500, { error: safe }); }
          request.resume(); return true;
        }
      },
      async close() {
        closed = true; clearInterval(timer);
        for (const batch of batches.values()) cancel(batch);
        await ready.catch(() => {});
        await telegram?.close?.();
        await sync?.close?.();
        await notifications?.close?.();
        await labelSync?.close?.();
        await processing?.close?.();
        await composer?.close?.();
        await invoices?.close?.();
        await drive?.close?.();
        await mail?.close?.();
        await Promise.allSettled([...batches.values()].map(value => value.scanPromise).concat([...actions]).concat([...activeMutations]));
        conversations?.destroy?.();
        await cache?.close?.();
        accounts?.close?.();
        index?.close?.();
        batches.clear(); sessions.clear(); loginAttempts.clear(); activeMutations.clear();
      }
    };
  };
}
