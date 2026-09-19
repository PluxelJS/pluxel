---
packages:
  '@pluxel/rolldown': patch
---

## Publish Node artifacts for every concurrent build

Deduplicate compilation without skipping each consumer's output directory or native dependency
report. Concurrent builds of the same source now each receive their artifact and deployment facts.

Compile native dependency bridges relative to the final artifact directory, not the disk cache.
Include the output layout in the cache identity so nested output directories remain loadable.

Keep cached bytes leased until every concurrent consumer finishes publishing, including during cache eviction.
