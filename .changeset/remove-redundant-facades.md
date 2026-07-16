---
'@pluxel/core': major
'@pluxel/runtime': major
'@pluxel/rolldown': major
'@pluxel/runtime-dynamic': major
'@pluxel/runtime-static': major
'@pluxel/test': major
---

Remove parallel and compatibility-only entry points left behind by the runtime, logging, Workbench,
and toolchain refactors. Runtime application helpers now live only on route package main entries,
core logging lives only on `@pluxel/core/logger`, and `@pluxel/runtime` is the single authoring and
always-on service entry. Vault keeps its explicit optional entry; the parallel runtime authoring and
route registration subpaths are removed. Oxlint implementation tests and exports belong directly to
`@pluxel/rolldown/oxlint` instead of a test-package forwarding facade.

Core now owns its plugin-specialized DI kernel directly while the standalone `diod` baseline and
comparison benchmark remain available for maintenance measurements. Config records, revisions,
validation, and normalized snapshots use one lightweight core engine; runtime extends it only with
persistence and readonly policy. Plugin startup now has one bounded topological scheduler instead
of retaining the legacy depth-batch strategy.

Core production sources now share one layout under `src`: the DI and FSM kernels live under
`src/internal`, while migration changelogs are left to Git history.

Remove the superseded `@pluxel/runtime/frozen` generator so production applications have only the
canonical `defineStaticRuntime()` + Rolldown freezer path. Remove the unused process-global core
runtime/environment facade; route identity remains explicit host policy instead of mutable Context
state. Runtime-dev now owns the single Workbench compiler attachment lifecycle used by both static
and dynamic development routes.
