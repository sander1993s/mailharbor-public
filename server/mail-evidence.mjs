export const EVIDENCE_VERSION = '1';

// These expressions only select excerpts. They are deliberately not a classifier
// or evidence that omitted text is safe to discard from a cleanup decision.
const SIGNALS = [
  { weight: 1000, pattern: /\b(?:invoices?|receipts?|factu(?:ur|ren|re|res)|reçu[es]?|betalingen?|betaling|payments?|paiements?|bankafschrift|overschrijving|virement|transaction|transactie)\b/giu },
  { weight: 950, pattern: /\b(?:orders?|orderbevestiging|bestelling(?:en)?|commande[s]?|confirmation de commande|purchase|aankoop|achat)\b/giu },
  { weight: 900, pattern: /\b(?:tenders?|aanbesteding(?:en)?|offertes?|devis|appel[s]? d['’]offres|soumission|bid closing|gunning)\b/giu },
  { weight: 850, pattern: /\b(?:appointments?|afspra(?:ak|ken)|rendez[- ]vous|consultation|vergadering|réunion|reservation|réservation|meeting)\b/giu },
  { weight: 600, pattern: /(?<![\p{L}\p{N}_])(?:deadlines?|due date|expires?|expiry|expiration|valid until|geldig tot|vervalt|vervaldatum|uiterlijk|einddatum|date limite|échéance|valable jusqu|expire|expiration)(?![\p{L}\p{N}_])/giu },
  { weight: 450, pattern: /(?:\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s+(?:jan(?:uary|uari|vier)?|feb(?:ruary|ruari|r[ui]er)?|février|ma(?:rch|art|i|y)|mars|apr(?:il)?|avril|jun[ei]?|juin|jul[yi]?|juillet|aug(?:ust|ustus)?|août|sep(?:tember|tembre)?|oct(?:ober|obre)?|oktober|nov(?:ember|embre)?|dec(?:ember)?|décembre)\b)/giu },
  { weight: 400, pattern: /(?:[€$£]\s?\d|\b\d[\d., ]*\s?(?:EUR|USD|GBP)\b|\b(?:coupons?|offers?|aanbieding(?:en)?|korting|promotion[s]?|offre[s]?)\b)/giu },
];
const GAP = '\n[…]\n';
const meaningful = value => /\S/u.test(value);
const highSurrogate = code => code >= 0xd800 && code <= 0xdbff;
const lowSurrogate = code => code >= 0xdc00 && code <= 0xdfff;
const safeEnd = (text, end) => end > 0 && highSurrogate(text.charCodeAt(end - 1)) && lowSurrogate(text.charCodeAt(end)) ? end - 1 : end;
const safeStart = (text, start) => start > 0 && lowSurrogate(text.charCodeAt(start)) && highSurrogate(text.charCodeAt(start - 1)) ? start - 1 : start;

function normalizeWhitespace(text) {
  return text.replace(/\r\n?/gu, '\n').replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function mergeRanges(text, ranges) {
  const merged = [];
  for (const range of [...ranges].filter(value => value.end > value.start).sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && (range.start <= previous.end || !meaningful(text.slice(previous.end, range.start)))) {
      previous.end = Math.max(previous.end, range.end);
    } else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

function renderRanges(text, ranges) {
  let cursor = 0;
  const chunks = [];
  for (const range of mergeRanges(text, ranges)) {
    if (meaningful(text.slice(cursor, range.start))) chunks.push(GAP);
    else if (cursor !== range.start) chunks.push(text.slice(cursor, range.start));
    chunks.push(text.slice(range.start, range.end));
    cursor = range.end;
  }
  if (meaningful(text.slice(cursor))) chunks.push(GAP);
  return chunks.join('').trim();
}

function contextWindow(text, start, end, size) {
  // Keep the match plus surrounding source words; never strip quoted replies.
  let left = Math.max(0, start - Math.floor((size - (end - start)) / 3));
  let right = Math.min(text.length, left + size);
  left = Math.max(0, right - size);
  const previousLine = text.lastIndexOf('\n', start);
  if (previousLine >= left) left = previousLine + 1;
  else if (left > 0 && !/\s/u.test(text[left - 1])) {
    const nextSpace = text.slice(left, start).search(/\s/u);
    if (nextSpace >= 0) left += nextSpace + 1;
  }
  const nextLine = text.indexOf('\n', end);
  if (nextLine >= 0 && nextLine < right) right = nextLine;
  else if (right < text.length && !/\s/u.test(text[right])) {
    const tail = text.slice(end, right).match(/\s\S*$/u);
    if (tail) right = end + tail.index;
  }
  return { start: safeStart(text, Math.min(left, start)), end: safeEnd(text, Math.max(end, right)) };
}

/**
 * Select bounded, verbatim evidence from an already validated mail body.
 * Character counts use JavaScript UTF-16 units, matching the classifier's caps.
 * Whitespace normalization is lossless for completeness; any other omission,
 * including duplicate paragraphs, makes the result incomplete.
 */
export function compactMailEvidence(message, { maxCharacters = 2000 } = {}) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0) throw new RangeError('maxCharacters must be a nonnegative integer');
  const sourceCharacters = message.body.length;
  const text = normalizeWhitespace(message.body);
  const finish = (body, omitted) => ({ body, complete: message.complete === true && !omitted,
    sourceCharacters, inputCharacters: body.length, omitted, version: EVIDENCE_VERSION });
  if (text.length <= maxCharacters) return finish(text, false);
  // Tiny caller-specified budgets still announce omission without breaking a
  // surrogate pair. The normal 2,000-character path retains useful context.
  if (maxCharacters < 24) {
    const marker = maxCharacters >= 3 ? '[…]' : maxCharacters > 0 ? '…' : '';
    return finish(text.slice(0, safeEnd(text, maxCharacters - marker.length)) + marker, true);
  }

  const opening = { start: 0, end: safeEnd(text, Math.min(360, Math.floor(maxCharacters / 4))) };
  const selected = [opening];
  const size = Math.min(360, Math.floor(maxCharacters * 0.6));
  const candidates = new Map();
  for (const signal of SIGNALS) {
    for (const match of text.matchAll(signal.pattern)) {
      const range = contextWindow(text, match.index, match.index + match[0].length, size);
      const key = `${range.start}:${range.end}`;
      const candidate = candidates.get(key) ?? { ...range, weights: new Set() };
      candidate.weights.add(signal.weight);
      candidates.set(key, candidate);
    }
  }
  const ranked = [...candidates.values()].map(candidate => ({ ...candidate,
    score: [...candidate.weights].reduce((sum, weight) => sum + weight, 0) }))
    .sort((a, b) => b.score - a.score || a.start - b.start || a.end - b.end);
  const seenPassages = new Set();
  for (const candidate of ranked) {
    if (mergeRanges(text, selected).some(range => range.start <= candidate.start && range.end >= candidate.end)) continue;
    const passage = text.slice(candidate.start, candidate.end);
    if (seenPassages.has(passage)) continue;
    if (renderRanges(text, [...selected, candidate]).length <= maxCharacters) {
      selected.push(candidate);
      seenPassages.add(passage);
    }
  }
  // Spend the remaining space on contiguous opening context. Measuring the
  // rendered body includes every gap marker and avoids truncating a marker or
  // accidentally presenting nonadjacent fragments as one original sentence.
  let low = opening.end, high = Math.min(text.length, maxCharacters);
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (renderRanges(text, [{ start: 0, end: safeEnd(text, end) }, ...selected.slice(1)]).length <= maxCharacters) low = end;
    else high = end - 1;
  }
  selected[0] = { start: 0, end: safeEnd(text, low) };
  return finish(renderRanges(text, selected), true);
}
