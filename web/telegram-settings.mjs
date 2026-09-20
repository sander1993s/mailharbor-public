const make = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const dateText = value => {
  if (value === null || value === undefined || value === '') return 'Not yet';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Not yet';
};
const reasonText = value => String(value || 'Needs review').replace(/[_-]+/g, ' ').slice(0, 160);
const errorText = code => ({
  telegram_authentication_failed: 'The bot token needs attention.',
  telegram_configuration_error: 'Check the bot token and the numeric ID of your private chat.',
  telegram_not_configured: 'Save valid bot credentials and a private chat before enabling notifications.',
  telegram_forbidden: 'The bot cannot send to this chat. Open the bot in Telegram and check its access.',
  telegram_rate_limited: 'Telegram has asked us to wait before retrying.',
  telegram_unavailable: 'Telegram did not confirm delivery. A retry may create a duplicate.',
  telegram_rejected: 'Telegram rejected this delivery. Check the saved destination.',
  telegram_destination_changed: 'The destination changed. Earlier work needs review.',
  destination_changed: 'The destination changed. Earlier work needs review.',
  reconciliation_required: 'The mailbox changed. Review recovery before continuing.',
  agy_unavailable: 'Agy is unavailable. Inquiries remain here until they can be checked.'
}[code] || 'Notifications need attention. MailHarbor will keep uncertain messages here.');

/** Independent Settings panel: opening it only reads status, never sends a Telegram message. */
export function createTelegramSettings({ api, describeError, pollInterval = 30000 } = {}) {
  let panel = null, controls = null, status = null, timer = null, observer = null, ownerDocument = null;
  let epoch = 0, active = false, loading = false, acting = false, request = null;
  let languageDirty = false, accountDirty = false, trustDirty = false, message = '', failed = false;
  const visibilityChanged = () => reconcile();

  function visible() {
    if (!panel?.open || panel.isConnected === false || document.visibilityState === 'hidden') return false;
    for (let node = panel; node; node = node.parentNode) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
      if (node !== panel && String(node.tagName).toLowerCase() === 'details' && !node.open) return false;
    }
    return true;
  }
  function clearSecrets() { if (controls) { controls.token.value = ''; controls.chat.value = ''; } }
  function stop() {
    active = false; epoch++; clearTimeout(timer); timer = null;
    request?.abort(); request = null; loading = false; acting = false;
    clearSecrets();
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (active && visible()) { timer = setTimeout(() => void refresh(), pollInterval); timer.unref?.(); }
  }
  function reconcile() {
    if (!visible()) { if (active) { stop(); update(); } return; }
    if (!active) { active = true; void refresh(); }
  }
  function watch() {
    observer?.disconnect();
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(visibilityChanged);
      for (let node = panel?.parentNode; node && node.nodeType !== 9; node = node.parentNode) {
        observer.observe(node, { attributes: true, attributeFilter: ['hidden', 'open', 'aria-hidden', 'style', 'class'] });
      }
    }
  }
  function safeError(error) {
    let result = String(describeError?.(error) || 'The notification request could not be completed. Refresh the status before retrying.');
    for (const value of [controls?.token.value, controls?.chat.value]) if (value) result = result.split(value).join('[redacted]');
    return result.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]').slice(0, 400);
  }
  function accept(value) {
    if (!value || typeof value.enabled !== 'boolean' || typeof value.configured !== 'boolean') throw new Error('Invalid notification status');
    status = value;
    if (!languageDirty) controls.language.value = value.language === 'en' ? 'en' : 'nl-BE';
    if (!accountDirty) {
      controls.account.replaceChildren();
      const empty = make('option', 'Select a connected mailbox'); empty.value = ''; controls.account.append(empty);
      const accounts = Array.isArray(value.availableAccounts) ? value.availableAccounts : value.accountId ? [{ id: value.accountId, label: value.accountId }] : [];
      for (const account of accounts) {
        const option = make('option', account.label || account.email || account.id); option.value = account.id; controls.account.append(option);
      }
      controls.account.value = value.accountId || '';
    }
    if (!trustDirty) {
      controls.trustEnabled.checked = Boolean(value.formTrust);
      for (const [key, input] of Object.entries(controls.trustFields)) input.value = key === 'trustedRelayHosts'
        ? (value.formTrust?.[key] || []).join(', ') : value.formTrust?.[key] || '';
    }
  }
  async function refresh() {
    if (!active || !visible() || loading || acting) { schedule(); return; }
    const version = epoch, controller = new AbortController(); request = controller; loading = true; update();
    try {
      const value = await api('/api/mail/telegram', { method: 'GET', signal: controller.signal });
      if (version !== epoch || !active) return;
      accept(value);
      if (failed) { message = ''; failed = false; }
    } catch (error) {
      if (version === epoch && error?.name !== 'AbortError') { message = safeError(error); failed = true; }
    } finally {
      if (version === epoch) { loading = false; request = null; update(); schedule(); }
    }
  }
  async function action(path, body, success) {
    if (!active || !visible() || acting || loading) return;
    const version = epoch, controller = new AbortController();
    request = controller; acting = true; message = ''; failed = false; clearTimeout(timer); update();
    try {
      await api(`/api/mail/telegram${path}`, { method: 'POST', body, timeout: 190000, signal: controller.signal });
      if (version !== epoch || !active) return;
      clearSecrets(); languageDirty = false; accountDirty = false; trustDirty = false; message = success;
      const value = await api('/api/mail/telegram', { method: 'GET', signal: controller.signal });
      if (version === epoch && active) accept(value);
    } catch (error) {
      if (version === epoch && error?.name !== 'AbortError') { message = safeError(error); failed = true; }
    } finally {
      if (version === epoch) { clearSecrets(); acting = false; request = null; update(); schedule(); }
    }
  }
  function update() {
    if (!controls) return;
    const busy = acting || loading, saved = status?.configured === true, changedDestination = Boolean(controls.token.value.trim() || controls.chat.value.trim() || accountDirty || trustDirty);
    controls.mode.textContent = !status ? (loading ? 'Loading notification settings…' : 'Open this section to load settings.')
      : status.enabled ? 'Inquiry notifications enabled' : 'Inquiry notifications paused';
    controls.destination.textContent = saved
      ? `Private destination: ${String(status.destinationLabel || 'Telegram chat').slice(0, 100)} ${String(status.chatIdMasked || '').slice(0, 40)}. ${status.verified ? 'Verified.' : 'Enter and save the credentials to verify this destination.'}`
      : 'No Telegram destination configured.';
    controls.enable.textContent = status?.enabled ? 'Pause inquiry notifications' : 'Enable inquiry notifications';
    controls.enable.disabled = busy || !status || (!status.enabled && (!saved || !status.verified || !status.accountId || changedDestination));
    controls.save.disabled = busy || !status;
    controls.test.disabled = busy || !saved || !status?.verified || !status.accountId || changedDestination;
    controls.refresh.disabled = busy;
    controls.token.disabled = acting; controls.chat.disabled = acting; controls.language.disabled = acting; controls.account.disabled = acting; controls.trustEnabled.disabled = acting;
    for (const input of Object.values(controls.trustFields)) input.disabled = acting || !controls.trustEnabled.checked;
    controls.feedback.textContent = message; controls.feedback.hidden = !message;
    controls.feedback.className = `fineprint${failed ? ' error' : ''}`;
    controls.testHint.textContent = changedDestination ? 'Save the changed settings before sending a test.' : 'This button sends one clearly labeled test message to the saved private chat.';
    const counts = status?.counts || {};
    for (const [key, node] of Object.entries(controls.counts)) node.textContent = String(Number.isSafeInteger(counts[key]) && counts[key] >= 0 ? counts[key] : 0);
    controls.activity.textContent = `Last scan: ${dateText(status?.lastScanAt)}. Last delivery: ${dateText(status?.lastDeliveryAt)}.${status?.busy ? ' Processing new arrivals.' : ''}`;
    controls.fault.textContent = status?.error ? `${errorText(status.error.code)}${status.error.retryAt ? ` Next retry: ${dateText(status.error.retryAt)}.` : ''}` : '';
    controls.fault.hidden = !status?.error;
    controls.recovery.textContent = status?.recovery ? 'Recovery needs review. MailHarbor has kept the mailbox cursor and pending work; it will not replay historical mail automatically.' : '';
    controls.recovery.hidden = !status?.recovery;
    controls.review.replaceChildren();
    const review = Array.isArray(status?.review) ? status.review.slice(0, 50) : [];
    if (!review.length) controls.review.append(make('li', 'No held inquiries to review.', 'fineprint'));
    for (const entry of review) {
      const row = make('li', undefined, 'telegram-review-item');
      row.append(make('strong', String(entry.subject || '(No subject)').slice(0, 250)),
        make('span', `${String(entry.author || 'Unknown sender').slice(0, 180)} · ${dateText(entry.receivedAt ?? entry.date)}`, 'fineprint'),
        make('p', reasonText(entry.reason), 'fineprint'));
      const retry = make('button', 'Reevaluate', 'subtle'); retry.type = 'button';
      retry.disabled = busy || !entry.id || /destination|generation|stale/i.test(String(entry.reason || ''));
      const version = epoch, id = entry.id;
      retry.addEventListener('click', () => {
        if (version !== epoch || retry.disabled) return;
        void action('/retry', { id }, 'The inquiry is queued for another eligibility check. It will notify only if it qualifies.');
      });
      row.append(retry); controls.review.append(row);
    }
  }
  function build() {
    panel = make('details', undefined, 'mail-tools-details telegram-settings');
    ownerDocument = document;
    const currentPanel = panel, current = () => panel === currentPanel;
    panel.append(make('summary', 'Business inquiries on Telegram'));
    panel.addEventListener('toggle', () => { if (current()) reconcile(); });
    const content = make('div', undefined, 'telegram-settings-content');
    content.append(make('p', 'Receive direct business inquiries and verified website contact-form submissions from your selected mailbox. Routine mail, newsletters, promotions and uncertain messages stay silent.', 'fineprint'),
      make('p', 'When enabled, bounded email text is sent to Google through Agy to decide whether it is an inquiry and summarize it. Only qualifying summaries are sent to your private Telegram chat.', 'fineprint'));
    const mode = make('p', '', 'telegram-mode'), destination = make('p', '', 'fineprint');
    const form = make('form', undefined, 'mail-tools-grid');
    const accountLabel = make('label', 'Mailbox'), account = make('select'); account.setAttribute('aria-label', 'Notification mailbox');
    account.addEventListener('change', () => { if (current()) { accountDirty = true; update(); } }); accountLabel.append(account);
    const languageLabel = make('label', 'Summary language'), language = make('select'); language.setAttribute('aria-label', 'Summary language');
    for (const [value, label] of [['nl-BE', 'Nederlands (België)'], ['en', 'English']]) { const option = make('option', label); option.value = value; language.append(option); }
    language.value = 'en'; language.addEventListener('change', () => { if (current()) languageDirty = true; }); languageLabel.append(language);
    const secretField = (label, type, maxLength) => {
      const wrapper = make('label', label), input = make('input'); input.type = type; input.maxLength = maxLength;
      input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-label', label);
      input.placeholder = 'Leave blank to keep saved value'; input.addEventListener('input', update); wrapper.append(input); return { wrapper, input };
    };
    const token = secretField('New bot token', 'password', 256), chat = secretField('New private chat ID', 'text', 19);
    chat.input.inputMode = 'numeric';
    const save = make('button', 'Save Telegram settings'); save.type = 'submit';
    const trustPanel = make('details'), trustSummary = make('summary', 'Website form verification (optional)');
    const trustLabel = make('label', 'Verify a configured website form'), trustEnabled = make('input'); trustEnabled.type = 'checkbox';
    trustEnabled.setAttribute('aria-label', 'Verify a configured website form'); trustLabel.append(trustEnabled);
    const trustFields = {};
    const trustFieldsList = [['subject', 'Exact form subject'], ['sender', 'Form sender email'], ['envelopeDomain', 'SPF envelope domain'],
      ['mailboxHost', 'Receiving mail server'], ['trustedRelayHosts', 'Trusted relay hosts (comma separated)'],
      ['relayAlias', 'Relay alias (optional)'], ['relayAddress', 'Relay IP address (with alias)']];
    trustPanel.append(trustSummary, make('p', 'Forms stay held until you configure and verify the delivery route from your mailbox provider. Sender and subject alone do not establish trust.', 'fineprint'), trustLabel);
    for (const [key, label] of trustFieldsList) {
      const wrapper = make('label', label), input = make('input'); input.type = 'text'; input.maxLength = key === 'trustedRelayHosts' ? 5000 : 500;
      input.setAttribute('aria-label', label); input.autocomplete = 'off'; input.spellcheck = false;
      input.addEventListener('input', () => { if (current()) { trustDirty = true; update(); } });
      wrapper.append(input); trustPanel.append(wrapper); trustFields[key] = input;
    }
    trustEnabled.addEventListener('change', () => { if (current()) { trustDirty = true; update(); } });
    form.append(accountLabel, languageLabel, token.wrapper, chat.wrapper, trustPanel, save);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!current() || save.disabled) return;
      const body = { language: language.value === 'en' ? 'en' : 'nl-BE' };
      if (accountDirty || (!status.accountId && account.value)) body.accountId = account.value;
      if (trustDirty) {
        body.formTrust = trustEnabled.checked ? Object.fromEntries(Object.entries(trustFields).map(([key, input]) =>
          [key, key === 'trustedRelayHosts' ? input.value.split(',').map(value => value.trim()).filter(Boolean) : input.value.trim()])) : null;
      }
      if (token.input.value.trim()) body.token = token.input.value.trim();
      if (chat.input.value.trim()) {
        if (!/^[1-9]\d{0,18}$/.test(chat.input.value.trim())) { message = 'Enter the numeric ID of your private Telegram chat.'; failed = true; update(); return; }
        body.chatId = chat.input.value.trim();
      }
      void action('', body, 'Telegram settings saved. Saving settings does not send a message.');
    });
    const actions = make('div', undefined, 'mail-tools-row');
    const enable = make('button', 'Enable inquiry notifications', 'subtle'), test = make('button', 'Send a Telegram test', 'subtle'), refreshButton = make('button', 'Refresh Telegram status', 'subtle');
    for (const node of [enable, test, refreshButton]) node.type = 'button';
    enable.addEventListener('click', () => { if (current() && !enable.disabled) void action('', { enabled: !status.enabled }, status.enabled ? 'Inquiry notifications paused. Pending work is kept.' : 'Inquiry notifications enabled. Saved pending inquiries resume.'); });
    test.addEventListener('click', () => { if (current() && !test.disabled) void action('/test', {}, 'Test message sent. Check your private Telegram chat.'); });
    refreshButton.addEventListener('click', () => { if (current() && !refreshButton.disabled) { message = ''; failed = false; void refresh(); } });
    actions.append(enable, test, refreshButton);
    const testHint = make('p', '', 'fineprint'), feedback = make('p', '', 'fineprint'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    const countList = make('dl', undefined, 'telegram-counts'), counts = {};
    for (const [key, label] of [['pending', 'Pending'], ['eligible', 'Eligible'], ['skipped', 'Skipped'], ['held', 'Held'], ['sent', 'Sent']]) {
      const item = make('div'); counts[key] = make('dd', '0'); item.append(make('dt', label), counts[key]); countList.append(item);
    }
    const activity = make('p', '', 'fineprint'), fault = make('p', '', 'fineprint error'), recovery = make('p', '', 'fineprint error'), review = make('ul', undefined, 'telegram-review');
    content.append(mode, destination, form, actions, testHint, feedback,
      make('p', 'Pause keeps the cursor and pending work. Resume checks arrivals since the saved cursor. Changing the destination holds earlier pending work for review.', 'fineprint'),
      countList, activity, fault, recovery, make('h4', 'Held inquiries'), review);
    panel.append(content);
    controls = { mode, destination, language, account, trustEnabled, trustFields, token: token.input, chat: chat.input, save, enable, test, refresh: refreshButton, testHint, feedback, counts, activity, fault, recovery, review };
    document.addEventListener?.('visibilitychange', visibilityChanged); update();
  }
  return {
    render(container) {
      if (!panel) build();
      container.append(panel); watch(); reconcile();
    },
    reset() {
      stop(); observer?.disconnect(); observer = null;
      ownerDocument?.removeEventListener?.('visibilitychange', visibilityChanged); ownerDocument = null;
      panel?.remove?.(); panel = null; controls = null; status = null; languageDirty = false; accountDirty = false; trustDirty = false; message = ''; failed = false;
    }
  };
}
