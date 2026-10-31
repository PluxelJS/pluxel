---
packages:
  '@pluxel/rolldown': patch
---

# Accept moved database declarations during development

Recheck a previous `defineDatabase()` location before rejecting a declaration in another module. Moving or removing the old module no longer leaves a stale package claim. Concurrent transforms still reject multiple active declarations, including transforms competing to replace the same stale claim.
