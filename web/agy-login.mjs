const PENDING = new Set(['starting', 'awaiting_code', 'verifying']);
const STATES = new Set(['idle', ...PENDING, 'connected', 'failed', 'cancelled']);
const make = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

function authorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.port && !url.username && !url.password && !url.hash &&
      /^\/o\/oauth2\/(?:v2\/)?auth$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

// Opening Settings only reads status. A provider login starts with an explicit click.
export function createAgyLoginView({ root, api, onConnected, pollInterval = 1500, maxPolls = 400 } = {}) {
  let shown = false, active = false, epoch = 0, status = null, timer = null, request = null;
  let loading = false, acting = false, polls = 0, message = '', failed = false, notified = false;
  const heading = make('h2', 'AI connection'); heading.id = 'agy-login-title';
  const intro = make('p', 'Reconnect the Google account used for AI briefings and mail organization from this browser or app.', 'fineprint');
  const mode = make('p', '', 'agy-login-status'); mode.setAttribute('role', 'status'); mode.setAttribute('aria-live', 'polite');
  const start = make('button', 'Reconnect AI', 'primary'); start.type = 'button';
  const instructions = make('div', undefined, 'agy-login-instructions');
  const link = make('a', 'Continue with Google ↗'); link.target = '_blank'; link.rel = 'noopener noreferrer';
  const form = make('form', undefined, 'agy-login-form');
  const label = make('label', undefined, 'field'); label.append(make('span', 'Paste authorization code'));
  const code = make('input'); code.type = 'password'; code.autocomplete = 'off'; code.spellcheck = false; code.required = true; code.maxLength = 2048;
  code.setAttribute('aria-label', 'Paste authorization code'); label.append(code);
  const submit = make('button', 'Complete sign-in', 'primary'); submit.type = 'submit'; form.append(label, submit);
  instructions.append(make('p', 'Open Google, sign in with the account you use for Agy, then return here and paste the authorization code.', 'fineprint'), link, form);
  const actions = make('div', undefined, 'agy-login-actions');
  const cancel = make('button', 'Cancel sign-in', 'subtle'); cancel.type = 'button';
  const refreshButton = make('button', 'Refresh AI sign-in status', 'subtle'); refreshButton.type = 'button';
  actions.append(start, cancel, refreshButton);
  const feedback = make('p', '', 'fineprint'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  root.replaceChildren(heading, intro, mode, instructions, actions, feedback,
    make('p', 'Sign-in does not send email content or an AI prompt. Your authorization code is cleared after submission.', 'fineprint'));

  function visible() {
    if (!shown || document.visibilityState === 'hidden' || root.isConnected === false) return false;
    for (let node = root; node; node = node.parentNode) if (node.hidden) return false;
    return true;
  }
  function expired() {
    const deadline = status?.expiresAt && new Date(status.expiresAt).getTime();
    return Number.isFinite(deadline) && deadline <= Date.now();
  }
  function errorText(error) {
    return ({
      quota_exhausted: 'The AI quota is still exhausted. Reconnecting does not reset the provider quota.',
      busy: 'AI is busy. Let the current operation finish, then try again.',
      server_busy: 'AI is busy. Let the current operation finish, then try again.',
      login_busy: 'Another AI sign-in is already running. Refresh its status to continue.',
      login_expired: 'This sign-in expired. Select Retry AI sign-in to start again.',
      login_failed: 'AI sign-in could not be verified. Retry the sign-in. If it keeps failing, check Agy sign-in on the homeserver.',
      login_unavailable: 'Browser sign-in is unavailable on this homeserver. Check its Agy sign-in setup before retrying.',
      configuration_error: 'The homeserver’s Agy setup needs attention before you can reconnect.',
      invalid_request: 'The authorization code was not accepted. Copy the complete code from Google, or cancel and start again.',
      login_required: 'AI sign-in is still required. Retry the sign-in and complete the Google authorization.',
      timeout: 'The connection took too long. Refresh the sign-in status before retrying.',
      csrf: 'Your browser session changed. Reload MailHarbor and try again.',
      csrf_invalid: 'Your browser session changed. Reload MailHarbor and try again.'
    })[error?.code] || 'AI sign-in could not be completed. Refresh its status, or cancel and retry.';
  }
  function update() {
    const pending = PENDING.has(status?.state), busy = acting || loading;
    mode.textContent = !status ? (loading ? 'Loading AI sign-in status…' : 'Open Settings to check AI sign-in.') : ({
      idle: 'Start a new sign-in if your AI connection needs reconnecting.',
      starting: 'Preparing Google sign-in…', awaiting_code: 'Waiting for your Google authorization code.',
      verifying: 'Verifying the AI connection…', connected: 'AI sign-in verified.',
      failed: 'AI sign-in needs another attempt.', cancelled: 'AI sign-in cancelled.'
    })[status.state];
    const url = active && status?.state === 'awaiting_code' && !expired() && authorizationUrl(status.url);
    instructions.hidden = !url;
    if (url) link.href = url; else link.removeAttribute('href');
    start.hidden = pending; start.disabled = busy || !active;
    start.textContent = ['failed', 'cancelled'].includes(status?.state) ? 'Retry AI sign-in' : 'Reconnect AI';
    cancel.hidden = !pending; cancel.disabled = acting || !active;
    refreshButton.disabled = busy || !active;
    code.disabled = acting || !url; submit.disabled = acting || !url;
    feedback.textContent = message || (status?.error ? errorText(status.error) : '');
    feedback.hidden = !feedback.textContent; feedback.className = `fineprint${failed || status?.error ? ' error' : ''}`;
  }
  function stop() {
    active = false; epoch++; clearTimeout(timer); timer = null;
    request?.abort(); request = null; loading = false; acting = false; code.value = '';
    if (status) status = { ...status, url: undefined };
    update();
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (!active || !visible() || !PENDING.has(status?.state)) return;
    if (polls >= maxPolls || expired()) {
      code.value = '';
      message = 'Automatic status checks paused. Refresh the sign-in status, or cancel and retry.';
      update(); return;
    }
    timer = setTimeout(() => { polls++; void refresh(); }, pollInterval); timer.unref?.();
  }
  function accept(value) {
    if (!value || !STATES.has(value.state)) throw new Error('Invalid AI sign-in status');
    if (value.state === 'awaiting_code' && !authorizationUrl(value.url)) throw new Error('Invalid authorization URL');
    status = value;
    if (status.state !== 'awaiting_code') code.value = '';
    message = ''; failed = false;
    if (status.state === 'connected' && !notified) {
      notified = true;
      const version = epoch;
      // The application callback checks the current browser session before updating it.
      Promise.resolve().then(() => version === epoch && active && onConnected?.()).catch(() => {});
    }
  }
  async function refresh() {
    if (!active || !visible() || loading || acting) return;
    const version = epoch, controller = new AbortController(); request = controller; loading = true; update();
    try {
      const value = await api('/api/agy/login', { method: 'GET', signal: controller.signal });
      if (version === epoch && active) accept(value);
    } catch (error) {
      if (version === epoch && error?.name !== 'AbortError') { message = errorText(error); failed = true; }
    } finally {
      if (version === epoch) { loading = false; request = null; update(); schedule(); }
    }
  }
  async function action(method, path, body) {
    if (!active || !visible() || acting) return;
    request?.abort(); epoch++; loading = false;
    const version = epoch, controller = new AbortController(); request = controller;
    acting = true; message = ''; failed = false; polls = 0; clearTimeout(timer); code.value = ''; update();
    try {
      const value = await api(path, { method, ...(body === undefined ? {} : { body }), signal: controller.signal });
      if (version === epoch && active) accept(value);
    } catch (error) {
      if (version === epoch && error?.name !== 'AbortError') { message = errorText(error); failed = true; }
    } finally {
      if (version === epoch) { acting = false; request = null; update(); schedule(); }
    }
  }
  function reconcile() {
    if (!visible()) { if (active) stop(); return; }
    if (!active) { active = true; polls = 0; void refresh(); }
  }
  start.addEventListener('click', () => {
    if (start.disabled || start.hidden) return;
    notified = false; void action('POST', '/api/agy/login', {});
  });
  cancel.addEventListener('click', () => { if (!cancel.disabled && !cancel.hidden) void action('DELETE', '/api/agy/login'); });
  refreshButton.addEventListener('click', () => { if (!refreshButton.disabled) { polls = 0; void refresh(); } });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const value = code.value.trim(); code.value = '';
    if (!value || submit.disabled || instructions.hidden) return;
    void action('POST', '/api/agy/login/code', { code: value });
  });
  document.addEventListener('visibilitychange', reconcile);
  update();
  return {
    show() { shown = true; reconcile(); },
    hide() { shown = false; stop(); },
    reset() { shown = false; stop(); status = null; notified = false; message = ''; failed = false; update(); }
  };
}
