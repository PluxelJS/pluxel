---
packages:
  '@pluxel/host': minor
  '@pluxel/services': major
  '@pluxel/workbench': minor
  '@pluxel/host-vite': minor
  '@pluxel/rolldown': minor
  '@pluxel/test': minor
  '@pluxel/create': patch
---

# Replicate the Host saved configuration layer

Deployments can configure one fixed writer and authenticated replicas for a scope
and application artifact. Each atomic config document stores its history, global
sequence and original SuperJSON saved body together. Writer mutations require the
version originally read by the caller; stale writes and replica writes are rejected
before persistence or compound fork cleanup. Management, Workbench and the dev
console expose and preserve this version without automatically retrying a conflict.

Replicas validate complete candidate snapshots, commit once, then publish normalized
values and notify running Plugins. Missing fields are deleted; local initial/file/env
layers remain authoritative. Unknown owners stay deferred until real admission.
A valid cache permits offline startup; a replica without one waits for first sync.
Business Stores, Vault, logs, layout, code and runtime policy are not replicated.

Version 4 documents require explicit conversion when enabling replication over
older data. Network failures retain confirmed state; persistence and application
failures remain visible and are not silently retried.
