---
packages:
  '@pluxel/runtime':
    type: patch
  '@pluxel/runtime-dynamic':
    type: patch
  '@pluxel/runtime-static':
    type: patch
---

## Reject unknown runtime configuration fields during authoring

Make Runtime, static `configure()` results, and dynamic runtime config objects share one exhaustive
field contract that rejects unknown fields throughout every Runtime-owned service and logging
configuration. Explicit extension values such as Plugin raw config, environment maps, custom
persistence backends, custom log sinks, constructors, and iterables remain open. Runtime validation
remains the authority for JavaScript, asserted values, and other untyped inputs, while the recursive
TypeScript constraint catches the same mistakes during authoring. RuntimeState startup snapshots now
also expose their intended `Iterable` auto-start input instead of accidentally intersecting it back to
arrays only.
