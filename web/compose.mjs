const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const LIMIT = 25 * 1024 * 1024;
const errors = {
  smtp_login_required: 'Reconnect this account in Accounts, or check its outgoing-mail password. The message was not sent.',
  smtp_not_configured: 'Configure outgoing mail in Accounts before sending.',
  smtp_error: 'The SMTP server rejected this attempt. Check outgoing-mail settings before trying again.',
  send_uncertain: 'Delivery could not be confirmed. Check Sent and the recipient before composing another attempt. Send is locked to prevent duplicates.',
  send_partial: 'Some recipients were accepted and others were rejected. Do not resend to the accepted recipients.',
  sent_copy_failed: 'The message was sent, but its Sent copy could not be saved. Do not send it again.',
  draft_cleanup_failed: 'The previous draft could not be removed. Review Drafts for the old copy.',
  draft_partial: 'The draft may have been saved, but confirmation or cleanup failed. Refresh Drafts before saving another copy.',
  draft_unavailable: 'This mailbox cannot safely save or replace this draft. Its Drafts folder and targeted deletion support are required.',
  attachment_too_large: 'Attachments must total 25 MiB or less.',
  message_too_large: 'This message is too large to edit in MailHarbor.',
  send_history_full: 'The send history is full. Ask the server administrator to archive it before sending more mail.',
  stale_message: 'This draft, account, or message was modified elsewhere. Refresh before editing again.',
  busy: 'The server queue is busy or storage is full. Try again shortly.'
};
const explain = (error, describeError) => errors[error?.code || error] || describeError?.(error) || 'The operation could not be completed. Your text is still here.';
const requestId = () => globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `req_${Math.random().toString(36).slice(2)}${Date.now()}`;
const escapeHtml = str => String(str ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const iconPaths = {
  close: 'M6 6l12 12M6 18L18 6',
  minimize: 'M5 17h14',
  expand: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  restore: 'M8 4h12v12M4 8h12v12H4z',
  attach: 'M9 17l8-8a3 3 0 0 0-4-4L5 13a5 5 0 0 0 7 7l8-8M8 14l7-7',
  save: 'M5 3h12l4 4v14H3V3h2zm2 0v6h10V3M7 21v-8h10v8',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v7M14 10v7',
  bold: 'M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6zm0 8h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z',
  italic: 'M19 4h-9m4 16H5M15 4L9 20',
  underline: 'M6 3v7a6 6 0 0 0 12 0V3M4 21h16',
  listBulleted: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  listNumbered: 'M10 6h11M10 12h11M10 18h11M4 6h1v4m-1 0h2m-2 8h3v-2a1 1 0 0 0-1-1h-1a1 1 0 0 1 0-2h2',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  signature: 'M3 17c3-3 6-5 9-2s6 1 9-4M3 21h18'
};

function icon(name) {
  const value = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  value.setAttribute('viewBox', '0 0 24 24');
  value.setAttribute('aria-hidden', 'true');
  value.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', iconPaths[name] || iconPaths.close);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.7');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  value.append(path);
  return value;
}

const EMAIL_REGEX = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/u;

function isQuoteEscaped(str, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && str[i] === '\\'; i--) {
    slashes++;
  }
  return slashes % 2 === 1;
}

function splitRecipients(value = '') {
  const list = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"' && !isQuoteEscaped(value, i)) {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === ',' && !inQuotes) {
      if (current.trim()) list.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) list.push(current.trim());
  return list;
}

function parseRecipient(item) {
  const trimmed = String(item || '').trim();
  if (!trimmed) return null;
  if (/[\r\n\u0000-\u001f\u007f]/u.test(trimmed)) return { valid: false, address: '', text: trimmed, error: 'Contains invalid characters' };
  const angleMatch = /^(?:"([^"]*)"|([^<]+))?\s*<([^>]+)>$/u.exec(trimmed);
  if (angleMatch) {
    const name = (angleMatch[1] || angleMatch[2] || '').trim();
    const addr = angleMatch[3].trim();
    if (!EMAIL_REGEX.test(addr) || name.length > 300) {
      return { valid: false, address: addr, name, text: trimmed, error: 'Invalid address format' };
    }
    return { valid: true, address: addr, name, text: name ? `"${name}" <${addr}>` : addr };
  }
  if (!EMAIL_REGEX.test(trimmed)) {
    return { valid: false, address: trimmed, text: trimmed, error: 'Invalid address format' };
  }
  return { valid: true, address: trimmed, text: trimmed };
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCharCode(Number(dec)); } catch { return ''; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCharCode(parseInt(hex, 16)); } catch { return ''; }
    });
}

function extractPlainText(node) {
  if (!node) return '';
  if (node.innerText !== undefined) {
    return String(node.innerText).replace(/\r\n/g, '\n').trim();
  }
  const rawHtml = node.innerHTML;
  if (rawHtml !== undefined && rawHtml !== '') {
    return decodeEntities(
      rawHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    ).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return String(node.textContent || '').replace(/\r\n/g, '\n').trim();
}

function calculateBase64Bytes(b64) {
  if (!b64) return 0;
  const len = b64.length;
  let pad = 0;
  if (len > 0 && b64[len - 1] === '=') pad++;
  if (len > 1 && b64[len - 2] === '=') pad++;
  return Math.floor((len * 3) / 4) - pad;
}

function normalizeRichHtml(rawHtml = '') {
  if (!rawHtml) return '';
  let html = String(rawHtml);
  html = html.replace(/<span\s+style="([^"]*)"\s*>([\s\S]*?)<\/span>/gi, (match, style, inner) => {
    let result = inner;
    const lower = style.toLowerCase();
    if (/font-weight:\s*(?:bold|bolder|[7-9]00)/i.test(lower)) {
      result = `<b>${result}</b>`;
    }
    if (/font-style:\s*italic/i.test(lower)) {
      result = `<i>${result}</i>`;
    }
    if (/text-decoration(?:-line)?:\s*underline/i.test(lower)) {
      result = `<u>${result}</u>`;
    }
    return result;
  });
  return html;
}

/** An explicit review precedes every send. Mail content is never stored in browser storage. */
export function createComposeView({ api, describeError, onChanged = () => {}, getRecipients, autosaveDebounceMs = 750 }) {
  const state = {
    generation: 0,
    dirty: false,
    busy: false,
    locked: false,
    minimized: false,
    expanded: false,
    data: null,
    files: [],
    requestId: null,
    accounts: [],
    recoveryId: null,
    recoveryRevision: 0,
    signatures: {},
    autosaveTimer: null,
    savingRecovery: false,
    saveRequested: false,
    savePromise: null,
    forceRecoveryCreation: false,
    editGeneration: 0,
    savedEditGeneration: 0,
    pendingRetrySnapshot: null,
    html: '',
    activeSuggestionIndex: -1
  };

  let dialog, nodes = {}, previousFocus, settingsRevision = 0, settingsHosts = [], settingsPasswords = [], currentAnchor = null;

  function updateDialogClass() {
    if (!dialog) return;
    const classes = ['compose-dialog'];
    if (currentAnchor) classes.push('is-inline');
    if (state.expanded) classes.push('is-expanded');
    if (state.minimized) classes.push('is-minimized');
    dialog.className = classes.join(' ');
  }

  function moveDialogTo(target) {
    if (!dialog || !target || dialog.parentElement === target || dialog.parentNode === target) return;
    target.append(dialog);
  }

  function dock(anchor) {
    if (!dialog || !currentAnchor) return;
    if (anchor !== undefined && anchor !== null && anchor !== currentAnchor) {
      return;
    }
    currentAnchor = null;
    updateDialogClass();
    if (typeof document !== 'undefined' && document.body) {
      moveDialogTo(document.body);
    }
  }


  function button(parent, label, callback, className = 'subtle') {
    const value = make('button', label, className);
    value.type = 'button';
    value.addEventListener('click', callback);
    parent.append(value);
    return value;
  }
  function field(parent, name, label, tag = 'input') {
    const wrapper = make('label', undefined, 'field'), input = make(tag);
    input.name = name;
    wrapper.append(make('span', label), input);
    parent.append(wrapper);
    return input;
  }
  function iconButton(parent, label, symbol, callback, className = 'compose-icon-button') {
    const value = button(parent, '', callback, className);
    value.setAttribute('aria-label', label);
    value.title = label;
    value.append(icon(symbol));
    return value;
  }
  function inlineField(parent, name, label, tag = 'input') {
    const row = make('div', undefined, 'compose-recipient-row'), input = make(tag), caption = make('label', label);
    input.name = name;
    input.id = `compose-${name}`;
    caption.htmlFor = input.id;
    const chips = make('div', undefined, 'compose-chips');
    row.append(caption, chips, input);
    parent.append(row);
    return { row, input, chips };
  }
  function windowSize(minimized = state.minimized, expanded = state.expanded) {
    state.minimized = minimized;
    state.expanded = expanded;
    updateDialogClass();
    nodes.form.hidden = minimized;
    const minimizeLabel = minimized ? 'Restore composer' : 'Minimize composer';
    nodes.minimize.setAttribute('aria-label', minimizeLabel);
    nodes.minimize.title = minimizeLabel;
    nodes.minimize.setAttribute('aria-expanded', String(!minimized));
    const expandLabel = expanded ? 'Restore window size' : 'Expand composer';
    nodes.expand.setAttribute('aria-label', expandLabel);
    nodes.expand.title = expandLabel;
    nodes.expand.replaceChildren(icon(expanded ? 'restore' : 'expand'));
  }
  function show() {
    if (!dialog.open) {
      if (typeof dialog.show === 'function') dialog.show();
      else dialog.showModal();
    }
  }
  function revealRecipient(name) {
    nodes[`${name}Row`].hidden = false;
    nodes[`${name}Toggle`].hidden = true;
    nodes[name].hidden = false;
    nodes[name].focus();
  }
  function feedback(text = '', isError = false) {
    nodes.status.textContent = text;
    nodes.status.hidden = !text;
    nodes.status.className = `compose-feedback ${isError ? 'error' : 'success'}`;
  }
  function setBusy(value) {
    state.busy = value;
    for (const item of [nodes.account, nodes.to, nodes.cc, nodes.bcc, nodes.subject, nodes.text, nodes.file]) {
      if (item) item.disabled = value || state.locked;
    }
    for (const name of ['to', 'cc', 'bcc']) {
      if (nodes[`${name}Edit`]) nodes[`${name}Edit`].disabled = value || state.locked;
    }
    if (nodes.editor) nodes.editor.contentEditable = String(!value && !state.locked);
    nodes.save.disabled = value || state.locked;
    nodes.review.disabled = value || state.locked;
    nodes.send.disabled = value || state.locked;
    nodes.attach.disabled = value || state.locked;
    nodes.ccToggle.disabled = value || state.locked;
    nodes.bccToggle.disabled = value || state.locked;
    nodes.back.disabled = value;
    nodes.close.disabled = value;
    nodes.trash.disabled = value;
    if (nodes.formatButtons) {
      for (const btn of nodes.formatButtons) btn.disabled = value || state.locked;
    }
    for (const item of nodes.removeFiles || []) item.disabled = value || state.locked;
    for (const item of nodes.removeChips || []) item.disabled = value || state.locked;
  }

  function scheduleAutosave() {
    if (state.locked) return;
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(() => {
      saveRecovery().catch(() => {});
    }, autosaveDebounceMs);
  }

  function edited() {
    state.dirty = true;
    state.editGeneration++;
    nodes.reviewPanel.hidden = true;
    if (!state.locked) state.requestId = null;
    scheduleAutosave();
  }

  function ensureRecoveryId() {
    if (!state.recoveryId) {
      state.recoveryId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `comp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      state.recoveryRevision = 0;
    }
    return state.recoveryId;
  }

  function isPristineBlank(cur) {
    return !state.recoveryId &&
      !cur.to.trim() && !cur.cc.trim() && !cur.bcc.trim() &&
      !cur.subject.trim() && !cur.text.trim() &&
      (!cur.attachments || cur.attachments.length === 0);
  }

  function showRecoveryError(err) {
    feedback('Could not save draft. Text preserved. ', true);
    const retryBtn = button(nodes.status, 'Retry', () => saveRecovery().catch(() => {}), 'compose-retry-button compose-text-button');
    retryBtn.setAttribute('aria-label', 'Retry save draft');
  }

  const OVERSIZED_MESSAGE = 'Message is too large to save. Shorten it before saving or sending.';

  function isBodyOverLimit(p) {
    if (!p) return false;
    const textLen = typeof p.text === 'string' ? p.text.length : 0;
    const htmlLen = typeof p.html === 'string' ? p.html.length : 0;
    return textLen > 200000 || htmlLen > 400000;
  }

  function saveRecovery(options = {}) {
    if (state.locked) return Promise.reject(new Error('Draft is locked'));
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;

    if (options.force) {
      state.forceRecoveryCreation = true;
    }
    state.saveRequested = true;

    if (state.savePromise) {
      return state.savePromise;
    }

    const cur = payload();
    if (!state.forceRecoveryCreation && !state.pendingRetrySnapshot && isPristineBlank(cur)) {
      state.saveRequested = false;
      return Promise.resolve();
    }

    const generation = state.generation;

    let drainPromise;
    drainPromise = Promise.resolve().then(async () => {
      try {
        while (state.saveRequested && generation === state.generation && !state.locked) {
          state.saveRequested = false;
          const currentPayload = payload();
          if (!state.forceRecoveryCreation && !state.pendingRetrySnapshot && isPristineBlank(currentPayload)) {
            break;
          }

          if (isBodyOverLimit(currentPayload) || (state.pendingRetrySnapshot && isBodyOverLimit(state.pendingRetrySnapshot.content))) {
            feedback(OVERSIZED_MESSAGE, true);
            throw new Error(OVERSIZED_MESSAGE);
          }

          state.savingRecovery = true;
          feedback('Saving draft…');

          ensureRecoveryId();
          const snapshot = state.pendingRetrySnapshot || {
            id: state.recoveryId,
            revision: state.recoveryRevision,
            content: {
              accountId: String(currentPayload.accountId || ''),
              to: String(currentPayload.to || ''),
              cc: String(currentPayload.cc || ''),
              bcc: String(currentPayload.bcc || ''),
              subject: String(currentPayload.subject || ''),
              text: String(currentPayload.text || ''),
              ...(currentPayload.html ? { html: String(currentPayload.html) } : {}),
              attachments: state.files.map(f => ({ ...f })),
              inReplyTo: String(state.data?.inReplyTo || ''),
              references: String(state.data?.references || ''),
              providerDraftId: state.data?.draftId || null
            },
            editGeneration: state.editGeneration
          };

          const body = {
            composeId: snapshot.id,
            revision: snapshot.revision,
            content: snapshot.content
          };

          let result;
          try {
            result = await api('/api/mail/compose/recovery', { method: 'POST', body, timeout: 30000 });
          } catch (err) {
            if (generation === state.generation) {
              state.pendingRetrySnapshot = snapshot;
              showRecoveryError(err);
            }
            throw err;
          }

          if (generation !== state.generation) return;

          state.recoveryId = result.composeId || snapshot.id;
          state.recoveryRevision = result.revision !== undefined ? result.revision : snapshot.revision + 1;
          state.savedEditGeneration = snapshot.editGeneration;
          state.pendingRetrySnapshot = null;
          state.forceRecoveryCreation = false;

          if (state.editGeneration === snapshot.editGeneration) {
            state.dirty = false;
          }
          feedback('Draft saved');

          if (state.editGeneration > snapshot.editGeneration) {
            state.saveRequested = true;
          }
        }
      } finally {
        if (generation === state.generation && state.savePromise === drainPromise) {
          state.savePromise = null;
          state.savingRecovery = false;
        }
      }
    });

    state.savePromise = drainPromise;
    return drainPromise;
  }

  async function flushRecovery(force = false) {
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
    if (state.locked) throw new Error('Draft is locked');

    if (force) {
      state.forceRecoveryCreation = true;
    }

    const cur = payload();
    if (isBodyOverLimit(cur) || (state.pendingRetrySnapshot && isBodyOverLimit(state.pendingRetrySnapshot.content))) {
      feedback(OVERSIZED_MESSAGE, true);
      if (state.savePromise) {
        try {
          await state.savePromise;
        } catch {}
      }
      throw new Error(OVERSIZED_MESSAGE);
    }

    const needsSave = force ||
      !isPristineBlank(cur) ||
      state.pendingRetrySnapshot ||
      state.dirty ||
      state.savedEditGeneration < state.editGeneration ||
      Boolean(state.savePromise);

    const generation = state.generation;
    if (needsSave) {
      state.saveRequested = true;
      if (!state.savePromise) {
        await saveRecovery({ force });
      } else {
        await state.savePromise;
      }
    }

    if (generation !== state.generation) return;

    while (state.savePromise || ((state.dirty || state.savedEditGeneration < state.editGeneration || state.pendingRetrySnapshot) && !state.locked)) {
      if (generation !== state.generation) return;
      if (state.savePromise) {
        await state.savePromise;
      } else {
        await saveRecovery({ force });
      }
    }

    if (needsSave && !state.locked && state.savedEditGeneration < state.editGeneration) {
      throw new Error('Could not save latest draft edits');
    }
  }

  function renderRecipientChips(name) {
    const container = nodes[`${name}Chips`];
    if (!container) return;
    if (nodes.removeChips) {
      nodes.removeChips = nodes.removeChips.filter(btn => !container.contains(btn));
    } else {
      nodes.removeChips = [];
    }
    container.replaceChildren();
    const raw = nodes[name].value;
    const items = splitRecipients(raw);
    container.hidden = false;
    nodes[name].hidden = items.length > 0;
    if (nodes[`${name}Edit`]) nodes[`${name}Edit`].hidden = items.length === 0;
    items.forEach((item, index) => {
      const parsed = parseRecipient(item);
      const chip = make('span', undefined, `compose-chip${parsed?.valid === false ? ' is-invalid' : ''}`);
      const label = make('span', parsed?.name || parsed?.address || item);
      label.title = item;
      const remove = button(chip, '×', () => {
        if (state.busy || state.locked) return;
        items.splice(index, 1);
        nodes[name].value = items.join(', ');
        renderRecipientChips(name);
        edited();
      }, 'compose-chip-remove-button');
      remove.setAttribute('aria-label', `Remove ${item}`);
      remove.disabled = state.busy || state.locked;
      nodes.removeChips.push(remove);
      chip.prepend(label);
      container.append(chip);
    });
  }

  function fileList() {
    nodes.files.replaceChildren();
    nodes.removeFiles = [];
    state.files.forEach((value, index) => {
      const row = make('li'), filename = make('span', value.filename, 'compose-file-name');
      filename.title = value.filename;
      row.append(icon('attach'), filename, make('span', `${Math.ceil(value.content.length * 3 / 4 / 1024)} KiB`, 'compose-file-size'));
      const remove = iconButton(row, `Remove ${value.filename}`, 'close', () => {
        if (state.busy || state.locked) return;
        state.files.splice(index, 1);
        fileList();
        edited();
      }, 'compose-icon-button compose-chip-remove');
      remove.disabled = state.busy || state.locked;
      nodes.removeFiles.push(remove);
      nodes.files.append(row);
    });
  }

  function clear() {
    state.generation++;
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
    state.dirty = false;
    state.busy = false;
    state.locked = false;
    state.data = null;
    state.files = [];
    state.accounts = [];
    state.requestId = null;
    state.recoveryId = null;
    state.recoveryRevision = 0;
    state.savingRecovery = false;
    state.saveRequested = false;
    state.savePromise = null;
    state.forceRecoveryCreation = false;
    state.pendingRetrySnapshot = null;
    state.savedEditGeneration = 0;
    state.editGeneration = 0;
    state.html = '';
    state.signatures = {};
    state.activeSuggestionIndex = -1;

    currentAnchor = null;
    if (dialog) {
      dialog.close();
      if (typeof document !== 'undefined' && document.body) {
        moveDialogTo(document.body);
      }
      windowSize(false, false);
      for (const key of ['to', 'cc', 'bcc', 'subject', 'text', 'file']) {
        if (nodes[key]) nodes[key].value = '';
      }
      if (nodes.editor) nodes.editor.textContent = '';
      for (const name of ['to', 'cc', 'bcc']) {
        if (nodes[`${name}Chips`]) nodes[`${name}Chips`].replaceChildren();
        if (nodes[name]) nodes[name].hidden = false;
        if (nodes[`${name}Edit`]) nodes[`${name}Edit`].hidden = true;
      }
      for (const name of ['cc', 'bcc']) {
        if (nodes[`${name}Row`]) nodes[`${name}Row`].hidden = true;
        if (nodes[`${name}Toggle`]) nodes[`${name}Toggle`].hidden = false;
      }
      nodes.account.replaceChildren();
      nodes.files.replaceChildren();
      nodes.removeFiles = [];
      nodes.removeChips = [];
      nodes.reviewText.replaceChildren();
      nodes.reviewPanel.hidden = true;
      nodes.discard.hidden = true;
      if (nodes.recoveryBanner) {
        nodes.recoveryBanner.replaceChildren();
        nodes.recoveryBanner.hidden = true;
      }
      if (nodes.signaturePanel) {
        nodes.signaturePanel.hidden = true;
        if (nodes.signatureInput) nodes.signatureInput.value = '';
      }
      if (nodes.linkPanel) {
        nodes.linkPanel.hidden = true;
        if (nodes.linkInput) nodes.linkInput.value = '';
      }
      if (nodes.suggestions) {
        nodes.suggestions.replaceChildren();
        nodes.suggestions.hidden = true;
      }
      feedback();
    }
  }

  async function discardRecovery(composeId, revision) {
    const idToDiscard = composeId || state.recoveryId;
    const revToDiscard = revision !== undefined ? revision : state.recoveryRevision;
    if (!idToDiscard) return;
    await api('/api/mail/compose/recovery/discard', {
      method: 'POST',
      body: { composeId: idToDiscard, ...(revToDiscard !== undefined ? { revision: revToDiscard } : {}) }
    });
  }

  async function explicitDiscard() {
    if (state.busy) return;
    const generation = state.generation;
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
    state.saveRequested = false;
    setBusy(true);
    try {
      if (state.savePromise) {
        await state.savePromise;
      }
      if (generation !== state.generation) return;
      if (state.pendingRetrySnapshot) {
        await saveRecovery();
      }
      if (generation !== state.generation) return;
      if (state.recoveryId) {
        await discardRecovery(state.recoveryId, state.recoveryRevision);
      }
      if (generation === state.generation) {
        clear();
        previousFocus?.focus?.();
      }
    } catch (err) {
      if (generation === state.generation) {
        nodes.discard.hidden = true;
        setBusy(false);
        feedback(explain(err, describeError) || 'Could not discard draft. Your text is still here.', true);
      }
    }
  }

  function close() {
    if (state.busy) return;
    if (state.dirty && !state.locked) {
      windowSize(false);
      nodes.discard.hidden = false;
      nodes.stay.focus();
      return;
    }
    clear();
    previousFocus?.focus?.();
  }

  async function addFiles(selected) {
    const generation = state.generation;
    if (state.busy || state.locked) return;

    const existing = state.files.reduce((sum, value) => sum + calculateBase64Bytes(value.content), 0);
    const selectedTotal = selected.reduce((sum, file) => sum + (file.size || 0), 0);

    if (selected.length + state.files.length > 50 || existing + selectedTotal > LIMIT) {
      feedback('Attachments must total 25 MiB or less.', true);
      if (nodes.file) nodes.file.value = '';
      return;
    }

    setBusy(true);
    try {
      const additions = [];
      for (const file of selected) {
        if (generation !== state.generation) return;
        if ((file.size || 0) > LIMIT) {
          throw { code: 'attachment_too_large' };
        }
        const buffer = await file.arrayBuffer();
        if (generation !== state.generation) return;

        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let start = 0; start < bytes.length; start += 32768) {
          binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
        }
        const filename = (file.name || 'attachment').replace(/[\\/\u0000-\u001f\u007f]/gu, '_').slice(0, 200) || 'attachment';
        additions.push({
          filename,
          mimeType: file.type || 'application/octet-stream',
          content: btoa(binary)
        });
      }
      if (generation !== state.generation) return;
      state.files.push(...additions);
      fileList();
      edited();
      feedback();
    } catch (error) {
      if (generation === state.generation) {
        feedback(explain(error, describeError), true);
      }
    } finally {
      if (generation === state.generation) {
        if (nodes.file) nodes.file.value = '';
        setBusy(false);
      }
    }
  }

  function formatDoc(command, value = null) {
    if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
      try {
        document.execCommand('styleWithCSS', false, false);
      } catch {}
      try {
        document.execCommand(command, false, value);
      } catch {}
    }
    if (nodes.editor) {
      state.html = normalizeRichHtml(nodes.editor.innerHTML);
      nodes.text.value = extractPlainText(nodes.editor);
    }
    edited();
  }

  function setupToolbarButton(btn, callback) {
    btn.addEventListener('mousedown', event => {
      event.preventDefault?.();
    });
    btn.addEventListener('click', () => {
      callback();
      if (nodes.editor) nodes.editor.focus();
    });
  }

  function openLinkPanel() {
    nodes.linkPanel.hidden = !nodes.linkPanel.hidden;
    if (!nodes.linkPanel.hidden) {
      nodes.linkInput.value = '';
      nodes.linkInput.focus();
    }
  }

  async function loadSignature(accountId) {
    if (!accountId) return '';
    if (state.signatures[accountId] !== undefined) return state.signatures[accountId];
    const gen = state.generation;
    try {
      const res = await api('/api/mail/compose/preferences/read', { method: 'POST', body: { accountId } });
      if (gen !== state.generation) return '';
      if (res && res.signature !== undefined) {
        state.signatures[accountId] = res.signature;
        return res.signature;
      }
    } catch {}
    return '';
  }

  async function insertSignature() {
    const accountId = nodes.account.value;
    const gen = state.generation;
    let sig = state.signatures[accountId];
    if (sig === undefined) sig = await loadSignature(accountId);
    if (gen !== state.generation || nodes.account.value !== accountId) return;

    if (!sig) {
      toggleSignaturePanel();
      return;
    }
    const cleanSig = String(sig).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
    const signatureText = `\n\n-- \n${cleanSig}`;
    nodes.text.value += signatureText;
    if (nodes.editor) {
      const sigHtml = `<p><br></p><p>-- <br>${escapeHtml(cleanSig).replace(/\n/g, '<br>')}</p>`;
      nodes.editor.innerHTML += sigHtml;
      state.html = nodes.editor.innerHTML;
    }
    edited();
    feedback('Signature inserted.');
  }

  function toggleSignaturePanel() {
    nodes.signaturePanel.hidden = !nodes.signaturePanel.hidden;
    if (!nodes.signaturePanel.hidden) {
      const accountId = nodes.account.value;
      nodes.signatureInput.value = state.signatures[accountId] || '';
      nodes.signatureInput.focus();
    }
  }

  function collectKnownIdentities() {
    const list = [];
    for (const acc of state.accounts) {
      if (acc.email) list.push({ name: acc.label || '', address: acc.email });
    }
    if (state.data) {
      for (const f of ['to', 'cc', 'from']) {
        const raw = state.data[f];
        if (typeof raw === 'string') {
          for (const item of splitRecipients(raw)) {
            const p = parseRecipient(item);
            if (p?.valid) list.push({ name: p.name || '', address: p.address });
          }
        }
      }
    }
    if (typeof getRecipients === 'function') {
      try {
        const extra = getRecipients();
        if (Array.isArray(extra)) {
          for (const item of extra) {
            if (item?.address) list.push({ name: item.name || '', address: item.address });
          }
        }
      } catch {}
    }
    const seen = new Set();
    return list.filter(item => {
      const key = item.address.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function showSuggestions(input, query) {
    const cleanQuery = query.trim().toLowerCase();
    if (!cleanQuery) {
      nodes.suggestions.hidden = true;
      state.activeSuggestionIndex = -1;
      return;
    }
    const known = collectKnownIdentities();
    const matches = known.filter(k => k.address.toLowerCase().includes(cleanQuery) || k.name.toLowerCase().includes(cleanQuery)).slice(0, 5);
    if (!matches.length) {
      nodes.suggestions.hidden = true;
      state.activeSuggestionIndex = -1;
      return;
    }
    nodes.suggestions.replaceChildren();
    state.activeSuggestionIndex = -1;
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const li = make('li');
      li.setAttribute('role', 'presentation');
      const item = button(li, `${match.name ? `${match.name} ` : ''}<${match.address}>`, () => {
        const existing = splitRecipients(input.value);
        existing.pop();
        existing.push(match.name ? `"${match.name.replace(/"/g, '')}" <${match.address}>` : match.address);
        input.value = existing.join(', ') + ', ';
        nodes.suggestions.hidden = true;
        state.activeSuggestionIndex = -1;
        renderRecipientChips(input.name);
        (input.hidden ? nodes[`${input.name}Edit`] : input)?.focus({preventScroll: true});
        edited();
      }, 'compose-suggestion-item');
      item.setAttribute('role', 'option');
      item.setAttribute('id', `compose-sug-${i}`);
      nodes.suggestions.append(li);
    }
    nodes.suggestions.hidden = false;
  }

  function renderRecoveryChooser(drafts = []) {
    if (!drafts || drafts.length === 0) {
      nodes.recoveryBanner.replaceChildren();
      nodes.recoveryBanner.hidden = true;
      return;
    }
    nodes.recoveryBanner.replaceChildren();
    const title = make('div', undefined, 'compose-recovery-title');
    title.append(make('strong', `Recoverable drafts (${drafts.length}):`));
    nodes.recoveryBanner.append(title);

    const list = make('ul', undefined, 'compose-recovery-list');
    for (const draft of drafts) {
      const item = make('li', undefined, 'compose-recovery-item');
      const acct = state.accounts.find(a => a.accountId === draft.accountId);
      const acctLabel = acct ? `${acct.label} <${acct.email}>` : draft.accountId;
      const timeStr = draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : '';
      const info = make('div', undefined, 'compose-recovery-info');
      info.append(
        make('span', draft.subject ? `Subject: ${draft.subject}` : '(no subject)', 'compose-recovery-subject'),
        make('span', ` • ${acctLabel}`, 'compose-recovery-account'),
        make('span', timeStr ? ` • ${timeStr}` : '', 'compose-recovery-time'),
        draft.locked ? make('span', ' [Locked]', 'compose-recovery-locked') : make('span', '')
      );
      item.append(info);

      const actions = make('div', undefined, 'compose-recovery-actions');
      button(actions, 'Restore', () => restoreRecovery(draft.composeId), 'compose-text-button');
      const discardBtn = button(actions, 'Discard', async () => {
        if (state.busy || state.locked) return;
        discardBtn.disabled = true;
        try {
          await discardRecovery(draft.composeId, draft.revision);
          item.remove();
          if (list.children.length === 0) {
            nodes.recoveryBanner.replaceChildren();
            nodes.recoveryBanner.hidden = true;
          }
        } catch (err) {
          feedback(explain(err, describeError) || 'Could not discard draft.', true);
          discardBtn.disabled = false;
        }
      }, 'compose-text-button compose-discard-confirm');
      item.append(actions);
      list.append(item);
    }
    nodes.recoveryBanner.append(list);
    button(nodes.recoveryBanner, 'Dismiss all', () => {
      nodes.recoveryBanner.hidden = true;
    }, 'compose-text-button');
    nodes.recoveryBanner.hidden = false;
  }

  function build() {
    if (dialog) return;
    nodes.removeFiles = [];
    nodes.removeChips = [];
    nodes.formatButtons = [];
    dialog = make('dialog', undefined, 'compose-dialog');
    dialog.setAttribute('aria-labelledby', 'compose-title');
    const heading = make('div', undefined, 'compose-heading');
    nodes.title = make('h2', 'New message');
    nodes.title.id = 'compose-title';
    heading.append(nodes.title);

    const windowActions = make('div', undefined, 'compose-window-actions');
    nodes.minimize = iconButton(windowActions, 'Minimize composer', 'minimize', () => {
      dock();
      windowSize(!state.minimized);
      if (!state.minimized) {
        if (nodes.editor) nodes.editor.focus();
        else nodes.text.focus();
      }
    });
    nodes.expand = iconButton(windowActions, 'Expand composer', 'expand', () => {
      dock();
      windowSize(false, !state.expanded);
      if (nodes.editor) nodes.editor.focus();
      else nodes.text.focus();
    });
    nodes.close = iconButton(windowActions, 'Close composer', 'close', close);
    heading.append(windowActions);
    dialog.append(heading);

    nodes.recoveryBanner = make('div', undefined, 'compose-recovery-banner');
    nodes.recoveryBanner.hidden = true;
    dialog.append(nodes.recoveryBanner);

    nodes.form = make('form', undefined, 'compose-form');
    nodes.form.addEventListener('submit', event => {
      event.preventDefault();
      review();
    });
    const content = make('div', undefined, 'compose-content'), recipients = make('div', undefined, 'compose-recipients');
    nodes.account = inlineField(recipients, 'accountId', 'From', 'select').input;
    const to = inlineField(recipients, 'to', 'To');
    nodes.to = to.input;
    nodes.toChips = to.chips;
    nodes.toRow = to.row;
    const recipientActions = make('div', undefined, 'compose-recipient-actions');
    for (const [name, label] of [['cc', 'Cc'], ['bcc', 'Bcc']]) {
      nodes[`${name}Toggle`] = button(recipientActions, label, () => revealRecipient(name), 'compose-recipient-toggle');
      nodes[`${name}Toggle`].setAttribute('aria-controls', `compose-${name}-row`);
      const f = inlineField(recipients, name, label);
      nodes[name] = f.input;
      nodes[`${name}Chips`] = f.chips;
      nodes[`${name}Row`] = f.row;
      f.row.id = `compose-${name}-row`;
      f.row.hidden = true;
    }
    to.row.append(recipientActions);
    for (const [name, label] of [['to', 'To'], ['cc', 'Cc'], ['bcc', 'Bcc']]) {
      const beginEdit = () => {
        if (state.busy || state.locked) return;
        nodes[name].hidden = false;
        nodes[`${name}Chips`].hidden = true;
        nodes[`${name}Edit`].hidden = true;
      };
      nodes[`${name}Edit`] = button(nodes[`${name}Row`], 'Edit', () => {
        beginEdit();
        nodes[name].focus();
      }, 'compose-recipient-toggle');
      nodes[`${name}Edit`].setAttribute('aria-label', `Edit ${label} recipients`);
      nodes[`${name}Edit`].hidden = true;
      nodes[name].addEventListener('focus', beginEdit);
    }
    for (const value of [nodes.to, nodes.cc, nodes.bcc]) {
      value.autocomplete = 'off';
      value.spellcheck = false;
      value.setAttribute('autocapitalize', 'none');
      value.maxLength = 10000;
    }
    content.append(recipients);

    nodes.suggestions = make('ul', undefined, 'compose-suggestions');
    nodes.suggestions.setAttribute('role', 'listbox');
    nodes.suggestions.setAttribute('aria-label', 'Recipient suggestions');
    nodes.suggestions.hidden = true;
    content.append(nodes.suggestions);

    const subjectRow = make('div', undefined, 'compose-subject-row');
    nodes.subject = make('input');
    nodes.subject.name = 'subject';
    nodes.subject.placeholder = 'Subject';
    nodes.subject.setAttribute('aria-label', 'Subject');
    nodes.subject.maxLength = 998;
    subjectRow.append(nodes.subject);
    content.append(subjectRow);

    // Formatting Toolbar
    const toolbar = make('div', undefined, 'compose-toolbar');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Formatting options');

    const boldBtn = iconButton(toolbar, 'Bold', 'bold', () => formatDoc('bold'), 'compose-format-button');
    setupToolbarButton(boldBtn, () => formatDoc('bold'));

    const italicBtn = iconButton(toolbar, 'Italic', 'italic', () => formatDoc('italic'), 'compose-format-button');
    setupToolbarButton(italicBtn, () => formatDoc('italic'));

    const underlineBtn = iconButton(toolbar, 'Underline', 'underline', () => formatDoc('underline'), 'compose-format-button');
    setupToolbarButton(underlineBtn, () => formatDoc('underline'));

    const listBulletedBtn = iconButton(toolbar, 'Bulleted list', 'listBulleted', () => formatDoc('insertUnorderedList'), 'compose-format-button');
    setupToolbarButton(listBulletedBtn, () => formatDoc('insertUnorderedList'));

    const listNumberedBtn = iconButton(toolbar, 'Numbered list', 'listNumbered', () => formatDoc('insertOrderedList'), 'compose-format-button');
    setupToolbarButton(listNumberedBtn, () => formatDoc('insertOrderedList'));

    const linkBtn = iconButton(toolbar, 'Insert link', 'link', openLinkPanel, 'compose-format-button');
    setupToolbarButton(linkBtn, openLinkPanel);

    const sigBtn = iconButton(toolbar, 'Insert signature', 'signature', insertSignature, 'compose-format-button');
    setupToolbarButton(sigBtn, insertSignature);

    const editSigBtn = button(toolbar, 'Edit signature', toggleSignaturePanel, 'compose-text-button compose-edit-sig-button');

    nodes.formatButtons = [boldBtn, italicBtn, underlineBtn, listBulletedBtn, listNumberedBtn, linkBtn, sigBtn, editSigBtn];
    content.append(toolbar);

    // Link Panel
    nodes.linkPanel = make('div', undefined, 'compose-link-panel');
    nodes.linkPanel.hidden = true;
    const linkLabel = make('label', 'Link URL');
    nodes.linkInput = make('input', undefined, 'compose-link-input');
    nodes.linkInput.type = 'url';
    nodes.linkInput.placeholder = 'https://example.com or mailto:...';
    const linkActions = make('div', undefined, 'compose-link-actions');
    button(linkActions, 'Insert', () => {
      const url = nodes.linkInput.value.trim();
      if (!url || !/^(?:https?:\/\/|mailto:)/iu.test(url) || /[\u0000-\u0020\u007f]/u.test(url)) {
        feedback('Please enter a valid URL starting with http://, https://, or mailto:.', true);
        return;
      }
      formatDoc('createLink', url);
      nodes.linkPanel.hidden = true;
      nodes.linkInput.value = '';
      if (nodes.editor) nodes.editor.focus();
    }, 'compose-send-button');
    button(linkActions, 'Cancel', () => {
      nodes.linkPanel.hidden = true;
      nodes.linkInput.value = '';
      if (nodes.editor) nodes.editor.focus();
    }, 'compose-text-button');
    nodes.linkPanel.append(linkLabel, nodes.linkInput, linkActions);
    content.append(nodes.linkPanel);

    // Signature Panel
    nodes.signaturePanel = make('div', undefined, 'compose-signature-panel');
    nodes.signaturePanel.hidden = true;
    const sigLabel = make('label', 'Signature');
    nodes.signatureInput = make('textarea', undefined, 'compose-signature-textarea');
    nodes.signatureInput.rows = 3;
    nodes.signatureInput.maxLength = 10000;
    const sigActions = make('div', undefined, 'compose-signature-actions');
    const saveSigBtn = button(sigActions, 'Save signature', async () => {
      const accountId = nodes.account.value;
      const sig = nodes.signatureInput.value;
      saveSigBtn.disabled = true;
      const gen = state.generation;
      try {
        await api('/api/mail/compose/preferences', { method: 'POST', body: { accountId, signature: sig } });
        if (gen !== state.generation || nodes.account.value !== accountId) return;
        state.signatures[accountId] = sig;
        feedback('Signature saved.');
        nodes.signaturePanel.hidden = true;
      } catch (err) {
        if (gen === state.generation) feedback(explain(err, describeError), true);
      } finally {
        if (gen === state.generation) saveSigBtn.disabled = false;
      }
    }, 'compose-send-button');
    button(sigActions, 'Cancel', () => {
      nodes.signaturePanel.hidden = true;
    }, 'compose-text-button');
    nodes.signaturePanel.append(sigLabel, nodes.signatureInput, sigActions);
    content.append(nodes.signaturePanel);

    // Visual ContentEditable Editor
    nodes.editor = make('div', undefined, 'compose-editor-content');
    nodes.editor.contentEditable = 'true';
    nodes.editor.setAttribute('role', 'textbox');
    nodes.editor.setAttribute('aria-multiline', 'true');
    nodes.editor.setAttribute('aria-label', 'Message body');

    // Hidden Canonical Textarea for test and form compatibility
    nodes.text = make('textarea', undefined, 'compose-editor');
    nodes.text.name = 'text';
    nodes.text.rows = 1;
    nodes.text.maxLength = 200000;
    nodes.text.spellcheck = true;
    nodes.text.hidden = true;
    nodes.text.tabIndex = -1;
    nodes.text.setAttribute('aria-hidden', 'true');

    content.append(nodes.editor);
    content.append(nodes.text);

    nodes.file = make('input');
    nodes.file.name = 'attachments';
    nodes.file.type = 'file';
    nodes.file.multiple = true;
    nodes.file.hidden = true;
    nodes.file.setAttribute('aria-label', 'Add attachments (25 MiB total)');
    content.append(nodes.file);

    nodes.files = make('ul', undefined, 'compose-files');
    content.append(nodes.files);
    nodes.form.append(content);

    // File picker listener
    nodes.file.addEventListener('change', async () => {
      if (nodes.file.files?.length) await addFiles([...nodes.file.files]);
    });

    // Drag and drop listeners
    nodes.form.addEventListener('dragover', event => {
      event.preventDefault?.();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    nodes.form.addEventListener('drop', async event => {
      event.preventDefault?.();
      const droppedFiles = event.dataTransfer?.files;
      if (droppedFiles && droppedFiles.length > 0) {
        await addFiles([...droppedFiles]);
      }
    });

    // Paste handling on editor
    nodes.editor.addEventListener('paste', async event => {
      event.preventDefault?.();
      if (!event.clipboardData) return;
      const files = [...(event.clipboardData.files || [])].filter(f => /^image\/(png|jpeg|gif|webp|avif)$/iu.test(f.type));
      if (files.length > 0) {
        await addFiles(files);
        return;
      }
      const text = event.clipboardData.getData('text/plain');
      if (text) {
        formatDoc('insertText', text);
      }
    });

    // Contenteditable input event
    nodes.editor.addEventListener('input', () => {
      state.html = normalizeRichHtml(nodes.editor.innerHTML);
      nodes.text.value = extractPlainText(nodes.editor);
      edited();
    });

    // Textarea input listener
    nodes.text.addEventListener('input', () => {
      if (nodes.editor) {
        nodes.editor.textContent = nodes.text.value;
        state.html = '';
      }
      edited();
    });

    // Recipient inputs listeners
    for (const name of ['to', 'cc', 'bcc']) {
      nodes[name].addEventListener('input', () => {
        edited();
        const parts = splitRecipients(nodes[name].value);
        const last = parts[parts.length - 1] || '';
        if (last && !last.includes('@')) showSuggestions(nodes[name], last);
        else nodes.suggestions.hidden = true;
      });
      nodes[name].addEventListener('blur', () => {
        setTimeout(() => {
          if (nodes.suggestions) nodes.suggestions.hidden = true;
        }, 200);
        renderRecipientChips(name);
      });
      nodes[name].addEventListener('keydown', event => {
        if (nodes.suggestions.hidden) return;
        const items = nodes.suggestions.querySelectorAll('.compose-suggestion-item');
        if (!items.length) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          state.activeSuggestionIndex = (state.activeSuggestionIndex + 1) % items.length;
          items[state.activeSuggestionIndex]?.focus?.();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          state.activeSuggestionIndex = (state.activeSuggestionIndex - 1 + items.length) % items.length;
          items[state.activeSuggestionIndex]?.focus?.();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation?.();
          nodes.suggestions.hidden = true;
          state.activeSuggestionIndex = -1;
        }
      });
    }

    nodes.subject.addEventListener('input', edited);

    // Account change listener
    nodes.account.addEventListener('change', async () => {
      const selectedAccountId = nodes.account.value;
      if (state.data?.draftId) {
        nodes.account.value = state.data.accountId;
        feedback('An existing draft must stay in its original account.', true);
        return;
      }
      edited();
      const gen = state.generation;
      await loadSignature(selectedAccountId);
      if (gen !== state.generation || nodes.account.value !== selectedAccountId) return;
    });

    nodes.status = make('p', undefined, 'compose-feedback');
    nodes.status.setAttribute('role', 'status');
    nodes.status.hidden = true;
    nodes.form.append(nodes.status);

    nodes.reviewPanel = make('section', undefined, 'compose-review');
    nodes.reviewPanel.hidden = true;
    const reviewHeading = make('h3', 'Ready to send?');
    reviewHeading.id = 'compose-review-title';
    nodes.reviewPanel.setAttribute('aria-labelledby', reviewHeading.id);
    nodes.reviewPanel.append(reviewHeading);
    nodes.reviewText = make('div', undefined, 'compose-review-details');
    nodes.reviewPanel.append(nodes.reviewText);

    const finalActions = make('div', undefined, 'compose-review-actions');
    nodes.back = button(finalActions, 'Keep editing', () => {
      nodes.reviewPanel.hidden = true;
      if (nodes.editor) nodes.editor.focus();
      else nodes.text.focus();
    }, 'compose-text-button');
    nodes.send = button(finalActions, 'Send', send, 'compose-send-button');
    nodes.send.setAttribute('aria-label', 'Send message');
    nodes.reviewPanel.append(finalActions);
    nodes.form.append(nodes.reviewPanel);

    nodes.discard = make('div', undefined, 'compose-discard');
    nodes.discard.hidden = true;
    nodes.discard.append(make('p', 'Discard unsaved changes?'));
    const discardActions = make('div', undefined, 'compose-review-actions');
    nodes.stay = button(discardActions, 'Keep writing', () => {
      nodes.discard.hidden = true;
      if (nodes.editor) nodes.editor.focus();
      else nodes.text.focus();
    }, 'compose-text-button');
    button(discardActions, 'Discard changes', explicitDiscard, 'compose-text-button compose-discard-confirm');
    nodes.discard.append(discardActions);
    nodes.form.append(nodes.discard);

    const actions = make('div', undefined, 'compose-actions');
    nodes.review = button(actions, 'Send', review, 'compose-send-button compose-send-primary');
    nodes.review.title = 'Review before sending';
    nodes.attach = iconButton(actions, 'Attach files', 'attach', () => {
      if (!state.busy && !state.locked) nodes.file.click();
    });
    nodes.attach.title = 'Attach files (25 MiB total)';
    nodes.save = iconButton(actions, 'Save draft', 'save', save, 'compose-draft-button');
    nodes.save.append(make('span', 'Save draft'));
    nodes.trash = iconButton(actions, 'Discard unsaved changes', 'trash', () => {
      if (state.busy) return;
      if (state.dirty && !state.locked) {
        windowSize(false);
        nodes.discard.hidden = false;
        nodes.stay.focus();
        return;
      }
      return explicitDiscard();
    }, 'compose-icon-button compose-discard-button');
    nodes.form.append(actions);

    dialog.append(nodes.form);
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation?.();
        close();
      }
    });

    if (typeof globalThis.window !== 'undefined') {
      globalThis.window.addEventListener('beforeunload', event => {
        if (state.dirty && !state.locked) {
          event.preventDefault();
          event.returnValue = '';
        }
      });
    }

    document.body.append(dialog);
  }

  function payload() {
    let textVal = nodes.text ? nodes.text.value : '';
    let htmlVal = state.html || '';
    if (nodes.editor && nodes.editor.innerHTML && !textVal) {
      textVal = extractPlainText(nodes.editor);
      nodes.text.value = textVal;
      htmlVal = normalizeRichHtml(nodes.editor.innerHTML);
    } else if (htmlVal) {
      htmlVal = normalizeRichHtml(htmlVal);
    }
    return {
      accountId: nodes.account ? nodes.account.value : '',
      ...(state.data?.draftId ? { draftId: state.data.draftId } : {}),
      ...(state.recoveryId ? { composeId: state.recoveryId, recoveryRevision: state.recoveryRevision } : {}),
      to: nodes.to ? nodes.to.value : '',
      cc: nodes.cc ? nodes.cc.value : '',
      bcc: nodes.bcc ? nodes.bcc.value : '',
      subject: nodes.subject ? nodes.subject.value : '',
      text: textVal,
      ...(htmlVal ? { html: htmlVal } : {}),
      attachments: state.files.map(f => ({ ...f })),
      inReplyTo: state.data?.inReplyTo || '',
      references: state.data?.references || ''
    };
  }

  async function restoreRecovery(composeId) {
    if (state.busy) return;
    if (state.dirty && !state.locked) {
      feedback('Save or discard current unsaved changes before restoring another draft.', true);
      return;
    }
    const generation = state.generation;
    setBusy(true);
    try {
      const rec = await api('/api/mail/compose/recovery/read', { method: 'POST', body: { composeId } });
      if (generation !== state.generation) return;

      state.recoveryId = rec.composeId;
      state.recoveryRevision = rec.revision;
      state.files = (rec.content?.attachments || []).map(f => ({ ...f }));
      state.data = {
        ...(state.data || {}),
        accountId: rec.content?.accountId || nodes.account.value,
        draftId: rec.content?.providerDraftId || rec.content?.draftId || null,
        inReplyTo: rec.content?.inReplyTo || '',
        references: rec.content?.references || ''
      };
      if (rec.content?.accountId) nodes.account.value = rec.content.accountId;
      nodes.to.value = rec.content?.to || '';
      nodes.cc.value = rec.content?.cc || '';
      nodes.bcc.value = rec.content?.bcc || '';
      nodes.subject.value = rec.content?.subject || '';
      nodes.text.value = rec.content?.text || '';

      if (rec.content?.html) {
        state.html = rec.content.html;
        if (nodes.editor) nodes.editor.innerHTML = rec.content.html;
      } else if (nodes.editor) {
        nodes.editor.textContent = rec.content?.text || '';
        state.html = '';
      }
      for (const name of ['cc', 'bcc']) {
        if (nodes[name].value) revealRecipient(name);
      }
      fileList();
      renderRecipientChips('to');
      renderRecipientChips('cc');
      renderRecipientChips('bcc');

      state.dirty = false;
      state.editGeneration = 0;
      state.savedEditGeneration = 0;
      state.pendingRetrySnapshot = null;

      nodes.recoveryBanner.hidden = true;
      if (rec.locked) {
        state.locked = true;
        feedback('This draft was submitted and is locked.', true);
      } else {
        feedback('Draft restored.');
      }
    } catch (err) {
      if (generation === state.generation) {
        feedback(explain(err, describeError), true);
      }
    } finally {
      if (generation === state.generation) {
        setBusy(false);
      }
    }
  }

  async function open({ mode = 'new', id, accountId, composeId, anchor } = {}) {
    build();
    if (state.busy || (dialog.open && state.dirty)) {
      windowSize(false);
      feedback('Save or close the current message before opening another.', true);
      show();
      return;
    }
    clear();
    previousFocus = document.activeElement;

    const isReplyMode = mode === 'reply' || mode === 'reply_all' || mode === 'replyAll';
    const isConnectedAnchor = Boolean(
      anchor &&
      typeof anchor === 'object' &&
      typeof anchor.append === 'function' &&
      (anchor.isConnected ?? (typeof document !== 'undefined' && document.body?.contains?.(anchor)))
    );

    if (isReplyMode && !composeId && isConnectedAnchor) {
      currentAnchor = anchor;
      moveDialogTo(anchor);
      updateDialogClass();
    } else {
      currentAnchor = null;
      if (typeof document !== 'undefined' && document.body) {
        moveDialogTo(document.body);
      }
      updateDialogClass();
    }

    show();
    const generation = state.generation;
    nodes.title.textContent = ({ new: 'New message', reply: 'Reply', reply_all: 'Reply all', replyAll: 'Reply all', forward: 'Forward', edit: 'Edit draft' })[mode] || 'New message';
    feedback('Loading…');
    setBusy(true);
    try {
      if (composeId) {
        const [settingsData, rec] = await Promise.all([
          api('/api/mail/smtp'),
          api('/api/mail/compose/recovery/read', { method: 'POST', body: { composeId } })
        ]);
        if (generation !== state.generation) return;
        state.accounts = settingsData.accounts;
        state.data = {
          accountId: rec.content?.accountId,
          draftId: rec.content?.providerDraftId || rec.content?.draftId || null,
          inReplyTo: rec.content?.inReplyTo || '',
          references: rec.content?.references || ''
        };
        state.recoveryId = rec.composeId;
        state.recoveryRevision = rec.revision;
        state.files = (rec.content?.attachments || []).map(f => ({ ...f }));
        nodes.account.replaceChildren();
        for (const acc of settingsData.accounts) {
          const opt = make('option', `${acc.label} <${acc.email}>`);
          opt.value = acc.accountId;
          nodes.account.append(opt);
        }
        nodes.account.value = rec.content?.accountId || settingsData.accounts[0]?.accountId || '';
        nodes.to.value = rec.content?.to || '';
        nodes.cc.value = rec.content?.cc || '';
        nodes.bcc.value = rec.content?.bcc || '';
        nodes.subject.value = rec.content?.subject || '';
        nodes.text.value = rec.content?.text || '';
        if (rec.content?.html) {
          state.html = rec.content.html;
          if (nodes.editor) nodes.editor.innerHTML = rec.content.html;
        } else if (nodes.editor) {
          nodes.editor.textContent = rec.content?.text || '';
          state.html = '';
        }
        for (const name of ['cc', 'bcc']) if (nodes[name].value) revealRecipient(name);
        fileList();
        renderRecipientChips('to');
        renderRecipientChips('cc');
        renderRecipientChips('bcc');
        state.dirty = false;
        state.editGeneration = 0;
        state.savedEditGeneration = 0;

        if (rec.locked) {
          state.locked = true;
          feedback('This message was submitted. Send is locked to prevent duplicates.', true);
        } else {
          feedback(settingsData.accounts.length ? '' : 'Connect an account before writing mail.', !settingsData.accounts.length);
        }
        return;
      }

      const [settingsData, data, recoverable] = await Promise.all([
        api('/api/mail/smtp'),
        mode === 'new' ? Promise.resolve({ accountId, to: '', cc: '', bcc: '', subject: '', text: '', attachments: [] }) :
          api('/api/mail/compose/context', { method: 'POST', body: { id, mode }, timeout: 190000 }),
        mode === 'new' ? api('/api/mail/compose/recovery').catch(() => ({ drafts: [] })) : Promise.resolve({ drafts: [] })
      ]);
      if (generation !== state.generation) return;
      state.accounts = settingsData.accounts;
      state.data = data;
      state.files = (data.attachments || []).map(f => ({ ...f }));
      nodes.account.replaceChildren();
      for (const account of settingsData.accounts) {
        const option = make('option', `${account.label} <${account.email}>`);
        option.value = account.accountId;
        nodes.account.append(option);
      }
      nodes.account.value = data.accountId || accountId || settingsData.accounts[0]?.accountId || '';
      for (const key of ['to', 'cc', 'bcc', 'subject', 'text']) nodes[key].value = data[key] || '';
      if (data.html) {
        state.html = data.html;
        if (nodes.editor) nodes.editor.innerHTML = data.html;
      } else if (nodes.editor) {
        nodes.editor.textContent = data.text || '';
        state.html = '';
      }
      for (const name of ['cc', 'bcc']) if (nodes[name].value) revealRecipient(name);
      fileList();
      renderRecipientChips('to');
      renderRecipientChips('cc');
      renderRecipientChips('bcc');
      state.dirty = false;
      state.editGeneration = 0;
      state.savedEditGeneration = 0;

      if (mode === 'new' && recoverable?.drafts?.length > 0) {
        renderRecoveryChooser(recoverable.drafts);
      }

      feedback(settingsData.accounts.length ? '' : 'Connect an account before writing mail.', !settingsData.accounts.length);
      loadSignature(nodes.account.value);
    } catch (error) {
      if (generation === state.generation) {
        feedback(explain(error, describeError), true);
        state.locked = true;
      }
    } finally {
      if (generation === state.generation) {
        setBusy(false);
        if (!state.locked) {
          if (mode === 'new') nodes.to.focus();
          else {
            const editor = nodes.editor || nodes.text;
            if (currentAnchor) editor.focus({preventScroll: true});
            else editor.focus();
            if (currentAnchor && typeof dialog.scrollIntoView === 'function') {
              try { dialog.scrollIntoView({ behavior: 'instant', block: 'start' }); } catch {}
            }
          }
        }
      }
    }
  }

  function review() {
    if (state.busy || state.locked || !nodes.reviewPanel.hidden) return;
    const value = payload(), account = state.accounts.find(item => item.accountId === value.accountId);
    if (!account || !(value.to.trim() || value.cc.trim() || value.bcc.trim())) {
      feedback('Choose a connected sender and enter at least one recipient.', true);
      return;
    }
    if (account.needsReconnect) { feedback(errors.smtp_login_required, true); return; }

    const toItems = splitRecipients(nodes.to.value);
    const ccItems = splitRecipients(nodes.cc.value);
    const bccItems = splitRecipients(nodes.bcc.value);
    if (toItems.length + ccItems.length + bccItems.length > 100) {
      feedback('A maximum of 100 recipients is supported across To, Cc, and Bcc.', true);
      return;
    }

    for (const name of ['to', 'cc', 'bcc']) {
      const raw = nodes[name].value;
      if (/[\r\n\u0000-\u001f\u007f]/u.test(raw)) {
        feedback('Recipient addresses cannot contain line breaks or control characters.', true);
        return;
      }
      const items = splitRecipients(raw);
      for (const item of items) {
        const parsed = parseRecipient(item);
        if (parsed && !parsed.valid) {
          feedback(`Invalid recipient: "${item}". Please enter valid email addresses.`, true);
          return;
        }
      }
    }

    if (value.text.length > 200000) {
      feedback('Message text exceeds 200,000 characters limit.', true);
      return;
    }
    if (value.html && value.html.length > 400000) {
      feedback('Formatted message exceeds 400,000 characters limit.', true);
      return;
    }

    nodes.reviewText.replaceChildren();
    for (const [label, text] of [['From', account.email], ['To', value.to], ['Cc', value.cc], ['Bcc', value.bcc], ['Subject', value.subject || '(no subject)']]) {
      if (text) {
        const row = make('p');
        row.append(make('strong', `${label}: `), make('span', text));
        nodes.reviewText.append(row);
      }
    }
    if (state.files.length) {
      nodes.reviewText.append(make('p', `${state.files.length} attachment${state.files.length === 1 ? '' : 's'}: ${state.files.map(file => file.filename).join(', ')}`, 'compose-review-attachments'));
    }
    state.requestId ||= requestId();
    nodes.reviewPanel.hidden = false;
    feedback();
    nodes.send.focus();
  }

  async function save() {
    if (state.busy || state.locked) return;
    const cur = payload();
    if (isBodyOverLimit(cur) || (state.pendingRetrySnapshot && isBodyOverLimit(state.pendingRetrySnapshot.content))) {
      feedback(OVERSIZED_MESSAGE, true);
      return;
    }
    const generation = state.generation;
    setBusy(true);
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
    state.saveRequested = false;

    try {
      await flushRecovery(true);
    } catch (flushErr) {
      if (generation === state.generation) {
        setBusy(false);
        if (flushErr?.message === OVERSIZED_MESSAGE) {
          feedback(OVERSIZED_MESSAGE, true);
        } else if (!state.pendingRetrySnapshot) {
          feedback('Could not save draft before provider save. Text preserved.', true);
        }
      }
      return;
    }
    if (generation !== state.generation) return;

    try {
      const curPayload = payload();
      if (isBodyOverLimit(curPayload)) {
        feedback(OVERSIZED_MESSAGE, true);
        return;
      }
      const body = {
        ...curPayload,
        composeId: state.recoveryId,
        recoveryRevision: state.recoveryRevision
      };
      const result = await api('/api/mail/draft', { method: 'POST', body, timeout: 190000 });
      if (generation !== state.generation) return;

      state.data = {
        ...state.data,
        accountId: nodes.account.value,
        draftId: result.draftId || state.data?.draftId
      };
      if (result.composeId) state.recoveryId = result.composeId;
      if (result.recoveryRevision !== undefined) state.recoveryRevision = result.recoveryRevision;

      state.dirty = false;
      feedback(result.warning ? `Draft saved. ${explain(result.warning, describeError)}` : 'Draft saved in the original mailbox.', Boolean(result.warning));
      onChanged();
    } catch (error) {
      if (generation === state.generation) {
        const allowedCodes = ['invalid_request', 'smtp_login_required', 'smtp_not_configured', 'smtp_error', 'stale_message', 'draft_unavailable', 'busy'];
        if (!allowedCodes.includes(error?.code)) {
          state.locked = true;
          feedback('Draft save could not be confirmed. Saving is locked to prevent duplicates. Review Drafts on reload.', true);
        } else {
          feedback(explain(error, describeError), true);
        }
      }
    } finally {
      if (generation === state.generation) setBusy(false);
    }
  }

  async function send() {
    if (state.busy || state.locked || nodes.reviewPanel.hidden || !state.requestId) return;
    const cur = payload();
    if (isBodyOverLimit(cur) || (state.pendingRetrySnapshot && isBodyOverLimit(state.pendingRetrySnapshot.content))) {
      feedback(OVERSIZED_MESSAGE, true);
      return;
    }
    const generation = state.generation;
    setBusy(true);
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
    state.saveRequested = false;

    try {
      await flushRecovery();
    } catch (flushErr) {
      if (generation === state.generation) {
        setBusy(false);
        if (flushErr?.message === OVERSIZED_MESSAGE) {
          feedback(OVERSIZED_MESSAGE, true);
        } else if (!state.pendingRetrySnapshot) {
          feedback('Could not save draft before sending. Text preserved.', true);
        }
      }
      return;
    }
    if (generation !== state.generation) return;

    const curPayload = payload();
    if (isBodyOverLimit(curPayload)) {
      feedback(OVERSIZED_MESSAGE, true);
      return;
    }

    feedback('Sending…');
    try {
      const body = {
        ...curPayload,
        requestId: state.requestId,
        composeId: state.recoveryId,
        recoveryRevision: state.recoveryRevision
      };
      const result = await api('/api/mail/send', { method: 'POST', body, timeout: 190000 });
      if (generation !== state.generation) return;
      state.locked = true;
      state.dirty = false;
      nodes.reviewPanel.hidden = true;
      const warnings = result.warnings || (result.warning ? [result.warning] : []);
      feedback(result.status === 'partial' ?
        `${errors.send_partial} Accepted: ${(result.accepted || []).join(', ')}. Rejected: ${(result.rejected || []).join(', ')}.` :
        `Message sent.${warnings.length ? ` ${warnings.map(value => explain(value, describeError)).join(' ')}` : ''}`,
        warnings.length > 0
      );
      onChanged();
    } catch (error) {
      if (generation !== state.generation) return;
      const allowedCodes = ['invalid_request', 'smtp_login_required', 'smtp_not_configured', 'smtp_error', 'stale_message', 'draft_unavailable', 'busy', 'send_history_full'];
      if (!allowedCodes.includes(error?.code)) {
        state.locked = true;
        feedback(errors.send_uncertain, true);
      } else {
        state.requestId = null;
        nodes.reviewPanel.hidden = true;
        feedback(explain(error, describeError), true);
      }
    } finally {
      if (generation === state.generation) {
        setBusy(false);
        fileList();
      }
    }
  }

  function clearSettings() {
    settingsRevision++;
    for (const passwordInput of settingsPasswords) passwordInput.value = '';
    for (const container of settingsHosts) container.replaceChildren();
    settingsHosts = [];
    settingsPasswords = [];
  }

  async function renderSettings(mounts = []) {
    clearSettings();
    const version = settingsRevision;
    const targets = mounts.map(({accountId, container}) => {
      const status = make('p', 'Loading outgoing settings…', 'fineprint');
      status.setAttribute('role', 'status');
      container.replaceChildren(status);
      settingsHosts.push(container);
      return {accountId, container, status};
    });
    if (!targets.length) return;
    try {
      const data = await api('/api/mail/smtp');
      if (version !== settingsRevision) return;
      const accounts = new Map(data.accounts.map(account => [account.accountId, account]));
      for (const {accountId, container, status} of targets) {
        const account = accounts.get(accountId);
        if (!account) {
          status.textContent = 'Outgoing mail is unavailable. Refresh this account’s connection.';
          continue;
        }
        const form = make('form', undefined, 'smtp-settings');
        const host = field(form, 'host', 'SMTP server');
        host.value = account.host;
        host.readOnly = true;
        const port = field(form, 'port', 'Connection', 'select');
        const connections = new Map([[587, 'starttls'], [465, 'tls']]);
        connections.set(account.port, account.security || (account.port === 465 ? 'tls' : 'starttls'));
        for (const [value, security] of connections) {
          const option = make('option', `${value} · ${security === 'tls' ? 'TLS' : 'STARTTLS'}`);
          option.value = String(value);
          port.append(option);
        }
        port.value = String(account.port);
        const copy = field(form, 'sentCopy', 'Save a Sent copy through IMAP');
        copy.type = 'checkbox';
        copy.checked = account.sentCopy;
        let passwordInput, reuse;
        if (account.authType === 'password') {
          reuse = field(form, 'reuse', 'Use the connected mailbox password');
          reuse.type = 'checkbox';
          reuse.checked = !account.customPassword;
          passwordInput = field(form, 'password', 'Separate SMTP password (leave blank to keep saved password)');
          passwordInput.type = 'password';
          passwordInput.autocomplete = 'new-password';
          passwordInput.maxLength = 4096;
          settingsPasswords.push(passwordInput);
          passwordInput.disabled = reuse.checked;
          reuse.addEventListener('change', () => {
            passwordInput.disabled = reuse.checked;
            if (reuse.checked) passwordInput.value = '';
          });
        }
        if (account.needsReconnect) form.append(make('p', 'Reconnect Microsoft above to enable sending.', 'smtp-warning'));
        const fb = make('p');
        fb.setAttribute('role', 'status');
        form.append(fb);
        const saveBtn = button(form, 'Save outgoing settings', async () => {
          if (version !== settingsRevision) return;
          saveBtn.disabled = true;
          verifyBtn.disabled = true;
          const credentials = passwordInput ? { password: passwordInput.value, useMailboxPassword: reuse.checked } : {};
          if (passwordInput) passwordInput.value = '';
          try {
            await api('/api/mail/smtp', {
              method: 'POST',
              body: {
                accountId: account.accountId,
                host: account.host,
                port: Number(port.value),
                security: connections.get(Number(port.value)),
                sentCopy: copy.checked,
                ...credentials
              }
            });
            if (version === settingsRevision) fb.textContent = 'Outgoing settings saved.';
          } catch (error) {
            if (version === settingsRevision) fb.textContent = explain(error, describeError);
          } finally {
            if (version === settingsRevision) {
              saveBtn.disabled = false;
              verifyBtn.disabled = false;
            }
          }
        });
        const verifyBtn = button(form, 'Test saved connection', async () => {
          if (version !== settingsRevision) return;
          saveBtn.disabled = true;
          verifyBtn.disabled = true;
          try {
            await api('/api/mail/smtp/test', { method: 'POST', body: { accountId: account.accountId }, timeout: 60000 });
            if (version === settingsRevision) fb.textContent = 'Connection verified. No email was sent.';
          } catch (error) {
            if (version === settingsRevision) fb.textContent = explain(error, describeError);
          } finally {
            if (version === settingsRevision) {
              saveBtn.disabled = false;
              verifyBtn.disabled = false;
            }
          }
        });
        form.addEventListener('submit', event => event.preventDefault());
        container.replaceChildren(form);
      }
    } catch (error) {
      if (version === settingsRevision) {
        for (const {status} of targets) status.textContent = explain(error, describeError);
      }
    }
  }

  return {
    open,
    close,
    reset() {
      clear();
      clearSettings();
    },
    dock,
    renderSettings
  };
}
