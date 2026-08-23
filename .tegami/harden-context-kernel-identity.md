---
packages:
  '@pluxel/context':
    type: patch
  '@pluxel/core':
    type: patch
  '@pluxel/runtime-dynamic':
    type: patch
---

## Harden Context identity across HMR boundaries

Diagnose Context values and capability descriptors that cross evaluated kernel instances without
restoring the pre-1.0 global fatal singleton. Core's embedded kernel and standalone
`@pluxel/context` can still coexist, and normal Context creation and projected getter paths remain
free of global identity checks.

When standalone Context is installed by a dynamic host, bridge its public and internal entries into
the HMR runner together with Core and Runtime. Resolve host singleton entries with ESM import
conditions so conditional CommonJS exports cannot create a second kernel, while keeping standalone
Context optional for hosts that do not install it.
