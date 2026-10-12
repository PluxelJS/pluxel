---
packages:
  '@pluxel/typst': minor
---

# Render retained document pages as PNG

Navigation metadata includes physical page dimensions. Sessions can render a selected page or pixel-aligned region from the retained successful revision without recompilation. Page rendering shares the bounded session queue and cancellation lifecycle, rejects stale revisions, and enforces scale, raster and PNG output budgets. Native cropping preserves page-relative backgrounds and gradients.
