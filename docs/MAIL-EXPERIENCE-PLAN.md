# Mail experience design

This guide describes product goals and validation journeys using synthetic mail. It contains no screenshots, samples, or observations from a personal mailbox.

## Reading and navigation

Keep useful rows and the open message visible while a replacement request loads. Cancel stale requests and preserve focus, scroll, and selection where valid. Surface partial provider results and retryable errors. Search and advanced filters must submit the same visible query.

Use a compact reader toolbar, accessible menus, expandable quoted text, and account-separated conversation groups. Display coverage limits when scans or loaded pages are incomplete. Device sizes, keyboard behavior, and touch targets require explicit checks.

## Attachments and composition

Place attachments after the body with file metadata, preview controls, and downloads. Clearly distinguish unsupported previews from a missing attachment. Keep remote content blocked and enforce MIME, decompression, and byte limits.

Compose should preserve recoverable drafts while changing views. Validate recipients, keep safe rich text and a plain alternative, and expose autosave progress. Review before sending; uncertain delivery must remain locked against automatic resend.

## Performance and storage

The encrypted homeserver cache serves bounded recent Inbox content. Show coverage and refresh status, retain provider fallback, and make access to older mail explicit. Cache hits never authorize mutations; those always require current provider identity checks. Authenticated mail remains outside browser offline storage.

## Synthetic acceptance journeys

- Search, change filters, cancel loading, and recover from one failed account.
- Open long HTML and plain mail, inspect quoted conversations, and load an allowed CID image explicitly.
- Preview and download supported attachments; reject oversized or malformed files.
- Compose, switch views, reload recovered draft, review, and exercise uncertain delivery recovery.
- Change a message while an older sync is running and verify stale results cannot resurrect deleted content.

See [implemented limits and recovery](MAIL-EXPERIENCE-IMPLEMENTATION.md) and [mailbox capabilities](MAILBOX-GAPS.md).
