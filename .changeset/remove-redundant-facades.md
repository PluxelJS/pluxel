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
core logging lives only on `@pluxel/core/logger`, and runtime authoring entries directly forward the
canonical core author surface instead of maintaining a second export list. Oxlint implementation
tests and exports belong directly to `@pluxel/rolldown/oxlint` instead of a test-package forwarding
facade.
