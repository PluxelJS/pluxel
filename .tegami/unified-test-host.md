---
packages:
  '@pluxel/test': major
  '@pluxel/core': major
  '@pluxel/services': major
  '@pluxel/rolldown': minor
  '@pluxel/cli': patch
  '@pluxel/create': patch
---

## One production-backed plugin test host

Import `createTestHost()` from `@pluxel/test`. Services are explicit and default to an empty list;
`workbench: true` adds the local test plane to the same host. Use `start/stop/restart`, typed batch
starts, catalog transactions, dependency overrides, configuration and native resource disposal.
The public Core and Services test factories are removed; Core graph harnesses remain internal.

Node/Worker source tests automatically attach the real artifact compiler when Node services are
selected without an explicit artifact source. Each host owns its compiler, temporary cache and
cleanup. Explicit packaged artifacts remain authoritative. The Vitest preset enables legacy
decorators and keeps project plugins explicit; separately built Node artifacts do not inherit
arbitrary Vitest plugins.

Official tests, generated plugin examples and testing documentation use the unified root entry.
