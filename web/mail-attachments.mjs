const make = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

const button = (text, onClick, className = 'subtle') => {
  const node = make('button', text, className);
  node.type = 'button';
  if (typeof onClick === 'function') {
    node.addEventListener('click', onClick);
  }
  return node;
};

export const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
export const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/tab-separated-values', 'text/calendar', 'application/json']);
export const OFFICE_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);

const UNSAFE_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'xht', 'svg', 'xml', 'js', 'mjs', 'cjs',
  'exe', 'bat', 'cmd', 'sh', 'com', 'msi', 'scr', 'vbs', 'ps1', 'php'
]);
const UNSAFE_MIMES = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml',
  'text/xml', 'application/xml', 'text/javascript', 'application/javascript', 'application/x-javascript'
]);

export function attachmentType(attachment) {
  return typeof attachment?.mimeType === 'string' ? attachment.mimeType.split(';')[0].trim().toLowerCase() : 'application/octet-stream';
}

export function attachmentSize(size) {
  if (!Number.isSafeInteger(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentReadableType(attachment) {
  const mime = String(attachment?.mimeType ?? '').toLowerCase().split(';')[0].trim();
  const ext = String(attachment?.filename ?? '').split('.').at(-1)?.toLowerCase() || '';
  if (mime === 'application/pdf' || ext === 'pdf') return 'PDF Document';
  if (mime === 'image/png' || ext === 'png') return 'PNG Image';
  if (['image/jpeg', 'image/jpg'].includes(mime) || ['jpg', 'jpeg'].includes(ext)) return 'JPEG Image';
  if (mime === 'image/gif' || ext === 'gif') return 'GIF Image';
  if (mime === 'image/webp' || ext === 'webp') return 'WebP Image';
  if (mime === 'image/avif' || ext === 'avif') return 'AVIF Image';
  if (ext === 'docx' || mime.includes('wordprocessingml')) return 'Word Document';
  if (ext === 'xlsx' || mime.includes('spreadsheetml')) return 'Excel Spreadsheet';
  if (ext === 'pptx' || mime.includes('presentationml')) return 'PowerPoint Presentation';
  if (mime === 'text/plain' || ext === 'txt') return 'Plain Text';
  if (mime === 'text/csv' || ext === 'csv') return 'CSV Spreadsheet';
  if (mime === 'text/calendar' || ext === 'ics') return 'Calendar Event';
  if (mime === 'application/json' || ext === 'json') return 'JSON File';
  if (mime === 'application/zip' || ext === 'zip') return 'Zip Archive';
  return mime || (ext ? `${ext.toUpperCase()} File` : 'Attachment');
}

export function attachmentPreviewKind(attachment) {
  const mime = String(attachment?.mimeType ?? '').toLowerCase().split(';')[0].trim();
  const ext = String(attachment?.filename ?? '').split('.').at(-1)?.toLowerCase() || '';

  // Active content / unsafe types are NEVER previewable
  if (UNSAFE_MIMES.has(mime) || UNSAFE_EXTENSIONS.has(ext)) return 'unsupported';

  // Office documents (exact allowlist recognized before broad XML check; extension fallback only generic/absent MIME)
  if (OFFICE_TYPES.has(mime) && (!ext || ['docx', 'xlsx', 'pptx'].includes(ext))) return 'office';
  if ((!mime || mime === 'application/octet-stream') && ['docx', 'xlsx', 'pptx'].includes(ext)) return 'office';

  if (mime.includes('html') || mime.includes('svg') || mime.includes('javascript') || mime.includes('xml')) return 'unsupported';

  // Raster image
  if (RASTER_TYPES.has(mime) && (!ext || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext))) return 'image';
  if ((!mime || mime === 'application/octet-stream') && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext)) return 'image';

  // Plain text
  if (TEXT_TYPES.has(mime) && (!ext || ['txt', 'csv', 'tsv', 'json', 'ics'].includes(ext))) return 'text';
  if ((!mime || mime === 'application/octet-stream') && ['txt', 'csv', 'tsv', 'json', 'ics'].includes(ext)) return 'text';

  // PDF
  if (mime === 'application/pdf' || ((!mime || mime === 'application/octet-stream') && ext === 'pdf')) return 'pdf';

  return 'unsupported';
}

export function createMailAttachmentsView({api, describeError, loadPdfjs} = {}) {
  const previewUrls = new Set();
  const downloadUrls = new Map();
  let currentDialog = null;
  let currentTrigger = null;
  let activeMessageId = null;
  let activeAttachments = [];
  let currentIndex = 0;
  let activeLoadToken = 0;
  let sessionGeneration = 0;
  let pdfRenderGeneration = 0;

  let previewAbortController = null;
  let downloadAbortController = null;

  let currentPdfLoadingTask = null;
  let currentPdfDoc = null;
  let currentPdfRenderTask = null;
  let currentPdfRenderPromise = null;

  let pdfScale = 'fit';
  let renderedPdfScale = 1;
  let pdfCurrentPage = 1;
  let savedReaderScroll = 0;
  let isDownloadBusy = false;
  let currentContainer = null;

  function safeDestroy(target) {
    if (!target || typeof target.destroy !== 'function') return;
    try {
      const res = target.destroy();
      Promise.resolve(res).catch(() => {});
    } catch {}
  }

  const errorText = err => describeError?.(err) || err?.message || 'Attachment could not be loaded.';

  const defaultLoadPdfjs = async () => {
    try {
      const pdfjs = await import('/vendor/pdfjs/pdf.mjs');
      if (pdfjs?.GlobalWorkerOptions) {
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
      }
      return pdfjs;
    } catch {
      return null;
    }
  };

  const getPdfjs = loadPdfjs || defaultLoadPdfjs;

  function revokePreviewUrls() {
    for (const url of previewUrls) {
      try { URL.revokeObjectURL(url); } catch {}
    }
    previewUrls.clear();
  }

  function trackDownloadUrl(url) {
    const timer = setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch {}
      downloadUrls.delete(url);
    }, 60000);
    timer.unref?.();
    downloadUrls.set(url, timer);
    return url;
  }

  function revokeAllDownloadUrls() {
    for (const [url, timer] of downloadUrls) {
      clearTimeout(timer);
      try { URL.revokeObjectURL(url); } catch {}
    }
    downloadUrls.clear();
  }

  function cancelPdfRendering() {
    pdfRenderGeneration++;
    if (currentPdfRenderTask) {
      try { currentPdfRenderTask.cancel?.(); } catch {}
      currentPdfRenderTask = null;
    }
    currentPdfRenderPromise = null;
    if (currentPdfLoadingTask) {
      const task = currentPdfLoadingTask;
      currentPdfLoadingTask = null;
      safeDestroy(task);
    }
    if (currentPdfDoc) {
      const doc = currentPdfDoc;
      currentPdfDoc = null;
      safeDestroy(doc);
    }
  }

  function updateButtonsDisabled(disabled) {
    if (!currentContainer) return;
    for (const btn of currentContainer.querySelectorAll('.mail-attachment-actions button, .mail-download-all')) {
      btn.disabled = disabled;
    }
  }

  function showDialogStatus(msg, onRetry) {
    if (!currentDialog) return;
    clearDialogStatus();
    const status = make('div', undefined, 'mail-attachment-dialog-status');
    status.setAttribute('role', 'alert');
    const text = make('span', msg);
    status.append(text);
    if (onRetry) {
      const retryBtn = button('Retry', onRetry, 'subtle');
      status.append(retryBtn);
    }
    const header = currentDialog.querySelector('.mail-attachment-dialog-header');
    if (header) header.after(status);
  }

  function clearDialogStatus() {
    if (!currentDialog) return;
    const existing = currentDialog.querySelector('.mail-attachment-dialog-status');
    existing?.remove();
  }

  function showPdfPageError(canvasContainer, msg) {
    if (!canvasContainer) return;
    const existing = canvasContainer.querySelector('.mail-pdf-error');
    if (existing) {
      existing.textContent = msg;
      return;
    }
    const errBox = make('div', msg, 'mail-pdf-error');
    errBox.setAttribute('role', 'alert');
    canvasContainer.prepend(errBox);
  }

  async function downloadAttachment(messageId, attachment, inDialog = false) {
    if (isDownloadBusy) return;
    const session = sessionGeneration;
    isDownloadBusy = true;
    updateButtonsDisabled(true);

    const abortController = new AbortController();
    downloadAbortController = abortController;
    const { signal } = abortController;

    try {
      const blob = await api('/api/mail/attachment', {
        method: 'POST',
        body: {id: messageId, attachmentId: attachment.id},
        responseType: 'blob',
        signal,
        timeout: 190000
      });
      if (signal.aborted || session !== sessionGeneration || activeMessageId !== messageId) return;
      if (!(blob instanceof Blob)) throw new Error('Attachment download failed.');

      const url = URL.createObjectURL(new Blob([blob], {type: 'application/octet-stream'}));
      trackDownloadUrl(url);

      const link = make('a');
      link.href = url;
      link.download = String(attachment.filename || 'attachment').replace(/[\\/\u0000-\u001f\u007f]/gu, '_').slice(0, 180) || 'attachment';
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (err) {
      if (signal.aborted || err?.name === 'AbortError' || session !== sessionGeneration || activeMessageId !== messageId) return;
      const msg = errorText(err);
      if (inDialog && currentDialog) {
        showDialogStatus(msg, () => void downloadAttachment(messageId, attachment, true));
      } else {
        renderError(msg);
      }
    } finally {
      if (downloadAbortController === abortController) {
        downloadAbortController = null;
      }
      if (session === sessionGeneration) {
        isDownloadBusy = false;
        updateButtonsDisabled(false);
      }
    }
  }

  async function downloadAllZip(messageId) {
    if (isDownloadBusy) return;
    const session = sessionGeneration;
    isDownloadBusy = true;
    updateButtonsDisabled(true);

    const abortController = new AbortController();
    downloadAbortController = abortController;
    const { signal } = abortController;

    try {
      const blob = await api('/api/mail/attachments', {
        method: 'POST',
        body: {id: messageId},
        responseType: 'blob',
        signal,
        timeout: 190000
      });
      if (signal.aborted || session !== sessionGeneration || activeMessageId !== messageId) return;
      if (!(blob instanceof Blob)) throw new Error('Zip download failed.');

      const url = URL.createObjectURL(new Blob([blob], {type: 'application/octet-stream'}));
      trackDownloadUrl(url);

      const link = make('a');
      link.href = url;
      link.download = 'attachments.zip';
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (err) {
      if (signal.aborted || err?.name === 'AbortError' || session !== sessionGeneration || activeMessageId !== messageId) return;
      renderError(errorText(err));
    } finally {
      if (downloadAbortController === abortController) {
        downloadAbortController = null;
      }
      if (session === sessionGeneration) {
        isDownloadBusy = false;
        updateButtonsDisabled(false);
      }
    }
  }

  function renderError(msg) {
    if (!currentContainer) return;
    let errEl = currentContainer.querySelector('.mail-attachment-status') || currentContainer.querySelector('.mail-reader-error');
    if (!errEl) {
      errEl = make('p', '', 'mail-reader-error');
      errEl.setAttribute('role', 'alert');
      const section = currentContainer.querySelector('.mail-attachments');
      if (section) section.append(errEl);
      else currentContainer.append(errEl);
    }
    errEl.textContent = msg;
  }

  function closeDialog(restoreFocus = true) {
    const hadDialog = Boolean(currentDialog);
    activeLoadToken++;
    if (previewAbortController) {
      try { previewAbortController.abort(); } catch {}
      previewAbortController = null;
    }
    cancelPdfRendering();
    revokePreviewUrls();
    if (currentDialog) {
      currentDialog.close?.();
      currentDialog.remove?.();
      currentDialog = null;
    }
    const reader = document.getElementById?.('mail-reader');
    if (hadDialog && restoreFocus !== false && reader && Number.isFinite(savedReaderScroll)) {
      reader.scrollTop = savedReaderScroll;
    }
    if (hadDialog && restoreFocus !== false) {
      const isConnected = Boolean(currentTrigger && (currentTrigger.isConnected ?? (currentTrigger.parentNode != null)));
      const inContainer = Boolean(currentTrigger && (currentContainer?.contains ? currentContainer.contains(currentTrigger) : isConnected));
      if (currentTrigger && isConnected && inContainer && typeof currentTrigger.focus === 'function') {
        try { currentTrigger.focus({preventScroll: true}); } catch {}
      } else if (reader && typeof reader.focus === 'function') {
        try { reader.focus({preventScroll: true}); } catch {}
      }
    }
    currentTrigger = null;
  }

  function renderDialogShell() {
    if (currentDialog) {
      closeDialog(false);
    }
    const dialog = make('dialog', undefined, 'mail-attachment-dialog');
    dialog.setAttribute('aria-label', 'Attachment Preview');
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeDialog();
    });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
      }
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog && event.clientX !== undefined) {
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
          closeDialog();
        }
      }
    });

    const header = make('div', undefined, 'mail-attachment-dialog-header');
    const titleArea = make('div', undefined, 'mail-attachment-dialog-title-area');
    const title = make('h3', '', 'mail-attachment-dialog-title');
    titleArea.append(title);

    const controls = make('div', undefined, 'mail-attachment-dialog-actions');
    const prevBtn = button('‹', () => navigateAttachment(-1), 'subtle mail-attachment-prev');
    prevBtn.setAttribute('aria-label', 'Previous attachment');
    prevBtn.title = 'Previous attachment';

    const nextBtn = button('›', () => navigateAttachment(1), 'subtle mail-attachment-next');
    nextBtn.setAttribute('aria-label', 'Next attachment');
    nextBtn.title = 'Next attachment';

    const downloadBtn = button('Download', async () => {
      const att = activeAttachments[currentIndex];
      if (att && activeMessageId) {
        await downloadAttachment(activeMessageId, att, true);
      }
    }, 'subtle mail-attachment-dialog-download');
    downloadBtn.setAttribute('aria-label', 'Download current attachment');

    const closeBtn = button('✕', () => closeDialog(), 'subtle mail-attachment-dialog-close');
    closeBtn.setAttribute('aria-label', 'Close preview');

    controls.append(prevBtn, nextBtn, downloadBtn, closeBtn);
    header.append(titleArea, controls);

    const body = make('div', undefined, 'mail-attachment-dialog-body');
    dialog.append(header, body);

    document.body.append(dialog);
    currentDialog = dialog;
    return dialog;
  }

  function navigateAttachment(direction) {
    const nextIdx = currentIndex + direction;
    if (nextIdx < 0 || nextIdx >= activeAttachments.length) return;
    currentIndex = nextIdx;
    void loadActivePreview();
  }

  async function loadActivePreview() {
    const dialog = currentDialog;
    if (!dialog) return;
    const token = ++activeLoadToken;
    const session = sessionGeneration;

    if (previewAbortController) {
      try { previewAbortController.abort(); } catch {}
      previewAbortController = null;
    }
    const abortController = new AbortController();
    previewAbortController = abortController;
    const { signal } = abortController;

    cancelPdfRendering();
    revokePreviewUrls();
    clearDialogStatus();

    const attachment = activeAttachments[currentIndex];
    const total = activeAttachments.length;
    const title = dialog.querySelector('.mail-attachment-dialog-title');
    if (title) {
      title.textContent = `${attachment?.filename || 'Attachment'} (${currentIndex + 1} of ${total})`;
    }

    const prevBtn = dialog.querySelector('.mail-attachment-prev');
    const nextBtn = dialog.querySelector('.mail-attachment-next');
    if (prevBtn) prevBtn.disabled = currentIndex <= 0;
    if (nextBtn) nextBtn.disabled = currentIndex >= total - 1;

    const body = dialog.querySelector('.mail-attachment-dialog-body');
    if (!body) return;
    body.replaceChildren();

    const kind = attachmentPreviewKind(attachment);
    const messageId = activeMessageId;

    if (kind === 'unsupported') {
      const unsuppBox = make('div', undefined, 'mail-attachment-unsupported');
      unsuppBox.append(
        make('h4', attachment.filename || 'Attachment'),
        make('p', `${attachmentReadableType(attachment)} · ${attachmentSize(attachment.size)}`),
        make('p', 'Inline preview is not available for this file type. Download the file to view it on your device.', 'fineprint'),
        button('Download file', () => void downloadAttachment(messageId, attachment, true), 'primary')
      );
      body.append(unsuppBox);
      return;
    }

    const loading = make('div', 'Loading preview…', 'mail-attachment-loading');
    loading.setAttribute('role', 'status');
    body.append(loading);

    try {
      if (kind === 'office') {
        const data = await api('/api/mail/attachment-preview', {
          method: 'POST',
          body: {id: messageId, attachmentId: attachment.id},
          signal,
          timeout: 190000
        });
        if (signal.aborted || token !== activeLoadToken || session !== sessionGeneration || currentDialog !== dialog || activeMessageId !== messageId) return;
        body.replaceChildren();
        const prev = data?.preview || data || {};
        const box = make('div', undefined, 'mail-attachment-office-preview');
        box.append(
          make('p', prev.note || 'Text-only preview. Download the original for complete formatting.', 'fineprint mail-attachment-note')
        );
        const pre = make('pre', prev.text || '(Empty document)', 'mail-attachment-text-view');
        box.append(pre);
        if (prev.truncated) {
          box.append(make('p', 'Preview shortened. Download the original file for complete content.', 'fineprint'));
        }
        body.append(box);
      } else {
        const blob = await api('/api/mail/attachment', {
          method: 'POST',
          body: {id: messageId, attachmentId: attachment.id},
          responseType: 'blob',
          signal,
          timeout: 190000
        });
        if (signal.aborted || token !== activeLoadToken || session !== sessionGeneration || currentDialog !== dialog || activeMessageId !== messageId) return;
        if (!(blob instanceof Blob)) throw new Error('Invalid attachment response.');

        if (kind === 'image') {
          body.replaceChildren();
          const mime = RASTER_TYPES.has(attachment.mimeType) ? attachment.mimeType : 'image/png';
          const url = URL.createObjectURL(new Blob([blob], {type: mime}));
          previewUrls.add(url);
          const img = make('img', undefined, 'mail-attachment-img');
          img.src = url;
          img.alt = String(attachment.filename || 'Attachment image');
          body.append(img);
        } else if (kind === 'text') {
          const text = await blob.slice(0, 512 * 1024).text();
          if (signal.aborted || token !== activeLoadToken || session !== sessionGeneration || currentDialog !== dialog || activeMessageId !== messageId) return;
          body.replaceChildren();
          const pre = make('pre', text, 'mail-attachment-text-view');
          body.append(pre);
          if (blob.size > 512 * 1024) {
            body.append(make('p', 'Preview truncated at 512 KB. Download the file to view complete text.', 'fineprint'));
          }
        } else if (kind === 'pdf') {
          await renderPdf(body, blob, attachment, messageId, token, session, dialog, signal);
        }
      }
    } catch (err) {
      if (signal.aborted || err?.name === 'AbortError' || token !== activeLoadToken || session !== sessionGeneration || currentDialog !== dialog || activeMessageId !== messageId) return;
      body.replaceChildren();
      const errBox = make('div', undefined, 'mail-attachment-error');
      errBox.setAttribute('role', 'alert');
      errBox.append(
        make('p', errorText(err)),
        button('Retry', () => void loadActivePreview(), 'subtle'),
        button('Download anyway', () => void downloadAttachment(messageId, attachment, true), 'primary')
      );
      body.append(errBox);
    } finally {
      if (previewAbortController === abortController) {
        previewAbortController = null;
      }
    }
  }

  async function renderPdf(container, blob, attachment, messageId, token, session, dialog, signal) {
    const pdfjs = await getPdfjs();
    if (signal?.aborted || token !== activeLoadToken || session !== sessionGeneration || currentDialog !== dialog || activeMessageId !== messageId) return;

    if (!pdfjs || typeof pdfjs.getDocument !== 'function') {
      container.replaceChildren();
      const fallback = make('div', undefined, 'mail-attachment-pdf-fallback');
      fallback.append(
        make('h4', attachment.filename || 'PDF Document'),
        make('p', 'PDF preview is unavailable in this environment. Download the PDF to view it.'),
        button('Download PDF', () => void downloadAttachment(messageId, attachment, true), 'primary')
      );
      container.append(fallback);
      return;
    }

    try {
      const arrayBuffer = await blob.arrayBuffer();
      if (signal?.aborted || token !== activeLoadToken || session !== sessionGeneration || currentDialog !== dialog || activeMessageId !== messageId) return;

      const data = new Uint8Array(arrayBuffer);
      const loadingTask = pdfjs.getDocument({
        data,
        isEvalSupported: false,
        disableFontFace: true,
        enableXfa: false,
        useSystemFonts: false
      });
      currentPdfLoadingTask = loadingTask;

      let doc;
      try {
        doc = await loadingTask.promise;
      } catch (loadErr) {
        if (currentPdfLoadingTask === loadingTask) {
          currentPdfLoadingTask = null;
        }
        safeDestroy(loadingTask);
        if (signal?.aborted || token !== activeLoadToken || session !== sessionGeneration || currentDialog !== dialog || activeMessageId !== messageId) return;
        throw loadErr;
      }
      if (currentPdfLoadingTask === loadingTask) {
        currentPdfLoadingTask = null;
      }

      if (signal?.aborted || token !== activeLoadToken || session !== sessionGeneration || currentDialog !== dialog || activeMessageId !== messageId) {
        safeDestroy(doc);
        return;
      }

      if (currentPdfDoc && currentPdfDoc !== doc) {
        safeDestroy(currentPdfDoc);
      }
      currentPdfDoc = doc;
      pdfCurrentPage = 1;
      pdfScale = 'fit';
      renderedPdfScale = 1;

      container.replaceChildren();
      const pdfViewer = make('div', undefined, 'mail-pdf-viewer');
      const toolbar = make('div', undefined, 'mail-pdf-toolbar');

      const totalPages = doc.numPages || 1;
      const pageStatus = make('span', `Page ${pdfCurrentPage} of ${totalPages}`, 'fineprint mail-pdf-page-status');
      pageStatus.setAttribute('role', 'status');

      const prevPageBtn = button('‹ Prev page', () => changePdfPage(-1), 'subtle');
      prevPageBtn.setAttribute('aria-label', 'Previous page');
      prevPageBtn.title = 'Previous page';

      const nextPageBtn = button('Next page ›', () => changePdfPage(1), 'subtle');
      nextPageBtn.setAttribute('aria-label', 'Next page');
      nextPageBtn.title = 'Next page';

      const zoomOutBtn = button('−', () => changePdfZoom(0.85), 'subtle');
      zoomOutBtn.setAttribute('aria-label', 'Zoom out');
      zoomOutBtn.title = 'Zoom out';

      const zoomInBtn = button('+', () => changePdfZoom(1.15), 'subtle');
      zoomInBtn.setAttribute('aria-label', 'Zoom in');
      zoomInBtn.title = 'Zoom in';

      const fitWidthBtn = button('Fit width', () => changePdfZoom('fit'), 'subtle');
      fitWidthBtn.setAttribute('aria-label', 'Fit width');
      fitWidthBtn.title = 'Fit width';

      toolbar.append(prevPageBtn, nextPageBtn, pageStatus, zoomOutBtn, zoomInBtn, fitWidthBtn);

      const canvasContainer = make('div', undefined, 'mail-pdf-canvas-container');
      const canvas = document.createElement('canvas');
      canvas.className = 'mail-pdf-canvas';
      canvasContainer.append(canvas);

      pdfViewer.append(toolbar, canvasContainer);
      container.append(pdfViewer);

      await renderPdfCurrentPage(canvas, pageStatus, prevPageBtn, nextPageBtn, canvasContainer, token, session, dialog);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' || token !== activeLoadToken || session !== sessionGeneration || currentDialog !== dialog || activeMessageId !== messageId) return;
      container.replaceChildren();
      const fallback = make('div', undefined, 'mail-attachment-pdf-fallback');
      fallback.append(
        make('h4', attachment.filename || 'PDF Document'),
        make('p', errorText(err) || 'Could not render PDF preview.'),
        button('Download PDF', () => void downloadAttachment(messageId, attachment, true), 'primary')
      );
      container.append(fallback);
    }
  }

  async function renderPdfCurrentPage(canvas, pageStatus, prevBtn, nextBtn, canvasContainer, token, session, dialog) {
    const doc = currentPdfDoc;
    if (!doc || !canvas) return;
    const renderGen = ++pdfRenderGeneration;

    if (currentPdfRenderTask) {
      try { currentPdfRenderTask.cancel?.(); } catch {}
      currentPdfRenderTask = null;
    }
    if (currentPdfRenderPromise) {
      try { await currentPdfRenderPromise; } catch {}
      if (renderGen !== pdfRenderGeneration || currentPdfDoc !== doc) return;
    }

    const totalPages = doc.numPages || 1;
    pdfCurrentPage = Math.max(1, Math.min(totalPages, pdfCurrentPage));

    if (pageStatus) pageStatus.textContent = `Page ${pdfCurrentPage} of ${totalPages}`;
    if (prevBtn) prevBtn.disabled = pdfCurrentPage <= 1;
    if (nextBtn) nextBtn.disabled = pdfCurrentPage >= totalPages;

    let page;
    try {
      page = await doc.getPage(pdfCurrentPage);
    } catch (err) {
      if (renderGen !== pdfRenderGeneration || currentPdfDoc !== doc) return;
      showPdfPageError(canvasContainer, 'Failed to load page: ' + errorText(err));
      return;
    }
    if (renderGen !== pdfRenderGeneration || currentPdfDoc !== doc) return;
    if (token !== undefined && (token !== activeLoadToken || session !== sessionGeneration || currentDialog !== dialog)) return;

    let scale = typeof pdfScale === 'number' ? pdfScale : 1.0;
    if (pdfScale === 'fit' && canvasContainer) {
      const containerWidth = canvasContainer.clientWidth || 640;
      const unscaledViewport = page.getViewport({scale: 1.0});
      scale = Math.max(0.3, Math.min(2.5, (containerWidth - 32) / (unscaledViewport.width || 600)));
    }

    let viewport = page.getViewport({scale});
    const MAX_DIM = 4096;
    const MAX_PIXELS = 4096 * 4096;
    if (viewport.width > MAX_DIM || viewport.height > MAX_DIM || (viewport.width * viewport.height) > MAX_PIXELS) {
      const factor = Math.min(MAX_DIM / Math.max(viewport.width, viewport.height), Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)));
      scale *= factor;
      viewport = page.getViewport({scale});
    }

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    renderedPdfScale = scale;

    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;

    let renderTask;
    try {
      renderTask = page.render({canvasContext: ctx, viewport});
    } catch (renderSyncErr) {
      if (renderGen === pdfRenderGeneration && currentPdfDoc === doc) {
        showPdfPageError(canvasContainer, 'Page rendering error: ' + errorText(renderSyncErr));
      }
      return;
    }
    currentPdfRenderTask = renderTask;
    const renderPromise = renderTask?.promise;
    currentPdfRenderPromise = renderPromise;

    try {
      await renderPromise;
    } catch (e) {
      if (e?.name === 'RenderingCancelledException' || String(e?.message || '').toLowerCase().includes('cancel')) {
        return;
      }
      if (renderGen === pdfRenderGeneration && currentPdfDoc === doc) {
        showPdfPageError(canvasContainer, 'Page rendering error: ' + errorText(e));
      }
    } finally {
      if (currentPdfRenderTask === renderTask) {
        currentPdfRenderTask = null;
      }
    }
  }

  function changePdfPage(delta) {
    if (!currentPdfDoc) return;
    const totalPages = currentPdfDoc.numPages || 1;
    const next = pdfCurrentPage + delta;
    if (next < 1 || next > totalPages) return;
    pdfCurrentPage = next;
    const canvas = currentDialog?.querySelector?.('.mail-pdf-canvas');
    const pageStatus = currentDialog?.querySelector?.('.mail-pdf-page-status');
    const prevBtn = currentDialog?.querySelectorAll?.('.mail-pdf-toolbar button')?.[0];
    const nextBtn = currentDialog?.querySelectorAll?.('.mail-pdf-toolbar button')?.[1];
    const container = currentDialog?.querySelector?.('.mail-pdf-canvas-container');
    if (canvas) void renderPdfCurrentPage(canvas, pageStatus, prevBtn, nextBtn, container, activeLoadToken, sessionGeneration, currentDialog);
  }

  function changePdfZoom(action) {
    if (!currentPdfDoc) return;
    if (action === 'fit') {
      pdfScale = 'fit';
    } else if (typeof action === 'number') {
      const current = typeof pdfScale === 'number' ? pdfScale : renderedPdfScale;
      pdfScale = Math.max(0.25, Math.min(3.0, current * action));
    }
    const canvas = currentDialog?.querySelector?.('.mail-pdf-canvas');
    const pageStatus = currentDialog?.querySelector?.('.mail-pdf-page-status');
    const prevBtn = currentDialog?.querySelectorAll?.('.mail-pdf-toolbar button')?.[0];
    const nextBtn = currentDialog?.querySelectorAll?.('.mail-pdf-toolbar button')?.[1];
    const container = currentDialog?.querySelector?.('.mail-pdf-canvas-container');
    if (canvas) void renderPdfCurrentPage(canvas, pageStatus, prevBtn, nextBtn, container, activeLoadToken, sessionGeneration, currentDialog);
  }

  function openPreview(message, attachment, allAttachments = [], triggerElement = null) {
    const nextTrigger = triggerElement || document.activeElement;
    const reader = document.getElementById?.('mail-reader');
    const nextScroll = reader ? reader.scrollTop : 0;

    if (currentDialog) {
      closeDialog(false);
    }

    currentTrigger = nextTrigger;
    savedReaderScroll = nextScroll;

    activeMessageId = message.id;
    activeAttachments = allAttachments.length ? allAttachments : (message.attachments || [attachment]);
    const idx = activeAttachments.findIndex(att => att.id === attachment.id);
    currentIndex = idx >= 0 ? idx : 0;

    const dialog = renderDialogShell();
    if (dialog.showModal) {
      dialog.showModal();
    } else {
      dialog.open = true;
    }
    const closeBtn = dialog.querySelector('.mail-attachment-dialog-close');
    closeBtn?.focus?.();
    void loadActivePreview();
  }

  function createJumpControl(message, onJump) {
    const count = message?.attachments?.length || 0;
    if (!count) return null;
    const jump = button(`📎 ${count} ${count === 1 ? 'attachment' : 'attachments'}`, () => {
      if (typeof onJump === 'function') onJump();
      else {
        const el = document.getElementById('mail-attachments-section');
        el?.scrollIntoView?.({behavior: 'smooth', block: 'start'});
      }
    }, 'subtle mail-attachments-jump');
    jump.setAttribute('aria-label', `Jump to ${count} ${count === 1 ? 'attachment' : 'attachments'}`);
    jump.title = 'Jump to attachments';
    return jump;
  }

  function renderGrid(container, message) {
    const nextMessageId = message?.id ?? null;
    if (activeMessageId !== nextMessageId) {
      if (downloadAbortController) {
        try { downloadAbortController.abort(); } catch {}
        downloadAbortController = null;
      }
      if (currentDialog) {
        closeDialog(false);
      }
    }
    currentContainer = container;
    container.replaceChildren();
    activeMessageId = nextMessageId;
    const attachments = (message?.attachments || []).filter(att => att && typeof att.id === 'string');
    if (!attachments.length) return;

    const section = make('section', undefined, 'mail-attachments');
    section.id = 'mail-attachments-section';
    section.setAttribute('aria-label', 'Attachments');

    const header = make('div', undefined, 'mail-attachments-header');
    const heading = make('h3', `${attachments.length} ${attachments.length === 1 ? 'attachment' : 'attachments'}`);
    const downloadAll = button('Download all (.zip)', () => {
      void downloadAllZip(message.id);
    }, 'subtle mail-download-all');
    downloadAll.setAttribute('aria-label', 'Download all attachments as zip');

    header.append(heading, downloadAll);
    section.append(header);

    const grid = make('div', undefined, 'mail-attachment-grid');
    grid.setAttribute('role', 'list');

    for (const attachment of attachments) {
      const card = make('div', undefined, 'mail-attachment-card');
      card.setAttribute('role', 'listitem');

      const info = make('div', undefined, 'mail-attachment-info');
      const name = make('span', attachment.filename || 'Attachment', 'mail-attachment-name');
      name.title = attachment.filename || 'Attachment';

      const meta = make('span', `${attachmentReadableType(attachment)} · ${attachmentSize(attachment.size)}`, 'mail-attachment-meta');
      info.append(name, meta);

      const actions = make('div', undefined, 'mail-attachment-actions');
      const kind = attachmentPreviewKind(attachment);

      if (kind !== 'unsupported') {
        const viewBtn = button('View', event => {
          openPreview(message, attachment, attachments, event.currentTarget);
        }, 'subtle mail-attachment-view-btn');
        viewBtn.setAttribute('aria-label', `View ${attachment.filename || 'attachment'}`);
        actions.append(viewBtn);
      }

      const dlBtn = button('Download', () => {
        void downloadAttachment(message.id, attachment, false);
      }, 'subtle mail-attachment-download-btn');
      dlBtn.setAttribute('aria-label', `Download ${attachment.filename || 'attachment'}`);
      actions.append(dlBtn);

      card.append(info, actions);
      grid.append(card);
    }

    section.append(grid);
    container.append(section);
  }

  function reset() {
    sessionGeneration++;
    activeLoadToken++;
    if (downloadAbortController) {
      try { downloadAbortController.abort(); } catch {}
      downloadAbortController = null;
    }
    currentTrigger = null;
    closeDialog(false);
    revokeAllDownloadUrls();
    activeMessageId = null;
    currentContainer = null;
    isDownloadBusy = false;
  }

  return {
    renderGrid,
    createJumpControl,
    openPreview,
    closeDialog,
    downloadAttachment,
    downloadAllZip,
    reset
  };
}
