---
packages:
  '@pluxel/services': patch
---

# Fix Workbench sessions behind Portless

Use the configured Portless browser origin for management WebSocket admission while preserving physical listener, TLS and peer-address facts.
