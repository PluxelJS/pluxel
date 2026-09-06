---
packages:
  '@pluxel/cli':
    type: patch
  '@pluxel/rolldown':
    type: patch
---

## Keep Plugin database evolution workflows separate

Reject migration generation, checking, and rebasing for `reset-on-schema-change` databases, whose
baseline is generated only during build. This prevents stale checked-in migration artifacts from being
silently ignored and makes the reset workflow explicit in CLI help.
