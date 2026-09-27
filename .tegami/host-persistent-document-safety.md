---
packages:
  '@pluxel/host': major
  '@pluxel/core': patch
---

## Preserve invalid persistent Host documents

Host startup now rejects malformed or unsupported persisted config and runtime state documents instead of creating `.broken.*` copies and replacing the originals with empty state. The original document stays untouched; repair it or restore a backup before restarting. A failed load also keeps the store unready and blocks direct mutation.
