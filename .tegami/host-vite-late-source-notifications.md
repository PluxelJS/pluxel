---
packages:
  '@pluxel/host-vite': patch
---

## Avoid repeated reloads from late source notifications

Consume source notifications already represented by an accepted candidate without
evaluating and restarting the same Plugin again. Every batch still validates the
source owner and entry set; creation, deletion, failed inputs and changed imports
continue through normal candidate evaluation and recovery.
