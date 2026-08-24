---
packages:
  '@pluxel/context':
    type: patch
---

## Avoid repeated Context validation during explicit resolution

Compile descriptor resolvers inside the private Context implementation so
`resolveContextCapability()` validates its receiver and host plan once, then reads the selected
root, scope, or owner cache directly. Extend the Context benchmark to keep all three explicit
resolution paths and a mixed workload visible alongside projected property access and Context
creation costs.
