---
packages:
  '@pluxel/cli': major
---

## Require package-scoped source links

Source overlays require repository directories containing package symlinks. Remove automatic conversion of whole-checkout symlinks; unexpected paths are rejected without replacement.
