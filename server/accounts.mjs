import { randomBytes, createHash } from 'node:crypto';
import { MailHarborError } from './validation.mjs';

import { MAIL_PROVIDERS, MAX_ACCOUNTS, accountDefinition, incomingEndpoint, smtpEndpoint } from './providers.mjs';
import { smtpTlsOptions } from './smtp-tls.mjs';

const PROVIDERS = Object.freeze({
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'https://mail.google.com/' },
  microsoft: { authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access' }
});
const TOKEN_ERRORS = Object.freeze({
  invalid_client: 'oauth_invalid_client', unauthorized_client: 'oauth_unauthorized_client',
  invalid_scope: 'oauth_invalid_scope', invalid_grant: 'oauth_invalid_grant'
});
const fail = code => { throw new MailHarborError(code); };
function strict(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) fail('invalid_request');
}
function field(value, max = 2048) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }

export function createAccounts({ store, publicOrigin, testAccount, fetcher = fetch }) {
  const oauth = new Map();
  const refreshes = new Map();
  const generations = new Map();
  let closed = false;
  const callback = provider => `${publicOrigin}/oauth/${provider}/callback`;
  const sameRegistration = (a, b) => Boolean(a && b && a.clientId === b.clientId && a.clientSecret === b.clientSecret);
  function invalidate(id) {
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    for (const [state, pending] of oauth) if (pending.id === id) oauth.delete(state);
    return generation;
  }
  function assertCurrent(id, generation) {
    if (closed || generations.get(id) !== generation) fail('stale_message');
  }

  function definition(id) { if (closed) fail('busy'); return store.read().accounts.find(item => item.id === id) ?? fail('mailbox_login_required'); }
  function account(id) { const value = definition(id); if (!value.auth) fail('mailbox_login_required'); return value; }
  async function tokenRequest(provider, params) {
    let response;
    try {
      response = await fetcher(PROVIDERS[provider].token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch { fail('oauth_token_transport'); }
    if (!response || response.redirected || (response.url && response.url !== PROVIDERS[provider].token)) fail('oauth_token_response');
    let text;
    try { text = await response.text(); } catch { fail('oauth_token_transport'); }
    if (typeof text !== 'string' || text.length > 65536) fail('oauth_token_response');
    let value;
    try { value = JSON.parse(text); } catch { fail('oauth_token_response'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('oauth_token_response');
    if (!response.ok || value.error !== undefined) {
      // Only an exact protocol error name may select a fixed local diagnostic.
      // Provider descriptions, response bodies, URLs and credentials never leave this scope.
      fail(typeof value.error === 'string' && Object.hasOwn(TOKEN_ERRORS, value.error) ? TOKEN_ERRORS[value.error] : 'oauth_token_response');
    }
    if (!field(value.access_token, 32768) || !Number.isFinite(value.expires_in) || value.expires_in < 1 ||
        (value.refresh_token !== undefined && !field(value.refresh_token, 32768)) ||
        (value.scope !== undefined && !field(value.scope, 4096))) fail('oauth_token_response');
    return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: Date.now() + Math.min(value.expires_in, 86400) * 1000,
      ...(value.scope ? { oauthScope: value.scope } : {}) };
  }
  async function saveAccount(value, verify = () => {}) {
    await store.update(data => {
      verify(data);
      const index = data.accounts.findIndex(item => item.id === value.id);
      if (index < 0) data.accounts.push(value); else data.accounts[index] = value;
    });
  }
  async function accessToken(value) {
    if (value.auth.expiresAt > Date.now() + 60000) return value.auth.accessToken;
    const existing = refreshes.get(value.id);
    if (existing?.revision === value.revision) return existing.promise;
    const refresh = { revision: value.revision };
    refresh.promise = (async () => {
      const current = account(value.id);
      if (current.revision !== value.revision) fail('stale_message');
      const registration = store.read().providers[value.provider];
      if (!registration || !field(current.auth.refreshToken, 32768)) fail('mailbox_login_required');
      const params = { grant_type: 'refresh_token', refresh_token: current.auth.refreshToken, client_id: registration.clientId };
      if (registration.clientSecret) params.client_secret = registration.clientSecret;
      // Existing IMAP-only grants must continue refreshing without demanding new
      // consent. SMTP permission is requested only by an explicit reconnect.
      if (value.provider === 'microsoft') params.scope = current.auth.oauthScope || 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';
      const refreshed = await tokenRequest(value.provider, params);
      await store.update(data => {
        const saved = data.accounts.find(item => item.id === value.id);
        if (closed || !saved || saved.revision !== current.revision || !sameRegistration(data.providers[value.provider], registration)) fail('stale_message');
        saved.auth = { ...saved.auth, type: 'oauth', ...refreshed, refreshToken: refreshed.refreshToken || current.auth.refreshToken };
      });
      return refreshed.accessToken;
    })().finally(() => { if (refreshes.get(value.id) === refresh) refreshes.delete(value.id); });
    refreshes.set(value.id, refresh);
    return refresh.promise;
  }
  return {
    list() {
      const data = store.read();
      return data.accounts.map(item => ({ id: item.id, preset: item.preset ?? item.provider, provider: item.provider, label: item.label, email: item.email,
        username: item.username ?? item.email, host: item.host, port: item.port, security: item.security ?? 'tls',
        connected: Boolean(item.auth), authType: item.auth?.type ?? null, archivePath: item.archivePath ?? null,
        connectedAt: item.connectedAt ?? null, oauthConfigured: Boolean(data.providers[item.provider]) }));
    },
    catalog() { return structuredClone(MAIL_PROVIDERS); },
    async add(body) {
      if (closed) fail('busy');
      const value = { ...accountDefinition(body), id: randomBytes(16).toString('hex'), auth: null, revision: randomBytes(16).toString('hex') };
      await store.update(data => {
        if (closed) fail('busy');
        if (data.accounts.length >= MAX_ACCOUNTS) fail('busy');
        if (data.accounts.some(item => item.email.toLowerCase() === value.email.toLowerCase() && item.host === value.host && (item.username ?? item.email) === value.username)) fail('invalid_request');
        data.accounts.push(value);
      });
      return { id: value.id, connected: false };
    },
    registrations() {
      const providers = store.read().providers;
      return Object.entries(PROVIDERS).map(([id, value]) => ({ id, configured: Boolean(providers[id]), clientId: providers[id]?.clientId ?? '', callback: callback(id), scope: value.scope }));
    },
    get: account,
    async configureProvider(body) {
      if (closed) fail('busy');
      strict(body, ['provider', 'clientId', 'clientSecret']);
      if (!Object.hasOwn(PROVIDERS, body.provider) || !field(body.clientId, 512) || (body.clientSecret !== undefined && body.clientSecret !== '' && !field(body.clientSecret, 4096))) fail('invalid_request');
      if (body.provider === 'google' && !/^[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com$/.test(body.clientId)) fail('invalid_request');
      if (body.provider === 'microsoft' && !/^[a-f0-9-]{36}$/i.test(body.clientId)) fail('invalid_request');
      await store.update(data => {
        if (closed) fail('busy');
        const old = data.providers[body.provider];
        const secret = body.clientSecret || (old?.clientId === body.clientId ? old.clientSecret : '');
        if (!secret) fail('invalid_request');
        if (!sameRegistration(old, { clientId: body.clientId, clientSecret: secret })) {
          for (const item of data.accounts) if (item.provider === body.provider) invalidate(item.id);
        }
        if (old && old.clientId !== body.clientId) for (const item of data.accounts) if (item.provider === body.provider && item.auth?.type === 'oauth') {
          item.auth = null; item.connectedAt = null; item.revision = randomBytes(16).toString('hex');
        }
        data.providers[body.provider] = { clientId: body.clientId, clientSecret: secret,
          revision: sameRegistration(old, { clientId: body.clientId, clientSecret: secret }) && old.revision ? old.revision : randomBytes(16).toString('hex') };
      });
    },
    async connectPassword(body) {
      if (closed) fail('busy');
      strict(body, ['id', 'password', 'smtpPassword']);
      const info = definition(body.id);
      if (info.provider === 'microsoft' || !field(body.password, 4096) || (body.smtpPassword !== undefined && !field(body.smtpPassword, 4096))) fail('invalid_request');
      const password = info.provider === 'google' ? body.password.replaceAll(' ', '') : body.password;
      if (!field(password, 4096)) fail('invalid_request');
      const generation = invalidate(info.id);
      const value = { ...info, auth: { type: 'password', password, ...(body.smtpPassword ? { smtpPassword: body.smtpPassword } : {}) }, connectedAt: new Date().toISOString(), revision: randomBytes(16).toString('hex') };
      const tested = await testAccount(value);
      value.archivePath = tested.archivePath || undefined;
      await saveAccount(value, () => assertCurrent(info.id, generation));
      return { id: value.id, connected: true };
    },
    startOAuth(body, owner) {
      if (closed) fail('busy');
      strict(body, ['id']);
      const info = definition(body.id);
      if (!Object.hasOwn(PROVIDERS, info.provider)) fail('invalid_request');
      const registration = store.read().providers[info.provider];
      if (!registration) fail('oauth_not_configured');
      for (const [key, value] of oauth) if (value.expires < Date.now()) oauth.delete(key);
      if (oauth.size >= 12) fail('busy');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const generation = invalidate(info.id);
      const previousRevision = store.read().accounts.find(value => value.id === info.id)?.revision;
      oauth.set(state, { id: info.id, provider: info.provider, owner, verifier, generation, previousRevision, registration: { ...registration }, expires: Date.now() + 600000 });
      const url = new URL(PROVIDERS[info.provider].authorize);
      for (const [key, value] of Object.entries({ client_id: registration.clientId, redirect_uri: callback(info.provider), response_type: 'code', scope: PROVIDERS[info.provider].scope, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', login_hint: info.email, ...(info.provider === 'google' ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } : { prompt: 'select_account' }) })) url.searchParams.set(key, value);
      return { url: url.href };
    },
    async finishOAuth(provider, params, owner) {
      const state = params.get('state');
      const pending = oauth.get(state);
      if (!pending || pending.provider !== provider || pending.owner !== owner || pending.expires < Date.now()) fail('unauthorized');
      oauth.delete(state);
      assertCurrent(pending.id, pending.generation);
      if (!sameRegistration(store.read().providers[provider], pending.registration)) fail('stale_message');
      if (params.get('error') || !field(params.get('code'), 8192)) fail('mailbox_login_required');
      const auth = await tokenRequest(provider, { grant_type: 'authorization_code', client_id: pending.registration.clientId, client_secret: pending.registration.clientSecret, code: params.get('code'), redirect_uri: callback(provider), code_verifier: pending.verifier });
      assertCurrent(pending.id, pending.generation);
      if (!sameRegistration(store.read().providers[provider], pending.registration)) fail('stale_message');
      if (!field(auth.refreshToken, 32768)) {
        const previous = store.read().accounts.find(value => value.id === pending.id);
        if (provider !== 'google' || !previous || previous.revision !== pending.previousRevision || previous.auth?.type !== 'oauth' ||
            previous.auth.clientId !== pending.registration.clientId || previous.auth.registrationRevision !== pending.registration.revision ||
            !field(previous.auth.refreshToken, 32768)) fail('oauth_token_response');
        auth.refreshToken = previous.auth.refreshToken;
      }
      const value = { ...definition(pending.id), auth: { type: 'oauth', ...auth, oauthScope: auth.oauthScope || PROVIDERS[provider].scope, clientId: pending.registration.clientId,
        registrationRevision: pending.registration.revision }, connectedAt: new Date().toISOString(), revision: randomBytes(16).toString('hex') };
      let tested;
      try { tested = await testAccount(value); }
      catch (error) {
        fail(error instanceof MailHarborError && error.code === 'mailbox_login_required' ? 'oauth_imap_authentication_failed' : 'oauth_imap_connection_failed');
      }
      value.archivePath = tested.archivePath || undefined;
      await saveAccount(value, data => {
        assertCurrent(pending.id, pending.generation);
        if (!sameRegistration(data.providers[provider], pending.registration)) fail('stale_message');
      });
      return value.id;
    },
    async setArchivePath(id, archivePath) {
      if (!field(archivePath, 1024)) fail('invalid_request');
      const current = account(id);
      const generation = invalidate(id);
      const tested = await testAccount({ ...current, archivePath });
      if (tested.archivePath !== archivePath) fail('archive_unavailable');
      await store.update(data => {
        assertCurrent(id, generation);
        const saved = data.accounts.find(item => item.id === id);
        if (!saved || saved.revision !== current.revision) fail('stale_message');
        saved.archivePath = archivePath;
        saved.revision = randomBytes(16).toString('hex');
      });
      return { archivePath };
    },
    async connectionOptions(value) {
      if (closed) fail('busy');
      const info = definition(value.id), incoming = incomingEndpoint(info);
      if (['provider', 'email', 'username', 'host', 'port', 'security', 'allowLocalBridge', 'tlsCertificate'].some(key => value[key] !== info[key]) ||
          JSON.stringify(value.smtp) !== JSON.stringify(info.smtp)) fail('invalid_request');
      if (!value.auth) fail('mailbox_login_required');
      // OAuth credentials must only ever be sent to their provider's mail endpoints.
      if (value.auth.type === 'oauth' && !['google', 'microsoft'].includes(value.provider)) fail('invalid_request');
      return { host: incoming.host, port: incoming.port, secure: incoming.security === 'tls', doSTARTTLS: incoming.security === 'starttls',
        auth: value.auth.type === 'password' ? { user: info.username ?? info.email, pass: value.auth.password } : { user: info.username ?? info.email, accessToken: await accessToken(value) },
        logger: false, disableAutoIdle: true, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 45000, tls: smtpTlsOptions(info, incoming.host) };
    },
    smtpSettings(value) {
      const current = account(value.id);
      if (current.revision !== value.revision) fail('stale_message');
      return smtpEndpoint(current);
    },
    async disconnect(id) {
      if (closed) fail('busy');
      definition(id);
      invalidate(id);
      await store.update(data => { data.accounts = data.accounts.filter(item => item.id !== id); });
    },
    close() { closed = true; oauth.clear(); }
  };
}
