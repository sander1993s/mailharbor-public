import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const python = process.platform === 'win32' ? 'python' : 'python3';
const prelude = `import importlib.util, pathlib, tempfile, subprocess, json
spec=importlib.util.spec_from_file_location('privacy','scripts/privacy-scan.py')
privacy=importlib.util.module_from_spec(spec); spec.loader.exec_module(privacy)
`;
function run(code) {
  const result = spawnSync(python, ['-B', '-c', prelude + code], {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
test('privacy scanner rejects real-domain addresses, runtime files, keys and local denylist values', () => {
  const result = run(`
values = [
 privacy.scan('server/sample.mjs', ('const email="person' + '@mail-provider.com"').encode()),
 privacy.scan('accounts.enc', b'encrypted'),
 privacy.scan('sample.mjs', ('-----BEGIN ' + 'PRIVATE KEY-----').encode()),
 privacy.scan('sample.mjs', b'private-fixture-host', ['private-fixture-host']),
 privacy.scan('sample.mjs', b'person@example.test'),
 privacy.scan('sample.mjs', b'public dependenciesMetadata', ['sMeta'])]
print(json.dumps([len(value) for value in values]))
`);
  assert.deepEqual(result, [1, 1, 1, 1, 0, 0]);
});
test('release packaging includes only tracked source and rejects tracked private data', () => {
  const result = run(`
spec=importlib.util.spec_from_file_location('package','scripts/package.py')
package=importlib.util.module_from_spec(spec); spec.loader.exec_module(package)
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder).resolve()
 for name in ('LICENSE','package.json','server/main.mjs','web/index.html','scripts/privacy-scan.py'):
  target=root/name; target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(pathlib.Path('scripts/privacy-scan.py').read_bytes() if name.endswith('privacy-scan.py') else b'{}')
 subprocess.run(['git','init','--quiet',str(root)],check=True)
 subprocess.run(['git','-C',str(root),'add','.'],check=True)
 (root/'session.log').write_text('runtime private data')
 (root/'.env').write_text('password=private-fixture')
 files=package.source_files(root)
 excluded='session.log' not in files and '.env' not in files
 subprocess.run(['git','-C',str(root),'add','session.log'],check=True)
 rejected=False
 try: package.source_files(root)
 except RuntimeError: rejected=True
 print(json.dumps({'excluded':excluded,'rejected':rejected}))
`);
  assert.deepEqual(result, {excluded: true, rejected: true});
});
test('release packaging rejects hard-linked source even inside the release root', () => {
  const result = run(`
import os
spec=importlib.util.spec_from_file_location('package','scripts/package.py')
package=importlib.util.module_from_spec(spec); spec.loader.exec_module(package)
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder).resolve(); (root/'public.txt').write_text('fixture')
 (root/'scripts').mkdir()
 (root/'scripts/privacy-scan.py').write_bytes(pathlib.Path('scripts/privacy-scan.py').read_bytes())
 os.link(root/'public.txt', root/'private.txt')
 subprocess.run(['git','init','--quiet',str(root)],check=True)
 subprocess.run(['git','-C',str(root),'add','public.txt'],check=True)
 rejected=False
 try: package.source_files(root)
 except RuntimeError: rejected=True
 print(json.dumps(rejected))
`);
  assert.equal(result, true);
});
