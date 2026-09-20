"""Scan tracked release files and optional Git history without printing matches.

This is a release gate and regression check, not a mathematical proof of privacy.
An optional local denylist accepts {replacements: [{from: <private literal>}]}.
Keep that denylist outside tracked source.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import zlib

EMAIL = re.compile(r"[A-Za-z0-9][A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}")
PUBLIC_EMAILS = {'notify@web3forms.com'}
# These exact values exercise protocol rejection/authentication in synthetic tests.
TEST_EMAILS = {'fixture-#@app.web3forms.com', 'mail@app.web3forms.com', 'user@fcm.googleapis.com'}
RULES = [
    ('private key', re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----')),
    ('GitHub token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b')),
    ('provider API key', re.compile(r'\b(?:AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|sk-(?:proj-)?[0-9A-Za-z_-]{32,})\b')),
    ('credential-bearing URL', re.compile(r'\b(?:https?|imaps?|smtps?)://[^\s/\"\x27:@]+:[^\s/\"\x27@]+@')),
    ('personal Windows home', re.compile(r'[A-Za-z]:[\\/]+Users[\\/]+(?!<|example\b|user\b|username\b)[A-Za-z0-9_.-]+', re.I)),
    ('private Tailscale hostname', re.compile(r'\b[a-z0-9-]+\.tail[a-f0-9]{6,}\.ts\.net\b', re.I)),
]
FORBIDDEN = re.compile(r'(?:^|/)(?:\.env(?:\..*)?|accounts\.(?:key|enc)|pairing-token|config(?:\.local)?\.json|credentials[^/]*|[^/]*\.(?:sqlite(?:-wal|-shm)?|db|eml|mbox|pst|ost|pem|key|p12|pfx|log|har|zip|gz|dump|enc))$', re.I)
EXCLUDED_DIRS = {'.analysis', '.git', 'node_modules', 'state', 'data', 'backups', 'agy-home', 'coverage', '__pycache__'}

def clean_png(data):
    if not data.startswith(b'\x89PNG\r\n\x1a\n'): return False
    allowed = {b'IHDR', b'PLTE', b'tRNS', b'IDAT', b'IEND', b'sRGB', b'gAMA', b'cHRM', b'pHYs'}
    position = 8; chunks = []
    while position + 12 <= len(data):
        size = int.from_bytes(data[position:position + 4], 'big')
        end = position + size + 12; kind = data[position + 4:position + 8]
        if end > len(data) or kind not in allowed: return False
        if zlib.crc32(data[position + 4:end - 4]) != int.from_bytes(data[end - 4:end], 'big'): return False
        chunks.append(kind); position = end
        if kind == b'IEND': return size == 0 and position == len(data) and chunks[0] == b'IHDR' and chunks.count(b'IHDR') == 1 and b'IDAT' in chunks
    return False

def git(root, *args):
    result = subprocess.run(['git', '-c', 'core.quotepath=false', *args], cwd=root, capture_output=True, check=True)
    return result.stdout

def reserved(address):
    domain = address.lower().rsplit('@', 1)[1]
    return (address.lower() in PUBLIC_EMAILS or domain.endswith('.users.noreply.github.com') or domain == 'users.noreply.github.com'
            or domain in {'example.com', 'example.org', 'example.net', 'localhost'}
            or any(domain.endswith('.' + suffix) for suffix in ('example.com', 'example.org', 'example.net', 'example', 'test', 'invalid', 'localhost')))

def scan(name, data, denylist=()):
    findings = []
    if FORBIDDEN.search(name) or EXCLUDED_DIRS.intersection(Path(name).parts): findings.append((name, 0, 'private/runtime file'))
    if any(not reserved(match.group()) for match in EMAIL.finditer(name)) or any(value.lower() in name.lower() for value in denylist if value):
        findings.append((name, 0, 'private filename'))
    if b'\0' in data:
        # Only reviewed PNG icons are allowed binary assets; reject embedded metadata.
        if name not in {'web/icon-192.png', 'web/icon-512.png', 'web/logo.png', 'addon/icon.png'} or not data.startswith(b'\x89PNG\r\n\x1a\n'):
            findings.append((name, 0, 'unreviewed binary'))
        elif not clean_png(data):
            findings.append((name, 0, 'image metadata or malformed PNG'))
        return findings
    try: text = data.decode('utf-8-sig')
    except UnicodeDecodeError: return findings + [(name, 0, 'non-UTF-8 file')]
    denied = [re.compile(r'(?<![A-Za-z0-9_])' + re.escape(value) + r'(?![A-Za-z0-9_])', re.I) for value in denylist if value]
    for index, line in enumerate(text.splitlines(), 1):
        synthetic = name.startswith('tests/') or name == 'scripts/privacy-scan.py'
        if any(not reserved(match.group()) and not (synthetic and match.group() in TEST_EMAILS) for match in EMAIL.finditer(line)):
            findings.append((name, index, 'non-example email address'))
        for reason, pattern in RULES:
            matches = list(pattern.finditer(line))
            if reason == 'credential-bearing URL' and synthetic:
                matches = [match for match in matches if not line[match.start():].startswith(('https://user:pass@example.test', 'https://user:pass@mail.example'))]
            if matches: findings.append((name, index, reason))
        if any(pattern.search(line) for pattern in denied):
            findings.append((name, index, 'local denylist match'))
    return findings

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--history', action='store_true')
    parser.add_argument('--denylist', type=Path)
    args = parser.parse_args(); root = args.root.resolve()
    denylist = []
    if args.denylist:
        values = json.loads(args.denylist.read_text(encoding='utf-8'))
        denylist = [item['from'] for item in values['replacements']]
    findings = []; count = 0
    names = git(root, 'ls-files', '-z').decode().split('\0')
    for name in filter(None, names):
        file = root / name
        if file.is_symlink() or not file.is_file() or file.absolute() != file.resolve() or root not in file.resolve().parents or file.stat().st_nlink != 1:
            findings.append((name, 0, 'missing or linked source')); continue
        findings.extend(scan(name, file.read_bytes(), denylist)); count += 1
    commits = 0
    if args.history:
        seen = set()
        for commit in git(root, 'rev-list', '--all').decode().splitlines():
            commits += 1
            findings.extend(scan('commit-metadata', git(root, 'cat-file', 'commit', commit), denylist))
            for entry in git(root, 'ls-tree', '-r', '-z', commit).split(b'\0'):
                if not entry: continue
                metadata, raw_name = entry.split(b'\t', 1); mode, kind, oid = metadata.decode().split(); name = raw_name.decode()
                if kind != 'blob' or mode not in {'100644', '100755'}: findings.append((name, 0, 'linked history entry')); continue
                if (oid, name) in seen: continue
                seen.add((oid, name)); findings.extend(scan(name, git(root, 'cat-file', 'blob', oid), denylist))
    unique = sorted(set(findings))
    print(json.dumps({'files': count, 'commits': commits, 'findings': [{'path': name, 'line': line, 'reason': reason} for name, line, reason in unique]}, indent=2))
    return 1 if unique else 0

if __name__ == '__main__': sys.exit(main())
