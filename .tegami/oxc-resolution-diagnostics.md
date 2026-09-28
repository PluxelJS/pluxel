---
packages:
  '@pluxel/rolldown': patch
---

## Preserve installed-package resolution failures

OXC-backed resolution now reports an installed package's invalid or unreadable manifest and rejected exports with its importer and original cause. Ordinary missing packages still return no match.
