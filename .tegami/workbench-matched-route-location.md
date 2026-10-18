---
packages:
  '@pluxel/workbench': patch
---

# Preserve the matched Plugin route during navigation

Read Plugin page paths from their accepted route context. Navigating to another page while its loader is pending keeps the current Plugin page visible without reporting an invalid route from the destination URL.
