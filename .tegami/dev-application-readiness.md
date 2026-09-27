---
packages:
  '@pluxel/host-dev': patch
  '@pluxel/cli': patch
---

## Show application readiness in dev discovery

`pluxel dev instances` now reports whether the live Vite console has a ready Host, is applying an update, or has no admitted Host. The existing recent update snapshot remains visible when initial admission fails.
