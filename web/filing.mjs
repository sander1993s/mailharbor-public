const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
const STATUS = { filed: 'Filed', duplicate: 'Already filed', needs_review: 'Needs review', waiting_drive: 'Waiting for Drive' };
const REASONS = {
  business_configuration_changed: 'The configured businesses changed. This document will be checked again.',
  document_missing: 'No original invoice attachment was found.',
  document_too_large: 'The original attachment exceeds the filing size limit.',
  document_unavailable: 'The original attachment could not be retrieved.',
  unsupported_document: 'This attachment is not a supported PDF or XML document.',
  unsupported_invoice_xml: 'This XML is not a supported invoice format.',
  document_parse_failed: 'The invoice details could not be read reliably.',
  document_parse_timeout: 'Reading this attachment took too long. It needs another attempt.',
  document_needs_ocr: 'This scanned document needs text recognition before it can be filed.',
  document_page_limit: 'The document has too many pages for automatic invoice reading.',
  document_text_limit: 'The document contains too much text for automatic invoice reading.',
  incomplete_or_invalid_pdf: 'The PDF appears incomplete or damaged.',
  proforma_document: 'This document is a pro forma invoice.',
  order_confirmation_document: 'This document is an order confirmation.',
  payment_request_document: 'This document is a payment request.',
  no_invoice_evidence: 'No invoice details were found in this document.',
  missing_invoice_date: 'The invoice date is missing.',
  invalid_invoice_date: 'The invoice date could not be read reliably.',
  ambiguous_invoice_date: 'More than one possible invoice date was found.',
  missing_received_date: 'The message date is missing.',
  invalid_received_date: 'The message date could not be read reliably.',
  ambiguous_received_date: 'More than one possible message date was found.',
  missing_invoice_number: 'An invoice number was not found.',
  ambiguous_invoice_number: 'More than one possible invoice number was found.',
  insufficient_invoice_evidence: 'There is not enough evidence to identify an invoice.',
  unknown_customer_vat: 'The customer VAT number does not match a configured business.',
  missing_customer_identity: 'The invoice customer could not be identified.',
  ambiguous_customer_identity: 'The invoice could belong to more than one business.',
  ambiguous_customer_context: 'The customer details are unclear.',
  customer_identity_conflict: 'The customer name and VAT details do not agree.',
  customer_vat_match: 'The customer VAT number matches this business.',
  customer_name_match: 'The customer name matches this business.',
  invoice_date_used: 'The folder is based on the invoice date.',
  received_date_used: 'The folder is based on the message date.',
  filing_pending: 'The original invoice is waiting to be saved in Drive.',
  already_filed: 'This original document is already saved in Drive.',
  drive_not_configured: 'Set up Google Drive to file this invoice.',
  drive_login_required: 'Connect your private Google Drive to file this invoice.',
  drive_wrong_account: 'Connect the expected private Google account.',
  drive_error: 'Drive could not verify or save the invoice. It will need another attempt.',
  drive_duplicate_ambiguous: 'More than one matching Drive file was found. Review the existing files.',
  stale_message: 'This message changed or the mailbox was reconnected. Scan again to verify it.',
  mailbox_login_required: 'Reconnect this mailbox before retrieving its invoice.',
  cancelled: 'Processing was stopped before this invoice was filed.'
};
const ERROR_TEXT = {
  drive_not_configured: 'Save the Google app registration below, then connect your private Drive.',
  drive_login_required: 'Connect your private Google Drive again.',
  drive_wrong_account: 'Choose the private Google account shown here when connecting Drive.',
  drive_error: 'Google Drive could not complete this operation. Check its connection and try again.',
  drive_duplicate_ambiguous: 'Multiple matching files were found in Drive. Review them before trying again.'
};
const errorText = (error, describeError) => ERROR_TEXT[error?.code] || describeError?.(error) || 'Could not complete this operation. Please try again.';

export function createFilingView({ root, api, describeError, notify }) {
  if (!root || typeof api !== 'function') throw new TypeError('Invoice filing requires a root element and API.');
  const state = { session: 0, dataRevision: 0, active: false, visible: false, loaded: false, drive: null, invoices: null, busy: '', request: null, timer: null, ownJobId: null, clientDirty: false, entitiesDirty: false };
  const nodes = {};
  const addButton = (parent, text, callback, className = 'subtle') => {
    const button = make('button', text, className); button.type = 'button'; button.addEventListener('click', callback); parent.append(button); return button;
  };
  const field = (parent, labelText, type = 'text') => {
    const label = make('label', undefined, 'field'), input = make('input');
    input.type = type; label.append(make('span', labelText), input); parent.append(label); return input;
  };
  const link = (parent, title, href) => {
    const anchor = make('a', title); anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; parent.append(anchor); return anchor;
  };
  function feedback(text = '', error = false) {
    nodes.feedback.textContent = text; nodes.feedback.hidden = !text; nodes.feedback.className = `feedback${error ? ' error' : ' success'}`;
  }
  function build() {
    root.replaceChildren(); root.classList.add('invoice-filing');
    root.append(make('h2', 'Invoice filing'), make('p', 'Find invoices across your accounts and save the original PDF or XML in your private Google Drive, organized by business and invoice date.'));
    nodes.driveStatus = make('p', 'Loading Drive connection…', 'filing-drive-status'); nodes.driveStatus.setAttribute('role', 'status');
    nodes.oauthFailure = make('p', undefined, 'feedback error'); nodes.oauthFailure.setAttribute('role', 'alert'); nodes.oauthFailure.hidden = true;
    nodes.expected = make('p', undefined, 'fineprint');
    root.append(nodes.driveStatus, nodes.oauthFailure, nodes.expected);
    const connectionActions = make('div', undefined, 'account-actions');
    nodes.connect = addButton(connectionActions, 'Connect private Google Drive', () => connect(), 'primary');
    nodes.disconnect = addButton(connectionActions, 'Disconnect Drive', () => disconnect());
    root.append(connectionActions);

    nodes.registration = make('details', undefined, 'filing-registration'); nodes.registration.append(make('summary', 'Google app registration'));
    nodes.registration.append(make('p', 'Use a Google web application with the Drive API enabled. Add the callback URL below to its authorized redirect URIs.', 'fineprint'));
    const help = make('div', undefined, 'provider-help');
    link(help, 'Google app credentials', 'https://console.cloud.google.com/apis/credentials');
    link(help, 'Google Drive setup guide', 'https://developers.google.com/workspace/drive/api/guides/api-specific-auth');
    nodes.registration.append(help);
    nodes.form = make('form');
    nodes.expectedEmail = field(nodes.form, 'Google Drive account email', 'email'); nodes.expectedEmail.required = true; nodes.expectedEmail.maxLength = 320;
    nodes.expectedEmail.addEventListener('input', () => { state.clientDirty = true; });
    nodes.clientId = field(nodes.form, 'Google client ID'); nodes.clientId.required = true; nodes.clientId.maxLength = 512; nodes.clientId.autocomplete = 'off'; nodes.clientId.spellcheck = false;
    nodes.clientId.addEventListener('input', () => { state.clientDirty = true; });
    nodes.clientSecret = field(nodes.form, 'Google client secret', 'password'); nodes.clientSecret.maxLength = 4096; nodes.clientSecret.autocomplete = 'new-password';
    nodes.form.append(make('p', 'The client secret and Drive tokens are encrypted on your homeserver. Leave the secret blank to keep the saved secret for the same client ID.', 'fineprint'));
    nodes.callback = field(nodes.form, 'Authorized callback URL'); nodes.callback.readOnly = true;
    nodes.copy = addButton(nodes.form, 'Copy callback URL', () => copyCallback());
    nodes.save = make('button', 'Save Google registration', 'primary'); nodes.save.type = 'submit'; nodes.form.append(nodes.save);
    nodes.form.addEventListener('submit', event => { event.preventDefault(); void configure(); });
    nodes.registration.append(nodes.form); root.append(nodes.registration);

    const destinations = make('div', undefined, 'filing-destinations'); destinations.append(make('h3', 'Invoice folders'));
    destinations.append(make('p', 'Add the businesses whose invoices you want to file. Folders use Invoices / business name / year / quarter. The quarter follows the invoice date; unclear documents stay in Needs review.', 'fineprint'));
    nodes.entityRows = make('div'); destinations.append(nodes.entityRows);
    nodes.addEntity = addButton(destinations, 'Add business', () => {
      if (nodes.entityRows.children.length >= 20) return;
      state.entitiesDirty = true; addEntityRow({ id: `business_${crypto.randomUUID().replaceAll('-', '')}`, label: '', vat: '', names: [] });
    });
    nodes.saveEntities = addButton(destinations, 'Save businesses', () => saveEntities(), 'primary');
    root.append(destinations);
    const automation = make('div', undefined, 'filing-automation');
    const toggleLabel = make('label', undefined, 'filing-toggle'); nodes.enabled = make('input'); nodes.enabled.type = 'checkbox';
    toggleLabel.append(nodes.enabled, make('span', 'Automatically find and file new invoices'));
    nodes.enabled.addEventListener('change', () => settings(nodes.enabled.checked));
    nodes.interval = make('p', 'Checks every 20 minutes while automatic filing is enabled.', 'fineprint');
    automation.append(toggleLabel, nodes.interval);
    const actions = make('div', undefined, 'account-actions');
    nodes.scan = addButton(actions, 'Scan latest 1,000 emails', () => scan(), 'primary');
    nodes.refresh = addButton(actions, 'Refresh filing status', () => refresh());
    automation.append(actions); root.append(automation);
    nodes.feedback = make('p', undefined, 'feedback'); nodes.feedback.setAttribute('role', 'status'); nodes.feedback.hidden = true; root.append(nodes.feedback);
    nodes.progress = make('p', 'Invoice filing status will appear here.', 'filing-progress'); nodes.progress.setAttribute('role', 'status'); nodes.progress.setAttribute('aria-live', 'polite'); root.append(nodes.progress);
    nodes.errors = make('p', undefined, 'feedback error'); nodes.errors.hidden = true; root.append(nodes.errors);
    nodes.counts = make('dl', undefined, 'filing-counts'); root.append(nodes.counts);
    nodes.recentDisclosure = make('details', undefined, 'filing-history');
    nodes.recentDisclosure.append(make('summary', 'Recent invoices'));
    nodes.recent = make('div', undefined, 'filing-records'); nodes.recentDisclosure.append(nodes.recent);
    root.append(nodes.recentDisclosure);
  }
  function addEntityRow(entity) {
    const row = make('div', undefined, 'filing-business'); row.dataset.entityId = entity.id;
    const label = field(row, 'Business name'), vat = field(row, 'Customer VAT (optional)'), names = field(row, 'Exact customer names (comma-separated, optional)');
    label.value = entity.label || ''; label.maxLength = 80; vat.value = entity.vat || ''; vat.maxLength = 40; names.value = (entity.names || []).join(', '); names.maxLength = 968;
    row.filingFields = { label, vat, names };
    for (const input of [label, vat, names]) input.addEventListener('input', () => { state.entitiesDirty = true; });
    addButton(row, 'Remove business', () => { state.entitiesDirty = true; row.remove(); });
    nodes.entityRows.append(row);
  }
  function saveEntities() {
    const entities = Array.from(nodes.entityRows.children).map(row => ({ id: row.dataset.entityId, label: row.filingFields.label.value.trim(), vat: row.filingFields.vat.value.trim(), names: row.filingFields.names.value.split(',').map(value => value.trim()).filter(Boolean) }));
    return action('entities', async valid => {
      const value = await api('/api/invoices/settings', { method: 'POST', body: { entities } });
      if (!valid()) return;
      state.invoices = value; state.entitiesDirty = false; feedback('Businesses saved. Invoice matches will use these details.'); render(); await refresh();
    });
  }
  function renderControls() {
    const busy = Boolean(state.busy);
    nodes.connect.disabled = busy || !state.drive?.configured;
    nodes.connect.textContent = state.busy === 'connect' ? 'Opening Google…' : state.drive?.connected ? 'Reconnect private Google Drive' : 'Connect private Google Drive';
    nodes.disconnect.hidden = !state.drive?.connected; nodes.disconnect.disabled = busy;
    nodes.save.disabled = nodes.clientId.disabled = nodes.clientSecret.disabled = nodes.expectedEmail.disabled = busy;
    nodes.save.textContent = state.busy === 'configure' ? 'Saving…' : 'Save Google registration';
    nodes.enabled.disabled = busy || !state.invoices;
    if (state.busy !== 'settings') nodes.enabled.checked = state.invoices?.enabled === true;
    nodes.scan.disabled = busy || !state.invoices || state.invoices.running === true;
    nodes.scan.textContent = state.invoices?.running ? 'Invoice scan running…' : 'Scan latest 1,000 emails';
    nodes.refresh.disabled = Boolean(state.request) || busy;
    nodes.copy.disabled = !nodes.callback.value;
    nodes.addEntity.disabled = nodes.saveEntities.disabled = busy || state.invoices?.running === true;
  }
  function render() {
    const drive = state.drive, invoices = state.invoices;
    const entities = Object.fromEntries((invoices?.entities || []).map(entity => [entity.id, entity.label]));
    if (!state.entitiesDirty) { nodes.entityRows.replaceChildren(); for (const entity of invoices?.entities || []) addEntityRow(entity); }
    nodes.driveStatus.textContent = !drive ? 'Drive connection unavailable.' : drive.connected ? `Connected to ${drive.email || drive.expectedEmail}` : drive.configured ? 'Google Drive is ready to connect.' : 'Google Drive needs its app registration.';
    nodes.oauthFailure.textContent = drive?.oauthFailure ? errorText(drive.oauthFailure, describeError) : ''; nodes.oauthFailure.hidden = !drive?.oauthFailure;
    nodes.expected.textContent = drive?.expectedEmail ? `Private Drive account: ${drive.expectedEmail}. MailHarbor can create and access its invoice files.` : '';
    if (drive) {
      nodes.callback.value = drive.callback || '';
      if (!state.clientDirty) { nodes.clientId.value = drive.clientId || ''; nodes.expectedEmail.value = drive.expectedEmail || ''; }
      if (!state.loaded) nodes.registration.open = !drive.configured;
    }
    nodes.interval.textContent = `Checks every ${Number.isSafeInteger(invoices?.intervalMinutes) ? invoices.intervalMinutes : 20} minutes while automatic filing is enabled.`;
    const job = invoices?.running ? invoices.job : invoices?.lastRun || invoices?.job;
    if (!invoices) nodes.progress.textContent = 'Invoice filing status is unavailable. Refresh to try again.';
    else if (invoices.running) nodes.progress.textContent = `${job?.phase === 'scanning' ? 'Scanning your mailboxes' : 'Reading invoice attachments'} · ${count(job?.scanned)} emails found · ${count(job?.processed)} processed.`;
    else if (job) nodes.progress.textContent = `${job.status === 'failed' ? 'The last scan could not finish' : job.status === 'cancelled' ? 'The last scan was stopped' : 'Last scan complete'} · ${count(job.scanned)} emails checked · ${count(job.filed)} filed · ${count(job.needsReview)} need review${job.scanComplete === false ? ' · some mailboxes could not be fully checked' : ''}.`;
    else nodes.progress.textContent = 'Ready to scan the latest 1,000 emails across your accounts.';
    const errors = Array.isArray(job?.errors) ? job.errors : [];
    nodes.errors.textContent = [...new Set(errors.map(error => errorText(error, describeError)))].join(' '); nodes.errors.hidden = !errors.length;
    nodes.counts.replaceChildren();
    for (const [key, label] of [['filed', 'Filed'], ['duplicates', 'Already filed'], ['needsReview', 'Needs review'], ['waitingDrive', 'Waiting for Drive'], ['notInvoices', 'Not invoices']]) {
      const item = make('div'); item.append(make('dt', label), make('dd', count(invoices?.counts?.[key]))); nodes.counts.append(item);
    }
    nodes.recent.replaceChildren();
    const recent = (Array.isArray(invoices?.recent) ? invoices.recent : []).filter(item => Object.hasOwn(STATUS, item.status)).slice(0, 50);
    if (!recent.length) nodes.recent.append(make('p', 'Invoices found by a scan will appear here, including documents that need review.', 'fineprint'));
    for (const item of recent) {
      const entry = make('article', undefined, 'filing-record');
      const heading = make('div', undefined, 'filing-record-heading');
      heading.append(make('h4', item.filename || item.subject || 'Invoice document'), make('span', STATUS[item.status], `filing-record-state ${item.status}`)); entry.append(heading);
      if (item.subject && item.subject !== item.filename) entry.append(make('p', item.subject, 'filing-record-subject'));
      const details = make('dl', undefined, 'filing-record-details');
      for (const [label, value] of [['Mailbox', item.account], ['Business', entities[item.entity]], ['Invoice date', item.invoiceDate]]) if (value) details.append(make('dt', label), make('dd', String(value)));
      const derived = entities[item.entity] && Number.isSafeInteger(item.year) && Number.isSafeInteger(item.quarter) && item.quarter >= 1 && item.quarter <= 4 ? `Invoices/${entities[item.entity]}/${item.year}/Q${item.quarter}` : '';
      const destination = typeof item.file?.folderPath === 'string' && /^Invoices\/[^/\\\p{Cc}\p{Cf}]{1,80}\/\d{4}\/Q[1-4]$/u.test(item.file.folderPath) ? item.file.folderPath : derived;
      if (destination) details.append(make('dt', 'Drive folder'), make('dd', destination));
      entry.append(details);
      const reasons = (Array.isArray(item.reasons) ? item.reasons : []).map(reason => REASONS[reason]).filter(Boolean);
      if (reasons.length) entry.append(make('p', [...new Set(reasons)].join(' '), 'fineprint'));
      else if (item.status === 'needs_review') entry.append(make('p', 'Check the original document before filing it.', 'fineprint'));
      if (typeof item.file?.fileId === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(item.file.fileId)) link(entry, 'Open invoice in Drive', `https://drive.google.com/file/d/${item.file.fileId}/view`);
      nodes.recent.append(entry);
    }
    renderControls();
  }
  function ownsRunningJob() { return state.ownJobId && state.invoices?.running && state.invoices.job?.id === state.ownJobId; }
  function schedule() {
    clearTimeout(state.timer); state.timer = null;
    if (!state.active || (!ownsRunningJob() && (!state.visible || document.hidden))) return;
    state.timer = setTimeout(() => { state.timer = null; void refresh(); }, state.invoices?.running ? 4000 : 20000);
  }
  async function refresh() {
    state.active = true;
    const session = state.session, revision = state.dataRevision;
    if (state.request) {
      if (state.request.session === session && state.request.revision === revision) return state.request.promise;
      await state.request.promise;
      if (session !== state.session) return;
      return refresh();
    }
    const request = { session, revision, promise: null }; state.request = request;
    renderControls();
    request.promise = (async () => {
      const results = await Promise.allSettled([api('/api/drive'), api('/api/invoices')]);
      if (session !== state.session || revision !== state.dataRevision) return;
      if (results[0].status === 'fulfilled') state.drive = results[0].value;
      if (results[1].status === 'fulfilled') state.invoices = results[1].value;
      const failure = results.find(result => result.status === 'rejected');
      if (failure) feedback(errorText(failure.reason, describeError), true);
      if (state.ownJobId && state.invoices) {
        const job = state.invoices.lastRun || state.invoices.job;
        if (job?.id === state.ownJobId && ['completed', 'failed', 'cancelled'].includes(job.status)) {
          notify?.(job.status === 'completed' ? `Invoice scan complete: ${count(job.filed)} filed, ${count(job.needsReview)} need review.` : 'The invoice scan stopped. Check Invoice filing under Accounts.', job.status === 'completed' ? 'success' : 'error');
          state.ownJobId = null;
        }
      }
      render(); state.loaded = true;
    })().finally(() => {
      if (state.request === request) { state.request = null; renderControls(); schedule(); }
    });
    return request.promise;
  }
  async function action(kind, work) {
    if (state.busy) return;
    const session = state.session, revision = ++state.dataRevision;
    state.busy = kind; feedback(); renderControls();
    const valid = () => session === state.session && revision === state.dataRevision;
    try { await work(valid); }
    catch (error) { if (valid()) feedback(errorText(error, describeError), true); }
    finally { if (valid()) { state.busy = ''; renderControls(); schedule(); } }
  }
  function configure() {
    const clientId = nodes.clientId.value.trim(), clientSecret = nodes.clientSecret.value.trim(), expectedEmail = nodes.expectedEmail.value.trim();
    return action('configure', async valid => {
      const value = await api('/api/drive/configure', { method: 'POST', body: { clientId, clientSecret, expectedEmail } });
      if (!valid()) return;
      nodes.clientSecret.value = ''; state.clientDirty = false;
      if (value?.configured !== undefined) state.drive = value;
      feedback('Google registration saved. Connect your private Drive to continue.'); render(); await refresh();
    });
  }
  function connect() {
    return action('connect', async valid => {
      const result = await api('/api/drive/connect', { method: 'POST', body: {} });
      if (!valid()) return;
      let url;
      try { url = new URL(result.url); } catch { throw new Error('Google did not return a valid sign-in link.'); }
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password || url.hash) throw new Error('Google did not return a valid sign-in link.');
      window.location.assign(url.href);
    });
  }
  function disconnect() {
    return action('disconnect', async valid => {
      const value = await api('/api/drive/disconnect', { method: 'POST', body: {} });
      if (!valid()) return;
      if (value?.connected !== undefined) state.drive = value;
      feedback('Drive disconnected. Existing invoice files remain in Drive.'); render(); await refresh();
    });
  }
  function settings(enabled) {
    return action('settings', async valid => {
      const value = await api('/api/invoices/settings', { method: 'POST', body: { enabled } });
      if (!valid()) return;
      if (value?.enabled !== undefined) state.invoices = value;
      feedback(enabled ? 'Automatic invoice filing enabled.' : 'Automatic invoice filing paused.'); render(); await refresh();
    });
  }
  function scan() {
    return action('scan', async valid => {
      const value = await api('/api/invoices/scan', { method: 'POST', body: { limit: 1000 } });
      if (!valid()) return;
      if (value?.job?.id) { state.ownJobId = value.job.id; state.invoices = { ...state.invoices, running: value.job.status === 'running', job: value.job }; }
      feedback('Invoice scan started. You can keep using MailHarbor while it runs.'); render(); await refresh();
    });
  }
  async function copyCallback() {
    const session = state.session;
    try { await navigator.clipboard.writeText(nodes.callback.value); if (session === state.session) feedback('Callback URL copied.'); }
    catch { if (session === state.session) { nodes.callback.focus(); nodes.callback.select(); feedback('Select and copy the callback URL from the field.'); } }
  }
  build(); renderControls();
  document.addEventListener('visibilitychange', () => {
    if (!state.active) return;
    if (!document.hidden && state.visible) void refresh(); else schedule();
  });
  return {
    show() { state.active = true; state.visible = true; void refresh(); },
    hide() { state.visible = false; schedule(); },
    refresh,
    reset() {
      state.session++; state.dataRevision++; state.active = false; state.visible = false; state.loaded = false; state.drive = null; state.invoices = null; state.busy = ''; state.ownJobId = null; state.clientDirty = false; state.entitiesDirty = false;
      clearTimeout(state.timer); state.timer = null; state.request = null;
      nodes.expectedEmail.value = ''; nodes.clientId.value = ''; nodes.clientSecret.value = ''; nodes.callback.value = ''; nodes.enabled.checked = false;
      nodes.recentDisclosure.open = false;
      feedback(); render();
    }
  };
}
