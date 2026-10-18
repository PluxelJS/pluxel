---
packages:
  '@pluxel/core':
    type: minor
  '@pluxel/host':
    type: minor
  '@pluxel/rolldown':
    type: major
  '@pluxel/workbench':
    type: patch
  '@pluxel/plugin-auth':
    type: patch
  '@pluxel/plugin-fonts':
    type: patch
  '@pluxel/plugin-wretch':
    type: patch
---

## Add bounded third party version contracts

Add the optional `@pluxel/core/better-result` entry with all named exports from the shared `better-result` dependency.
Check the exact `capnweb` peer, development and installed versions when a plugin package publishes a
Workbench View or Attachment target. Move Vault Admin's `capnweb` to a peer and development dependency.
Record target publication in package metadata so static builds and dynamic source loaders share the
host `RpcTarget` constructor only for those publishers. Diagnose deployment version mismatches before
target evaluation. Improve the Workbench identity diagnostic and use Result within Auth credential
preparation while preserving its portable setup replies.
