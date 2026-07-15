---
'@pluxel/cli': minor
'@pluxel/rolldown': minor
'@pluxel/runtime': patch
'@pluxel/runtime-dev': patch
'@pluxel/runtime-dynamic': patch
'@pluxel/runtime-static': major
---

Make a default-exported `defineStaticRuntime()` application the shared Vite and production entry,
add Rolldown-backed frozen Node distributions with optional Workbench artifacts and traced residual
dependencies, preserve startup-time configuration and fixed-catalog plugin enablement, and move the
ordinary plugin production source pipeline into `@pluxel/rolldown/build`.
