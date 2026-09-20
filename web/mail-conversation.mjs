import { createRichMailView } from './mail-content.mjs';
import { createMailAttachmentsView } from './mail-attachments.mjs';

const make = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined && text !== null) el.textContent = text;
  if (className) el.className = className;
  return el;
};

const button = (text, onClick, className = 'subtle') => {
  const node = make('button', text, className);
  node.type = 'button';
  if (typeof onClick === 'function') {
    node.addEventListener('click', onClick);
  }
  return node;
};

const addressText = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(addressText).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return [value.name, value.address].filter(item => typeof item === 'string').join(' ');
  return '';
};

const addressName = value => {
  if (typeof value === 'string') return value.split('<')[0].trim();
  if (Array.isArray(value)) return value.map(addressName).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return value.name || value.address || '';
  return '';
};

function dateText(value, full = false) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return 'Date unavailable';
  if (full) {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {})
      });
}

export function createConversationView({
  api,
  describeError,
  openCompose,
  dockCompose,
  richViewFactory = createRichMailView,
  attachmentsViewFactory = createMailAttachmentsView
} = {}) {
  let currentContainer = null;
  let currentMessage = null;
  let currentId = null;
  let currentAccountId = null;
  let threaded = false;

  let controlsEl = null;
  let threadEl = null;

  let selectedEntry = null;
  const entries = new Map();

  let viewGeneration = 0;
  let convRevision = 0;
  let convAbort = null;
  let convLoading = false;
  let convComplete = false;
  let convCursor = null;
  let convLastAttemptedCursor = null;
  let convError = '';
  let convErrors = [];
  let convCancelled = false;
  let convLoadedMessagesCount = 0;

  const errorText = err => {
    if (!err) return 'Could not load conversation.';
    const described = describeError?.(err) || (err.code ? describeError?.({ code: err.code }) : null);
    if (typeof described === 'string' && described.trim()) {
      return described;
    }
    if (typeof err === 'string') return err;
    if (typeof err.message === 'string' && err.message.trim()) {
      return err.message;
    }
    if (typeof err.code === 'string' && err.code.trim()) {
      return err.code;
    }
    return 'Could not load conversation.';
  };

  function renderControls() {
    if (!controlsEl) return;
    controlsEl.replaceChildren();

    if (!threaded) {
      controlsEl.hidden = true;
      return;
    }

    controlsEl.hidden = false;

    if (convLoading) {
      const statusSpan = make('span', 'Loading conversation…', 'fineprint mail-conv-loading');
      statusSpan.setAttribute('role', 'status');
      const cancelBtn = button('Cancel', () => {
        cancelConversation();
      }, 'subtle mail-conv-cancel');
      controlsEl.append(statusSpan, cancelBtn);
      return;
    }

    if (convError) {
      const errorSpan = make('span', convError, 'fineprint error');
      errorSpan.setAttribute('role', 'alert');
      const retryBtn = button('Retry', () => {
        void loadConversation(convLastAttemptedCursor);
      }, 'subtle mail-conv-retry');
      controlsEl.append(errorSpan, retryBtn);
      return;
    }

    if (convCancelled) {
      const cancelNote = make('span', 'Conversation loading cancelled.', 'fineprint');
      cancelNote.setAttribute('role', 'status');
      const retryBtn = button('Retry', () => {
        convCancelled = false;
        void loadConversation(convLastAttemptedCursor);
      }, 'subtle mail-conv-retry');
      controlsEl.append(cancelNote, retryBtn);
      return;
    }

    if (!convComplete) {
      const hint = convErrors.length > 0
        ? (errorText(convErrors[0]) || 'error loading some messages')
        : 'partial results';
      const note = make('p', `${convLoadedMessagesCount} messages loaded · Partial results (${hint})`, 'fineprint error mail-conv-partial');
      note.setAttribute('role', 'status');
      controlsEl.append(note);

      if (convCursor) {
        const moreBtn = button('Load more conversation messages', () => {
          void loadConversation(convCursor);
        }, 'subtle mail-conv-more');
        controlsEl.append(moreBtn);
      } else {
        const terminalNote = make('p', 'End of available conversation history (partial results).', 'fineprint mail-conv-terminal');
        controlsEl.append(terminalNote);
      }
      return;
    }

    if (convComplete) {
      const msgText = convLoadedMessagesCount === 1 ? '1 message in conversation' : `${convLoadedMessagesCount} messages in conversation`;
      const completeNote = make('span', msgText, 'fineprint mail-conv-complete');
      controlsEl.append(completeNote);
    }
  }

  function cancelConversation() {
    if (convAbort) {
      convAbort.abort();
      convAbort = null;
    }
    convRevision++;
    convLoading = false;
    convCancelled = true;
    renderControls();
  }

  async function loadConversation(cursor = null) {
    if (convAbort) {
      convAbort.abort();
      convAbort = null;
    }

    convRevision++;
    const requestRevision = convRevision;
    const targetMessageId = currentId;
    const targetAccountId = currentAccountId;

    const abortController = new AbortController();
    convAbort = abortController;

    convLoading = true;
    convError = '';
    convCancelled = false;
    convLastAttemptedCursor = cursor;
    renderControls();

    try {
      const body = { id: targetMessageId };
      if (cursor) body.cursor = cursor;

      const res = await api('/api/mail/conversation', {
        method: 'POST',
        body,
        timeout: 130000,
        signal: abortController.signal
      });

      if (requestRevision !== convRevision || targetMessageId !== currentId || targetAccountId !== currentAccountId) {
        if (convAbort === abortController) convAbort = null;
        return;
      }
      if (abortController.signal.aborted) {
        if (convAbort === abortController) convAbort = null;
        return;
      }
      if (convAbort === abortController) {
        convAbort = null;
      }

      if (
        !res ||
        typeof res !== 'object' ||
        Array.isArray(res) ||
        !Array.isArray(res.messages) ||
        typeof res.complete !== 'boolean' ||
        (res.nextCursor !== null && (typeof res.nextCursor !== 'string' || res.nextCursor.length > 4096))
      ) {
        throw new Error('Malformed conversation response');
      }

      convLoading = false;
      convCursor = res.nextCursor || null;
      convErrors = Array.isArray(res.errors) ? res.errors : [];

      const rawMessages = res.messages;
      let hasFilteredInvalid = false;
      const seenIds = new Set();
      const deduped = [];

      for (const m of rawMessages) {
        if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id || m.accountId !== targetAccountId) {
          hasFilteredInvalid = true;
          continue;
        }
        if (seenIds.has(m.id)) {
          hasFilteredInvalid = true;
          continue;
        }
        seenIds.add(m.id);
        deduped.push(m);
      }

      if (selectedEntry && !seenIds.has(selectedEntry.id)) {
        deduped.push(selectedEntry.fullMessage || selectedEntry.header);
        seenIds.add(selectedEntry.id);
      }

      deduped.sort((a, b) => {
        const timeA = new Date(a.date).getTime() || 0;
        const timeB = new Date(b.date).getTime() || 0;
        return timeA - timeB;
      });

      convLoadedMessagesCount = deduped.length;

      if (hasFilteredInvalid) {
        convComplete = false;
        if (convErrors.length === 0) {
          convErrors.push({ message: 'Filtered invalid or foreign messages' });
        }
      } else {
        convComplete = res.complete;
      }

      updateThreadOrder(deduped);
      renderControls();
    } catch (err) {
      if (convAbort === abortController) {
        convAbort = null;
      }
      if (requestRevision !== convRevision || targetMessageId !== currentId || targetAccountId !== currentAccountId) {
        return;
      }
      if (abortController.signal.aborted) {
        return;
      }
      convLoading = false;
      convError = errorText(err);
      renderControls();
    }
  }

  function updateThreadOrder(orderedMessages) {
    if (!threadEl || !selectedEntry) return;

    const currentIds = new Set(orderedMessages.map(m => m.id));

    for (const [id, entry] of entries.entries()) {
      if (id !== selectedEntry.id && !currentIds.has(id)) {
        dockCompose?.(entry.replyHost);
        if (entry.messageAbortController) {
          entry.messageAbortController.abort();
          entry.messageAbortController = null;
        }
        entry.isLoadingMessage = false;
        entry.fetchGeneration++;
        try { entry.richView?.reset?.(); } catch {}
        try { entry.attachmentsView?.reset?.(); } catch {}
        entry.card.remove();
        entries.delete(id);
      }
    }

    const selectedIndex = orderedMessages.findIndex(m => m.id === selectedEntry.id);
    if (selectedIndex === -1) return;

    const precedingMessages = orderedMessages.slice(0, selectedIndex);
    const followingMessages = orderedMessages.slice(selectedIndex + 1);

    let nextAnchor = selectedEntry.card;
    for (let i = precedingMessages.length - 1; i >= 0; i--) {
      const msg = precedingMessages[i];
      const entry = getOrCreateEntry(msg);
      if (entry.card.nextSibling !== nextAnchor || entry.card.parentNode !== threadEl) {
        threadEl.insertBefore(entry.card, nextAnchor);
      }
      nextAnchor = entry.card;
    }

    let prevAnchor = selectedEntry.card;
    for (let i = 0; i < followingMessages.length; i++) {
      const msg = followingMessages[i];
      const entry = getOrCreateEntry(msg);
      if (prevAnchor.nextSibling !== entry.card) {
        if (prevAnchor.nextSibling) {
          threadEl.insertBefore(entry.card, prevAnchor.nextSibling);
        } else {
          threadEl.append(entry.card);
        }
      }
      prevAnchor = entry.card;
    }
  }

  function getOrCreateEntry(header) {
    let entry = entries.get(header.id);
    if (entry) {
      entry.header = header;
      const authorName = addressName(header.author) || addressText(header.author) || 'Unknown sender';
      entry.authorSpan.textContent = authorName;
      entry.snippetSpan.textContent = header.snippet ? ` · ${header.snippet}` : '';
      entry.dateEl.textContent = dateText(header.date);
      return entry;
    }
    entry = createNonselectedEntry(header);
    entries.set(header.id, entry);
    return entry;
  }

  function createSelectedEntry(message) {
    const authorName = addressName(message.author) || addressText(message.author) || 'Unknown sender';
    const card = make('article', undefined, 'mail-conversation-entry current expanded');
    card.dataset.messageId = message.id;
    card.setAttribute('data-message-id', message.id);

    const headerBtn = make('button', undefined, 'mail-conversation-entry-header');
    headerBtn.type = 'button';
    headerBtn.setAttribute('aria-expanded', 'true');
    headerBtn.setAttribute('aria-label', `Collapse message from ${authorName}`);
    headerBtn.hidden = !threaded;

    const left = make('div', undefined, 'mail-conversation-entry-summary');
    const authorSpan = make('span', authorName, 'mail-conversation-author');
    const snippetSpan = make('span', message.snippet ? ` · ${message.snippet}` : '', 'mail-conversation-snippet');
    left.append(authorSpan, snippetSpan);

    const right = make('div', undefined, 'mail-conversation-entry-meta');
    const dateEl = make('time', dateText(message.date), 'mail-conversation-date');
    right.append(dateEl);

    headerBtn.append(left, right);
    card.append(headerBtn);

    const bodyEl = make('div', undefined, 'mail-conversation-body');

    const richHost = make('div', undefined, 'mail-conversation-rich-host');
    const richView = richViewFactory({ api, describeError });
    richView.render(richHost, message, { id: message.id });
    bodyEl.append(richHost);

    const attHost = make('div', undefined, 'mail-conversation-attachments-host');
    const attachmentsView = attachmentsViewFactory({ api, describeError });
    attachmentsView.renderGrid(attHost, message);
    bodyEl.append(attHost);

    const actionsEl = make('div', undefined, 'mail-conversation-actions');
    const replyHost = make('div', undefined, 'mail-conversation-reply-host');
    const replyBtn = button('Reply', () => openCompose?.({ mode: 'reply', id: message.id, accountId: message.accountId, anchor: replyHost }));
    const replyAllBtn = button('Reply all', () => openCompose?.({ mode: 'replyAll', id: message.id, accountId: message.accountId, anchor: replyHost }));
    const forwardBtn = button('Forward', () => openCompose?.({ mode: 'forward', id: message.id, accountId: message.accountId }));
    actionsEl.append(replyBtn, replyAllBtn, forwardBtn);
    bodyEl.append(actionsEl);
    bodyEl.append(replyHost);

    card.append(bodyEl);

    const entry = {
      id: message.id,
      accountId: message.accountId,
      header: message,
      fullMessage: message,
      isCurrent: true,
      isExpanded: true,
      card,
      headerBtn,
      authorSpan,
      snippetSpan,
      dateEl,
      bodyEl,
      richHost,
      attHost,
      actionsEl,
      replyHost,
      richView,
      attachmentsView,
      isLoadingMessage: false,
      messageError: null,
      messageAbortController: null,
      fetchGeneration: 0
    };

    headerBtn.addEventListener('click', () => {
      toggleEntry(entry);
    });

    return entry;
  }

  function createNonselectedEntry(header) {
    const authorName = addressName(header.author) || addressText(header.author) || 'Unknown sender';
    const card = make('article', undefined, 'mail-conversation-entry collapsed');
    card.dataset.messageId = header.id;
    card.setAttribute('data-message-id', header.id);

    const headerBtn = make('button', undefined, 'mail-conversation-entry-header');
    headerBtn.type = 'button';
    headerBtn.setAttribute('aria-expanded', 'false');
    headerBtn.setAttribute('aria-label', `Expand message from ${authorName}`);

    const left = make('div', undefined, 'mail-conversation-entry-summary');
    const authorSpan = make('span', authorName, 'mail-conversation-author');
    const snippetSpan = make('span', header.snippet ? ` · ${header.snippet}` : '', 'mail-conversation-snippet');
    left.append(authorSpan, snippetSpan);

    const right = make('div', undefined, 'mail-conversation-entry-meta');
    const dateEl = make('time', dateText(header.date), 'mail-conversation-date');
    right.append(dateEl);

    headerBtn.append(left, right);
    card.append(headerBtn);

    const bodyEl = make('div', undefined, 'mail-conversation-body');
    bodyEl.hidden = true;

    const richHost = make('div', undefined, 'mail-conversation-rich-host');
    const attHost = make('div', undefined, 'mail-conversation-attachments-host');
    const actionsEl = make('div', undefined, 'mail-conversation-actions');
    const replyHost = make('div', undefined, 'mail-conversation-reply-host');

    const richView = richViewFactory({ api, describeError });
    const attachmentsView = attachmentsViewFactory({ api, describeError });

    card.append(bodyEl);

    const entry = {
      id: header.id,
      accountId: header.accountId,
      header,
      fullMessage: null,
      isCurrent: false,
      isExpanded: false,
      card,
      headerBtn,
      authorSpan,
      snippetSpan,
      dateEl,
      bodyEl,
      richHost,
      attHost,
      actionsEl,
      replyHost,
      richView,
      attachmentsView,
      isLoadingMessage: false,
      messageError: null,
      messageAbortController: null,
      fetchGeneration: 0
    };

    headerBtn.addEventListener('click', () => {
      toggleEntry(entry);
    });

    return entry;
  }

  function toggleEntry(entry) {
    entry.isExpanded = !entry.isExpanded;
    const authorName = addressName(entry.header?.author) || addressText(entry.header?.author) || 'Unknown sender';

    if (entry.isExpanded) {
      entry.card.className = entry.isCurrent
        ? 'mail-conversation-entry current expanded'
        : 'mail-conversation-entry expanded';
      entry.headerBtn.setAttribute('aria-expanded', 'true');
      entry.headerBtn.setAttribute('aria-label', `Collapse message from ${authorName}`);
      entry.bodyEl.hidden = false;

      if (!entry.fullMessage && !entry.isLoadingMessage) {
        void fetchEntryMessage(entry);
      }
    } else {
      dockCompose?.(entry.replyHost);
      entry.card.className = entry.isCurrent
        ? 'mail-conversation-entry current collapsed'
        : 'mail-conversation-entry collapsed';
      entry.headerBtn.setAttribute('aria-expanded', 'false');
      entry.headerBtn.setAttribute('aria-label', `Expand message from ${authorName}`);
      entry.bodyEl.hidden = true;

      if (entry.messageAbortController) {
        entry.messageAbortController.abort();
        entry.messageAbortController = null;
      }
      entry.isLoadingMessage = false;
      entry.fetchGeneration++;
    }
  }

  async function fetchEntryMessage(entry) {
    if (entry.isLoadingMessage || entry.fullMessage) return;

    entry.isLoadingMessage = true;
    entry.messageError = null;

    if (entry.replyHost?.parentNode) {
      dockCompose?.(entry.replyHost);
    }
    entry.bodyEl.replaceChildren();
    const loadingP = make('p', 'Loading message…', 'fineprint mail-conv-loading');
    loadingP.setAttribute('role', 'status');
    entry.bodyEl.append(loadingP);

    const abortController = new AbortController();
    entry.messageAbortController = abortController;
    const requestGeneration = viewGeneration;
    const requestFetchId = ++entry.fetchGeneration;
    const expectedId = entry.id;
    const expectedAccountId = entry.accountId;

    try {
      const res = await api('/api/mail/message', {
        method: 'POST',
        body: { id: expectedId },
        timeout: 130000,
        signal: abortController.signal
      });

      const isCurrentRequest = (
        entry.messageAbortController === abortController &&
        entry.fetchGeneration === requestFetchId
      );

      if (!isCurrentRequest) {
        return;
      }

      const isValid = (
        requestGeneration === viewGeneration &&
        entries.get(expectedId) === entry &&
        expectedAccountId === currentAccountId &&
        !abortController.signal.aborted
      );

      if (!isValid) {
        entry.messageAbortController = null;
        entry.isLoadingMessage = false;
        return;
      }

      const msg = res?.message;
      if (!msg || typeof msg !== 'object' || msg.id !== expectedId || msg.accountId !== expectedAccountId) {
        throw new Error('Message data unavailable or account mismatch.');
      }

      entry.fullMessage = msg;
      entry.isLoadingMessage = false;
      entry.messageError = null;
      entry.messageAbortController = null;

      renderEntryContent(entry);
    } catch (err) {
      const isCurrentRequest = (
        entry.messageAbortController === abortController &&
        entry.fetchGeneration === requestFetchId
      );

      if (!isCurrentRequest) {
        return;
      }

      entry.messageAbortController = null;
      entry.isLoadingMessage = false;

      const isValid = (
        requestGeneration === viewGeneration &&
        entries.get(expectedId) === entry &&
        expectedAccountId === currentAccountId &&
        !abortController.signal.aborted
      );

      if (!isValid) {
        return;
      }

      entry.messageError = errorText(err);

      entry.card.className = 'mail-conversation-entry expanded';
      entry.headerBtn.setAttribute('aria-expanded', 'true');
      entry.bodyEl.hidden = false;

      if (entry.replyHost?.parentNode) {
        dockCompose?.(entry.replyHost);
      }
      entry.bodyEl.replaceChildren();
      const errorP = make('p', entry.messageError, 'fineprint error');
      errorP.setAttribute('role', 'alert');
      const retryBtn = button('Retry', () => {
        void fetchEntryMessage(entry);
      }, 'subtle mail-conv-retry');
      entry.bodyEl.append(errorP, retryBtn);
    }
  }

  function renderEntryContent(entry) {
    if (entry.replyHost?.parentNode) {
      dockCompose?.(entry.replyHost);
    }
    entry.bodyEl.replaceChildren();

    entry.richHost.replaceChildren();
    entry.richView.render(entry.richHost, entry.fullMessage, { id: entry.id });
    entry.bodyEl.append(entry.richHost);

    entry.attHost.replaceChildren();
    entry.attachmentsView.renderGrid(entry.attHost, entry.fullMessage);
    const duplicateAttSection = entry.attHost.querySelector('#mail-attachments-section');
    if (duplicateAttSection) {
      duplicateAttSection.removeAttribute('id');
    }
    entry.bodyEl.append(entry.attHost);

    entry.actionsEl.replaceChildren();
    entry.actionsEl.className = 'mail-conversation-actions';
    const replyBtn = button('Reply', () => openCompose?.({ mode: 'reply', id: entry.id, accountId: entry.accountId, anchor: entry.replyHost }));
    const replyAllBtn = button('Reply all', () => openCompose?.({ mode: 'replyAll', id: entry.id, accountId: entry.accountId, anchor: entry.replyHost }));
    const forwardBtn = button('Forward', () => openCompose?.({ mode: 'forward', id: entry.id, accountId: entry.accountId }));
    entry.actionsEl.append(replyBtn, replyAllBtn, forwardBtn);
    entry.bodyEl.append(entry.actionsEl);
    entry.bodyEl.append(entry.replyHost);
  }

  function updateSelectedEntryMetadata(entry, message) {
    if (!entry) return;
    const prev = entry.fullMessage || entry.header;
    entry.header = { ...prev, ...message };
    entry.fullMessage = { ...prev, ...message };
    currentMessage = entry.fullMessage;

    const authorName = addressName(message.author) || addressText(message.author) || 'Unknown sender';
    entry.authorSpan.textContent = authorName;
    entry.snippetSpan.textContent = message.snippet ? ` · ${message.snippet}` : '';
    entry.dateEl.textContent = dateText(message.date);

    entry.headerBtn.hidden = !threaded;

    const prevAtt = prev?.attachments;
    const newAtt = message.attachments;
    const attChanged = Boolean(
      (!prevAtt && newAtt) ||
      (prevAtt && !newAtt) ||
      (prevAtt && newAtt && (prevAtt.length !== newAtt.length || prevAtt.some((a, i) => a.id !== newAtt[i]?.id)))
    );
    if (attChanged) {
      entry.attHost.replaceChildren();
      entry.attachmentsView.renderGrid(entry.attHost, entry.fullMessage);
    }

    const bodyChanged = (message.body !== undefined && message.body !== prev?.body) ||
      (message.html !== undefined && message.html !== prev?.html);
    if (bodyChanged) {
      entry.richView.render(entry.richHost, entry.fullMessage, { id: message.id });
    }
  }

  function disposeNonselectedEntries() {
    if (convAbort) {
      convAbort.abort();
      convAbort = null;
    }
    convRevision++;
    convLoading = false;
    convError = '';
    convCancelled = false;
    convComplete = false;
    convCursor = null;
    convLastAttemptedCursor = null;
    convErrors = [];
    convLoadedMessagesCount = selectedEntry ? 1 : 0;

    for (const [id, entry] of entries.entries()) {
      if (id !== selectedEntry?.id) {
        dockCompose?.(entry.replyHost);
        if (entry.messageAbortController) {
          entry.messageAbortController.abort();
          entry.messageAbortController = null;
        }
        entry.isLoadingMessage = false;
        entry.fetchGeneration++;
        try { entry.richView?.reset?.(); } catch {}
        try { entry.attachmentsView?.reset?.(); } catch {}
        entry.card.remove();
        entries.delete(id);
      }
    }

    renderControls();
  }

  function reset() {
    viewGeneration++;
    if (convAbort) {
      convAbort.abort();
      convAbort = null;
    }
    convRevision++;
    convLoading = false;
    convError = '';
    convCancelled = false;
    convComplete = false;
    convCursor = null;
    convLastAttemptedCursor = null;
    convErrors = [];
    convLoadedMessagesCount = 0;

    for (const entry of entries.values()) {
      dockCompose?.(entry.replyHost);
      if (entry.messageAbortController) {
        entry.messageAbortController.abort();
        entry.messageAbortController = null;
      }
      entry.isLoadingMessage = false;
      entry.fetchGeneration++;
      try { entry.richView?.reset?.(); } catch {}
      try { entry.attachmentsView?.reset?.(); } catch {}
      entry.card.remove();
    }
    entries.clear();
    selectedEntry = null;

    if (currentContainer) {
      currentContainer.replaceChildren();
      currentContainer = null;
    }

    currentId = null;
    currentAccountId = null;
    currentMessage = null;
    threadEl = null;
    controlsEl = null;
  }

  function render(container, message, { threaded: newThreaded = false } = {}) {
    if (!container || !message || typeof message.id !== 'string') {
      reset();
      return;
    }

    const isScopeChange = container !== currentContainer ||
      message.id !== currentId ||
      message.accountId !== currentAccountId;

    if (isScopeChange) {
      reset();
      currentContainer = container;
      currentId = message.id;
      currentAccountId = message.accountId;
      currentMessage = message;
      threaded = Boolean(newThreaded);

      currentContainer.replaceChildren();

      controlsEl = make('div', undefined, 'mail-conversation-controls');
      controlsEl.hidden = !threaded;

      threadEl = make('div', undefined, 'mail-conversation-thread');
      currentContainer.append(controlsEl, threadEl);

      selectedEntry = createSelectedEntry(message);
      entries.set(message.id, selectedEntry);
      threadEl.append(selectedEntry.card);

      if (threaded) {
        void loadConversation(null);
      }
      return;
    }

    const prevThreaded = threaded;
    threaded = Boolean(newThreaded);

    updateSelectedEntryMetadata(selectedEntry, message);

    if (prevThreaded && !threaded) {
      controlsEl.hidden = true;
      disposeNonselectedEntries();
      if (selectedEntry) {
        selectedEntry.isExpanded = true;
        selectedEntry.bodyEl.hidden = false;
        selectedEntry.card.className = 'mail-conversation-entry current expanded';
        selectedEntry.headerBtn.setAttribute('aria-expanded', 'true');
        const authorName = addressName(selectedEntry.header?.author) || addressText(selectedEntry.header?.author) || 'Unknown sender';
        selectedEntry.headerBtn.setAttribute('aria-label', `Collapse message from ${authorName}`);
      }
    } else if (!prevThreaded && threaded) {
      controlsEl.hidden = false;
      void loadConversation(null);
    }
  }

  function scrollAttachments() {
    if (!selectedEntry) return;
    const target = selectedEntry.attHost?.querySelector?.('.mail-attachments') || selectedEntry.attHost;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  return {
    render,
    reset,
    scrollAttachments
  };
}
