---
packages:
  '@pluxel/host':
    type: minor
  '@pluxel/host-vite':
    type: patch
  '@pluxel/cli':
    type: patch
  '@pluxel/services':
    type: minor
---

## Share Host development reports and HTTP assembly

Host development publishes update history through Host status and Management, including retained
candidates, application compensation and lifecycle issues. Update outcomes include `failed` when
startup or compensation leaves no active Host. Failed cleanup preserves the original diagnostics
and does not skip remaining settlement or compensation.

Official application presets delegate HTTP and management ingress to their owning services. Plugin
scaffolding consistently declares Core and validation dependencies.
