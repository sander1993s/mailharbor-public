const paths = {
  reply: 'm9 5-6 6 6 6 M3 11h10a7 7 0 0 1 7 7',
  reply_all: 'm7 5-6 6 6 6 m6-12-6 6 6 6 M7 11h7a7 7 0 0 1 7 7',
  forward: 'm15 5 6 6-6 6 M21 11H11a7 7 0 0 0-7 7',
  archive: 'M3 3h18v5H3z M5 8v13h14V8 M10 12h4',
  spam: 'm8 3-5 5v8l5 5h8l5-5V8l-5-5z M12 7v6 M12 16v1',
  check: 'm5 12 4 4L19 6',
  restore: 'M4 10V4 M4 10h6 M4 10a8 8 0 1 1 0 5',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  move: 'M3 7V4h6l2 3h10v13H3v-5 M2 11h11 m-4-4 4 4-4 4',
  folder: 'M3 7V4h6l2 3h10v13H3z',
  label: 'M3 3h8l10 10-8 8L3 11V3z M7 7h.01',
  edit: 'M13 4H5v16h14v-8 M11 13l1-4 7-7 3 3-7 7-4 1z',
  download: 'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
  attachment: 'm9 17 8-8a3 3 0 0 0-4-4L4 14a5 5 0 0 0 7 7L21 11 M7 15l8-8',
  file: 'M14 2H5v20h14V7z M14 2v6h5 M8 13h8 M8 17h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  chevron: 'm6 9 6 6 6-6',
  close: 'm6 6 12 12 M6 18 18 6',
  back: 'm10 5-7 7 7 7 M3 12h18',
  unread: 'M3 5h18v14H3z M3 5l9 7 9-7',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z'
};
let sequence = 0;
let activePopup = null;
const enhanced = new WeakMap();
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function icon(name) {
  const holder = make('span', 'ui-icon');
  holder.setAttribute('aria-hidden', 'true');
  if (document.createElementNS) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round'})) svg.setAttribute(key,value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d',paths[name] || paths.more); svg.append(path); holder.append(svg);
  }
  return holder;
}

export function iconButton(name, label, onClick, className = '') {
  const button = make('button', `ui-icon-button${className ? ` ${className}` : ''}`);
  button.type = 'button'; button.title = label; button.setAttribute('aria-label',label); button.append(icon(name));
  if (onClick) button.addEventListener('click',onClick);
  return button;
}

function showPopup(anchor, panel, {items, initial = 0, onClose, onKey} = {}) {
  activePopup?.close(false);
  let index = Math.max(0,initial);
  const enabled = () => items().filter(item => !item.disabled);
  const focus = value => { const choices = enabled(); index = (value + choices.length) % (choices.length || 1); choices[index]?.focus?.(); };
  const position = () => {
    if (!anchor.getBoundingClientRect || !panel.style) return;
    const bounds = anchor.getBoundingClientRect(), width = document.documentElement.clientWidth, height = window.innerHeight;
    panel.style.minWidth = `${Math.min(Math.max(bounds.width,200),width - 24)}px`;
    panel.style.maxWidth = `${Math.max(0,width - 24)}px`;
    const menuWidth = panel.getBoundingClientRect().width;
    panel.style.left = `${Math.max(12,Math.min(bounds.left,width - menuWidth - 12))}px`;
    const below = height - bounds.bottom - 20, above = bounds.top - 20;
    if (below < 160 && above > below) { panel.style.bottom = `${height - bounds.top + 6}px`; panel.style.top = 'auto'; panel.style.maxHeight = `${above}px`; }
    else { panel.style.top = `${bounds.bottom + 6}px`; panel.style.bottom = 'auto'; panel.style.maxHeight = `${Math.max(80,below)}px`; }
  };
  const close = (restoreFocus = true) => {
    panel.hidden = true; panel.remove?.(); anchor.setAttribute('aria-expanded','false');
    document.removeEventListener?.('pointerdown',outside,true); document.removeEventListener?.('keydown',keydown,true);
    if (typeof window !== 'undefined') window.removeEventListener?.('resize',position); document.removeEventListener?.('scroll',scroll,true);
    if (activePopup?.panel === panel) activePopup = null;
    onClose?.(); if (restoreFocus && anchor.isConnected !== false) anchor.focus?.();
  };
  const outside = event => { if (!panel.contains?.(event.target) && !anchor.contains?.(event.target)) close(false); };
  const scroll = event => { if (!panel.contains?.(event.target)) position(); };
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); close(); }
    else if (event.key === 'Tab') close();
    else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); const choices = enabled(), current = choices.indexOf(document.activeElement);
      focus(event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (current < 0 ? index : current) + (event.key === 'ArrowUp' ? -1 : 1));
    } else onKey?.(event,focus,enabled());
  };
  panel.hidden = false; anchor.setAttribute('aria-expanded','true'); (anchor.closest?.('dialog[open]') || document.body)?.append(panel); position();
  document.addEventListener?.('pointerdown',outside,true); document.addEventListener?.('keydown',keydown,true);
  if (typeof window !== 'undefined') window.addEventListener?.('resize',position);
  document.addEventListener?.('scroll',scroll,true);
  activePopup = {panel,anchor,close}; focus(index);
  return close;
}

/** Menu entries are {label, icon?, onClick?, href?, download?, disabled?, danger?}. */
export function actionMenu({label, icon: iconName = 'more', items = []}) {
  const element = make('span','ui-action-menu'), trigger = iconButton(iconName,label);
  let close = null;
  trigger.setAttribute('aria-haspopup','menu'); trigger.setAttribute('aria-expanded','false');
  function open() {
    if (trigger.disabled) return;
    if (close) { close(); return; }
    const panel = make('div','ui-popup ui-action-popup'); panel.id = `ui-menu-${++sequence}`; panel.setAttribute('role','menu'); panel.setAttribute('aria-label',label); trigger.setAttribute('aria-controls',panel.id);
    const entries = typeof items === 'function' ? items() : items;
    const controls = entries.map(entry => {
      const link = entry.href && !entry.disabled;
      const item = make(link ? 'a' : 'button',`ui-menu-item${entry.danger ? ' danger' : ''}`);
      if (link) { item.href = entry.href; if (entry.download !== undefined) item.download = entry.download; }
      else item.type = 'button';
      item.setAttribute('role','menuitem'); item.tabIndex = -1; item.disabled = !!entry.disabled;
      if (entry.disabled) item.setAttribute('aria-disabled','true');
      if (entry.icon) item.append(icon(entry.icon));
      item.append(make('span','',entry.label));
      item.addEventListener('click',event => { if (item.disabled) { event.preventDefault(); return; } close?.(); entry.onClick?.(event); });
      panel.append(item); return item;
    });
    if (!controls.length) panel.append(make('p','ui-menu-empty','No options available'));
    close = showPopup(trigger,panel,{items:() => controls,onClose:() => {close = null;}});
  }
  trigger.addEventListener('click',open); trigger.addEventListener('keydown',event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!close) open(); } });
  element.append(trigger); return {element,button:trigger,close:() => close?.()};
}

/** Keep the native select as a hidden form/state carrier while presenting a styled, keyboard-accessible listbox. */
export function enhanceSelect(select) {
  if (!select?.ownerDocument?.defaultView || select.multiple || select.size > 1) return null;
  const existing = enhanced.get(select); if (existing) { existing.sync(); return existing; }
  const wrapper = make('span','ui-select'), trigger = make('button','ui-select-trigger'), value = make('span','ui-select-value');
  const label = select.getAttribute('aria-label') || select.labels?.[0]?.childNodes?.[0]?.textContent?.trim() || select.name || 'Choose an option';
  trigger.type = 'button'; trigger.setAttribute('role','combobox'); trigger.setAttribute('aria-label',label); trigger.setAttribute('aria-haspopup','listbox'); trigger.setAttribute('aria-expanded','false');
  trigger.append(value,icon('chevron')); select.before(wrapper); wrapper.append(select,trigger);
  select.classList.add('ui-select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden','true');
  let close = null, typeahead = '', typedAt = 0;
  const sync = () => { value.textContent = select.selectedOptions[0]?.label || select.options[0]?.label || 'Choose an option'; trigger.disabled = select.disabled; trigger.title = value.textContent; };
  function choose(option) {
    if (option.disabled || option.parentElement?.disabled === true || select.disabled || option.index < 0) return;
    select.selectedIndex = option.index; sync(); close?.();
    select.dispatchEvent(new Event('input',{bubbles:true})); select.dispatchEvent(new Event('change',{bubbles:true})); sync();
  }
  function open() {
    if (select.disabled) return;
    if (close) { close(); return; }
    sync(); const panel = make('div','ui-popup ui-select-popup'); panel.id = `ui-select-${++sequence}`; panel.setAttribute('role','listbox'); panel.setAttribute('aria-label',label); trigger.setAttribute('aria-controls',panel.id);
    const choices = [...select.options].map(option => {
      const node = make('button','ui-select-option'); node.type = 'button'; node.tabIndex = -1; node.setAttribute('role','option'); node.setAttribute('aria-selected',String(option.selected)); node.disabled = option.disabled || option.parentElement?.disabled === true;
      node.append(make('span','',option.label),icon('check')); node.addEventListener('click',() => choose(option)); panel.append(node); return node;
    });
    const enabled = choices.filter(item => !item.disabled), selected = choices[select.selectedIndex];
    close = showPopup(trigger,panel,{items:() => choices,initial:Math.max(0,enabled.indexOf(selected)),onClose:() => {close = null; typeahead = '';},onKey:(event,focus,items) => {
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.key === ' ') return;
      event.preventDefault(); typeahead = Date.now() - typedAt < 700 ? typeahead + event.key : event.key; typedAt = Date.now();
      const index = items.findIndex(item => item.textContent.toLowerCase().startsWith(typeahead.toLowerCase())); if (index >= 0) focus(index);
    }});
  }
  trigger.addEventListener('click',open); trigger.addEventListener('focus',sync); select.addEventListener('change',sync);
  select.addEventListener('focus',() => trigger.focus());
  select.addEventListener('pointerdown',event => event.preventDefault());
  select.addEventListener('click',event => { event.preventDefault(); trigger.focus(); if (!select.disabled) open(); });
  for (const associatedLabel of select.labels ?? []) associatedLabel.addEventListener('click',event => {
    if (event.defaultPrevented || event.target === select || trigger.contains(event.target)) return;
    // Leave nested links and other form controls alone; a label caption activates this combobox.
    if (event.target.closest?.('a,button,input,select,textarea')) return;
    event.preventDefault(); trigger.focus(); if (!select.disabled) open();
  });
  trigger.addEventListener('keydown',event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!close) open(); } });
  select.addEventListener('invalid',event => { event.preventDefault(); trigger.focus(); trigger.setAttribute('aria-invalid','true'); });
  select.addEventListener('change',() => trigger.removeAttribute('aria-invalid'));
  const observer = new MutationObserver(() => { sync(); if (close) close(); }); observer.observe(select,{childList:true,subtree:true,attributes:true,characterData:true});
  const result = {sync,button:trigger}; enhanced.set(select,result); sync(); return result;
}

export function enhanceSelects(root = document) {
  if (root.matches?.('select')) enhanceSelect(root);
  for (const select of root.querySelectorAll?.('select') ?? []) enhanceSelect(select);
}

/** Enhance existing and future application selects, including controls inserted by modal forms. */
export function observeSelects(root = document) {
  if (typeof MutationObserver === 'undefined') return () => {};
  enhanceSelects(root);
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) enhanceSelects(node);
    if (activePopup && activePopup.anchor.isConnected === false) activePopup.close(false);
  });
  observer.observe(root,{subtree:true,childList:true}); return () => { observer.disconnect(); activePopup?.close(false); };
}
