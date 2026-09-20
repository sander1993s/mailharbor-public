import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const python = process.platform === 'win32' ? 'python' : 'python3';
function run(code) {
  const prelude = `import importlib.util, pathlib, json, os, sys, tempfile, io, types
def load(name):
 spec=importlib.util.spec_from_file_location(name,'scripts/'+name+'.py')
 module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
`;
  const result = spawnSync(python, ['-B', '-c', prelude + code], {encoding: 'utf8', timeout: 30000, windowsHide: true});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('deployment remote paths preserve POSIX syntax on Windows hosts', () => {
  const value = run(`
os.environ['MAILHARBOR_REMOTE_HOME']='/srv/mail-owner'
os.environ['MAILHARBOR_NODE']='/opt/node/bin/node'
old_platform=sys.platform
sys.platform='win32'
try: deployment=load('deploy-release')
finally: sys.platform=old_platform
print(json.dumps({'home':str(deployment.DEPLOY_HOME),'live':str(deployment.LIVE),'node':str(deployment.NODE),'absolute':deployment.DEPLOY_HOME.is_absolute()}))
`);
  assert.deepEqual(value, {home: '/srv/mail-owner', live: '/srv/mail-owner/MailHarbor', node: '/opt/node/bin/node', absolute: true});
});

test('acceptance handles arbitrary connected account counts, custom Drive identity and empty inboxes', () => {
  const value = run(`
v=load('verify-unified-mail'); v.ORIGIN='https://mail.example.test'
observations=[]; v.emit=lambda step,**details:observations.append((step,details))
class Client:
 def __init__(self,count,empty): self.ids=['mailbox-'+str(i) for i in range(count)]; self.empty=empty
 def login(self): pass
 def raw(self,route):
  if route=='/': return (''.join('<div id="'+value+'"></div>' for value in v.ELEMENTS).encode(),{})
  return (b'createMailView ./mail.mjs export function createMailView createFilingView export function createFilingView '+b' '*150,{})
 def json(self,route,method='GET',body=None):
  if route=='/api/status': return {'version':v.VERSION,'ready':False}
  if route=='/api/accounts': return {'accounts':[{'id':value,'connected':True} for value in self.ids]+[{'id':'disconnected','connected':False}]}
  if route=='/api/drive': return {'expectedEmail':'chosen@example.test','configured':True,'callback':v.ORIGIN+'/oauth/drive/callback'}
  if route=='/api/invoices': return {'enabled':False,'running':False,'recent':[]}
  if route=='/api/mail/folders': return {'errors':[],'folders':[{'id':folder,'accountIds':self.ids,'counts':[{'accountId':value,'total':0 if self.empty else 1} for value in self.ids]} for folder in v.FOLDERS]}
  if route=='/api/mail/list':
   messages=[] if self.empty or body['folder']!='inbox' else [{'id':'message1','accountId':self.ids[0],'unread':False}]
   return {'folder':body['folder'],'messages':messages,'total':len(messages),'totalComplete':True,'nextCursor':None,'errors':[]}
  if route=='/api/mail/message': return {'message':{'id':'message1','accountId':self.ids[0],'body':'Synthetic content','truncated':False,'bodyUnavailable':False,'unread':False,'starred':False}}
  raise AssertionError(route)
for count,empty in [(1,True),(1,False),(7,False)]: v.verify(Client(count,empty))
print(json.dumps({'accountCounts':[details['connectedAccounts'] for step,details in observations if step=='accounts'],'emptySkipped':sum(step=='preview' and details['status']=='skipped_empty_inbox' for step,details in observations)}))
`);
  assert.deepEqual(value, {accountCounts: [1, 1, 7], emptySkipped: 1});
});

test('header export accepts current service version, one connected account and current labels without Agy readiness', () => {
  const value = run(`
export=load('analyze-mail-labels'); acceptance=load('verify-unified-mail')
export.TARGET=50; export.PAGE_SIZE=50; export.emit=lambda *args,**kwargs:None
class Client:
 def login(self): pass
 def logout(self): pass
 def json(self,route,method='GET',body=None):
  if route=='/api/status': return {'version':acceptance.VERSION,'ready':False}
  if route=='/api/accounts': return {'accounts':[{'id':'mailbox-one','connected':True,'label':'Synthetic mailbox'},{'id':'not-connected','connected':False}]}
  if route=='/api/mail/list':
   assert body['accountIds']==['mailbox-one']
   return {'folder':'inbox','errors':[],'totalComplete':True,'total':50,'nextCursor':None,'messages':[{'id':'message'+str(i),'accountId':'mailbox-one','subject':'Synthetic','author':'sender@example.test','to':'owner@example.test','date':'2026-01-01T00:00:00Z','tags':['development','security','appointments'],'unread':False,'starred':False} for i in range(50)]}
  raise AssertionError(route)
acceptance.Client=Client
export.importlib.util.module_from_spec=lambda spec:acceptance
export.importlib.util.spec_from_file_location=lambda *args:types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module:None))
old_platform=sys.platform; old_stdout=sys.stdout
buffer=io.BytesIO()
with tempfile.TemporaryDirectory() as folder:
 export.REMOTE_OUTPUT=pathlib.Path(folder).resolve()/'private-output'
 sys.platform='linux'; export.os.getuid=lambda:1000
 try:
  sys.stdout=types.SimpleNamespace(buffer=buffer)
  export.remote_export()
 finally: sys.platform=old_platform; sys.stdout=old_stdout
 snapshot=json.loads(buffer.getvalue())
 print(json.dumps({'count':snapshot['count'],'accounts':len(snapshot['accounts']),'tags':snapshot['messages'][0]['tags']}))
`);
  assert.deepEqual(value, {count: 50, accounts: 1, tags: ['development', 'security', 'appointments']});
});
