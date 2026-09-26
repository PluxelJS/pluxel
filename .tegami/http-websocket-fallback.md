---
packages:
  '@pluxel/services': patch
---

## Keep successful WebSocket upgrades out of shell fallbacks

Business WebSocket connections now complete their handshake when a host shell fallback is installed. A successful Elysia upgrade is treated as a handled request instead of falling through to the shell.
