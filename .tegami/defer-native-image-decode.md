---
packages:
  '@pluxel/canvas':
    type: patch
---

## Decode native images after load callbacks return

Defer the final native image decode until the canvas load callback releases its mutable borrow,
restoring SVG and raster image decoding with the latest `@napi-rs/canvas` release.
