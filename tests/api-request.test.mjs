import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiRequest} from '../web/api-request.mjs';

function createTrackedSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  let activeCount = 0;
  let addedCount = 0;
  let removedCount = 0;

  const origAdd = signal.addEventListener.bind(signal);
  const origRemove = signal.removeEventListener.bind(signal);

  signal.addEventListener = function (type, listener, options) {
    if (type === 'abort') {
      activeCount++;
      addedCount++;
    }
    return origAdd(type, listener, options);
  };

  signal.removeEventListener = function (type, listener, options) {
    if (type === 'abort') {
      activeCount--;
      removedCount++;
    }
    return origRemove(type, listener, options);
  };

  return {
    controller,
    signal,
    get activeCount() { return activeCount; },
    get addedCount() { return addedCount; },
    get removedCount() { return removedCount; }
  };
}

test('success JSON response with credentials, no-store, Accept json and no body Content-Type', async () => {
  let capturedUrl;
  let capturedOptions;
  const fakeFetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', data: [1, 2, 3] })
    };
  };

  const api = createApiRequest({ fetchImpl: fakeFetch });
  const result = await api('/api/items');

  assert.strictEqual(capturedUrl, '/api/items');
  assert.strictEqual(capturedOptions.method, 'GET');
  assert.strictEqual(capturedOptions.credentials, 'same-origin');
  assert.strictEqual(capturedOptions.cache, 'no-store');
  assert.strictEqual(capturedOptions.headers.Accept, 'application/json');
  assert.strictEqual(capturedOptions.headers['Content-Type'], undefined);
  assert.strictEqual(capturedOptions.headers['X-MailHarbor-CSRF'], undefined);
  assert.deepStrictEqual(result, { status: 'ok', data: [1, 2, 3] });
});

test('success blob response with Accept application/octet-stream', async () => {
  let capturedOptions;
  const syntheticBlob = { size: 42, type: 'application/octet-stream' };
  const fakeFetch = async (url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      blob: async () => syntheticBlob
    };
  };

  const api = createApiRequest({ fetchImpl: fakeFetch });
  const result = await api('/api/download', { responseType: 'blob' });

  assert.strictEqual(capturedOptions.headers.Accept, 'application/octet-stream');
  assert.strictEqual(result, syntheticBlob);
});

test('sets Content-Type and serializes body for non-GET requests', async () => {
  let capturedOptions;
  const fakeFetch = async (url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({ saved: true })
    };
  };

  const api = createApiRequest({ fetchImpl: fakeFetch });
  const result = await api('/api/save', { method: 'POST', body: { note: 'test' } });

  assert.strictEqual(capturedOptions.method, 'POST');
  assert.strictEqual(capturedOptions.headers['Content-Type'], 'application/json');
  assert.strictEqual(capturedOptions.body, JSON.stringify({ note: 'test' }));
  assert.deepStrictEqual(result, { saved: true });
});

test('CSRF header added only for non-GET and non-session requests', async () => {
  let lastOptions;
  const fakeFetch = async (url, options) => {
    lastOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({})
    };
  };

  const api = createApiRequest({ getCsrf: () => 'token-xyz', fetchImpl: fakeFetch });

  // POST without sessionRequest
  await api('/api/actions', { method: 'POST', body: {} });
  assert.strictEqual(lastOptions.headers['X-MailHarbor-CSRF'], 'token-xyz');

  // DELETE without sessionRequest
  await api('/api/actions/1', { method: 'DELETE' });
  assert.strictEqual(lastOptions.headers['X-MailHarbor-CSRF'], 'token-xyz');

  // GET request (should not have CSRF)
  await api('/api/actions');
  assert.strictEqual(lastOptions.headers['X-MailHarbor-CSRF'], undefined);

  // POST with sessionRequest: true (should not have CSRF)
  await api('/api/session', { method: 'POST', body: { token: '123' }, sessionRequest: true });
  assert.strictEqual(lastOptions.headers['X-MailHarbor-CSRF'], undefined);
});

test('handles server error with errorMessages mapping and HTTP fallback', async () => {
  const errorMessages = {
    server_busy: 'The server is currently busy.',
    invalid_grant: 'Re-authenticate account.'
  };

  // Case A: payload.error is object with code
  const fakeFetch1 = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { code: 'server_busy', message: 'Busy' } })
  });
  const api1 = createApiRequest({ errorMessages, fetchImpl: fakeFetch1 });
  await assert.rejects(
    async () => api1('/api/test'),
    (err) => {
      assert.strictEqual(err.message, 'The server is currently busy.');
      assert.strictEqual(err.status, 400);
      assert.strictEqual(err.code, 'server_busy');
      return true;
    }
  );

  // Case B: payload.code with fallback message
  const fakeFetch2 = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ code: 'unknown_code', message: 'Server internal' })
  });
  const api2 = createApiRequest({ errorMessages, fetchImpl: fakeFetch2 });
  await assert.rejects(
    async () => api2('/api/test'),
    (err) => {
      assert.strictEqual(err.message, 'Server internal');
      assert.strictEqual(err.status, 500);
      assert.strictEqual(err.code, 'unknown_code');
      return true;
    }
  );

  // Case C: payload is not JSON (HTML error)
  const fakeFetch3 = async () => ({
    ok: false,
    status: 502,
    json: async () => { throw new SyntaxError('Bad gateway'); }
  });
  const api3 = createApiRequest({ errorMessages, fetchImpl: fakeFetch3 });
  await assert.rejects(
    async () => api3('/api/test'),
    (err) => {
      assert.strictEqual(err.message, 'Request failed (502).');
      assert.strictEqual(err.status, 502);
      return true;
    }
  );
});

test('401 triggers onUnauthorized except when sessionRequest is true', async () => {
  let unauthorizedCalls = 0;
  const onUnauthorized = () => { unauthorizedCalls++; };

  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Unauthorized' })
  });

  const api = createApiRequest({ onUnauthorized, fetchImpl: fakeFetch });

  // Normal request: should call onUnauthorized
  await assert.rejects(
    async () => api('/api/profile'),
    (err) => err.status === 401
  );
  assert.strictEqual(unauthorizedCalls, 1);

  // sessionRequest: true: should NOT call onUnauthorized
  await assert.rejects(
    async () => api('/api/session', { sessionRequest: true }),
    (err) => err.status === 401
  );
  assert.strictEqual(unauthorizedCalls, 1);
});

test('converts network TypeError to friendly connection error', async () => {
  const fakeFetch = async () => {
    throw new TypeError('fetch failed');
  };

  const api = createApiRequest({ fetchImpl: fakeFetch });
  await assert.rejects(
    async () => api('/api/mail'),
    (err) => {
      assert.strictEqual(
        err.message,
        'Cannot reach your homeserver. Check your internet and Tailscale connection, then try again.'
      );
      return true;
    }
  );
});

test('malformed JSON on 200 throws friendly reload error', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); }
  });

  const api = createApiRequest({ fetchImpl: fakeFetch });
  await assert.rejects(
    async () => api('/api/broken'),
    (err) => {
      assert.strictEqual(
        err.message,
        'The server returned an unexpected response. Please reload MailHarbor.'
      );
      return true;
    }
  );
});

test('already aborted signal rejects AbortError immediately with no fetch and no listeners', async () => {
  let fetchCalled = false;
  const fakeFetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  };

  const tracked = createTrackedSignal();
  tracked.controller.abort();

  const api = createApiRequest({ fetchImpl: fakeFetch });
  await assert.rejects(
    async () => api('/api/test', { signal: tracked.signal }),
    (err) => {
      assert.strictEqual(err.name, 'AbortError');
      return true;
    }
  );

  assert.strictEqual(fetchCalled, false);
  assert.strictEqual(tracked.addedCount, 0);
  assert.strictEqual(tracked.activeCount, 0);
});

test('in-flight abort cancels fetch and rejects AbortError rather than timeout', async () => {
  let underlyingSignal;
  const fakeFetch = async (url, options) => {
    underlyingSignal = options.signal;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const tracked = createTrackedSignal();
  const api = createApiRequest({
    errorMessages: { timeout: 'Timed out' },
    fetchImpl: fakeFetch
  });

  const promise = api('/api/search', { signal: tracked.signal, timeout: 5000 });
  tracked.controller.abort();

  await assert.rejects(
    async () => promise,
    (err) => {
      assert.strictEqual(err.name, 'AbortError');
      assert.notStrictEqual(err.code, 'timeout');
      return true;
    }
  );

  assert.strictEqual(underlyingSignal.aborted, true);
  assert.strictEqual(tracked.activeCount, 0);
});

test('in-flight abort wins when fake fetch ignores abort; late 401 does not trigger onUnauthorized', async () => {
  let unauthorizedCalled = false;
  let resolveLateFetch;

  const fakeFetch = async (url, options) => {
    // Fake fetch that ignores abort signal
    return new Promise((resolve) => {
      resolveLateFetch = () => {
        resolve({
          ok: false,
          status: 401,
          json: async () => ({ error: 'Late 401' })
        });
      };
    });
  };

  const tracked = createTrackedSignal();
  const api = createApiRequest({
    onUnauthorized: () => { unauthorizedCalled = true; },
    fetchImpl: fakeFetch
  });

  const promise = api('/api/search', { signal: tracked.signal });
  // In-flight abort
  tracked.controller.abort();

  // api rejects immediately without waiting for fakeFetch
  await assert.rejects(
    async () => promise,
    (err) => {
      assert.strictEqual(err.name, 'AbortError');
      return true;
    }
  );

  // Now resolve the ignored fetch with 401
  resolveLateFetch();
  // Allow any pending microtasks to run
  await new Promise(r => setTimeout(r, 20));

  assert.strictEqual(unauthorizedCalled, false, 'Late 401 after abort must not call onUnauthorized');
  assert.strictEqual(tracked.activeCount, 0);
});

test('timeout independently aborts and rejects with code timeout', async () => {
  let underlyingSignal;
  const fakeFetch = async (url, options) => {
    underlyingSignal = options.signal;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const errorMessages = {
    timeout: 'Operation timed out custom message.'
  };

  const api = createApiRequest({ errorMessages, fetchImpl: fakeFetch });
  await assert.rejects(
    async () => api('/api/long-task', { timeout: 5 }),
    (err) => {
      assert.strictEqual(err.code, 'timeout');
      assert.strictEqual(err.message, 'Operation timed out custom message.');
      assert.notStrictEqual(err.name, 'AbortError');
      return true;
    }
  );

  assert.strictEqual(underlyingSignal.aborted, true);
});

test('cancelling caller signal while reading response body rejects AbortError', async () => {
  const tracked = createTrackedSignal();
  let jsonReject;

  const fakeFetch = async (url, options) => {
    options.signal.addEventListener('abort', () => {
      if (jsonReject) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        jsonReject(err);
      }
    });

    return {
      ok: true,
      status: 200,
      json: () => new Promise((resolve, reject) => {
        jsonReject = reject;
      })
    };
  };

  const api = createApiRequest({ fetchImpl: fakeFetch });
  const promise = api('/api/big-json', { signal: tracked.signal });

  // Yield to allow fetch to return headers and start reading body
  await new Promise(r => setTimeout(r, 10));
  tracked.controller.abort();

  await assert.rejects(
    async () => promise,
    (err) => {
      assert.strictEqual(err.name, 'AbortError');
      return true;
    }
  );

  assert.strictEqual(tracked.activeCount, 0);
});

test('tracked signal listeners are cleaned on success, failure, abort, and timeout', async () => {
  // 1. Success exit
  {
    const tracked = createTrackedSignal();
    const fakeFetch = async () => ({ ok: true, json: async () => ({}) });
    const api = createApiRequest({ fetchImpl: fakeFetch });
    await api('/api/test', { signal: tracked.signal });
    assert.strictEqual(tracked.addedCount, 1);
    assert.strictEqual(tracked.activeCount, 0);
  }

  // 2. Server failure exit (400)
  {
    const tracked = createTrackedSignal();
    const fakeFetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
    const api = createApiRequest({ fetchImpl: fakeFetch });
    await assert.rejects(() => api('/api/test', { signal: tracked.signal }));
    assert.strictEqual(tracked.addedCount, 1);
    assert.strictEqual(tracked.activeCount, 0);
  }

  // 3. Network TypeError failure exit
  {
    const tracked = createTrackedSignal();
    const fakeFetch = async () => { throw new TypeError('Network error'); };
    const api = createApiRequest({ fetchImpl: fakeFetch });
    await assert.rejects(() => api('/api/test', { signal: tracked.signal }));
    assert.strictEqual(tracked.addedCount, 1);
    assert.strictEqual(tracked.activeCount, 0);
  }

  // 4. Abort exit
  {
    const tracked = createTrackedSignal();
    const fakeFetch = async () => new Promise(() => {});
    const api = createApiRequest({ fetchImpl: fakeFetch });
    const p = api('/api/test', { signal: tracked.signal });
    tracked.controller.abort();
    await assert.rejects(() => p);
    assert.strictEqual(tracked.addedCount, 1);
    assert.strictEqual(tracked.activeCount, 0);
  }

  // 5. Timeout exit
  {
    const tracked = createTrackedSignal();
    const fakeFetch = async () => new Promise(() => {});
    const api = createApiRequest({ fetchImpl: fakeFetch });
    await assert.rejects(() => api('/api/test', { signal: tracked.signal, timeout: 5 }));
    assert.strictEqual(tracked.addedCount, 1);
    assert.strictEqual(tracked.activeCount, 0);
  }
});

test('supports large timeouts expected by callers (130000, 190000)', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  const api = createApiRequest({ fetchImpl: fakeFetch });

  const res1 = await api('/api/slow-1', { timeout: 130000 });
  assert.deepStrictEqual(res1, { ok: true });

  const res2 = await api('/api/slow-2', { timeout: 190000 });
  assert.deepStrictEqual(res2, { ok: true });
});
