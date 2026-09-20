import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createMailTools,buildMailFilters,selectionAccount} from '../web/mail-tools.mjs';

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = new Map(); this.events = new Map();
    this.value = ''; this.className = ''; this.isConnected = true; this.dataset = {};
    const self = this;
    this.classList = {
      add: (...tokens) => {
        const classes = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        for (const token of tokens) classes.add(token);
        self.className = [...classes].join(' ');
      },
      remove: (...tokens) => {
        const classes = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        for (const token of tokens) classes.delete(token);
        self.className = [...classes].join(' ');
      },
      toggle: (token, force) => {
        const classes = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        const shouldAdd = force !== undefined ? Boolean(force) : !classes.has(token);
        if (shouldAdd) classes.add(token); else classes.delete(token);
        self.className = [...classes].join(' ');
        return shouldAdd;
      },
      contains: token => {
        const classes = new Set(self.className ? self.className.split(/\s+/).filter(Boolean) : []);
        return classes.has(token);
      },
      get className() { return self.className; }
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) {
        const idx = node.parentNode.children.indexOf(node);
        if (idx !== -1) node.parentNode.children.splice(idx, 1);
      }
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) { this.text = ''; this.children = []; this.append(...nodes); }
  setAttribute(name,value) {
    this.attributes.set(name,String(value));
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  addEventListener(name,callback) { this.events.set(name,callback); }
  removeEventListener(name,callback) { if (this.events.get(name) === callback) this.events.delete(name); }
  closest(selector) {
    let curr = this;
    while (curr) {
      if (curr.tagName && curr.tagName.toLowerCase() === selector.toLowerCase()) return curr;
      curr = curr.parentNode;
    }
    return null;
  }
  dispatch(name,event = {}) {
    const evt = {preventDefault(){}, stopPropagation(){}, target: this, currentTarget: this, ...event};
    const res = this.events.get(name)?.(evt);
    if (name === 'click' && this.tagName.toLowerCase() === 'button') {
      const form = this.closest ? this.closest('form') : null;
      if (form && (!this.type || this.type === 'submit' || this.attributes.get('type') === 'submit')) {
        form.dispatch('submit');
      }
    }
    return res ?? evt;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [child,...child.querySelectorAll('*')]).filter(child => {
      if (selector === '*') return true;
      if (selector.startsWith('.')) return child.className === selector.slice(1) || child.classList.contains(selector.slice(1));
      if (selector.startsWith('#')) return child.id === selector.slice(1);
      if (selector.startsWith('[') && selector.endsWith(']')) {
        const inner = selector.slice(1, -1);
        const eqIdx = inner.indexOf('=');
        if (eqIdx === -1) {
          if (inner.startsWith('data-')) {
            const key = inner.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
            return child.attributes.has(inner) || (key in child.dataset);
          }
          if (inner === 'type') return child.attributes.has('type') || Boolean(child.type);
          return child.attributes.has(inner) || (inner in child.dataset);
        }
        const attr = inner.slice(0, eqIdx);
        let val = inner.slice(eqIdx + 1).replace(/^["']|["']$/g, '');
        let actual = child.attributes.get(attr);
        if (attr === 'type' && actual === undefined) actual = child.type;
        else if (attr.startsWith('data-') && actual === undefined) {
          const key = attr.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
          if (key in child.dataset) actual = String(child.dataset[key]);
        }
        return actual === val;
      }
      return child.tagName.toLowerCase() === selector.toLowerCase();
    });
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  scrollIntoView() {}
  focus() { document.activeElement = this; }
}
function setup(t,overrides = {}) {
  const before = Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:tag => new Element(tag)}});
  t.after(() => before ? Object.defineProperty(globalThis,'document',before) : delete globalThis.document);
  const state = {accounts:[{id:'a',label:'Account A',connected:true},{id:'b',label:'Account B',connected:true}],folders:[{id:'folder:a',label:'A folder',type:'provider',accountIds:['a']},{id:'folder:b',label:'B folder',type:'provider',accountIds:['b']},{id:'tag:custom_one',label:'Custom',type:'tag'}],accountId:'a',folder:'inbox',messages:[{id:'1',accountId:'a'}],selection:new Set(),filters:{},sort:'date_desc',bodySearch:false,threaded:false};
  const host = new Element('div'), selectionHost = new Element('div'), settingsHost = new Element('div'), advancedButton = new Element('button'), calls = [], notices = []; let refreshes = 0;
  document.body = new Element('body');
  const mounts = {settingsHost,advancedButton,selectionHost};
  const tools = createMailTools({state,api:async(path,options) => { calls.push({path,...options}); return {applied:options?.body?.ids ?? [],failed:[],undoTokens:['undo']}; },refresh:async () => { refreshes++; },renderList:() => tools.render(host),setNotice:(...args) => notices.push(args),...overrides});
  t.after(() => tools.reset()); tools.render(host,mounts);
  const nodes = () => [...host.querySelectorAll('*'),...settingsHost.querySelectorAll('*'),...selectionHost.querySelectorAll('*')];
  const button = text => nodes().find(node => node.tagName === 'button' && node.textContent === text);
  const field = label => nodes().find(node => node.tagName === 'label' && node.text === label)?.children[0];
  const selectLoaded = () => nodes().find(node => node.attributes.get('aria-label') === 'Select loaded messages');
  return {state,host,selectionHost,settingsHost,advancedButton,mounts,selectLoaded,calls,notices,tools,nodes,button,field,refreshes:() => refreshes};
}

test('mail-tools initializes without a DOM and start makes no immediate API request', () => {
  let calls = 0;
  const tools = createMailTools({api:() => { calls++; },state:{}}); tools.start(); tools.stop(); tools.reset(); assert.equal(calls,0);
});

test('advanced search retains false conditions and validates numerical/date ranges', () => {
  assert.deepEqual(buildMailFilters({from:' a@example.test ',unread:'false',starred:'true',hasAttachment:'false',minSize:'0',maxSize:'100'}),{from:'a@example.test',unread:false,starred:true,hasAttachment:false,minSize:0,maxSize:100});
  assert.throws(() => buildMailFilters({minSize:'101',maxSize:'100'}),/Minimum/u);
  assert.throws(() => buildMailFilters({maxSize:'4294967296'}),/Size/u);
  assert.throws(() => buildMailFilters({since:'2026-09-20',before:'2026-09-10'}),/before/u);
  assert.equal(selectionAccount([{id:'1',accountId:'a'},{id:'2',accountId:'b'}],new Set(['1','2'])),'');
});

test('select-loaded caps at fifty and rerenders preserve unfinished advanced search text and DOM focus', t => {
  const view = setup(t); view.state.messages = Array.from({length:75},(_,index) => ({id:String(index),accountId:'a'}));
  const from = view.field('From'); from.value = 'unsaved@example.test'; from.dispatch('input');
  view.selectLoaded().checked = true; view.selectLoaded().dispatch('change');
  assert.equal(view.state.selection.size,50); assert.equal(view.field('From'),from); assert.equal(view.field('From').value,'unsaved@example.test');
  view.selectLoaded().checked = false; view.selectLoaded().dispatch('change'); assert.equal(view.state.selection.size,0);
});

test('permanent deletion requires in-page confirmation and sends only confirmed selected message IDs', async t => {
  const view = setup(t); view.state.folder = 'trash'; view.state.selection.add('1'); view.tools.render(view.host);
  const action = view.field('Selected action'); action.value = 'delete_permanent'; action.dispatch('change');
  view.button('Apply to selected').dispatch('click'); assert.equal(view.calls.length,0);
  assert.match(view.host.textContent,/cannot be undone/u); view.button('Confirm').dispatch('click'); await nextTurn();
  assert.deepEqual(view.calls[0].body,{ids:['1'],action:'delete_permanent',confirm:true}); assert.equal(view.refreshes(),1);
});

test('undo retries server tokens and provider move choices are isolated to the selected account', async t => {
  const view = setup(t); view.state.selection.add('1'); view.tools.render(view.host);
  const destination = view.field('Move destination'); assert.deepEqual(destination.children.map(node => node.value),['','folder:a']);
  view.tools.setUndo(['token-a','token-b']); view.button('Undo last moves').dispatch('click'); await nextTurn();
  assert.deepEqual(view.calls.map(call => call.body),[{token:'token-a'},{token:'token-b'}]); assert.equal(view.refreshes(),1);
});

test('navigating away cancels pending destructive confirmation', t => {
  const view = setup(t); view.state.folder = 'trash'; view.tools.render(view.host);
  view.button('Empty Trash…').dispatch('click'); assert.ok(view.button('Confirm'));
  view.state.folder = 'inbox'; view.tools.render(view.host); assert.equal(view.button('Confirm'),undefined); assert.equal(view.calls.length,0);
});

test('reader confirmation is visible locally and detached confirmation controls cannot approve a newer selection', async t => {
  const view = setup(t), reader = new Element('div'); view.state.folder = 'trash'; view.tools.render(view.host);
  view.tools.renderReader(reader,view.state.messages[0]);
  reader.querySelectorAll('*').find(node => node.tagName === 'button' && node.attributes.get('aria-label') === 'Delete permanently').dispatch('click');
  const obsolete = reader.querySelectorAll('*').find(node => node.tagName === 'button' && node.textContent === 'Confirm');
  assert.ok(obsolete,'The reader has its own visible confirmation.');
  view.tools.clearReader(); assert.equal(reader.children.length,0); assert.equal(view.button('Confirm'),undefined);
  view.state.messages.push({id:'2',accountId:'a'}); view.state.selection = new Set(['2']); view.tools.render(view.host);
  const action = view.field('Selected action'); action.value = 'delete_permanent'; action.dispatch('change'); view.button('Apply to selected').dispatch('click');
  obsolete.dispatch('click'); assert.equal(view.calls.length,0,'A detached confirm cannot approve the latest selection.');
  view.button('Confirm').dispatch('click'); await nextTurn(); assert.deepEqual(view.calls[0].body.ids,['2']);
});

test('label sync status loads only when folder management opens and preserves form controls', async t => {
  const requests = [];
  const view = setup(t, {api: async (path, options) => {
    requests.push({path,...options});
    return {running:false,backfillComplete:true,synced:12,pending:3,failed:2,protected:1,skipped:0};
  }});
  assert.equal(requests.length, 0);
  const manager = () => view.nodes().find(node => node.tagName === 'details' && node.children[0]?.textContent === 'Manage folders & labels');
  const name = view.field('Name'); name.value = 'Unfinished label'; name.dispatch('input');
  manager().open = true; manager().dispatch('toggle'); await nextTurn();
  assert.deepEqual(requests, [{path:'/api/mail/labels/sync',method:'GET',timeout:190000}]);
  assert.match(view.settingsHost.textContent, /12 synced\. 3 pending\. 2 need review\. 1 left unchanged\./u);
  assert.equal(view.field('Name'), name); assert.equal(name.value, 'Unfinished label');
  view.tools.render(view.host); manager().dispatch('toggle'); await nextTurn(); assert.equal(requests.length, 1);
  manager().open = false; manager().dispatch('toggle'); await nextTurn(); assert.equal(requests.length, 1);
  manager().open = true; manager().dispatch('toggle'); await nextTurn(); assert.equal(requests.length, 2);
});

test('Sync labels explicitly retries provider sync and displays pending status without polling', async t => {
  const requests = []; let complete;
  const view = setup(t, {api: async (path, options) => {
    requests.push({path,...options}); return new Promise(resolve => { complete = resolve; });
  }});
  view.button('Sync labels').dispatch('click');
  assert.equal(view.button('Sync labels').disabled, true);
  assert.match(view.settingsHost.textContent, /Syncing labels to original mailboxes/u);
  assert.deepEqual(requests[0], {path:'/api/mail/labels/sync',method:'POST',body:{action:'sync'},timeout:190000});
  view.button('Sync labels').dispatch('click'); assert.equal(requests.length, 1);
  complete({running:true,pending:6,synced:3,failed:0}); await nextTurn();
  assert.match(view.settingsHost.textContent, /Sync in progress\. 3 synced\. 6 pending\./u);
  assert.equal(view.button('Sync labels').disabled, false);
  await nextTurn(); assert.equal(requests.length, 1);
});

test('late label sync responses cannot repopulate a reset session and failures remain retryable', async t => {
  const responses = [];
  const view = setup(t, {api: async () => new Promise((resolve,reject) => responses.push({resolve,reject}))});
  view.button('Sync labels').dispatch('click'); view.tools.reset(); view.tools.render(view.host,view.mounts);
  responses[0].resolve({running:false,pending:999,synced:888,failed:777}); await nextTurn();
  assert.doesNotMatch(view.settingsHost.textContent, /999|888|777/u);
  view.button('Sync labels').dispatch('click'); responses[1].reject(new Error('Mailbox unavailable.')); await nextTurn();
  assert.match(view.settingsHost.textContent, /Mailbox unavailable\./u); assert.equal(view.button('Sync labels').disabled, false);
  view.button('Sync labels').dispatch('click'); responses[2].resolve({running:false,backfillComplete:true}); await nextTurn();
  assert.doesNotMatch(view.settingsHost.textContent, /Mailbox unavailable/u); assert.match(view.settingsHost.textContent, /No labels waiting to sync/u);
});

test('one selection checkbox tracks empty, partial and complete capped selection', async t => {
  const hold = {}; const view = setup(t,{api:async () => new Promise(resolve => {hold.resolve=resolve;})});
  assert.equal(view.button('Compose'),undefined); assert.equal(view.button('Select loaded'),undefined); assert.equal(view.button('Clear selection'),undefined);
  view.state.messages = Array.from({length:70},(_,i) => ({id:String(i),accountId:'a'}));
  view.state.selection = new Set(['4']); view.tools.render(view.host);
  assert.equal(view.selectLoaded().indeterminate,true); assert.equal(view.selectLoaded().checked,false);
  view.selectLoaded().checked = true; view.selectLoaded().dispatch('change');
  assert.equal(view.state.selection.size,50); assert.equal(view.selectLoaded().checked,true); assert.equal(view.selectLoaded().indeterminate,false);
  view.button('Apply to selected').dispatch('click'); assert.equal(view.selectLoaded().disabled,true);
  hold.resolve({applied: Array.from({length: 50}, (_, i) => String(i)), failed: []}); await nextTurn();
  assert.equal(view.state.selection.size,0); assert.equal(view.nodes().find(node => node.attributes.has('data-mail-selection-count')).hidden,true);
  view.state.messages = []; view.tools.render(view.host); assert.equal(view.selectLoaded().disabled,true); assert.equal(view.selectLoaded().checked,false);
});

test('advanced search opens externally, retains edits, and closes on Escape, apply and route change', async t => {
  const view = setup(t), panel = () => view.nodes().find(node => node.id === 'mail-advanced-search');
  assert.equal(panel().hidden,true); assert.equal(view.advancedButton.attributes.get('aria-expanded'),'false');
  view.advancedButton.dispatch('click'); assert.equal(panel().hidden,false); assert.equal(document.activeElement,view.field('From'));
  const field = view.field('From'); field.value='saved@example.test'; field.dispatch('input');
  view.tools.render(view.host,view.mounts); assert.equal(view.field('From'),field);
  panel().dispatch('keydown',{key:'Escape'}); assert.equal(panel().hidden,true); assert.equal(document.activeElement,view.advancedButton);
  view.advancedButton.dispatch('click'); assert.equal(view.field('From').value,'saved@example.test');
  panel().children.find(node => node.tagName === 'form').dispatch('submit'); await nextTurn();
  assert.equal(panel().hidden,true); assert.equal(view.state.filters.from,'saved@example.test');
  view.advancedButton.dispatch('click'); view.tools.closeAdvanced(); assert.equal(panel().hidden,true);
  assert.equal(view.advancedButton.attributes.get('aria-controls'),'mail-advanced-search');
});

test('folder management and notifications live only in settings and confirmations stay there', t => {
  const view=setup(t);
  assert.doesNotMatch(view.host.textContent,/Manage folders|New-mail notifications/u);
  assert.match(view.settingsHost.textContent,/Manage folders & labels/u); assert.match(view.settingsHost.textContent,/New-mail notifications/u);
  const kind=view.field('Manage'); kind.value='label'; kind.dispatch('change');
  const operation=view.field('Operation'); operation.value='delete'; operation.dispatch('change');
  const label=view.settingsHost.querySelectorAll('*').find(node => node.tagName==='label' && node.text==='Local label').children[0]; label.value='custom_one'; label.dispatch('change');
  const form=view.settingsHost.querySelectorAll('*').find(node => node.tagName==='form'); form.dispatch('submit');
  assert.ok(view.settingsHost.querySelectorAll('*').find(node => node.textContent==='Confirm'));
  assert.equal(view.host.querySelectorAll('*').find(node => node.textContent==='Confirm'),undefined);
});

test('select-all lives in the folder heading and an empty bulk toolbar stays hidden', t => {
  const view = setup(t);
  assert.equal(view.host.querySelector('[data-mail-select-loaded]'),null);
  assert.ok(view.selectionHost.querySelector('[data-mail-select-loaded]'));
  assert.equal(view.host.hidden,true);
  view.selectLoaded().checked = true; view.selectLoaded().dispatch('change');
  assert.equal(view.host.hidden,false);
  view.selectLoaded().checked = false; view.selectLoaded().dispatch('change');
  assert.equal(view.host.hidden,true);
  view.tools.setUndo(['undo']); assert.equal(view.host.hidden,false);
});

test('advanced search mounts under its search toolbar outside the hidden message actions', t => {
  const view = setup(t), toolbar = new Element('div');
  view.advancedButton.closest = () => toolbar;
  view.state.folder = 'all'; view.tools.render(view.host,view.mounts);
  const panel = toolbar.querySelectorAll('*').find(node => node.id === 'mail-advanced-search');
  assert.ok(panel); assert.equal(view.host.hidden,true);
  view.advancedButton.dispatch('click'); assert.equal(panel.hidden,false);
  assert.equal(view.host.querySelectorAll('*').some(node => node.id === 'mail-advanced-search'),false);
});

test('reader provides accessible reply icons and account-specific move menu actions', async t => {
  const composed = [], view = setup(t,{openCompose:(...args) => composed.push(args)}), reader = new Element('div');
  const message = view.state.messages[0]; view.tools.renderReader(reader,message);
  const action = label => reader.querySelectorAll('*').find(node => node.attributes.get('aria-label') === label);
  for (const label of ['Reply','Reply all','Forward']) action(label).dispatch('click');
  assert.deepEqual(composed,[['reply',message],['reply_all',message],['forward',message]]);
  assert.equal(reader.querySelectorAll('*').some(node => node.tagName === 'select'),false);
  action('Move to folder').dispatch('click');
  const menu = document.body.querySelectorAll('*').filter(node => node.attributes.get('role') === 'menuitem');
  assert.deepEqual(menu.map(node => node.textContent),['A folder']);
  menu[0].dispatch('click'); await nextTurn();
  assert.deepEqual(view.calls[0].body,{ids:['1'],action:'move',destinationId:'folder:a'});
});

test('provider labels load in a modal only after their toolbar action is used', async t => {
  const requests = [], view = setup(t,{api:async (path,options) => { requests.push({path,...options}); return {supported:false}; }}), reader = new Element('div');
  view.tools.renderReader(reader,view.state.messages[0]); assert.equal(requests.length,0);
  reader.querySelectorAll('*').find(node => node.attributes.get('aria-label') === 'Provider labels').dispatch('click'); await nextTurn();
  assert.deepEqual(requests,[{path:'/api/mail/provider-labels',method:'POST',body:{id:'1'},timeout:190000}]);
  const modal = document.body.querySelectorAll('*').find(node => node.tagName === 'dialog');
  assert.ok(modal); assert.match(modal.textContent,/does not offer editable labels/u);
  assert.doesNotMatch(reader.textContent,/Current provider labels|does not offer editable labels/u);
});

test('buildMailFilters handles KB and MB unit conversions and catches inverted converted sizes', () => {
  const converted = buildMailFilters({minSize:'50',minSizeUnit:'KB',maxSize:'2',maxSizeUnit:'MB'});
  assert.equal(converted.minSize, 50 * 1024);
  assert.equal(converted.maxSize, 2 * 1024 * 1024);

  // 1 MB min > 500 KB max must throw
  assert.throws(() => buildMailFilters({minSize:'1',minSizeUnit:'MB',maxSize:'500',maxSizeUnit:'KB'}), /Minimum/u);
});

test('advanced search commits with shared search submission callback', t => {
  const submissions = [], clears = [];
  const view = setup(t, {
    onSearchSubmit: draft => submissions.push(draft),
    onSearchClear: () => clears.push(true)
  });
  view.advancedButton.dispatch('click');
  const panel = view.nodes().find(node => node.id === 'mail-advanced-search');
  assert.ok(panel);

  const searchBtn = panel.querySelectorAll('*').find(node => node.tagName === 'button' && node.textContent === 'Search');
  assert.ok(searchBtn);
  panel.children.find(node => node.tagName === 'form').dispatch('submit');
  assert.equal(submissions.length, 1);

  const clearBtn = panel.querySelectorAll('*').find(node => node.tagName === 'button' && node.textContent === 'Clear');
  assert.ok(clearBtn);
  clearBtn.dispatch('click');
  assert.equal(clears.length, 1);
});

test('flat cache settings loads 1800 server value, saves 100..5000 range and handles save failure', async t => {
  const calls = [];
  let saveFail = false;
  const view = setup(t, {
    api: async (path, options) => {
      calls.push({path, ...options});
      if (path === '/api/mail/cache' && options.method === 'GET') {
        return {
          enabled: true,
          healthy: true,
          maxHeadersPerAccount: 1800,
          headerCount: 1500,
          bodyCount: null,
          bodyBytes: null,
          refreshing: false,
          revision: 'rev-1',
          accounts: []
        };
      }
      if (path === '/api/mail/cache' && options.method === 'POST') {
        if (saveFail) throw new Error('Could not save cache limit.');
        return {
          enabled: true,
          healthy: true,
          maxHeadersPerAccount: options.body.maxHeadersPerAccount,
          headerCount: 1500,
          bodyCount: null,
          bodyBytes: null,
          refreshing: false,
          revision: 'rev-2',
          accounts: []
        };
      }
      return {};
    }
  });

  const cacheDetails = () => view.nodes().find(node => node.tagName === 'details' && node.children[0]?.textContent === 'Header cache settings');
  cacheDetails().open = true;
  cacheDetails().dispatch('toggle');
  await nextTurn();

  assert.equal(calls[0].path, '/api/mail/cache');
  assert.equal(calls[0].method, 'GET');

  const maxInput = view.field('Max headers per account (100–5000)');
  assert.ok(maxInput, 'Max headers input exists');
  assert.equal(maxInput.value, 1800, 'Loads actual server value of 1800, not fallback 500');

  // Submit out of bounds (< 100)
  maxInput.value = '50';
  maxInput.dispatch('input');
  const form = cacheDetails().children.find(n => n.className === 'mail-tools-grid');
  form.dispatch('submit');
  await nextTurn();
  assert.equal(calls.length, 1, 'Out of bounds does not make POST request');
  assert.match(view.notices.at(-1)[0], /100 and 5000/);

  // Submit out of bounds (> 5000)
  maxInput.value = '6000';
  maxInput.dispatch('input');
  form.dispatch('submit');
  await nextTurn();
  assert.equal(calls.length, 1);

  // Valid save failure
  saveFail = true;
  maxInput.value = '2500';
  maxInput.dispatch('input');
  form.dispatch('submit');
  await nextTurn();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, {maxHeadersPerAccount: 2500});
  assert.match(view.notices.at(-1)[0], /Could not save cache limit/);
  assert.equal(maxInput.value, '2500', 'Edited value remains visible after failure');

  // Valid save success
  saveFail = false;
  form.dispatch('submit');
  await nextTurn();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body, {maxHeadersPerAccount: 2500});
  assert.match(view.notices.at(-1)[0], /Cache settings saved/);
  const updatedInput = view.field('Max headers per account (100–5000)');
  assert.equal(updatedInput.value, 2500);
});

test('restoreCriteria replaces filter draft without emitting search submit or clear', t => {
  const submits = [], clears = [];
  const view = setup(t, {
    onSearchSubmit: d => submits.push(d),
    onSearchClear: () => clears.push(true)
  });

  // Populate some initial draft
  const from = view.field('From');
  from.value = 'initial@example.com';
  from.dispatch('input');

  // Restore criteria with different keys
  view.tools.restoreCriteria({
    filters: {to: 'restored@example.com', unread: 'false'},
    sort: 'subject_asc',
    bodySearch: true,
    allFolders: true
  });

  const draft = view.tools.readDraft();
  assert.equal(draft.filters.from, undefined, 'Old keys are replaced, not merged');
  assert.equal(draft.filters.to, 'restored@example.com');
  assert.equal(draft.filters.unread, false);
  assert.equal(draft.sort, 'subject_asc');
  assert.equal(draft.bodySearch, true);
  assert.equal(draft.allFolders, true);
  assert.equal(submits.length, 0, 'Restoration does not emit search submit');
  assert.equal(clears.length, 0, 'Restoration does not emit search clear');
});

test('removeCriteria preserves remaining draft fields and commits once', t => {
  const submits = [];
  const view = setup(t, {
    onSearchSubmit: d => submits.push(d)
  });

  const from = view.field('From');
  from.value = 'keep@example.com';
  from.dispatch('input');

  const subject = view.field('Subject');
  subject.value = 'toremove';
  subject.dispatch('input');

  view.tools.removeCriteria('subject');
  assert.equal(submits.length, 1);
  assert.equal(submits[0].filters.subject, undefined);
  assert.equal(submits[0].filters.from, 'keep@example.com');
});
