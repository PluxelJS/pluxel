---
packages:
  '@pluxel/rolldown': patch
  '@pluxel/host-dev': major
---

## Preserve Vite source resolution and browser diagnostics

Enable Vite tsconfig path resolution by default while respecting an explicit `false`. Classify
alias-resolved CommonJS files through the same Node execution boundary as installed dependencies.
Report browser imports of Node builtins immediately with their importer, while allowing explicit
browser implementations and leaving server imports unchanged.

Remove the unused Host-dev `hmr-log` entry and root log-schema exports. Application update reports
and plugin lifecycle reports remain the authoritative development diagnostics.
