---
packages:
  '@pluxel/services': patch
  '@pluxel/cli': patch
---

## Reject invalid explicit configuration

The official services preset now rejects unknown top-level options and a non-boolean Workbench selection. The CLI rejects an empty `PLUXEL_STATE_DIR` instead of silently using the default directory.
