---
packages:
  '@pluxel/services': major
  '@pluxel/rolldown': patch
  '@pluxel/create': patch
  '@pluxel/workbench': patch
---

## Collapse implementation paths into deliberate service boundaries

Import `createHostHttpHandler` from `@pluxel/services/http` and `listenHostHttp` from
`@pluxel/services/http/node`. The application, listener and private asset-file subpaths are removed.
Generated launchers and starter applications use these shared domain entries.

Private service implementation files are no longer exported individually. Framework owner-view and
security integration uses the narrow `@pluxel/services/internal` entry; white-box test support retains
`/internal/test`. Persistence and Vault contracts come from their existing public domain entries.
Database drivers remain private package imports, preserving lazy optional-backend loading.

`VaultAdmin` and the root `vaultAdmin` property expose the existing `VaultAdminApi` contract,
keeping the backend implementation and Host-only preparation method private.
