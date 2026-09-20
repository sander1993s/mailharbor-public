import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { MailHarborError } from './validation.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const NAMESPACE = 'mailharbor.invoices.v1';
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE = 128 * 1024;
const FILE_FIELDS = 'id,name,mimeType,parents,appProperties,trashed,ownedByMe,shared,driveId,size,md5Checksum,sha256Checksum';
const SAFE_ERRORS = new Set(['invalid_request', 'configuration_error', 'unauthorized', 'busy', 'cancelled', 'drive_not_configured', 'drive_login_required', 'drive_wrong_account', 'drive_error', 'drive_duplicate_ambiguous']);
const fail = code => { throw new MailHarborError(code); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const field = (value, maximum = 4096) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
const emailAddress = value => typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && !/[\p{Cc}\p{Cf}]/u.test(value);
const entityLabel = value => field(value, 80) && !/[\p{Cc}\p{Cf}\\/]/u.test(value) && !/^\.+$/u.test(value.trim()) && value === value.trim();
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(24).toString('base64url');
const strict = (value, keys) => { if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) fail('invalid_request'); };
const quote = value => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const propertyQuery = (key, value) => `appProperties has { key=${quote(key)} and value=${quote(value)} }`;

function readState(data) {
  if (data.mailDrive === undefined) return { schema: 1, revision: '', registration: null, connection: null, allocations: {} };
  const value = data.mailDrive;
  if (!record(value) || value.schema !== 1 || typeof value.revision !== 'string' || !record(value.allocations) || Object.keys(value.allocations).length > 12000) fail('configuration_error');
  return value;
}
function scopes(value, previous) {
  if (value === undefined && previous) return previous;
  if (!field(value, 4096)) fail('drive_login_required');
  const granted = new Set(value.split(/\s+/u).map(scope => scope === 'https://www.googleapis.com/auth/userinfo.email' ? 'email' : scope));
  const required = DRIVE_SCOPE.split(' ');
  if (granted.size !== required.length || required.some(scope => !granted.has(scope))) fail('drive_login_required');
  return DRIVE_SCOPE;
}
function invoice(value) {
  strict(value, ['bytes', 'mimeType', 'filename', 'entityLabel', 'year', 'quarter', 'sha256']);
  if (!(value.bytes instanceof Uint8Array) || !value.bytes.byteLength || value.bytes.byteLength > MAX_BYTES ||
      !['application/pdf', 'application/xml', 'text/xml'].includes(value.mimeType) || !field(value.filename, 240) ||
      /[/\\]/u.test(value.filename) || ['.', '..'].includes(value.filename) || !entityLabel(value.entityLabel) ||
      !Number.isSafeInteger(value.year) || value.year < 1900 || value.year > 9999 || !Number.isSafeInteger(value.quarter) || value.quarter < 1 || value.quarter > 4) fail('invalid_request');
  const bytes = Buffer.from(value.bytes);
  const extension = value.mimeType === 'application/pdf' ? /\.pdf$/iu : /\.xml$/iu;
  if (!extension.test(value.filename)) fail('invalid_request');
  if (value.mimeType === 'application/pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail('invalid_request');
  } else {
    // Sniff the original XML without parsing or resolving entities. UTF-8 and UTF-16 originals stay byte-for-byte intact.
    let start;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) start = bytes.subarray(2, 1024).toString('utf16le');
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const prefix = Buffer.from(bytes.subarray(2, 2 + Math.floor((Math.min(bytes.length, 1024) - 2) / 2) * 2));
      start = prefix.swap16().toString('utf16le');
    } else start = bytes.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/u, '');
    if (!/^\s*<(?:\?xml\s|[A-Za-z_:]|!--)/u.test(start)) fail('invalid_request');
  }
  const sha256 = hash(bytes);
  if (value.sha256 !== undefined && value.sha256 !== sha256) fail('invalid_request');
  const path = `Invoices/${value.entityLabel}/${value.year}/Q${value.quarter}`;
  return { ...value, bytes, sha256, md5: createHash('md5').update(bytes).digest('hex'), path };
}

/** Private, app-created invoice files. Registration, tokens and allocated retry IDs stay in the encrypted store. */
export function createDrive({ store, publicOrigin, fetcher = fetch, now = () => Date.now() }) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' || typeof fetcher !== 'function' || typeof now !== 'function') fail('configuration_error');
  let origin;
  try { origin = new URL(publicOrigin); } catch { fail('configuration_error'); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) fail('configuration_error');
  const callback = `${origin.origin}/oauth/drive/callback`;
  const oauth = new Map(), operations = new Set();
  let epoch = 0, closed = false, pending = Promise.resolve(), refresh = null, queued = 0;
  const state = () => readState(store.read());
  state();
  const timestamp = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail('configuration_error'); return value; };
  const invalidate = () => { epoch++; oauth.clear(); for (const operation of operations) operation.controller.abort(); };
  function current(context) {
    if (closed || context.epoch !== epoch) fail('drive_login_required');
    const value = state();
    if (value.revision !== context.revision) fail('drive_login_required');
    return value;
  }
  function connected(context) {
    const value = current(context);
    if (!value.registration) fail('drive_not_configured');
    if (!value.connection || !emailAddress(value.registration.expectedEmail) || value.connection.email !== value.registration.expectedEmail || !field(value.connection.refreshToken, 32768)) fail('drive_login_required');
    return value;
  }
  function context() { if (closed) fail('busy'); return { epoch, revision: state().revision }; }
  function operation(context, signal, work) {
    const controller = new AbortController(), entry = { controller, promise: null }; operations.add(entry);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    entry.promise = (async () => {
      try { current(context); if (combined.aborted) fail('cancelled'); return await work(combined); }
      catch (error) {
        if (context.epoch !== epoch || closed) fail('drive_login_required');
        if (signal?.aborted) fail('cancelled');
        throw new MailHarborError(error instanceof MailHarborError && SAFE_ERRORS.has(error.code) ? error.code : 'drive_error');
      } finally { operations.delete(entry); }
    })();
    return entry.promise;
  }
  async function update(context, change) {
    await store.update(data => {
      current(context);
      const value = readState(data);
      if (value.revision !== context.revision) fail('drive_login_required');
      change(value); data.mailDrive = value;
    });
  }
  function knownUrl(value) {
    const url = new URL(value);
    const fixed = url.href === TOKEN_URL || url.href === USERINFO_URL;
    const drive = url.origin === 'https://www.googleapis.com' &&
      (url.pathname === '/drive/v3/files' || /^\/drive\/v3\/files\/[A-Za-z0-9_-]{1,200}$/u.test(url.pathname) || url.pathname === '/upload/drive/v3/files');
    if ((!fixed && !drive) || url.username || url.password || url.hash) fail('drive_error');
    return url;
  }
  async function responseJson(response) {
    const length = Number(response.headers?.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE) { await response.body?.cancel?.(); fail('drive_error'); }
    let raw;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE) { await reader.cancel(); fail('drive_error'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      raw = Buffer.concat(chunks).toString('utf8');
    } else { raw = await response.text(); if (Buffer.byteLength(raw) > MAX_RESPONSE) fail('drive_error'); }
    let result;
    try { result = JSON.parse(raw); } catch { fail('drive_error'); }
    if (!record(result)) fail('drive_error');
    return result;
  }
  async function request(url, options, context, signal, { allowed = [], empty = false } = {}) {
    const target = knownUrl(url);
    current(context);
    let response;
    try {
      response = await fetcher(target.href, { ...options, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
    } catch { current(context); if (signal.aborted) fail('cancelled'); fail('drive_error'); }
    current(context);
    if (!response || response.redirected || (response.url && response.url !== target.href)) fail('drive_error');
    if (!response.ok) {
      await response.body?.cancel?.();
      if (allowed.includes(response.status)) return { status: response.status, value: null, headers: response.headers };
      if (response.status === 401) fail('drive_login_required');
      fail('drive_error');
    }
    const result = { status: response.status, value: empty ? null : await responseJson(response), headers: response.headers };
    if (empty) await response.body?.cancel?.();
    current(context);
    return result;
  }
  async function tokenRequest(params, context, signal, previousScope) {
    const { value, status } = await request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) }, context, signal, { allowed: [400, 401] });
    if (status === 400 || status === 401) fail('drive_login_required');
    if (value.error || !field(value.access_token, 32768) || value.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(value.expires_in) || value.expires_in < 1 ||
        (value.refresh_token !== undefined && !field(value.refresh_token, 32768))) fail('drive_login_required');
    return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: timestamp() + Math.min(value.expires_in, 86400) * 1000, scope: scopes(value.scope, previousScope) };
  }
  async function accessToken(context, signal, rejectedToken) {
    const value = connected(context), auth = value.connection;
    if (field(auth.accessToken, 32768) && auth.expiresAt > timestamp() + 60000 && auth.accessToken !== rejectedToken) return auth.accessToken;
    if (refresh?.revision === context.revision && refresh.epoch === context.epoch) return refresh.promise;
    const entry = { ...context };
    entry.promise = (async () => {
      const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: value.registration.clientId, client_secret: value.registration.clientSecret }, context, signal, auth.scope);
      await update(context, saved => { saved.connection = { ...saved.connection, ...refreshed, refreshToken: refreshed.refreshToken || auth.refreshToken }; });
      return refreshed.accessToken;
    })().finally(() => { if (refresh === entry) refresh = null; });
    refresh = entry;
    return entry.promise;
  }
  async function driveRequest(url, options, context, signal, settings = {}) {
    let token = await accessToken(context, signal);
    let result = await request(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } }, context, signal, { ...settings, allowed: [...(settings.allowed || []), 401] });
    if (result.status === 401) {
      token = await accessToken(context, signal, token);
      result = await request(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } }, context, signal, settings);
    }
    return result;
  }
  async function getFile(id, context, signal) {
    if (!identifier(id)) fail('drive_error');
    const url = new URL(`${API}/${id}`); url.searchParams.set('fields', FILE_FIELDS);
    const result = await driveRequest(url, { method: 'GET' }, context, signal, { allowed: [404] });
    return result.status === 404 ? null : result.value;
  }
  function privateFile(file) {
    if (!record(file) || !identifier(file.id) || file.trashed === true || file.ownedByMe !== true || file.shared !== false || file.driveId) fail('drive_error');
  }
  function validateFile(file, metadata, content) {
    privateFile(file);
    if (file.mimeType !== metadata.mimeType || !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== metadata.parents[0] ||
        !record(file.appProperties) || Object.entries(metadata.appProperties).some(([key, value]) => file.appProperties[key] !== value)) fail('drive_error');
    if (!content) { if (file.name !== metadata.name) fail('drive_error'); }
    else if (String(file.size) !== String(content.bytes.length) || (!file.md5Checksum && !file.sha256Checksum) ||
      (file.md5Checksum && file.md5Checksum !== content.md5) || (file.sha256Checksum && file.sha256Checksum !== content.sha256)) fail('drive_error');
  }
  async function findFiles(query, context, signal, ambiguous = 'drive_error') {
    const url = new URL(API);
    for (const [key, value] of Object.entries({ q: query, spaces: 'drive', corpora: 'user', pageSize: '2', fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})` })) url.searchParams.set(key, value);
    const { value } = await driveRequest(url, { method: 'GET' }, context, signal);
    if (!Array.isArray(value.files) || value.files.length > 1 || value.nextPageToken || value.incompleteSearch) fail(ambiguous);
    return value.files[0] || null;
  }
  async function allocation(key, metadata, context, signal, existingId) {
    const old = connected(context).allocations[key];
    if (old) {
      if (!identifier(old.id) || !record(old.metadata) || (existingId && old.id !== existingId)) fail('drive_error');
      return old;
    }
    let id = existingId;
    if (!id) {
      const url = new URL(`${API}/generateIds`); url.searchParams.set('count', '1'); url.searchParams.set('space', 'drive'); url.searchParams.set('type', 'files');
      const { value } = await driveRequest(url, { method: 'GET' }, context, signal);
      if (!Array.isArray(value.ids) || value.ids.length !== 1 || !identifier(value.ids[0])) fail('drive_error');
      id = value.ids[0];
    }
    const allocated = { id, metadata: { ...metadata, id }, complete: Boolean(existingId), allocatedAt: timestamp() };
    // Persist the exact ID before any create request. An uncertain result can only be retried with this ID.
    await update(context, saved => { if (Object.keys(saved.allocations).length >= 12000) fail('drive_error'); saved.allocations[key] = allocated; });
    return allocated;
  }
  async function markComplete(key, context) {
    if (connected(context).allocations[key]?.complete) return;
    await update(context, saved => { if (!saved.allocations[key]) fail('drive_error'); saved.allocations[key].complete = true; });
  }
  async function ensureFolder(name, parentId, path, context, signal) {
    const key = `folder:${path}`;
    const metadata = { name, mimeType: FOLDER_MIME, parents: [parentId], appProperties: { namespace: NAMESPACE, kind: 'folder', path } };
    const query = `trashed=false and ${quote(parentId)} in parents and name=${quote(name)}`;
    const validateFolder = file => {
      // drive.file can list app-created children of 'root', but cannot read My Drive itself.
      // For this alias, the list query establishes parent membership; Google returns the real parent ID.
      const expected = parentId === 'root' ? { ...metadata, parents: [file?.parents?.[0]] } : metadata;
      validateFile(file, expected);
      if (!identifier(file.parents[0])) fail('drive_error');
    };
    let file = await findFiles(query, context, signal);
    if (file) {
      validateFolder(file);
      await allocation(key, metadata, context, signal, file.id);
      await markComplete(key, context);
      return file.id;
    }
    const allocated = await allocation(key, metadata, context, signal);
    if (JSON.stringify(allocated.metadata) !== JSON.stringify({ ...metadata, id: allocated.id })) fail('drive_error');
    file = await getFile(allocated.id, context, signal);
    if (!file) {
      const url = new URL(API); url.searchParams.set('fields', FILE_FIELDS);
      await driveRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(allocated.metadata) }, context, signal, { allowed: [409] });
      file = await getFile(allocated.id, context, signal);
    }
    if (parentId === 'root') {
      file = await findFiles(query, context, signal);
      if (file?.id !== allocated.id) fail('drive_error');
    }
    validateFolder(file);
    await markComplete(key, context);
    return file.id;
  }
  async function upload(metadata, content, context, signal) {
    if (content.bytes.length <= 5 * 1024 * 1024) {
      const boundary = `mailharbor-${randomBytes(24).toString('hex')}`;
      const prefix = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${content.mimeType}\r\n\r\n`);
      const body = Buffer.concat([prefix, content.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const url = new URL(UPLOAD); url.searchParams.set('uploadType', 'multipart'); url.searchParams.set('fields', FILE_FIELDS);
      await driveRequest(url, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.length) }, body }, context, signal, { allowed: [409] });
    } else {
      const url = new URL(UPLOAD); url.searchParams.set('uploadType', 'resumable'); url.searchParams.set('fields', FILE_FIELDS);
      const started = await driveRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': content.mimeType, 'X-Upload-Content-Length': String(content.bytes.length) }, body: JSON.stringify(metadata) }, context, signal, { allowed: [409], empty: true });
      if (started.status === 409) return;
      let location;
      try { location = knownUrl(started.headers.get('location')); } catch { fail('drive_error'); }
      if (location.origin !== 'https://www.googleapis.com' || location.pathname !== '/upload/drive/v3/files' || location.searchParams.get('uploadType') !== 'resumable' || !field(location.searchParams.get('upload_id'), 2048)) fail('drive_error');
      await driveRequest(location, { method: 'PUT', headers: { 'Content-Type': content.mimeType, 'Content-Length': String(content.bytes.length) }, body: content.bytes }, context, signal, { allowed: [409] });
    }
  }
  function result(file, content, deduplicated) {
    return { fileId: file.id, webViewLink: `https://drive.google.com/file/d/${file.id}/view`, folderPath: content.path, sha256: content.sha256, deduplicated };
  }
  function status() {
    const value = state();
    return { configured: Boolean(value.registration), connected: Boolean(value.connection), email: value.connection?.email || null, expectedEmail: value.registration?.expectedEmail || '',
      callback, clientId: value.registration?.clientId || '', scope: DRIVE_SCOPE, rootFolderId: value.allocations['folder:Invoices']?.complete ? value.allocations['folder:Invoices'].id : null };
  }
  return {
    status,
    async configure(body) {
      if (closed) fail('busy');
      strict(body, ['clientId', 'clientSecret', 'expectedEmail']);
      if (!field(body.clientId, 512) || !/^[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com$/u.test(body.clientId) || (body.clientSecret !== undefined && body.clientSecret !== '' && !field(body.clientSecret, 4096))) fail('invalid_request');
      const old = state(), secret = body.clientSecret || (old.registration?.clientId === body.clientId ? old.registration.clientSecret : '');
      const suppliedEmail = body.expectedEmail ?? old.registration?.expectedEmail ?? '';
      if (typeof suppliedEmail !== 'string') fail('invalid_request');
      const expectedEmail = suppliedEmail.trim().toLowerCase();
      if (!field(secret, 4096) || !emailAddress(expectedEmail)) fail('invalid_request');
      if (old.registration?.clientId === body.clientId && old.registration.clientSecret === secret && old.registration.expectedEmail === expectedEmail) return status();
      invalidate(); const revision = nonce(), expectedEpoch = epoch;
      await store.update(data => {
        if (closed || expectedEpoch !== epoch) fail('drive_login_required');
        const previous = readState(data);
        data.mailDrive = { schema: 1, revision, registration: { clientId: body.clientId, clientSecret: secret, expectedEmail }, connection: null,
          allocations: previous.registration?.clientId === body.clientId && previous.registration.expectedEmail === expectedEmail ? previous.allocations : {} };
      });
      return status();
    },
    start(sessionBinding) {
      if (!field(sessionBinding, 1024)) fail('unauthorized');
      const snapshot = context(), registration = current(snapshot).registration;
      if (!registration || !emailAddress(registration.expectedEmail)) fail('drive_not_configured');
      for (const [key, value] of oauth) if (value.expires <= timestamp()) oauth.delete(key);
      if (oauth.size >= 12) fail('busy');
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
      oauth.set(state, { ...snapshot, ownerHash: hash(sessionBinding), verifier, expires: timestamp() + 600000 });
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries({ client_id: registration.clientId, redirect_uri: callback, response_type: 'code', scope: DRIVE_SCOPE, state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', login_hint: registration.expectedEmail })) url.searchParams.set(key, value);
      return { url: url.href };
    },
    async finish(params, sessionBinding) {
      if (!(params instanceof URLSearchParams) || !field(sessionBinding, 1024) || params.getAll('state').length !== 1 || params.getAll('code').length > 1) fail('unauthorized');
      const key = params.get('state'), entry = oauth.get(key);
      if (!entry || entry.expires <= timestamp() || !timingSafeEqual(Buffer.from(entry.ownerHash, 'hex'), Buffer.from(hash(sessionBinding), 'hex'))) fail('unauthorized');
      oauth.delete(key);
      if (params.has('error') || !field(params.get('code'), 8192)) fail('drive_login_required');
      return operation(entry, null, async signal => {
        const previous = current(entry), registration = previous.registration;
        if (!registration || !emailAddress(registration.expectedEmail)) fail('drive_not_configured');
        const auth = await tokenRequest({ grant_type: 'authorization_code', code: params.get('code'), client_id: registration.clientId, client_secret: registration.clientSecret, redirect_uri: callback, code_verifier: entry.verifier }, entry, signal);
        const { value: identity } = await request(USERINFO_URL, { method: 'GET', headers: { Authorization: `Bearer ${auth.accessToken}` } }, entry, signal);
        if (identity.email_verified !== true || typeof identity.email !== 'string' || identity.email.trim().toLowerCase() !== registration.expectedEmail || !field(identity.sub, 255)) fail('drive_wrong_account');
        if (!auth.refreshToken) {
          if (previous.connection?.subject !== identity.sub || !field(previous.connection?.refreshToken, 32768)) fail('drive_login_required');
          auth.refreshToken = previous.connection.refreshToken;
        }
        await update(entry, saved => {
          saved.connection = { ...auth, email: registration.expectedEmail, subject: identity.sub, connectedAt: timestamp() };
          saved.revision = nonce();
        });
        invalidate();
        return status();
      });
    },
    async disconnect() {
      if (closed) fail('busy');
      invalidate(); const expectedEpoch = epoch;
      await store.update(data => {
        if (closed || expectedEpoch !== epoch) fail('drive_login_required');
        const value = readState(data); value.connection = null; value.revision = nonce(); data.mailDrive = value;
      });
      return status();
    },
    fileInvoice(input, { signal } = {}) {
      let content;
      try { content = invoice(input); } catch (error) { return Promise.reject(error); }
      if (queued >= 16) return Promise.reject(new MailHarborError('busy'));
      queued++;
      const work = pending.then(() => {
        const snapshot = context();
        return operation(snapshot, signal, async combined => {
          connected(snapshot);
          let parent = 'root', path = '';
          for (const name of ['Invoices', content.entityLabel, String(content.year), `Q${content.quarter}`]) {
            path = path ? `${path}/${name}` : name;
            parent = await ensureFolder(name, parent, path, snapshot, combined);
          }
          const properties = { namespace: NAMESPACE, kind: 'invoice', sha256: content.sha256, entity: content.entityLabel, year: String(content.year), quarter: `Q${content.quarter}`, path: content.path };
          const metadata = { name: content.filename, mimeType: content.mimeType, parents: [parent], appProperties: properties };
          const key = `file:${content.path}/${content.sha256}`;
          let file = await findFiles(`trashed=false and ${quote(parent)} in parents and ${Object.entries(properties).map(([name, value]) => propertyQuery(name, value)).join(' and ')}`, snapshot, combined, 'drive_duplicate_ambiguous');
          if (file) {
            validateFile(file, metadata, content); await allocation(key, metadata, snapshot, combined, file.id);
            await markComplete(key, snapshot);
            return result(file, content, true);
          }
          const allocated = await allocation(key, metadata, snapshot, combined);
          const intended = { ...allocated.metadata, name: metadata.name, id: allocated.id };
          if (JSON.stringify(intended) !== JSON.stringify({ ...metadata, id: allocated.id })) fail('drive_error');
          file = await getFile(allocated.id, snapshot, combined);
          if (file) { validateFile(file, metadata, content); await markComplete(key, snapshot); return result(file, content, true); }
          await upload(allocated.metadata, content, snapshot, combined);
          file = await getFile(allocated.id, snapshot, combined); validateFile(file, metadata, content); await markComplete(key, snapshot);
          return result(file, content, false);
        });
      }).finally(() => { queued--; });
      pending = work.catch(() => {});
      return work;
    },
    async close() {
      closed = true; invalidate();
      await Promise.allSettled([pending, refresh?.promise, ...[...operations].map(entry => entry.promise)]);
    }
  };
}
