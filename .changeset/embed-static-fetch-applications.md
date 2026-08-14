---
'@pluxel/rolldown': minor
'@pluxel/runtime-static': minor
---

Add a production `launcher: 'fetch'` static application target for embedded hosts that need the
runtime Fetch boundary without a Node HTTP listener. Keep the existing Node launcher as the default
and share the same production lifecycle, configuration, Vault, persistence, Workbench, and frozen
distribution closure between both launchers.
