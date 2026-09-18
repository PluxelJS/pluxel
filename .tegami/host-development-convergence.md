---
packages:
  '@pluxel/host': minor
  '@pluxel/host-dev': patch
  '@pluxel/management': minor
  '@pluxel/runtime': minor
  '@pluxel/cli': patch
---

## Share Host development reports and HTTP assembly

Host development publishes update history through Host status and Management, including retained
candidates, application compensation and lifecycle issues. Update outcomes include `failed` when
startup or compensation leaves no active Host. Failed cleanup preserves the original diagnostics
and does not skip remaining settlement or compensation.

Runtime delegates HTTP and management ingress to the same services as composable Hosts. Plugin
scaffolding consistently declares Core and validation dependencies.
