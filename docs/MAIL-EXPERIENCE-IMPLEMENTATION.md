# Mail experience implementation

This document describes implemented contracts and operating limits. Provider compatibility and performance require validation in your own installation; no private deployment results are included.

## Reading, search and attachments

Main search and Advanced Apply submit the visible phrase and filters together. Cancellable loading retains useful content and list context, with retry and per-account errors. Default/compact density and split/full-width reading preferences support different screens. Rows show attachment filenames when metadata is available and snippets when complete bodies are cached. Reader details, triage actions and end-of-message reply controls reduce repeated navigation.

Verified conversations collect related Inbox, Sent and other-folder messages across pages within one account. Provider scans are bounded and report partial coverage. Quoted text folds into expandable details. Replies can be composed inline, preserving the editor and autosave state when returning to the docked composer. Opening mail preserves read state by default; automatic mark-as-read is an explicit preference.

Attachments sit below the body with readable type, filename and size, a header jump/count, and Download all. PDF, image, text and Office text previews use an overlay with file navigation, Close/Escape and focus return. Unsupported files remain downloadable. Bounds reject oversized requests or make previews unavailable; partial content is not represented as complete.

HTML keeps vetted typography, colors, spacing and table styling in an isolated, script-disabled frame. Remote resources and executable content remain blocked. Ordinary reading fetches complete bounded MIME text parts without downloading attachments or the whole EML. Renderer version `2` excludes older sanitized bodies from the cache. Normal rendering strips sender `data:image` URLs.

**Load embedded images** explicitly re-reads provider HTML and fetches verified PNG, JPEG, GIF, WebP or AVIF CID parts. These images are transient and bypass the cache; remote images remain blocked. Request-only OpenPGP/RSA S/MIME decryption is also excluded from caching. Signatures are not verified.

## Enable the homeserver cache

Caching is disabled by default and remains opt-in after deployment; this note does not establish the production setting. To enable it, merge this setting into the existing `web` object in `~/.config/mailharbor/config.json`, preserving its other fields, then restart only MailHarbor:

```json
"mailCache": { "enabled": true }
```

The setting is `config.web.mailCache.enabled`. Settings controls the recent Inbox header cap, from 100 to 5,000, default 500. The same cap applies to every connected account; there is no per-account cache enable switch. It persists in the encrypted account store. The API provides:

- `GET /api/mail/cache`: counts, bytes, coverage, sync timestamps and errors.
- `POST /api/mail/cache` with `{"maxHeadersPerAccount":500}`: change the cap.
- `POST /api/mail/cache/clear` with `{}`: clear disposable browsing data.

The cache serves the simplest recent Inbox view in newest-date order. Queries, filters, other folders and sorts use the provider. **Browse older mail** restarts live provider paging from the newest messages, allowing access beyond the cached window; previously viewed messages can appear again. Expired cached cursors require a refresh.

Warm list/body hits perform no synchronous provider queries. Cold or missing content falls back to the provider. Background sync runs while the browser is closed, normally every 60 seconds, with at most two account jobs and one per account. It publishes the first 50 verified headers before filling the cap and prefetching complete bodies. Same-count membership and flag changes are reconciled. Failed accounts back off independently while healthy cached accounts remain readable. Coverage, refreshing state, last success and errors distinguish warming from complete results. Folder counts come from the provider. Notifications reuse verified sync Inbox status when enabled; the existing provider watcher takes over if the cache becomes unavailable during operation.

## Storage and recovery

`mail-cache.sqlite` lives in the private web state directory, normally `~/.config/mailharbor/web`, alongside `accounts.key` and encrypted `accounts.enc`. It uses AES-256-GCM and a distinct cache key derivation context. Envelopes, subjects, addresses, bodies, paths and provider references are encrypted; operational IDs, timestamps, flags, sizes and counts may remain visible. Protect the key, state directory and backups. Bodies do not enter the durable organizer decision index.

Header retention and body limits are separate. Bodies are evicted oldest first. SQLite headers, indexes, WAL and other overhead mean disk usage can exceed the body payload budget. Attachments, images, raw EML, private keys and decrypted mail are excluded from this browsing cache. Downloads remain provider operations. Authenticated API responses use `Cache-Control: no-store`; the service worker caches public assets only, with no offline browser mail.

Account identity/revision, UIDVALIDITY and fingerprints guard cache admission. Persistent mutation barriers invalidate an account's cache before provider writes and remain active through completion. Live provider verification remains required. Ambiguous failures require reconciliation, with no automatic mutation retry. Clear preserves active barriers. An unclean restart requires reconciliation before retained rows are served; disconnecting or forgetting an account removes its cache records.

Normal Clear cache removes browsing data and starts warming again if enabled. It preserves account credentials, compose recoveries, organizer decisions and provider mail. Disabling the feature requires a service restart and can retain the encrypted cache until cleared.

An unavailable or physically corrupted cache falls back to the provider. **Clear cache cannot recreate a damaged SQLite file.** For manual recovery, stop MailHarbor, remove only `mail-cache.sqlite`, `mail-cache.sqlite-wal` and `mail-cache.sqlite-shm` from the configured private web state directory, then restart. Preserve `accounts.key`, `accounts.enc` and all durable organizer data.

## Compose recovery

Autosave waits 750 ms, then stores draft recovery in `accounts.enc`, using recovery revisions and idempotency guards. Saving/Saved/Retry states expose progress. Reload recovery includes recipients, subject, plain/sanitized HTML, files, thread headers and provider draft ID. Account revision is a separate stale-identity guard. Explicit provider Save draft still uses IMAP and is separate from local recovery.

Recipients use validated chips and identity suggestions. Rich text has a safe formatting allowlist and plain-text alternative. Signatures are editable/insertable per account. Picker, drop and pasted images add file attachments; pasted images do not become inline CID content. Recovery attachment bytes persist in the encrypted account store, distinct from the attachment-free browsing cache.

Before SMTP, a durable single-attempt ledger and recovery lock are written. Uncertain/partial sends remain locked across restart and are not automatically resent. Review then Send remains a two-step action. Fourteen-day expiry applies only to unlocked recoveries.

| Limit | Boundary |
| --- | --- |
| Recent Inbox headers | Default 500 per account; configurable 100–5,000 |
| Cached body payload | 512 MiB total; 2 MiB per complete admitted body |
| Demand body / source | 8 MiB rendered content / 160 MiB EML |
| Embedded images | 2 MiB each; 8 MiB total; 10 raster parts |
| Download / ZIP | 100 MiB per file / 100 MiB combined |
| Office preview | 25 MiB input; 32 MiB extracted XML |
| Compose recovery | 50 records and 50 MiB serialized aggregate |
| Compose attachments | 50 files and 25 MiB combined per draft |
| Compose request / text | 36 MiB; 200,000 plain / 400,000 HTML characters |
| Account signature | 10,000 plain-text characters |

## Rollout checks

Start with synthetic journeys and a global cap of 100, then increase to 500 after inspecting coverage, errors, disk usage and provider load. Check provider fallback and older-mail navigation, account replacement, writes, notifications, HTML/attachments, conversations and draft recovery. Live checks require separate authorization. Targets below 200 ms for warm API responses and one second for useful display require actual homeserver/network measurement; they are not production results.
