---
'@pluxel/core': patch
'@pluxel/rolldown': patch
'@pluxel/runtime': patch
---

Keep host-only Workbench navigation grouping out of browser contract fingerprints, invalidate old
remote build caches, and reject static applications assembled from a stale Workbench shell whose
contract protocol does not match the runtime package.
