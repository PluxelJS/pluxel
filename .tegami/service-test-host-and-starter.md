---
packages:
  '@pluxel/services': minor
  '@pluxel/workbench': minor
  '@pluxel/create': major
---

## Use Host composition in tests and new applications

Add `@pluxel/services/test` with an isolated `createServiceTestHost()` backed by the production Host catalog, state, configuration and lifecycle. Explicit service lists replace the default HTTP, commands, Node artifacts, workers and memory persistence composition; Management is an opt-in test integration. The base test entry with `services: []` loads without optional HTTP or Workbench peers; the default HTTP composition explicitly requires Elysia. `@pluxel/workbench/test` owns `createWorkbenchTestHost()`. `@pluxel/workbench/server` exposes typed `openLocalWorkbenchEntry()` for local sessions with caller-owned disposal and cancellation. Core author symbols remain in `@pluxel/core/test`.

Generated applications use Host environment settings and the service presets without a Runtime package dependency.

The published starter derives its first-party catalog ranges from the current package manifests during the create build, so Tegami version changes cannot leave newly generated applications on stale framework ranges.
