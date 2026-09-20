"""Read-only production acceptance for MailHarbor 0.8.6, run as the service owner on Linux.

Uses the existing local configuration and pairing token only against loopback.
Requests folder metadata, at most two Inbox pages, and one text preview. Never
sends mail, changes mail flags, calls actions/briefings/Agy, or writes mail data.
Output contains fixed progress labels, counts, safe error codes, and flags only.
"""
from __future__ import annotations

import argparse
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler


CONFIG = Path(os.environ.get("MAILHARBOR_CONFIG", str(Path.home() / ".config/mailharbor/config.json")))
ORIGIN = ""
VERSION = "0.8.6"
TIMEOUT = 180
MAX_RESPONSE = 1024 * 1024
FOLDERS = {"all", "inbox", "unread", "starred", "sent", "drafts", "archive", "junk", "trash"} | {"tag:" + tag for tag in ("coupons", "development", "social", "jobs", "security", "travel", "work", "newsletters", "finance", "invoices", "tenders", "appointments", "orders")}
ELEMENTS = {"mail-page", "mail-folders", "mail-account", "mail-search", "mail-list", "mail-more", "mail-reader", "invoice-filing", "mail-processing", "nav-inbox", "nav-today", "nav-accounts", "mail-tools", "accounts-list", "mail-compose", "mail-advanced", "mail-tools-settings"}
SAFE_CODES = {"unauthorized", "invalid_request", "busy", "not_found", "configuration_error", "stale_message",
              "mailbox_login_required", "mailbox_error", "mailbox_timeout", "cancelled", "timeout",
              "oauth_invalid_client", "oauth_invalid_grant", "oauth_imap_authentication_failed",
              "oauth_imap_connection_failed"}
ALLOWED_REQUESTS = {
    ("POST", "/api/session"), ("DELETE", "/api/session"), ("GET", "/api/status"),
    ("GET", "/api/accounts"), ("GET", "/"), ("GET", "/app.mjs"), ("GET", "/mail.mjs"),
    ("GET", "/api/mail/folders"), ("POST", "/api/mail/list"), ("POST", "/api/mail/message"),
    ("GET", "/api/drive"), ("GET", "/api/invoices"), ("GET", "/filing.mjs"),
    *(("GET", path) for path in ("/compose.mjs", "/compose.css", "/mail-content.mjs", "/mail-content.css", "/mail-tools.mjs", "/mail-tools.css", "/telegram-settings.mjs", "/controls.mjs", "/controls.css")),
}


class AcceptanceError(Exception):
    """Only fixed local error codes are ever emitted."""


def require(condition, code):
    if not condition:
        raise AcceptanceError(code)


def emit(step, **details):
    print(json.dumps({"step": step, **details}, separators=(",", ":")), flush=True)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise AcceptanceError("unexpected_redirect")


class InterfaceParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()

    def handle_starttag(self, tag, attrs):
        self.ids.update(value for key, value in attrs if key == "id")


def safe_provider_errors(data, accounts):
    errors = data.get("errors")
    require(isinstance(errors, list), "invalid_error_schema")
    output = []
    for error in errors:
        require(isinstance(error, dict), "invalid_error_schema")
        account = error.get("accountId")
        code = error.get("code")
        output.append({"accountId": account if isinstance(account, str) and account in accounts else "unknown",
                       "code": code if isinstance(code, str) and code in SAFE_CODES else "mailbox_error"})
    return output


class Client:
    def __init__(self):
        require(sys.platform == "linux" and os.getuid() != 0, "wrong_host_user")
        global ORIGIN
        config = json.loads(CONFIG.read_text())
        ORIGIN = config.get("web", {}).get("origin", "").rstrip("/")
        origin = urlsplit(ORIGIN)
        require(origin.scheme == "https" and bool(origin.hostname) and not origin.username and not origin.password and not origin.query and not origin.fragment and origin.path in ("", "/"), "unexpected_web_origin")
        port = config.get("port", 8765)
        require(type(port) is int and 1024 <= port <= 65535, "invalid_loopback_port")
        self.base = f"http://127.0.0.1:{port}"
        self.host = urlsplit(ORIGIN).netloc
        self.cookie, self.csrf = "", ""
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.token = config.get("pairingToken")
        if self.token is None:
            self.token = Path(config["tokenFile"]).read_text().strip()
        require(isinstance(self.token, str) and re.fullmatch(r"[A-Za-z0-9_-]{32,128}", self.token), "invalid_pairing_token")

    def raw(self, route, method="GET", body=None):
        require((method, route) in ALLOWED_REQUESTS, "request_outside_acceptance_scope")
        headers = {"Host": self.host, "Origin": ORIGIN, "Content-Type": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        if self.csrf:
            headers["X-Mailharbor-CSRF"] = self.csrf
        request = Request(self.base + route, data=None if body is None else json.dumps(body).encode(),
                          headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=TIMEOUT) as response:
                raw = response.read(MAX_RESPONSE + 1)
                require(len(raw) <= MAX_RESPONSE, "response_too_large")
                return raw, response.headers
        except HTTPError as error:
            # Provider text, URLs and exception strings are deliberately discarded.
            code = "http_error"
            try:
                value = json.loads(error.read(MAX_RESPONSE + 1)).get("error", {}).get("code")
                if isinstance(value, str) and value in SAFE_CODES:
                    code = value
            except Exception:
                pass
            raise AcceptanceError(code) from None
        except (TimeoutError, URLError):
            raise AcceptanceError("request_timeout_or_connection_error") from None

    def json(self, route, method="GET", body=None):
        data = json.loads(self.raw(route, method, body)[0])
        require(isinstance(data, dict), "invalid_response_schema")
        return data

    def login(self):
        raw, headers = self.raw("/api/session", "POST", {"token": self.token})
        self.token = None
        self.cookie = headers.get("Set-Cookie", "").split(";", 1)[0]
        self.csrf = json.loads(raw).get("csrf")
        require(re.fullmatch(r"__Host-mailharbor=[A-Za-z0-9_-]{43}", self.cookie)
                and isinstance(self.csrf, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", self.csrf), "invalid_session_response")

    def logout(self):
        if self.cookie and self.csrf:
            data = self.json("/api/session", "DELETE")
            require(data.get("authenticated") is False, "logout_failed")
            self.cookie, self.csrf = "", ""


def verify_page(client, accounts, page, cursor=None, seen=None):
    emit("inbox", status="started", page=page)
    body = {"folder": "inbox"}
    if cursor:
        body["cursor"] = cursor
    data = client.json("/api/mail/list", "POST", body)
    errors = safe_provider_errors(data, accounts)
    require(data.get("folder") == "inbox" and isinstance(data.get("messages"), list), "invalid_inbox_response")
    messages = data["messages"]
    require(len(messages) <= 50 and all(isinstance(message, dict) for message in messages), "invalid_page_size")
    ids = [message.get("id") for message in messages]
    require(all(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) for value in ids), "invalid_message_reference")
    require(len(set(ids)) == len(ids) and not set(ids).intersection(seen or set()), "duplicate_page_messages")
    require(all(message.get("accountId") in accounts for message in messages), "unexpected_message_account")
    next_cursor = data.get("nextCursor")
    require(next_cursor is None or isinstance(next_cursor, str) and re.fullmatch(r"[A-Za-z0-9_-]{32}", next_cursor), "invalid_page_cursor")
    emit("inbox", status="checked", page=page, messages=len(messages),
         representedAccounts=len({message["accountId"] for message in messages}), hasNextPage=bool(next_cursor),
         total=data.get("total"), totalComplete=data.get("totalComplete"), errors=errors)
    require(type(data.get("total")) is int and data["total"] >= len(messages) and data.get("totalComplete") is True, "invalid_inbox_total")
    require(not errors, "inbox_provider_errors")
    return messages, next_cursor, set(ids)


def verify(client):
    emit("session", status="started")
    client.login()
    status = client.json("/api/status")
    require(status.get("version") == VERSION, "unexpected_version")
    emit("session", status="checked", version=VERSION, ready=status.get("ready") is True)

    data = client.json("/api/accounts")
    raw_accounts = data.get("accounts")
    require(isinstance(raw_accounts, list) and len(raw_accounts) <= 100
            and all(isinstance(account, dict) and type(account.get("connected")) is bool for account in raw_accounts), "invalid_account_schema")
    connected = [account for account in raw_accounts if account["connected"]]
    accounts = {account.get("id") for account in connected}
    require(accounts and len(accounts) == len(connected) and all(isinstance(account, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", account) for account in accounts), "accounts_not_connected")
    emit("accounts", status="checked", connectedAccounts=len(accounts))

    interface = InterfaceParser()
    interface.feed(client.raw("/")[0].decode("utf-8"))
    require(ELEMENTS <= interface.ids, "missing_mail_interface")
    app = client.raw("/app.mjs")[0]
    module = client.raw("/mail.mjs")[0]
    require(b"createMailView" in app and b"./mail.mjs" in app and b"export function createMailView" in module, "missing_mail_module")
    emit("interface", status="checked", requiredElements=len(ELEMENTS))
    for path in ("/compose.mjs", "/compose.css", "/mail-content.mjs", "/mail-content.css", "/mail-tools.mjs", "/mail-tools.css", "/telegram-settings.mjs", "/controls.mjs", "/controls.css"):
        require(len(client.raw(path)[0]) > 100, "missing_mailbox_asset")
    emit("mailbox_assets", status="checked", assets=8)
    filing_module = client.raw("/filing.mjs")[0]
    require(b"createFilingView" in app and b"export function createFilingView" in filing_module, "missing_filing_module")
    drive = client.json("/api/drive")
    filing = client.json("/api/invoices")
    require(isinstance(drive.get("expectedEmail"), str) and
            (not drive.get("configured") or bool(drive["expectedEmail"])) and
            drive.get("callback") == ORIGIN + "/oauth/drive/callback", "invalid_drive_destination")
    require(type(filing.get("enabled")) is bool and type(filing.get("running")) is bool and
            isinstance(filing.get("recent"), list), "invalid_invoice_status")
    emit("invoice_filing", status="checked", configured=drive.get("configured") is True,
         connected=drive.get("connected") is True, enabled=filing["enabled"], running=filing["running"])

    emit("folders", status="started")
    data = client.json("/api/mail/folders")
    errors = safe_provider_errors(data, accounts)
    folders = data.get("folders")
    require(isinstance(folders, list) and all(isinstance(folder, dict) for folder in folders), "invalid_folders_response")
    require(FOLDERS <= {folder.get("id") for folder in folders}, "missing_unified_folders")
    for folder in folders:
        require(isinstance(folder.get("accountIds"), list) and len(set(folder["accountIds"])) == len(folder["accountIds"])
                and set(folder["accountIds"]) <= accounts, "invalid_folder_accounts")
        counts = folder.get("counts")
        require(isinstance(counts, list) and all(isinstance(count, dict) and count.get("accountId") in accounts and
                (count.get("total") is None or type(count["total"]) is int and count["total"] >= 0) for count in counts), "invalid_folder_counts")
        if folder["id"] in {"inbox", "unread"}:
            require(len(counts) == len(accounts) and all(type(count.get("total")) is int for count in counts), "missing_inbox_counts")
    emit("folders", status="checked", folders=[{"id": folder["id"], "accounts": len(folder["accountIds"]),
         "total": sum(count["total"] for count in folder["counts"]) if all(type(count.get("total")) is int for count in folder["counts"]) else None} for folder in folders], errors=errors)
    require(not errors, "folder_provider_errors")
    require(set(next(folder["accountIds"] for folder in folders if folder["id"] == "inbox")) == accounts, "inbox_missing_accounts")

    for tag in ("coupons", "jobs", "invoices"):
        tagged = client.json("/api/mail/list", "POST", {"folder": "tag:" + tag})
        require(tagged.get("folder") == "tag:" + tag and type(tagged.get("total")) is int and
                tagged.get("totalComplete") is True and isinstance(tagged.get("messages"), list), "invalid_tag_folder")
        require(all(tag in message.get("tags", []) for message in tagged["messages"]), "missing_message_label")
        emit("labels", status="checked", tag=tag, total=tagged["total"])

    messages, cursor, seen = verify_page(client, accounts, 1)
    if not messages:
        require(cursor is None, "empty_page_with_cursor")
        emit("preview", status="skipped_empty_inbox")
        return
    first = messages[0]
    if cursor:
        verify_page(client, accounts, 2, cursor=cursor, seen=seen)
    else:
        emit("inbox", status="second_page_not_available", page=2)

    emit("preview", status="started")
    message = client.json("/api/mail/message", "POST", {"id": first["id"]}).get("message")
    require(isinstance(message, dict) and message.get("id") == first["id"]
            and message.get("accountId") == first["accountId"], "invalid_preview_reference")
    require(isinstance(message.get("body"), str) and all(type(message.get(flag)) is bool for flag in ("truncated", "bodyUnavailable", "unread", "starred")), "invalid_preview_schema")
    emit("preview", status="checked", bodyCharacters=len(message["body"]), truncated=message["truncated"],
         bodyUnavailable=message["bodyUnavailable"], unread=message["unread"], starred=message["starred"],
         readStateUnchanged=message["unread"] == first.get("unread"))


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    client, success = None, False
    try:
        client = Client()
        verify(client)
        success = True
    except AcceptanceError as error:
        emit("verification", status="failed", error=str(error))
    except Exception:
        # Never emit raw JSON parsing errors, filesystem paths, HTTP responses,
        # stack traces, or unexpected server-provided values.
        emit("verification", status="failed", error="unexpected_verification_error")
    finally:
        if client is not None:
            try:
                client.logout()
                emit("session", status="logged_out")
            except Exception:
                success = False
                emit("session", status="logout_failed", error="logout_failed")
    emit("verification", status="passed" if success else "failed", **({"version": VERSION} if success else {"expectedVersion": VERSION}))
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
