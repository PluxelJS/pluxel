---
packages:
  '@pluxel/core':
    type: patch
  '@pluxel/create':
    type: patch
  '@pluxel/rolldown':
    type: major
  '@pluxel/runtime':
    type: patch
  '@pluxel/runtime-dynamic':
    type: patch
  '@pluxel/runtime-static':
    type: patch
---

## Upgrade and tighten the Workbench federation toolchain

Upgrade Module Federation, Vite, Rolldown, React, and Mantine to their current stable lines. Workbench
remotes now reuse the Shell's exact React and Mantine singleton modules without bundling fallbacks,
while each renderer keeps its own Mantine provider root.

Producer builds now run in-process with precise application-root coordination, isolated declaration
caches, fair cross-root admission, producer/host shared-version validation, and validated dynamic types.
The dynamic Vite integration owns React Refresh exactly once, including in newly created projects.

The low-level shared-resolution result and compatibility-signature helpers are no longer exported from
`@pluxel/rolldown/vite/workbench-ui`; callers provide the application root directly to the producer
builder instead of depending on inferred workspace roots. Producer calls must also select
`packageMode: 'development' | 'distribution'` so package subpaths cannot silently fall back to stale
built output during Workbench HMR.
