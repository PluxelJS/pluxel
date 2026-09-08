---
packages:
  '@pluxel/runtime':
    type: minor
---

## Retain and expose Plugin lifecycle failures

Plugin status and management commands include lifecycle failure codes and messages until recovery or removal, including across unrelated commits. Runtime logs record the affected Plugin, phase and serialized error. Workbench distinguishes startup failures and dependency blocking from pending activation, keeps error notifications open, and lets users copy the notification and full lifecycle report. PGlite initialization errors identify the data directory and explain why retrying a Plugin cannot recreate a failed shared backend.
