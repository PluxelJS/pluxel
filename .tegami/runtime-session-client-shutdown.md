---
packages:
  '@pluxel/services': patch
---

# Close the runtime RPC graph before releasing child resources

Runtime session clients now shut down the native Capnweb root before releasing their bootstrap graph or notifying epoch invalidation observers. Child resource cleanup no longer sends release messages through a WebSocket that is already closing. In-flight or late bootstrap results cannot become current after the client is disposed.
