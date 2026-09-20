# Maintenance

Record your own OAuth client secret expiry dates privately in a password manager. This repository contains no tenant identifiers, secret expiry schedule, or reminders for a particular deployment.

## OAuth secret rotation

Create a replacement secret in the provider registration, enter it directly in MailHarbor's provider settings, and reconnect when required. Check token refresh and a read-only folder listing before revoking the previous secret. Update your private expiry reminder. Do not place either secret in command lines, chat, screenshots, support logs, or source files.

Use the same procedure for a dedicated Google Drive registration. Changing the expected Drive identity clears the saved connection and upload allocations so files cannot be routed using another account's state.

## Routine operation

Keep Node.js, dependencies, the operating system, and Agy current. Review the dedicated Agy executable/profile pin after upgrades and confirm the profile still denies tools and paid overages. Check the Linux keyring and user service after reboot.

Back up encrypted durable state together with its matching key into private encrypted storage. Inspect available disk space, pending review items, provider connection status, and quota cooldowns. Do not reset durable move or send journals to force retries of uncertain operations.

Revoke unused application grants and app passwords. Review local retention of Agy state and private backups. See [deployment and rollback](DEPLOYMENT.md) and [cache recovery](MAIL-EXPERIENCE-IMPLEMENTATION.md).
