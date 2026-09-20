---
packages:
  '@pluxel/services': major
---

## Keep management sessions independent of Workbench installation

Management no longer imports Workbench types or declares it as an optional peer. Session bootstrap
types preserve the existing wire variants and expose an opaque RPC target by default. Shells that
consume Workbench methods bind the existing session client types to `WorkbenchSessionApi`; the
official Workbench app binds this once in its local runtime entry.

Server composition accepts the authenticated Management principal and a borrowed `{ target, dispose }`
session, without depending on Workbench's server implementation.
