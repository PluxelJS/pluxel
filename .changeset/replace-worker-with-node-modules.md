---
'@pluxel/cli': minor
'@pluxel/rolldown': minor
'@pluxel/runtime': major
'@pluxel/runtime-dev': minor
'@pluxel/runtime-dynamic': major
'@pluxel/runtime-static': minor
---

Replace the development-only worker facade and generic bundler with opaque `defineNodeModule()`
declarations and owner-bound `ctx.nodeModules.use()` lifecycle management. Build self-contained Node
ESM artifacts through the canonical plugin pipeline for plugin packages and both static application
variants, add packaged/deployment resolution and shared development rebuilds, and remove the runtime
and dynamic `plugin` subpaths without compatibility aliases.
