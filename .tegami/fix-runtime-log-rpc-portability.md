---
packages:
  '@pluxel/runtime':
    type: patch
---

## Keep runtime log streams portable

Emit exact JSON-like log DTOs without `undefined` fields, keep Plugin reference and label hints
on one logger/Workbench protocol source, and byte-page range responses against a payload budget
derived from the physical Runtime session ceiling.
