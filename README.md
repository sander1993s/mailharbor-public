# MailHarbor

MailHarbor is a self-hosted email app for browsing multiple mailboxes, composing mail, reviewing AI briefings, and organizing messages from a phone or desktop browser. An optional Thunderbird add-on shares the briefing service.

This is a single-owner application. A new installation has no connected email accounts, owner identities, or private deployment settings. Add your own accounts and credentials through the application. All examples in this repository are fictional.

## Features

- Unified Inbox, provider folders, search, conversations, shared categories, and bulk actions.
- Plain text and sanitized HTML reading, attachment previews and downloads, and explicit source export.
- Compose, reply, forward, provider drafts, encrypted draft recovery, and review before sending.
- Optional AI briefings and organization through a separately authorized Agy CLI session. Ordinary browsing and manual actions do not send mail to AI.
- Optional encrypted server-side Inbox cache. The browser does not store an offline mailbox.
- Optional invoice filing to your Google Drive and business-inquiry summaries to your configured Telegram destination.
- Private HTTPS access through Tailscale Serve, with a pairing token or explicitly allowed Tailscale identity.

Mailbox changes affect the original provider. Archive retains mail; permanent deletion requires explicit confirmation. Provider capabilities, plan restrictions, and administrator policies can limit available features.

## Add email accounts

Open **Settings → Accounts**, add an account, choose a provider, enter your own email address and label, and connect it. Multiple accounts from the same provider are supported. A custom IMAP/SMTP connection covers compatible providers without a built-in preset.

Google and Microsoft use your own OAuth application registrations. Providers offering app passwords require a dedicated app password when their security policy requires one. Provider passwords and OAuth secrets are saved only in the encrypted local account store.

See [account setup and provider requirements](docs/MOBILE-SETUP.md). A preset supplies connection defaults; it does not bypass a provider's subscription, IMAP, SMTP, consent, or administrator requirements. Services without standards-based IMAP/SMTP access require a compatible bridge or are unsupported.

## Install on Linux

Requirements:

- Node.js **22.13 or newer** and npm.
- Linux with a non-root service account and a user systemd session.
- Tailscale on the server and client devices for the documented private deployment.
- A supported Agy installation and Google authorization for AI features. Agy's Linux login may require an unlocked Secret Service keyring and a working D-Bus session.
- Python 3 for packaging and deployment helpers. Thunderbird 140 or later is needed only for the optional add-on.

From a checkout under the service account:

```sh
npm ci --omit=dev --ignore-scripts
node scripts/setup.mjs /absolute/path/to/agy
node scripts/login.mjs
node scripts/install-service.mjs
systemctl --user daemon-reload
systemctl --user enable --now mailharbor.service
```

Setup creates private configuration, a pairing token, and an isolated Agy home. It copies runtime assets, not an existing user's settings, credentials, or conversation history. Complete Agy's interactive Google login in the dedicated profile. Setup preserves existing files.

The service listens on `127.0.0.1:8765`. Choose an unused tailnet HTTPS port:

```sh
tailscale serve --bg --https=9443 http://127.0.0.1:8765
```

Add this `web` section to `~/.config/mailharbor/config.json`, preserving the generated fields and replacing the example origin with your server's exact Tailscale HTTPS origin:

```json
{
  "web": {
    "origin": "https://your-server.your-tailnet.ts.net:9443",
    "allowedTailscaleLogins": []
  }
}
```

Restart MailHarbor, open that origin, and sign in with the token in `~/.config/mailharbor/pairing-token`. Optionally populate `allowedTailscaleLogins` with your own permitted owner identities. Use the HTTPS certificate hostname consistently. Do not expose the loopback service directly or use Tailscale Funnel for this deployment.

Tailscale sign-in trusts the local proxy boundary and local host processes. All accepted identities access the same owner's data; tailnet membership alone does not grant application access. See [deployment and rollback](docs/DEPLOYMENT.md).

## Optional Thunderbird add-on

1. Configure your email accounts and archive destinations in Thunderbird.
2. Run `npm run package` and install the generated `.xpi` through Thunderbird's **Install Add-on From File** menu.
3. In MailHarbor's add-on settings, enter your server HTTPS origin and pairing token, select accounts, and save.
4. Request a briefing and review its proposed actions before applying them.

The add-on retains its mailbox access in Thunderbird. The browser app has independent server-side connections; Thunderbird credentials and tokens are never imported.

## Privacy and data storage

Mailbox credentials, provider client secrets, refresh tokens, draft recoveries, labels, and selected workflow state are stored encrypted on the server. The default web state directory is `~/.config/mailharbor/web`. AES-256-GCM encryption uses a separate local key: anyone able to read both the key and ciphertext can decrypt the data. Protect the service account and its backups.

Briefings and organization send selected sender, account label, subject, date, and bounded plain message text to Google through Agy when you enable those workflows. Attachments and encrypted bodies are excluded from AI briefing input. Agy may retain provider state or transcripts inside `~/.local/share/mailharbor/agy-home`; treat that directory as email-sensitive. This is not entirely local AI processing.

Invoice parsing occurs locally; enabled filing uploads matched original documents to your configured Google Drive. Enabled Telegram summaries send approved inquiry summaries to your selected destination. Optional Web Push uses generic alerts without sender, subject, or body. Device speech uses the browser's available voices.

Authenticated responses use `Cache-Control: no-store`. The service worker caches only public application assets. The optional server cache stores encrypted recent Inbox headers and complete bounded message bodies, while the durable organizer index stores encrypted metadata and decisions. Draft recovery can retain attachment bytes. Briefing results expire from server memory after at most 15 minutes or a restart. See [security and vulnerability reporting](SECURITY.md) and [storage/recovery details](docs/MAIL-EXPERIENCE-IMPLEMENTATION.md).

Agy runs with tools denied, no MCP or custom plugins, a fresh scratch directory per request, and validated structured output. A separate Linux user or VM gives stronger isolation from unrelated host data. Automatic paid overages and model substitution are disabled in the dedicated profile. Authentication and quota failures pause affected work; persisted cooldowns survive restart.

## Develop and verify

```sh
npm ci --ignore-scripts
npm test
node tests/fixtures/web-preview.mjs
```

The preview prints a loopback URL and uses fictional messages without connecting to providers. Tests use synthetic fixtures and fake provider/CLI implementations. A passing synthetic suite does not establish live compatibility with every provider or device.

```sh
npm run package
python scripts/deploy-release.py --help
```

Packaging writes source and add-on archives to `artifacts/`, includes only tracked files, and runs the privacy gate. Stage reviewed new source files before packaging. Run `python scripts/privacy-scan.py --history` before publication; CI also scans all fetched history. The scanner checks common secret patterns, non-example email addresses, runtime files, and linked files. It supplements human review and cannot prove that arbitrary content contains no private data.

Deployment settings belong in local private configuration, never source files. Inspect the exact release files and archive contents for secrets, private addresses, mail content, local paths, and operational logs. Do not publish runtime stores, backups, or an unaudited Git history.

See [CONTRIBUTING.md](CONTRIBUTING.md), the [API contract](CONTRACT.md), [mailbox features and limits](docs/MAILBOX-GAPS.md), [organization rules](docs/PROCESSING.md), and [invoice filing](docs/INVOICES.md).

## License

MailHarbor is released under the [MIT License](LICENSE). Dependencies retain their own licenses.
