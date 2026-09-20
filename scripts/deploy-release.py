"""Stage, verify, and atomically replace the existing private MailHarbor service.

Default execution is a read-only local dry run. --build-only creates a reviewed
release artifact; --deploy uploads it, tests it on Linux, and activates it.
No command in this script calls Agy, reads mailbox content, or changes config.
"""
from __future__ import annotations

import argparse
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import signal
import sqlite3
import subprocess
import sys
import tarfile
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
import uuid


# Local configuration is supplied at runtime and never committed.
SERVER = os.environ.get("MAILHARBOR_DEPLOY_SERVER", "")
IDENTITY = os.environ.get("MAILHARBOR_SSH_IDENTITY", "")
REMOTE_PATH = Path if sys.platform == "linux" else PurePosixPath
DEPLOY_HOME = REMOTE_PATH(os.environ.get("MAILHARBOR_REMOTE_HOME", str(Path.home()) if sys.platform == "linux" else "/home/mailharbor"))
LIVE = DEPLOY_HOME / "MailHarbor"
STATE = DEPLOY_HOME / ".local/share/mailharbor"
CONFIG = DEPLOY_HOME / ".config/mailharbor/config.json"
NODE = REMOTE_PATH(os.environ.get("MAILHARBOR_NODE", "/usr/bin/node"))
ROOT_FILES = {"package.json", "package-lock.json", "README.md", "CONTRACT.md", ".gitignore", ".gitattributes", "LICENSE", "SECURITY.md", "CONTRIBUTING.md"}
SUFFIXES = {
    "server": {".mjs"}, "web": {".html", ".mjs", ".css", ".svg", ".png", ".webmanifest"},
    "addon": {".html", ".mjs", ".js", ".css", ".svg", ".json"},
    "tests": {".mjs"}, "scripts": {".mjs", ".py", ".ps1"}, "docs": {".md"},
}
MAX_FILE = 2 * 1024 * 1024
MAX_RELEASE = 30 * 1024 * 1024
RELEASE_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{8}")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checked(path: Path, parent: Path | None = None) -> Path:
    """Reject symlink/junction traversal and require the intended absolute root."""
    path = path.absolute()
    require(path.resolve() == path, "Refusing a non-canonical or linked deployment path")
    if parent is not None:
        require(path != parent and parent in path.parents, "Deployment path escaped its intended directory")
    return path


def allowed_name(name):
    parts = PurePosixPath(name).parts
    if (not parts or "\\" in name or PurePosixPath(name).is_absolute() or ".." in parts
            or name != PurePosixPath(name).as_posix()):
        return False
    if name in ROOT_FILES:
        return True
    return (parts[0] in SUFFIXES and len(parts) >= 2
            and all(not part.startswith(".") and part != "__pycache__" for part in parts)
            and PurePosixPath(name).suffix in SUFFIXES[parts[0]])


def release_source(root):
    spec = importlib.util.spec_from_file_location('release_package', root / 'scripts/package.py')
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    files = {name: data for name, data in package.source_files(root).items() if allowed_name(name)}
    require({"package.json", "package-lock.json", "server/main.mjs", "web/index.html"} <= files.keys(),
            "Missing required release source")
    require(all(len(data) <= MAX_FILE for data in files.values()), "A release file exceeds the size limit")
    require(sum(map(len, files.values())) <= MAX_RELEASE, "Release source exceeds the size limit")
    version = json.loads(files["package.json"])["version"]
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version), "Invalid release version")
    manifest = {"schema": 1, "version": version, "files": {name: sha(data) for name, data in files.items()}}
    return files, manifest


def archive_bytes(files, manifest):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        members = {"release-manifest.json": json.dumps(manifest, sort_keys=True, indent=2).encode(), **files}
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o600, 0
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def command(args, *, cwd=None, env=None, timeout=900):
    """Commands operate on source/fixtures only; never pass secrets in argv."""
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True, timeout=timeout)


def service_state(name):
    value = subprocess.run(["systemctl", "--user", "is-active", name], capture_output=True, text=True, timeout=20)
    return value.stdout.strip()


def require_no_worker():
    # Legacy add-on jobs share the worker but are absent from /api/briefings.
    # Inspect child PIDs only; never expose command lines or process environments.
    result = subprocess.run(["systemctl", "--user", "show", "mailharbor.service", "--property=MainPID", "--value"],
                            capture_output=True, text=True, timeout=20, check=True)
    pid = result.stdout.strip()
    require(pid.isdecimal() and int(pid) > 0, "MailHarbor service PID unavailable")
    children = Path(f"/proc/{pid}/task/{pid}/children").read_text().strip()
    require(not children, "MailHarbor has an active worker; deployment left production unchanged")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("Unexpected deployment health redirect")


def health(expected_version=None, require_idle=False):
    """Read credentials only on the server, send only to its loopback listener.

    Responses are reduced to version/booleans/counts before being printed.
    Session logout happens in finally; no cookies or tokens enter command lines.
    """
    config = json.loads(CONFIG.read_text())
    port = config.get("port", 8765)
    require(isinstance(port, int) and 1024 <= port <= 65535, "Invalid loopback port")
    origin = config["web"]["origin"]
    parsed = urlsplit(origin)
    require(parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password
            and not parsed.path and not parsed.query and not parsed.fragment, "Unexpected configured web origin")
    token = config.get("pairingToken")
    if token is None:
        token = Path(config["tokenFile"]).read_text().strip()
    require(isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token), "Invalid pairing token")
    opener = build_opener(ProxyHandler({}), NoRedirect())
    cookie, csrf = "", ""

    def request(route, method="GET", body=None):
        headers = {"Host": parsed.netloc, "Origin": origin, "Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        if csrf:
            headers["X-Mailharbor-CSRF"] = csrf
        data = None if body is None else json.dumps(body).encode()
        with opener.open(Request(f"http://127.0.0.1:{port}{route}", data=data, headers=headers, method=method), timeout=15) as response:
            raw = response.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024, "Health response exceeds limit")
            return raw, response.headers

    try:
        raw, headers = request("/api/session", "POST", {"token": token})
        cookie = headers.get("Set-Cookie", "").split(";", 1)[0]
        csrf = json.loads(raw)["csrf"]
        require(cookie and csrf, "Health session was not created")
        status = json.loads(request("/api/status")[0])
        accounts = json.loads(request("/api/accounts")[0])["accounts"]
        batches = json.loads(request("/api/briefings")[0])["briefings"]
        request("/")
        request("/manifest.webmanifest")
        active = sum(batch["status"] in {"scanning", "queued", "running"} for batch in batches)
        active_invoices = False
        active_processing = False
        enabled_processing = False
        active_notifications = False
        enabled_notifications = False
        version_parts = tuple(int(part) for part in status.get("version", "0.0.0").split("."))
        if version_parts >= (0, 5, 0):
            filing = json.loads(request("/api/invoices")[0])
            active_invoices = filing.get("running") is True
            request("/api/drive")
            request("/filing.mjs")
        if version_parts >= (0, 6, 0):
            processing = json.loads(request("/api/mail/processing/status")[0])
            active_processing = processing.get("running") is True
            enabled_processing = processing.get("enabled") is True
            request("/processing.mjs")
        if version_parts >= (0, 8, 5):
            notifications = json.loads(request("/api/mail/telegram")[0])
            active_notifications = notifications.get("busy") is True
            enabled_notifications = notifications.get("enabled") is True
            request("/telegram-settings.mjs")
        if expected_version is not None:
            require(status.get("version") == expected_version, "Deployed API version does not match release")
        if require_idle:
            require(active == 0, "Active briefings exist; deployment left production unchanged")
            require(not active_invoices, "Invoice filing is active; deployment left production unchanged")
            require(not active_processing, "Mail processing is active; pause it before deployment")
            require(not enabled_processing, "Automatic mail processing is enabled; pause it before deployment")
            require(not active_notifications, "Telegram inquiry processing is active; pause it before deployment")
            require(not enabled_notifications, "Telegram inquiry notifications are enabled; pause them before deployment")
        return {"version": status.get("version"), "ready": bool(status.get("ready")),
                "connectedAccounts": sum(bool(account.get("connected")) for account in accounts), "activeBriefings": active,
                "activeInvoiceFiling": active_invoices, "activeMailProcessing": active_processing,
                "enabledMailProcessing": enabled_processing, "activeInquiryNotifications": active_notifications,
                "enabledInquiryNotifications": enabled_notifications}
    finally:
        if cookie and csrf:
            try:
                request("/api/session", "DELETE")
            except Exception:
                pass


def wait_health(version):
    for attempt in range(12):
        try:
            return health(version)
        except Exception:
            if attempt == 11:
                raise RuntimeError("MailHarbor health checks failed after service start") from None
            time.sleep(2)


def verify_stage(stage, manifest):
    actual = {file.relative_to(stage).as_posix(): sha(checked(file, stage).read_bytes())
              for file in stage.rglob("*") if file.is_file() and "node_modules" not in file.relative_to(stage).parts}
    require(actual == manifest["files"], "Staged source changed or differs from release manifest")


def private_copy(source, destination):
    """Copy only an explicitly checked regular file, with exclusive creation."""
    checked(source)
    checked(destination)
    require(source.is_file() and not source.is_symlink(), "Backup source is not a regular file")
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with source.open("rb") as original, os.fdopen(descriptor, "wb") as copy:
        while chunk := original.read(1024 * 1024):
            copy.write(chunk)
        copy.flush()
        os.fsync(copy.fileno())
    destination.chmod(0o600)


def file_hash(filename):
    digest = hashlib.sha256()
    with filename.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def backup_database(source, destination):
    """Produce one consistent database file, including committed WAL pages."""
    for suffix in ("-wal", "-shm"):
        sidecar = checked(Path(str(source) + suffix), source.parent)
        require(not sidecar.exists() or sidecar.is_file(), "Invalid protected SQLite sidecar")
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    original = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    snapshot = sqlite3.connect(destination)
    try:
        original.backup(snapshot, pages=256, sleep=0.01)
        require(snapshot.execute("PRAGMA quick_check").fetchall() == [("ok",)], "State backup failed integrity verification")
        counts = dict(snapshot.execute("SELECT kind,count(*) FROM documents GROUP BY kind").fetchall())
        snapshot.commit()
        require(snapshot.execute("PRAGMA journal_mode=DELETE").fetchone()[0] == "delete", "State backup still requires WAL")
    finally:
        snapshot.close()
        original.close()
    destination.chmod(0o600)
    return counts


def backup_state(state_directory, destination):
    """Caller must stop the service first. SQLite backup includes committed WAL.

    Accounts, invoice ledger, encrypted messages, notification jobs and move intents
    remain private. The manifest records ciphertext hashes and aggregate counts.
    A restore is never copied over production during a source rollback.
    """
    state_directory, destination = checked(state_directory), checked(destination)
    require(state_directory.is_dir() and not destination.exists(), "Invalid state backup paths")
    require(state_directory not in destination.parents and destination not in state_directory.parents,
            "State backup must be outside the live state directory")
    sources = [checked(state_directory / name, state_directory) for name in
               ("accounts.key", "accounts.enc", "mail-index.sqlite")]
    require(all(source.is_file() for source in sources), "Required protected state is missing")
    require(sources[0].stat().st_size == 32, "Protected state key has an invalid size")
    notifications = checked(state_directory / "notification-state.sqlite", state_directory)
    if notifications.exists():
        require(notifications.is_file(), "Invalid protected notification store")
        sources.append(notifications)
    else:
        require(not any(checked(Path(str(notifications) + suffix), state_directory).exists() for suffix in ("-wal", "-shm")),
                "Notification database is missing but SQLite sidecars remain")
    before = {source.name: file_hash(source) for source in sources[:2]}
    destination.mkdir(parents=True, mode=0o700)
    destination.chmod(0o700)
    for source in sources[:2]:
        private_copy(source, checked(destination / source.name, destination))
    index_counts = backup_database(sources[2], checked(destination / sources[2].name, destination))
    notification_counts = backup_database(notifications, checked(destination / notifications.name, destination)) if notifications.exists() else {}
    require(before == {source.name: file_hash(source) for source in sources[:2]}, "Protected account state changed during backup")
    require(before == {name: file_hash(destination / name) for name in before}, "Protected account backup differs from source")
    manifest = {"schema": 2, "documents": sum(index_counts.values()), "messages": index_counts.get("messages", 0),
                "notificationsPresent": notifications.exists(), "notificationDocuments": sum(notification_counts.values()),
                "notificationCandidates": notification_counts.get("candidates", 0),
                "files": {source.name: file_hash(destination / source.name) for source in sources}}
    target = checked(destination / "backup-manifest.json", destination)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(manifest, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    return manifest


def verify_state_backup(previous, staged, state_backup, restore_directory, env):
    """Restore only to a new private directory, then prove migration/read rollback."""
    manifest = json.loads((state_backup / "backup-manifest.json").read_text())
    expected = {"accounts.key", "accounts.enc", "mail-index.sqlite"}
    require(manifest.get("schema") in (1, 2), "Invalid backup schema")
    if manifest["schema"] == 2:
        require(isinstance(manifest.get("notificationsPresent"), bool), "Invalid notification backup inventory")
        if manifest["notificationsPresent"]:
            expected.add("notification-state.sqlite")
    require(set(manifest.get("files", {})) == expected, "Invalid backup inventory")
    require(not checked(restore_directory).exists(), "Restore verification path already exists")
    restore_directory.mkdir(mode=0o700)
    for name, digest in manifest["files"].items():
        source = checked(state_backup / name, state_backup)
        require(file_hash(source) == digest, "Protected state backup hash mismatch")
        private_copy(source, checked(restore_directory / name, restore_directory))
    marker = restore_directory / ".restore-check"
    descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="ascii", newline="\n") as output:
        output.write("MailHarbor isolated restore verification\n")
    command([NODE, staged / "scripts/verify-state-backup.mjs", previous, staged, restore_directory], env=env)
    require(all(file_hash(state_backup / name) == digest for name, digest in manifest["files"].items()),
            "Restore verification modified the backup")


def remote_deploy(release_id, archive_sha):
    require(sys.platform == "linux" and os.getuid() != 0, "Deploy as the existing non-root Linux user")
    require(checked(Path.home()) == checked(DEPLOY_HOME) and DEPLOY_HOME.stat().st_uid == os.getuid(), "Unexpected deployment user or home")
    os.umask(0o077)
    require(RELEASE_RE.fullmatch(release_id) and re.fullmatch(r"[a-f0-9]{64}", archive_sha), "Invalid release identity")
    for base in (STATE, LIVE, NODE, CONFIG):
        checked(base)
    require(LIVE.is_dir() and NODE.is_file() and CONFIG.is_file(), "Existing deployment prerequisites are missing")
    require(service_state("mailharbor.service") == "active", "MailHarbor must be active before deployment")
    archive_path = checked(STATE / "releases" / f"{release_id}.tar.gz", STATE)
    require(archive_path.stat().st_size <= MAX_RELEASE, "Uploaded archive exceeds the size limit")
    require(sha(archive_path.read_bytes()) == archive_sha, "Uploaded archive SHA-256 mismatch")
    stage_root = checked(STATE / "staging" / release_id, STATE)
    backup_root = checked(STATE / "backups" / f"{release_id}-previous", STATE)
    require(not stage_root.exists() and not backup_root.exists(), "Release stage or backup already exists")
    stage_root.mkdir(parents=True, mode=0o700)
    stage = checked(stage_root / "project", stage_root)
    stage.mkdir(mode=0o700)
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        require(len(members) <= 1000 and all(member.isfile() and 0 <= member.size <= MAX_FILE for member in members),
                "Release archive contains unsupported entries")
        require(sum(member.size for member in members) <= MAX_RELEASE, "Expanded release exceeds size limit")
        names = [member.name for member in members]
        require(len(names) == len(set(names)) and names.count("release-manifest.json") == 1, "Invalid release inventory")
        manifest = json.load(archive.extractfile("release-manifest.json"))
        require(manifest.get("schema") == 1 and isinstance(manifest.get("files"), dict), "Unsupported release manifest")
        require(set(names) == set(manifest["files"]) | {"release-manifest.json"}, "Archive inventory mismatch")
        for member in members:
            if member.name == "release-manifest.json":
                continue
            require(allowed_name(member.name), "Release contains an unapproved source path")
            data = archive.extractfile(member).read()
            require(sha(data) == manifest["files"][member.name], "Release source SHA-256 mismatch")
            destination = checked(stage / member.name, stage)
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with destination.open("xb") as output:
                output.write(data)
            destination.chmod(0o600)
    version = json.loads((stage / "package.json").read_text())["version"]
    require(version == manifest["version"] and f"-{version}-" in release_id, "Release version mismatch")
    env = {**os.environ, "PATH": str(NODE.parent) + os.pathsep + os.environ.get("PATH", ""), "MAILHARBOR_UI_TEST": "0"}
    env.pop("NODE_OPTIONS", None)
    env.pop("NODE_PATH", None)
    command(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], cwd=stage, env=env)
    tests = sorted((stage / "tests").glob("*.mjs"))
    require(tests, "Release has no synthetic tests")
    command([NODE, "--test", "--test-concurrency=1", *tests], cwd=stage, env=env)
    verify_stage(stage, manifest)
    before = health(require_idle=True)
    require_no_worker()
    print(json.dumps({"preflight": before, "sourceFiles": len(manifest["files"])}), flush=True)
    backup_root.mkdir(parents=True, mode=0o700)
    backup = checked(backup_root / "project", backup_root)
    failed = checked(stage_root / "failed-project", stage_root)
    stopped = False

    def interrupted(signum, frame):
        raise RuntimeError("Deployment interrupted; attempting rollback")

    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        # Recheck immediately before stopping; no long-running work follows this check.
        health(require_idle=True)
        require_no_worker()
        stopped = True
        command(["systemctl", "--user", "stop", "mailharbor.service"], timeout=30)
        require(service_state("mailharbor.service") == "inactive", "MailHarbor did not stop cleanly")
        config = json.loads(CONFIG.read_text())
        state_directory = checked(Path(config.get("web", {}).get("stateDir", str(CONFIG.parent / "web"))))
        require(Path.home() in state_directory.parents, "Protected state escaped the deployment user's home")
        state_backup = checked(backup_root / "state", backup_root)
        backup_manifest = backup_state(state_directory, state_backup)
        verify_state_backup(LIVE, stage, state_backup, checked(backup_root / "restore-check", backup_root), env)
        print(json.dumps({"stateBackup": str(state_backup), "documents": backup_manifest["documents"],
                          "messages": backup_manifest["messages"], "backupManifestSha256": file_hash(state_backup / "backup-manifest.json")}), flush=True)
        checked(LIVE).rename(checked(backup, backup_root))
        checked(stage, stage_root).rename(checked(LIVE))
        command(["systemctl", "--user", "start", "mailharbor.service"], timeout=30)
        after = wait_health(version)
        require(not after["enabledMailProcessing"] and not after["activeMailProcessing"], "Mail processing must stay paused during deployment")
        require(not after["enabledInquiryNotifications"] and not after["activeInquiryNotifications"], "Inquiry notifications must stay paused during deployment")
        require(after["connectedAccounts"] == before["connectedAccounts"], "Connected account count changed")
        require(not before["ready"] or after["ready"], "Existing service readiness regressed")
        require(service_state("mailharbor.service") == "active", "MailHarbor is not active")
        print(json.dumps({"deployed": after, "rollbackProject": str(backup), "sourceSha256": archive_sha}), flush=True)
    except BaseException:
        if stopped:
            try:
                command(["systemctl", "--user", "stop", "mailharbor.service"], timeout=30)
                # Determine completed moves from disk: a signal can arrive after
                # rename() succeeds but before a Python state flag is assigned.
                if checked(backup, backup_root).exists():
                    if checked(LIVE).exists():
                        checked(LIVE).rename(checked(failed, stage_root))
                    checked(backup, backup_root).rename(checked(LIVE))
                require(checked(LIVE).is_dir(), "Previous project is missing during rollback")
                command(["systemctl", "--user", "start", "mailharbor.service"], timeout=30)
                restored = wait_health(before["version"])
                require(not restored["enabledMailProcessing"] and not restored["activeMailProcessing"], "Rollback worker must remain paused")
                require(not restored["enabledInquiryNotifications"] and not restored["activeInquiryNotifications"], "Rollback inquiry notifications must remain paused")
                print(json.dumps({"rolledBack": restored, "failedRelease": str(failed) if failed.exists() else None}), flush=True)
            except BaseException:
                print("ROLLBACK NEEDS ATTENTION: inspect the preserved project/backup paths and mailharbor.service.", file=sys.stderr)
        raise


def local_main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Read source and print the release plan only (default)")
    mode.add_argument("--build-only", action="store_true", help="Write archive/manifest/SHA into deploy/releases; no network")
    mode.add_argument("--deploy", action="store_true", help="Upload, test on Linux, then activate with automatic rollback")
    parser.add_argument("--identity", default=IDENTITY, help="Existing SSH private-key path (contents are never read by this script)")
    args = parser.parse_args()
    root = checked(Path(__file__).resolve().parent.parent)
    files, manifest = release_source(root)
    release_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f'-{manifest["version"]}-{uuid.uuid4().hex[:8]}'
    target = checked(root / "deploy" / "releases" / f"{release_id}.tar.gz", root)
    print(json.dumps({"mode": "deploy" if args.deploy else "build-only" if args.build_only else "dry-run",
                      "version": manifest["version"], "server": SERVER, "target": LIVE.as_posix(),
                      "artifact": str(target), "sourceFiles": len(files), "sourceBytes": sum(map(len, files.values())),
                      "files": sorted(files)}, indent=2), flush=True)
    if not (args.deploy or args.build_only):
        return
    payload = archive_bytes(files, manifest)
    digest = sha(payload)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as output:
        output.write(payload)
    target.with_suffix(target.suffix + ".sha256").write_text(f"{digest}  {target.name}\n", encoding="ascii")
    target.with_suffix(target.suffix + ".manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"archiveSha256": digest}), flush=True)
    if not args.deploy:
        return
    require(bool(SERVER) and re.fullmatch(r"[A-Za-z0-9_.@-]+", SERVER) and not SERVER.startswith("-"), "Set MAILHARBOR_DEPLOY_SERVER to your SSH destination")
    require("MAILHARBOR_REMOTE_HOME" in os.environ and DEPLOY_HOME.is_absolute() and str(DEPLOY_HOME).startswith("/") and re.fullmatch(r"/[A-Za-z0-9_./-]+", str(DEPLOY_HOME)) and ".." not in DEPLOY_HOME.parts, "Set MAILHARBOR_REMOTE_HOME to an absolute Linux home directory")
    identity = str(Path(args.identity).absolute()) if args.identity else None
    options = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=yes"] + (["-i", identity] if identity else [])
    # Fixed remote directory and random release ID; never compose shell paths from source filenames.
    prepare = ("import os; from pathlib import Path; os.umask(0o077); "
               f"p=Path({str(STATE / 'releases')!r}); "
               "assert p.absolute()==p.resolve(), 'Linked release directory'; "
               "p.mkdir(parents=True,exist_ok=True,mode=0o700); "
               f"assert not (p/{(release_id + '.tar.gz')!r}).exists(), 'Release already exists'")
    command(["ssh", *options, SERVER, "python3 -c " + shlex.quote(prepare)], timeout=45)
    command(["scp", *options, str(target), f"{SERVER}:{STATE.as_posix()}/releases/{release_id}.tar.gz"], timeout=120)
    remote_command = "env MAILHARBOR_REMOTE_HOME=" + shlex.quote(str(DEPLOY_HOME)) + " MAILHARBOR_NODE=" + shlex.quote(str(NODE)) + " python3 - --remote " + shlex.quote(release_id) + " " + shlex.quote(digest)
    # stdin transports reviewed source only, never credentials. Remote rollback also
    # handles SSH hangup; do not terminate a running activation on a short timeout.
    subprocess.run(["ssh", *options, SERVER, remote_command], input=files["scripts/deploy-release.py"], check=True)


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--remote":
            remote_deploy(sys.argv[2], sys.argv[3])
        else:
            local_main()
    except KeyboardInterrupt:
        print("Deployment interrupted. Check the reported remote rollback result before retrying.", file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        # HTTP/provider bodies and configuration never enter exception output.
        print(f"Deployment failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
