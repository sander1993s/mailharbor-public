import { simpleParser } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import { zipSync } from 'fflate';
import { inflateRawSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { MailHarborError } from './validation.mjs';
import { MAX_ATTACHMENT_BYTES, validAttachmentId } from './mail-attachments.mjs';
import { decryptMail } from './mail-crypto.mjs';

export const MAIL_RENDERER_VERSION = '2';
export const MAX_MESSAGE_SOURCE_BYTES = 160 * 1024 * 1024;
export const MAX_RENDERED_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_ZIP_BYTES = 100 * 1024 * 1024;
export const MAX_CONTENT_ENCODED_BYTES = 16 * 1024 * 1024;
export const MAX_CONTENT_DECODED_BYTES = 8 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_AGGREGATE_INLINE_BYTES = 8 * 1024 * 1024;
export const MAX_INLINE_PARTS_COUNT = 10;
const MAX_OFFICE_BYTES = 25 * 1024 * 1024, MAX_XML_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 1024 * 1024;
const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const fail = code => { throw new MailHarborError(code); };
const abort = signal => { if (signal?.aborted) throw signal.reason ?? new MailHarborError('cancelled'); };

export function safeFilename(value, fallback = 'attachment') {
  let name = String(value ?? '').toWellFormed().normalize('NFC').split(/[\\/]/u).at(-1)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>:"|?*]/gu, '')
    .replace(/^[.\s]+|[.\s]+$/gu, '');
  name = Array.from(name).slice(0, 180).join('');
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu.test(name)) name = `_${name}`;
  if (['__proto__','constructor','prototype'].includes(name.toLowerCase())) name = `_${name}`;
  return name || fallback;
}

const COLOR_REGEX = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\(\s*\d+(?:\.\d+)?%?\s*,\s*\d+(?:\.\d+)?%?\s*,\s*\d+(?:\.\d+)?%?(?:\s*,\s*[\d.]+%?)?\s*\)|[a-zA-Z]+)$/;
const BORDER_VAL_REGEX = /^(?:none|hidden|0|(?:\d+(?:\.\d+)?(?:px|em|pt|thin|medium|thick)\s+)?(?:solid|dashed|dotted|double|groove|ridge|inset|outset)(?:\s+(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^)]+\)|[a-zA-Z]+))?)$/i;

function hasDisallowedCssConstruct(str) {
  if (/\\/u.test(str)) return true;
  if (/\/\*[\s\S]*?\*\//u.test(str)) return true;
  const lower = str.toLowerCase();
  if (/(?:url|expression|@import|behavior|position|javascript|-moz-binding)\b/iu.test(lower) || lower.includes('url(') || lower.includes('expression(')) {
    return true;
  }
  return false;
}

function parseLength(val) {
  const match = /^(-?\d+(?:\.\d+)?)(px|em|rem|%|pt)$/i.exec(String(val).trim());
  if (!match) return null;
  return {num: parseFloat(match[1]), unit: match[2].toLowerCase()};
}

function isSafeFontSize(val) {
  if (val === '0') return true;
  const parsed = parseLength(val);
  if (!parsed || parsed.num < 0) return false;
  const {num, unit} = parsed;
  if (unit === 'px' && num >= 6 && num <= 72) return true;
  if (unit === 'pt' && num >= 5 && num <= 72) return true;
  if ((unit === 'em' || unit === 'rem') && num >= 0.4 && num <= 4.5) return true;
  if (unit === '%' && num >= 30 && num <= 400) return true;
  return false;
}

function isSafeMargin(val) {
  const parts = String(val).trim().split(/\s+/u);
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every(part => {
    if (part === '0' || part.toLowerCase() === 'auto') return true;
    const parsed = parseLength(part);
    if (!parsed) return false;
    const {num, unit} = parsed;
    if (unit === 'px') return num >= -100 && num <= 200;
    if (unit === 'pt') return num >= -75 && num <= 150;
    if (unit === 'em' || unit === 'rem') return num >= -6 && num <= 12;
    if (unit === '%') return num >= -50 && num <= 100;
    return false;
  });
}

function isSafePadding(val) {
  const parts = String(val).trim().split(/\s+/u);
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every(part => {
    if (part === '0' || part.toLowerCase() === 'auto') return true;
    const parsed = parseLength(part);
    if (!parsed || parsed.num < 0) return false;
    const {num, unit} = parsed;
    if (unit === 'px') return num <= 200;
    if (unit === 'pt') return num <= 150;
    if (unit === 'em' || unit === 'rem') return num <= 12;
    if (unit === '%') return num <= 100;
    return false;
  });
}

function isSafeDimension(val, maxPx = 1600) {
  if (val === '0' || val.toLowerCase() === 'auto' || val.toLowerCase() === 'none') return true;
  const parsed = parseLength(val);
  if (!parsed || parsed.num < 0) return false;
  const {num, unit} = parsed;
  if (unit === 'px') return num <= maxPx;
  if (unit === 'pt') return num <= maxPx * 0.75;
  if (unit === 'em' || unit === 'rem') return num <= maxPx / 16;
  if (unit === '%') return num <= 100;
  return false;
}

function isSafeBorderWidth(val) {
  const lower = String(val).toLowerCase();
  if (['0', 'thin', 'medium', 'thick'].includes(lower)) return true;
  const parsed = parseLength(val);
  if (!parsed || parsed.num < 0) return false;
  return (parsed.unit === 'px' && parsed.num <= 20) || (parsed.unit === 'pt' && parsed.num <= 16);
}

function isSafeBorder(val) {
  if (['none', 'hidden', '0'].includes(String(val).toLowerCase().trim())) return true;
  const match = BORDER_VAL_REGEX.exec(val);
  if (!match) return false;
  const lengthMatch = /^\d+(?:\.\d+)?(?:px|em|pt|thin|medium|thick)/i.exec(val);
  if (lengthMatch && !isSafeBorderWidth(lengthMatch[0])) return false;
  return true;
}

function sanitizeInlineStyle(styleText) {
  if (typeof styleText !== 'string' || !styleText.trim()) return '';
  if (hasDisallowedCssConstruct(styleText)) return '';

  const declarations = styleText.split(';');
  const clean = [];
  for (const decl of declarations) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (!prop || !val) continue;

    if (['position', 'behavior', 'background-image', 'cursor', 'display'].includes(prop)) continue;

    let valid = false;
    if (prop === 'color' || prop === 'background-color') {
      valid = COLOR_REGEX.test(val);
    } else if (prop === 'background') {
      valid = /^(?:none|transparent|#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^)]+\)|[a-zA-Z]+)$/i.test(val);
    } else if (prop === 'font-family') {
      valid = /^[a-zA-Z0-9\s,"'._-]+$/i.test(val) && val.length <= 120 && !hasDisallowedCssConstruct(val);
    } else if (prop === 'font-size') {
      valid = isSafeFontSize(val);
    } else if (prop === 'font-weight') {
      valid = /^(?:normal|bold|bolder|lighter|[1-9]00)$/i.test(val);
    } else if (prop === 'font-style') {
      valid = /^(?:normal|italic|oblique)$/i.test(val);
    } else if (prop === 'line-height') {
      valid = /^(?:normal|\d+(?:\.\d+)?(?:px|em|rem|%|pt)?)$/i.test(val) && (isSafeFontSize(val) || /^(?:normal|[0-3](?:\.\d+)?)$/i.test(val));
    } else if (prop === 'text-decoration') {
      valid = /^(?:none|underline|line-through|overline)(?:\s+(?:solid|dashed|dotted|double|wavy))?$/i.test(val);
    } else if (prop === 'text-align') {
      valid = /^(?:left|right|center|justify)$/i.test(val);
    } else if (prop === 'vertical-align') {
      valid = /^(?:baseline|sub|super|top|text-top|middle|bottom|text-bottom)$/i.test(val) || isSafeMargin(val);
    } else if (['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'].includes(prop)) {
      valid = isSafeMargin(val);
    } else if (['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'].includes(prop)) {
      valid = isSafePadding(val);
    } else if (['width', 'min-width', 'max-width'].includes(prop)) {
      valid = isSafeDimension(val, 1600);
    } else if (['height', 'min-height', 'max-height'].includes(prop)) {
      valid = isSafeDimension(val, 2400);
    } else if (['border', 'border-top', 'border-right', 'border-bottom', 'border-left'].includes(prop)) {
      valid = isSafeBorder(val);
    } else if (prop === 'border-color') {
      valid = val.split(/\s+/u).every(c => COLOR_REGEX.test(c));
    } else if (prop === 'border-style') {
      valid = /^(?:none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)(?:\s+(?:none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)){0,3}$/i.test(val);
    } else if (prop === 'border-width') {
      valid = val.split(/\s+/u).every(isSafeBorderWidth);
    } else if (prop === 'border-radius') {
      valid = val.split(/\s+/u).every(part => isSafeDimension(part, 50));
    } else if (prop === 'border-collapse') {
      valid = /^(?:collapse|separate)$/i.test(val);
    } else if (prop === 'border-spacing') {
      valid = isSafeDimension(val, 50);
    } else if (prop === 'table-layout') {
      valid = /^(?:auto|fixed)$/i.test(val);
    } else if (prop === 'white-space') {
      valid = /^(?:normal|nowrap|pre|pre-wrap|pre-line)$/i.test(val);
    } else if (prop === 'letter-spacing' || prop === 'word-spacing') {
      valid = /^(?:normal|-?\d+(?:\.\d+)?(?:px|em|pt))$/i.test(val) && isSafeMargin(val);
    }

    if (valid) {
      clean.push(`${prop}: ${val}`);
    }
  }
  return clean.join('; ');
}

function boundIntegerAttr(val, min, max) {
  if (!val && val !== 0) return null;
  const str = String(val).trim();
  if (!/^\d+$/u.test(str)) return null;
  const num = parseInt(str, 10);
  if (num < min || num > max) return null;
  return String(num);
}

function boundDimensionAttr(val, maxPx) {
  if (!val && val !== 0) return null;
  const str = String(val).trim();
  if (/^(\d+)%$/u.test(str)) {
    const num = parseInt(str, 10);
    return num >= 1 && num <= 100 ? `${num}%` : null;
  }
  return boundIntegerAttr(str, 1, maxPx);
}

/** Only user-activated web/mail links survive; remote resources and active content do not. */
export function sanitizeMailHtml(html, attachments = [], { allowDataImages = false } = {}) {
  const inline = new Map();
  let inlineBytes = 0;
  for (const attachment of attachments) {
    if (!attachment.contentId || !RASTER.has(attachment.contentType) || !Buffer.isBuffer(attachment.content)) continue;
    inlineBytes += attachment.content.length;
    if (inlineBytes > 16 * 1024 * 1024) continue;
    inline.set(attachment.contentId.replace(/^<|>$/gu, ''), `data:${attachment.contentType};base64,${attachment.content.toString('base64')}`);
  }

  const cleanCell = (tagName, attribs) => {
    const clean = {};
    for (const [k, v] of Object.entries(attribs)) {
      if (k === 'dir' || k === 'lang' || k === 'title') clean[k] = v;
      else if (k === 'align') {
        if (/^(?:left|center|right|justify)$/i.test(v)) clean.align = v.toLowerCase();
      } else if (k === 'valign') {
        if (/^(?:top|middle|bottom|baseline)$/i.test(v)) clean.valign = v.toLowerCase();
      } else if (k === 'colspan') {
        const b = boundIntegerAttr(v, 1, 100);
        if (b) clean.colspan = b;
      } else if (k === 'rowspan') {
        const b = boundIntegerAttr(v, 1, 100);
        if (b) clean.rowspan = b;
      } else if (k === 'width') {
        const b = boundDimensionAttr(v, 2000);
        if (b) clean.width = b;
      } else if (k === 'height') {
        const b = boundDimensionAttr(v, 3000);
        if (b) clean.height = b;
      }
    }
    if (attribs.style) {
      const s = sanitizeInlineStyle(attribs.style);
      if (s) clean.style = s;
    }
    return {tagName, attribs: clean};
  };

  const cleanGeneric = (tagName, attribs) => {
    const clean = {...attribs};
    if (attribs.style) {
      const s = sanitizeInlineStyle(attribs.style);
      if (s) clean.style = s;
      else delete clean.style;
    }
    return {tagName, attribs: clean};
  };

  const transformTags = {
    a: (tagName, attribs) => {
      const href = String(attribs.href ?? '').trim();
      if (!/^(?:https?:\/\/|mailto:)/iu.test(href) || /[\u0000-\u0020\u007f]/u.test(href)) return {tagName, attribs: {}};
      try { new URL(href); } catch { return {tagName, attribs: {}}; }
      const clean = {...attribs, href, target: '_blank', rel: 'noopener noreferrer'};
      if (attribs.style) {
        const s = sanitizeInlineStyle(attribs.style);
        if (s) clean.style = s;
        else delete clean.style;
      }
      return {tagName, attribs: clean};
    },
    img: (tagName, attribs) => {
      let isCid = false;
      let cid;
      const rawSrc = String(attribs.src ?? '').trim();
      if (/^cid:/iu.test(rawSrc)) {
        isCid = true;
        try { cid = decodeURIComponent(rawSrc.slice(4)).replace(/^<|>$/gu, ''); } catch { /* malformed CID */ }
      }
      let src = null;
      if (isCid && cid) {
        src = inline.get(cid) || null;
      } else if (allowDataImages && /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[a-zA-Z0-9+/=]+$/i.test(rawSrc)) {
        src = rawSrc;
      }

      const altText = attribs.alt && attribs.alt.trim() ? attribs.alt.trim() : (src ? 'Inline image' : (isCid ? 'Embedded image unavailable' : 'Remote image blocked'));
      const clean = {alt: altText};

      if (src) {
        clean.src = src;
      } else {
        clean['data-blocked-image'] = isCid ? 'missing' : 'true';
        clean.role = 'img';
        clean['aria-label'] = altText;
      }

      for (const key of ['width','height']) {
        const b = boundIntegerAttr(attribs[key], 1, 2000);
        if (b) clean[key] = b;
      }
      if (attribs.style) {
        const s = sanitizeInlineStyle(attribs.style);
        if (s) clean.style = s;
      }
      return {tagName, attribs: clean};
    },
    table: (tagName, attribs) => {
      const clean = {};
      for (const [k, v] of Object.entries(attribs)) {
        if (k === 'dir' || k === 'lang' || k === 'title') clean[k] = v;
        else if (k === 'align') {
          if (/^(?:left|center|right)$/i.test(v)) clean.align = v.toLowerCase();
        } else if (k === 'width') {
          const b = boundDimensionAttr(v, 2000);
          if (b) clean.width = b;
        } else if (k === 'height') {
          const b = boundDimensionAttr(v, 3000);
          if (b) clean.height = b;
        } else if (k === 'border') {
          const b = boundIntegerAttr(v, 0, 20);
          if (b) clean.border = b;
        } else if (k === 'cellpadding') {
          const b = boundIntegerAttr(v, 0, 50);
          if (b) clean.cellpadding = b;
        } else if (k === 'cellspacing') {
          const b = boundIntegerAttr(v, 0, 50);
          if (b) clean.cellspacing = b;
        }
      }
      if (attribs.style) {
        const s = sanitizeInlineStyle(attribs.style);
        if (s) clean.style = s;
      }
      return {tagName, attribs: clean};
    },
    td: cleanCell,
    th: cleanCell,
    tr: cleanGeneric,
    col: cleanGeneric,
    colgroup: cleanGeneric,
    p: cleanGeneric,
    div: cleanGeneric,
    span: cleanGeneric,
    b: cleanGeneric,
    strong: cleanGeneric,
    i: cleanGeneric,
    em: cleanGeneric,
    u: cleanGeneric,
    s: cleanGeneric,
    strike: cleanGeneric,
    blockquote: cleanGeneric,
    pre: cleanGeneric,
    code: cleanGeneric,
    hr: cleanGeneric,
    h1: cleanGeneric,
    h2: cleanGeneric,
    h3: cleanGeneric,
    h4: cleanGeneric,
    h5: cleanGeneric,
    h6: cleanGeneric,
    ul: cleanGeneric,
    ol: cleanGeneric,
    li: cleanGeneric,
    dl: cleanGeneric,
    dt: cleanGeneric,
    dd: cleanGeneric,
    caption: cleanGeneric,
    sup: cleanGeneric,
    sub: cleanGeneric
  };

  return sanitizeHtml(html, {
    allowedTags: ['p','br','div','span','b','strong','i','em','u','s','strike','blockquote','pre','code','hr','h1','h2','h3','h4','h5','h6','ul','ol','li','dl','dt','dd','table','thead','tbody','tfoot','tr','th','td','caption','col','colgroup','img','a','sup','sub'],
    allowedAttributes: {
      '*': ['dir','lang','style','title'],
      a: ['href','target','rel'],
      img: ['src','alt','width','height','data-blocked-image','role','aria-label'],
      table: ['width','height','border','cellpadding','cellspacing','align'],
      td: ['colspan','rowspan','width','height','align','valign'],
      th: ['colspan','rowspan','width','height','align','valign'],
      tr: ['align','valign'],
      col: ['span','width'],
      colgroup: ['span','width']
    },
    allowedStyles: {
      '*': {
        'color': [COLOR_REGEX],
        'background-color': [COLOR_REGEX],
        'background': [/^(?:none|transparent|#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^)]+\)|[a-zA-Z]+)$/i],
        'font-family': [/^(?!.*(?:url|expression|@import|javascript|position|behavior))[a-zA-Z0-9\s,"'._-]+$/i],
        'font-size': [/^(?:[1-6]?\d|7[0-2])(?:\.\d+)?(?:px|pt)|(?:[0-3](?:\.\d+)?|4(?:\.[0-5])?)(?:em|rem)|(?:[3-9]\d|[1-3]\d{2}|400)%$/i],
        'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
        'font-style': [/^(?:normal|italic|oblique)$/i],
        'line-height': [/^(?:normal|\d+(?:\.\d+)?(?:px|em|rem|%|pt)?)$/i],
        'text-decoration': [/^(?:none|underline|line-through|overline)(?:\s+(?:solid|dashed|dotted|double|wavy))?$/i],
        'text-align': [/^(?:left|right|center|justify)$/i],
        'vertical-align': [/^(?:baseline|sub|super|top|text-top|middle|bottom|text-bottom|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'margin': [/^(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt))(?:\s+(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt))){0,3}$/i],
        'margin-top': [/^(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'margin-right': [/^(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'margin-bottom': [/^(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'margin-left': [/^(?:auto|0|-?\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'padding': [/^(?:auto|0|\d+(?:\.\d+)?(?:px|em|rem|%|pt))(?:\s+(?:auto|0|\d+(?:\.\d+)?(?:px|em|rem|%|pt))){0,3}$/i],
        'padding-top': [/^(?:auto|0|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'padding-right': [/^(?:auto|0|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'padding-bottom': [/^(?:auto|0|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'padding-left': [/^(?:auto|0|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'border': [BORDER_VAL_REGEX],
        'border-top': [BORDER_VAL_REGEX],
        'border-right': [BORDER_VAL_REGEX],
        'border-bottom': [BORDER_VAL_REGEX],
        'border-left': [BORDER_VAL_REGEX],
        'border-color': [/^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^)]+\)|[a-zA-Z]+)(?:\s+(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^)]+\)|[a-zA-Z]+)){0,3}$/i],
        'border-style': [/^(?:none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)(?:\s+(?:none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)){0,3}$/i],
        'border-width': [/^(?:\d+(?:\.\d+)?(?:px|em|pt|thin|medium|thick))(?:\s+(?:\d+(?:\.\d+)?(?:px|em|pt|thin|medium|thick))){0,3}$/i],
        'border-radius': [/^\d+(?:\.\d+)?(?:px|em|rem|%)(?:\s+\d+(?:\.\d+)?(?:px|em|rem|%)){0,3}$/i],
        'border-collapse': [/^(?:collapse|separate)$/i],
        'border-spacing': [/^\d+(?:\.\d+)?(?:px|em|pt)(?:\s+\d+(?:\.\d+)?(?:px|em|pt))?$/i],
        'width': [/^(?:auto|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'max-width': [/^(?:none|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'min-width': [/^(?:auto|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'height': [/^(?:auto|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'max-height': [/^(?:none|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'min-height': [/^(?:auto|\d+(?:\.\d+)?(?:px|em|rem|%|pt))$/i],
        'table-layout': [/^(?:auto|fixed)$/i],
        'white-space': [/^(?:normal|nowrap|pre|pre-wrap|pre-line)$/i],
        'letter-spacing': [/^(?:normal|-?\d+(?:\.\d+)?(?:px|em|pt))$/i],
        'word-spacing': [/^(?:normal|-?\d+(?:\.\d+)?(?:px|em|pt))$/i]
      }
    },
    allowedSchemes: ['http','https','mailto'],
    allowedSchemesByTag: {img: ['data']},
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script','style','textarea','option','iframe','object','svg','math'],
    transformTags
  });
}

function addresses(value) {
  if (!value) return [];
  const list = Array.isArray(value)
    ? value.flatMap(item => Array.isArray(item?.value) ? item.value : (item && typeof item === 'object' && ('address' in item || 'name' in item) ? [item] : []))
    : (Array.isArray(value?.value) ? value.value : []);
  return list.slice(0, 200).map(item => ({
    name: String(item?.name ?? '').slice(0, 500),
    address: String(item?.address ?? '').slice(0, 500)
  }));
}
export function sourceHeaders(bytes) {
  const match = /\r?\n\r?\n/u.exec(bytes.toString('latin1', 0, Math.min(bytes.length, 1024 * 1024)));
  if (!match) fail('content_unavailable');
  return bytes.subarray(0, match.index);
}

async function parse(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MESSAGE_SOURCE_BYTES) fail('content_too_large');
  try { return await simpleParser(bytes, {skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: MAX_RENDERED_BODY_BYTES}); }
  catch { fail('content_unavailable'); }
}
function encryption(parsed) {
  const type = parsed.headers.get('content-type');
  if (type?.value === 'multipart/encrypted' && type.params?.protocol === 'application/pgp-encrypted') {
    const payload = parsed.attachments.find(item => item.contentType !== 'application/pgp-encrypted');
    return {type: 'openpgp', bytes: payload?.content};
  }
  const smime = parsed.attachments.find(item => ['application/pkcs7-mime', 'application/x-pkcs7-mime'].includes(item.contentType));
  if (smime && type?.params?.['smime-type'] !== 'signed-data') return {type: 'smime', bytes: smime.content};
  const inline = parsed.text?.match(/-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/u);
  if (inline) return {type: 'openpgp', bytes: Buffer.from(inline[0])};
  return null;
}
function render(parsed, headers, encrypted = null, decrypted = false) {
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  if (Buffer.byteLength(text) + Buffer.byteLength(html) > MAX_RENDERED_BODY_BYTES) fail('content_too_large');
  if (parsed.attachments.length > 100) fail('content_too_large');
  let attachmentsSize = 0;
  const attachments = parsed.attachments.map((item, index) => {
    attachmentsSize += item.content.length;
    if (item.content.length > MAX_ATTACHMENT_BYTES || attachmentsSize > MAX_ZIP_BYTES) fail('attachment_too_large');
    return {index, filename: safeFilename(item.filename, `attachment-${index + 1}`), mimeType: item.contentType,
      size: item.content.length, contentId: item.contentId ?? null,
      ...(decrypted ? {bytesBase64: item.content.toString('base64')} : {})};
  });
  return {text, html: html ? sanitizeMailHtml(html, parsed.attachments) : '', headers,
    from: addresses(parsed.from), to: addresses(parsed.to), cc: addresses(parsed.cc), bcc: addresses(parsed.bcc), replyTo: addresses(parsed.replyTo),
    subject: String(parsed.subject ?? ''), messageId: String(parsed.messageId ?? ''),
    attachments, inlineParts: [], encrypted: encrypted ? {type: encrypted.type, decrypted, signatureVerified: false} : null,
    complete: true, sanitized: true, rendererVersion: MAIL_RENDERER_VERSION};
}

export function renderCompleteContent(decoded) {
  if (!decoded || typeof decoded !== 'object') fail('content_unavailable');

  const rawText = typeof decoded.text === 'string' ? decoded.text : '';
  const rawHtml = typeof decoded.html === 'string' ? decoded.html : '';
  if (Buffer.byteLength(rawText) + Buffer.byteLength(rawHtml) > MAX_RENDERED_BODY_BYTES) {
    fail('content_too_large');
  }

  const rawAttachments = Array.isArray(decoded.attachments) ? decoded.attachments : [];
  const rawInlineParts = Array.isArray(decoded.inlineParts) ? decoded.inlineParts : [];
  if (rawAttachments.length > 100 || rawInlineParts.length > 100) {
    fail('content_too_large');
  }

  const attachments = [];
  const seenAttachmentIds = new Set();
  for (let index = 0; index < Math.min(rawAttachments.length, 100); index++) {
    const item = rawAttachments[index];
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!validAttachmentId(id) || seenAttachmentIds.has(id)) continue;
    seenAttachmentIds.add(id);
    const rawMime = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
    const mimeType = rawMime.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(rawMime)
      ? rawMime : 'application/octet-stream';
    const size = Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null;
    attachments.push({
      id,
      filename: safeFilename(item.filename, `attachment-${index + 1}`),
      mimeType,
      size
    });
  }

  const inlineParts = [];
  const seenInlineIds = new Set();
  for (let index = 0; index < Math.min(rawInlineParts.length, 100); index++) {
    const item = rawInlineParts[index];
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!validAttachmentId(id) || seenInlineIds.has(id)) continue;
    const contentId = String(item.contentId ?? '').replace(/^<|>$/gu, '').trim().slice(0, 200);
    if (!contentId || /[\u0000-\u001f\u007f]/u.test(contentId)) continue;
    seenInlineIds.add(id);
    const rawMime = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
    const mimeType = rawMime.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(rawMime)
      ? rawMime : 'application/octet-stream';
    const size = Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null;
    inlineParts.push({
      id,
      contentId,
      mimeType,
      size
    });
  }

  let encrypted = null;
  if (decoded.encrypted) {
    const encType = ['openpgp', 'smime'].includes(decoded.encrypted.type) ? decoded.encrypted.type : 'openpgp';
    const isDecrypted = Boolean(decoded.encrypted.decrypted);
    encrypted = {
      type: encType,
      decrypted: isDecrypted,
      signatureVerified: Boolean(decoded.encrypted.signatureVerified)
    };
  }

  const complete = decoded.complete === true;
  const headers = typeof decoded.headers === 'string' ? decoded.headers.slice(0, 32768) : '';
  const subject = String(decoded.subject ?? '').slice(0, 500);
  const messageId = String(decoded.messageId ?? '').slice(0, 500);

  if (encrypted && !encrypted.decrypted) {
    return {
      text: '',
      html: '',
      headers,
      from: addresses(decoded.from),
      to: addresses(decoded.to),
      cc: addresses(decoded.cc),
      bcc: addresses(decoded.bcc),
      replyTo: addresses(decoded.replyTo),
      subject,
      messageId,
      attachments,
      inlineParts,
      encrypted,
      complete,
      sanitized: true,
      rendererVersion: MAIL_RENDERER_VERSION
    };
  }

  let html = '';
  if (decoded.sanitized === true && decoded.rendererVersion === MAIL_RENDERER_VERSION) {
    html = rawHtml;
  } else if (rawHtml) {
    html = sanitizeMailHtml(rawHtml, []);
  }

  return {
    text: rawText,
    html,
    headers,
    from: addresses(decoded.from),
    to: addresses(decoded.to),
    cc: addresses(decoded.cc),
    bcc: addresses(decoded.bcc),
    replyTo: addresses(decoded.replyTo),
    subject,
    messageId,
    attachments,
    inlineParts,
    encrypted,
    complete,
    sanitized: true,
    rendererVersion: MAIL_RENDERER_VERSION
  };
}

/** Validate ZIP central-directory sizes BEFORE any decompressor allocates. */
export function officeArchiveEntries(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_OFFICE_BYTES || bytes.length < 22) fail('preview_unavailable');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50)) fail('preview_unavailable');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count > 1000 || count !== bytes.readUInt16LE(end + 8) || start + size !== end) fail('preview_unavailable');
  const entries = [], names = new Set();
  let offset = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail('preview_unavailable');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20), uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || (flags & 1) || ![0,8].includes(method) || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) fail('preview_unavailable');
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (!name || names.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || /[\u0000-\u001f]/u.test(name)) fail('preview_unavailable');
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (dataStart + compressed > start || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || bytes.toString('utf8', local + 30, local + 30 + bytes.readUInt16LE(local + 26)) !== name) fail('preview_unavailable');
    expanded += uncompressed;
    if (uncompressed > MAX_XML_BYTES || expanded > MAX_XML_BYTES || uncompressed > Math.max(1024 * 1024, compressed * 250)) fail('preview_unavailable');
    names.add(name); entries.push({name, size: uncompressed, compressed, dataStart, method}); offset = next;
  }
  if (offset !== end) fail('preview_unavailable');
  return entries;
}

const xmlParser = new XMLParser({ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true,
  processEntities: true, parseTagValue: false, trimValues: false, preserveOrder: true});
const sheetParser = new XMLParser({ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true,
  processEntities: true, parseTagValue: false, trimValues: false});
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
function runText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (Object.hasOwn(value, '#text')) return String(value['#text']);
  return array(value.t).map(runText).join('') + array(value.r).map(runText).join('');
}
function sheetXml(bytes) {
  const xml = bytes.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) fail('preview_unavailable');
  try { return sheetParser.parse(xml); } catch { fail('preview_unavailable'); }
}
function xmlText(xml) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) fail('preview_unavailable');
  let result = '';
  function visit(nodes, depth = 0) {
    if (depth > 100) fail('preview_unavailable');
    for (const node of nodes) {
      for (const [name, value] of Object.entries(node)) {
        if (name === '#text') result += String(value);
        else if (Array.isArray(value)) { visit(value, depth + 1); if (['p','row','si','c','tr','br','tab'].includes(name)) result += name === 'tab' || name === 'c' ? '\t' : '\n'; }
        if (result.length > MAX_PREVIEW_CHARS) return;
      }
      if (result.length > MAX_PREVIEW_CHARS) return;
    }
  }
  try { visit(xmlParser.parse(xml)); } catch { fail('preview_unavailable'); }
  return result;
}
export function previewOffice({bytes, filename, mimeType}) {
  const extension = String(filename ?? '').split('.').at(-1).toLowerCase();
  if (!['docx','xlsx','pptx'].includes(extension)) fail('preview_unavailable');
  const entries = officeArchiveEntries(bytes);
  const allowed = name => extension === 'docx' ? /^word\/(document|header\d+|footer\d+)\.xml$/u.test(name) :
    extension === 'xlsx' ? /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/u.test(name) : /^ppt\/slides\/slide\d+\.xml$/u.test(name);
  const files = Object.create(null);
  for (const entry of entries.filter(item => allowed(item.name))) {
    const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
    try { files[entry.name] = entry.method === 0 ? compressed : inflateRawSync(compressed, {maxOutputLength: Math.max(1, entry.size)}); }
    catch { fail('preview_unavailable'); }
    if (files[entry.name].length !== entry.size) fail('preview_unavailable');
  }
  let text = '';
  const shared = extension === 'xlsx' && files['xl/sharedStrings.xml'] ? array(sheetXml(files['xl/sharedStrings.xml']).sst?.si).map(runText) : [];
  for (const entry of entries.filter(item => allowed(item.name)).sort((a,b) => a.name.localeCompare(b.name, 'en', {numeric: true}))) {
    if (!files[entry.name] || files[entry.name].length !== entry.size) fail('preview_unavailable');
    if (extension === 'xlsx') {
      if (entry.name === 'xl/sharedStrings.xml') continue;
      text += `${entry.name}\n`;
      for (const row of array(sheetXml(files[entry.name]).worksheet?.sheetData?.row)) {
        text += array(row.c).map(cell => {
          const value = cell['@t'] === 's' ? shared[Number(cell.v)] ?? '' : cell['@t'] === 'inlineStr' ? runText(cell.is) : String(cell.v ?? (cell.f ? `=${cell.f}` : ''));
          return `${cell['@r'] ?? ''}: ${value}`;
        }).join('\t') + '\n';
        if (text.length > MAX_PREVIEW_CHARS) break;
      }
      text += '\n';
    } else text += `${entry.name}\n${xmlText(Buffer.from(files[entry.name]).toString('utf8'))}\n\n`;
    if (text.length > MAX_PREVIEW_CHARS) break;
  }
  if (!text) fail('preview_unavailable');
  return {filename: safeFilename(filename), mimeType, text: text.slice(0, MAX_PREVIEW_CHARS), truncated: text.length > MAX_PREVIEW_CHARS,
    note: 'Text-only preview. Download the original file for formatting, images and formulas.'};
}

export function zipAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length > 100) fail('invalid_request');
  const files = Object.create(null), used = new Set();
  let total = 0;
  for (const [index, attachment] of attachments.entries()) {
    if (!Buffer.isBuffer(attachment.bytes)) fail('attachment_unavailable');
    total += attachment.bytes.length;
    if (attachment.bytes.length > MAX_ATTACHMENT_BYTES || total > MAX_ZIP_BYTES) fail('attachment_too_large');
    const original = safeFilename(attachment.filename, `attachment-${index + 1}`);
    let name = original, suffix = 1;
    while (used.has(name.toLowerCase())) {
      const dot = original.lastIndexOf('.');
      name = dot > 0 ? `${original.slice(0, dot)} (${++suffix})${original.slice(dot)}` : `${original} (${++suffix})`;
    }
    used.add(name.toLowerCase()); files[name] = attachment.bytes;
  }
  return {bytes: Buffer.from(zipSync(files, {level: 0})), mimeType: 'application/zip', filename: 'attachments.zip'};
}

export function extractReferencedCids(html) {
  const referencedCids = new Set();
  if (typeof html !== 'string' || !html.toLowerCase().includes('cid:')) {
    return referencedCids;
  }
  sanitizeHtml(html, {
    allowedTags: ['img'],
    allowedAttributes: { img: ['src'] },
    transformTags: {
      img: (tagName, attribs) => {
        const rawSrc = String(attribs.src ?? '').trim();
        if (/^cid:/iu.test(rawSrc)) {
          try {
            const cid = decodeURIComponent(rawSrc.slice(4)).replace(/^<|>$/gu, '').trim();
            if (cid && cid.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(cid)) {
              referencedCids.add(cid);
            }
          } catch {}
        }
        return { tagName, attribs: {} };
      }
    }
  });
  return referencedCids;
}

export function createMailContent({reader, inlineReader = reader}) {
  async function raw(account, reference, {signal} = {}) {
    abort(signal);
    const bytes = await reader.source(account, reference, {signal, maxBytes: MAX_MESSAGE_SOURCE_BYTES});
    abort(signal);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MESSAGE_SOURCE_BYTES) fail('content_too_large');
    return bytes;
  }
  return {
    async read(account, reference, {signal, privateKey, passphrase, certificate, includeInlineImages = false} = {}) {
      if (typeof includeInlineImages !== 'boolean') fail('invalid_request');

      if (privateKey) {
        const bytes = await raw(account, reference, {signal});
        const parsed = await parse(bytes), encrypted = encryption(parsed);
        const headers = sourceHeaders(bytes).toString('utf8');
        abort(signal);
        if (!encrypted?.bytes) fail('encrypted_mail_unsupported');
        const decrypted = await decryptMail({...encrypted, privateKey, passphrase, certificate});
        abort(signal);
        const prefix = decrypted.subarray(0, 65536).toString('utf8');
        const headerEnd = prefix.search(/\r?\n\r?\n/u);
        const isMime = headerEnd >= 0 && /^(?:Content-Type|MIME-Version|Content-Transfer-Encoding):/imu.test(prefix.slice(0, headerEnd));
        const content = await parse(isMime ? decrypted : Buffer.concat([Buffer.from('Content-Type: text/plain; charset=utf-8\r\n\r\n'), decrypted]));
        abort(signal);
        for (const field of ['from','to','cc','bcc','replyTo','subject','messageId']) content[field] ||= parsed[field];
        return render(content, headers, encrypted, true);
      }

      if (!includeInlineImages) {
        if (typeof reader?.content !== 'function') fail('content_unavailable');
        abort(signal);
        const rawContent = await reader.content(account, reference, {
          signal,
          maxEncodedBytes: MAX_CONTENT_ENCODED_BYTES,
          maxDecodedBytes: MAX_CONTENT_DECODED_BYTES,
          includeAttachments: true
        });
        abort(signal);
        if (!rawContent || typeof rawContent !== 'object') fail('content_unavailable');
        return renderCompleteContent(rawContent);
      }

      // Explicit raster images path: bypasses cached sanitized HTML via inlineReader.content
      if (typeof inlineReader?.content !== 'function') fail('content_unavailable');
      abort(signal);
      const rawContent = await inlineReader.content(account, reference, {
        signal,
        maxEncodedBytes: MAX_CONTENT_ENCODED_BYTES,
        maxDecodedBytes: MAX_CONTENT_DECODED_BYTES,
        includeAttachments: true
      });
      abort(signal);
      if (!rawContent || typeof rawContent !== 'object') fail('content_unavailable');

      // Validate decoded body BEFORE any attachment download;
      // compute base = renderCompleteContent(rawContent) before candidate work and use its vetted descriptors.
      const base = renderCompleteContent(rawContent);
      if (base.encrypted && !base.encrypted.decrypted) {
        return base;
      }

      const referencedCids = extractReferencedCids(rawContent.html);

      const candidateParts = [];
      const seenIds = new Set();
      const seenCids = new Set();
      for (const part of base.inlineParts) {
        if (!part || typeof part !== 'object') continue;
        const id = part.id;
        if (!validAttachmentId(id) || seenIds.has(id)) continue;
        const cid = part.contentId;
        if (!cid || seenCids.has(cid)) continue;
        if (!referencedCids.has(cid)) continue;
        const mime = String(part.mimeType ?? '').toLowerCase();
        if (!RASTER.has(mime)) continue;
        seenIds.add(id);
        seenCids.add(cid);
        candidateParts.push({ ...part, id, contentId: cid, mimeType: mime });
        if (candidateParts.length >= MAX_INLINE_PARTS_COUNT) break;
      }

      const sanitizerAttachments = [];
      let consumedBytes = 0;
      let hasFailed = false;
      let loadedCount = 0;

      for (const part of candidateParts) {
        if (consumedBytes >= MAX_AGGREGATE_INLINE_BYTES) {
          hasFailed = true;
          break;
        }
        if (Number.isSafeInteger(part.size) && part.size > MAX_INLINE_IMAGE_BYTES) {
          hasFailed = true;
          continue;
        }
        const maxBytes = Math.min(MAX_INLINE_IMAGE_BYTES, MAX_AGGREGATE_INLINE_BYTES - consumedBytes);
        abort(signal);
        let res;
        try {
          res = await inlineReader.attachment(account, reference, part.id, { signal, maxBytes });
        } catch (cause) {
          abort(signal);
          if (cause) {
            if (cause.name === 'AbortError') throw cause;
            const code = cause.code ?? cause.message;
            if (code === 'stale_message' || code === 'stale' || code === 'cancelled' || code === 'mailbox_login_required') {
              throw cause;
            }
          }
          hasFailed = true;
          consumedBytes += maxBytes;
          continue;
        }
        abort(signal);

        const buf = res?.bytes ?? (Buffer.isBuffer(res) ? res : null);
        if (Buffer.isBuffer(buf) && buf.length <= maxBytes) {
          consumedBytes += buf.length;
        } else {
          consumedBytes += maxBytes;
        }

        const respMime = String(res?.mimeType ?? res?.contentType ?? '').toLowerCase();
        if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > maxBytes ||
            !RASTER.has(respMime) || respMime !== part.mimeType) {
          hasFailed = true;
          continue;
        }

        sanitizerAttachments.push({
          contentId: part.contentId,
          contentType: part.mimeType,
          content: buf
        });
        loadedCount++;
      }

      const sanitizedHtml = rawContent.html ? sanitizeMailHtml(rawContent.html, sanitizerAttachments) : '';
      base.html = sanitizedHtml;
      base.inlineImagesLoaded = true;
      const hasAnyUnloaded = hasFailed || candidateParts.length < referencedCids.size || loadedCount < candidateParts.length;
      base.inlineImagesStatus = hasAnyUnloaded ? (loadedCount > 0 ? 'partial' : 'unavailable') : 'complete';
      return base;
    },
    async source(account, reference, options) { return {bytes: await raw(account, reference, options), mimeType: 'message/rfc822', filename: 'message.eml'}; },
    async headers(account, reference, options) { return {bytes: sourceHeaders(await raw(account, reference, options)), mimeType: 'text/plain; charset=utf-8', filename: 'message-headers.txt'}; },
    async preview(account, reference, attachmentId, {signal} = {}) {
      if (!validAttachmentId(attachmentId)) fail('invalid_request');
      const attachment = await reader.attachment(account, reference, attachmentId, {signal});
      abort(signal); return previewOffice(attachment);
    },
    async zip(account, reference, attachments, {signal} = {}) {
      if (!Array.isArray(attachments) || attachments.length < 1 || attachments.length > 100 || attachments.some(item => !validAttachmentId(item.id))) fail('invalid_request');
      const downloaded = []; let total = 0;
      for (const attachment of attachments) {
        abort(signal);
        const item = await reader.attachment(account, reference, attachment.id, {signal});
        total += item.bytes.length;
        if (total > MAX_ZIP_BYTES) fail('attachment_too_large');
        downloaded.push(item);
      }
      abort(signal); return zipAttachments(downloaded);
    }
  };
}
