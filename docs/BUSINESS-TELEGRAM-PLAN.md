# Business inquiry summaries on Telegram

This optional workflow checks a selected connected account for likely direct business inquiries and can send a bounded summary to an explicitly configured Telegram destination. A new installation contains no selected account, bot token, chat ID, website sender, or trusted routing evidence.

Choose the account in **Settings → Business inquiries on Telegram**, enter your own destination credentials, choose a summary language, and explicitly enable the workflow. Use the separate test-message control to validate delivery; configuration alone does not authorize a test message.

## Eligibility and trust

Direct inquiry classification uses bounded email text through the authorized Agy worker. Routine mail and uncertain classifications do not produce an inquiry alert. This transfers the selected text to Google and, for eligible alerts, the summary to Telegram.

Website form submissions require configured routing trust before they can qualify. The optional encrypted `formTrust` settings describe the expected subject, sender, envelope domain, mailbox host, trusted relay hosts, and any explicitly required relay alias/address. Defaults contain no trust rule. Configure this from your own independently verified routing; never assume an arbitrary From header proves a website submission.

The server captures new Inbox arrivals independently of the browser, persists pending work in encrypted notification state, and uses bounded recovery and deduplication. Treat bot tokens, destination identifiers, routing evidence, sender addresses, message samples, and delivery reports as private state outside the repository.

Use synthetic examples or your own test mailbox when checking eligible, routine, ambiguous, duplicate, paused, disconnected, and delivery-failure cases. Do not publish real submission text or operational routing evidence in fixtures or documentation.
