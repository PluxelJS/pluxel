---
packages:
  '@pluxel/services': minor
---

## Keep operation log cursors in the Logging domain

Add markLogs, readLogs and cancellable waitForLogs over existing bounded stores. JSON cursors retain
Host and stream identity; replacement, reset and retention gaps remain explicit failures. Waiting
releases its subscription on delivery, discontinuity or cancellation and never reconfigures logging.
Remove the unused internal Runtime launcher preinstallation bridge; Host owns logging preparation
and disposal through the ordinary logging service descriptor.
