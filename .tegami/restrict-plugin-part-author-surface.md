---
packages:
  '@pluxel/core':
    type: major
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-static':
    type: major
  '@pluxel/test':
    type: major
  '@pluxel/cli':
    type: patch
  '@pluxel/create':
    type: patch
---

## Restrict the PluginPart author surface

Make Plugin and PluginPart composition declarations subclass-only: Part `ctx`, immediate `host`,
`parts`, `plugins`, and `configs`, plus Plugin `parts`, `plugins`, and `configs`, are now protected.
`BasePlugin.ctx` remains public.

Remove the PluginPart root Plugin getter, stop publishing `partInfo` on occurrence Contexts, and
remove `PluginPartContext`, `PluginPartInfo`, `PluginPartOwner`, and `PluginParts` from Core and
Runtime root types. Nested Parts retain a strongly typed immediate host, while lifecycle errors,
effects, and structured logging continue to carry framework-owned `partPath` attribution.

Update test helpers and generated repository guidance to validate explicit Part business surfaces
without exposing Context, root-owner, or path locators.

Add a dedicated user guide for choosing, declaring, configuring, nesting, and testing Parts. Keep
generated Plugin config fields private and lifecycle overrides protected by default.

## Serialize static host lifecycle operations

Serialize static host lifecycle and HMR operations so overlapping Vite invalidations derive each
catalog revision from the preceding committed snapshot.
