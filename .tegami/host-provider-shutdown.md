---
packages:
  '@pluxel/host': patch
---

## Drain Hosts with abstract provider defaults

Clear applied provider-default bindings in the same shutdown transaction that removes Plugin nodes,
so Hosts with abstract providers drain their generations successfully. Persisted provider selection
and startup intent remain available for the next startup.
