---
packages:
  '@pluxel/core': minor
  '@pluxel/host': minor
  '@pluxel/rolldown': major
  '@pluxel/workbench': patch
  '@pluxel/auth': patch
  '@pluxel/fonts': patch
  '@pluxel/wretch': patch
  '@pluxel/vault-admin': patch
---

## Add bounded third party version contracts

Add the optional `@pluxel/core/result` entry with shared `better-result` `Result` and `TaggedError` exports.
Check the exact `capnweb` peer, development and installed versions when a plugin package publishes a
Workbench View or Attachment target. Move Vault Admin's `capnweb` to a peer and development dependency.
Record target publication in package metadata so static builds and dynamic source loaders share the
host `RpcTarget` constructor only for those publishers. Diagnose deployment version mismatches before
target evaluation. Improve the Workbench identity diagnostic and use Result within Auth credential
preparation while preserving its portable setup replies.
