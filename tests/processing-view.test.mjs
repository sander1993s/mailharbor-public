import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createProcessingView} from '../web/processing.mjs';

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = new Map(); this.attributes = new Map(); this.className = ''; this.classList = {add: name => { this.className += ` ${name}`; }}; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ''; this.children = nodes; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, callback) { this.events.set(name, callback); }
  dispatch(name) { return this.events.get(name)?.({preventDefault() {}}); }
}
function dom(t) {
  const previous = ['document', 'setTimeout', 'clearTimeout'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const root = new Element(), timers = new Map(); let timerId = 0;
  const document = {hidden: false, events: new Map(), createElement: tag => new Element(tag), addEventListener(name, callback) { this.events.set(name, callback); }, removeEventListener(name) { this.events.delete(name); }};
  const replacements = {document, setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id)};
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, {configurable: true, value});
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const all = () => { const walk = node => [node, ...node.children.flatMap(walk)]; return walk(root); };
  return {root, timers, document, all, button: title => all().find(node => node.tagName === 'button' && node.textContent === title)};
}
const status = changes => ({enabled: false, running: false, providerConsent: true, tenderConfigured: true, phase: 'idle', counts: {discovered: 12000, analyzed: 11000, markedRead: 10990, moved: 320, errors: 2, needsReview: 10}, lastRun: {status: 'completed', finishedAt: '2026-09-13T12:00:00Z'}, ...changes});

test('processing explains all category rules, safe deletion and delayed provider retries', async t => {
  const ui = dom(t);
  const view = createProcessingView({root: ui.root, api: async () => status({enabled: true, running: false, phase: 'quota', pauseReason: 'quota', retryAt: '2026-09-13T16:00:00Z', policies: [{id: 'tenders', label: 'Tenders', action: 'archive', retention: '2 months after the deadline; 6 months if unknown'}]})});
  view.show(); await nextTurn();
  for (const title of ['Promotions & Coupons', 'Development / GitHub', 'Social', 'Jobs', 'Security / Account Alerts', 'Travel & Events', 'Work & Administration', 'Newsletters', 'Finance', 'Invoices & Receipts', 'Tenders', 'Appointments', 'Orders', 'Sent mail', 'Drafts']) assert.ok(ui.root.textContent.includes(title), title);
  assert.match(ui.root.textContent, /2 months after the deadline/);
  assert.match(ui.root.textContent, /Gemini capacity is temporarily unavailable/);
  assert.match(ui.root.textContent, /Deleted mail moves to Trash/);
  assert.match(ui.root.textContent, /provider may empty Trash automatically/);
  assert.match(ui.root.textContent, /11,000|11\.000|11 000/);
  assert.equal(ui.button('Pause processing').hidden, false);
  assert.equal(ui.timers.size, 1);
  view.hide(); assert.equal(ui.timers.size, 0);
  view.destroy(); assert.equal(ui.document.events.size, 0);
});

test('start, pause and preview send only their defined actions and render a harmless preview', async t => {
  const ui = dom(t), calls = [], notices = []; let data = status();
  const view = createProcessingView({root: ui.root, notify: text => notices.push(text), api: async (path, options) => {
    calls.push({path, options});
    if (path === '/api/mail/processing/status') return data;
    assert.equal(path, '/api/mail/processing'); assert.equal(options.method, 'POST');
    if (options.body.action === 'start') data = status({enabled: true, running: true, phase: 'analyzing'});
    if (options.body.action === 'pause') data = status();
    if (options.body.action === 'preview') data = status({preview: {counts: {archive: 20, trash: 5, markRead: 0, rescue: 3, review: 2}, createdAt: '2026-09-13T12:00:00Z'}});
    return {status: data};
  }});
  await view.refresh();
  await ui.button('Resume processing').dispatch('click');
  assert.match(ui.root.textContent, /Analyzing and labeling messages/);
  assert.equal(ui.button('Preview due actions').disabled, true);
  await ui.button('Pause processing').dispatch('click');
  await ui.button('Preview due actions').dispatch('click');
  assert.deepEqual(calls.filter(call => call.options).map(call => call.options.body), [{action: 'start'}, {action: 'pause'}, {action: 'preview'}]);
  assert.equal(notices.length, 2);
  assert.match(ui.root.textContent, /may analyze a small sample with Gemini/);
  assert.match(ui.root.textContent, /without changing your mail/);
  const preview = ui.all().find(node => node.className === 'processing-preview');
  assert.equal(preview.hidden, false);
  view.destroy();
});

test('a late status read cannot overwrite pause and logout discards private pending responses', async t => {
  const ui = dom(t); let finishRead, finishAction, delayedRead = false;
  const view = createProcessingView({root: ui.root, api: async (path, options) => {
    if (options) return new Promise(resolve => { finishAction = resolve; });
    if (delayedRead) return new Promise(resolve => { finishRead = resolve; });
    return status({enabled: true, running: true});
  }});
  await view.refresh(); delayedRead = true;
  const staleRead = view.refresh(); await nextTurn();
  const pause = ui.button('Pause processing').dispatch('click'); await nextTurn();
  finishAction(status({enabled: false, counts: {...status().counts, analyzed: 12345}})); await nextTurn();
  assert.match(ui.root.textContent, /Processing is paused/);
  finishRead(status({enabled: true, running: true})); await staleRead; await nextTurn();
  assert.match(ui.root.textContent, /Processing is paused/);
  view.reset();
  finishRead(status({policies: [{id: 'coupons', label: 'PRIVATE_SUBJECT', retention: 'PRIVATE_DATE'}]})); await pause;
  assert.doesNotMatch(ui.root.textContent, /PRIVATE_|12,345|12\.345/);
  assert.equal(ui.timers.size, 0);
  view.destroy();
});

test('missing setup disables start and API failures leave saved counts visible', async t => {
  const ui = dom(t); let fail = false;
  const view = createProcessingView({root: ui.root, api: async () => {
    if (fail) throw Object.assign(new Error('private technical details'), {code: 'mailbox_login_required'});
    return status({providerConsent: false, tenderConfigured: false});
  }});
  await view.refresh();
  assert.equal(ui.button('Resume processing').disabled, true);
  assert.match(ui.root.textContent, /needs your Gemini permission/);
  assert.match(ui.root.textContent, /delay after a tender deadline still needs/);
  fail = true; await view.refresh();
  assert.match(ui.root.textContent, /Reconnect the affected mailbox/);
  assert.doesNotMatch(ui.root.textContent, /private technical details/);
  assert.match(ui.root.textContent, /11,000|11\.000|11 000/);
  view.destroy();
});

test('policy strings render as text and invalid counts never imply successful work', async t => {
  const ui = dom(t);
  const view = createProcessingView({root: ui.root, api: async () => status({counts: {analyzed: -1, discovered: Infinity}, policies: [{id: 'coupons', label: '<img src=x onerror=alert(1)>', retention: '<script>private</script>'}]})});
  await view.refresh();
  assert.match(ui.root.textContent, /<script>private<\/script>/);
  assert.equal(ui.all().some(node => node.tagName === 'img' || node.tagName === 'script'), false);
  assert.ok(ui.all().filter(node => node.tagName === 'dd' && node.textContent === '—').length >= 6);
  view.destroy();
});

test('an unset tender delay holds tenders while allowing other mail to start with Gemini consent', async t => {
  const ui = dom(t);
  const view = createProcessingView({root: ui.root, api: async () => status({tenderConfigured: false})});
  await view.refresh();
  assert.equal(ui.button('Resume processing').disabled, false);
  assert.equal(ui.button('Preview due actions').disabled, false);
  assert.match(ui.root.textContent, /Tenders with a deadline stay in place while other mail follows its rules/);
  assert.match(ui.root.textContent, /Gmail keeps its Sent label/);
  assert.match(ui.root.textContent, /Automatic retention still uses the saved analysis/);
  view.destroy();
});

test('a stopped failure snapshot never promises a retry and separates decisions from failures', async t => {
  const ui = dom(t);
  const view = createProcessingView({root: ui.root, api: async () => status({workerState: 'blocked', pauseReason: 'invalid_model_output',
    retryAt: '2026-09-13T21:15:00Z', lastProgressAt: '2026-09-13T21:00:00Z', counts: {...status().counts, pending: 82314, technicalFailures: 41, automaticHolds: 127, needsReview: 24, retrying: 0},
    reasonCounts: {classification_uncertain: 19, incomplete_message: 85}, recentErrors: [{at: '2026-09-13T21:00:00Z', code: 'invalid_model_output', phase: 'analyzing',
      diagnostic: {stage: 'response_schema', reason: 'response_date_invalid', raw: 'PRIVATE_PROVIDER_REPLY'}}]})});
  await view.refresh();
  assert.match(ui.root.textContent, /Processing is blocked/);
  assert.match(ui.root.textContent, /Gemini replies could not be validated/);
  assert.doesNotMatch(ui.root.textContent, /Next attempt:/);
  assert.match(ui.root.textContent, /response_date_invalid/); assert.doesNotMatch(ui.root.textContent, /PRIVATE_PROVIDER_REPLY/);
  for (const title of ['Awaiting analysis (including retries)', 'Technical failures', 'Automatic holds', 'Your decisions', 'Last progress:', 'The category needs confirmation.']) assert.ok(ui.root.textContent.includes(title));
  view.destroy();
});

test('scheduled recovery is visible and overdue work cannot appear healthy', async t => {
  const ui = dom(t); let data = status({enabled: true, workerState: 'retrying', retryAt: '2026-09-18T21:15:00Z', pauseReason: 'provider_cooldown'});
  const view = createProcessingView({root: ui.root, api: async () => data});
  await view.refresh();
  assert.match(ui.root.textContent, /scheduled recovery attempt/); assert.match(ui.root.textContent, /Next attempt:/);
  data = {...data, workerState: 'stalled'}; await view.refresh();
  assert.match(ui.root.textContent, /Pending work has stopped making progress/); assert.doesNotMatch(ui.root.textContent, /Next attempt:/);
  view.destroy();
});

test('review pagination stays bounded by the server cursor and retry is an explicit owner action', async t => {
  const ui = dom(t), calls = [], first = {id: 'hash-1', account: 'Personal', author: 'Sender', subject: '<script>EMAIL</script>', category: 'failed', reasons: ['invalid_model_output'], complete: false};
  const view = createProcessingView({root: ui.root, api: async (path, options) => {
    calls.push({path, options});
    if (path === '/api/mail/processing/status') return status();
    if (options) return {saved: true};
    if (path.endsWith('after=hash-1')) return {items: [{...first, id: 'hash-2', subject: 'Second'}], nextAfter: null};
    return {items: [first], nextAfter: 'hash-1'};
  }});
  await view.refresh(); assert.equal(calls.length, 1);
  await ui.button('Open review queue').dispatch('click');
  await ui.button('Technical failures').dispatch('click');
  assert.match(ui.root.textContent, /<script>EMAIL<\/script>/); assert.equal(ui.all().some(node => node.tagName === 'script'), false);
  await ui.button('Load more messages').dispatch('click');
  assert.ok(calls.some(call => call.path === '/api/mail/processing/review?category=failed&after=hash-1'));
  await ui.button('Retry analysis').dispatch('click');
  assert.deepEqual(calls.find(call => call.options)?.options, {method: 'POST', body: {id: 'hash-1', action: 'retry'}});
  assert.match(ui.root.textContent, /Analysis is queued/); assert.doesNotMatch(ui.root.textContent, /EMAIL/); assert.match(ui.root.textContent, /Second/);
  view.destroy();
});

test('confirming categories requires a complete live text preview and keeps user values as data', async t => {
  const ui = dom(t), posts = [], item = {id: 'hash-safe', category: 'review', subject: 'Appointment', account: 'Personal', complete: true, reasons: ['date_uncertain'], labels: ['appointments'], dates: {appointmentStart: '2026-09-18', appointmentEnd: null}};
  const view = createProcessingView({root: ui.root, api: async (path, options) => {
    if (path === '/api/mail/processing/status') return status();
    if (options) { posts.push(options.body); return {saved: true}; }
    if (path.includes('/message?')) return {body: '<img src=x>Message text', truncated: false, bodyUnavailable: false};
    return {items: [item], nextAfter: null};
  }});
  await view.refresh(); await ui.button('Open review queue').dispatch('click');
  assert.equal(ui.button('Confirm categories and dates'), undefined);
  await ui.button('Read message').dispatch('click');
  assert.match(ui.root.textContent, /<img src=x>Message text/); assert.equal(ui.all().some(node => node.tagName === 'img'), false);
  const end = ui.all().find(node => node.attributes.get('aria-label') === 'Appointment end'); end.value = '2026-09-19';
  const form = ui.all().find(node => node.tagName === 'form'); await form.dispatch('submit');
  assert.deepEqual(posts, [{id: 'hash-safe', action: 'confirm', labels: ['appointments'], dates: {couponExpiry: null, tenderDeadline: null, appointmentStart: '2026-09-18', appointmentEnd: '2026-09-19'}}]);
  view.destroy();
});

test('incomplete previews cannot confirm and logout clears or discards pending review text', async t => {
  const ui = dom(t); let finishRead, delay = false;
  const view = createProcessingView({root: ui.root, api: async path => {
    if (path === '/api/mail/processing/status') return status();
    if (path.includes('/message?')) return delay ? new Promise(resolve => { finishRead = resolve; }) : {body: 'INCOMPLETE_PRIVATE_TEXT', truncated: true, bodyUnavailable: false};
    return {items: [{id: 'hash', subject: 'PRIVATE_SUBJECT', reasons: ['incomplete_message'], complete: true}], nextAfter: null};
  }});
  await view.refresh(); await ui.button('Open review queue').dispatch('click'); await ui.button('Read message').dispatch('click');
  assert.equal(ui.button('Confirm categories and dates'), undefined); assert.match(ui.root.textContent, /cannot yet be confirmed/);
  delay = true; const reading = ui.button('Read message').dispatch('click'); await nextTurn(); view.reset();
  finishRead({body: 'PRIVATE_LATE_BODY', truncated: false, bodyUnavailable: false}); await reading;
  assert.doesNotMatch(ui.root.textContent, /PRIVATE_/); assert.equal(ui.button('Confirm categories and dates'), undefined);
  view.destroy();
});
