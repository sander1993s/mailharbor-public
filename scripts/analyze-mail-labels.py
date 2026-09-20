"""Export exactly the newest 1,000 unified-Inbox headers for a local label review.

Default is a dry run. --export uses the existing homeserver loopback API, with
tokens remaining on that server. It makes no body, flag, label, briefing, AI,
Drive, deployment, or service-management requests. Private output is excluded
from source under .analysis/latest-1000; only safe progress appears in stdout.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid


SERVER = os.environ.get("MAILHARBOR_DEPLOY_SERVER", "")
KEY = os.environ.get("MAILHARBOR_SSH_IDENTITY", "")
ROOT = Path(__file__).resolve().parents[1] if "__file__" in globals() and __file__ != "<stdin>" else None
REMOTE_CLIENT = Path(os.environ.get("MAILHARBOR_INSTALL_DIR", str(Path.home() / "MailHarbor"))) / "scripts/verify-unified-mail.py"
REMOTE_OUTPUT = Path.home() / ".local/share/mailharbor/analysis/latest-1000"
TARGET = 1000
PAGE_SIZE = 50
SAFE_FIELDS = ("id", "accountId", "subject", "author", "to", "date", "tags")
READ_REQUESTS = {
    ("POST", "/api/session"), ("DELETE", "/api/session"),
    ("GET", "/api/status"), ("GET", "/api/accounts"),
    ("POST", "/api/mail/list"),
}


class ExportError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ExportError(code)


def emit(step, **details):
    print(json.dumps({"step": step, **details}, separators=(",", ":")), file=sys.stderr, flush=True)


def utc():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def date_value(value):
    require(isinstance(value, str) and len(value) <= 80, "invalid_message_date")
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ExportError("invalid_message_date") from None
    require(date.tzinfo is not None, "missing_message_timezone")
    return date.timestamp()


def validate_page(data, accounts, seen, previous_date, expected_total):
    require(isinstance(data, dict) and data.get("folder") == "inbox", "invalid_inbox_response")
    require(data.get("errors") == [] and data.get("totalComplete") is True, "partial_account_results")
    total = data.get("total")
    require(type(total) is int and total >= TARGET, "insufficient_inbox_total")
    require(expected_total is None or total == expected_total, "snapshot_total_changed")
    messages = data.get("messages")
    require(isinstance(messages, list) and len(messages) == PAGE_SIZE, "incomplete_page")
    page_seen, clean = set(), []
    unread = 0
    for message in messages:
        require(isinstance(message, dict), "invalid_message")
        identity = message.get("id")
        require(isinstance(identity, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identity), "invalid_message_id")
        require(identity not in seen and identity not in page_seen, "duplicate_messages")
        require(message.get("accountId") in accounts, "unexpected_account")
        require(all(isinstance(message.get(field), str) and len(message[field]) <= 500 for field in ("subject", "author", "to")), "invalid_header")
        require(isinstance(message.get("tags"), list) and len(message["tags"]) <= 64 and all(isinstance(tag, str) and re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", tag) for tag in message["tags"]), "invalid_message_tags")
        require(type(message.get("unread")) is bool and type(message.get("starred")) is bool, "invalid_message_flags")
        stamp = date_value(message.get("date"))
        require(previous_date is None or stamp <= previous_date, "message_order_changed")
        previous_date = stamp
        page_seen.add(identity)
        unread += int(message["unread"])
        clean.append({field: message[field] for field in SAFE_FIELDS})
    cursor = data.get("nextCursor")
    require(cursor is None or isinstance(cursor, str) and re.fullmatch(r"[A-Za-z0-9_-]{32}", cursor), "invalid_page_cursor")
    return clean, cursor, page_seen, previous_date, unread, total


def save_private(path, payload):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(payload)


def remote_export():
    require(sys.platform == "linux" and os.getuid() != 0, "wrong_host_user")
    os.umask(0o077)
    spec = importlib.util.spec_from_file_location("mailharbor_readonly_client", REMOTE_CLIENT)
    require(spec is not None and spec.loader is not None, "verification_client_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ALLOWED_REQUESTS = READ_REQUESTS
    client = module.Client()
    snapshot = None
    try:
        client.login()
        status = client.json("/api/status")
        require(status.get("version") == module.VERSION, "unexpected_service_status")
        all_accounts = client.json("/api/accounts").get("accounts")
        require(isinstance(all_accounts, list) and len(all_accounts) <= 100 and all(isinstance(account, dict) and type(account.get("connected")) is bool for account in all_accounts), "invalid_account_schema")
        raw_accounts = [account for account in all_accounts if account["connected"]]
        require(raw_accounts, "no_connected_accounts")
        account_ids = [account.get("id") for account in raw_accounts]
        require(len(set(account_ids)) == len(account_ids) and all(isinstance(identity, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identity) for identity in account_ids), "invalid_account_ids")
        account_ids.sort()
        started = utc()
        messages, seen, pages = [], set(), []
        cursor, previous_date, expected_total = None, None, None
        unread = 0
        for page in range(1, TARGET // PAGE_SIZE + 1):
            body = {"folder": "inbox", "accountIds": account_ids}
            if cursor:
                body["cursor"] = cursor
            for attempt in (1, 2):
                requested = utc()
                emit("inbox_export", page=page, attempt=attempt, status="started", collected=len(messages))
                try:
                    data = client.json("/api/mail/list", "POST", body)
                    checked = validate_page(data, set(account_ids), seen, previous_date, expected_total)
                    break
                except (ExportError, module.AcceptanceError) as error:
                    # A retry always reuses the incoming cursor. Never adopt the
                    # continuation cursor of a partial page that lost an account.
                    emit("inbox_export", page=page, attempt=attempt, status="retry" if attempt == 1 else "failed", error=str(error))
                    if attempt == 2:
                        raise ExportError("page_failed_after_one_retry") from None
            clean, cursor, page_seen, previous_date, page_unread, expected_total = checked
            require(page == TARGET // PAGE_SIZE or cursor is not None, "missing_page_cursor")
            messages.extend(clean)
            seen.update(page_seen)
            unread += page_unread
            pages.append({"page": page, "requestedAt": requested, "receivedAt": utc(), "attempts": attempt, "count": len(clean), "total": expected_total})
            emit("inbox_export", page=page, status="checked", collected=len(messages), completeTotal=expected_total)
        require(len(messages) == TARGET and len(seen) == TARGET, "incomplete_export")
        account_counts = dict(Counter(message["accountId"] for message in messages))
        snapshot = {
            "schema": 1, "scope": "Newest 1000 messages in the unified Inbox, including read and unread mail",
            "startedAt": started, "completedAt": utc(), "version": status["version"],
            "count": len(messages), "completeInboxTotal": expected_total,
            "newestDate": messages[0]["date"], "oldestDate": messages[-1]["date"],
            "unread": unread, "read": TARGET - unread,
            "accounts": [{"id": account["id"], "label": account.get("label", account["id"]), "count": account_counts.get(account["id"], 0)} for account in raw_accounts],
            "snapshotMethod": "The first successful page freezes each account's maximum matching UID on the server. Every continuation uses that snapshot, and all pages require the same complete total, unique IDs and descending message dates.",
            "pages": pages, "messages": messages,
        }
    finally:
        client.logout()
        emit("session", status="logged_out")
    require(snapshot is not None, "missing_export")
    require(REMOTE_OUTPUT.resolve() == REMOTE_OUTPUT, "linked_output_directory")
    REMOTE_OUTPUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(REMOTE_OUTPUT, 0o700)
    path = REMOTE_OUTPUT / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8] + ".json")
    payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    save_private(path, payload)
    emit("private_export", status="saved", messages=TARGET, sha256=hashlib.sha256(payload).hexdigest())
    # stdout is captured directly into a private local file by the parent helper;
    # it is never printed by a shell tool or mixed with progress diagnostics.
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def local_export():
    require(ROOT is not None and (ROOT / "server/mail-api.mjs").is_file(), "wrong_workspace")
    output = ROOT / ".analysis" / "latest-1000"
    require(output.resolve() == output, "linked_output_directory")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = output / ("headers-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".json")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        require(bool(SERVER) and re.fullmatch(r"[A-Za-z0-9_.@-]+", SERVER) and not SERVER.startswith("-"), "configure_ssh_destination")
        require(bool(KEY), "configure_ssh_identity")
        remote_environment = [f"{name}={shlex.quote(os.environ[name])}" for name in ("MAILHARBOR_INSTALL_DIR", "MAILHARBOR_CONFIG") if name in os.environ]
        remote_command = ("env " + " ".join(remote_environment) + " " if remote_environment else "") + "python3 - --remote"
        result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=yes", "-i", KEY, SERVER, remote_command],
                                input=Path(__file__).read_bytes(), stdout=stream, check=False)
    require(result.returncode == 0, "remote_export_failed")
    data = json.loads(path.read_text(encoding="utf-8"))
    require(data.get("count") == TARGET and len(data.get("messages", [])) == TARGET, "invalid_saved_export")
    print(json.dumps({"status": "saved", "file": str(path), "count": data["count"], "connectedAccounts": len(data["accounts"]),
                      "oldestDate": data["oldestDate"], "newestDate": data["newestDate"],
                      "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--export", action="store_true", help="Read 20 Inbox pages and save exactly 1,000 private headers")
    mode.add_argument("--remote", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.remote:
            remote_export()
        elif args.export:
            local_export()
        else:
            print(json.dumps({"mode": "dry-run", "server": SERVER, "pages": TARGET // PAGE_SIZE,
                              "scope": "Inbox, connected accounts, read and unread", "output": ".analysis/latest-1000",
                              "bodyReads": False, "mailboxWrites": False, "labelWrites": False, "externalAI": False}))
        return 0
    except ExportError as error:
        emit("export", status="failed", error=str(error))
    except Exception:
        emit("export", status="failed", error="unexpected_export_error")
    return 1


if __name__ == "__main__":
    sys.exit(main())
