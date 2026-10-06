# Changelog

All notable changes to `@synergyconnectapp/sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/).

## [1.0.0]

First public release, published to npm with provenance from GitHub Actions.

### Added

- `Synergy` client for the Synergy Connect public API (WhatsApp): `synergy.number(id)` with `messages` (text, media,
  location, contacts, reaction, template, interactive buttons and lists, `markAsRead`, raw Graph body), `media`,
  `templates` (list, create, update, delete, upload media), `flows` (`createToken`), `conversations` (list, search,
  changes, messages, handoff) and `contacts`.
- Account resources: `me()`, `numbers`, `webhooks` management (create, list, update, rotate secret, test, retry,
  replay, health, stats) and embedded signup (`onboarding.sessions`, `onboarding.verifyReturn`).
- `PagePromise` pagination: `await` for the first page, `for await` for every page, `autoPagingToArray({ limit })`.
- Webhook verification in `@synergyconnectapp/sdk/webhooks` (`constructEvent`, `verify`): `X-Synergy-Signature` with a
  300 s timestamp window and the delivery id, constant-time HMAC comparison, `X-Hub-Signature-256` fallback marked as
  `timestamped: false`.
- Typed errors (`SynergyError`, `APIError` and its subclasses), also exported from `@synergyconnectapp/sdk/errors`.
- Automatic retries with a stable `Idempotency-Key`, `Retry-After` handling and a per-call `signal`.
- ESM and CommonJS builds with type declarations; zero runtime dependencies (only `fetch` and `crypto.subtle`);
  runs on Node >= 20, Bun, Deno and Cloudflare Workers.

### Security

- The API key is sent only to the exact origin of `baseURL`, with `redirect: 'error'`, and never appears in an error,
  `toString()` or `toJSON()`. The constructor refuses to run in a browser without `dangerouslyAllowBrowser: true`.
