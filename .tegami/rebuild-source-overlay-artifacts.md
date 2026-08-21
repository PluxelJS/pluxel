---
packages:
  '@pluxel/cli':
    type: patch
---

## Rebuild source overlay artifacts exactly

Make `pluxel source build` execute selected source builds instead of restoring output directories
from Turbo cache. This prevents stale files in linked package distributions from entering consumer
production bundles when a build output changes without a consumer workspace input change.
