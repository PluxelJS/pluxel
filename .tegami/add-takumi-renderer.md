---
packages:
  '@pluxel/fonts':
    type: minor
  '@pluxel/takumi':
    type: major
---

## Add portable font resources and bounded Takumi rendering

Let renderer Plugins consume content-addressed managed and caller-registered font bytes without
exposing Canvas's mutable global registry. Add portable-only Fonts Selection Port projection so
renderers that cannot access platform font files only present candidates they can actually load.

Publish `@pluxel/takumi` with bounded HTML/node-tree raster and SVG rendering, revision-scoped font
registries, caller-aware fair admission, cancellation, explicit preloaded images, and optional Fonts
Workbench composition. Host deadlines prevent stuck renders from retaining admission slots. Takumi's
genuinely asynchronous N-API tasks stay on their native execution path instead of consuming a second
Pluxel worker thread.
