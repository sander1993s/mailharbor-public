import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { runAgy } from './runner.mjs';
import { createJobs } from './jobs.mjs';
import { createAgyLogin } from './agy-login.mjs';
import { MAX_REQUEST_BYTES, MailHarborError, errorMessages, safeError, validateRequest } from './validation.mjs';

const statusCodes = { unauthorized: 401, invalid_request: 400, busy: 429, not_found: 404, configuration_error: 503, quota_exhausted: 503, login_required: 503 };
const digest = value => createHash('sha256').update(value).digest();

async function loadToken(config) {
  const token = config.pairingToken ?? (await readFile(config.tokenFile, 'utf8')).trim();
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new MailHarborError('configuration_error', errorMessages.configuration_error);
  return digest(token);
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new MailHarborError('invalid_request');
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) throw new MailHarborError('invalid_request');
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new MailHarborError('invalid_request');
    chunks.push(chunk);
  }
  try {
    const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return validateRequest(JSON.parse(body));
  } catch { throw new MailHarborError('invalid_request'); }
}

function send(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
  });
  response.end(JSON.stringify(body));
}

/** The caller must listen on 127.0.0.1. Tests may inject a pure/fake runner. */
export function createServer(config, runner = runAgy, options = {}) {
  const jobs = createJobs(config, runner);
  const agyLogin = options.agyLogin ?? createAgyLogin(config, { onConnected: () => jobs.resumeAfterLogin() });
  const token = loadToken(config).then(value => ({ value }), () => ({ error: true }));
  async function verifyToken(raw) {
    const expected = await token;
    if (expected.error) throw new MailHarborError('configuration_error');
    return typeof raw === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(raw) && timingSafeEqual(digest(raw), expected.value);
  }
  let web;
  try { web = options.createWeb?.({ jobs, verifyToken, agyLogin }); }
  catch (error) { void jobs.close(); void Promise.resolve().then(() => agyLogin.close()).catch(() => {}); throw error; }
  let closed = false;
  let closing = null;
  let webClosing = null;
  let loginClosing = null;
  const closeWeb = () => webClosing ??= Promise.resolve().then(() => web?.close());
  const closeLogin = () => loginClosing ??= Promise.resolve().then(() => agyLogin.close());

  const server = http.createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    try {
      if (closed) throw new MailHarborError('busy');
      if (web && await web.handle(request, response)) return;
      const authorization = request.headers.authorization ?? '';
      const authorized = await verifyToken(/^Bearer [A-Za-z0-9_-]{32,128}$/.test(authorization) ? authorization.slice(7) : null);
      if (!authorized) throw new MailHarborError('unauthorized');
      const path = request.url;
      if (request.method === 'GET' && path === '/v1/status') return send(response, 200, await jobs.status());
      if (request.method === 'POST' && path === '/v1/jobs') {
        const input = await readJson(request);
        return send(response, 202, await jobs.submit(input));
      }
      const match = /^\/v1\/jobs\/([A-Za-z0-9_-]{24})$/.exec(path ?? '');
      if (match && ['GET', 'DELETE'].includes(request.method)) {
        return send(response, 200, request.method === 'DELETE' ? jobs.cancel(match[1]) : jobs.get(match[1]));
      }
      throw new MailHarborError('not_found');
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const safe = safeError(error);
        send(response, statusCodes[safe.code] ?? 500, { error: safe });
      }
      request.resume();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  server.shutdown = () => closing ??= (async () => {
    closed = true;
    const stopping = Promise.allSettled([closeWeb(), closeLogin(), jobs.close()]);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    const stopped = await stopping;
    const failed = stopped.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  })();
  server.on('close', () => {
    closed = true;
    void jobs.close().catch(() => {});
    void closeWeb().catch(() => {});
    void closeLogin().catch(() => {});
  });
  // Refuse accidental exposure if bootstrap configuration changes.
  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    const host = typeof args[0] === 'object' ? args[0]?.host : args[1];
    if (host !== '127.0.0.1' && host !== '::1') throw new MailHarborError('configuration_error', 'MailHarbor must bind a loopback address.');
    return listen(...args);
  };
  return server;
}

export async function closeServer(server) { await server.shutdown(); }
