---
packages:
  '@pluxel/rolldown':
    type: patch
---

## Reuse unaffected Workbench producers

Derive Workbench producer revisions from the resolved UI source and dependency graph instead of the
entire workspace lockfile, so unrelated dependency changes no longer rebuild every immutable producer.
