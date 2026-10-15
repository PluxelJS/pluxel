---
packages:
  '@pluxel/rolldown': patch
---

# Reuse published framework Workbench artifacts in standalone builds

Resolve the official `@pluxel/services/plugins` entry through its production exports, so standalone builds consume the published Services Workbench inventory without rebuilding the same producer. Preserve Plugin source compilation through `@pluxel/hmr` and reject conflicting artifact contents.
