---
packages:
  '@pluxel/core':
    type: patch
  '@pluxel/rolldown':
    type: patch
  '@pluxel/runtime':
    type: patch
  '@pluxel/runtime-dynamic':
    type: patch
  '@pluxel/runtime-static':
    type: patch
---

## Defer development Workbench producer builds

Development hosts now publish Workbench topology and Content artifacts before cold MF producer builds
finish. Missing producer artifacts are built in the background from a persistent Workbench cache, while
unready View and Attachment entries remain visible in layout with building or failed status. A successful
producer candidate commits the complete tuple and reloads the Workbench session.

Development producer builds default to runtime-only MF artifacts. Static and distribution builds remain
strict and still require dynamic type artifacts before a producer can be published.
