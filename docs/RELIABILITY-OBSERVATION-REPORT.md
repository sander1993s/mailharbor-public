# Reliability observation template

This public document is a reusable verification template. It contains no live mailbox counts, message samples, account identities, deployment timestamps, or private operational results.

Keep completed observation reports outside the repository. Publish only synthetic results or measurements that have been independently reviewed for privacy.

## Record privately

- Release identifier, test environment, start/end time, and restart boundaries.
- Configured account count and provider types, without publishing identities.
- Classification throughput and latency, deferred work, safe failure codes, and retry deadlines.
- Owner decisions, cached classification preservation, move journals, and pause state before and after restart.
- Bounded action limits and independently verified provider outcomes.
- Storage growth, quotas, and recovery after temporary account failures.

## Acceptance

Check healthy-account progress during a separate account's failure. Confirm quota deadlines survive restart; uncertain moves remain journaled; expired references cannot authorize changes; and pause or owner decisions are preserved. Verify Gmail Inbox removal against provider state, and native MOVE destination identity for other servers.

A completed synthetic suite is distinct from live provider validation. Record any untested device, provider feature, duration, or recovery path accurately. Never infer correct semantic classification solely from successful API responses.
