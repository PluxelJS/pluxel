---
packages:
  '@pluxel/core':
    type: minor
  '@pluxel/runtime':
    type: major
---

## Notify running Plugins without implicit restart

Add generation-bound `configs.onUpdate(config, listener)` registration for Plugins and PluginParts.
Config patch/reset now persists desired config first, then notifies every changed declaration only when
all required listeners are registered. Successful listeners confirm the applied revision and update the
injected config fields without replacing the Plugin generation.

Running Plugins without listeners, or with a rejecting listener, remain running with their previous
framework-confirmed config fields while management reports stable `listener_not_registered`,
`listener_failed`, or `generation_changed` failure codes. Config mutations no longer implicitly restart
the addressed Plugin or its dependent closure; hosts can still request an explicit restart independently.
