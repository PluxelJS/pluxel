---
packages:
  '@pluxel/cli':
    type: patch
  '@pluxel/commands':
    type: patch
  '@pluxel/core':
    type: patch
  '@pluxel/create':
    type: patch
  '@pluxel/host':
    type: patch
  '@pluxel/plugin-auth':
    type: patch
  '@pluxel/plugin-canvas':
    type: patch
  '@pluxel/plugin-fonts':
    type: patch
  '@pluxel/plugin-takumi':
    type: patch
  '@pluxel/plugin-takumi-markdown':
    type: patch
  '@pluxel/plugin-wretch':
    type: patch
  '@pluxel/rolldown':
    type: patch
  '@pluxel/services':
    type: patch
  '@pluxel/test':
    type: patch
  '@pluxel/workbench':
    type: patch
  'valibot-form':
    type: patch
---

## Refresh dependencies and source workspace synchronization

Update supported runtime, rendering, UI, test and build dependencies together, including the generated application and plugin toolchain pins. Rebuild the Workbench compatibility set with Mantine 9.7.4 and Module Federation Vite 1.23.9 / runtime and React bridge 2.9.3.

Prune source workspace scans to branches selected by declared workspace globs so unrelated artifact trees do not exhaust the scan budget. Preserve the directory bound and existing member validation.

Prepare the libSQL optional peer in the Services development checkout so source workspaces can share its Drizzle instance across PostgreSQL, PGlite and libSQL consumers.
