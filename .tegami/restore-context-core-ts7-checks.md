---
packages:
  '@pluxel/context':
    type: patch
  '@pluxel/core':
    type: patch
---

## Restore TypeScript 7 declaration checks

Keep the frozen empty owner-value sentinel explicit across TypeScript 7's readonly assertion rules and
narrow unresolved watcher keys before querying availability changes. This restores declaration generation
for Workbench producers that expose Context- and Core-backed source modules.
