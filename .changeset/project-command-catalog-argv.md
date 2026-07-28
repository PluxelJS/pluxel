---
'@pluxel/core': major
'@pluxel/commands': minor
'@pluxel/runtime': major
---

Add a lazy default argv projection over a live command catalog, using exact command names, generated
scalar options, and field-level JSON without per-plugin bindings or a mirrored route registry.

Bind runtime command execution to its plugin generation. Plugin stop now closes owner admission,
aborts and drains admitted command invocations before the stop hook, and rejects calls through stale
captured wrappers. Manual registration disposal remains publication-only. `shutdownSelf()` now schedules
its commit and returns `void`, preventing an owner invocation from awaiting its own teardown.

Clarify that EffectsService owns only explicit disposable handles and awaitable cleanup; it does not
publish an ambient lifetime signal.

Export `VoidCommandDefinition` so carrier packages can build context-specific command definers
without duplicating the command definition contract.
