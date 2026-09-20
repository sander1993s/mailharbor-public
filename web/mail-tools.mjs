import { iconButton, actionMenu, enhanceSelects } from './controls.mjs';
import { createTelegramSettings } from './telegram-settings.mjs';

const make = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

const button = (text, action, className = 'subtle') => {
  const node = make('button', text, className); node.type = 'button'; node.addEventListener('click', action); return node;
};
const option = (value, label) => { const node = make('option', label); node.value = value; return node; };
const provider = folder => folder.type === 'provider' || String(folder.id).startsWith('folder:');
const folderAccounts = folder => folder.accountIds ?? [];
const CUSTOM_LABEL = /^tag:custom_/u;
export const BULK_ACTIONS = Object.freeze([
  ['mark_read','Mark read'], ['mark_unread','Mark unread'], ['star','Star'], ['unstar','Unstar'],
  ['archive','Archive'], ['spam','Mark as spam'], ['not_spam','Not spam'], ['restore','Restore to inbox'],
  ['delete','Move to Trash'], ['move','Move to folder'], ['tag_add','Add local label'], ['tag_remove','Remove local label'],
  ['delete_permanent','Delete permanently']
]);

export function selectionAccount(messages, ids) {
  const selected = messages.filter(message => ids.has(message.id));
  const accounts = new Set(selected.map(message => message.accountId));
  return selected.length === ids.size && accounts.size === 1 ? selected[0]?.accountId ?? '' : '';
}

/** Optional inputs are omitted; explicit false means read/unstarred/no attachment. Supports KB and MB units. */
export function buildMailFilters(values) {
  const result = {};
  for (const key of ['from','to','subject','body','since','before']) if (String(values[key] ?? '').trim()) result[key] = String(values[key]).trim();
  for (const key of ['unread','starred','hasAttachment']) if (values[key] === 'true' || values[key] === 'false' || values[key] === true || values[key] === false) result[key] = values[key] === 'true' || values[key] === true;
  for (const key of ['minSize','maxSize']) if (String(values[key] ?? '').trim()) {
    let raw = String(values[key]).trim();
    let factor = 1;
    const unit = values[`${key}Unit`];
    if (unit === 'MB') factor = 1024 * 1024;
    else if (unit === 'KB') factor = 1024;
    else {
      const match = raw.match(/^(\d+(?:\.\d+)?)\s*(bytes?|b|kb|mb)$/i);
      if (match) {
        raw = match[1];
        const u = match[2].toLowerCase();
        if (u === 'mb') factor = 1024 * 1024;
        else if (u === 'kb') factor = 1024;
      }
    }
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) throw new Error('Size filters must be whole numbers from 0 to 4,294,967,295 bytes.');
    const number = Math.round(num * factor);
    if (!Number.isSafeInteger(number) || number < 0 || number > 0xffffffff) throw new Error('Size filters must be whole numbers from 0 to 4,294,967,295 bytes.');
    result[key] = number;
  }
  if (result.minSize !== undefined && result.maxSize !== undefined && result.minSize > result.maxSize) throw new Error('Minimum size cannot exceed maximum size.');
  if (result.since && result.before && result.since >= result.before) throw new Error('The before date must come after the since date.');
  return result;
}

export function createMailTools({api, describeError, state, refresh, renderList, renderReader, setNotice, openCompose, selectFolder, onSearchSubmit, onSearchClear}) {
  const telegramSettings = createTelegramSettings({api, describeError});
  let host = null, selectionHost = null, readerHost = null, readerMessage = null, generation = 0, busy = false, confirmation = null;
  let settingsHost = null, advancedButton = null, advancedPanel = null, advancedFirst = null, advancedBinding = null;
  let undoTokens = [], filterDraft = null, advancedOpen = false, managerOpen = false, notificationsOpen = false, lastShape = '';
  let notificationState = '', pollTimer = null, polling = false, updateRevision = null, pollGeneration = 0, viewKey = '';
  let providerData = null, providerMessageId = null;
  let providerDialog = null;
  let labelSync = null, labelSyncBusy = false, labelSyncError = '', labelSyncControls = null, labelSyncAction = false;
  const manager = {kind:'folder',accountId:'',action:'create',id:'',name:'',parentId:''};
  const bulk = {action:'mark_read',destinationId:'',tag:''};
  const call = (path, body, method = 'POST') => api(`/api/mail/${path}`, {method, ...(body === undefined ? {} : {body}), timeout:190000});
  const errorText = error => describeError?.(error) || error?.message || 'This mailbox action could not be completed.';
  const notice = (text, failed = false) => setNotice?.(text, failed);
  const selected = () => state.selection instanceof Set ? state.selection : (state.selection = new Set());
  const accounts = () => (state.accounts ?? []).filter(account => account.connected !== false);
  const providers = accountId => (state.folders ?? []).filter(folder => provider(folder) && folderAccounts(folder).includes(accountId));
  const labels = () => (state.folders ?? []).filter(folder => String(folder.id).startsWith('tag:'));
  function drafts() {
    if (!filterDraft) {
      filterDraft = Object.fromEntries(Object.entries(state.filters ?? {}).map(([key,value]) => [key,String(value)]));
      filterDraft.bodySearch = state.bodySearch === true; filterDraft.allFolders = state.folder === 'all'; filterDraft.sort = state.sort ?? 'date_desc';
    }
    return filterDraft;
  }
  function readDraft() {
    const vals = drafts();
    const filters = buildMailFilters(vals);
    return {
      query: state.query || '',
      filters,
      sort: vals.sort || state.sort || 'date_desc',
      bodySearch: Boolean(vals.bodySearch),
      allFolders: Boolean(vals.allFolders)
    };
  }
  function commitDraft(overrides = {}) {
    const vals = drafts();
    if ('sort' in overrides) vals.sort = overrides.sort;
    if ('bodySearch' in overrides) vals.bodySearch = Boolean(overrides.bodySearch);
    if ('allFolders' in overrides) vals.allFolders = Boolean(overrides.allFolders);
    if (overrides.filters) {
      for (const [k, v] of Object.entries(overrides.filters)) vals[k] = String(v);
    }
    let validatedFilters;
    try {
      validatedFilters = buildMailFilters(vals);
    } catch (err) {
      notice(errorText(err), true);
      throw err;
    }
    state.filters = validatedFilters;
    state.sort = vals.sort || 'date_desc';
    state.bodySearch = Boolean(vals.bodySearch);
    if (overrides.query !== undefined) state.query = overrides.query;
    closeAdvanced(true);
    if (typeof onSearchSubmit === 'function') {
      onSearchSubmit({
        query: state.query,
        filters: state.filters,
        sort: state.sort,
        bodySearch: state.bodySearch,
        allFolders: Boolean(vals.allFolders)
      });
    } else {
      if (vals.allFolders && state.folder !== 'all') selectFolder?.('all');
      else if (!vals.allFolders && state.folder === 'all') selectFolder?.('inbox');
      else void run(async () => { await refreshAll(); });
    }
    return {
      query: state.query,
      filters: state.filters,
      sort: state.sort,
      bodySearch: state.bodySearch,
      allFolders: Boolean(vals.allFolders)
    };
  }
  function removeCriteria(key) {
    const vals = drafts();
    if (key === 'query') {
      state.query = '';
      const mainInput = document.getElementById?.('mail-search');
      if (mainInput) mainInput.value = '';
      delete vals.query;
      return commitDraft({ query: '' });
    } else if (key === 'bodySearch') {
      vals.bodySearch = false;
      return commitDraft({ bodySearch: false });
    } else if (key === 'allFolders') {
      vals.allFolders = false;
      return commitDraft({ allFolders: false });
    } else if (key === 'sort') {
      vals.sort = 'date_desc';
      return commitDraft({ sort: 'date_desc' });
    } else {
      delete vals[key];
      delete vals[`${key}Unit`];
      if (state.filters) delete state.filters[key];
      return commitDraft();
    }
  }
  function clearFilters() {
    const mainInput = document.getElementById?.('mail-search');
    if (mainInput) mainInput.value = '';
    filterDraft = {
      sort: 'date_desc',
      bodySearch: false,
      allFolders: false
    };
    closeAdvanced(false);
    draw(true);
    if (typeof onSearchClear === 'function') {
      onSearchClear();
    } else {
      state.query = '';
      state.filters = {};
      state.bodySearch = false;
      state.sort = 'date_desc';
      void run(async () => { await refreshAll(); });
    }
  }
  function restoreCriteria(criteria = {}) {
    filterDraft = Object.fromEntries(
      Object.entries(criteria.filters ?? {}).map(([key, value]) => [key, String(value)])
    );
    filterDraft.bodySearch = criteria.bodySearch === true;
    filterDraft.allFolders = criteria.allFolders === true;
    filterDraft.sort = criteria.sort ?? 'date_desc';
    draw(true);
  }
  function setUndo(tokens) { undoTokens = (Array.isArray(tokens) ? tokens : [tokens]).filter(value => typeof value === 'string' && value).slice(0,50); updateControls(); }
  function refreshAll() { return refresh?.({refreshMetadata:true}); }
  async function run(work) {
    if (busy) return;
    const version = generation; busy = true; updateControls();
    try { await work(() => version === generation); }
    catch (error) { if (version === generation) notice(errorText(error), true); }
    finally { if (version === generation) { busy = false; draw(true); drawReader(); } }
  }
  function confirm(title, text, action, scope = 'toolbar') {
    confirmation = {title,text,action,scope}; draw(true); drawReader();
    (scope === 'settings' ? settingsHost : host)?.querySelector?.('.mail-tools-confirm')?.scrollIntoView?.({block:'center',behavior:'smooth'});
  }
  function confirmationPanel() {
    if (!confirmation) return null;
    const pendingConfirmation = confirmation;
    const panel = make('section', undefined, 'mail-tools-confirm'); panel.setAttribute('role','alertdialog'); panel.setAttribute('aria-label',confirmation.title);
    panel.append(make('h4',confirmation.title), make('p',confirmation.text));
    panel.append(button('Cancel', () => { if (confirmation !== pendingConfirmation) return; confirmation = null; draw(true); drawReader(); }), button('Confirm', () => {
      if (confirmation !== pendingConfirmation) return;
      const work = pendingConfirmation.action; confirmation = null; draw(true); drawReader(); if (work) void work();
    }, 'danger'));
    return panel;
  }
  async function apply(ids, action, extra = {}) {
    if (!ids.length) { notice('Select at least one message.', true); return; }
    if (ids.length > 50) { notice('Select up to 50 messages at a time.', true); return; }
    const permanent = action === 'delete_permanent';
    const perform = () => run(async current => {
      const result = await call('bulk', {ids,action,...extra,...(permanent ? {confirm:true} : {})});
      if (!current()) return;
      if (result.undoTokens?.length) setUndo(result.undoTokens);
      const failed = result.failed ?? [], count = result.applied?.length ?? 0;
      for (const appliedId of (result.applied ?? [])) selected().delete(appliedId);
      await refreshAll();
      if (current()) notice(`${count} message${count === 1 ? '' : 's'} updated.${failed.length ? ` ${failed.length} failed: ${failed[0].message || errorText(failed[0])}` : ''}`, failed.length > 0);
    });
    if (permanent) confirm('Permanently delete selected mail?', `This permanently removes ${ids.length} selected message${ids.length === 1 ? '' : 's'} from the original mailbox. This cannot be undone.`, perform);
    else if (action === 'delete') confirm('Move selected mail to Trash?', `Move ${ids.length} selected message${ids.length === 1 ? '' : 's'} to Trash in the original mailbox?`, perform);
    else await perform();
  }
  function bulkApply() {
    let action = bulk.action, extra = {};
    if (action === 'move') {
      const accountId = selectionAccount(state.messages ?? [], selected());
      if (!accountId || !providers(accountId).some(folder => folder.id === bulk.destinationId)) { notice('Select messages from one account and choose its destination folder.', true); return; }
      extra.destinationId = bulk.destinationId;
    } else if (action === 'tag_add' || action === 'tag_remove') {
      if (!labels().some(folder => folder.id === `tag:${bulk.tag}`)) { notice('Choose a local label.', true); return; }
      extra = {tag:bulk.tag, enabled:action === 'tag_add'}; action = 'tag';
    }
    void apply([...selected()], action, extra);
  }
  function selectControl(label, items, value, onChange, className) {
    const wrapper = make('label',label,className), node = make('select');
    for (const [id,text] of items) node.append(option(id,text));
    node.value = value ?? ''; node.setAttribute('aria-label',label);
    node.addEventListener('change', () => onChange(node.value)); wrapper.append(node); return {wrapper,node};
  }
  function inputControl(label, value, onInput, type = 'text', maxLength = 200) {
    const wrapper = make('label',label), node = make('input'); node.type = type; node.value = value ?? ''; node.maxLength = maxLength;
    if (type === 'number') { node.min = '0'; node.step = 'any'; }
    node.addEventListener('input', () => onInput(node.value)); wrapper.append(node); return {wrapper,node};
  }
  function checkbox(label, checked, onChange) {
    const wrapper = make('label', undefined, 'mail-tools-check'), node = make('input'); node.type = 'checkbox'; node.checked = checked;
    node.addEventListener('change', () => onChange(node.checked)); wrapper.append(node,make('span',label)); return {wrapper,node};
  }
  function closeAdvanced(restoreFocus = false) {
    advancedOpen = false;
    if (advancedPanel) advancedPanel.hidden = true;
    advancedButton?.setAttribute('aria-expanded','false');
    if (restoreFocus) advancedButton?.focus?.();
  }
  function bindAdvanced(node) {
    if (advancedButton === node) return;
    if (advancedBinding) {
      advancedButton?.removeEventListener?.('click',advancedBinding.click);
      advancedButton?.removeEventListener?.('keydown',advancedBinding.keydown);
    }
    advancedButton = node ?? null; advancedBinding = null;
    if (!advancedButton) { closeAdvanced(); return; }
    const bound = advancedButton;
    const click = () => {
      if (advancedButton !== bound || !host) return;
      if (advancedOpen) closeAdvanced(true);
      else { advancedOpen = true; if (advancedPanel) advancedPanel.hidden = false; bound.setAttribute('aria-expanded','true'); advancedFirst?.focus?.(); }
    };
    const keydown = event => { if (event.key === 'Escape') { event.preventDefault(); closeAdvanced(true); } };
    advancedBinding = {click,keydown}; bound.addEventListener('click',click); bound.addEventListener('keydown',keydown);
    bound.setAttribute('aria-controls','mail-advanced-search'); bound.setAttribute('aria-expanded',String(advancedOpen));
  }
  function advancedFilters() {
    const values = drafts(), detail = make('section',undefined,'mail-advanced-panel'); detail.id = 'mail-advanced-search'; detail.hidden = !advancedOpen;
    detail.setAttribute('role','region'); detail.setAttribute('aria-label','Advanced search'); advancedPanel = detail;
    const heading = make('div',undefined,'mail-advanced-heading');
    heading.append(make('h3','Advanced search'),button('Close',() => closeAdvanced(true)));
    detail.append(heading); detail.addEventListener('keydown',event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); closeAdvanced(true); } });
    const form = make('form',undefined,'mail-tools-grid');
    for (const [key,label,type] of [['from','From'],['to','To'],['subject','Subject'],['body','Body contains'],['since','Since (inclusive)','date'],['before','Before (exclusive)','date']]) {
      const field = inputControl(label,values[key],value => { values[key] = value; },type ?? 'text');
      if (key === 'from') advancedFirst = field.node;
      form.append(field.wrapper);
    }
    for (const [key,label] of [['minSize','Minimum size'],['maxSize','Maximum size']]) {
      const field = inputControl(label,values[key],value => { values[key] = value; },'number');
      const unit = selectControl(`${label} unit`,[['Bytes','Bytes'],['KB','KB'],['MB','MB']],values[`${key}Unit`] || 'Bytes',value => { values[`${key}Unit`] = value; });
      const group = make('div', undefined, 'mail-size-field');
      group.append(field.wrapper, unit.wrapper);
      form.append(group);
    }
    for (const [key,label,yes,no] of [['unread','Read state','Unread','Read'],['starred','Star state','Starred','Unstarred'],['hasAttachment','Attachments','Has attachments','No attachments']]) {
      form.append(selectControl(label,[['','Any'],['true',yes],['false',no]],values[key],value => { values[key] = value; }).wrapper);
    }
    form.append(selectControl('Sort',[['date_desc','Newest first'],['date_asc','Oldest first'],['subject_asc','Subject A–Z'],['sender_asc','Sender A–Z']],values.sort,value => { values.sort = value; }).wrapper);
    form.append(checkbox('Search message bodies with the main search',values.bodySearch,value => { values.bodySearch = value; }).wrapper,
      checkbox('Search all provider folders',values.allFolders,value => { values.allFolders = value; }).wrapper,
      checkbox('Group conversations',state.threaded === true,value => { state.threaded = value; renderList?.(); renderReader?.(); }).wrapper);
    const submit = make('button','Search'); submit.type = 'submit'; form.append(submit);
    form.append(button('Clear', () => {
      clearFilters();
    }));
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const mainInput = document.getElementById?.('mail-search');
        commitDraft({query: mainInput ? mainInput.value.trim() : (state.query || '')});
      } catch (error) { /* notice already called */ }
    });
    detail.append(form); return detail;
  }
  function updateLabelSyncControls() {
    if (!labelSyncControls) return;
    const {sync, status} = labelSyncControls;
    sync.disabled = busy || labelSyncBusy;
    let text = labelSyncError;
    if (labelSyncBusy) text = labelSyncAction ? 'Syncing labels to original mailboxes…' : 'Checking label sync…';
    else if (!text && labelSync) {
      const count = name => Number.isSafeInteger(labelSync[name]) && labelSync[name] > 0 ? labelSync[name] : 0;
      const parts = [];
      if (labelSync.running) parts.push('Sync in progress.');
      if (count('synced')) parts.push(`${count('synced')} synced.`);
      if (count('pending')) parts.push(`${count('pending')} pending.`);
      if (count('failed')) parts.push(`${count('failed')} need review.`);
      const unchanged = count('protected') + count('skipped');
      if (unchanged) parts.push(`${unchanged} left unchanged.`);
      text = parts.join(' ') || (labelSync.backfillComplete ? 'No labels waiting to sync.' : 'Ready to sync labels to original mailboxes.');
    }
    status.textContent = text; status.hidden = !text;
  }
  async function refreshLabelSync(sync = false) {
    if (labelSyncBusy || (sync && busy)) return;
    const version = generation;
    labelSyncBusy = true; labelSyncAction = sync; labelSyncError = ''; updateLabelSyncControls();
    try {
      const result = await call('labels/sync', sync ? {action:'sync'} : undefined, sync ? 'POST' : 'GET');
      if (version === generation) labelSync = result;
    } catch (error) { if (version === generation) labelSyncError = errorText(error); }
    finally { if (version === generation) { labelSyncBusy = false; updateLabelSyncControls(); } }
  }
  function folderManager() {
    const version = generation;
    const detail = make('details',undefined,'mail-tools-details'); detail.open = managerOpen;
    detail.append(make('summary','Manage folders & labels')); detail.addEventListener('toggle', () => {
      if (version !== generation || detail.isConnected === false) return;
      const opening = detail.open && !managerOpen;
      managerOpen = detail.open;
      if (opening) void refreshLabelSync();
    });
    const syncRow = make('div', undefined, 'mail-tools-row');
    const sync = button('Sync labels', () => { if (version === generation) void refreshLabelSync(true); });
    sync.title = 'Sync MailHarbor labels to original mailboxes';
    const status = make('span', '', 'fineprint'); status.setAttribute('role', 'status');
    labelSyncControls = {sync, status}; updateLabelSyncControls(); syncRow.append(sync, status);
    detail.append(syncRow);
    const form = make('form',undefined,'mail-tools-grid');
    form.append(selectControl('Manage',[['folder','Provider folders'],['label','Labels']],manager.kind,value => { manager.kind = value; manager.action = 'create'; manager.id = ''; draw(true); }).wrapper);
    const actions = [['create','Create'],['rename','Rename'],...(manager.kind === 'label' ? [['delete','Delete label']] : [])];
    form.append(selectControl('Operation',actions,manager.action,value => { manager.action = value; draw(true); }).wrapper);
    if (manager.kind === 'folder') {
      const defaultAccount = state.accountId || (accounts().length === 1 ? accounts()[0].id : '');
      if (!manager.accountId) manager.accountId = defaultAccount;
      form.append(selectControl('Mailbox account',[['','Choose account'],...accounts().map(account => [account.id,account.label || account.email])],manager.accountId,value => { manager.accountId = value; manager.id = ''; manager.parentId = ''; draw(true); }).wrapper);
      if (manager.action === 'rename') form.append(selectControl('Folder',[['','Choose folder'],...providers(manager.accountId).filter(folder => !folder.specialUse).map(folder => [folder.id,folder.label])],manager.id,value => { manager.id = value; }).wrapper);
      else form.append(selectControl('Parent folder',[['','Mailbox root'],...providers(manager.accountId).map(folder => [folder.id,folder.label])],manager.parentId,value => { manager.parentId = value; }).wrapper);
    } else if (manager.action !== 'create') form.append(selectControl('Local label',[['','Choose label'],...labels().filter(folder => CUSTOM_LABEL.test(folder.id)).map(folder => [folder.id.slice(4),folder.label])],manager.id,value => { manager.id = value; }).wrapper);
    if (manager.action !== 'delete') form.append(inputControl('Name',manager.name,value => { manager.name = value; },'text',manager.kind === 'label' ? 80 : 100).wrapper);
    const submit = make('button',manager.action === 'delete' ? 'Delete local label' : 'Save'); submit.type = 'submit'; form.append(submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const snapshot = {...manager};
      if (snapshot.action !== 'create' && !snapshot.id) { notice('Choose the folder or custom label first.',true); return; }
      if (snapshot.action !== 'delete' && !snapshot.name.trim()) { notice('Enter a name.',true); return; }
      if (snapshot.kind === 'folder' && !snapshot.accountId) { notice('Choose a mailbox account.',true); return; }
      const perform = () => run(async current => {
        const payload = snapshot.kind === 'folder' ? {accountId:snapshot.accountId,action:snapshot.action,name:snapshot.name.trim(),
          ...(snapshot.action === 'rename' ? {folderId:snapshot.id} : snapshot.parentId ? {parentId:snapshot.parentId} : {})} :
          {action:snapshot.action,...(snapshot.action !== 'create' ? {id:snapshot.id} : {}),...(snapshot.action !== 'delete' ? {label:snapshot.name.trim()} : {})};
        const result = await call(snapshot.kind === 'folder' ? 'folders/manage' : 'labels/manage',payload);
        if (!current()) return;
        manager.name = ''; manager.id = ''; await refreshAll();
        if (current()) { notice(snapshot.kind === 'folder' ? 'Folder saved in the original mailbox.' : 'Labels updated. Mailbox sync runs in the background.'); if (result.folder?.id) selectFolder?.(result.folder.id); }
      });
      if (snapshot.action === 'delete') confirm('Delete local label?', 'This removes the custom local label. The messages remain in their mailboxes.', perform, 'settings');
      else void perform();
    });
    detail.append(form); return detail;
  }
  function emptyTrash() {
    const account = accounts().find(item => item.id === state.accountId);
    if (!account) { notice('Choose one mailbox account before emptying Trash.',true); return; }
    confirm('Empty original mailbox Trash?', `Permanently delete up to 100 messages from Trash in ${account.label || account.email}? This cannot be undone. If messages remain, you can repeat this action.`, () => run(async current => {
      const result = await call('trash/empty',{accountId:account.id,confirm:true});
      if (!current()) return;
      await refreshAll();
      if (current()) notice(`${result.deleted ?? 0} messages permanently deleted. ${result.remaining ?? 0} remain in Trash.`, !!result.errors?.length);
    }));
  }
  async function undo() {
    const tokens = [...undoTokens];
    await run(async current => {
      const failed = []; let restored = 0;
      for (const token of tokens) {
        if (!current()) return;
        try { await call('undo',{token}); restored++; } catch { failed.push(token); }
      }
      if (!current()) return;
      setUndo(failed); await refreshAll();
      if (current()) notice(`${restored} move${restored === 1 ? '' : 's'} undone.${failed.length ? ` ${failed.length} could not be undone; they may have expired or changed.` : ''}`,failed.length > 0);
    });
  }
  async function notifications(enable) {
    await run(async current => {
      if (typeof navigator === 'undefined' || !navigator.serviceWorker || typeof Notification === 'undefined' || typeof PushManager === 'undefined') throw new Error('Push notifications are unavailable in this browser. Live mailbox updates remain available.');
      if (enable && Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') throw new Error('Allow notifications in your browser settings to enable new-mail alerts.');
      const registration = await navigator.serviceWorker.ready;
      if (!current()) return;
      let subscription = await registration.pushManager.getSubscription();
      if (!enable) {
        if (subscription) { await call('notifications',{endpoint:subscription.endpoint},'DELETE'); await subscription.unsubscribe(); }
        if (current()) { notificationState = 'disabled'; notice('New-mail notifications disabled on this device.'); } return;
      }
      const settings = await call('notifications',undefined,'GET');
      if (!current()) return;
      let created = false;
      if (!subscription) {
        const raw = atob(settings.publicKey.replace(/-/gu,'+').replace(/_/gu,'/'));
        subscription = await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(raw,character => character.charCodeAt(0))}); created = true;
      }
      if (!current()) { if (created) await subscription.unsubscribe(); return; }
      try { await call('notifications',subscription.toJSON()); }
      catch (error) { if (created) await subscription.unsubscribe(); throw error; }
      if (current()) { notificationState = 'enabled'; notice('New-mail notifications enabled on this device. Alerts contain no message content.'); }
    });
  }
  function updateControls() {
    if (!host) return;
    const count = host.querySelector?.('[data-mail-selection-count]'); if (count) { count.textContent = `${selected().size} selected`; count.hidden = !selected().size; }
    const all = (selectionHost || host).querySelector?.('[data-mail-select-loaded]');
    if (all) {
      const loaded = (state.messages ?? []).slice(0,50);
      const selectedCount = loaded.filter(message => selected().has(message.id)).length;
      all.checked = loaded.length > 0 && selectedCount === loaded.length;
      all.indeterminate = selected().size > 0 && !all.checked;
      all.disabled = busy || !(state.messages ?? []).length;
    }
    const selectedRow = host.querySelector?.('[data-mail-selection-actions]'); if (selectedRow) selectedRow.hidden = !selected().size;
    for (const node of host.querySelectorAll?.('[data-mail-selected-action]') ?? []) node.disabled = busy || !selected().size;
    for (const node of host.querySelectorAll?.('[data-mail-busy]') ?? []) node.disabled = busy;
    for (const node of readerHost?.querySelectorAll?.('[data-mail-busy]') ?? []) node.disabled = busy;
    updateLabelSyncControls();
    const undoButton = host.querySelector?.('[data-mail-undo]'); if (undoButton) { undoButton.hidden = !undoTokens.length; undoButton.disabled = busy; undoButton.textContent = `Undo last move${undoTokens.length > 1 ? 's' : ''}`; }
    const move = host.querySelector?.('[data-mail-move-target]');
    if (move) {
      const accountId = selectionAccount(state.messages ?? [],selected()), available = providers(accountId);
      move.replaceChildren(option('','Move destination'),...available.map(folder => option(folder.id,folder.label)));
      if (!available.some(folder => folder.id === bulk.destinationId)) bulk.destinationId = '';
      move.value = bulk.destinationId; move.disabled = busy || !accountId;
    }
    const summary = host.querySelector?.('[data-mail-selection-summary]');
    if (summary) summary.hidden = !!selectionHost && !selected().size && !undoTokens.length && state.folder !== 'trash';
    host.hidden = !!selectionHost && !selected().size && !undoTokens.length && state.folder !== 'trash' && !confirmation;
    enhanceSelects(host);
  }
  let cacheSettings = null, cacheBusy = false, cacheError = '', cacheOpen = false;
  async function refreshCacheSettings() {
    if (cacheBusy) return;
    const version = generation;
    cacheBusy = true; cacheError = '';
    try {
      const data = await call('cache', undefined, 'GET');
      if (version === generation) cacheSettings = data;
    } catch (e) {
      if (version === generation) cacheError = errorText(e);
    } finally {
      if (version === generation) {
        cacheBusy = false;
        drawSettings();
      }
    }
  }
  function cacheManager() {
    const version = generation;
    const detail = make('details', undefined, 'mail-tools-details');
    detail.open = cacheOpen;
    detail.append(make('summary', 'Header cache settings'));
    detail.addEventListener('toggle', () => {
      if (version !== generation || detail.isConnected === false) return;
      cacheOpen = detail.open;
      if (detail.open && !cacheSettings && !cacheBusy) void refreshCacheSettings();
    });
    const content = make('div', undefined, 'mail-tools-grid');
    if (cacheBusy) {
      content.append(make('p', 'Loading cache settings…', 'fineprint'));
    } else if (cacheError) {
      content.append(make('p', cacheError, 'fineprint error'));
      content.append(button('Retry', () => void refreshCacheSettings()));
    } else if (cacheSettings && cacheSettings.enabled) {
      const healthText = cacheSettings.healthy ? 'Healthy' : 'Needs attention';
      const countVal = Number.isSafeInteger(cacheSettings.maxHeadersPerAccount) ? cacheSettings.maxHeadersPerAccount : 500;
      content.append(make('p', `Status: ${healthText}. Recent inbox coverage (default 500 headers per account).`, 'fineprint'));
      const maxField = inputControl('Max headers per account (100–5000)', countVal, () => {}, 'number');
      maxField.node.min = '100'; maxField.node.max = '5000'; maxField.node.step = '50';
      content.append(maxField.wrapper);
      const save = make('button', 'Save cache settings'); save.type = 'submit';
      content.append(save);
      const clear = button('Clear cache', () => {
        confirm('Clear local mail cache?', 'This permanently clears cached headers. Fresh mail will be fetched on next sync.', () => run(async current => {
          try {
            await call('cache/clear', {}, 'POST');
            if (current()) {
              notice('Cache cleared.');
              await refreshCacheSettings();
              await refreshAll();
            }
          } catch (err) {
            if (current()) notice(errorText(err), true);
          }
        }), 'settings');
      }, 'danger');
      content.append(clear);
      content.addEventListener('submit', async ev => {
        ev.preventDefault();
        const val = Number(maxField.node.value);
        if (!Number.isSafeInteger(val) || val < 100 || val > 5000) {
          notice('Max headers must be a whole number between 100 and 5000.', true);
          return;
        }
        await run(async current => {
          try {
            const res = await call('cache', {maxHeadersPerAccount: val}, 'POST');
            if (current()) {
              cacheSettings = res;
              notice('Cache settings saved.');
              drawSettings();
            }
          } catch (err) {
            if (current()) notice(errorText(err), true);
          }
        });
      });
    } else if (cacheSettings && !cacheSettings.enabled) {
      content.append(make('p', 'Header cache is disabled on this server.', 'fineprint'));
    }
    detail.append(content);
    return detail;
  }
  function drawSettings() {
    if (!settingsHost) return;
    settingsHost.replaceChildren();
    const section = make('section',undefined,'mail-tools-settings'); section.append(folderManager());
    section.append(cacheManager());
    const details = make('details',undefined,'mail-tools-details'); details.open = notificationsOpen;
    details.append(make('summary','New-mail notifications'));
    details.addEventListener('toggle',() => { notificationsOpen = details.open; });
    const row = make('div',undefined,'mail-tools-row');
    row.append(button(notificationState === 'enabled' ? 'Notifications enabled' : 'Enable new-mail notifications',() => void notifications(true)),button('Disable notifications on this device',() => void notifications(false)));
    details.append(row); section.append(details);
    if (confirmation?.scope === 'settings') section.append(confirmationPanel());
    settingsHost.append(section);
    telegramSettings.render(section);
  }
  function draw(force = false) {
    if (!host) return;
    const nextView = JSON.stringify([state.accountId,state.folder]);
    if (viewKey && viewKey !== nextView) { confirmation = null; if (filterDraft) filterDraft.allFolders = state.folder === 'all'; }
    viewKey = nextView;
    const shape = JSON.stringify([state.accountId,state.folder,(state.accounts ?? []).map(item => [item.id,item.connected,item.label]),(state.folders ?? []).map(item => [item.id,item.label]),notificationState]);
    if (!force && shape === lastShape && host.children.length) { updateControls(); return; }
    lastShape = shape; advancedPanel?.remove?.(); host.replaceChildren();
    const section = make('section',undefined,'mail-tools'), row = make('div',undefined,'mail-tools-row'); row.setAttribute('data-mail-selection-summary','');
    const selectLoaded = make('input'); selectLoaded.type = 'checkbox'; selectLoaded.setAttribute('aria-label','Select loaded messages'); selectLoaded.setAttribute('data-mail-select-loaded','');
    selectLoaded.addEventListener('change',() => {
      if (busy || !(state.messages ?? []).length) { updateControls(); return; }
      if (selectLoaded.checked) state.selection = new Set((state.messages ?? []).slice(0,50).map(message => message.id));
      else selected().clear();
      renderList?.(); updateControls();
    });
    const selectionTarget = make('label',undefined,'mail-select-loaded'); selectionTarget.title = 'Select loaded messages'; selectionTarget.append(selectLoaded);
    if (selectionHost) selectionHost.replaceChildren(selectionTarget); else row.append(selectionTarget);
    const count = make('span',`${selected().size} of up to 50 loaded messages selected`,'fineprint'); count.setAttribute('data-mail-selection-count',''); row.append(count);
    const undoButton = button('Undo last move',() => void undo()); undoButton.setAttribute('data-mail-undo',''); row.append(undoButton);
    section.append(row);
    const actions = make('div',undefined,'mail-tools-row'); actions.setAttribute('data-mail-selection-actions',''); actions.hidden = !selected().size;
    const actionSelector = selectControl('Selected action',BULK_ACTIONS,bulk.action,value => { bulk.action = value; });
    actions.append(actionSelector.wrapper);
    const destination = selectControl('Move destination',[['','Move destination']],bulk.destinationId,value => { bulk.destinationId = value; }); destination.node.setAttribute('data-mail-move-target',''); actions.append(destination.wrapper);
    actions.append(selectControl('Local label',[['','Choose local label'],...labels().map(folder => [folder.id.slice(4),folder.label])],bulk.tag,value => { bulk.tag = value; }).wrapper);
    const applyButton = button('Apply to selected',bulkApply); applyButton.setAttribute('data-mail-selected-action',''); actions.append(applyButton); section.append(actions);
    const advancedMount = advancedButton?.closest?.('.mail-control-panel');
    (advancedMount || section).append(advancedFilters());
    if (state.folder === 'trash') { const empty = button('Empty Trash…',emptyTrash,'danger'); empty.setAttribute('data-mail-busy',''); row.append(empty); }
    if (confirmation && confirmation.scope !== 'settings') section.append(confirmationPanel());
    host.append(section); drawSettings(); updateControls();
  }
  function closeProviderDialog() {
    if (!providerDialog) return;
    const dialog = providerDialog; providerDialog = null; dialog.close?.(); dialog.remove?.();
  }
  function renderProviderDialog() {
    if (!providerDialog || !readerMessage) return;
    const dialog = providerDialog, message = readerMessage;
    dialog.replaceChildren();
    const heading = make('div',undefined,'mail-provider-dialog-heading'); heading.append(make('h3','Provider labels'),iconButton('close','Close provider labels',closeProviderDialog)); dialog.append(heading);
    if (!providerData || providerMessageId !== message.id) { dialog.append(make('p','Loading labels…','fineprint')); return; }
    if (!providerData.supported) { dialog.append(make('p','This provider does not offer editable labels or keywords.','fineprint')); return; }
    if (Array.isArray(message.providerLabels) && message.providerLabels.length) dialog.append(make('p',`Applied: ${message.providerLabels.join(', ')}`,'fineprint'));
    const form = make('form',undefined,'mail-provider-label-form'); let label = '';
    form.append(selectControl(providerData.kind === 'gmail' ? 'Gmail label' : 'IMAP keyword',[['','Choose label'],...(providerData.labels ?? []).map(value => [value,value])],'',value => { label = value; }).wrapper);
    if (providerData.allowCreate) form.append(inputControl('Or enter a provider label','',value => { label = value; }).wrapper);
    const actions = make('div',undefined,'mail-tools-row');
    for (const [enabled,title] of [[true,'Add label'],[false,'Remove label']]) actions.append(button(title,() => {
      if (!label.trim()) { notice('Choose or enter a provider label.',true); return; }
      closeProviderDialog();
      void run(async current => { await call('provider-labels/apply',{id:message.id,label:label.trim(),enabled}); if (current()) { await refreshAll(); notice('Provider label updated.'); } });
    }));
    form.append(actions); form.addEventListener('submit',event => event.preventDefault()); dialog.append(form); enhanceSelects(dialog);
  }
  function openProviderLabels(message) {
    closeProviderDialog();
    const dialog = make('dialog',undefined,'mail-provider-dialog'); dialog.setAttribute('aria-label','Provider labels'); providerDialog = dialog;
    dialog.addEventListener('close',() => { if (providerDialog === dialog) providerDialog = null; dialog.remove?.(); });
    dialog.addEventListener('click',event => { if (event.target === dialog && event.clientX !== undefined) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeProviderDialog(); } });
    (document.body || readerHost)?.append(dialog); renderProviderDialog(); dialog.showModal?.();
    void run(async current => {
      try {
        const result = await call('provider-labels',{id:message.id});
        if (current() && readerMessage?.id === message.id) { providerData = result; providerMessageId = message.id; renderProviderDialog(); }
      } catch (error) { closeProviderDialog(); throw error; }
    });
  }
  function drawReader() {
    if (!readerHost || !readerMessage) return;
    readerHost.replaceChildren();
    const message = readerMessage, section = make('section',undefined,'mail-tools-reader'), row = make('div',undefined,'mail-reader-icon-actions');
    row.setAttribute('role','group'); row.setAttribute('aria-label','Message actions');
    const appendAction = control => { control.disabled = busy; control.setAttribute('data-mail-busy',''); row.append(control); };
    for (const [mode,label] of [['reply','Reply'],['reply_all','Reply all'],['forward','Forward'],...(state.folder === 'drafts' ? [['edit','Edit draft']] : [])]) appendAction(iconButton(mode === 'edit' ? 'edit' : mode,label,() => openCompose?.(mode,message)));
    row.append(make('span',undefined,'mail-action-separator'));
    appendAction(iconButton('archive','Archive',() => void apply([message.id],'archive')));
    const move = actionMenu({label:'Move to folder',icon:'move',items:() => providers(message.accountId).map(folder => ({label:folder.label,icon:'folder',onClick:() => void apply([message.id],'move',{destinationId:folder.id})}))});
    move.button.disabled = busy; move.button.setAttribute('data-mail-busy',''); row.append(move.element);
    const spam = state.folder === 'junk' ? ['not_spam','Not spam','check'] : ['spam','Mark as spam','spam'];
    appendAction(iconButton(spam[2],spam[1],() => void apply([message.id],spam[0])));
    appendAction(iconButton('label','Provider labels',() => openProviderLabels(message)));
    if (state.folder === 'trash') {
      appendAction(iconButton('restore','Restore to inbox',() => void apply([message.id],'restore')));
      appendAction(iconButton('trash','Delete permanently',() => void apply([message.id],'delete_permanent'),'danger'));
    }
    section.append(row);
    // Reader remains usable on narrow displays where the toolbar is outside view.
    const panel = confirmationPanel(); if (panel) section.append(panel);
    readerHost.append(section);
  }
  function stop() { polling = false; pollGeneration++; clearTimeout(pollTimer); pollTimer = null; updateRevision = null; }
  function schedule() { if (polling) { pollTimer = setTimeout(poll,30000); pollTimer.unref?.(); } }
  async function poll() {
    if (!polling) return;
    const version = generation, pollVersion = pollGeneration;
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const result = await call('updates',undefined,'GET');
      if (!polling || version !== generation || pollVersion !== pollGeneration) return;
      const changed = updateRevision !== null && result.revision !== updateRevision;
      updateRevision = result.revision;
      if (changed && !busy && !selected().size && !state.selectedId) { await refreshAll(); if (polling && version === generation) notice('Inbox updated with provider changes.'); }
      else if (changed) notice('Inbox changes are available. Refresh when you finish reading or selecting messages.');
    } catch { /* A transient background outage is surfaced by explicit refresh. */ }
    finally { if (version === generation && pollVersion === pollGeneration) schedule(); }
  }
  return {
    render(container, mounts = {}) {
      if (host !== container) { host = container; lastShape = ''; }
      if ('settingsHost' in mounts && settingsHost !== mounts.settingsHost) { telegramSettings.reset(); settingsHost?.replaceChildren(); settingsHost = mounts.settingsHost ?? null; lastShape = ''; }
      if ('advancedButton' in mounts) bindAdvanced(mounts.advancedButton);
      if ('selectionHost' in mounts && selectionHost !== mounts.selectionHost) { selectionHost?.replaceChildren(); selectionHost = mounts.selectionHost ?? null; lastShape = ''; }
      draw();
    },
    renderReader(container,message) { readerHost = container; if (readerMessage?.id !== message?.id) { closeProviderDialog(); providerData = null; providerMessageId = null; confirmation = null; } readerMessage = message; drawReader(); },
    clearReader() { closeProviderDialog(); readerHost?.replaceChildren(); readerHost = null; readerMessage = null; providerData = null; providerMessageId = null; confirmation = null; draw(true); },
    setUndo,
    closeAdvanced,
    getFilterDraft() { return drafts(); },
    clearFilters,
    clearAll: clearFilters,
    readDraft,
    commitDraft,
    removeCriteria,
    restoreCriteria,
    buildFilters(vals) { return buildMailFilters(vals || drafts()); },
    start() { if (!polling) { polling = true; schedule(); } },
    stop,
    reset() { stop(); telegramSettings.reset(); closeAdvanced(); closeProviderDialog(); bindAdvanced(null); advancedPanel?.remove?.(); selectionHost?.replaceChildren(); selectionHost = null; settingsHost?.replaceChildren(); host?.replaceChildren(); settingsHost = null; advancedPanel = null; advancedFirst = null;
      generation++; busy = false; confirmation = null; undoTokens = []; filterDraft = null; providerData = null; providerMessageId = null; readerMessage = null; readerHost = null; host = null; lastShape = ''; viewKey = ''; notificationState = ''; advancedOpen = false; managerOpen = false; notificationsOpen = false;
      labelSync = null; labelSyncBusy = false; labelSyncError = ''; labelSyncControls = null; labelSyncAction = false;
      cacheSettings = null; cacheBusy = false; cacheError = ''; cacheOpen = false;
      Object.assign(manager,{kind:'folder',accountId:'',action:'create',id:'',name:'',parentId:''}); Object.assign(bulk,{action:'mark_read',destinationId:'',tag:''}); }
  };
}
