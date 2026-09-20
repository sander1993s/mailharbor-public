import { computeMailDisposition, CLASSIFICATION_CONFIDENCE, DATE_CONFIDENCE } from './mail-policy.mjs';

export const PROCESSING_VERSION = 2;
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY = 15 * 60000;
export const categoryOf = record => {
  if (record.ownerDecision?.action === 'keep') return 'held';
  if (record.disconnected) return 'failed';
  if ((record.readError && record.readRetryAt == null) || (record.classificationError && record.retryAt == null)) return 'failed';
  if (record.refreshRequested || ((!record.classification || record.classificationError) && record.retryAt != null) || record.readRetryAt != null) return 'retry';
  if (record.classificationError || (record.readError && record.readRetryAt == null)) return 'failed';
  if (record.blockers?.some(reason => ['classification_uncertain', 'unclassified', 'appointment_date_uncertain', 'invoice_review_required'].includes(reason))) return 'review';
  if (record.blockers?.some(reason => ['stale_message', 'target_unavailable', 'source_absent'].includes(reason))) return 'failed';
  if (record.blockers?.some(reason => ['read_flag_pending', 'move_retry'].includes(reason))) return 'retry';
  return record.blockers?.length ? 'held' : '';
};

export function processingReasons(record, { now, settings, invoiceState = null, manualLabels = [] }) {
  if (record.ownerDecision?.action === 'keep') return ['owner_keep'];
  const reasons = new Set();
  if (record.classificationError) reasons.add(record.classificationError);
  if (record.readError) reasons.add(record.readError === 'stale_message' ? 'stale_message' : 'body_read_failed');
  if (record.refreshRequested) reasons.add('content_recovery');
  if (!record.classification) return [...reasons];
  const active = record.locations.filter(location => !location.handled || ['changed', 'target_unavailable'].includes(location.handled));
  if (record.locations.some(location => location.handled === 'absent')) reasons.add('source_absent');
  if (!active.length) return [...reasons];
  if (active.every(location => location.role === 'trash')) return [...reasons];
  if (active.some(location => !location.read)) reasons.add('read_flag_pending');
  if (active.some(location => location.handled === 'changed')) reasons.add('stale_message');
  if (active.some(location => location.handled === 'target_unavailable')) reasons.add('target_unavailable');
  if (active.some(location => location.intent)) reasons.add('move_retry');
  if (!record.complete) reasons.add('incomplete_message');
  const classification = record.classification;
  if (classification.confidence < CLASSIFICATION_CONFIDENCE) reasons.add('classification_uncertain');
  if (invoiceState) reasons.add(invoiceState);
  const labels = [...new Set([...classification.labels, ...manualLabels])];
  for (const label of labels) {
    const key = { coupons: 'couponExpiry', appointments: 'appointmentEnd', tenders: 'tenderDeadline' }[label];
    if (key && !(label === 'tenders' && classification.dates?.[key] == null) &&
        (!classification.dates?.[key] || classification.dateConfidence < DATE_CONFIDENCE))
      reasons.add(label === 'appointments' ? 'appointment_date_uncertain' : 'date_uncertain');
  }
  for (const location of active) {
    const decision = computeMailDisposition({ classification, receivedAt: record.receivedAt, folderKind: location.role,
      complete: record.complete, invoiceProtected: Boolean(invoiceState), manualLabels, now,
      tenderGraceDays: settings.tenderGraceDays, tenderGraceMonths: settings.tenderGraceMonths });
    if (decision.action === 'hold' && !['already_archived', 'already_in_trash', 'retention_not_due', 'date_uncertain', 'invoice_review_required'].includes(decision.reason)) reasons.add(decision.reason);
  }
  return [...reasons].sort();
}

export function workMetadata(record, token) {
  const recovering = record.refreshRequested === true;
  const retryAt = record.readError ? record.readRetryAt : record.retryAt;
  const state = record.ownerDecision?.action === 'keep' ? 'done' : !record.classification || recovering ?
    ((record.classificationError || record.readError) && retryAt == null ? 'review' : 'pending') :
    record.review ? 'review' : record.nextAt != null ? 'ready' : 'done';
  return { state: record.disconnected ? 'disconnected' : state, due: !record.classification || recovering ? retryAt ?? (record.classificationError || record.readError ? null : record.nextAt) : record.nextAt,
    owner: token(`processing:${record.accountId}:${record.email}`), age: Date.parse(record.receivedAt) || record.discoveredAt || 0,
    analysis: record.classification ? 'classified' : record.disconnected ? 'disconnected' : record.ownerDecision?.action === 'keep' ? 'kept' : state === 'pending' ? (retryAt != null ? 'retrying' : 'pending') : 'failed',
    category: categoryOf(record), reasons: record.blockers ?? [] };
}
