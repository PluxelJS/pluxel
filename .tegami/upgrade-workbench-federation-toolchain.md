---
packages:
  '@pluxel/core':
    type: patch
  '@pluxel/create':
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

## Upgrade and tighten the Workbench federation toolchain

Upgrade Module Federation, Vite, Rolldown, React, and Mantine to their current stable lines. Workbench
remotes now reuse the Shell's exact React and Mantine singleton modules without bundling fallbacks,
while each renderer keeps its own Mantine provider root.

Producer builds now run in-process with precise application-root coordination, isolated declaration
caches, and validated dynamic types. The dynamic Vite integration owns React Refresh exactly once,
including in newly created projects.
