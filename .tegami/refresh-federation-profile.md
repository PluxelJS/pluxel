---
packages:
  '@pluxel/core': minor
  '@pluxel/rolldown': minor
  '@pluxel/workbench': minor
---

## Refresh the Workbench Federation profile

Use Module Federation Vite 1.22.1 with Runtime, SDK and React Bridge 2.9.1 and Mantine 9.6.3. The exact producer and Shell compatibility checks remain enforced; rebuild renderer artifacts with the updated profile.

Keep shared-surface import analysis, application-root scheduling and isolated declaration caches: real Mantine producer builds and upstream shared state still require these boundaries with the updated plugin.
