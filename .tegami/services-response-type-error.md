---
packages:
  '@pluxel/services': patch
---

## Identify invalid Elysia responses as type errors

Throw a `TypeError` when Elysia returns no `Response` without transferring a WebSocket
upgrade, preserving the existing diagnostic and request cleanup.
