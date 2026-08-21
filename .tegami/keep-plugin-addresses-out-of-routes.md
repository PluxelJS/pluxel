---
packages:
  '@pluxel/rolldown':
    type: patch
  '@pluxel/runtime':
    type: patch
---

## Keep internal Plugin address keys out of catalog routes

Use readable root export names for unambiguous Workbench plugin IDs while retaining structured
addresses for runtime control and persistence. Carry Workbench layout targets in a query parameter
so scoped package names cannot split the HTTP route, and reject static application builds that would
embed an absolute external source path instead of package-root Plugin provenance.
