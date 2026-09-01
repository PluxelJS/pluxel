---
packages:
  '@pluxel/runtime':
    type: patch
---

## Detach Workbench RPC data safely

Add one Workbench client helper that validates and deeply freezes awaited portable DTOs while
releasing their Cap'n Web result ownership, so Plugin renderers do not need ad-hoc cloning logic.
