---
packages:
  '@pluxel/rolldown': major
  '@pluxel/services': patch
---

## Use one Core metadata ABI for Plugin source

Plugin and configuration lowering now emit only `@pluxel/core/toolchain` imports. Remove Runtime
preset selection and configurable metadata helper imports. `pluginSourceVitePlugins()` provides the
complete source transform and Vite resolution stack; `createPluginSourceVitePipeline()` additionally
exposes its semantic collector. Host and service singleton policy belongs to their own Vite plugins.

The official service Vite preset explicitly installs server database source lowering, preserving
checked migration metadata without a Runtime preset.

Installed modules under `node_modules` contribute execution facts only when they contain a valid
prelowered Core ABI declaration. Their ordinary source remains outside Plugin lowering. Settled
semantic scopes read committed Workbench facts, including asynchronous continuations after rollback.
Prelowered evidence accepts minified static template strings and reads only the ABI identity fields;
unrelated dependency expressions do not discard a statically proven definition.
