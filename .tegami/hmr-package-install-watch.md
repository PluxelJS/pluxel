---
packages:
  '@pluxel/runtime-static': patch
---

## Restore HMR after installing a missing package

Keep recovery watches active when package resolution searches overlapping ancestor directories, so installing a previously missing dependency automatically retries the failed application update.
