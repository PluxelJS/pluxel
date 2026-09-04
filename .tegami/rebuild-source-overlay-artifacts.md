---
packages:
  '@pluxel/cli':
    type: patch
---

## Rebuild source overlay artifacts exactly

Make `pluxel source build` execute selected source builds instead of restoring output directories
from Turbo cache. This prevents stale files in linked package distributions from entering consumer
production bundles when a build output changes without a consumer workspace input change.

`pluxel source build --package <name>` can now bootstrap one selected source artifact without
building the entire consumer closure. The selected package's own task graph still owns its real
artifact prerequisites; this is used by Vitest config bootstrap before source conditions can apply.
