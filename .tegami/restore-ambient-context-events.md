---
packages:
  '@pluxel/core':
    type: minor
  '@pluxel/runtime':
    type: minor
---

## Restore owner-scoped ambient Context events

Add a module-augmented `ctx.events` service for loose-coupled host broadcasts alongside named
`EvtChannel` dependency protocols. Each root shares one emitter backend while subscriptions are
registered through immutable per-owner views and automatically cleaned up with owner effects.
