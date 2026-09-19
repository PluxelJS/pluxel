---
packages:
  '@pluxel/preset': major
  '@pluxel/services': minor
  '@pluxel/workbench': minor
  '@pluxel/create': patch
---

## Separate application composition from base services

Move official runtime, Vite, build and integrated test compositions to @pluxel/preset. Remove the previous Services composition/test entries; update applications to the corresponding Preset entries. Workbench test host composition also belongs to Preset, while Workbench retains its domain drivers. Shared framework identities use peer dependencies. Base Services no longer depend on Management or Workbench.
