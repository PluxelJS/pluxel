---
packages:
  '@pluxel/services': major
  '@pluxel/create': patch
---

# Use the application build entry directly

Remove `buildPreset()` and the `@pluxel/services/build` export. Application builds use `pluxel()` from `@pluxel/rolldown`; delivery, Workbench variant, launcher and residual dependency options keep their existing behavior and defaults. Runtime service and Vite attachment presets retain their distinct contracts.

Generated hosts and the official Host example import the same application build entry. No compatibility alias or forwarding entry remains.
