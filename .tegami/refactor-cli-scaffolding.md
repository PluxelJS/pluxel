---
packages:
  '@pluxel/cli': minor
  '@pluxel/create': minor
---

## Separate project creation from Plugin scaffolding

Ship a fixed, production-quality example monorepo and version-matched offline documentation from
`@pluxel/create`. Keep `pluxel new` focused on publishable Plugin packages with a strict manifest,
opt-in lightweight `.tpl` interpolation, immutable byte plans and exact overwrite preflight.

The example uses one host-owned Vite configuration for its React Todo UI and Plugin routes. Static
and dynamic development are modes of the same application server, while `host/web` is an independent
private workspace package for browser source and frontend-only dependencies without Pluxel imports.
