---
packages:
  '@pluxel/runtime':
    type: patch
---

## Keep lifecycle control responses portable and diagnostic

Materialize and validate Plugin lifecycle and auto-start results before Cap'n Web serializes them,
and let Workbench surface the target Plugin's lifecycle failure instead of replacing it with a
generic unsettled-state warning.
