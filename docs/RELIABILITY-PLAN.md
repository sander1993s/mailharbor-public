# Reliability design and acceptance

MailHarbor preserves cached classifications, owner decisions, move journals, and retry deadlines across restarts. Validation must distinguish synthetic tests from real provider observations; no private deployment history is part of the public repository.

## State and recovery

Expose discovery, analysis, due retention, pending owner review, automatic holds, retry eligibility, and technical failures separately. Successful results are reused by logical-message fingerprint. Failed isolated classifications have a bounded retry budget; repeated provider failures open a circuit breaker with a synthetic recovery probe and cooldown. Authentication/configuration failures require correction. Quota deadlines are durable and must not be shortened by a later shorter hint.

Use adaptive bounded batches, independent account backoff, and fair opportunities for new arrivals and old backlog. A failed account must not prevent healthy accounts from progressing. Incomplete content holds mutations; a bounded reread may recover complete evidence while preserving earlier protection.

Migration commits its page and cursor together. A renewable per-instance SQLite lease protects initialization and owner writes. Keep/confirm/retry decisions exclude concurrent processing edits, and an intervening Pause must remain effective. Corruption or failed durable writes must stop subsequent processor effects.

## Provider correctness

Revalidate account revision, UIDVALIDITY, UID, and fingerprint immediately before changes. Gmail archive verifies removal of Inbox membership while preserving other labels. Other providers require a verified destination and native MOVE. Unknown outcomes remain journaled; do not claim success from an absent flag alone.

Preview disables provider writes. Apply-mode action limits bound move/rescue attempts, including uncertain outcomes; they do not cap read flags. Classification limits bound saved results, not every provider request. Review [PROCESSING.md](PROCESSING.md) before enabling automatic processing.

## Validation sequence

1. Run synthetic suites covering protocol rejection, retries, quota persistence, migrations, owner decisions, message identity, and restart journals.
2. Verify an isolated state copy and the expected migration differences without exposing its contents.
3. Run a preview with bounded work and inspect resulting holds/retries.
4. Use a deliberate, bounded test-mailbox pilot and independently verify each provider mutation.
5. Measure sustained throughput, restart safety, and a full observation interval privately, using the [observation template](RELIABILITY-OBSERVATION-REPORT.md).

Rollback must preserve current journals, owner decisions, and protections. Older code remains paused until it is shown compatible with newer state. Restoring a local backup cannot undo provider-side changes.
