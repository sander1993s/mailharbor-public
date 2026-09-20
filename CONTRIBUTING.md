# Contributing

Use Node.js 22.13 or newer. Install the pinned dependencies and run the synthetic test suite:

```sh
npm ci --ignore-scripts
npm test
```

For a local UI preview, run `node tests/fixtures/web-preview.mjs` and open the printed loopback URL. It uses fictional data and does not connect to a real mailbox. Packaging and deployment helpers require Python 3.

Keep changes focused, describe the behavior they change, and include relevant validation. Add tests for new provider behavior, authorization, message identity handling, durable state, or privacy boundaries. Use existing synthetic fixtures; do not require another contributor's credentials or live mailbox.

Before opening a pull request:

- Review the diff for credentials, real addresses, business identifiers, private hosts, filesystem paths, copied email content, and logs.
- Use `example.com`, `example.net`, or `example.org` for fictional identities. Public provider service hosts may appear in provider presets and their tests.
- Keep deployment configuration and runtime data outside source control. Inspect generated release archives as well as tracked files.
- Update user documentation when setup, provider requirements, data retention, or data sent to external services changes.
- Confirm that mailbox changes still verify account identity and provider capabilities and that uncertain sends cannot be automatically duplicated.

Provider presets must be generic and allow multiple independent accounts. Never add a contributor's address, tenant, organization, hosting server, destination folder ID, or secret as a default. Document authentication restrictions rather than weakening TLS or bypassing provider requirements.

Report security problems privately as described in [SECURITY.md](SECURITY.md). Contributions are made under the project's [MIT License](LICENSE).
