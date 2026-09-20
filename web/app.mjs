import {createMailView} from './mail.mjs';
import {createFilingView} from './filing.mjs';
import {createProcessingView} from './processing.mjs';
import {observeSelects} from './controls.mjs';
import {createApiRequest} from './api-request.mjs';
import {createAccountSetup} from './account-setup.mjs';

observeSelects(document);

const $ = id => document.getElementById(id);
const make = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const ACTIVE = new Set(['scanning', 'queued', 'running']);
const state = {csrf: '', accounts: [], providers: [], oauthFailure: null, jobs: [], current: null, activeId: null, chosen: new Set(), chosenInitialized: false, selected: new Set(), applied: new Map(), folders: new Map(), busy: false, session: false, pollTimer: null, loadSequence: 0};
let outgoingSettings = [];
const speech = {supported: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window, voices: [], chunks: [], index: 0, generation: 0, active: false, paused: false, utterance: null, label: ''};
const providerKey = provider => /gmail|google/i.test(provider) ? 'google' : /hotmail|outlook|microsoft/i.test(provider) ? 'microsoft' : 'imap';
const accountName = account => account.label || account.email || account.id;
const jobPath = id => `/api/briefings/${encodeURIComponent(id)}`;
const dateText = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'}) : 'Date unavailable';
};
const timeText = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
};
const numberText = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
const messages = () => Array.isArray(state.current?.messages) ? state.current.messages : [];
const notify = (text, type = '') => {
  $('notice').textContent = text;
  $('notice').className = `notice ${type}`;
  $('notice').hidden = !text;
};
const ERROR_MESSAGES = {
  busy: 'The homeserver is busy. Let the current operation finish, then try again.',
  server_busy: 'The homeserver is busy. Let the current operation finish, then try again.',
  timeout: 'The connection took too long. The server may still be working; refresh its status before retrying.',
  deadline_exceeded: 'This operation reached its time limit. Try again, or reconnect the affected account.',
  connection_error: 'Could not reach the mailbox. Check its connection in Accounts.',
  authentication_failed: 'The mailbox login was rejected. Reconnect this account in Accounts.',
  invalid_grant: 'This account needs a fresh sign-in. Reconnect it in Accounts.',
  oauth_not_configured: 'Set up this provider under Accounts → Provider registration first.',
  not_configured: 'Complete the connection settings in Accounts first.',
  stale_message: 'This email or mail view changed. Refresh mail or create a new briefing before trying again.',
  stale: 'This email changed since the briefing. Create a fresh briefing before changing it.',
  csrf: 'Your browser session changed. Reload MailHarbor and try again.',
  csrf_invalid: 'Your browser session changed. Reload MailHarbor and try again.'
};
function describeError(error) {
  if (ERROR_MESSAGES[error?.code]) return ERROR_MESSAGES[error.code];
  return error?.message || 'Something went wrong. Please try again.';
}
function showLogin() {
  mailView.reset();
  filingView.reset();
  processingView.reset();
  state.session = false;
  state.csrf = '';
  clearTimeout(state.pollTimer);
  state.loadSequence++;
  state.current = null; state.jobs = []; state.activeId = null;
  state.accounts = []; state.providers = []; state.chosen.clear(); state.chosenInitialized = false;
  state.oauthFailure = null;
  outgoingSettings = [];
  state.selected.clear(); state.applied.clear(); state.folders.clear();
  $('emails').replaceChildren();
  $('accounts-list').replaceChildren();
  $('provider-list').replaceChildren();
  $('account-choices').replaceChildren();
  $('history-list').replaceChildren();
  $('briefing-text').textContent = 'Create a briefing to bring the newest unread emails from your inboxes into one place.';
  $('briefing-state').textContent = 'READY WHEN YOU ARE';
  $('briefing-time').textContent = '';
  $('progress').hidden = true;
  $('email-count').textContent = '0 emails';
  $('scope').textContent = 'Each briefing covers up to 40 newest unread Inbox emails across your selected accounts.';
  $('authenticated').hidden = true;
  $('login').hidden = false;
  $('connection').textContent = 'Pairing required';
  $('connection').className = 'connection';
  stopSpeech();
}
const api = createApiRequest({getCsrf: () => state.csrf, onUnauthorized: showLogin, errorMessages: ERROR_MESSAGES});
const accountSetup = createAccountSetup({root: $('account-setup'), api, refresh: refreshAccounts, describeError});
function setPage() {
  const page = location.hash === '#accounts' ? 'accounts' : location.hash === '#today' ? 'today' : 'inbox';
  for (const name of ['inbox', 'today', 'accounts']) {
    $(name === 'inbox' ? 'mail-page' : `${name}-page`).hidden = name !== page;
    if (name === page) $(`nav-${name}`).setAttribute('aria-current', 'page');
    else $(`nav-${name}`).removeAttribute('aria-current');
  }
  if (page === 'inbox' && state.session) mailView.show();
  else mailView.hide();
  if (page === 'accounts' && state.session) { filingView.show(); processingView.show(); void mailView.renderSettings(outgoingSettings); }
  else { filingView.hide(); processingView.hide(); }
  document.title = `${page === 'today' ? 'Briefings' : page === 'accounts' ? 'Accounts' : 'Inbox'} · MailHarbor`;
}
const mailView = createMailView({api, describeError});
const filingView = createFilingView({root: $('invoice-filing'), api, describeError, notify});
const processingView = createProcessingView({root: $('mail-processing'), api, describeError, notify});
async function acceptSession(session) {
  if (session?.authenticated !== true || typeof session.csrf !== 'string' || !session.csrf) throw new Error('The server did not create a valid browser session.');
  state.csrf = session.csrf;
  state.session = true;
  $('login').hidden = true;
  $('authenticated').hidden = false;
  $('version').textContent = session.version ? `v${session.version}` : '';
  setPage();
  notify('');
  const results = await Promise.allSettled([refreshStatus(), refreshAccounts(), refreshJobs(true)]);
  for (const result of results) if (result.status === 'rejected') notify(describeError(result.reason), 'error');
}
async function connectSession(body) {
  const buttons = [...$('login').querySelectorAll('button')];
  buttons.forEach(button => button.disabled = true);
  try { await acceptSession(await api('/api/session', {method: 'POST', body, sessionRequest: true})); }
  finally { buttons.forEach(button => button.disabled = false); }
}
async function initialize() {
  $('today-date').textContent = new Date().toLocaleDateString(undefined, {weekday: 'long', month: 'long', day: 'numeric'}).toUpperCase();
  loadVoices();
  try { await acceptSession(await api('/api/session', {sessionRequest: true})); }
  catch (error) {
    if (error.status === 401) {
      try { await connectSession({tailscale: true}); return; }
      catch (fallback) { showLogin(); if (fallback.status !== 401 && fallback.status !== 403) notify(describeError(fallback), 'error'); }
    } else { showLogin(); notify(describeError(error), 'error'); }
  }
}
async function refreshStatus() {
  const session = state.csrf;
  const status = await api('/api/status');
  if (!state.session || state.csrf !== session) return;
  $('connection').textContent = status.ready ? 'Homeserver ready' : 'Setup needed';
  $('connection').className = `connection ${status.ready ? 'ready' : ''}`;
  $('connection').title = status.ready ? (status.model || 'Connected') : (status.detail || 'Complete Agy setup on the homeserver.');
  if (status.version) $('version').textContent = `v${status.version}`;
  if (!status.ready) notify(status.detail || 'Your homeserver is connected. Complete its Agy login and setup before creating a briefing.', 'error');
}
async function refreshAccounts() {
  const session = state.csrf;
  const data = await api('/api/accounts');
  if (!state.session || state.csrf !== session) return;
  state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
  state.providers = Array.isArray(data.providers) ? data.providers : [];
  accountSetup.update(data.catalog);
  state.oauthFailure = data.oauthFailure || null;
  const connected = state.accounts.filter(account => account.connected);
  if (!state.chosenInitialized) {
    connected.forEach(account => state.chosen.add(account.id));
    state.chosenInitialized = true;
  }
  for (const id of state.chosen) if (!connected.some(account => account.id === id)) state.chosen.delete(id);
  renderAccountChoices();
  renderAccounts();
  renderProviders();
  updateControls();
  mailView.accountsChanged(state.accounts);
}
function renderAccountChoices() {
  const connected = state.accounts.filter(account => account.connected).length;
  $('account-count').textContent = `${connected} of ${state.accounts.length} accounts connected`;
  $('connect-first').hidden = connected > 0;
  const choices = $('account-choices');
  choices.replaceChildren(make('legend', 'Accounts to include', 'sr-only'));
  for (const account of state.accounts) {
    const label = make('label', undefined, `account-choice${account.connected ? '' : ' unavailable'}`);
    const input = make('input');
    input.type = 'checkbox'; input.checked = state.chosen.has(account.id); input.disabled = !account.connected;
    input.addEventListener('change', () => { if (input.checked) state.chosen.add(account.id); else state.chosen.delete(account.id); updateControls(); });
    label.append(input, make('span', accountName(account)));
    if (!account.connected) label.append(make('small', 'Connect'));
    choices.append(label);
  }
}
function addButton(parent, text, action, className = 'subtle') {
  const button = make('button', text, className);
  button.type = 'button';
  button.addEventListener('click', action);
  parent.append(button);
  return button;
}
function feedback(node, message, error = false) {
  node.textContent = message;
  node.className = `feedback ${error ? 'error' : 'success'}`;
  node.hidden = !message;
}
async function accountOperation(card, message, operation) {
  const buttons = [...card.querySelectorAll('button, input, select')];
  const feedbackNode = card.querySelector('.feedback');
  buttons.forEach(button => button.disabled = true);
  feedback(feedbackNode, 'Connecting…');
  try {
    await operation();
    await refreshAccounts();
    notify(message, 'success');
  } catch (error) { feedback(feedbackNode, describeError(error), true); }
  finally { buttons.forEach(button => button.disabled = false); }
}
function passwordForm(account, card, isGoogle) {
  const form = make('form');
  const label = make('label', undefined, 'field');
  label.append(make('span', isGoogle ? 'Dedicated Google app password' : 'Mailbox password'));
  const input = make('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.required = true; input.spellcheck = false;
  label.append(input);
  if (isGoogle) label.append(make('small', 'Use a new app password created for MailHarbor. Your normal Google password will not work.'));
  form.append(label);
  const submit = make('button', 'Save connection', 'primary'); submit.type = 'submit'; form.append(submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const passwordInput = input.value;
    input.value = '';
    if (!passwordInput) return;
    accountOperation(card, `${accountName(account)} connection saved. Use Test connection to verify it.`, () => api('/api/accounts/password', {method: 'POST', body: {id: account.id, password: passwordInput}, timeout: 65000}));
  });
  return form;
}
function renderAccounts() {
  outgoingSettings = [];
  $('accounts-list').replaceChildren();
  if (!state.accounts.length) $('accounts-list').append(make('p', 'No accounts yet. Add your first email account above.', 'fineprint'));
  for (const account of state.accounts) {
    const key = providerKey(account.provider);
    const card = make('article', undefined, 'account-card panel');
    const heading = make('div', undefined, 'account-title');
    const title = make('div'); title.append(make('h2', accountName(account)), make('p', account.email || ''));
    heading.append(make('span', key === 'google' ? 'G' : key === 'microsoft' ? 'M' : 'V', 'provider-icon'), title);
    card.append(heading, make('span', account.connected ? 'Connected' : 'Not connected', `account-state${account.connected ? ' connected' : ''}`));
    const detail = account.connected ? `Saved connection${account.authType ? ` · ${account.authType === 'oauth' ? 'OAuth' : 'Password'}` : ''}` : 'Connect this mailbox to include it in your briefings.';
    card.append(make('p', detail, 'fineprint'));
    if (state.oauthFailure?.provider === key) {
      const failure = make('p', describeError(state.oauthFailure), 'notice error');
      failure.setAttribute('role', 'alert');
      card.append(failure);
    }
    if (account.archivePath) card.append(make('p', `Archive folder: ${account.archivePath}`, 'fineprint'));
    const actions = make('div', undefined, 'account-actions');
    const oauthConfigured = account.oauthConfigured === true || state.providers.some(provider => providerKey(provider.id) === key && provider.configured);
    if (key === 'google' || key === 'microsoft') {
      const connect = addButton(actions, `${account.connected ? 'Reconnect' : 'Connect'} ${key === 'google' ? 'Google' : 'Microsoft'}`, () => {
        accountOperation(card, 'Opening provider sign-in…', async () => {
          const result = await api('/api/accounts/oauth', {method: 'POST', body: {id: account.id}});
          const url = new URL(result.url);
          const expectedHost = key === 'google' ? 'accounts.google.com' : 'login.microsoftonline.com';
          if (url.protocol !== 'https:' || url.hostname !== expectedHost || url.username || url.password) throw new Error('The server returned an unexpected sign-in address.');
          location.assign(url.href);
        });
      }, 'primary');
      connect.disabled = !oauthConfigured;
      if (!oauthConfigured) {
        const link = make('a', 'Set up provider sign-in →'); link.href = '#accounts';
        link.addEventListener('click', () => { $('provider-settings').open = true; $('provider-settings').scrollIntoView({behavior: 'smooth', block: 'start'}); });
        card.append(make('p', 'Provider registration is needed for OAuth.', 'fineprint'), link);
      }
    }
    if (account.connected) {
      addButton(actions, 'Test connection', () => accountOperation(card, `${accountName(account)} connected successfully. Archive folders are available below.`, async () => {
        const result = await api(`/api/accounts/${encodeURIComponent(account.id)}/test`, {method: 'POST', timeout: 65000});
        state.folders.set(account.id, Array.isArray(result.folders) ? result.folders : []);
      }));
    }
    addButton(actions, 'Remove account', async () => {
      const confirmed = await confirmAction({title: 'Remove this account?', description: `Remove ${accountName(account)} and its saved credentials from MailHarbor?`, items: [], note: 'Your mailbox stays with its provider. You can add it again later.', button: 'Remove account'});
      if (confirmed) accountOperation(card, `${accountName(account)} removed from MailHarbor.`, () => api(`/api/accounts/${encodeURIComponent(account.id)}`, {method: 'DELETE'}));
    }, 'danger');
    card.append(actions);
    if (key === 'imap') {
      const details = make('details'); details.open = !account.connected;
      details.append(make('summary', account.connected ? 'Update mailbox password' : 'Connect with mailbox password'), passwordForm(account, card, false)); card.append(details);
    } else if (key === 'google') {
      const details = make('details');
      const explanation = make('p', 'If your account supports app passwords, this is an alternative to OAuth. It requires 2-Step Verification and may be restricted by Workspace settings.', 'fineprint');
      const help = make('a', 'Google app password instructions'); help.href = 'https://support.google.com/accounts/answer/185833'; help.target = '_blank'; help.rel = 'noopener noreferrer';
      details.append(make('summary', 'Use a Google app password instead'), explanation, help, passwordForm(account, card, true)); card.append(details);
    }
    if (account.connected) {
      const outgoing = make('details', undefined, 'account-outgoing');
      const settings = make('div');
      outgoing.append(make('summary', 'Outgoing mail'), settings);
      card.append(outgoing, archiveFolderForm(account, card));
      outgoingSettings.push({accountId: account.id, container: settings});
    }
    const status = make('p', '', 'feedback'); status.hidden = true; status.setAttribute('role', 'status'); card.append(status);
    $('accounts-list').append(card);
  }
  void mailView.renderSettings(state.session && location.hash === '#accounts' ? outgoingSettings : []);
}
function archiveFolderForm(account, card) {
  const details = make('details');
  details.append(make('summary', 'Choose archive folder'));
  const folders = state.folders.get(account.id);
  if (!folders) {
    details.append(make('p', 'Use Test connection above to load this mailbox’s existing folders.', 'fineprint'));
    return details;
  }
  const allowed = folders.filter(folder => folder?.path && !/^INBOX$/i.test(folder.path) && !/\\(?:Trash|Junk|Drafts|Sent|Inbox)\b/i.test(folder.specialUse || ''));
  if (!allowed.length) {
    details.append(make('p', 'No eligible archive folder was returned. Create an archive folder in your mail provider and test the connection again.', 'fineprint'));
    return details;
  }
  const form = make('form');
  const label = make('label', undefined, 'field'); label.append(make('span', 'Existing mailbox folder'));
  const select = make('select'); select.required = true;
  const placeholder = make('option', 'Choose a folder'); placeholder.value = ''; select.append(placeholder);
  for (const folder of allowed) { const option = make('option', folder.path); option.value = folder.path; select.append(option); }
  if (allowed.some(folder => folder.path === account.archivePath)) select.value = account.archivePath;
  label.append(select); form.append(label, make('p', 'This changes where future archive actions move email. Create a new briefing after changing the folder.', 'fineprint'));
  const submit = make('button', 'Save archive folder', 'subtle'); submit.type = 'submit'; form.append(submit);
  form.addEventListener('submit', event => {
    event.preventDefault(); const path = select.value;
    if (!path) return;
    accountOperation(card, `Archive folder saved for ${accountName(account)}. Create a new briefing before applying mail actions.`, () => api(`/api/accounts/${encodeURIComponent(account.id)}/archive`, {method: 'POST', body: {path}, timeout: 65000}));
  });
  details.append(form); return details;
}
function inputField(labelText, type, value = '') {
  const label = make('label', undefined, 'field'); const input = make('input');
  input.type = type; input.value = value; input.spellcheck = false;
  label.append(make('span', labelText), input);
  return {label, input};
}
function renderProviders() {
  $('provider-list').replaceChildren();
  for (const key of ['google', 'microsoft']) {
    const provider = state.providers.find(item => providerKey(item.id) === key) || {id: key, configured: false};
    const google = key === 'google';
    const form = make('form', undefined, 'provider-form');
    form.append(make('h3', google ? 'Google · Gmail and Workspace' : 'Microsoft · personal Hotmail'), make('p', provider.configured ? 'Sign-in configured. The saved client secret is never displayed.' : 'Add your own OAuth client to enable the account Connect buttons.', 'provider-state'));
    form.append(make('p', google ? 'Create a Web application OAuth client with an External audience so it can serve your Google accounts. Testing mode expires mail refresh tokens after seven days; for this personal app, use In production for ongoing access. Google documents an exception to verification for personal use. Workspace may require administrator approval.' : 'Register a Web application in Microsoft Entra with accounts in any organizational directory and personal Microsoft accounts. Use the authorization code flow; a Single-page application registration is not suitable for this homeserver connection. You need access to an Entra tenant where you can register applications.'));
    const links = make('div', undefined, 'provider-help');
    const sourceLinks = google ? [['Create your Google client', 'https://developers.google.com/workspace/guides/configure-oauth-consent'], ['Personal-use verification exception', 'https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#exceptions_to_verification_requirements']] : [['Register your Microsoft app', 'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app'], ['Microsoft IMAP OAuth', 'https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth']];
    for (const [text, href] of sourceLinks) { const link = make('a', text); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link); }
    form.append(links);
    const callback = inputField('Authorized redirect / callback URL', 'text', provider.callback || 'Waiting for server configuration'); callback.input.readOnly = true;
    const row = make('div', undefined, 'callback-row'); callback.input.remove(); row.append(callback.input);
    const copy = addButton(row, 'Copy URL', async () => {
      try { await navigator.clipboard.writeText(callback.input.value); copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy URL', 2000); }
      catch { callback.input.focus(); callback.input.select(); notify('Select and copy the callback URL from the field.'); }
    });
    copy.disabled = !provider.callback; callback.label.append(row); form.append(callback.label);
    form.append(make('p', 'Register this exact URL, including its port and path. Open sign-in from a device connected to Tailscale.', 'fineprint'));
    const id = inputField('Client ID', 'text', provider.clientId || ''); id.input.required = true; id.input.autocomplete = 'off';
    const secret = inputField('Client secret', 'password'); secret.input.required = true; secret.input.autocomplete = 'new-password';
    secret.label.append(make('small', 'Enter the secret value, not its identifier. It is stored encrypted on your homeserver.'));
    form.append(id.label, secret.label);
    if (provider.scope) form.append(make('p', `Requested scope: ${provider.scope}`, 'fineprint'));
    const submit = make('button', 'Save provider registration', 'primary'); submit.type = 'submit';
    const status = make('p', '', 'feedback'); status.hidden = true; status.setAttribute('role', 'status'); form.append(submit, status);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const clientId = id.input.value.trim(); const clientSecret = secret.input.value; secret.input.value = '';
      if (!clientId || !clientSecret) return;
      submit.disabled = true; feedback(status, 'Saving registration…');
      try { await api('/api/providers', {method: 'POST', body: {provider: provider.id, clientId, clientSecret}}); await refreshAccounts(); notify(`${google ? 'Google' : 'Microsoft'} sign-in configured. Connect each mailbox above.`, 'success'); }
      catch (error) { feedback(status, describeError(error), true); }
      finally { submit.disabled = false; }
    });
    $('provider-list').append(form);
  }
}
function progressText(job) {
  const progress = job?.progress;
  if (typeof progress === 'string') return progress;
  if (progress?.message) return String(progress.message);
  if (job?.status === 'scanning' && progress?.phase === 'bodies' && progress.read !== undefined && progress.total !== undefined) return `Preparing email text · ${numberText(progress.read)} of ${numberText(progress.total)} emails.`;
  if (job?.status === 'scanning' && progress?.checked !== undefined) {
    const inboxes = Number(progress.inboxCount ?? 0);
    return `Finding newest unread emails · ${numberText(progress.checked)} headers checked · ${numberText(progress.totalUnread)} unread found so far in ${numberText(inboxes)} inbox${inboxes === 1 ? '' : 'es'}.`;
  }
  if (progress?.headersChecked !== undefined) return `Finding newest unread emails · ${numberText(progress.headersChecked)} headers checked.`;
  if (progress?.done !== undefined && progress?.total !== undefined) return `Preparing email text · ${numberText(progress.done)} of ${numberText(progress.total)}.`;
  return {scanning: 'Checking your inboxes for the newest unread emails…', queued: 'Your briefing is queued on the homeserver…', running: 'Google is preparing your briefing through Agy…', failed: 'The briefing could not finish.', cancelled: 'This briefing was cancelled.'}[job?.status] || '';
}
async function refreshJobs(resume = false) {
  const session = state.csrf;
  const data = await api('/api/briefings');
  if (!state.session || state.csrf !== session) return;
  state.jobs = Array.isArray(data.briefings) ? data.briefings : [];
  state.jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  state.activeId = state.jobs.find(job => ACTIVE.has(job.status))?.id || null;
  renderHistory(); updateControls();
  if (resume && !state.current && state.jobs.length) await loadJob(state.activeId || state.jobs[0].id);
  else schedulePoll();
}
function renderHistory() {
  const list = $('history-list'); list.replaceChildren();
  if (!state.jobs.length) { list.append(make('p', 'Your briefings will appear here. You can return on another device while the homeserver works.', 'fineprint')); return; }
  for (const job of state.jobs.slice(0, 12)) {
    const button = addButton(list, timeText(job.createdAt) || 'Briefing', () => loadJob(job.id).catch(error => notify(describeError(error), 'error')), 'history-item');
    if (state.current?.id === job.id) button.setAttribute('aria-current', 'true');
    button.append(make('small', `${job.status} · ${Number.isFinite(job.count) ? job.count : '…'} emails`));
  }
}
async function loadJob(id, {poll = false} = {}) {
  const sequence = ++state.loadSequence;
  const job = await api(jobPath(id));
  if (sequence !== state.loadSequence || !state.session) return;
  if (!job || job.id !== id || typeof job.status !== 'string') throw new Error('The homeserver returned an unexpected briefing.');
  const changed = state.current?.id !== id;
  const previousStatus = state.current?.status;
  if (changed) { state.selected.clear(); state.applied.clear(); stopSpeech(); }
  state.current = job;
  const index = state.jobs.findIndex(item => item.id === id);
  const summary = {id: job.id, status: job.status, createdAt: job.createdAt, count: job.count ?? messages().length, totalUnread: job.totalUnread, inboxCount: job.inboxCount};
  if (index < 0) state.jobs.unshift(summary); else state.jobs[index] = summary;
  if (ACTIVE.has(job.status)) state.activeId = id;
  else if (state.activeId === id) state.activeId = state.jobs.find(item => ACTIVE.has(item.status))?.id || null;
  renderJob({renderEmails: !poll || changed || previousStatus !== job.status || !ACTIVE.has(job.status)});
  if (previousStatus !== job.status && !ACTIVE.has(job.status)) {
    if (job.status === 'completed') notify(messages().length ? 'Your briefing is ready. Nothing has been changed in your inboxes.' : 'No unread emails were found. Your inboxes are unchanged.', 'success');
    else if (job.status === 'failed') notify('The briefing could not finish. See its status below, then check your account connections.', 'error');
    else if (job.status === 'cancelled') notify('Briefing cancelled. Your emails are unchanged.');
  }
  renderHistory(); schedulePoll();
}
function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!state.session || !state.activeId) return;
  state.pollTimer = setTimeout(async () => {
    try {
      if (state.current?.id === state.activeId) await loadJob(state.activeId, {poll: true});
      else await refreshJobs();
    } catch (error) {
      if (state.session) { notify(describeError(error), 'error'); schedulePoll(); }
    }
  }, 2000);
}
function renderJob({renderEmails = true} = {}) {
  const job = state.current;
  if (!job) { updateControls(); return; }
  const complete = job.status === 'completed';
  const count = messages().length || job.count || 0;
  $('briefing-state').textContent = {scanning: 'FINDING EMAILS', queued: 'QUEUED', running: 'PREPARING', completed: 'READY TO LISTEN', failed: 'NEEDS ATTENTION', cancelled: 'CANCELLED'}[job.status] || job.status.toUpperCase();
  $('briefing-time').textContent = timeText(job.createdAt) ? `Created ${timeText(job.createdAt)}` : '';
  $('briefing-text').textContent = job.result?.briefing || (complete && count === 0 ? 'A quiet inbox. There are no unread emails in the accounts you selected.' : ACTIVE.has(job.status) ? 'Your homeserver is working on this briefing. You can leave this page and return on any connected device.' : job.status === 'cancelled' ? 'This briefing was cancelled. Start a new one whenever you are ready.' : 'This briefing did not finish. Check the message below and try again.');
  $('email-count').textContent = `${count} email${count === 1 ? '' : 's'}`;
  $('progress').hidden = complete;
  $('progress').textContent = job.status === 'failed' ? describeError(typeof job.error === 'object' ? job.error : {message: job.error || 'The briefing failed. Check Accounts and try again.'}) : progressText(job);
  if (complete) {
    const unread = Number.isFinite(job.totalUnread) ? ` ${numberText(job.totalUnread)} unread emails were found.` : '';
    const inboxes = Number.isFinite(job.inboxCount) ? ` across ${job.inboxCount} inbox${job.inboxCount === 1 ? '' : 'es'}` : '';
    $('scope').textContent = `${count} newest unread email${count === 1 ? '' : 's'}${inboxes}, up to 40 per briefing.${unread} This briefing covers this batch only. Emails left unread may appear again in your next briefing.`;
  } else $('scope').textContent = 'Finding up to 40 newest unread Inbox emails across the selected accounts. Reading this briefing does not change your mail.';
  if (renderEmails) renderMessages();
  updateControls();
}
function renderMessages() {
  const list = $('emails'); list.replaceChildren();
  const job = state.current;
  const items = new Map((Array.isArray(job?.result?.items) ? job.result.items : []).map(item => [item.id, item]));
  if (!messages().length) {
    const empty = make('div', undefined, 'empty');
    const complete = job?.status === 'completed';
    empty.append(make('span', complete ? '✓' : '✦', 'empty-symbol'), make('h3', complete ? 'You’re caught up.' : ACTIVE.has(job?.status) ? 'A clearer view is on its way.' : 'No emails to review.'), make('p', complete ? 'No unread emails were found in the selected inboxes. Nothing has been changed.' : ACTIVE.has(job?.status) ? 'The homeserver will keep working if you close this page.' : 'Create a new briefing when you are ready.'));
    list.append(empty); return;
  }
  for (const message of messages()) {
    const item = items.get(message.id);
    const applied = state.applied.get(message.id);
    const card = make('article', undefined, `email${state.selected.has(message.id) ? ' selected' : ''}${applied ? ' done' : ''}`);
    const top = make('div', undefined, 'email-top');
    const target = make('label', undefined, 'selection-target');
    const check = make('input'); check.type = 'checkbox'; check.checked = state.selected.has(message.id);
    check.disabled = state.busy || job.status !== 'completed' || Boolean(applied);
    check.setAttribute('aria-label', `Select ${message.subject || 'email without a subject'}`);
    check.addEventListener('change', () => { if (check.checked) state.selected.add(message.id); else state.selected.delete(message.id); card.classList.toggle('selected', check.checked); updateControls(); });
    target.append(check); const content = make('div', undefined, 'email-content');
    const meta = make('div', undefined, 'email-meta');
    meta.append(make('span', message.account || 'Mailbox', 'account-pill'), make('span', dateText(message.date)));
    if (item) meta.append(make('span', item.priority === 'high' ? 'NEEDS ATTENTION' : String(item.category || 'Email').replaceAll('_', ' ').toUpperCase(), item.priority === 'high' ? 'priority-high' : ''));
    content.append(meta, make('h3', message.subject || '(No subject)'), make('p', message.author || 'Sender unavailable', 'author'));
    if (item) {
      content.append(make('p', item.summary || '', 'summary'), make('span', item.recommendation === 'archive' ? '↘ Suggested: archive' : '• Suggested: keep in inbox', `suggestion ${item.recommendation === 'archive' ? 'archive' : 'keep'}`));
      if (item.reason) content.append(make('p', item.reason, 'reason'));
    } else content.append(make('p', ACTIVE.has(job.status) ? 'Waiting for your briefing…' : 'No summary is available for this email.', 'summary'));
    if (message.truncated || message.bodyUnavailable) content.append(make('p', message.bodyUnavailable ? 'Email text could not be read. Review the original in your mail app before changing it.' : 'This email was shortened. Archiving from this copy is unavailable; review the original in your mail app.', 'fineprint warning'));
    if (applied) content.append(make('p', applied === 'archive' ? '✓ Archived in this session' : '✓ Marked read in this session', 'fineprint'));
    const bottom = make('div', undefined, 'email-bottom');
    const read = addButton(bottom, '▶ Read email', () => speak(`${message.subject || 'Email'}. From ${message.author || 'unknown sender'}. ${message.body || ''}${message.truncated ? ' End of shortened email. Open the original for the rest.' : ''}`, 'Reading email'));
    read.disabled = !speech.supported || message.bodyUnavailable || !message.body;
    const details = make('details'); details.append(make('summary', 'View extracted email text'), make('pre', message.body || 'Readable text is unavailable. Open the original in your mail app.', 'original-body'));
    bottom.append(details); content.append(bottom); top.append(target, content); card.append(top); list.append(card);
  }
}
function updateControls() {
  const active = Boolean(state.activeId);
  $('create-briefing').disabled = state.busy || active || !state.chosen.size;
  $('create-briefing').textContent = active ? 'Briefing in progress…' : 'Create briefing ↗';
  $('cancel-briefing').hidden = !active;
  $('cancel-briefing').disabled = state.busy;
  const selectedMessages = messages().filter(message => state.selected.has(message.id));
  const canAct = !state.busy && state.current?.status === 'completed' && selectedMessages.length > 0;
  $('selected-count').textContent = `${state.selected.size} selected`;
  $('clear-selection').disabled = !state.selected.size || state.busy;
  $('mark-read').disabled = !canAct;
  $('archive').disabled = !canAct || selectedMessages.some(message => message.truncated || message.bodyUnavailable);
  $('archive').title = selectedMessages.some(message => message.truncated || message.bodyUnavailable) ? 'Review shortened or unreadable emails in your mail app before archiving.' : '';
  updateSpeechControls();
}
async function createBriefing() {
  if (state.busy || state.activeId || !state.chosen.size) return;
  state.busy = true; updateControls(); stopSpeech(); notify('Starting your briefing…');
  try {
    const job = await api('/api/briefings', {method: 'POST', body: {accountIds: [...state.chosen], language: 'en'}});
    state.activeId = job.id;
    state.selected.clear(); state.applied.clear();
    location.hash = '#today';
    await loadJob(job.id);
    if (ACTIVE.has(state.current?.status)) notify('Your homeserver is preparing the briefing. You can return here from your phone or computer.');
  } catch (error) {
    notify(describeError(error), 'error');
    // An accepted POST can outlive a failed response. Check the server before enabling another submission.
    if (state.session) await refreshJobs(true).catch(() => {});
  } finally { state.busy = false; updateControls(); }
}
let dialogPending = false;
function confirmAction({title, description, items, note, button}) {
  if (dialogPending) return Promise.resolve(false);
  dialogPending = true;
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  $('confirm-note').textContent = note;
  $('confirm-apply').textContent = button;
  $('confirm-items').replaceChildren(...items.map(item => make('li', item)));
  $('confirm-items').hidden = !items.length;
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => { dialogPending = false; resolve(dialog.returnValue === 'confirm'); }, {once: true});
    dialog.showModal();
    dialog.querySelector('button[value="cancel"]').focus();
  });
}
async function applyAction(action) {
  if (state.busy || state.current?.status !== 'completed') return;
  const jobId = state.current.id;
  const chosen = messages().filter(message => state.selected.has(message.id) && !state.applied.has(message.id));
  if (!chosen.length || (action === 'archive' && chosen.some(message => message.truncated || message.bodyUnavailable))) return;
  const archive = action === 'archive';
  const confirmed = await confirmAction({title: `${archive ? 'Archive' : 'Mark read'} ${chosen.length} email${chosen.length === 1 ? '' : 's'}?`, description: archive ? 'These selected emails will leave their inboxes and move to the accounts’ archive folders.' : 'These selected emails will be marked as read in their original mailboxes.', items: chosen.map(message => `${message.account} · ${message.subject || '(No subject)'}`), note: 'Only the emails listed above will be changed. The server checks each email against this briefing before applying your choice.', button: archive ? 'Archive selected emails' : 'Mark selected as read'});
  if (!confirmed || state.busy || state.current?.id !== jobId) return;
  state.busy = true; updateControls(); renderMessages();
  try {
    const result = await api(`${jobPath(jobId)}/actions`, {method: 'POST', body: {action, ids: chosen.map(message => message.id)}, timeout: 95000});
    const applied = Array.isArray(result.applied) ? result.applied : [];
    const failed = Array.isArray(result.failed) ? result.failed : [];
    for (const id of applied) { state.applied.set(id, action); state.selected.delete(id); }
    const codes = [...new Set(failed.map(item => item.code))].map(code => ERROR_MESSAGES[code] || String(code).replaceAll('_', ' '));
    notify(`${applied.length} email${applied.length === 1 ? '' : 's'} ${archive ? 'archived' : 'marked read'}.${failed.length ? ` ${failed.length} could not be changed. ${codes.join(' ')}` : ''}`, failed.length ? 'error' : 'success');
  } catch (error) { notify(describeError(error), 'error'); }
  finally { state.busy = false; renderMessages(); updateControls(); }
}
async function cancelBriefing() {
  if (!state.activeId || state.busy) return;
  const id = state.activeId;
  const confirmed = await confirmAction({title: 'Cancel this briefing?', description: 'Stop the briefing currently running on your homeserver?', items: [], note: 'This does not change any email. You can create another briefing afterward.', button: 'Cancel briefing'});
  if (!confirmed || state.busy || state.activeId !== id) return;
  state.busy = true; updateControls();
  try { await api(jobPath(id), {method: 'DELETE'}); await loadJob(id); notify('Briefing cancelled. Your emails are unchanged.'); }
  catch (error) { notify(describeError(error), 'error'); }
  finally { state.busy = false; updateControls(); }
}
function loadVoices() {
  if (!speech.supported) {
    $('speech-status').textContent = 'Read aloud is not available in this browser. Try a browser with speech support.';
    $('voice').disabled = true; $('speed').disabled = true; return;
  }
  const previous = $('voice').value;
  speech.voices = speechSynthesis.getVoices();
  $('voice').replaceChildren();
  const defaultOption = make('option', 'Device default voice'); defaultOption.value = ''; $('voice').append(defaultOption);
  for (const voice of speech.voices) {
    const option = make('option', `${voice.name} · ${voice.lang}${voice.localService ? ' · on device' : ''}`);
    option.value = voice.voiceURI; $('voice').append(option);
  }
  if (speech.voices.some(voice => voice.voiceURI === previous)) $('voice').value = previous;
  else {
    const preferred = speech.voices.find(voice => /^en/i.test(voice.lang) && voice.default) || speech.voices.find(voice => /^en/i.test(voice.lang));
    if (preferred) $('voice').value = preferred.voiceURI;
  }
  updateSpeechControls();
}
function speechChunks(text) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const chunks = []; let current = '';
  for (const word of words) {
    if (current.length + word.length > 220 && current) { chunks.push(current); current = ''; }
    if (word.length > 220) {
      if (current) { chunks.push(current); current = ''; }
      for (let start = 0; start < word.length; start += 220) chunks.push(word.slice(start, start + 220));
    } else current += (current ? ' ' : '') + word;
    if (current.length > 100 && /[.!?]$/.test(current)) { chunks.push(current); current = ''; }
  }
  if (current) chunks.push(current);
  return chunks;
}
function updateSpeechControls() {
  $('play').disabled = !speech.supported || (!state.current?.result?.briefing && !speech.paused);
  $('play').textContent = speech.paused ? '▶ Resume' : speech.active ? '↻ Restart' : '▶ Listen';
  $('pause').disabled = !speech.active || speech.paused;
  $('stop').disabled = !speech.active && !speech.paused;
}
function stopSpeech() {
  speech.generation++;
  speech.active = false; speech.paused = false; speech.chunks = []; speech.index = 0; speech.utterance = null;
  if (speech.supported) speechSynthesis.cancel();
  $('speech-status').textContent = speech.supported ? 'Read aloud uses the voices available on this device.' : 'Read aloud is not available in this browser.';
  updateSpeechControls();
}
function readNext(generation) {
  if (generation !== speech.generation || !speech.active || speech.paused) return;
  if (speech.index >= speech.chunks.length) {
    speech.active = false; speech.utterance = null; $('speech-status').textContent = 'Finished reading.'; updateSpeechControls(); return;
  }
  const utterance = new SpeechSynthesisUtterance(speech.chunks[speech.index]);
  const voice = speech.voices.find(item => item.voiceURI === $('voice').value);
  if (voice) { utterance.voice = voice; utterance.lang = voice.lang; } else utterance.lang = 'en';
  utterance.rate = Number($('speed').value);
  speech.utterance = utterance;
  utterance.onend = () => { if (generation === speech.generation && !speech.paused) { speech.index++; readNext(generation); } };
  utterance.onerror = event => {
    if (generation !== speech.generation || speech.paused || ['canceled', 'interrupted'].includes(event.error)) return;
    speech.active = false; speech.utterance = null;
    $('speech-status').textContent = 'Reading stopped. Tap Listen to try again, or choose another voice.'; updateSpeechControls();
  };
  $('speech-status').textContent = `${speech.label} · part ${speech.index + 1} of ${speech.chunks.length}`;
  speechSynthesis.speak(utterance);
  updateSpeechControls();
}
function speak(text, label = 'Reading briefing') {
  if (!speech.supported || !text) return;
  stopSpeech(); speech.chunks = speechChunks(text); speech.label = label; speech.active = true;
  readNext(speech.generation);
}
function pauseSpeech() {
  if (!speech.active || speech.paused) return;
  // Cancel/resume at the current short chunk also works on mobile engines that do not implement pause().
  speech.generation++; speech.paused = true; speechSynthesis.cancel(); speech.utterance = null;
  $('speech-status').textContent = 'Paused. Resume repeats the current short passage.'; updateSpeechControls();
}
$('play').addEventListener('click', () => {
  if (speech.paused) { speech.paused = false; speech.active = true; readNext(speech.generation); }
  else speak(state.current?.result?.briefing);
});
$('pause').addEventListener('click', pauseSpeech);
$('stop').addEventListener('click', stopSpeech);
$('speed').addEventListener('input', () => { $('speed-value').value = `${Number($('speed').value)}×`; });
$('voice').addEventListener('change', () => { if (speech.active || speech.paused) stopSpeech(); });
if (speech.supported) speechSynthesis.addEventListener('voiceschanged', loadVoices);
$('create-briefing').addEventListener('click', createBriefing);
$('cancel-briefing').addEventListener('click', cancelBriefing);
$('archive').addEventListener('click', () => applyAction('archive'));
$('mark-read').addEventListener('click', () => applyAction('mark_read'));
$('clear-selection').addEventListener('click', () => { state.selected.clear(); renderMessages(); updateControls(); });
$('refresh-accounts').addEventListener('click', async () => {
  $('refresh-accounts').disabled = true;
  try { await Promise.all([refreshAccounts(), refreshStatus()]); notify('Connection status refreshed. Use Test connection on an account to check its mailbox login.'); }
  catch (error) { notify(describeError(error), 'error'); }
  finally { $('refresh-accounts').disabled = false; }
});
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); const token = $('pairing-token').value; $('pairing-token').value = '';
  if (!token) return;
  try { await connectSession({token}); }
  catch (error) { showLogin(); notify(error.status === 401 ? 'Pairing was not accepted. Check your MailHarbor pairing token and try again.' : describeError(error), 'error'); }
});
$('retry-tailscale').addEventListener('click', async () => {
  try { await connectSession({tailscale: true}); }
  catch (error) { showLogin(); notify(error.status === 401 || error.status === 403 ? 'This device could not sign in through Tailscale automatically. Use the pairing token above.' : describeError(error), 'error'); }
});
function openMailFromToolbar() {
  if (!state.session || !['#accounts', '#today'].includes(location.hash)) return;
  location.hash = '#inbox';
  // Reveal the mail view before its existing search/drawer handlers run.
  setPage();
}
$('mail-search-form').addEventListener('submit', openMailFromToolbar, {capture: true});
$('mail-menu').addEventListener('click', openMailFromToolbar, {capture: true});
$('mail-refresh').addEventListener('click', openMailFromToolbar, {capture: true});
$('mail-advanced').addEventListener('click', openMailFromToolbar, {capture: true});
window.addEventListener('hashchange', setPage);
window.addEventListener('online', () => { if (state.session) { refreshStatus().catch(error => notify(describeError(error), 'error')); refreshJobs().catch(() => {}); } });
window.addEventListener('offline', () => { $('connection').textContent = 'Offline'; $('connection').className = 'connection error'; notify('You are offline. Reconnect to Tailscale to load mail or check the briefing running on your homeserver.'); });
document.addEventListener('visibilitychange', () => {
  // Briefings belong to the server session. Hiding or closing this page must never cancel one.
  if (!document.hidden && state.session) refreshJobs().catch(error => notify(describeError(error), 'error'));
});
let installPrompt;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
$('install').addEventListener('click', async () => { if (!installPrompt) return; await installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('install').hidden = true; });
window.addEventListener('appinstalled', () => { installPrompt = null; $('install').hidden = true; });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.mjs', {scope: '/', type: 'module'}).catch(() => {});
initialize();
