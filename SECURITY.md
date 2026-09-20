# Security and privacy

MailHarbor handles private email. Run it under a dedicated non-root account, keep its state outside the source checkout, and expose it only through the documented private HTTPS boundary. It is a single-owner service, not a public multi-tenant email server.

## Report a vulnerability

Use the repository's **Security → Report a vulnerability** option when available. Do not publish credentials, mailbox addresses, real messages, account-store files, or exploitable deployment details in a public issue. If private reporting is unavailable, open an issue requesting a private contact channel without disclosing vulnerability details or personal data.

Include the affected version, a description of impact, and a minimal reproduction using fictional addresses such as `person@example.com`. Maintainers should coordinate a fix and disclosure before publishing sensitive details.

## Data boundaries

- Mailbox access uses each owner's authorized account. Passwords, OAuth registrations, and tokens are stored encrypted on the server and are not returned to the browser after saving.
- A local encryption key protects data at rest only when the key remains separate from exposed ciphertext. The service account can decrypt its own state; host compromise defeats that boundary.
- Browser sessions use HttpOnly cookies, an exact configured origin, and CSRF checks. Tailscale sign-in also trusts local processes at the loopback proxy boundary.
- Public application assets may be cached in the browser. Mail and authenticated API responses are not service-worker cached.
- AI briefings and organization send bounded email text to Google through Agy when enabled. Browsing and manual mailbox actions do not. Agy's profile can contain sensitive state or transcripts.
- Invoice filing uploads selected original documents to the configured Google Drive. Optional inquiry alerts send summaries to the configured Telegram destination. Disable these workflows if that transfer is unwanted.
- HTML rendering blocks executable content and remote resources. Request-only decryption keys are not retained. Cryptographic signatures are not verified by the reader.
- Provider mutations revalidate message identity. Uncertain SMTP sends are not automatically retried, and permanent deletion requires explicit confirmation.

## Keep private state out of Git

Never commit `.env` files, pairing tokens, configuration from a real deployment, OAuth secrets, app passwords, private keys, account stores, SQLite databases or sidecars, backups, mail exports, attachments, screenshots of real mail, provider responses, or AI transcripts. Ignoring a file does not remove it from existing commits.

Use reserved example domains and synthetic mail in tests and documentation. Inspect staged changes, generated archives, and history before publishing. Removing a secret from the current file is insufficient if it was already shared: revoke or rotate it and address all published copies.

Back up encrypted state and its matching key together into a private encrypted backup. Restoring local state cannot undo email already sent or provider-side moves and deletions. Revoke provider grants and app passwords when retiring an installation.
