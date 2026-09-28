---
packages:
  '@pluxel/services': major
---

## Vault uses only the current storage contract

Remove `legacyNamespaces` and startup namespace migration. Encrypted snapshots require version 2 with per-record revisions; unversioned documents are no longer converted.
