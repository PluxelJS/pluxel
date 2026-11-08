---
packages:
  '@pluxel/cli': patch
---

## Share installed peer dependencies across source workspaces

`pluxel source` now accepts declared singleton peer dependencies such as React.
Several selected source packages may share a singleton when their installed paths
resolve to the same physical package. Missing or conflicting installations report
the affected owners and paths instead of choosing a copy implicitly.
