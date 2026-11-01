---
packages:
  '@pluxel/core': major
  '@pluxel/host': minor
  '@pluxel/host-vite': minor
  '@pluxel/rolldown': minor
  '@pluxel/workbench': patch
  '@pluxel/services': minor
  '@pluxel/cli': patch
  '@pluxel/create': patch
---

## Bind managed TinyBase consumers to the Host runtime

Share exact peer, catalog, installation, and artifact admission between Cap'n Web
and TinyBase. Build metadata records managed TinyBase consumers; development,
static builds, and production native loading validate their original installation
before binding `tinybase` and its original subpaths to the exact Core-owned module.
Private TinyBase dependencies retain their own versions and modules.

Core owns the exact TinyBase 10.0.1 runtime dependency. Only native Store/Queries
interoperability consumers declare matching peer/dev dependencies. Ordinary Core
imports and fixed open() calls do not mark a package as a native consumer; private
application dependencies retain their own resolution.
