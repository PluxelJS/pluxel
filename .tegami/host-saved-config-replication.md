---
packages:
  '@pluxel/core': minor
  '@pluxel/host': major
  '@pluxel/services': major
  '@pluxel/workbench': major
  '@pluxel/host-vite': major
  '@pluxel/rolldown': major
---

# Use shared files for saved state

Remove `configSync`, writer/replica roles, authenticated replication endpoints,
history/sequence versions, and the corresponding expected-version arguments and
Management/Workbench version fields. Host saved configuration uses a version 4
ordinary document. Previous replication documents and TinyBase Host envelopes need
explicit offline conversion; startup does not silently reinterpret or reset them.

Managed TinyBase Stores and encrypted Vault snapshots reload external file changes.
Host configuration validates and applies changed saved documents through its normal
configuration lifecycle. Incoming snapshots are not saved back unchanged; invalid
updates preserve the last valid in-memory state and report their failure.

The Host document adapter can optionally subscribe to external namespace changes.
Shared visibility depends on the actual filesystem backend. Whole-snapshot writes
may overwrite concurrent changes; cross-instance conditional writes, merging and
transactions are not provided. Use a database when those guarantees are required.

Vault continues to use Core FS directly. Its record revisions and conditional writes
remain local to one instance; externally loaded revisions may repeat or decrease.
