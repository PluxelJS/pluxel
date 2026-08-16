---
'@pluxel/core': major
'@pluxel/runtime': major
'@pluxel/runtime-static': major
'@pluxel/runtime-dynamic': major
'@pluxel/rolldown': major
'@pluxel/test': major
'@pluxel/cli': major
'@pluxel/wretch': major
'@pluxel/canvas': major
'@pluxel/echarts': major
'@pluxel/fonts': major
---

Replace class/name-based plugin identity with package-root definition slots and structured node
addresses across Core, runtime state, static and dynamic catalogs, HMR, Workbench, logging, config,
and plugin-owned resources.

Lower required constructor dependencies and `definePluginRef<T>()` optional integrations through one
semantic build pass, with absent-safe optional callbacks and deduplicated consumer restart closures.
Remove the optional loader, Feature lifecycle, reflection fallback, public global event facade,
multi-layout config authoring, and Plugin `stop()` hook. Plugin teardown now exclusively drains
generation effects, and persisted state starts at the strict structured-address schema.

Update workspace plugins, tests, templates, and current documentation to the converged authoring and
runtime model.
