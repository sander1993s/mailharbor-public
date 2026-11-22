const make = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

const usdText = (value, decimals = 4) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '$0.00';
  return `$${num.toFixed(decimals)}`;
};

const capText = value => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '$12.00';
  return `$${num.toFixed(2)}`;
};

const countText = value => (Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '0');

export function createGeminiSettingsView({ root, api, describeError, onChanged } = {}) {
  if (!root) return { show() {}, hide() {}, reset() {}, refresh() {} };
  let shown = false, active = false, epoch = 0, status = null, request = null;
  let loading = false, acting = false, dirty = false, message = '', failed = false;

  const header = make('div', undefined, 'section-top');
  const eyebrow = make('span', 'FAST LOW-COST AI ENGINE', 'eyebrow');
  const badge = make('span', 'CHECKING…', 'small-badge');
  header.append(eyebrow, badge);

  const heading = make('h2', 'Direct Gemini API & Spend Cap');
  heading.id = 'gemini-settings-title';

  const intro = make('p',
    'Process up to 35 emails per batch over HTTPS using Gemini 3.5 Flash-Lite without CLI startup overhead (~$9.80 total for your remaining backlog). MailHarbor enforces a strict pre-flight USD spend cap and pauses automatically before exceeding your budget.',
    'fineprint'
  );

  const meterCard = make('div', undefined, 'gemini-budget-card');
  const meterTop = make('div', undefined, 'gemini-budget-top');
  const spendSummary = make('strong', '$0.0000 spent of $12.00 cap');
  const remainingSummary = make('span', '$12.0000 remaining', 'fineprint');
  meterTop.append(spendSummary, remainingSummary);

  const meterTrack = make('div', undefined, 'gemini-budget-track');
  meterTrack.setAttribute('role', 'progressbar');
  meterTrack.setAttribute('aria-valuemin', '0');
  meterTrack.setAttribute('aria-valuemax', '100');
  meterTrack.setAttribute('aria-valuenow', '0');
  meterTrack.setAttribute('aria-label', 'Gemini API budget usage');
  const meterFill = make('div', undefined, 'gemini-budget-fill');
  meterTrack.append(meterFill);

  const usageStats = make('p', '0 requests · 0 input tokens · 0 output tokens', 'fineprint gemini-usage-stats');
  meterCard.append(meterTop, meterTrack, usageStats);

  const form = make('form', undefined, 'gemini-settings-form');

  const enableLabel = make('label', undefined, 'gemini-toggle-row');
  const enableInput = make('input');
  enableInput.type = 'checkbox';
  const enableText = make('span', 'Enable Direct Gemini API for mail organization & briefings');
  enableLabel.append(enableInput, enableText);

  const grid = make('div', undefined, 'gemini-fields-grid');

  const modelField = make('label', undefined, 'field');
  modelField.append(make('span', 'AI model'));
  const modelSelect = make('select');
  modelSelect.setAttribute('aria-label', 'Gemini model');
  modelField.append(modelSelect);

  const capField = make('div', undefined, 'field');
  const capLabel = make('label', undefined, 'field');
  capLabel.append(make('span', 'Hard spend cap (USD)'));
  const capInput = make('input');
  capInput.type = 'number';
  capInput.min = '0.5';
  capInput.max = '100';
  capInput.step = '0.5';
  capInput.value = '12';
  capInput.required = true;
  capInput.setAttribute('aria-label', 'Hard spend cap in USD');
  capLabel.append(capInput);

  const capPresets = make('div', undefined, 'gemini-cap-presets');
  for (const preset of [5, 10, 12]) {
    const btn = make('button', `$${preset} max`, 'subtle gemini-preset-btn');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      capInput.value = String(preset);
      dirty = true;
      update();
    });
    capPresets.append(btn);
  }
  capField.append(capLabel, capPresets);
  grid.append(modelField, capField);

  const keyField = make('label', undefined, 'field');
  const keyCaption = make('span', 'Gemini API key (Google AI Studio)');
  const keyInput = make('input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'new-password';
  keyInput.spellcheck = false;
  keyInput.maxLength = 256;
  keyInput.placeholder = 'Paste API key from aistudio.google.com';
  keyField.append(keyCaption, keyInput, make('small', 'Encrypted at rest on your homeserver. Never exposed to browser storage or logs.'));

  const actions = make('div', undefined, 'gemini-settings-actions');
  const saveBtn = make('button', 'Save Gemini settings', 'primary');
  saveBtn.type = 'submit';
  const testBtn = make('button', 'Test connection', 'subtle');
  testBtn.type = 'button';
  const resetSpendBtn = make('button', 'Reset spend counter', 'subtle');
  resetSpendBtn.type = 'button';
  const clearKeyBtn = make('button', 'Remove API key', 'danger');
  clearKeyBtn.type = 'button';
  actions.append(saveBtn, testBtn, resetSpendBtn, clearKeyBtn);

  const feedback = make('p', '', 'feedback');
  feedback.hidden = true;
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');

  form.append(enableLabel, grid, keyField, actions, feedback);
  root.replaceChildren(header, heading, intro, meterCard, form);

  function visible() {
    if (!shown || document.visibilityState === 'hidden' || root.isConnected === false) return false;
    for (let node = root; node; node = node.parentNode) if (node.hidden) return false;
    return true;
  }

  function safeErrorText(error) {
    if (error?.code === 'quota_exhausted') {
      return status?.budgetReached
        ? 'The configured USD spend cap has been reached. Raise the cap or reset the spend counter to continue.'
        : 'Gemini API rate limit or quota reached. Wait a minute and try again.';
    }
    if (error?.code === 'login_required') return 'Enter a valid Gemini API key before testing or enabling Direct API.';
    if (error?.code === 'invalid_request') return 'Check the API key format and ensure the spend cap is between $0.50 and $100.00.';
    let text = String(describeError?.(error) || 'Could not update Gemini API settings.');
    if (keyInput.value) text = text.split(keyInput.value).join('[redacted]');
    return text.slice(0, 320);
  }

  function populateModels(models, selected) {
    const list = Array.isArray(models) && models.length ? models : [
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite ($0.30 / $2.50 per 1M · Newest Flash-Lite · ~$9.80 for remaining backlog)' },
      { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite Latest (Auto-tracks newest Google Flash-Lite)' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite ($0.25 / $1.50 per 1M · ~$8 for remaining backlog)' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite ($0.10 / $0.40 per 1M · ~$4 for remaining backlog)' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash ($0.30 / $2.50 per 1M)' }
    ];
    modelSelect.replaceChildren();
    for (const item of list) {
      const opt = make('option', item.label || item.id);
      opt.value = item.id;
      modelSelect.append(opt);
    }
    if (selected && list.some(item => item.id === selected)) modelSelect.value = selected;
  }

  function accept(value) {
    if (!value || typeof value.enabled !== 'boolean') throw new Error('Invalid Gemini status');
    status = value;
    if (!dirty) {
      populateModels(value.models, value.model);
      enableInput.checked = value.enabled;
      capInput.value = String(value.maxSpendUsd ?? 12);
    }
  }

  function update() {
    const busy = loading || acting;
    if (!modelSelect.options.length) populateModels(status?.models, status?.model);
    const configured = Boolean(status?.configured);
    const enabled = Boolean(status?.enabled);
    const budgetReached = Boolean(status?.budgetReached);

    if (!status) {
      badge.textContent = loading ? 'LOADING…' : 'FALLBACK: AGY CLI';
      badge.className = 'small-badge';
    } else if (enabled && budgetReached) {
      badge.textContent = 'CAP REACHED · PAUSED';
      badge.className = 'small-badge badge-warning';
    } else if (enabled && configured) {
      badge.textContent = 'DIRECT API ACTIVE';
      badge.className = 'small-badge badge-active';
    } else if (configured) {
      badge.textContent = 'KEY SAVED · PAUSED';
      badge.className = 'small-badge';
    } else {
      badge.textContent = 'USING AGY CLI';
      badge.className = 'small-badge';
    }

    const spent = Number(status?.spentUsd ?? 0);
    const cap = Math.max(0.5, Number(status?.maxSpendUsd ?? 12));
    const remaining = Math.max(0, Number(status?.remainingUsd ?? cap));
    const pct = Math.min(100, Math.max(0, Math.round((spent / cap) * 100)));

    spendSummary.textContent = `${usdText(spent)} spent of ${capText(cap)} hard cap`;
    remainingSummary.textContent = budgetReached ? 'Hard spend cap reached — AI paused' : `${usdText(remaining)} remaining`;
    meterTrack.setAttribute('aria-valuenow', String(pct));
    meterFill.style.width = `${pct}%`;
    meterFill.className = `gemini-budget-fill${budgetReached ? ' danger' : pct >= 80 ? ' warn' : ''}`;

    usageStats.textContent = `${countText(status?.requests)} requests · ${countText(status?.inputTokens)} input tokens · ${countText(status?.outputTokens)} output tokens${status?.cachedTokens ? ` (${countText(status.cachedTokens)} cached)` : ''}`;

    keyCaption.textContent = configured ? 'Replace saved Gemini API key (optional)' : 'Gemini API key (Google AI Studio)';
    keyInput.placeholder = configured ? 'Saved encrypted key — leave blank to keep current key' : 'Paste API key from aistudio.google.com';

    enableInput.disabled = busy || (!configured && !keyInput.value.trim());
    modelSelect.disabled = busy;
    capInput.disabled = busy;
    keyInput.disabled = busy;
    saveBtn.disabled = busy;
    testBtn.disabled = busy || (!configured && !keyInput.value.trim());
    resetSpendBtn.disabled = busy || !(spent > 0 || Number(status?.requests) > 0);
    clearKeyBtn.hidden = !configured;
    clearKeyBtn.disabled = busy;
    for (const btn of capPresets.querySelectorAll('button')) btn.disabled = busy;

    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.className = `feedback ${failed ? 'error' : 'success'}`;
  }

  async function refresh() {
    if (!active || !visible() || loading || acting) return;
    const version = epoch, controller = new AbortController();
    request = controller;
    loading = true;
    update();
    try {
      const value = await api('/api/gemini', { method: 'GET', signal: controller.signal });
      if (version === epoch && active) {
        accept(value);
        if (failed) { message = ''; failed = false; }
      }
    } catch (error) {
      if (version === epoch && error?.name !== 'AbortError') {
        message = safeErrorText(error);
        failed = true;
      }
    } finally {
      if (version === epoch) {
        loading = false;
        request = null;
        update();
      }
    }
  }

  async function runAction(path, body, successText) {
    if (!active || acting) return;
    request?.abort();
    epoch++;
    loading = false;
    const version = epoch, controller = new AbortController();
    request = controller;
    acting = true;
    message = '';
    failed = false;
    update();
    try {
      const result = await api(path, { method: 'POST', body, signal: controller.signal, timeout: 30000 });
      if (version === epoch && active) {
        dirty = false;
        accept(result.status ?? result);
        message = typeof successText === 'function' ? successText(result) : successText;
        failed = false;
        Promise.resolve().then(() => onChanged?.()).catch(() => {});
      }
    } catch (error) {
      if (version === epoch && error?.name !== 'AbortError') {
        message = safeErrorText(error);
        failed = true;
      }
    } finally {
      if (version === epoch) {
        acting = false;
        request = null;
        update();
      }
    }
  }

  function stop() {
    active = false;
    epoch++;
    request?.abort();
    request = null;
    loading = false;
    acting = false;
    keyInput.value = '';
    update();
  }

  function reconcile() {
    if (!visible()) { if (active) stop(); return; }
    if (!active) { active = true; void refresh(); }
  }

  keyInput.addEventListener('input', () => {
    if (keyInput.value.trim() && !status?.configured) enableInput.checked = true;
    dirty = true;
    update();
  });
  enableInput.addEventListener('change', () => { dirty = true; update(); });
  modelSelect.addEventListener('change', () => { dirty = true; update(); });
  capInput.addEventListener('input', () => { dirty = true; update(); });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const typedKey = keyInput.value.trim();
    keyInput.value = '';
    const cap = Number(capInput.value);
    const payload = {
      enabled: typedKey ? enableInput.checked : (status?.configured ? enableInput.checked : false),
      model: modelSelect.value,
      maxSpendUsd: cap
    };
    if (typedKey) payload.apiKey = typedKey;
    void runAction('/api/gemini', payload, saved =>
      saved.enabled
        ? `Direct Gemini API active (${saved.model}) with ${capText(saved.maxSpendUsd)} hard spend cap.`
        : 'Gemini API settings saved.'
    );
  });

  testBtn.addEventListener('click', () => {
    const typedKey = keyInput.value.trim();
    const payload = { model: modelSelect.value };
    if (typedKey) payload.apiKey = typedKey;
    void runAction('/api/gemini/test', payload, res => `Verified ${res.model} in ${res.latencyMs} ms.`);
  });

  resetSpendBtn.addEventListener('click', () => {
    void runAction('/api/gemini', { resetSpend: true }, 'Spend counter reset to $0.0000.');
  });

  clearKeyBtn.addEventListener('click', () => {
    keyInput.value = '';
    dirty = false;
    void runAction('/api/gemini', { clearKey: true, enabled: false }, 'Removed saved Gemini API key. Reverted to Agy CLI.');
  });

  document.addEventListener('visibilitychange', reconcile);
  populateModels(null, 'gemini-3.5-flash-lite');
  update();

  return {
    show() { shown = true; reconcile(); },
    hide() { shown = false; stop(); },
    reset() { shown = false; dirty = false; status = null; message = ''; failed = false; stop(); },
    refresh() { if (active) void refresh(); }
  };
}
