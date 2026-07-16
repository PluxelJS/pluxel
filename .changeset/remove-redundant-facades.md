---
'@pluxel/core': major
'@pluxel/rolldown': major
'@pluxel/runtime-dynamic': major
'@pluxel/runtime-static': major
'@pluxel/test': major
---

Remove parallel and compatibility-only entry points left behind by the runtime, logging, Workbench,
and toolchain refactors. Runtime application helpers now live only on route package main entries,
core logging lives only on `@pluxel/core/logger`, and Oxlint implementation tests and exports belong
directly to `@pluxel/rolldown/oxlint` instead of a test-package forwarding facade.
