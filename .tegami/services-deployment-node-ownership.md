---
packages:
  '@pluxel/services': patch
---

## Preserve Node artifact ownership in modules applications

`servicesPreset()` now reads the application deployment manifest to distinguish standalone and modules delivery. Standalone applications keep their bundled Node artifact directory; modules applications use each loaded plugin package's verified artifact inventory, including workers owned by external packages. Missing or invalid deployment manifests fail explicitly.
