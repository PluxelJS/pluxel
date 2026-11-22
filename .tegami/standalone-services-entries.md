---
packages:
  '@pluxel/rolldown': patch
---

## Resolve every Services entry from its published build

Standalone applications now resolve all `@pluxel/services` entries from the
published build, not only `@pluxel/services/plugins`. Capability tokens such as
Vault are compared by identity, so a rebuilt entry carried a second copy and a
Plugin like `VaultAdminPlugin` required a Vault the host never installed.
