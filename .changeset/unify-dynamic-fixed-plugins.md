---
'@pluxel/cli': major
'@pluxel/runtime': major
'@pluxel/runtime-dev': minor
'@pluxel/runtime-dynamic': major
---

Replace the dynamic builtin subsystem with one fixed `plugins` catalog plus mutable file `sources`.
Fixed and mutable modules now share one Vite SSR evaluated namespace, fixed availability reads the
same RuntimeState enablement and fork state as every other plugin, and direct launchers load a config
module path instead of accepting constructor-bearing objects.

Initial mutable entries are now a required part of startup instead of optional background warmup.
Generation shutdown stops HMR admission, discards queued work, drains the active batch, and closes
the canonical runner only after Vite and host cleanup.

Remove builtin declarations, dist loading, auto-enablement state, diagnostics, environment tuning,
and the `pluxel hmr builtin` command. Upgrade workspace HMR configuration and RuntimeState
persistence to version 2, with RuntimeState v1 reads preserving all non-builtin state.

Add the isolated dynamic source-producer validation contract. Source producers now fail before
native, filesystem, command, RPC, or Workbench side effects unless their exact publication source is
declared by the active dynamic host generation.
