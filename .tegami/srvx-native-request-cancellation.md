---
packages:
  '@pluxel/services': patch
---

# Preserve srvx native client cancellation

Node listeners use srvx request cancellation directly instead of installing a second disconnect listener. Handlers retain the original transport abort reason, including socket errors such as `ECONNRESET`; cancellation is identified by `request.signal.aborted`, not a fixed error name. Owner shutdown cancellation and request address mapping remain intact.
