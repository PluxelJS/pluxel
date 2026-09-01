---
packages:
  '@pluxel/core':
    type: minor
  '@pluxel/runtime':
    type: minor
  '@pluxel/rolldown':
    type: minor
  '@pluxel/runtime-static':
    type: minor
  '@pluxel/runtime-dynamic':
    type: minor
---

## Add host-rendered Workbench Standard Pages

Add `workbench.page()` and `workbench.markdown()` for build-time compiled, host-rendered Plugin
documentation. Validate a bounded portable Markdown plan at build, artifact-load, RPC, and browser
boundaries without creating a Plugin RPC target, Module Federation producer, or React Bridge.

Publish content-addressed Page inventories through plugin package, static application, dynamic
distribution, and development pipelines. Commit mixed Page and federated View artifacts as one
last-known-good revision, and invalidate the existing Workbench session only after the full candidate
has committed.
