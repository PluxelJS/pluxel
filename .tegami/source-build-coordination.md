---
packages:
  '@pluxel/cli': patch
---

# Coordinate shared source checkout builds

Serialize source build and install operations that share a checkout, with explicit waiting diagnostics. Hold ownership across the complete provider graph and drain every started sibling operation before releasing locks on failure. This prevents concurrent consumer dev commands from writing the same provider artifacts at once.
