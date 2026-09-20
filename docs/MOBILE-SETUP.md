# Account and mobile setup

MailHarbor connects independently to each mailbox. A fresh installation has no predefined account addresses or saved credentials. The optional Thunderbird add-on keeps its own connections in Thunderbird.

## Open the app

Connect your device to the server's tailnet, then open your exact MailHarbor HTTPS origin, for example `https://your-server.your-tailnet.ts.net:9443`. Sign in with your private pairing token or an explicitly allowed Tailscale owner identity. Tailnet membership alone does not grant application access. All accepted users share the same owner's data.

On Android, use the browser's install or Add to Home screen option if available. Keep Tailscale connected. The app requires the server and network; public app assets can be cached, but mail is not available offline. Speech uses available device/browser voices and may pause in the background. Check playback and notification delivery on your actual device.

## Add a mailbox

Open **Settings → Accounts**, select **Add account**, choose a provider and supply your own email address and display label. Multiple accounts of the same provider are supported. Configure a differing IMAP username when required, and use a separate SMTP username/password if your provider requires one. Test the connection and select an existing archive folder before applying archive actions.

| Provider preset | Requirements |
| --- | --- |
| Gmail / Google Workspace | OAuth, or a dedicated app password when your account permits it. Workspace administrators can restrict access. |
| Outlook.com / Hotmail | OAuth; enable IMAP in the mailbox settings. |
| Microsoft 365 / Exchange Online | OAuth; organization policy must permit IMAP and authenticated SMTP. SMTP AUTH may require administrator configuration. |
| Yahoo Mail / AOL Mail | Generate an app password in the provider's account security settings. |
| iCloud Mail | Apple app-specific password. IMAP username can differ from the full SMTP email address. |
| Fastmail | App password and a plan that supports IMAP. |
| Zoho Mail / Zoho business | Enable IMAP and use the exact regional servers shown in your account. Availability depends on plan; two-factor authentication requires an app password. |
| GMX.com / GMX Germany or Europe | Enable IMAP; use an app password when two-factor authentication is enabled. |
| mail.com | An eligible Premium plan and enabled IMAP access. |
| Proton Mail Bridge | A supported paid Proton plan, Bridge running on the MailHarbor server, Bridge-generated credentials, and its exported TLS certificate. |
| Other IMAP / SMTP | Supply your provider's server names, ports, usernames and TLS or STARTTLS mode. |

Presets are configuration defaults, not a promise that every plan or organization permits third-party access. A provider without IMAP/SMTP support cannot be added directly. MailHarbor does not implement POP3, Exchange ActiveSync, or proprietary mailbox APIs.

Provider references: [Google](https://support.google.com/mail/answer/7126229), [Microsoft consumer accounts](https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com), [Microsoft OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth), [Apple](https://support.apple.com/en-us/102525), [Yahoo](https://help.yahoo.com/kb/SLN4075.html), [AOL](https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail), [Fastmail](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports), [Zoho](https://www.zoho.com/mail/help/imap-access.html), [GMX](https://support.gmx.com/pop-imap/imap/server.html), [mail.com](https://support.mail.com/premium/imap/server.html), [Proton Bridge](https://proton.me/support/imap-smtp-and-pop3-setup).

Remote connections require TLS or STARTTLS and certificate verification. Custom remote endpoints use DNS hostnames. The Proton preset permits literal loopback addresses only after explicit local-bridge opt-in, with its exported certificate supplied for trust. Keep Bridge on the server; the phone connects to MailHarbor, not directly to Bridge. Use the ports, username and password shown by Bridge. Do not disable certificate verification or expose Bridge publicly.

## Google OAuth registration

Create your own Google Cloud application and a **Web application** OAuth client. Configure its audience for the intended accounts; use an External audience if you need personal Gmail accounts. Register your exact MailHarbor origin followed by `/oauth/google/callback` as an authorized redirect URI, with no trailing slash.

Save the client ID and secret privately in MailHarbor's Google provider settings. Start Google sign-in separately for each added Gmail account and select the same address you entered. Finish consent in the browser session that started it. Gmail IMAP/SMTP requires the full mail scope `https://mail.google.com/`. See [Google's OAuth protocol](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol).

Testing audiences, consent verification, token expiry, and Workspace policies can affect access. Review [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration) when planning unattended operation. A Google app password is a separate supported option only when offered by the account; do not weaken account protection to enable it. See [app passwords](https://support.google.com/accounts/answer/185833).

## Microsoft OAuth registration

Register your own application in Microsoft Entra with supported account types covering your intended personal and/or organization accounts. MailHarbor uses the `common` authority. Add a **Web** redirect URI using your exact MailHarbor origin followed by `/oauth/microsoft/callback`.

Use delegated `https://outlook.office.com/IMAP.AccessAsUser.All`, `https://outlook.office.com/SMTP.Send`, and `offline_access` permissions as requested by MailHarbor. This is user mailbox authorization, not Microsoft Graph `Mail.Read` or application-only access. Organization consent and SMTP policy can still block a connection.

Create a client secret, enter its value directly in MailHarbor, and keep its expiry date in your private password manager. Select Microsoft sign-in for the added mailbox and complete consent in the same browser session. Renew consent if a prior connection lacks outgoing-mail permission. See [Microsoft registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) and [IMAP/SMTP OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth).

## Credentials and daily use

Mailbox passwords, refresh tokens, and provider client secrets are saved in the encrypted server account store. Its key is stored separately under the same service account; this does not protect against someone controlling that account. Do not share credentials, real addresses, mail content, screenshots, or runtime stores in public support requests.

Agy authorization enables AI features and is separate from mailbox OAuth. Briefings choose up to the newest 40 unread messages across selected accounts; the batch count is not a full mailbox total. Scanning preserves read state. Review and explicitly apply briefing actions; incomplete, encrypted, or unavailable bodies cannot authorize briefing archive actions.

Disconnecting removes the local MailHarbor connection, not the mailbox. To revoke the underlying grant, use the provider's account security page or revoke its app password. See [maintenance](MAINTENANCE.md), [privacy boundaries](../SECURITY.md), and [mailbox limits](MAILBOX-GAPS.md).
