---
packages:
  '@pluxel/rolldown': patch
---

## Fingerprint type-only package exports without a runtime entry

Workbench artifact builds now include installed declaration-only packages such as `@types/react` in the dependency revision without trying to resolve a nonexistent JavaScript root. Packages that declare a runtime root still fail on a broken export.
