---
packages:
  '@pluxel/runtime':
    type: minor
  '@pluxel/runtime-static':
    type: minor
  '@pluxel/runtime-dynamic':
    type: patch
---

## Complete the reserved Workbench URL namespace

Serve built Workbench shell assets from `/__pluxel/workbench/assets` so framework-owned browser routes,
runtime sessions, federation artifacts, and assets no longer compete with an application's public URL
space. Document the minimal route arbitration contract without imposing an application `/api` policy.
Prevent the production application SPA fallback from serving Runtime-owned `/__pluxel` requests when
the Runtime correctly rejects a non-navigation request.
Consumer workspaces without the Pluxel monorepo's Workbench source tree now serve the packaged
Workbench bundle during Vite development instead of emitting an unresolved repository-only entry.
