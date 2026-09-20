# Private Linux deployment

The public repository contains source and fictional examples. Supply your own deployment host, service account, HTTPS origin, account identities, OAuth registrations, and storage destinations. There is no preconfigured installation.

## Install

Follow the commands in [README.md](../README.md) under a dedicated non-root Linux account. Keep configuration in `~/.config/mailharbor` and Agy state in `~/.local/share/mailharbor`, outside the checkout. Setup creates the pairing token and an isolated Agy profile; complete its interactive login as the same service account.

The Node service binds `127.0.0.1:8765`. Expose it with Tailscale Serve at your chosen HTTPS port, preserve unrelated Serve entries, and set `web.origin` to the exact HTTPS certificate hostname and port. Keep `allowedTailscaleLogins` empty for token-only access, or list explicitly permitted owner identities. All sessions access one owner's data. Local host processes are trusted at the Serve proxy boundary.

Register OAuth callbacks using this exact origin and the paths `/oauth/google/callback`, `/oauth/microsoft/callback`, and, if needed, `/oauth/drive/callback`. Add your own accounts through the app; provider credentials are not imported from Thunderbird.

## Verify your installation

Run synthetic tests before installation. After installing, check service readiness, keyring access after restart, HTTPS sign-in, one configured mailbox's folder listing, and sign-out. Review provider requirements in [MOBILE-SETUP.md](MOBILE-SETUP.md).

Use synthetic mail or a dedicated test mailbox when checking SMTP, archive, folder moves, and permanent deletion. Observe the provider after each action; an API success alone does not prove the intended delivery or mailbox state. Validate phone speech and push delivery on each intended device. Real-account tests can change mailbox state and should be undertaken deliberately by the operator.

AI features need their own Agy authorization. Manual browsing does not submit messages to AI. Enable automatic organization, invoice uploads, or Telegram alerts only after reviewing their destinations and effects. Begin with organization preview and bounded action limits.

## Releases and rollback

Run `python scripts/deploy-release.py --help` for the deployment helper's current options. Deployment destinations and credentials belong in local private configuration. Inspect the exact source archive before transferring it; exclude state, private configuration, backups, logs, caches, and repository history.

Before an update, stop the service and make a private backup of configuration, the encrypted account store, its matching key, durable SQLite data and sidecars, and Agy state. Preserve a known-good release. Follow the deployment helper's documented validation before activation.

After an update, verify the process, authenticated UI, state compatibility, and selected provider operations. Monitor sanitized failure codes and storage use without publishing mail-derived details. Record operational evidence privately outside the source tree.

Restoring code or a database does not undo mail already sent, moved, or deleted. Older code may not understand newer owner decisions, retry metadata, or journals; keep automatic processing paused until compatibility is established. Disposable browsing cache can be rebuilt separately; do not discard durable organizer state or encryption keys.

To stop MailHarbor, use `systemctl --user stop mailharbor.service`. Remove only the corresponding Tailscale Serve mapping when retiring access. Revoke provider grants and app passwords when decommissioning the installation.
