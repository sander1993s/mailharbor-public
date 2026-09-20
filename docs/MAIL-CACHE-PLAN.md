# Homeserver mail cache plan

Draft, 19 September 2026. Planning only; no application or homeserver changes have been made.

Serve recent mail from encrypted homeserver storage immediately, then synchronize with the original providers in the background. The homeserver remains necessary to browse mail; this does not introduce browser offline mail.

## Proposed defaults

| Setting | Starting value |
| --- | --- |
| X | 500 recent Inbox messages **per account**, read and unread |
| Initial coverage | Unified Inbox and account Inbox views; other folders remain available through the existing provider path |
| Meaning of recent | Existing date order: message Date, falling back to INTERNALDATE, with deterministic ties; UID is an identity/change cursor, not date order |
| Cached content | List metadata, flags, folder membership, attachment descriptions, complete plain text and sanitized HTML when within the cache limits |
| Background refresh | Every 60 seconds while enabled, including when every browser is closed |
| Body budget | 512 MiB total, with a 2 MiB admission limit per message's combined rendered content |
| Attachments | Download on demand; do not prefetch attachment files, full EML sources, or inline images in the first release |

Make X configurable in Settings, initially allowing 100–5,000 per account. X bounds retained Inbox metadata; the separate byte budget bounds bodies. When bodies exceed either budget, retain their headers and show that the content requires a provider fetch. Never present a truncated preview as complete mail. Existing larger-message reading/export limits remain available on demand.

For example, two accounts with X=500 can retain 1,000 Inbox entries. At an illustrative 100 KiB of rendered content each, bodies occupy about 98 MiB before database overhead. Measure actual usage rather than promising that estimate. Display cached-header count, ready-body count, bytes, and per-account last successful refresh. Expanding to selected additional folders is a later setting with explicit quotas; do not silently multiply X by every provider folder.

## Why the current path can be slow

These are source-code findings, not timings measured on the homeserver:

- `web/mail.mjs` waits for `/api/mail/folders` before `/api/mail/list`. `server/mail-reader.mjs` discovers folders and requests their counts, then separately searches/fetches list headers. The unified response awaits the selected accounts, including slow accounts.
- Each `createMailboxSession` operation in `server/mailboxes.mjs` connects a new IMAP client and closes it afterward. Repeated browsing repeats connection and authentication overhead.
- Opening mail first requests a bounded preview, then `web/mail-content.mjs` requests full content. `server/mail-content.mjs` fetches and parses the full source on every request. `reader.source()` downloads it in sequential 64 KiB chunks, including attachment bytes.
- `server/mail-index.mjs` already provides encrypted SQLite records for metadata and organizer state, but explicitly excludes bodies. The existing notification watcher only checks Inbox status while a browser is watching or a push subscription exists.

## Design

### 1. Separate, disposable encrypted storage

Add `server/mail-cache.mjs` with a dedicated `mail-cache.sqlite` under the private web state directory. Reuse the existing AES-256-GCM/key-derivation approach with a distinct cache key context; keep subjects, addresses, bodies, folder paths, and provider references encrypted. Use opaque keyed identifiers for lookups, bounded SQLite transactions, and the existing private directory/file permissions. Document the limited unencrypted operational indexes, such as timestamps and sizes. Do not put bodies into the organizer's durable decision database.

Store account identity/generation, folder UIDVALIDITY, UID, existing fingerprint, dates, mutable flags/labels, body completeness, renderer version, and sync checkpoints. Namespace by account and connected mailbox identity, not just an account preset ID. Keep folder membership separate from content reuse; never merge generic IMAP copies by Message-ID or fingerprint alone. The existing fingerprint covers envelope metadata and size, not message bytes. Gmail alias reuse, if added, must use a verified provider message identity.

Keep public message references and pagination tokens short-lived. A cached list response registers references through `createMailApi` just as a live response does; persistent rows must not become permanent action tokens. Reloading a list after restart recreates valid references.

Corruption or a failed cache migration falls back to the existing provider path and offers cache rebuild. Disconnecting/forgetting an account immediately stops access and removes its cached rows. Reconnecting requires identity validation and invalidates old access generations. “Clear cache” removes only disposable cache data, never mail, labels, credentials, or organizer decisions. Do not persist private keys, passphrases, or decrypted OpenPGP/S/MIME content.

### 2. Serve available mail without waiting for refresh

Add a cache-aware browsing layer at `server/mail-api.mjs` and `server/mail-content.mjs`, wired in `server/web-app.mjs`. Keep the underlying provider reader available for misses and verified writes; do not globally replace it for organizer or invoice workflows.

- Return a cached first page of 50 messages and cached folder metadata immediately. Include cache coverage, last successful sync, and per-account errors. A slow provider cannot delay another account's cached messages.
- Decouple folder/count loading from list rendering in `web/mail.mjs`. Show unknown or dated counts while refreshing; cached item count is not the provider mailbox total.
- Render a cached body immediately through the existing safe rendering rules. Eliminate the preview-then-full-source round trip for cache hits. On a miss, fetch the requested content with priority and populate the cache only if it meets the admission rules.
- Show “Updated … ago”, “Refreshing”, or an account reconnect error while keeping available mail readable. Cold startup shows progressive warming; it must not wait for all X bodies before displaying the first headers.
- Background changes produce a cache revision that the existing browser updates flow can observe. Keep the current message and scroll position stable; advertise new mail without resetting the reader.

Warm cache reads perform **zero synchronous provider calls**. Authentication, account-generation checks, reference expiry, and authorization remain mandatory locally. Stale data may be displayed with its timestamp; stale data does not authorize a mailbox mutation.

### 3. Keep it warm with bounded synchronization

Add `server/mail-sync.mjs` inside the existing service. Start after account/storage initialization and stop cleanly with the service. Run one sync per account at a time, initially at most two accounts concurrently; use bounded batches and prioritize foreground requests over body prefetch. Coalesce duplicate refresh requests. Coordinate connection budgets and writes with organizer and label-sync activity.

First fetch/cache the newest 50 headers per account, publish that progress, then fill to X and prefetch text bodies. Reuse the reader's date-window approach and ordering guarantees. Do not implement latest-by-date as simply the highest X UIDs. If an exact date window cannot yet be established within a batch, report partial warming and continue with a checkpoint. Use one account/folder session for multiple fetches rather than calling the existing single-message reader X times.

Introduce a complete plain/HTML MIME-part reader with explicit encoded/decoded byte limits and completeness checks, preserving read flags, attachment part IDs, and the existing content response fields. The current `reader.read()` uses bounded preview limits and cannot supply complete cached bodies. Fetch those text parts instead of downloading complete attachment-bearing messages just to display text. Apply the existing sanitization rules before rendering; store a renderer version so security-related renderer changes invalidate older cached HTML. Keep remote content blocked and inline images on demand initially. Encrypted messages retain their encrypted indicator and request-only decrypt flow; their decrypted content is never admitted to the cache.

For refreshes:

1. Track UIDVALIDITY, new-UID checkpoints, and modification sequence where supported. Fetch new arrivals and changed metadata in batches; commit checkpoints only with the corresponding successful data writes.
2. Use CONDSTORE/`changedSince` when advertised. The installed ImapFlow 2.0.0 types and [official fetching guide](https://imapflow.com/docs/guides/fetching-messages/) expose this facility. Treat it as a capability-dependent optimization.
3. Reconcile cached UID membership and flags even if total/unread counts are unchanged. On servers without suitable change tracking, poll flags/membership for the bounded cached set each cycle and periodically rebuild the date window, initially every five minutes. This catches external moves, deletions, equal-count changes, and refill needs. UIDVALIDITY changes invalidate the affected folder and rebuild it.
4. Feed the same sync results into notifications and browser revisions, avoiding an independent duplicate Inbox poller. Account failures use backoff with jitter; keep healthy accounts updating. Expose failed attempts separately from the last successful sync.

Trim older metadata beyond X after successful reconciliation, and evict bodies oldest-first under the byte budget. Account removal, confirmed deletion, and changed identity take precedence over retention. Bound database/WAL growth and temporary buffers as well as body payloads; monitor actual disk space and stop prefetch safely on disk pressure. Connection pooling/IDLE can be evaluated after the cache is effective; neither is required for the first release.

### 4. Preserve mailbox correctness

All writes still validate the live account, UIDVALIDITY, UID, fingerprint, and relevant current mailbox state. Keep the existing processing write coordination. Update or invalidate affected cache records only after confirmed provider success; ambiguous outcomes trigger reconciliation and are not reported as successful changes.

Add targeted change hooks for flags, archive/move/delete, Undo, empty Trash, provider labels, folder rename, draft save/send, background organizer actions, and category filing. `mail-label-sync.mjs` already has a `changed(account.id)` callback that can be wired into this work. Refresh affected source/destination folders and category views; a callback only in the manual mail API would miss background changes.

Use per-account/folder mutation generations and deletion tombstones so an older in-flight sync/read cannot resurrect deleted mail or overwrite newer flags. Preserve verified UID mappings on moves; otherwise invalidate the location and reconcile. If a provider mutation succeeds but persisting its cache update/invalidation fails, stop serving the affected cache namespace and use provider fallback until reconciled. Require reconciliation before reuse after an unclean shutdown so restart cannot expose older rows from that failure. Avoid aborting unrelated open messages when a background action changes another item.

### 5. Keep coverage and older-mail behavior explicit

Cached newest-first Inbox pages use a stable snapshot and deterministic ordering. Freeze arrival bounds per folder/account for pagination; when continuing beyond the cached window, use a compatible provider continuation and deduplicate by verified identity. Never claim the mailbox ends at X. If a snapshot cannot continue safely, refresh it explicitly rather than silently skipping messages.

Unread filters can exhaust the cached window while older unread mail exists. Uncached folders, full-history searches, body searches, alternate sorts, and other queries without complete cache coverage continue through the provider path. Any optional “search cached mail” mode must label its limited scope. Existing category views continue to use the durable label index and live/cache decorations without treating cached headers as new category decisions.

Authenticated responses retain `Cache-Control: no-store`; the service worker continues caching only public app assets. Browsing/prefetch does not submit email to AI.

## Implementation and verification sequence

1. **Measure the baseline.** Add privacy-safe timings for folder discovery/counts, connection/authentication, list search/fetch, preview, source download, parse, and first visible mail. Record per-account durations and bytes without subjects, addresses, or bodies.
2. **Deliver list caching.** Implement encrypted storage, configuration, bounded header synchronization, cached folder metadata, pagination boundaries, and independent UI loading. Verify restart persistence and slow-account isolation.
3. **Deliver body caching.** Implement bounded MIME-part prefetch, content admission/eviction, versioned rendering, cache-aware preview/full-content routes, and clear cold/miss/oversize states.
4. **Integrate every writer and notifications.** Exercise foreground/background mutations, external client changes, account reconnects, and races before enabling by default. This is part of the release, not optional cleanup.
5. **Roll out on the homeserver.** Update `CONTRACT.md`, `README.md`, and mailbox/deployment documentation to describe persisted browsing content, coverage, settings, and recovery. Behind a feature flag, warm 100 messages on one account, inspect timings/storage/provider load, then increase to 500 across all accounts. Disabling the feature returns to the provider path; retain the separate cache only until explicitly cleared or rebuilt.

Acceptance targets, to measure rather than assume:

- Warm first-page and cached-body API responses each have p95 under 200 ms on the homeserver; first useful display under one second on the normal Tailscale connection, with client/network time reported separately.
- A warm cache remains available after service restart and during provider timeout. A healthy account's new Inbox mail appears within about 90 seconds under normal load; fallback external-change reconciliation completes within five minutes.
- Synthetic tests cover cold/warm/partial caches, out-of-order dates versus UIDs, restart, cache/provider pagination without duplicates or gaps, false-complete search/counts, UIDVALIDITY reset, same-count external changes, account replacement, mutation races, encrypted payloads, malicious HTML, body/disk limits, interrupted writes, and corruption fallback.
- Integration tests prove cache hits cause no IMAP call, prefetch does not mark mail read, old sync work cannot undo confirmed writes, no plaintext mail leaks into the cache database/WAL/temp files, and browser API caching remains disabled. Existing mail, rendering, mutation, processing, label-sync, and service-worker suites continue to pass.

The first release is complete when both list loading and ordinary message opening meet these checks with 500 cached Inbox entries per account, with transparent provider fallback wherever coverage or body limits require it.
