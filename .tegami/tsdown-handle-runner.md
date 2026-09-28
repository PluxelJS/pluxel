---
packages:
  '@pluxel/rolldown': patch
---

## Adopt the tsdown 0.23 build handle

The official CLI runner consumes the native build handle while preserving one-shot hook completion and bundle cleanup, including cleanup errors. Watch remains owned by the command process and native tsdown controls. Remove the obsolete dependency diagnostic field; use tsdown's `deps.neverBundle` configuration.
