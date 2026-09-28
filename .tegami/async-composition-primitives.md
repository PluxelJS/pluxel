---
packages:
  '@pluxel/async': minor
---

## Add explicit async composition primitives

Add independent `limit`, `retry`, `singleflight`, and `wait` subpaths without runtime dependencies. Limit shared or per-key concurrency, explicitly authorize bounded retries, share only in-flight work, and cancel waits using native AbortSignal. Stateful handles close admission and drain accepted work; cancelled waiters do not acquire ownership of shared operations.

Extend `iter` with sequential forEach, find, some, every, and reduce consumers that preserve upstream cleanup and drain semantics. Preserve the existing grfn and iter contracts. Generate all source and published exports with tsdown and validate behavior, public types, and source-free consumption.
