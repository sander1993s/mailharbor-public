const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
const dateText = value => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) : '';
};
const POLICIES = [
  {id: 'coupons', label: 'Promotions & Coupons', action: 'trash', retention: 'When the offer has expired; unknown expiry dates keep the message safely'},
  {id: 'development', label: 'Development / GitHub', action: 'trash', retention: 'After 1 month'},
  {id: 'social', label: 'Social', action: 'trash', retention: 'After 1 week'},
  {id: 'jobs', label: 'Jobs', action: 'trash', retention: 'After 1 month'},
  {id: 'security', label: 'Security / Account Alerts', action: 'archive', retention: 'After 1 month'},
  {id: 'travel', label: 'Travel & Events', action: 'archive', retention: 'After 2 years'},
  {id: 'work', label: 'Work & Administration', action: 'archive', retention: 'After 1 year'},
  {id: 'newsletters', label: 'Newsletters', action: 'trash', retention: 'After 1 month'},
  {id: 'finance', label: 'Finance', action: 'archive', retention: 'After 2 years'},
  {id: 'invoices', label: 'Invoices & Receipts', action: 'archive', retention: 'After 7 years'},
  {id: 'tenders', label: 'Tenders', action: 'archive', retention: 'After the deadline; delay needs to be set. After 6 months if the deadline is unknown'},
  {id: 'appointments', label: 'Appointments', action: 'archive', retention: 'After the appointment has ended'},
  {id: 'orders', label: 'Orders', action: 'archive', retention: 'After 7 years'},
  {id: 'sent', label: 'Sent mail', action: 'archive', retention: 'After 7 years'},
  {id: 'drafts', label: 'Drafts', action: 'trash', retention: 'After 2 months'}
];
const ACTIONS = {archive: 'Archive', trash: 'Move to Trash', delete: 'Move to Trash', keep: 'Keep'};
const PHASES = {
  discovering: 'Finding messages across your mailboxes', scanning: 'Finding messages across your mailboxes',
  classifying: 'Analyzing and labeling messages', analyzing: 'Analyzing and labeling messages',
  applying: 'Applying your mail rules', retention: 'Checking scheduled archive and deletion dates',
  marking_read: 'Marking messages as read', waiting: 'Waiting for the next check', idle: 'Waiting for the next check',
  preview: 'Preparing a preview of due actions', quota: 'Waiting for Gemini capacity', backoff: 'Waiting before retrying'
};
const REASONS = {
  quota: 'Gemini capacity is temporarily unavailable. Processing will resume from saved progress.',
  quota_exceeded: 'Gemini capacity is temporarily unavailable. Processing will resume from saved progress.',
  quota_exhausted: 'Gemini capacity is temporarily unavailable. Processing will resume from saved progress.',
  backoff: 'A service needs a break. Processing will retry from saved progress.',
  timeout: 'Gemini took too long to respond. Saved progress is retained for another attempt.',
  mailbox_error: 'A mailbox request failed. Saved progress is retained for another attempt.',
  mailbox_timeout: 'A mailbox took too long to respond. Saved progress is retained for another attempt.',
  provider_consent_required: 'Message analysis needs your Gemini permission before it can start.',
  tender_rule_required: 'The delay after a tender deadline still needs to be set. Tenders with a deadline stay in place while other mail follows its rules.',
  mailbox_login_required: 'Reconnect the affected mailbox in Accounts. Saved progress is retained.',
  processing_error: 'Processing could not finish this pass. Saved progress is retained.',
  invalid_model_output: 'Gemini replies could not be validated. Successful analysis is saved. Retry processing after checking the failure details.',
  response_schema: 'Gemini replies did not match the required response format.',
  provider_cooldown: 'Gemini response failures triggered a recovery cooldown.',
  configuration_error: 'Processing needs a configuration repair before it can resume.',
  persistence_error: 'Progress could not be saved. Processing is blocked until storage is repaired.',
  storage_error: 'Progress could not be saved. Processing is blocked until storage is repaired.',
  pilot_complete: 'The bounded processing pilot is complete. Review the saved results before resuming.',
  overdue_work: 'Pending work has stopped making progress. Refresh status and check service health.'
};
const WORKER_STATES = {running: 'Processing', paused: 'Paused', retrying: 'Waiting to retry', blocked: 'Action needed', idle: 'Waiting', stalled: 'Progress overdue'};
const REVIEW_CATEGORIES = [['review', 'Your decisions'], ['held', 'Automatic holds'], ['failed', 'Technical failures'], ['retry', 'Scheduled retries']];
const REVIEW_REASONS = {
  incomplete_message: 'The available message text is incomplete.', classification_uncertain: 'The category needs confirmation.',
  date_uncertain: 'A reliable date is missing.', coupon_expiry_unknown: 'The offer has no reliable expiry date; the message is kept.',
  promotion_expiry_unknown: 'The offer has no reliable expiry date; the message is kept.', unknown_message_date: 'The received date cannot be verified.',
  invoice_review_required: 'Invoice filing still protects this message.', invoice_filing_pending: 'Invoice filing is still in progress.',
  tender_grace_unconfirmed: 'The delay after a tender deadline must be set.', retention_not_due: 'The retention period has not ended.',
  classification_failed: 'Message analysis failed.', classification_retry: 'Message analysis will be retried.', invalid_model_output: 'The AI response could not be validated.',
  unclassified: 'No category could be confirmed.', junk_review_required: 'The message remains in Junk.',
  owner_keep: 'You chose to keep this message.', owner_kept: 'You chose to keep this message.',
  encoded_byte_limit: 'The encoded message exceeds the safe read limit.', decoded_text_limit: 'The text exceeds the analysis limit.',
  unavailable_part: 'The message text could not be found.', body_unavailable: 'The message text is unavailable.',
  transient_fetch_failure: 'A temporary error prevented reading the text.', encrypted_content: 'The message text is encrypted.',
  unsupported_content: 'This message format cannot be analyzed.',
  body_read_failed: 'The message text could not be read.', content_recovery: 'A more complete message read is queued.',
  source_absent: 'The original message was not found. Its location needs reconciliation.', read_flag_pending: 'The read flag is waiting to be applied.',
  stale_message: 'The message identity changed; the saved reference must be checked.', target_unavailable: 'The required destination folder is unavailable.',
  move_retry: 'An interrupted move must be reconciled before retrying.', invoice_waiting: 'Invoice filing is still in progress.',
  appointment_date_uncertain: 'The appointment end date needs confirmation.'
};
const reasonText = reason => REVIEW_REASONS[typeof reason === 'string' ? reason : reason?.code] || REASONS[typeof reason === 'string' ? reason : reason?.code] || String(typeof reason === 'string' ? reason : reason?.code || 'Unresolved processing hold').replaceAll('_', ' ');
const DATE_FIELDS = [['couponExpiry', 'Offer expiry'], ['tenderDeadline', 'Tender deadline'], ['appointmentStart', 'Appointment start'], ['appointmentEnd', 'Appointment end']];

export function createProcessingView({root, api, describeError, notify}) {
  if (!root || typeof api !== 'function') throw new TypeError('Mail processing requires a root element and API.');
  const state = {session: 0, revision: 0, active: false, visible: false, destroyed: false, status: null, busy: '', request: null, timer: null,
    reviewOpen: false, reviewCategory: 'review', reviewRevision: 0, reviewBusy: false, reviewItems: [], nextAfter: null};
  const nodes = {};
  const addButton = (parent, title, callback, className = 'subtle') => {
    const button = make('button', title, className); button.type = 'button';
    button.addEventListener('click', callback); parent.append(button); return button;
  };
  const errorText = error => REASONS[error?.code] || describeError?.(error) || 'Could not update mail processing. Please try again.';
  function feedback(text = '', error = false) {
    nodes.feedback.textContent = text; nodes.feedback.hidden = !text;
    nodes.feedback.className = `feedback ${error ? 'error' : 'success'}`;
  }
  function build() {
    root.replaceChildren(); root.classList.add('mail-processing');
    const heading = make('div', undefined, 'processing-heading');
    heading.append(make('h2', 'Mail organization'));
    nodes.state = make('span', 'Loading…', 'processing-state'); nodes.state.setAttribute('role', 'status'); heading.append(nodes.state);
    root.append(heading, make('p', 'Analyze mail across your accounts, apply shared labels and keep each category for the time you chose.'));
    nodes.disclosure = make('p', undefined, 'fineprint'); root.append(nodes.disclosure);
    nodes.setup = make('p', undefined, 'feedback error'); nodes.setup.setAttribute('role', 'status'); nodes.setup.hidden = true; root.append(nodes.setup);
    const actions = make('div', undefined, 'account-actions processing-actions');
    nodes.start = addButton(actions, 'Start processing', () => action('start'), 'primary');
    nodes.pause = addButton(actions, 'Pause processing', () => action('pause'));
    nodes.previewButton = addButton(actions, 'Preview due actions', () => action('preview'));
    nodes.refresh = addButton(actions, 'Refresh status', () => refresh()); root.append(actions);
    nodes.feedback = make('p', undefined, 'feedback'); nodes.feedback.setAttribute('role', 'status'); nodes.feedback.hidden = true; root.append(nodes.feedback);
    nodes.progress = make('p', 'Loading processing status…', 'processing-progress');
    nodes.progress.setAttribute('role', 'status'); nodes.progress.setAttribute('aria-live', 'polite'); root.append(nodes.progress);
    nodes.retry = make('p', undefined, 'fineprint'); root.append(nodes.retry);
    nodes.counts = make('dl', undefined, 'processing-counts'); root.append(nodes.counts);
    nodes.lastRun = make('p', undefined, 'fineprint'); root.append(nodes.lastRun);
    nodes.coverage = make('p', undefined, 'fineprint'); root.append(nodes.coverage);
    nodes.reasonCounts = make('dl', undefined, 'processing-reasons'); root.append(nodes.reasonCounts);
    nodes.diagnostics = make('details', undefined, 'processing-diagnostics');
    nodes.diagnostics.append(make('summary', 'Recent processing errors'));
    nodes.errorList = make('ul'); nodes.diagnostics.append(nodes.errorList); nodes.diagnostics.hidden = true; root.append(nodes.diagnostics);
    const review = make('section', undefined, 'processing-review');
    review.append(make('h3', 'Messages waiting for a decision or recovery'), make('p', 'Technical failures and automatic holds are separated from decisions that need you. Keeping a message saves your choice.', 'fineprint'));
    nodes.openReview = addButton(review, 'Open review queue', () => loadReview());
    nodes.reviewContent = make('div'); nodes.reviewContent.hidden = true; review.append(nodes.reviewContent);
    const filters = make('div', undefined, 'processing-review-filters'); filters.setAttribute('aria-label', 'Message status'); nodes.reviewFilters = [];
    for (const [category, title] of REVIEW_CATEGORIES) {
      const button = addButton(filters, title, () => loadReview(category)); button.setAttribute('aria-pressed', 'false'); nodes.reviewFilters.push({category, button});
    }
    nodes.reviewContent.append(filters);
    nodes.reviewFeedback = make('p', undefined, 'fineprint'); nodes.reviewFeedback.setAttribute('role', 'status'); nodes.reviewContent.append(nodes.reviewFeedback);
    nodes.reviewList = make('div', undefined, 'processing-review-list'); nodes.reviewContent.append(nodes.reviewList);
    nodes.reviewMore = addButton(nodes.reviewContent, 'Load more messages', () => loadReview(state.reviewCategory, true)); nodes.reviewMore.hidden = true;
    root.append(review);
    nodes.preview = make('section', undefined, 'processing-preview'); nodes.preview.hidden = true; root.append(nodes.preview);
    const policies = make('details', undefined, 'processing-policies');
    policies.append(make('summary', 'Labels and retention rules'));
    policies.append(make('p', 'When labels overlap, longer retention protects the message. Messages whose dates or category need review stay in place.', 'fineprint'));
    nodes.policies = make('dl', undefined, 'processing-policy-list'); policies.append(nodes.policies);
    policies.append(make('p', 'All mail is marked as read. Gemini reviews Junk, and messages confidently identified as legitimate return to Inbox. Other Junk stays in its folder.', 'fineprint'));
    policies.append(make('p', 'Appointment messages with a clear date include an Add to calendar action when you open them.', 'fineprint'));
    policies.append(make('p', 'On Gmail, Archive removes the Inbox label. Sent mail stays available in Sent and All Mail; Gmail keeps its Sent label.', 'fineprint'));
    policies.append(make('p', 'Removing a label hides it from that label folder. Automatic retention still uses the saved analysis. Pause processing to stop automatic actions.', 'fineprint'));
    root.append(policies, make('p', 'Deleted mail moves to Trash. Your email provider may empty Trash automatically. Previously analyzed messages use their saved labels and dates for future checks.', 'fineprint'));
  }
  function renderControls() {
    const data = state.status, busy = Boolean(state.busy), blocked = data?.providerConsent === false;
    nodes.start.disabled = !data || busy || blocked || data.enabled === true;
    nodes.start.textContent = state.busy === 'start' ? 'Starting…' : data?.counts?.analyzed > 0 ? 'Resume processing' : 'Start processing';
    nodes.start.hidden = data?.enabled === true;
    nodes.pause.disabled = !data || busy || !(data.enabled || data.running); nodes.pause.hidden = !data?.enabled && !data?.running;
    nodes.pause.textContent = state.busy === 'pause' ? 'Pausing…' : 'Pause processing';
    nodes.previewButton.disabled = !data || busy || blocked || data.running === true;
    nodes.previewButton.textContent = state.busy === 'preview' ? 'Preparing preview…' : 'Preview due actions';
    nodes.refresh.disabled = busy || Boolean(state.request);
    nodes.openReview.disabled = !data || state.reviewBusy;
    for (const {category, button} of nodes.reviewFilters) { button.disabled = state.reviewBusy; button.setAttribute('aria-pressed', String(category === state.reviewCategory)); }
    nodes.reviewMore.disabled = state.reviewBusy;
    root.setAttribute('aria-busy', String(busy));
  }
  function render() {
    const data = state.status, blocked = data?.providerConsent === false;
    nodes.state.textContent = !data ? 'Unavailable' : blocked ? 'Setup needed' : WORKER_STATES[data.workerState] || (data.enabled ? data.running ? 'Processing' : 'Enabled' : data.running ? 'Pausing' : 'Paused');
    nodes.state.className = `processing-state${data?.enabled && !blocked ? ' enabled' : ''}`;
    nodes.disclosure.textContent = data?.providerConsent ? 'Gemini receives a bounded text excerpt for classification and Junk review. Attachments stay on your homeserver. Processing continues when this page is closed.' : 'Mail analysis uses Gemini with your permission. Attachments stay on your homeserver.';
    const missing = [data?.providerConsent === false ? REASONS.provider_consent_required : '', data?.tenderConfigured === false ? REASONS.tender_rule_required : ''].filter(Boolean);
    nodes.setup.textContent = missing.join(' '); nodes.setup.hidden = !missing.length;
    nodes.progress.textContent = !data ? 'Processing status is unavailable. Refresh to try again.' : blocked ? 'Processing is waiting for setup.' : data.running ? `${PHASES[data.phase] || 'Processing your mail'}…` : data.enabled ? PHASES[data.phase] || 'Automatic processing is enabled.' : 'Processing is paused. Saved progress is ready to resume.';
    if (!blocked && data?.workerState === 'blocked') nodes.progress.textContent = 'Processing is blocked. Resolve the reported problem, then resume from saved progress.';
    if (!blocked && data?.workerState === 'stalled') nodes.progress.textContent = REASONS.overdue_work;
    if (!blocked && data?.workerState === 'retrying') nodes.progress.textContent = 'Processing is waiting for a scheduled recovery attempt. Saved progress is retained.';
    const retry = data?.enabled && !['paused', 'blocked', 'stalled'].includes(data?.workerState) ? dateText(data?.retryAt) : '';
    const failureReason = data?.stateReason || data?.pauseReason;
    nodes.retry.textContent = [failureReason ? REASONS[failureReason] || reasonText(failureReason) : '', retry ? `Next attempt: ${retry}.` : '', data?.lastProgressAt ? `Last progress: ${dateText(data.lastProgressAt)}.` : ''].filter(Boolean).join(' '); nodes.retry.hidden = !nodes.retry.textContent;
    nodes.counts.replaceChildren();
    for (const [key, label] of [['discovered', 'Discovered'], ['analyzed', 'Analyzed'], ['pending', 'Awaiting analysis (including retries)'], ['retrying', 'Waiting to retry'], ['technicalFailures', 'Technical failures'], ['automaticHolds', 'Automatic holds'], ['needsReview', 'Your decisions'], ['markedRead', 'Marked read (actions)'], ['moved', 'Moved (actions)'], ['errors', 'Errors (total)']]) {
      const item = make('div'); item.append(make('dt', label), make('dd', count(data?.counts?.[key]))); nodes.counts.append(item);
    }
    const lastRun = data?.lastRun, finished = dateText(lastRun?.finishedAt), started = dateText(lastRun?.startedAt);
    nodes.lastRun.textContent = lastRun ? `Last run: ${lastRun.status === 'completed' ? 'completed' : lastRun.status === 'partial' ? 'partially completed' : lastRun.status === 'failed' ? 'interrupted' : lastRun.status === 'cancelled' || lastRun.status === 'paused' ? 'paused' : 'in progress'}${finished || started ? ` · ${finished || started}` : ''}.${lastRun.status === 'partial' ? ' Some mail could not be checked. Saved progress will be used on the next pass.' : ''}` : 'Your first scan will find mail in every connected mailbox.';
    if (Number.isSafeInteger(lastRun?.errorCount) && lastRun.errorCount >= 0) nodes.lastRun.textContent += ` Errors in this run: ${count(lastRun.errorCount)}.`;
    const coverage = Array.isArray(data?.accounts) ? data.accounts : [];
    nodes.coverage.textContent = ['Analysis counts describe unique messages. Holds and decisions may concern already analyzed mail; provider action totals are separate.', ...coverage.map(account => `${account.label || account.account || account.id}: ${account.discoveryComplete === true ? 'discovery complete' : 'discovery incomplete'}${account.reason ? ` (${reasonText(account.reason)})` : ''}.`)].join(' ');
    nodes.reasonCounts.replaceChildren();
    for (const [reason, total] of Object.entries(data?.reasonCounts || {})) {
      if (!Number.isSafeInteger(total) || total < 1) continue;
      const item = make('div'); item.append(make('dt', reasonText(reason)), make('dd', count(total))); nodes.reasonCounts.append(item);
    }
    nodes.errorList.replaceChildren();
    const errors = Array.isArray(data?.recentErrors) ? data.recentErrors.slice(-10).reverse() : [];
    nodes.diagnostics.hidden = !errors.length;
    for (const error of errors) {
      const details = [dateText(error.at), error.accountId, reasonText(error.code), error.phase ? `During ${String(error.phase).replaceAll('_', ' ')}` : '',
        error.diagnostic?.stage, error.diagnostic?.reason].filter(value => typeof value === 'string' && value);
      nodes.errorList.append(make('li', details.join(' · ')));
    }
    nodes.preview.replaceChildren(); nodes.preview.hidden = !data?.preview;
    if (data?.preview) {
      nodes.preview.append(make('h3', data.running && data.mode === 'preview' ? 'Preparing due actions preview…' : 'Due actions preview'), make('p', 'Preview uses saved analysis and may analyze a small sample with Gemini. It estimates due actions without changing your mail.', 'fineprint'));
      const list = make('dl', undefined, 'processing-counts');
      for (const [key, label] of [['archive', 'Archive'], ['trash', 'Move to Trash'], ['markRead', 'Mark read'], ['rescue', 'Return to Inbox'], ['review', 'Need review']]) {
        const item = make('div'); item.append(make('dt', label), make('dd', count(data.preview.counts?.[key]))); list.append(item);
      }
      nodes.preview.append(list);
      const asOf = dateText(data.preview.createdAt); if (asOf) nodes.preview.append(make('p', `Preview prepared ${asOf}.`, 'fineprint'));
    }
    nodes.policies.replaceChildren();
    for (const fallback of POLICIES) {
      const override = Array.isArray(data?.policies) ? data.policies.find(policy => policy?.id === fallback.id) : null;
      const policy = {...fallback, ...override}, item = make('div', undefined, 'processing-policy');
      item.append(make('dt', typeof policy.label === 'string' ? policy.label : fallback.label));
      const detail = make('dd'); detail.append(make('span', ACTIONS[policy.action] || ACTIONS[fallback.action], `processing-policy-action ${fallback.action}`), make('span', typeof policy.retention === 'string' ? policy.retention : fallback.retention));
      item.append(detail); nodes.policies.append(item);
    }
    renderControls();
  }
  function renderReview() {
    nodes.reviewContent.hidden = !state.reviewOpen; nodes.openReview.textContent = state.reviewOpen ? 'Refresh review queue' : 'Open review queue';
    nodes.reviewList.replaceChildren(); nodes.reviewMore.hidden = !state.nextAfter;
    if (!state.reviewItems.length && state.reviewOpen && !state.reviewBusy) nodes.reviewList.append(make('p', 'No messages in this group.', 'fineprint'));
    for (const item of state.reviewItems) {
      const card = make('article', undefined, 'processing-review-card');
      card.append(make('h4', item.subject || '(No subject)'), make('p', [item.account, item.author, dateText(item.date)].filter(Boolean).join(' · '), 'fineprint'));
      const reasons = make('ul', undefined, 'processing-review-reasons');
      for (const reason of [...new Set([...(Array.isArray(item.reasons) ? item.reasons : []), ...(Array.isArray(item.contentReasons) ? item.contentReasons : [])])]) reasons.append(make('li', reasonText(reason)));
      card.append(reasons);
      if (item.category === 'retry' || state.reviewCategory === 'retry') card.append(make('p', state.status?.enabled ? item.nextAttempt ? `Eligible for retry: ${dateText(item.nextAttempt)}.` : 'Waiting for an automatic retry.' : 'Queued for retry when processing resumes.', 'fineprint'));
      if (Array.isArray(item.labels) && item.labels.length) card.append(make('p', `Categories: ${item.labels.map(id => POLICIES.find(policy => policy.id === id)?.label || id).join(', ')}`, 'fineprint'));
      const actions = make('div', undefined, 'account-actions');
      const preview = make('div', undefined, 'processing-message-preview'); preview.hidden = true;
      addButton(actions, 'Read message', () => readReview(item, preview));
      if (item.category === 'failed' || item.category === 'retry' || state.reviewCategory === 'failed' || state.reviewCategory === 'retry' || item.complete === false) addButton(actions, 'Retry analysis', () => resolveReview(item, 'retry'));
      addButton(actions, 'Keep this message', () => resolveReview(item, 'keep'));
      card.append(actions, preview); nodes.reviewList.append(card);
    }
    renderControls();
  }
  async function loadReview(category = state.reviewCategory, more = false) {
    if (state.destroyed || state.reviewBusy || !state.status) return;
    const session = state.session, revision = ++state.reviewRevision;
    const valid = () => session === state.session && revision === state.reviewRevision && !state.destroyed;
    const after = more ? state.nextAfter : null;
    state.reviewCategory = category; state.reviewOpen = true; state.reviewBusy = true;
    if (!more) { state.reviewItems = []; state.nextAfter = null; }
    nodes.reviewFeedback.textContent = 'Loading messages…'; renderReview();
    try {
      const result = await api(`/api/mail/processing/review?category=${encodeURIComponent(category)}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      if (!valid()) return;
      if (!Array.isArray(result?.items)) throw new Error('Invalid review response');
      const known = new Set(state.reviewItems.map(item => item.id));
      state.reviewItems.push(...result.items.filter(item => item && typeof item.id === 'string' && !known.has(item.id)));
      state.nextAfter = typeof result.nextAfter === 'string' ? result.nextAfter : null;
      nodes.reviewFeedback.textContent = `${count(state.reviewItems.length)} messages shown.${state.nextAfter ? ' More are available.' : ''}`;
    } catch (error) { if (valid()) nodes.reviewFeedback.textContent = errorText(error); }
    finally { if (valid()) { state.reviewBusy = false; renderReview(); } }
  }
  async function readReview(item, target) {
    if (state.destroyed || state.reviewBusy) return;
    const session = state.session, revision = state.reviewRevision;
    const valid = () => session === state.session && revision === state.reviewRevision && !state.destroyed;
    state.reviewBusy = true; renderControls(); target.hidden = false; target.replaceChildren(make('p', 'Reading message…'));
    try {
      const result = await api(`/api/mail/processing/review/message?id=${encodeURIComponent(item.id)}`);
      if (!valid()) return;
      const message = result?.message || result;
      target.replaceChildren(make('pre', typeof message?.body === 'string' ? message.body : '', 'processing-message-body'));
      if (typeof message?.body !== 'string' || message?.bodyUnavailable !== false || message?.truncated !== false || item.complete !== true) target.append(make('p', 'This message cannot yet be confirmed because the analysis did not have complete text. Retry analysis or keep the message.', 'fineprint'));
      else buildConfirmation(item, target);
    } catch (error) { if (valid()) target.replaceChildren(make('p', errorText(error), 'feedback error')); }
    finally { if (valid()) { state.reviewBusy = false; renderControls(); } }
  }
  function buildConfirmation(item, target) {
    const form = make('form', undefined, 'processing-confirmation');
    form.append(make('p', 'Confirm or add categories and reliable dates. Existing protective categories are retained. Confirming allows the saved retention rules to be evaluated when processing runs.', 'fineprint'));
    const categories = make('fieldset'); categories.append(make('legend', 'Confirmed categories'));
    const labels = [];
    for (const policy of POLICIES.filter(policy => !['sent', 'drafts'].includes(policy.id))) {
      const label = make('label'), input = make('input'); input.type = 'checkbox'; input.value = policy.id; input.checked = item.labels?.includes(policy.id) === true;
      label.append(input, make('span', policy.label)); categories.append(label); labels.push(input);
    }
    form.append(categories); const dateInputs = [];
    for (const [key, title] of DATE_FIELDS) {
      const label = make('label', undefined, 'processing-date-field'), input = make('input'); input.type = 'text'; input.value = item.dates?.[key] || ''; input.maxLength = 35;
      input.placeholder = 'YYYY-MM-DD or date and time with UTC offset'; input.setAttribute('aria-label', title);
      label.append(make('span', title), input); form.append(label); dateInputs.push([key, input]);
    }
    form.append(make('p', 'Leave unknown dates blank. For exact times include an offset, such as 2026-09-17T14:00:00+02:00.', 'fineprint'));
    const submit = make('button', 'Confirm categories and dates', 'primary'); submit.type = 'submit'; form.append(submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const selected = labels.filter(input => input.checked).map(input => input.value);
      if (!selected.length) { nodes.reviewFeedback.textContent = 'Choose at least one category or keep the message.'; return; }
      return resolveReview(item, 'confirm', {labels: selected, dates: Object.fromEntries(dateInputs.map(([key, input]) => [key, input.value.trim() || null]))});
    });
    target.append(form);
  }
  async function resolveReview(item, action, extra = {}) {
    if (state.destroyed || state.reviewBusy) return;
    const session = state.session, revision = ++state.reviewRevision;
    const valid = () => session === state.session && revision === state.reviewRevision && !state.destroyed;
    state.reviewBusy = true; nodes.reviewFeedback.textContent = 'Saving…'; renderControls();
    try {
      await api('/api/mail/processing/review', {method: 'POST', body: {id: item.id, action, ...extra}});
      if (!valid()) return;
      state.reviewItems = state.reviewItems.filter(value => value.id !== item.id);
      nodes.reviewFeedback.textContent = action === 'keep' ? 'Your choice to keep this message is saved.' : action === 'retry' ? 'Analysis is queued. It will run when processing is enabled.' : 'Your confirmation is saved. Mailbox actions still require the usual safety checks.';
      await refresh();
    } catch (error) { if (valid()) nodes.reviewFeedback.textContent = errorText(error); }
    finally { if (valid()) { state.reviewBusy = false; renderReview(); } }
  }
  function schedule() {
    clearTimeout(state.timer); state.timer = null;
    if (!state.active || !state.visible || state.destroyed || document.hidden) return;
    state.timer = setTimeout(() => { state.timer = null; void refresh(); }, state.status?.running ? 4000 : 20000);
  }
  function statusFrom(value) {
    const data = value?.status && typeof value.status === 'object' ? value.status : value;
    return data && typeof data === 'object' && typeof data.enabled === 'boolean' ? data : null;
  }
  async function refresh() {
    if (state.destroyed) return;
    state.active = true;
    const session = state.session, revision = state.revision;
    if (state.request) {
      if (state.request.session === session && state.request.revision === revision) return state.request.promise;
      await state.request.promise;
      if (session !== state.session || state.destroyed) return;
      return refresh();
    }
    const request = {session, revision, promise: null}; state.request = request; renderControls();
    request.promise = (async () => {
      try {
        const value = await api('/api/mail/processing/status');
        if (session !== state.session || revision !== state.revision || state.destroyed) return;
        const data = statusFrom(value); if (!data) throw new Error('Processing status is unavailable.');
        state.status = data; render();
      } catch (error) {
        if (session === state.session && revision === state.revision && !state.destroyed) { feedback(errorText(error), true); render(); }
      }
    })().finally(() => {
      if (state.request === request) { state.request = null; renderControls(); schedule(); }
    });
    return request.promise;
  }
  async function action(kind) {
    if (state.busy || state.destroyed) return;
    const session = state.session, revision = ++state.revision;
    const valid = () => session === state.session && revision === state.revision && !state.destroyed;
    state.busy = kind; feedback(); renderControls();
    try {
      const value = await api('/api/mail/processing', {method: 'POST', body: {action: kind}});
      if (!valid()) return;
      const data = statusFrom(value); if (data) state.status = data;
      const text = kind === 'start' ? 'Processing started. You can keep using MailHarbor while it runs.' : kind === 'pause' ? 'Pause requested. Current work will finish safely and progress will be saved.' : 'Preview started. Your mail stays in place while due actions are estimated.';
      feedback(text); render(); if (kind !== 'preview') notify?.(text, 'success');
      await refresh();
    } catch (error) { if (valid()) feedback(errorText(error), true); }
    finally { if (valid()) { state.busy = ''; renderControls(); schedule(); } }
  }
  function reset() {
    state.session++; state.revision++; state.active = false; state.visible = false; state.status = null; state.busy = ''; state.request = null;
    state.reviewRevision++; state.reviewOpen = false; state.reviewBusy = false; state.reviewItems = []; state.nextAfter = null; state.reviewCategory = 'review';
    nodes.reviewFeedback.textContent = ''; clearTimeout(state.timer); state.timer = null; feedback(); render(); renderReview();
  }
  const onVisibility = () => {
    if (!state.active || state.destroyed) return;
    if (!document.hidden && state.visible) void refresh(); else schedule();
  };
  build(); render(); document.addEventListener('visibilitychange', onVisibility);
  return {
    show() { if (state.destroyed) return; state.active = true; state.visible = true; void refresh(); },
    hide() { state.visible = false; schedule(); },
    refresh, reset,
    destroy() { reset(); state.destroyed = true; document.removeEventListener('visibilitychange', onVisibility); }
  };
}
