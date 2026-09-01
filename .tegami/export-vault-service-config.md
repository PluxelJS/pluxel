---
packages:
  '@pluxel/runtime':
    type: minor
---

## Export the Vault host configuration type

Export `VaultServiceConfig` from the Runtime root so host configuration types can name Vault setup
without depending on the server-only Vault service entry.
