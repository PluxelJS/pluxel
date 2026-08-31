---
packages:
  '@pluxel/runtime-dynamic':
    type: patch
  '@pluxel/runtime-static':
    type: patch
---

## Reject unknown runtime configuration fields during authoring

Make static `configure()` results and dynamic runtime config objects reject unknown top-level fields
and unknown fields in closed nested host configuration. Runtime validation remains the authority for
JavaScript, asserted values, and other untyped inputs.
