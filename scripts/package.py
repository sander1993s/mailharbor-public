"""Package only version-controlled, privacy-scanned source into artifacts/."""
from pathlib import Path
import importlib.util
import io
import json
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'artifacts'

def source_files(root=ROOT):
    spec = importlib.util.spec_from_file_location('privacy', root / 'scripts/privacy-scan.py')
    privacy = importlib.util.module_from_spec(spec); spec.loader.exec_module(privacy)
    names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    files = {}
    for name in filter(None, names):
        file = root / name
        if file.is_symlink() or not file.is_file() or file.absolute() != file.resolve() or root.resolve() not in file.resolve().parents or file.stat().st_nlink != 1:
            raise RuntimeError('Release contains a linked or missing source file')
        data = file.read_bytes()
        if privacy.scan(name, data): raise RuntimeError('Privacy scan failed; run python scripts/privacy-scan.py')
        files[name] = data
    for required in ('LICENSE', 'package.json', 'server/main.mjs', 'web/index.html', 'scripts/privacy-scan.py'):
        if required not in files: raise RuntimeError('Stage all reviewed release source before packaging')
    return files

def package():
    files = source_files()
    DEST.mkdir(exist_ok=True)
    version = json.loads(files['addon/manifest.json'])['version']
    xpi = DEST / f'mailharbor-{version}.xpi'
    with zipfile.ZipFile(xpi, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            if name.startswith('addon/'):
                info = zipfile.ZipInfo(name.removeprefix('addon/'), date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED; archive.writestr(info, data)
    version = json.loads(files['package.json'])['version']
    target = DEST / f'mailharbor-{version}.tar.gz'
    with tarfile.open(target, 'w:gz') as archive:
        for name, data in sorted(files.items()):
            info = tarfile.TarInfo('mailharbor/' + name); info.size = len(data); info.mode = 0o644; info.mtime = 0
            archive.addfile(info, io.BytesIO(data))
    print(xpi); print(target)

if __name__ == '__main__': package()
