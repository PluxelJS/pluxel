---
packages:
  '@pluxel/runtime':
    type: minor
---

## Prefer declared Workbench route paths and diagnose collisions

Workbench exposes all committed routes in its global layout, including parameterized routes and pages outside navigation. The Shell uses declared paths below its UI base URL when unambiguous. Overlapping routes from different plugin instances and reserved Shell paths use canonical plugin URLs with visible collision diagnostics. Canonical URLs remain available, and aliases are recomputed after publication changes.
