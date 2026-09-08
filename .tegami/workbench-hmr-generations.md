---
packages:
  '@pluxel/rolldown':
    type: patch
  '@pluxel/runtime-static':
    type: patch
---

## Recover Workbench definition hot updates across edits, failures and file replacement

Refresh standalone Workbench definitions and imported helpers within the same semantic generation as Plugin facts. Reject superseded transforms, discard failed parsing work, withdraw deleted publications, and preserve committed facts when a candidate is rejected. Generated Bridge and renderer projection files now use revision-specific paths.

Static Vite development handles file creation and deletion through the same update queue as edits, allowing recreated definitions and their dependent plugins to recover without restarting dev.
