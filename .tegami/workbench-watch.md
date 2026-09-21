---
packages:
  '@pluxel/workbench': minor
---

## Simplify latest-state RPC subscriptions

Add `createWorkbenchWatch()` to `@pluxel/workbench/server`. Plugin targets connect a local
revision subscription to a remote observer without implementing a separate subscription target.
The helper owns callback references, invocation results and local registration cleanup, closes on
open abort or observer failure, and bounds notification work to one in-flight callback and the latest
pending revision. It is intended for snapshot invalidation, not lossless event delivery.
