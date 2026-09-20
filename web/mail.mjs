import { createMailTools } from './mail-tools.mjs';
import { attachmentSize } from './mail-attachments.mjs';
import { createComposeView } from './compose.mjs';
import { createConversationView } from './mail-conversation.mjs';

const FOLDERS = [
  {id: 'inbox', label: 'Inbox', icon: 'M4 4h16v16H4z M4 13h5l2 3h2l2-3h5'},
  {id: 'all', label: 'All mail', icon: 'M4 4h16v16H4z M4 9h16 M8 13h8 M8 17h5'},
  {id: 'unread', label: 'Unread', icon: 'M3 5h18v14H3z M3 5l9 7 9-7'},
  {id: 'starred', label: 'Starred', icon: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z'},
  {id: 'sent', label: 'Sent', icon: 'm3 11 18-8-8 18-2-8-8-2z M11 13l10-10'},
  {id: 'drafts', label: 'Drafts', icon: 'M13 4H5v16h14v-8 M11 13l1-4 7-7 3 3-7 7-4 1z'},
  {id: 'archive', label: 'Archive', icon: 'M3 3h18v5H3z M5 8v13h14V8 M10 12h4'},
  {id: 'junk', label: 'Spam', icon: 'm8 3-5 5v8l5 5h8l5-5V8l-5-5z M12 7v6 M12 16v1'},
  {id: 'trash', label: 'Trash', icon: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7'}
];
const TAGS = [
  {id: 'coupons', label: 'Coupons'},
  {id: 'development', label: 'Development / GitHub'},
  {id: 'social', label: 'Social'},
  {id: 'jobs', label: 'Jobs'},
  {id: 'security', label: 'Security / Account Alerts'},
  {id: 'travel', label: 'Travel & Events'},
  {id: 'work', label: 'Work & Administration'},
  {id: 'newsletters', label: 'Newsletters'},
  {id: 'finance', label: 'Finance'},
  {id: 'invoices', label: 'Invoices', icon: 'M5 3h14v18l-3-2-4 2-4-2-3 2V3z M8 7h8 M8 11h8 M8 15h5'},
  {id: 'tenders', label: 'Tenders'},
  {id: 'appointments', label: 'Appointments'},
  {id: 'orders', label: 'Orders'}
];
const TAG_ICON = 'M3 3h8l10 10-8 8L3 11V3z M7 7h.01';
const NAV_FOLDERS = [...FOLDERS, ...TAGS.map(tag => ({id: `tag:${tag.id}`, label: tag.label, icon: tag.icon || TAG_ICON, type: 'tag'}))];
const $ = id => document.getElementById(id);
const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const addressText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(addressText).filter(Boolean).join(', ') : value && typeof value === 'object' ? [value.name, value.address].filter(item => typeof item === 'string').join(' ') : '';
const addressName = value => typeof value === 'string' ? value.split('<')[0].trim() : Array.isArray(value) ? value.map(addressName).filter(Boolean).join(', ') : value && typeof value === 'object' ? (value.name || value.address || '') : '';
const icon = path => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
};
const button = (label, onClick, className = 'subtle') => {
  const element = make('button', label, className);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
};
const iconAction = (label, path, action, className = '') => {
  const control = button('', action, `subtle mail-icon-action ${className}`.trim());
  control.append(icon(path), make('span', label, 'sr-only'));
  control.title = label; control.setAttribute('aria-label', label);
  return control;
};
const emptyState = (title, description, symbol = '✉') => {
  const element = make('div', undefined, 'mail-empty');
  const mark = make('span', symbol, 'mail-empty-symbol');
  mark.setAttribute('aria-hidden', 'true');
  element.append(mark, make('h3', title), make('p', description));
  return element;
};
function dateText(value, full = false) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return 'Date unavailable';
  if (full) return date.toLocaleString(undefined, {year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'});
  return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'}) : date.toLocaleDateString(undefined, {month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() ? {year: 'numeric'} : {})});
}

const safeStorage = {
  get: (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch {} }
};

const ALLOWED_MARK_READ_DELAYS = [0, 3000, 5000];
function clampMarkReadDelay(val) {
  const num = Number(val);
  if (Number.isFinite(num) && ALLOWED_MARK_READ_DELAYS.includes(num)) {
    return num;
  }
  return 0;
}

export function createMailView(options = {}) {
  const api = options.api;
  const describeError = options.describeError;
  const convFactory = options.conversationViewFactory || createConversationView;

  const state = {
    visible: false, initialized: false, folder: 'inbox', accountId: '', query: '',
    accounts: [], folders: [], metadataErrors: [], listErrors: [], messages: [],
    cursor: null, total: null, totalComplete: false,
    selectedId: null, selectedHeader: null, message: null,
    readerError: '', readerBusy: false, actionBusy: false,
    tagRevision: 0, tagChanges: new Map(),
    loading: false, loadingMore: false, refreshing: false, showingPreviousResults: false,
    live: false, metadataLoading: false,
    metadataLoaded: false, metadataDirty: true, metadataRevision: 0,
    pending: null, running: false, revision: 0, readerRevision: 0, session: 0,
    fingerprint: null, lastLoaded: 0,
    selection: new Set(), filters: {}, sort: 'date_desc', bodySearch: false, threaded: false,
    density: ['compact', 'default'].includes(safeStorage.get('mailharbor_density', 'default')) ? safeStorage.get('mailharbor_density', 'default') : 'default',
    readingMode: ['split', 'full'].includes(safeStorage.get('mailharbor_reading_mode', 'split')) ? safeStorage.get('mailharbor_reading_mode', 'split') : 'split',
    markReadDelay: clampMarkReadDelay(safeStorage.get('mailharbor_mark_read_delay', '0')),
    cache: null,
    savedListScroll: 0, savedReaderScroll: 0
  };

  let committedAccountId = '';
  let committedFolder = 'inbox';
  let searchCancelled = false;

  function parseMailbox(item) {
    if (!item) return null;
    if (typeof item === 'object') {
      const addr = typeof item.address === 'string' ? item.address.trim() : '';
      if (addr && addr.includes('@') && !addr.includes(' ') && !addr.includes(',')) {
        return {name: typeof item.name === 'string' ? item.name.trim() : '', address: addr};
      }
      return null;
    }
    if (typeof item === 'string') {
      const str = item.trim();
      if (!str || str.includes('\n') || str.includes(',')) return null;
      const angleMatch = str.match(/^(.*?)\s*<([^@<>\s]+@[^@<>\s]+)>$/);
      if (angleMatch) {
        const name = angleMatch[1].trim().replace(/^["']|["']$/g, '').trim();
        const address = angleMatch[2].trim();
        return {name, address};
      }
      const plainMatch = str.match(/^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z0-9-]+)$/);
      if (plainMatch) {
        return {name: '', address: plainMatch[1]};
      }
    }
    return null;
  }

  function getRecipients() {
    const result = [];
    const seen = new Set();
    const currentAcc = state.accountId;
    const messages = [...(state.messages || [])];
    if (state.message && !messages.some(m => m.id === state.message.id)) {
      messages.push(state.message);
    }

    const add = parsed => {
      if (!parsed || !parsed.address) return;
      const lower = parsed.address.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      result.push({name: parsed.name || parsed.address, address: parsed.address});
    };

    const processAddressField = val => {
      if (!val) return;
      if (Array.isArray(val)) {
        for (const item of val) add(parseMailbox(item));
      } else {
        add(parseMailbox(val));
      }
    };

    for (const m of messages) {
      if (currentAcc && m.accountId && m.accountId !== currentAcc) continue;
      processAddressField(m.author);
      processAddressField(m.from);
      processAddressField(m.sender);
      processAddressField(m.to);
      processAddressField(m.cc);
      processAddressField(m.replyTo);
    }
    return result;
  }

  const compFactory = options.composeViewFactory || createComposeView;
  const composer = compFactory({api, describeError, getRecipients, onChanged: () => requestList({refreshMetadata: true})});
  const conversation = convFactory({
    api,
    describeError,
    openCompose: ({mode, id, accountId, anchor}) => {
      const canonicalMode = (mode === 'replyAll' || mode === 'reply_all') ? 'reply_all' : mode;
      composer.open({mode: canonicalMode, id, accountId: accountId || state.accountId || undefined, anchor});
    },
    dockCompose: anchor => composer.dock?.(anchor)
  });

  const mailTools = createMailTools({
    api, describeError, state,
    refresh: opts => requestList(opts),
    renderList,
    renderReader,
    setNotice,
    openCompose: (mode, message) => composer.open({
      mode: (mode === 'reply_all' || mode === 'replyAll') ? 'reply_all' : (mode === 'draft' ? 'edit' : mode),
      id: message?.id,
      accountId: message?.accountId || state.accountId || undefined
    }),
    selectFolder: id => { state.folder = id; requestList({refreshMetadata: true}); },
    onSearchSubmit: commitSearch,
    onSearchClear: () => {
      state.query = '';
      state.filters = {};
      state.bodySearch = false;
      state.sort = 'date_desc';
      if (state.folder === 'all') state.folder = 'inbox';
      if ($('mail-search')) $('mail-search').value = '';
      requestList({refreshMetadata: false, preserveReader: false});
    }
  });

  let deleteConfirmation = null;
  let deleteControl = null;
  let deleteCancelControl = null;
  let labelControl = null;
  let labelMessageId = null;
  let labelError = '', labelFocusId = null;
  let activeListAbort = null;
  let markReadTimer = null;
  let nextSnapshotToken = 1;
  const navSnapshots = new Map();
  let currentSnapshotToken = null;
  let isReplayingHistory = false;
  let navGeneration = 0;
  let listenersAttached = false;

  function snapshotListMetadata() {
    return {
      total: state.total,
      totalComplete: state.totalComplete,
      listErrors: state.listErrors.map(error => ({...error})),
      cache: state.cache ? structuredClone(state.cache) : null
    };
  }

  function captureDepartingSnapshot() {
    if (currentSnapshotToken && navSnapshots.has(currentSnapshotToken)) {
      const snap = navSnapshots.get(currentSnapshotToken);
      if ($('mail-list-pane')) snap.scrollList = $('mail-list-pane').scrollTop;
      if ($('mail-reader')) snap.scrollReader = $('mail-reader').scrollTop;
    }
  }

  function matchesListSnapshot(snap) {
    if (!snap || snap.selectedId) return false;
    if (snap.folder !== state.folder) return false;
    if (snap.accountId !== state.accountId) return false;
    if ((snap.query || '') !== (state.query || '')) return false;
    if ((snap.sort || 'date_desc') !== (state.sort || 'date_desc')) return false;
    if (Boolean(snap.bodySearch) !== Boolean(state.bodySearch)) return false;
    if (Boolean(snap.live) !== Boolean(state.live)) return false;
    const snapFilters = snap.filters || {};
    const stateFilters = state.filters || {};
    const snapKeys = Object.keys(snapFilters);
    const stateKeys = Object.keys(stateFilters);
    if (snapKeys.length !== stateKeys.length) return false;
    for (const k of snapKeys) {
      if (String(snapFilters[k]) !== String(stateFilters[k])) return false;
    }
    return true;
  }

  let readerMessageId = null;
  let readerAccountId = null;
  let readerToolbarEl = null;
  let readerStatusEl = null;
  let readerHeadingEl = null;
  let readerAppointmentEl = null;
  let readerBodyHost = null;

  const connected = () => state.accounts.filter(account => account.connected);
  const selectedAccounts = () => connected().filter(account => !state.accountId || account.id === state.accountId);
  const accountLabel = id => {
    const account = state.accounts.find(item => item.id === id);
    return account?.label || account?.email || 'Mailbox';
  };
  const navigation = () => [...NAV_FOLDERS.map(folder => ({...folder, ...state.folders.find(item => item.id === folder.id)})),
    ...state.folders.filter(folder => folder.id.startsWith('tag:') && !NAV_FOLDERS.some(item => item.id === folder.id)).map(folder => ({...folder, icon: TAG_ICON}))];
  const labels = () => [...TAGS.map(tag => ({...tag, label: state.folders.find(folder => folder.id === `tag:${tag.id}`)?.label || tag.label})),
    ...state.folders.filter(folder => folder.id.startsWith('tag:') && !TAGS.some(tag => folder.id === `tag:${tag.id}`)).map(folder => ({id: folder.id.slice(4), label: folder.label}))];
  const folderLabel = () => navigation().find(folder => folder.id === state.folder)?.label || state.folders.find(folder => folder.id === state.folder)?.label || 'Mailbox';
  const fingerprint = accounts => JSON.stringify(accounts.map(({id, email, label, connected, archivePath, updatedAt}) => ({id, email, label, connected, archivePath, updatedAt})));

  function messageIdentityKey(m) {
    if (!m) return '';
    const acc = m.accountId || '';
    const ref = m.reference;
    if (ref) {
      if (ref.path !== undefined && ref.uidValidity !== undefined && ref.uid !== undefined) {
        return `${acc}:${ref.path}:${ref.uidValidity}:${ref.uid}`;
      }
      if (ref.path !== undefined && ref.uid !== undefined) {
        return `${acc}:${ref.path}:${ref.uid}`;
      }
      if (ref.fingerprint) {
        return `${acc}:fp:${ref.fingerprint}`;
      }
    }
    if (m.fingerprint) return `${acc}:fp:${m.fingerprint}`;
    return `${acc}:id:${m.id}`;
  }

  const errorText = error => {
    if (['stale_message', 'stale', 'invalid_cursor', 'stale_cursor', 'cursor_expired'].includes(error?.code)) return 'This mail view has expired or the message has moved. Refresh mail to get the latest view.';
    if (error?.code === 'folder_unavailable') return 'This folder is unavailable in the selected mailbox.';
    if (error?.code === 'not_found') return 'This email is no longer available. Refresh mail to get the latest view.';
    if (error?.code === 'mailbox_login_required') return 'This mailbox needs a fresh sign-in. Reconnect it in Accounts.';
    if (error?.code === 'mailbox_timeout') return 'This mailbox took too long to respond. Refresh mail to retry.';
    if (error?.code === 'mailbox_error') return 'Could not reach this mailbox. Refresh mail or check its connection in Accounts.';
    if (error?.code === 'delete_unavailable') return 'This message could not be moved to Trash safely. It may already be in Trash, or this mailbox may not support deletion here. Use your provider’s mail app.';
    if (error?.code === 'attachment_too_large') return 'This attachment is too large to download here. Download it in your provider’s mail app.';
    if (error?.code === 'attachment_unavailable') return 'This attachment is no longer available. Refresh mail and try again.';
    return describeError?.(error) || 'Could not load mail. Please try again.';
  };

  function setNotice(text, error = false) {
    $('mail-notice').textContent = text;
    $('mail-notice').className = `mail-notice${error ? ' error' : ''}`;
    $('mail-notice').hidden = !text;
  }

  function renderErrors() {
    const errors = [...state.metadataErrors, ...state.listErrors].filter(error => !state.accountId || error.accountId === state.accountId);
    const affected = [...new Set(errors.map(error => error.accountId))];
    if (!affected.length) { setNotice(''); return; }
    const detail = errors.find(error => ['authentication_failed', 'invalid_grant', 'not_configured', 'connection_error', 'timeout', 'deadline_exceeded', 'mailbox_login_required', 'mailbox_timeout', 'mailbox_error', 'stale_message'].includes(error.code));
    const explanation = detail ? errorText({code: detail.code}) : 'Refresh mail to retry, or check the connection in Accounts.';
    setNotice(`Some mail could not be loaded from ${affected.map(accountLabel).join(', ')}. ${explanation}`, true);
  }

  function renderFolders() {
    for (const target of [$('mail-folders'), $('mail-drawer-folders')]) {
      if (!target) continue;
      target.replaceChildren();
      for (const folder of navigation()) {
        const metadata = state.folders.find(item => item.id === folder.id);
        const accountIds = (metadata?.accountIds || []).filter(id => selectedAccounts().some(account => account.id === id));
        const counts = accountIds.map(id => metadata?.counts?.find(count => count.accountId === id)?.total);
        const total = counts.length && counts.every(value => Number.isSafeInteger(value) && value >= 0) ? counts.reduce((sum, value) => sum + value, 0) : null;
        if (folder.id === 'tag:coupons') target.append(make('p', 'Labels', 'mail-label-heading'));
        const folderButton = button('', () => {
          closeDrawer();
          if (state.folder === folder.id) return;
          state.folder = folder.id;
          requestList();
        }, 'mail-folder');
        folderButton.dataset.folderId = folder.id;
        folderButton.append(icon(folder.icon || TAG_ICON), make('span', folder.type === 'provider' ? `${folder.label} · ${accountLabel(folder.accountIds?.[0])}` : folder.label, 'mail-folder-label'));
        if (state.metadataLoaded && total !== null) {
          const count = make('span', total.toLocaleString(), 'mail-folder-count');
          count.setAttribute('aria-label', `${total.toLocaleString()} ${total === 1 ? 'message' : 'messages'}`);
          folderButton.append(count);
        }
        folderButton.title = folder.type === 'tag' ? `${folder.label} · MailHarbor label across your accounts` : folder.label;
        if (folder.id === state.folder) folderButton.setAttribute('aria-current', 'page');
        if (state.metadataLoaded && !accountIds.length) folderButton.classList.add('unavailable');
        target.append(folderButton);
      }
    }
    const connectionText = state.metadataLoaded ? `${connected().length} ${connected().length === 1 ? 'account' : 'accounts'} connected` : 'Connecting…';
    if ($('mail-connected')) $('mail-connected').textContent = connectionText;
    if ($('mail-drawer-connected')) $('mail-drawer-connected').textContent = connectionText;
    if ($('mail-folder-title')) $('mail-folder-title').textContent = folderLabel();
  }

  function renderAccounts() {
    for (const select of [$('mail-account'), $('mail-workspace-account'), $('mail-drawer-account')].filter(Boolean)) {
      select.replaceChildren();
      const all = make('option', 'All accounts'); all.value = ''; select.append(all);
      for (const account of connected()) {
        const opt = make('option', account.label || account.email || 'Mailbox'); opt.value = account.id; select.append(opt);
      }
      if (state.accountId && !connected().some(account => account.id === state.accountId)) state.accountId = '';
      select.value = state.accountId;
    }
  }

  function closeDrawer() {
    if ($('mail-drawer')?.open) $('mail-drawer').close();
    $('mail-menu')?.setAttribute('aria-expanded', 'false');
  }

  function openDrawer() {
    if ($('mail-drawer')?.open) return;
    $('mail-drawer')?.showModal();
    $('mail-menu')?.setAttribute('aria-expanded', 'true');
    $('mail-drawer-close')?.focus();
  }

  function renderSearchSummary() {
    const summary = $('mail-search-summary');
    if (!summary) return;
    const hasSearch = Boolean(state.query || Object.keys(state.filters).length);
    summary.hidden = !hasSearch && !state.cache;
    if (!hasSearch && !state.cache) {
      summary.replaceChildren();
      return;
    }
    summary.replaceChildren();
    const chipsWrapper = make('div', undefined, 'mail-search-chips');

    if (state.query) {
      const chip = make('span', undefined, 'mail-filter-chip');
      chip.append(make('span', `${state.bodySearch ? 'Body' : 'Search'}: “${state.query}”`));
      const remove = button('✕', () => {
        mailTools.removeCriteria('query');
      }, 'mail-chip-remove');
      remove.setAttribute('aria-label', 'Remove query filter');
      chip.append(remove);
      chipsWrapper.append(chip);
    }

    for (const [key, val] of Object.entries(state.filters)) {
      const chip = make('span', undefined, 'mail-filter-chip');
      let label = `${key}: ${val}`;
      if (key === 'unread') label = val ? 'Unread' : 'Read';
      else if (key === 'starred') label = val ? 'Starred' : 'Unstarred';
      else if (key === 'hasAttachment') label = val ? 'Has attachment' : 'No attachment';
      else if (key === 'minSize') label = `Size ≥ ${attachmentSize(val)}`;
      else if (key === 'maxSize') label = `Size ≤ ${attachmentSize(val)}`;
      chip.append(make('span', label));
      const remove = button('✕', () => {
        mailTools.removeCriteria(key);
      }, 'mail-chip-remove');
      remove.setAttribute('aria-label', `Remove ${key} filter`);
      chip.append(remove);
      chipsWrapper.append(chip);
    }

    if (state.accountId) {
      const scopeChip = make('span', `Account: ${accountLabel(state.accountId)}`, 'mail-filter-chip mail-chip-scope');
      chipsWrapper.append(scopeChip);
    }
    if (state.folder && state.folder !== 'inbox') {
      const folderChip = make('span', `Folder: ${folderLabel()}`, 'mail-filter-chip mail-chip-scope');
      chipsWrapper.append(folderChip);
    }

    if (hasSearch) {
      const clearBtn = button('Clear all', () => mailTools.clearFilters(), 'subtle mail-clear-all-chip');
      chipsWrapper.append(clearBtn);
    }

    if (state.cache) {
      const parts = [];
      const cov = state.cache.coverage;
      if (state.cache.refreshing) {
        parts.push('Refreshing…');
      }
      if (cov?.status === 'warming') {
        parts.push('Warming cache…');
      } else {
        if (cov?.cached !== undefined) parts.push(`${cov.cached} cached`);
        if (state.cache.lastSuccessfulSync) parts.push(`Last successful refresh ${dateText(state.cache.lastSuccessfulSync)}`);
        if (cov?.limited || cov?.status === 'partial') parts.push('Partial coverage');
      }
      const cacheNote = make('span', `Cached: ${parts.join(' · ')}`, 'fineprint mail-cache-note');
      chipsWrapper.append(cacheNote);

      const isEligibleSimpleInbox = state.folder === 'inbox' &&
        (!state.sort || state.sort === 'date_desc') &&
        !state.query &&
        Object.keys(state.filters || {}).length === 0 &&
        !state.bodySearch;

      if (state.cache.providerFallback && isEligibleSimpleInbox) {
        const browseOlder = button('Browse older mail', () => {
          state.live = true;
          state.cursor = null;
          requestList({preserveReader: true, isBrowseOlder: true});
        }, 'subtle mail-chip-browse-older');
        chipsWrapper.append(browseOlder);
      }
    }

    summary.append(chipsWrapper);
  }

  function renderControls() {
    $('mail-refresh').disabled = state.loading || state.loadingMore || state.refreshing;
    $('mail-refresh').textContent = state.loading || state.loadingMore || state.refreshing ? '…' : '↻';
    $('mail-refresh').setAttribute('aria-label', state.loading || state.loadingMore || state.refreshing ? 'Refreshing mail' : 'Refresh mail');
    $('mail-more').hidden = !state.cursor || state.loading;
    $('mail-more').disabled = state.loadingMore;
    $('mail-more').textContent = state.loadingMore ? 'Loading…' : 'Load more';
    $('mail-list').setAttribute('aria-busy', String(state.loading || state.loadingMore || state.refreshing));
    const loaded = state.messages.length.toLocaleString();
    $('mail-list-count').textContent = state.showingPreviousResults ? 'Previous results · Loading…' : state.loading && !state.refreshing ? 'Loading…' : state.totalComplete && state.total !== null ? `${loaded} of ${state.total.toLocaleString()} messages` : `${loaded} messages loaded${state.listErrors.length ? ' · partial results' : ''}`;

    renderSearchSummary();
    mailTools.render($('mail-tools'), {settingsHost: $('mail-tools-settings'), advancedButton: $('mail-advanced'), selectionHost: $('mail-folder-selection')});

    $('mail-page')?.classList.toggle('mail-density-compact', state.density === 'compact');
    $('mail-page')?.classList.toggle('mail-reading-full', state.readingMode === 'full');
    if ($('mail-density-setting')) $('mail-density-setting').value = state.density;
    if ($('mail-reading-mode-setting')) $('mail-reading-mode-setting').value = state.readingMode;
    if ($('mail-mark-read-setting')) $('mail-mark-read-setting').value = String(state.markReadDelay);
  }

  function cancelActiveSearch() {
    if (activeListAbort) {
      activeListAbort.abort();
      activeListAbort = null;
    }
    state.revision++;
    state.pending = null;
    state.loading = false;
    state.loadingMore = false;
    state.refreshing = false;
    state.showingPreviousResults = false;
    searchCancelled = true;
    renderList();
  }

  function retrySearch() {
    searchCancelled = false;
    requestList({refreshMetadata: false, preserveReader: true});
  }

  function renderList() {
    renderFolders(); renderControls();
    const list = $('mail-list');
    list.replaceChildren();

    if (state.refreshing) {
      list.classList.add('mail-refreshing');
      const refreshingBar = make('div', 'Refreshing mailbox…', 'mail-refreshing-bar');
      refreshingBar.setAttribute('role', 'status');
      list.append(refreshingBar);
    } else {
      list.classList.remove('mail-refreshing');
    }

    if (state.showingPreviousResults) {
      const prevBar = make('div', undefined, 'mail-previous-results-bar');
      prevBar.setAttribute('role', 'status');
      prevBar.append(make('span', 'Showing previous results while searching… '));
      const cancelBtn = button('Cancel search', cancelActiveSearch, 'subtle');
      prevBar.append(cancelBtn);
      list.append(prevBar);
    }

    if (searchCancelled) {
      const cancelBar = make('div', undefined, 'mail-error-bar mail-cancel-bar');
      cancelBar.setAttribute('role', 'status');
      cancelBar.append(make('span', 'Search cancelled. '));
      const retryBtn = button('Retry', retrySearch, 'subtle');
      cancelBar.append(retryBtn);
      list.append(cancelBar);
    }

    if (state.listErrors.length > 0 && state.messages.length > 0) {
      const errorBar = make('div', undefined, 'mail-error-bar');
      errorBar.setAttribute('role', 'alert');
      errorBar.append(make('span', `Could not update mail: ${errorText(state.listErrors[0])} `));
      const retryBtn = button('Retry', () => {
        state.listErrors = [];
        requestList({isRefresh: true, preserveReader: true});
      });
      const cancelBtn = button('Cancel', () => {
        state.listErrors = [];
        state.showingPreviousResults = false;
        renderList();
      });
      errorBar.append(retryBtn, cancelBtn);
      list.append(errorBar);
    }

    if (state.loading && !state.messages.length && !state.refreshing) {
      const loading = emptyState('Bringing your mail together…', 'Checking your selected mailboxes. Large folders can take a little longer.', '◌');
      loading.classList.add('mail-loading');
      const cancelBtn = button('Cancel search', cancelActiveSearch, 'subtle');
      loading.append(cancelBtn);
      list.append(loading);
      return;
    }

    if (!state.messages.length && !state.refreshing && !state.showingPreviousResults) {
      if (state.listErrors.length) {
        const empty = emptyState('Mail is temporarily unavailable.', 'Check the connection details above, then try refreshing.');
        empty.append(button('Try again', () => requestList({refreshMetadata: true}))); list.append(empty);
      } else if (!connected().length) {
        const empty = emptyState('Your inbox starts here.', 'Connect a mailbox to see your mail in one place.');
        const link = make('a', 'Connect an account →'); link.href = '#accounts'; empty.append(link); list.append(empty);
      } else if (state.metadataLoaded && !state.folders.find(folder => folder.id === state.folder)?.accountIds?.some(id => !state.accountId || id === state.accountId)) {
        list.append(emptyState(`No ${folderLabel().toLowerCase()} folder available.`, 'The selected accounts do not have this folder available. Choose another folder or account.'));
      } else if (state.query || Object.keys(state.filters).length) {
        const empty = emptyState('No matching messages.', 'Try another sender, recipient or subject, or clear your search.');
        empty.append(button('Clear search', () => mailTools.clearFilters())); list.append(empty);
      } else if (state.folder.startsWith('tag:')) list.append(emptyState(`No messages labeled ${folderLabel()}.`, 'Add this label to a message to see it here across your accounts.'));
      else list.append(emptyState(`Your ${folderLabel().toLowerCase()} is clear.`, 'There are no messages in this view. Refresh mail to check for anything new.'));
      return;
    }

    for (const message of state.messages) {
      const item = make('div', undefined, 'mail-row-container');
      if (state.refreshing) item.classList.add('mail-row-refreshing');
      if (state.showingPreviousResults) item.classList.add('mail-row-previous');
      const selection = make('input'); selection.type = 'checkbox'; selection.checked = state.selection.has(message.id);
      selection.setAttribute('aria-label', `Select ${message.subject || 'message'}`);
      selection.addEventListener('change', () => {
        if (selection.checked && state.selection.size >= 50) { selection.checked = false; setNotice('Select up to 50 messages at a time.', true); return; }
        if (selection.checked) state.selection.add(message.id); else state.selection.delete(message.id);
        renderControls();
      });

      const row = button('', () => openMessage(message), `mail-row${message.unread ? ' unread' : ''}${message.id === state.selectedId ? ' selected' : ''}`);
      row.dataset.messageId = message.id;
      if (message.id === state.selectedId) row.setAttribute('aria-current', 'true');

      const top = make('div', undefined, 'mail-row-top');
      const authorName = addressName(message.author) || addressText(message.author) || 'Unknown sender';
      const authorEl = make('span', authorName, 'mail-row-author');
      const authorFull = addressText(message.author);
      if (authorFull) authorEl.title = authorFull;
      top.append(authorEl, make('time', dateText(message.date), 'mail-row-date'));

      const subject = make('div', undefined, 'mail-row-subject');
      const dot = make('span', message.unread ? '●' : '', 'mail-unread-dot'); dot.setAttribute('aria-label', message.unread ? 'Unread' : 'Read');
      subject.append(dot, make('span', message.subject || '(No subject)'));

      if (message.snippet) {
        const snip = make('span', ` · ${message.snippet}`, 'mail-row-snippet');
        subject.append(snip);
      }

      const meta = make('div', undefined, 'mail-row-meta');
      meta.append(make('span', accountLabel(message.accountId), 'mail-account-badge'));
      for (const tag of labels().filter(tag => message.tags?.includes(tag.id))) meta.append(make('span', tag.label, 'mail-tag-badge'));

      if (Array.isArray(message.attachments) && message.attachments.length) {
        const chipCount = message.attachments.length;
        const chipLabel = chipCount === 1 ? `📎 ${message.attachments[0].filename || 'file'}` : `📎 ${chipCount} files`;
        meta.append(make('span', chipLabel, 'mail-tag-badge mail-att-chip'));
      } else if (message.hasAttachments) {
        meta.append(make('span', 'Attachment', 'mail-tag-badge'));
      }

      if (message.starred) {
        const star = make('span', '★', 'mail-star');
        star.setAttribute('aria-label', 'Starred');
        meta.append(star);
      }

      const quickActions = make('div', undefined, 'mail-row-quick-actions');
      const starBtn = button(message.starred ? '★' : '☆', event => {
        event.stopPropagation();
        void applyAction(message.starred ? 'unstar' : 'star', undefined, message.id);
      }, 'subtle mail-quick-star');
      starBtn.title = message.starred ? 'Unstar' : 'Star';
      starBtn.setAttribute('aria-label', starBtn.title);

      const archiveBtn = button('📦', event => {
        event.stopPropagation();
        void applyAction('archive', undefined, message.id);
      }, 'subtle mail-quick-archive');
      archiveBtn.title = 'Archive';
      archiveBtn.setAttribute('aria-label', 'Archive');

      quickActions.append(starBtn, archiveBtn);
      row.append(top, subject, meta);
      item.append(selection, row, quickActions); list.append(item);
    }
  }

  function resetReader() {
    closeLabels(false);
    mailTools.clearReader();
    conversation.reset();
    readerBodyHost = null;
    readerMessageId = null;
    readerAccountId = null;
    readerToolbarEl = null;
    readerStatusEl = null;
    readerHeadingEl = null;
    readerAppointmentEl = null;
    deleteConfirmation = null;
    clearTimeout(markReadTimer);
    markReadTimer = null;
    state.readerRevision++;
    state.selectedId = null;
    state.selectedHeader = null;
    state.message = null;
    state.readerBusy = false;
    state.readerError = '';
    $('mail-page')?.classList.remove('mail-reading');
    const reader = $('mail-reader-content');
    if (reader) reader.replaceChildren();
    if (state.readingMode !== 'full') {
      reader?.append(emptyState('A little room to read.', 'Choose a message to open it here. Opening a message keeps its read status unchanged.'));
    }
  }

  function backToList({fromHistory = false} = {}) {
    if (!fromHistory) {
      captureDepartingSnapshot();
      ++navGeneration;
    }
    const id = state.selectedId;

    let listToken = null;
    for (const [t, snap] of navSnapshots) {
      if (matchesListSnapshot(snap)) {
        listToken = t;
        break;
      }
    }
    if (!listToken) {
      listToken = `snap-${nextSnapshotToken++}`;
      navSnapshots.set(listToken, {
        folder: state.folder,
        accountId: state.accountId,
        query: state.query,
        filters: {...state.filters},
        sort: state.sort,
        bodySearch: state.bodySearch,
        live: Boolean(state.live),
        selectedId: null,
        messages: [...state.messages],
        cursor: state.cursor,
        ...snapshotListMetadata(),
        scrollList: $('mail-list-pane')?.scrollTop ?? 0,
        scrollReader: 0
      });
      while (navSnapshots.size > 50) navSnapshots.delete(navSnapshots.keys().next().value);
    }

    if (!fromHistory && typeof history !== 'undefined' && history.pushState) {
      history.pushState({snapshotToken: listToken, messageId: null}, '', `#${state.folder}`);
    }
    currentSnapshotToken = listToken;

    resetReader();
    renderList();

    const listSnap = navSnapshots.get(listToken);
    if (listSnap && $('mail-list-pane')) {
      $('mail-list-pane').scrollTop = listSnap.scrollList || 0;
    }
    if (id) {
      [...($('mail-list')?.querySelectorAll('[data-message-id]') || [])].find(row => row.dataset.messageId === id)?.focus();
    }
  }

  function closeLabels(restoreFocus = true) {
    labelMessageId = null;
    labelError = ''; labelFocusId = null;
    if ($('mail-label-dialog')?.open) $('mail-label-dialog').close();
    $('mail-label-options')?.replaceChildren();
    if (restoreFocus) {
      if (labelControl && !labelControl.disabled) labelControl.focus();
      else $('mail-reader')?.focus({preventScroll: true});
    }
  }

  function renderLabels() {
    if (!labelMessageId || labelMessageId !== state.selectedId) return;
    const message = state.message || state.messages.find(item => item.id === labelMessageId) || state.selectedHeader;
    const focusedTag = document.activeElement?.dataset?.tagId || labelFocusId;
    if (focusedTag && state.actionBusy) $('mail-label-close')?.focus();
    const options = $('mail-label-options');
    if (!options) return;
    options.replaceChildren();
    for (const tag of labels()) {
      const enabled = Boolean(message?.tags?.includes(tag.id));
      const targetId = labelMessageId;
      const toggle = button(tag.label, () => {
        if (targetId === state.selectedId && targetId === labelMessageId) { labelFocusId = tag.id; void applyTag(tag.id, !enabled); }
      }, 'subtle mail-tag-toggle');
      toggle.dataset.tagId = tag.id;
      toggle.setAttribute('aria-label', tag.label);
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.disabled = state.actionBusy;
      options.append(toggle);
      if (focusedTag === tag.id && !toggle.disabled) toggle.focus();
    }
    if ($('mail-label-status')) {
      $('mail-label-status').textContent = state.actionBusy ? 'Saving label…' : labelError || 'Changes are saved automatically.';
      $('mail-label-status').className = labelError ? 'fineprint error' : 'fineprint';
    }
  }

  function openLabels() {
    if (!state.selectedId) return;
    labelMessageId = state.selectedId;
    renderLabels();
    if (!$('mail-label-dialog')?.open) $('mail-label-dialog')?.showModal();
    $('mail-label-close')?.focus();
  }

  function renderReaderToolbar(toolbar) {
    toolbar.replaceChildren();
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Message actions');
    toolbar.append(iconAction('Back', 'M19 12H5 M11 6l-6 6 6 6', backToList, 'mail-back'));

    const currentIdx = state.messages.findIndex(m => m.id === state.selectedId);
    const prevMsgBtn = iconAction('Previous message', 'M15 18l-6-6 6-6', () => navigateMessage(-1), 'mail-nav-prev');
    const nextMsgBtn = iconAction('Next message', 'M9 18l6-6-6-6', () => navigateMessage(1), 'mail-nav-next');
    prevMsgBtn.disabled = currentIdx <= 0;
    nextMsgBtn.disabled = currentIdx < 0 || currentIdx >= state.messages.length - 1;
    toolbar.append(prevMsgBtn, nextMsgBtn);

    const message = state.message || state.messages.find(item => item.id === state.selectedId) || state.selectedHeader;
    if (message) {
      const read = iconAction(message.unread ? 'Mark read' : 'Mark unread', 'M3 5h18v14H3z M3 5l9 7 9-7', () => applyAction(message.unread ? 'mark_read' : 'mark_unread'));
      const star = iconAction(message.starred ? '★ Starred' : '☆ Star', FOLDERS.find(folder => folder.id === 'starred').icon, () => applyAction(message.starred ? 'unstar' : 'star'));
      const remove = iconAction('Delete', FOLDERS.find(folder => folder.id === 'trash').icon, requestDelete, 'mail-delete');
      labelControl = iconAction('Labels', TAG_ICON, openLabels);
      labelControl.setAttribute('aria-haspopup', 'dialog');
      labelControl.setAttribute('aria-controls', 'mail-label-dialog');
      labelControl.disabled = state.actionBusy;
      deleteControl = remove;
      remove.title = 'Move to Trash in the original mailbox';
      star.setAttribute('aria-pressed', String(Boolean(message.starred)));
      read.disabled = star.disabled = remove.disabled = state.actionBusy || state.readerBusy || Boolean(state.readerError) || Boolean(deleteConfirmation);
      if (state.message && !state.readerBusy && !state.readerError) {
        const operations = make('div', undefined, 'mail-reader-operations');
        mailTools.renderReader(operations, state.message); toolbar.append(operations);
      }
      toolbar.append(labelControl, read, star, remove);
    }
  }

  function renderReaderStatus(statusContainer) {
    statusContainer.replaceChildren();
    if (deleteConfirmation?.id === state.selectedId) {
      const target = deleteConfirmation;
      const confirmation = make('section', undefined, 'mail-delete-confirmation');
      confirmation.setAttribute('role', 'group');
      confirmation.setAttribute('aria-label', 'Confirm deletion');
      confirmation.setAttribute('aria-describedby', 'mail-delete-explanation');
      const explanation = make('p', 'Move this message to Trash in the original mailbox? This also removes it from its current folder in your other mail apps.');
      explanation.id = 'mail-delete-explanation';
      const controls = make('div', undefined, 'mail-delete-confirmation-controls');
      const move = button(state.actionBusy ? 'Moving…' : 'Move to Trash', () => applyAction('delete', target), 'mail-delete-confirm');
      const cancel = button('Cancel', () => cancelDelete(target));
      move.disabled = cancel.disabled = state.actionBusy;
      deleteCancelControl = cancel;
      controls.append(move, cancel); confirmation.append(explanation, controls);
      statusContainer.append(confirmation);
    }

    if (state.readerBusy) {
      statusContainer.append(emptyState('Opening your message…', 'Fetching its text from the original mailbox.', '◌'));
    } else if (state.readerError) {
      const error = make('p', state.readerError, 'mail-reader-error');
      error.setAttribute('role', 'alert');
      statusContainer.append(error, button('Refresh mail', () => requestList({refreshMetadata: true})));
    }
  }

  function renderReaderHeading(headingContainer) {
    headingContainer.replaceChildren();
    const message = state.message || state.messages.find(item => item.id === state.selectedId) || state.selectedHeader;
    if (!message) return;

    const heading = make('div', undefined, 'mail-message-heading');
    const meta = make('div', undefined, 'mail-message-meta');
    meta.append(make('span', accountLabel(message.accountId), 'mail-account-badge'), make('span', message.unread ? 'Unread' : 'Read', 'mail-read-state'));
    for (const tag of labels().filter(tag => message.tags?.includes(tag.id))) meta.append(make('span', tag.label, 'mail-tag-badge'));

    heading.append(make('h2', message.subject || '(No subject)'), meta);

    const senderLine = make('div', undefined, 'mail-reader-sender-line');
    const authorName = addressName(message.author) || addressText(message.author) || 'Unknown sender';
    const authorEl = make('span', authorName, 'mail-reader-author');
    const fullAuthor = addressText(message.author);
    if (fullAuthor && fullAuthor !== authorName) {
      authorEl.append(make('span', ` <${fullAuthor.replace(/.*<([^>]+)>.*/, '$1')}>`, 'fineprint mail-reader-author-email'));
    }
    senderLine.append(authorEl, make('time', dateText(message.date, true), 'mail-reader-date'));
    heading.append(senderLine);

    if (message.to || message.cc) {
      const recipLine = make('div', undefined, 'mail-reader-recipients');
      if (message.to) recipLine.append(make('span', `To: ${addressText(message.to)}`, 'mail-reader-to'));
      if (message.cc) recipLine.append(make('span', `Cc: ${addressText(message.cc)}`, 'mail-reader-cc'));
      heading.append(recipLine);
    }

    const extraDetails = make('details', undefined, 'mail-envelope-details');
    extraDetails.append(make('summary', 'Message details'));
    const extraFields = make('dl', undefined, 'mail-message-details');
    for (const [label, value] of [
      ['From', addressText(message.author) || 'Unknown sender'],
      ['To', addressText(message.to)],
      ['Cc', addressText(message.cc)],
      ['Reply-To', addressText(message.replyTo)],
      ['Date', dateText(message.date, true)],
      ['Folder', message.folderPath],
      ['Account', accountLabel(message.accountId)]
    ]) {
      if (value) extraFields.append(make('dt', label), make('dd', value));
    }
    extraDetails.append(extraFields);
    heading.append(extraDetails);

    const toggleConversation = button(state.threaded ? 'Show single message' : 'Show conversation', () => {
      state.threaded = !state.threaded;
      renderList();
      renderReader();
    }, 'subtle mail-toggle-conversation');
    toggleConversation.setAttribute('aria-pressed', String(state.threaded));
    heading.append(toggleConversation);

    if (message.attachments?.length > 0 || message.hasAttachments) {
      const jump = button('Jump to attachments', () => conversation.scrollAttachments(), 'subtle mail-jump-attachments');
      heading.append(jump);
    }

    headingContainer.append(heading);
    renderLabels();
  }

  function renderReaderAppointment(appointmentContainer) {
    appointmentContainer.replaceChildren();
    if (!state.message?.appointment) return;
    const appointment = state.message.appointment;
    const start = appointment?.start ? new Date(appointment.start).getTime() : NaN;
    const end = appointment?.end ? new Date(appointment.end).getTime() : NaN;
    const allDay = /^\d{4}-\d{2}-\d{2}$/u.test(appointment?.start || '') && /^\d{4}-\d{2}-\d{2}$/u.test(appointment?.end || '');
    if (Number.isFinite(start) && Number.isFinite(end) && (end > start || (allDay && end === start)) && typeof appointment.title === 'string' && appointment.title.trim()) {
      const event = make('section', undefined, 'mail-appointment');
      const calendarDate = value => new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric'});
      const when = allDay ? `All day · ${calendarDate(appointment.start)}${appointment.end === appointment.start ? '' : ` – ${calendarDate(appointment.end)}`}` : `${dateText(appointment.start, true)} – ${dateText(appointment.end, true)}`;
      event.append(make('h3', appointment.title), make('p', when));
      if (typeof appointment.location === 'string' && appointment.location) event.append(make('p', appointment.location));
      const calendar = make('a', 'Add to calendar', 'mail-calendar-link');
      calendar.href = `/api/mail/calendar?id=${encodeURIComponent(state.selectedId)}`;
      calendar.setAttribute('download', 'appointment.ics');
      event.append(calendar, make('p', 'Download the appointment and open it in your calendar to check the details and add it.', 'fineprint'));
      appointmentContainer.append(event);
    }
  }

  function renderReader() {
    deleteControl = deleteCancelControl = null;
    const reader = $('mail-reader-content');
    if (!reader) return;
    $('mail-reader')?.setAttribute('aria-busy', String(state.readerBusy || state.actionBusy));

    if (!state.selectedId) {
      if (readerBodyHost) {
        conversation.reset();
        readerBodyHost = null;
      }
      readerMessageId = null;
      readerAccountId = null;
      readerToolbarEl = null;
      readerStatusEl = null;
      readerHeadingEl = null;
      readerAppointmentEl = null;
      reader.replaceChildren();
      if (state.readingMode !== 'full') {
        reader.append(emptyState('A little room to read.', 'Choose a message to open it here. Opening a message keeps its read status unchanged.'));
      }
      return;
    }

    const currentMessageId = state.selectedId;
    const currentAccountId = state.message?.accountId || state.selectedHeader?.accountId || state.accountId || '';
    const isSameHost = readerBodyHost && readerMessageId === currentMessageId && readerAccountId === currentAccountId;

    if (!isSameHost) {
      conversation.reset();
      readerMessageId = currentMessageId;
      readerAccountId = currentAccountId;
      reader.replaceChildren();

      readerToolbarEl = make('div', undefined, 'mail-reader-toolbar');
      readerStatusEl = make('div', undefined, 'mail-reader-status-container');
      readerHeadingEl = make('div', undefined, 'mail-reader-heading-container');
      readerAppointmentEl = make('div', undefined, 'mail-reader-appointment-container');
      readerBodyHost = make('div', undefined, 'mail-conversation-host');

      reader.append(readerToolbarEl, readerStatusEl, readerHeadingEl, readerAppointmentEl, readerBodyHost);
    }

    renderReaderToolbar(readerToolbarEl);
    renderReaderStatus(readerStatusEl);
    renderReaderHeading(readerHeadingEl);
    renderReaderAppointment(readerAppointmentEl);

    if (state.message && !state.readerBusy && !state.readerError) {
      readerBodyHost.hidden = false;
      conversation.render(readerBodyHost, state.message, {threaded: state.threaded === true});
    } else {
      composer.dock?.();
      readerBodyHost.hidden = true;
    }
  }

  function navigateMessage(direction) {
    const idx = state.messages.findIndex(m => m.id === state.selectedId);
    const targetIdx = idx + direction;
    if (targetIdx >= 0 && targetIdx < state.messages.length) {
      openMessage(state.messages[targetIdx]);
    }
  }

  async function openMessage(message, {fromSnapshot = false} = {}) {
    if (!fromSnapshot) {
      captureDepartingSnapshot();
      ++navGeneration;
    }
    closeLabels(false);
    mailTools.clearReader();
    deleteConfirmation = null;
    clearTimeout(markReadTimer);
    markReadTimer = null;

    const revision = ++state.readerRevision;
    const session = state.session;
    const tagRevision = state.tagRevision;
    state.selectedId = message.id;
    state.selectedHeader = {...message};
    state.message = null;
    state.readerError = '';
    state.readerBusy = true;

    $('mail-page')?.classList.add('mail-reading');
    renderList();
    renderReader();
    $('mail-reader')?.focus({preventScroll: true});
    if (!fromSnapshot) updateHash(message.id);
    if ($('mail-reader') && !fromSnapshot) $('mail-reader').scrollTop = 0;

    try {
      const data = await api('/api/mail/message', {method: 'POST', body: {id: message.id}, timeout: 130000});
      if (session !== state.session || revision !== state.readerRevision) return;
      if (!data?.message) throw new Error('The server did not return this message. Refresh mail to try again.');
      const changedTags = state.tagChanges.get(message.id);
      state.message = {...data.message, ...(changedTags?.revision > tagRevision ? {tags: changedTags.tags} : {})};
      state.messages = state.messages.map(item => item.id === message.id ? {...item, unread: data.message.unread, starred: data.message.starred, tags: state.message.tags || []} : item);

      if (state.markReadDelay > 0 && state.message.unread) {
        scheduleMarkRead(message.id, state.message.accountId);
      }
    } catch (error) {
      if (session === state.session && revision === state.readerRevision) state.readerError = errorText(error);
    } finally {
      if (session === state.session && revision === state.readerRevision) {
        state.readerBusy = false;
        renderReader();
        renderList();
        // The loaded envelope/body replaces the loading view. Start a fresh
        // navigation at its heading after that layout change as well.
        if (!fromSnapshot && $('mail-reader')) $('mail-reader').scrollTop = 0;
      }
    }
  }

  function scheduleMarkRead(messageId, accountId) {
    clearTimeout(markReadTimer);
    markReadTimer = null;
    if (state.markReadDelay <= 0) return;
    if (!state.visible) return;
    if (typeof document !== 'undefined' && (document.visibilityState === 'hidden' || document.hidden === true)) return;

    const scheduledSession = state.session;
    const scheduledRevision = state.readerRevision;
    const scheduledId = messageId;
    const scheduledAccountId = accountId;

    markReadTimer = setTimeout(() => {
      markReadTimer = null;
      if (
        state.visible &&
        state.session === scheduledSession &&
        state.readerRevision === scheduledRevision &&
        state.selectedId === scheduledId &&
        (state.message?.accountId || state.selectedHeader?.accountId) === scheduledAccountId &&
        state.message?.id === scheduledId &&
        state.message?.unread &&
        (typeof document === 'undefined' || (document.visibilityState !== 'hidden' && document.hidden !== true))
      ) {
        void applyAction('mark_read');
      }
    }, state.markReadDelay);
  }

  async function loadMetadata() {
    const session = state.session;
    const revision = ++state.metadataRevision;
    const tagRevision = state.tagRevision;
    const data = await api('/api/mail/folders', {timeout: 130000});
    if (session !== state.session || revision !== state.metadataRevision) return;
    state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    let folders = Array.isArray(data.folders) ? data.folders : [];
    if (tagRevision !== state.tagRevision) {
      const currentLabels = state.folders.filter(folder => TAGS.some(tag => folder.id === `tag:${tag.id}`));
      folders = [...folders.filter(folder => !currentLabels.some(label => label.id === folder.id)), ...currentLabels];
    }
    state.folders = folders;
    state.metadataErrors = Array.isArray(data.errors) ? data.errors : [];
    state.metadataLoaded = true;
    state.metadataDirty = false;
    renderAccounts();
    renderFolders();
  }

  async function refreshCounts() {
    const session = state.session;
    state.metadataDirty = true;
    try { await loadMetadata(); }
    catch { if (session === state.session) state.metadataDirty = true; }
  }

  async function applyTag(tag, enabled) {
    if (state.actionBusy || !state.selectedId) return;
    const id = state.selectedId;
    const session = state.session;
    deleteConfirmation = null;
    labelError = '';
    state.actionBusy = true; renderReader(); setNotice('');
    try {
      const data = await api('/api/mail/tags', {method: 'POST', body: {id, tag, enabled}, timeout: 130000});
      if (session !== state.session) return;
      const tags = labels().filter(item => data.tags?.includes(item.id)).map(item => item.id);
      state.tagChanges.set(id, {revision: ++state.tagRevision, tags});
      if (state.tagChanges.size > 5000) state.tagChanges.delete(state.tagChanges.keys().next().value);
      state.messages = state.messages.map(message => message.id === id ? {...message, tags} : message);
      if (state.selectedHeader?.id === id) state.selectedHeader.tags = tags;
      if (state.message?.id === id) state.message.tags = tags;
      const updatedFolders = Array.isArray(data.folders) ? data.folders.filter(folder => labels().some(item => folder.id === `tag:${item.id}`)) : [];
      if (updatedFolders.length) {
        for (const folder of updatedFolders) {
          state.folders = [...state.folders.filter(item => item.id !== folder.id), folder];
        }
        renderFolders();
      }
      if (state.folder.startsWith('tag:')) requestList({refreshMetadata: !updatedFolders.length, preserveReader: true});
      else if (!updatedFolders.length) void refreshCounts();
      setNotice(`${labels().find(item => item.id === tag)?.label || 'Mail'} label ${enabled ? 'added' : 'removed'}.`);
    } catch (error) { if (session === state.session) { if (labelMessageId === id) labelError = errorText(error); setNotice(errorText(error), true); } }
    finally { if (session === state.session) { state.actionBusy = false; renderReader(); renderList(); } }
  }

  function requestDelete() {
    if (state.actionBusy || state.readerBusy || state.readerError || !state.message) return;
    deleteConfirmation = {id: state.selectedId, session: state.session, readerRevision: state.readerRevision};
    renderReader(); deleteCancelControl?.focus();
  }

  function cancelDelete(target = deleteConfirmation) {
    if (state.actionBusy || target !== deleteConfirmation) return;
    deleteConfirmation = null; renderReader(); deleteControl?.focus();
  }

  async function applyAction(action, confirmation, targetId = state.selectedId) {
    if (state.actionBusy) return;
    if (action === 'delete' && (!confirmation || confirmation !== deleteConfirmation || confirmation.id !== state.selectedId || confirmation.session !== state.session || confirmation.readerRevision !== state.readerRevision)) return;
    const id = targetId;
    const session = state.session;
    state.actionBusy = true; renderReader(); setNotice('');
    try {
      const result = await api('/api/mail/action', {method: 'POST', body: {id, action}, timeout: 190000});
      if (session !== state.session) return;
      if (action === 'delete') {
        if (result?.undoToken) mailTools.setUndo([result.undoToken]);
        requestList({refreshMetadata: true, preserveReader: state.selectedId !== id});
        setNotice('Moved to Trash in the original mailbox.');
        return;
      }
      if (action === 'archive') {
        if (result?.undoToken) mailTools.setUndo([result.undoToken]);
        state.messages = state.messages.filter(message => message.id !== id);
        if (state.selectedId === id) resetReader();
        if (state.totalComplete && state.total !== null) state.total = Math.max(0, state.total - 1);
        void refreshCounts();
        setNotice('Archived in the original mailbox.');
        return;
      }
      const patch = action === 'mark_read' ? {unread: false} : action === 'mark_unread' ? {unread: true} : {starred: action === 'star'};
      state.messages = state.messages.map(message => message.id === id ? {...message, ...patch} : message);
      if (state.selectedHeader?.id === id) Object.assign(state.selectedHeader, patch);
      if (state.message?.id === id) Object.assign(state.message, patch);
      const removed = (state.folder === 'unread' && action === 'mark_read') || (state.folder === 'starred' && action === 'unstar');
      if (removed) { state.messages = state.messages.filter(message => message.id !== id); if (state.selectedId === id) resetReader(); }
      if (removed && state.totalComplete && state.total !== null) state.total = Math.max(0, state.total - 1);
      void refreshCounts();
      setNotice(action === 'mark_read' ? 'Marked read in the original mailbox.' : action === 'mark_unread' ? 'Marked unread in the original mailbox.' : action === 'star' ? 'Star added in the original mailbox.' : 'Star removed in the original mailbox.');
    } catch (error) { if (session === state.session) setNotice(errorText(error), true); }
    finally {
      if (session === state.session) {
        if (deleteConfirmation === confirmation) deleteConfirmation = null;
        state.actionBusy = false; renderReader(); renderList();
      }
    }
  }

  function commitSearch({query, filters, bodySearch, sort, allFolders} = {}) {
    const searchInput = $('mail-search');
    const committedQuery = query !== undefined ? query : (searchInput ? searchInput.value.trim() : state.query);
    state.query = committedQuery;
    if (searchInput && searchInput.value !== committedQuery) searchInput.value = committedQuery;
    if (filters !== undefined) state.filters = filters;
    if (bodySearch !== undefined) state.bodySearch = Boolean(bodySearch);
    if (sort !== undefined) state.sort = sort;
    if (allFolders !== undefined) {
      if (allFolders && state.folder !== 'all') state.folder = 'all';
      else if (!allFolders && state.folder === 'all') state.folder = 'inbox';
    }
    requestList({refreshMetadata: false, preserveReader: false});
  }

  function clearSearch() {
    mailTools.clearFilters();
  }

  function requestList({append = false, refreshMetadata = false, preserveReader = false, isRefresh = false, isBrowseOlder = false} = {}) {
    if (append && (!state.cursor || state.loading || state.loadingMore)) return;

    const scopeChanged = state.accountId !== committedAccountId || state.folder !== committedFolder;
    if (scopeChanged) {
      committedAccountId = state.accountId;
      committedFolder = state.folder;
      state.messages = [];
      state.selection.clear();
      state.cursor = null;
      state.total = null;
      state.totalComplete = false;
      state.cache = null;
      state.showingPreviousResults = false;
      state.live = false;
      if (activeListAbort) {
        activeListAbort.abort();
        activeListAbort = null;
      }
      resetReader();
    }

    if (!append && !isRefresh) {
      state.cursor = null;
      if (!isBrowseOlder) {
        state.live = false;
      }
    }

    if (activeListAbort) {
      activeListAbort.abort();
      activeListAbort = null;
    }
    state.revision++;
    if (!append) ++navGeneration;
    if (refreshMetadata) state.metadataDirty = true;

    const requestLive = isBrowseOlder ? true : (append ? state.live : false);
    state.live = requestLive;

    const descriptor = {
      revision: state.revision,
      session: state.session,
      folder: state.folder,
      accountId: state.accountId,
      query: state.query,
      filters: {...state.filters},
      sort: state.sort,
      bodySearch: state.bodySearch,
      cursor: append ? state.cursor : null,
      live: requestLive,
      append,
      isRefresh,
      readerId: state.selectedId,
      readerRevision: state.readerRevision
    };

    state.pending = descriptor;
    state.loading = !append;
    state.loadingMore = append;
    searchCancelled = false;

    if (isRefresh) {
      state.refreshing = true;
      state.savedListScroll = $('mail-list-pane')?.scrollTop ?? 0;
      state.savedReaderScroll = $('mail-reader')?.scrollTop ?? 0;
    } else if (append) {
      // Retain messages
    } else if (!scopeChanged && state.messages.length > 0 && (state.query || Object.keys(state.filters).length)) {
      state.showingPreviousResults = true;
    } else {
      state.showingPreviousResults = false;
      state.messages = [];
      state.cursor = null;
      state.total = null;
      state.totalComplete = false;
      state.selection.clear();
      if (!preserveReader) resetReader();
    }

    setNotice('');
    renderList();
    void runQueue();
  }

  async function runQueue() {
    if (state.running) return;
    state.running = true;
    const session = state.session;
    try {
      while (state.pending && session === state.session) {
        const request = state.pending;
        state.pending = null;
        try {
          if (request.revision !== state.revision) continue;
          if (state.metadataDirty) {
            void loadMetadata().catch(() => {});
          }

          const body = {folder: request.folder};
          if (Object.keys(request.filters).length) body.filters = request.filters;
          if (request.sort !== 'date_desc') body.sort = request.sort;
          if (request.bodySearch) body.bodySearch = true;
          if (request.accountId) body.accountIds = [request.accountId];
          if (request.query) body.query = request.query;
          if (request.cursor) body.cursor = request.cursor;
          if (request.live) body.live = true;

          const controller = new AbortController();
          activeListAbort = controller;

          const tagRevision = state.tagRevision;
          const data = await api('/api/mail/list', {
            method: 'POST',
            body,
            timeout: 130000,
            signal: controller.signal
          });

          if (session !== state.session || request.revision !== state.revision) continue;
          state.showingPreviousResults = false;

          if (data?.source === 'provider') {
            state.cache = null;
          } else if (data?.source === 'cache' || data?.coverage) {
            state.cache = {
              source: data.source || 'cache',
              providerFallback: Boolean(data.providerFallback),
              coverage: data.coverage,
              lastSuccessfulSync: data.lastSuccessfulSync ?? null,
              refreshing: Boolean(data.refreshing),
              revision: data.revision
            };
          }

          const incoming = (Array.isArray(data?.messages) ? data.messages : []).map(message => {
            const change = state.tagChanges.get(message.id);
            return change?.revision > tagRevision ? {...message, tags: change.tags} : message;
          });

          if (request.append) {
            const existing = new Set(state.messages.map(m => m.id));
            state.messages = [...state.messages, ...incoming.filter(m => !existing.has(m.id))];
          } else {
            if (request.isRefresh && state.selection.size > 0) {
              const identityMap = new Map();
              for (const m of incoming) {
                const idKey = messageIdentityKey(m);
                identityMap.set(idKey, m.id);
              }
              const newSelection = new Set();
              for (const oldMsg of state.messages) {
                if (state.selection.has(oldMsg.id)) {
                  const idKey = messageIdentityKey(oldMsg);
                  const renewedId = identityMap.get(idKey);
                  if (renewedId) newSelection.add(renewedId);
                }
              }
              state.selection = newSelection;
            }
            state.messages = incoming;
          }

          state.cursor = data?.nextCursor || null;
          state.total = Number.isSafeInteger(data?.total) && data.total >= 0 ? data.total : null;
          state.totalComplete = data?.totalComplete === true;
          state.listErrors = Array.isArray(data?.errors) ? data.errors : [];
          state.initialized = true;
          state.lastLoaded = Date.now();
          state.refreshing = false;
          renderErrors();
        } catch (error) {
          if (error?.name === 'AbortError') continue;
          if (session === state.session && request.revision === state.revision) {
            state.refreshing = false;
            state.listErrors = [{accountId: state.accountId || selectedAccounts()[0]?.id, code: error.code}];
            setNotice(errorText(error), true);
          }
        } finally {
          if (session === state.session && request.revision === state.revision) {
            state.loading = false;
            state.loadingMore = false;
            state.refreshing = false;
            renderList();
            if (request.isRefresh) {
              if ($('mail-list-pane')) $('mail-list-pane').scrollTop = state.savedListScroll;
              if (request.readerId === state.selectedId && request.readerRevision === state.readerRevision && $('mail-reader')) {
                $('mail-reader').scrollTop = state.savedReaderScroll;
              }
            }
          }
        }
      }
    } finally {
      state.running = false;
      if (state.pending) void runQueue();
    }
  }

  function updateHash(messageId) {
    if (typeof history === 'undefined' || !history.replaceState) return;

    if (!messageId) {
      if (globalThis.location?.hash?.includes('?m=')) {
        let listToken = null;
        for (const [t, snap] of navSnapshots) {
          if (matchesListSnapshot(snap)) {
            listToken = t;
            break;
          }
        }
        if (!listToken) {
          listToken = `snap-${nextSnapshotToken++}`;
          navSnapshots.set(listToken, {
            folder: state.folder,
            accountId: state.accountId,
            query: state.query,
            filters: {...state.filters},
            sort: state.sort,
            bodySearch: state.bodySearch,
            live: Boolean(state.live),
            selectedId: null,
            messages: [...state.messages],
            cursor: state.cursor,
            ...snapshotListMetadata(),
            scrollList: $('mail-list-pane')?.scrollTop ?? 0,
            scrollReader: 0
          });
        }
        currentSnapshotToken = listToken;
        while (navSnapshots.size > 50) navSnapshots.delete(navSnapshots.keys().next().value);
        history.replaceState({snapshotToken: listToken, messageId: null}, '', `#${state.folder}`);
      }
      return;
    }

    const currentState = history.state;
    if (!currentState?.snapshotToken || !navSnapshots.has(currentState.snapshotToken)) {
      const listToken = `snap-${nextSnapshotToken++}`;
      navSnapshots.set(listToken, {
        folder: state.folder,
        accountId: state.accountId,
        query: state.query,
        filters: {...state.filters},
        sort: state.sort,
        bodySearch: state.bodySearch,
        live: Boolean(state.live),
        selectedId: null,
        messages: [...state.messages],
        cursor: state.cursor,
        ...snapshotListMetadata(),
        scrollList: $('mail-list-pane')?.scrollTop ?? 0,
        scrollReader: 0
      });
      history.replaceState({snapshotToken: listToken, messageId: null}, '', `#${state.folder}`);
    }

    const token = `snap-${nextSnapshotToken++}`;
    navSnapshots.set(token, {
      folder: state.folder,
      accountId: state.accountId,
      query: state.query,
      filters: {...state.filters},
      sort: state.sort,
      bodySearch: state.bodySearch,
      live: Boolean(state.live),
      selectedId: messageId,
      messages: [...state.messages],
      cursor: state.cursor,
      ...snapshotListMetadata(),
      scrollList: $('mail-list-pane')?.scrollTop ?? 0,
      scrollReader: 0
    });
    currentSnapshotToken = token;
    while (navSnapshots.size > 50) navSnapshots.delete(navSnapshots.keys().next().value);
    if (history.pushState) {
      history.pushState({snapshotToken: token, messageId}, '', `#${state.folder}?m=${encodeURIComponent(messageId)}`);
    } else {
      history.replaceState({snapshotToken: token, messageId}, '', `#${state.folder}?m=${encodeURIComponent(messageId)}`);
    }
  }

  async function handlePopState(event) {
    captureDepartingSnapshot();
    if (activeListAbort) {
      activeListAbort.abort();
      activeListAbort = null;
    }
    state.revision++;
    state.readerRevision++;
    state.pending = null;
    state.loading = false;
    state.loadingMore = false;
    state.refreshing = false;
    state.showingPreviousResults = false;
    state.selection.clear();
    state.cache = null;
    state.live = false;
    state.listErrors = [];
    searchCancelled = false;

    const currentGen = ++navGeneration;
    const token = event?.state?.snapshotToken;
    if (token && navSnapshots.has(token)) {
      const snap = navSnapshots.get(token);
      currentSnapshotToken = token;
      state.folder = snap.folder;
      state.accountId = snap.accountId;
      state.query = snap.query;
      state.filters = {...snap.filters};
      state.sort = snap.sort;
      state.bodySearch = snap.bodySearch;
      state.live = Boolean(snap.live);
      committedAccountId = snap.accountId;
      committedFolder = snap.folder;

      renderAccounts();

      if ($('mail-search')) $('mail-search').value = state.query || '';
      mailTools.restoreCriteria?.({
        filters: state.filters,
        sort: state.sort,
        bodySearch: state.bodySearch,
        allFolders: state.folder === 'all'
      });

      state.messages = [...(snap.messages || [])];
      state.cursor = snap.cursor;
      state.total = Number.isSafeInteger(snap.total) && snap.total >= 0 ? snap.total : null;
      state.totalComplete = snap.totalComplete === true;
      state.listErrors = (snap.listErrors || []).map(error => ({...error}));
      state.cache = snap.cache ? {...structuredClone(snap.cache), refreshing: false} : null;
      renderErrors();

      if (snap.selectedId) {
        const msg = (snap.messages || []).find(m => m.id === snap.selectedId);
        if (msg) {
          renderList();
          await openMessage(msg, {fromSnapshot: true});
          if (currentGen !== navGeneration) return;
          if ($('mail-list-pane')) $('mail-list-pane').scrollTop = snap.scrollList || 0;
          if ($('mail-reader')) $('mail-reader').scrollTop = snap.scrollReader || 0;
        } else {
          renderList();
          resetReader();
          setNotice('This message link has expired. Refresh mail to view current messages.', false);
        }
      } else {
        renderList();
        resetReader();
        if (currentGen === navGeneration) {
          if ($('mail-list-pane')) $('mail-list-pane').scrollTop = snap.scrollList || 0;
        }
      }
      return;
    }
    handleHashChange();
  }

  function handleHashChange() {
    if (typeof location === 'undefined') return;
    const match = location.hash?.match(/\?m=([^&]+)/);
    if (match) {
      let id = null;
      try { id = decodeURIComponent(match[1]); } catch {}
      if (!id) return;
      if (state.selectedId === id) return;
      const msg = state.messages.find(m => m.id === id);
      if (msg) void openMessage(msg, {fromSnapshot: true});
      else setNotice('This message link has expired. Refresh mail to view current messages.', false);
    } else if (state.selectedId) {
      backToList({fromHistory: true});
    }
  }

  function handleVisibilityChange() {
    if (typeof document !== 'undefined' && (document.visibilityState === 'hidden' || document.hidden === true)) {
      clearTimeout(markReadTimer);
      markReadTimer = null;
    }
  }

  function isEditableOrDialog(target) {
    if (!target) return false;
    const tag = target.tagName?.toLowerCase();
    if (['input', 'textarea', 'select', 'button'].includes(tag) && !target.classList?.contains('mail-row')) return true;
    if (target.isContentEditable) return true;
    if (target.closest?.('dialog[open], .mail-attachment-dialog, .mail-advanced-panel, .mail-preferences, form')) return true;
    return false;
  }

  function handleKeydown(event) {
    if (!state.visible) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableOrDialog(event.target)) return;

    if (['j', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      navigateMessage(1);
    } else if (['k', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      navigateMessage(-1);
    } else if (event.key === 'u') {
      if (state.selectedId) {
        event.preventDefault();
        backToList();
      }
    } else if (event.key === 'e' || event.key === 'y') {
      if (state.selectedId) {
        event.preventDefault();
        void applyAction('archive');
      }
    } else if (event.key === 's') {
      if (state.selectedId) {
        event.preventDefault();
        const msg = state.message || state.selectedHeader;
        void applyAction(msg?.starred ? 'unstar' : 'star');
      }
    } else if (event.key === '#' || event.key === 'Delete') {
      if (state.selectedId) {
        event.preventDefault();
        requestDelete();
      }
    } else if (event.key === 'r') {
      if (state.message) {
        event.preventDefault();
        composer.open({mode: 'reply', id: state.message.id, accountId: state.message.accountId});
      }
    } else if (event.key === 'a') {
      if (state.message) {
        event.preventDefault();
        composer.open({mode: 'reply_all', id: state.message.id, accountId: state.message.accountId});
      }
    } else if (event.key === 'f') {
      if (state.message) {
        event.preventDefault();
        composer.open({mode: 'forward', id: state.message.id, accountId: state.message.accountId});
      }
    } else if (event.key === '/') {
      const searchInput = $('mail-search');
      if (searchInput) {
        event.preventDefault();
        searchInput.focus();
        searchInput.select?.();
      }
    }
  }

  function attachListeners() {
    if (listenersAttached) return;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', handleKeydown);
      window.addEventListener('popstate', handlePopState);
      window.addEventListener('hashchange', handleHashChange);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    listenersAttached = true;
  }

  function detachListeners() {
    if (!listenersAttached) return;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('hashchange', handleHashChange);
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    listenersAttached = false;
  }

  function triggerToolbarRefresh() {
    if (state.loading || state.loadingMore || state.refreshing) return;
    const session = state.session;
    if (state.cache?.source === 'cache') {
      const refreshBody = state.accountId ? {accountIds: [state.accountId]} : {};
      api('/api/mail/cache/refresh', {method: 'POST', body: refreshBody, timeout: 130000})
        .then(res => {
          if (session === state.session && state.cache) {
            if (res?.refreshing !== undefined) {
              state.cache.refreshing = Boolean(res.refreshing);
              renderControls();
            }
          }
        })
        .catch(err => {
          if (session === state.session) {
            setNotice(errorText(err), true);
          }
        });
    }
    requestList({refreshMetadata: true, isRefresh: true, preserveReader: true});
  }

  $('mail-refresh')?.addEventListener('click', triggerToolbarRefresh);
  $('mail-more')?.addEventListener('click', () => requestList({append: true}));
  for (const select of [$('mail-account'), $('mail-workspace-account'), $('mail-drawer-account')].filter(Boolean)) {
    select.addEventListener('change', () => {
      state.accountId = select.value;
      for (const other of [$('mail-account'), $('mail-workspace-account'), $('mail-drawer-account')].filter(Boolean)) {
        other.value = select.value;
      }
      state.messages = [];
      state.selection.clear();
      state.cursor = null;
      state.total = null;
      state.totalComplete = false;
      state.cache = null;
      state.showingPreviousResults = false;
      state.live = false;
      if (activeListAbort) {
        activeListAbort.abort();
        activeListAbort = null;
      }
      navSnapshots.clear();
      currentSnapshotToken = null;
      ++navGeneration;
      resetReader();
      renderList();
      requestList();
    });
  }
  $('mail-density-setting')?.addEventListener('change', () => {
    state.density = $('mail-density-setting').value === 'compact' ? 'compact' : 'default';
    safeStorage.set('mailharbor_density', state.density);
    renderControls();
  });
  $('mail-reading-mode-setting')?.addEventListener('change', () => {
    state.readingMode = $('mail-reading-mode-setting').value === 'full' ? 'full' : 'split';
    safeStorage.set('mailharbor_reading_mode', state.readingMode);
    renderControls();
  });
  $('mail-mark-read-setting')?.addEventListener('change', () => {
    clearTimeout(markReadTimer);
    markReadTimer = null;
    state.markReadDelay = clampMarkReadDelay($('mail-mark-read-setting').value);
    safeStorage.set('mailharbor_mark_read_delay', String(state.markReadDelay));
    renderControls();
  });
  $('mail-compose')?.addEventListener('click', () => composer.open({accountId: state.accountId || undefined}));
  $('mail-search-form')?.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const q = $('mail-search')?.value ?? '';
      mailTools.commitDraft({query: q.trim()});
    } catch (error) {
      setNotice(describeError?.(error) || error?.message || 'Invalid search criteria.', true);
    }
  });
  $('mail-search')?.addEventListener('search', () => { if (!$('mail-search').value && (state.query || Object.keys(state.filters).length)) mailTools.clearFilters(); });
  $('mail-reader')?.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (deleteConfirmation) { event.preventDefault(); cancelDelete(); }
    else backToList();
  });
  $('mail-menu')?.addEventListener('click', openDrawer);
  $('mail-label-close')?.addEventListener('click', () => closeLabels());
  $('mail-label-dialog')?.addEventListener('cancel', event => { event.preventDefault(); closeLabels(); });
  $('mail-label-dialog')?.addEventListener('click', event => {
    if (event.target !== $('mail-label-dialog')) return;
    const bounds = $('mail-label-dialog').getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeLabels();
  });
  $('mail-drawer-close')?.addEventListener('click', closeDrawer);
  $('mail-drawer')?.addEventListener('cancel', event => { event.preventDefault(); closeDrawer(); });
  $('mail-drawer')?.addEventListener('close', () => {
    $('mail-menu')?.setAttribute('aria-expanded', 'false');
    if (state.visible) $('mail-menu')?.focus();
  });
  $('mail-drawer')?.addEventListener('click', event => {
    if (event.target !== $('mail-drawer')) return;
    const bounds = $('mail-drawer').getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDrawer();
  });

  const mobileMedia = typeof window === 'undefined' ? null : window.matchMedia('(max-width: 600px)');
  mobileMedia?.addEventListener?.('change', event => { if (!event.matches) closeDrawer(); });

  renderFolders();
  renderReader();

  return {
    show() {
      state.visible = true;
      attachListeners();
      mailTools.start();
      if (!state.loading && !state.loadingMore && (!state.initialized || state.metadataDirty || Date.now() - state.lastLoaded > 10 * 60 * 1000)) {
        requestList();
      }
    },
    hide() {
      state.visible = false;
      clearTimeout(markReadTimer);
      markReadTimer = null;
      detachListeners();
      mailTools.stop();
      mailTools.closeAdvanced();
      closeDrawer();
      resetReader();
    },
    renderSettings(mounts) {
      renderControls();
      if (state.metadataDirty) void refreshCounts().then(renderControls);
      return composer.renderSettings(mounts);
    },
    reset() {
      clearTimeout(markReadTimer);
      markReadTimer = null;
      if (activeListAbort) {
        activeListAbort.abort();
        activeListAbort = null;
      }
      detachListeners();
      mailTools.reset();
      composer.reset();
      conversation.reset();
      state.selection.clear();
      Object.assign(state, {filters: {}, sort: 'date_desc', bodySearch: false, threaded: false});
      state.session++;
      state.revision++;
      state.pending = null;
      Object.assign(state, {
        visible: false, initialized: false, folder: 'inbox', accountId: '', query: '',
        accounts: [], folders: [], metadataErrors: [], listErrors: [], messages: [],
        cursor: null, total: null, totalComplete: false, actionBusy: false, tagRevision: 0,
        loading: false, loadingMore: false, refreshing: false, showingPreviousResults: false,
        metadataLoaded: false, metadataDirty: true, fingerprint: null, lastLoaded: 0,
        cache: null, live: false
      });
      committedAccountId = '';
      committedFolder = 'inbox';
      searchCancelled = false;
      state.tagChanges.clear();
      navSnapshots.clear();
      currentSnapshotToken = null;
      nextSnapshotToken = 1;
      navGeneration++;
      closeDrawer();
      if ($('mail-search')) $('mail-search').value = '';
      resetReader();
      renderAccounts();
      renderFolders();
      renderControls();
      $('mail-list')?.replaceChildren();
      setNotice('');
    },
    accountsChanged(accounts) {
      const next = fingerprint(accounts);
      if (state.fingerprint === null) { state.fingerprint = next; return; }
      if (next === state.fingerprint) return;
      state.fingerprint = next;
      navSnapshots.clear();
      currentSnapshotToken = null;
      state.metadataDirty = true;
      state.metadataRevision++;
      state.accounts = accounts;
      renderAccounts();
      if (state.visible) requestList({refreshMetadata: true});
      else { state.initialized = false; state.messages = []; state.cursor = null; resetReader(); $('mail-list')?.replaceChildren(); }
    },
    setDensity(mode) {
      state.density = mode === 'compact' ? 'compact' : 'default';
      safeStorage.set('mailharbor_density', state.density);
      renderControls();
    },
    setReadingMode(mode) {
      state.readingMode = mode === 'full' ? 'full' : 'split';
      safeStorage.set('mailharbor_reading_mode', state.readingMode);
      renderControls();
    },
    setMarkReadDelay(delayMs) {
      clearTimeout(markReadTimer);
      markReadTimer = null;
      state.markReadDelay = clampMarkReadDelay(delayMs);
      safeStorage.set('mailharbor_mark_read_delay', String(state.markReadDelay));
      renderControls();
    }
  };
}
