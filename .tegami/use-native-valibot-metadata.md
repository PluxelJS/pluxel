---
packages:
  '@pluxel/rolldown':
    type: major
  '@pluxel/runtime':
    type: major
  valibot-form:
    type: major
---

## Unify field semantics on Valibot metadata

Make `formMeta({ title, description })` emit Valibot's standard `metadata()` action so schema
tooling, form planning, and static config projections consume the same field text. Native Valibot
`title`, `description`, and generic metadata actions continue to interoperate by pipe order.

Rename `formMeta.label` to `title` without a compatibility alias. Remove duplicated requiredness,
bounds, formats, choices, and the no-op `booleanMeta()` contract. Field metadata can no longer
override the control kind derived from the schema, and validation bounds must use Valibot actions.
