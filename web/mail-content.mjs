const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const button = (text, action) => {
  const node = make('button', text, 'subtle'); node.type = 'button'; node.addEventListener('click', action); return node;
};
const icon = path => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'})) svg.setAttribute(name, value);
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path'); shape.setAttribute('d', path); svg.append(shape); return svg;
};
const DOWNLOAD_ICON = 'M12 3v12 m-5-5 5 5 5-5 M4 15v5h16v-5';
const TEXT_ICON = 'M4 5h16 M8 5v15 M16 5v15 M5 20h6 M13 20h6';
export const isOfficeAttachment = attachment => /\.(?:docx|xlsx|pptx)$/iu.test(attachment.filename ?? '');

export function isolatedMailDocument(html) {
  return '<!doctype html><html class="mail-document"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'self\' \'unsafe-inline\'; script-src \'none\'; form-action \'none\'; base-uri \'none\'; connect-src \'none\'; frame-src \'none\'; object-src \'none\'">' +
    '<link rel="stylesheet" href="/mail-content.css">' +
    `<title>Message content</title></head><body>${html}</body></html>`;
}

export function foldMailBlockquotes(doc) {
  if (!doc) return;
  const blockquotes = doc.querySelectorAll
    ? Array.from(doc.querySelectorAll('blockquote'))
    : (doc.getElementsByTagName ? Array.from(doc.getElementsByTagName('blockquote')) : []);

  const MAX_WRAPPERS = 100;
  let wrapperCount = doc.querySelectorAll
    ? doc.querySelectorAll('details.mail-quoted-text').length
    : 0;

  for (const bq of blockquotes) {
    if (wrapperCount >= MAX_WRAPPERS) break;

    let parent = bq.parentElement;
    let isTopLevel = true;
    while (parent) {
      const tag = (parent.tagName || parent.nodeName || '').toLowerCase();
      if (tag === 'blockquote' || tag === 'details') {
        isTopLevel = false;
        break;
      }
      parent = parent.parentElement;
    }
    if (!isTopLevel) continue;

    const directParent = bq.parentElement;
    if (!directParent) continue;
    const ownerDoc = bq.ownerDocument || doc;
    if (!ownerDoc?.createElement) continue;

    const details = ownerDoc.createElement('details');
    details.className = 'mail-quoted-text';
    details.open = false;

    const summary = ownerDoc.createElement('summary');
    summary.textContent = 'Show quoted text';
    details.append ? details.append(summary) : details.appendChild(summary);

    directParent.insertBefore(details, bq);
    details.append ? details.append(bq) : details.appendChild(bq);
    wrapperCount++;
  }
}

/** Grow and shrink with the body, including image loads and reader width changes.
 * Measuring the body instead of documentElement avoids a viewport-height loop. */
export function autoSizeMailFrame(frame) {
  let observer = null, body = null, stopped = false;
  const MAX_FRAME_HEIGHT = 12000;
  const measure = () => {
    if (stopped || !body) return;
    const rawHeight = Math.ceil(Math.max(body.scrollHeight || 0, body.offsetHeight || 0, body.getBoundingClientRect?.().height || 0)) + 1;
    if (Number.isFinite(rawHeight) && rawHeight > 0) {
      const height = Math.min(MAX_FRAME_HEIGHT, rawHeight);
      frame.style.height = `${height}px`;
      if (rawHeight > MAX_FRAME_HEIGHT) {
        frame.style.overflowY = 'auto';
      } else {
        frame.style.overflowY = '';
      }
    }
  };
  const loaded = () => {
    observer?.disconnect();
    body?.removeEventListener?.('load', measure, true);
    body?.removeEventListener?.('toggle', measure, true);
    let doc = null;
    try { doc = frame.contentDocument; body = doc?.body; } catch { body = null; }
    if (!body || stopped) return;
    foldMailBlockquotes(doc);
    body.addEventListener?.('load', measure, true);
    body.addEventListener?.('toggle', measure, true);
    if (typeof ResizeObserver === 'function') { observer = new ResizeObserver(measure); observer.observe(body); }
    measure();
  };
  frame.addEventListener?.('load', loaded);
  globalThis.window?.addEventListener?.('resize', measure);
  try {
    const doc = frame.contentDocument;
    if (doc?.readyState === 'complete' && doc.body?.childNodes?.length) loaded();
  } catch { /* A navigating or inaccessible frame is handled by its next load. */ }
  return () => {
    stopped = true;
    observer?.disconnect();
    body?.removeEventListener?.('load', measure, true);
    body?.removeEventListener?.('toggle', measure, true);
    frame.removeEventListener?.('load', loaded);
    globalThis.window?.removeEventListener?.('resize', measure);
    body = null;
  };
}

function appendLinkified(target, text) {
  let position = 0;
  for (const match of String(text).matchAll(/(?:https?:\/\/|mailto:)[^\s<>]+/giu)) {
    const href = match[0].replace(/[.,;!?)\]}]+$/gu, '');
    try { new URL(href); } catch { continue; }
    if (match.index > position) target.append(make('span', text.slice(position, match.index)));
    const link = make('a', href);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    target.append(link);
    position = match.index + href.length;
  }
  if (position < text.length) target.append(make('span', text.slice(position)));
}

export function plainMailBody(text) {
  const rawText = String(text ?? '');
  const lines = rawText.split(/(?<=\n)/u);
  const isQuoteLine = line => /^[^\S\r\n]*>/u.test(line);

  if (!lines.some(isQuoteLine)) {
    const body = make('pre', undefined, 'rich-mail-text');
    appendLinkified(body, rawText);
    return body;
  }

  const chunks = [];
  let currentChunk = null;
  for (const line of lines) {
    if (line === '') continue;
    const isQuote = isQuoteLine(line);
    if (!currentChunk || currentChunk.isQuote !== isQuote) {
      currentChunk = { isQuote, lines: [line] };
      chunks.push(currentChunk);
    } else {
      currentChunk.lines.push(line);
    }
  }

  const container = make('div', undefined, 'rich-mail-text');
  for (const chunk of chunks) {
    const chunkText = chunk.lines.join('');
    if (chunk.isQuote) {
      const details = make('details', undefined, 'mail-quoted-text');
      details.open = false;
      const summary = make('summary', 'Show quoted text');
      details.append(summary);

      const pre = make('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.font = 'inherit';
      pre.style.margin = '0';
      appendLinkified(pre, chunkText);
      details.append(pre);

      container.append(details);
    } else {
      const pre = make('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.font = 'inherit';
      pre.style.margin = '0';
      appendLinkified(pre, chunkText);
      container.append(pre);
    }
  }

  return container;
}

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

export function createRichMailView({api, describeError}) {
  let revision = 0, currentId = null, host = null, content = null, message = null, mode = 'html';
  let pending = false, error = '', actionPending = false;
  let renderedHtml = null, renderedText = null;
  let inlineImagesPending = false, inlineImagesError = '';
  let cleanupFrame = () => {}, cleanupMenu = () => {};
  let currentSection = null;
  let currentFrame = null;
  let currentPlain = null;
  let currentToolbar = null;
  let currentStatus = null;
  let currentError = null;
  let currentPrivacy = null;
  let currentIncomplete = null;
  let currentInlineStatus = null;
  let currentDecrypt = null;
  let currentDecryptedAttachments = null;
  let contentAbortController = null;
  let inlineImagesAbortController = null;

  const urls = new Map();
  const errorText = value => describeError?.(value) || value?.message || 'The message could not be loaded.';
  const call = (path, body, blob = false, signal = undefined) => api(`/api/mail/${path}`, {method: 'POST', body, timeout: 190000, ...(blob ? {responseType: 'blob'} : {}), ...(signal ? {signal} : {})});

  function reset() {
    if (contentAbortController) {
      try { contentAbortController.abort(); } catch {}
      contentAbortController = null;
    }
    if (inlineImagesAbortController) {
      try { inlineImagesAbortController.abort(); } catch {}
      inlineImagesAbortController = null;
    }
    cleanupFrame();
    cleanupMenu();
    revision++;
    currentId = null;
    host = null;
    content = null;
    message = null;
    mode = 'html';
    pending = false;
    error = '';
    actionPending = false;
    renderedHtml = null;
    renderedText = null;
    inlineImagesPending = false;
    inlineImagesError = '';
    currentSection = null;
    currentFrame = null;
    currentPlain = null;
    currentToolbar = null;
    currentStatus = null;
    currentError = null;
    currentPrivacy = null;
    currentIncomplete = null;
    currentInlineStatus = null;
    currentDecrypt = null;
    currentDecryptedAttachments = null;
    for (const [url, timer] of urls) {
      clearTimeout(timer);
      try { URL.revokeObjectURL(url); } catch {}
    }
    urls.clear();
  }

  async function loadInlineImages() {
    if (inlineImagesPending || actionPending || !currentId) return;
    const version = revision, id = currentId;
    if (inlineImagesAbortController) {
      try { inlineImagesAbortController.abort(); } catch {}
      inlineImagesAbortController = null;
    }
    const abortController = new AbortController();
    inlineImagesAbortController = abortController;
    inlineImagesPending = true;
    inlineImagesError = '';
    draw();
    try {
      const result = await call('content', {id, includeInlineImages: true}, false, abortController.signal);
      if (abortController.signal.aborted || version !== revision || id !== currentId) return;
      const payload = result?.content ?? result;
      if (payload && typeof payload === 'object' && (typeof payload.html === 'string' || typeof payload.text === 'string')) {
        content = payload;
      } else {
        inlineImagesError = describeError?.({ code: 'content_unavailable' }) || 'The embedded images could not be loaded.';
      }
    } catch (cause) {
      if (abortController.signal.aborted || cause?.name === 'AbortError' || version !== revision || id !== currentId) return;
      inlineImagesError = errorText(cause);
    } finally {
      if (inlineImagesAbortController === abortController) {
        inlineImagesAbortController = null;
      }
      if (version === revision && id === currentId) {
        inlineImagesPending = false;
        draw();
      }
    }
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(new Blob([blob], {type: 'application/octet-stream'}));
    const anchor = make('a');
    anchor.href = url;
    anchor.download = String(name).replace(/[\\/\u0000-\u001f\u007f]/gu, '_');
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    const timer = setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch {}
      urls.delete(url);
    }, 60000);
    urls.set(url, timer);
  }

  async function action(work) {
    if (actionPending) return;
    const version = revision;
    actionPending = true;
    error = '';
    draw();
    try {
      await work(() => version === revision);
    } catch (cause) {
      if (version === revision) error = errorText(cause);
    } finally {
      if (version === revision) {
        actionPending = false;
        draw();
      }
    }
  }

  async function load() {
    if (pending || !currentId) return;
    const version = revision, id = currentId;
    if (contentAbortController) {
      try { contentAbortController.abort(); } catch {}
      contentAbortController = null;
    }
    const abortController = new AbortController();
    contentAbortController = abortController;
    const { signal } = abortController;

    pending = true;
    error = '';
    draw();
    try {
      const result = await call('content', {id}, false, signal);
      if (signal.aborted || version !== revision || id !== currentId) return;
      const payload = result?.content ?? result;
      if (payload && typeof payload === 'object' && (typeof payload.html === 'string' || typeof payload.text === 'string')) {
        content = payload;
        mode = content.html ? 'html' : 'text';
      } else {
        error = describeError?.({ code: 'content_unavailable' }) || 'The message could not be loaded.';
      }
    } catch (cause) {
      if (signal.aborted || cause?.name === 'AbortError' || version !== revision || id !== currentId) return;
      error = errorText(cause);
    } finally {
      if (contentAbortController === abortController) {
        contentAbortController = null;
      }
      if (version === revision) {
        pending = false;
        draw();
      }
    }
  }

  const download = (path, filename) => action(async current => {
    const blob = await call(path, {id: currentId}, true);
    if (current()) downloadBlob(blob, filename);
  });

  function renderToolbar() {
    cleanupMenu();
    const controls = make('div', undefined, 'rich-mail-toolbar');
    const menu = make('details', undefined, 'rich-mail-options');
    const toggle = make('summary');
    toggle.title = 'Message options';
    toggle.setAttribute('aria-label', 'Message options');
    toggle.append(icon('M5 12h.01 M12 12h.01 M19 12h.01'), make('span', 'Message options', 'visually-hidden'));

    const list = make('div', undefined, 'rich-mail-options-list');
    const item = (label, path, work) => {
      const control = button(undefined, () => {
        menu.open = false;
        try { toggle.focus(); } catch {}
        work();
      });
      control.append(icon(path), make('span', label));
      control.disabled = actionPending || inlineImagesPending;
      list.append(control);
    };

    item('Download message (.eml)', DOWNLOAD_ICON, () => download('source', 'message.eml'));
    item('Download headers', DOWNLOAD_ICON, () => download('headers', 'message-headers.txt'));
    if (message?.attachments?.length) {
      item('Download all attachments (.zip)', DOWNLOAD_ICON, () => download('attachments', 'attachments.zip'));
    }
    const hasVettedRaster = Boolean(
      content &&
      !content.encrypted &&
      Array.isArray(content.inlineParts) &&
      content.inlineParts.some(part => part?.mimeType && RASTER.has(String(part.mimeType).toLowerCase()))
    );
    if (hasVettedRaster && (!content?.inlineImagesLoaded || content.inlineImagesStatus !== 'complete')) {
      const label = content?.inlineImagesLoaded ? 'Retry embedded images' : 'Load embedded images';
      item(label, DOWNLOAD_ICON, () => void loadInlineImages());
    }
    if (content?.html && (!content.encrypted || content.encrypted.decrypted)) {
      item(mode === 'html' ? 'View plain text' : 'View formatted message', TEXT_ICON, () => {
        mode = mode === 'html' ? 'text' : 'html';
        draw();
      });
    }

    menu.append(toggle, list);
    controls.append(menu);

    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        menu.open = false;
        try { toggle.focus(); } catch {}
      }
    });
    const outside = event => {
      if (!menu.contains(event.target)) menu.open = false;
    };
    document.addEventListener?.('pointerdown', outside);
    cleanupMenu = () => document.removeEventListener?.('pointerdown', outside);
    return controls;
  }

  function renderDecryptForm() {
    const form = make('form', undefined, 'rich-mail-decrypt');
    form.autocomplete = 'off';
    const kind = content.encrypted.type === 'smime' ? 'S/MIME' : 'OpenPGP';
    form.append(make('h4', `${kind} encrypted message`), make('p', 'Your key is used for this request on your paired MailHarbor server and is never saved.'));

    function field(label, tag = 'textarea', type) {
      const wrapper = make('label', label);
      const input = make(tag);
      if (type) input.type = type;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.maxLength = tag === 'textarea' ? 262144 : 4096;
      wrapper.append(input);
      form.append(wrapper);
      return input;
    }

    const key = field('Private key (PEM / armored)');
    key.required = true;
    const passphrase = field('Key passphrase', 'input', 'password');
    const cert = content.encrypted.type === 'smime' ? field('Recipient certificate (PEM)') : null;
    if (cert) cert.required = true;

    const submit = make('button', 'Decrypt message');
    submit.type = 'submit';
    submit.disabled = actionPending;
    form.append(submit);

    form.addEventListener('submit', event => {
      event.preventDefault();
      const body = {id: currentId, privateKey: key.value, passphrase: passphrase.value, certificate: cert?.value ?? ''};
      key.value = '';
      passphrase.value = '';
      if (cert) cert.value = '';
      void action(async current => {
        try {
          const result = await call('decrypt', body);
          if (current()) {
            content = result.content ?? result;
            mode = content.html ? 'html' : 'text';
          }
        } finally {
          body.privateKey = '';
          body.passphrase = '';
          body.certificate = '';
        }
      });
    });
    return form;
  }

  function draw() {
    if (!host || !currentId) return;

    if (!currentSection) {
      currentSection = make('section', undefined, 'rich-mail-content');
      host.replaceChildren(currentSection);
    } else if (currentSection.parentElement !== host) {
      host.replaceChildren(currentSection);
    }

    // Update toolbar
    const newToolbar = renderToolbar();
    if (currentToolbar) {
      currentToolbar.replaceWith(newToolbar);
    } else {
      currentSection.prepend(newToolbar);
    }
    currentToolbar = newToolbar;

    // Status: Loading complete message
    if (pending) {
      if (!currentStatus) {
        currentStatus = make('p', 'Loading complete message…', 'fineprint');
        currentToolbar.after(currentStatus);
      }
    } else if (inlineImagesPending) {
      if (!currentStatus) {
        currentStatus = make('p', 'Loading embedded images…', 'fineprint');
        currentToolbar.after(currentStatus);
      }
    } else if (currentStatus) {
      currentStatus.remove();
      currentStatus = null;
    }

    // Incomplete notice
    if (content && content.complete === false) {
      if (!currentIncomplete) {
        currentIncomplete = make('p', 'This message is partial. Use Message options to download the original message.', 'fineprint rich-mail-incomplete-notice');
        (currentStatus || currentToolbar).after(currentIncomplete);
      }
    } else if (currentIncomplete) {
      currentIncomplete.remove();
      currentIncomplete = null;
    }

    // Error notice
    const activeError = error || inlineImagesError;
    if (activeError) {
      if (!currentError) {
        currentError = make('div', undefined, 'rich-mail-error-container');
        const notice = make('p', activeError, 'rich-mail-error');
        notice.setAttribute('role', 'alert');
        currentError.append(notice);
        if (!content && !pending) {
          currentError.append(button('Retry full message', () => void load()));
        } else if (inlineImagesError) {
          currentError.append(button('Retry embedded images', () => void loadInlineImages()));
        }
        (currentIncomplete || currentStatus || currentToolbar).after(currentError);
      } else {
        const p = currentError.querySelector('p');
        if (p) p.textContent = activeError;
      }
    } else if (currentError) {
      currentError.remove();
      currentError = null;
    }

    // Content body handling
    if (content) {
      // If encrypted and not decrypted
      if (content.encrypted && !content.encrypted.decrypted) {
        if (currentFrame) { cleanupFrame(); currentFrame.remove(); currentFrame = null; renderedHtml = null; }
        if (currentPlain) { currentPlain.remove(); currentPlain = null; renderedText = null; }
        if (currentPrivacy) { currentPrivacy.remove(); currentPrivacy = null; }
        if (currentInlineStatus) { currentInlineStatus.remove(); currentInlineStatus = null; }
        if (!currentDecrypt) {
          currentDecrypt = renderDecryptForm();
          currentSection.append(currentDecrypt);
        }
        return;
      }

      if (currentDecrypt) {
        currentDecrypt.remove();
        currentDecrypt = null;
      }

      // Decrypted note banner
      if (content.encrypted?.decrypted) {
        let note = currentSection.querySelector('.rich-mail-decrypted-note');
        if (!note) {
          note = make('p', 'Decrypted for this view. Sender signature has not been verified.', 'fineprint rich-mail-decrypted-note');
          currentToolbar.after(note);
        }
      }

      // Inline partial / unavailable notice
      if (content?.inlineImagesLoaded && content?.inlineImagesStatus && content.inlineImagesStatus !== 'complete') {
        if (!currentInlineStatus) {
          const p = make('p', undefined, 'fineprint rich-mail-inline-status');
          const msg = content.inlineImagesStatus === 'partial'
            ? 'Some embedded images could not be loaded.'
            : 'Embedded images were unavailable.';
          p.append(make('span', msg), make('span', ' '), button('Retry embedded images', () => void loadInlineImages()));
          currentInlineStatus = p;
          (currentError || currentIncomplete || currentStatus || currentToolbar).after(currentInlineStatus);
        }
      } else if (currentInlineStatus) {
        currentInlineStatus.remove();
        currentInlineStatus = null;
      }

      if (mode === 'html' && content.html) {
        if (currentPlain) {
          currentPlain.remove();
          currentPlain = null;
          renderedText = null;
        }

        // Privacy banner only when content.html contains blocked remote images
        const hasBlockedImages = /data-blocked-image="true"/u.test(content.html);
        if (hasBlockedImages) {
          if (!currentPrivacy) {
            currentPrivacy = make('p', 'Remote images and external resources are blocked for your privacy.', 'rich-mail-privacy');
            (currentInlineStatus || currentError || currentIncomplete || currentStatus || currentToolbar).after(currentPrivacy);
          }
        } else if (currentPrivacy) {
          currentPrivacy.remove();
          currentPrivacy = null;
        }

        // RETAIN same mounted DOM/frame
        if (!currentFrame) {
          const frame = make('iframe', undefined, 'rich-mail-frame');
          frame.title = 'Email HTML content';
          frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
          frame.setAttribute('scrolling', 'no');
          frame.referrerPolicy = 'no-referrer';
          cleanupFrame = autoSizeMailFrame(frame);
          frame.srcdoc = isolatedMailDocument(content.html);
          renderedHtml = content.html;
          currentFrame = frame;
          currentSection.append(frame);
        } else {
          if (currentFrame.parentElement !== currentSection) {
            currentSection.append(currentFrame);
          }
          if (renderedHtml !== content.html) {
            currentFrame.srcdoc = isolatedMailDocument(content.html);
            renderedHtml = content.html;
          }
        }
      } else {
        // Plain text mode
        if (currentFrame) {
          cleanupFrame();
          currentFrame.remove();
          currentFrame = null;
          renderedHtml = null;
        }
        if (currentPrivacy) {
          currentPrivacy.remove();
          currentPrivacy = null;
        }
        const plainText = content.text || 'No plain-text body. Use Message options to view the formatted message.';
        if (!currentPlain) {
          currentPlain = plainMailBody(plainText);
          renderedText = plainText;
          currentSection.append(currentPlain);
        } else {
          if (currentPlain.parentElement !== currentSection) {
            currentSection.append(currentPlain);
          }
          if (renderedText !== plainText) {
            const newPlain = plainMailBody(plainText);
            currentPlain.replaceWith(newPlain);
            currentPlain = newPlain;
            renderedText = plainText;
          }
        }
      }

      // Decrypted attachments download buttons
      if (content.encrypted?.decrypted && content.attachments?.length) {
        if (!currentDecryptedAttachments) {
          currentDecryptedAttachments = make('div', undefined, 'rich-mail-decrypted-attachments');
          for (const attachment of content.attachments) {
            if (typeof attachment.bytesBase64 !== 'string') continue;
            currentDecryptedAttachments.append(button(`Download ${attachment.filename}`, () => {
              const binary = atob(attachment.bytesBase64);
              const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
              downloadBlob(bytes, attachment.filename);
            }));
          }
          currentSection.append(currentDecryptedAttachments);
        }
      }
    } else if (message?.body) {
      // Readable fallback before full content arrives
      if (!currentPlain) {
        currentPlain = plainMailBody(message.body);
        renderedText = message.body;
        currentSection.append(currentPlain);
      } else if (currentPlain.parentElement !== currentSection) {
        currentSection.append(currentPlain);
      }
    }
  }

  return {
    render(container, value, {id = value?.id} = {}) {
      if (!id) {
        reset();
        container.replaceChildren();
        return;
      }
      const changed = id !== currentId;
      if (changed) {
        reset();
      }
      currentId = id;
      host = container;
      message = value;
      if (changed) {
        void load();
      } else {
        draw();
      }
    },
    reset
  };
}
