function toAbortError(reason) {
  if (reason instanceof Error) {
    if (reason.name !== 'AbortError') {
      try {
        reason.name = 'AbortError';
      } catch {}
    }
    return reason;
  }
  const message = typeof reason === 'string' ? reason : 'This operation was aborted';
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function createApiRequest({getCsrf, onUnauthorized, errorMessages, fetchImpl = globalThis.fetch} = {}) {
  return async function api(path, {method = 'GET', body, timeout = 35000, sessionRequest = false, responseType = 'json', signal} = {}) {
    if (signal?.aborted) {
      throw toAbortError(signal.reason);
    }

    const controller = new AbortController();
    const effectiveTimeout = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : 35000;

    let winner = null; // 'caller' | 'timeout' | 'request'
    let cancelReject;
    const cancelPromise = new Promise((_, reject) => {
      cancelReject = reject;
    });

    function onCallerAbort() {
      if (winner) return;
      winner = 'caller';
      controller.abort(signal?.reason);
      cancelReject(toAbortError(signal?.reason));
    }

    function onTimeout() {
      if (winner) return;
      winner = 'timeout';
      controller.abort();
      const timeoutMsg = errorMessages?.timeout || 'The connection took too long. The server may still be working; refresh its status before retrying.';
      const timeoutErr = new Error(timeoutMsg);
      timeoutErr.code = 'timeout';
      cancelReject(timeoutErr);
    }

    if (signal) {
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const timer = setTimeout(onTimeout, effectiveTimeout);

    const headers = {Accept: responseType === 'blob' ? 'application/octet-stream' : 'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && !sessionRequest) {
      const csrf = typeof getCsrf === 'function' ? getCsrf() : getCsrf;
      if (csrf) headers['X-MailHarbor-CSRF'] = csrf;
    }

    async function executeRequest() {
      try {
        const response = await fetchImpl(path, {
          method,
          headers,
          credentials: 'same-origin',
          cache: 'no-store',
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });

        if (response.ok && responseType === 'blob') {
          return await response.blob();
        }

        const payload = await response.json().catch(err => {
          if (err?.name === 'AbortError') throw err;
          return null;
        });

        if (!response.ok) {
          const detail = payload?.error;
          const code = typeof detail === 'object' ? detail?.code : payload?.code || detail;
          const error = new Error(
            errorMessages?.[code] ||
            (typeof detail === 'object' ? detail?.message : payload?.message) ||
            `Request failed (${response.status}).`
          );
          error.status = response.status;
          error.code = code;
          if (response.status === 401 && !sessionRequest) {
            if (!winner) {
              onUnauthorized?.();
            }
          }
          throw error;
        }

        if (payload === null) {
          throw new Error('The server returned an unexpected response. Please reload MailHarbor.');
        }

        return payload;
      } catch (error) {
        if (error.name === 'AbortError') {
          if (winner === 'caller' || signal?.aborted) {
            throw toAbortError(signal?.reason);
          }
          const timeoutMsg = errorMessages?.timeout || 'The connection took too long. The server may still be working; refresh its status before retrying.';
          const timedOut = new Error(timeoutMsg);
          timedOut.code = 'timeout';
          throw timedOut;
        }
        if (error instanceof TypeError) {
          throw new Error('Cannot reach your homeserver. Check your internet and Tailscale connection, then try again.');
        }
        throw error;
      }
    }

    const requestPromise = executeRequest();
    requestPromise.catch(() => {});

    try {
      const result = await Promise.race([requestPromise, cancelPromise]);
      winner = 'request';
      return result;
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onCallerAbort);
      }
    }
  };
}
