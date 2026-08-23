---
packages:
  '@pluxel/core':
    type: patch
---

## Reuse canonical Plugin addresses inside Core

Validate structured Plugin addresses once at the external boundary, then reuse kernel-owned frozen
addresses across constructor projections, slot lookup, graph materialization, restart, and teardown.
This removes repeated deep parsing from lifecycle operations while preserving complete validation
for plain objects and addresses crossing evaluated Core instances. Configless Plugin teardown also
keeps the root Config service strictly lazy instead of constructing it only to clear absent state.
Provider-default changes now collect overlapping consumer cascades in one union traversal.
