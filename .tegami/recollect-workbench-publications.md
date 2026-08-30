---
packages:
  '@pluxel/rolldown':
    type: patch
---

## Make Workbench semantic collection idempotent

Treat each transformed module as an atomic Workbench publication snapshot so concurrent Vite
prefetch and evaluation remain idempotent, and source updates can replace or remove publications
without weakening duplicate-owner validation across distinct modules.
