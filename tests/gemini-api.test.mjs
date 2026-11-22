import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGeminiApi, DEFAULT_GEMINI_MODEL } from '../server/gemini-api.mjs';
import { createJobs } from '../server/jobs.mjs';
import { createMailboxSession } from '../server/mailboxes.mjs';
import { createAccountStore } from '../server/account-store.mjs';
import { createWebFactory } from '../server/web-app.mjs';

const TEST_KEY = 'AQ.test-gemini-key-0123456789abcdef';

function memoryStore(initial = {}) {
  let doc = structuredClone(initial);
  return {
    read: () => structuredClone(doc),
    async update(mutator) {
      const next = structuredClone(doc);
      await mutator(next);
      doc = next;
      return structuredClone(doc);
    }
  };
}

function geminiJsonResponse(jsonObj, usage = { promptTokenCount: 1000, candidatesTokenCount: 200 }) {
  return new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(jsonObj) }] } }],
    usageMetadata: usage
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('gemini-api configures encrypted state, redacts keys, disables thinking overhead, and reconciles exact micro-USD spend', async () => {
  const store = memoryStore();
  const requests = [];
  const gemini = createGeminiApi({
    store,
    fetcher: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return geminiJsonResponse({ ok: true }, {
        promptTokenCount: 10_000,
        cachedContentTokenCount: 2_000,
        candidatesTokenCount: 1_000
      });
    }
  });

  assert.equal(gemini.isActive(), false);
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(gemini.status().model, 'gemini-3.5-flash-lite');
  assert.equal(gemini.status().maxSpendUsd, 12);

  const configured = await gemini.configure({
    apiKey: TEST_KEY,
    enabled: true,
    model: 'gemini-2.5-flash-lite',
    maxSpendUsd: 12
  });
  assert.equal(configured.enabled, true);
  assert.equal(configured.configured, true);
  assert.equal(configured.maxSpendUsd, 12);
  assert.equal('apiKey' in configured, false, 'API key must never appear in status payload');

  const tested = await gemini.test({});
  assert.equal(tested.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['x-goog-api-key'], TEST_KEY);
  assert.deepEqual(requests[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(requests[0].body.generationConfig.responseMimeType, 'application/json');

  // 8,000 uncached input * $0.10/1M ($0.0008) + 2,000 cached * $0.025/1M ($0.00005) + 1,000 output * $0.40/1M ($0.0004) = $0.00125 -> 1,250 micros -> $0.0013 rounded to 4dp
  const afterTest = gemini.status();
  assert.equal(afterTest.requests, 1);
  assert.equal(afterTest.inputTokens, 10_000);
  assert.equal(afterTest.cachedTokens, 2_000);
  assert.equal(afterTest.outputTokens, 1_000);
  assert.equal(store.read().geminiApi.spentMicros, 1_250);

  // Switch to gemini-3.1-flash-lite and verify minimal thinking config
  await gemini.configure({ model: 'gemini-3.1-flash-lite' });
  await gemini.test({});
  assert.deepEqual(requests[1].body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });

  // Clear key disables provider without losing spend ledger unless resetSpend is passed
  const cleared = await gemini.configure({ clearKey: true });
  assert.equal(cleared.enabled, false);
  assert.equal(cleared.configured, false);
  assert.equal(cleared.requests, 2);

  const reset = await gemini.configure({ resetSpend: true });
  assert.equal(reset.spentUsd, 0);
  assert.equal(reset.requests, 0);
});

test('gemini-api classification sends constrained responseSchema + BLOCK_NONE safetySettings and canonicalizes nullable optional fields', async () => {
  const store = memoryStore();
  let capturedBody = null;
  const gemini = createGeminiApi({
    store,
    fetcher: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return geminiJsonResponse({
        items: [
          {
            id: 'm0',
            labels: ['development', 'development'],
            confidence: 0.98,
            junk: 'legitimate',
            junkConfidence: 0.99,
            dates: null,
            dateConfidence: null,
            appointment: null
          },
          {
            id: 'm1',
            labels: ['appointments'],
            confidence: 0.96,
            junk: 'legitimate',
            junkConfidence: 0.99,
            dates: {
              couponExpiry: '2026-12-31',
              tenderDeadline: null,
              appointmentStart: '2026-11-25T14:00Z',
              appointmentEnd: null
            },
            dateConfidence: null,
            appointment: { title: 'Incomplete end time', location: '' }
          }
        ]
      });
    }
  });
  await gemini.configure({ apiKey: TEST_KEY, enabled: true, model: 'gemini-3.5-flash-lite', maxSpendUsd: 12 });
  const id0 = '1'.repeat(64);
  const id1 = '2'.repeat(64);
  const result = await gemini.classificationRunner({
    messages: [
      { id: id0, subject: 'PR merged', author: 'bot@example.test', to: 'owner@example.test', date: '2026-11-20T10:00:00Z', folderKind: 'inbox', body: 'Merged pull request #12.', complete: true },
      { id: id1, subject: 'Dentist', author: 'clinic@example.test', to: 'owner@example.test', date: '2026-11-20T11:00:00Z', folderKind: 'inbox', body: 'Appointment starts 14:00.', complete: true }
    ]
  });

  assert.equal(capturedBody.generationConfig.responseSchema?.properties?.items?.type, 'ARRAY');
  assert.equal('minItems' in (capturedBody.generationConfig.responseSchema?.properties?.items ?? {}), false);
  assert.equal(capturedBody.safetySettings?.every(item => item.threshold === 'BLOCK_NONE'), true);
  assert.deepEqual(result.items[0].labels, ['development']);
  assert.equal(result.items[0].appointment, null);
  assert.equal(result.items[0].dateConfidence, 0);
  // Partial appointment without appointmentEnd conservatively clears appointment dates so policy holds for confirmation
  assert.equal(result.items[1].dates.couponExpiry, null);
  assert.equal(result.items[1].dates.appointmentStart, null);
  assert.equal(result.items[1].appointment, null);
});

test('gemini-api pre-flight reservation strictly prevents concurrent batches from exceeding the hard USD spend cap', async () => {
  const store = memoryStore();
  let inFlight = 0;
  let maxConcurrent = 0;

  const gemini = createGeminiApi({
    store,
    fetcher: async (_url, init) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise(resolve => setTimeout(resolve, 25));
      inFlight--;
      const body = JSON.parse(init.body);
      const isClassification = body.contents[0].parts[0].text.includes('Classify mail.');
      if (isClassification) {
        return geminiJsonResponse(
          { items: [{ id: 'm0', labels: ['newsletters'], confidence: 0.92, junk: 'legitimate', junkConfidence: 0.9 }] },
          { promptTokenCount: 2_000, candidatesTokenCount: 150 }
        );
      }
      return geminiJsonResponse({ ok: true }, { promptTokenCount: 4_000, candidatesTokenCount: 200 });
    }
  });

  // Set lowest allowed hard spend cap ($0.50 = 500,000 micros) and pre-seed spentMicros so exactly 1 reservation (~550 micros) fits
  await gemini.configure({ apiKey: TEST_KEY, enabled: true, model: 'gemini-2.5-flash-lite', maxSpendUsd: 0.5 });
  await store.update(doc => { doc.geminiApi.spentMicros = 499_400; });

  // Launch 6 concurrent classification batches; reservation for 1 batch (~550 micros) fits once, blocking the other 5 pre-flight!
  const makeBatch = idx => gemini.classificationRunner({
    messages: [{
      id: String(idx + 1).padStart(64, 'a'),
      subject: `Newsletter ${idx}`,
      author: `sender-${idx}@example.test`,
      to: 'owner@example.test',
      date: '2026-10-01T10:00:00Z',
      folderKind: 'inbox',
      body: 'Unsubscribe from our weekly product digest at any time.',
      complete: true
    }]
  });

  const outcomes = await Promise.allSettled([0, 1, 2, 3, 4, 5].map(makeBatch));
  const succeeded = outcomes.filter(item => item.status === 'fulfilled');
  const rejected = outcomes.filter(item => item.status === 'rejected');

  assert.equal(succeeded.length, 1, 'Only one batch may pass pre-flight budget reservation near the cap');
  assert.equal(rejected.length, 5, 'Remaining concurrent batches must be rejected before calling the network');
  for (const item of rejected) {
    assert.equal(item.reason?.code, 'quota_exhausted');
    assert.deepEqual(item.reason?.diagnostic, { stage: 'provider_limits', reason: 'provider_budget_reached' });
  }
  assert.equal(maxConcurrent, 1);
});

test('jobs manager routes classification & briefings to Direct Gemini API with 3x concurrency and isolated budget pause', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-gemini-jobs-'));
  const cooldownFile = path.join(dir, 'quota-cooldown.json');
  try {
    const store = memoryStore();
    let agyCalled = 0;
    let activeFetches = 0;
    let peakFetches = 0;

    const gemini = createGeminiApi({
      store,
      fetcher: async () => {
        activeFetches++;
        peakFetches = Math.max(peakFetches, activeFetches);
        await new Promise(resolve => setTimeout(resolve, 30));
        activeFetches--;
        return geminiJsonResponse(
          { items: [{ id: 'm0', labels: ['work'], confidence: 0.94, junk: 'legitimate', junkConfidence: 0.95 }] },
          { promptTokenCount: 1500, candidatesTokenCount: 150 }
        );
      }
    });
    await gemini.configure({ apiKey: TEST_KEY, enabled: true, maxSpendUsd: 12 });

    const jobs = createJobs({ cooldownFile, timeoutMs: 30_000 }, async () => {
      agyCalled++;
      throw new Error('Agy CLI should not be called when Direct Gemini API is active');
    });
    jobs.setGeminiProvider(gemini);
    assert.equal(jobs.isFastMode(), true);

    const initialStatus = await jobs.status();
    assert.equal(initialStatus.ready, true);
    assert.equal(initialStatus.provider, 'gemini-api');
    assert.equal(initialStatus.model, 'gemini-3.5-flash-lite');

    const payload = {
      messages: [{
        id: 'b'.repeat(64),
        subject: 'Project update',
        author: 'colleague@example.test',
        to: 'owner@example.test',
        date: '2026-10-02T09:00:00Z',
        folderKind: 'inbox',
        body: 'Please review the attached sprint milestones.',
        complete: true
      }]
    };

    const submitted = await Promise.all([0, 1, 2, 3].map(() => jobs.submit(payload, 'mailharbor-processing', 'classification')));
    while (submitted.some(job => !['completed', 'failed'].includes(jobs.get(job.id, 'mailharbor-processing').status))) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.equal(agyCalled, 0);
    assert.ok(peakFetches >= 2 && peakFetches <= 3, `Expected parallel Gemini execution up to 3, saw ${peakFetches}`);
    for (const job of submitted) {
      assert.equal(jobs.get(job.id, 'mailharbor-processing').status, 'completed');
    }

    // Simulate reaching budget cap: status reports quota_exhausted without writing Agy quota-cooldown.json
    await store.update(doc => { doc.geminiApi.spentMicros = doc.geminiApi.maxSpendMicros; });
    const cappedStatus = await jobs.status();
    assert.equal(cappedStatus.ready, false);
    assert.equal(cappedStatus.code, 'quota_exhausted');
    await assert.rejects(() => stat(cooldownFile), { code: 'ENOENT' });

    await jobs.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createMailboxSession reuses healthy pooled IMAP connections and evicts on credential change or close()', async () => {
  const created = [];
  let closedCount = 0;
  class PooledClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.usable = true;
      this.closed = false;
      this.noopCalls = 0;
      created.push(this);
    }
    async connect() {}
    async noop() { this.noopCalls++; }
    close() { this.closed = true; this.usable = false; closedCount++; }
  }

  let secret = 'token-v1';
  const pool = createMailboxSession({
    connectionOptions: async account => ({ host: 'imap.example.test', port: 993, auth: { user: account.email, accessToken: secret } }),
    createClient: opts => new PooledClient(opts),
    poolIdleMs: 10_000
  });

  const account = { id: 'acc-1', revision: 1, email: 'owner@example.test' };
  const firstClient = await pool.session(account, undefined, async client => client);
  const secondClient = await pool.session(account, undefined, async client => client);
  assert.equal(firstClient, secondClient, 'Second session within poolIdleMs reuses the same authenticated IMAP client');
  assert.equal(created.length, 1);
  assert.equal(closedCount, 0);

  // Rotating OAuth accessToken evicts old idle client and opens a fresh one
  secret = 'token-v2';
  const thirdClient = await pool.session(account, undefined, async client => client);
  assert.notEqual(thirdClient, firstClient);
  assert.equal(firstClient.closed, true);
  assert.equal(created.length, 2);

  pool.close();
  assert.equal(thirdClient.closed, true);
  assert.equal(closedCount, 2);
});

test('web-app /api/gemini routes enforce session + CSRF and configure budget-capped Gemini provider', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mailharbor-gemini-web-'));
  try {
    const store = await createAccountStore(dir);
    let setProviderCalled = false;
    const fakeJobs = {
      setGeminiProvider() { setProviderCalled = true; },
      clearProviderPause() {},
      async status() { return { ready: true, provider: 'gemini-api', version: '0.9.0' }; }
    };
    const webFactory = createWebFactory(
      { origin: 'http://127.0.0.1:8765', stateDir: dir, mailCache: { enabled: false } },
      {
        store,
        fetcher: async () => geminiJsonResponse({ ok: true }, { promptTokenCount: 50, candidatesTokenCount: 10 })
      }
    );
    const web = webFactory({
      jobs: fakeJobs,
      verifyToken: async token => token === 'valid-pairing-token-0123456789abcdef',
      agyLogin: null
    });

    async function call(pathname, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
      const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
      const req = Object.assign(new EventEmitter(), {
        url: pathname,
        method,
        headers: {
          host: '127.0.0.1:8765',
          origin: 'http://127.0.0.1:8765',
          ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          ...(cookie ? { cookie } : {}),
          ...(csrf ? { 'x-mailharbor-csrf': csrf } : {})
        },
        socket: { remoteAddress: '127.0.0.1', destroyed: false },
        aborted: false,
        resume() {}
      });
      let resStatus = 0;
      let resHeaders = {};
      const chunks = [];
      const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        writeHead(code, headers) { resStatus = code; resHeaders = headers; this.headersSent = true; },
        end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); this.writableEnded = true; this.emit('close'); }
      });
      const handledPromise = web.handle(req, res);
      if (body !== undefined) {
        queueMicrotask(() => { req.emit('data', payload); req.emit('end'); });
      }
      await handledPromise;
      const text = Buffer.concat(chunks).toString('utf8');
      const isJson = String(resHeaders['Content-Type'] ?? '').includes('application/json');
      return { status: resStatus, headers: resHeaders, text, json: isJson && text ? JSON.parse(text) : null };
    }

    // Unauthenticated request rejected
    assert.equal((await call('/api/gemini')).status, 401);

    // Pair session
    const sessionRes = await call('/api/session', { method: 'POST', body: { token: 'valid-pairing-token-0123456789abcdef' } });
    assert.equal(sessionRes.status, 200);
    assert.equal(setProviderCalled, true);
    const cookie = String(sessionRes.headers['Set-Cookie']).split(';')[0];
    const csrf = sessionRes.json.csrf;

    // Missing CSRF rejected on POST
    assert.equal((await call('/api/gemini', { method: 'POST', cookie, body: { maxSpendUsd: 12 } })).status, 401);

    // Authenticated + CSRF succeeds
    const saved = await call('/api/gemini', {
      method: 'POST',
      cookie,
      csrf,
      body: { apiKey: TEST_KEY, enabled: true, model: 'gemini-2.5-flash-lite', maxSpendUsd: 12 }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.enabled, true);
    assert.equal(saved.json.maxSpendUsd, 12);

    const tested = await call('/api/gemini/test', { method: 'POST', cookie, csrf, body: {} });
    assert.equal(tested.status, 200);
    assert.equal(tested.json.ok, true);

    // Serve new static module
    const asset = await call('/gemini-settings.mjs');
    assert.equal(asset.status, 200);
    assert.match(asset.text, /createGeminiSettingsView/);

    await web.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
