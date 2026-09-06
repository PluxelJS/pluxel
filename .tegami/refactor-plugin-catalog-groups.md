---
packages:
  '@pluxel/runtime':
    type: major
  '@pluxel/workbench-app':
    type: minor
---

## Group plugins by dependencies and edit layouts in a standalone document

Replace package/directory sections with dependency entry groups and shared dependencies. Empty
configuration computes defaults without writing files; unrelated singleton definitions stay flat.
Manual groups, ordered definition references and explicit ungrouped membership live in the new
formatted `management/plugin-groups.json` document. File edits reload on the next catalog read,
with strict validation and publication only after successful persistence. No legacy migration.

Management protocol major 6 accepts named sections and explicit automatic-layout reset. The
Workbench supports creating, renaming, deleting and resetting groups, and adopts server-returned
section identities after saving. New plugins continue to receive automatic placement.
