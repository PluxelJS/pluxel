---
packages:
  '@pluxel/runtime':
    type: major
  '@pluxel/agent-tools':
    type: major
---

## Extract Agent tools into an optional Plugin

Remove the always-installed Runtime `agentTools` Context capability, Agent-specific Management RPC,
policy store, public Runtime types, and built-in Workbench page. Runtime now owns only the single command
registry and its Plugin generation admission/cleanup bridge.

Publish `@pluxel/agent-tools` as an ordinary optional Plugin. Toolsets and Agent assignments use the
standard Plugin config authority, while live bound catalogs filter the shared registry, recheck assignments
at dispatch, react to command/config changes, and fail closed after Plugin withdrawal. External provider
adapters consume it through normal constructor dependency injection.
