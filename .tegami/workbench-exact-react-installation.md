---
packages:
  '@pluxel/workbench': patch
  '@pluxel/services': patch
  '@pluxel/create': patch
---

## Keep fresh React installs compatible with precompiled Workbench artifacts

Pin React and ReactDOM installation and peer declarations to the same exact stable version used by the precompiled Workbench producers. Generated starters inherit these exact versions, so a fresh installation cannot select a newer patch that the published Federation manifest rejects. Applications consuming these artifacts must use the declared exact versions; upgrading the shared runtime requires rebuilding the corresponding assets.
