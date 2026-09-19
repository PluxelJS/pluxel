---
packages:
  '@pluxel/services': minor
  '@pluxel/create': major
---

## Use Host composition in tests and new applications

Add `@pluxel/services/test` with an isolated `createServiceTestHost()` backed by the production Host catalog, state, configuration and lifecycle. Explicit service lists replace the default HTTP, commands, Node artifacts, workers and memory persistence composition; Workbench and Management are opt-in test integrations. Core author symbols remain in `@pluxel/core/test`.

Generated applications use Host environment settings and the service presets without a Runtime package dependency.

The published starter derives its first-party catalog ranges from the current package manifests during the create build, so Tegami version changes cannot leave newly generated applications on stale framework ranges.
