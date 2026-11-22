export const LABEL_FILTERS_STORAGE_KEY = 'mailharbor_label_filters';

const BUILTIN_LABELS = new Set([
  'coupons', 'development', 'social', 'jobs', 'security', 'travel', 'work',
  'newsletters', 'finance', 'invoices', 'tenders', 'appointments', 'orders'
]);
const MAX_LABELS = 128; // Includes the 100 custom labels allowed by the server.
const MAX_STORED_LENGTH = 16384;
const validId = id => BUILTIN_LABELS.has(id) || /^custom_[a-f0-9]{32}$/u.test(id);

/** Copy only label preferences; optionally discard labels removed from server metadata. */
export function normalizeLabelFilters(filters, availableIds) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return {};
  const available = availableIds === undefined ? null : new Set(availableIds);
  const normalize = values => Array.isArray(values)
    ? [...new Set(values.slice(0, MAX_LABELS).filter(value => typeof value === 'string')
      .map(value => value.trim()).filter(id => validId(id) && (!available || available.has(id))))].sort()
    : [];
  const excludeLabels = normalize(filters.excludeLabels);
  const excluded = new Set(excludeLabels);
  const includeLabels = normalize(filters.includeLabels).filter(id => !excluded.has(id));
  return {
    ...(includeLabels.length ? {includeLabels} : {}),
    ...(excludeLabels.length ? {excludeLabels} : {})
  };
}

export function loadLabelFilters(storage) {
  try {
    const saved = (storage === undefined ? globalThis.localStorage : storage)?.getItem(LABEL_FILTERS_STORAGE_KEY);
    if (typeof saved !== 'string' || saved.length > MAX_STORED_LENGTH) return {};
    return normalizeLabelFilters(JSON.parse(saved));
  } catch {
    return {};
  }
}

export function saveLabelFilters(filters, storage) {
  const labels = normalizeLabelFilters(filters);
  try {
    (storage === undefined ? globalThis.localStorage : storage)?.setItem(LABEL_FILTERS_STORAGE_KEY, JSON.stringify(labels));
  } catch {} // Restricted storage must not prevent applying filters.
  return labels;
}
