---
packages:
  '@pluxel/services': patch
---

## Adopt current Elysia, srvx and LogTape contracts

Use Elysia 2 beta.19's Web Standard adapter and bind the Plugin-owned server through
its request hook while keeping cancellation, WebSocket ownership and Host shutdown.
Use srvx 1.0.5 for Node listeners. Delegate exit-hook disposal and file value rendering
to LogTape 2.3.8, removing local listener interception and formatter workarounds.

Pin TypeBox to 1.3.23 until Elysia no longer uses the Validator internals removed in 1.3.24; preserve schema compilation before publication and cover it with real requests.
