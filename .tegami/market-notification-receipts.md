---
packages:
  '@pluxel/cli': minor
---

## Use durable HTTP market notification receipts when publishing

`pluxel publish` now submits the current market's public notification protocol
without an optional market package or a separate OIDC token. `--market-url`
selects the market endpoint, and the command prints the receipt and its query
URL. Accepted, pending and failed notifications retain their actual status;
acceptance does not claim the release is indexed.

`--dry-run` prevents notification writes even with `--webhook`. Exact-version
checks run in the publishing directory so local npm registry configuration is
honored and repeating a notification does not republish an existing release.

Registry coordinates now retain the actual npm publication source, including
private PNPR bases. Registry selection honors native npm configuration and
scoped registry precedence; exact-version checks and notification receipts use
the same source. Private publications require both an explicit notification and
market destination. `PLUXEL_MARKET_TOKEN` supplies a notification bearer token
only to an explicitly selected market, without exposing npm credentials.
