# Invoice filing

Invoice filing is optional and starts disabled with no business identities or Google Drive account configured. Open **Settings → Accounts → Invoice filing**, add your own businesses, and connect your own Drive.

## Configure businesses

Under **Invoice folders**, add a business name and customer VAT number. An exact customer name can be configured when VAT is unavailable; it is used only for a business without a configured VAT. Up to 20 businesses are supported, each with a unique internal ID. Blank or unrecognized identities never authorize an upload.

The current text parser recognizes Belgian VAT formatting and Dutch/English invoice labels. Other document formats or unsupported identifiers need review. Do not assume international tax-document coverage. The invoice date determines year and quarter; the supplier's VAT, email recipient, due date, and filename do not determine the business destination.

Ready documents are filed under `Invoices / configured business name / YYYY / Q1–Q4`. Missing, conflicting, or ambiguous customer/date evidence remains in **Needs review**. Credit notes use the same routing. Proformas, order confirmations, and payment requests are excluded. The settings API is `POST /api/invoices/settings` with `enabled` and/or `entities: [{id,label,vat,names}]`; settings are stored encrypted. Changing businesses while a scan is running is rejected.

## Connect Google Drive

1. Create your own Google **Web application** OAuth registration and enable the Google Drive API.
2. Register the exact MailHarbor origin followed by `/oauth/drive/callback` as its authorized redirect URI.
3. In **Google app registration**, enter the Google Drive account email you intend to authorize, client ID, and client secret. No address is assumed. OAuth must return that same verified account.
4. Select **Connect private Google Drive** and finish consent in the browser session that started it.
5. Run a manual scan, review its results, and explicitly enable automatic filing if desired.

Mailbox access does not authorize Drive. This separate connection requests only `drive.file`, `openid`, and `email`. It creates private app-owned folders, reuses verified allocations, and does not adopt unrelated same-name folders or change sharing settings. Changing the expected Drive account clears connection and allocation state. Disconnecting removes local tokens while preserving existing uploaded files.

Google controls registration, token expiry, plan and verification requirements. See [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) and [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Processing and storage

When enabled, automatic filing scans up to the latest 1,000 Inbox messages across connected accounts every 20 minutes. Manual scans also work while automatic scanning is disabled. Scans preserve source flags and do not move messages. This is not an unrestricted historical scan; the optional organizer can additionally enqueue historical candidates. Waiting-for-Drive items can be retried after leaving the newest Inbox window.

Original PDF and UBL XML attachments are extracted locally without Agy. Limits are 10 MiB per document, 25 MiB downloaded documents per message, 40 PDF pages, and 200,000 extracted characters. Scanned PDFs without text, encrypted documents, unsupported XML and oversized inputs need review. Invoice-portal links are not followed.

Only confidently matched original documents are uploaded. Exact-byte hashes, server checksums, and persisted preallocated file IDs prevent a lost upload response from creating a duplicate. Document bytes and extracted text are not retained in the filing ledger. Registration, tokens, allocation IDs, bounded source references, business configuration, and invoice status remain encrypted.

The record ledger and source index each stop at 10,000 entries instead of deleting unresolved work. Drive allocations stop at 12,000 entries. Back up durable state and the matching encryption key privately. Local rollback cannot delete files already uploaded.

Authenticated routes: `GET /api/drive`, `POST /api/drive/configure`, `POST /api/drive/connect`, `POST /api/drive/disconnect`, `GET /api/invoices`, `POST /api/invoices/settings`, and `POST /api/invoices/scan`. Writes require the browser session, exact origin and CSRF token. OAuth state is session-bound, short-lived and single-use.
